// PM2 Ecosystem Configuration for Production (t3.micro — 1GB RAM)
// Usage: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'api',
      script: 'src/index.js',
      instances: 1,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/home/ubuntu/logs/api-error.log',
      out_file: '/home/ubuntu/logs/api-out.log',
      time: true,
    },
    {
      name: 'worker',
      script: 'src/worker.js',
      instances: 1,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/home/ubuntu/logs/worker-error.log',
      out_file: '/home/ubuntu/logs/worker-out.log',
      time: true,
    },
    {
      name: 'dlq-monitor',
      script: 'src/dlq-monitor.js',
      instances: 1,
      max_memory_restart: '150M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/home/ubuntu/logs/dlq-error.log',
      out_file: '/home/ubuntu/logs/dlq-out.log',
      time: true,
    },
  ],
};
