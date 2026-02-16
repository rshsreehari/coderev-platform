const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { sendToQueue } = require('../services/queue');
const { getCachedReview } = require('../services/cache');
const { generateReviewPDF } = require('../services/pdfGenerator');

async function submitReview(req, res) {
  try {
    const { fileName, fileContent, userId = 1 } = req.body;

    if (!fileContent) {
      return res.status(400).json({ error: 'File content required' });
    }

    const codeHash = crypto.createHash('sha256').update(fileContent).digest('hex');

    // Check cache
    const cachedResult = await getCachedReview(codeHash);

    if (cachedResult) {
      const jobId = uuidv4();

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
      });
    }

    // Queue for processing
    const jobId = uuidv4();

    await pool.query(
      `INSERT INTO review_jobs (id, user_id, code_hash, file_name, file_content, status)
       VALUES ($1, $2, $3, $4, $5, 'queued')`,
      [jobId, userId, codeHash, fileName, fileContent]
    );

    await sendToQueue({ jobId, codeHash, fileName, fileContent });

    res.json({
      jobId,
      status: 'queued',
      cacheHit: false,
    });
  } catch (error) {
    console.error('Submit error:', error);
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
    console.error('Get status error:', error);
    res.status(500).json({ error: 'Failed to get status' });
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
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
}

async function downloadPDF(req, res) {
  try {
    const { jobId } = req.params;

    // Get job data
    const result = await pool.query(
      'SELECT file_name, result FROM review_jobs WHERE id = $1 AND status = $2',
      [jobId, 'complete']
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found or not complete' });
    }

    const job = result.rows[0];
    const reviewData = job.result;

    // Generate PDF
    const tmpDir = path.join('/tmp', 'code-review-pdfs');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const pdfPath = path.join(tmpDir, `review-${jobId}.txt`);
    await generateReviewPDF(reviewData, pdfPath);

    // Send file
    res.download(pdfPath, `code-review-${job.file_name}.txt`, (err) => {
      if (err) {
        console.error('Download error:', err);
      }
      // Clean up temp file after 5 seconds
      setTimeout(() => {
        try {
          fs.unlinkSync(pdfPath);
        } catch (e) {
          console.error('Error deleting temp file:', e);
        }
      }, 5000);
    });
  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
}

module.exports = { submitReview, getJobStatus, getHistory, downloadPDF };