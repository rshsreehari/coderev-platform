#!/bin/bash
set -euo pipefail

# ============================================================
# STEP 3: CREATE RDS POSTGRESQL DATABASE
# ============================================================
# Config:
#   - Instance:  db.t4g.micro (your selection)
#   - Storage:   20 GB gp2 (your selection)
#   - Engine:    PostgreSQL 15
#   - AZ:        Single-AZ (your selection)
#   - Pricing:   On-Demand
#   - Backup:    7-day retention
#   - Access:    Private only (no public endpoint)
# ============================================================

source "$(dirname "$0")/config.sh"

if [ -z "$SUBNET_PRIVATE_1" ] || [ -z "$SUBNET_PRIVATE_2" ] || [ -z "$SG_RDS" ]; then
  echo "  Missing config. Run steps 01 and 02 first and update config.sh"
  exit 1
fi

if [ -z "$RDS_PASSWORD" ]; then
  echo "  RDS_PASSWORD not set in config.sh. Set a strong password first!"
  exit 1
fi

echo "🔧 Creating RDS PostgreSQL instance..."

# ── 1. DB Subnet Group (requires 2 AZs) ────────────────────
aws rds create-db-subnet-group \
  --db-subnet-group-name code-review-db-subnet \
  --db-subnet-group-description "Subnet group for Code Review RDS" \
  --subnet-ids "$SUBNET_PRIVATE_1" "$SUBNET_PRIVATE_2" \
  --region "$AWS_REGION" > /dev/null

echo "  DB Subnet Group created"

# ── 2. Create RDS Instance ─────────────────────────────────
aws rds create-db-instance \
  --db-instance-identifier code-review-db \
  --db-instance-class db.t4g.micro \
  --engine postgres \
  --engine-version 15 \
  --master-username "$RDS_USERNAME" \
  --master-user-password "$RDS_PASSWORD" \
  --allocated-storage 20 \
  --storage-type gp2 \
  --db-name "$RDS_DB_NAME" \
  --db-subnet-group-name code-review-db-subnet \
  --vpc-security-group-ids "$SG_RDS" \
  --no-publicly-accessible \
  --backup-retention-period 7 \
  --no-multi-az \
  --no-auto-minor-version-upgrade \
  --monitoring-interval 0 \
  --region "$AWS_REGION" > /dev/null

echo "⏳ Creating RDS instance... This takes 5–10 minutes."
echo "   Check status with:"
echo "   aws rds describe-db-instances --db-instance-identifier code-review-db --query 'DBInstances[0].DBInstanceStatus' --region $AWS_REGION"

# Wait for it
echo "⏳ Waiting for RDS to become available..."
aws rds wait db-instance-available \
  --db-instance-identifier code-review-db \
  --region "$AWS_REGION"

# Get endpoint
RDS_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier code-review-db \
  --query 'DBInstances[0].Endpoint.Address' \
  --region "$AWS_REGION" \
  --output text)

cat << EOF

════════════════════════════════════════════════════════
  RDS POSTGRESQL CREATED — Update infrastructure/config.sh
════════════════════════════════════════════════════════
RDS_ENDPOINT="$RDS_ENDPOINT"

Instance:  db.t4g.micro | 20 GB gp2 | Single-AZ
Database:  $RDS_DB_NAME
Username:  $RDS_USERNAME
Engine:    PostgreSQL 15

⚠️  Next: SSH into EC2 and run the schema migration:
   psql -h $RDS_ENDPOINT -U $RDS_USERNAME -d $RDS_DB_NAME -f schema.sql
════════════════════════════════════════════════════════
EOF
