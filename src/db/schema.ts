/**
 * Database schema for Tech4Human WhatsApp Banking Platform.
 * Run this migration against the PostgreSQL database on first deployment.
 *
 * Tables managed by Mastra (memory, traces, etc.) are created automatically.
 * These are application-level tables for banking operations.
 */

export const SCHEMA_SQL = `
-- ─── Customer Sessions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_sessions (
  id             SERIAL PRIMARY KEY,
  phone          VARCHAR(20)  NOT NULL UNIQUE,
  customer_name  VARCHAR(100),
  account_number VARCHAR(20),
  kyc_status     VARCHAR(20)  NOT NULL DEFAULT 'unverified',  -- 'unverified'|'tier1'|'tier2'|'tier3'
  state          VARCHAR(50)  NOT NULL DEFAULT 'idle',
  -- state: 'idle'|'awaiting_otp'|'pending_transfer'|'pending_kyc'|'pending_fraud_review'
  context        JSONB        NOT NULL DEFAULT '{}',
  -- context.pending_flow: {action, step, data{}, started_at}
  device_id      VARCHAR(255),
  authenticated  BOOLEAN      NOT NULL DEFAULT false,
  last_active    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_phone ON customer_sessions(phone);
CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON customer_sessions(last_active DESC);

-- Idempotent migrations: add missing columns if upgrading from an older schema
ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS customer_name  VARCHAR(100);
ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS account_number VARCHAR(20);
ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS kyc_status     VARCHAR(20) NOT NULL DEFAULT 'unverified';
ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS last_active    TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- Backfill last_active from updated_at if null
UPDATE customer_sessions SET last_active = updated_at WHERE last_active IS NULL;

-- ─── OTP Records ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_records (
  id          SERIAL PRIMARY KEY,
  phone       VARCHAR(20)  NOT NULL,
  otp_hash    VARCHAR(255) NOT NULL,
  purpose     VARCHAR(50)  NOT NULL,  -- 'login' | 'transaction' | 'device_binding'
  attempts    INTEGER      NOT NULL DEFAULT 0,
  used        BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_records(phone, used, expires_at);

-- ─── Transaction Ledger ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id              SERIAL PRIMARY KEY,
  reference       VARCHAR(50)  NOT NULL UNIQUE,
  phone           VARCHAR(20)  NOT NULL,
  account_number  VARCHAR(20)  NOT NULL,
  type            VARCHAR(30)  NOT NULL,  -- 'intra_transfer' | 'interbank' | 'bill_payment' | 'balance_enquiry'
  amount          NUMERIC(15,2),
  currency        CHAR(3)      NOT NULL DEFAULT 'NGN',
  beneficiary     JSONB,
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending',  -- 'pending' | 'success' | 'failed' | 'reversed'
  metadata        JSONB        NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_txn_phone ON transactions(phone);
CREATE INDEX IF NOT EXISTS idx_txn_reference ON transactions(reference);

-- ─── Fraud Alerts ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fraud_alerts (
  id              SERIAL PRIMARY KEY,
  phone           VARCHAR(20)  NOT NULL,
  transaction_ref VARCHAR(50),
  risk_score      NUMERIC(5,4) NOT NULL,
  risk_factors    JSONB        NOT NULL DEFAULT '[]',
  status          VARCHAR(20)  NOT NULL DEFAULT 'open',  -- 'open' | 'confirmed' | 'cleared'
  reviewed_by     VARCHAR(100),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_fraud_phone ON fraud_alerts(phone, status);

-- ─── Escalation Tickets ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS escalation_tickets (
  id            SERIAL PRIMARY KEY,
  ticket_id     VARCHAR(20)  NOT NULL UNIQUE,
  phone         VARCHAR(20)  NOT NULL,
  category      VARCHAR(50)  NOT NULL,
  description   TEXT         NOT NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'open',  -- 'open' | 'assigned' | 'resolved' | 'closed'
  priority      VARCHAR(10)  NOT NULL DEFAULT 'medium',
  assigned_to   VARCHAR(100),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ticket_phone ON escalation_tickets(phone, status);
CREATE INDEX IF NOT EXISTS idx_ticket_id ON escalation_tickets(ticket_id);

-- ─── Audit Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  event_id      UUID         NOT NULL DEFAULT gen_random_uuid(),
  phone         VARCHAR(20),
  session_id    VARCHAR(100),
  event_type    VARCHAR(50)  NOT NULL,
  agent_id      VARCHAR(50),
  input_summary TEXT,
  output_summary TEXT,
  metadata      JSONB        NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_phone ON audit_log(phone);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
-- Audit logs are append-only (no DELETE/UPDATE allowed via app layer)

-- ─── Device Registry ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_registry (
  id          SERIAL PRIMARY KEY,
  phone       VARCHAR(20)  NOT NULL,
  device_id   VARCHAR(255) NOT NULL,
  device_name VARCHAR(100),
  trusted     BOOLEAN      NOT NULL DEFAULT false,
  last_seen   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ,
  UNIQUE(phone, device_id)
);
CREATE INDEX IF NOT EXISTS idx_device_phone ON device_registry(phone);

-- ─── Beneficiaries ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS beneficiaries (
  id              SERIAL PRIMARY KEY,
  phone           VARCHAR(20)  NOT NULL,
  nickname        VARCHAR(50)  NOT NULL,
  account_number  VARCHAR(20)  NOT NULL,
  bank_code       VARCHAR(10)  NOT NULL,
  bank_name       VARCHAR(100) NOT NULL,
  account_name    VARCHAR(100) NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bene_phone ON beneficiaries(phone);

-- ─── Notification Preferences ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  phone             VARCHAR(20) PRIMARY KEY,
  all_transactions  BOOLEAN NOT NULL DEFAULT true,
  debits_only       BOOLEAN NOT NULL DEFAULT false,
  threshold_amount  NUMERIC(15,2),
  marketing_opt_in  BOOLEAN NOT NULL DEFAULT false,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
