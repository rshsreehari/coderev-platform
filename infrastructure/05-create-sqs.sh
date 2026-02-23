#!/bin/bash
set -euo pipefail

# ============================================================
# STEP 5: CREATE SQS QUEUES
# ============================================================
# Config (YOUR selection):
#   - Standard queue for main jobs
#   - Standard DLQ for failed jobs
#   - ~0.02M requests/month
# ============================================================

source "$(dirname "$0")/config.sh"

echo "🔧 Creating SQS queues..."

# ── 1. Dead Letter Queue (create first) ────────────────────
SQS_DLQ_URL=$(aws sqs create-queue \
  --queue-name code-review-jobs-dlq \
  --attributes MessageRetentionPeriod=1209600 \
  --region "$AWS_REGION" \
  --query 'QueueUrl' \
  --output text)

echo "  DLQ created: $SQS_DLQ_URL"

# Get DLQ ARN
DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url "$SQS_DLQ_URL" \
  --attribute-names QueueArn \
  --region "$AWS_REGION" \
  --query 'Attributes.QueueArn' \
  --output text)

# ── 2. Main Queue (with DLQ redrive) ───────────────────────
REDRIVE_POLICY="{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"3\"}"

SQS_MAIN_QUEUE_URL=$(aws sqs create-queue \
  --queue-name code-review-jobs \
  --attributes "VisibilityTimeout=300,MessageRetentionPeriod=86400,RedrivePolicy=$REDRIVE_POLICY" \
  --region "$AWS_REGION" \
  --query 'QueueUrl' \
  --output text)

echo "  Main Queue created: $SQS_MAIN_QUEUE_URL"

cat << EOF

════════════════════════════════════════════════════════
  SQS QUEUES CREATED — Update infrastructure/config.sh
════════════════════════════════════════════════════════
SQS_MAIN_QUEUE_URL="$SQS_MAIN_QUEUE_URL"
SQS_DLQ_URL="$SQS_DLQ_URL"

Main Queue:  code-review-jobs (Standard)
DLQ:         code-review-jobs-dlq (Standard)
Max Retries: 3 before moving to DLQ
════════════════════════════════════════════════════════
EOF
