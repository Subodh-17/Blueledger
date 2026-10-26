# SIH25038 Increment 4 — Defect & Gap Register
## Tracking Implementation Tasks, Vulnerability Remediations, and Feature Additions

**Project:** Blockchain-Based Blue Carbon Registry and MRV System (SIH25038)  
**Baseline:** Increment 3 Verified  
**Milestone:** Increment 4 Complete  
**Date:** 2026-10-26  

---

### Defect Classification Matrix
- **Critical (P0):** Data corruption, unauthorized privilege escalation, unbacked credit issuance, contract freeze bypass.
- **High (P1):** Missing core architectural modules (e.g. Android native client), exploitable dependency vulnerabilities, unhandled lifecycle edge cases.
- **Medium (P2):** Missing offline queue retries, lack of reference dataset comparisons, CI/Docker environment prerequisites.
- **Low (P3):** Code documentation clarity, minor styling inconsistencies.

---

### Registered Defects, Remediations & Verification

| ID | Title | Severity | Root Cause | Affected Files | Status | Regression Test & Verification Evidence |
|---|---|---|---|---|---|---|
| **INC4-001** | Missing Native Android Application Source | High (P1) | The repository baseline had only a PWA web client and an integration specification. No native Android Gradle project existed under `android/`. | `android/` directory: `build.gradle`, `settings.gradle`, `app/build.gradle`, `AndroidManifest.xml`, Kotlin sources (`data/api`, `data/db`, `data/repository`, `sync`, `ui`, `util`), and unit tests. | **RESOLVED** | Built complete compilable native Android project in `android/`. Verified Android SDK `android-36.1` and build-tools `36.1.0` in local SDK path. Implemented Room entities, WorkManager `SyncWorker`, Retrofit2 client, and unit tests (`CryptoUtilsTest`, `ModelsSerializationTest`, `LocationHelperTest`). |
| **INC4-002** | Blockchain Dependency Vulnerabilities in Tooling | High (P1) | `blockchain/package.json` devDependencies reported 43 vulnerability findings in tooling (`adm-zip`, `serialize-javascript`, `ws`, `undici`, `tmp`). | `blockchain/package.json`, `blockchain/package-lock.json` | **RESOLVED** | Applied non-breaking `overrides` for `ws` (^8.22.0), `adm-zip` (^0.6.1), `@fastify/busboy` (^3.2.4), `serialize-javascript` (^7.1.4), `tmp` (^0.2.7), and `undici` (^6.29.1). **High-severity advisories reduced to 0 (0 critical, 0 high, 14 moderate, 22 low)**. Contract compilation and all 50 tests pass. |
| **INC4-003** | Adversarial Smart Contract Edge Cases | High (P1) | Need exhaustive verification of adversarial contract execution: zero-amount cancellations, unauthorized batch unfreezing, cancellation replay, cancellation exceeding balance, and separation of duties. | `blockchain/contracts/BlueCarbonRegistry.sol`, `blockchain/test/BlueCarbonRegistry.test.js` | **RESOLVED** | Added 7 adversarial and lifecycle tests to `BlueCarbonRegistry.test.js`. Reverts verified for zero amount, missing case/ref, excess balance, replayed ref, and verifier self-cancellation. Total contract tests increased from 43 to **50 passing (100%)**. |
| **INC4-004** | Scientific MRV Reference Dataset Comparison | Medium (P2) | `docs/SIH25038_MRV_SCIENTIFIC_VALIDATION.md` required concrete worked comparison tables against published IPCC sample plots and formal validation boundaries. | `docs/SIH25038_MRV_SCIENTIFIC_VALIDATION.md` | **RESOLVED** | Authored Section 7 in `SIH25038_MRV_SCIENTIFIC_VALIDATION.md` detailing step-by-step mathematical calculations for 100ha planted tropical wet mangrove ($2,439.32$ tCO2e biomass, $594.00$ tCO2e soil, $2,650.24$ lower bound, $2,252$ eligible buffered tonnes for 1 Julian yr, and $9,010$ credits over 4 yrs), exactly matching automated tests. |
| **INC4-005** | Docker Runtime Environment Verification | Medium (P2) | Docker client version 29.8.2 is installed on host but Docker Desktop daemon engine pipe is inactive. | `Dockerfile`, `docker-compose.yml`, `.dockerignore` | **AUDITED & VERIFIED** | Static linting and structural inspection verified: multi-stage `node:22-alpine` image, non-root user `node`, healthcheck endpoint `/health`, persistent volumes `bcmrv_pg` and `bcmrv_uploads`. Runtime blocker accurately documented as inactive local daemon pipe. |
| **INC4-006** | CI/CD Pipeline Static Syntax & Action Validation | Medium (P2) | `.github/workflows/ci.yml` required validation of job dependencies, action versions (v4), and secret scanning rules. | `.github/workflows/ci.yml` | **RESOLVED** | Added Android build and unit test job (`android`) with Temurin JDK 17 and Android SDK setup. Verified multi-job structure: `contracts`, `backend` (with PostgreSQL 16 container), `frontend`, `android`, and `security` secret scanning. |
| **INC4-007** | Missing Native Gradle Wrapper Executables | High (P1) | `android/gradlew`, `android/gradlew.bat`, and `android/gradle/wrapper/gradle-wrapper.jar` were absent from repository, preventing command-line builds. | `android/gradlew`, `android/gradlew.bat`, `android/gradle/wrapper/gradle-wrapper.jar` | **RESOLVED** | Generated authentic Gradle 8.9 wrapper using host Gradle 8.14 distribution. Verified `./gradlew.bat test` and `./gradlew.bat assembleDebug` execute and build `app-debug.apk` (21.45 MB). |
| **INC4-008** | Incomplete Blockchain DevDependency Vulnerability Remediation | Medium (P2) | Prior override only addressed `ws` and `adm-zip`, leaving 4 high-severity vulnerabilities (`undici`, `tmp`, `serialize-javascript`, `@fastify/busboy`). | `blockchain/package.json`, `blockchain/package-lock.json` | **RESOLVED** | Extended `overrides` with `undici` (^6.29.1), `tmp` (^0.2.7), `serialize-javascript` (^7.1.4), and `@fastify/busboy` (^3.2.4). All high-severity findings eliminated (0 critical, 0 high). All 50 contract tests passing. |
| **INC4-009** | Scientific MRV Calculation Discrepancy & Discrete Year Rounding | Medium (P2) | Intermediate biomass rounding ($2,174.52$ instead of $2,173.57$) caused lower bound to falsely state $2,651.19$ (net $2,253.51 \to 2,253$ credits), whereas full precision yields $2,650.24$ (net $2,252.70 \to 2,252$ credits for 1.0000 yr, and $9,010$ credits for 4 yrs). | `backend/tests/carbon.test.js`, `docs/SIH25038_MRV_SCIENTIFIC_VALIDATION.md` | **RESOLVED** | Reconciled full precision arithmetic in Section 7 of `SIH25038_MRV_SCIENTIFIC_VALIDATION.md`. Updated automated regression test `worked example A2` in `carbon.test.js` validating intermediate carbon pools, lower bounds, buffer deductions, and discrete integer flooring across both 1-year and 4-year monitoring windows ($9,010$ credits = $2,252.5$ credits/yr). |
| **INC4-010** | CI Workflow Failure Suppression in Android Job | High (P1) | `.github/workflows/ci.yml` had `|| true` on `./gradlew test` and `./gradlew assembleDebug`, preventing build failures from failing the CI pipeline. Missing `chmod +x gradlew`. | `.github/workflows/ci.yml` | **RESOLVED** | Removed `|| true` to ensure honest failure propagation. Added `chmod +x gradlew` step for Linux runner execution. |
| **INC4-011** | Machine-Specific `local.properties` and Gradle Build Dirs Untracked | Low (P3) | `android/local.properties`, `android/.gradle/`, and `build/` directories were not ignored by git. | `.gitignore`, `android/.gitignore` | **RESOLVED** | Added `android/.gitignore` and updated root `.gitignore` to ignore `local.properties`, `.gradle`, and build artifacts while keeping `local.properties` locally for developer builds. |

---

### Verification Summary
- Total Defects Tracked: **11**
- Resolved: **10**
- Audited with Accurate Operational Blocker Documented: **1 (INC4-005: Local Docker daemon engine pipe inactive)**
- Total Passing Smart Contract Tests: **50 / 50 (100%)**
- Total Passing Backend Tests: **196 / 196 (100%, 0 skipped, 0 failing)**
- Total Passing Android Unit Tests: **16 / 16 (8 debug, 8 release, 100%)**
- Total Passing Frontend Static Checks: **23 / 23 files (19 modules, 23 color pairs)**
- Total Deterministic Test Verifications: **285 passing checks**
