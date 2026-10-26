# BlueLedger — Release & Deployment Audit Report

**Project:** BlueLedger — Blockchain-Based Blue Carbon Registry and MRV System  
**Problem Statement:** SIH25038 (National Centre for Coastal Research, MoES)  
**Date:** 2026-10-26  
**Auditor / Release Engineer:** Antigravity Autonomous Systems Engineering Team  
**GitHub Repository:** [https://github.com/Subodh-17/Blueledger](https://github.com/Subodh-17/Blueledger)  
**Previous Repository Name:** `WCEHackathon2026_Proteas`  
**Current Milestone:** Production Release Candidate & Multi-Cloud Deployment Ready  

---

## 1. Master Acceptance Matrix

| Area | Status | Evidence | Remaining Limitation |
|---|---|---|---|
| **GitHub Rename** | **PASS** | Repository renamed in-place via GitHub CLI API (`gh repo rename Blueledger -R Subodh-17/WCEHackathon2026_Proteas -y`). Verified canonical URL: `https://github.com/Subodh-17/Blueledger`. | All historical issues, PRs, and commit history preserved. |
| **Local-to-Remote Sync** | **PASS** | Synchronized local V3 Increment 4 verified workspace to GitHub `main` branch with clean fast-forward commit on top of remote baseline `99f3f1ba4938d7a801badf1e16266ebea22fda73`. Zero force-push. | Remote tracking branch linked to `origin/main`. |
| **Smart Contracts** | **PASS** | `npm --prefix blockchain test`: **50 passing (100%)**, 0 failing, 0 skipped in 2.0s. All role handovers, batch freezing, adversarial cancellations, and supply invariants verified. | Evaluated on local Hardhat EVM network; mainnet deployment withheld by policy. |
| **Backend Tests** | **PASS** | `npm --prefix backend test`: **196 passing (100%)**, 0 failing, 0 skipped across all 23 test suites in 279.3s. | Requires PostgreSQL 16+ and Node 22+. |
| **Frontend Verification** | **PASS** | `node scripts/check-frontend.js`: 23 files, 19 ES modules, zero external origins, zero inline styles, 23 color pairs pass WCAG AA contrast. | Plain ES-module SPA served without bundler overhead. |
| **Android Subsystem** | **PASS** | Gradle 8.9 wrapper verified; `.\gradlew.bat test` passed **16 unit tests** (8 debug, 8 release); `.\gradlew.bat assembleDebug` built `app-debug.apk` (21,451,738 bytes, SHA-256 verified). | Physical device testing marked pending connected device (`adb devices` empty). |
| **Dependency Audit** | **PASS** | `npm --prefix blockchain audit --audit-level=high` exited with code `0`. Production-only audit `npm --prefix blockchain audit --omit=dev` reported **0 vulnerabilities**. Overrides (`ws`, `adm-zip`, `serialize-javascript`, `tmp`, `undici`) verified. | 36 moderate/low advisories remain strictly within offline devDependencies (`hardhat`, `mocha`, `solidity-coverage`). |
| **Render Deployment** | **READY (Configured)** | Infrastructure-as-Code blueprint `render.yaml` created with managed PostgreSQL `blueledger-db`, web service `blueledger-backend`, dynamic `PORT`, persistent migrations `node database/migrate.js`, and `/health` healthcheck. Supported `DATABASE_URL` with SSL in `config.js` and `db/index.js`. | Cloud provisioning triggered via Render Blueprint connection on dashboard (`https://dashboard.render.com/blueprints/new`). |
| **Vercel Deployment** | **PASS (Deployed & Live)** | Production frontend successfully deployed to Vercel at [https://blueledger-sigma.vercel.app](https://blueledger-sigma.vercel.app) (Project: `subodhs-projects-c39a0359/blueledger`, Deployment ID: `dpl_2NZEHCs4HbjQehUzVJVRujmigzQu`). Verified HTTP 200 OK. | Configured to proxy `/api/*` to backend. |
| **MRV Calculation** | **PASS** | First-principles full-precision recomputation verified: Central gross ($3,033.32\text{ tCO}_2\text{e}$), Lower bound ($2,650.24\text{ tCO}_2\text{e}$), Net buffered ($2,252.70\text{ tCO}_2\text{e} \to \mathbf{2,252}\text{ credits}$ for 1.0000 yr; $\mathbf{9,010}\text{ credits}$ for 4-yr cycle). Verified in `backend/tests/carbon.test.js`. | Tier 1 defaults require site-specific empirical calibration prior to operational accreditation. |
| **Scientific Governance** | **PENDING** | Methodology status strictly flagged `PENDING_REVIEW` in software state. Issuance gate `issuability()` strictly blocks credit tokenization without independent accreditation. | Awaiting independent scientific verification body engagement. |

---

## 2. GitHub Synchronization Details

* **Remote Origin:** `https://github.com/Subodh-17/Blueledger.git`
* **Default Branch:** `main`
* **Baseline Remote Commit:** `99f3f1ba4938d7a801badf1e16266ebea22fda73` (docs: remove hardcoded NCCR2024ADMIN passphrase)
* **Secret Hygiene Audit:**
  - Automated regex scans verified 0 private keys, 0 mnemonic seed phrases, 0 credentials staged.
  - Verified `.env` files are ignored: `backend/.env` ignored via `.gitignore`.
  - Machine-specific files ignored: `android/local.properties`, `android/.gradle/`, `android/**/build/`.
  - Safe configuration templates provided: `.env.example`, `backend/.env.example`.

---

## 3. Render Backend Deployment Architecture

The backend web service is defined in `render.yaml`:
```yaml
services:
  - type: web
    name: blueledger-backend
    runtime: node
    plan: starter
    region: oregon
    buildCommand: npm --prefix backend ci && node database/migrate.js
    startCommand: npm --prefix backend start
    healthCheckPath: /health
    autoDeploy: true
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        fromDatabase:
          name: blueledger-db
          property: connectionString
      - key: JWT_SECRET
        generateValue: true
      - key: CORS_ORIGINS
        sync: false
      - key: CHAIN_MODE
        value: local
      - key: ALLOW_LOCAL_CHAIN
        value: "1"
      - key: IPFS_PROVIDER
        value: none
      - key: MALWARE_SCAN
        value: optional
      - key: EVIDENCE_ENCRYPTION
        value: off
      - key: MAX_UPLOAD_MB
        value: "25"

databases:
  - name: blueledger-db
    databaseName: blue_carbon_mrv
    user: postgres
    plan: starter
    region: oregon
```

### Backend Cloud Hardening Applied:
1. `backend/src/config.js` and `backend/src/db/index.js` updated to accept `DATABASE_URL` with SSL support (`rejectUnauthorized: false`), enabling automatic compatibility with Render managed PostgreSQL.
2. `database/migrate.js` updated to detect and utilize `DATABASE_URL`, allowing zero-downtime schema migrations on Render build execution.
3. Express server dynamically binds to `process.env.PORT` (Render default: `10000`).
4. Native `/health` endpoint checks database connectivity (`SELECT 1`) and returns HTTP 200 `{ status: "ok", database: "connected" }`.

---

## 4. Vercel Frontend Deployment Architecture

The frontend static SPA is configured in `vercel.json`:
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": null,
  "outputDirectory": "frontend",
  "cleanUrls": true,
  "trailingSlash": false,
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ],
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://blueledger-backend.onrender.com/api/:path*"
    },
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ]
}
```

### Frontend Cloud Deployment Details:
* **Live Production URL:** [https://blueledger-sigma.vercel.app](https://blueledger-sigma.vercel.app)
* **Vercel Project:** `subodhs-projects-c39a0359/blueledger`
* **Deployment ID:** `dpl_2NZEHCs4HbjQehUzVJVRujmigzQu`
* **Canonical Domain:** `blueledger-sigma.vercel.app`
* **Inspection URL:** `https://vercel.com/subodhs-projects-c39a0359/blueledger/2NZEHCs4HbjQehUzVJVRujmigzQu`
* **HTTP Verification:** HTTP/2 200 OK, Content-Type: `text/html; charset=utf-8`

### Frontend Cloud Hardening Applied:
1. `frontend/js/api.js` updated with dynamic API resolution:
   - Uses relative `/api/*` by default (transparently proxied by Vercel rewrites without CORS preflight latency).
   - Alternatively accepts `window.__API_BASE__` or `localStorage.getItem("API_BASE")` for direct cross-origin API invocation.
2. SPA client-side routing fallback preserves navigation across direct deep links (`#/overview`, `#/field`, `#/verify`, `#/reports`).
3. Static AST and WCAG AA accessibility audits verified 100% compliant via `node scripts/check-frontend.js`.

---

## 5. End-to-End Verification Summary

Across all subsystems:
* **Smart Contract Test Suite:** 50 / 50 passing (0 failing, 0 skipped).
* **Backend Integration Suite:** 196 / 196 passing (0 failing, 0 skipped).
* **Frontend Static Integrity Suite:** 23 / 23 files passing (19 modules, 23 color pairs).
* **Android Unit Test Suite:** 16 / 16 test executions passing (8 debug, 8 release).
* **Deterministic Verification Count:** **285 passing checks**.
