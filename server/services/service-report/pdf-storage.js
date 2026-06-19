const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const config = require('../../config');
const db = require('../../models/db');
const logger = require('../logger');

const FALLBACK_PDF_MARKER = 'Browser PDF rendering was unavailable';
const MIN_EXPECTED_REPORT_BYTES = 50000;
// Bump this whenever a global report-content rule changes so every cached PDF
// becomes a cache miss and re-renders. 20260619: WaveGuard-member reports now
// hide the per-visit "Time on site" duration, which changes rendered content.
const SERVICE_REPORT_PDF_STORAGE_VERSION = 'public-surface-20260619';

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

function assertPdfStorageConfigured() {
  if (!config.s3?.bucket) throw new Error('S3/R2 bucket not configured');
}

function reportPdfStorageKey(serviceRecordId, { visibilitySignature = '' } = {}) {
  if (!serviceRecordId) throw new Error('serviceRecordId is required');
  // visibilitySignature embeds a hash of Pest Pressure visibility config so
  // that flipping enabled / showOnCustomerReport / enabledServiceLines /
  // requireRecurringFrequency invalidates cached PDFs automatically (the
  // key changes → cache miss → re-render). When omitted (legacy / non-
  // pest-pressure callers), the key keeps its pre-Pest-Pressure shape.
  //
  // INVARIANT: this key is content-INSENSITIVE apart from the pest-pressure
  // signature. The cache hit check (pdf-queue.js / reports-public.js) only
  // compares the stored key to the expected key, so any code path that edits
  // content the report renders — technician notes, findings, products, areas,
  // photos, scores — MUST call invalidateServiceReportPdfCache() after the
  // edit, or the next view/email keeps serving the stale cached PDF.
  const sigPart = visibilitySignature ? `-pp${visibilitySignature}` : '';
  return `reports/${serviceRecordId}/report-${SERVICE_REPORT_PDF_STORAGE_VERSION}${sigPart}.pdf`;
}

// Drop the cached-PDF hint for a service record so the next render rebuilds it
// from live data. Best-effort: a failure here must never fail the content edit
// that triggered it (the renderer falls back to re-rendering on the next view).
async function invalidateServiceReportPdfCache(serviceRecordId, knex = db) {
  if (!serviceRecordId) return;
  try {
    await knex('service_records').where({ id: serviceRecordId }).update({ pdf_storage_key: null });
  } catch (err) {
    logger.warn(`[service-report-pdf-storage] cache invalidation failed for ${serviceRecordId}: ${err.message}`);
  }
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function putReportPdf(serviceRecordId, pdf, { visibilitySignature = '' } = {}) {
  assertPdfStorageConfigured();
  const key = reportPdfStorageKey(serviceRecordId, { visibilitySignature });
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
  SERVICE_REPORT_PDF_STORAGE_VERSION,
  getHealthyStoredReportPdf,
  getReportPdf,
  headReportPdf,
  invalidateServiceReportPdfCache,
  putReportPdf,
  reportPdfBufferHasFallbackMarker,
  reportPdfStorageKey,
  storedReportPdfLooksBroken,
};
