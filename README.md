# BlueLedger — Blockchain-Based Blue Carbon Registry and MRV System

Monitoring, reporting and verification (MRV) registry for blue-carbon restoration projects (mangroves, seagrass, salt marsh), with
on-chain record anchoring and traceable credit issuance, transfer and retirement. Developed against problem statement SIH25038
(Ministry of Earth Sciences, National Centre for Coastal Research).

Repository: [https://github.com/Subodh-17/Blueledger](https://github.com/Subodh-17/Blueledger)

> **Status and provenance.** This is a software system, not an accredited registry. Registry credits are not accredited under any external
> carbon standard and have no legal recognition. The carbon coefficients in the assessment methodology are **unvalidated placeholders**
> (see [docs/METHODOLOGY.md](docs/METHODOLOGY.md)). The included reference dataset is **illustrative**: it was not collected in the field,
> does not describe real restoration outcomes, and is labelled "Illustrative dataset" wherever it appears. Nothing here has been independently
> security-audited or scientifically reviewed.

## Contents
1. [Workflow](#1-workflow) · 2. [Architecture](#2-architecture) · 3. [Roles](#3-roles-and-permissions) · 4. [Requirements](#4-requirements) · 5. [Setup](#5-setup) · 6. [Environment](#6-environment-variables) · 7. [Database](#7-database) · 8. [Blockchain](#8-blockchain-network-and-contract) · 9. [Evidence storage](#9-evidence-storage) · 10. [Running](#10-running) · 11. [Reference accounts](#11-reference-dataset-and-accounts) · 12. [Testing](#12-testing) · 13. [Failure handling](#13-failure-handling-and-reconciliation) · 14. [Service confirmation levels](#14-what-confirmed-means) · 15. [Public verification](#15-public-verification) · 16. [Deployment](#16-deployment-guidance) · 17. [Security](#17-security-summary) · 18. [Troubleshooting](#18-troubleshooting) · 19. [Limitations](#19-known-limitations-and-external-dependencies) · 20. [Items needing review](#20-items-requiring-scientific-or-independent-review) · 21. [Governance screens](#21-governance-screens-added-in-this-snapshot)

## 1. Workflow

```
Field data → Evidence submission → MRV review → Independent verification → Carbon assessment → Authorized approval → Credit issuance → Transfer or retirement → Public verification
```

Every transition is backed by persisted state and an audit entry. Separate status vocabularies are used for: project lifecycle (Active / On hold / Closed),
monitoring record (Draft → Submitted → Under review → Verified | Rejected | Revision requested), evidence review (Pending review / Accepted / Rejected / Revision requested),
verification decision, assessment approval (Awaiting approval / Approved / Not approved), credit batch (Issued / Partly retired / Retired), and blockchain operation
(Not submitted / Pending confirmation / Confirmed; registry update pending / Completed / Failed).

1. **Field data** – a field user records activity, geotag, measurements (with units) and observations, and attaches evidence (photographs, drone imagery, remote-sensing references, documents). Drafts can be saved.
2. **Reporting** – on submission the server builds a structured MRV report and a canonical content hash; the hash and an evidence root are **anchored on-chain** (the project is registered on-chain first).
3. **Review** – a verifier starts review, accepts / rejects / requests revision per evidence item, and sees ten automated checks (completeness, evidence accepted, area, date, location, embedded file metadata, integrity, anchoring). Blocking checks must pass before a record can be verified.
4. **Verification** – the decision (with comments) is written on-chain and to the audit log. A verifier cannot review their own submission.
5. **Carbon assessment** – a versioned, reproducible calculation (inputs, formula, parameters, deductions, rounding) for verified records. It never counts credits already issued twice.
6. **Approval** – the registry administrator approves or declines the assessment; the approver must differ from the verifier.
7. **Issuance / transfer / retirement** – only approved quantities are issued, once per record, to the implementing organization; holders may transfer and retire. Per-batch balances stay traceable on-chain.
8. **Public verification** – anyone can recompute a record's hash and compare it with the on-chain anchor.

## 2. Architecture

```
Browser (vanilla ES-module SPA, responsive) ──REST/JWT──▶ Node.js / Express API ──SQL──▶ PostgreSQL
                                                                │     └─ files (+ optional IPFS pin) ▶ backend/uploads
                                                                └─ ethers ─▶ EVM network ▶ BlueCarbonRegistry.sol
```

* **Off-chain:** users, organizations, projects, measurements, MRV reports, evidence files, calculations, audit log (PostgreSQL + file storage).
* **On-chain:** project id + metadata hash, record id + content hash + evidence root, verification hash and verifier, estimate hash, credit quantity / holder / per-batch balances / retirements.
* Large files never go on-chain. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 3. Roles and permissions

| Capability | Public | Field user | Verifier | Registry administrator |
|---|:-:|:-:|:-:|:-:|
| Public verification of records and credit batches | ✔ | ✔ | ✔ | ✔ |
| Create / edit / submit records and upload evidence (own organization's projects) | | ✔ | | |
| Review evidence, start review, verify / reject / request revision | | | ✔ | |
| Calculate a carbon assessment | | | ✔ | ✔ |
| Register projects, manage users and organizations, grant on-chain roles | | | | ✔ |
| Approve assessments and issue credits | | | | ✔ |
| Transfer / retire credits | | own holdings | | on behalf of a holder |
| Audit log | | | ✔ | ✔ (+ integrity check) |
| Blockchain operations, reconciliation, system status | | | | ✔ |

All permissions are enforced on the server (role checks, organization scoping on every list and detail endpoint). Verification and issuance are also enforced by the smart contract (separation of duties).

## 4. Requirements
Node.js ≥ 20, PostgreSQL ≥ 14 (or `docker compose up -d db`; the compose file was not executed in the authoring environment), a modern browser. No Docker or external service is required for the local blockchain network.

## 5. Setup

```bash
npm run setup                               # installs backend and blockchain dependencies
cp backend/.env.example backend/.env        # set DB_PASSWORD (JWT_SECRET is generated per run in development)
```

## 6. Environment variables
All configuration is read from the environment; see `backend/.env.example` for the complete annotated template. Required in production: `JWT_SECRET` (≥ 32 random characters), `DB_*`, `ETH_RPC_URL`,
`CHAIN_MODE=keys` with `CHAIN_ADMIN_PRIVATE_KEY`, `CHAIN_VERIFIER_PRIVATE_KEY`, `CHAIN_REGISTRAR_PRIVATE_KEY` (environment or secret manager only), `CORS_ORIGINS` if a separate front-end origin is used.
Optional: `IPFS_PROVIDER` (`none|kubo|pinata`), `MAP_TILE_URL`, `RATE_LIMIT_*`, `RPC_TIMEOUT_MS`, `TX_CONFIRM_TIMEOUT_MS`, `RECONCILE_INTERVAL_MS`, `TRUST_PROXY`.
No private key or secret is stored in the repository, returned by the API, or logged.

## 7. Database
```bash
npm run db:migrate      # apply pending migrations (001–008, see database/migrations)
npm run db:reset        # DROP SCHEMA public and re-apply (refuses when NODE_ENV=production)
npm run db:seed         # load the illustrative reference dataset (resets all data; needs the blockchain network)
```
Migrations 004–008 add: methodology reviews and project determinations (004), chain-operation recovery (005), password resets, token revocation and evidence encryption columns (006), evidence provenance (007), notifications, runtime settings and idempotent client references (008).
Migration 003 renames provenance values, adds the durable `chain_operations` table, credit batch codes, assessment versions and file-metadata columns. The audit log is append-only (database trigger) and hash-chained.

## 8. Blockchain network and contract
```bash
npm run chain           # terminal 1: local Hardhat network (development only)
npm run chain:deploy    # terminal 2: deploys BlueCarbonRegistry, writes blockchain/deployments/localhost.json
```
The deployment file (address, chain ID, ABI) is validated at startup: shape, chain ID against the RPC endpoint, contract code at the address, and the required ABI functions. A mismatch keeps the API running but marks the network **not connected** with the exact reason.
Local role mapping (development only): account 0 = registry administrator, 1 and 3 = verifiers, 2 = registrar service, 4+ = organization wallets. For a public/permissioned network, deploy with `npx hardhat run scripts/deploy.js --network <name>` using environment-supplied keys and run the API with `CHAIN_MODE=keys`; this path has **not** been exercised against a live public network.
Contract summary: `registerProject → anchorRecord → recordVerification → issueCredits → transfer / retire`; verifiers cannot issue, the issuer cannot be the verifier of the same record, no issuance before verification, one issuance per record, inactive projects blocked, zero address / quantity rejected, per-batch balance checks.
The `solc` npm package compiles the contract so the build also works where the native compiler download is blocked (`HARDHAT_NATIVE_SOLC=1` to disable).

## 9. Evidence storage
Files are stored under `UPLOAD_DIR` named by their SHA-256 and validated by **file signature** (the content must match the extension: JPEG, PNG, WebP, TIFF, PDF). Embedded metadata (image size, capture time, device, GPS where present) is read from the file and compared with declared values during review.
IPFS pinning is optional (`kubo` or `pinata`); a CID is recorded **only** when a pin succeeded, and each item shows one of: IPFS not configured / pinned / unavailable. Evidence files are served only to authenticated users with access, with sandboxing headers and `no-store`.
The content hash is an integrity identifier, not proof that what a file shows is true.

## 10. Running
```bash
DB_PASSWORD=… npm run start:local     # one command: local network → deploy → migrate (reset) → reference dataset → API + UI at http://localhost:3001
npm start                             # API + UI only (database migrated, contract deployed, network reachable)
```
The API starts a background reconciler (every `RECONCILE_INTERVAL_MS`) and also reconciles once at startup.

## 11. Reference dataset and accounts
`npm run db:seed` loads six illustrative projects covering every lifecycle state (verified and issued with a transfer and a partial retirement, an assessment awaiting approval, a record under review, a rejected record, a revision request, a draft). Records are created through the real service layer, so transactions and audit entries are genuine on the local network.
All reference records carry the provenance value `ILLUSTRATIVE` and are shown as "Illustrative dataset".

Sign-in shortcuts are offered on the sign-in page **only when `NODE_ENV` is not `production`** (`SHOW_REFERENCE_ACCOUNTS=0` disables them). Password for all reference accounts: `Reference-Pass-2026` (override with `REFERENCE_PASSWORD`).

| Role | Email |
|---|---|
| Registry administrator | `admin@nccr.example` |
| Verifiers | `verifier1@verification.example`, `verifier2@verification.example` |
| Field users | `field.trust@field.example`, `field.village@field.example`, `field.panchayat@field.example`, `field.research@field.example`, `buyer@field.example` |

## 12. Testing
```bash
npm test                         # frontend check + contract tests + backend suite
npm run frontend:check           # modules parse, imports/assets resolve, no external origins / inline styles, wording audit, colour-contrast audit
npm run test:contracts           # Hardhat tests of BlueCarbonRegistry
DB_PASSWORD=… npm run test:backend   # starts its own local network; RESETS the database named TEST_DB_NAME (default blue_carbon_mrv_test)
```
The backend suite runs against real PostgreSQL and a real local EVM network: the full lifecycle, revision and rejection paths, duplicate-issuance prevention (API and contract), transfers and retirement, role and cross-organization permissions, validation, uploads, rate limiting, password policy, audit immutability and tamper detection, carbon calculation reproducibility and boundaries, public verification, pagination/search, administration, **RPC outage and recovery, failure after on-chain confirmation, idempotent retries and reconciliation, deployment validation**, and **UI workflows with accessibility and wording audits** (the real frontend bundle in jsdom).
jsdom is not a visual browser: layout, real-device behaviour and map tile rendering are **not** covered by automated tests.

## 13. Failure handling and reconciliation
PostgreSQL and a blockchain cannot be updated atomically, so this system does not claim to. Each on-chain action is a durable **operation** (`chain_operations`) with an idempotency key and explicit states:

`PENDING` (intent stored) → `SUBMITTED` (transaction hash known) → `CONFIRMED` (receipt shows success; registry not yet updated) → `COMPLETED` (registry updated) · `FAILED` (rejected, reverted, or indeterminate).

* If the network is down, the registry action is stored (or refused with an explicit 503) and retried; records submitted during an outage are kept and anchored automatically afterwards.
* If a transaction is confirmed but the database update fails, the operation stays `CONFIRMED`; reconciliation applies the result **exactly once**.
* Reconciliation runs at startup, on a timer, and on demand (Blockchain network → Run reconciliation, or `POST /api/system/reconcile`). It probes the chain state before re-sending anything.
* Transfers and retirements are not blindly re-sent when no transaction hash was stored: they are marked `FAILED` ("indeterminate") and may be retried explicitly, with an `Idempotency-Key` header making replays safe.
* Remaining gap: if a process dies in the instant between the network accepting a transfer/retirement and the hash being stored, the movement can exist on-chain without a registry record; the public verification and holder balance comparison (registry vs on-chain) expose this.

## 14. What "confirmed" means
* **Locally confirmed** – confirmed by the connected network, which is a local development network unless configured otherwise. It is not confirmed by any public blockchain.
* **Externally confirmed** – confirmed on a public or consortium network you configured (not exercised here).
* **Not connected / unavailable** – the service could not be reached. The interface never shows this as empty or successful.
The Administration → System health page shows the live state of the database, network, evidence storage and IPFS.

## 15. Public verification
`#/verify` (no sign-in) accepts a record code (`MR-00001`) or credit batch (`CB-00001`), recomputes the record hash from registry data, compares it with the hash anchored on the network, and shows chain ID, contract, block, transaction and credit events. A match proves the stored record is consistent with the anchored hash; it does **not** prove the measurements are true, that carbon was removed, or that any external accreditation exists.

## 16. Deployment guidance
Terminate TLS in a reverse proxy; set `NODE_ENV=production`, `TRUST_PROXY=1`, a strong `JWT_SECRET`, a managed PostgreSQL with backups, restricted network access to the RPC endpoint, `CHAIN_MODE=keys` with keys from a secret manager, persistent storage for `UPLOAD_DIR`, and run more than one reconciler only if you accept benign contention (operations are claimed with row locks). The in-memory rate limiter is per process; use a gateway for global limits. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

## 17. Security summary
Server-side role checks and organization scoping; JWTs re-validated against the user table on every request (deactivation takes effect immediately); bcrypt password hashing with a 12-character policy; login throttling and per-route rate limits; strict content-security-policy (no inline scripts or styles); sandboxed, authenticated evidence downloads with file-signature validation; parameterized SQL with escaped search input and whitelisted sort keys; request ids and sanitized error responses (no stack traces); append-only hash-chained audit log; no secrets in the repository or in API responses. Details and gaps: [docs/SECURITY.md](docs/SECURITY.md). No external security audit has been performed.

## 18. Troubleshooting
| Symptom | Cause / action |
|---|---|
| "Blockchain network not connected: Deployment file not found" | Run `npm run chain:deploy` while the network is running. |
| "Chain ID mismatch" | The deployment file was created on another network; redeploy or fix `ETH_RPC_URL`. |
| "No contract code at …" | The network was restarted (a local network loses state); redeploy and re-seed. |
| Records stay "Anchoring pending" | The network was unreachable; it resolves automatically, or run reconciliation. |
| "confirmed on the blockchain, but the registry update did not complete" | Reconciliation will apply it; check Blockchain network → operations. |
| Map has no background | Tile server unreachable or `MAP_TILE_URL` empty; boundaries and markers still use recorded coordinates. |
| 429 responses | Rate limit reached; wait for `Retry-After`. |
| 503 "database is unavailable" | PostgreSQL is unreachable; the API recovers when it returns. |

## 19. Known limitations and external dependencies
* Not an accredited registry; credits have no legal standing. Carbon coefficients are unvalidated placeholders.
* The default network is a local development network with **custodial signing** (the API signs as service accounts and, locally, as holder accounts). A production design needs verifier and holder wallets signing for themselves.
* No atomic commit between PostgreSQL and the chain (mitigated as described in §13). The audit hash chain detects tampering but is not itself anchored on-chain.
* No offline submission queue; unsent form input is kept in the browser session, not synced. No native mobile app (responsive, PWA-style web app).
* No image analysis of any kind. Embedded metadata is read, nothing is inferred from pixels.
* Basemap tiles come from a third-party tile server (OpenStreetMap by default; mind its usage policy) and were not loadable in the authoring environment. No PostGIS.
* UI verified with automated jsdom tests only; no visual inspection in a real browser engine or on real devices.
* Docker Compose file and public-network deployment were not executed.

## 20. Items requiring scientific or independent review
Applicable methodology per habitat; sources and uncertainty of sequestration coefficients and soil pools; baseline, additionality and leakage; permanence and buffer governance; monitoring design and minimum survey frequency; independent third-party validation and verification procedures; legal and regulatory status of any credit; security review of the deployed system. Details: [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

## 21. Governance screens added in this snapshot
These screens sit on API endpoints that already existed and are tested at the API level (see `V3-PROGRESS.md`). The screens themselves have been checked only by `npm run frontend:check` (syntax, imports, wording, contrast); they have **not** been exercised against a running stack, and the page-render checks added to `backend/tests/ui.test.js` have not been run.

| Where | What it does | API |
|---|---|---|
| Administration → Methodology review (administrator) | Shows each methodology version's review state and parameter-set hash; records an independent review that was performed outside the system. Illustration-only versions cannot be reviewed. | `GET /methodologies`, `GET/POST /methodologies/:version/review(s)` |
| Project detail → Methodology determinations | Baseline, additionality, leakage and non-permanence (buffer) determinations: administrators submit from a reviewed document; a different verifier accepts or rejects. | `GET/POST /projects/:id/determinations`, `POST /determinations/:id/review` |
| Administration → Runtime settings (administrator) | Bounded settings that change without a restart; each change needs a reason and is audited with its history. Secrets are never shown. | `GET /settings`, `PUT/DELETE /settings/:key`, `GET /settings/history` |
| Administration → On-chain roles (administrator) | Lists verifier and registrar wallets, grants or revokes roles, proposes an administrator hand-over (the proposed wallet must accept from its own wallet; there is no accept screen). | `GET/POST /chain/roles`, `POST /chain/admin/propose` |
| Account menu → Notifications | Notifications created with the events they describe; mark as read. Unread count is included in the bell badge. | `GET /notifications`, `POST /notifications/read` |
| Sign-in → Forgot your password? | Requests a reset link (answered identically whether or not the account exists) and sets a new password from the emailed link; all sessions are revoked. | `POST /auth/forgot-password`, `POST /auth/reset-password` |

Not yet built: evidence scan / IPFS / provenance detail views, an assessment screen that lists issuance blockers from the methodology rules, the browser offline queue, and a real-browser test suite.

## SIH25038 status documents
`docs/SIH25038_REQUIREMENTS_TRACEABILITY.md` (requirement-by-requirement status with files and test evidence), `docs/SIH25038_IMPLEMENTATION_REPORT.md` (what changed, open decisions, remaining work) and `docs/SIH25038_TEST_REPORT.md` (exact commands, counts, skipped and unrun checks). The project is not claimed to be SIH-ready: methodology review, a contract-level reversal path, drone-derived evidence import and real-browser tests remain open.

## Demonstration journey (automated)
One automated test walks the whole workflow with distinct users and proves the wrong actor is refused at each stage: onboarding an organization and a collector, field submission with a photo, GeoJSON and species list, anchoring, independent verification, a versioned estimate with disclosed assumptions, approval, issuance (including a crash after the transaction was sent), transfer, dispute and retirement, the audit trail, and NCCR reports with CSV export. All records are labelled illustrative sample data and the estimates use placeholder parameters; this is not validated carbon accounting.
```
npm run setup
# disposable PostgreSQL only: the test runner RESETS the database named by TEST_DB_NAME
DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=postgres DB_PASSWORD=... TEST_DB_NAME=blue_carbon_mrv_test node backend/tests/run.js backend/tests/journey.test.js
# the same workflows in a real browser (needs Playwright with Chromium; axe-core optional)
DB_PASSWORD=... E2E_DB_NAME=blue_carbon_mrv_e2e npm run test:e2e
```
To explore by hand, run the reference dataset (`npm run db:reset && npm run db:seed`, on a development database), sign in with a reference account and open Registry reports, Evidence (geospatial import), a record (species) and a credit batch (disputes). Environment additions in this version are optional: `GEO_MAX_BYTES`, `GEO_MAX_FEATURES`, `GEO_MAX_VERTICES`.
