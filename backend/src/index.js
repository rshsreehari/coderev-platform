require('dotenv').config({ path: '.env.local' });
const express = require('express');
const cors = require('cors');
const { ensureQueuesExist } = require('./config/queue');
const { setQueueUrl } = require("./services/queue");
const { setDLQUrl } = require("./services/dlq");
const { getCacheStats } = require('./services/cache');

const app = express();

app.use(cors());
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
  
  // Get queue depth from SQS
  let queueDepth = 0;
  let activeWorkers = 0;
  
  try {
    const { sqs } = require('./config/queue');
    const { getQueueUrl } = require('./services/queue');
    const queueUrl = getQueueUrl();
    
    if (queueUrl) {
      const attrs = await sqs.getQueueAttributes({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']
      }).promise();
      
      queueDepth = parseInt(attrs.Attributes.ApproximateNumberOfMessages || '0', 10);
      // Messages not visible = being processed by workers
      activeWorkers = parseInt(attrs.Attributes.ApproximateNumberOfMessagesNotVisible || '0', 10);
    }
  } catch (error) {
    console.error('Error fetching queue stats:', error.message);
  }
  
  res.json({
    cacheHits: cacheStats.hits,
    cacheMisses: cacheStats.misses,
    cacheHitRate: `${cacheStats.hitRate}%`,
    queueDepth,
    activeWorkers,
  });
});

const PORT = process.env.PORT || 3000;

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