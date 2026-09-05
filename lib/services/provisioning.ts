import { and, eq } from 'drizzle-orm';
import type { Database, Executor } from '../db/client';
import {
  accounts,
  eventParticipants,
  events,
  inventory,
  inventoryMovements,
  productCategories,
  products,
  storeStaff,
  stores,
  teamMembers,
  teams,
  terminals,
  users,
} from '../db/schema';
import { recordAudit, type AuditContext } from '../audit';
import { nextRef } from '../core/refs';
import { generateToken, hashToken } from '../auth/tokens';
import { hashPassword } from '../auth/password';
import { grantRole } from '../authz/actor';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { provisionTeamAccounts, provisionUserAccounts } from './ledger';
import { updateEventSettings } from '../settings/service';
import type { EventSettingsPatch } from '../settings/schema';

/**
 * Create an event and its system accounts.
 *
 * The two SYSTEM accounts are created here and nowhere else: an event without
 * them cannot post a balanced transaction, so this is the one place that
 * guarantees the ledger is usable from the first point issued.
 */
export async function createEvent(
  db: Database,
  input: {
    slug: string;
    name: string;
    description?: string | null;
    timezone?: string;
    startsAt?: Date | null;
    endsAt?: Date | null;
    settings?: EventSettingsPatch;
  },
  context: AuditContext,
): Promise<{ eventId: string }> {
  assertSlug(input.slug);

  return db.transaction(async (tx) => {
    const [event] = await tx
      .insert(events)
      .values({
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        timezone: input.timezone ?? 'UTC',
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        status: 'DRAFT',
      })
      .returning({ id: events.id });
    if (!event) throw new Error('Failed to create event');

    await tx.insert(accounts).values([
      {
        eventId: event.id,
        type: 'SYSTEM_ISSUANCE',
        name: `${input.name} — issuance`,
        // The mint: goes negative by exactly the number of points issued.
        allowNegative: true,
      },
      {
        eventId: event.id,
        type: 'SYSTEM_FORFEITURE',
        name: `${input.name} — forfeiture`,
        allowNegative: true,
      },
    ]);

    if (input.settings) {
      await updateEventSettings(tx, event.id, input.settings, context.actorUserId ?? null);
    }

    await recordAudit(tx, {
      ...context,
      eventId: event.id,
      action: 'event.created',
      targetType: 'event',
      targetId: event.id,
      after: { slug: input.slug, name: input.name },
    });

    return { eventId: event.id };
  });
}

export async function setEventStatus(
  db: Database,
  eventId: string,
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'ARCHIVED',
  context: AuditContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: events.status })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    if (!current) throw new NotFoundError('That event');

    await tx
      .update(events)
      .set({ status, archivedAt: status === 'ARCHIVED' ? new Date() : null })
      .where(eq(events.id, eventId));

    await recordAudit(tx, {
      ...context,
      eventId,
      action: 'event.status_changed',
      targetType: 'event',
      targetId: eventId,
      before: { status: current.status },
      after: { status },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* People                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreatedUser {
  userId: string;
  participantRef: string;
}

/**
 * Create a person and enrol them in an event.
 *
 * Wallets are provisioned in the same transaction, so a participant can never
 * exist without somewhere for their points to live.
 */
export async function createParticipant(
  db: Database,
  input: {
    eventId: string;
    displayName: string;
    email?: string | null;
    phone?: string | null;
    password?: string | null;
    teamId?: string | null;
    roleKey?: string;
  },
  context: AuditContext,
): Promise<CreatedUser> {
  if (input.displayName.trim().length < 2) {
    throw new ValidationError('A name of at least 2 characters is required.');
  }

  const passwordHash = input.password ? await hashPassword(input.password) : null;

  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        displayName: input.displayName.trim(),
        email: input.email?.trim().toLowerCase() ?? null,
        phone: input.phone?.trim() ?? null,
        passwordHash,
        qrSecret: generateToken(24),
      })
      .returning({ id: users.id });
    if (!user) throw new Error('Failed to create user');

    const participantRef = await nextRef(tx, 'participant');
    await tx.insert(eventParticipants).values({
      eventId: input.eventId,
      userId: user.id,
      participantRef,
    });

    await provisionUserAccounts(tx, input.eventId, user.id, input.displayName.trim());

    if (input.teamId) {
      await addToTeam(tx, input.eventId, input.teamId, user.id, 'MEMBER');
    }

    await grantRole(tx, {
      userId: user.id,
      roleKey: input.roleKey ?? 'PARTICIPANT',
      eventId: input.eventId,
      grantedBy: context.actorUserId ?? null,
    });

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'participant.created',
      targetType: 'user',
      targetId: user.id,
      after: { displayName: input.displayName, participantRef },
    });

    return { userId: user.id, participantRef };
  });
}

/** Enrol an existing person into an event (they may already be in another). */
export async function enrolExistingUser(
  db: Database,
  input: { eventId: string; userId: string; teamId?: string | null; roleKey?: string },
  context: AuditContext,
): Promise<CreatedUser> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!user) throw new NotFoundError('That person');

    const [existing] = await tx
      .select({ participantRef: eventParticipants.participantRef })
      .from(eventParticipants)
      .where(
        and(
          eq(eventParticipants.eventId, input.eventId),
          eq(eventParticipants.userId, input.userId),
        ),
      )
      .limit(1);

    const participantRef = existing?.participantRef ?? (await nextRef(tx, 'participant'));
    if (!existing) {
      await tx
        .insert(eventParticipants)
        .values({ eventId: input.eventId, userId: input.userId, participantRef });
    }

    await provisionUserAccounts(tx, input.eventId, input.userId, user.displayName);

    if (input.teamId) {
      await addToTeam(tx, input.eventId, input.teamId, input.userId, 'MEMBER');
    }
    await grantRole(tx, {
      userId: input.userId,
      roleKey: input.roleKey ?? 'PARTICIPANT',
      eventId: input.eventId,
      grantedBy: context.actorUserId ?? null,
    });

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'participant.enrolled',
      targetType: 'user',
      targetId: input.userId,
      after: { participantRef },
    });

    return { userId: input.userId, participantRef };
  });
}

export async function createTeam(
  db: Database,
  input: {
    eventId: string;
    name: string;
    slug: string;
    color?: string;
    managerUserId?: string | null;
  },
  context: AuditContext,
): Promise<{ teamId: string }> {
  assertSlug(input.slug);

  return db.transaction(async (tx) => {
    const [team] = await tx
      .insert(teams)
      .values({
        eventId: input.eventId,
        name: input.name,
        slug: input.slug,
        color: input.color ?? '#64748b',
        managerUserId: input.managerUserId ?? null,
      })
      .returning({ id: teams.id });
    if (!team) throw new Error('Failed to create team');

    await provisionTeamAccounts(tx, input.eventId, team.id, input.name);

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'team.created',
      targetType: 'team',
      targetId: team.id,
      after: { name: input.name, slug: input.slug },
    });

    return { teamId: team.id };
  });
}

/** One team per person per event, enforced by a unique index. */
export async function addToTeam(
  db: Executor,
  eventId: string,
  teamId: string,
  userId: string,
  role: 'MEMBER' | 'MANAGER' = 'MEMBER',
): Promise<void> {
  const [existing] = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.eventId, eventId), eq(teamMembers.userId, userId)))
    .limit(1);

  if (existing) {
    if (existing.teamId === teamId) return;
    throw new ConflictError(
      'This participant is already on another team for this event.',
      'already_on_team',
    );
  }

  await db.insert(teamMembers).values({ eventId, teamId, userId, role });
}

/* -------------------------------------------------------------------------- */
/* Commerce                                                                   */
/* -------------------------------------------------------------------------- */

export async function createStore(
  db: Database,
  input: {
    eventId: string;
    name: string;
    slug: string;
    description?: string | null;
    location?: string | null;
    managerUserId?: string | null;
  },
  context: AuditContext,
): Promise<{ storeId: string }> {
  assertSlug(input.slug);

  return db.transaction(async (tx) => {
    const [store] = await tx
      .insert(stores)
      .values({
        eventId: input.eventId,
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        location: input.location ?? null,
        managerUserId: input.managerUserId ?? null,
      })
      .returning({ id: stores.id });
    if (!store) throw new Error('Failed to create store');

    // Each store gets its own revenue account, so "sales by store" is a
    // balance rather than a sum over rows that could be double counted.
    const [revenue] = await tx
      .insert(accounts)
      .values({
        eventId: input.eventId,
        type: 'SYSTEM_STORE_REVENUE',
        storeId: store.id,
        name: `${input.name} — revenue`,
      })
      .returning({ id: accounts.id });
    if (!revenue) throw new Error('Failed to create store revenue account');

    await tx
      .update(stores)
      .set({ revenueAccountId: revenue.id })
      .where(eq(stores.id, store.id));

    if (input.managerUserId) {
      await tx
        .insert(storeStaff)
        .values({ storeId: store.id, userId: input.managerUserId, role: 'MANAGER' })
        .onConflictDoNothing();
      await grantRole(tx, {
        userId: input.managerUserId,
        roleKey: 'CASHIER',
        eventId: input.eventId,
        storeId: store.id,
      });
    }

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'store.created',
      targetType: 'store',
      targetId: store.id,
      after: { name: input.name, slug: input.slug },
    });

    return { storeId: store.id };
  });
}

export async function assignStoreStaff(
  db: Database,
  input: {
    eventId: string;
    storeId: string;
    userId: string;
    role: 'MANAGER' | 'CASHIER';
  },
  context: AuditContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(storeStaff)
      .values({ storeId: input.storeId, userId: input.userId, role: input.role })
      .onConflictDoUpdate({
        target: [storeStaff.storeId, storeStaff.userId],
        set: { role: input.role },
      });

    // The role grant is scoped to this store: authority here is not authority
    // at the store next door.
    //
    // MANAGER and CASHIER both grant the cashier role. The distinction is a
    // roster label — who is in charge of this store's shift — and no longer
    // carries permissions of its own; editing products or stock is admin work.
    await grantRole(tx, {
      userId: input.userId,
      roleKey: 'CASHIER',
      eventId: input.eventId,
      storeId: input.storeId,
      grantedBy: context.actorUserId ?? null,
    });

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'store.staff_assigned',
      targetType: 'store',
      targetId: input.storeId,
      after: { userId: input.userId, role: input.role },
    });
  });
}

export async function createCategory(
  db: Database,
  input: { eventId: string; name: string; slug: string; sortOrder?: number },
): Promise<{ categoryId: string }> {
  const [row] = await db
    .insert(productCategories)
    .values({
      eventId: input.eventId,
      name: input.name,
      slug: input.slug,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning({ id: productCategories.id });
  if (!row) throw new Error('Failed to create category');
  return { categoryId: row.id };
}

export async function createProduct(
  db: Database,
  input: {
    eventId: string;
    storeId: string;
    sku: string;
    name: string;
    description?: string | null;
    pricePoints: number;
    categoryId?: string | null;
    initialStock?: number;
    lowStockThreshold?: number;
    trackInventory?: boolean;
    maxPerPurchase?: number | null;
    restrictedToTeamId?: string | null;
  },
  context: AuditContext,
): Promise<{ productId: string }> {
  if (!Number.isInteger(input.pricePoints) || input.pricePoints < 0) {
    throw new ValidationError('Price must be a whole number of points, zero or above.');
  }

  return db.transaction(async (tx) => {
    const [product] = await tx
      .insert(products)
      .values({
        eventId: input.eventId,
        storeId: input.storeId,
        categoryId: input.categoryId ?? null,
        sku: input.sku.trim().toUpperCase(),
        name: input.name,
        description: input.description ?? null,
        pricePoints: input.pricePoints,
        maxPerPurchase: input.maxPerPurchase ?? null,
        restrictedToTeamId: input.restrictedToTeamId ?? null,
      })
      .returning({ id: products.id });
    if (!product) throw new Error('Failed to create product');

    const initialStock = input.initialStock ?? 0;
    const [stock] = await tx
      .insert(inventory)
      .values({
        eventId: input.eventId,
        productId: product.id,
        quantityOnHand: initialStock,
        lowStockThreshold: input.lowStockThreshold ?? 5,
        trackInventory: input.trackInventory ?? true,
      })
      .returning({ id: inventory.id });
    if (!stock) throw new Error('Failed to create inventory row');

    // Opening stock is a movement like any other, so the movement history
    // reconciles to the current quantity with no unexplained starting point.
    if (initialStock > 0) {
      await tx.insert(inventoryMovements).values({
        eventId: input.eventId,
        inventoryId: stock.id,
        productId: product.id,
        type: 'INITIAL',
        quantityDelta: initialStock,
        quantityBefore: 0,
        quantityAfter: initialStock,
        reason: 'Opening stock',
        createdBy: context.actorUserId ?? null,
      });
    }

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'product.created',
      targetType: 'product',
      targetId: product.id,
      after: { name: input.name, sku: input.sku, pricePoints: input.pricePoints, initialStock },
    });

    return { productId: product.id };
  });
}

/* -------------------------------------------------------------------------- */
/* Terminals                                                                  */
/* -------------------------------------------------------------------------- */

export async function registerTerminal(
  db: Database,
  input: { eventId: string; storeId: string | null; name: string },
  context: AuditContext,
): Promise<{ terminalId: string; terminalRef: string; apiKey: string }> {
  return db.transaction(async (tx) => {
    const terminalRef = await nextRef(tx, 'terminal');
    const apiKey = generateToken(32);

    const [terminal] = await tx
      .insert(terminals)
      .values({
        eventId: input.eventId,
        storeId: input.storeId,
        terminalRef,
        name: input.name,
        apiKeyHash: hashToken(apiKey),
      })
      .returning({ id: terminals.id });
    if (!terminal) throw new Error('Failed to register terminal');

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'terminal.registered',
      targetType: 'terminal',
      targetId: terminal.id,
      after: { terminalRef, name: input.name, storeId: input.storeId },
    });

    return { terminalId: terminal.id, terminalRef, apiKey };
  });
}

function assertSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ValidationError(
      'Slug must be lowercase letters, numbers and single hyphens.',
    );
  }
}
