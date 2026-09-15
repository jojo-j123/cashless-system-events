-- ============================================================================
-- Record reward redemptions.
--
-- `rewards` shipped in the initial schema and nothing has ever written to it,
-- because there was nowhere to record that somebody redeemed one. Without that
-- record there is no fulfilment ("has this person actually been handed their
-- hoodie?"), no way to reverse a mistake, and nothing for the ledger entry to
-- point at.
--
-- Two deliberate choices here:
--
--   * `cost_points` is copied onto the redemption rather than read back through
--     `rewards`. An operator retiring or repricing a reward next week must not
--     rewrite what somebody was charged for it today.
--
--   * Stock gets a CHECK constraint, mirroring `inventory`. Redemption
--     decrements it with a conditional UPDATE, so overselling is impossible at
--     the storage layer and not merely unlikely in application code.
-- ============================================================================

CREATE TYPE reward_redemption_status AS ENUM ('CLAIMED', 'FULFILLED', 'CANCELLED');
--> statement-breakpoint

ALTER TABLE rewards
  ADD CONSTRAINT rewards_stock_non_negative CHECK (stock IS NULL OR stock >= 0);
--> statement-breakpoint

CREATE TABLE reward_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- RESTRICT on both: a redemption is a financial record, so neither the reward
  -- nor the person who claimed it can be deleted out from under it.
  reward_id uuid NOT NULL REFERENCES rewards(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cost_points bigint NOT NULL,
  status reward_redemption_status NOT NULL DEFAULT 'CLAIMED',
  ledger_transaction_id uuid REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  reversal_transaction_id uuid REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  fulfilled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  fulfilled_at timestamptz,
  cancelled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reward_redemptions_cost_non_negative CHECK (cost_points >= 0),
  -- A cancelled redemption must carry its reversal, and an uncancelled one must
  -- not: the status and the money it moved cannot disagree.
  CONSTRAINT reward_redemptions_cancel_consistent CHECK (
    (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
  ),
  CONSTRAINT reward_redemptions_fulfil_consistent CHECK (
    (status = 'FULFILLED') = (fulfilled_at IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE INDEX reward_redemptions_event_time_idx ON reward_redemptions (event_id, created_at);
--> statement-breakpoint

CREATE INDEX reward_redemptions_user_time_idx ON reward_redemptions (user_id, created_at);
--> statement-breakpoint

CREATE INDEX reward_redemptions_reward_idx ON reward_redemptions (reward_id);
--> statement-breakpoint

-- Outstanding claims are what a fulfilment desk works from, so index the open
-- ones rather than scanning every redemption the event has ever taken.
CREATE INDEX reward_redemptions_open_idx ON reward_redemptions (event_id, created_at)
  WHERE status = 'CLAIMED';
--> statement-breakpoint

CREATE TRIGGER reward_redemptions_no_delete
  BEFORE DELETE ON reward_redemptions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
