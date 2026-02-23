#!/bin/bash
set -euo pipefail

# ============================================================
# STEP 7: SETUP EC2 — Install Node.js, PM2, deploy app
# ============================================================
# Run this from YOUR LOCAL MACHINE.
# It SSHes into EC2 and sets everything up.
# ============================================================

source "$(dirname "$0")/config.sh"

if [ -z "$EC2_PUBLIC_IP" ]; then
  echo "  EC2_PUBLIC_IP not set. Run 06-create-ec2.sh first and update config.sh"
  exit 1
fi

KEY_FILE="${EC2_KEY_FILE:-$HOME/Downloads/${EC2_KEY_NAME}.pem}"
SSH_CMD="ssh -i $KEY_FILE -o StrictHostKeyChecking=no ubuntu@$EC2_PUBLIC_IP"

echo "🔧 Setting up EC2 instance at $EC2_PUBLIC_IP..."

# ── 1. Install system dependencies ─────────────────────────
echo "📦 Installing Node.js 18.x, PM2, PostgreSQL client..."
$SSH_CMD << 'REMOTE_SCRIPT'
set -e

# Update packages
sudo apt-get update -y

# Install Node.js 18 LTS
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Git
sudo apt-get install -y git

# Install PostgreSQL client (for running schema migrations)
sudo apt-get install -y postgresql-client

# Install PM2 globally
sudo npm install -g pm2 serve

# Verify installations
echo "  Node.js $(node -v)"
echo "  npm $(npm -v)"
echo "  PM2 $(pm2 -v)"
echo "  psql $(psql --version)"
REMOTE_SCRIPT

echo "  System dependencies installed"

# ── 2. Upload application code ─────────────────────────────
PROJECT_ROOT="$(dirname "$(dirname "$0")")"

echo "📤 Uploading backend code..."
scp -i "$KEY_FILE" -o StrictHostKeyChecking=no -r \
  "$PROJECT_ROOT/backend" \
  "ubuntu@$EC2_PUBLIC_IP:~/code-review-platform/"

echo "📤 Uploading frontend code..."
scp -i "$KEY_FILE" -o StrictHostKeyChecking=no -r \
  "$PROJECT_ROOT/frontend" \
  "ubuntu@$EC2_PUBLIC_IP:~/code-review-platform/"

echo "📤 Uploading schema..."
scp -i "$KEY_FILE" -o StrictHostKeyChecking=no \
  "$PROJECT_ROOT/backend/src/models/schema.sql" \
  "ubuntu@$EC2_PUBLIC_IP:~/schema.sql"

echo "  Code uploaded"

# ── 2b. Download RDS SSL certificate bundle ────────────────
echo "🔒 Downloading RDS SSL certificate..."
$SSH_CMD << 'REMOTE_CERT'
set -e
mkdir -p ~/code-review-platform/backend/certs
curl -sS -o ~/code-review-platform/backend/certs/global-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
echo "  RDS SSL certificate downloaded"
REMOTE_CERT

# ── 3. Install dependencies & build frontend ───────────────
echo "📦 Installing npm dependencies..."
$SSH_CMD << 'REMOTE_SCRIPT'
set -e

cd ~/code-review-platform/backend
npm install --production

cd ~/code-review-platform/frontend
npm install
npm run build

echo "  Dependencies installed & frontend built"
REMOTE_SCRIPT

echo ""
echo "════════════════════════════════════════════════════════"
echo "  EC2 SETUP COMPLETE"
echo "════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Update infrastructure/config.sh with ALL values"
echo "  2. Run: ./infrastructure/08-deploy.sh"
echo ""
