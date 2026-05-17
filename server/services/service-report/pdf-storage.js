const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const config = require('../../config');
const logger = require('../logger');

const FALLBACK_PDF_MARKER = 'Browser PDF rendering was unavailable';
const MIN_EXPECTED_REPORT_BYTES = 50000;

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

function assertPdfStorageConfigured() {
  if (!config.s3?.bucket) throw new Error('S3/R2 bucket not configured');
}

function reportPdfStorageKey(serviceRecordId) {
  if (!serviceRecordId) throw new Error('serviceRecordId is required');
  return `reports/${serviceRecordId}/report.pdf`;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function putReportPdf(serviceRecordId, pdf) {
  assertPdfStorageConfigured();
  const key = reportPdfStorageKey(serviceRecordId);
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: pdf,
    ContentType: 'application/pdf',
    CacheControl: 'private, max-age=0, no-cache',
  }));
  return key;
}

async function headReportPdf(key) {
  if (!key) return null;
  assertPdfStorageConfigured();
  try {
    const head = await s3.send(new HeadObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
    }));
    return {
      size: head.ContentLength || 0,
      contentType: head.ContentType || null,
      lastModified: head.LastModified || null,
    };
  } catch (err) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function getReportPdf(key) {
  if (!key) return null;
  assertPdfStorageConfigured();
  try {
    const object = await s3.send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
    }));
    return streamToBuffer(object.Body);
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

function reportPdfBufferHasFallbackMarker(bytes) {
  if (!bytes) return true;
  const prefix = bytes.toString('utf8', 0, Math.min(bytes.length, 50000));
  return prefix.includes(FALLBACK_PDF_MARKER);
}

async function storedReportPdfLooksBroken(key) {
  if (!key) return true;
  const head = await headReportPdf(key);
  if (!head) return true;
  if (Number(head.size || 0) < MIN_EXPECTED_REPORT_BYTES) return true;
  const bytes = await getReportPdf(key);
  return reportPdfBufferHasFallbackMarker(bytes);
}

async function getHealthyStoredReportPdf(key) {
  if (!key) return null;
  try {
    const head = await headReportPdf(key);
    if (!head || Number(head.size || 0) < MIN_EXPECTED_REPORT_BYTES) return null;
    const bytes = await getReportPdf(key);
    if (reportPdfBufferHasFallbackMarker(bytes)) return null;
    return bytes;
  } catch (err) {
    logger.warn(`[service-report-pdf-storage] stored PDF read failed for ${key}: ${err.message}`);
    return null;
  }
}

module.exports = {
  FALLBACK_PDF_MARKER,
  MIN_EXPECTED_REPORT_BYTES,
  getHealthyStoredReportPdf,
  getReportPdf,
  headReportPdf,
  putReportPdf,
  reportPdfBufferHasFallbackMarker,
  reportPdfStorageKey,
  storedReportPdfLooksBroken,
};
