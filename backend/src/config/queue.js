const AWS = require("aws-sdk");

// Use SQS_ENDPOINT for LocalStack. On real AWS, leave it empty.
const SQS_ENDPOINT = process.env.SQS_ENDPOINT || process.env.AWS_ENDPOINT || "";
const IS_LOCAL = !!SQS_ENDPOINT && SQS_ENDPOINT.includes("localhost");
const isProduction = process.env.NODE_ENV === "production";

const sqsConfig = {
  region: process.env.AWS_REGION || "us-west-2",
};

if (IS_LOCAL) {
  // LocalStack mode — use dummy credentials
  sqsConfig.accessKeyId = process.env.AWS_ACCESS_KEY_ID || "test";
  sqsConfig.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "test";
  sqsConfig.endpoint = SQS_ENDPOINT;
  sqsConfig.sslEnabled = false;
} else if (!isProduction) {
  // Local dev without LocalStack — still need some credentials
  sqsConfig.accessKeyId = process.env.AWS_ACCESS_KEY_ID || "test";
  sqsConfig.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "test";
}
// On production EC2 with IAM role or env credentials, AWS SDK picks them up automatically

const sqs = new AWS.SQS(sqsConfig);

console.log(`SQS configured: ${IS_LOCAL ? "LocalStack" : isProduction ? "AWS Production" : "AWS Dev"}`);

async function getOrCreateQueue(queueName, attributes = {}) {
  try {
    const { QueueUrl } = await sqs.getQueueUrl({ QueueName: queueName }).promise();
    return QueueUrl;
  } catch (e) {
    const { QueueUrl } = await sqs
      .createQueue({
        QueueName: queueName,
        Attributes: attributes,
      })
      .promise();
    return QueueUrl;
  }
}

async function ensureQueuesExist() {
  const mainName = process.env.SQS_QUEUE_NAME || "code-review-jobs";
  const dlqName = process.env.SQS_DLQ_NAME || "code-review-jobs-dlq";

  const visibilityTimeout = String(Number(process.env.SQS_VISIBILITY_TIMEOUT || 30));
  const maxReceiveCount = String(Number(process.env.SQS_MAX_RECEIVE_COUNT || 3));

  // 1) Create / fetch DLQ
  const dlqUrl = await getOrCreateQueue(dlqName, {
    MessageRetentionPeriod: "1209600", // 14 days
  });

  const dlqAttrs = await sqs
    .getQueueAttributes({
      QueueUrl: dlqUrl,
      AttributeNames: ["QueueArn"],
    })
    .promise();

  const dlqArn = dlqAttrs.Attributes.QueueArn;

  // 2) Create / fetch main queue with RedrivePolicy
  const redrivePolicy = JSON.stringify({
    deadLetterTargetArn: dlqArn,
    maxReceiveCount,
  });

  const mainUrl = await getOrCreateQueue(mainName, {
    VisibilityTimeout: visibilityTimeout,
    MessageRetentionPeriod: "86400", // 1 day
    RedrivePolicy: redrivePolicy,
  });

  await sqs.setQueueAttributes({
    QueueUrl: mainUrl,
    Attributes: {
      VisibilityTimeout: visibilityTimeout,
      RedrivePolicy: redrivePolicy,
    },
  }).promise();


  console.log("SQS Main Queue:", mainUrl);
  console.log("SQS DLQ:", dlqUrl);
  console.log(`RedrivePolicy: maxReceiveCount=${maxReceiveCount}, visibilityTimeout=${visibilityTimeout}s`);

  return { mainUrl, dlqUrl };
}

module.exports = { sqs, ensureQueuesExist };
