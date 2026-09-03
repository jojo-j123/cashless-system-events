-- ============================================================================
-- Close the managed-Postgres API surface.
--
-- Some managed Postgres providers (Supabase among them) publish the `public`
-- schema over an auto-generated REST API, and pre-grant every newly created
-- table to an `anon` role whose API key is public *by design*. On a fresh
-- project the default privileges for a table created by `postgres` are
-- `arwdDxtm` to `anon` — that is INSERT, SELECT, UPDATE and DELETE, to
-- unauthenticated callers.
--
-- For a normal CRUD app that is a deliberate feature, paired with row-level
-- security policies. For this schema it is a hole straight through the
-- financial model: every guarantee here — the double-entry ledger, the
-- `FOR UPDATE` locks, idempotency, two-person approval — assumes writes arrive
-- through the application. `accounts.balance` carries no append-only trigger
-- (only ledger, audit, inventory-movement and card-event tables do), so a
-- direct `UPDATE accounts SET balance = …` over that REST endpoint would set
-- any wallet to any number, and the ledger would never know.
--
-- So: revoke the grants, and enable row-level security with no policies, which
-- denies all access to any role that does not bypass RLS. The application
-- connects as the database owner (`postgres`), which has BYPASSRLS and is
-- therefore unaffected — verified, not assumed.
--
-- This migration is a no-op on a plain Postgres server (local development, CI,
-- a container deployment): the `anon` and `authenticated` roles do not exist
-- there, so the revokes are skipped. Enabling RLS on a table nobody queries as
-- a non-owner is harmless, so that part runs everywhere.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Enable row-level security on every table in `public`.
--
-- RLS enabled with zero policies = deny all, for every role without BYPASSRLS.
-- This is the load-bearing protection; the revokes below are defence in depth.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.tablename);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Withdraw the API roles' privileges, present and future.
--
-- Guarded on role existence so this file also applies cleanly to a plain
-- Postgres server, where these roles are absent.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      -- Privileges already granted on what exists now.
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', api_role);

      -- And the defaults that would re-grant everything on the next table we
      -- create. This only clears defaults recorded for the role running this
      -- migration, which is the role that owns these tables.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', api_role);
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Note for whoever adds the next table.
--
-- Step 1 enables RLS on the tables that exist *right now*. A table created by a
-- later migration starts with RLS off, and step 2's default-privilege revoke is
-- the only thing standing between it and the public API. An event trigger would
-- automate this, but creating one requires superuser, which the application
-- role deliberately is not.
--
-- So: any migration that adds a table to `public` must also
--
--     ALTER TABLE public.<new_table> ENABLE ROW LEVEL SECURITY;
--
-- Supabase's own security advisor flags a table in an exposed schema without
-- RLS, which is the backstop if this is ever forgotten — but it is a backstop,
-- not the plan.
-- ---------------------------------------------------------------------------
