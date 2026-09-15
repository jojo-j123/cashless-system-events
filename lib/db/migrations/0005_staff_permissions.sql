-- ============================================================================
-- Register the permissions added for bulk removal and till top-ups.
--
-- The permission catalogue lives in TypeScript (`lib/authz/permissions.ts`) and
-- is reconciled into these tables by `syncRolesAndPermissions`. That function
-- runs from the seed, the reset and the test harness — none of which touch a
-- production database. `scripts/migrate.mjs` is the only thing that runs on a
-- deploy, and it is deliberately plain ESM so the runtime image does not have
-- to ship `tsx`, which means it cannot import the catalogue either.
--
-- So a new permission reaches an existing database exactly one way: here. A
-- permission that is added to the catalogue without a migration like this one
-- is silently inert in production — the role that is supposed to hold it has no
-- row in `role_permissions`, every check against it returns false, and the
-- feature it guards simply never appears. That is the failure this file exists
-- to prevent, and 0003 is the precedent for doing it in SQL.
--
--   participant.remove  Remove participants from an event in bulk.
--   card.remove         Delete or deactivate cards in bulk.
--   wallet.topup.pos    Load points at the till, capped and PIN-gated.
--
-- The first two are administrative and go to the roles that run the event. The
-- third also goes to CASHIER: it is the one place a till may create points, and
-- it is a narrower grant than `wallet.topup` in every direction — capped per
-- transaction, scoped to the cashier's own store, and useless for team
-- allocation. Handing the till the wider permission instead would let a cashier
-- mint without limit, which is exactly what the split avoids.
--
-- Written to be re-runnable: both inserts conflict-do-nothing, so applying this
-- against a database that has already been through `syncRolesAndPermissions`
-- changes nothing.
-- ============================================================================

INSERT INTO permissions (key, description)
VALUES
  ('participant.remove', 'Remove participants from an event in bulk'),
  ('card.remove',        'Delete or deactivate cards in bulk'),
  ('wallet.topup.pos',   'Load points at the till, up to the counter limit')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p
    ON p.key IN ('participant.remove', 'card.remove', 'wallet.topup.pos')
 WHERE r.key IN ('SUPER_ADMIN', 'ADMIN')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.key = 'wallet.topup.pos'
 WHERE r.key = 'CASHIER'
ON CONFLICT DO NOTHING;
