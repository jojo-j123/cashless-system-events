import { pgEnum } from 'drizzle-orm/pg-core';

export const eventStatus = pgEnum('event_status', [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'ENDED',
  'ARCHIVED',
]);

export const userStatus = pgEnum('user_status', ['ACTIVE', 'SUSPENDED', 'DEACTIVATED']);

export const cardStatus = pgEnum('card_status', [
  'UNASSIGNED',
  'ACTIVE',
  'SUSPENDED',
  'LOST',
  'REPLACED',
  'DEACTIVATED',
]);

export const cardTechnology = pgEnum('card_technology', [
  'NTAG213',
  'NTAG215',
  'NTAG216',
  'MIFARE_CLASSIC',
  'DESFIRE_EV2',
  'QR_ONLY',
  'OTHER',
]);

/** How a card was presented at a terminal. */
export const credentialKind = pgEnum('credential_kind', ['TOKEN', 'UID', 'QR', 'MANUAL_REF']);

export const tapOutcome = pgEnum('tap_outcome', [
  'RESOLVED',
  'CARD_NOT_FOUND',
  'CARD_NOT_ASSIGNED',
  'CARD_SUSPENDED',
  'CARD_LOST',
  'CARD_DEACTIVATED',
  'CARD_EXPIRED',
  'USER_SUSPENDED',
  'RATE_LIMITED',
  'INVALID_CREDENTIAL',
]);

/**
 * Ledger account types.
 *
 * SYSTEM_* accounts are the counterparties that make every transaction balance
 * to zero. Holder accounts (USER_*, TEAM_*) are what people see as "wallets".
 */
export const accountType = pgEnum('account_type', [
  'USER_SPENDABLE',
  'USER_SCORE',
  'TEAM_SPENDABLE',
  'TEAM_SCORE',
  'SYSTEM_ISSUANCE',
  'SYSTEM_STORE_REVENUE',
  'SYSTEM_FORFEITURE',
]);

export const accountStatus = pgEnum('account_status', ['ACTIVE', 'FROZEN', 'CLOSED']);

export const ledgerTransactionType = pgEnum('ledger_transaction_type', [
  'TOP_UP',
  'TEAM_ALLOCATION',
  'BONUS',
  'CHALLENGE_REWARD',
  'PURCHASE',
  'REFUND',
  'MANUAL_ADJUSTMENT',
  'TRANSFER',
  'REVERSAL',
  'REWARD_REDEMPTION',
  'SCORE_AWARD',
]);

export const purchaseStatus = pgEnum('purchase_status', [
  'PENDING',
  'AUTHORIZED',
  'COMPLETED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'CANCELLED',
]);

export const refundType = pgEnum('refund_type', ['FULL', 'PARTIAL']);

export const approvalStatus = pgEnum('approval_status', [
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export const topupTargetType = pgEnum('topup_target_type', ['USER', 'TEAM']);

export const topupSource = pgEnum('topup_source', [
  'ADMIN_PANEL',
  'POS_COUNTER',
  'BULK_CSV',
  'API',
  'SYSTEM',
]);

/** How a team allocation lands: on the team's own account, or split to members. */
export const allocationMode = pgEnum('allocation_mode', [
  'TEAM_WALLET',
  'TEAM_SCORE',
  'SPLIT_EQUALLY_TO_MEMBERS',
  'EACH_MEMBER_FULL_AMOUNT',
]);

export const batchStatus = pgEnum('batch_status', [
  'DRAFT',
  'VALIDATED',
  'COMMITTED',
  'CANCELLED',
]);

export const inventoryMovementType = pgEnum('inventory_movement_type', [
  'INITIAL',
  'RESTOCK',
  'SALE',
  'REFUND_RESTOCK',
  'ADJUSTMENT',
  'DAMAGE',
  'LOSS',
]);

export const storeStaffRole = pgEnum('store_staff_role', ['MANAGER', 'CASHIER']);

export const teamMemberRole = pgEnum('team_member_role', ['MEMBER', 'MANAGER']);

export const terminalStatus = pgEnum('terminal_status', [
  'ONLINE',
  'OFFLINE',
  'ERROR',
  'DISABLED',
]);

export const idempotencyStatus = pgEnum('idempotency_status', [
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
]);

export const notificationSeverity = pgEnum('notification_severity', [
  'INFO',
  'SUCCESS',
  'WARNING',
  'ERROR',
]);

export const rewardType = pgEnum('reward_type', [
  'PRODUCT',
  'EXPERIENCE',
  'PRIVILEGE',
  'DIGITAL',
]);

export const challengeStatus = pgEnum('challenge_status', ['DRAFT', 'ACTIVE', 'ENDED']);

export const approvalRequestType = pgEnum('approval_request_type', [
  'MANUAL_ADJUSTMENT',
  'LARGE_TOP_UP',
  'LARGE_REFUND',
  'BULK_ALLOCATION',
]);
