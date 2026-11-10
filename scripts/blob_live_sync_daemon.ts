import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { blob } from "../lib/blob.ts";

dotenv.config({ override: true });

const DAY = process.argv[2] ? parseInt(process.argv[2], 10) : 3;
const WATCH_DIR = path.resolve(`downloads/ai_income_challenge/day${DAY}`);
const STATE_FILE = path.join(WATCH_DIR, ".blob_synced_fragments.json");
const CONCURRENCY = 10;

let syncedSet = new Set<string>();
if (fs.existsSync(STATE_FILE)) {
  try {
    const list = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as string[];
    syncedSet = new Set(list);
  } catch {}
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(Array.from(syncedSet)));
  } catch {}
}

async function uploadFile(localPath: string, blobKey: string, contentType = "application/octet-stream") {
  const stat = fs.statSync(localPath);
  if (stat.size === 0) return;
  const buf = fs.readFileSync(localPath);
  await blob.put(blobKey, buf, {
    contentType,
    allowOverwrite: true,
  });
}

async function syncLogs() {
  const logs = ["audio_rec.log", "video_rec.log", "scheduler.log", "remote_audit.log", "FAILOVER_ALERT.txt"];
  for (const logName of logs) {
    const fullPath = path.join(WATCH_DIR, logName);
    if (fs.existsSync(fullPath)) {
      try {
        await uploadFile(fullPath, `ai_income_challenge/day${DAY}/${logName}`, "text/plain");
      } catch (err) {
        console.error(`[live-sync] Error syncing log ${logName}:`, (err as Error).message);
      }
    }
  }
}

async function processBatch(files: string[]) {
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    chunks.push(files.slice(i, i + CONCURRENCY));
  }

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (file) => {
        const fullPath = path.join(WATCH_DIR, file);
        const blobKey = `ai_income_challenge/day${DAY}/fragments/${file}`;
        try {
          await uploadFile(fullPath, blobKey);
          syncedSet.add(file);
          console.log(`[live-sync] Synced fragment -> ${blobKey}`);
        } catch (err) {
          console.error(`[live-sync] Failed to sync ${file}:`, (err as Error).message);
        }
      })
    );
    saveState();
  }
}

async function runLoop() {
  console.log(`[live-sync] Starting live interim sync daemon for Day ${DAY} (${WATCH_DIR})...`);
  console.log(`[live-sync] Initial state: ${syncedSet.size} fragments already recorded as synced.`);

  let lastLogSync = 0;
  while (true) {
    const now = Date.now();
    if (now - lastLogSync > 15000) {
      console.log(`[live-sync] Syncing logs and indexes...`);
      await syncLogs();
      lastLogSync = now;
    }

    if (fs.existsSync(WATCH_DIR)) {
      const allFiles = fs.readdirSync(WATCH_DIR);
      const pendingFragments = allFiles.filter((f) => f.includes(".part-Frag") && !syncedSet.has(f)).sort();

      if (pendingFragments.length > 0) {
        console.log(`[live-sync] Found ${pendingFragments.length} new/pending fragments. Syncing batch...`);
        await processBatch(pendingFragments);
      }
    }

    // Sleep 3 seconds between sweeps for continuous 5-second cadence
    await new Promise((r) => setTimeout(r, 3000));
  }
}

runLoop().catch((err) => {
  console.error("[live-sync] Fatal daemon error:", err);
  process.exit(1);
});
