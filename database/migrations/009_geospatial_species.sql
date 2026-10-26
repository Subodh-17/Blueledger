-- 009_geospatial_species.sql — validated geospatial evidence imports and structured planting by species.
-- Compatible with earlier data: new tables, one new evidence kind, one nullable column. The record content hash is unchanged for
-- records without a species snapshot (see common.recordPayload).
BEGIN;

-- 1. GeoJSON imports are evidence items of their own kind (so they are hashed, scanned, reviewed and superseded like any other evidence).
ALTER TABLE evidence DROP CONSTRAINT IF EXISTS evidence_kind_chk;
ALTER TABLE evidence ADD CONSTRAINT evidence_kind_chk CHECK (kind IN ('FIELD_PHOTO','DRONE_IMAGERY','REMOTE_SENSING','DOCUMENT','GEOSPATIAL'));

-- 2. What the validator found, frozen at import time. Only files that passed validation are stored; rejected files leave no row.
CREATE TABLE IF NOT EXISTS geospatial_imports (
  id                SERIAL PRIMARY KEY,
  evidence_id       INTEGER NOT NULL UNIQUE REFERENCES evidence(id),
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  record_id         INTEGER REFERENCES monitoring_records(id),
  imported_by       INTEGER NOT NULL REFERENCES users(id),
  source            VARCHAR(20) NOT NULL CHECK (source IN ('FIELD_SURVEY','DRONE_PRODUCT','OTHER')),
  tool              VARCHAR(100),
  tool_version      VARCHAR(50),
  validator_version VARCHAR(20) NOT NULL,
  validation_status VARCHAR(25) NOT NULL CHECK (validation_status IN ('VALID','VALID_WITH_WARNINGS')),
  boundary_status   VARCHAR(20) NOT NULL CHECK (boundary_status IN ('INSIDE','PARTIAL','OUTSIDE','NO_BOUNDARY','BOUNDARY_UNUSABLE','NOT_APPLICABLE')),
  boundary_checked  BOOLEAN NOT NULL,
  inside_fraction   NUMERIC(6,4),
  feature_count     INTEGER NOT NULL CHECK (feature_count > 0),
  vertex_count      INTEGER NOT NULL CHECK (vertex_count >= 0),
  bbox              JSONB,
  geometry_types    JSONB NOT NULL,
  species_totals    JSONB NOT NULL,
  validation_report JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_geoimports_project ON geospatial_imports(project_id);
CREATE INDEX IF NOT EXISTS idx_geoimports_record ON geospatial_imports(record_id);
CREATE OR REPLACE FUNCTION geospatial_imports_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'geospatial_imports is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_geospatial_imports_immutable ON geospatial_imports;
CREATE TRIGGER trg_geospatial_imports_immutable BEFORE UPDATE OR DELETE ON geospatial_imports FOR EACH ROW EXECUTE FUNCTION geospatial_imports_immutable();

-- 3. Planting by species for a monitoring record. Editable only while the record is a draft or awaiting revision.
CREATE TABLE IF NOT EXISTS record_species (
  id            SERIAL PRIMARY KEY,
  record_id     INTEGER NOT NULL REFERENCES monitoring_records(id),
  species_name  VARCHAR(120) NOT NULL CHECK (length(btrim(species_name)) > 0),
  planted_count INTEGER NOT NULL CHECK (planted_count >= 0 AND planted_count <= 10000000),
  unit          VARCHAR(20) NOT NULL DEFAULT 'plants',
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_record_species_name ON record_species(record_id, lower(btrim(species_name)));
CREATE OR REPLACE FUNCTION record_species_editable() RETURNS trigger AS $$
DECLARE st TEXT;
BEGIN
  SELECT status INTO st FROM monitoring_records WHERE id = COALESCE(NEW.record_id, OLD.record_id);
  IF st NOT IN ('DRAFT','NEEDS_REVISION') THEN RAISE EXCEPTION 'the species list is locked once a record is %', st; END IF;
  RETURN COALESCE(NEW, OLD);
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_species_editable ON record_species;
CREATE TRIGGER trg_record_species_editable BEFORE INSERT OR UPDATE OR DELETE ON record_species FOR EACH ROW EXECUTE FUNCTION record_species_editable();

-- 4. The species list as submitted, part of what the content hash and the anchor cover (null when none were recorded).
ALTER TABLE monitoring_records ADD COLUMN IF NOT EXISTS species_snapshot JSONB;
COMMIT;
