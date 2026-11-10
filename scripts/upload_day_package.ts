#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import { blob, uploadMedia } from "../lib/blob.ts";

dotenv.config({ override: true });

const DAY = process.argv[2] ? parseInt(process.argv[2], 10) : 3;
const DIR = path.resolve(`downloads/ai_income_challenge/day${DAY}`);

async function uploadFile(localPath: string, blobKey: string, contentType: string) {
  if (!fs.existsSync(localPath)) return;
  const stat = fs.statSync(localPath);
  if (stat.size === 0) return;

  console.log(`[upload-pkg] Uploading ${path.basename(localPath)} (${(stat.size / 1024 / 1024).toFixed(2)} MB)...`);

  if (stat.size > 16 * 1024 * 1024) {
    const webStream = Readable.toWeb(fs.createReadStream(localPath));
    await uploadMedia(blobKey, webStream as any, {
      contentType,
      size: stat.size,
      allowOverwrite: true,
    });
  } else {
    const buf = fs.readFileSync(localPath);
    await blob.put(blobKey, buf, {
      contentType,
      allowOverwrite: true,
    });
  }
  console.log(`[upload-pkg] Uploaded: ${blobKey}`);
}

async function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`[upload-pkg] Directory not found: ${DIR}`);
    process.exit(1);
  }

  console.log(`[upload-pkg] Starting packaging upload for Day ${DAY}...`);

  const filesToUpload = [
    { file: `day${DAY}_1080p.mp4`, type: "video/mp4" },
    { file: `day${DAY}_audio.m4a`, type: "audio/mp4" },
    { file: `day${DAY}_audio.mp3`, type: "audio/mpeg" },
    { file: `day${DAY}_transcript_accurate_1s.md`, type: "text/markdown" },
    { file: `day${DAY}_transcript.md`, type: "text/markdown" },
    { file: "audio_rec.log", type: "text/plain" },
    { file: "video_rec.log", type: "text/plain" },
    { file: "scheduler.log", type: "text/plain" },
  ];

  for (const item of filesToUpload) {
    const fullPath = path.join(DIR, item.file);
    if (fs.existsSync(fullPath)) {
      try {
        await uploadFile(fullPath, `ai_income_challenge/day${DAY}/${item.file}`, item.type);
      } catch (err) {
        console.error(`[upload-pkg] Error uploading ${item.file}:`, (err as Error).message);
      }
    }
  }

  console.log(`[upload-pkg] Completed packaging upload for Day ${DAY}.`);
}

main().catch((err) => {
  console.error("[upload-pkg] Fatal error:", err);
  process.exit(1);
});
