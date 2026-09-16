#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
[ -x "$TSX" ] || { echo "tsx not found at $TSX"; exit 1; }

PORT_F="${PAYMENTS_DEMO_FS_PORT:-8893}"
SECRET="fs_demo_TEST_ONLY_123"
TMP="$(mktemp -d /tmp/opencode/demo_fastspring.XXXXXX)"
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
  stop_server "${PID_F:-}"
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

order_data() {
  ORDER_ID="$1" PRODUCT_PATH="$2" CHANGED_MS="$3" TOTAL="${4:-19.00}" LIVE="${5:-true}" node -e '
    console.log(JSON.stringify({
      order: process.env.ORDER_ID,
      id: process.env.ORDER_ID,
      reference: "ABC123456-7891-01112",
      buyerReference: null,
      completed: true,
      changed: Number(process.env.CHANGED_MS),
      changedValue: Number(process.env.CHANGED_MS),
      changedInSeconds: Math.floor(Number(process.env.CHANGED_MS) / 1000),
      changedDisplayISO8601: "2026-09-16",
      language: "en",
      live: process.env.LIVE === "true",
      currency: "USD",
      payoutCurrency: "USD",
      total: Number(process.env.TOTAL),
      totalDisplay: "$" + process.env.TOTAL,
      totalInPayoutCurrency: Number(process.env.TOTAL),
      tax: 0.0,
      subtotal: Number(process.env.TOTAL),
      billDescriptor: "FS* fsprg.com",
      payment: { type: "test", cardEnding: "4242" },
      customer: { first: "Jane", last: "Doe", email: "Buyer@Example.COM", company: null, phone: null, subscribed: true },
      items: [{
        product: process.env.PRODUCT_PATH,
        quantity: 1,
        display: "Retire on $500K: The Early-Retirement Money Playbook",
        sku: "SKU-DEMO-1",
        subtotal: Number(process.env.TOTAL),
        fulfillments: {},
        withholdings: { taxWithholdings: false }
      }]
    }));
  '
}

forge() {
  DIR="$1" EVENTS_JSON="$2" SECRET="$SECRET" SIGN_SECRET="${SIGN_SECRET:-$SECRET}" node -e '
    const fs = require("fs"), crypto = require("crypto");
    const body = JSON.stringify({ events: JSON.parse(process.env.EVENTS_JSON) });
    fs.mkdirSync(process.env.DIR, { recursive: true });
    fs.writeFileSync(process.env.DIR + "/payload.json", body);
    fs.writeFileSync(process.env.DIR + "/sig.txt",
      crypto.createHmac("sha256", process.env.SIGN_SECRET).update(body).digest("base64"));
  '
}

post() {
  curl -s -o "$TMP/resp.json" -w "%{http_code}" -m 10 -X POST \
    -H "Content-Type: application/json" -H "x-fs-signature: $(cat "$2")" \
    --data-binary "@$3" \
    "http://127.0.0.1:$1/webhook/fastspring"
}

echo "=== stage F: isolated temp cwd — terms + ledger + product config under $TMP"
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
  "provider": "fastspring",
  "checkout_url": "https://demostore.onfastspring.com/duane-retirement-playbook",
  "pdf_file": "products/demo.pdf",
  "currency": "USD"
}
EOF
echo "=== temp terms.json: 50% effective 2026-09-14; product config: provider=fastspring; signature = base64(HMAC-SHA256(raw body, secret)) in x-fs-signature (per developer.fastspring.com/reference/message-security)"

CHANGED_MS="$(($(date -u -d "2026-09-16T12:00:00Z" +%s) * 1000))"
env -C "$TMP" PORT="$PORT_F" FASTSPRING_WEBHOOK_SECRET="$SECRET" PAYMENTS_PRODUCT_CONFIGS="$TMP/data/settings/product_config.json" \
  setsid nohup "$TSX" "$ROOT/payments/src/webhook_server.ts" >"$TMP/server.log" 2>&1 &
PID_F=$!
wait_health "$PORT_F" || { echo "SERVER FAILED TO START — log:"; cat "$TMP/server.log"; exit 1; }

ORDER_A="aBCDE12fGH3iJkL4mNOpqA"
SINGLE_EVT="[{\"id\":\"evt-1-$ORDER_A\",\"live\":true,\"processed\":false,\"type\":\"order.completed\",\"created\":$CHANGED_MS,\"data\":$(order_data "$ORDER_A" "duane_retirement_playbook_v1" "$CHANGED_MS" "19.00")}]"
forge "$TMP/forge" "$SINGLE_EVT"
CODE1="$(post "$PORT_F" "$TMP/forge/sig.txt" "$TMP/forge/payload.json")"
echo "=== POST #1 (single order.completed, total 19.00 major units) -> HTTP $CODE1"; cat "$TMP/resp.json"; echo
LINE_A="$(grep "$ORDER_A" "$TMP_LEDGER" 2>/dev/null | tail -n 1)"
echo "=== ledger line: $LINE_A"

if [ "$CODE1" = "200" ] && grep -q '"recorded":true' "$TMP/resp.json"; then pass "(a) fastspring order.completed accepted (HTTP 200, recorded:true)"; else fail "(a) expected HTTP 200 recorded:true, got $CODE1 $(cat "$TMP/resp.json")"; fi
if echo "$LINE_A" | grep -q '"amount_usd":19'; then pass "(a) amount_usd 19 = data.total 19.00 MAJOR units (not cents)"; else fail "(a) amount_usd unexpected: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"creator_split_pct":50'; then pass "(a) creator_split_pct 50 sourced from data/settings/terms.json"; else fail "(a) creator_split_pct missing/!= 50: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"creator_split_usd":9.5' && echo "$LINE_A" | grep -q '"our_split_usd":9.5'; then pass "(a) \$19.00 split 9.5/9.5 at 50%"; else fail "(a) split usd values unexpected: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"email_hash":"' && ! echo "$LINE_A" | grep -qi 'buyer@example.com'; then pass "(a) buyer email hashed, raw email absent from ledger"; else fail "(a) email hash missing or raw email leaked: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"provider":"fastspring"' && echo "$LINE_A" | grep -q '"product_id":"duane_retirement_playbook_v1"' && echo "$LINE_A" | grep -q '"sale_id":"'"$ORDER_A"'"'; then pass "(a) sale_id = data.id (order id), product_id = data.items[].product path"; else fail "(a) identity fields wrong: $LINE_A"; fi
if echo "$LINE_A" | grep -qv '"event_type"'; then pass "(a) sale line carries no event_type (legacy = sale)"; else fail "(a) sale line unexpectedly carries event_type: $LINE_A"; fi

CODE2="$(post "$PORT_F" "$TMP/forge/sig.txt" "$TMP/forge/payload.json")"
echo "=== POST #2 (webhook retry, same event id — automatic retries reuse ids) -> HTTP $CODE2"; cat "$TMP/resp.json"; echo
if [ "$CODE2" = "200" ] && grep -q '"reason":"duplicate"' "$TMP/resp.json"; then pass "(b) idempotency: retry deduped (HTTP 200, recorded:false)"; else fail "(b) idempotency: retry response unexpected: $(cat "$TMP/resp.json")"; fi
if [ "$(grep -c "$ORDER_A" "$TMP_LEDGER" 2>/dev/null || true)" = "1" ]; then pass "(b) idempotency: exactly one ledger line for the order"; else fail "(b) idempotency: order id appears more than once in the ledger"; fi

SIGN_SECRET="fs_demo_WRONG_SECRET" forge "$TMP/forge_bad" "$SINGLE_EVT"
CODE3="$(post "$PORT_F" "$TMP/forge_bad/sig.txt" "$TMP/forge_bad/payload.json")"
echo "=== POST #3 (forged signature, wrong secret) -> HTTP $CODE3"; cat "$TMP/resp.json"; echo
if [ "$CODE3" = "401" ] && [ "$(wc -l < "$TMP_LEDGER")" = "1" ]; then pass "(c) bad signature rejected 401, sale NOT recorded"; else fail "(c) expected 401 + unchanged ledger, got $CODE3 lines=$(wc -l < "$TMP_LEDGER")"; fi

ORDER_T="aBCDE12fGH3iJkL4mNOpqT"
TEST_EVT="[{\"id\":\"evt-test-$ORDER_T\",\"live\":true,\"processed\":false,\"type\":\"order.completed\",\"created\":$CHANGED_MS,\"data\":$(order_data "$ORDER_T" "duane_retirement_playbook_v1" "$CHANGED_MS" "19.00" "false")}]"
forge "$TMP/forge_test" "$TEST_EVT"
CODE4="$(post "$PORT_F" "$TMP/forge_test/sig.txt" "$TMP/forge_test/payload.json")"
echo "=== POST #4 (order.completed with data.live=false test order) -> HTTP $CODE4"; cat "$TMP/resp.json"; echo
if [ "$CODE4" = "202" ] && [ "$(wc -l < "$TMP_LEDGER")" = "1" ]; then pass "(d) live=false test order -> 202, NOT recorded (production ledger untouched)"; else fail "(d) expected 202 + unchanged ledger, got $CODE4 lines=$(wc -l < "$TMP_LEDGER")"; fi
if grep -q "test event" "$TMP/server.log" && grep -q "live=false" "$TMP/server.log"; then pass "(d) server log loud: test event + live=false + not-recorded"; else fail "(d) loud test-event log missing from server log"; fi

ORDER_B="aBCDE12fGH3iJkL4mNOpqB"
BATCH_EVT="[{\"id\":\"evt-2-$ORDER_B\",\"live\":true,\"processed\":false,\"type\":\"order.completed\",\"created\":$CHANGED_MS,\"data\":$(order_data "$ORDER_B" "duane_retirement_playbook_v1" "$CHANGED_MS" "19.00")},{\"id\":\"evt-3-sub\",\"live\":true,\"processed\":false,\"type\":\"subscription.activated\",\"created\":$CHANGED_MS,\"data\":{\"subscription\":\"sub_demo_001\",\"live\":true}}]"
forge "$TMP/forge_batch" "$BATCH_EVT"
CODE5="$(post "$PORT_F" "$TMP/forge_batch/sig.txt" "$TMP/forge_batch/payload.json")"
echo "=== POST #5 (mixed batch: order.completed + subscription.activated) -> HTTP $CODE5"; cat "$TMP/resp.json"; echo
if [ "$CODE5" = "200" ] && grep -q '"recorded":true' "$TMP/resp.json"; then pass "(e) mixed batch: sale recorded, subscription.activated ignored (single actionable event -> single-sale form), HTTP 200"; else fail "(e) batch response unexpected: $(cat "$TMP/resp.json")"; fi
LINE_B="$(grep "$ORDER_B" "$TMP_LEDGER" 2>/dev/null | tail -n 1)"
if echo "$LINE_B" | grep -q '"provider":"fastspring"' && echo "$LINE_B" | grep -q '"amount_usd":19'; then pass "(e) batch sale landed in ledger (sale_id = $ORDER_B)"; else fail "(e) batch sale missing from ledger: $LINE_B"; fi
if [ "$(wc -l < "$TMP_LEDGER")" = "2" ]; then pass "(e) ledger = exactly 2 sales after batch (non-sale event ignored)"; else fail "(e) ledger shape wrong: lines=$(wc -l < "$TMP_LEDGER")"; fi

CODE6="$(post "$PORT_F" "$TMP/forge_batch/sig.txt" "$TMP/forge_batch/payload.json")"
echo "=== POST #6 (mixed batch retry) -> HTTP $CODE6"; cat "$TMP/resp.json"; echo
if [ "$CODE6" = "200" ] && grep -q '"recorded":false' "$TMP/resp.json"; then pass "(e2) batch idempotency: retry deduped (recorded:false)"; else fail "(e2) batch retry response unexpected: $(cat "$TMP/resp.json")"; fi
if [ "$(wc -l < "$TMP_LEDGER")" = "2" ]; then pass "(e2) no duplicate lines after batch retry"; else fail "(e2) batch retry leaked duplicates: lines=$(wc -l < "$TMP_LEDGER")"; fi

ORDER_C="aBCDE12fGH3iJkL4mNOpqC"
ORDER_D="aBCDE12fGH3iJkL4mNOpqD"
MULTI_SALES="[{\"id\":\"evt-4-$ORDER_C\",\"live\":true,\"processed\":false,\"type\":\"order.completed\",\"created\":$CHANGED_MS,\"data\":$(order_data "$ORDER_C" "duane_retirement_playbook_v1" "$CHANGED_MS" "19.00")},{\"id\":\"evt-5-$ORDER_D\",\"live\":true,\"processed\":false,\"type\":\"order.completed\",\"created\":$CHANGED_MS,\"data\":$(order_data "$ORDER_D" "duane_retirement_playbook_v1" "$CHANGED_MS" "19.00")}]"
forge "$TMP/forge_multi" "$MULTI_SALES"
CODE6B="$(post "$PORT_F" "$TMP/forge_multi/sig.txt" "$TMP/forge_multi/payload.json")"
echo "=== POST #6b (TRUE multi-action batch: two order.completed in one POST) -> HTTP $CODE6B"; cat "$TMP/resp.json"; echo
if [ "$CODE6B" = "200" ] && grep -q '"recorded":2' "$TMP/resp.json" && grep -q '"batch":' "$TMP/resp.json"; then pass "(e3) multi-action batch: BOTH sales recorded in one POST (recorded:2)"; else fail "(e3) multi-sale batch response unexpected: $(cat "$TMP/resp.json")"; fi
if [ "$(grep -c '"provider":"fastspring"' "$TMP_LEDGER")" = "4" ]; then pass "(e3) ledger = exactly 4 fastspring sales after the multi-action batch"; else fail "(e3) ledger sale count wrong: $(grep -c '"provider":"fastspring"' "$TMP_LEDGER")"; fi

CODE6C="$(post "$PORT_F" "$TMP/forge_multi/sig.txt" "$TMP/forge_multi/payload.json")"
echo "=== POST #6c (multi-action batch retry) -> HTTP $CODE6C"; cat "$TMP/resp.json"; echo
if [ "$CODE6C" = "200" ] && grep -q '"recorded":0' "$TMP/resp.json" && grep -q '"batch":' "$TMP/resp.json"; then pass "(e4) multi-action batch retry fully deduped (recorded:0)"; else fail "(e4) multi-action batch retry response unexpected: $(cat "$TMP/resp.json")"; fi
if [ "$(grep -c '"provider":"fastspring"' "$TMP_LEDGER")" = "4" ]; then pass "(e4) no duplicate lines after multi-action batch retry"; else fail "(e4) retry leaked duplicates"; fi

RETURN_EVT="[{\"id\":\"evt-refund-$ORDER_B\",\"live\":true,\"processed\":false,\"type\":\"return.created\",\"created\":$CHANGED_MS,\"data\":{\"return\":\"RET1\",\"reference\":\"RET-1\",\"completed\":true,\"changed\":$CHANGED_MS,\"live\":true,\"currency\":\"USD\",\"payoutCurrency\":\"USD\",\"totalReturn\":19.0,\"original\":{\"id\":\"$ORDER_B\",\"order\":\"$ORDER_B\",\"reference\":\"ABC123456-7891-01112\",\"currency\":\"USD\",\"total\":19.0},\"customer\":{\"email\":\"Buyer@Example.COM\"},\"type\":\"RETURN\",\"items\":[{\"product\":\"duane_retirement_playbook_v1\",\"quantity\":1,\"refundType\":\"Full Refund\",\"subtotal\":19.0}]}}]"
forge "$TMP/forge_refund" "$RETURN_EVT"
CODE7="$(post "$PORT_F" "$TMP/forge_refund/sig.txt" "$TMP/forge_refund/payload.json")"
echo "=== POST #7 (return.created, links to recorded order $ORDER_B) -> HTTP $CODE7"; cat "$TMP/resp.json"; echo
LINE_R="$(grep '"event_type":"refund"' "$TMP_LEDGER" 2>/dev/null | tail -n 1)"
echo "=== refund ledger line: $LINE_R"
if [ "$CODE7" = "200" ] && grep -q '"recorded":true' "$TMP/resp.json" && grep -q '"event_type":"refund"' "$TMP/resp.json"; then pass "(f) return.created -> HTTP 200 recorded:true event_type refund"; else fail "(f) expected 200 recorded:true event_type refund, got $CODE7 $(cat "$TMP/resp.json")"; fi
if echo "$LINE_R" | grep -q '"event_type":"refund"' && echo "$LINE_R" | grep -q '"amount_usd":19' && echo "$LINE_R" | grep -q '"creator_split_usd":-9.5' && echo "$LINE_R" | grep -q '"our_split_usd":-9.5'; then pass "(f) refund record: event_type refund, amount_usd +19 kept positive, splits reversed -9.5/-9.5 from linked sale"; else fail "(f) refund record fields wrong: $LINE_R"; fi
if echo "$LINE_R" | grep -q '"sale_id":"'"$ORDER_B"'"' && echo "$LINE_R" | grep -q '"creator_id":"duane_retirearly500"' && echo "$LINE_R" | grep -q '"email_hash":"'; then pass "(f) refund linked via data.original.order, product/creator/email_hash copied from the sale"; else fail "(f) refund linkage fields wrong: $LINE_R"; fi
if [ "$(grep -c '"event_type":"refund"' "$TMP_LEDGER")" = "1" ]; then pass "(f) exactly one refund line in ledger"; else fail "(f) refund count wrong in ledger"; fi

CODE8="$(post "$PORT_F" "$TMP/forge_refund/sig.txt" "$TMP/forge_refund/payload.json")"
echo "=== POST #8 (webhook retry, same refund event) -> HTTP $CODE8"; cat "$TMP/resp.json"; echo
if [ "$CODE8" = "200" ] && grep -q '"reason":"duplicate"' "$TMP/resp.json"; then pass "(f2) refund idempotency: retry deduped (HTTP 200, recorded:false)"; else fail "(f2) refund retry response unexpected: $(cat "$TMP/resp.json")"; fi
if [ "$(grep -c '"event_type":"refund"' "$TMP_LEDGER")" = "1" ]; then pass "(f2) exactly one refund line after retry"; else fail "(f2) duplicate refund leaked into ledger"; fi

ORDER_O="aBCDE12fGH3iJkL4mNOpqO"
ORPHAN_EVT="[{\"id\":\"evt-refund-orphan\",\"live\":true,\"processed\":false,\"type\":\"return.created\",\"created\":$CHANGED_MS,\"data\":{\"return\":\"RET2\",\"completed\":true,\"changed\":$CHANGED_MS,\"live\":true,\"currency\":\"USD\",\"totalReturn\":19.0,\"original\":{\"id\":\"$ORDER_O\",\"order\":\"$ORDER_O\",\"currency\":\"USD\",\"total\":19.0},\"type\":\"RETURN\",\"items\":[]}}]"
forge "$TMP/forge_refund_orphan" "$ORPHAN_EVT"
CODE9="$(post "$PORT_F" "$TMP/forge_refund_orphan/sig.txt" "$TMP/forge_refund_orphan/payload.json")"
echo "=== POST #9 (return.created for UNRECORDED order $ORDER_O) -> HTTP $CODE9"; cat "$TMP/resp.json"; echo
if [ "$CODE9" = "422" ] && grep -q 'no recorded sale' "$TMP/resp.json"; then pass "(f3) orphan refund refused loudly (HTTP 422, no ledger write)"; else fail "(f3) expected 422, got $CODE9 $(cat "$TMP/resp.json")"; fi
if grep -q "REFUND REFUSED" "$TMP/server.log" && grep -q "$ORDER_O" "$TMP/server.log"; then pass "(f3) orphan refund surfaced loudly in server log (REFUND REFUSED + order id)"; else fail "(f3) loud REFUND REFUSED log missing"; fi

PARTIAL_EVT="[{\"id\":\"evt-refund-partial\",\"live\":true,\"processed\":false,\"type\":\"return.created\",\"created\":$CHANGED_MS,\"data\":{\"return\":\"RET3\",\"completed\":true,\"changed\":$CHANGED_MS,\"live\":true,\"currency\":\"USD\",\"totalReturn\":5.0,\"original\":{\"id\":\"$ORDER_A\",\"order\":\"$ORDER_A\",\"currency\":\"USD\",\"total\":19.0},\"type\":\"RETURN\",\"items\":[{\"product\":\"duane_retirement_playbook_v1\",\"refundType\":\"Partial Refund\",\"subtotal\":5.0}]}}]"
forge "$TMP/forge_refund_partial" "$PARTIAL_EVT"
CODE10="$(post "$PORT_F" "$TMP/forge_refund_partial/sig.txt" "$TMP/forge_refund_partial/payload.json")"
echo "=== POST #10 (return.created PARTIAL: totalReturn 5.0 of original.total 19.0) -> HTTP $CODE10"; cat "$TMP/resp.json"; echo
if [ "$CODE10" = "422" ] && grep -q 'partial return' "$TMP/resp.json"; then pass "(g) partial return refused loudly (HTTP 422, ledger refund records are full reversals)"; else fail "(g) expected 422, got $CODE10 $(cat "$TMP/resp.json")"; fi
if [ "$(grep -c '"event_type":"refund"' "$TMP_LEDGER")" = "1" ]; then pass "(g) partial refund did NOT write a ledger line"; else fail "(g) partial refund leaked into ledger"; fi

echo "=== POST #11 run: daily report from temp ledger (income must NOT be inflated by the refund) ==="
"$TSX" "$ROOT/payments/src/reports.ts" --daily --date=2026-09-16 \
  --sales-file="$TMP_LEDGER" --reports-dir="$TMP/reports" \
  --config="$TMP/data/settings/product_config.json" >"$TMP/reports.log" 2>&1
REPORT="$TMP/reports/creator_duane_retirearly500_2026-09-16.md"
if [ -f "$REPORT" ]; then pass "(h) daily report written from sale+refund ledger"; cat "$REPORT"; else fail "(h) daily report missing ($(cat "$TMP/reports.log"))"; fi
if [ -f "$REPORT" ] && grep -qF -- '-$19.00 refund' "$REPORT" && grep -qF '(50% back to creator)' "$REPORT"; then pass "(h) refund row rendered distinctly (-\$19.00 refund, 50% back to creator)"; else fail "(h) distinct refund row missing from report"; fi
if [ -f "$REPORT" ] && grep -qF '**Totals (4 sales, 1 refund)** | **$57.00** | **$28.50** | **$28.50** |' "$REPORT"; then pass "(h) income math exact: 4 sales \$76.00 - 1 refund \$19.00 = \$57.00 net (splits 28.50/28.50)"; else fail "(h) income totals wrong: $(grep 'Totals' "$REPORT" 2>/dev/null)"; fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "=== DEMO OK ((a) signed order.completed -> terms-sourced 50% split (b) idempotency on order id (c) forged signature 401 (d) live=false test gate 202-unrecorded (e) mixed batch: sale recorded + non-sale ignored (e2) batch retry idempotent (e3) multi-action batch records both sales (e4) multi-action batch retry fully deduped (f) return.created -> full-reversal ledger record via original.order (f2) refund retry idempotent (f3) orphan refund 422-refused (g) partial return 422-refused (h) reports subtract refund, income exact)"
else
  echo "=== DEMO FAILED ($FAILS check(s) failed)"
  exit 1
fi
