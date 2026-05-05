#!/bin/bash
# Deploy vinyl-checker to Contabo VPS
# Usage: ./deploy.sh
# Requires: ~/.ssh/contabo key

set -euo pipefail

SSH_KEY="$HOME/.ssh/contabo"
VPS="root@89.117.16.160"
APP_DIR="/root/vinyl-checker"
PORT=5052

SSH="ssh -i $SSH_KEY $VPS"

echo "=== Deploying Vinyl Checker ==="

# ── 1. Push must already be done (deploy.sh is called after git push) ─────────
echo ""
echo ">>> [1/4] Pulling latest code on VPS..."
$SSH "cd $APP_DIR && git pull"

# ── 2. Kill ALL server.js processes, then wait for port to be free ────────────
echo ""
echo ">>> [2/4] Stopping old server (all processes)..."
$SSH "
  PIDS=\$(pgrep -f 'node.*server\.js' 2>/dev/null || true)
  if [ -n \"\$PIDS\" ]; then
    echo \"  Sending TERM to PIDs: \$PIDS\"
    kill -TERM \$PIDS 2>/dev/null || true
    sleep 2
    # Force-kill any survivors
    SURVIVORS=\$(pgrep -f 'node.*server\.js' 2>/dev/null || true)
    if [ -n \"\$SURVIVORS\" ]; then
      echo \"  Force-killing survivors: \$SURVIVORS\"
      kill -9 \$SURVIVORS 2>/dev/null || true
    fi
  else
    echo '  No server.js processes found'
  fi

  # Wait for port $PORT to be free (up to 10 s)
  for i in 1 2 3 4 5; do
    if ss -tlnp | grep -q ':$PORT '; then
      echo \"  Port $PORT still in use — waiting (\$i/5)...\"
      sleep 2
    else
      break
    fi
  done

  if ss -tlnp | grep -q ':$PORT '; then
    echo '  ERROR: port $PORT still occupied after 10 s — aborting'
    exit 1
  else
    echo '  Port $PORT is free'
  fi
"

# ── 3. Start fresh ────────────────────────────────────────────────────────────
echo ""
echo ">>> [3/4] Starting server..."
$SSH "cd $APP_DIR && nohup node server.js >> server.log 2>&1 & echo \"  Started PID \$!\""

# ── 4. Verify (give it 5 s to bind) ──────────────────────────────────────────
echo ""
echo ">>> [4/4] Verifying..."
sleep 5
HTTP=$($SSH "curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT/ 2>/dev/null || echo 000")
LISTENING=$($SSH "ss -tlnp | grep ':$PORT ' | awk '{print \$5}'" || echo "")

if [ "$HTTP" = "200" ]; then
  echo ""
  echo "  ✓ Listening: $LISTENING"
  echo "  ✓ HTTP: $HTTP"
  echo ""
  echo "=== DEPLOYMENT COMPLETE ==="
  echo "    https://stream.ronautradio.la/vinyl/"
else
  echo ""
  echo "  ✗ HTTP $HTTP — server did not come up cleanly"
  echo ""
  echo "--- Last 30 lines of server.log ---"
  $SSH "tail -30 $APP_DIR/server.log"
  exit 1
fi
