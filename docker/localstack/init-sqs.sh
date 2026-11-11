#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
MAIN_QUEUE="${SQS_WAGER_QUEUE_NAME:-wager-transactions.fifo}"
DLQ_QUEUE="${SQS_WAGER_DLQ_NAME:-wager-transactions-dlq.fifo}"
EVENTS_QUEUE="${SQS_EVENTS_QUEUE_NAME:-wager-events.fifo}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-3}"

echo "[localstack-init] Creating Dead Letter Queue (FIFO): ${DLQ_QUEUE}..."
awslocal sqs create-queue \
  --region "${REGION}" \
  --queue-name "${DLQ_QUEUE}" \
  --attributes '{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "true",
    "MessageRetentionPeriod": "1209600"
  }' >/dev/null

DLQ_URL=$(awslocal sqs get-queue-url --region "${REGION}" --queue-name "${DLQ_QUEUE}" --query 'QueueUrl' --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --region "${REGION}" --queue-url "${DLQ_URL}" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

echo "[localstack-init] Creating Main Queue (FIFO): ${MAIN_QUEUE} with RedrivePolicy -> ${DLQ_ARN} (maxReceiveCount=${MAX_RECEIVE_COUNT})..."

REDRIVE_POLICY=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"%s"}' "${DLQ_ARN}" "${MAX_RECEIVE_COUNT}")
ATTRIBUTES=$(printf '{"FifoQueue":"true","ContentBasedDeduplication":"true","VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"1","RedrivePolicy":%s}' "$(printf '%s' "${REDRIVE_POLICY}" | sed 's/"/\\"/g' | sed 's/^/"/;s/$/"/')")

awslocal sqs create-queue \
  --region "${REGION}" \
  --queue-name "${MAIN_QUEUE}" \
  --attributes "${ATTRIBUTES}" >/dev/null

echo "[localstack-init] Creating Outbox Events Queue (FIFO): ${EVENTS_QUEUE}..."
awslocal sqs create-queue \
  --region "${REGION}" \
  --queue-name "${EVENTS_QUEUE}" \
  --attributes '{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "MessageRetentionPeriod": "1209600"
  }' >/dev/null

echo "[localstack-init] SQS FIFO queues successfully provisioned:"
awslocal sqs list-queues --region "${REGION}"
