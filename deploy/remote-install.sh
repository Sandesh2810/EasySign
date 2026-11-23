#!/usr/bin/env bash
# Runs ON THE SERVER, as the YouNMeSign Linux user only (never root, never the other app's user).
# Called by "npm run deploy:server". It unpacks one release, installs its packages, switches "current" to it,
# restarts ONLY the two easysign-* processes, checks the app answers, and puts the previous release back if not.
# Usage: remote-install.sh <release-name> <mode: local|server> <port> <app-url>
set -euo pipefail

REL="$1"; MODE="$2"; PORT="$3"; APP_URL="$4"
BASE="$HOME"
export PATH="$BASE/node/bin:$PATH"
export PM2_HOME="$BASE/.pm2"
export EASYSIGN_HOME="$BASE" EASYSIGN_PORT="$PORT"
DIR="$BASE/releases/$REL"
INCOMING="$BASE/incoming"

say() { echo "CHECK | $1 | $2"; }
fail() { say "$1" "FAIL: $2"; exit 1; }

[ "$(id -u)" != "0" ] || fail "user" "this must not run as root"
command -v node >/dev/null || fail "node" "Node is not installed for this user ($BASE/node)"
[ -f "$BASE/shared/web.env" ] && [ -f "$BASE/shared/worker.env" ] || fail "settings" "shared/web.env or shared/worker.env is missing"

# room on the disk: at least 1.5 GB free before unpacking
FREE_KB=$(df -Pk "$BASE" | awk 'NR==2 {print $4}')
[ "$FREE_KB" -gt 1500000 ] || fail "disk" "less than 1.5 GB free ($((FREE_KB / 1024)) MB)"
say "disk" "PASS ($((FREE_KB / 1024)) MB free)"

mkdir -p "$DIR"
tar -xzf "$INCOMING/$REL-source.tar.gz" -C "$DIR"
cd "$DIR"

if [ "$MODE" = "local" ]; then
  # built on Sandesh's PC: only the run-time packages are installed here (this fetches the Linux builds of
  # the image and PDF libraries)
  tar -xzf "$INCOMING/$REL-build.tar.gz" -C "$DIR"
  nice -n 19 npm ci --omit=dev --no-audit --no-fund >"$BASE/logs/npm-$REL.log" 2>&1 || fail "packages" "npm ci failed (logs/npm-$REL.log)"
else
  # built here, at the lowest priority and with a memory cap, so the other app on this server is not starved
  nice -n 19 npm ci --no-audit --no-fund >"$BASE/logs/npm-$REL.log" 2>&1 || fail "packages" "npm ci failed (logs/npm-$REL.log)"
  set -a; . "$BASE/shared/build.env"; set +a
  APP_URL="$APP_URL" NODE_OPTIONS="--max-old-space-size=${BUILD_HEAP_MB:-1024}" nice -n 19 npm run build >"$BASE/logs/build-$REL.log" 2>&1 || fail "build" "the build failed (logs/build-$REL.log)"
  nice -n 19 node scripts/build-worker.mjs >>"$BASE/logs/build-$REL.log" 2>&1 || fail "build" "the worker build failed"
  nice -n 19 npm prune --omit=dev --no-audit --no-fund >>"$BASE/logs/npm-$REL.log" 2>&1 || true
fi
[ -f .next/BUILD_ID ] && [ -f dist/worker.mjs ] || fail "build" "the release has no built site or worker"
say "packages" "PASS"

PREV="$(readlink "$BASE/current" 2>/dev/null || true)"
ln -sfn "$DIR" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"

start() { pm2 startOrReload "$BASE/current/deploy/ecosystem.config.cjs" --update-env >/dev/null; pm2 save >/dev/null; }
healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    sleep 2
  done
  return 1
}

start
if healthy; then
  say "health" "PASS (http://127.0.0.1:$PORT/api/health)"
else
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    ln -sfn "$PREV" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
    start
    healthy && fail "health" "the new release did not answer; the previous one is running again" || fail "health" "the new release did not answer and the previous one did not come back: look at 'pm2 logs easysign-web'"
  fi
  fail "health" "the new release did not answer (first release, nothing to go back to): look at 'pm2 logs easysign-web'"
fi

# keep the three newest releases and the uploads of this one only
cd "$BASE/releases" && ls -1t | tail -n +4 | while read -r old; do [ "$BASE/releases/$old" = "$(readlink "$BASE/current")" ] || rm -rf "${BASE:?}/releases/$old"; done
rm -f "$INCOMING"/*.tar.gz
say "release" "PASS ($REL is live on 127.0.0.1:$PORT)"
