#!/usr/bin/env bash
# Stall watchdog for an agent log (plan point 8).
#   scripts/agent_watch.sh <log file> [minutes=6]
# Every 60s: if the log has not grown for N minutes, OR its last 40 lines
# repeat the same command line 3+ times, ask Jev noul `stalled` on the tail
# and print STALLED with p (never kills anything; the orchestrator decides).
# Exits when the process writing the log is gone (or after the log is idle
# for N minutes with Jev down -> print STALLED unknown as fallback behaviour).
# --no-jev skips the Jev call (size/loop checks still print STALLED).
set -u

LOG="${1:-}"
MINS="${2:-6}"
NO_JEV=0
for a in "$@"; do [ "$a" = "--no-jev" ] && NO_JEV=1; done
[ -z "$LOG" ] && { echo "usage: agent_watch.sh <log file> [minutes=6] [--no-jev]" >&2; exit 2; }
[ -f "$LOG" ] || { echo "agent_watch: no such log: $LOG" >&2; exit 2; }
LOG="$([ "${LOG#/}" = "$LOG" ] && pwd)/$LOG"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCHER_PID="$PPID"

idle_strikes=0
while true; do
  sleep 60
  # writer gone? (watcher shell or a python process whose command line names the log)
  if ! kill -0 "$WATCHER_PID" 2>/dev/null; then
    echo "writer process gone; watchdog exiting"
    exit 0
  fi
  size1=$(stat -c %s "$LOG")
  sleep 2
  size2=$(stat -c %s "$LOG")
  now=$(date +%s)
  mtime=$(stat -c %Y "$LOG")
  idle_min=$(( (now - mtime) / 60 ))

  # last 40 lines: same command repeated 3+ times?
  rep=$(tail -40 "$LOG" | sed 's/^[$] //' | grep -v '^$' | sort | uniq -c | sort -rn | head -1 | sed 's/^ *//')
  repcount=${rep%% *}
  [ -z "$rep" ] && repcount=0
  [ "${rep#* }" = "${rep}" ] && repln=""
  repln=$(tail -40 "$LOG" | sed 's/^[$] //' | grep -v '^$' | sort | uniq -c | sort -rn | head -1 | cut -d' ' -f2-)

  stalled=0; reason=""
  if [ "$idle_min" -ge "$MINS" ]; then stalled=1; reason="idle ${idle_min}m >= ${MINS}m"; fi
  if [ "$repcount" -ge 3 ]; then stalled=1; reason="same line x${repcount}: ${repln:0:80}"; fi
  if [ "$stalled" = 0 ]; then idle_strikes=0; continue; fi

  tail_txt=$(tail -c 4000 "$LOG")
  if [ "$NO_JEV" = 1 ]; then
    echo "STALLED p=unknown (jev off) reason: $reason"
    continue
  fi
  p=$(python3 - "$REPO" "$tail_txt" <<'EOF'
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / "scripts"))
from jev import decide
tail = sys.argv[2]
a = decide({"agent_log_tail": tail}, {"stalled": {"type": "noul",
    "instructions": "This is the tail of an agent's work log. Is the agent stalled (stuck repeating itself, "
                    "or producing nothing for a long time), rather than just verbose?",
    "criteria": {"true": "Evidence of being stuck: identical commands repeated, an error loop, or no progress.",
                 "false": "Work is progressing normally."}}}, timeout=20)
print(json.dumps(a["stalled"]["noul"]) if a and "stalled" in a else "unknown")
EOF
) 2>/dev/null || p=unknown
  echo "STALLED p=$p reason: $reason"
  # keep watching; the orchestrator decides
done
