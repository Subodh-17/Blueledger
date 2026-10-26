# SIH25038 Increment 4 — Implementation & Feature Report
## Native Android Client Development, Adversarial Smart-Contract Hardening, Dependency Remediation, and CI/CD Multi-Job Integration

**Project:** Blockchain-Based Blue Carbon Registry and MRV System  
**SIH Problem Statement:** SIH25038  
**Milestone:** Increment 4 Complete  
**Date:** 2026-10-26  
**Auditor:** Antigravity Autonomous Systems Engineering Team  

---

### 1. Executive Summary

Increment 4 elevates the SIH25038 platform from an audited backend/web codebase to an end-to-end multi-platform enterprise architecture. This increment implemented the native Android field client, fortified smart contract edge cases with adversarial tests, resolved high-severity blockchain tooling vulnerabilities, formalized MRV reference calculations, and extended the GitHub Actions CI/CD pipeline to cover Android builds.

---

### 2. Core Implementation Accomplishments

#### 2.1 Native Android Field Application & Build Verification (`android/`)
To satisfy the mobile field data collection requirement without relying on web browser emulation, a complete native Android project was created in the workspace under `android/`:
- **Architecture:** Clean Architecture with Jetpack Compose, MVVM pattern, Room ORM, and WorkManager offline synchronization.
- **Components Implemented:**
  - `build.gradle` & `app/build.gradle`: Android Gradle Plugin 8.5.2, Kotlin 2.0.20, CompileSdk 34, MinSdk 26, Jetpack Compose BOM 2024.10.00.
  - `gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`: Authentic Gradle 8.9 wrapper generated using host Gradle distribution.
  - `AndroidManifest.xml`: Hardware features (`camera`, `gps`), runtime permissions (`ACCESS_FINE_LOCATION`, `CAMERA`, `INTERNET`), FileProvider for secure photo capture.
  - **Local Database (Room):**
    - `LocalProject`: Cached assigned restoration projects.
    - `LocalRecord`: Offline monitoring records with `LOCAL_DRAFT`, `SYNC_PENDING`, `SYNCED`, `SYNC_FAILED` states.
    - `LocalEvidence`: Geotagged evidence queue with pre-computed client-side SHA-256 fingerprints.
    - `SyncTransaction`: Idempotency tracking table preventing duplicate remote submissions.
  - **Networking & API Service (`MrvApiService.kt`):**
    - Retrofit2 + OkHttp3 with `AuthInterceptor` injecting JWT bearer tokens and `X-Client-Platform: Android-Native`.
    - Endpoints implemented: `/api/auth/login`, `/api/projects`, `/api/records` (with `X-Idempotency-Key`), `/api/evidence` (multipart), `/api/records/{id}/submit`, and `/health`.
  - **Offline Sync Engine (`SyncWorker.kt`, `SyncManager.kt`):**
    - `CoroutineWorker` running background sync constrained to `NetworkType.CONNECTED` with exponential backoff.
    - Atomically uploads draft records, streams evidence binaries, verifies server SHA-256 and malware scan status, and submits finalized records.
  - **Security & Provenance (`LocationHelper.kt`, `CryptoUtils.kt`, `AuthRepository.kt`):**
    - `EncryptedSharedPreferences` for secure token storage.
    - `LocationHelper.isMock()` detection rejecting spoofed location providers.
    - GPS accuracy enforcement threshold ($\le 15.0\text{ meters}$).
    - Pre-upload SHA-256 cryptographic hashing.
  - **UI Screens (Jetpack Compose Material3):**
    - `LoginScreen.kt`: Official email & password authentication.
    - `ProjectListScreen.kt`: Assigned projects with ecosystem tags and cache indicators.
    - `RecordCreateScreen.kt`: Plot survey form (area, canopy cover %, seedling count, activity date).
    - `EvidenceCaptureScreen.kt`: Photo capture with live GPS overlay and cryptographic hash fingerprinting.
    - `SyncStatusScreen.kt`: Offline queue status and manual "Sync Now" trigger.
  - **Build & Test Verification (INC4-007):**
    - `./gradlew.bat test`: Executed with **16 passing unit tests (8 debug, 8 release, 100% pass)** in 6m 5s.
    - `./gradlew.bat assembleDebug`: Successfully built debug APK `app-debug.apk` (**21,451,738 bytes, ~21.45 MB**) in 3m 13s.

#### 2.2 Adversarial Smart Contract Verification & Hardening (INC4-003)
- Expanded `blockchain/test/BlueCarbonRegistry.test.js` with 7 dedicated adversarial and lifecycle tests:
  - **Unauthorized Cancellation:** Asserts reverts when non-admin accounts invoke `cancelCredits`.
  - **Zero & Negative Quantities:** Asserts reverts when `amount = 0`.
  - **Invalid Identifiers:** Asserts reverts on zero case hashes or zero references.
  - **Excessive Cancellation:** Asserts reverts when cancellation quantity exceeds the holder's batch balance.
  - **Replay Protection:** Asserts reverts when a previously used idempotency reference (`ref`) is re-submitted.
  - **Separation of Duties:** Asserts that an account that verified a record cannot cancel its credits, even if it later becomes the contract administrator.
  - **Multi-Party Lifecycle:** Proves partial cancellation followed by transfer of remaining units, and cancellation of units held by a secondary buyer after transfer.
- Smart contract test count increased from 43 to **50 passing tests (100%)**.

#### 2.3 Blockchain Dependency Security Remediation (INC4-002, INC4-008)
- Root Cause: Transitive dependencies of Hardhat devTooling (`ws`, `adm-zip`, `undici`, `tmp`, `serialize-javascript`, `@fastify/busboy`) contained advisories.
- Remediation: Applied selective, non-breaking npm `overrides` in `blockchain/package.json`:
  - `"ws": "^8.22.0"`
  - `"adm-zip": "^0.6.1"`
  - `"@fastify/busboy": "^3.2.4"`
  - `"serialize-javascript": "^7.1.4"`
  - `"tmp": "^0.2.7"`
  - `"undici": "^6.29.1"`
- Result: **0 Critical, 0 High vulnerabilities**. High-severity advisories reduced from 15 to 0. All 50 contract tests compile and run with 100% stability.

#### 2.4 Scientific MRV Documentation & Mathematical Reconciliation (INC4-004, INC4-009)
- Updated `docs/SIH25038_MRV_SCIENTIFIC_VALIDATION.md` with Section 7:
  - Worked Example A: 100ha Mangrove Restoration (Planted, Tropical Wet, 1.0000 Julian year). Full-precision breakdown of Biomass ($2,439.32$ tCO2e), Soil ($594.00$ tCO2e), Central Total ($3,033.32$ tCO2e), Conservative 95% CI Lower Bound ($2,650.24$ tCO2e), and 15% Risk Buffer Net Eligible Credits ($2,252$ whole tonnes).
  - Mathematical Reconciliation: Clarified that the software compounds 95% CI parameter lower bounds ($g=9.4, R=0.47, CF=0.429, EF_{\text{REWET}}=1.30$), producing $2,650.24\text{ tCO}_2\text{e}$ (reconciling the earlier rounding typo of $2,651.19$), which nets to $2,252.70\text{ tCO}_2\text{e} \to \lfloor 2,252.70 \rfloor = \mathbf{2,252}$ credits for 1 year, and exactly $9,010$ credits across a 4-year cycle.
  - Added automated regression test `worked example A2` to `backend/tests/carbon.test.js`, asserting intermediate carbon pools, lower bounds, buffer deductions, and discrete integer flooring across both 1-year and 4-year monitoring windows ($12,133.29$ central, $10,600.95$ lower bound, $9,010$ eligible credits = $2,252.5\text{ credits/yr}$). Backend test suite verified at **196 passing tests**.

#### 2.5 Multi-Job CI/CD Pipeline & Failure Propagation (INC4-006, INC4-010)
- Enhanced `.github/workflows/ci.yml` with a dedicated `android` job:
  - Environment: `ubuntu-latest`, Temurin JDK 17, Android SDK via `android-actions/setup-android@v3`.
  - Added `chmod +x gradlew` step for Linux permissions.
  - Removed `|| true` to ensure genuine failure propagation in CI.
  - Steps: Checkout, JDK setup, Android SDK provisioning, Gradle unit test execution (`./gradlew test`), and debug APK build (`./gradlew assembleDebug`).

---

### 3. File Inventory of Increment 4 Changes

| Path | Action | Description |
|---|---|---|
| `android/build.gradle` | Created | Top-level Android build script with AGP 8.5.2 and Kotlin 2.0.20 |
| `android/settings.gradle` | Created | Android project settings and repository configurations |
| `android/local.properties` | Created | SDK pointer to local Android SDK path |
| `android/gradle.properties` | Created | JVM arguments, AndroidX, and configuration caching |
| `android/app/build.gradle` | Created | App module build script (Compose, Room, WorkManager, Retrofit2, CameraX) |
| `android/app/proguard-rules.pro` | Created | Proguard rules for Room, OkHttp, and Retrofit |
| `android/app/src/main/AndroidManifest.xml` | Created | Application manifest with permissions and FileProvider |
| `android/app/src/main/res/` | Created | Resource files: strings, colors, themes, file_paths, network_security_config |
| `android/app/src/main/java/org/bluecarbon/mrv/` | Created | 15 Kotlin source files implementing the complete native field client |
| `android/app/src/test/java/org/bluecarbon/mrv/` | Created | 3 unit test files testing crypto, models, and location logic |
| `android/gradle/wrapper/gradle-wrapper.properties` | Created | Gradle 8.9 distribution wrapper configuration |
| `blockchain/package.json` | Updated | Added dependency overrides for `ws` and `adm-zip` |
| `blockchain/test/BlueCarbonRegistry.test.js` | Updated | Added 7 adversarial and lifecycle contract tests (now 50 tests) |
| `.github/workflows/ci.yml` | Updated | Added Android build and unit test job |
| `docs/SIH25038_INCREMENT_4_BASELINE.md` | Created | Baseline state and independent test reproduction |
| `docs/SIH25038_INCREMENT_4_DEFECT_REGISTER.md` | Created | Tracking INC4-001 through INC4-006 |
| `docs/SIH25038_INCREMENT_4_IMPLEMENTATION_REPORT.md` | Created | This implementation report |
| `docs/SIH25038_INCREMENT_4_TEST_REPORT.md` | Created | Detailed test execution report |
| `docs/SIH25038_INCREMENT_4_FINAL_AUDIT.md` | Created | Final release readiness and security audit |
| `docs/SIH25038_ANDROID_INTEGRATION_GUIDE.md` | Updated | Documented newly created `android/` codebase and build instructions |
| `docs/SIH25038_MRV_SCIENTIFIC_VALIDATION.md` | Updated | Added Section 7 worked reference examples |
| `docs/SIH25038_REQUIREMENTS_TRACEABILITY.md` | Updated | Traceability matrix updated with Increment 4 verifications |
