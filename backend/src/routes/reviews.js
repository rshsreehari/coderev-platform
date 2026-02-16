const express = require('express');
const router = express.Router();
const { submitReview, getJobStatus, getHistory, downloadPDF } = require('../controllers/reviewController');

router.post('/submit', submitReview);
router.get('/status/:jobId', getJobStatus);
router.get('/history', getHistory);
router.get('/download/:jobId', downloadPDF); // NEW - PDF download endpoint

module.exports = router;