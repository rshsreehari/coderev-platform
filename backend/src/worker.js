require("dotenv").config({ path: ".env.local" });

const pool = require("./config/database");
const { ensureQueuesExist } = require("./config/queue");
const { receiveFromQueue, deleteFromQueue, setQueueUrl, getQueueUrl } = require("./services/queue");
const { logDLQMessage } = require("./services/dlq");
const { analyzeCode } = require("./services/analyzer");
const { setCachedReview } = require("./services/cache");

const MAX_RECEIVE = Number(process.env.SQS_MAX_RECEIVE_COUNT || 3);

async function processJob() {
  const data = await receiveFromQueue();

  if (!data.Messages || data.Messages.length === 0) return;

  const message = data.Messages[0];
  const job = JSON.parse(message.Body);

  const receiveCount = Number(message.Attributes?.ApproximateReceiveCount || 1);

  console.log(`\n Processing job ${job.jobId} (attempt ${receiveCount}/${MAX_RECEIVE})...`);

  // Check if message is at risk of going to DLQ
  if (receiveCount >= MAX_RECEIVE) {
    console.warn(`  WARNING: Job ${job.jobId} is at max receive count (${receiveCount}/${MAX_RECEIVE})`);
    console.warn("   This message will be moved to DLQ if it fails");
  }

  try {
    // Optional: force failure test
    if (job.fileName === "force_fail.js") {
      throw new Error("Forced failure for DLQ testing");
    }

    await pool.query(
      "UPDATE review_jobs SET status=$1, attempts=$2 WHERE id=$3",
      ["processing", receiveCount, job.jobId]
    );

    const result = await analyzeCode(job.fileContent, job.fileName);

    await setCachedReview(job.codeHash, result);

    await pool.query(
      `UPDATE review_jobs
       SET status=$1, result=$2, completed_at=NOW(), processing_time_ms=$3, attempts=$4, last_error=NULL, dlq_message_id=NULL
       WHERE id=$5`,
      ["complete", JSON.stringify(result), result.metrics.processingTimeMs, receiveCount, job.jobId]
    );

    await deleteFromQueue(message.ReceiptHandle);

    console.log(`Job ${job.jobId} completed in ${result.metrics.processingTimeMs}ms`);
    console.log(`   Found ${result.metrics.issuesFound} issues`);
  } catch (error) {
    console.error(` Error processing job ${job.jobId}:`, error.message || error);

    if (receiveCount >= MAX_RECEIVE) {
      // Message will be moved to DLQ by SQS automatically
      // Log it to database for tracking
      try {
        await logDLQMessage(message, job.jobId, error.message || error);
      } catch (dlqError) {
        console.error("Failed to log to DLQ table:", dlqError);
      }
    } else {
      // Still in retry phase - update status
      await pool.query(
        "UPDATE review_jobs SET status=$1, attempts=$2, last_error=$3 WHERE id=$4",
        ["retrying", receiveCount, String(error.message || error), job.jobId]
      );
    }

    // IMPORTANT: DO NOT delete message from queue
    // SQS will redeliver until maxReceiveCount then move to DLQ.
  }
}

async function startWorker() {
  console.log(" Worker started - polling for jobs...\n");

  // Ensure queues exist and set main queue URL for worker too
  const { mainUrl } = await ensureQueuesExist();
  setQueueUrl(mainUrl);

  while (true) {
    try {
      await processJob();
    } catch (e) {
      console.error("Worker loop error:", e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

startWorker();
