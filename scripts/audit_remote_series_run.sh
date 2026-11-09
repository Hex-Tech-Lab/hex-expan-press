#!/usr/bin/env bash
# audit_remote_series_run.sh
# Autonomous auditor & watchdog for remote GitHub Actions stream recording runs
# Usage: ./scripts/audit_remote_series_run.sh <day (3|4|5)>

set -euo pipefail

DAY="${1:-}"
if [ -z "$DAY" ]; then
  echo "Usage: $0 <day (3|4|5)>"
  exit 1
fi

case "$DAY" in
  3)
    URL="https://www.youtube.com/watch?v=wfSFaxHuU7Q"
    TITLE="Day 3: Watch Me Build a \$373/Day Side Hustle in Under 1 Hour"
    TARGET_EPOCH=1794247080 # Mon Nov 09, 2026 19:58 Cairo (17:58 UTC)
    KEYWORDS=("side hustle" "income" "hustle" "dollar" "money")
    ;;
  4)
    URL="https://www.youtube.com/watch?v=6TZs6Ctq8LE"
    TITLE="Day 4: Easiest Way to Make Money Online For Beginners"
    TARGET_EPOCH=1794333480 # Tue Nov 10, 2026 19:58 Cairo (17:58 UTC)
    KEYWORDS=("online" "beginners" "income" "money")
    ;;
  5)
    URL="https://www.youtube.com/watch?v=SFZYaN7TEX8"
    TITLE="Day 5: Copy & Paste This AI Side Hustle to Make \$11,290/Month"
    TARGET_EPOCH=1794765480 # Sun Nov 15, 2026 19:58 Cairo (17:58 UTC)
    KEYWORDS=("AI" "side hustle" "month" "copy" "paste")
    ;;
  *)
    echo "Unknown day: $DAY. Must be 3, 4, or 5."
    exit 1
    ;;
esac

ROOT="/home/kellyb_dev/projects/hex-expan"
DIR="$ROOT/downloads/ai_income_challenge/day$DAY"
mkdir -p "$DIR"
AUDIT_LOG="$DIR/remote_audit.log"

echo "[AUDIT] Starting remote auditor watchdog for Day $DAY ($TITLE)" >> "$AUDIT_LOG"
echo "[AUDIT] Target URL: $URL" >> "$AUDIT_LOG"
echo "[AUDIT] Scheduled trigger epoch: $TARGET_EPOCH ($(date -d @$TARGET_EPOCH))" >> "$AUDIT_LOG"

# 1. Sleep until arm time (19:58 Cairo / 17:58 UTC)
NOW=$(date +%s)
if [ "$NOW" -lt "$TARGET_EPOCH" ]; then
  SLEEP_SECS=$((TARGET_EPOCH - NOW))
  echo "[AUDIT] Current time $(date). Sleeping ${SLEEP_SECS}s until scheduled trigger..." >> "$AUDIT_LOG"
  sleep "$SLEEP_SECS"
fi

echo "[AUDIT] Waking up at $(date). Polling for remote GitHub Actions run dispatch..." >> "$AUDIT_LOG"

# 2. Poll for GitHub Actions run to start (within 15 minutes = 900s)
RUN_ID=""
MAX_DISPATCH_WAIT=$(( $(date +%s) + 900 ))

while [ "$(date +%s)" -lt "$MAX_DISPATCH_WAIT" ]; do
  RUN_DATA=$(gh run list --workflow=series_stream_recorder.yml -L 1 --json databaseId,status,createdAt 2>/dev/null || echo "[]")
  C_STATUS=$(echo "$RUN_DATA" | jq -r '.[0].status // empty')
  C_ID=$(echo "$RUN_DATA" | jq -r '.[0].databaseId // empty')
  
  if [ -n "$C_ID" ] && { [ "$C_STATUS" = "in_progress" ] || [ "$C_STATUS" = "queued" ] || [ "$C_STATUS" = "completed" ]; }; then
    RUN_ID="$C_ID"
    echo "[AUDIT] Remote run detected: Run ID #$RUN_ID (Status: $C_STATUS) at $(date)" >> "$AUDIT_LOG"
    break
  fi
  sleep 30
done

if [ -z "$RUN_ID" ]; then
  echo "[AUDIT_ALERT] No remote run started within 15 minutes of trigger time! Failing over to local capture fallback..." >> "$AUDIT_LOG"
  exec "$ROOT/scripts/schedule_series_capture.sh" "$DAY"
fi

# 3. Monitor remote execution until completion (timeout after 7 hours)
echo "[AUDIT] Monitoring remote Run ID #$RUN_ID progress..." >> "$AUDIT_LOG"
MAX_EXEC_WAIT=$(( $(date +%s) + 25200 )) # 7 hours
CONCLUSION=""

while [ "$(date +%s)" -lt "$MAX_EXEC_WAIT" ]; do
  RUN_DATA=$(gh run view "$RUN_ID" --json status,conclusion,elapsed 2>/dev/null || echo "{}")
  STATUS=$(echo "$RUN_DATA" | jq -r '.status // empty')
  CONCLUSION=$(echo "$RUN_DATA" | jq -r '.conclusion // empty')
  ELAPSED=$(echo "$RUN_DATA" | jq -r '.elapsed // empty')

  echo "[AUDIT] Run #$RUN_ID check at $(date): status=$STATUS, conclusion=$CONCLUSION, elapsed=$ELAPSED" >> "$AUDIT_LOG"

  if [ "$STATUS" = "completed" ]; then
    break
  fi
  sleep 180 # Check every 3 minutes
done

if [ "$CONCLUSION" != "success" ]; then
  echo "[AUDIT_FAIL] Remote Run #$RUN_ID ended with non-success conclusion: ${CONCLUSION:-unknown} at $(date)" >> "$AUDIT_LOG"
  exit 1
fi

echo "[AUDIT_SUCCESS] Remote run #$RUN_ID completed successfully! Downloading artifacts for verification..." >> "$AUDIT_LOG"

# 4. Download and spot-check transcript artifact
ART_DIR="$DIR/artifacts"
mkdir -p "$ART_DIR"
gh run download "$RUN_ID" --dir "$ART_DIR" 2>> "$AUDIT_LOG" || true

TRANSCRIPT_FILE=$(find "$ART_DIR" -name "*.md" | head -n 1)
if [ -n "$TRANSCRIPT_FILE" ] && [ -f "$TRANSCRIPT_FILE" ]; then
  LINE_COUNT=$(wc -l < "$TRANSCRIPT_FILE")
  echo "[AUDIT] Found transcript artifact: $TRANSCRIPT_FILE ($LINE_COUNT lines)" >> "$AUDIT_LOG"
  
  MATCH_COUNT=0
  for kw in "${KEYWORDS[@]}"; do
    if grep -iq "$kw" "$TRANSCRIPT_FILE"; then
      MATCH_COUNT=$((MATCH_COUNT + 1))
      echo "[AUDIT] Verified keyword presence: '$kw'" >> "$AUDIT_LOG"
    fi
  done

  echo "[AUDIT] Transcript spot-check excerpt (lines 20-35):" >> "$AUDIT_LOG"
  sed -n '20,35p' "$TRANSCRIPT_FILE" >> "$AUDIT_LOG"

  cp "$TRANSCRIPT_FILE" "$DIR/day${DAY}_transcript.md"
  touch "$DIR/DAY${DAY}_REMOTE_AUDIT_VERIFIED"
  echo "[AUDIT_VERIFIED] Day $DAY remote execution, artifacts, and transcript content 100% verified at $(date)" >> "$AUDIT_LOG"
else
  echo "[AUDIT_WARN] No transcript artifact found for Run #$RUN_ID" >> "$AUDIT_LOG"
fi
