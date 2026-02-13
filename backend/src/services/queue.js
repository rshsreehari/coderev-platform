const { sqs } = require("../config/queue");

let QUEUE_URL = null;

function setQueueUrl(url) {
  QUEUE_URL = url;
}

async function sendToQueue(jobData) {
  if (!QUEUE_URL) throw new Error("QUEUE_URL not set. Did you call ensureQueuesExist() first?");

  const params = {
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify(jobData),
    MessageAttributes: {
      JobId: { DataType: "String", StringValue: jobData.jobId },
    },
  };

  const result = await sqs.sendMessage(params).promise();
  console.log(`📤 Sent job ${jobData.jobId} to queue`);
  return result;
}

async function receiveFromQueue() {
  if (!QUEUE_URL) throw new Error("QUEUE_URL not set. Did you call ensureQueuesExist() first?");

  return sqs
    .receiveMessage({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
      VisibilityTimeout: Number(process.env.SQS_VISIBILITY_TIMEOUT || 30),
      AttributeNames: ["ApproximateReceiveCount"],
    })
    .promise();
}

async function deleteFromQueue(receiptHandle) {
  if (!QUEUE_URL) throw new Error("QUEUE_URL not set. Did you call ensureQueuesExist() first?");

  return sqs
    .deleteMessage({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: receiptHandle,
    })
    .promise();
}

function getQueueUrl() {
  return QUEUE_URL;
}

module.exports = { sendToQueue, receiveFromQueue, deleteFromQueue, setQueueUrl, getQueueUrl };
