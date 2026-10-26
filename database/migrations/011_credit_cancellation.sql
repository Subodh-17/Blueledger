-- Migration 011: Contract-level credit freezing, dispute remedies, and cancellation tracking
ALTER TABLE carbon_credits ADD COLUMN IF NOT EXISTS cancelled_tonnes NUMERIC DEFAULT 0 CHECK (cancelled_tonnes >= 0);
ALTER TABLE carbon_credits ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT FALSE;

ALTER TABLE carbon_credits DROP CONSTRAINT IF EXISTS credits_status_chk;
ALTER TABLE carbon_credits ADD CONSTRAINT credits_status_chk CHECK (status IN ('ISSUED','PARTIALLY_RETIRED','RETIRED','PARTIALLY_CANCELLED','CANCELLED'));

ALTER TABLE credit_events DROP CONSTRAINT IF EXISTS credit_events_event_type_check;
ALTER TABLE credit_events ADD CONSTRAINT credit_events_event_type_check CHECK (event_type IN ('ISSUED','TRANSFERRED','RETIRED','CANCELLED'));

ALTER TABLE credit_disputes ADD COLUMN IF NOT EXISTS onchain_frozen BOOLEAN DEFAULT FALSE;
ALTER TABLE credit_disputes ADD COLUMN IF NOT EXISTS freeze_tx_hash VARCHAR(66);
ALTER TABLE credit_disputes ADD COLUMN IF NOT EXISTS cancellation_tx_hash VARCHAR(66);

CREATE TABLE IF NOT EXISTS credit_cancellations (
  id SERIAL PRIMARY KEY,
  credit_id INTEGER NOT NULL REFERENCES carbon_credits(id),
  record_id INTEGER NOT NULL REFERENCES monitoring_records(id),
  holder_org_id INTEGER NOT NULL REFERENCES organizations(id),
  dispute_id INTEGER REFERENCES credit_disputes(id),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  case_hash VARCHAR(66) NOT NULL,
  op_ref VARCHAR(66) NOT NULL UNIQUE,
  tx_hash VARCHAR(66),
  cancelled_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_cancellations_credit ON credit_cancellations(credit_id);
CREATE INDEX IF NOT EXISTS idx_credit_cancellations_ref ON credit_cancellations(op_ref);
