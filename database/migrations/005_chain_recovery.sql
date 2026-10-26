-- 005_chain_recovery.sql — balance reservations, per-operation history and on-chain references for crash-safe credit operations.
BEGIN;
ALTER TABLE chain_operations ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE chain_operations ADD COLUMN IF NOT EXISTS op_ref VARCHAR(66);
ALTER TABLE chain_operations ADD COLUMN IF NOT EXISTS block_hash VARCHAR(66);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chain_ops_ref ON chain_operations(op_ref) WHERE op_ref IS NOT NULL;

-- Funds are reserved when a transfer/retirement is accepted, so concurrent requests cannot spend or retire the same credits.
CREATE TABLE IF NOT EXISTS credit_reservations (
  op_id      BIGINT PRIMARY KEY REFERENCES chain_operations(id),
  credit_id  INTEGER NOT NULL REFERENCES carbon_credits(id),
  org_id     INTEGER NOT NULL REFERENCES organizations(id),
  amount     NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status     VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONSUMED','RELEASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reservations_active ON credit_reservations(credit_id, org_id) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS chain_operation_events (
  id      BIGSERIAL PRIMARY KEY,
  op_id   BIGINT NOT NULL REFERENCES chain_operations(id) ON DELETE CASCADE,
  at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event   VARCHAR(40) NOT NULL,
  detail  JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_op_events_op ON chain_operation_events(op_id, id);
COMMIT;
