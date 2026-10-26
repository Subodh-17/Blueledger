# V3 — interim snapshot (work in progress)

This archive is a **snapshot of V3 work in progress**, not the finished release. Statements below reflect what was actually run.

## Completed and tested (backend, database, contract)
| Area | What exists | Tests actually run |
|---|---|---|
| Carbon methodology | Versioned methodology registry (`backend/src/methodology/definitions.js`) with IPCC 2013 Wetlands Supplement Ch. 4 Tier 1 parameters transcribed from the printed tables (table, page, units, pool, region, n, 95% CI, range, limitations); VM0033 / AFOLU Non-Permanence Risk Tool referenced as required determinations (buffer, baseline, additionality, leakage are never defaulted); independent-review records bound to a parameter hash; period-based assessments with a database no-overlap constraint; pool caps; central / lower-bound / eligible quantities kept distinct; issuance blocked unless the methodology is reviewed and determinations are accepted | `carbon.test.js` (11, expected values derived independently), `methodology.test.js` (9) |
| Blockchain recovery | Contract: unique on-chain reference for every transfer/retirement, two-step administrator hand-over, role revocation tests. Backend: stored operations, balance reservations, receipt depth + canonical-block checks, dropped/reorganised transaction handling, per-operation event history, consistency checker | Contract: 26 tests. `recovery.test.js` (14): crash injected at before-submit, after-submit-before-hash, after-hash, after-confirmation, before-database-transition, during reconciliation, concurrent transfers/retirements, reorganisation, permanent revert, direct-contract divergence |
| Security | Password reset (hashed single-use expiring tokens, no account enumeration), token revocation, real ClamAV integration (clamd INSTREAM), encryption at rest with key rotation, per-organisation quotas, malformed-file handling | `security2.test.js` (11, including a real clamd daemon) |
| IPFS | Pin → read back by CID → hash-verify → only then "pinned"; bounded exponential backoff; outage and recovery; mismatch detection | `ipfs.test.js` (9) against a **real Kubo 0.30 node** |
| Evidence provenance | Embedded vs declared metadata kept separate and compared; immutable provenance fields (database triggers); append-only review history tied to file hashes; replacement lineage; CRS and date validation | `provenance.test.js` (6) |
| Platform | Notifications created inside the transactions of the events they describe; audited runtime settings; on-chain role administration API; idempotent client references for offline sync (server side); structured redacted logging; Prometheus metrics; persistent-failure alerts | `platform.test.js` (10) |
| Operations scripts | `scripts/backup.sh`, `restore.sh`, `backup-restore-drill.js` | Drill run once: 7 of 8 checks passed; the audit-chain verification check **failed** (cause not yet diagnosed — may be a defect in the drill script itself) |

Backend test files run in two batches after these changes: 56 + 65 = 121 tests passing (all backend files except `ui.test.js`, which was not re-run). Existing V2 tests were kept.

## NOT done yet
* **Frontend is still the V2 interface.** None of the V3 features have screens yet (methodology review and determinations, password reset pages, notifications panel, runtime configuration, on-chain role administration, offline queue, evidence scan/IPFS/provenance views, assessment screens for the new methodology). `backend/tests/ui.test.js` has not been updated or re-run and is expected to need changes.
* **No real-browser test suite yet.** A real Chromium was confirmed to launch in this environment (npm-packaged build) but no Playwright tests, screenshots or viewport checks have been written or run.
* Offline queue in the browser (server side idempotency exists, client does not).
* Load tests, query-plan (EXPLAIN) review at scale, and documentation updates for V3 (README/docs still describe V2 and do not mention the new features).
* The "dummy data" term has not yet been added to the wording audit.
* No external review of the methodology; the IPCC parameters are cited and transcribed but the methodology remains **pending independent review** (nothing is approved for operational use).
* Not verified: SMTP delivery (only the development outbox transport was exercised), public-network deployment, Pinata.

## Running what exists
`npm run setup`, then see the V2 README for launch steps. Backend tests: `DB_PASSWORD=… node backend/tests/run.js [files]` (starts its own local chain; resets the database named by `TEST_DB_NAME`). The ClamAV and Kubo tests need `clamd` and a Kubo binary (`KUBO_BIN`) and skip otherwise.

## Update: frontend pass (written in an environment without PostgreSQL, Hardhat/solc, a browser, or network access)
**What changed.** New screens for the V3 endpoints that had none: methodology review, project determinations, runtime settings, on-chain roles, notifications (account menu and bell badge), and password recovery (`#/forgot`, `#/reset?token=`). Files: `frontend/js/pages/governance.js` (new), plus edits to `app.js`, `pages/admin.js`, `pages/projects.js`, `util.js`, `api.js` (adds `delete`), `css/app.css`. The sidebar was deliberately left unchanged because `ui.test.js` asserts the exact link list. `backend/tests/ui.test.js` gained page-render checks for the new screens. `scripts/backup-restore-drill.js` now verifies the audit chain in the live database before the backup and prints the real error text of the chain check.

**What was actually run:** `node scripts/check-frontend.js` — passed (20 files, 16 modules, wording audit, contrast audit for 23 pairs). `node --check` on every changed JavaScript file.

**What could NOT be run here:** the backend suite (needs PostgreSQL and installed dependencies; `npm install` failed with ENOTFOUND), the contract suite (Hardhat not installable), `ui.test.js`, the backup drill, and any real-browser check. None of the new screens has been loaded in a browser. The backend and contract code were not modified, so the 121 passing backend tests and 26 contract tests recorded above are unaffected in principle, but they were not re-run.

**Backup drill failure — diagnosis status.** Not diagnosed. Reading the code shows the old drill discarded the child process's error output and never verified the live chain, so the failure could not be attributed. The drill now does both. Run it again: if the live-database check also fails, the defect is in how entries are hashed or stored (not in backup/restore); if only the restored copy fails, look at the restore path.

**Still open:** everything under "NOT done yet" above except the screens listed here; also the evidence scan / IPFS / provenance views and an issuance-blockers view on the assessment screen.

## Update: verification run (disposable PostgreSQL 16, local Hardhat)
The suites listed above as not runnable were run. The frontend pass had a real defect (the assessment page), now fixed. Results, commands and what is still unverified are in `docs/SIH25038_TEST_REPORT.md`; requirement status is in `docs/SIH25038_REQUIREMENTS_TRACEABILITY.md`. Still not run: real-browser tests, Kubo and ClamAV tests, SMTP, Android, public-network deployment.

## Update: increment 2
Reporting UI, GeoJSON and species ingestion, disputes, a cancellation proposal, an end-to-end journey and a real-browser suite were added; see `docs/SIH25038_INCREMENT_2_REPORT.md`. Still open: scientific validation, on-chain cancellation (proposal only), Android app, Kubo / ClamAV / SMTP / public-network runs, CI.
