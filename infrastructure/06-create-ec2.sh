#!/bin/bash
set -euo pipefail

# ============================================================
# STEP 6: CREATE EC2 INSTANCE
# ============================================================
# Config (YOUR selection):
#   - Instance:  t2.nano (cheapest)
#   - OS:        Ubuntu 22.04 LTS (Linux)
#   - EBS:       20 GB gp2
#   - Tenancy:   Shared
#   - Monitoring: Disabled
#   - Pricing:   On-Demand
#   - Network:   Public subnet (SSH + API from your IP only)
# ============================================================

source "$(dirname "$0")/config.sh"

if [ -z "$SUBNET_PUBLIC" ] || [ -z "$SG_EC2" ]; then
  echo "  Missing config. Run steps 01 and 02 first and update config.sh"
  exit 1
fi

echo "🔧 Creating EC2 instance..."

# ── 1. Create SSH Key Pair ──────────────────────────────────
KEY_FILE="$HOME/.ssh/${EC2_KEY_NAME}.pem"

if [ -f "$KEY_FILE" ]; then
  echo "⚠️  SSH key already exists at $KEY_FILE — skipping key creation"
else
  aws ec2 create-key-pair \
    --key-name "$EC2_KEY_NAME" \
    --query 'KeyMaterial' \
    --region "$AWS_REGION" \
    --output text > "$KEY_FILE"

  chmod 400 "$KEY_FILE"
  echo "  SSH key saved: $KEY_FILE"
fi

# ── 2. Find latest Ubuntu 22.04 AMI ────────────────────────
AMI_ID=$(aws ec2 describe-images \
  --owners 099720109477 \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
    "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
  --region "$AWS_REGION" \
  --output text)

echo "📦 Using AMI: $AMI_ID (Ubuntu 22.04)"

# ── 3. Launch Instance ─────────────────────────────────────
EC2_INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type t2.nano \
  --key-name "$EC2_KEY_NAME" \
  --subnet-id "$SUBNET_PUBLIC" \
  --security-group-ids "$SG_EC2" \
  --associate-public-ip-address \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp2","DeleteOnTermination":true}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=code-review-server},{Key=Project,Value=code-review-platform}]' \
  --monitoring Enabled=false \
  --region "$AWS_REGION" \
  --query 'Instances[0].InstanceId' \
  --output text)

echo "⏳ Waiting for EC2 instance to start..."
aws ec2 wait instance-running \
  --instance-ids "$EC2_INSTANCE_ID" \
  --region "$AWS_REGION"

# Get Public IP
EC2_PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$EC2_INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --region "$AWS_REGION" \
  --output text)

cat << EOF

════════════════════════════════════════════════════════
  EC2 INSTANCE CREATED — Update infrastructure/config.sh
════════════════════════════════════════════════════════
EC2_INSTANCE_ID="$EC2_INSTANCE_ID"
EC2_PUBLIC_IP="$EC2_PUBLIC_IP"

Instance:  t2.nano | 20 GB gp2 | Ubuntu 22.04
SSH:       ssh -i $KEY_FILE ubuntu@$EC2_PUBLIC_IP

⚠️  Next: Run 07-setup-ec2.sh to install Node.js & deploy the app.
════════════════════════════════════════════════════════
EOF
