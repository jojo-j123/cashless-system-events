import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Executor } from './client';
import { permissions, rolePermissions, roles, userRoles } from './schema';
import {
  PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
} from '../authz/permissions';

/**
 * Sync the roles and permissions catalogue into the database.
 *
 * Idempotent, so it runs safely on every deploy. The code in
 * `lib/authz/permissions.ts` is the source of truth for the *vocabulary* of
 * permissions, and the default grants of every role that ships; this reflects
 * both into tables so grants can carry foreign keys.
 *
 * It is not the source of truth for a role a super admin has edited. Such a
 * role carries `permissions_customised`, and its grants are left exactly as
 * the operator left them — otherwise the edit would survive until the next
 * deploy and then disappear, which is worse than refusing it. Roles created in
 * the console (`is_system = false`) are likewise neither seeded nor swept up.
 */
export async function syncRolesAndPermissions(db: Executor): Promise<void> {
  const permissionRows = Object.entries(PERMISSIONS).map(([key, description]) => ({
    key,
    description,
  }));

  await db
    .insert(permissions)
    .values(permissionRows)
    .onConflictDoUpdate({
      target: permissions.key,
      set: { description: sqlExcluded('description') },
    });

  await db
    .insert(roles)
    .values(
      ROLE_KEYS.map((key) => ({
        key,
        name: toTitle(key),
        description: ROLE_DESCRIPTIONS[key],
        isSystem: true,
      })),
    )
    .onConflictDoUpdate({
      target: roles.key,
      set: { description: sqlExcluded('description') },
    });

  const allPermissions = await db
    .select({ id: permissions.id, key: permissions.key })
    .from(permissions);
  const permissionIdByKey = new Map(allPermissions.map((row) => [row.key, row.id]));

  for (const roleKey of ROLE_KEYS) {
    const [role] = await db
      .select({ id: roles.id, customised: roles.permissionsCustomised })
      .from(roles)
      .where(eq(roles.key, roleKey))
      .limit(1);
    if (!role) continue;
    // Hand-edited: the operator owns this role's grants now. Resetting it to
    // the catalogue defaults is an explicit action in the console, not a
    // side effect of a deploy.
    if (role.customised) continue;

    // Replace rather than merge: removing a permission from the catalogue
    // must actually revoke it, not leave it granted forever.
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));

    const grants = ROLE_PERMISSIONS[roleKey]
      .map((permissionKey) => permissionIdByKey.get(permissionKey))
      .filter((id): id is string => id !== undefined)
      .map((permissionId) => ({ roleId: role.id, permissionId }));

    if (grants.length > 0) {
      await db.insert(rolePermissions).values(grants).onConflictDoNothing();
    }
  }

  await retireRolesLeftOutOfTheCatalogue(db);
}

/**
 * Drop roles the catalogue no longer defines.
 *
 * Without this, removing a role from `ROLE_KEYS` only stops it being synced:
 * the row and its permission grants stay behind, frozen at whatever they held
 * on the day it was removed, and anyone still holding it keeps that access
 * indefinitely. That is the same reasoning as the permission replace above.
 *
 * Roles still granted to somebody are left alone — `user_roles.role_id` is ON
 * DELETE RESTRICT, and a deploy is not the place to revoke a working login.
 * Migration 0003 is what carries grants off a retired role; this only sweeps
 * up after it.
 *
 * Custom roles are exempt by `is_system`. They were never in the catalogue to
 * be left out of it, so without that filter every role a super admin created
 * would be swept away by the next reset for having a key this file does not
 * recognise.
 */
async function retireRolesLeftOutOfTheCatalogue(db: Executor): Promise<void> {
  const retired = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.isSystem, true), notInArray(roles.key, [...ROLE_KEYS])));
  if (retired.length === 0) return;

  const ids = retired.map((role) => role.id);
  const stillHeld = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(inArray(userRoles.roleId, ids));

  const held = new Set(stillHeld.map((row) => row.roleId));
  const removable = ids.filter((id) => !held.has(id));
  if (removable.length === 0) return;

  await db.delete(rolePermissions).where(inArray(rolePermissions.roleId, removable));
  await db.delete(roles).where(inArray(roles.id, removable));
}

function toTitle(key: string): string {
  return key
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
