#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

BACKUP_DIR="${CARDANO_MULTISIG_BACKUP_DIR:-/home/ultra/backups/cardano-multisig}"
KEY_FILE="${CARDANO_MULTISIG_BACKUP_KEY_FILE:-/home/ultra/.config/cardano-multisig/backup.key}"
backup="${1:-$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'cardano-multisig-*.dump.enc' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)}"

if [[ -z "$backup" || ! -f "$backup" ]]; then
  echo "No encrypted backup is available for restore testing." >&2
  exit 1
fi
if [[ ! -s "$KEY_FILE" ]]; then
  echo "Backup encryption key is missing: $KEY_FILE" >&2
  exit 1
fi

temporary="$(mktemp --suffix=.dump)"
container="cardano-multisig-restore-test-$$"
trap 'rm -f "$temporary"; docker rm -f "$container" >/dev/null 2>&1 || true' EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:${KEY_FILE}" -in "$backup" -out "$temporary"
docker run -d --name "$container" -e POSTGRES_PASSWORD=restore-test -e POSTGRES_DB=cardano_multisig_restore postgres:16-alpine >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -d cardano_multisig_restore >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres -d cardano_multisig_restore >/dev/null
docker exec -i "$container" pg_restore --exit-on-error --no-owner --no-acl -U postgres -d cardano_multisig_restore < "$temporary"

counts="$(docker exec "$container" psql -U postgres -d cardano_multisig_restore -Atc \
  "select (select count(*) from cm_account_wallets) || ':' || (select count(*) from cm_account_transactions) || ':' || (select count(*) from cm_relay_rooms)")"
echo "Restore test passed (wallets:transactions:rooms=${counts})."
