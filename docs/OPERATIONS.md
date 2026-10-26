# Operations

## Start-up checklist
1. PostgreSQL reachable; `npm run db:migrate` applied.
2. Blockchain network reachable at `ETH_RPC_URL`; contract deployed; `blockchain/deployments/<network>.json` (or `DEPLOYMENT_FILE`) present and matching the chain ID.
3. `JWT_SECRET`, signing keys (`CHAIN_MODE=keys`) and `CORS_ORIGINS` set from the environment.
4. `npm start`. The log reports network connection state and any reconciled operations.

## Health
* `GET /health` – process and database (503 when the database is unreachable).
* `GET /api/chain/status` (public) – connection, chain ID, contract, block, supply.
* `GET /api/system/status` (administrator) – database latency, network, evidence storage, IPFS, operation counts, non-secret configuration.

## Operations and reconciliation
* List: `GET /api/chain/operations?status=FAILED|PENDING|SUBMITTED|CONFIRMED`.
* Resume: `POST /api/system/reconcile` or the **Run reconciliation** action on the Blockchain network page.
* A `FAILED` operation with an "Indeterminate" message means no transaction hash was stored; inspect the contract event log for the record, then retry the action in the interface (use an `Idempotency-Key` header from API clients).
* A `CONFIRMED` operation that does not complete usually means a data-consistency problem in the registry: the `last_error` column states the reason.

## Backups
Back up PostgreSQL and `UPLOAD_DIR` together (evidence hashes in the database must match files). The blockchain network is the second record of anchored hashes and credit balances.

## Rotating secrets
Change `JWT_SECRET` to sign everyone out. Rotate signing keys by granting the new account its role (`ROLE_CHANGE` through Administration or the contract owner), updating the environment and restarting.

## Upgrading
Apply new migrations with `npm run db:migrate`; migrations are tracked by file name in `schema_migrations` and run once.

## Increment 2 additions
- **Migrations 009 and 010** are additive; apply with `npm run db:migrate`. Backups from before them restore into the new schema after migrating.
- **Restores and the species lock.** `record_species` has a trigger that blocks edits once a record leaves draft. `pg_restore` creates triggers after loading data, so a backup containing locked lists restores normally (proved by the drill); no superuser option is needed.
- **GeoJSON imports** are limited by `GEO_MAX_BYTES`, `GEO_MAX_FEATURES` and `GEO_MAX_VERTICES`; files are stored like other evidence (hashed, scanned if a scanner is configured, optionally encrypted and pinned).
- **Disputes** pause transfers and retirements through the API only. If someone signs a contract call directly, the reconciler reports the divergence; it cannot prevent it.
- **Browser end-to-end run** (`npm run test:e2e`) resets the database named by `E2E_DB_NAME` (default `blue_carbon_mrv_e2e`); it refuses a name without "test" or "e2e". Never point it at real data.
