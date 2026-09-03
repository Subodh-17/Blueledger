# Blue Carbon MRV — API Documentation

Base URL: `http://localhost:3001/api`

---

## Authentication

All protected routes require:
```
Authorization: Bearer <token>
```

---

## Auth Routes

### POST /api/auth/register
Register a new user account.
```json
{
  "name": "Dr. Priya Sharma",
  "email": "priya@wwf.org",
  "password": "securepassword",
  "role": "ngo_worker",
  "organisation": "WWF India",
  "adminKey": "YOUR_ADMIN_KEY"   // required only for admin/verifier roles
}
```

### POST /api/auth/login
```json
{ "email": "priya@wwf.org", "password": "securepassword" }
```
**Returns:** `{ token, user }`

### GET /api/auth/me *(auth required)*
Returns current user profile.

---

## Projects

### POST /api/projects *(auth required)*
Register a new project.
```json
{
  "name": "Godavari Delta Mangroves",
  "description": "Restoration of mangrove buffer zones",
  "locationText": "Kakinada, Andhra Pradesh",
  "latitude": 16.924,
  "longitude": 82.193,
  "areaHectares": 45,
  "ecosystemType": "MANGROVE",
  "growthYears": 8,
  "notes": "Initial phase"
}
```

### GET /api/projects *(auth required)*
- Admin/Verifier: returns all projects
- NGO/Community: returns own projects only

### GET /api/projects/:id *(auth required)*
Get single project with uploaded images.

### POST /api/projects/:id/verify *(admin/verifier only)*
```json
{ "action": "approve", "notes": "Verified on field visit" }
// action: "approve" | "reject"
```

---

## Uploads

### POST /api/upload/drone *(auth required)*
Upload drone/field image. Use `multipart/form-data`.
```
image       — file (JPEG/PNG/TIFF/WebP, max 50MB)
projectId   — integer
imageType   — "drone" | "field" | "satellite"
latitude    — number
longitude   — number
capturedAt  — ISO date string
```

### GET /api/upload/images/:projectId *(auth required)*
Get all images for a project.

### GET /api/upload/pending *(auth required)*
Get all images pending admin review.

### POST /api/upload/:id/review *(auth required)*
Admin reviews an uploaded image.
```json
{ "action": "approve" }
// action: "approve" | "reject"
```

---

## Carbon Credits

### GET /api/credits *(auth required)*
List all minted BCT carbon credits.

### POST /api/credits/mint *(admin/verifier only)*
Record a minting event after blockchain transaction.
```json
{
  "projectId": 1,
  "txHash": "0xabc123..."
}
```

### GET /api/credits/stats *(auth required)*
Returns platform-wide statistics.
```json
{
  "total_projects": 12,
  "pending": 4,
  "verified": 5,
  "minted": 3,
  "total_credits_tonnes": 1842,
  "total_users": 18,
  "pending_uploads": 2
}
```

---

## Users

### GET /api/users *(admin/verifier only)*
List all registered users.

### PUT /api/users/:id/wallet *(auth required)*
Update wallet address.
```json
{ "walletAddress": "0xAbCd..." }
```

### GET /api/users/:id/balance *(auth required)*
Get BCT token balance for a user.

---

## Health Check

### GET /health
```json
{ "status": "ok", "ts": "2024-...", "version": "1.0.0" }
```

---

## Ecosystem Types

| Value | Description |
|-------|-------------|
| `MANGROVE` | Mangrove forests |
| `SEAGRASS` | Seagrass meadows |
| `SALT_MARSH` | Salt marsh wetlands |

---

## Error Responses

```json
{ "error": "Error message here" }
```

| Code | Meaning |
|------|---------|
| 400 | Bad request / missing fields |
| 401 | Unauthorized / invalid token |
| 403 | Forbidden / wrong role |
| 404 | Not found |
| 409 | Conflict (e.g. email already registered) |
| 500 | Internal server error |
