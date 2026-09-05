import 'dotenv/config';
import { closeDb, getDb } from '../lib/db/client';
import { syncRolesAndPermissions } from '../lib/db/bootstrap';
import { hashPin } from '../lib/auth/password';
import {
  assignStoreStaff,
  createCategory,
  createEvent,
  createParticipant,
  createProduct,
  createStore,
  createTeam,
  registerTerminal,
  setEventStatus,
} from '../lib/services/provisioning';
import { assignCard, createCards } from '../lib/services/cards';
import { allocateToTeam, topUpUser } from '../lib/services/wallet';
import { checkout } from '../lib/services/purchases';
import { refundPurchase } from '../lib/services/refunds';
import { verifyLedgerIntegrity } from '../lib/services/ledger';
import { users } from '../lib/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Realistic seed data.
 *
 * Everything here goes through the real services — the same code paths the
 * live application uses. Nothing is inserted straight into the ledger, so if
 * the seed runs green, the money path genuinely works end to end.
 */

const DEMO_PASSWORD = 'Festival2026!';
const TEAM_DEFS = [
  { name: 'Team Red', slug: 'team-red', color: '#ef4444' },
  { name: 'Team Blue', slug: 'team-blue', color: '#3b82f6' },
  { name: 'Team Green', slug: 'team-green', color: '#22c55e' },
  { name: 'Team Yellow', slug: 'team-yellow', color: '#eab308' },
];

const FIRST_NAMES = [
  'Ahmed', 'Sara', 'Omar', 'Layla', 'Yusuf', 'Nour', 'Karim', 'Hana', 'Tarek', 'Mariam',
  'Zeina', 'Rami', 'Dina', 'Khaled', 'Salma', 'Adam', 'Farah', 'Bilal', 'Rana', 'Sami',
];
const LAST_NAMES = [
  'Hassan', 'Mansour', 'Khalil', 'Fahmy', 'Nasser', 'Aziz', 'Darwish', 'Saleh',
];

async function main(): Promise<void> {
  const db = getDb();
  const context = { actorUserId: null, requestId: 'seed' };

  console.log('→ Syncing roles and permissions');
  await syncRolesAndPermissions(db);

  console.log('→ Creating event');
  const { eventId } = await createEvent(
    db,
    {
      slug: 'summer-festival-2026',
      name: 'Summer Festival 2026',
      description: 'A four-day cashless event with team competition.',
      timezone: 'Africa/Cairo',
      startsAt: new Date('2026-07-01T09:00:00Z'),
      endsAt: new Date('2026-07-04T23:00:00Z'),
      settings: {
        lowBalanceThreshold: 150,
        maxSingleTopUp: 20_000,
        // Kept high in the seed so the demo data can be created without every
        // top-up parking as an approval request.
        approvalThresholdTopUp: 50_000,
        approvalThresholdAdjustment: 5_000,
        approvalThresholdRefund: 5_000,
        allowTransfers: true,
        maxSingleTransfer: 500,
        dailyTransferLimit: 1_000,
      },
    },
    context,
  );
  await setEventStatus(db, eventId, 'ACTIVE', context);

  console.log('→ Creating staff');
  await createStaff(db, eventId, {
    displayName: 'Nadia Superadmin',
    email: 'superadmin@example.com',
    roleKey: 'SUPER_ADMIN',
    isSuperAdmin: true,
  });
  const admin = await createStaff(db, eventId, {
    displayName: 'Omar Admin',
    email: 'admin@example.com',
    roleKey: 'ADMIN',
  });
  // Money operations — top-ups, adjustments, approvals — are admin work; there
  // is no separate finance role. She is a second admin who happens to run the
  // points desk.
  const finance = await createStaff(db, eventId, {
    displayName: 'Layla Admin',
    email: 'finance@example.com',
    roleKey: 'ADMIN',
  });
  const staffContext = { actorUserId: admin, requestId: 'seed' };
  const financeContext = { actorUserId: finance, requestId: 'seed' };

  console.log('→ Creating teams');
  const teamIds: string[] = [];
  for (const team of TEAM_DEFS) {
    const { teamId } = await createTeam(db, { eventId, ...team }, staffContext);
    teamIds.push(teamId);
  }

  console.log('→ Creating participants');
  const participants: { userId: string; teamId: string; name: string }[] = [];
  for (let index = 0; index < 40; index += 1) {
    const first = FIRST_NAMES[index % FIRST_NAMES.length] ?? 'Guest';
    const last = LAST_NAMES[index % LAST_NAMES.length] ?? 'Attendee';
    const name = `${first} ${last}`;
    const teamId = teamIds[index % teamIds.length];
    if (!teamId) continue;

    const { userId } = await createParticipant(
      db,
      {
        eventId,
        displayName: name,
        email: `participant${index + 1}@example.com`,
        password: index === 0 ? DEMO_PASSWORD : null,
        teamId,
      },
      staffContext,
    );
    participants.push({ userId, teamId, name });
  }
  if (participants.length === 0) throw new Error('Seed produced no participants');

  console.log('→ Creating stores and products');
  // Named on every store's roster, which grants the cashier role at each. Stock
  // and pricing are admin work, so he is not given more than a till.
  const storeManager = await createStaff(db, eventId, {
    displayName: 'Karim Store Lead',
    email: 'storemanager@example.com',
    roleKey: 'PARTICIPANT',
  });

  const categories = {
    food: (await createCategory(db, { eventId, name: 'Food & Drink', slug: 'food', sortOrder: 1 }))
      .categoryId,
    merch: (await createCategory(db, { eventId, name: 'Merchandise', slug: 'merch', sortOrder: 2 }))
      .categoryId,
    games: (await createCategory(db, { eventId, name: 'Games', slug: 'games', sortOrder: 3 }))
      .categoryId,
    props: (await createCategory(db, { eventId, name: 'Props & Costumes', slug: 'props', sortOrder: 4 }))
      .categoryId,
    ai: (await createCategory(db, { eventId, name: 'AI Tools', slug: 'ai-tools', sortOrder: 5 }))
      .categoryId,
  };

  const storeDefs = [
    {
      name: 'Festival Store',
      slug: 'festival-store',
      location: 'Main Plaza',
      products: [
        { sku: 'TSHIRT', name: 'Festival T-Shirt', price: 300, stock: 60, category: categories.merch },
        { sku: 'HOODIE', name: 'Festival Hoodie', price: 500, stock: 20, category: categories.merch },
        { sku: 'CAP', name: 'Snapback Cap', price: 180, stock: 45, category: categories.merch },
        { sku: 'TOTE', name: 'Canvas Tote', price: 120, stock: 4, category: categories.merch },
      ],
    },
    {
      name: 'Food Court',
      slug: 'food-court',
      location: 'East Lawn',
      products: [
        { sku: 'BURGER', name: 'Burger', price: 200, stock: 300, category: categories.food },
        { sku: 'DRINK', name: 'Soft Drink', price: 100, stock: 500, category: categories.food },
        { sku: 'FRIES', name: 'Loaded Fries', price: 140, stock: 200, category: categories.food },
        { sku: 'COFFEE', name: 'Iced Coffee', price: 130, stock: 250, category: categories.food },
      ],
    },
    {
      name: 'Games Arcade',
      slug: 'games',
      location: 'North Tent',
      products: [
        { sku: 'TOKEN1', name: 'Game Token', price: 50, stock: 1_000, category: categories.games },
        { sku: 'TOKEN10', name: 'Game Token × 10', price: 450, stock: 200, category: categories.games },
        {
          sku: 'VRRIDE',
          name: 'VR Experience',
          price: 350,
          stock: 0,
          category: categories.games,
          track: false,
        },
      ],
    },
    {
      name: 'Props & Costumes',
      slug: 'props-costumes',
      location: 'West Wing',
      products: [
        { sku: 'COSTUME', name: 'Full Costume Rental', price: 600, stock: 15, category: categories.props },
        { sku: 'PROP', name: 'Festival Prop', price: 90, stock: 80, category: categories.props },
        { sku: 'FACEPAINT', name: 'Face Painting', price: 70, stock: 0, category: categories.props, track: false },
      ],
    },
    {
      name: 'AI Tools Booth',
      slug: 'ai-tools',
      location: 'Innovation Hub',
      products: [
        { sku: 'AIPORTRAIT', name: 'AI Portrait Session', price: 400, stock: 0, category: categories.ai, track: false },
        { sku: 'AICREDITS', name: 'AI Credits Pack', price: 250, stock: 100, category: categories.ai },
      ],
    },
  ];

  const storeIds: Record<string, string> = {};
  const productIds: Record<string, string> = {};

  for (const store of storeDefs) {
    const { storeId } = await createStore(
      db,
      {
        eventId,
        name: store.name,
        slug: store.slug,
        location: store.location,
        managerUserId: storeManager,
      },
      staffContext,
    );
    storeIds[store.slug] = storeId;

    for (const product of store.products) {
      const { productId } = await createProduct(
        db,
        {
          eventId,
          storeId,
          sku: product.sku,
          name: product.name,
          pricePoints: product.price,
          categoryId: product.category,
          initialStock: product.stock,
          trackInventory: product.track ?? true,
        },
        staffContext,
      );
      productIds[product.sku] = productId;
    }
  }

  console.log('→ Creating cashiers and terminals');
  const cashiers: Record<string, string> = {};
  for (const store of storeDefs) {
    const storeId = storeIds[store.slug];
    if (!storeId) continue;
    const cashier = await createStaff(db, eventId, {
      displayName: `${store.name} Cashier`,
      email: `cashier.${store.slug}@example.com`,
      roleKey: 'PARTICIPANT',
      pin: '4821',
    });
    await assignStoreStaff(db, { eventId, storeId, userId: cashier, role: 'CASHIER' }, staffContext);
    cashiers[store.slug] = cashier;
    await registerTerminal(db, { eventId, storeId, name: `${store.name} POS 1` }, staffContext);
  }

  console.log('→ Issuing and assigning NFC cards');
  const cards = await createCards(
    db,
    { eventId, count: participants.length, batchLabel: 'Seed batch A' },
    staffContext,
  );
  for (const [index, participant] of participants.entries()) {
    const card = cards[index];
    if (!card) continue;
    await assignCard(db, { eventId, cardId: card.cardId, userId: participant.userId }, staffContext);
  }

  console.log('→ Issuing points');
  for (const [index, participant] of participants.entries()) {
    await topUpUser(
      db,
      {
        eventId,
        userId: participant.userId,
        amountPoints: 1_500 + (index % 5) * 250,
        reason: 'Registration welcome points',
        source: 'ADMIN_PANEL',
        createdBy: finance,
      },
      `seed-topup-${participant.userId}`,
      financeContext,
    );
  }

  for (const [index, teamId] of teamIds.entries()) {
    await allocateToTeam(
      db,
      {
        eventId,
        teamId,
        amountPoints: 8_000 + index * 1_200,
        mode: 'TEAM_SCORE',
        reason: 'Opening ceremony challenge results',
        createdBy: finance,
      },
      `seed-team-score-${teamId}`,
      financeContext,
    );
    await allocateToTeam(
      db,
      {
        eventId,
        teamId,
        amountPoints: 300,
        mode: 'EACH_MEMBER_FULL_AMOUNT',
        reason: 'Team bonus: everyone gets 300',
        createdBy: finance,
      },
      `seed-team-bonus-${teamId}`,
      financeContext,
    );
  }

  console.log('→ Simulating purchases');
  const basketPlans = [
    { store: 'food-court', lines: [['BURGER', 1], ['DRINK', 1]] },
    { store: 'food-court', lines: [['FRIES', 1], ['COFFEE', 1]] },
    { store: 'festival-store', lines: [['TSHIRT', 1]] },
    { store: 'games', lines: [['TOKEN10', 1]] },
    { store: 'props-costumes', lines: [['PROP', 2]] },
    { store: 'ai-tools', lines: [['AICREDITS', 1]] },
  ] as const;

  let purchaseCount = 0;
  let firstPurchaseId: string | null = null;
  for (const [index, participant] of participants.entries()) {
    const plan = basketPlans[index % basketPlans.length];
    if (!plan) continue;
    const storeId = storeIds[plan.store];
    const cashierUserId = cashiers[plan.store];
    if (!storeId || !cashierUserId) continue;

    const lines = plan.lines
      .map(([sku, quantity]) => ({ productId: productIds[sku] ?? '', quantity: quantity as number }))
      .filter((line) => line.productId !== '');

    const { receipt } = await checkout(
      db,
      { eventId, storeId, userId: participant.userId, cashierUserId, lines },
      `seed-purchase-${participant.userId}`,
      { actorUserId: cashierUserId, requestId: 'seed' },
    );
    firstPurchaseId ??= receipt.purchaseId;
    purchaseCount += 1;
  }

  console.log('→ Simulating a refund');
  if (firstPurchaseId) {
    await refundPurchase(
      db,
      {
        eventId,
        purchaseId: firstPurchaseId,
        reason: 'Customer changed their mind',
        requestedBy: finance,
      },
      `seed-refund-${firstPurchaseId}`,
      financeContext,
    );
  }

  console.log('→ Verifying ledger integrity');
  const integrity = await verifyLedgerIntegrity(db, eventId);
  if (!integrity.balanced) {
    throw new Error(
      `Seed produced an unbalanced ledger: sum=${integrity.eventSum}, drifting=${integrity.driftingAccounts}`,
    );
  }

  console.log('\nSeed complete.');
  console.log(`  Event            summer-festival-2026 (${eventId})`);
  console.log(`  Participants     ${participants.length}`);
  console.log(`  Stores           ${storeDefs.length}`);
  console.log(`  Purchases        ${purchaseCount}`);
  console.log(`  Ledger balanced  yes (sum = ${integrity.eventSum})`);
  console.log('\nSign in with any of these — password is the same for all:');
  console.log(`  superadmin@example.com   Super Admin        ${DEMO_PASSWORD}`);
  console.log(`  admin@example.com        Admin              ${DEMO_PASSWORD}`);
  console.log(`  finance@example.com      Admin (points)     ${DEMO_PASSWORD}`);
  console.log(`  storemanager@example.com Cashier (all stores) ${DEMO_PASSWORD}`);
  console.log(`  cashier.food-court@example.com  Cashier (PIN 4821)  ${DEMO_PASSWORD}`);
  console.log(`  participant1@example.com Participant        ${DEMO_PASSWORD}`);
  await closeDb();
}

async function createStaff(
  db: ReturnType<typeof getDb>,
  eventId: string,
  input: {
    displayName: string;
    email: string;
    roleKey: string;
    isSuperAdmin?: boolean;
    pin?: string;
  },
): Promise<string> {
  const { userId } = await createParticipant(
    db,
    {
      eventId,
      displayName: input.displayName,
      email: input.email,
      password: DEMO_PASSWORD,
      roleKey: input.roleKey,
    },
    { actorUserId: null, requestId: 'seed' },
  );

  const updates: Record<string, unknown> = {};
  if (input.isSuperAdmin) updates.isSuperAdmin = true;
  if (input.pin) updates.pinHash = await hashPin(input.pin);
  if (Object.keys(updates).length > 0) {
    await db.update(users).set(updates).where(eq(users.id, userId));
  }

  return userId;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
