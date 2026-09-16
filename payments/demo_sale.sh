#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
[ -x "$TSX" ] || { echo "tsx not found at $TSX"; exit 1; }

PORT_A="${PAYMENTS_DEMO_PORT:-8879}"
PORT_B=$((PORT_A + 1))
SECRET="whsec_demo_TEST_ONLY_123"
TMP="$(mktemp -d /tmp/opencode/demo_sale.XXXXXX)"
REAL_LEDGER="$ROOT/data/db/sales.jsonl"
REAL_TERMS="$ROOT/data/settings/terms.json"
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
  stop_server "${PID_A:-}"
  stop_server "${PID_B:-}"
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
  DIR="$1" SALE_ID="$2" PRODUCT_ID="$3" CREATED_AT="$4" TOTAL_CENTS="$5" SECRET="$SECRET" node -e '
    const fs = require("fs"), crypto = require("crypto");
    const body = {
      meta: { event_name: "order_created", custom_data: { product_id: process.env.PRODUCT_ID } },
      data: {
        id: process.env.SALE_ID,
        attributes: { status: "paid", total: Number(process.env.TOTAL_CENTS), currency: "USD",
          user_email: "Buyer@Example.COM", created_at: process.env.CREATED_AT }
      }
    };
    fs.mkdirSync(process.env.DIR, { recursive: true });
    fs.writeFileSync(process.env.DIR + "/payload.json", JSON.stringify(body));
    fs.writeFileSync(process.env.DIR + "/sig.txt",
      crypto.createHmac("sha256", process.env.SECRET).update(fs.readFileSync(process.env.DIR + "/payload.json")).digest("hex"));
  '
}

post() {
  curl -s -o "$TMP/resp.json" -w "%{http_code}" -m 10 -X POST \
    -H "Content-Type: application/json" -H "X-Signature: $(cat "$TMP/forge/sig.txt")" \
    --data-binary "@$TMP/forge/payload.json" \
    "http://127.0.0.1:$1/webhook/lemonsqueezy"
}

[ -f "$REAL_TERMS" ] || { echo "FAIL: $REAL_TERMS missing (seed it before running the demo)"; exit 1; }

echo "=== stage A: repo-root server against REAL data/settings/terms.json — (a) terms-sourced 50% + (b) idempotency ==="
cd "$ROOT"
PORT="$PORT_A" LEMONSQUEEZY_WEBHOOK_SECRET="$SECRET" setsid nohup "$TSX" "$ROOT/payments/src/webhook_server.ts" >"$TMP/server_a.log" 2>&1 &
PID_A=$!
wait_health "$PORT_A" || { echo "SERVER A FAILED TO START — log:"; cat "$TMP/server_a.log"; exit 1; }

ORD_A="ord_demo_a_$(date +%s)"
forge "$TMP/forge" "$ORD_A" "duane_retirement_playbook_v1" "2026-09-15T12:00:00.000Z" "1900"
CODE1="$(post "$PORT_A")"
echo "=== POST #1 (sale ts 2026-09-15, config legacy seed also says 50) -> HTTP $CODE1"; cat "$TMP/resp.json"; echo
CODE2="$(post "$PORT_A")"
echo "=== POST #2 (webhook retry, same sale_id) -> HTTP $CODE2"; cat "$TMP/resp.json"; echo
LINE_A="$(grep "$ORD_A" "$REAL_LEDGER" 2>/dev/null | tail -n 1)"
echo "=== ledger line: $LINE_A"

if [ "$CODE1" = "200" ]; then pass "(a) stage A: duane sale accepted (HTTP 200)"; else fail "(a) stage A: expected HTTP 200, got $CODE1"; fi
if echo "$LINE_A" | grep -q '"creator_split_pct":50'; then pass "(a) stage A: creator_split_pct 50 sourced from data/settings/terms.json"; else fail "(a) stage A: ledger line lacks creator_split_pct 50: $LINE_A"; fi
if echo "$LINE_A" | grep -q '"creator_split_usd":9.5'; then pass "(a) stage A: \$19.00 split 9.5/9.5 at 50%"; else fail "(a) stage A: split usd values unexpected: $LINE_A"; fi
if [ "$CODE2" = "200" ] && grep -q '"reason":"duplicate"' "$TMP/resp.json"; then pass "(b) idempotency: retry deduped (HTTP 200, recorded:false)"; else fail "(b) idempotency: retry response unexpected: $(cat "$TMP/resp.json")"; fi
if [ "$(grep -c "$ORD_A" "$REAL_LEDGER" 2>/dev/null || true)" = "1" ]; then pass "(b) idempotency: exactly one ledger line for the sale"; else fail "(b) idempotency: sale id appears more than once in the ledger"; fi

stop_server "$PID_A"
PID_A=""

grep -v "$ORD_A" "$REAL_LEDGER" > "$TMP/real_clean.jsonl" || true
mv "$TMP/real_clean.jsonl" "$REAL_LEDGER"
echo "=== stage A demo line purged from real ledger ($(wc -l < "$REAL_LEDGER") lines remain)"

echo
echo "=== stage B: isolated temp cwd (terms + ledger under $TMP/data) — (c) date-based winner flip + (d) loud no-terms failure ==="
mkdir -p "$TMP/data/settings"
cat > "$TMP/data/settings/terms.json" <<'EOF'
{
  "terms": [
    {
      "creator_id": "duane_retirearly500",
      "product_id": "duane_retirement_playbook_v1",
      "effective_from": "2026-09-14",
      "creator_split_pct": 50,
      "note": "demo: example split value"
    },
    {
      "creator_id": "duane_retirearly500",
      "product_id": "duane_retirement_playbook_v1",
      "effective_from": "2026-09-01",
      "creator_split_pct": 80,
      "note": "demo: pre-dated 80/20 entry proving date-based winner selection"
    }
  ]
}
EOF
echo "=== temp terms.json: 50% effective 2026-09-14 + pre-dated 80% effective 2026-09-01"

env -C "$TMP" PORT="$PORT_B" LEMONSQUEEZY_WEBHOOK_SECRET="$SECRET" setsid nohup "$TSX" "$ROOT/payments/src/webhook_server.ts" >"$TMP/server_b.log" 2>&1 &
PID_B=$!
wait_health "$PORT_B" || { echo "SERVER B FAILED TO START — log:"; cat "$TMP/server_b.log"; exit 1; }

ORD_C1="ord_demo_c1_$(date +%s)"
forge "$TMP/forge" "$ORD_C1" "duane_retirement_playbook_v1" "2026-09-02T09:00:00.000Z" "1900"
CODE_C1="$(post "$PORT_B")"
echo "=== POST sale ts 2026-09-02 (only the 80% entry is effective) -> HTTP $CODE_C1"; cat "$TMP/resp.json"; echo
LINE_C1="$(grep "$ORD_C1" "$TMP_LEDGER" | tail -n 1)"
echo "=== ledger line: $LINE_C1"
if [ "$CODE_C1" = "200" ] && echo "$LINE_C1" | grep -q '"creator_split_pct":80'; then pass "(c) 2026-09-02 sale -> 80% (pre-dated entry wins)"; else fail "(c) 2026-09-02 sale expected 80%, got code=$CODE_C1 line=$LINE_C1"; fi

ORD_C2="ord_demo_c2_$(date +%s)"
forge "$TMP/forge" "$ORD_C2" "duane_retirement_playbook_v1" "2026-09-15T12:00:00.000Z" "1900"
CODE_C2="$(post "$PORT_B")"
echo "=== POST sale ts 2026-09-15 (winner flips to the 2026-09-14 entry) -> HTTP $CODE_C2"; cat "$TMP/resp.json"; echo
LINE_C2="$(grep "$ORD_C2" "$TMP_LEDGER" | tail -n 1)"
echo "=== ledger line: $LINE_C2"
if [ "$CODE_C2" = "200" ] && echo "$LINE_C2" | grep -q '"creator_split_pct":50'; then pass "(c) 2026-09-15 sale -> 50% (effective-dated winner flipped)"; else fail "(c) 2026-09-15 sale expected 50%, got code=$CODE_C2 line=$LINE_C2"; fi

ORD_D="ord_demo_d_$(date +%s)"
forge "$TMP/forge" "$ORD_D" "prod_demo_001" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "1900"
CODE_D="$(post "$PORT_B")"
echo "=== POST sale for landing product prod_demo_001 (creator_007 has NO terms) -> HTTP $CODE_D"; cat "$TMP/resp.json"; echo
if [ "$CODE_D" = "500" ] && grep -q 'creator=creator_007' "$TMP/resp.json"; then pass "(d) no-terms lookup failed loudly (HTTP 500 naming creator/product/sale)"; else fail "(d) expected HTTP 500 naming creator_007, got $CODE_D $(cat "$TMP/resp.json")"; fi
if [ "$(wc -l < "$TMP_LEDGER")" = "2" ]; then pass "(d) sale NOT recorded (ledger holds exactly the 2 (c) sales)"; else fail "(d) ghost sale leaked into the ledger"; fi
if grep -q "no effective creator terms" "$TMP/server_b.log" && grep -q "creator=creator_007" "$TMP/server_b.log" && grep -q "product=prod_demo_001" "$TMP/server_b.log" && grep -q "sale=$ORD_D" "$TMP/server_b.log"; then pass "(d) server log shows loud error naming creator/product/sale_id"; else fail "(d) loud error missing from server log"; fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "=== DEMO OK ((a) terms-sourced 50% (b) idempotency (c) date-based winner flip (d) loud no-terms failure)"
else
  echo "=== DEMO FAILED ($FAILS check(s) failed)"
  exit 1
fi
