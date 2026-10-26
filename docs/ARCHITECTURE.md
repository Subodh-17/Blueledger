# Architecture

## Components
| Component | Location | Notes |
|---|---|---|
| Web application | `frontend/` | Vanilla ES modules, hash router, no build step, strict CSP (no inline scripts/styles). Pages in `frontend/js/pages`. |
| API | `backend/src` | Express. `routes/` (HTTP + role guards), `services/` (business logic), `middleware/`, `utils/`. |
| Database | `database/migrations`, PostgreSQL | Foreign keys, CHECK constraints, unique constraints (one credit per record), append-only audit trigger. |
| Smart contract | `blockchain/contracts/BlueCarbonRegistry.sol` | Hardhat project, 20 tests. |
| Evidence storage | `backend/uploads` (+ optional IPFS) | Files named by SHA-256. |

## Services
`projects`, `records` (field data → MRV report → checks → decision), `evidence`, `carbon` (pure calculation), `credits` (assessment, approval, issuance, transfer, retirement), `registry` (public verification, statistics), `insights` (overview, tasks, search, system status), `audit` (hash-chained log), `chain` (contract client), `chainOps` + `chainHandlers` (durable operations).

## Hybrid data model
Off-chain: everything descriptive. On-chain: `projectId`, `metadataHash`; `recordId`, `contentHash` (keccak-256 of canonical record JSON including evidence hashes), `evidenceRoot`; verification hash + verifier; estimate hash, quantity, holder; per-batch balances and retirements. On-chain identifiers are `keccak256("record:" + uuid)` / `keccak256("project:" + uuid)` so no personal or descriptive data is published.

## Durable blockchain operations
```
request ─▶ validate (DB) ─▶ store operation (idempotency key) ─▶ claim (row lock)
        ─▶ probe chain (already done?) ─▶ submit tx ─▶ store tx hash ─▶ wait receipt
        ─▶ CONFIRMED ─▶ apply to registry in one DB transaction ─▶ COMPLETED
```
Handlers: `PROJECT_REGISTER`, `RECORD_ANCHOR`, `VERIFICATION`, `CREDIT_ISSUE`, `CREDIT_TRANSFER`, `CREDIT_RETIRE`, `ROLE_CHANGE`. Each defines `submit`, an optional `probe` (detects that the effect already exists on-chain) and an idempotent `finalize`.
Errors are classified as **permanent** (contract/signer rejection → `FAILED`, HTTP 409) or **transient** (network → stored and retried, HTTP 503). A receipt with status 0 is a failure; an HTTP 200 from the RPC is never treated as confirmation.

## State machines
Record: `DRAFT → SUBMITTED → UNDER_REVIEW → VERIFIED | REJECTED | NEEDS_REVISION`; `NEEDS_REVISION → SUBMITTED` (revision + 1, evidence reset to pending, re-anchored).
Assessment: calculated (current version) → `APPROVED | REJECTED`; recalculation supersedes earlier versions until credits are issued.
Credit batch: `ISSUED → PARTIALLY_RETIRED → RETIRED`; transfers move per-batch balances.

## Frontend structure
`app.js` shell and router; `util.js` templating (automatic escaping) and the single status vocabulary; `ui.js` dialogs, maps (Web Mercator tiles + boundary drawn from stored coordinates), charts (SVG computed from queried series); `pages/*` one module per product area.
