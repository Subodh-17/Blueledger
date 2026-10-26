-- 006_security.sql — session revocation, password reset tokens, mail outbox, malware-scan state, envelope encryption metadata.
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;   -- incrementing it revokes every issued token

CREATE TABLE IF NOT EXISTS password_resets (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  token_hash   VARCHAR(64) NOT NULL UNIQUE,        -- SHA-256 of the token; the token itself is never stored
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  requested_ip VARCHAR(64),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_resets(user_id, created_at DESC);

-- Development / test mail transport stores messages here instead of sending them. Never used when MAIL_TRANSPORT=smtp.
CREATE TABLE IF NOT EXISTS mail_outbox (
  id         BIGSERIAL PRIMARY KEY,
  to_email   VARCHAR(200) NOT NULL,
  subject    VARCHAR(300) NOT NULL,
  body       TEXT NOT NULL,
  transport  VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE evidence ADD COLUMN IF NOT EXISTS scan_status VARCHAR(20) NOT NULL DEFAULT 'NOT_SCANNED' CHECK (scan_status IN ('NOT_SCANNED','CLEAN','SCAN_UNAVAILABLE','SCAN_ERROR'));
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS scan_engine VARCHAR(100);
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS enc_key_id VARCHAR(40);
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS enc_wrapped_key TEXT;      -- data key wrapped with the key-encryption key (iv.tag.ciphertext, base64)
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS stored_sha256 VARCHAR(64);  -- hash of the bytes actually stored (ciphertext when encrypted)
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS stored_size BIGINT;
UPDATE evidence SET stored_sha256 = sha256, stored_size = size_bytes WHERE stored_sha256 IS NULL AND sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evidence_scan ON evidence(scan_status) WHERE scan_status <> 'CLEAN';
CREATE INDEX IF NOT EXISTS idx_evidence_org_size ON evidence(project_id) INCLUDE (size_bytes);
COMMIT;
