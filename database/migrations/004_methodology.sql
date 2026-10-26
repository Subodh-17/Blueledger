-- 004_methodology.sql
-- Versioned methodologies with independent-review records, project determinations (baseline, additionality, leakage,
-- non-permanence risk) and period-based carbon assessments that cannot overlap (no double counting across periods).
CREATE EXTENSION IF NOT EXISTS btree_gist;
BEGIN;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS climate_region VARCHAR(20) CHECK (climate_region IN ('TROPICAL_WET','TROPICAL_DRY','SUBTROPICAL','OTHER'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS revegetation_method VARCHAR(25) CHECK (revegetation_method IN ('PLANTED','NATURAL_RECOLONISATION'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS methodology_version VARCHAR(40);

-- Records of independent scientific review of a methodology version. A review is only valid for the exact parameter set
-- (parameters_hash) that was reviewed; changing any coefficient invalidates it.
CREATE TABLE IF NOT EXISTS methodology_reviews (
  id               SERIAL PRIMARY KEY,
  methodology_version VARCHAR(40) NOT NULL,
  parameters_hash  VARCHAR(66) NOT NULL,
  decision         VARCHAR(12) NOT NULL CHECK (decision IN ('APPROVED','WITHDRAWN','REJECTED')),
  reviewer_name    VARCHAR(200) NOT NULL,
  reviewer_organization VARCHAR(200) NOT NULL,
  review_reference VARCHAR(500) NOT NULL,           -- report identifier or URL of the independent review
  review_date      DATE NOT NULL,
  scope_notes      TEXT,
  recorded_by      INTEGER NOT NULL REFERENCES users(id),
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meth_reviews_version ON methodology_reviews(methodology_version, id DESC);

-- Project-level determinations required by crediting methodologies. Values come from reviewed project documents, never from defaults.
CREATE TABLE IF NOT EXISTS project_determinations (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id),
  kind         VARCHAR(25) NOT NULL CHECK (kind IN ('BASELINE','ADDITIONALITY','LEAKAGE','NON_PERMANENCE_RISK')),
  version      INTEGER NOT NULL DEFAULT 1,
  summary      TEXT NOT NULL,
  document_reference VARCHAR(500) NOT NULL,
  buffer_percent NUMERIC(5,2) CHECK (buffer_percent IS NULL OR (buffer_percent >= 0 AND buffer_percent < 100)),
  status       VARCHAR(10) NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','ACCEPTED','REJECTED','SUPERSEDED')),
  submitted_by INTEGER NOT NULL REFERENCES users(id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by  INTEGER REFERENCES users(id),
  reviewer_organization VARCHAR(200),
  reviewed_at  TIMESTAMPTZ,
  review_notes TEXT,
  CHECK (kind <> 'NON_PERMANENCE_RISK' OR buffer_percent IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_determinations_project ON project_determinations(project_id, kind, id DESC);

-- Period-based assessments
ALTER TABLE carbon_calculations ADD COLUMN IF NOT EXISTS period_start DATE;
ALTER TABLE carbon_calculations ADD COLUMN IF NOT EXISTS period_end DATE;
ALTER TABLE carbon_calculations ADD COLUMN IF NOT EXISTS methodology_hash VARCHAR(66);
ALTER TABLE carbon_calculations ADD COLUMN IF NOT EXISTS central_tco2e NUMERIC(18,4);
ALTER TABLE carbon_calculations ADD COLUMN IF NOT EXISTS conservative_tco2e NUMERIC(18,4);
ALTER TABLE carbon_calculations ADD COLUMN IF NOT EXISTS buffer_percent NUMERIC(5,2);
ALTER TABLE carbon_calculations ADD COLUMN IF NOT EXISTS blockers JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE carbon_calculations ALTER COLUMN estimate_tco2e TYPE NUMERIC(18,4);
ALTER TABLE carbon_calculations ALTER COLUMN low_tco2e TYPE NUMERIC(18,4);
ALTER TABLE carbon_calculations ALTER COLUMN high_tco2e TYPE NUMERIC(18,4);
UPDATE carbon_calculations SET period_start = COALESCE(period_start, (inputs->>'projectStartDate')::date), period_end = COALESCE(period_end, (inputs->>'monitoringDate')::date) WHERE period_start IS NULL;
UPDATE carbon_calculations SET period_end = period_start + 1 WHERE period_end <= period_start;
-- Two current assessments of one project may never cover overlapping periods.
ALTER TABLE carbon_calculations ADD CONSTRAINT carbon_period_order CHECK (period_start IS NULL OR period_end > period_start);
ALTER TABLE carbon_calculations ADD CONSTRAINT carbon_no_period_overlap EXCLUDE USING gist (project_id WITH =, daterange(period_start, period_end, '[)') WITH &&) WHERE (is_current AND approval_status <> 'REJECTED' AND period_start IS NOT NULL);
COMMIT;
