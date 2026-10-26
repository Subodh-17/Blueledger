# SIH25038 implementation report (V3 frontend pass → release-candidate work, increment 1)

This report covers one increment. It does **not** claim SIH-readiness: the gaps below remain open. Scientific validation, public-chain deployment, SMTP delivery and a real-browser run were not possible here.

## Architecture (as audited)
Static frontend (`frontend/`, ES modules, no framework, PWA manifest and service worker) → Express API (`backend/src/routes/index.js`) → services (`projects`, `records`, `evidence`, `carbon`, `methodology`, `credits`, `chainOps`, `audit`, …) → PostgreSQL (8 migrations) and a Solidity registry contract (`BlueCarbonRegistry.sol`) on a local Hardhat chain. Evidence is stored locally with SHA-256, optionally pinned to IPFS (Kubo / Pinata), optionally scanned with ClamAV. Blockchain calls go through durable `chain_operations` with idempotency keys and a reconciler. Roles: `FIELD_USER`, `VERIFIER`, `NCCR_ADMIN`; organizations have a type (regulator, NGO, community, panchayat, verification body, credit holder).

## MRV lifecycle (as implemented)
Field record (draft) → submit (validated, report generated, hashes computed, anchored on-chain) → verifier starts review, reviews each evidence item, records a decision with comments (verified / rejected / needs revision; revision loops without overwriting history) → verifier calculates a period-based assessment under a versioned methodology (central, conservative and eligible quantities kept distinct; blockers recorded) → a different, NCCR administrator approves → administrator issues credits on-chain (one issuance per record) → transfer / retirement with unique references. Methodology `IPCC-WS2013-T1-v1` is **pending independent review** and needs accepted baseline, additionality, leakage and non-permanence determinations before anything is issuable. `ILLUSTRATIVE-BC-v1` uses unvalidated placeholder parameters and is allowed only on illustrative projects.

## Changes in this increment
| File | Change |
|---|---|
| `frontend/js/pages/credits.js` | Carbon assessment screen rewritten to the V3 data: central and conservative quantities, per-assessment issuance blockers, parameters used with units, status and source, methodology review state, required determinations, references, hashes. Removes the crash that took down `#/assessments` for every role. |
| `backend/src/services/reports.js` (new), `backend/src/routes/index.js` | `GET /api/reports/registry?groupBy=project|ecosystem|region|period|status&from&to&ecosystem&region&status&origin&format=json|csv`. |
| `backend/tests/reports.test.js` (new), `backend/tests/ui.test.js` | 7 reporting tests; UI test fixed and one test added. |
| `scripts/backup-restore-drill.js` | Chain verification path fixed; clearer evidence check. |
| `backend/package.json`, `package-lock.json` | `nodemailer` ^6 → ^10.2.1 (the code only uses `createTransport(url)` and `sendMail({from,to,subject,text})`); `body-parser` updated within semver by `npm audit fix`. |

### Reporting endpoint contract
Any signed-in role may call it; field users see only their own organization (enforced in SQL, not the UI). Drafts are never counted. Each row separates: reported and verified records and area; estimated central and conservative tCO₂e (from each record's current assessment); `eligible_approved_tonnes` (approved by NCCR, **not** issued); `issued_tonnes`, `retired_tonnes`, `outstanding_tonnes` from the credit ledger. Rows are always split by `data_origin`, so illustrative data is never added to user-entered data. Grouping keys are whitelisted; filters are validated (400 on bad input). CSV export is `no-store`, carries provenance notes, and prefixes cells beginning with `= + - @` to prevent spreadsheet formula injection.
Limitation: the estimate column sums each record's current assessment regardless of approval state, so it is a pipeline total, not an achievement.

## Findings that need your decision
1. **No reversal, cancellation or dispute for issued credits** (database or contract). *Proposed change, not made:* add an administrator-only `cancelCredits(recordId, amount, ref, reasonHash)` to the contract (reducing the batch balance and `outstanding`, emitting an event, reusing the single-use `ref`), a `credit_reversals` table, and a backend operation that goes through `chain_operations`. Existing function signatures and events stay unchanged, so the backend and tests remain compatible; the contract would need redeployment and new tests (access control, replay, accounting invariant `issued = outstanding + retired + cancelled`).
2. **Retirement reasons are free text emitted publicly on-chain** (`CreditsRetired`). Personal data could be published. Options: store only a hash of the reason on-chain, or constrain it. Changing the signature breaks the current ABI.
3. **No structured planting species.** Counts exist only as the `seedlings_planted` measurement.
4. **Drone / geospatial ingestion contract** is missing (only photos with a platform label). No live drone feed exists or is claimed.
5. **Onboarding** has no organization application / approval flow and no project membership model.
6. **Android app** is not in this workspace.

## Remaining work, in order
1. Reporting screen (Administration page, to avoid changing the sidebar that `ui.test.js` asserts) with CSV download.
2. Drone-derived evidence import contract (GeoJSON of processed observations: geometry validity, containment in the project boundary, CRS, capture time, tool and version, hash), with clearly labelled sample files.
3. Structured species and per-species counts.
4. Approve and implement the contract-level cancellation and the retirement-reason change.
5. Organization application / approval and project membership.
6. Playwright end-to-end journey on real Chromium, plus mobile viewport and accessibility checks; CI that runs the commands in the test report; application Dockerfile.
7. Run the skipped Kubo and ClamAV tests; static analysis and independent review of the contract.
8. Independent scientific review of the methodology; only then consider enabling production issuance.
