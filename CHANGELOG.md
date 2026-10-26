# Changelog

## Unreleased — increment 2
- Added the registry reporting page (`#/reports`) and extended `GET /api/reports/registry` (transferred quantity, project filter, database-computed totals, 500-group cap).
- Added GeoJSON ingestion (validator, dry run, import as `GEOSPATIAL` evidence with a frozen validation record and same-transaction supersede) and structured planting by species (snapshot in the content hash only when present). Migration 009.
- Added disputes on credit batches with a registry hold on transfer and retirement and an append-only history (does not change the on-chain token). Migration 010.
- Proposed (not adopted, not wired in) a cancellation contract with tests: `docs/SIH25038_CREDIT_CANCELLATION_PROPOSAL.md`. `BlueCarbonRegistry.sol` is unchanged.
- Fixed: recovered chain operations (anchoring, verification, issuance, project registration) completed without a transaction hash; the router let a slower page overwrite the current one; two accessibility defects (bell label, map role); the reports page retry.
- Tests: backend 194 (188 pass, 6 skipped for missing Kubo and ClamAV), contracts 37, real-browser run 58 of 58 (`npm run test:e2e`). See `docs/SIH25038_INCREMENT_2_TEST_REPORT.md`.

## Unreleased — verification and first fixes after the frontend pass
- Ran the previously unrun suites on disposable services: baseline 129 tests, 119 pass, 4 fail, 6 skipped; now 137 tests, 131 pass, 0 fail, 6 skipped (Kubo and ClamAV tests need those services). Contract suite: 26 passing.
- Fixed: `#/assessments` crashed for every role (page rendered the V2 methodology shape). Rewritten to show central and conservative quantities, issuance blockers, parameters with sources, methodology review state and required determinations.
- Added `GET /api/reports/registry` (group by project, ecosystem, region, month or record status; JSON or CSV) with `reports.test.js`. Estimated, approved-eligible and issued quantities are separate; illustrative data is never summed with user-entered data.
- Fixed `scripts/backup-restore-drill.js` (audit-chain check could not load its modules) and made missing evidence files distinct from hash mismatches.
- Dependencies: `nodemailer` ^6.10.1 → ^10.2.1 and `body-parser` updated; backend production audit now reports 0 vulnerabilities.
- Documentation: `docs/SIH25038_REQUIREMENTS_TRACEABILITY.md`, `SIH25038_IMPLEMENTATION_REPORT.md`, `SIH25038_TEST_REPORT.md`.

## Unreleased — frontend pass on the V3 snapshot
- Added screens for existing V3 endpoints: methodology review, project determinations, runtime settings, on-chain roles, notifications, password recovery.
- Bell badge now includes unread notifications; account menu links to Notifications.
- API client gained `delete`.
- Backup-restore drill verifies the live audit chain first and reports the real error of the chain check.
- `ui.test.js` page lists extended for the new screens.
- Documentation: README migration list corrected (001–008) and a section describing the new screens; `V3-PROGRESS.md` updated with what was and was not run.

Verification status of this entry: when written, only the frontend check had been run; the suites were run afterwards (see the entry above).
