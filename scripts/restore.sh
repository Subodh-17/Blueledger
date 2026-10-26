#!/usr/bin/env bash
# Restores a backup into a NEW database and a NEW evidence directory (never over a running registry).
# Usage: DB_PASSWORD=... scripts/restore.sh <backup-directory> <target-database> <target-uploads-directory>
set -euo pipefail
SRC="${1:?usage: restore.sh <backup-dir> <target-db> <target-uploads-dir>}"; TARGET_DB="${2:?target database name}"; TARGET_UPLOADS="${3:?target uploads directory}"
: "${DB_HOST:=localhost}" "${DB_PORT:=5432}" "${DB_USER:=postgres}"
export PGPASSWORD="${DB_PASSWORD:?DB_PASSWORD is required}"
( cd "$SRC" && sha256sum -c MANIFEST.sha256 )                       # refuse corrupted backups
createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$TARGET_DB"
pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-owner -d "$TARGET_DB" "$SRC/db.dump"
mkdir -p "$TARGET_UPLOADS" && tar -C "$TARGET_UPLOADS" -xzf "$SRC/uploads.tar.gz"
echo "Restored database $TARGET_DB and evidence into $TARGET_UPLOADS"
