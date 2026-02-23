#!/bin/bash
set -euo pipefail

# ============================================================
# UPDATE YOUR IP — Run when your public IP changes
# ============================================================
# Security groups restrict access to YOUR IP. If your ISP
# changes your IP, run this script to update the rules.
# ============================================================

source "$(dirname "$0")/config.sh"

if [ -z "$SG_EC2" ]; then
  echo "  SG_EC2 not set in config.sh"
  exit 1
fi

NEW_IP="$(curl -s ifconfig.me)/32"
echo "📍 Your new IP: $NEW_IP"

# Remove old SSH rule (port 22)
OLD_RULES=$(aws ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=$SG_EC2" \
  --query "SecurityGroupRules[?FromPort==\`22\`].SecurityGroupRuleId" \
  --region "$AWS_REGION" \
  --output text)

for RULE_ID in $OLD_RULES; do
  aws ec2 revoke-security-group-ingress \
    --group-id "$SG_EC2" \
    --security-group-rule-ids "$RULE_ID" \
    --region "$AWS_REGION" 2>/dev/null || true
done

# Remove old HTTP rule (port 3000)
OLD_RULES=$(aws ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=$SG_EC2" \
  --query "SecurityGroupRules[?FromPort==\`3000\`].SecurityGroupRuleId" \
  --region "$AWS_REGION" \
  --output text)

for RULE_ID in $OLD_RULES; do
  aws ec2 revoke-security-group-ingress \
    --group-id "$SG_EC2" \
    --security-group-rule-ids "$RULE_ID" \
    --region "$AWS_REGION" 2>/dev/null || true
done

# Remove old frontend rule (port 5173)
OLD_RULES=$(aws ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=$SG_EC2" \
  --query "SecurityGroupRules[?FromPort==\`5173\`].SecurityGroupRuleId" \
  --region "$AWS_REGION" \
  --output text)

for RULE_ID in $OLD_RULES; do
  aws ec2 revoke-security-group-ingress \
    --group-id "$SG_EC2" \
    --security-group-rule-ids "$RULE_ID" \
    --region "$AWS_REGION" 2>/dev/null || true
done

# Add new rules with current IP
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_EC2" --protocol tcp --port 22 --cidr "$NEW_IP" \
  --region "$AWS_REGION" > /dev/null

aws ec2 authorize-security-group-ingress \
  --group-id "$SG_EC2" --protocol tcp --port 3000 --cidr "$NEW_IP" \
  --region "$AWS_REGION" > /dev/null

aws ec2 authorize-security-group-ingress \
  --group-id "$SG_EC2" --protocol tcp --port 5173 --cidr "$NEW_IP" \
  --region "$AWS_REGION" > /dev/null

echo "  Security group updated for IP: $NEW_IP"
