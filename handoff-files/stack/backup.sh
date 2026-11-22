#!/usr/bin/env bash
# Encrypted backup of the local Ecomnomics stack. Never prints secrets.
#   - pg_dump of the agentv1 database (custom format; app secrets inside are already encrypted)
#   - tar of the browser-profile homes (/workspace/live-agentv1/data/homes)
#   - private/stack-secrets.json (needed to read the encrypted secrets in the dump) + compose/rebuild files
# Encrypted with gpg AES256 using the passphrase in $PASSFILE (box-only, outside /workspace).
# Keeps the last $KEEP archives in $OUT_DIR. Does not upload anywhere.
#
# Restore:  gpg --batch --pinentry-mode loopback --passphrase-file "$PASSFILE" -d FILE.tar.gpg | tar -x -C /some/dir
#           then: pg_restore -d agentv1 --clean --if-exists db/agentv1.dump   (inside the postgres container)
set -euo pipefail
STACK_DIR=/workspace/live-agentv1
OUT_DIR=${OUT_DIR:-/workspace/backups/nightly}
PASSFILE=${PASSFILE:-/home/box/.secrets/ecomnomics-backup.pass}
KEEP=${KEEP:-7}
PG=ecomnomics-agentv1-postgres-1
log(){ printf '[backup %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die(){ log "ERROR: $*"; exit 1; }
cd /

# passphrase: prefer the owner's password from env (kept outside the box, survives resets)
if [[ -n ${ECOMNOMICS_BACKUP_PASS:-} ]]; then
  PASSFILE=$(umask 077; mktemp /tmp/ecbk.XXXXXX)
  trap 'rm -f "$PASSFILE"' EXIT
  printf '%s' "$ECOMNOMICS_BACKUP_PASS" > "$PASSFILE"
  log "using owner backup password from env (value not shown)"
elif [[ ! -s $PASSFILE ]]; then
  mkdir -p "$(dirname "$PASSFILE")"; chmod 700 "$(dirname "$PASSFILE")"
  ( umask 077; openssl rand -base64 48 | tr -d '\n' > "$PASSFILE" )
  log "created new passphrase file at $PASSFILE (value not shown)"
fi
chmod 600 "$PASSFILE"

mkdir -p "$OUT_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
WORK=$(mktemp -d /tmp/ecom-backup.XXXXXX); trap 'sudo rm -rf "$WORK"; [[ $PASSFILE == /tmp/ecbk.* ]] && rm -f "$PASSFILE"' EXIT
mkdir -p "$WORK/db" "$WORK/files"

# 1. database dump (start postgres temporarily if the stack is stopped)
started_pg=0
if [[ -z $(sudo docker ps -q --filter "name=^$PG$") ]]; then
  sudo docker start "$PG" >/dev/null || die "postgres container $PG not found; run rebuild.sh first"
  started_pg=1
  for i in $(seq 1 30); do sudo docker exec "$PG" pg_isready -U postgres -q && break; sleep 1; done
fi
sudo docker exec -u postgres "$PG" pg_dump -Fc -d agentv1 > "$WORK/db/agentv1.dump" || die "pg_dump failed"
sudo docker exec -u postgres "$PG" pg_dumpall --globals-only --no-role-passwords > "$WORK/db/globals.sql" 2>/dev/null || true
[[ $started_pg == 1 ]] && sudo docker stop "$PG" >/dev/null
log "database dumped ($(du -h "$WORK/db/agentv1.dump" | cut -f1))"

# 2. browser-profile homes + config needed for a restore (caches skipped)
sudo tar -C "$STACK_DIR" -cf "$WORK/files/homes.tar" \
  --exclude='*/Cache/*' --exclude='*/Code Cache/*' --exclude='*/GPUCache/*' --exclude='*/.cache/*' \
  --exclude='*/Service Worker/CacheStorage/*' --warning=no-file-changed --ignore-failed-read \
  data/homes || [[ $? == 1 ]]
sudo tar -C "$STACK_DIR" -cf "$WORK/files/config.tar" private/stack-secrets.json compose.yml rebuild.sh backup.sh
sudo chown -R "$(id -u):$(id -g)" "$WORK"
log "homes archived ($(du -h "$WORK/files/homes.tar" | cut -f1))"

# 3. one encrypted archive, written atomically
OUT="$OUT_DIR/ecomnomics-$STAMP.tar.gpg"
tar -C "$WORK" -czf - db files | gpg --batch --yes --quiet --pinentry-mode loopback \
  --passphrase-file "$PASSFILE" --symmetric --cipher-algo AES256 -o "$OUT.partial"
mv "$OUT.partial" "$OUT"; chmod 600 "$OUT"
# verify it decrypts and lists
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASSFILE" -d "$OUT" | tar -tzf - >/dev/null \
  || die "verification failed for $OUT"
log "wrote $OUT ($(du -h "$OUT" | cut -f1)), verified"

# 4. keep the last $KEEP
ls -1t "$OUT_DIR"/ecomnomics-*.tar.gpg 2>/dev/null | tail -n +$((KEEP+1)) | while read -r f; do rm -f "$f"; log "pruned $(basename "$f")"; done
log "kept $(ls -1 "$OUT_DIR"/ecomnomics-*.tar.gpg | wc -l) archive(s) in $OUT_DIR"
echo "$OUT"
