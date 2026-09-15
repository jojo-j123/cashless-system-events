import type { Actor } from '../authz/actor';
import { STAFF_PERMISSIONS, type Permission } from '../authz/permissions';

export interface NavItem {
  href: string;
  label: string;
  permission: Permission;
  gameOnly?: boolean;
  superAdminOnly?: boolean;
}

/**
 * One flat list, in the order the desk actually uses it.
 *
 * Grouping five links under five headings was more chrome than navigation.
 * `gameOnly` entries disappear entirely when the event is not running a game,
 * so an operator running a plain cashless bar never sees a leaderboard.
 *
 * This list is the single answer to three separate questions — which links to
 * draw, whether somebody may enter the console at all, and where to send them
 * when they sign in. They were three answers once, and a custom role that could
 * enrol cards was admitted by none of them: the console gate asked for
 * `report.read` specifically, so a role built to work the door was bounced from
 * the door.
 */
export const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Dashboard', permission: 'report.read' },
  { href: '/admin/enrol', label: 'Add a card', permission: 'card.write' },
  // The till itself, not an admin view of it. An admin holds `pos.operate`
  // across every store, so this is the one link here that leaves the console.
  { href: '/pos', label: 'Till', permission: 'pos.operate' },
  { href: '/admin/points', label: 'Top-ups', permission: 'wallet.topup' },
  { href: '/admin/participants', label: 'People', permission: 'participant.read.any' },
  { href: '/admin/cards', label: 'Cards', permission: 'card.read' },
  { href: '/admin/inventory', label: 'Products', permission: 'inventory.read' },
  // Not gameOnly: rewards spend points, they do not score them, so a normal
  // event has just as much use for them.
  { href: '/admin/rewards', label: 'Rewards', permission: 'reward.read' },
  { href: '/admin/game', label: 'Game', permission: 'leaderboard.read', gameOnly: true },
  { href: '/admin/audit', label: 'Audit log', permission: 'audit.read' },
  { href: '/admin/system', label: 'System', permission: 'report.read', superAdminOnly: true },
];

/**
 * The links this actor may actually use.
 *
 * `canAnywhere` rather than `can`, because a cashier's grants are scoped to the
 * store they work: asking with only an event would compare their store against
 * null and hide every link they have. Filtered server-side, so a link somebody
 * cannot use is never rendered — the real control is in the API, always.
 */
/** Whether this actor works here at all, and so may enter the console. */
export function isStaff(actor: Actor, eventId: string): boolean {
  return STAFF_PERMISSIONS.some((permission) => actor.canAnywhere(permission, eventId));
}

export function visibleNavFor(
  actor: Actor,
  eventId: string,
  gameModeEnabled: boolean,
): NavItem[] {
  return ADMIN_NAV.filter(
    (item) =>
      (!item.gameOnly || gameModeEnabled) &&
      (!item.superAdminOnly || actor.isSuperAdmin) &&
      actor.canAnywhere(item.permission, eventId),
  );
}

/**
 * Where to drop somebody after they sign in.
 *
 * The first thing they can open, which for an admin is the dashboard, for a
 * cashier the till, and for a custom role whatever it was built to do. Falling
 * back to the participant dashboard is right only for an actual participant —
 * a staff login has no wallet to show there.
 */
export function landingPathFor(
  actor: Actor,
  eventId: string,
  gameModeEnabled: boolean,
): string {
  if (!isStaff(actor, eventId)) return '/me';
  return visibleNavFor(actor, eventId, gameModeEnabled)[0]?.href ?? '/me';
}
