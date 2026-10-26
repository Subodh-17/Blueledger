# SIH25038 increment 2 — test report

Environment: sandbox container; Node 22.22.2; PostgreSQL 16.15 (disposable cluster in `/tmp`, trust auth, port 55432); local Hardhat node; Chromium 141.0.7390.37 with Playwright 1.56.0 (`/opt/pw-browsers`); axe-core 4.14.0 (installed outside the repository for the run).
**Not available here:** Docker, Kubo (IPFS), ClamAV, SMTP, Pinata, Android toolchain, a public blockchain, a real phone, Slither or any contract static analyser. All destructive tests ran on disposable databases (`blue_carbon_mrv_test`, `blue_carbon_mrv_e2e`, `bcmrv_drill_src`). The workspace is not a Git repository.
Everything below was run in this session; nothing is reported that was not run.

## Results
| Check | Command | Result |
|---|---|---|
| Frontend static check (syntax of 19 modules, imports, assets, no external origins or inline styles, wording audit, contrast audit of 23 colour pairs) | `node scripts/check-frontend.js` | passed (23 files). The project has no bundling step, so there is no separate production build; this check is the build gate. |
| Backend, all files | `DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=postgres DB_PASSWORD=… TEST_DB_NAME=blue_carbon_mrv_test node tests/run.js` (from `backend/`) | exit 0; **194 tests: 188 pass, 0 fail, 6 skipped** (start of increment: 137 / 131 / 0 / 6) |
| Contracts | `cd blockchain && npx hardhat test` | **37 passing, 0 failing** (26 original + 11 for the proposed cancellation contract) |
| Real-browser end to end | `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers E2E_AXE_DIR=… DB_PASSWORD=… node e2e/run.js` | exit 0; **58 of 58 checks**, repeated three times in a row with the same result |
| Backup and restore drill with the new tables (seeded database plus a species list on a submitted record and a dispute with history) | `node scripts/backup-restore-drill.js` | `DRILL PASSED (9 checks)`: audit chain verifies live and restored (94 entries), rows equal in all 29 tables, 18 evidence files match their hashes, 10 migrations preserved, corrupted backup refused |
| Dependency audit, backend (production) | `cd backend && npm audit --omit=dev` | 0 vulnerabilities (no dependency was added in this increment) |
| Dependency audit, blockchain | `cd blockchain && npm audit` | 44 vulnerabilities (19 low, 10 moderate, 15 high), all in the Hardhat / solc development toolchain; the package has no runtime dependencies and the backend does not use it. **Not fixed.** The increment-1 report said "3 high-severity advisories"; that undercounted. |
| Secret scan | pattern search for key, secret and password assignments of 16+ characters and 32-byte hex strings, values never printed | Matches only the documented development placeholder in `backend/.env.example` and fixed test constants labelled "not-for-production" in the test harnesses. No private key, token or `.env` file in the tree. A pattern search, not a dedicated scanner. |
| Production contract unchanged | `sha256sum blockchain/contracts/BlueCarbonRegistry.sol` | `629fd89b19bf3dec…`, identical before and after the increment |

New or extended test files (run individually): `geo.test.js` 12 · `geospatial.test.js` 14 · `disputes.test.js` 7 · `journey.test.js` 7 · `txrecovery.test.js` 3 · `reports.test.js` 9 (was 7) · `ui.test.js` 21 (was 9) · `test/proposals/Cancellation.test.js` 11.

## Skipped (6), unverified in this environment
4 in `ipfs.test.js` (a real Kubo node: pin, read-back, encryption, outage and recovery, bounded retries) and 2 in `security2.test.js` (a real ClamAV daemon; scanner-unavailable policy) — no Kubo binary, no `clamd`.

## What the end-to-end journey covers (`backend/tests/journey.test.js`, seven ordered steps, real API, PostgreSQL, evidence files and local chain)
1. **Onboarding.** Only an administrator creates organizations and projects; a self-registered collector is refused everything until attached; self-promotion, self-attachment and a verifier assigning roles are refused; the steps are audited.
2. **Field submission.** Invalid coordinates and dates, wrong or mismatching file types, another organization's collector, duplicate files and duplicate submission are refused without leaving rows or files; a repeated client reference returns the same record; valid evidence keeps its SHA-256; a GeoJSON outside the boundary, with invalid coordinates or malformed is refused, a valid one imported; the record is anchored and the **on-chain hash equals the stored hash and covers the evidence root**.
3. **Review.** The collector cannot start review; verification is blocked while evidence is unreviewed; a collector promoted to verifier cannot decide their own submission; a reason is mandatory; the estimate is versioned and hashed, brackets central by low and high bounds, discloses every parameter with its review status and labels placeholders unvalidated; an estimate creates no credits.
4. **Refusals.** A rejected record cannot be estimated; a record claiming more area than its project cannot be verified (blocking check); a record dated inside an already-assessed period gets no assessment, and the database itself refuses an overlapping insert.
5. **Issuance.** Not issuable before approval; verifier, collector and other organizations cannot approve or issue; with the issuing request killed after its transaction was submitted, no credit is shown while the outcome is unconfirmed, reconciliation then completes it **exactly once with the real transaction hash and block (checked against the contract's own event)**, a second reconciliation changes nothing, and a repeated issue request is refused.
6. **Lifecycle and audit.** An idempotency key is required; a retry transfers once; a dispute pauses transfers; withdrawal releases them; retirement works; the audit trail names the actor of each step; the audit hash chain verifies; another organization cannot read the record.
7. **NCCR reporting.** Estimated, approved-eligible, issued, transferred, retired and outstanding quantities equal the ledger; illustrative data stays separate; exports need a session, are scoped, and neutralise a spreadsheet formula.

## Defects found by this increment's testing, and fixed
| Defect | Found by | Fix and regression test |
|---|---|---|
| A recovered issuance, anchoring, verification or project registration was completed **with no transaction hash or block** (the recovery probes returned `tx: null`), so the credit and the chain-transaction log lacked the transaction | the journey's crash-after-submit scenario | Probes now recover the transaction from the contract's own events (`chain.findEvents`, `txOf`). `journey.test.js` step 5 and `txrecovery.test.js` (3 tests); reverting the fix makes them fail. |
| The front-end router let a slower earlier page overwrite the page the user had just opened, and register its handlers | the real-browser run | Navigation sequencing in `frontend/js/app.js`; `ui.test.js` "navigation: a slow page…"; reverting the guard makes it fail. |
| Bell button's accessible name omitted its visible count (WCAG 2.5.3) | axe, all 18 scanned pages | label now includes the count |
| Overview map was `role="img"` but contained project links (WCAG nested-interactive) | axe | `role="group"` when markers are links |
| In-page "Try again" on the reports page did nothing | jsdom UI test | page registers its own retry handler |
| Several of my own test expectations were wrong, not the product: record area is enforced at review (a blocking check), not at creation; `submit` correctly returns 200 when anchoring fails; an injected crash fired in the lazy project registration instead of the anchoring step | the tests themselves | expectations corrected; two assertions that could not fail (a no-op expression and one followed by `.catch`) were replaced with real ones |
Mutation checks (temporarily breaking the code under test and confirming tests fail, then restoring it) were done for: the GeoJSON boundary check, the dispute hold, the replay protection of `cancelCredits`, and the three recovery probes.

## Not run
Android / Java build (no source in the workspace) · SMTP and Pinata · Kubo and ClamAV (skipped above) · public-network deployment · static analysis or formal verification of any contract · load and soak tests · real mobile devices (390 × 844 Chromium with touch emulation was used; layout was checked by measuring horizontal overflow and by viewing a screenshot of one page, not by exhaustive visual review) · screen-reader testing (axe finds roughly a third of accessibility problems; keyboard order and dialog focus were checked by hand-written assertions on the import form and the dispute dialog only).

## Reproduce
```
npm run setup
# disposable PostgreSQL; never point these at a database you care about (they are RESET)
DB_HOST=… DB_PORT=… DB_USER=… DB_PASSWORD=… TEST_DB_NAME=blue_carbon_mrv_test npm --prefix backend test      # journey, geospatial, disputes, reports, recovery, UI (jsdom)
npm run frontend:check && npm run test:contracts
# browser run: needs Playwright with Chromium (PLAYWRIGHT_BROWSERS_PATH if not default); axe-core optional (E2E_AXE_DIR)
DB_HOST=… DB_PASSWORD=… E2E_DB_NAME=blue_carbon_mrv_e2e npm run test:e2e     # refuses a database name without "test" or "e2e"
```
