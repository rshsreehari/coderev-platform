#!/bin/bash
set -euo pipefail

# ============================================================
# QUICK REDEPLOY — Push code updates without rebuilding infra
# ============================================================
# Use this when you change backend/frontend code and want to
# push the update to EC2.
# ============================================================

source "$(dirname "$0")/config.sh"

KEY_FILE="${EC2_KEY_FILE:-$HOME/Downloads/${EC2_KEY_NAME}.pem}"
PROJECT_ROOT="$(dirname "$(dirname "$0")")"

echo "🚀 Redeploying application..."

# Upload backend
echo "📤 Uploading backend..."
scp -i "$KEY_FILE" -o StrictHostKeyChecking=no -r \
  "$PROJECT_ROOT/backend/src" \
  "$PROJECT_ROOT/backend/package.json" \
  "ubuntu@$EC2_PUBLIC_IP:~/code-review-platform/backend/"

# Upload frontend
echo "📤 Uploading frontend..."
scp -i "$KEY_FILE" -o StrictHostKeyChecking=no -r \
  "$PROJECT_ROOT/frontend/src" \
  "$PROJECT_ROOT/frontend/index.html" \
  "$PROJECT_ROOT/frontend/package.json" \
  "$PROJECT_ROOT/frontend/vite.config.js" \
  "$PROJECT_ROOT/frontend/tailwind.config.js" \
  "$PROJECT_ROOT/frontend/postcss.config.js" \
  "ubuntu@$EC2_PUBLIC_IP:~/code-review-platform/frontend/"

# Rebuild & restart
echo "🔄 Rebuilding & restarting..."
ssh -i "$KEY_FILE" -o StrictHostKeyChecking=no "ubuntu@$EC2_PUBLIC_IP" << 'REMOTE'
cd ~/code-review-platform/backend
npm install --production

cd ~/code-review-platform/frontend
npm install
npm run build

pm2 restart all
pm2 status
REMOTE

echo ""
echo "  Redeployment complete!"
echo "   API:      http://$EC2_PUBLIC_IP:$APP_PORT"
echo "   Frontend: http://$EC2_PUBLIC_IP:5173"
