// pm2 process configuration for Simple Worship Presenter.
// Production values that are not secret live here; put SESSION_SECRET in .env.
module.exports = {
  apps: [
    {
      name: 'simple-worship-presenter',
      script: 'server.js',
      cwd: __dirname,
      instances: 1, // the JSON data store is single-process; do not cluster
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      kill_timeout: 8000,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: '3002',
        TRUST_PROXY: '1',
        INSTANCE_NAME: 'Simple Worship Presenter',
        LOG_LEVEL: 'info'
        // SESSION_SECRET and DATA_DIR come from .env or the host environment.
      }
    }
  ]
};
