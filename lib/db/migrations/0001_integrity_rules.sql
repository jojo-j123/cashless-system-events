-- ============================================================================
-- Integrity rules that the schema builder cannot express.
--
-- Everything here is a *last line of defence*. Application services return
-- friendly errors long before these fire. If one of these ever raises in
-- production it means a code path bypassed the service layer, and failing the
-- transaction is strictly better than silently corrupting the ledger.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Deferred / circular foreign keys
--
-- These could not be declared inline because the tables reference each other
-- (stores -> accounts -> stores) or themselves.
-- ---------------------------------------------------------------------------
ALTER TABLE "nfc_cards"
  ADD CONSTRAINT "nfc_cards_replaced_by_fk"
  FOREIGN KEY ("replaced_by_card_id") REFERENCES "nfc_cards"("id") ON DELETE SET NULL;

ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "ledger_transactions_reverses_fk"
  FOREIGN KEY ("reverses_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT;

ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_store_fk"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_terminal_fk"
  FOREIGN KEY ("terminal_id") REFERENCES "terminals"("id") ON DELETE SET NULL;

ALTER TABLE "card_taps"
  ADD CONSTRAINT "card_taps_terminal_fk"
  FOREIGN KEY ("terminal_id") REFERENCES "terminals"("id") ON DELETE SET NULL;

ALTER TABLE "card_taps"
  ADD CONSTRAINT "card_taps_store_fk"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL;

ALTER TABLE "user_roles"
  ADD CONSTRAINT "user_roles_store_fk"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE;

ALTER TABLE "topups"
  ADD CONSTRAINT "topups_batch_fk"
  FOREIGN KEY ("batch_id") REFERENCES "topup_batches"("id") ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2. Human-readable reference sequences
--
-- nextval() is non-transactional on purpose: it takes no lock, so thousands of
-- concurrent checkouts do not serialise behind a counter row. The cost is that
-- a rolled-back transaction leaves a gap in the numbering. That is expected and
-- normal for financial document numbering.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS "ledger_txn_ref_seq" START 1;
CREATE SEQUENCE IF NOT EXISTS "purchase_ref_seq"   START 1;
CREATE SEQUENCE IF NOT EXISTS "refund_ref_seq"     START 1;
CREATE SEQUENCE IF NOT EXISTS "topup_ref_seq"      START 1;
CREATE SEQUENCE IF NOT EXISTS "transfer_ref_seq"   START 1;
CREATE SEQUENCE IF NOT EXISTS "card_ref_seq"       START 1;
CREATE SEQUENCE IF NOT EXISTS "participant_ref_seq" START 1;
CREATE SEQUENCE IF NOT EXISTS "terminal_ref_seq"   START 1;

-- ---------------------------------------------------------------------------
-- 3. Append-only enforcement
--
-- A financial history that can be edited is not a financial history. Mistakes
-- are corrected by writing a compensating transaction, never by rewriting one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "forbid_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only; % is not permitted. Write a compensating record instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "ledger_transactions_append_only"
  BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();

CREATE TRIGGER "ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();

CREATE TRIGGER "inventory_movements_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();

CREATE TRIGGER "card_events_append_only"
  BEFORE UPDATE OR DELETE ON "card_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();

-- ---------------------------------------------------------------------------
-- 4. Double-entry: every transaction's legs must sum to zero
--
-- This is the invariant that makes "points in circulation" a provable number
-- rather than an estimate. Deferred to COMMIT so a transaction can insert its
-- legs one at a time.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "assert_transaction_balanced"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  leg_count  integer;
  leg_sum    bigint;
  target_id  uuid := COALESCE(NEW."transaction_id", OLD."transaction_id");
BEGIN
  SELECT count(*), COALESCE(sum("amount"), 0)
    INTO leg_count, leg_sum
    FROM "ledger_entries"
   WHERE "transaction_id" = target_id;

  IF leg_count < 2 THEN
    RAISE EXCEPTION
      'Ledger transaction % has % entries; double-entry requires at least 2.',
      target_id, leg_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF leg_sum <> 0 THEN
    RAISE EXCEPTION
      'Ledger transaction % is unbalanced by % points.', target_id, leg_sum
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ledger_entries_balanced"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_transaction_balanced"();

-- Every entry must belong to the same event as its transaction and account.
CREATE OR REPLACE FUNCTION "assert_entry_event_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  txn_event uuid;
  acc_event uuid;
BEGIN
  SELECT "event_id" INTO txn_event FROM "ledger_transactions" WHERE "id" = NEW."transaction_id";
  SELECT "event_id" INTO acc_event FROM "accounts" WHERE "id" = NEW."account_id";

  IF txn_event IS DISTINCT FROM NEW."event_id" OR acc_event IS DISTINCT FROM NEW."event_id" THEN
    RAISE EXCEPTION
      'Ledger entry crosses events (entry=%, transaction=%, account=%).',
      NEW."event_id", txn_event, acc_event
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ledger_entries_event_scope"
  BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "assert_entry_event_scope"();

-- ---------------------------------------------------------------------------
-- 5. updated_at maintenance
--
-- Done in the database so a forgotten assignment in application code cannot
-- produce a stale timestamp.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "touch_updated_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."updated_at" := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'events', 'users', 'teams', 'nfc_cards', 'accounts', 'stores',
    'products', 'inventory', 'purchases', 'terminals'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
      target || '_touch_updated_at', target
    );
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Reconciliation view
--
-- `accounts.balance` is a materialised cache. This view proves it matches the
-- ledger. The test suite asserts it returns zero rows; ops can query it live.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW "account_reconciliation" AS
SELECT
  a."id"          AS account_id,
  a."event_id",
  a."type",
  a."name",
  a."balance"     AS materialised_balance,
  COALESCE(e."ledger_balance", 0) AS ledger_balance,
  a."balance" - COALESCE(e."ledger_balance", 0) AS drift
FROM "accounts" a
LEFT JOIN (
  SELECT "account_id", sum("amount")::bigint AS "ledger_balance"
  FROM "ledger_entries"
  GROUP BY "account_id"
) e ON e."account_id" = a."id";

COMMENT ON VIEW "account_reconciliation" IS
  'Materialised account balance vs the sum of its ledger entries. Any row with drift <> 0 is a bug.';
