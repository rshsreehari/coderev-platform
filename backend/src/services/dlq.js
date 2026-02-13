const { sqs } = require("../config/queue");
const pool = require("../config/database");

let DLQ_URL = null;

function setDLQUrl(url) {
  DLQ_URL = url;
}

/**
 * Receive messages from Dead Letter Queue
 */
async function receiveFromDLQ() {
  if (!DLQ_URL) {
    throw new Error("DLQ_URL not set. Did you call ensureQueuesExist() first?");
  }

  return sqs
    .receiveMessage({
      QueueUrl: DLQ_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
      AttributeNames: ["ApproximateReceiveCount", "All"],
    })
    .promise();
}

/**
 * Delete message from DLQ
 */
async function deleteFromDLQ(receiptHandle) {
  if (!DLQ_URL) {
    throw new Error("DLQ_URL not set. Did you call ensureQueuesExist() first?");
  }

  return sqs
    .deleteMessage({
      QueueUrl: DLQ_URL,
      ReceiptHandle: receiptHandle,
    })
    .promise();
}

/**
 * Log DLQ message to database for analysis and potential retry
 */
async function logDLQMessage(message, jobId, error) {
  try {
    const job = JSON.parse(message.Body);
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount || 1);

    // Check if already logged
    const existing = await pool.query(
      "SELECT id FROM dlq_messages WHERE message_id = $1",
      [message.MessageId]
    );

    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO dlq_messages (job_id, message_id, message_body, receive_count, last_error)
         VALUES ($1, $2, $3, $4, $5)`,
        [jobId, message.MessageId, JSON.stringify(job), receiveCount, String(error)]
      );

      console.log(`DLQ Message logged: ${message.MessageId}`);
    }

    // Update job status to indicate it's in DLQ
    await pool.query(
      `UPDATE review_jobs
       SET status = 'dlq', dlq_message_id = $1, dlq_moved_at = NOW(), last_error = $2
       WHERE id = $3`,
      [message.MessageId, String(error), jobId]
    );

    console.log(` Job ${jobId} moved to DLQ`);
  } catch (err) {
    console.error("Error logging DLQ message:", err);
  }
}

/**
 * Get all DLQ messages from database
 */
async function getDLQMessages(resolved = false) {
  try {
    const result = await pool.query(
      `SELECT d.id, d.job_id, d.message_id, d.message_body, d.receive_count, d.last_error,
              d.moved_to_dlq_at, d.retry_count, d.last_retry_at, d.resolved,
              j.file_name, j.status, j.attempts
       FROM dlq_messages d
       LEFT JOIN review_jobs j ON d.job_id = j.id
       WHERE d.resolved = $1
       ORDER BY d.moved_to_dlq_at DESC`,
      [resolved]
    );
    return result.rows;
  } catch (error) {
    console.error("Error getting DLQ messages:", error);
    return [];
  }
}

/**
 * Mark DLQ message as resolved
 */
async function resolveDLQMessage(dlqMessageId, reason) {
  try {
    await pool.query(
      `UPDATE dlq_messages
       SET resolved = true, resolved_at = NOW(), resolution_reason = $1
       WHERE id = $2`,
      [reason, dlqMessageId]
    );
    console.log(`DLQ message ${dlqMessageId} resolved: ${reason}`);
  } catch (error) {
    console.error("Error resolving DLQ message:", error);
  }
}

/**
 * Retry a DLQ message by sending it back to main queue
 */
async function retryDLQMessage(dlqMessageId, mainQueueUrl) {
  try {
    const result = await pool.query(
      "SELECT message_body, job_id FROM dlq_messages WHERE id = $1",
      [dlqMessageId]
    );

    if (result.rows.length === 0) {
      throw new Error("DLQ message not found");
    }

    const { message_body, job_id } = result.rows[0];

    // Send back to main queue
    await sqs
      .sendMessage({
        QueueUrl: mainQueueUrl,
        MessageBody: JSON.stringify(message_body),
        MessageAttributes: {
          JobId: { DataType: "String", StringValue: message_body.jobId },
        },
      })
      .promise();

    // Update DLQ tracking
    await pool.query(
      `UPDATE dlq_messages
       SET retry_count = retry_count + 1, last_retry_at = NOW()
       WHERE id = $1`,
      [dlqMessageId]
    );

    // Update job status back to queued
    await pool.query(
      `UPDATE review_jobs
       SET status = 'retrying', attempts = 0, last_error = NULL
       WHERE id = $1`,
      [job_id]
    );

    console.log(`DLQ message ${dlqMessageId} (job: ${job_id}) retried`);
    return true;
  } catch (error) {
    console.error("Error retrying DLQ message:", error);
    return false;
  }
}

/**
 * Get DLQ statistics
 */
async function getDLQStats() {
  try {
    const result = await pool.query(
      `SELECT 
        COUNT(*) as total_messages,
        COUNT(CASE WHEN resolved = false THEN 1 END) as unresolved,
        COUNT(CASE WHEN resolved = true THEN 1 END) as resolved,
        COUNT(DISTINCT job_id) as unique_jobs,
        MAX(moved_to_dlq_at) as latest_message,
        AVG(retry_count) as avg_retries
       FROM dlq_messages`
    );
    return result.rows[0];
  } catch (error) {
    console.error("Error getting DLQ stats:", error);
    return null;
  }
}

module.exports = {
  setDLQUrl,
  receiveFromDLQ,
  deleteFromDLQ,
  logDLQMessage,
  getDLQMessages,
  resolveDLQMessage,
  retryDLQMessage,
  getDLQStats,
};
