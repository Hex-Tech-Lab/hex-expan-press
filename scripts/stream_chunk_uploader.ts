import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import dotenv from "dotenv";
import { uploadMedia } from "../lib/blob.ts";
import { transcribeFile, ts } from "../transcribe.ts";

dotenv.config({ override: true });

interface UploaderState {
  processedChunks: string[];
  lastUpdated: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let chunksDir = "";
  let day = "3";
  let doneFile = "";
  let chunkSeconds = 300;

  for (const a of args) {
    if (a.startsWith("--dir=")) chunksDir = a.split("=")[1];
    else if (a.startsWith("--day=")) day = a.split("=")[1];
    else if (a.startsWith("--done=")) doneFile = a.split("=")[1];
    else if (a.startsWith("--chunk-seconds=")) chunkSeconds = Number(a.split("=")[1]) || 300;
  }

  if (!chunksDir) {
    console.error("Usage: tsx scripts/stream_chunk_uploader.ts --dir=<chunks_dir> --day=<day> --done=<done_file>");
    process.exit(1);
  }

  return { chunksDir, day, doneFile, chunkSeconds };
}

async function uploadToBlob(localPath: string, blobKey: string, contentType: string) {
  if (!process.env.UPSTASH_BLOB_TOKEN) {
    console.warn(`[uploader] UPSTASH_BLOB_TOKEN missing, skipping blob upload for ${blobKey}`);
    return;
  }
  try {
    const stat = fs.statSync(localPath);
    let data: any;
    if (stat.size < 50 * 1024 * 1024) {
      data = fs.readFileSync(localPath);
    } else {
      const nodeStream = fs.createReadStream(localPath);
      data = (await import("node:stream")).Readable.toWeb(nodeStream);
    }
    const res = await uploadMedia(blobKey, data, {
      contentType,
      size: stat.size,
      allowOverwrite: true,
    });
    console.log(`[uploader] Blob uploaded: ${blobKey} (${stat.size} bytes, etag: ${res.etag || "ok"})`);
  } catch (err) {
    console.error(`[uploader] Failed to upload ${localPath} to blob ${blobKey}:`, err);
  }
}

function syncToDrive(localPath: string, remoteDest: string) {
  try {
    execFileSync("rclone", ["copy", localPath, remoteDest], { stdio: "ignore" });
    console.log(`[uploader] Rclone synced ${path.basename(localPath)} -> ${remoteDest}`);
  } catch (err) {
    // Non-fatal if rclone fails or not configured
    console.warn(`[uploader] Rclone sync notice: ${(err as Error).message}`);
  }
}

async function main() {
  const { chunksDir, day, doneFile, chunkSeconds } = parseArgs();
  const dayDir = path.dirname(chunksDir);
  const statePath = path.join(dayDir, "uploader_state.json");
  const liveTranscriptPath = path.join(dayDir, "live_transcript.md");

  fs.mkdirSync(chunksDir, { recursive: true });

  let state: UploaderState = { processedChunks: [], lastUpdated: new Date().toISOString() };
  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    } catch {
      // fresh state
    }
  }

  if (!fs.existsSync(liveTranscriptPath)) {
    fs.writeFileSync(liveTranscriptPath, `# AI Income Challenge — Day ${day} Live Transcript (Accurate 1s Timestamps)\n\n`);
  }

  console.log(`[uploader] Watching chunks directory: ${chunksDir} for Day ${day}...`);

  let isDone = false;
  while (!isDone) {
    const isRecorderFinished = doneFile && fs.existsSync(doneFile);
    const files = fs.readdirSync(chunksDir)
      .filter((f) => f.startsWith("chunk_") && f.endsWith(".mp4"))
      .sort();

    for (let i = 0; i < files.length; i++) {
      const chunkFile = files[i];
      if (state.processedChunks.includes(chunkFile)) continue;

      // A chunk is sealed if a subsequent chunk exists OR the recorder has finished
      const isSealed = i < files.length - 1 || isRecorderFinished;
      if (!isSealed) continue;

      const chunkPath = path.join(chunksDir, chunkFile);
      const stat = fs.statSync(chunkPath);
      if (stat.size === 0) continue;

      console.log(`\n[uploader] === Processing sealed chunk: ${chunkFile} (${(stat.size / 1024 / 1024).toFixed(1)} MB) ===`);

      // 1. Upload video chunk to Upstash Blob
      const blobVideoKey = `ai_income_challenge/day${day}/chunks/${chunkFile}`;
      await uploadToBlob(chunkPath, blobVideoKey, "video/mp4");

      // 2. Extract audio chunk
      const audioFile = chunkFile.replace(/\.mp4$/, ".mp3");
      const audioPath = path.join(chunksDir, audioFile);
      if (!fs.existsSync(audioPath)) {
        try {
          execFileSync("ffmpeg", ["-y", "-i", chunkPath, "-vn", "-c:a", "libmp3lame", "-q:a", "2", audioPath], { stdio: "ignore" });
        } catch (e) {
          console.error(`[uploader] ffmpeg audio extraction failed for ${chunkFile}:`, e);
        }
      }

      // 3. Upload audio chunk to Upstash Blob
      if (fs.existsSync(audioPath)) {
        const blobAudioKey = `ai_income_challenge/day${day}/chunks/${audioFile}`;
        await uploadToBlob(audioPath, blobAudioKey, "audio/mpeg");
      }

      // 4. Transcribe audio chunk with exact 1-second timestamps
      if (process.env.OPENROUTER_API_KEY && fs.existsSync(audioPath)) {
        try {
          const chunkIdxMatch = chunkFile.match(/chunk_(\d+)\.mp4/);
          const chunkIdx = chunkIdxMatch ? parseInt(chunkIdxMatch[1], 10) : i;
          const baseSec = chunkIdx * chunkSeconds;

          console.log(`[uploader] Transcribing ${audioFile} (offset: ${ts(baseSec)})...`);
          const r = await transcribeFile(audioPath);

          let block = "";
          if (r.segments && r.segments.length > 0) {
            block = r.segments.map((s) => `- [${ts(baseSec + s.start)}] ${s.text.trim()}`).join("\n");
          } else if (r.text && r.text.trim()) {
            block = `- [${ts(baseSec)}] ${r.text.trim()}`;
          }

          if (block) {
            fs.appendFileSync(liveTranscriptPath, `\n## [${ts(baseSec)} - ${ts(baseSec + chunkSeconds)}]\n${block}\n`);
            console.log(`[uploader] Appended transcribed segment to ${path.basename(liveTranscriptPath)}`);
            // Update live transcript in Upstash Blob
            const transcriptBuf = fs.readFileSync(liveTranscriptPath);
            await uploadToBlob(liveTranscriptPath, `ai_income_challenge/day${day}/live_transcript.md`, "text/markdown");
          }
        } catch (err) {
          console.error(`[uploader] Transcription failed for ${audioFile}:`, err);
        }
      }

      // 5. Sync to Google Drive
      syncToDrive(chunkPath, `gdrive:AI_Income_Challenge/day${day}/chunks/`);
      if (fs.existsSync(audioPath)) {
        syncToDrive(audioPath, `gdrive:AI_Income_Challenge/day${day}/chunks/`);
      }
      syncToDrive(liveTranscriptPath, `gdrive:AI_Income_Challenge/day${day}/`);

      // 6. Record progress in state
      state.processedChunks.push(chunkFile);
      state.lastUpdated = new Date().toISOString();
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }

    if (isRecorderFinished) {
      // Check if all found chunks have been processed
      const allDone = files.every((f) => state.processedChunks.includes(f));
      if (allDone) {
        console.log(`[uploader] All ${files.length} chunks processed and recorder finished. Beginning final assembly...`);
        isDone = true;
        break;
      }
    }

    // Sleep 5 seconds before next polling iteration
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Final Assembly
  const allChunks = fs.readdirSync(chunksDir)
    .filter((f) => f.startsWith("chunk_") && f.endsWith(".mp4"))
    .sort();

  if (allChunks.length > 0) {
    const concatListFile = path.join(dayDir, "concat_list.txt");
    const concatContent = allChunks.map((f) => `file 'chunks/${f}'`).join("\n");
    fs.writeFileSync(concatListFile, concatContent);

    const finalVideoPath = path.join(dayDir, `day${day}_1080p.mp4`);
    const finalAudioPath = path.join(dayDir, `day${day}_audio.mp3`);
    const finalTranscriptPath = path.join(dayDir, `day${day}_transcript.md`);

    console.log(`[uploader] Concatenating ${allChunks.length} chunks into ${path.basename(finalVideoPath)}...`);
    try {
      execSync(`ffmpeg -y -f concat -safe 0 -i "${concatListFile}" -c copy "${finalVideoPath}"`, { stdio: "inherit" });
      execSync(`ffmpeg -y -i "${finalVideoPath}" -vn -c:a libmp3lame -q:a 2 "${finalAudioPath}"`, { stdio: "inherit" });
      fs.copyFileSync(liveTranscriptPath, finalTranscriptPath);

      // Upload final package to Upstash Blob and Google Drive
      console.log(`[uploader] Uploading final complete artifacts...`);
      await uploadToBlob(finalAudioPath, `ai_income_challenge/day${day}/day${day}_audio.mp3`, "audio/mpeg");
      await uploadToBlob(finalTranscriptPath, `ai_income_challenge/day${day}/day${day}_transcript.md`, "text/markdown");
      syncToDrive(finalAudioPath, `gdrive:AI_Income_Challenge/day${day}/`);
      syncToDrive(finalTranscriptPath, `gdrive:AI_Income_Challenge/day${day}/`);
      syncToDrive(finalVideoPath, `gdrive:AI_Income_Challenge/day${day}/`);
      console.log(`[uploader] Final assembly and cloud distribution complete for Day ${day}!`);
    } catch (err) {
      console.error(`[uploader] Final concatenation error:`, err);
    }
  }
}

main().catch((err) => {
  console.error("[uploader] Fatal error:", err);
  process.exit(1);
});
