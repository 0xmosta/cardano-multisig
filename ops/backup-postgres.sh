#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

BACKUP_DIR="${CARDANO_MULTISIG_BACKUP_DIR:-/home/ultra/backups/cardano-multisig}"
KEY_FILE="${CARDANO_MULTISIG_BACKUP_KEY_FILE:-/home/ultra/.config/cardano-multisig/backup.key}"
RETENTION_DAYS="${CARDANO_MULTISIG_BACKUP_RETENTION_DAYS:-14}"
SERVICE_NAME="${CARDANO_MULTISIG_POSTGRES_SERVICE:-cardano-multisig-postgres}"

if [[ ! -s "$KEY_FILE" ]]; then
  echo "Backup encryption key is missing: $KEY_FILE" >&2
  exit 1
fi

container="$(docker ps --filter "name=${SERVICE_NAME}" --format '{{.ID}}' | head -1)"
if [[ -z "$container" ]]; then
  echo "PostgreSQL container for ${SERVICE_NAME} is not running." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/cardano-multisig-${timestamp}.dump.enc"
temporary="${target}.tmp"
trap 'rm -f "$temporary"' EXIT

docker exec "$container" sh -lc \
  'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass "file:${KEY_FILE}" -out "$temporary"

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:${KEY_FILE}" -in "$temporary" \
  | docker exec -i "$container" pg_restore --list >/dev/null

mv "$temporary" "$target"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'cardano-multisig-*.dump.enc' -mtime "+${RETENTION_DAYS}" -delete
echo "Encrypted PostgreSQL backup verified: $(basename "$target")"
