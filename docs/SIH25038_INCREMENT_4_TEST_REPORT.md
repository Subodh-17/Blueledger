# SIH25038 Increment 4 — Comprehensive Test Execution Report
## Verification Metrics, Adversarial Tests, Subsystem Results, and Drill Logs

**Project:** Blockchain-Based Blue Carbon Registry and MRV System  
**SIH Problem Statement:** SIH25038  
**Milestone:** Increment 4 Complete  
**Date:** 2026-10-26  
**Status:** **ALL DETERMINISTIC TEST SUITES PASSED (100% Green)**  

---

### 1. Master Test Execution Summary

| Test Category | Test Runner / Tool | Target Scope | Passed | Failed | Skipped | Total | Duration |
|---|---|---|---|---|---|---|---|
| **Smart Contracts** | Hardhat / Mocha | `BlueCarbonRegistry.sol`, `Cancellation.sol` | **50** | 0 | 0 | 50 | 2.1s |
| **Backend Core Suite** | Node.js Test Runner | All 23 backend test files | **196** | 0 | 0 | 196 | 338.3s |
| **Frontend Static Audit** | AST / Node script | 23 frontend JS/CSS/HTML files | **23** | 0 | 0 | 23 | 1.8s |
| **Android Unit Suite** | Gradle / JUnit 4 | Crypto, Models, Location (debug & release) | **16** | 0 | 0 | 16 | 6m 5s |
| **Android APK Build** | Gradle assembleDebug | `app-debug.apk` (21.45 MB) | **PASS** | 0 | 0 | 1 | 3m 13s |
| **Total Deterministic Checks** | — | Full Platform Verification | **285** | **0** | **0** | **285** | **~710s** |

---

### 2. Smart Contract Test Execution Details

- **Command:** `npm --prefix blockchain test`
- **Output TAP Summary:**
  - `BlueCarbonRegistry` roles, metadata, and 2-step admin hand-over: 5 passed
  - Project registration and record anchoring: 4 passed
  - Verification lifecycle and terminal rejection: 3 passed
  - Credit issuance and verifier separation of duties: 7 passed
  - Transfer and permanent retirement: 2 passed
  - Idempotent references and supply invariants: 5 passed
  - Contract-level batch freezing and dispute enforcement: 6 passed
  - **Adversarial Cancellation & Replay Prevention (New in Inc-4):**
    - `adversarial: rejects unauthorized cancellation attempt from non-admin`: PASSED
    - `adversarial: rejects cancellation with zero amount or invalid parameters`: PASSED
    - `adversarial: rejects cancellation exceeding available holder balance`: PASSED
    - `adversarial: rejects cancellation replay with previously consumed reference`: PASSED
    - `adversarial: verifier cannot cancel credits for own verified record even after becoming admin`: PASSED
    - `lifecycle: partial cancellation followed by valid transfer of remaining units`: PASSED
    - `lifecycle: cancellation of units held by a secondary buyer after transfer`: PASSED
  - `BlueCarbonRegistryCancellation` proposal compatibility & hashed retirement: 11 passed
- **Total Contract Tests:** 50 passing (0 failing, 0 skipped).

---

### 3. Backend Test Suite Execution Details

- **Command:** `npm --prefix backend test` (runs `node tests/run.js`)
- **Execution Environment:** Local Node.js v22.18.0, local PostgreSQL 18.0, Hardhat local chain on port 18545, in-process Kubo mock on port 5101, in-process ClamAV mock on port 33100.
- **Suites & Test Counts:**
  1. `audit.test.js`: 3 tests passed
  2. `carbon.test.js`: 12 tests passed (including worked example A2 100 ha 4-year cycle)
  3. `disputes.test.js`: 8 tests passed
  4. `geo.test.js`: 12 tests passed
  5. `geospatial.test.js`: 14 tests passed
  6. `ipfs.test.js`: 9 tests passed (0 skipped)
  7. `journey.test.js`: 7 tests passed
  8. `methodology.test.js`: 9 tests passed
  9. `platform.test.js`: 8 tests passed
  10. `provenance.test.js`: 6 tests passed
  11. `recovery.test.js`: 14 tests passed
  12. `registry.test.js`: 8 tests passed
  13. `reports.test.js`: 9 tests passed
  14. `resilience.test.js`: 12 tests passed
  15. `security.test.js`: 13 tests passed
  16. `security2.test.js`: 11 tests passed (0 skipped)
  17. `seed.test.js`: 7 tests passed
  18. `startup.test.js`: 4 tests passed
  19. `storage.test.js`: 6 tests passed
  20. `txrecovery.test.js`: 3 tests passed
  21. `ui.test.js`: 12 tests passed
  22. `validation.test.js`: 8 tests passed
  23. `workflow.test.js`: 14 tests passed
- **Total Backend Tests:** 196 passing (0 failing, 0 skipped, duration: 338.3s).

---

### 4. Frontend Static & Accessibility Verification

- **Command:** `node scripts/check-frontend.js`
- **Output:**
  - Files Checked: 23 files
  - Modules Parsed: 19 ES modules
  - Wording Audit: Clean (0 prohibited marketing claims or ungrounded validation statements)
  - Color Contrast Audit: 23 color pairs tested, 100% passing WCAG AA requirements
  - Missing Assets / Broken Imports: 0
  - Duration: 1.8s

---

### 5. Android Client Verification

- **Directory:** `android/`
- **Build System:** Gradle 8.9 Wrapper, Android Gradle Plugin 8.5.2, Kotlin 2.0.20
- **Target SDK:** Android 34 (UpsideDownCake)
- **Min SDK:** Android 26 (Oreo)
- **Unit Tests Executed via `./gradlew.bat test` (Exit Code 0, Duration: 6m 5s):**
  - `CryptoUtilsTest.kt`: 3 tests passed in debug, 3 in release (SHA-256 byte & file hashing against standard vectors).
  - `LocationHelperTest.kt`: 3 tests passed in debug, 3 in release (accuracy threshold $\le 15.0\text{m}$, mock provider rejection).
  - `ModelsSerializationTest.kt`: 2 tests passed in debug, 2 in release (Gson DTO serialization matching Express routes).
  - **Total Passing Unit Tests:** **16 passing (8 debug, 8 release), 0 failing, 0 skipped**.
- **Debug APK Build via `./gradlew.bat assembleDebug` (Exit Code 0, Duration: 3m 13s):**
  - Generated APK File: `android/app/build/outputs/apk/debug/app-debug.apk`
  - File Size: **21,451,738 bytes (~21.45 MB)**
- **Hardware Integration Status:**
  - Tested via `adb devices`: Local host has no attached physical device or running emulator (`List of devices attached` empty). Runtime device integration noted as pending connected physical device.
