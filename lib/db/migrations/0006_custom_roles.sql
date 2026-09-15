-- ============================================================================
-- Let a super admin own a role's permissions.
--
-- Until now `lib/authz/permissions.ts` was the only source of truth for what a
-- role may do, and `syncRolesAndPermissions` enforced that by replacing every
-- role's grants wholesale on each run — deliberately, so that deleting a
-- permission from the catalogue actually revoked it rather than leaving it
-- granted forever.
--
-- That guarantee is worth keeping for roles nobody has touched, and is exactly
-- wrong for a role somebody has edited on purpose: the edit would survive until
-- the next seed or reset and then silently vanish. So ownership becomes a
-- property of the row. A role starts owned by the catalogue; the first hand
-- edit transfers it, and from then on the sync leaves its grants alone. The
-- editor offers a "reset to defaults" that hands it back.
--
-- Custom roles (`is_system = false`) are never seeded and never retired by the
-- sync, which previously deleted anything it did not recognise.
-- ============================================================================

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS permissions_customised boolean NOT NULL DEFAULT false;
