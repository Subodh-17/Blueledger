-- database/migrations/001_initial_schema.sql
-- Blue Carbon MRV — Full Database Schema
-- Run: psql -U postgres -d blue_carbon_mrv -f 001_initial_schema.sql

-- ── Users ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  uuid           UUID DEFAULT gen_random_uuid() UNIQUE,
  name           VARCHAR(255) NOT NULL,
  email          VARCHAR(255) UNIQUE NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  role           VARCHAR(50)  NOT NULL DEFAULT 'ngo_worker',
                 -- admin | verifier | ngo_worker | community
  organisation   VARCHAR(255),
  wallet_address VARCHAR(42),
  bct_balance    NUMERIC(14,2) DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Projects ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id               SERIAL PRIMARY KEY,
  uuid             UUID DEFAULT gen_random_uuid() UNIQUE,
  owner_id         INTEGER REFERENCES users(id),
  name             VARCHAR(255) NOT NULL,
  description      TEXT,
  location_text    VARCHAR(255),
  latitude         NUMERIC(10,6),
  longitude        NUMERIC(10,6),
  area_hectares    NUMERIC(12,2) NOT NULL,
  ecosystem_type   VARCHAR(50)   NOT NULL,
                   -- MANGROVE | SEAGRASS | SALT_MARSH
  growth_years     INTEGER DEFAULT 1,
  status           VARCHAR(50)  DEFAULT 'pending',
                   -- pending | verified | rejected | minted
  carbon_tonnes    NUMERIC(12,2),
  ipfs_image_hash  VARCHAR(255),
  blockchain_id    INTEGER,
  tx_hash          VARCHAR(66),
  notes            TEXT,
  verified_by      INTEGER REFERENCES users(id),
  verified_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Drone / Field Images ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drone_images (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id),
  uploader_id  INTEGER REFERENCES users(id),
  filename     VARCHAR(255),
  file_path    VARCHAR(500),
  ipfs_hash    VARCHAR(255),
  image_type   VARCHAR(50) DEFAULT 'drone',
               -- drone | field | satellite
  latitude     NUMERIC(10,6),
  longitude    NUMERIC(10,6),
  captured_at  TIMESTAMPTZ,
  status       VARCHAR(50) DEFAULT 'pending_review',
               -- pending_review | approved | rejected
  reviewed_by  INTEGER REFERENCES users(id),
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Carbon Credits ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS carbon_credits (
  id            SERIAL PRIMARY KEY,
  project_id    INTEGER REFERENCES projects(id) UNIQUE,
  owner_id      INTEGER REFERENCES users(id),
  amount_tonnes NUMERIC(12,2) NOT NULL,
  tx_hash       VARCHAR(66),
  block_number  INTEGER,
  minted_at     TIMESTAMPTZ DEFAULT NOW(),
  retired       BOOLEAN DEFAULT FALSE,
  retired_at    TIMESTAMPTZ,
  retired_by    INTEGER REFERENCES users(id)
);

-- ── Blockchain Transactions ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS blockchain_transactions (
  id          SERIAL PRIMARY KEY,
  tx_hash     VARCHAR(66) UNIQUE NOT NULL,
  block_num   INTEGER,
  tx_type     VARCHAR(50),
               -- ProjectRegistered | ProjectVerified | CreditsMinted | ContractDeployed
  detail      TEXT,
  from_addr   VARCHAR(42),
  gas_used    VARCHAR(20),
  owner_id    INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Smart Contract Registry ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS smart_contracts (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  address      VARCHAR(42) UNIQUE NOT NULL,
  network      VARCHAR(50) DEFAULT 'testnet',
  chain_id     INTEGER DEFAULT 31337,
  deployed_by  INTEGER REFERENCES users(id),
  deployed_at  TIMESTAMPTZ DEFAULT NOW(),
  is_active    BOOLEAN DEFAULT TRUE
);

-- ── Indexes ───────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_projects_status    ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_owner     ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_images_project     ON drone_images(project_id);
CREATE INDEX IF NOT EXISTS idx_images_status      ON drone_images(status);
CREATE INDEX IF NOT EXISTS idx_credits_project    ON carbon_credits(project_id);
CREATE INDEX IF NOT EXISTS idx_credits_owner      ON carbon_credits(owner_id);
CREATE INDEX IF NOT EXISTS idx_blockchain_type    ON blockchain_transactions(tx_type);
