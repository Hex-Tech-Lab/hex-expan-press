import fs from "node:fs";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import { uploadMedia } from "../lib/blob.ts";

dotenv.config({ override: true });

async function main() {
  const localFile = process.argv[2];
  const blobPath = process.argv[3];

  if (!localFile || !blobPath) {
    console.error("Usage: tsx upload_stream_blob.ts <local_file> <blob_path>");
    process.exit(1);
  }

  if (!fs.existsSync(localFile)) {
    console.error(`Local file does not exist: ${localFile}`);
    process.exit(1);
  }

  const stat = fs.statSync(localFile);
  if (stat.size === 0) {
    console.error(`Local file is empty (0 bytes): ${localFile}`);
    process.exit(1);
  }

  console.log(`[blob] Uploading ${localFile} (${stat.size} bytes) to Upstash Blob: ${blobPath}...`);
  const nodeStream = fs.createReadStream(localFile);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  const result = await uploadMedia(blobPath, webStream, {
    contentType: localFile.endsWith(".mp4") ? "video/mp4" : "audio/mpeg",
    size: stat.size,
    allowOverwrite: true,
  });

  console.log(`[blob] Upload successful: ${result.path} (${stat.size} bytes, etag: ${result.etag || "ok"})`);
}

main().catch((err) => {
  console.error("[blob] Upload failed:", err);
  process.exit(1);
});
