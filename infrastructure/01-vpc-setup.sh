#!/bin/bash
set -euo pipefail

# ============================================================
# STEP 1: CREATE VPC & NETWORKING
# ============================================================
# Creates:
#   - VPC (10.0.0.0/16)
#   - 1 Public subnet  (10.0.0.0/24)  → EC2
#   - 2 Private subnets (10.0.1.0/24, 10.0.2.0/24) → RDS, Redis
#   - Internet Gateway → Public subnet
#   - NAT Gateway      → Private subnets (so they can reach internet)
#   - Route tables
# ============================================================

source "$(dirname "$0")/config.sh"

echo "🔧 Creating VPC infrastructure in ${AWS_REGION}..."

# ── 1. VPC ──────────────────────────────────────────────────
VPC_ID=$(aws ec2 create-vpc \
  --cidr-block 10.0.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=code-review-vpc},{Key=Project,Value=code-review-platform}]' \
  --region "$AWS_REGION" \
  --query 'Vpc.VpcId' \
  --output text)

# Enable DNS hostnames (required for RDS endpoints)
aws ec2 modify-vpc-attribute \
  --vpc-id "$VPC_ID" \
  --enable-dns-hostnames '{"Value": true}' \
  --region "$AWS_REGION"

aws ec2 modify-vpc-attribute \
  --vpc-id "$VPC_ID" \
  --enable-dns-support '{"Value": true}' \
  --region "$AWS_REGION"

echo "  VPC created: $VPC_ID"

# ── 2. Subnets ──────────────────────────────────────────────
# Public subnet (EC2 goes here)
SUBNET_PUBLIC=$(aws ec2 create-subnet \
  --vpc-id "$VPC_ID" \
  --cidr-block 10.0.0.0/24 \
  --availability-zone "${AWS_REGION}a" \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=code-review-public-subnet}]' \
  --region "$AWS_REGION" \
  --query 'Subnet.SubnetId' \
  --output text)

# Enable auto-assign public IPs on public subnet
aws ec2 modify-subnet-attribute \
  --subnet-id "$SUBNET_PUBLIC" \
  --map-public-ip-on-launch \
  --region "$AWS_REGION"

echo "  Public subnet: $SUBNET_PUBLIC"

# Private subnet 1 (RDS + Redis)
SUBNET_PRIVATE_1=$(aws ec2 create-subnet \
  --vpc-id "$VPC_ID" \
  --cidr-block 10.0.1.0/24 \
  --availability-zone "${AWS_REGION}a" \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=code-review-private-subnet-1}]' \
  --region "$AWS_REGION" \
  --query 'Subnet.SubnetId' \
  --output text)

echo "  Private subnet 1: $SUBNET_PRIVATE_1"

# Private subnet 2 (required by RDS — needs 2 AZs)
SUBNET_PRIVATE_2=$(aws ec2 create-subnet \
  --vpc-id "$VPC_ID" \
  --cidr-block 10.0.2.0/24 \
  --availability-zone "${AWS_REGION}b" \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=code-review-private-subnet-2}]' \
  --region "$AWS_REGION" \
  --query 'Subnet.SubnetId' \
  --output text)

echo "  Private subnet 2: $SUBNET_PRIVATE_2"

# ── 3. Internet Gateway ────────────────────────────────────
IGW_ID=$(aws ec2 create-internet-gateway \
  --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=code-review-igw}]' \
  --region "$AWS_REGION" \
  --query 'InternetGateway.InternetGatewayId' \
  --output text)

aws ec2 attach-internet-gateway \
  --vpc-id "$VPC_ID" \
  --internet-gateway-id "$IGW_ID" \
  --region "$AWS_REGION"

echo "  Internet Gateway: $IGW_ID"

# ── 4. NAT Gateway (for private subnet internet access) ────
# Allocate Elastic IP for NAT
EIP_ALLOC=$(aws ec2 allocate-address \
  --domain vpc \
  --region "$AWS_REGION" \
  --query 'AllocationId' \
  --output text)

NAT_GW_ID=$(aws ec2 create-nat-gateway \
  --subnet-id "$SUBNET_PUBLIC" \
  --allocation-id "$EIP_ALLOC" \
  --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=code-review-nat}]' \
  --region "$AWS_REGION" \
  --query 'NatGateway.NatGatewayId' \
  --output text)

echo "⏳ Waiting for NAT Gateway to become available..."
aws ec2 wait nat-gateway-available \
  --nat-gateway-ids "$NAT_GW_ID" \
  --region "$AWS_REGION"

echo "  NAT Gateway: $NAT_GW_ID"

# ── 5. Route Tables ────────────────────────────────────────
# Public route table → Internet Gateway
RTB_PUBLIC=$(aws ec2 create-route-table \
  --vpc-id "$VPC_ID" \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=code-review-rtb-public}]' \
  --region "$AWS_REGION" \
  --query 'RouteTable.RouteTableId' \
  --output text)

aws ec2 create-route \
  --route-table-id "$RTB_PUBLIC" \
  --destination-cidr-block 0.0.0.0/0 \
  --gateway-id "$IGW_ID" \
  --region "$AWS_REGION" > /dev/null

aws ec2 associate-route-table \
  --route-table-id "$RTB_PUBLIC" \
  --subnet-id "$SUBNET_PUBLIC" \
  --region "$AWS_REGION" > /dev/null

echo "  Public route table: $RTB_PUBLIC"

# Private route table → NAT Gateway
RTB_PRIVATE=$(aws ec2 create-route-table \
  --vpc-id "$VPC_ID" \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=code-review-rtb-private}]' \
  --region "$AWS_REGION" \
  --query 'RouteTable.RouteTableId' \
  --output text)

aws ec2 create-route \
  --route-table-id "$RTB_PRIVATE" \
  --destination-cidr-block 0.0.0.0/0 \
  --nat-gateway-id "$NAT_GW_ID" \
  --region "$AWS_REGION" > /dev/null

aws ec2 associate-route-table \
  --route-table-id "$RTB_PRIVATE" \
  --subnet-id "$SUBNET_PRIVATE_1" \
  --region "$AWS_REGION" > /dev/null

aws ec2 associate-route-table \
  --route-table-id "$RTB_PRIVATE" \
  --subnet-id "$SUBNET_PRIVATE_2" \
  --region "$AWS_REGION" > /dev/null

echo "  Private route table: $RTB_PRIVATE"

# ── 6. Save values ─────────────────────────────────────────
cat << EOF

════════════════════════════════════════════════════════
  VPC SETUP COMPLETE — Update infrastructure/config.sh
════════════════════════════════════════════════════════
VPC_ID="$VPC_ID"
SUBNET_PUBLIC="$SUBNET_PUBLIC"
SUBNET_PRIVATE_1="$SUBNET_PRIVATE_1"
SUBNET_PRIVATE_2="$SUBNET_PRIVATE_2"
IGW_ID="$IGW_ID"
NAT_GW_ID="$NAT_GW_ID"
RTB_PUBLIC="$RTB_PUBLIC"
RTB_PRIVATE="$RTB_PRIVATE"
════════════════════════════════════════════════════════
EOF
