-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  api_key VARCHAR(255) UNIQUE NOT NULL,
  tier VARCHAR(50) DEFAULT 'free',
  requests_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Review jobs table
CREATE TABLE IF NOT EXISTS review_jobs (
  id UUID PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  status VARCHAR(50) DEFAULT 'queued',
  code_hash VARCHAR(64) NOT NULL,
  file_name VARCHAR(255),
  file_content TEXT,
  result JSONB,
  cache_hit BOOLEAN DEFAULT FALSE,
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  dlq_message_id VARCHAR(255),
  dlq_moved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  processing_time_ms INTEGER
);

-- Dead Letter Queue tracking table
CREATE TABLE IF NOT EXISTS dlq_messages (
  id SERIAL PRIMARY KEY,
  job_id UUID REFERENCES review_jobs(id),
  message_id VARCHAR(255) NOT NULL UNIQUE,
  message_body JSONB NOT NULL,
  receive_count INTEGER NOT NULL,
  last_error TEXT,
  moved_to_dlq_at TIMESTAMP DEFAULT NOW(),
  retry_count INTEGER DEFAULT 0,
  last_retry_at TIMESTAMP,
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMP,
  resolution_reason TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_code_hash ON review_jobs(code_hash);
CREATE INDEX IF NOT EXISTS idx_status ON review_jobs(status);
CREATE INDEX IF NOT EXISTS idx_user_id ON review_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_created_at ON review_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_job_id ON dlq_messages(job_id);
CREATE INDEX IF NOT EXISTS idx_dlq_resolved ON dlq_messages(resolved);
CREATE INDEX IF NOT EXISTS idx_dlq_moved_at ON dlq_messages(moved_to_dlq_at DESC);

-- Insert test user
INSERT INTO users (email, api_key, tier)
VALUES ('test@example.com', 'test-api-key-123', 'free')
ON CONFLICT (email) DO NOTHING;