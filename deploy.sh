#!/bin/bash
# Deploy vinyl-checker to Contabo VPS
# Usage: ./deploy.sh

VPS="root@89.117.16.160"
PASS="Caswell123@"
APP_DIR="/root/vinyl-checker"
PORT=5052

echo "=== Deploying Vinyl Checker to VPS ==="

expect -c "
set timeout 300
spawn ssh -o StrictHostKeyChecking=no $VPS
expect \"password:\"
send \"${PASS}\r\"
expect \"#\"

# Step 1: Install Chromium
puts \"\n>>> Installing Chromium...\"
send \"apt-get update -qq && apt-get install -y -qq chromium-browser 2>/dev/null || apt-get install -y -qq chromium 2>/dev/null; echo CHROMIUM_DONE\r\"
expect \"CHROMIUM_DONE\"

# Step 2: Clone or pull repo
puts \"\n>>> Setting up vinyl-checker...\"
send \"if \[ -d $APP_DIR \]; then cd $APP_DIR && git checkout -- . && git pull; else git clone https://github.com/solakli/vinyl-checker.git $APP_DIR; fi; echo REPO_DONE\r\"
expect \"REPO_DONE\"

# Step 3: Install npm dependencies
puts \"\n>>> Installing dependencies...\"
send \"cd $APP_DIR && npm install --production 2>&1 | tail -3; echo NPM_DONE\r\"
expect -timeout 120 \"NPM_DONE\"

# Step 4: Kill ALL existing vinyl-checker processes
puts \"\n>>> Stopping old process(es)...\"
send \"pkill -f 'node server.js' 2>/dev/null; sleep 2; echo KILL_DONE\r\"
expect \"KILL_DONE\"

# Step 5: Start the app with all required env vars
puts \"\n>>> Starting vinyl-checker on port $PORT...\"
send \"cd $APP_DIR && PORT=$PORT DISCOGS_TOKEN=UPiAwrUCQLYhGCppWIVvBDMSScyQuxGyRRyRDSPd DISCOGS_CONSUMER_KEY=OVtKjTmXdGeBpsudUyhz DISCOGS_CONSUMER_SECRET=XIexsqsiEyJUZjKhyFNBcUGHTVSoPsAV BASE_URL=https://stream.ronautradio.la/vinyl nohup node server.js >> /root/vinyl-checker.log 2>&1 & sleep 2; echo START_DONE\r\"
expect \"START_DONE\"

# Step 6: Verify it's running
send \"curl -s http://localhost:$PORT/api/status; echo; echo VERIFY_DONE\r\"
expect \"VERIFY_DONE\"

# Step 7: Add nginx config if not already there
puts \"\n>>> Configuring nginx...\"
send \"grep -q vinyl /etc/nginx/nginx.conf && echo NGINX_EXISTS || echo NGINX_NEEDED\r\"
expect {
    \"NGINX_EXISTS\" {
        puts \"nginx already configured\"
    }
    \"NGINX_NEEDED\" {
        # Add vinyl location block before the last closing brace of the HTTPS server block
        send \"sed -i '/location \\/api\\// i \\\\n        # Vinyl Checker\\n        location /vinyl/ {\\n            proxy_pass http://127.0.0.1:$PORT/;\\n            proxy_http_version 1.1;\\n            proxy_set_header Upgrade \\\$http_upgrade;\\n            proxy_set_header Connection \\\"upgrade\\\";\\n            proxy_set_header Host \\\$host;\\n            proxy_set_header X-Real-IP \\\$remote_addr;\\n            proxy_buffering off;\\n            proxy_cache off;\\n            proxy_read_timeout 86400;\\n        }\\n' /etc/nginx/nginx.conf; nginx -t && nginx -s reload; echo NGINX_CONFIGURED\r\"
        expect \"NGINX_CONFIGURED\"
    }
}

# Done
send \"echo; echo '=== DEPLOYMENT COMPLETE ==='; echo 'App: https://stream.ronautradio.la/vinyl/'; echo 'Port: $PORT'; echo 'Log: /root/vinyl-checker.log'; echo\r\"
expect \"===\"
send \"exit\r\"
expect eof
"

echo ""
echo "Done! Test at: https://stream.ronautradio.la/vinyl/"
