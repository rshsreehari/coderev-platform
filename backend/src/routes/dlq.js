const express = require("express");
const router = express.Router();
const {
  getDLQQueue,
  getDLQQueueStats,
  getDLQMessageDetail,
  retryDLQMessageHandler,
  resolveDLQMessageHandler,
} = require("../controllers/dlqController");

// Get all DLQ messages
router.get("/", getDLQQueue);

// Get DLQ statistics
router.get("/stats", getDLQQueueStats);

// Get specific DLQ message details
router.get("/:dlqId", getDLQMessageDetail);

// Retry a DLQ message
router.post("/:dlqId/retry", retryDLQMessageHandler);

// Resolve a DLQ message
router.post("/:dlqId/resolve", resolveDLQMessageHandler);

module.exports = router;
