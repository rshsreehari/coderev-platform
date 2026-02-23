// Load environment: .env.production for AWS, .env.local for dev
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.local';
require('dotenv').config({ path: envFile });

const express = require('express');
const cors = require('cors');
const path = require('path');
const { ensureQueuesExist } = require('./config/queue');
const { setQueueUrl } = require("./services/queue");
const { setDLQUrl } = require("./services/dlq");
const { getCacheStats } = require('./services/cache');
const pool = require('./config/database');

const app = express();

// CORS — allow frontend from both local and EC2
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
];
// If running on EC2, also allow the public IP
if (process.env.EC2_PUBLIC_IP) {
  allowedOrigins.push(`http://${process.env.EC2_PUBLIC_IP}:5173`);
  allowedOrigins.push(`http://${process.env.EC2_PUBLIC_IP}:3000`);
}

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // In production, be more permissive within VPC
    if (process.env.NODE_ENV === 'production') return callback(null, true);
    return callback(new Error('CORS not allowed'), false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', async (req, res) => {
  const cacheStats = await getCacheStats();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cacheHitRate: `${cacheStats.hitRate}%`,
  });
});

// Routes
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/dlq', require('./routes/dlq'));

// Stats endpoint
app.get('/api/stats', async (req, res) => {
  const cacheStats = await getCacheStats();
  
  // Use database as source of truth for queue depth and active workers.
  // SQS ApproximateNumberOfMessages is delayed and often returns 0 even
  // when messages are in flight, because the worker picks them up within
  // 1-2 seconds. The database status column is updated in real-time by
  // the controller (queued) and worker (processing/complete).
  let queueDepth = 0;
  let activeWorkers = 0;
  let totalReviews = 0;
  let completedReviews = 0;
  let failedReviews = 0;
  let avgProcessingTime = 0;
  
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'queued') AS queued,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE status = 'complete') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed' OR status = 'retrying') AS failed,
        COUNT(*) AS total,
        COALESCE(AVG(processing_time_ms) FILTER (WHERE status = 'complete' AND processing_time_ms > 0), 0) AS avg_time
      FROM review_jobs
    `);
    
    const row = result.rows[0];
    queueDepth = parseInt(row.queued || '0', 10);
    activeWorkers = parseInt(row.processing || '0', 10);
    totalReviews = parseInt(row.total || '0', 10);
    completedReviews = parseInt(row.completed || '0', 10);
    failedReviews = parseInt(row.failed || '0', 10);
    avgProcessingTime = Math.round(parseFloat(row.avg_time || '0'));
  } catch (error) {
    console.error('Error fetching DB stats:', error.message);
  }
  
  res.json({
    cacheHits: cacheStats.hits,
    cacheMisses: cacheStats.misses,
    cacheHitRate: `${cacheStats.hitRate}%`,
    queueDepth,
    activeWorkers,
    totalReviews,
    completedReviews,
    failedReviews,
    avgProcessingTime,
  });
});

const PORT = process.env.PORT || 3000;

// In production, serve frontend static files from Express (single port)
if (process.env.NODE_ENV === 'production') {
  const frontendDist = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist));
  // SPA fallback — serve index.html for any non-API route
  app.get(/^\/(?!api|health).*/, (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

async function startServer() {
  try {
    const { mainUrl, dlqUrl } = await ensureQueuesExist();
    setQueueUrl(mainUrl);
    setDLQUrl(dlqUrl);

    app.listen(PORT, () => {
      console.log(` API Server running on http://localhost:${PORT}`);
      console.log(` Health check: http://localhost:${PORT}/health`);
      console.log(` Stats: http://localhost:${PORT}/api/stats`);
      console.log(` DLQ Queue: http://localhost:${PORT}/api/dlq`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();