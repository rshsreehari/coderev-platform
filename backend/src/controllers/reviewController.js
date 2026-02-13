const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const pool = require('../config/database');
const { sendToQueue } = require('../services/queue');
const { getCachedReview } = require('../services/cache');

async function submitReview(req, res) {
  try {
    const { fileName, fileContent, userId = 1 } = req.body;

    if (!fileContent) {
      return res.status(400).json({ error: 'File content required' });
    }

    // Generate code hash
    const codeHash = crypto.createHash('sha256').update(fileContent).digest('hex');

    // Check cache first
    const cachedResult = await getCachedReview(codeHash);

    if (cachedResult) {
      // Return cached result immediately
      const jobId = uuidv4();

      // Force metrics flag for cached response
      if (cachedResult?.metrics) {
        cachedResult.metrics.cacheHit = true;
      }

      await pool.query(
        `INSERT INTO review_jobs (id, user_id, code_hash, file_name, file_content, status, result, cache_hit, completed_at, processing_time_ms)
         VALUES ($1, $2, $3, $4, $5, 'complete', $6, true, NOW(), 0)`,
        [jobId, userId, codeHash, fileName, fileContent, JSON.stringify(cachedResult)]
      );

      return res.json({
        jobId,
        status: 'complete',
        result: cachedResult,
        cacheHit: true,
        message: 'Review retrieved from cache',
      });
    }

    // Cache miss - queue the job
    const jobId = uuidv4();

    await pool.query(
      `INSERT INTO review_jobs (id, user_id, code_hash, file_name, file_content, status)
       VALUES ($1, $2, $3, $4, $5, 'queued')`,
      [jobId, userId, codeHash, fileName, fileContent]
    );

    await sendToQueue({
      jobId,
      codeHash,
      fileName,
      fileContent,
    });

    res.json({
      jobId,
      status: 'queued',
      cacheHit: false,
      message: 'Review job submitted successfully',
    });
  } catch (error) {
    console.error('Error submitting review:', error);
    res.status(500).json({ error: 'Failed to submit review' });
  }
}

async function getJobStatus(req, res) {
  try {
    const { jobId } = req.params;

    const result = await pool.query(
      'SELECT id, status, result, cache_hit, processing_time_ms, created_at, completed_at FROM review_jobs WHERE id = $1',
      [jobId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error getting job status:', error);
    res.status(500).json({ error: 'Failed to get job status' });
  }
}

async function getHistory(req, res) {
  try {
    const { userId = 1 } = req.query;

    const result = await pool.query(
      `SELECT id, file_name, status, cache_hit, processing_time_ms, created_at,
              (result->'metrics'->>'issuesFound')::int as issues_found
       FROM review_jobs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error getting history:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
}

module.exports = { submitReview, getJobStatus, getHistory };