module.exports = {
    apps: [{
        name: 'vinyl-checker',
        script: 'server.js',
        watch: false,
        autorestart: true,
        max_restarts: 10,
        restart_delay: 5000,
        env: {
            PORT: 5052,
            NODE_ENV: 'production',
            DISCOGS_TOKEN: 'UPiAwrUCQLYhGCppWIVvBDMSScyQuxGyRRyRDSPd',
            DISCOGS_CONSUMER_KEY: 'OVtKjTmXdGeBpsudUyhz',
            DISCOGS_CONSUMER_SECRET: 'XIexsqsiEyJUZjKhyFNBcUGHTVSoPsAV',
            BASE_URL: 'https://stream.ronautradio.la/vinyl',
            // Cron-triggered runs use a secret token so /api/trigger is not public
            CRON_SECRET: 'vc-cron-2026'
        },
        error_file: '/root/vinyl-checker-err.log',
        out_file: '/root/vinyl-checker-out.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        merge_logs: true
    }]
};
