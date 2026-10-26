# SIH25038 Increment 3 — Execution Plan
## Complete Defect Remediation, MRV Integrity, Blockchain Security, Geospatial Verification, Android Integration, CI/CD and Release Readiness

**Project:** Blockchain-Based Blue Carbon Registry and MRV System  
**SIH Problem Statement:** SIH25038  
**Baseline:** Increment 2 (V3)  
**Date:** 2026-10-26  
**Environment:** Windows Local Workspace (`E:\Projects\blue-carbon-registry-mrv-v3-wip`)  

---

### 1. Executive Summary & Objectives
Increment 3 is dedicated to closing all unresolved architectural and operational gaps from Increment 2, hardening the codebase against real-world vulnerabilities and failures, establishing rigorous scientific validation boundaries, implementing smart-contract level credit lifecycle controls, providing CI/CD and Dockerization, and delivering comprehensive regression test verification.

---

### 2. Baseline Status & Initial Discovery

- **Project Root:** `E:\Projects\blue-carbon-registry-mrv-v3-wip`
- **Git Repository Status:** Not initialized as a Git repository (`fatal: not a git repository`). No live Git branches or remote commit history present. Work is performed strictly in-place with zero data loss.
- **Node & NPM:** Node.js v22.18.0, npm 10.9.3.
- **PostgreSQL Database:** PostgreSQL 18 running locally on port 5432. Dedicated test database `blue_carbon_mrv_test` available for test suites.
- **Baseline Test Results:**
  - `check-frontend.js`: PASSED (23 files, 19 modules, clean contrast & wording audit).
  - Hardhat Contract Tests: PASSED (37 tests: 26 original `BlueCarbonRegistry` + 11 proposed `Cancellation`).
  - Backend Tests: Failed initially due to missing environment loading and Windows child process spawning (`spawn npx ENOENT` on Windows in `backend/tests/run.js`).
  - Mobile / Android Source: Zero Android/Java/Kotlin source files found in the workspace (only PWA assets: `manifest.webmanifest`, `sw.js`).
  - Docker: Docker CLI installed, daemon not active locally. `docker-compose.yml` only specifies development PostgreSQL. Application Dockerfile missing.
  - CI/CD: No GitHub Actions or automated CI pipelines in place.
  - Blockchain dev toolchain: 44 vulnerabilities in Hardhat toolchain (19 low, 10 moderate, 15 high).

---

### 3. Work Breakdown Structure & Phases

#### Phase 1: Baseline Establishment, Defect Register & Execution Planning
- Complete repo audit, file verification, baseline logging.
- Initialize `docs/SIH25038_INCREMENT_3_PLAN.md` and `docs/SIH25038_INCREMENT_3_DEFECT_REGISTER.md`.
- Ensure strict database volume and credential safety.

#### Phase 2: Complete Defect Discovery & Remediation
- Fix Windows/cross-platform process spawning in test runners and scripts (`spawn npx ENOENT`).
- Fix `.env` loading in `backend/tests/run.js` and test helpers.
- Run complete backend test suite and catalog all failures.

#### Phase 3: Scientifically Defensible MRV
- Audit all carbon equations, IPCC Tier 1 coefficients, conversion factors in `backend/src/methodology/definitions.js` and `services/carbon.js`.
- Separate observed, estimated, verified, eligible, issued, transferred, retired quantities.
- Implement versioned methodology governance and independent review gating.
- Author `docs/SIH25038_MRV_SCIENTIFIC_VALIDATION.md` detailing all implemented formulas, parameter provenance, uncertainty bounds, and domain-expert review requirements.

#### Phase 4: Blockchain Security and Credit Lifecycle
- Resolve the dispute-bypass vulnerability: promote and integrate contract-level credit cancellation and freezing (`BlueCarbonRegistryCancellation.sol` -> contract hardening or active integration).
- Implement backend durable transaction tracking for credit cancellation and freezing with idempotency keys.
- Audit Hardhat dependencies and minimize security advisories without breaking solc Paris EVM target.
- Document redeployment and state migration implications.

#### Phase 5: Evidence Integrity, IPFS & Geospatial Validation
- Harden the evidence processing pipeline (file size, mime types, magic bytes, hash verification).
- Enhance GeoJSON validation (CRS, coordinate range, boundary containment, tolerance checks).
- Provide reproducible mock/offline pipelines for ClamAV and IPFS to achieve 100% test coverage without skipping when external daemons are unavailable.
- Create drone/remote sensing evidence ingestion interfaces and test fixtures.

#### Phase 6: Android Field-Application Integration
- Document absence of native Android source in workspace.
- Formulate complete Mobile Integration Specification (`docs/SIH25038_ANDROID_INTEGRATION_GUIDE.md`): REST API contracts, offline SQLite sync, auth token refresh, multipart evidence upload, and test harness.

#### Phase 7: CI/CD and Reproducible Testing
- Implement complete GitHub Actions workflow (`.github/workflows/ci.yml`) covering linting, frontend check, backend tests, contract tests, security audit, and secret scanning.

#### Phase 8: Application Dockerfile and Runtime Reliability
- Create multi-stage production Dockerfile (`Dockerfile`) for the backend and frontend.
- Update `docker-compose.yml` to support full-stack local deployment with database, backend, and health checks.

#### Phase 9: Frontend, Backend and API Regressions
- Trace end-to-end user journeys (Field User, Verifier, Admin).
- Neutralize CSV injection formulas, verify error handling and state persistence.

#### Phase 10: Security, Backup and Data Integrity
- Test backup and restore drills verifying relational invariants and SHA-256 evidence hashes.
- Enforce separation of duties and rate-limiting.

#### Phase 11: Full Regression Matrix
- Execute all tests across contracts, backend, frontend, backup/restore drills, and CI validation.

#### Phase 12: Documentation & Final Release Review
- Update `docs/SIH25038_REQUIREMENTS_TRACEABILITY.md`, `docs/SIH25038_IMPLEMENTATION_REPORT.md`, `docs/SIH25038_TEST_REPORT.md`, `docs/SIH25038_INCREMENT_3_REPORT.md`, and `docs/SIH25038_INCREMENT_3_FINAL_AUDIT.md`.
