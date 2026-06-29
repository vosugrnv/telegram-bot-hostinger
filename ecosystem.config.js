// Dùng khi Hostinger/VPS hỗ trợ PM2 để bot tự khởi động lại khi crash
module.exports = {
  apps: [
    {
      name: 'telegram-bot',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
