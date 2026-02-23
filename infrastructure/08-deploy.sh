#!/bin/bash
set -euo pipefail

# ============================================================
# STEP 8: DEPLOY — Create .env, init DB, start PM2 services
# ============================================================
# This is the final deploy step. Run from YOUR LOCAL MACHINE.
# Re-run this whenever you need to redeploy.
# ============================================================

source "$(dirname "$0")/config.sh"

KEY_FILE="${EC2_KEY_FILE:-$HOME/Downloads/${EC2_KEY_NAME}.pem}"
SSH_CMD="ssh -i $KEY_FILE -o StrictHostKeyChecking=no ubuntu@$EC2_PUBLIC_IP"

# Validate required values
MISSING=""
[ -z "$EC2_PUBLIC_IP" ]     && MISSING="$MISSING EC2_PUBLIC_IP"
[ -z "$RDS_ENDPOINT" ]      && MISSING="$MISSING RDS_ENDPOINT"
[ -z "$RDS_PASSWORD" ]      && MISSING="$MISSING RDS_PASSWORD"
[ -z "$REDIS_ENDPOINT" ]    && MISSING="$MISSING REDIS_ENDPOINT"
[ -z "$SQS_MAIN_QUEUE_URL" ] && MISSING="$MISSING SQS_MAIN_QUEUE_URL"

if [ -n "$MISSING" ]; then
  echo "  Missing required config values:$MISSING"
  echo "   Update infrastructure/config.sh and re-run."
  exit 1
fi

echo "🚀 Deploying application to EC2..."

# ── 1. Create production .env on EC2 ───────────────────────
echo "📝 Writing .env.production..."
$SSH_CMD "cat > ~/code-review-platform/backend/.env.production" << ENVFILE
# ═══════════════════════════════════════════════
# PRODUCTION ENVIRONMENT — AWS (us-west-2)
# ═══════════════════════════════════════════════

# Database (RDS PostgreSQL)
DB_HOST=${RDS_ENDPOINT}
DB_PORT=5432
DB_NAME=${RDS_DB_NAME}
DB_USER=${RDS_USERNAME}
DB_PASSWORD=${RDS_PASSWORD}

# Redis (ElastiCache)
REDIS_HOST=${REDIS_ENDPOINT}
REDIS_PORT=${REDIS_PORT}

# SQS (IAM role handles auth — no access keys needed)
AWS_REGION=${AWS_REGION}
SQS_QUEUE_NAME=coderev-jobs
SQS_DLQ_NAME=coderev-jobs-dlq
SQS_VISIBILITY_TIMEOUT=300
SQS_MAX_RECEIVE_COUNT=3

# Server
PORT=${APP_PORT}
NODE_ENV=production

# Gemini AI Configuration
AI_PROVIDER=${AI_PROVIDER}
AI_MODEL=${AI_MODEL}
AI_API_KEY=${AI_API_KEY}
ENABLE_AI=true

# EC2 (for CORS)
EC2_PUBLIC_IP=${EC2_PUBLIC_IP}
ENVFILE

echo "  .env.production created"

# ── 2. Initialize database schema ──────────────────────────
echo "🗄️  Running database schema migration..."
$SSH_CMD << REMOTE_DB
export PGPASSWORD="${RDS_PASSWORD}"
export PGSSLROOTCERT=~/code-review-platform/backend/certs/global-bundle.pem
psql "host=${RDS_ENDPOINT} port=5432 dbname=${RDS_DB_NAME} user=${RDS_USERNAME} sslmode=verify-full sslrootcert=\$PGSSLROOTCERT" -f ~/schema.sql 2>&1 || echo "Schema may already exist (OK)"
REMOTE_DB

echo "  Database schema initialized"

# ── 3. Create frontend production env ──────────────────────
echo "📝 Writing frontend .env.production..."
$SSH_CMD "cat > ~/code-review-platform/frontend/.env.production" << ENVFILE
VITE_API_URL=http://${EC2_PUBLIC_IP}:${APP_PORT}
ENVFILE

echo "🔨 Rebuilding frontend with production API URL..."
$SSH_CMD "cd ~/code-review-platform/frontend && npm run build"

echo "  Frontend rebuilt with production API URL"

# ── 4. Start / Restart PM2 services ────────────────────────
echo "🔄 Starting PM2 services..."
$SSH_CMD << 'REMOTE_PM2'
cd ~/code-review-platform/backend

# Stop any existing processes
pm2 delete all 2>/dev/null || true

# Start API server
pm2 start src/index.js \
  --name api \
  --node-args="--env-file=.env.production" \
  --max-memory-restart 200M

# Start Worker
pm2 start src/worker.js \
  --name worker \
  --node-args="--env-file=.env.production" \
  --max-memory-restart 200M

# Start DLQ Monitor
pm2 start src/dlq-monitor.js \
  --name dlq-monitor \
  --node-args="--env-file=.env.production" \
  --max-memory-restart 100M

# Serve frontend static build via a simple server
pm2 start npx --name frontend -- serve -s ~/code-review-platform/frontend/dist -l 5173

# Save PM2 config & enable startup on reboot
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu 2>/dev/null || true
pm2 save

# Show status
pm2 status
REMOTE_PM2

echo ""
echo "════════════════════════════════════════════════════════"
echo "  🎉 DEPLOYMENT COMPLETE!"
echo "════════════════════════════════════════════════════════"
echo ""
echo "  🌐 Frontend:  http://$EC2_PUBLIC_IP:5173"
echo "  🔌 API:       http://$EC2_PUBLIC_IP:$APP_PORT"
echo "  💚 Health:     http://$EC2_PUBLIC_IP:$APP_PORT/health"
echo ""
echo "  🔐 SSH Tunnel (most secure):"
echo "     ssh -i $KEY_FILE -L 3000:localhost:3000 -L 5173:localhost:5173 ubuntu@$EC2_PUBLIC_IP"
echo "     Then open: http://localhost:5173"
echo ""
echo "  📊 PM2 Logs:   ssh -i $KEY_FILE ubuntu@$EC2_PUBLIC_IP 'pm2 logs'"
echo "  📊 PM2 Status: ssh -i $KEY_FILE ubuntu@$EC2_PUBLIC_IP 'pm2 status'"
echo ""
