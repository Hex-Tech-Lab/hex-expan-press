#!/usr/bin/env bash
# PreToolUse (Bash) guard: stop commands that would print environment values or secret files into the
# transcript (2026-10-15, after a messaging token was echoed). Denies only commands that print values;
# names-only listings (vercel env ls, grep -c, env-var checks) and piping a value into another command pass.
# Regression cases: .claude/hooks/test-redact-env.sh
in=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$in" 2>/dev/null) || cmd="$in"
# Heredoc bodies (commit messages, file bodies) are data, not commands: drop them before matching.
cmd=$(awk 'BEGIN{d=""} { if (d!="") { if ($0 ~ ("^" d "$")) d=""; next }
  if (match($0, /<<-?[ ]*[\x27"]?[A-Za-z_]+[\x27"]?/)) { t=substr($0,RSTART,RLENGTH); gsub(/[<>\x27" -]/,"",t); sub(/^-/,"",t); d=t }
  print }' <<<"$cmd" | tr '\n' ';' | sed 's/;$//')

deny(){
  local esc
  esc=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\t' '  ')
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$esc"
  exit 0
}

S='[[:space:]]'
SENSITIVE_RE='[A-Za-z_]*(KEY|TOKEN|SECRET|PASS|PASSWORD|DSN|AUTH|PRIVATE|CREDENTIAL|COOKIE|_URL|_URI)[A-Za-z_]*'
# Bare env / printenv / set (print everything), or printenv with any argument (prints the value).
grep -qE "(^|[;&|(])${S}*(env|set)${S}*($|[|;&)])" <<<"$cmd" && deny "Redaction guard: bare env/set prints every environment value. Use vercel env ls (names only)."
grep -qE "(^|[;&|(])${S}*printenv(${S}|$)" <<<"$cmd" && deny "Redaction guard: printenv prints environment values. Name the variable in code instead."
grep -qE "(^|[;&|(])${S}*(export|declare|typeset)${S}+-[a-zA-Z]*p" <<<"$cmd" && deny "Redaction guard: export -p / declare -p dump every variable."
grep -qE "/proc/[^[:space:]]*/environ" <<<"$cmd" && deny "Redaction guard: /proc/*/environ holds every process environment."
# Readers on dotenv files print their lines. Piping a single value out of .env is the allowed path.
grep -qE "(^|[;&|(])${S}*(cat|less|more|head|tail|bat|strings|xxd|od|nl|tac|sed|awk|cut|tee)${S}[^|;&]*\.env([._[:space:]]|$)" <<<"$cmd" && deny "Redaction guard: reading a .env file prints its secrets. Grep for one variable name and pipe only its value into the consumer."
# Echo or printf of a secret-named variable.
if grep -qE "(^|[;&|(])${S}*(echo|printf|print)${S}" <<<"$cmd" && grep -qE "\\\$\{?${SENSITIVE_RE}" <<<"$cmd"; then
  deny "Redaction guard: echo/printf of a secret-named variable prints its value."
fi
exit 0
