import { and, eq, isNull, or } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { permissions, rolePermissions, roles, userRoles, users } from '../db/schema';
import { ForbiddenError } from '../errors';
import type { Permission } from './permissions';

/** One permission, optionally narrowed to an event and/or a store. */
export interface Grant {
  permission: string;
  eventId: string | null;
  storeId: string | null;
}

export interface Scope {
  eventId?: string | null;
  storeId?: string | null;
}

/**
 * The authenticated caller and everything needed to authorise them.
 *
 * Built once per request from the database. The client never supplies any part
 * of this — a browser cannot claim a permission it was not granted.
 */
export class Actor {
  readonly userId: string;
  readonly displayName: string;
  readonly isSuperAdmin: boolean;
  readonly roleKeys: readonly string[];
  private readonly grants: readonly Grant[];

  constructor(init: {
    userId: string;
    displayName: string;
    isSuperAdmin: boolean;
    roleKeys: string[];
    grants: Grant[];
  }) {
    this.userId = init.userId;
    this.displayName = init.displayName;
    this.isSuperAdmin = init.isSuperAdmin;
    this.roleKeys = init.roleKeys;
    this.grants = init.grants;
  }

  /**
   * A grant applies when its scope is broader than or equal to the scope being
   * checked. A NULL scope on the grant means "everywhere"; a set scope must
   * match exactly. So a cashier at Store A fails `can('pos.operate', {storeId: B})`.
   */
  can(permission: Permission, scope: Scope = {}): boolean {
    if (this.isSuperAdmin) return true;
    return this.grants.some(
      (grant) =>
        grant.permission === permission &&
        (grant.eventId === null || grant.eventId === (scope.eventId ?? null)) &&
        (grant.storeId === null || grant.storeId === (scope.storeId ?? null)),
    );
  }

  canAny(candidates: Permission[], scope: Scope = {}): boolean {
    return candidates.some((permission) => this.can(permission, scope));
  }

  /** Throws rather than returning false. Use at the top of every handler. */
  require(permission: Permission, scope: Scope = {}): void {
    if (!this.can(permission, scope)) {
      throw new ForbiddenError(
        'You do not have permission to do that.',
        { required: permission, ...(scope.storeId ? { storeId: scope.storeId } : {}) },
      );
    }
  }

  /**
   * Permission to act on `targetUserId`: either the caller is that user and
   * holds the `.self` permission, or they hold the broader `.any` permission.
   */
  requireSelfOr(
    targetUserId: string,
    selfPermission: Permission,
    anyPermission: Permission,
    scope: Scope = {},
  ): void {
    if (targetUserId === this.userId && this.can(selfPermission, scope)) return;
    this.require(anyPermission, scope);
  }

  /** Store ids this actor holds `permission` for; `null` means all stores. */
  storesFor(permission: Permission, eventId: string | null): string[] | null {
    if (this.isSuperAdmin) return null;
    const matching = this.grants.filter(
      (grant) =>
        grant.permission === permission &&
        (grant.eventId === null || grant.eventId === eventId),
    );
    if (matching.some((grant) => grant.storeId === null)) return null;
    return [...new Set(matching.map((grant) => grant.storeId).filter((id): id is string => id !== null))];
  }

  permissionList(): string[] {
    return [...new Set(this.grants.map((grant) => grant.permission))].sort();
  }
}

/**
 * Load an actor. Grants are filtered to the event in play plus global grants,
 * so an admin of Event A gets nothing extra at Event B.
 */
export async function loadActor(
  db: Executor,
  userId: string,
  eventId: string | null,
): Promise<Actor | null> {
  const [user] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      isSuperAdmin: users.isSuperAdmin,
      status: users.status,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.deletedAt !== null || user.status !== 'ACTIVE') return null;

  const rows = await db
    .select({
      permission: permissions.key,
      roleKey: roles.key,
      eventId: userRoles.eventId,
      storeId: userRoles.storeId,
    })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(
      and(
        eq(userRoles.userId, userId),
        eventId === null
          ? isNull(userRoles.eventId)
          : or(isNull(userRoles.eventId), eq(userRoles.eventId, eventId)),
      ),
    );

  return new Actor({
    userId: user.id,
    displayName: user.displayName,
    isSuperAdmin: user.isSuperAdmin,
    roleKeys: [...new Set(rows.map((row) => row.roleKey))],
    grants: rows.map((row) => ({
      permission: row.permission,
      eventId: row.eventId,
      storeId: row.storeId,
    })),
  });
}

/** Grant a role, optionally scoped. Idempotent. */
export async function grantRole(
  db: Executor,
  input: {
    userId: string;
    roleKey: string;
    eventId?: string | null;
    storeId?: string | null;
    grantedBy?: string | null;
  },
): Promise<void> {
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.key, input.roleKey))
    .limit(1);
  if (!role) throw new Error(`Unknown role: ${input.roleKey}`);

  await db
    .insert(userRoles)
    .values({
      userId: input.userId,
      roleId: role.id,
      eventId: input.eventId ?? null,
      storeId: input.storeId ?? null,
      grantedBy: input.grantedBy ?? null,
    })
    // The unique index is over COALESCE() expressions, which cannot be named
    // as a conflict target; the untargeted form covers it.
    .onConflictDoNothing();
}
