#!/bin/bash
set -euo pipefail

# ============================================================
# COST SAVER — Stop / Start instances
# ============================================================
# Usage:
#   ./manage-instances.sh stop   — Stop EC2 (saves ~$4/month)
#   ./manage-instances.sh start  — Start EC2
#   ./manage-instances.sh status — Check status of everything
# ============================================================

source "$(dirname "$0")/config.sh"

ACTION="${1:-status}"

case "$ACTION" in
  stop)
    echo "⏹️  Stopping EC2 instance..."
    aws ec2 stop-instances \
      --instance-ids "$EC2_INSTANCE_ID" \
      --region "$AWS_REGION" > /dev/null
    echo "  EC2 stopped. You won't be charged for compute while stopped."
    echo "⚠️  Note: EBS storage ($0.10/GB/month) and Elastic IP (if any) still incur charges."
    ;;

  start)
    echo "▶️  Starting EC2 instance..."
    aws ec2 start-instances \
      --instance-ids "$EC2_INSTANCE_ID" \
      --region "$AWS_REGION" > /dev/null

    echo "⏳ Waiting for instance to start..."
    aws ec2 wait instance-running \
      --instance-ids "$EC2_INSTANCE_ID" \
      --region "$AWS_REGION"

    # Get new public IP (may change on restart)
    NEW_IP=$(aws ec2 describe-instances \
      --instance-ids "$EC2_INSTANCE_ID" \
      --query 'Reservations[0].Instances[0].PublicIpAddress' \
      --region "$AWS_REGION" \
      --output text)

    echo "  EC2 started!"
    echo "📍 Public IP: $NEW_IP"

    if [ "$NEW_IP" != "$EC2_PUBLIC_IP" ]; then
      echo ""
      echo "⚠️  IP changed! Update config.sh:"
      echo "   EC2_PUBLIC_IP=\"$NEW_IP\""
      echo ""
      echo "   Then run: ./infrastructure/update-ip.sh"
    fi
    ;;

  status)
    echo "📊 Infrastructure Status"
    echo "────────────────────────"

    # EC2
    EC2_STATE=$(aws ec2 describe-instances \
      --instance-ids "$EC2_INSTANCE_ID" \
      --query 'Reservations[0].Instances[0].State.Name' \
      --region "$AWS_REGION" \
      --output text 2>/dev/null || echo "unknown")
    echo "EC2:          $EC2_STATE"

    # RDS
    RDS_STATE=$(aws rds describe-db-instances \
      --db-instance-identifier code-review-db \
      --query 'DBInstances[0].DBInstanceStatus' \
      --region "$AWS_REGION" \
      --output text 2>/dev/null || echo "unknown")
    echo "RDS:          $RDS_STATE"

    # ElastiCache
    REDIS_STATE=$(aws elasticache describe-cache-clusters \
      --cache-cluster-id code-review-redis \
      --query 'CacheClusters[0].CacheClusterStatus' \
      --region "$AWS_REGION" \
      --output text 2>/dev/null || echo "unknown")
    echo "ElastiCache:  $REDIS_STATE"

    # SQS
    if [ -n "$SQS_MAIN_QUEUE_URL" ]; then
      QUEUE_MSGS=$(aws sqs get-queue-attributes \
        --queue-url "$SQS_MAIN_QUEUE_URL" \
        --attribute-names ApproximateNumberOfMessages \
        --region "$AWS_REGION" \
        --query 'Attributes.ApproximateNumberOfMessages' \
        --output text 2>/dev/null || echo "unknown")
      echo "SQS Queue:    $QUEUE_MSGS messages pending"
    fi
    ;;

  *)
    echo "Usage: $0 {stop|start|status}"
    exit 1
    ;;
esac
