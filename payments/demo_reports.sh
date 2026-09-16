#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TSX=node_modules/.bin/tsx
REPO_ROOT="$(pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "=== 1. seeding 3 fixture sales via ledger.appendSale into TEMP file ==="
cat > "$TMP/seed.ts" <<EOF
import { appendSale } from "${REPO_ROOT}/payments/src/ledger.ts";
const sales = [
  { ts: "2026-09-10T15:04:11.000Z", sale_id: "demo_001", provider: "stripe", product_id: "pdf_vre_playbook_v1", amount_usd: 19.99, creator_id: "creator_alpha", creator_split_pct: 85, creator_split_usd: 16.99, our_split_usd: 3.0, currency: "USD" },
  { ts: "2026-09-10T18:41:52.000Z", sale_id: "demo_002", provider: "stripe", product_id: "pdf_funnel_hacks_v1", amount_usd: 49.0, creator_id: "creator_beta", creator_split_pct: 80, creator_split_usd: 39.2, our_split_usd: 9.8, currency: "USD" },
  { ts: "2026-09-11T09:12:03.000Z", sale_id: "demo_003", provider: "stripe", product_id: "pdf_vre_playbook_v1", amount_usd: 7.5, creator_id: "creator_alpha", creator_split_pct: 85, creator_split_usd: 6.38, our_split_usd: 1.12, currency: "USD" },
];
async function main() {
  for (const s of sales) await appendSale(s, "${TMP}/sales_fixture.jsonl");
  const legacy = { ts: "2026-09-11T10:00:00.000Z", sale_id: "demo_004_legacy", provider: "stripe", product_id: "pdf_vre_playbook_v1", amount_usd: 10, creator_id: "creator_alpha", creator_split_usd: 8.5, our_split_usd: 1.5, currency: "USD" };
  const { appendFileSync } = await import("node:fs");
  appendFileSync("${TMP}/sales_fixture.jsonl", JSON.stringify(legacy) + "\n");
  console.log("[demo] seeded 3 fixture sales + 1 legacy (pre-terms) record");
}
main().catch((e) => { console.error(e); process.exit(1); });
EOF

"$TSX" "$TMP/seed.ts"

cat > "$TMP/config_alpha.json" <<'EOF'
{ "product_id": "pdf_vre_playbook_v1", "title": "The VRE Playbook (PDF)", "price_usd": 19.99, "creator_id": "creator_alpha", "creator_split_pct": 85, "provider": "stripe", "checkout_url": "https://checkout.example.com/vre-playbook", "pdf_file": "products/vre_playbook_v1.pdf", "currency": "USD" }
EOF
cat > "$TMP/config_beta.json" <<'EOF'
{ "product_id": "pdf_funnel_hacks_v1", "title": "Funnel Hacks One-Pager (PDF)", "price_usd": 49.0, "creator_id": "creator_beta", "creator_split_pct": 80, "provider": "stripe", "checkout_url": "https://checkout.example.com/funnel-hacks", "pdf_file": "products/funnel_hacks_v1.pdf", "currency": "USD" }
EOF

FIXTURE="$TMP/sales_fixture.jsonl"
SUM_BEFORE="$(sha256sum "$FIXTURE" | cut -d' ' -f1)"
LINES_BEFORE="$(wc -l < "$FIXTURE")"
REAL_LEDGER="data/db/sales.jsonl"
REAL_BEFORE=""
[ -e "$REAL_LEDGER" ] && REAL_BEFORE="$(sha256sum "$REAL_LEDGER" | cut -d' ' -f1)"

echo; echo "=== 2. daily report run (2026-09-10) ==="
"$TSX" payments/src/reports.ts --daily --date=2026-09-10 \
  --sales-file="$FIXTURE" --reports-dir="$TMP/reports" \
  --config="$TMP/config_alpha.json" --config="$TMP/config_beta.json"

echo; echo "=== 3. weekly compound run (2026-09-11) ==="
"$TSX" payments/src/reports.ts --weekly --date=2026-09-11 \
  --sales-file="$FIXTURE" --reports-dir="$TMP/reports" \
  --config="$TMP/config_alpha.json" --config="$TMP/config_beta.json"

echo; echo "=== daily report: creator_alpha ==="; cat "$TMP/reports/creator_creator_alpha_2026-09-10.md"
echo "=== daily report: creator_beta ==="; cat "$TMP/reports/creator_creator_beta_2026-09-10.md"
echo "=== weekly compound report ==="; cat "$TMP/reports/compound_2026-W37.md"

echo "=== 4. fixture integrity check ==="
SUM_AFTER="$(sha256sum "$FIXTURE" | cut -d' ' -f1)"
LINES_AFTER="$(wc -l < "$FIXTURE")"
if [ "$SUM_BEFORE" = "$SUM_AFTER" ] && [ "$LINES_BEFORE" = "$LINES_AFTER" ]; then
  echo "fixture untouched: sha256 ${SUM_AFTER:0:12}..., $LINES_AFTER lines (reports read, never rewrite)"
else
  echo "FIXTURE MUTATED"; exit 1
fi
if [ -n "$REAL_BEFORE" ]; then
  REAL_AFTER="$(sha256sum "$REAL_LEDGER" | cut -d' ' -f1)"
  if [ "$REAL_BEFORE" = "$REAL_AFTER" ]; then
    echo "real ledger data/db/sales.jsonl untouched"
  else
    echo "REAL LEDGER MUTATED"; exit 1
  fi
else
  echo "real ledger data/db/sales.jsonl: not present (demo never wrote it)"
fi
echo "=== demo OK ==="
