#!/bin/bash
# Developer use only: OverlayDemo's scripted checks on this Mac, against a bridge already running
# (overlay-bridge.mjs; its log's `ready` line has the sign-in link). Launches the stand-in host window
# and the overlays with `open -n -g` (the logged-in GUI session), waits for the results, quits both.
#   overlay-check.sh <bridge log> <results dir> [helper: standin|real] [extra OverlayDemo args...]
# Takes the shared GUI lock (~/.orbit-mac-test.lock) for the run.
set -u
LOG="$1"; OUT="$2"; HELPER="${3:-standin}"; shift 3 || shift $#
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HERE/.build/OverlayDemo.app"
BIN="$APP/Contents/MacOS/OverlayDemo"
LOCK="$HOME/.orbit-mac-test.lock"
mkdir -p "$OUT"
AUTH=$(grep -o '"main":"[^"]*"' "$LOG" | head -1 | sed 's/"main":"//; s/"$//')
[ -n "$AUTH" ] || { echo "no sign-in link in $LOG"; exit 2; }

# The lock: wait while another fresh one is held; a stale one (45 min) is removed.
for i in $(seq 1 90); do
  if [ -f "$LOCK" ] && [ $(( $(date +%s) - $(stat -f %m "$LOCK") )) -gt 2700 ]; then rm -f "$LOCK"; fi
  if ( set -o noclobber; echo "agent-overlays $$ $(date -u +%FT%TZ)" > "$LOCK" ) 2>/dev/null; then break; fi
  [ "$i" = 90 ] && { echo "lock busy: $(cat "$LOCK")"; exit 3; }
  sleep 20
done
STANDIN=""; DEMO=""
# The display may be asleep (no animation frames then): keep it awake for the run (a power
# assertion only; it ends with the run).
caffeinate -u -t 600 & CAF=$!
cleanup() {
  kill "$CAF" 2>/dev/null
  [ -n "$DEMO" ] && kill "$DEMO" 2>/dev/null
  [ -n "$STANDIN" ] && kill "$STANDIN" 2>/dev/null
  sleep 1
  pkill -f "$BIN" 2>/dev/null
  rm -f "$LOCK"
}
trap cleanup EXIT

before=$(pgrep -f "$BIN stand-in" | tr '\n' ' ')
open -n -g "$APP" --args stand-in --frame 140,160,1000,640
for i in $(seq 1 50); do
  for p in $(pgrep -f "$BIN stand-in"); do
    [[ " $before " == *" $p "* ]] || STANDIN=$p
  done
  [ -n "$STANDIN" ] && break; sleep 0.2
done
echo "stand-in pid $STANDIN"
sleep 1.5
ENVS=(--env "ORBIT_TEST_CLAUDE_PID=$STANDIN")
if [ "$HELPER" = standin ]; then ENVS+=(--env "ORBIT_CLAUDE_HELPER=$BIN"); else ENVS+=(--env "ORBIT_CLAUDE_HELPER=$HERE/../orbit-helper"); fi
rm -f "$OUT/results.json"
open -n -g "${ENVS[@]}" --stdout "$OUT/demo.log" --stderr "$OUT/demo.err" "$APP" --args --auth "$AUTH" --check "$OUT/results.json" --shots "$OUT" "$@"
sleep 1
DEMO=$(pgrep -f "$BIN --auth" | head -1)
for i in $(seq 1 120); do [ -f "$OUT/results.json" ] && break; sleep 1; done
sleep 1
[ -f "$OUT/results.json" ] && cat "$OUT/results.json" || { echo "no results"; tail -30 "$OUT/demo.log"; }
