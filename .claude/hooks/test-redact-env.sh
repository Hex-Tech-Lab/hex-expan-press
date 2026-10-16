#!/usr/bin/env bash
# Regression cases for .claude/hooks/redact-env.sh. Usage: bash .claude/hooks/test-redact-env.sh
HOOK="$(cd "$(dirname "$0")" && pwd)/redact-env.sh"
pass=0; fail=0
expect(){ # expect <allow|deny> <command>
  local out d
  out=$(jq -n --arg c "$2" '{tool_input:{command:$c}}' | bash "$HOOK" 2>&1)
  if grep -qE '"permissionDecision": ?"deny"' <<<"$out"; then d=deny; else d=allow; fi
  if [ "$d" = "$1" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL want=$1 got=$d :: $2"; fi
}
for c in 'env' 'printenv' 'printenv RESEND_API_KEY' 'set' 'ls && set' 'export -p' 'declare -p' 'cat /proc/self/environ' \
  'cat .env' 'sed -n 1,5p .env.local' 'head -3 ./.env' 'echo $RESEND_API_KEY' 'printf "%s" "$DUB_API_KEY"' 'echo ${SUPABASE_SECRET_KEY}' 'env | grep KEY' \
  'echo $DATABASE_URL' 'printenv REDIS_URL' 'printf "%s" "$SESSION_COOKIE"' 'echo ${POSTGRES_URL}' 'echo $SUPABASE_CREDENTIALS'; do
  expect deny "$c"
done
for c in 'vercel env ls production' 'env NODE_ENV=test node x.js' 'set -e' 'grep -c "^RESEND_API_KEY=" .env' \
  "grep '^RESEND_API_KEY=' .env | cut -d= -f2- | vercel env add RESEND_API_KEY production" 'echo "hello world"' 'printf "%s" "$NODE_ENV"' 'git status'; do
  expect allow "$c"
done
# Heredoc bodies are data: a commit message naming a print path is allowed; a real env after the heredoc is not.
expect allow "$(printf 'git commit -F - <<'"'"'EOF'"'"'\n/proc/x/environ is a path name\nEOF')"
expect deny "$(printf 'cat <<EOF\nhi\nEOF\nenv')"
echo "redact-env regression: $pass passed, $fail failed"; [ "$fail" -eq 0 ]
