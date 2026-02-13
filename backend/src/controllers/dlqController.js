const pool = require("../config/database");
const { getQueueUrl } = require("../services/queue");
const {
  getDLQMessages,
  resolveDLQMessage,
  retryDLQMessage,
  getDLQStats,
} = require("../services/dlq");

/**
 * Get all DLQ messages
 */
async function getDLQQueue(req, res) {
  try {
    const { resolved = false, limit = 50, offset = 0 } = req.query;

    const result = await pool.query(
      `SELECT d.id, d.job_id, d.message_id, d.message_body, d.receive_count, d.last_error,
              d.moved_to_dlq_at, d.retry_count, d.last_retry_at, d.resolved,
              j.file_name, j.status, j.attempts
       FROM dlq_messages d
       LEFT JOIN review_jobs j ON d.job_id = j.id
       WHERE d.resolved = $1
       ORDER BY d.moved_to_dlq_at DESC
       LIMIT $2 OFFSET $3`,
      [resolved === "true", parseInt(limit), parseInt(offset)]
    );

    res.json({
      messages: result.rows,
      count: result.rows.length,
      offset: parseInt(offset),
      limit: parseInt(limit),
    });
  } catch (error) {
    console.error("Error getting DLQ messages:", error);
    res.status(500).json({ error: "Failed to get DLQ messages" });
  }
}

/**
 * Get DLQ statistics
 */
async function getDLQQueueStats(req, res) {
  try {
    const stats = await getDLQStats();
    res.json(stats);
  } catch (error) {
    console.error("Error getting DLQ stats:", error);
    res.status(500).json({ error: "Failed to get DLQ stats" });
  }
}

/**
 * Get details of a specific DLQ message
 */
async function getDLQMessageDetail(req, res) {
  try {
    const { dlqId } = req.params;

    const result = await pool.query(
      `SELECT d.id, d.job_id, d.message_id, d.message_body, d.receive_count, d.last_error,
              d.moved_to_dlq_at, d.retry_count, d.last_retry_at, d.resolved, d.resolved_at, d.resolution_reason,
              j.file_name, j.status, j.attempts, j.file_content, j.last_error as job_last_error
       FROM dlq_messages d
       LEFT JOIN review_jobs j ON d.job_id = j.id
       WHERE d.id = $1`,
      [dlqId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "DLQ message not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error getting DLQ message detail:", error);
    res.status(500).json({ error: "Failed to get DLQ message detail" });
  }
}

/**
 * Retry a DLQ message
 */
async function retryDLQMessageHandler(req, res) {
  try {
    const { dlqId } = req.params;
    const mainQueueUrl = getQueueUrl();

    if (!mainQueueUrl) {
      return res.status(500).json({ error: "Main queue URL not available" });
    }

    const success = await retryDLQMessage(dlqId, mainQueueUrl);

    if (success) {
      res.json({ message: "DLQ message retried successfully" });
    } else {
      res.status(500).json({ error: "Failed to retry DLQ message" });
    }
  } catch (error) {
    console.error("Error retrying DLQ message:", error);
    res.status(500).json({ error: "Failed to retry DLQ message" });
  }
}

/**
 * Resolve a DLQ message (mark as handled without retry)
 */
async function resolveDLQMessageHandler(req, res) {
  try {
    const { dlqId } = req.params;
    const { reason = "Manual resolution" } = req.body;

    await resolveDLQMessage(dlqId, reason);

    res.json({ message: "DLQ message resolved" });
  } catch (error) {
    console.error("Error resolving DLQ message:", error);
    res.status(500).json({ error: "Failed to resolve DLQ message" });
  }
}

module.exports = {
  getDLQQueue,
  getDLQQueueStats,
  getDLQMessageDetail,
  retryDLQMessageHandler,
  resolveDLQMessageHandler,
};
