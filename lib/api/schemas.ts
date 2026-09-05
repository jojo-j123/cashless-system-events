import { z } from 'zod';

export const uuid = z.string().uuid();
export const points = z.number().int();
export const positivePoints = z.number().int().positive();
export const reason = z.string().trim().min(3).max(500);

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(1024),
});

export const cardCredentialSchema = z.object({
  kind: z.enum(['TOKEN', 'UID', 'MANUAL_REF']),
  value: z.string().min(1).max(512),
  terminalId: uuid.optional(),
  storeId: uuid.optional(),
});

export const checkoutSchema = z.object({
  storeId: uuid,
  userId: uuid,
  cardId: uuid.nullish(),
  terminalId: uuid.nullish(),
  lines: z
    .array(z.object({ productId: uuid, quantity: z.number().int().min(1).max(1_000) }))
    .min(1)
    .max(100),
  notes: z.string().max(500).nullish(),
});

export const refundSchema = z.object({
  lines: z
    .array(z.object({ purchaseItemId: uuid, quantity: z.number().int().min(1) }))
    .max(100)
    .optional(),
  reason,
  restockInventory: z.boolean().optional(),
});

export const topUpUserSchema = z.object({
  userId: uuid,
  amountPoints: positivePoints,
  reason,
  source: z.enum(['ADMIN_PANEL', 'POS_COUNTER', 'BULK_CSV', 'API']).optional(),
  terminalId: uuid.nullish(),
  pin: z.string().regex(/^\d{4,12}$/).optional(),
});

export const topUpTeamSchema = z.object({
  teamId: uuid,
  amountPoints: positivePoints,
  mode: z.enum([
    'TEAM_WALLET',
    'TEAM_SCORE',
    'SPLIT_EQUALLY_TO_MEMBERS',
    'EACH_MEMBER_FULL_AMOUNT',
  ]),
  reason,
});

export const adjustSchema = z.object({
  userId: uuid,
  amountPoints: points.refine((value) => value !== 0, 'Adjustment cannot be zero.'),
  reason: z.string().trim().min(5).max(500),
});

export const transferSchema = z.object({
  toUserId: uuid,
  amountPoints: positivePoints,
  note: z.string().max(200).nullish(),
});

export const productWriteSchema = z.object({
  storeId: uuid,
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).nullish(),
  pricePoints: z.number().int().min(0),
  categoryId: uuid.nullish(),
  initialStock: z.number().int().min(0).max(1_000_000).optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
  trackInventory: z.boolean().optional(),
  maxPerPurchase: z.number().int().positive().nullish(),
});

export const productPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2_000).nullish(),
  pricePoints: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  maxPerPurchase: z.number().int().positive().nullish(),
  categoryId: uuid.nullish(),
});

export const inventoryAdjustSchema = z.object({
  productId: uuid,
  quantityDelta: z.number().int().refine((value) => value !== 0, 'Delta cannot be zero.'),
  type: z.enum(['RESTOCK', 'ADJUSTMENT', 'DAMAGE', 'LOSS']),
  reason,
});

export const cardBatchSchema = z.object({
  count: z.number().int().min(1).max(5_000),
  technology: z
    .enum(['NTAG213', 'NTAG215', 'NTAG216', 'MIFARE_CLASSIC', 'DESFIRE_EV2', 'OTHER'])
    .optional(),
  batchLabel: z.string().max(120).nullish(),
});

export const cardAssignSchema = z.object({ cardId: uuid, userId: uuid });
export const cardStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'LOST', 'DEACTIVATED']),
  reason,
});
export const cardReplaceSchema = z.object({
  oldCardId: uuid,
  newCardId: uuid,
  reason,
  retireAs: z.enum(['LOST', 'REPLACED', 'DEACTIVATED']).optional(),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  note: z.string().max(500).optional(),
});

export const bulkTopUpRowSchema = z.object({
  identifier: z.string().trim().min(1).max(320),
  amountPoints: positivePoints,
  reason: z.string().trim().max(500).optional(),
});

export const bulkTopUpSchema = z.object({
  filename: z.string().max(255).optional(),
  defaultReason: reason,
  rows: z.array(bulkTopUpRowSchema).min(1).max(10_000),
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).nullish(),
});

/**
 * The desk enrolment: one person, one tag, one opening balance.
 *
 * `topUpPoints` may be zero — a card can be handed out empty and loaded later.
 */
export const enrolCardSchema = z.object({
  displayName: z.string().min(2).max(120),
  teamId: z.string().uuid().nullish(),
  uid: z.string().min(4).max(64),
  topUpPoints: z.number().int().nonnegative().max(1_000_000).default(0),
});
