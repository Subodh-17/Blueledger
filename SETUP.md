# Blue Carbon MRV — Setup & Run Guide

## Project Structure

```
blue-carbon-mrv/
│
├── frontend/
│   ├── admin/
│   │   └── index.html          ← Admin & Verifier Dashboard (open in browser)
│   └── mobile/
│       └── index.html          ← User Mobile App (open in browser)
│
├── backend/
│   ├── package.json
│   ├── .env.example            ← Copy to .env and fill values
│   └── src/
│       ├── index.js            ← Express server entry point
│       ├── middleware/
│       │   └── auth.js         ← JWT authentication middleware
│       ├── routes/
│       │   ├── auth.js         ← Register / Login
│       │   ├── projects.js     ← Project CRUD & verification
│       │   ├── uploads.js      ← Image upload & review
│       │   ├── credits.js      ← Carbon credit minting
│       │   └── users.js        ← User management
│       └── utils/
│           ├── db.js           ← PostgreSQL connection pool
│           └── carbonCalculator.js ← IPCC carbon formula
│
├── database/
│   ├── migrate.js              ← Run migrations
│   └── migrations/
│       └── 001_initial_schema.sql  ← Full DB schema
│
├── blockchain/
│   ├── package.json
│   ├── hardhat.config.js
│   ├── contracts/
│   │   └── BlueCarbonToken.sol ← ERC-20 smart contract
│   ├── scripts/
│   │   ├── deploy.js           ← Deploy contract
│   │   └── interact.js         ← Test contract functions
│   └── test/
│       └── BlueCarbonToken.test.js ← Contract unit tests
│
├── docs/
│   └── API.md                  ← Full API documentation
│
└── package.json                ← Root scripts
```

---

## Option A — Standalone Mode (No server needed)

Just open the HTML files directly in your browser — no installation required.

1. Open `frontend/admin/index.html` in Chrome/Edge
2. Open `frontend/mobile/index.html` in another tab in the **same browser**
3. Both share `localStorage` — data syncs automatically across tabs

**Admin Key:** Set via `ADMIN_KEY` in `backend/.env`

---

## Option B — Full Localhost Mode (Recommended)

Everything runs through `localhost` — no file:// paths.

### Step 1 — Install dependencies
```bash
# In the root blue-carbon-mrv folder:
npm install
cd backend && npm install
cd ..
```

### Step 2 — Setup environment
```bash
cd backend
copy .env.example .env     # Windows
# or: cp .env.example .env  # Mac/Linux
```
Edit `.env`:
```env
PORT=3001
JWT_SECRET=anylongrandomstring123
ADMIN_KEY=your_admin_registration_passphrase_here
```

### Step 3 — Start the backend (serves frontend too)
```bash
cd backend
npm run dev
```

### Step 4 — Open in browser

| URL | What it opens |
|-----|---------------|
| `http://localhost:3001` | Home page with links |
| `http://localhost:3001/admin` | ⚙️ Admin Dashboard |
| `http://localhost:3001/mobile` | 📱 Field Worker App |
| `http://localhost:3001/health` | API health check |

Both apps share the same origin so localStorage syncs between them automatically.

---

## Option C — Deploy to Sepolia Testnet

1. Get Sepolia ETH from a faucet
2. Add your private key and Infura/Alchemy URL to `backend/.env`
3. Run: `cd blockchain && npx hardhat run scripts/deploy.js --network sepolia`
4. Contract address is saved automatically

---

## Environment Variables (`backend/.env`)

```env
PORT=3001
NODE_ENV=development

DB_HOST=localhost
DB_PORT=5432
DB_NAME=blue_carbon_mrv
DB_USER=postgres
DB_PASSWORD=your_password

JWT_SECRET=your_long_random_secret
ADMIN_KEY=your_admin_registration_passphrase_here

ETH_RPC_URL=http://127.0.0.1:8545
PRIVATE_KEY=your_wallet_private_key
CONTRACT_ADDRESS=          # filled by deploy script

SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY
```

---

## Workflow

```
User (Mobile App)                     Admin (Dashboard)
─────────────────                     ─────────────────
1. Register account
2. Register project           ──►     Appears in Projects
3. Upload photo               ──►     Appears in Upload Queue
                                      Admin sees actual photo
                                      Admin clicks Approve
4. Project → "verified"       ◄──     Upload approved
                                      Admin clicks Mint BCT
5. BCT appears in wallet      ◄──     Blockchain tx confirmed
6. See tx hash & block #
```

---

## Admin Key

The admin key is required to create admin/verifier accounts during registration.  
To change it, update `ADMIN_KEY` in `backend/.env` (full-stack) or  
`const ADMIN_KEY = '...'` in `frontend/admin/index.html` (standalone).

---

## Carbon Calculation (IPCC Wetlands Supplement 2013)

| Ecosystem | Seq. Rate (tCO₂e/ha/yr) | Stock (tC/ha) | Maturity |
|-----------|------------------------|---------------|----------|
| Mangrove  | 6.00 | 100 | 20 yrs |
| Seagrass  | 1.38 | 70  | 10 yrs |
| Salt Marsh| 2.18 | 50  | 15 yrs |

Formula: `(Annual Seq + Biomass Stock Carbon) × 0.80`  
(20% uncertainty discount per IPCC guidelines)
