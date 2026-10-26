-- 010_credit_disputes.sql — disputes against issued credit batches, with an append-only review history.
-- A dispute is a REGISTRY control: while one is open, under review or upheld, the API refuses to start transfers and retirements of that
-- batch. It does not freeze or alter the on-chain token (the deployed contract has no such function); see docs/SIH25038_CREDIT_CANCELLATION_PROPOSAL.md.
BEGIN;
CREATE TABLE IF NOT EXISTS credit_disputes (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(20) GENERATED ALWAYS AS ('DSP-' || lpad(id::text, 4, '0')) STORED,
  credit_id       INTEGER NOT NULL REFERENCES carbon_credits(id),
  record_id       INTEGER NOT NULL REFERENCES monitoring_records(id),
  calculation_id  INTEGER REFERENCES carbon_calculations(id),
  category        VARCHAR(20) NOT NULL CHECK (category IN ('EVIDENCE','DOUBLE_COUNTING','OWNERSHIP','CALCULATION','OTHER')),
  reason          TEXT NOT NULL CHECK (length(btrim(reason)) >= 10 AND length(reason) <= 2000),
  status          VARCHAR(15) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UNDER_REVIEW','UPHELD','DISMISSED','WITHDRAWN')),
  raised_by       INTEGER NOT NULL REFERENCES users(id),
  reviewer_id     INTEGER REFERENCES users(id),
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_disputes_code ON credit_disputes(code);
CREATE INDEX IF NOT EXISTS idx_credit_disputes_credit ON credit_disputes(credit_id, status);

CREATE TABLE IF NOT EXISTS credit_dispute_events (
  id          BIGSERIAL PRIMARY KEY,
  dispute_id  INTEGER NOT NULL REFERENCES credit_disputes(id),
  event_type  VARCHAR(20) NOT NULL CHECK (event_type IN ('RAISED','REVIEW_STARTED','UPHELD','DISMISSED','WITHDRAWN')),
  from_status VARCHAR(15),
  to_status   VARCHAR(15) NOT NULL,
  actor_id    INTEGER NOT NULL REFERENCES users(id),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dispute_events_dispute ON credit_dispute_events(dispute_id, id);
CREATE OR REPLACE FUNCTION credit_dispute_events_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'credit_dispute_events is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_credit_dispute_events_immutable ON credit_dispute_events;
CREATE TRIGGER trg_credit_dispute_events_immutable BEFORE UPDATE OR DELETE ON credit_dispute_events FOR EACH ROW EXECUTE FUNCTION credit_dispute_events_immutable();

-- Only these status changes are possible, whatever application code does; disputes are never deleted.
CREATE OR REPLACE FUNCTION credit_disputes_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'disputes cannot be deleted'; END IF;
  IF NEW.credit_id <> OLD.credit_id OR NEW.record_id <> OLD.record_id OR NEW.raised_by <> OLD.raised_by OR NEW.reason <> OLD.reason OR NEW.category <> OLD.category
     OR NEW.calculation_id IS DISTINCT FROM OLD.calculation_id THEN RAISE EXCEPTION 'the content of a dispute cannot be changed'; END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'OPEN' AND NEW.status IN ('UNDER_REVIEW','WITHDRAWN'))
    OR (OLD.status = 'UNDER_REVIEW' AND NEW.status IN ('UPHELD','DISMISSED','WITHDRAWN'))) THEN
    RAISE EXCEPTION 'invalid dispute status change % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_credit_disputes_guard ON credit_disputes;
CREATE TRIGGER trg_credit_disputes_guard BEFORE UPDATE OR DELETE ON credit_disputes FOR EACH ROW EXECUTE FUNCTION credit_disputes_guard();
COMMIT;
