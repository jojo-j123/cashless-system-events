import { z } from 'zod';

/**
 * Per-event configuration. Every knob an operator can turn lives here, is
 * validated on write, and has a safe default.
 *
 * Defaults are deliberately conservative: the risky features (negative
 * balances, peer transfers, offline spending) are all OFF.
 */
export const eventSettingsSchema = z.object({
  /* ---- Wallet limits ---------------------------------------------------- */
  maxWalletBalance: z.number().int().positive().max(100_000_000).default(1_000_000),
  maxSingleTopUp: z.number().int().positive().max(100_000_000).default(50_000),
  maxSinglePurchase: z.number().int().positive().max(100_000_000).default(100_000),
  /** Off by default. A wallet that can go negative is an uncollectable debt. */
  allowNegativeBalance: z.boolean().default(false),

  /* ---- Feature switches -------------------------------------------------- */
  allowTransfers: z.boolean().default(false),
  allowRefunds: z.boolean().default(true),
  /** See docs/architecture.md §9. Enabling this accepts bounded double-spend. */
  offlinePosEnabled: z.boolean().default(false),
  offlineSpendCap: z.number().int().nonnegative().default(0),

  /* ---- Transfers --------------------------------------------------------- */
  maxSingleTransfer: z.number().int().positive().default(1_000),
  dailyTransferLimit: z.number().int().positive().default(2_000),
  requirePinForTransfer: z.boolean().default(true),

  /* ---- Approvals (two-person control) ------------------------------------ */
  /** Manual adjustments at or above this need a second approver. 0 = always. */
  approvalThresholdAdjustment: z.number().int().nonnegative().default(5_000),
  approvalThresholdTopUp: z.number().int().nonnegative().default(20_000),
  approvalThresholdRefund: z.number().int().nonnegative().default(10_000),
  /** Staff PIN required for counter top-ups at or above this amount. */
  pinRequiredAboveTopUp: z.number().int().nonnegative().default(1_000),

  /* ---- Cards ------------------------------------------------------------- */
  /**
   * Accepting a bare chip UID as proof of identity is weak: UIDs are readable
   * and clonable by any phone. Leave off unless the hardware forces it.
   */
  allowUidOnlyResolution: z.boolean().default(false),
  /** Reject taps of the same card closer together than this. */
  tapCooldownMs: z.number().int().nonnegative().default(750),
  maxTapsPerCardPerMinute: z.number().int().positive().default(30),
  qrTokenTtlSeconds: z.number().int().positive().max(3600).default(120),

  /* ---- Inventory & balances ---------------------------------------------- */
  lowBalanceThreshold: z.number().int().nonnegative().default(100),
  defaultLowStockThreshold: z.number().int().nonnegative().default(5),
  /** Whether refunds put stock back by default. Staff can override per refund. */
  restockOnRefundByDefault: z.boolean().default(true),

  /* ---- Sessions ---------------------------------------------------------- */
  sessionTimeoutMinutes: z.number().int().positive().max(43_200).default(720),
  posSessionTimeoutMinutes: z.number().int().positive().max(1_440).default(240),

  /* ---- Leaderboard ------------------------------------------------------- */
  teamRankingMetric: z
    .enum(['TEAM_SCORE', 'TOTAL_EARNED', 'TOTAL_SPENT', 'CURRENT_BALANCE'])
    .default('TEAM_SCORE'),
  individualRankingMetric: z
    .enum(['TOTAL_EARNED', 'TOTAL_SPENT', 'CHALLENGE_POINTS', 'CURRENT_BALANCE'])
    .default('TOTAL_EARNED'),
  leaderboardVisibleToParticipants: z.boolean().default(true),
});

export type EventSettings = z.infer<typeof eventSettingsSchema>;

/** Every field optional, for PATCH-style updates. */
export const eventSettingsPatchSchema = eventSettingsSchema.partial();
export type EventSettingsPatch = z.infer<typeof eventSettingsPatchSchema>;

export const DEFAULT_EVENT_SETTINGS: EventSettings = eventSettingsSchema.parse({});
