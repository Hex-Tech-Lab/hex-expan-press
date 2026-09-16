#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
[ -x "$TSX" ] || { echo "tsx not found at $TSX"; exit 1; }

PORT_P="${PAYMENTS_DEMO_PH_PORT:-8892}"
SECRET="payhip_demo_TEST_ONLY_123"
TMP="$(mktemp -d /tmp/opencode/demo_payhip.XXXXXX)"
TMP_LEDGER="$TMP/data/db/sales.jsonl"
FAILS=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }

stop_server() {
  [ -n "${1:-}" ] || return 0
  kill -TERM -- -"$1" 2>/dev/null
  kill -KILL -- -"$1" 2>/dev/null
}
cleanup() {
  stop_server "${PID_P:-}"
  rm -rf "$TMP"
}
trap cleanup EXIT

wait_health() {
  for _ in $(seq 1 40); do
    if curl -s -m 2 "http://127.0.0.1:$1/health" | grep -q '"ok":true'; then return 0; fi
    sleep 0.5
  done
  return 1
}

forge() {
  DIR="$1" TX_ID="$2" PRODUCT_ID="$3" DATE_S="$4" PRICE_MINOR="$5" \
  EVENT_TYPE="${6:-paid}" REFUND_MINOR="${7:-}" SECRET="$SECRET" SIGN_SECRET="${SIGN_SECRET:-$SECRET}" node -e '
    const fs = require("fs"), crypto = require("crypto");
    const type = process.env.EVENT_TYPE;
    const body = {
      id: process.env.TX_ID,
      email: "Buyer@Example.COM",
      currency: "USD",
      price: Number(process.env.PRICE_MINOR),
      vat_applied: false,
      ip_address: "72.334.28.154",
      items: [{
        product_id: process.env.PRODUCT_ID,
        product_name: "Retire on $500K: The Early-Retirement Money Playbook",
        product_key: "RGsF",
        product_permalink: "https://payhip.com/b/RGsF",
        quantity: "1",
        on_sale: false, used_coupon: false, used_social_discount: false,
        used_cross_sell_discount: false, used_upgrade_discount: false,
        promoted_by_affiliate: false, has_variant: false
      }],
      payment_type: "card",
      stripe_fee: 48,
      payhip_fee: 33,
      unconsented_from_emails: false,
      is_gift: false,
      type
    };
    if (type === "refunded") {
      body.amount_refunded = Number(process.env.REFUND_MINOR || process.env.PRICE_MINOR);
      body.date_refunded = Number(process.env.DATE_S) + 60;
      body.date_created = Number(process.env.DATE_S);
    } else {
      body.date = Number(process.env.DATE_S);
    }
    body.signature = crypto.createHash("sha256").update(process.env.SIGN_SECRET).digest("hex");
    fs.mkdirSync(process.env.DIR, { recursive: true });
    fs.writeFileSync(process.env.DIR + "/payload.json", JSON.stringify(body));
  '
}

post() {
  curl -s -o "$TMP/resp.json" -w "%{http_code}" -m 10 -X POST \
    -H "Content-Type: application/json" \
    --data-binary "@$2" \
    "http://127.0.0.1:$1/webhook/payhip"
}

echo "=== stage P: isolated temp cwd — terms + ledger + product config under $TMP"
mkdir -p "$TMP/data/settings"
cat > "$TMP/data/settings/terms.json" <<'EOF'
{
  "terms": [
    {
      "creator_id": "duane_retirearly500",
      "product_id": "duane_retirement_playbook_v1",
      "effective_from": "2026-09-14",
      "creator_split_pct": 50,
      "note": "demo: 50/50 founder decision 2026-09-14"
    }
  ]
}
EOF
cat > "$TMP/data/settings/product_config.json" <<'EOF'
{
  "product_id": "duane_retirement_playbook_v1",
  "title": "Retire on $500K: The Early-Retirement Money Playbook",
  "price_usd": 19,
  "creator_id": "duane_retirearly500",
  "creator_split_pct": 50,
  "provider": "payhip",
  "checkout_url": "https://payhip.com/b/RGsF",
  "pdf_file": "products/demo.pdf",
  "currency": "USD"
}
EOF
echo "=== temp terms.json: 50% effective 2026-09-14; product config: provider=payhip; signature = sha256(secret) IN payload (per help.payhip.com/article/115-webhooks)"

DATE_S="$(date -u -d "2026-09-16T12:00:00Z" +%s)"
env -C "$TMP" PORT="$PORT_P" PAYHIP_WEBHOOK_SECRET="$SECRET" PAYMENTS_PRODUCT_CONFIGS="$TMP/data/settings/product_config.json" \
  setsid nohup "$TSX" "$ROOT/payments/src/webhook_server.ts" >"$TMP/server.log" 2>&1 &
PID_P=$!
wait_health "$PORT_P" || { echo "SERVER FAILED TO START — log:"; cat "$TMP/server.log"; exit 1; }

TX_A="ZGjVj5x4GN"
forge "$TMP/forge" "$TX_A" "duane_retirement_playbook_v1" "$DATE_S" "1900" "paid"
CODE1="$(post "$PORT_P" "$TMP/forge/payload.json")"
echo "=== POST #1 (paid, price 1900 minor units) -> HTTP $CODE1"; cat "$TMP/resp.json"; echo
LINE_A="$(grep "$TX_A" "$TMP_LEDGER" 2>/dev/null | tail -n 1)"
echo "=== ledger line: $LINE_A"

if [ "$CODE1" = "200" ] && grep -q '"recorded":true' "$TMP/resp.json"; then pass "(a) payhip paid accepted (HTTP 200, recorded:true)"; else fail "(a) expected HTTP 200 recorded:true, got $CODE1 $(cat "$TMP/resp.json")"; fi
if echo "$LINE_A" | grep -q '"amount_usd":19'; then pass "(a) amount_usd 19 = price 1900 minor units / 100 (docs: prices in cents or pennies)"; else fail "(a) amount_usd unexpected: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"creator_split_pct":50'; then pass "(a) creator_split_pct 50 sourced from data/settings/terms.json"; else fail "(a) creator_split_pct missing/!= 50: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"creator_split_usd":9.5' && echo "$LINE_A" | grep -q '"our_split_usd":9.5'; then pass "(a) \$19.00 split 9.5/9.5 at 50%"; else fail "(a) split usd values unexpected: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"email_hash":"' && ! echo "$LINE_A" | grep -qi 'buyer@example.com'; then pass "(a) buyer email hashed, raw email absent from ledger"; else fail "(a) email hash missing or raw email leaked: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"provider":"payhip"' && echo "$LINE_A" | grep -q '"product_id":"duane_retirement_playbook_v1"' && echo "$LINE_A" | grep -q '"sale_id":"'"$TX_A"'"'; then pass "(a) sale_id = transaction id, product_id = items[0].product_id"; else fail "(a) identity fields wrong: $LINE_A"; fi
if echo "$LINE_A" | grep -qv '"event_type"'; then pass "(a) sale line carries no event_type (legacy = sale)"; else fail "(a) sale line unexpectedly carries event_type: $LINE_A"; fi

CODE2="$(post "$PORT_P" "$TMP/forge/payload.json")"
echo "=== POST #2 (webhook retry, same transaction id) -> HTTP $CODE2"; cat "$TMP/resp.json"; echo
if [ "$CODE2" = "200" ] && grep -q '"reason":"duplicate"' "$TMP/resp.json"; then pass "(b) idempotency: retry deduped (HTTP 200, recorded:false)"; else fail "(b) idempotency: retry response unexpected: $(cat "$TMP/resp.json")"; fi
if [ "$(grep -c "$TX_A" "$TMP_LEDGER" 2>/dev/null || true)" = "1" ]; then pass "(b) idempotency: exactly one ledger line for the transaction"; else fail "(b) idempotency: transaction id appears more than once in the ledger"; fi

SIGN_SECRET="payhip_demo_WRONG_SECRET" forge "$TMP/forge_bad" "b2222222-txid-bad0-0000-000000000001" "duane_retirement_playbook_v1" "$DATE_S" "1900" "paid"
CODE3="$(post "$PORT_P" "$TMP/forge_bad/payload.json")"
echo "=== POST #3 (forged signature property, wrong secret) -> HTTP $CODE3"; cat "$TMP/resp.json"; echo
if [ "$CODE3" = "401" ] && [ "$(wc -l < "$TMP_LEDGER")" = "1" ]; then pass "(c) bad signature rejected 401, sale NOT recorded"; else fail "(c) expected 401 + unchanged ledger, got $CODE3 lines=$(wc -l < "$TMP_LEDGER")"; fi

forge "$TMP/forge_nosig" "c3333333-txid-nosig-0000-000000000002" "duane_retirement_playbook_v1" "$DATE_S" "1900" "paid"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));delete p.signature;fs.writeFileSync(process.argv[1],JSON.stringify(p))' "$TMP/forge_nosig/payload.json"
CODE4="$(post "$PORT_P" "$TMP/forge_nosig/payload.json")"
echo "=== POST #4 (paid event WITHOUT signature property) -> HTTP $CODE4"; cat "$TMP/resp.json"; echo
if [ "$CODE4" = "401" ] && [ "$(wc -l < "$TMP_LEDGER")" = "1" ]; then pass "(d) missing signature property rejected 401, sale NOT recorded"; else fail "(d) expected 401 + unchanged ledger, got $CODE4 lines=$(wc -l < "$TMP_LEDGER")"; fi

forge "$TMP/forge_sub" "d4444444-txid-sub0-0000-000000000003" "duane_retirement_playbook_v1" "$DATE_S" "1900" "subscription.created"
CODE5="$(post "$PORT_P" "$TMP/forge_sub/payload.json")"
echo "=== POST #5 (subscription.created) -> HTTP $CODE5"; cat "$TMP/resp.json"; echo
if [ "$CODE5" = "202" ] && [ "$(wc -l < "$TMP_LEDGER")" = "1" ]; then pass "(e) subscription.created ignored at sale layer (202), ledger unchanged"; else fail "(e) expected 202 + unchanged ledger, got $CODE5 lines=$(wc -l < "$TMP_LEDGER")"; fi

forge "$TMP/forge_refund" "$TX_A" "duane_retirement_playbook_v1" "$DATE_S" "1900" "refunded"
CODE6="$(post "$PORT_P" "$TMP/forge_refund/payload.json")"
echo "=== POST #6 (refunded full, links to recorded sale $TX_A) -> HTTP $CODE6"; cat "$TMP/resp.json"; echo
LINE_R="$(grep '"event_type":"refund"' "$TMP_LEDGER" 2>/dev/null | tail -n 1)"
echo "=== refund ledger line: $LINE_R"
if [ "$CODE6" = "200" ] && grep -q '"recorded":true' "$TMP/resp.json" && grep -q '"event_type":"refund"' "$TMP/resp.json"; then pass "(f) refunded -> HTTP 200 recorded:true event_type refund"; else fail "(f) expected 200 recorded:true event_type refund, got $CODE6 $(cat "$TMP/resp.json")"; fi
if echo "$LINE_R" | grep -q '"event_type":"refund"' && echo "$LINE_R" | grep -q '"amount_usd":19' && echo "$LINE_R" | grep -q '"creator_split_usd":-9.5' && echo "$LINE_R" | grep -q '"our_split_usd":-9.5'; then pass "(f) refund record: event_type refund, amount_usd +19 kept positive, splits reversed -9.5/-9.5 from linked sale"; else fail "(f) refund record fields wrong: $LINE_R"; fi
if echo "$LINE_R" | grep -q '"sale_id":"'"$TX_A"'"' && echo "$LINE_R" | grep -q '"product_id":"duane_retirement_playbook_v1"' && echo "$LINE_R" | grep -q '"creator_id":"duane_retirearly500"' && echo "$LINE_R" | grep -q '"email_hash":"'; then pass "(f) refund linked by transaction id, product/creator/email_hash copied from the sale"; else fail "(f) refund linkage fields wrong: $LINE_R"; fi
if [ "$(wc -l < "$TMP_LEDGER")" = "2" ] && [ "$(grep -c '"event_type":"refund"' "$TMP_LEDGER")" = "1" ] && [ "$(grep "$TX_A" "$TMP_LEDGER" | grep -vc '"event_type":"refund"')" = "1" ]; then pass "(f) ledger = exactly 1 sale + 1 refund for the transaction"; else fail "(f) ledger shape wrong: lines=$(wc -l < "$TMP_LEDGER")"; fi

CODE7="$(post "$PORT_P" "$TMP/forge_refund/payload.json")"
echo "=== POST #7 (webhook retry, same refund event) -> HTTP $CODE7"; cat "$TMP/resp.json"; echo
if [ "$CODE7" = "200" ] && grep -q '"recorded":false' "$TMP/resp.json" && grep -q '"reason":"duplicate"' "$TMP/resp.json"; then pass "(f2) refund idempotency: retry deduped (HTTP 200, recorded:false)"; else fail "(f2) refund retry response unexpected: $(cat "$TMP/resp.json")"; fi
if [ "$(grep -c '"event_type":"refund"' "$TMP_LEDGER")" = "1" ]; then pass "(f2) exactly one refund line after retry"; else fail "(f2) duplicate refund leaked into ledger"; fi

forge "$TMP/forge_refund_orphan" "e5555555-txid-orphan-000-0000000000004" "duane_retirement_playbook_v1" "$DATE_S" "1900" "refunded"
CODE8="$(post "$PORT_P" "$TMP/forge_refund_orphan/payload.json")"
echo "=== POST #8 (refunded for UNRECORDED transaction e5555555-...) -> HTTP $CODE8"; cat "$TMP/resp.json"; echo
if [ "$CODE8" = "422" ] && grep -q 'no recorded sale' "$TMP/resp.json" && [ "$(wc -l < "$TMP_LEDGER")" = "2" ]; then pass "(f3) orphan refund refused loudly (HTTP 422, no ledger write)"; else fail "(f3) expected 422 + unchanged ledger, got $CODE8 lines=$(wc -l < "$TMP_LEDGER")"; fi
if grep -q "REFUND REFUSED" "$TMP/server.log" && grep -q "e5555555-txid-orphan-000-0000000000004" "$TMP/server.log"; then pass "(f3) orphan refund surfaced loudly in server log (REFUND REFUSED + transaction id)"; else fail "(f3) loud REFUND REFUSED log missing"; fi

forge "$TMP/forge_refund_partial" "$TX_A" "duane_retirement_playbook_v1" "$DATE_S" "1900" "refunded" "500"
CODE9="$(post "$PORT_P" "$TMP/forge_refund_partial/payload.json")"
echo "=== POST #9 (refunded PARTIAL: amount_refunded 500 of price 1900) -> HTTP $CODE9"; cat "$TMP/resp.json"; echo
if [ "$CODE9" = "422" ] && grep -q 'partial refund' "$TMP/resp.json" && [ "$(wc -l < "$TMP_LEDGER")" = "2" ]; then pass "(g) partial refund refused loudly (HTTP 422, ledger event_type refund is full-reversal only)"; else fail "(g) expected 422 + unchanged ledger, got $CODE9 lines=$(wc -l < "$TMP_LEDGER")"; fi

echo "=== POST #10 run: daily report from temp ledger (income must NOT be inflated by the sale) ==="
"$TSX" "$ROOT/payments/src/reports.ts" --daily --date=2026-09-16 \
  --sales-file="$TMP_LEDGER" --reports-dir="$TMP/reports" \
  --config="$TMP/data/settings/product_config.json" >"$TMP/reports.log" 2>&1
REPORT="$TMP/reports/creator_duane_retirearly500_2026-09-16.md"
if [ -f "$REPORT" ]; then pass "(h) daily report written from sale+refund ledger"; cat "$REPORT"; else fail "(h) daily report missing ($(cat "$TMP/reports.log"))"; fi
if [ -f "$REPORT" ] && grep -qF '**Totals (1 sale, 1 refund)** | **$0.00** | **$0.00** | **$0.00** |' "$REPORT"; then pass "(h) refund subtracted from income: totals \$19.00 sale - \$19.00 refund = \$0.00 (not inflated)"; else fail "(h) income totals wrong/inflated: $(grep 'Totals' "$REPORT" 2>/dev/null)"; fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "=== DEMO OK ((a) signed paid -> terms-sourced 50% split (b) idempotency on transaction id (c) forged signature 401 (d) missing signature 401 (e) subscription.created ignored 202 (f) refunded -> full-reversal ledger record (f2) refund retry idempotent (f3) orphan refund 422-refused (g) partial refund 422-refused (h) reports subtract refund, income \$0.00)"
else
  echo "=== DEMO FAILED ($FAILS check(s) failed)"
  exit 1
fi
