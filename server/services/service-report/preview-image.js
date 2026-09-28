const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const db = require('../../models/db');
const config = require('../../config');
const logger = require('../logger');
const { launchBrowser, serviceReportViewerUrl } = require('./pdf');
const { stableStringify } = require('./ai-summary');
const { reportPhotoSetPdfSignature } = require('./photo-set-signature');
const { reportPhotoContentLive } = require('../../config/feature-gates');

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

// Cached probe for the rollout window where the photo_content_signature
// column has not migrated yet (new code, old schema) — same pattern as
// pdf-queue.js's hasServiceTierSourceColumn. Resolves once per process; a
// probe failure reads as "absent" and only costs this one column until
// restart, never the whole insert.
let photoContentSignatureColumnPresent = null;
async function hasPhotoContentSignatureColumn(knex) {
  if (photoContentSignatureColumnPresent === true) return true;
  try {
    const cols = await knex('service_report_notification_assets').columnInfo();
    photoContentSignatureColumnPresent = !!cols.photo_content_signature;
  } catch { return false; }
  return photoContentSignatureColumnPresent;
}

function publicPreviewUrl(token) {
  const base = (process.env.PORTAL_URL || process.env.CLIENT_URL || config.clientUrl || 'http://localhost:5173')
    .replace(/\/+$/, '');
  return `${base}/api/reports/${encodeURIComponent(token)}/preview.jpg`;
}

function computeSmsPreviewInputHash({
  recordId, token, dynamicContext, currentPressureIndexOverride,
  // GATE_REPORT_PHOTO_CONTENT + the chosen photo's identity (owner pre-push
  // P1): a bare gate flip, or the eligible photo set changing, must move the
  // cache key — otherwise a preview rendered under the OLD state (no photo,
  // or a now-stale photo) would keep serving forever. Same suffix-join
  // convention the PDF signatures use (e.g. -termv2 / -pex1). '' when the
  // gate is off, so every pre-feature and gate-off preview keeps its
  // existing identity untouched.
  photoContentSignature = '',
} = {}) {
  return sha256(stableStringify({
    recordId,
    token,
    dynamicContext,
    currentPressureIndexOverride,
    renderVersion: RENDER_VERSION,
    photoContentSignature,
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

    // networkidle only proves the card's image requests SETTLED, not that
    // they SUCCEEDED — a 403/404/timeout against S3 still fires the <img>'s
    // load/error event and reaches networkidle just the same. Verify every
    // image the card actually rendered finished loading before shooting: a
    // broken thumbnail screenshotted here would upload and get CACHED under
    // the current, valid photo-set signature (buildAndStoreSmsPreviewImage's
    // input hash), so it would keep being served as a cache hit even once
    // S3 recovers — nothing about the signature moves again on its own
    // (pre-push P1). GATE_REPORT_PHOTO_CONTENT off ⇒ the card has no photo
    // <img>, only the same-origin logo, which reliably loads — a no-op then.
    // Same in-page-function spelling convention as the cardHeight read below
    // and pdf-puppeteer.js's imageFailures (server-side lint disallows
    // browser globals, so globalThis stands in for window here).
    const imagesFailed = await page.evaluate(() => Array.from(globalThis.document.querySelectorAll('.sms-preview-card img'))
      .some((img) => !img.complete || img.naturalWidth === 0))
      .catch(() => true); // uncertain ⇒ treat as failed, never screenshot on faith
    if (imagesFailed) {
      throw new Error('sms_preview_image_asset_failed');
    }

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

  // Gate state + the chosen photo's identity join the cache key — see
  // computeSmsPreviewInputHash. reportPhotoSetPdfSignature (photo-set-
  // signature.js) is the SAME photo-row-set signature the PDF pipeline's own
  // storage key already carries; only read when the gate is on, so a
  // gate-off render never pays the extra query and never moves its key.
  const photoContentGateOn = reportPhotoContentLive();

  // Rollout-window guard (owner pre-push P1, 2026-09-28): a gate-on image
  // must never be stored without its photo_content_signature — the public
  // reader (reports-public.js) keys its SELECT on that column, and an
  // unsigned gate-on row would either 404 every read (column absent from
  // its query) or, post-migration, wrongly satisfy a gate-off query (NULL
  // coalesces to ''). The render happens via the live report page, so this
  // writer can't force a gate-off render as a substitute — skipping the
  // build (MMS falls back to plain text) is the correct move here. Gate off
  // is unaffected: photoContentSignature is '' either way, a true gate-off
  // identity, so an absent column just omits the row's own column below.
  if (photoContentGateOn && !(await hasPhotoContentSignatureColumn(knex))) {
    logger.warn('[service-report-preview] GATE_REPORT_PHOTO_CONTENT is on but photo_content_signature column is absent; skipping preview build');
    return null;
  }

  const photoContentSignature = photoContentGateOn
    ? `-pgon${await reportPhotoSetPdfSignature(recordId, knex).catch(() => '-phu')}`
    : '';

  const inputHash = computeSmsPreviewInputHash({
    recordId,
    token,
    dynamicContext,
    currentPressureIndexOverride,
    photoContentSignature,
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
    // The public read path (reports-public.js) re-verifies THIS value cheaply
    // on every GET /preview.jpg — see the migration's docstring for why the
    // opaque inputHash above can't be reproduced at read time.
    ...(await hasPhotoContentSignatureColumn(knex) ? { photo_content_signature: photoContentSignature } : {}),
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
  hasPhotoContentSignatureColumn,
  publicPreviewUrl,
  renderServiceReportSmsPreviewImage,
};
