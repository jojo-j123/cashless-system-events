/**
 * The complete permission catalogue.
 *
 * Permissions are the unit of authority; roles are only bundles of them. Route
 * handlers require permissions, never roles, so adding a role never requires
 * touching a route.
 */
export const PERMISSIONS = {
  // Participants
  'participant.read.self': 'View your own profile, balance and history',
  'participant.read.any': 'View any participant',
  'participant.write': 'Create and edit participants',
  'participant.suspend': 'Suspend or reactivate a participant',

  // Teams
  'team.read': 'View teams and members',
  'team.write': 'Create and edit teams',
  'team.allocate': 'Allocate points to a team',

  // Cards
  'card.read': 'View NFC cards and their history',
  'card.write': 'Create cards and edit card metadata',
  'card.assign': 'Assign or unassign a card',
  'card.suspend': 'Suspend, mark lost, or deactivate a card',
  'card.replace': 'Replace a card, carrying the wallet across',
  'card.resolve': 'Tap a card and resolve it to an account',

  // Wallet & ledger
  'wallet.read.self': 'View your own wallet',
  'wallet.read.any': 'View any wallet and its ledger',
  'wallet.topup': 'Issue points to a participant or team',
  'wallet.adjust': 'Make a manual adjustment, up or down',
  'wallet.transfer.self': 'Send points to another participant',
  'ledger.read': 'Read the raw ledger',
  'ledger.export': 'Export ledger and transaction data',

  // Stores, products, inventory
  'store.read': 'View stores',
  'store.write': 'Create and edit stores',
  'store.staff.manage': 'Assign cashiers and managers to a store',
  'product.read': 'View products',
  'product.write': 'Create and edit products, including prices',
  'inventory.read': 'View stock levels',
  'inventory.adjust': 'Adjust stock levels',

  // POS
  'pos.operate': 'Run a checkout at a store',
  'purchase.read.self': 'View your own purchases',
  'purchase.read.any': 'View any purchase',
  'purchase.refund': 'Refund a purchase',
  'purchase.refund.approve': 'Approve a refund that exceeds the threshold',

  // Gamification
  'challenge.read': 'View challenges',
  'challenge.write': 'Create and edit challenges',
  'challenge.award': 'Mark a challenge complete and award its points',
  'reward.read': 'View rewards',
  'reward.write': 'Create and edit rewards',
  'reward.redeem.self': 'Redeem a reward for yourself',

  // Operations & reporting
  'report.read': 'View reports and analytics',
  'report.export': 'Export reports',
  'leaderboard.read': 'View leaderboards',
  'terminal.read': 'View POS terminals and their health',
  'terminal.write': 'Register, rename and disable terminals',
  'ops.dashboard': 'View the live operations dashboard',

  // Administration
  'audit.read': 'Read the audit log',
  'settings.read': 'View event settings',
  'settings.write': 'Change event settings',
  'event.write': 'Create and edit events, change event status',
  'role.manage': 'Grant and revoke roles',
  'approval.decide': 'Approve or reject a pending high-value request',
} as const;

export type Permission = keyof typeof PERMISSIONS;

/** Re-exported so route definitions need only one import. */
export type { Scope } from './actor';

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const ROLE_KEYS = [
  'SUPER_ADMIN',
  'ADMIN',
  'FINANCE_MANAGER',
  'STORE_MANAGER',
  'CASHIER',
  'TEAM_MANAGER',
  'PARTICIPANT',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

const PARTICIPANT_PERMISSIONS: Permission[] = [
  'participant.read.self',
  'wallet.read.self',
  'purchase.read.self',
  'team.read',
  'store.read',
  'product.read',
  'challenge.read',
  'reward.read',
  'reward.redeem.self',
  'leaderboard.read',
  'wallet.transfer.self',
];

/**
 * A cashier can take money in and, if permitted, give it back — but cannot
 * create points, change a price, or touch a wallet directly. That separation
 * is the whole point of the role.
 */
const CASHIER_PERMISSIONS: Permission[] = [
  ...PARTICIPANT_PERMISSIONS,
  'pos.operate',
  'card.resolve',
  'card.read',
  'participant.read.any',
  'purchase.read.any',
  'purchase.refund',
  'inventory.read',
];

const STORE_MANAGER_PERMISSIONS: Permission[] = [
  ...CASHIER_PERMISSIONS,
  'product.write',
  'inventory.adjust',
  'store.staff.manage',
  'report.read',
  'report.export',
  'terminal.read',
  'purchase.refund.approve',
];

const TEAM_MANAGER_PERMISSIONS: Permission[] = [
  ...PARTICIPANT_PERMISSIONS,
  'participant.read.any',
  'team.allocate',
  'report.read',
];

const FINANCE_MANAGER_PERMISSIONS: Permission[] = [
  ...PARTICIPANT_PERMISSIONS,
  'participant.read.any',
  'wallet.read.any',
  'wallet.topup',
  'wallet.adjust',
  'team.allocate',
  'ledger.read',
  'ledger.export',
  'report.read',
  'report.export',
  'audit.read',
  'purchase.read.any',
  'purchase.refund',
  'purchase.refund.approve',
  'approval.decide',
];

const ADMIN_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter(
  (permission) => permission !== 'role.manage',
);

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  FINANCE_MANAGER: unique(FINANCE_MANAGER_PERMISSIONS),
  STORE_MANAGER: unique(STORE_MANAGER_PERMISSIONS),
  CASHIER: unique(CASHIER_PERMISSIONS),
  TEAM_MANAGER: unique(TEAM_MANAGER_PERMISSIONS),
  PARTICIPANT: unique(PARTICIPANT_PERMISSIONS),
};

export const ROLE_DESCRIPTIONS: Record<RoleKey, string> = {
  SUPER_ADMIN: 'Unrestricted access, including granting roles.',
  ADMIN: 'Runs the event: users, teams, cards, stores, points, reports.',
  FINANCE_MANAGER: 'Owns points: top-ups, adjustments, the ledger and approvals.',
  STORE_MANAGER: 'Runs one store: products, stock, staff and store reports.',
  CASHIER: 'Operates a POS terminal: checkout and permitted refunds.',
  TEAM_MANAGER: 'Views their team and allocates team rewards where authorised.',
  PARTICIPANT: 'An event attendee: balance, purchases, team and rewards.',
};

/** Roles whose grants are meaningful only in the context of one store. */
export const STORE_SCOPED_ROLES: ReadonlySet<RoleKey> = new Set<RoleKey>([
  'CASHIER',
  'STORE_MANAGER',
]);

function unique(permissions: Permission[]): Permission[] {
  return [...new Set(permissions)];
}
