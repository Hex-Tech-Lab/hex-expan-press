#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
[ -x "$TSX" ] || { echo "tsx not found at $TSX"; exit 1; }

PORT_F="${PAYMENTS_DEMO_F_PORT:-8891}"
SECRET="fngs_demo_TEST_ONLY_123"
TMP="$(mktemp -d /tmp/opencode/demo_fungies.XXXXXX)"
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

forge() {
  DIR="$1" SALE_ID="$2" PRODUCT_ID="$3" CREATED_MS="$4" VALUE_CENTS="$5" \
  EVENT_TYPE="${6:-payment_success}" TEST_MODE="${7:-${TEST_MODE:-false}}" SECRET="$SECRET" SIGN_SECRET="${SIGN_SECRET:-$SECRET}" node -e '
    const fs = require("fs"), crypto = require("crypto");
    const rid = () => crypto.randomUUID();
    const type = process.env.EVENT_TYPE;
    const eventId = type + "-evt-" + process.env.SALE_ID;
    const body = {
      id: eventId,
      type,
      idempotencyKey: eventId,
      testMode: process.env.TEST_MODE === "true",
      data: {}
    };
    if (type === "payment_success") {
      const orderId = rid(), productId = rid();
      body.data = {
        items: [{
          object: "item", id: rid(), name: "Retire on $500K: The Early-Retirement Money Playbook",
          value: Number(process.env.VALUE_CENTS), quantity: 1, currency: "USD",
          product: { object: "product", id: productId, type: "OneTimePayment", internalId: process.env.PRODUCT_ID },
          offer: { object: "offer", id: rid(), internalId: "offer_demo_v1" },
          variant: null, plan: null,
          customFields: { product_id: process.env.PRODUCT_ID }
        }],
        order: { object: "order", id: orderId, number: "L8FNGDEMO001", orderNumber: "L8FNGDEMO001",
          status: "PAID", value: Number(process.env.VALUE_CENTS), tax: 0, fee: 0,
          currency: "USD", currencyDecimals: 2, country: "US", totalItems: 1,
          createdAt: Number(process.env.CREATED_MS), userId: rid() },
        payment: { object: "payment", id: process.env.SALE_ID, number: "L8FNGDEMO001",
          type: "one_time", status: "PAID", value: Number(process.env.VALUE_CENTS), tax: 0, fee: 0,
          currency: "USD", currencyDecimals: 2, createdAt: Number(process.env.CREATED_MS),
          orderId: orderId, orderNumber: "L8FNGDEMO001" },
        user: { object: "user", id: rid(), email: "Buyer@Example.COM", username: null, internalId: null },
        customer: { object: "user", id: rid(), email: "Buyer@Example.COM", username: null, internalId: null }
      };
    } else if (type === "payment_refunded") {
      const orderId = rid();
      body.data = {
        items: [],
        order: { object: "order", id: orderId, number: "L8FNGDEMO001", orderNumber: "L8FNGDEMO001",
          status: "PAID", value: Number(process.env.VALUE_CENTS), tax: 0, fee: 0,
          currency: "USD", currencyDecimals: 2, country: "US", totalItems: 0,
          createdAt: Number(process.env.CREATED_MS), userId: rid() },
        payment: { object: "payment", id: process.env.SALE_ID, number: "L8FNGDEMO001",
          type: "one_time", status: "PAID", value: Number(process.env.VALUE_CENTS), tax: 0, fee: 0,
          currency: "USD", currencyDecimals: 2, createdAt: Number(process.env.CREATED_MS),
          orderId: orderId, orderNumber: "L8FNGDEMO001" },
        user: { object: "user", id: rid(), email: "Buyer@Example.COM", username: null, internalId: null },
        customer: { object: "user", id: rid(), email: "Buyer@Example.COM", username: null, internalId: null }
      };
    } else {
      body.data = {
        items: [{ object: "item", id: rid(), name: "Pro Plan", value: 1900, quantity: 1, currency: "USD",
          product: { object: "product", id: rid(), type: "Subscription", internalId: process.env.PRODUCT_ID },
          offer: { object: "offer", id: rid(), internalId: "plan_pro" }, variant: null, plan: null, customFields: {} }],
        user: { object: "user", id: rid(), email: "Buyer@Example.COM", username: null, internalId: null },
        subscription: { object: "subscription", id: "sub_demo_001", status: "incomplete" },
        lastPayment: { object: "payment", id: rid(), number: "L8FNGDEMO001-0001", status: "PENDING" }
      };
    }
    fs.mkdirSync(process.env.DIR, { recursive: true });
    fs.writeFileSync(process.env.DIR + "/payload.json", JSON.stringify(body));
    fs.writeFileSync(process.env.DIR + "/sig.txt",
      "sha256_" + crypto.createHmac("sha256", process.env.SIGN_SECRET).update(fs.readFileSync(process.env.DIR + "/payload.json")).digest("hex"));
  '
}

post() {
  curl -s -o "$TMP/resp.json" -w "%{http_code}" -m 10 -X POST \
    -H "Content-Type: application/json" -H "x-fngs-signature: $(cat "$2")" \
    --data-binary "@$3" \
    "http://127.0.0.1:$1/webhook/fungies"
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
  "provider": "fungies",
  "checkout_url": "https://demo-store.stage.fungies.net/checkout",
  "pdf_file": "products/demo.pdf",
  "currency": "USD"
}
EOF
echo "=== temp terms.json: 50% effective 2026-09-14; product config: provider=fungies, customFields correlation key product_id"

CREATED_MS="$(($(date -u -d "2026-09-15T12:00:00Z" +%s) * 1000))"
env -C "$TMP" PORT="$PORT_F" FUNGIES_WEBHOOK_SECRET="$SECRET" PAYMENTS_PRODUCT_CONFIGS="$TMP/data/settings/product_config.json" \
  setsid nohup "$TSX" "$ROOT/payments/src/webhook_server.ts" >"$TMP/server.log" 2>&1 &
PID_F=$!
wait_health "$PORT_F" || { echo "SERVER FAILED TO START — log:"; cat "$TMP/server.log"; exit 1; }

PAY_A="a1111111-2222-4333-8444-555555555555"
forge "$TMP/forge" "$PAY_A" "duane_retirement_playbook_v1" "$CREATED_MS" "1900" "payment_success"
CODE1="$(post "$PORT_F" "$TMP/forge/sig.txt" "$TMP/forge/payload.json")"
echo "=== POST #1 (payment_success, value 1900 minor units, customFields product_id) -> HTTP $CODE1"; cat "$TMP/resp.json"; echo
LINE_A="$(grep "$PAY_A" "$TMP_LEDGER" 2>/dev/null | tail -n 1)"
echo "=== ledger line: $LINE_A"

if [ "$CODE1" = "200" ] && grep -q '"recorded":true' "$TMP/resp.json"; then pass "(a) fungies payment_success accepted (HTTP 200, recorded:true)"; else fail "(a) expected HTTP 200 recorded:true, got $CODE1 $(cat "$TMP/resp.json")"; fi
if echo "$LINE_A" | grep -q '"amount_usd":19'; then pass "(a) amount_usd 19 = 1900 minor units / 10^currencyDecimals(2)"; else fail "(a) amount_usd unexpected: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"creator_split_pct":50'; then pass "(a) creator_split_pct 50 sourced from data/settings/terms.json"; else fail "(a) creator_split_pct missing/!= 50: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"creator_split_usd":9.5' && echo "$LINE_A" | grep -q '"our_split_usd":9.5'; then pass "(a) \$19.00 split 9.5/9.5 at 50%"; else fail "(a) split usd values unexpected: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"email_hash":"' && ! echo "$LINE_A" | grep -qi 'buyer@example.com'; then pass "(a) buyer email hashed, raw email absent from ledger"; else fail "(a) email hash missing or raw email leaked: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"provider":"fungies"' && echo "$LINE_A" | grep -q '"product_id":"duane_retirement_playbook_v1"' && echo "$LINE_A" | grep -q '"sale_id":"'"$PAY_A"'"'; then pass "(a) sale_id = payment.id, product_id = customFields.product_id"; else fail "(a) identity fields wrong: $LINE_A"; fi

CODE2="$(post "$PORT_F" "$TMP/forge/sig.txt" "$TMP/forge/payload.json")"
echo "=== POST #2 (webhook retry, same payment id) -> HTTP $CODE2"; cat "$TMP/resp.json"; echo
if [ "$CODE2" = "200" ] && grep -q '"reason":"duplicate"' "$TMP/resp.json"; then pass "(b) idempotency: retry deduped (HTTP 200, recorded:false)"; else fail "(b) idempotency: retry response unexpected: $(cat "$TMP/resp.json")"; fi
if [ "$(grep -c "$PAY_A" "$TMP_LEDGER" 2>/dev/null || true)" = "1" ]; then pass "(b) idempotency: exactly one ledger line for the payment"; else fail "(b) idempotency: payment id appears more than once in the ledger"; fi

SIGN_SECRET="fngs_demo_WRONG_SECRET" forge "$TMP/forge_bad" "b2222222-3333-4777-8999-aaaaaaaaaaaa" "duane_retirement_playbook_v1" "$CREATED_MS" "1900" "payment_success"
CODE3="$(post "$PORT_F" "$TMP/forge_bad/sig.txt" "$TMP/forge_bad/payload.json")"
echo "=== POST #3 (forged signature, wrong secret) -> HTTP $CODE3"; cat "$TMP/resp.json"; echo
if [ "$CODE3" = "401" ] && [ "$(wc -l < "$TMP_LEDGER")" = "1" ]; then pass "(c) bad signature rejected 401, sale NOT recorded"; else fail "(c) expected 401 + unchanged ledger, got $CODE3 lines=$(wc -l < "$TMP_LEDGER")"; fi

PAY_T="e5555555-6666-4777-8999-dddddddddddd"
TEST_MODE=true forge "$TMP/forge_testmode" "$PAY_T" "duane_retirement_playbook_v1" "$CREATED_MS" "1900" "payment_success"
CODE4="$(post "$PORT_F" "$TMP/forge_testmode/sig.txt" "$TMP/forge_testmode/payload.json")"
echo "=== POST #4 (testMode:true sandbox sale) -> HTTP $CODE4"; cat "$TMP/resp.json"; echo
if [ "$CODE4" = "202" ] && [ "$(wc -l < "$TMP_LEDGER")" = "1" ]; then pass "(d) testMode:true sale -> 202, NOT recorded (production ledger untouched)"; else fail "(d) expected 202 + unchanged ledger, got $CODE4 lines=$(wc -l < "$TMP_LEDGER")"; fi
if grep -q "testMode — not recorded" "$TMP/server.log" && grep -q "payment_success-evt-$PAY_T" "$TMP/server.log" && grep -q "sandbox event type=payment_success" "$TMP/server.log"; then pass "(d) server log loud: testMode + event type + event id + not-recorded"; else fail "(d) loud testMode log missing from server log"; fi

forge "$TMP/forge_refund" "$PAY_A" "duane_retirement_playbook_v1" "$CREATED_MS" "1900" "payment_refunded"
CODE5="$(post "$PORT_F" "$TMP/forge_refund/sig.txt" "$TMP/forge_refund/payload.json")"
echo "=== POST #5 (payment_refunded, links to recorded sale $PAY_A) -> HTTP $CODE5"; cat "$TMP/resp.json"; echo
LINE_R="$(grep '"event_type":"refund"' "$TMP_LEDGER" 2>/dev/null | tail -n 1)"
echo "=== refund ledger line: $LINE_R"
if [ "$CODE5" = "200" ] && grep -q '"recorded":true' "$TMP/resp.json" && grep -q '"event_type":"refund"' "$TMP/resp.json"; then pass "(e) payment_refunded -> HTTP 200 recorded:true event_type refund"; else fail "(e) expected 200 recorded:true event_type refund, got $CODE5 $(cat "$TMP/resp.json")"; fi
if echo "$LINE_R" | grep -q '"amount_usd":19' && echo "$LINE_R" | grep -q '"creator_split_usd":-9.5' && echo "$LINE_R" | grep -q '"our_split_usd":-9.5'; then pass "(e) refund record: amount_usd +19 kept positive, splits reversed -9.5/-9.5 from linked sale"; else fail "(e) refund split reversal wrong: $LINE_R"; fi
if echo "$LINE_R" | grep -q '"sale_id":"'"$PAY_A"'"' && echo "$LINE_R" | grep -q '"product_id":"duane_retirement_playbook_v1"' && echo "$LINE_R" | grep -q '"creator_id":"duane_retirearly500"' && echo "$LINE_R" | grep -q '"email_hash":"'; then pass "(e) refund linked by sale_id, product/creator/email_hash copied from the sale"; else fail "(e) refund linkage fields wrong: $LINE_R"; fi
if [ "$(wc -l < "$TMP_LEDGER")" = "2" ] && [ "$(grep -c '"event_type":"refund"' "$TMP_LEDGER")" = "1" ] && [ "$(grep "$PAY_A" "$TMP_LEDGER" | grep -vc '"event_type":"refund"')" = "1" ]; then pass "(e) ledger = exactly 1 sale + 1 refund for the payment"; else fail "(e) ledger shape wrong: lines=$(wc -l < "$TMP_LEDGER")"; fi

CODE6="$(post "$PORT_F" "$TMP/forge_refund/sig.txt" "$TMP/forge_refund/payload.json")"
echo "=== POST #6 (webhook retry, same refund event) -> HTTP $CODE6"; cat "$TMP/resp.json"; echo
if [ "$CODE6" = "200" ] && grep -q '"recorded":false' "$TMP/resp.json" && grep -q '"reason":"duplicate"' "$TMP/resp.json"; then pass "(e2) refund idempotency: retry deduped (HTTP 200, recorded:false)"; else fail "(e2) refund retry response unexpected: $(cat "$TMP/resp.json")"; fi
if [ "$(grep -c '"event_type":"refund"' "$TMP_LEDGER")" = "1" ]; then pass "(e2) exactly one refund line after retry"; else fail "(e2) duplicate refund leaked into ledger"; fi

forge "$TMP/forge_refund_orphan" "c3333333-4444-4888-9aaa-bbbbbbbbbbbb" "duane_retirement_playbook_v1" "$CREATED_MS" "1900" "payment_refunded"
CODE7="$(post "$PORT_F" "$TMP/forge_refund_orphan/sig.txt" "$TMP/forge_refund_orphan/payload.json")"
echo "=== POST #7 (payment_refunded for UNRECORDED payment c3333333-...) -> HTTP $CODE7"; cat "$TMP/resp.json"; echo
if [ "$CODE7" = "422" ] && grep -q 'no recorded sale' "$TMP/resp.json" && [ "$(wc -l < "$TMP_LEDGER")" = "2" ]; then pass "(e3) orphan refund refused loudly (HTTP 422, no ledger write)"; else fail "(e3) expected 422 + unchanged ledger, got $CODE7 lines=$(wc -l < "$TMP_LEDGER")"; fi
if grep -q "REFUND REFUSED" "$TMP/server.log" && grep -q "c3333333-4444-4888-9aaa-bbbbbbbbbbbb" "$TMP/server.log"; then pass "(e3) orphan refund surfaced loudly in server log (REFUND REFUSED + payment id)"; else fail "(e3) loud REFUND REFUSED log missing"; fi

echo "=== POST #8 run: daily report from temp ledger (income must NOT be inflated by the sale) ==="
"$TSX" "$ROOT/payments/src/reports.ts" --daily --date=2026-09-15 \
  --sales-file="$TMP_LEDGER" --reports-dir="$TMP/reports" \
  --config="$TMP/data/settings/product_config.json" >"$TMP/reports.log" 2>&1
REPORT="$TMP/reports/creator_duane_retirearly500_2026-09-15.md"
if [ -f "$REPORT" ]; then pass "(f) daily report written from sale+refund ledger"; cat "$REPORT"; else fail "(f) daily report missing ($(cat "$TMP/reports.log"))"; fi
if [ -f "$REPORT" ] && grep -qF -- '-$19.00 refund' "$REPORT" && grep -qF '(50% back to creator)' "$REPORT"; then pass "(f) refund row rendered distinctly (-\$19.00 refund, 50% back to creator)"; else fail "(f) distinct refund row missing from report"; fi
if [ -f "$REPORT" ] && grep -qF '**Totals (1 sale, 1 refund)** | **$0.00** | **$0.00** | **$0.00** |' "$REPORT"; then pass "(f) refund subtracted from income: totals \$19.00 sale - \$19.00 refund = \$0.00 (not inflated)"; else fail "(f) income totals wrong/inflated: $(grep 'Totals' "$REPORT" 2>/dev/null)"; fi

forge "$TMP/forge_sub" "d4444444-5555-4999-abbb-cccccccccccc" "duane_retirement_playbook_v1" "$CREATED_MS" "1900" "subscription_created"
CODE8="$(post "$PORT_F" "$TMP/forge_sub/sig.txt" "$TMP/forge_sub/payload.json")"
echo "=== POST #9 (subscription_created, no order/payment keys) -> HTTP $CODE8"; cat "$TMP/resp.json"; echo
if [ "$CODE8" = "202" ] && [ "$(wc -l < "$TMP_LEDGER")" = "2" ]; then pass "(g) subscription_created ignored at sale layer (202), ledger unchanged"; else fail "(g) expected 202 + unchanged ledger, got $CODE8 lines=$(wc -l < "$TMP_LEDGER")"; fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "=== DEMO OK ((a) signed payment_success -> terms-sourced 50% split (b) idempotency on payment.id (c) forged signature 401 (d) testMode gate 202-unrecorded (e) refund -> full-reversal ledger record (e2) refund retry idempotent (e3) orphan refund 422-refused (f) reports subtract refund, income \$0.00 (g) subscription events ignored)"
else
  echo "=== DEMO FAILED ($FAILS check(s) failed)"
  exit 1
fi
