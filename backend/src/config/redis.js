const redis = require('redis');

const isProduction = process.env.NODE_ENV === 'production';

const client = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    // ElastiCache inside VPC — no TLS needed
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error('Redis: too many reconnect attempts, giving up');
        return new Error('Too many retries');
      }
      return Math.min(retries * 200, 3000);
    },
  },
});

client.on('connect', () => {
  console.log(`Connected to Redis (${isProduction ? 'AWS ElastiCache' : 'local'})`);
});

client.on('error', (err) => {
  console.error('Redis error:', err.message);
});

client.connect().catch((err) => {
  console.error('Redis initial connection failed:', err.message);
});

module.exports = client;