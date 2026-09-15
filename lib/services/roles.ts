import { count, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client';
import { permissions, rolePermissions, roles, userRoles } from '../db/schema';
import { recordAudit, type AuditContext } from '../audit';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
} from '../authz/permissions';

/**
 * Roles as a thing a super admin owns, rather than a thing the code decides.
 *
 * The catalogue in `lib/authz/permissions.ts` still defines every permission
 * that exists and seeds the roles that ship. What changes here is who owns a
 * role's grants afterwards: the first hand edit transfers ownership to the
 * database, and the sync stops overwriting it (see `lib/db/bootstrap.ts`).
 */

/**
 * Permissions the editor will not hand out, whatever the screen says.
 *
 * These are the ones that mint points, move them by hand, destroy records, or
 * hand out authority itself. They are not blocked because they are important —
 * `pos.operate` is important — but because granting them is how the controls
 * the rest of the system is built on get quietly undone. The whole reason
 * `wallet.topup.pos` exists as a capped, PIN-gated, store-scoped permission is
 * that a till must not be able to reach the uncapped `wallet.topup`; a screen
 * that grants it with a tick makes that distinction decorative.
 *
 * They are not disabled — ADMIN and SUPER_ADMIN hold them by catalogue default
 * and keep doing so. What is refused is *adding* one to a role that does not
 * already have it. Changing that is a code review, which is the point.
 */
export const UNGRANTABLE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'role.manage',
  'wallet.topup',
  'wallet.adjust',
  'participant.remove',
  'card.remove',
  'event.write',
  'settings.write',
]);

/** Without this a super admin can edit away their own ability to edit. */
const SUPER_ADMIN_REQUIRED: ReadonlySet<Permission> = new Set<Permission>(['role.manage']);

const SYSTEM_ROLE_KEYS: ReadonlySet<string> = new Set<string>(ROLE_KEYS);

export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  customised: boolean;
  holders: number;
  permissions: Permission[];
}

export interface PermissionOption {
  key: Permission;
  description: string;
  grantable: boolean;
}

/** Every permission that exists, flagged with whether the editor may grant it. */
export function permissionCatalogue(): PermissionOption[] {
  return ALL_PERMISSIONS.map((key) => ({
    key,
    description: PERMISSIONS[key],
    grantable: !UNGRANTABLE_PERMISSIONS.has(key),
  }));
}

export async function listRoles(db: Database): Promise<RoleSummary[]> {
  const [roleRows, grantRows, holderRows] = await Promise.all([
    db
      .select({
        id: roles.id,
        key: roles.key,
        name: roles.name,
        description: roles.description,
        isSystem: roles.isSystem,
        customised: roles.permissionsCustomised,
      })
      .from(roles)
      .orderBy(roles.key),
    db
      .select({ roleId: rolePermissions.roleId, key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId)),
    db
      .select({ roleId: userRoles.roleId, n: count() })
      .from(userRoles)
      .groupBy(userRoles.roleId),
  ]);

  const grantsByRole = new Map<string, Permission[]>();
  for (const row of grantRows) {
    const list = grantsByRole.get(row.roleId) ?? [];
    list.push(row.key as Permission);
    grantsByRole.set(row.roleId, list);
  }
  const holdersByRole = new Map(holderRows.map((row) => [row.roleId, Number(row.n)]));

  return roleRows.map((role) => ({
    ...role,
    holders: holdersByRole.get(role.id) ?? 0,
    permissions: (grantsByRole.get(role.id) ?? []).sort(),
  }));
}

export async function createRole(
  db: Database,
  input: { key: string; name: string; description?: string | null; permissions: string[] },
  context: AuditContext,
): Promise<{ roleId: string }> {
  const key = input.key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(key)) {
    throw new ValidationError(
      'A role key is 3 to 40 characters: capitals, digits and underscores, starting with a letter.',
    );
  }
  if (SYSTEM_ROLE_KEYS.has(key)) {
    throw new ConflictError(`${key} is a role that ships with the system.`, 'role_key_reserved');
  }
  if (input.name.trim().length < 2) {
    throw new ValidationError('Give the role a name of at least 2 characters.');
  }

  const granted = assertGrantable(input.permissions, []);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, key))
      .limit(1);
    if (existing) throw new ConflictError('A role with that key already exists.', 'role_exists');

    const [role] = await tx
      .insert(roles)
      .values({
        key,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        // Not from the catalogue, so the sync must neither seed nor sweep it.
        isSystem: false,
        permissionsCustomised: true,
      })
      .returning({ id: roles.id });
    if (!role) throw new Error('Failed to create role');

    await writeGrants(tx, role.id, granted);

    await recordAudit(tx, {
      ...context,
      action: 'role.created',
      targetType: 'role',
      targetId: role.id,
      after: { key, name: input.name, permissions: granted },
    });

    return { roleId: role.id };
  });
}

export async function deleteRole(
  db: Database,
  roleId: string,
  context: AuditContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [role] = await tx
      .select({ id: roles.id, key: roles.key, isSystem: roles.isSystem })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1);
    if (!role) throw new NotFoundError('That role');
    if (role.isSystem) {
      throw new ConflictError(
        `${role.key} ships with the system and cannot be deleted. Edit what it may do instead.`,
        'role_is_system',
      );
    }

    // user_roles.role_id is ON DELETE RESTRICT, so the database would refuse
    // this anyway; failing here says who is still holding it.
    const [held] = await tx
      .select({ n: count() })
      .from(userRoles)
      .where(eq(userRoles.roleId, roleId));
    if (Number(held?.n ?? 0) > 0) {
      throw new ConflictError(
        `${held?.n} account${Number(held?.n) === 1 ? '' : 's'} still hold this role. Move them to another role first.`,
        'role_still_held',
      );
    }

    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    await tx.delete(roles).where(eq(roles.id, roleId));

    await recordAudit(tx, {
      ...context,
      action: 'role.deleted',
      targetType: 'role',
      targetId: roleId,
      before: { key: role.key },
    });
  });
}

/**
 * Replace what a role may do.
 *
 * Permissions the role already holds are carried through even when they are in
 * the blocked set: the rule is that the editor cannot *add* authority of that
 * kind, not that ADMIN quietly loses the ability to mint points the first time
 * somebody renames a role.
 */
export async function setRolePermissions(
  db: Database,
  input: { roleId: string; permissions: string[] },
  context: AuditContext,
): Promise<{ permissions: Permission[] }> {
  return db.transaction(async (tx) => {
    const [role] = await tx
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      .where(eq(roles.id, input.roleId))
      .limit(1);
    if (!role) throw new NotFoundError('That role');

    const before = await currentPermissions(tx, input.roleId);
    const granted = assertGrantable(input.permissions, before);

    if (role.key === 'SUPER_ADMIN') {
      for (const required of SUPER_ADMIN_REQUIRED) {
        if (!granted.includes(required)) {
          throw new ConflictError(
            `Super admin must keep ${required}, or nobody can edit roles again.`,
            'super_admin_locked',
          );
        }
      }
    }

    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, input.roleId));
    await writeGrants(tx, input.roleId, granted);
    await tx
      .update(roles)
      .set({ permissionsCustomised: true })
      .where(eq(roles.id, input.roleId));

    await recordAudit(tx, {
      ...context,
      action: 'role.permissions_changed',
      targetType: 'role',
      targetId: input.roleId,
      before: { permissions: before },
      after: { permissions: granted },
    });

    return { permissions: granted };
  });
}

/** Hand a shipped role back to the catalogue. */
export async function resetRoleToDefaults(
  db: Database,
  roleId: string,
  context: AuditContext,
): Promise<{ permissions: Permission[] }> {
  return db.transaction(async (tx) => {
    const [role] = await tx
      .select({ id: roles.id, key: roles.key, isSystem: roles.isSystem })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1);
    if (!role) throw new NotFoundError('That role');
    if (!role.isSystem) {
      throw new ConflictError(
        'That role was created here, so there are no defaults to go back to.',
        'role_has_no_defaults',
      );
    }

    const before = await currentPermissions(tx, roleId);
    const defaults = ROLE_PERMISSIONS[role.key as RoleKey] ?? [];

    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    await writeGrants(tx, roleId, defaults);
    await tx
      .update(roles)
      .set({ permissionsCustomised: false })
      .where(eq(roles.id, roleId));

    await recordAudit(tx, {
      ...context,
      action: 'role.reset_to_defaults',
      targetType: 'role',
      targetId: roleId,
      before: { permissions: before },
      after: { permissions: defaults },
    });

    return { permissions: [...defaults] };
  });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

async function currentPermissions(tx: Tx, roleId: string): Promise<Permission[]> {
  const rows = await tx
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(rolePermissions.roleId, roleId));
  return rows.map((row) => row.key as Permission).sort();
}

function assertGrantable(requested: string[], alreadyHeld: Permission[]): Permission[] {
  const held = new Set(alreadyHeld);
  const seen = new Set<Permission>();

  for (const key of requested) {
    if (!ALL_PERMISSIONS.includes(key as Permission)) {
      throw new ValidationError(`There is no permission called ${key}.`);
    }
    const permission = key as Permission;
    if (UNGRANTABLE_PERMISSIONS.has(permission) && !held.has(permission)) {
      throw new ConflictError(
        `${permission} cannot be granted from this screen — it mints points, moves them by hand, or hands out authority. Ask for a code change instead.`,
        'permission_not_grantable',
      );
    }
    seen.add(permission);
  }

  return [...seen].sort();
}

async function writeGrants(tx: Tx, roleId: string, granted: readonly Permission[]): Promise<void> {
  if (granted.length === 0) return;
  const rows = await tx
    .select({ id: permissions.id, key: permissions.key })
    .from(permissions)
    .where(inArray(permissions.key, [...granted]));

  if (rows.length > 0) {
    await tx
      .insert(rolePermissions)
      .values(rows.map((row) => ({ roleId, permissionId: row.id })))
      .onConflictDoNothing();
  }
}
