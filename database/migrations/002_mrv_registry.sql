-- 002_mrv_registry.sql
-- Extends the original schema (001) into a blue-carbon MRV + registry + credit lifecycle model.
-- Existing tables are altered/renamed where possible rather than dropped:
--   drone_images  -> evidence            (now covers field photos, drone imagery, remote sensing, documents)
--   carbon_credits -> per-verified-record issuance, with credit_events for transfer/retirement
--   projects      -> lifecycle/verification/credit status split into separate columns
-- None of the original tables held production data (the original UI never wrote to them).

BEGIN;

-- ── Organizations ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id             SERIAL PRIMARY KEY,
  uuid           UUID DEFAULT gen_random_uuid() UNIQUE,
  name           VARCHAR(255) NOT NULL UNIQUE,
  org_type       VARCHAR(30) NOT NULL
                 CHECK (org_type IN ('REGULATOR','NGO','COMMUNITY','PANCHAYAT','RESEARCH','VERIFICATION_BODY','CREDIT_HOLDER')),
  wallet_address VARCHAR(42),
  is_synthetic   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Users: role model + organization ─────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE users SET role = CASE role
  WHEN 'admin' THEN 'NCCR_ADMIN' WHEN 'verifier' THEN 'VERIFIER' ELSE 'FIELD_USER' END
  WHERE role IN ('admin','verifier','ngo_worker','community');
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'FIELD_USER';
ALTER TABLE users ADD CONSTRAINT users_role_chk CHECK (role IN ('FIELD_USER','VERIFIER','NCCR_ADMIN'));
ALTER TABLE users DROP COLUMN IF EXISTS bct_balance;   -- balances now live on-chain / in credit_events
CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);

-- ── Projects ─────────────────────────────────────────────────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS code VARCHAR(40) UNIQUE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS restoration_type VARCHAR(50);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS region VARCHAR(255);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS geometry JSONB;                 -- GeoJSON Polygon (PostGIS is not used)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) NOT NULL DEFAULT 'PENDING';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS credit_status VARCHAR(20) NOT NULL DEFAULT 'NONE';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS data_origin VARCHAR(20) NOT NULL DEFAULT 'USER_ENTERED';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS chain_registered BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS chain_register_tx VARCHAR(66);
ALTER TABLE projects RENAME COLUMN carbon_tonnes TO latest_estimate_tco2e;    -- cached "Illustrative Carbon Estimate"
ALTER TABLE projects DROP COLUMN IF EXISTS growth_years;     -- derived from start_date + record date
ALTER TABLE projects DROP COLUMN IF EXISTS ipfs_image_hash;  -- evidence references now live on evidence rows
ALTER TABLE projects DROP COLUMN IF EXISTS blockchain_id;
ALTER TABLE projects DROP COLUMN IF EXISTS tx_hash;
ALTER TABLE projects DROP COLUMN IF EXISTS verified_by;
ALTER TABLE projects DROP COLUMN IF EXISTS verified_at;
ALTER TABLE projects ALTER COLUMN owner_id DROP NOT NULL;
UPDATE projects SET status = 'ACTIVE';
ALTER TABLE projects ALTER COLUMN status SET DEFAULT 'ACTIVE';
ALTER TABLE projects ADD CONSTRAINT projects_status_chk CHECK (status IN ('ACTIVE','ON_HOLD','CLOSED'));
ALTER TABLE projects ADD CONSTRAINT projects_eco_chk CHECK (ecosystem_type IN ('MANGROVE','SEAGRASS','SALT_MARSH'));
ALTER TABLE projects ADD CONSTRAINT projects_verif_chk CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED','NEEDS_REVISION'));
ALTER TABLE projects ADD CONSTRAINT projects_credit_chk CHECK (credit_status IN ('NONE','ELIGIBLE','APPROVED','ISSUED'));
ALTER TABLE projects ADD CONSTRAINT projects_origin_chk CHECK (data_origin IN ('USER_ENTERED','SYNTHETIC_DEMO'));
ALTER TABLE projects ADD CONSTRAINT projects_area_chk CHECK (area_hectares > 0);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id);

-- ── Monitoring records (field data -> MRV report) ────────────────
CREATE TABLE IF NOT EXISTS monitoring_records (
  id                  SERIAL PRIMARY KEY,
  uuid                UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  code                VARCHAR(40) UNIQUE,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  submitted_by        INTEGER NOT NULL REFERENCES users(id),
  activity_type       VARCHAR(30) NOT NULL
                      CHECK (activity_type IN ('PLANTING','TRANSPLANTING','MONITORING_SURVEY','MAINTENANCE','HYDROLOGY_RESTORATION')),
  activity_date       DATE NOT NULL,
  latitude            NUMERIC(9,6),
  longitude           NUMERIC(9,6),
  location_accuracy_m NUMERIC(8,1),
  area_ha             NUMERIC(12,2) NOT NULL CHECK (area_ha > 0),
  observations        TEXT,
  measurements        JSONB NOT NULL DEFAULT '{}'::jsonb,
  report              JSONB,                         -- structured MRV report generated on submission
  status              VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','VERIFIED','REJECTED','NEEDS_REVISION')),
  revision            INTEGER NOT NULL DEFAULT 1,
  submitted_at        TIMESTAMPTZ,
  review_started_by   INTEGER REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,
  content_hash        VARCHAR(66),
  evidence_root       VARCHAR(66),
  anchor_status       VARCHAR(10) NOT NULL DEFAULT 'NONE' CHECK (anchor_status IN ('NONE','PENDING','ANCHORED')),
  anchor_tx_hash      VARCHAR(66),
  data_origin         VARCHAR(20) NOT NULL DEFAULT 'USER_ENTERED' CHECK (data_origin IN ('USER_ENTERED','SYNTHETIC_DEMO')),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_records_project ON monitoring_records(project_id);
CREATE INDEX IF NOT EXISTS idx_records_status  ON monitoring_records(status);

-- ── Evidence (extends drone_images) ──────────────────────────────
ALTER TABLE drone_images RENAME TO evidence;
ALTER TABLE evidence RENAME COLUMN ipfs_hash TO ipfs_cid;      -- only set when really pinned
ALTER TABLE evidence RENAME COLUMN file_path TO storage_uri;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS code VARCHAR(40) UNIQUE;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS record_id INTEGER REFERENCES monitoring_records(id);
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'FIELD_PHOTO';
UPDATE evidence SET kind = CASE image_type WHEN 'drone' THEN 'DRONE_IMAGERY' WHEN 'satellite' THEN 'REMOTE_SENSING' ELSE 'FIELD_PHOTO' END;
ALTER TABLE evidence DROP COLUMN IF EXISTS image_type;
ALTER TABLE evidence ADD CONSTRAINT evidence_kind_chk CHECK (kind IN ('FIELD_PHOTO','DRONE_IMAGERY','REMOTE_SENSING','DOCUMENT'));
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS sha256 VARCHAR(64);
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS mime_type VARCHAR(100);
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS size_bytes BIGINT;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS external_ref TEXT;                -- reference-only evidence (no file held)
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS platform VARCHAR(100);            -- e.g. drone model / sensor name as declared
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS altitude_m NUMERIC(8,1);
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS processing_status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED';
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS analysis_mode VARCHAR(20) NOT NULL DEFAULT 'NONE';
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS analysis_result JSONB;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS review_notes TEXT;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS data_origin VARCHAR(20) NOT NULL DEFAULT 'USER_ENTERED';
UPDATE evidence SET status = CASE status WHEN 'approved' THEN 'VERIFIED' WHEN 'rejected' THEN 'REJECTED' ELSE 'PENDING' END;
ALTER TABLE evidence RENAME COLUMN status TO verification_status;
ALTER TABLE evidence ALTER COLUMN verification_status SET DEFAULT 'PENDING';
ALTER TABLE evidence ADD CONSTRAINT evidence_verif_chk CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED','NEEDS_REVISION'));
ALTER TABLE evidence ADD CONSTRAINT evidence_proc_chk CHECK (processing_status IN ('RECEIVED','HASHED','PINNED','REFERENCE_ONLY'));
ALTER TABLE evidence ADD CONSTRAINT evidence_analysis_chk CHECK (analysis_mode IN ('NONE','SIMULATED_DEMO'));
ALTER TABLE evidence ADD CONSTRAINT evidence_origin_chk CHECK (data_origin IN ('USER_ENTERED','SYNTHETIC_DEMO'));
ALTER INDEX IF EXISTS idx_images_project RENAME TO idx_evidence_project;
ALTER INDEX IF EXISTS idx_images_status  RENAME TO idx_evidence_status;
CREATE INDEX IF NOT EXISTS idx_evidence_record ON evidence(record_id);

-- ── Verification decisions ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS verification_records (
  id          SERIAL PRIMARY KEY,
  record_id   INTEGER NOT NULL REFERENCES monitoring_records(id),
  verifier_id INTEGER NOT NULL REFERENCES users(id),
  decision    VARCHAR(20) NOT NULL CHECK (decision IN ('VERIFIED','REJECTED','NEEDS_REVISION')),
  revision    INTEGER NOT NULL,
  checks      JSONB NOT NULL,
  comments    TEXT,
  report_hash VARCHAR(66) NOT NULL,
  tx_hash     VARCHAR(66),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_verif_record ON verification_records(record_id);

-- ── Carbon calculations + NCCR approval ──────────────────────────
CREATE TABLE IF NOT EXISTS carbon_calculations (
  id                  SERIAL PRIMARY KEY,
  uuid                UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  record_id           INTEGER NOT NULL REFERENCES monitoring_records(id),
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  methodology_version VARCHAR(40) NOT NULL,
  inputs              JSONB NOT NULL,
  assumptions         JSONB NOT NULL,
  result              JSONB NOT NULL,
  estimate_tco2e      NUMERIC(14,2) NOT NULL,
  low_tco2e           NUMERIC(14,2) NOT NULL,
  high_tco2e          NUMERIC(14,2) NOT NULL,
  eligible_credits    INTEGER NOT NULL CHECK (eligible_credits >= 0),
  input_hash          VARCHAR(66) NOT NULL,
  is_current          BOOLEAN NOT NULL DEFAULT TRUE,
  calculated_by       INTEGER NOT NULL REFERENCES users(id),
  calculated_at       TIMESTAMPTZ DEFAULT NOW(),
  approval_status     VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING','APPROVED','REJECTED')),
  approved_by         INTEGER REFERENCES users(id),
  approved_at         TIMESTAMPTZ,
  approval_notes      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_calc_current_per_record ON carbon_calculations(record_id) WHERE is_current;

-- ── Credits (extends carbon_credits) ─────────────────────────────
ALTER TABLE carbon_credits DROP CONSTRAINT IF EXISTS carbon_credits_project_id_key;   -- credits are per verified record, not per project
ALTER TABLE carbon_credits ADD COLUMN IF NOT EXISTS record_id INTEGER UNIQUE REFERENCES monitoring_records(id);
ALTER TABLE carbon_credits ADD COLUMN IF NOT EXISTS calculation_id INTEGER UNIQUE REFERENCES carbon_calculations(id);
ALTER TABLE carbon_credits ADD COLUMN IF NOT EXISTS holder_org_id INTEGER REFERENCES organizations(id);
ALTER TABLE carbon_credits ADD COLUMN IF NOT EXISTS credit_label VARCHAR(40) NOT NULL DEFAULT 'Tokenized Demo Credit';
ALTER TABLE carbon_credits ADD COLUMN IF NOT EXISTS retired_tonnes NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE carbon_credits ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ISSUED';
ALTER TABLE carbon_credits ADD COLUMN IF NOT EXISTS issued_by INTEGER REFERENCES users(id);
ALTER TABLE carbon_credits ADD COLUMN IF NOT EXISTS data_origin VARCHAR(20) NOT NULL DEFAULT 'USER_ENTERED';
ALTER TABLE carbon_credits DROP COLUMN IF EXISTS owner_id;
ALTER TABLE carbon_credits DROP COLUMN IF EXISTS retired;
ALTER TABLE carbon_credits DROP COLUMN IF EXISTS retired_at;
ALTER TABLE carbon_credits DROP COLUMN IF EXISTS retired_by;
ALTER TABLE carbon_credits RENAME COLUMN minted_at TO issued_at;
ALTER TABLE carbon_credits ADD CONSTRAINT credits_status_chk CHECK (status IN ('ISSUED','PARTIALLY_RETIRED','RETIRED'));
ALTER TABLE carbon_credits ADD CONSTRAINT credits_retired_chk CHECK (retired_tonnes >= 0 AND retired_tonnes <= amount_tonnes);
DROP INDEX IF EXISTS idx_credits_owner;

CREATE TABLE IF NOT EXISTS credit_balances (        -- off-chain mirror of per-batch holder balances (chain is authoritative)
  credit_id INTEGER NOT NULL REFERENCES carbon_credits(id),
  org_id    INTEGER NOT NULL REFERENCES organizations(id),
  balance   NUMERIC(12,2) NOT NULL CHECK (balance >= 0),
  PRIMARY KEY (credit_id, org_id)
);

CREATE TABLE IF NOT EXISTS credit_events (
  id           SERIAL PRIMARY KEY,
  credit_id    INTEGER NOT NULL REFERENCES carbon_credits(id),
  event_type   VARCHAR(12) NOT NULL CHECK (event_type IN ('ISSUED','TRANSFERRED','RETIRED')),
  from_org_id  INTEGER REFERENCES organizations(id),
  to_org_id    INTEGER REFERENCES organizations(id),
  from_wallet  VARCHAR(42),
  to_wallet    VARCHAR(42),
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason       TEXT,
  actor_id     INTEGER REFERENCES users(id),
  tx_hash      VARCHAR(66),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_events_credit ON credit_events(credit_id);

-- ── Blockchain transactions ──────────────────────────────────────
ALTER TABLE blockchain_transactions ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id);
ALTER TABLE blockchain_transactions ADD COLUMN IF NOT EXISTS record_id INTEGER REFERENCES monitoring_records(id);
ALTER TABLE blockchain_transactions ADD COLUMN IF NOT EXISTS chain_id INTEGER;
ALTER TABLE blockchain_transactions ADD COLUMN IF NOT EXISTS contract_address VARCHAR(42);
ALTER TABLE blockchain_transactions ADD COLUMN IF NOT EXISTS payload_hash VARCHAR(66);
ALTER TABLE blockchain_transactions ADD COLUMN IF NOT EXISTS status VARCHAR(10) NOT NULL DEFAULT 'CONFIRMED';
ALTER TABLE blockchain_transactions ADD CONSTRAINT bctx_status_chk CHECK (status IN ('CONFIRMED','FAILED'));
CREATE INDEX IF NOT EXISTS idx_bctx_record  ON blockchain_transactions(record_id);
CREATE INDEX IF NOT EXISTS idx_bctx_project ON blockchain_transactions(project_id);

-- ── Audit log (append-only, hash-chained) ────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id        INTEGER REFERENCES users(id),
  actor_name      VARCHAR(255),
  actor_role      VARCHAR(30),
  action          VARCHAR(40) NOT NULL,
  entity_type     VARCHAR(30) NOT NULL,
  entity_id       VARCHAR(64),
  project_id      INTEGER REFERENCES projects(id),
  record_id       INTEGER REFERENCES monitoring_records(id),
  previous_status VARCHAR(30),
  new_status      VARCHAR(30),
  details         JSONB NOT NULL DEFAULT '{}'::jsonb,
  tx_hash         VARCHAR(66),
  prev_hash       VARCHAR(64),
  entry_hash      VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_record  ON audit_logs(record_id);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_logs(action);

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_audit_no_update ON audit_logs;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

COMMIT;
