#!/bin/sh
# Periodic backup loop for the pidb `backup` compose service.
# Calls the server CLI, which does VACUUM INTO and prunes to --keep.
# The master key is NEVER copied: a backup is the SQLite file only.
set -eu

INTERVAL="${PIDB_BACKUP_INTERVAL:-86400}"
KEEP="${PIDB_BACKUP_KEEP:-14}"
DATA_DIR="${PIDB_DATA_DIR:-/data}"
OUT="${PIDB_BACKUP_DIR:-${DATA_DIR}/backups}"
CLI="${PIDB_SERVER_BIN:-/app/packages/server/dist/cli.js}"

while :; do
  if node "$CLI" backup --out "$OUT" --keep "$KEEP"; then
    status=0
  else
    status=$?
    echo "pidb backup failed with status ${status}" >&2
  fi

  if [ -n "${PIDB_BACKUP_ONCE:-}" ]; then
    exit "$status"
  fi

  sleep "$INTERVAL"
done
