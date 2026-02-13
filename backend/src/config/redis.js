const redis = require('redis');

const client = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
  },
});

client.on('connect', () => {
  console.log(' Connected to Redis');
});

client.on('error', (err) => {
  console.error(' Redis error:', err);
});

client.connect();

module.exports = client;