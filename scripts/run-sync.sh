#!/bin/sh
set -eu
umask 077

# Login and sync-setup are interactive one-off commands, never startup actions.
# Keep the container available for interactive setup; do not start syncing until
# a vault is explicitly linked by ob sync-setup.
waiting=0
while :; do
  if ob sync-config --path /vault >/dev/null 2>&1; then
    break
  else
    status=$?
  fi
  if [ "$status" -ne 3 ]; then
    echo "Unable to inspect Sync configuration (exit $status)." >&2
    exit "$status"
  fi
  if [ "$waiting" -eq 0 ]; then
    echo "Waiting for vault setup. Run: docker compose exec sync bash"
    echo "Then run ob login, ob sync-list-remote, and ob sync-setup --vault <name> --path /vault."
    waiting=1
  fi
  sleep 5
done

ob sync-config --path /vault \
  --mode "${SYNC_MODE:-bidirectional}" \
  --conflict-strategy conflict \
  --file-types "${SYNC_FILE_TYPES:-image,audio,video,pdf,unsupported}" \
  --configs "" \
  --excluded-folders "${SYNC_EXCLUDED_FOLDERS:-}"

exec ob sync --path /vault --continuous
