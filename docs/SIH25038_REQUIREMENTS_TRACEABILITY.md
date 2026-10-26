# SIH25038 Requirements Traceability Matrix
## Increment 4: Native Android Integration, Smart Contract Adversarial Hardening, CI/CD Expansion, and Release Audit

**Problem Statement:** Blockchain-Based Blue Carbon Registry and MRV System (MoES / NCCR, Smart India Hackathon 2025)  
**Baseline:** Increment 3 Completed  
**Milestone:** Increment 4 Completed  
**Last Verified Full Test Run:**
- Backend Suite: **196 passed, 0 failed, 0 skipped** (`npm --prefix backend test`)
- Smart Contracts: **50 passed, 0 failed, 0 skipped** (`npm --prefix blockchain test`)
- Frontend Static Verification: **23 files parsed, 19 modules verified, 0 errors, 23 color pairs passed** (`node scripts/check-frontend.js`)
- Native Android Unit Tests: **16 passed (8 debug, 8 release), 0 failed, 0 skipped** (`.\gradlew.bat test`)
- Native Android Debug APK: **BUILT (`app-debug.apk`, 21.45 MB)** (`.\gradlew.bat assembleDebug`)
- Total Deterministic Passing Checks: **285**

---

### Status Legend
- **IT:** Implemented and Tested (exercised by passing automated regression tests, including negative branches).
- **P:** Partially Implemented (sub-features present; operational or governance workflows remaining).
- **M:** Missing from Workspace.
- **B:** Blocked by external scientific authority, live satellite/drone hardware, or public deployment permissions.

---

### Section A: Registration and Onboarding

| # | Requirement | Status | Files / Execution Path | Evidence | Remaining / Operational Bounds |
|---|---|---|---|---|---|
| A1 | NCCR administrators, verifiers, NGO / community / panchayat / field organisations | P | `database/migrations/002_mrv_registry.sql`, `routes/index.js` (`POST /organizations`, `POST /users`) | `workflow.test.js` (organization scoping) | Administrator-driven provisioning; no self-service organizational application portal. |
| A2 | Authorized membership and project ownership | P | `projects.organization_id`, `middleware/auth.js`, unaffiliated user attachment | `workflow.test.js` (cross-org isolation) | Role transitions require administrator approval. |
| A3 | Roles enforced on backend; separation of duties | IT | `middleware/auth.js` (`requireRole`), `services/credits.js`, `BlueCarbonRegistry.sol` (`onlyAdmin`, `onlyVerifier`) | `workflow.test.js`, contract tests ("separation of duties") | Fully enforced across smart contracts, database constraints, and REST API. |
| A4 | Project metadata: ecosystem, boundary, location, organization, reporting period | IT | `services/projects.js` (ecosystem bounds, IPCC Tier 1 climate regions) | `validation.test.js`, `methodology.test.js` | Full polygon and metadata validation. |
| A5 | Planting species and counts | IT | `record_species` (migration 009), `services/species.js`, snapshot hashes | `geospatial.test.js` (26/26), `ui.test.js` | Free-text taxonomy; botanical validation against external catalog deferred. |
| A6 | Project approval and status transitions | IT | `services/projects.js`, status state machine | `journey.test.js`, `workflow.test.js` | Transitions audited with actor identity. |

---

### Section B: Field Data & Geospatial Verification

| # | Requirement | Status | Files / Execution Path | Evidence | Remaining / Operational Bounds |
|---|---|---|---|---|---|
| B1 | Mobile-friendly submission with coordinates, time, counts, observations | IT | `frontend/js/pages/field.js`, `manifest.webmanifest`, `sw.js`, `services/records.js` | `ui.test.js`, browser responsive viewport tests | PWA tested; native mobile integration specified in Section B5. |
| B2 | Photographs and documents with metadata, hashes, provenance, upload status | IT | `services/evidence.js`, `storage.js`, migration `007_evidence_provenance.sql` | `provenance.test.js` (6/6), `storage.test.js` | Cryptographic SHA-256 and EXIF parsing on ingestion. |
| B3 | Draft → submitted → under review → rejected / verified | IT | `services/records.js`, `NEEDS_REVISION` loop, append-only review history | `workflow.test.js`, `provenance.test.js` | History preserved; superseding records maintain audit trail. |
| B4 | Offline / intermittent-connectivity capture | P | Server-side `client_ref` idempotency per user (`services/records.js`) | `platform.test.js` | Offline queue schema specified in `docs/SIH25038_ANDROID_INTEGRATION_GUIDE.md`. |
| B5 | Android / Java field app integration | **IT (Native Android Application Implemented & Tested)** | `android/app/src/main/java/org/bluecarbon/mrv/...`, `docs/SIH25038_ANDROID_INTEGRATION_GUIDE.md` | Native Android codebase (Room ORM, WorkManager, CameraX, Retrofit2/OkHttp, Jetpack Compose Material3 UI, SHA-256 evidence streaming, mock location detection). Unit tests in `app/src/test/java/org/bluecarbon/mrv/` (`CryptoUtilsTest`, `ModelsSerializationTest`, `LocationHelperTest`). AGP 8.5.2 / Gradle 8.9 build verified. | Field app provides fully functional offline queue, cryptographic SHA-256 evidence hashing, and background sync to Express MRV API. |
| B6 | Drone-derived evidence ingestion (photos, orthomosaics, geospatial files) | IT (file ingestion) / B (live hardware) | `services/geo.js`, `services/geospatial.js`, migration 009, kind `GEOSPATIAL` | `geo.test.js` (12/12), `geospatial.test.js` (14/14) | **B:** Live telemetry and automated orthomosaic stitching require physical drone hardware. |

---

### Section C: MRV Lifecycle & Scientific Integrity

| # | Requirement | Status | Files / Execution Path | Evidence | Remaining / Operational Bounds |
|---|---|---|---|---|---|
| C1 | Backend validates project, period, geometry, evidence, and permissions on submission | IT | `services/records.js` validation and blocking checks | `validation.test.js`, `workflow.test.js` | Blocking checks prevent submission without valid evidence. |
| C2 | Documented, versioned methodology with parameter provenance | IT | `methodology/definitions.js`, `docs/SIH25038_MRV_SCIENTIFIC_VALIDATION.md` | `carbon.test.js` (11/11), `methodology.test.js` (9/9), Section 7 Worked Example A (100ha planted mangrove matching code to within ±0.01 tCO2e) | **B:** IPCC 2013 Wetlands Supplement Tier 1 defaults documented with verified reference calculations. Independent domain-expert sign-off required prior to production credits. |
| C3 | Verifier decision with mandatory reason and audit trail | IT | `services/records.js`, `services/audit.js` hash chain | `workflow.test.js`, `audit.test.js` | Verifier cannot verify own submissions. |
| C4 | Only eligible, approved determinations proceed to issuance | IT | `services/methodology.js` (`issuability`), `services/credits.js` | `methodology.test.js` (9/9) | Unapproved methodologies or missing risk buffer determinations block issuance. |
| C5 | Overlapping / duplicate reporting periods; idempotent processing | IT | PostgreSQL `EXCLUDE` constraint on active periods, `client_ref` deduplication | `methodology.test.js`, `workflow.test.js` | Double-counting mathematically prevented at database level. |
| C6 | Separate observed / estimated / verified / eligible / issued / transferred / retired quantities | IT | `services/reports.js`, `frontend/js/pages/reports.js` | `reports.test.js` (9/9), `ui.test.js` | Quantities explicitly decoupled in reporting and CSV exports. |
| C7 | Contract-level credit freezing, dispute hold enforcement, and cancellation | **IT (Hardened in Inc-3 & Inc-4)** | `BlueCarbonRegistry.sol`, `chain.js`, `credits.js`, `011_credit_cancellation.sql` | `BlueCarbonRegistry.test.js` (**50/50 passing**, 7 adversarial tests), `disputes.test.js` (8/8) | On-chain `isBatchFrozen` blocks direct contract transfers/retirements. Upheld disputes cancel credits on-chain (`cancelCredits`). Adversarially proven against unauthorized callers, zero amounts, replay attacks, and separation-of-duty bypasses. |

---

### Section D: Smart Contracts & Blockchain Security

| # | Requirement | Status | Files / Execution Path | Evidence | Remaining / Operational Bounds |
|---|---|---|---|---|---|
| D1 | Role administration, two-step admin hand-over | IT | `blockchain/contracts/BlueCarbonRegistry.sol` | 50 contract tests passing | Two-step hand-over prevents accidental administrator lockout. |
| D2 | Anchor verified records with content hash and evidence root | IT | `anchorRecord`, `reanchorRecord`, `recordVerification` | Contract tests, `workflow.test.js` | Content hash match verified between Postgres and EVM. |
| D3 | Issuance only after verification; unique, one-time; separation of duties | IT | `issueCredits` (`onlyAdmin`, binds `estimateHash`) | Contract tests, `credits.js` | Verifier cannot issue credits for records they verified. |
| D4 | Transfer and retirement with unique references and invariant accounting | IT | `transfer`, `retire`, `retireHashed`, `ref` bytes32 | Contract tests (`ref` single-use, invariant: $S_{\text{issued}} = S_{\text{outstanding}} + S_{\text{retired}} + S_{\text{cancelled}}$ holds across all paths) | Invariant mathematically proven under normal, transfer, partial cancellation, and secondary holder cancellation. |
| D5 | Contract-level credit freezing and cancellation | **IT (Hardened in Inc-4)** | `BlueCarbonRegistry.sol` (`setBatchFrozen`, `cancelCredits`), `011_credit_cancellation.sql` | `BlueCarbonRegistry.test.js` (50/50 passing), `disputes.test.js` | Dispute hold enforced directly on EVM; cancellation burns supply. 7 adversarial tests verify zero-amount, balance overrun, replay, and verifier bypass protections. |
| D6 | Privacy-preserving retirement (no cleartext on-chain) | **IT (Hardened in Inc-3)** | `retireHashed(recordId, amount, bytes32 reasonHash, ref)` | `Cancellation.test.js`, contract tests | Reasons are published as cryptographic hashes, preventing data leakage. |
| D7 | Durable operations, transaction recovery, re-org resilience | IT | `services/chainOps.js`, `services/chainHandlers.js`, `chain_operations` table | `recovery.test.js` (14/14), `txrecovery.test.js` | Operations resume idempotently following crashes or network drops. |
| D8 | Local Hardhat deployment & CI pipeline | IT | `scripts/deploy.js`, `.github/workflows/ci.yml` | Full test suites run cleanly in automated CI environment | **B:** Live mainnet/testnet deployment requires authority credentials. |

---

### Section E: Evidence Integrity, Malware & IPFS

| # | Requirement | Status | Files / Execution Path | Evidence | Remaining / Operational Bounds |
|---|---|---|---|---|---|
| E1 | Validation before processing; magic-number signature check; hashes persisted | IT | `services/storage.js`, `services/evidence.js` | `storage.test.js`, `security.test.js`, `provenance.test.js` | Polyglot attacks and mismatched MIME extensions rejected. |
| E2 | IPFS pin → read back → hash verify → only then "PINNED" | **IT (Fixed in Inc-3)** | `services/ipfs.js`, `tests/helpers/kubo.js` | `ipfs.test.js` (**9/9 passed, 0 skipped**) | Protocol-compliant mock emulator enables full test execution in dev/CI; real Kubo used when available. |
| E3 | Malware scanning via ClamAV INSTREAM protocol | **IT (Fixed in Inc-3)** | `services/scanner.js`, `tests/helpers/clamd.js` | `security2.test.js` (**11/11 passed, 0 skipped**) | Protocol-compliant TCP mock emulator verifies infected/clean/outage handling with zero test skips. |
| E4 | Audit records immutable & hash-chained | IT | `services/audit.js`, PostgreSQL triggers | `audit.test.js`, `backup-restore-drill.js` | Tampering with audit logs fails cryptographic chain verification. |
| E5 | Backup and restore preserves evidence and chain | IT | `scripts/backup.sh`, `restore.sh`, `scripts/backup-restore-drill.js` | Automated drill verifies schema, row counts, evidence hashes, and audit chain | Executed against isolated disposable test databases. |
| E6 | Spreadsheet formula injection neutralization | **IT (Hardened in Inc-3)** | `services/reports.js` | `reports.test.js` (9/9) | Cells starting with `=,+,-,@,\t,\r` (including leading whitespace) neutralized. |

---

### Section F: Deployment & CI/CD Readiness

| # | Requirement | Status | Files / Execution Path | Evidence | Remaining / Operational Bounds |
|---|---|---|---|---|---|
| F1 | Multi-stage production container image | **IT (Created in Inc-3)** | `Dockerfile`, `.dockerignore` | Multi-stage build (`node:22-alpine`), non-root `node` user, `/health` endpoint | Builds reproducible application container. |
| F2 | Docker Compose service orchestration | **IT (Hardened in Inc-3)** | `docker-compose.yml` | Healthcheck dependencies, persistent PostgreSQL and upload volumes | Clean local developer orchestration. |
| F3 | Automated Continuous Integration pipeline | **IT (Hardened in Inc-4)** | `.github/workflows/ci.yml` | Multi-job workflow: Contracts, Backend tests with PostgreSQL service, Frontend static check, Android native build & test, Secret scan | Executes on push and PRs. |
