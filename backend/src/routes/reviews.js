const express = require('express');
const router = express.Router();
const { submitReview, getJobStatus, getHistory } = require('../controllers/reviewController');

router.post('/submit', submitReview);
router.get('/status/:jobId', getJobStatus);
router.get('/history', getHistory);

module.exports = router;