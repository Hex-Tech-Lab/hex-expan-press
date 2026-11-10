#!/usr/bin/env bash
# schedule_series_capture.sh
# Automated live stream capture & live transcription for "AI Income Challenge with Mark Tilbury"
# Usage: ./scripts/schedule_series_capture.sh <day_number (3|4|5)>

set -euo pipefail

DAY="${1:-}"
if [ -z "$DAY" ]; then
  echo "Usage: $0 <day_number 3|4|5>"
  exit 1
fi

case "$DAY" in
  3)
    URL="https://www.youtube.com/watch?v=wfSFaxHuU7Q"
    TITLE="Day 3: Watch Me Build a \$373/Day Side Hustle in Under 1 Hour"
    # Mon Nov 09, 2026 20:00 Cairo (18:00 UTC) -> arm at 19:58 Cairo (17:58 UTC)
    TARGET_EPOCH=1794247080
    ;;
  4)
    URL="https://www.youtube.com/watch?v=6TZs6Ctq8LE"
    TITLE="Day 4: Easiest Way to Make Money Online For Beginners"
    # Tue Nov 10, 2026 20:00 Cairo (18:00 UTC) -> arm at 19:58 Cairo (17:58 UTC)
    TARGET_EPOCH=1794333480
    ;;
  5)
    URL="https://www.youtube.com/watch?v=SFZYaN7TEX8"
    TITLE="Day 5: Copy & Paste This AI Side Hustle to Make \$11,290/Month"
    # Sun Nov 15, 2026 20:00 Cairo (18:00 UTC) -> arm at 19:58 Cairo (17:58 UTC)
    TARGET_EPOCH=1794765480
    ;;
  *)
    echo "Unknown day: $DAY. Valid options: 3, 4, 5"
    exit 1
    ;;
esac

ROOT="/home/kellyb_dev/projects/hex-expan"
DIR="$ROOT/downloads/ai_income_challenge/day$DAY"
mkdir -p "$DIR"
LOG="$DIR/scheduler.log"

echo "[sched] Starting automated capture workflow for Day $DAY ($TITLE)" >> "$LOG"
echo "[sched] Target URL: $URL" >> "$LOG"

# 1. Sleep until target epoch (19:58 Cairo / 2 mins before live start)
NOW=$(date +%s)
if [ "$NOW" -lt "$TARGET_EPOCH" ]; then
  SLEEP_SECS=$((TARGET_EPOCH - NOW))
  echo "[sched] Current time $(date). Sleeping ${SLEEP_SECS}s until arm time (19:58 Cairo)..." >> "$LOG"
  sleep "$SLEEP_SECS"
fi

# 2. Poll for stream start (timeout after 2.5 hours if live never starts)
MAX_WAIT_EPOCH=$((TARGET_EPOCH + 9000))
IS_LIVE=""
echo "[sched] Arming live detector at $(date)..." >> "$LOG"

while [ "$(date +%s)" -lt "$MAX_WAIT_EPOCH" ]; do
  STATUS=$(timeout 60 /home/kellyb_dev/.local/bin/yt-dlp --no-update --js-runtimes node --no-playlist --skip-download --print "%(live_status)s" "$URL" 2>/dev/null || echo "not_ready")
  echo "[sched] Status check: $STATUS at $(date)" >> "$LOG"
  if [ "$STATUS" = "is_live" ] || [ "$STATUS" = "was_live" ]; then
    IS_LIVE="true"
    break
  fi
  sleep 30
done

if [ -z "$IS_LIVE" ]; then
  echo "[sched] Timeout waiting for stream to go live. Exiting." >> "$LOG"
  exit 1
fi

echo "[sched] STREAM IS LIVE! Initiating capture at $(date)..." >> "$LOG"

# 3. Launch live audio recording
/home/kellyb_dev/.local/bin/yt-dlp \
  --no-update --js-runtimes node --no-playlist --live-from-start \
  -N 16 -f "140/234/bestaudio" \
  --socket-timeout 30 --retries 20 --fragment-retries 25 --skip-unavailable-fragments \
  -o "$DIR/day${DAY}_audio.m4a" "$URL" >> "$DIR/audio_rec.log" 2>&1 &
PID_AUDIO=$!

# 4. Launch live video recording (best 1080p60)
/home/kellyb_dev/.local/bin/yt-dlp \
  --no-update --js-runtimes node --no-playlist --live-from-start \
  -N 8 -f "bestvideo[height<=1080]+bestaudio/best" --merge-output-format mp4 \
  --socket-timeout 30 --retries 20 --fragment-retries 25 --skip-unavailable-fragments \
  -o "$DIR/day${DAY}_1080p.mp4" "$URL" >> "$DIR/video_rec.log" 2>&1 &
PID_VIDEO=$!

# 5. Launch live transcription & real-time blob sync
sleep 15
/home/kellyb_dev/projects/hex-expan/node_modules/.bin/tsx \
  /home/kellyb_dev/projects/hex-expan/scripts/blob_live_sync_daemon.ts "$DAY" \
  >> "$DIR/blob_sync.log" 2>&1 &
PID_BLOB=$!

echo "[sched] All capture processes launched for Day $DAY (video: $PID_VIDEO, audio: $PID_AUDIO, blob_sync: $PID_BLOB)." >> "$LOG"

# 6. Monitor completion and execute post-capture packaging
echo "[sched] Monitoring stream completion..." >> "$LOG"
wait "$PID_VIDEO" 2>/dev/null || true
echo "[sched] Video recorder exited at $(date). Waiting for audio recorder..." >> "$LOG"
wait "$PID_AUDIO" 2>/dev/null || true

echo "[sched] Stream concluded. Starting post-capture packaging at $(date)..." >> "$LOG"

# Extract high-quality MP3 from m4a or mp4
if [ -f "$DIR/day${DAY}_audio.m4a" ] && [ ! -f "$DIR/day${DAY}_audio.mp3" ]; then
  echo "[sched] Extracting high-quality MP3 from audio m4a..." >> "$LOG"
  /home/kellyb_dev/.local/bin/ffmpeg -y -i "$DIR/day${DAY}_audio.m4a" -vn -c:a libmp3lame -q:a 2 "$DIR/day${DAY}_audio.mp3" >> "$LOG" 2>&1 || true
elif [ -f "$DIR/day${DAY}_1080p.mp4" ] && [ ! -f "$DIR/day${DAY}_audio.mp3" ]; then
  echo "[sched] Extracting high-quality MP3 from video mp4..." >> "$LOG"
  /home/kellyb_dev/.local/bin/ffmpeg -y -i "$DIR/day${DAY}_1080p.mp4" -vn -c:a libmp3lame -q:a 2 "$DIR/day${DAY}_audio.mp3" >> "$LOG" 2>&1 || true
fi

# Run dual transcription (accurate 1s + clean plain text)
echo "[sched] Generating full 1s accurate and clean transcripts..." >> "$LOG"
/home/kellyb_dev/projects/hex-expan/node_modules/.bin/tsx \
  /home/kellyb_dev/projects/hex-expan/scripts/generate_accurate_timestamps.ts "$DAY" >> "$LOG" 2>&1 || true

PART_TRANS="$DIR/transcript_day${DAY}_audio.m4a.part.md"
if [ -f "$PART_TRANS" ] && [ ! -f "$DIR/day${DAY}_transcript.md" ]; then
  cp "$PART_TRANS" "$DIR/day${DAY}_transcript.md"
fi

# Upload complete package to Upstash Blob if token is set
if [ -f "$ROOT/.env" ] && grep -q "UPSTASH_BLOB_TOKEN" "$ROOT/.env"; then
  echo "[sched] Uploading day package to Upstash Blob..." >> "$LOG"
  $ROOT/node_modules/.bin/tsx "$ROOT/scripts/upload_day_package.ts" "$DAY" >> "$LOG" 2>&1 || true
fi

# Sync to Google Drive via rclone if configured
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q "gdrive:"; then
  echo "[sched] Syncing to Google Drive..." >> "$LOG"
  rclone copy "$DIR" gdrive:AI_Income_Challenge/day${DAY} --progress >> "$LOG" 2>&1 || true
fi

touch "$DIR/DAY${DAY}_COMPLETE"
echo "[sched] DAY $DAY COMPLETE at $(date)" >> "$LOG"
