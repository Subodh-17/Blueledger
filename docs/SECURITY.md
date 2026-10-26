# Security notes

No external security audit has been performed. This document lists what is implemented and what remains.

## Implemented
* **Authentication:** bcrypt (cost 12), 12-character password policy (common passwords, repetition, name/email fragments), constant-time-style login path for unknown accounts, per-account login throttle, per-route rate limits, 12 h JWTs re-validated against the user row on every request; role claims in tokens are not trusted.
* **Authorization:** role guards on every sensitive route; organization scoping in queries for records, evidence, projects, credits, search and overview; ownership checks for edits; separation of duties (verifier ≠ submitter, approver ≠ verifier, contract-level issuer ≠ verifier).
* **Uploads and evidence downloads:** extension allow-list **and** file-signature check, size limit, content-addressed storage (client file names never reach the filesystem path), authenticated downloads only, `Content-Security-Policy: sandbox`, `nosniff`, sanitized `Content-Disposition`, `Cache-Control: private, no-store`.
* **Injection / XSS:** parameterized SQL, escaped `LIKE` input, whitelisted sort keys, strict CSP (`script-src 'self'`, `style-src 'self'`), automatic output escaping in the frontend, no inline handlers.
* **CSRF:** the API uses bearer tokens in the `Authorization` header (no ambient cookies), so classic CSRF does not apply. Tokens live in `sessionStorage`, which scripts on the same origin can read; the CSP is the mitigation.
* **CORS:** disabled unless `CORS_ORIGINS` is set; wildcards rejected in production.
* **Errors and logging:** request ids; no stack traces to clients; bodies, headers and tokens are not logged; database outages return a generic 503.
* **Secrets:** environment only; production start-up fails without a strong `JWT_SECRET`; signing keys never leave the server; reference accounts and their password endpoint are disabled when `NODE_ENV=production`.
* **Audit log:** append-only (trigger) and hash-chained; verification endpoint detects alteration.
* **Dependencies:** `npm audit --omit=dev` reported 0 vulnerabilities for backend and blockchain at the time of packaging.

## Known gaps
* Rate limiting and login throttling are in memory and per process.
* Evidence is not virus-scanned or encrypted at rest.
* Signing is custodial (see README limitations); the audit hash chain is not anchored on-chain.
* No multi-factor authentication, no password-reset flow, no token revocation list (deactivating the user revokes access).
* Only automated tests and static review were performed; no penetration test.
