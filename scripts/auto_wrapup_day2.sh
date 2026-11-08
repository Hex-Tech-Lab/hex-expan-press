#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/kellyb_dev/projects/hex-expan"
DL="$ROOT/downloads/live_20261108"
OUT_DIR="$ROOT/downloads/ai_income_challenge/day2"
ALT_DIR="$ROOT/downloads/day2"
LOG="$OUT_DIR/wrapup.log"
mkdir -p "$OUT_DIR" "$ALT_DIR"

echo "[wrapup] Monitor started at $(date)" >> "$LOG"

# Wait for watchdog or recorders to indicate stream completion
while true; do
  if [ -f "$DL/DONE_gadzhi_live_video" ] || [ -f "$DL/DONE_gadzhi_live_audio" ]; then
    echo "[wrapup] DONE marker detected at $(date)" >> "$LOG"
    break
  fi

  # Secondary check: if both yt-dlp recorders have stopped and live_status is no longer is_live
  if ! pgrep -f "gadzhi_live_audio" > /dev/null 2>&1 && ! pgrep -f "gadzhi_live_video" > /dev/null 2>&1; then
    LIVE=$(timeout 60 /home/kellyb_dev/.local/bin/yt-dlp --no-update --js-runtimes node --no-playlist --skip-download --print "%(live_status)s" "https://www.youtube.com/watch?v=jDgMGSAP0PQ" 2>/dev/null || echo "not_live")
    if [ "$LIVE" != "is_live" ]; then
      echo "[wrapup] Recorders exited and stream ended at $(date)" >> "$LOG"
      break
    fi
  fi

  sleep 20
done

# Give python assemblers 30s to flush the last received fragments
echo "[wrapup] Waiting 30s for assemblers to finish final fragments..." >> "$LOG"
sleep 30

# Kill python assemblers cleanly if still running
pkill -f "assemble_live_audio.py" || true
pkill -f "assemble_live_video.py" || true
sleep 2

VIDEO_SRC="$DL/.assembled_video_track.mp4"
AUDIO_SRC="$DL/gadzhi_live_audio_assembled.m4a"

echo "[wrapup] Remuxing final 1080p60 MP4 with AAC audio..." >> "$LOG"
/home/kellyb_dev/.local/bin/ffmpeg -y -loglevel warning \
  -i "$VIDEO_SRC" -i "$AUDIO_SRC" \
  -c copy -movflags +faststart \
  "$OUT_DIR/day2_live_1080p60.mp4" >> "$LOG" 2>&1

echo "[wrapup] Generating high-quality MP3 audio..." >> "$LOG"
/home/kellyb_dev/.local/bin/ffmpeg -y -loglevel warning \
  -i "$AUDIO_SRC" \
  -c:a libmp3lame -q:a 2 \
  "$OUT_DIR/day2_audio.mp3" >> "$LOG" 2>&1

# Copy to alt day2 and root downloads convenience paths
cp "$OUT_DIR/day2_live_1080p60.mp4" "$ALT_DIR/day2_live_1080p60.mp4" || true
cp "$OUT_DIR/day2_audio.mp3" "$ALT_DIR/day2_audio.mp3" || true
cp "$OUT_DIR/day2_live_1080p60.mp4" "$ROOT/downloads/gadzhi_live_video.mp4" || true
cp "$OUT_DIR/day2_audio.mp3" "$ROOT/downloads/gadzhi_live_audio.mp3" || true

# Wait up to 5 minutes for transcribe.ts to finish the last chunks
echo "[wrapup] Waiting for transcribe.ts to finish final segments..." >> "$LOG"
for i in {1..30}; do
  if ! pgrep -f "transcribe.ts" > /dev/null 2>&1; then
    break
  fi
  sleep 10
done

if [ -f "$ROOT/downloads/transcript_gadzhi_live_audio_assembled.md" ]; then
  cp "$ROOT/downloads/transcript_gadzhi_live_audio_assembled.md" "$OUT_DIR/day2_transcript.md"
  cp "$ROOT/downloads/transcript_gadzhi_live_audio_assembled.md" "$ALT_DIR/day2_transcript.md"
fi

touch "$OUT_DIR/DAY2_COMPLETE"
echo "[wrapup] DAY 2 PACKAGING COMPLETE at $(date)" >> "$LOG"
