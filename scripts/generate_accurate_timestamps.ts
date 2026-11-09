import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";
import { transcribeFile, ts } from "../transcribe.ts";

dotenv.config({ override: true });

async function processAudio(audioPath: string, outPath: string, dayNum: number) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const durationStr = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audioPath],
    { encoding: "utf-8" }
  ).trim();
  const totalDur = parseFloat(durationStr) || 0;
  console.log(`[accurate-ts] Processing Day ${dayNum} (${audioPath}): ${totalDur.toFixed(1)}s total duration...`);

  fs.writeFileSync(
    outPath,
    `# AI Income Challenge — Day ${dayNum} High-Precision Transcript (1-Second Timestamps)\n\n`
  );

  const chunkSeconds = 300;
  const tempDir = path.join(path.dirname(audioPath), "temp_chunks");
  fs.mkdirSync(tempDir, { recursive: true });

  const numChunks = Math.ceil(totalDur / chunkSeconds);
  for (let i = 0; i < numChunks; i++) {
    const startSec = i * chunkSeconds;
    const dur = Math.min(chunkSeconds, totalDur - startSec);
    const chunkFile = path.join(tempDir, `chunk_${String(i).padStart(4, "0")}.mp3`);

    console.log(`[accurate-ts] Chunk ${i + 1}/${numChunks} [${ts(startSec)} - ${ts(startSec + dur)}]...`);

    // Extract chunk
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel", "error",
        "-ss", String(startSec),
        "-i", audioPath,
        "-t", String(dur),
        "-c:a", "libmp3lame",
        "-b:a", "64k",
        "-ar", "16000",
        "-ac", "1",
        chunkFile,
      ],
      { stdio: "ignore" }
    );

    try {
      const res = await transcribeFile(chunkFile);
      let block = "";
      if (res.segments && res.segments.length > 0) {
        block = res.segments
          .map((s) => `- [${ts(startSec + s.start)}] ${s.text.trim()}`)
          .join("\n");
      } else if (res.text && res.text.trim()) {
        block = `- [${ts(startSec)}] ${res.text.trim()}`;
      }

      if (block) {
        fs.appendFileSync(
          outPath,
          `\n## [${ts(startSec)} - ${ts(startSec + dur)}]\n${block}\n`
        );
      }
    } catch (err) {
      console.error(`[accurate-ts] Error transcribing chunk ${i}:`, err);
    } finally {
      if (fs.existsSync(chunkFile)) {
        fs.unlinkSync(chunkFile);
      }
    }
  }

  try {
    fs.rmdirSync(tempDir);
  } catch {}

  console.log(`[accurate-ts] Completed Day ${dayNum} accurate transcript: ${outPath}`);
}

async function main() {
  const targetDay = process.argv[2] ? parseInt(process.argv[2], 10) : 1;
  const customFile = process.argv[3];
  let audioFile = customFile ? path.resolve(customFile) : path.resolve(`downloads/ai_income_challenge/day${targetDay}/day${targetDay}_audio.mp3`);
  if (!fs.existsSync(audioFile)) {
    const m4aFile = path.resolve(`downloads/ai_income_challenge/day${targetDay}/current_assembled_day${targetDay}_audio.m4a`);
    if (fs.existsSync(m4aFile)) audioFile = m4aFile;
  }
  const outFile = path.resolve(`downloads/ai_income_challenge/day${targetDay}/day${targetDay}_transcript_accurate_1s.md`);

  await processAudio(audioFile, outFile, targetDay);
}

main().catch((err) => {
  console.error("[accurate-ts] Fatal:", err);
  process.exit(1);
});
