#!/bin/bash
set -euo pipefail

# ============================================================
# STEP 4: CREATE ELASTICACHE REDIS
# ============================================================
# Config (YOUR selection):
#   - Engine:    Redis OSS
#   - Node:      cache.t4g.micro (Standard, cheapest)
#   - Nodes:     1
#   - Pricing:   On-Demand
# ============================================================

source "$(dirname "$0")/config.sh"

if [ -z "$SUBNET_PRIVATE_1" ] || [ -z "$SUBNET_PRIVATE_2" ] || [ -z "$SG_REDIS" ]; then
  echo "  Missing config. Run steps 01 and 02 first and update config.sh"
  exit 1
fi

echo "🔧 Creating ElastiCache Redis cluster..."

# ── 1. Cache Subnet Group ──────────────────────────────────
aws elasticache create-cache-subnet-group \
  --cache-subnet-group-name code-review-redis-subnet \
  --cache-subnet-group-description "Subnet group for Code Review Redis" \
  --subnet-ids "$SUBNET_PRIVATE_1" "$SUBNET_PRIVATE_2" \
  --region "$AWS_REGION" > /dev/null

echo "  Cache Subnet Group created"

# ── 2. Create Redis Cluster ────────────────────────────────
aws elasticache create-cache-cluster \
  --cache-cluster-id code-review-redis \
  --cache-node-type cache.t4g.micro \
  --engine redis \
  --engine-version 7.0 \
  --num-cache-nodes 1 \
  --cache-subnet-group-name code-review-redis-subnet \
  --security-group-ids "$SG_REDIS" \
  --region "$AWS_REGION" > /dev/null

echo "⏳ Creating Redis cluster... This takes 3–5 minutes."
echo "   Check status with:"
echo "   aws elasticache describe-cache-clusters --cache-cluster-id code-review-redis --region $AWS_REGION --query 'CacheClusters[0].CacheClusterStatus'"

# Wait for cluster to be available
echo "⏳ Waiting for Redis cluster..."
aws elasticache wait cache-cluster-available \
  --cache-cluster-id code-review-redis \
  --region "$AWS_REGION"

# Get endpoint
REDIS_ENDPOINT=$(aws elasticache describe-cache-clusters \
  --cache-cluster-id code-review-redis \
  --show-cache-node-info \
  --query 'CacheClusters[0].CacheNodes[0].Endpoint.Address' \
  --region "$AWS_REGION" \
  --output text)

cat << EOF

════════════════════════════════════════════════════════
  ELASTICACHE REDIS CREATED — Update infrastructure/config.sh
════════════════════════════════════════════════════════
REDIS_ENDPOINT="$REDIS_ENDPOINT"
REDIS_PORT="6379"

Node Type:  cache.t4g.micro | 1 node | Redis OSS 7.0
════════════════════════════════════════════════════════
EOF
