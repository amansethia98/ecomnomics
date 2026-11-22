#!/usr/bin/env bash
# Run test-public.sh and the Safari asset check every 30s for at least 10 minutes.
# Never prints passwords. Writes a summary log.
set -u
ROOT=/workspace/preview-link
LOG="$ROOT/logs/prove-10min.log"
: > "$LOG"
if [[ -z "${PREVIEW_LINK_PASSWORD:-}" ]]; then
  echo "FAIL: PREVIEW_LINK_PASSWORD is not set"
  exit 1
fi
start=$(date +%s)
# At least 10 minutes, 30s apart: 21 iterations covers 10 minutes of interval plus the first run.
# Run until elapsed >= 600s AND at least 21 successful cycles.
i=0
fails=0
passes=0
while true; do
  i=$((i+1))
  now=$(date '+%Y-%m-%d %H:%M:%S %Z')
  echo "===== cycle $i at $now =====" | tee -a "$LOG"
  pub_ok=0
  saf_ok=0
  if "$ROOT/test-public.sh" >>"$LOG" 2>&1; then
    pub_ok=1
    echo "cycle $i test-public: PASS" | tee -a "$LOG"
  else
    echo "cycle $i test-public: FAIL" | tee -a "$LOG"
  fi
  if "$ROOT/test-safari-assets.sh" >>"$LOG" 2>&1; then
    saf_ok=1
    echo "cycle $i safari-assets: PASS" | tee -a "$LOG"
  else
    echo "cycle $i safari-assets: FAIL" | tee -a "$LOG"
  fi
  if [[ $pub_ok -eq 1 && $saf_ok -eq 1 ]]; then
    passes=$((passes+1))
  else
    fails=$((fails+1))
  fi
  elapsed=$(( $(date +%s) - start ))
  echo "progress: cycles=$i passes=$passes fails=$fails elapsed=${elapsed}s" | tee -a "$LOG"
  if [[ $elapsed -ge 600 && $i -ge 21 ]]; then
    break
  fi
  sleep 30
done
echo "RESULT: cycles=$i passes=$passes fails=$fails elapsed=${elapsed}s" | tee -a "$LOG"
if [[ $fails -ne 0 ]]; then
  exit 1
fi
exit 0
