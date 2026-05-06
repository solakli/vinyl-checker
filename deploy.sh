#!/bin/bash
# Deploy vinyl-checker to Contabo VPS
# Usage: ./deploy.sh
# Requires: ~/.ssh/contabo key

SSH_KEY="$HOME/.ssh/contabo"
VPS="root@89.117.16.160"
APP_DIR="/root/vinyl-checker"
PORT=5052

SSH="ssh -i $SSH_KEY -o ServerAliveInterval=30 $VPS"

echo "=== Deploying Vinyl Checker ==="

# ── 1. Pull latest code ────────────────────────────────────────────────────────
echo ""
echo ">>> [1/4] Pulling latest code on VPS..."
$SSH "cd $APP_DIR && git pull" || { echo "✗ git pull failed"; exit 1; }

# ── 2. Kill ALL server.js processes (listening + orphans) ─────────────────────
#      fuser kills the port-holder; pgrep mops up orphans that aren't on any port
echo ""
echo ">>> [2/4] Stopping server..."
$SSH "
  # Kill whatever is holding the port (most reliable — no name ambiguity)
  PORT_PID=\$(fuser ${PORT}/tcp 2>/dev/null | tr -d ' ' || true)
  if [ -n \"\$PORT_PID\" ]; then
    echo '  Killing port holder PID' \$PORT_PID
    kill -9 \$PORT_PID 2>/dev/null || true
  fi

  # Mop up any orphaned server.js processes (not holding the port)
  ORPHANS=\$(pgrep -f 'node.*server\.js' 2>/dev/null || true)
  if [ -n \"\$ORPHANS\" ]; then
    echo '  Killing orphan PIDs:' \$ORPHANS
    kill -9 \$ORPHANS 2>/dev/null || true
  fi

  sleep 1

  # Confirm port is clear
  STILL=\$(fuser ${PORT}/tcp 2>/dev/null | tr -d ' ' || true)
  if [ -n \"\$STILL\" ]; then
    echo '  ERROR: port ${PORT} still held by PID' \$STILL
    exit 1
  fi
  echo '  Done — port ${PORT} is free'
" || { echo "✗ Stop step failed"; exit 1; }

# ── 3. Start fresh — use setsid to fully detach from the SSH session ──────────
echo ""
echo ">>> [3/4] Starting server..."
$SSH "setsid bash -c 'cd ${APP_DIR} && nohup node server.js >> server.log 2>&1' & echo '  Started'" \
  || { echo "✗ Start failed"; exit 1; }

# ── 4. Verify ─────────────────────────────────────────────────────────────────
echo ""
echo ">>> [4/4] Verifying..."
ATTEMPTS=0
HTTP="000"
while [ "$HTTP" != "200" ] && [ $ATTEMPTS -lt 5 ]; do
  sleep 2
  HTTP=$($SSH "curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT/ 2>/dev/null" 2>/dev/null || echo "000")
  ATTEMPTS=$((ATTEMPTS+1))
  [ "$HTTP" != "200" ] && echo "  attempt $ATTEMPTS/5: HTTP $HTTP"
done

if [ "$HTTP" = "200" ]; then
  PID=$($SSH "fuser ${PORT}/tcp 2>/dev/null | tr -d ' '" 2>/dev/null || echo "?")
  echo ""
  echo "  ✓ HTTP $HTTP — PID $PID on port $PORT"
  echo ""
  echo "=== DEPLOYMENT COMPLETE ==="
  echo "    https://waxdigger.ai/vinyl/"
else
  echo ""
  echo "  ✗ Server not responding after $((ATTEMPTS*2))s (HTTP $HTTP)"
  echo ""
  echo "--- Last 20 lines of server.log ---"
  $SSH "tail -20 $APP_DIR/server.log"
  exit 1
fi
