#!/bin/bash
set -euo pipefail

# ============================================================
# STEP 2: CREATE SECURITY GROUPS (Firewall Rules)
# ============================================================
# Creates:
#   - EC2 SG:    SSH (22) + HTTP (3000) from YOUR IP only
#   - RDS SG:    PostgreSQL (5432) from EC2 SG only
#   - Redis SG:  Redis (6379) from EC2 SG only
# ============================================================

source "$(dirname "$0")/config.sh"

if [ -z "$VPC_ID" ]; then
  echo "  VPC_ID not set. Run 01-vpc-setup.sh first and update config.sh"
  exit 1
fi

echo "🔧 Creating security groups..."

# Get your current public IP
YOUR_IP="$(curl -s ifconfig.me)/32"
echo "📍 Your public IP: $YOUR_IP"

# ── 1. EC2 Security Group ──────────────────────────────────
SG_EC2=$(aws ec2 create-security-group \
  --group-name code-review-ec2-sg \
  --description "EC2 instances - SSH and API access" \
  --vpc-id "$VPC_ID" \
  --region "$AWS_REGION" \
  --query 'GroupId' \
  --output text)

# SSH from your IP only
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_EC2" \
  --protocol tcp \
  --port 22 \
  --cidr "$YOUR_IP" \
  --region "$AWS_REGION" > /dev/null

# API (port 3000) from your IP only
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_EC2" \
  --protocol tcp \
  --port 3000 \
  --cidr "$YOUR_IP" \
  --region "$AWS_REGION" > /dev/null

# Frontend (port 5173) from your IP only (for dev access)
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_EC2" \
  --protocol tcp \
  --port 5173 \
  --cidr "$YOUR_IP" \
  --region "$AWS_REGION" > /dev/null

# Allow all outbound (default, but explicit)
# (default SG already allows all outbound)

echo "  EC2 Security Group: $SG_EC2"

# ── 2. RDS Security Group ──────────────────────────────────
SG_RDS=$(aws ec2 create-security-group \
  --group-name code-review-rds-sg \
  --description "RDS PostgreSQL - access from EC2 only" \
  --vpc-id "$VPC_ID" \
  --region "$AWS_REGION" \
  --query 'GroupId' \
  --output text)

# PostgreSQL from EC2 security group only
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_RDS" \
  --protocol tcp \
  --port 5432 \
  --source-group "$SG_EC2" \
  --region "$AWS_REGION" > /dev/null

echo "  RDS Security Group: $SG_RDS"

# ── 3. ElastiCache Security Group ──────────────────────────
SG_REDIS=$(aws ec2 create-security-group \
  --group-name code-review-redis-sg \
  --description "ElastiCache Redis - access from EC2 only" \
  --vpc-id "$VPC_ID" \
  --region "$AWS_REGION" \
  --query 'GroupId' \
  --output text)

# Redis from EC2 security group only
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_REDIS" \
  --protocol tcp \
  --port 6379 \
  --source-group "$SG_EC2" \
  --region "$AWS_REGION" > /dev/null

echo "  Redis Security Group: $SG_REDIS"

# ── Output ──────────────────────────────────────────────────
cat << EOF

════════════════════════════════════════════════════════
  SECURITY GROUPS CREATED — Update infrastructure/config.sh
════════════════════════════════════════════════════════
SG_EC2="$SG_EC2"
SG_RDS="$SG_RDS"
SG_REDIS="$SG_REDIS"

⚠️  Access restricted to YOUR current IP: $YOUR_IP
   If your IP changes, update the EC2 SG inbound rules.
════════════════════════════════════════════════════════
EOF
