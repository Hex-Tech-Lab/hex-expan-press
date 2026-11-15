# YouTube: transcript routing and cloud access (verified 2026-11-15)

Status: verified by a cloud test (GitHub-hosted runner) and by the 2026-11-15 live capture. Keys are never written here.

## Routing

| Need | Route | Verified | Notes |
| --- | --- | --- | --- |
| Transcript from a cloud host | TranscriptAPI `GET https://transcriptapi.com/api/v2/youtube/transcript?video_url=<id>&format=json&include_timestamp=true`, `Authorization: Bearer <key>` | HTTP 200 on three videos, 0.58 to 0.71 s each (run 43756156015) | Primary route. Credits: 1 per successful call; 4xx, 5xx and 429 cost 0. |
| Transcript, many videos | Same endpoint, sequential | 80 of 86 Duane videos fetched, 80 of 100 credits used, no 402 (ledger T48, 2026-09-25) | Five 404 unavailable; one no-transcript. |
| Free language check | `GET /api/v2/youtube/info?video_url=<id>` | Documented (0 credits) | Use before paying for a transcript. |
| Channel / search / metadata / playlist | `/api/v2/youtube/search`, `/channel/info`, `/channel/videos`, `/video/metadata`, `/playlist/videos` | Documented by the provider; NOT yet run here | Verify each once before use. |
| Local media download (live or VOD) | yt-dlp 2026.10.26 at `.tools/yt-dlp/bin/yt-dlp` | Works from this machine (live capture 2026-11-15) | Blocked from cloud runners: "Sign in to confirm you're not a bot" (runs 43756075145 and 43756156015, and the 2026-11-15 scheduled recorder). |
| Live audio, cloud | None verified | Scheduled recorder run 43744037384 failed at the yt-dlp step | Live capture needs a local (non-cloud) host. |

## Rules

- Retry only on 408, 429 and 503. Stop on 402. Honor `Retry-After`.
- Rate limit: 200 requests per minute per key.
- Keep the key in a secret store (GitHub secret or `.env`), never in chat or in the repo.
- Whisper: whisper-large-v3-turbo is the model in use (founder choice). `transcribe.ts` holds back the last 90 s of any live file until a `downloads/DONE_<name>` marker exists; create the marker when the capture ends, or the tail is never transcribed.

## Decodo

- Decodo's Web Scraping API has moved to the Web Data API. The `youtube_subtitles` help page returns 404. Treat it as unverified.
- Remaining credit must be read from the Decodo dashboard; no balance endpoint is documented.

## Bright Data (evaluated 2026-11-15)

- Web Scraper API pay-as-you-go: $1.50 per 1,000 records, 5,000 records a month free. Scale plan: $499 a month with 384,000 records, then $1.30 per 1,000.
- Social scrapers listed by Bright Data: LinkedIn 10, Instagram 8, TikTok 15, Facebook 16, YouTube 10, X 4.
- Caution: "record" means different things per scraper (per profile or per post). Price each scraper before budgeting.
- Caution: scraping personal profiles for profiling needs a legal and consent review before use.
- Recommendation: pilot on the free 5,000 records, and only then decide. Industry norm: use the vendor's own dataset or API for social profiling rather than building scrapers. Why not: cost grows with volume, and the terms of each platform still apply.

## Summary of the day

- Day 5 scheduled recorder (cron 15 Nov 17:58 UTC) fired on time, polled correctly, and detected the stream live at 18:31 UTC. The yt-dlp download was then blocked by YouTube's bot check on the GitHub runner.
- Day 3 and day 4 recorded earlier (day 4 has DAY4_COMPLETE).
- Local three-minute capture of the live Day 5 audio: 180 s, transcribed in full (51 segments) with whisper-large-v3-turbo.
