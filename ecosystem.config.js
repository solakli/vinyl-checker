module.exports = {
    apps: [{
        name: 'vinyl-checker',
        script: 'server.js',
        watch: false,
        autorestart: true,
        max_restarts: 50,
        restart_delay: 5000,
        // Prevent Puppeteer ProtocolErrors from crashing the process
        // (Network.enable/Page.enable timed out — handled inside scanner but can escape)
        node_args: '--unhandled-rejections=none',
        env: {
            PORT: 5052,
            NODE_ENV: 'production',
            DISCOGS_TOKEN: 'UPiAwrUCQLYhGCppWIVvBDMSScyQuxGyRRyRDSPd',
            DISCOGS_CONSUMER_KEY: 'OVtKjTmXdGeBpsudUyhz',
            DISCOGS_CONSUMER_SECRET: 'XIexsqsiEyJUZjKhyFNBcUGHTVSoPsAV',
            BASE_URL: 'https://waxdigger.ai',
            // Cron-triggered runs use a secret token so /api/trigger is not public
            CRON_SECRET: 'vc-cron-2026'
            // GITHUB_WEBHOOK_SECRET is loaded from .env — do NOT hardcode here
            // (PM2 env overrides dotenv, so hardcoding it here breaks the webhook)
        },
        error_file: '/root/vinyl-checker-err.log',
        out_file: '/root/vinyl-checker-out.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        merge_logs: true
    }]
};
