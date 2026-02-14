// frontend/src/services/api.js
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ============================================
// REVIEW ENDPOINTS
// ============================================

export const submitReview = async (fileName, fileContent) => {
  const response = await axios.post(`${API_BASE}/api/reviews/submit`, {
    fileName,
    fileContent,
  });
  return response.data;
};

export const getJobStatus = async (jobId) => {
  const response = await axios.get(`${API_BASE}/api/reviews/status/${jobId}`);
  return response.data;
};

export const getHistory = async (userId = 1) => {
  const response = await axios.get(`${API_BASE}/api/reviews/history?userId=${userId}`);
  return response.data;
};

// ============================================
// DLQ ENDPOINTS
// ============================================

export const getDLQMessages = async (resolved = false) => {
  const response = await axios.get(`${API_BASE}/api/dlq?resolved=${resolved}`);
  return response.data;
};

export const getDLQStats = async () => {
  const response = await axios.get(`${API_BASE}/api/dlq/stats`);
  return response.data;
};

export const getDLQMessage = async (dlqId) => {
  const response = await axios.get(`${API_BASE}/api/dlq/${dlqId}`);
  return response.data;
};

export const retryDLQMessage = async (dlqId) => {
  const response = await axios.post(`${API_BASE}/api/dlq/${dlqId}/retry`);
  return response.data;
};

export const resolveDLQMessage = async (dlqId, reason) => {
  const response = await axios.post(`${API_BASE}/api/dlq/${dlqId}/resolve`, {
    reason,
  });
  return response.data;
};

// ============================================
// SYSTEM ENDPOINTS
// ============================================

export const getHealth = async () => {
  const response = await axios.get(`${API_BASE}/health`);
  return response.data;
};

export const getStats = async () => {
  const response = await axios.get(`${API_BASE}/api/stats`);
  return response.data;
};

// ============================================
// POLLING UTILITIES
// ============================================

export const pollJobStatus = async (jobId, onUpdate, maxAttempts = 60) => {
  let attempts = 0;

  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      attempts++;

      try {
        const data = await getJobStatus(jobId);
        onUpdate(data);

        if (data.status === 'complete') {
          clearInterval(interval);
          resolve(data);
        } else if (data.status === 'failed' || data.status === 'dlq') {
          clearInterval(interval);
          reject(new Error(`Job failed with status: ${data.status}`));
        } else if (attempts >= maxAttempts) {
          clearInterval(interval);
          reject(new Error('Moved to DLQ'));
        }
      } catch (error) {
        clearInterval(interval);
        reject(error);
      }
    }, 1000);
  });
};

export default {
  submitReview,
  getJobStatus,
  getHistory,
  getDLQMessages,
  getDLQStats,
  getDLQMessage,
  retryDLQMessage,
  resolveDLQMessage,
  getHealth,
  getStats,
  pollJobStatus,
};
