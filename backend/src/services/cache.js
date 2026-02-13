const redisClient = require('../config/redis');

const CACHE_TTL = 3600; // 1 hour

async function getCachedReview(codeHash) {
  try {
    const cached = await redisClient.get(`review:${codeHash}`);
    if (cached) {
      console.log(`Cache HIT for hash ${codeHash.substring(0, 8)}...`);
      return JSON.parse(cached);
    }
    console.log(`Cache MISS for hash ${codeHash.substring(0, 8)}...`);
    return null;
  } catch (error) {
    console.error('Redis get error:', error);
    return null;
  }
}

async function setCachedReview(codeHash, result) {
  try {
    await redisClient.setEx(
      `review:${codeHash}`,
      CACHE_TTL,
      JSON.stringify(result)
    );
    console.log(`Cached result for hash ${codeHash.substring(0, 8)}...`);
  } catch (error) {
    console.error('Redis set error:', error);
  }
}

async function getCacheStats() {
  try {
    const info = await redisClient.info('stats');
    const hits = parseInt(info.match(/keyspace_hits:(\d+)/)?.[1] || 0);
    const misses = parseInt(info.match(/keyspace_misses:(\d+)/)?.[1] || 0);
    const total = hits + misses;
    const hitRate = total > 0 ? ((hits / total) * 100).toFixed(2) : 0;

    return { hits, misses, hitRate };
  } catch (error) {
    return { hits: 0, misses: 0, hitRate: 0 };
  }
}

module.exports = { getCachedReview, setCachedReview, getCacheStats };