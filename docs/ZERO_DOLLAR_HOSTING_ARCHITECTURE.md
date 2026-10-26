# BlueLedger — Strictly $0/Month Hosting Architecture & Free-Tier Operational Runbook

**Project:** BlueLedger — Blockchain-Based Blue Carbon Registry and MRV System (SIH25038)  
**Target Audience:** Students, Hackathon Evaluators, Demonstrators, and Independent Developers  
**Target Monthly Cost:** **$0.00 / month (Strictly Zero Cost)**  
**Mandatory Payment Method Required:** **None** (Zero credit card requirement across all recommended tiers)  

---

## 1. Multi-Cloud Zero-Dollar Architecture Overview

```
                      +------------------------------------------+
                      |             USER BROWSER                 |
                      +------------------------------------------+
                                           |
                                           | HTTPS (port 443)
                                           v
                      +------------------------------------------+
                      |         VERCEL HOBBY TIER (FREE)         |
                      |  - Edge-cached static SPA                |
                      |  - 100 GB/mo bandwidth                   |
                      |  - Rewrites /api/* to Render backend     |
                      |  - Canonical: blueledger-sigma.vercel.app|
                      +------------------------------------------+
                                           |
                                           | HTTPS / Edge Reverse Proxy
                                           v
                      +------------------------------------------+
                      |        RENDER FREE WEB SERVICE           |
                      |  - Node.js 22 LTS (Express API)          |
                      |  - 0.1 CPU, 512 MB RAM                   |
                      |  - Inactivity sleep after 15 min idle    |
                      |  - Cold start: 30-50s wake time          |
                      |  - 750 free instance hours / month       |
                      +------------------------------------------+
                                           |
                                           | TLS encrypted PostgreSQL connection (port 5432 / 6543)
                                           v
        +----------------------------------+----------------------------------+
        |                                                                     |
        v                                                                     v
+-------------------------------+                     +-------------------------------+
|  OPTION A: RENDER FREE POSTGRES|                     | OPTION B: SUPABASE FREE (REC) |
|  - 1 GB SSD, 256 MB RAM       |                     |  - 500 MB PostgreSQL 15/16    |
|  - Managed via render.yaml    |                     |  - Persistent storage (no 30d)|
|  - 30-day expiration policy   |                     |  - Pauses after 7 days idle   |
|  - 1 free database per account|                     |  - 1-click unpause, data safe |
+-------------------------------+                     +-------------------------------+
```

---

## 2. Resource-by-Resource Financial & Constraint Audit

| Service / Component | Provider & Tier | Cost | Credit Card Required? | Hard Caps & Limits | Inactivity & Expiration Behavior | Overage Policy |
|---|---|---|---|---|---|---|
| **Frontend** | Vercel (Hobby) | **$0.00** | **No** | 100 GB/mo bandwidth, 6,000 build min/mo, 100 deployments/day | Never expires. Static assets remain live 24/7. | Hard block; no automatic billing. |
| **Backend API** | Render (Free Web Service) | **$0.00** | **No** | 0.1 CPU, 512 MB RAM, 750 instance hours/mo, 100 GB bandwidth | Spins down after **15 minutes** of zero HTTP traffic. Cold start takes 30–50s to wake up. | Container stops serving if 750 hrs exceeded (resets 1st of month). |
| **Database (Option A)** | Render (Free PostgreSQL) | **$0.00** | **No** | 1 GB storage, 256 MB RAM, max 1 free DB per account | **Strict 30-day expiration.** Suspended at day 30; permanently deleted after 14-day grace period. | Cannot be extended without upgrading to paid ($7/mo). |
| **Database (Option B - Recommended)** | Supabase (Free Tier) | **$0.00** | **No** | 500 MB database storage, 2 free projects per organization | Pauses after **7 days of consecutive inactivity**. Data is **never deleted**; unpauses in 1 click via dashboard. | Spend cap enabled by default ($0.00). Features throttle rather than charge. |
| **IPFS Storage** | Local / Disabled (`IPFS_PROVIDER=none`) | **$0.00** | **No** | Local filesystem storage | Stored in `/uploads` on the backend ephemeral disk or mock hash. | No external Pinata/Infura API charges. |
| **Smart Contracts / EVM** | Local EVM (`CHAIN_MODE=local`, `ALLOW_LOCAL_CHAIN=1`) | **$0.00** | **No** | In-memory Hardhat EVM state simulation | Zero on-chain gas costs; no Alchemy/Infura subscription needed. | No live Ethereum mainnet transaction fees. |
| **Email Service** | Outbox (`MAIL_TRANSPORT=outbox`) | **$0.00** | **No** | Internal memory/log queue | Reset tokens printed to logs for demonstration. | No SendGrid/Mailgun charges. |

---

## 3. Detailed Operational Constraints & Mitigations

### A. Backend Cold Starts (Render Free Tier)
- **Behavior:** If no HTTP requests are sent to `blueledger-backend` for 15 minutes, Render places the container in a dormant state to conserve compute.
- **Impact:** The first request to `https://blueledger-sigma.vercel.app` after 15 minutes of inactivity will experience a 30 to 50-second latency while Render spins up the Node.js container.
- **Handling:** Subsequent requests respond in normal millisecond latency (< 100 ms).
- **Tip for Demo/Presentation:** Visit the website or send a `curl https://<your-render-url>/health` 1 minute prior to presenting so the container is already warm.

### B. Database Longevity Comparison: Render vs. Supabase

#### Option A: Render Free PostgreSQL (`render.yaml`)
- **Pros:** 100% turnkey deployment directly from `render.yaml` with zero external service configuration.
- **Cons:**
  1. Only 1 free database allowed per Render account. If you already have a free database on Render, Render will require a paid plan ($7/mo) or require you to delete the old one.
  2. The database **expires strictly in 30 days**. Render will permanently destroy the database and its data after a 14-day grace period unless upgraded to paid.

#### Option B: Supabase Free PostgreSQL (Recommended for Long-Term Hackathon / Portfolio)
- **Pros:**
  1. **Zero credit card requirement.**
  2. **Data is permanent:** Supabase will never delete your tables or data.
  3. 500 MB storage is more than 50x what BlueLedger requires for complete registry records, audits, and users.
  4. Automatic pausing after 7 days of inactivity simply puts the compute to sleep. You can unpause it from the Supabase dashboard with one click at any time.

---

## 4. Step-by-Step Deployment Guide & Dashboard Safety Instructions

### Option A: Deploying via Render Free Blueprint (Turnkey $0)

1. Open [https://dashboard.render.com/blueprints/new](https://dashboard.render.com/blueprints/new).
2. Connect or select repository: `Subodh-17/Blueledger`.
3. Render will read `render.yaml` (configured with `plan: free` for both `blueledger-backend` and `blueledger-db`).
4. **CRITICAL ACCEPTANCE GATE:**
   - Look at the **"Estimated Monthly Cost"** displayed at the top or bottom of the Blueprint review page.
   - **It MUST say `$0.00`**.
   - If the dashboard displays `$7.00/month`, `$14.00/month`, asks you to enter credit card details, or states *"You have already used your free database"*, **DO NOT CLICK APPLY**. Instead, cancel and follow Option B below.
5. If it displays `$0.00`, click **Apply**.
6. Render will provision `blueledger-db` and deploy `blueledger-backend`.

---

### Option B: Deploying with Supabase Free Database (Permanent $0 Alternative)

If Render asks for payment due to the 1-free-database limit or if you want permanent data storage without the 30-day deletion:

1. **Create Supabase Account & Project:**
   - Go to [https://supabase.com](https://supabase.com) and sign in with GitHub (no credit card required).
   - Click **New project**, choose an organization, set project name: `blueledger-db`.
   - Set a secure database password (save this securely).
   - Choose region: `US East (N. Virginia)` or closest to your Render service (`Oregon`).
   - Pricing Plan: Verify **Free Tier ($0/month)** is selected. Click **Create new project**.

2. **Obtain Connection String:**
   - In Supabase dashboard: Navigate to **Project Settings** (gear icon) -> **Database**.
   - Scroll down to **Connection parameters** -> **Connection string** tab.
   - Select **URI** mode.
   - Under Mode, choose **Session (Port 5432)** or **Transaction (Port 6543)**.
   - Example URI:
     ```
     postgresql://postgres.[project-ref]:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
     ```
   - Replace `[YOUR-PASSWORD]` with the database password you chose.

3. **Deploy Web Service on Render (Without Render Database):**
   - On Render: Navigate to [https://dashboard.render.com/web/new](https://dashboard.render.com/web/new).
   - Select `Subodh-17/Blueledger`.
   - Configure Web Service:
     - **Name:** `blueledger-backend`
     - **Runtime:** `Node`
     - **Plan:** `Free` ($0/mo)
     - **Region:** `Oregon`
     - **Build Command:** `npm --prefix backend ci && node database/migrate.js`
     - **Start Command:** `npm --prefix backend start`
     - **Health Check Path:** `/health`
   - Under **Environment Variables**, add:
     - `NODE_ENV` = `production`
     - `DATABASE_URL` = `<your-supabase-connection-uri>`
     - `JWT_SECRET` = `<click Generate Value or enter a 32+ char random string>`
     - `CHAIN_MODE` = `local`
     - `ALLOW_LOCAL_CHAIN` = `1`
     - `IPFS_PROVIDER` = `none`
     - `MALWARE_SCAN` = `optional`
     - `EVIDENCE_ENCRYPTION` = `off`
     - `MAX_UPLOAD_MB` = `25`
   - Click **Create Web Service** (Cost: $0.00).

4. **Run Migrations Automatically:**
   - Because `node database/migrate.js` is included in the Render Build Command, Render will automatically connect to your Supabase PostgreSQL database during the build and apply all 11 schema migrations safely over SSL (`rejectUnauthorized: false`).
   - Schema, tables, triggers, and indices are preserved 100% identically.

---

## 5. Connecting Frontend to the Live Backend

Once your Render Web Service finishes building:
1. Copy your assigned Render domain (e.g. `https://blueledger-backend-xxxx.onrender.com`).
2. Test backend health:
   ```bash
   curl -s https://<your-render-domain>/health
   ```
   Expected response:
   ```json
   {"status":"ok","database":"connected","ts":"2026-10-26T..."}
   ```
3. Update Vercel API proxy destination:
   In `vercel.json` and `frontend/vercel.json`, update the rewrite target:
   ```json
   {
     "source": "/api/:path*",
     "destination": "https://<your-render-domain>/api/:path*"
   }
   ```
   Or immediately test directly in the browser without redeployment by executing in DevTools console on [blueledger-sigma.vercel.app](https://blueledger-sigma.vercel.app):
   ```javascript
   localStorage.setItem("API_BASE", "https://<your-render-domain>");
   location.reload();
   ```
