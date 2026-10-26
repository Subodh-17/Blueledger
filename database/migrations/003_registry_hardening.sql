-- 003_registry_hardening.sql
-- * provenance values renamed to neutral registry wording (ILLUSTRATIVE = records not collected in the field)
-- * durable blockchain operations (idempotent submit -> confirm -> apply, with reconciliation)
-- * real file-metadata extraction replaces the placeholder "analysis" columns on evidence
-- * credit batch codes, assessment versions, storage status columns, search/sort indexes
BEGIN;

-- provenance
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
           WHERE contype='c' AND pg_get_constraintdef(oid) ILIKE '%data_origin%'
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname); END LOOP;
END $$;
UPDATE projects           SET data_origin='ILLUSTRATIVE' WHERE data_origin='SYNTHETIC_DEMO';
UPDATE monitoring_records SET data_origin='ILLUSTRATIVE' WHERE data_origin='SYNTHETIC_DEMO';
UPDATE evidence           SET data_origin='ILLUSTRATIVE' WHERE data_origin='SYNTHETIC_DEMO';
UPDATE carbon_credits     SET data_origin='ILLUSTRATIVE' WHERE data_origin='SYNTHETIC_DEMO';
ALTER TABLE projects           ADD CONSTRAINT projects_origin_chk CHECK (data_origin IN ('USER_ENTERED','ILLUSTRATIVE'));
ALTER TABLE monitoring_records ADD CONSTRAINT records_origin_chk  CHECK (data_origin IN ('USER_ENTERED','ILLUSTRATIVE'));
ALTER TABLE evidence           ADD CONSTRAINT evidence_origin_chk CHECK (data_origin IN ('USER_ENTERED','ILLUSTRATIVE'));
ALTER TABLE carbon_credits     ADD CONSTRAINT credits_origin_chk  CHECK (data_origin IN ('USER_ENTERED','ILLUSTRATIVE'));
UPDATE carbon_credits SET credit_label='Registry Credit' WHERE credit_label ILIKE '%demo%';
ALTER TABLE carbon_credits ALTER COLUMN credit_label SET DEFAULT 'Registry Credit';
ALTER TABLE carbon_credits ADD COLUMN IF NOT EXISTS batch_code VARCHAR(20) UNIQUE;
UPDATE carbon_credits SET batch_code = 'CB-' || LPAD(id::text, 5, '0') WHERE batch_code IS NULL;

-- evidence: real metadata instead of placeholder analysis; explicit storage status
ALTER TABLE evidence DROP CONSTRAINT IF EXISTS evidence_analysis_chk;
ALTER TABLE evidence DROP COLUMN IF EXISTS analysis_mode;
ALTER TABLE evidence DROP COLUMN IF EXISTS analysis_result;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS file_metadata JSONB;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS metadata_extracted_at TIMESTAMPTZ;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS ipfs_status VARCHAR(20) NOT NULL DEFAULT 'NOT_CONFIGURED';
ALTER TABLE evidence ADD CONSTRAINT evidence_ipfs_chk CHECK (ipfs_status IN ('NOT_CONFIGURED','PINNED','UNAVAILABLE'));
UPDATE evidence SET ipfs_status='PINNED' WHERE ipfs_cid IS NOT NULL;

-- carbon assessments are versioned per record
ALTER TABLE carbon_calculations ADD COLUMN IF NOT EXISTS assessment_no INTEGER;
UPDATE carbon_calculations c SET assessment_no = s.n FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY id) AS n FROM carbon_calculations) s WHERE s.id = c.id;
ALTER TABLE carbon_calculations ALTER COLUMN assessment_no SET NOT NULL;
ALTER TABLE carbon_calculations ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- durable blockchain operations
CREATE TABLE IF NOT EXISTS chain_operations (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key VARCHAR(200) NOT NULL UNIQUE,
  op_type         VARCHAR(40) NOT NULL,
  project_id      INTEGER REFERENCES projects(id),
  record_id       INTEGER REFERENCES monitoring_records(id),
  actor_id        INTEGER REFERENCES users(id),
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- PENDING: intent stored, nothing sent | SUBMITTED: tx hash known | CONFIRMED: receipt ok, registry update not yet applied
  -- COMPLETED: registry updated | FAILED: rejected/reverted or indeterminate (needs operator attention)
  status          VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUBMITTED','CONFIRMED','COMPLETED','FAILED')),
  tx_hash         VARCHAR(66),
  block_number    BIGINT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  result          JSONB,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chain_ops_status ON chain_operations(status);
CREATE INDEX IF NOT EXISTS idx_chain_ops_record ON chain_operations(record_id);

-- list / search / sort support
CREATE INDEX IF NOT EXISTS idx_projects_name_lower ON projects (lower(name));
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, verification_status);
CREATE INDEX IF NOT EXISTS idx_records_submitted ON monitoring_records(submitted_at);
CREATE INDEX IF NOT EXISTS idx_evidence_sha ON evidence(sha256);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

COMMIT;
