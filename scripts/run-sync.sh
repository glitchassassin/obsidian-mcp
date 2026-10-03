#!/bin/sh
set -eu
umask 077

# The supervisor waits for completed admin setup and reloads on re-authentication.
ob sync-config --path /vault \
  --mode "${SYNC_MODE:-bidirectional}" \
  --conflict-strategy conflict \
  --file-types "${SYNC_FILE_TYPES:-image,audio,video,pdf,unsupported}" \
  --configs "" \
  --excluded-folders "${SYNC_EXCLUDED_FOLDERS:-}"

exec ob sync --path /vault --continuous
