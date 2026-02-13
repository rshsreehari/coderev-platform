require("dotenv").config({ path: ".env.local" });

const pool = require("./config/database");
const { ensureQueuesExist } = require("./config/queue");
const {
  setDLQUrl,
  receiveFromDLQ,
  deleteFromDLQ,
  logDLQMessage,
} = require("./services/dlq");

/**
 * DLQ Monitor - Listens to the Dead Letter Queue and logs messages
 * This is a separate process that should run alongside the main worker
 */
async function processDLQMessage() {
  try {
    const data = await receiveFromDLQ();

    if (!data.Messages || data.Messages.length === 0) {
      return;
    }

    const message = data.Messages[0];
    const job = JSON.parse(message.Body);
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount || 1);

    console.log(`\n DLQ Message received: ${message.MessageId}`);
    console.log(`   Job ID: ${job.jobId}`);
    console.log(`   File: ${job.fileName}`);
    console.log(`   Receive Count: ${receiveCount}`);

    try {
      // Log to database
      await logDLQMessage(message, job.jobId, "Moved to DLQ after max retries");

      // Delete from DLQ to prevent infinite processing
      await deleteFromDLQ(message.ReceiptHandle);

      console.log(`DLQ message processed and logged`);
    } catch (err) {
      console.error(`Error processing DLQ message: ${err.message}`);
      // Leave message in DLQ for retry
    }
  } catch (error) {
    console.error("DLQ Monitor error:", error.message || error);
  }
}

async function startDLQMonitor() {
  console.log("DLQ Monitor started - listening for dead letters...\n");

  const { dlqUrl } = await ensureQueuesExist();
  setDLQUrl(dlqUrl);

  while (true) {
    try {
      await processDLQMessage();
    } catch (error) {
      console.error("DLQ Monitor loop error:", error);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

startDLQMonitor().catch((error) => {
  console.error("Failed to start DLQ Monitor:", error);
  process.exit(1);
});
