#!/usr/bin/env bash
# preflight.sh — catch top recurring bug patterns before pushing to waxdigger.ai
# Run from project root: ./scripts/preflight.sh
# Exit 0 = clean, 1 = issues found

PASS=0
FAIL=0
WARNS=()

ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; WARNS+=("$1"); FAIL=$((FAIL+1)); }
hdr()  { echo; echo "── $1 ──"; }

# ──────────────────────────────────────────────────────────────────────────
hdr "1. Event loop — sync calls in async contexts"

# Find execSync/spawnSync that are actual code (not in comments) and not in
# the deploy webhook block (which is intentionally synchronous — one-shot git pull)
DEPLOY_START=$(grep -n "app\.post.*api/deploy\|\/api\/deploy" server.js 2>/dev/null | head -1 | cut -d: -f1)
DEPLOY_START=${DEPLOY_START:-0}
DEPLOY_END=$((DEPLOY_START + 80))

BAD_SYNC=""
while IFS=: read -r file lineno rest; do
  # Skip pure comments
  trimmed="${rest#"${rest%%[! ]*}"}"  # ltrim
  [[ "$trimmed" == //* ]] && continue
  # Skip if inside the /api/deploy handler block
  if [[ "$file" == "server.js" ]] && \
     [ "$lineno" -gt "$DEPLOY_START" ] && [ "$lineno" -lt "$DEPLOY_END" ]; then
    continue
  fi
  BAD_SYNC="$BAD_SYNC\n    $file:$lineno: $rest"
done < <(grep -n "execSync\|spawnSync" server.js lib/scanner.js 2>/dev/null || true)

if [ -n "$BAD_SYNC" ]; then
  fail "execSync/spawnSync outside deploy handler (use async exec() instead):"
  echo -e "$BAD_SYNC"
else
  ok "No execSync/spawnSync in timer/request contexts"
fi

# reapChrome specifically — it runs on a 10-min timer, must have no sync fs calls
REAPER_SYNC=$(sed -n '/^function reapChrome/,/^}/p' server.js 2>/dev/null \
  | grep -v "^\s*//" | grep "readFileSync\|readdirSync\|statSync\|rmSync" || true)
if [ -n "$REAPER_SYNC" ]; then
  fail "Sync fs calls inside reapChrome() — blocks event loop every 10 min"
else
  ok "reapChrome() free of sync fs calls"
fi

# ──────────────────────────────────────────────────────────────────────────
hdr "2. DB function name consistency"

# Get all exported function names from db.js
DB_EXPORTS=$(node -e "try{const m=require('./db.js');console.log(Object.keys(m).join('\n'))}catch(e){}" 2>/dev/null || true)
if [ -z "$DB_EXPORTS" ]; then
  # Fallback: parse module.exports keys from source
  DB_EXPORTS=$(grep "    [a-zA-Z_][a-zA-Z0-9_]*[,:]" db.js 2>/dev/null | grep -oE "^\s+[a-zA-Z_][a-zA-Z0-9_]+" | tr -d ' ' | sort -u || true)
fi

# Find all db.X() call sites (excluding db itself and known built-ins)
DB_CALLS=$(grep -oh "db\.[a-zA-Z_][a-zA-Z0-9_]*" server.js lib/pipeline-stages/*.js lib/scanner.js 2>/dev/null \
  | grep -vE "db\.(prepare|exec|transaction|pragma|close|getDb|default|all|get|run|js)" \
  | sort -u || true)

MISSING=()
while IFS= read -r call; do
  fn="${call#db.}"
  [ -z "$fn" ] && continue
  if [ -n "$DB_EXPORTS" ] && ! echo "$DB_EXPORTS" | grep -qxF "$fn"; then
    MISSING+=("$call")
  fi
done <<< "$DB_CALLS"

if [ ${#MISSING[@]} -gt 0 ]; then
  fail "db.X() calls with no matching export in db.js: ${MISSING[*]}"
  echo "    → Run: grep -n 'module.exports' db.js to see what's exported"
else
  ok "All db.X() calls have matching exports"
fi

# ──────────────────────────────────────────────────────────────────────────
hdr "3. Startup job guards"

# syncStaleStores() should only be called inside setInterval/setTimeout, never bare
# Check for lines with syncStaleStores() that are NOT inside a timer callback
# Strategy: flag any call that isn't on a line after setInterval/setTimeout, inside a function body
BARE_CALLS=$(python3 - << 'PYEOF' 2>/dev/null
import re

with open('server.js') as f:
    lines = f.readlines()

# Find lines with syncStaleStores() call (not definition, not comment)
for i, line in enumerate(lines):
    stripped = line.strip()
    if 'syncStaleStores()' not in stripped:
        continue
    if stripped.startswith('//') or 'function syncStaleStores' in stripped:
        continue
    # Look back up to 5 lines for setInterval/setTimeout wrapper
    context = ''.join(lines[max(0,i-5):i+1])
    if 'setInterval' in context or 'setTimeout' in context or 'syncStaleStores()' in context.split('syncStaleStores')[0]:
        # probably inside a timer callback
        pass
    else:
        print(f"  line {i+1}: {stripped}")
PYEOF
)

if [ -n "$BARE_CALLS" ]; then
  fail "syncStaleStores() may be called outside a timer (crash loop risk):"
  echo "$BARE_CALLS"
else
  ok "syncStaleStores() only called inside timer callbacks"
fi

# ──────────────────────────────────────────────────────────────────────────
hdr "4. Health / ping endpoints"

# /api/ping must respond instantly — no DB queries allowed
PING_CODE=$(awk '/app\.(get|post)\(['"'"'"]\/api\/ping/,/^\}\)/' server.js 2>/dev/null | grep -v "^app\.\|function (req" | head -10)
if echo "$PING_CODE" | grep -qE "\.prepare|db\.all|db\.get|db\.run"; then
  fail "/api/ping contains DB queries — watchdog hits this with 8s timeout, keep it instant"
else
  ok "/api/ping has no DB queries"
fi

# ──────────────────────────────────────────────────────────────────────────
hdr "5. Chrome process management — reapChrome()"

# The dangerous pattern is only in the REAPER (periodic cleanup job).
# process.kill inside finally{} blocks is fine — those own their browser instance.
# Only check that the reapChrome() function guards with chromeLock before bulk-killing.
REAPER_BODY=$(sed -n '/^function reapChrome/,/^}/p' server.js 2>/dev/null)
if [ -z "$REAPER_BODY" ]; then
  ok "reapChrome() not found (no periodic reaper to check)"
elif ! echo "$REAPER_BODY" | grep -q "chromeLock"; then
  fail "reapChrome() kills Chrome without checking chromeLock — will kill live scans every 10 min"
else
  ok "reapChrome() checks chromeLock before killing"
fi

# ──────────────────────────────────────────────────────────────────────────
hdr "6. Pipeline column names"

# pipeline_jobs uses 'claimed_at' not 'started_at' — scan_runs does use started_at (fine)
# Only flag if 'started_at' appears together with 'pipeline_jobs' on the same line or nearby
if grep -n "pipeline_jobs" server.js lib/pipeline-stages/*.js 2>/dev/null \
   | grep -v "//" | grep -q "started_at"; then
  fail "pipeline_jobs query uses 'started_at' — the column is 'claimed_at'"
else
  ok "pipeline_jobs queries use claimed_at (not started_at)"
fi

# ──────────────────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────"
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "$FAIL" -gt 0 ]; then
  echo
  echo "Fix before pushing:"
  for w in "${WARNS[@]}"; do echo "  • $w"; done
  echo
  exit 1
else
  echo "All checks passed — safe to push."
  exit 0
fi
