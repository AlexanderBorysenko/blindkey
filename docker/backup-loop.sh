#!/bin/sh
# Periodic backup loop for the blindkey `backup` compose service.
# Calls the server CLI, which does VACUUM INTO and prunes to --keep.
# The master key is NEVER copied: a backup is the SQLite file only.
set -eu

INTERVAL="${BLINDKEY_BACKUP_INTERVAL:-86400}"
KEEP="${BLINDKEY_BACKUP_KEEP:-14}"
DATA_DIR="${BLINDKEY_DATA_DIR:-/data}"
OUT="${BLINDKEY_BACKUP_DIR:-${DATA_DIR}/backups}"
CLI="${BLINDKEY_SERVER_BIN:-/app/packages/server/dist/cli.js}"

while :; do
  if node "$CLI" backup --out "$OUT" --keep "$KEEP"; then
    status=0
  else
    status=$?
    echo "blindkey backup failed with status ${status}" >&2
  fi

  if [ -n "${BLINDKEY_BACKUP_ONCE:-}" ]; then
    exit "$status"
  fi

  sleep "$INTERVAL"
done
