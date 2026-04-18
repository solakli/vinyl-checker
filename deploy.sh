#!/bin/bash
# Deploy vinyl-checker to Contabo VPS
# Usage: ./deploy.sh

VPS="root@89.117.16.160"
PASS="Caswell123@"
APP_DIR="/root/vinyl-checker"
PORT=5052
CRON_SECRET="vc-cron-2026"

echo "=== Deploying Vinyl Checker to VPS ==="

expect -c "
set timeout 300
spawn ssh -o StrictHostKeyChecking=no $VPS
expect \"password:\"
send \"${PASS}\r\"
expect \"#\"

# Step 1: Install Chromium + PM2
puts \"\n>>> Installing dependencies (chromium + pm2)...\"
send \"apt-get update -qq && apt-get install -y -qq chromium-browser 2>/dev/null || apt-get install -y -qq chromium 2>/dev/null; npm install -g pm2 2>&1 | tail -2; echo DEPS_DONE\r\"
expect -timeout 120 \"DEPS_DONE\"

# Step 2: Clone or pull repo
puts \"\n>>> Updating code...\"
send \"if \[ -d $APP_DIR \]; then cd $APP_DIR && git checkout -- . && git pull; else git clone https://github.com/solakli/vinyl-checker.git $APP_DIR; fi; echo REPO_DONE\r\"
expect \"REPO_DONE\"

# Step 3: Install npm dependencies
puts \"\n>>> Installing npm packages...\"
send \"cd $APP_DIR && npm install --production 2>&1 | tail -3; echo NPM_DONE\r\"
expect -timeout 120 \"NPM_DONE\"

# Step 4: Stop existing process (pm2 or nohup)
puts \"\n>>> Stopping old process...\"
send \"pm2 stop vinyl-checker 2>/dev/null; pm2 delete vinyl-checker 2>/dev/null; pkill -f 'node server.js' 2>/dev/null; sleep 2; echo STOP_DONE\r\"
expect \"STOP_DONE\"

# Step 5: Start with PM2 using ecosystem config
puts \"\n>>> Starting with PM2...\"
send \"cd $APP_DIR && pm2 start ecosystem.config.js && pm2 save && pm2 startup systemd -u root --hp /root 2>&1 | grep -v 'To setup' | tail -5; echo PM2_DONE\r\"
expect -timeout 30 \"PM2_DONE\"

# Step 6: Set up system cron for daily rescan + validation (belt-and-suspenders)
puts \"\n>>> Setting up cron jobs...\"
send \"(crontab -l 2>/dev/null | grep -v vinyl-trigger; echo '0 3 * * * curl -s -X POST http://localhost:$PORT/api/trigger?job=all -H X-Cron-Secret:$CRON_SECRET >> /root/vinyl-cron.log 2>&1'; echo '0 7 * * * curl -s -X POST http://localhost:$PORT/api/trigger?job=validate -H X-Cron-Secret:$CRON_SECRET >> /root/vinyl-cron.log 2>&1') | crontab -; echo CRON_DONE\r\"
expect \"CRON_DONE\"

# Step 7: Verify
puts \"\n>>> Verifying...\"
send \"pm2 list && curl -s http://localhost:$PORT/api/job-health | head -c 200; echo; echo VERIFY_DONE\r\"
expect \"VERIFY_DONE\"

# Step 8: Configure nginx (skip if already done)
send \"grep -q vinyl /etc/nginx/nginx.conf && echo NGINX_EXISTS || echo NGINX_NEEDED\r\"
expect {
    \"NGINX_EXISTS\" {
        puts \"nginx already configured\"
    }
    \"NGINX_NEEDED\" {
        send \"sed -i '/location \\/api\\// i \\\\n        # Vinyl Checker\\n        location /vinyl/ {\\n            proxy_pass http://127.0.0.1:$PORT/;\\n            proxy_http_version 1.1;\\n            proxy_set_header Upgrade \\\$http_upgrade;\\n            proxy_set_header Connection \\\"upgrade\\\";\\n            proxy_set_header Host \\\$host;\\n            proxy_set_header X-Real-IP \\\$remote_addr;\\n            proxy_buffering off;\\n            proxy_cache off;\\n            proxy_read_timeout 86400;\\n        }\\n' /etc/nginx/nginx.conf; nginx -t && nginx -s reload; echo NGINX_CONFIGURED\r\"
        expect \"NGINX_CONFIGURED\"
    }
}

send \"echo; echo '=== DEPLOYMENT COMPLETE ==='; echo 'App: https://stream.ronautradio.la/vinyl/'; echo 'Port: $PORT'; echo 'Daily scan: 03:00 UTC via cron'; echo 'Validation: 07:00 UTC via cron'; echo\r\"
expect \"===\"
send \"exit\r\"
expect eof
"

echo ""
echo "Done! Test at: https://stream.ronautradio.la/vinyl/"
echo "Job health: https://stream.ronautradio.la/vinyl/api/job-health"
