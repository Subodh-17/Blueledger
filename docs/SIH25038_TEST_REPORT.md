# SIH25038 test report

Environment: sandbox container, Node 22.22.2, npm 10.9.7, PostgreSQL 16.15 (disposable cluster in `/tmp`, port 55432, trust auth), Hardhat local node. **No Docker, Kubo, ClamAV, SMTP, browser, Android toolchain or public network.** All destructive tests ran against disposable databases (`blue_carbon_mrv_test`, `bcmrv_drill_src`); the backend test runner resets the database named by `TEST_DB_NAME`.
Everything below was actually run in this session. Anything not listed was not run.

## Results
| Check | Command | Result |
|---|---|---|
| Frontend static check | `node scripts/check-frontend.js` | Passed: 20 files, 16 modules, wording audit, contrast audit (23 pairs). Run before and after the frontend change. |
| Contract tests | `cd blockchain && npx hardhat test` | 26 passing, 0 failing (summary line; the shell exit code was not captured separately). Not re-run after this pass because no contract file changed. |
| Backend suite, **baseline** (V3 snapshot as received) | `DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=postgres DB_PASSWORD=… TEST_DB_NAME=blue_carbon_mrv_test node tests/run.js` | exit 1; 129 tests: **119 pass, 4 fail, 6 skipped** |
| Backend suite, **after this pass** | same command | exit 0; 137 tests: **131 pass, 0 fail, 6 skipped** |
| Backend suite after dependency upgrade (`nodemailer` 10.2.1, `body-parser` 1.20.9) | same command | exit 0; 137 tests: 131 pass, 0 fail, 6 skipped |
| UI tests alone | `node tests/run.js tests/ui.test.js` | 9 of 9 pass (was 5 of 8 passing before the fix, with the assessment page crashing) |
| Reporting tests alone | `node tests/run.js tests/reports.test.js` | 7 of 7 pass |
| Backup / restore drill | `DB_NAME=bcmrv_drill_src UPLOAD_DIR=/tmp/drill-uploads node scripts/backup-restore-drill.js` | `DRILL PASSED (9 checks)`: live and restored audit chains verify (94 entries), 25 tables equal, 18 evidence files match hashes, corrupted backup refused |
| Dependency audit, backend production deps | `cd backend && npm audit --omit=dev` | Before: 2 high (`nodemailer`, `body-parser`). After upgrade: 0 vulnerabilities. |
| Dependency audit, blockchain | `cd blockchain && npm audit` | 3 high-severity advisories in the Hardhat toolchain (dev tooling, not deployed); **not resolved**. |
| Secret scan | `grep -rIlE` for key/secret/password assignments and 32-byte hex strings, values never printed | Two matches: the documented development `REFERENCE_PASSWORD` in `.env.example` and the fixed test password in `tests/helpers.js`. No private keys or tokens found. This is a pattern search, not a dedicated scanner. |

## Skipped (6) — unverified in this environment
| Tests | Reason |
|---|---|
| 4 in `ipfs.test.js` (real Kubo pin, read-back, encryption, outage and recovery; bounded retries) | No Kubo binary |
| 2 in `security2.test.js` (real ClamAV clean / infected; scanner unavailable policy) | No `clamd` |

## Failures found and fixed in this pass
| Failure | Cause | Fix |
|---|---|---|
| 3 UI tests: `#/assessments: … Cannot read properties of undefined (reading 'map')` | The assessment page rendered the V2 methodology shape; the server returns the V3 shape | Page rewritten to render from the server's methodology and stored calculation |
| UI test "approve an assessment and issue credits" | Seed now also holds a correctly blocked IPCC assessment that sorts first; the test clicked it | Test selects an unblocked row; a new test covers the blocked row |
| Backup drill "audit chain failed" | The drill's child process could not resolve `./src/services/audit` (relative `require` under `node -e`) | Absolute paths; the evidence check now reports missing files separately from hash mismatches |

## Negative cases covered by tests that ran
Unauthorized approvals and issuance (verifier, field user, anonymous) · verifier cannot approve credits for a record they verified · verification blocked with unreviewed evidence · rejection without reason · duplicate issuance · overlapping assessment periods via direct database insert · forged audit entry detected · crash injection at each blockchain step, reorganisation, permanent revert, contract divergence · duplicate offline-sync reference · invalid and injection-style report parameters · cross-organization report access · spreadsheet-formula cell in CSV export · approval of a blocked assessment refused with the server's reason and no credits created.

## Not run
Real-browser end-to-end tests and screenshots · responsive-layout checks (jsdom does not lay out pages) · Android / Java build (no Android source in the workspace) · SMTP delivery · Pinata · public-network deployment · load tests · static analysis of the contract · test-run of the new reporting endpoint from the browser (no screen exists yet).

## Reproduce
```
npm run setup
# start a disposable PostgreSQL; never point TEST_DB_NAME at a database you care about
DB_HOST=… DB_PORT=… DB_USER=… DB_PASSWORD=… TEST_DB_NAME=blue_carbon_mrv_test npm --prefix backend test
npm run frontend:check
npm run test:contracts
```
