# REST API

Base path `/api`. JSON in/out. Authenticated routes need `Authorization: Bearer <token>` from `POST /api/auth/login`.
List endpoints accept `page`, `pageSize` (≤ 100), `sort`, `dir`, `q` and endpoint-specific filters and return `pagination: {page, pageSize, total, totalPages, sort, dir}`.
Every response has `X-Request-Id` (also in error bodies); `RateLimit-*` headers are returned, `Retry-After` on 429. Transfers and retirements accept an `Idempotency-Key` header (8–100 characters).
Errors: `{ "error": string, "details"?: object, "requestId": string }` with 400 (validation), 401, 403, 404, 409 (state, duplicate or blockchain rejection), 413, 422 (business rule), 429, 502/503 (blockchain or database unavailable).

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/auth/login`, `/auth/register`, `/auth/change-password` | public / public / any | Sign in; create an organization-less field user; change password |
| GET | `/auth/me` | any | Current user |
| GET | `/config` | public | Basemap settings; reference sign-in shortcuts (non-production only) |
| GET | `/public/registry`, `/public/verify/:code`, `/public/transactions` | public | Registry summary; verify a record code or credit batch against the chain; recent transactions |
| GET | `/chain/status`, `/carbon/methodology` | public | Network connection; methodology, parameters, sources, review items |
| GET | `/overview`, `/tasks`, `/search?q=` | any (scoped) | Role-aware figures and series, pending actions, global search |
| GET | `/reports/registry?groupBy=&project=&ecosystem=&region=&status=&origin=&from=&to=&format=` | any (field users scoped to their organization) | Registry report grouped by `project`, `ecosystem`, `region`, `period` (activity month) or `status`; `format=csv` downloads (spreadsheet formulas neutralised, `no-store`). Columns: reported and verified records and area; estimated central and conservative tCO₂e; approved-eligible, issued, **transferred** (cumulative movement), retired and outstanding tonnes. Rows split by `data_origin`; `totals` (one per origin) are computed by the database over the same filters; drafts excluded; at most 500 groups (`truncated`). Invalid parameters return 400. |
| POST | `/geospatial/validate` | field user of the owning organization | Multipart dry run of a `.geojson` file (`projectId`, `source`, optional `tool`, `toolVersion`, `recordId`, `file`). Returns the validator's result, SHA-256 and whether it duplicates a registered file. Stores nothing. |
| POST | `/geospatial/import` | field user of the owning organization | Same input (plus optional `replacesEvidenceId`). Stores only a valid file, as evidence of kind `GEOSPATIAL`, with a frozen validation record and audit entry in one transaction. 422 with the validator report if invalid, 409 duplicate, 413 too large. |
| GET | `/geospatial/imports`, `/geospatial/imports/:evidenceId` | any (scoped) | List (current versions; `current=0` for history) and detail with the declared-versus-imported species comparison |
| GET/PUT | `/records/:id/species` | any (scoped) / the submitting collector | Read, or replace, the planting-by-species list while the record is a draft or awaiting revision |
| POST/GET | `/credits/:id/disputes` | any with access / any with access | Raise a dispute (`category`, `reason` 10–2000 characters); list a batch's disputes with history and whether it is on hold |
| GET | `/disputes?status=&category=&creditId=` | any (scoped) | Dispute queue |
| POST | `/disputes/:id/start-review`, `/disputes/:id/decision` | NCCR administrator who did not raise it | Start review; decide `UPHELD` or `DISMISSED` with a reason of at least 10 characters |
| POST | `/disputes/:id/withdraw` | the person who raised it | Withdraw while open or under review |
| GET/POST | `/organizations` | any / admin | List / create |
| GET/POST/PATCH | `/users`, `/users/:id` | admin | Manage users |
| POST | `/users/:id/chain-role` | admin | Grant/revoke on-chain verifier or registrar role (`{role, granted}`) |
| GET/POST | `/projects`, `/projects/:id`, PATCH `/projects/:id/status` | any (scoped) / admin | Directory (filters `q, ecosystem, status, verification, creditStatus`), detail, create, status |
| GET/POST/PUT | `/records`, `/records/:id` | any (scoped) / field user | Monitoring records |
| POST | `/records/:id/submit` | field user | Build report, hash, anchor on-chain |
| POST | `/records/:id/anchor` | verifier, admin | Retry anchoring |
| POST | `/records/:id/start-review`, `/records/:id/decision` | verifier | Start review; `{decision: VERIFIED\|REJECTED\|NEEDS_REVISION, comments}` |
| POST | `/records/:id/carbon-estimate` | verifier, admin | Versioned carbon assessment for a verified record |
| GET/POST | `/evidence` | any (scoped) / field user | List; upload (multipart `file` or `externalRef`) |
| GET | `/evidence/:id`, `/evidence/:id/file[?download=1]` | any (scoped) | Metadata; authenticated file |
| POST | `/evidence/:id/review`, `/evidence/:id/extract-metadata` | verifier / verifier, admin | Accept, reject, request revision; re-read file metadata |
| GET | `/carbon/calculations` | verifier, admin | Current assessments |
| POST | `/carbon/calculations/:id/approve`, `/issue` | admin | Approve or decline; issue credits on-chain |
| GET | `/credits`, `/credits/:id` | any (scoped) | Batches; detail with events and registry-vs-chain balances |
| POST | `/credits/:id/transfer`, `/credits/:id/retire` | field user (holder), admin | Move or retire credits |
| GET | `/chain/transactions` | any | Transaction register (`q`, `type`, `projectId`, `recordId`) |
| GET | `/chain/operations` | admin | Durable blockchain operations |
| GET | `/admin/stats` | admin, verifier | Registry statistics |
| GET | `/system/status` | admin | Database, network, storage, IPFS, configuration |
| POST | `/system/reconcile` | admin | Resume interrupted blockchain operations |
| GET | `/audit`, `/audit/verify` | admin, verifier / admin | Audit entries; hash-chain integrity |


### Notes on the new endpoints
- **GeoJSON contract:** WGS 84 longitude, latitude; Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon; optional feature properties `observedAt`, `capturedAt`, `species`, `count`, `unit`, `collector`, `sensor`. Limits (environment): `GEO_MAX_BYTES` (5 MB), `GEO_MAX_FEATURES` (5000), `GEO_MAX_VERTICES` (250000). See the header of `backend/src/services/geo.js`.
- **Disputes are a registry control.** While a dispute is open, under review or upheld, transfers and retirements through this API return 409 and start no blockchain operation. The on-chain token is not changed.
