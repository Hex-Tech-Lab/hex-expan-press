# Payments reports (sales.jsonl → markdown)

`data/db/sales.jsonl` is the append-only ledger (one JSON line per sale — `payments/src/ledger.ts`). Reports are derived artifacts; regenerate any time, the ledger is never rewritten.

- **Daily (per creator):** `tsx payments/src/reports.ts --daily [--date=YYYY-MM-DD]` → `data/db/reports/creator_<id>_<YYYY-MM-DD>.md` — that day's sales (time UTC, product, gross, creator split, our split) + totals. Zero sales = no file.
- **Weekly (compound, our view):** `tsx payments/src/reports.ts --weekly [--date=YYYY-MM-DD]` → `data/db/reports/compound_<YYYY-Www>.md` (ISO week, Mon–Sun UTC) — totals by creator and by product.
- Product titles resolve via repeatable `--config=<path>` (single-product configs, shape in `payments/config.example.json`); unknown product_ids fall back to the raw id.
- Tests/demos redirect I/O with `--sales-file=<path>` and `--reports-dir=<dir>` so real data is never touched — see `payments/demo_reports.sh`.
- Money math is integer cents end-to-end (`payments/src/split.ts`); creator gets `Math.round`, we take the remainder — cents never vanish.

Planned cron (not wired yet), after the 09:00 Cairo scheduled scan; daily for yesterday's UTC day, weekly Mondays for the closed ISO week:

```
5 9 * * *  cd /home/kellyb_dev/projects/hex-expan && node_modules/.bin/tsx payments/src/reports.ts --daily --date=$(date -u -d yesterday +\%F) >> data/db/scheduled_scan.log 2>&1
10 9 * * 1 cd /home/kellyb_dev/projects/hex-expan && node_modules/.bin/tsx payments/src/reports.ts --weekly --date=$(date -u -d last sunday +\%F) >> data/db/scheduled_scan.log 2>&1
```
