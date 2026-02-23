#!/bin/bash
set -euo pipefail

# ============================================================
# TEARDOWN — Delete ALL AWS resources
# ============================================================
# ⚠️  THIS IS DESTRUCTIVE! Only run to clean up everything.
# ============================================================

source "$(dirname "$0")/config.sh"

echo "⚠️  WARNING: This will DELETE all AWS resources for code-review-platform!"
echo "   - EC2 instance"
echo "   - RDS database (ALL DATA LOST)"
echo "   - ElastiCache Redis"
echo "   - SQS queues"
echo "   - VPC and networking"
echo ""
read -p "Type 'DELETE' to confirm: " CONFIRM

if [ "$CONFIRM" != "DELETE" ]; then
  echo "Cancelled."
  exit 0
fi

echo ""
echo "🗑️  Deleting resources..."

# 1. Terminate EC2
if [ -n "$EC2_INSTANCE_ID" ]; then
  echo "  Terminating EC2..."
  aws ec2 terminate-instances --instance-ids "$EC2_INSTANCE_ID" --region "$AWS_REGION" > /dev/null 2>&1 || true
  aws ec2 wait instance-terminated --instance-ids "$EC2_INSTANCE_ID" --region "$AWS_REGION" 2>/dev/null || true
fi

# 2. Delete RDS
echo "  Deleting RDS..."
aws rds delete-db-instance \
  --db-instance-identifier code-review-db \
  --skip-final-snapshot \
  --region "$AWS_REGION" > /dev/null 2>&1 || true

echo "  Waiting for RDS deletion (this takes a few minutes)..."
aws rds wait db-instance-deleted \
  --db-instance-identifier code-review-db \
  --region "$AWS_REGION" 2>/dev/null || true

aws rds delete-db-subnet-group \
  --db-subnet-group-name code-review-db-subnet \
  --region "$AWS_REGION" 2>/dev/null || true

# 3. Delete ElastiCache
echo "  Deleting ElastiCache..."
aws elasticache delete-cache-cluster \
  --cache-cluster-id code-review-redis \
  --region "$AWS_REGION" > /dev/null 2>&1 || true

sleep 30  # Wait a bit for cluster deletion

aws elasticache delete-cache-subnet-group \
  --cache-subnet-group-name code-review-redis-subnet \
  --region "$AWS_REGION" 2>/dev/null || true

# 4. Delete SQS Queues
echo "  Deleting SQS queues..."
[ -n "$SQS_MAIN_QUEUE_URL" ] && aws sqs delete-queue --queue-url "$SQS_MAIN_QUEUE_URL" --region "$AWS_REGION" 2>/dev/null || true
[ -n "$SQS_DLQ_URL" ] && aws sqs delete-queue --queue-url "$SQS_DLQ_URL" --region "$AWS_REGION" 2>/dev/null || true

# 5. Delete Key Pair
echo "  Deleting SSH key pair..."
aws ec2 delete-key-pair --key-name "$EC2_KEY_NAME" --region "$AWS_REGION" 2>/dev/null || true
rm -f "$HOME/.ssh/${EC2_KEY_NAME}.pem"

# 6. Delete Security Groups
echo "  Deleting security groups..."
sleep 10  # Wait for dependencies to clear
[ -n "$SG_REDIS" ] && aws ec2 delete-security-group --group-id "$SG_REDIS" --region "$AWS_REGION" 2>/dev/null || true
[ -n "$SG_RDS" ] && aws ec2 delete-security-group --group-id "$SG_RDS" --region "$AWS_REGION" 2>/dev/null || true
[ -n "$SG_EC2" ] && aws ec2 delete-security-group --group-id "$SG_EC2" --region "$AWS_REGION" 2>/dev/null || true

# 7. Delete NAT Gateway & Elastic IP
echo "  Deleting NAT Gateway..."
if [ -n "$NAT_GW_ID" ]; then
  aws ec2 delete-nat-gateway --nat-gateway-id "$NAT_GW_ID" --region "$AWS_REGION" 2>/dev/null || true
  sleep 30
fi

# Release all Elastic IPs in this VPC
if [ -n "$VPC_ID" ]; then
  EIPS=$(aws ec2 describe-addresses \
    --filters "Name=domain,Values=vpc" \
    --query "Addresses[?AssociationId==null].AllocationId" \
    --region "$AWS_REGION" \
    --output text 2>/dev/null || echo "")
  for EIP in $EIPS; do
    aws ec2 release-address --allocation-id "$EIP" --region "$AWS_REGION" 2>/dev/null || true
  done
fi

# 8. Delete Subnets
echo "  Deleting subnets..."
[ -n "$SUBNET_PUBLIC" ] && aws ec2 delete-subnet --subnet-id "$SUBNET_PUBLIC" --region "$AWS_REGION" 2>/dev/null || true
[ -n "$SUBNET_PRIVATE_1" ] && aws ec2 delete-subnet --subnet-id "$SUBNET_PRIVATE_1" --region "$AWS_REGION" 2>/dev/null || true
[ -n "$SUBNET_PRIVATE_2" ] && aws ec2 delete-subnet --subnet-id "$SUBNET_PRIVATE_2" --region "$AWS_REGION" 2>/dev/null || true

# 9. Delete Route Tables
echo "  Deleting route tables..."
[ -n "$RTB_PUBLIC" ] && aws ec2 delete-route-table --route-table-id "$RTB_PUBLIC" --region "$AWS_REGION" 2>/dev/null || true
[ -n "$RTB_PRIVATE" ] && aws ec2 delete-route-table --route-table-id "$RTB_PRIVATE" --region "$AWS_REGION" 2>/dev/null || true

# 10. Detach & Delete Internet Gateway
echo "  Deleting Internet Gateway..."
if [ -n "$IGW_ID" ] && [ -n "$VPC_ID" ]; then
  aws ec2 detach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID" --region "$AWS_REGION" 2>/dev/null || true
  aws ec2 delete-internet-gateway --internet-gateway-id "$IGW_ID" --region "$AWS_REGION" 2>/dev/null || true
fi

# 11. Delete VPC
echo "  Deleting VPC..."
[ -n "$VPC_ID" ] && aws ec2 delete-vpc --vpc-id "$VPC_ID" --region "$AWS_REGION" 2>/dev/null || true

echo ""
echo "  All resources deleted!"
echo "   Remember to clear the values in infrastructure/config.sh"
