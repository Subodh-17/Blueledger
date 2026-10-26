-- 007_evidence_provenance.sql — chain of custody (immutable review history, supersession, protected provenance fields) and IPFS pin tracking.
BEGIN;
ALTER TABLE evidence DROP CONSTRAINT IF EXISTS evidence_ipfs_chk;
ALTER TABLE evidence ADD CONSTRAINT evidence_ipfs_chk CHECK (ipfs_status IN ('NOT_CONFIGURED','PENDING','PINNED','UNAVAILABLE','VERIFY_FAILED'));
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS ipfs_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS ipfs_last_error TEXT;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS ipfs_next_retry_at TIMESTAMPTZ;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS ipfs_verified_at TIMESTAMPTZ;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS supersedes_id INTEGER REFERENCES evidence(id);
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS crs VARCHAR(20) NOT NULL DEFAULT 'EPSG:4326';
CREATE INDEX IF NOT EXISTS idx_evidence_ipfs_retry ON evidence(ipfs_next_retry_at) WHERE ipfs_status IN ('PENDING','UNAVAILABLE');
CREATE INDEX IF NOT EXISTS idx_evidence_record_live ON evidence(record_id) WHERE superseded_at IS NULL;

-- Every review decision is appended; the evidence row only carries the current state.
CREATE TABLE IF NOT EXISTS evidence_reviews (
  id              BIGSERIAL PRIMARY KEY,
  evidence_id     INTEGER NOT NULL REFERENCES evidence(id),
  reviewer_id     INTEGER REFERENCES users(id),
  decision        VARCHAR(20) NOT NULL CHECK (decision IN ('VERIFIED','REJECTED','NEEDS_REVISION','RESET','SUPERSEDED')),
  notes           TEXT,
  record_revision INTEGER,
  content_sha256  VARCHAR(64),                       -- exactly which file bytes the decision applied to
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evidence_reviews ON evidence_reviews(evidence_id, id);
CREATE OR REPLACE FUNCTION evidence_reviews_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'evidence_reviews is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_evidence_reviews_immutable ON evidence_reviews;
CREATE TRIGGER trg_evidence_reviews_immutable BEFORE UPDATE OR DELETE ON evidence_reviews FOR EACH ROW EXECUTE FUNCTION evidence_reviews_immutable();

-- The content hash, original file reference, uploader and upload time of an evidence row can never be rewritten.
CREATE OR REPLACE FUNCTION evidence_provenance_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN RAISE EXCEPTION 'evidence content hash is immutable'; END IF;
  IF OLD.storage_uri IS NOT NULL AND NEW.storage_uri IS DISTINCT FROM OLD.storage_uri THEN RAISE EXCEPTION 'evidence file reference is immutable'; END IF;
  IF NEW.uploader_id IS DISTINCT FROM OLD.uploader_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'evidence upload provenance is immutable'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_evidence_provenance ON evidence;
CREATE TRIGGER trg_evidence_provenance BEFORE UPDATE ON evidence FOR EACH ROW EXECUTE FUNCTION evidence_provenance_guard();
COMMIT;
