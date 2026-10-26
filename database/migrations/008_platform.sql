-- 008_platform.sql — persisted notifications, audited runtime settings, client references for offline sync, supporting indexes.
BEGIN;
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  type        VARCHAR(40) NOT NULL,
  title       VARCHAR(200) NOT NULL,
  body        TEXT,
  href        VARCHAR(200),
  entity_type VARCHAR(30),
  entity_id   VARCHAR(64),
  severity    VARCHAR(10) NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','ACTION','WARNING','ALERT')),
  dedupe_key  VARCHAR(120),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, id DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key        VARCHAR(80) PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS app_settings_history (
  id         BIGSERIAL PRIMARY KEY,
  key        VARCHAR(80) NOT NULL,
  old_value  JSONB,
  new_value  JSONB NOT NULL,
  reason     TEXT,
  changed_by INTEGER REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Offline/sync safety: a client-generated reference makes record creation idempotent per user.
ALTER TABLE monitoring_records ADD COLUMN IF NOT EXISTS client_ref VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_records_client_ref ON monitoring_records(submitted_by, client_ref) WHERE client_ref IS NOT NULL;

-- Query-support indexes (see docs/OPERATIONS.md for the EXPLAIN review)
CREATE INDEX IF NOT EXISTS idx_records_project_status ON monitoring_records(project_id, status);
CREATE INDEX IF NOT EXISTS idx_evidence_project_status ON evidence(project_id, verification_status);
CREATE INDEX IF NOT EXISTS idx_audit_project_id ON audit_logs(project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_credit_events_credit_id ON credit_events(credit_id, id);
CREATE INDEX IF NOT EXISTS idx_bctx_created ON blockchain_transactions(id DESC);
CREATE INDEX IF NOT EXISTS idx_chain_ops_status_updated ON chain_operations(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_calcs_project_current ON carbon_calculations(project_id) WHERE is_current;
COMMIT;
