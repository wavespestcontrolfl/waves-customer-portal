const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const db = require('../../models/db');
const config = require('../../config');
const logger = require('../logger');
const { launchBrowser, serviceReportViewerUrl } = require('./pdf');
const { stableStringify } = require('./ai-summary');

// v2: GATE_REPORT_PHOTO_CONTENT can composite a photo thumbnail into the
// card and grow the viewport to fit it — bump so a preview cached under v1
// (no photo, fixed viewport) re-renders instead of serving stale bytes.
const RENDER_VERSION = 'sms_preview_v2';
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
  // Reflect the ACTUAL viewport the screenshot was taken at (see the
  // height-growth step in renderServiceReportSmsPreviewImage below) — a
  // GATE_REPORT_PHOTO_CONTENT thumbnail can make the card taller than the
  // default, and stamping the stale DEFAULT_HEIGHT here would desync the
  // stored metadata from the actual JPEG.
  const viewport = page.viewportSize() || { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  return {
    buffer,
    width: viewport.width,
    height: viewport.height,
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

    // The card is a fixed-viewport, fullPage:false screenshot — content taller
    // than DEFAULT_HEIGHT is silently clipped, never reflowed. Ordinarily the
    // card's own min-height is tuned to fit; GATE_REPORT_PHOTO_CONTENT's photo
    // thumbnail can push a report past that budget, so grow the viewport to
    // the card's actual rendered height before shooting. Only ever GROWS —
    // every report that already fit gets today's exact framing and dimensions.
    // globalThis === window in the page context; spelled this way so the
    // server-side lint (no browser globals) accepts the in-page function
    // (same convention as pdf-puppeteer.js's imageFailures read).
    const cardHeight = await page.evaluate(() => {
      const card = globalThis.document.querySelector('.sms-preview-card');
      return card ? Math.ceil(card.getBoundingClientRect().height) : 0;
    }).catch(() => 0);
    const PAGE_VERTICAL_PADDING = 144; // .sms-preview-page's 72px top + bottom
    const neededHeight = cardHeight ? cardHeight + PAGE_VERTICAL_PADDING : 0;
    if (neededHeight > DEFAULT_HEIGHT) {
      await page.setViewportSize({ width: DEFAULT_WIDTH, height: neededHeight });
    }

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
