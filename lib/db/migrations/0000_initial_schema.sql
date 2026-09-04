CREATE TYPE "public"."account_status" AS ENUM('ACTIVE', 'FROZEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('USER_SPENDABLE', 'USER_SCORE', 'TEAM_SPENDABLE', 'TEAM_SCORE', 'SYSTEM_ISSUANCE', 'SYSTEM_STORE_REVENUE', 'SYSTEM_FORFEITURE');--> statement-breakpoint
CREATE TYPE "public"."allocation_mode" AS ENUM('TEAM_WALLET', 'TEAM_SCORE', 'SPLIT_EQUALLY_TO_MEMBERS', 'EACH_MEMBER_FULL_AMOUNT');--> statement-breakpoint
CREATE TYPE "public"."approval_request_type" AS ENUM('MANUAL_ADJUSTMENT', 'LARGE_TOP_UP', 'LARGE_REFUND', 'BULK_ALLOCATION');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('DRAFT', 'VALIDATED', 'COMMITTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."card_status" AS ENUM('UNASSIGNED', 'ACTIVE', 'SUSPENDED', 'LOST', 'REPLACED', 'DEACTIVATED');--> statement-breakpoint
CREATE TYPE "public"."card_technology" AS ENUM('NTAG213', 'NTAG215', 'NTAG216', 'MIFARE_CLASSIC', 'DESFIRE_EV2', 'QR_ONLY', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."challenge_status" AS ENUM('DRAFT', 'ACTIVE', 'ENDED');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('TOKEN', 'UID', 'QR', 'MANUAL_REF');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('IN_PROGRESS', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."inventory_movement_type" AS ENUM('INITIAL', 'RESTOCK', 'SALE', 'REFUND_RESTOCK', 'ADJUSTMENT', 'DAMAGE', 'LOSS');--> statement-breakpoint
CREATE TYPE "public"."ledger_transaction_type" AS ENUM('TOP_UP', 'TEAM_ALLOCATION', 'BONUS', 'CHALLENGE_REWARD', 'PURCHASE', 'REFUND', 'MANUAL_ADJUSTMENT', 'TRANSFER', 'REVERSAL', 'REWARD_REDEMPTION', 'SCORE_AWARD');--> statement-breakpoint
CREATE TYPE "public"."notification_severity" AS ENUM('INFO', 'SUCCESS', 'WARNING', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."purchase_status" AS ENUM('PENDING', 'AUTHORIZED', 'COMPLETED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."refund_type" AS ENUM('FULL', 'PARTIAL');--> statement-breakpoint
CREATE TYPE "public"."reward_type" AS ENUM('PRODUCT', 'EXPERIENCE', 'PRIVILEGE', 'DIGITAL');--> statement-breakpoint
CREATE TYPE "public"."store_staff_role" AS ENUM('MANAGER', 'CASHIER');--> statement-breakpoint
CREATE TYPE "public"."tap_outcome" AS ENUM('RESOLVED', 'CARD_NOT_FOUND', 'CARD_NOT_ASSIGNED', 'CARD_SUSPENDED', 'CARD_LOST', 'CARD_DEACTIVATED', 'CARD_EXPIRED', 'USER_SUSPENDED', 'RATE_LIMITED', 'INVALID_CREDENTIAL');--> statement-breakpoint
CREATE TYPE "public"."team_member_role" AS ENUM('MEMBER', 'MANAGER');--> statement-breakpoint
CREATE TYPE "public"."terminal_status" AS ENUM('ONLINE', 'OFFLINE', 'ERROR', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."topup_source" AS ENUM('ADMIN_PANEL', 'POS_COUNTER', 'BULK_CSV', 'API', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."topup_target_type" AS ENUM('USER', 'TEAM');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'SUSPENDED', 'DEACTIVATED');--> statement-breakpoint
CREATE TABLE "event_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"participant_ref" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_settings" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"status" "event_status" DEFAULT 'DRAFT' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "role_permissions_pk" UNIQUE("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"terminal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"external_ref" text,
	"dietary_notes" text,
	"emergency_contact" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"event_id" uuid,
	"store_id" uuid,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"phone" text,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"password_hash" text,
	"pin_hash" text,
	"qr_secret" text NOT NULL,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "team_member_role" DEFAULT 'MEMBER' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"color" text DEFAULT '#64748b' NOT NULL,
	"logo_url" text,
	"manager_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "card_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" "card_status",
	"to_status" "card_status",
	"user_id" uuid,
	"actor_user_id" uuid,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_taps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"card_id" uuid,
	"credential_kind" "credential_kind" NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"outcome" "tap_outcome" NOT NULL,
	"terminal_id" uuid,
	"store_id" uuid,
	"actor_user_id" uuid,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nfc_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"card_ref" text NOT NULL,
	"uid" text,
	"token_hash" text,
	"token_last4" text,
	"technology" "card_technology" DEFAULT 'NTAG213' NOT NULL,
	"status" "card_status" DEFAULT 'UNASSIGNED' NOT NULL,
	"assigned_user_id" uuid,
	"assigned_at" timestamp with time zone,
	"unassigned_at" timestamp with time zone,
	"replaced_by_card_id" uuid,
	"batch_label" text,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"type" "account_type" NOT NULL,
	"owner_user_id" uuid,
	"owner_team_id" uuid,
	"store_id" uuid,
	"name" text NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"lifetime_credited" bigint DEFAULT 0 NOT NULL,
	"lifetime_debited" bigint DEFAULT 0 NOT NULL,
	"allow_negative" boolean DEFAULT false NOT NULL,
	"status" "account_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_balance_non_negative" CHECK ("accounts"."allow_negative" or "accounts"."balance" >= 0),
	CONSTRAINT "accounts_lifetime_non_negative" CHECK ("accounts"."lifetime_credited" >= 0 and "accounts"."lifetime_debited" >= 0),
	CONSTRAINT "accounts_owner_exactly_one" CHECK ((case when "accounts"."owner_user_id" is null then 0 else 1 end
         + case when "accounts"."owner_team_id" is null then 0 else 1 end
         + case when "accounts"."store_id" is null then 0 else 1 end) <= 1)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"balance_before" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_nonzero" CHECK ("ledger_entries"."amount" <> 0),
	CONSTRAINT "ledger_entries_balance_consistent" CHECK ("ledger_entries"."balance_after" = "ledger_entries"."balance_before" + "ledger_entries"."amount")
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"txn_ref" text NOT NULL,
	"type" "ledger_transaction_type" NOT NULL,
	"reference_type" text,
	"reference_id" uuid,
	"reason" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reverses_transaction_id" uuid,
	"idempotency_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity_on_hand" bigint DEFAULT 0 NOT NULL,
	"low_stock_threshold" bigint DEFAULT 5 NOT NULL,
	"track_inventory" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_non_negative" CHECK ("inventory"."quantity_on_hand" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"inventory_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"type" "inventory_movement_type" NOT NULL,
	"quantity_delta" bigint NOT NULL,
	"quantity_before" bigint NOT NULL,
	"quantity_after" bigint NOT NULL,
	"reference_type" text,
	"reference_id" uuid,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_delta_nonzero" CHECK ("inventory_movements"."quantity_delta" <> 0),
	CONSTRAINT "inventory_movements_consistent" CHECK ("inventory_movements"."quantity_after" = "inventory_movements"."quantity_before" + "inventory_movements"."quantity_delta")
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"category_id" uuid,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"price_points" bigint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"max_per_purchase" integer,
	"restricted_to_team_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "products_price_non_negative" CHECK ("products"."price_points" >= 0),
	CONSTRAINT "products_max_per_purchase_positive" CHECK ("products"."max_per_purchase" is null or "products"."max_per_purchase" > 0)
);
--> statement-breakpoint
CREATE TABLE "store_staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "store_staff_role" DEFAULT 'CASHIER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"logo_url" text,
	"location" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_open" boolean DEFAULT true NOT NULL,
	"opens_at" time,
	"closes_at" time,
	"manager_user_id" uuid,
	"revenue_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "purchase_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name_snapshot" text NOT NULL,
	"sku_snapshot" text NOT NULL,
	"unit_price_points" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"line_total_points" bigint NOT NULL,
	"refunded_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_items_quantity_positive" CHECK ("purchase_items"."quantity" > 0),
	CONSTRAINT "purchase_items_refunded_within_qty" CHECK ("purchase_items"."refunded_quantity" >= 0 and "purchase_items"."refunded_quantity" <= "purchase_items"."quantity"),
	CONSTRAINT "purchase_items_line_total" CHECK ("purchase_items"."line_total_points" = "purchase_items"."unit_price_points" * "purchase_items"."quantity")
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"purchase_ref" text NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid,
	"cashier_user_id" uuid,
	"user_id" uuid NOT NULL,
	"card_id" uuid,
	"account_id" uuid NOT NULL,
	"status" "purchase_status" DEFAULT 'PENDING' NOT NULL,
	"subtotal_points" bigint NOT NULL,
	"discount_points" bigint DEFAULT 0 NOT NULL,
	"total_points" bigint NOT NULL,
	"refunded_points" bigint DEFAULT 0 NOT NULL,
	"balance_before" bigint,
	"balance_after" bigint,
	"ledger_transaction_id" uuid,
	"idempotency_key" text,
	"failure_code" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_totals_non_negative" CHECK ("purchases"."subtotal_points" >= 0 and "purchases"."total_points" >= 0 and "purchases"."discount_points" >= 0),
	CONSTRAINT "purchases_refunded_within_total" CHECK ("purchases"."refunded_points" >= 0 and "purchases"."refunded_points" <= "purchases"."total_points")
);
--> statement-breakpoint
CREATE TABLE "refund_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"purchase_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"amount_points" bigint NOT NULL,
	CONSTRAINT "refund_items_quantity_positive" CHECK ("refund_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"refund_ref" text NOT NULL,
	"purchase_id" uuid NOT NULL,
	"type" "refund_type" NOT NULL,
	"amount_points" bigint NOT NULL,
	"restock_inventory" boolean DEFAULT true NOT NULL,
	"reason" text NOT NULL,
	"status" "approval_status" DEFAULT 'COMPLETED' NOT NULL,
	"ledger_transaction_id" uuid,
	"idempotency_key" text,
	"requested_by" uuid,
	"approved_by" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_points" > 0)
);
--> statement-breakpoint
CREATE TABLE "terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"store_id" uuid,
	"terminal_ref" text NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text,
	"app_version" text,
	"last_heartbeat_at" timestamp with time zone,
	"last_transaction_at" timestamp with time zone,
	"assigned_cashier_user_id" uuid,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"offline_enabled" boolean DEFAULT false NOT NULL,
	"offline_spend_cap" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terminals_offline_cap_non_negative" CHECK ("terminals"."offline_spend_cap" >= 0)
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"type" "approval_request_type" NOT NULL,
	"amount_points" bigint,
	"payload" jsonb NOT NULL,
	"status" "approval_status" DEFAULT 'PENDING_APPROVAL' NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"result_reference_type" text,
	"result_reference_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_requests_two_person" CHECK ("approval_requests"."decided_by" is null or "approval_requests"."decided_by" <> "approval_requests"."requested_by")
);
--> statement-breakpoint
CREATE TABLE "topup_batch_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"resolved_user_id" uuid,
	"resolved_team_id" uuid,
	"amount_points" bigint,
	"reason" text,
	"is_valid" boolean DEFAULT false NOT NULL,
	"error" text,
	"topup_id" uuid
);
--> statement-breakpoint
CREATE TABLE "topup_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"filename" text,
	"status" "batch_status" DEFAULT 'DRAFT' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"invalid_rows" integer DEFAULT 0 NOT NULL,
	"total_points" bigint DEFAULT 0 NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "topups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"topup_ref" text NOT NULL,
	"target_type" "topup_target_type" NOT NULL,
	"user_id" uuid,
	"team_id" uuid,
	"allocation_mode" "allocation_mode",
	"amount_points" bigint NOT NULL,
	"reason" text NOT NULL,
	"source" "topup_source" DEFAULT 'ADMIN_PANEL' NOT NULL,
	"status" "approval_status" DEFAULT 'COMPLETED' NOT NULL,
	"batch_id" uuid,
	"terminal_id" uuid,
	"ledger_transaction_id" uuid,
	"idempotency_key" text,
	"created_by" uuid,
	"approved_by" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "topups_amount_positive" CHECK ("topups"."amount_points" > 0),
	CONSTRAINT "topups_target_consistent" CHECK (("topups"."target_type" = 'USER' and "topups"."user_id" is not null and "topups"."team_id" is null)
        or ("topups"."target_type" = 'TEAM' and "topups"."team_id" is not null and "topups"."user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"transfer_ref" text NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"amount_points" bigint NOT NULL,
	"note" text,
	"status" "approval_status" DEFAULT 'COMPLETED' NOT NULL,
	"ledger_transaction_id" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_amount_positive" CHECK ("transfers"."amount_points" > 0),
	CONSTRAINT "transfers_distinct_parties" CHECK ("transfers"."from_user_id" <> "transfers"."to_user_id")
);
--> statement-breakpoint
CREATE TABLE "achievements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"icon" text,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"actor_user_id" uuid,
	"actor_role" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"before_state" jsonb,
	"after_state" jsonb,
	"ip_address" text,
	"user_agent" text,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenge_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"challenge_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"completion_index" integer DEFAULT 1 NOT NULL,
	"awarded_points" bigint NOT NULL,
	"ledger_transaction_id" uuid,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"reward_points" bigint NOT NULL,
	"reward_score_points" bigint DEFAULT 0 NOT NULL,
	"max_completions_per_user" integer DEFAULT 1 NOT NULL,
	"status" "challenge_status" DEFAULT 'DRAFT' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenges_reward_non_negative" CHECK ("challenges"."reward_points" >= 0 and "challenges"."reward_score_points" >= 0),
	CONSTRAINT "challenges_max_completions_positive" CHECK ("challenges"."max_completions_per_user" > 0)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"actor_user_id" uuid,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"resource_type" text,
	"resource_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"severity" "notification_severity" DEFAULT 'INFO' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "reward_type" DEFAULT 'PRODUCT' NOT NULL,
	"cost_points" bigint NOT NULL,
	"stock" integer,
	"product_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rewards_cost_non_negative" CHECK ("rewards"."cost_points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_achievements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"achievement_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_settings" ADD CONSTRAINT "event_settings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_events" ADD CONSTRAINT "card_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_events" ADD CONSTRAINT "card_events_card_id_nfc_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."nfc_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_events" ADD CONSTRAINT "card_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_events" ADD CONSTRAINT "card_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_taps" ADD CONSTRAINT "card_taps_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_taps" ADD CONSTRAINT "card_taps_card_id_nfc_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."nfc_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_taps" ADD CONSTRAINT "card_taps_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nfc_cards" ADD CONSTRAINT "nfc_cards_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nfc_cards" ADD CONSTRAINT "nfc_cards_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nfc_cards" ADD CONSTRAINT "nfc_cards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_team_id_teams_id_fk" FOREIGN KEY ("owner_team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_inventory_id_inventory_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_restricted_to_team_id_teams_id_fk" FOREIGN KEY ("restricted_to_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_staff" ADD CONSTRAINT "store_staff_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_staff" ADD CONSTRAINT "store_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_revenue_account_id_accounts_id_fk" FOREIGN KEY ("revenue_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_card_id_nfc_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."nfc_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_purchase_item_id_purchase_items_id_fk" FOREIGN KEY ("purchase_item_id") REFERENCES "public"."purchase_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_assigned_cashier_user_id_users_id_fk" FOREIGN KEY ("assigned_cashier_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_batch_rows" ADD CONSTRAINT "topup_batch_rows_batch_id_topup_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."topup_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_batch_rows" ADD CONSTRAINT "topup_batch_rows_resolved_user_id_users_id_fk" FOREIGN KEY ("resolved_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_batch_rows" ADD CONSTRAINT "topup_batch_rows_resolved_team_id_teams_id_fk" FOREIGN KEY ("resolved_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_batch_rows" ADD CONSTRAINT "topup_batch_rows_topup_id_topups_id_fk" FOREIGN KEY ("topup_id") REFERENCES "public"."topups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_batches" ADD CONSTRAINT "topup_batches_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_batches" ADD CONSTRAINT "topup_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievements" ADD CONSTRAINT "achievements_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_completions" ADD CONSTRAINT "challenge_completions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_completions" ADD CONSTRAINT "challenge_completions_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_completions" ADD CONSTRAINT "challenge_completions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_completions" ADD CONSTRAINT "challenge_completions_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_completions" ADD CONSTRAINT "challenge_completions_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_achievement_id_achievements_id_fk" FOREIGN KEY ("achievement_id") REFERENCES "public"."achievements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_participants_key" ON "event_participants" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_participants_ref_key" ON "event_participants" USING btree ("event_id","participant_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "events_slug_key" ON "events" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "events_status_idx" ON "events" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions" USING btree ("key");--> statement-breakpoint
CREATE INDEX "role_permissions_role_idx" ON "role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_key_key" ON "roles" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_scope_key" ON "user_roles" USING btree ("user_id","role_id",coalesce("event_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("store_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "user_roles" USING btree ("user_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email")) WHERE "users"."deleted_at" is null and "users"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_key" ON "users" USING btree ("phone") WHERE "users"."deleted_at" is null and "users"."phone" is not null;--> statement-breakpoint
CREATE INDEX "users_display_name_idx" ON "users" USING btree ("display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_event_user_key" ON "team_members" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE INDEX "team_members_team_idx" ON "team_members" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_event_slug_key" ON "teams" USING btree ("event_id","slug");--> statement-breakpoint
CREATE INDEX "teams_event_idx" ON "teams" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "card_events_card_idx" ON "card_events" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "card_taps_card_time_idx" ON "card_taps" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "card_taps_fingerprint_idx" ON "card_taps" USING btree ("credential_fingerprint","created_at");--> statement-breakpoint
CREATE INDEX "card_taps_event_time_idx" ON "card_taps" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nfc_cards_event_ref_key" ON "nfc_cards" USING btree ("event_id","card_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "nfc_cards_event_uid_key" ON "nfc_cards" USING btree ("event_id","uid") WHERE "nfc_cards"."uid" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "nfc_cards_token_hash_key" ON "nfc_cards" USING btree ("token_hash") WHERE "nfc_cards"."token_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "nfc_cards_one_active_per_user" ON "nfc_cards" USING btree ("event_id","assigned_user_id") WHERE "nfc_cards"."assigned_user_id" is not null and "nfc_cards"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "nfc_cards_status_idx" ON "nfc_cards" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "nfc_cards_user_idx" ON "nfc_cards" USING btree ("assigned_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_type_key" ON "accounts" USING btree ("event_id","owner_user_id","type") WHERE "accounts"."owner_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_team_type_key" ON "accounts" USING btree ("event_id","owner_team_id","type") WHERE "accounts"."owner_team_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_store_type_key" ON "accounts" USING btree ("event_id","store_id","type") WHERE "accounts"."store_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_event_singleton_key" ON "accounts" USING btree ("event_id","type") WHERE "accounts"."type" in ('SYSTEM_ISSUANCE', 'SYSTEM_FORFEITURE');--> statement-breakpoint
CREATE INDEX "accounts_event_type_idx" ON "accounts" USING btree ("event_id","type");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_time_idx" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_ref_key" ON "ledger_transactions" USING btree ("txn_ref");--> statement-breakpoint
CREATE INDEX "ledger_transactions_event_time_idx" ON "ledger_transactions" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_transactions_reference_idx" ON "ledger_transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_type_idx" ON "ledger_transactions" USING btree ("event_id","type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_product_key" ON "inventory" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "inventory_low_stock_idx" ON "inventory" USING btree ("event_id") WHERE "inventory"."track_inventory" and "inventory"."quantity_on_hand" <= "inventory"."low_stock_threshold";--> statement-breakpoint
CREATE INDEX "inventory_movements_product_time_idx" ON "inventory_movements" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_reference_idx" ON "inventory_movements" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_event_slug_key" ON "product_categories" USING btree ("event_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "products_store_sku_key" ON "products" USING btree ("store_id","sku");--> statement-breakpoint
CREATE INDEX "products_store_active_idx" ON "products" USING btree ("store_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "store_staff_key" ON "store_staff" USING btree ("store_id","user_id");--> statement-breakpoint
CREATE INDEX "store_staff_user_idx" ON "store_staff" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_event_slug_key" ON "stores" USING btree ("event_id","slug");--> statement-breakpoint
CREATE INDEX "stores_event_idx" ON "stores" USING btree ("event_id","is_active");--> statement-breakpoint
CREATE INDEX "purchase_items_purchase_idx" ON "purchase_items" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "purchase_items_product_idx" ON "purchase_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_ref_key" ON "purchases" USING btree ("purchase_ref");--> statement-breakpoint
CREATE INDEX "purchases_user_time_idx" ON "purchases" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "purchases_store_time_idx" ON "purchases" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "purchases_event_status_idx" ON "purchases" USING btree ("event_id","status","created_at");--> statement-breakpoint
CREATE INDEX "purchases_terminal_idx" ON "purchases" USING btree ("terminal_id","created_at");--> statement-breakpoint
CREATE INDEX "refund_items_refund_idx" ON "refund_items" USING btree ("refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_ref_key" ON "refunds" USING btree ("refund_ref");--> statement-breakpoint
CREATE INDEX "refunds_purchase_idx" ON "refunds" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "refunds_event_time_idx" ON "refunds" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "terminals_event_ref_key" ON "terminals" USING btree ("event_id","terminal_ref");--> statement-breakpoint
CREATE INDEX "terminals_store_idx" ON "terminals" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "approval_requests_event_status_idx" ON "approval_requests" USING btree ("event_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "topup_batch_rows_key" ON "topup_batch_rows" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE INDEX "topup_batches_event_idx" ON "topup_batches" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "topups_ref_key" ON "topups" USING btree ("topup_ref");--> statement-breakpoint
CREATE INDEX "topups_event_time_idx" ON "topups" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "topups_user_idx" ON "topups" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "topups_batch_idx" ON "topups" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_ref_key" ON "transfers" USING btree ("transfer_ref");--> statement-breakpoint
CREATE INDEX "transfers_from_idx" ON "transfers" USING btree ("from_user_id","created_at");--> statement-breakpoint
CREATE INDEX "transfers_to_idx" ON "transfers" USING btree ("to_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "achievements_event_key" ON "achievements" USING btree ("event_id","key");--> statement-breakpoint
CREATE INDEX "audit_logs_event_time_idx" ON "audit_logs" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "challenge_completions_key" ON "challenge_completions" USING btree ("challenge_id","user_id","completion_index");--> statement-breakpoint
CREATE INDEX "challenge_completions_user_idx" ON "challenge_completions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "challenges_event_slug_key" ON "challenges" USING btree ("event_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_key" ON "idempotency_keys" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "notifications_user_time_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_expires_idx" ON "rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "rewards_event_idx" ON "rewards" USING btree ("event_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "user_achievements_key" ON "user_achievements" USING btree ("achievement_id","user_id");