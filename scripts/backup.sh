#!/usr/bin/env bash
# Backs up the registry: a PostgreSQL custom-format dump and the evidence directory, with a SHA-256 manifest.
# Usage: DB_PASSWORD=... scripts/backup.sh <output-directory>
# Back up the database and the evidence directory TOGETHER: evidence hashes in the database must match the files.
set -euo pipefail
OUT="${1:?usage: backup.sh <output-directory>}"
: "${DB_HOST:=localhost}" "${DB_PORT:=5432}" "${DB_NAME:=blue_carbon_mrv}" "${DB_USER:=postgres}"
: "${UPLOAD_DIR:=$(cd "$(dirname "$0")/.." && pwd)/backend/uploads}"
export PGPASSWORD="${DB_PASSWORD:?DB_PASSWORD is required}"
mkdir -p "$OUT"
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -Fc --no-owner "$DB_NAME" -f "$OUT/db.dump"
tar -C "$UPLOAD_DIR" -czf "$OUT/uploads.tar.gz" .
( cd "$OUT" && sha256sum db.dump uploads.tar.gz > MANIFEST.sha256 )
echo "Backup written to $OUT ($(du -sh "$OUT" | cut -f1)); manifest:"; cat "$OUT/MANIFEST.sha256"
