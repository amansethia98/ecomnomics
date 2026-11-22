#!/usr/bin/env bash
# Rebuild and start the local Ecomnomics stack on the box with one command.
# Idempotent: safe to re-run. Never prints secrets.
#
# Usage:
#   ./rebuild.sh [COMMIT]            # default commit below
#   ./rebuild.sh --stop              # stop the stack (containers kept, data kept)
# Env flags:
#   WITH_WORKER=1   also start the worker (runs scheduled bots; off by default)
#   WITH_MODEL=1    pass OPENROUTER_API_KEY from the caller's env to the app (off by default = no model spend)
#   SKIP_BUILD=1    don't build images (use existing tags)
#
# Steps: 1 docker  2 images  3 pgdata repair  4 postgres + migrations  5 api/supervisor/web + checks
set -euo pipefail

STACK_DIR=/workspace/live-agentv1
REPO_DIR=/workspace/ecomnomics             # local clone (fetch only, never push)
PROJECT=ecomnomics-agentv1
DEFAULT_COMMIT=d61dc31bc4acaa8699179ad6ead21dcc5537f025   # main incl. PR #26 (step 2 closed)
PGDATA="$STACK_DIR/pgdata"
SECRETS="$STACK_DIR/private/stack-secrets.json"
TEMPLATE="$STACK_DIR/compose.yml"
log(){ printf '[rebuild %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die(){ log "ERROR: $*"; exit 1; }
cd /                                       # never sit inside pgdata (it becomes 0700 postgres)

compose(){  # run docker compose with secrets passed via env only (never on the command line or stdout)
  local cf="$1"; shift
  python3 - "$cf" "$@" <<'PY'
import json,os,subprocess,sys
cf=sys.argv[1]; args=sys.argv[2:]
s=json.load(open('/workspace/live-agentv1/private/stack-secrets.json'))
e=os.environ.copy(); e.update(s)
if os.environ.get('WITH_MODEL')!='1': e['OPENROUTER_API_KEY']=''
e.setdefault('OPENROUTER_API_KEY','')
keep=','.join(list(s)+['OPENROUTER_API_KEY'])
r=subprocess.run(['sudo','-n','--preserve-env='+keep,'docker','compose','--env-file','/dev/null',
                  '-p','ecomnomics-agentv1','-f',cf]+args,env=e)
sys.exit(r.returncode)
PY
}

if [[ "${1:-}" == "--stop" ]]; then
  sudo docker ps -q --filter "label=com.docker.compose.project=$PROJECT" | grep -q . || { log "stack already stopped"; exit 0; }
  sudo docker stop $(sudo docker ps -q --filter "label=com.docker.compose.project=$PROJECT") >/dev/null
  # bot computers launched by the supervisor
  for img in $(sudo docker images ecomnomics/main-computer --format '{{.Repository}}:{{.Tag}}'); do
    ids=$(sudo docker ps -q --filter "ancestor=$img"); [[ -n "$ids" ]] && sudo docker stop $ids >/dev/null
  done
  log "stack stopped (data kept)"; exit 0
fi

COMMIT="${1:-$DEFAULT_COMMIT}"
TAG="${COMMIT:0:9}"
[[ -f "$SECRETS" ]] || die "missing $SECRETS. Restore it from the backup; new secrets would not open the existing database."

# ---------- 1. Docker ----------
if [[ ! -x /usr/sbin/iptables-legacy ]]; then
  log "installing iptables"
  if ! sudo apt-get update -qq >/dev/null 2>&1 || ! sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables >/dev/null 2>&1; then
    log "default Debian mirror failed; switching apt to mirrors.edge.kernel.org (https)"
    sudo sed -i -E 's#https?://deb.debian.org/debian(\s|$)#https://mirrors.edge.kernel.org/debian\1#' /etc/apt/sources.list.d/debian.sources
    sudo apt-get update -qq >/dev/null 2>&1 || true
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables >/dev/null
  fi
fi
# The box carries legacy iptables chains (FORWARD policy DROP); Docker must use the legacy backend
# or containers can't reach each other.
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null
if ! command -v docker >/dev/null || ! command -v dockerd >/dev/null; then
  log "installing Docker static binaries"
  tmp=$(mktemp -d)
  v=$(curl -sSf https://download.docker.com/linux/static/stable/x86_64/ | grep -o 'docker-[0-9.]*\.tgz' | sort -V | tail -1)
  curl -sSfL -o "$tmp/d.tgz" "https://download.docker.com/linux/static/stable/x86_64/$v"
  tar xzf "$tmp/d.tgz" -C "$tmp"; sudo cp "$tmp"/docker/* /usr/local/bin/; rm -rf "$tmp"
fi
sudo mkdir -p /usr/local/lib/docker/cli-plugins
for p in compose buildx; do
  f=/usr/local/lib/docker/cli-plugins/docker-$p
  [[ -x $f ]] && continue
  log "installing docker $p plugin"
  repo=docker/$p; tagv=$(curl -sSfL https://api.github.com/repos/$repo/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)
  if [[ $p == compose ]]; then url=https://github.com/$repo/releases/download/$tagv/docker-compose-linux-x86_64
  else url=https://github.com/$repo/releases/download/$tagv/buildx-$tagv.linux-amd64; fi
  sudo curl -sSfL -o "$f" "$url"; sudo chmod +x "$f"
done
if ! sudo docker info >/dev/null 2>&1; then
  log "starting dockerd"
  # drop nft tables a previous nft-mode dockerd may have left behind
  if command -v nft >/dev/null && sudo nft list chain ip filter DOCKER-USER >/dev/null 2>&1; then
    for t in "ip nat" "ip filter" "ip6 nat" "ip6 filter" "ip raw"; do sudo nft delete table $t 2>/dev/null || true; done
  fi
  sudo sh -c 'nohup dockerd > /var/log/dockerd.log 2>&1 &'
  for i in $(seq 1 30); do sudo docker info >/dev/null 2>&1 && break; sleep 1; done
  sudo docker info >/dev/null 2>&1 || die "dockerd did not start; see /var/log/dockerd.log"
fi
log "docker $(sudo docker version --format '{{.Server.Version}}') ready"

# ---------- 2. Images ----------
APP=ecomnomics/main-app:$TAG; SUP=ecomnomics/main-supervisor:$TAG; COMP=ecomnomics/main-computer:$TAG
need_build=0
for i in $APP $SUP $COMP; do sudo docker image inspect "$i" >/dev/null 2>&1 || need_build=1; done
if [[ $need_build == 1 && "${SKIP_BUILD:-}" != 1 ]]; then
  [[ -d $REPO_DIR/.git ]] || git clone --filter=blob:none https://github.com/amansethia98/ecomnomics.git "$REPO_DIR"
  git -C "$REPO_DIR" cat-file -e "$COMMIT^{commit}" 2>/dev/null || git -C "$REPO_DIR" fetch -q origin
  FULL=$(git -C "$REPO_DIR" rev-parse "$COMMIT^{commit}")
  SRC=/workspace/tmp/ecom-build-$TAG
  rm -rf "$SRC"; mkdir -p "$SRC"; git -C "$REPO_DIR" archive "$FULL" | tar -x -C "$SRC"
  b(){ local img=$1 logf=$2; shift 2
       sudo docker image inspect "$img" >/dev/null 2>&1 && { log "$img exists"; return; }
       log "building $img (log $logf)"
       sudo docker build --progress=plain -t "$img" "$@" > "$logf" 2>&1 || die "build failed for $img; see $logf"; }
  b "$APP"  "$STACK_DIR/build-app-$TAG.log" --build-arg GIT_SHA="$FULL" -f "$SRC/infra/compose/Dockerfile" "$SRC"
  b "$SUP"  "$STACK_DIR/build-sup-$TAG.log" -f "$SRC/infra/sandboxes/supervisor/Dockerfile" "$SRC"
  b "$COMP" "$STACK_DIR/build-computer-$TAG.log" "$SRC/infra/sandboxes/computer"
else
  log "images for $TAG present"
fi
FULL=$(git -C "$REPO_DIR" rev-parse "$COMMIT^{commit}" 2>/dev/null || echo "$COMMIT")

# compose file for this commit, generated from the template (only image tags + version label change)
CF="$STACK_DIR/compose-$TAG.yml"
sed -E -e "s#(ecomnomics/main-(app|supervisor|computer)):[A-Za-z0-9._-]+#\1:$TAG#g" \
       -e "s#(RAKAZO_GIT_SHA:) *[0-9a-f]+#\1 $FULL#" "$TEMPLATE" > "$CF.tmp"
mv "$CF.tmp" "$CF"

# ---------- 3. pgdata repair ----------
pg_running=$(sudo docker ps -q --filter "name=^${PROJECT}-postgres-1$")
if [[ -z $pg_running ]]; then
  sudo test -f "$PGDATA/PG_VERSION" || die "$PGDATA has no PG_VERSION; refusing to let Postgres initialise a new empty database. Restore from backup."
  for d in pg_commit_ts pg_dynshmem pg_replslot pg_serial pg_snapshots pg_stat_tmp pg_tblspc pg_twophase \
           pg_logical/snapshots pg_logical/mappings pg_wal/archive_status pg_notify pg_stat pg_subtrans; do
    sudo test -d "$PGDATA/$d" || { sudo mkdir -p "$PGDATA/$d"; log "created missing $d"; }
  done
  if [[ $(sudo stat -c %u "$PGDATA") != 999 ]] || sudo find "$PGDATA" ! -uid 999 -print -quit | grep -q .; then
    sudo chown -R 999:999 "$PGDATA"; log "pgdata ownership set to postgres (999)"
  fi
  sudo chmod 700 "$PGDATA"
fi

# ---------- 4. Postgres + migrations ----------
compose "$CF" up -d --no-deps --wait postgres >/dev/null 2>&1 || die "postgres did not become healthy; sudo docker logs ${PROJECT}-postgres-1"
log "postgres healthy"
sudo docker rm -f "${PROJECT}-migrate-1" >/dev/null 2>&1 || true   # one-shot container
compose "$CF" up -d --no-deps migrate >/dev/null 2>&1
rc=$(timeout 600 sudo docker wait "${PROJECT}-migrate-1" || echo timeout)
sudo docker logs "${PROJECT}-migrate-1" > "$STACK_DIR/migrate-$TAG.log" 2>&1 || true
[[ $rc == 0 ]] || die "migrations failed (exit $rc); see $STACK_DIR/migrate-$TAG.log"
log "migrations: $(grep -E 'successfully applied|No pending migrations' "$STACK_DIR/migrate-$TAG.log" | tail -1)"

# ---------- 5. App services + checks ----------
svcs=(supervisor api web); [[ "${WITH_WORKER:-}" == 1 ]] && svcs+=(worker)
compose "$CF" up -d --no-deps "${svcs[@]}" >/dev/null 2>&1
for i in $(seq 1 60); do curl -sf http://127.0.0.1:3320/health >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3320/health >/dev/null || die "API health check failed"
log "API health: $(curl -s http://127.0.0.1:3320/health)"
sudo docker exec "${PROJECT}-api-1" sh -c 'grep -q "/agent/v1/metric-reports" dist/index.js && grep -q "/agent/v1/payout-reports" dist/index.js' \
  && log "routes present: /agent/v1/metric-reports, /agent/v1/payout-reports" || log "WARNING: report routes not found in image"
log "version label: $(sudo docker exec ${PROJECT}-api-1 printenv RAKAZO_GIT_SHA)"
log "running: $(sudo docker ps --filter label=com.docker.compose.project=$PROJECT --format '{{.Label "com.docker.compose.service"}}' | sort | tr '\n' ' ')"
[[ "${WITH_WORKER:-}" == 1 ]] || log "worker NOT started (scheduled bots off). Use WITH_WORKER=1 to start it."
log "done. Stop with: $STACK_DIR/rebuild.sh --stop"
