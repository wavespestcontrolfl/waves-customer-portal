const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const db = require('../../models/db');
const config = require('../../config');
const logger = require('../logger');
const { launchBrowser, serviceReportViewerUrl } = require('./pdf');
const { stableStringify } = require('./ai-summary');

const RENDER_VERSION = 'sms_preview_v1';
const ASSET_TYPE = 'sms_preview_image';
const MAX_BYTES = 4_500_000;
const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 1500;

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function publicPreviewUrl(token) {
  const base = (process.env.PORTAL_URL || process.env.CLIENT_URL || config.clientUrl || 'http://localhost:5173')
    .replace(/\/+$/, '');
  return `${base}/api/reports/${encodeURIComponent(token)}/preview.jpg`;
}

function computeSmsPreviewInputHash({ recordId, token, dynamicContext, currentPressureIndexOverride } = {}) {
  return sha256(stableStringify({
    recordId,
    token,
    dynamicContext,
    currentPressureIndexOverride,
    renderVersion: RENDER_VERSION,
  }));
}

async function screenshotPreview(page, quality) {
  const buffer = await page.screenshot({
    type: 'jpeg',
    quality,
    fullPage: false,
  });
  return {
    buffer,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    contentType: 'image/jpeg',
    byteSize: buffer.length,
  };
}

async function renderServiceReportSmsPreviewImage({
  token,
  req,
} = {}) {
  if (!token) throw new Error('token is required');
  const url = serviceReportViewerUrl(token, req, 'sms_preview');
  const browser = await launchBrowser();
  let page = null;
  try {
    page = await browser.newPage({
      viewport: {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        deviceScaleFactor: 1,
      },
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('.sms-preview-card', { timeout: 10000 });

    let quality = 82;
    let result = await screenshotPreview(page, quality);
    while (result.byteSize > MAX_BYTES && quality > 50) {
      quality -= 8;
      result = await screenshotPreview(page, quality);
    }
    if (result.byteSize > MAX_BYTES) {
      throw new Error('sms_preview_image_too_large');
    }
    return result;
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function buildAndStoreSmsPreviewImage({
  recordId,
  token,
  dynamicContext,
  currentPressureIndexOverride,
  req,
  knex = db,
} = {}) {
  if (!recordId || !token) return null;
  if (!config.s3?.bucket) {
    logger.warn('[service-report-preview] S3 not configured; MMS preview skipped');
    return null;
  }

  const inputHash = computeSmsPreviewInputHash({
    recordId,
    token,
    dynamicContext,
    currentPressureIndexOverride,
  });
  const existing = await knex('service_report_notification_assets')
    .where({
      service_record_id: recordId,
      asset_type: ASSET_TYPE,
      input_hash: inputHash,
      render_version: RENDER_VERSION,
    })
    .first()
    .catch(() => null);
  if (existing) return existing;

  const image = await renderServiceReportSmsPreviewImage({ token, req });
  const storageKey = `reports/${recordId}/sms-preview-${inputHash.slice(0, 12)}.jpg`;

  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: storageKey,
    Body: image.buffer,
    ContentType: image.contentType,
    CacheControl: 'public, max-age=604800',
  }));

  const row = {
    service_record_id: recordId,
    asset_type: ASSET_TYPE,
    storage_key: storageKey,
    public_url: publicPreviewUrl(token),
    content_type: image.contentType,
    width: image.width,
    height: image.height,
    byte_size: image.byteSize,
    input_hash: inputHash,
    render_version: RENDER_VERSION,
  };

  const inserted = await knex('service_report_notification_assets')
    .insert(row)
    .returning('*')
    .catch(async (err) => {
      logger.warn(`[service-report-preview] asset insert failed: ${err.message}`);
      return knex('service_report_notification_assets')
        .where({
          service_record_id: recordId,
          asset_type: ASSET_TYPE,
          input_hash: inputHash,
          render_version: RENDER_VERSION,
        })
        .limit(1);
    });
  return Array.isArray(inserted) ? inserted[0] : inserted;
}

module.exports = {
  ASSET_TYPE,
  MAX_BYTES,
  RENDER_VERSION,
  buildAndStoreSmsPreviewImage,
  computeSmsPreviewInputHash,
  publicPreviewUrl,
  renderServiceReportSmsPreviewImage,
};
