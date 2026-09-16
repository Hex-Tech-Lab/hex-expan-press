#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
[ -x "$TSX" ] || { echo "tsx not found at $TSX"; exit 1; }

TMP="$(mktemp -d /tmp/opencode/demo_rails.XXXXXX)"
STATE="$TMP/data/settings/rail_state.json"
P2_PICKS="$TMP/p2_picks.txt"
FAILS=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

run_snippet() {
  env -C "$TMP" PICKS_OUT="$P2_PICKS" STATE="$STATE" "$TSX" "$1"
}

mkdir -p "$TMP/data/settings"
cp "$ROOT/data/settings/providers.json" "$TMP/data/settings/providers.json"

cat > "$TMP/s0_validate.ts" <<EOF
import { parseProduct } from "${ROOT}/payments/src/settings.ts";
const base = { product_id: "p", title: "t", price_usd: 19, creator_id: "c", creator_split_pct: 50, provider: "fungies", checkout_url: "https://x.example", pdf_file: "f.pdf", currency: "USD" };
let bad = 0;
function expectThrow(name: string, cfg: unknown, needle: string): void {
  try {
    parseProduct(cfg, "s0");
    console.log("S0FAIL " + name + ": expected throw containing \"" + needle + "\"");
    bad = 1;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes(needle)) console.log("S0OK reject-" + name);
    else {
      console.log("S0FAIL " + name + ": message lacks \"" + needle + "\": " + msg);
      bad = 1;
    }
  }
}
const ok = parseProduct({ ...base, rails: [{ provider: "fungies", weight: 3 }, { provider: "polar", weight: 2 }], rail_policy: "rotate" }, "s0");
console.log("S0OK rails-parsed providers=" + (ok.rails ?? []).map((r) => r.provider).join("+") + " policy=" + String(ok.rail_policy));
expectThrow("rotate-single", { ...base, rails: [{ provider: "fungies", weight: 1 }], rail_policy: "rotate" }, "rotate");
expectThrow("rotate-no-rails", { ...base, rail_policy: "rotate" }, "rotate");
expectThrow("zero-weight", { ...base, rails: [{ provider: "fungies", weight: 0 }, { provider: "polar", weight: 1 }] }, "weight");
expectThrow("negative-weight", { ...base, rails: [{ provider: "fungies", weight: -2 }, { provider: "polar", weight: 1 }] }, "weight");
expectThrow("nonfinite-weight", { ...base, rails: [{ provider: "fungies", weight: "3" }, { provider: "polar", weight: 1 }] }, "weight");
expectThrow("bad-policy", { ...base, rails: [{ provider: "fungies", weight: 1 }, { provider: "polar", weight: 1 }], rail_policy: "spin" }, "rail_policy");
expectThrow("duplicate-provider", { ...base, rails: [{ provider: "fungies", weight: 1 }, { provider: "fungies", weight: 1 }], rail_policy: "rotate" }, "duplicate");
expectThrow("unregistered-provider", { ...base, rails: [{ provider: "not_a_provider", weight: 1 }, { provider: "polar", weight: 1 }], rail_policy: "rotate" }, "registered payment provider");
const legacy = parseProduct(base, "s0");
console.log("S0OK legacy-shape rails=" + String(legacy.rails === undefined) + " policy=" + String(legacy.rail_policy === undefined));
if (bad) process.exit(1);
EOF

cat > "$TMP/s1_smooth.ts" <<EOF
import { nextRail } from "${ROOT}/payments/src/rails.ts";
const rails = [{ provider: "a", weight: 3 }, { provider: "b", weight: 2 }, { provider: "c", weight: 1 }];
const picks: string[] = [];
for (let i = 0; i < 12; i++) picks.push(nextRail("p1", rails));
const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
let maxRun = 1;
let run = 1;
for (let i = 0; i < picks.length; i++) {
  counts[picks[i]] += 1;
  if (i > 0 && picks[i] === picks[i - 1]) {
    run += 1;
    if (run > maxRun) maxRun = run;
  } else {
    run = 1;
  }
}
console.log("S1SEQ=" + picks.join(""));
console.log("S1COUNTS a=" + counts.a + " b=" + counts.b + " c=" + counts.c);
console.log("S1MAXRUN=" + maxRun);
EOF

cat > "$TMP/s2_ratio.ts" <<EOF
import { nextRail } from "${ROOT}/payments/src/rails.ts";
import { writeFileSync } from "node:fs";
const rails = [{ provider: "a", weight: 60 }, { provider: "b", weight: 25 }, { provider: "c", weight: 15 }];
const picks: string[] = [];
for (let i = 0; i < 20; i++) picks.push(nextRail("p2", rails));
const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
for (const p of picks) counts[p] += 1;
writeFileSync(process.env.PICKS_OUT as string, picks.join("\n") + "\n", "utf8");
console.log("S2COUNTS a=" + counts.a + " b=" + counts.b + " c=" + counts.c);
EOF

cat > "$TMP/s2b_restart.ts" <<EOF
import { nextRail, railCounter } from "${ROOT}/payments/src/rails.ts";
import { appendFileSync } from "node:fs";
const before = railCounter("p2");
console.log("S2BCOUNTER=" + before);
const rails = [{ provider: "a", weight: 60 }, { provider: "b", weight: 25 }, { provider: "c", weight: 15 }];
const picks: string[] = [];
for (let i = 0; i < 5; i++) picks.push(nextRail("p2", rails));
appendFileSync(process.env.PICKS_OUT as string, picks.join("\n") + "\n", "utf8");
console.log("S2BPICKS=" + picks.join(""));
EOF

cat > "$TMP/s3_down.ts" <<EOF
import { nextRail, skipRail } from "${ROOT}/payments/src/rails.ts";
import { readFileSync } from "node:fs";
const rails = [{ provider: "a", weight: 3 }, { provider: "b", weight: 2 }, { provider: "c", weight: 1 }];
skipRail("p3", "a", rails);
const picks: string[] = [];
for (let i = 0; i < 6; i++) picks.push(nextRail("p3", rails));
const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
for (const p of picks) counts[p] += 1;
console.log("S3SEQ=" + picks.join(""));
console.log("S3COUNTS a=" + counts.a + " b=" + counts.b + " c=" + counts.c);
const state = JSON.parse(readFileSync(process.env.STATE as string, "utf8"));
console.log("S3DOWNA=" + state.p3.down.a);
EOF

cat > "$TMP/s4a_reset.ts" <<EOF
import { resetRails } from "${ROOT}/payments/src/rails.ts";
resetRails();
console.log("S4RESET=done");
EOF

cat > "$TMP/s4b_fresh.ts" <<EOF
import { nextRail } from "${ROOT}/payments/src/rails.ts";
const rails = [{ provider: "a", weight: 3 }, { provider: "b", weight: 2 }, { provider: "c", weight: 1 }];
console.log("S4PICK=" + nextRail("p5", rails));
EOF

echo "=== stage 0: parseProduct rail schema + registry validation (against real data/settings/providers.json copy) ==="
if run_snippet s0_validate.ts > "$TMP/s0.log" 2>&1 && ! grep -q "S0FAIL" "$TMP/s0.log" && [ "$(grep -c "S0OK" "$TMP/s0.log")" -ge 5 ]; then
  pass "(0) parseProduct: rails parsed (fungies+polar, rotate) + 8 invalid configs rejected + legacy shape unchanged"
  grep "S0OK" "$TMP/s0.log" | sed 's/^/       /'
else
  fail "(0) parseProduct rail validation: $(cat "$TMP/s0.log")"
fi

echo
echo "=== stage 1: weights 3/2/1 -> smooth AABBC-class sequence (12 picks) ==="
S1_OUT="$(run_snippet s1_smooth.ts)" || { echo "$S1_OUT"; fail "(1) s1 snippet crashed"; }
S1_SEQ="$(echo "$S1_OUT" | sed -n 's/^S1SEQ=//p')"
S1_COUNTS="$(echo "$S1_OUT" | sed -n 's/^S1COUNTS //p')"
S1_MAXRUN="$(echo "$S1_OUT" | sed -n 's/^S1MAXRUN=//p')"
echo "=== sequence: $S1_SEQ | counts: $S1_COUNTS | max consecutive run: $S1_MAXRUN"
if [ "$S1_COUNTS" = "a=6 b=4 c=2" ]; then pass "(1) weights 3/2/1 over 12 picks = exactly 6A/4B/2C"; else fail "(1) counts wrong: $S1_COUNTS (want a=6 b=4 c=2)"; fi
if [ -n "$S1_MAXRUN" ] && [ "$S1_MAXRUN" -le 3 ]; then pass "(1) max consecutive same-provider run = $S1_MAXRUN (<= 3)"; else fail "(1) max run wrong/missing: '$S1_MAXRUN'"; fi
if echo "$S1_SEQ" | grep -qE 'aaa|bbb|ccc'; then fail "(1) clumpy blocking found in sequence: $S1_SEQ"; else pass "(1) no AAA/BBB/CCC blocking — smooth interleaved cycle"; fi

echo
echo "=== stage 2: weights 60/25/15 -> 20 picks = 12/5/3 ==="
S2_OUT="$(run_snippet s2_ratio.ts)" || { echo "$S2_OUT"; fail "(2) s2 snippet crashed"; }
S2_COUNTS="$(echo "$S2_OUT" | sed -n 's/^S2COUNTS //p')"
echo "=== counts: $S2_COUNTS"
if [ "$S2_COUNTS" = "a=12 b=5 c=3" ]; then pass "(2) weights 60/25/15 over 20 picks = exactly 12/5/3"; else fail "(2) counts wrong: $S2_COUNTS (want a=12 b=5 c=3)"; fi

echo
echo "=== stage 2b: simulated restart (fresh tsx process reads persisted counter) ==="
S2B_OUT="$(run_snippet s2b_restart.ts)" || { echo "$S2B_OUT"; fail "(2b) s2b snippet crashed"; }
S2B_COUNTER="$(echo "$S2B_OUT" | sed -n 's/^S2BCOUNTER=//p')"
echo "=== counter seen by the new process before picking: $S2B_COUNTER"
if [ "$S2B_COUNTER" = "20" ]; then pass "(2b) restart survival: new process reads counter=20 from rail_state.json"; else fail "(2b) counter lost on restart: '$S2B_COUNTER'"; fi
LINES="$(wc -l < "$P2_PICKS")"
CA="$(grep -c '^a$' "$P2_PICKS" || true)"
CB="$(grep -c '^b$' "$P2_PICKS" || true)"
CC="$(grep -c '^c$' "$P2_PICKS" || true)"
if [ "$LINES" = "25" ] && [ "$CA" = "15" ] && [ "$CB" = "6" ] && [ "$CC" = "4" ]; then pass "(2b) cumulative 25 picks across both processes = 15/6/4 (largest-remainder quotas)"; else fail "(2b) cumulative counts wrong: lines=$LINES a=$CA b=$CB c=$CC (want 25 / 15/6/4)"; fi

echo
echo "=== stage 3: mark rail A down -> picks flip to B/C at renormalized 2:1 ==="
S3_OUT="$(run_snippet s3_down.ts)" || { echo "$S3_OUT"; fail "(3) s3 snippet crashed"; }
S3_SEQ="$(echo "$S3_OUT" | sed -n 's/^S3SEQ=//p')"
S3_COUNTS="$(echo "$S3_OUT" | sed -n 's/^S3COUNTS //p')"
S3_DOWN="$(echo "$S3_OUT" | sed -n 's/^S3DOWNA=//p')"
echo "=== sequence: $S3_SEQ | counts: $S3_COUNTS | down.a until: $S3_DOWN"
if [ "$S3_COUNTS" = "a=0 b=4 c=2" ]; then pass "(3) A down: 6 picks all B/C at renormalized 2:1 (b=4 c=2, a=0)"; else fail "(3) down-rail counts wrong: $S3_COUNTS (want a=0 b=4 c=2)"; fi
if [ -n "$S3_DOWN" ] && [ "$(date -u -d "$S3_DOWN" +%s 2>/dev/null || echo 0)" -gt "$(date -u +%s)" ]; then pass "(3) down map persisted in rail_state.json with future until_ts"; else fail "(3) down entry missing/expired in rail_state.json: '$S3_DOWN'"; fi

echo
echo "=== stage 4: resetRails helper (demo hygiene) ==="
run_snippet s4a_reset.ts > "$TMP/s4a.log" 2>&1
if [ ! -f "$STATE" ]; then pass "(4a) resetRails removed the state file"; else fail "(4a) state file still present after resetRails"; fi
S4B_OUT="$(run_snippet s4b_fresh.ts)" || { echo "$S4B_OUT"; fail "(4b) s4b snippet crashed"; }
S4_PICK="$(echo "$S4B_OUT" | sed -n 's/^S4PICK=//p')"
if [ "$S4_PICK" = "a" ] && [ -f "$STATE" ]; then pass "(4b) post-reset first pick = a (heaviest rail, fresh counter) + state file recreated"; else fail "(4b) post-reset pick/state wrong: pick='$S4_PICK' file=$([ -f "$STATE" ] && echo present || echo absent)"; fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "=== DEMO OK ((0) rail schema+registry validation (1) 3/2/1 smooth 6/4/2 (2) 60/25/15 exact 12/5/3 (2b) counter survives restart (3) down-rail renormalized failover (4) resetRails hygiene)"
else
  echo "=== DEMO FAILED ($FAILS check(s) failed)"
  exit 1
fi
