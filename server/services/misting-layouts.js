'use strict';

// Saved misting layouts (GATE_MISTING_LAYOUT_DESIGNER, step 3): one current layout per estimate.
//
// The row holds the geometry (validated in misting-layout-validate.js) and a pointer to the composited
// sketch PNG in S3. The storage follows services/treatment-zone-maps.js: the object goes up first, the
// row is upserted, and the replaced object is deleted after the write, best effort. The prefix is
// nested under service-photos/ because the deployed IAM policy grants PutObject on that prefix only.

const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const { validateLayoutPayload, looksLikePng, operationalError, sameProperty } = require('./misting-layout-validate');
const { estimateDataCarriesMosquitoMisting } = require('./pricing-engine/v1-legacy-mapper');

const MISTING_LAYOUT_PREFIX = 'service-photos/misting-layouts/';
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const ADMIN_URL_SECONDS = 15 * 60;
// The document render pin lives 15 minutes (estimate-doc-pdf.js); the picture link outlives it a little.
const DOC_URL_SECONDS = 20 * 60;

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

/** Both gates, read at call time: the designer needs GATE_MOSQUITO_MISTING too. Off = every route 404s. */
function layoutEnabled() {
  return featureGates.mosquitoMistingLive() && featureGates.mistingLayoutDesignerLive();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isEstimateId = (id) => UUID_RE.test(String(id || ''));

async function signedUrl(key, seconds) {
  if (!key || !config.s3?.bucket) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }), { expiresIn: seconds });
}

// jsonb columns read back parsed from pg; a fake store may hand strings, so parse defensively.
const parsed = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

function toLayout(row, snapshotUrl) {
  return {
    id: row.id,
    estimateId: row.estimate_id,
    address: row.address || null,
    center: { lat: Number(row.center_lat), lng: Number(row.center_lng) },
    zoom: Number(row.zoom),
    mapWidth: Number(row.map_width),
    mapHeight: Number(row.map_height),
    lines: parsed(row.lines, []),
    nozzles: parsed(row.nozzles, []),
    risers: parsed(row.risers, []),
    pump: parsed(row.pump, null),
    zones: parsed(row.zones, []),
    counts: {
      nozzles: Number(row.nozzle_count),
      eave: Number(row.eave_count),
      fence: Number(row.fence_count),
      risers: Number(row.riser_count),
      linearFt: Number(row.linear_ft),
    },
    snapshotUrl: snapshotUrl || null,
    savedAt: row.updated_at || null,
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
  };
}

async function estimateExists(estimateId, knex = db) {
  if (!isEstimateId(estimateId)) return false;
  const row = await knex('estimates').where({ id: estimateId }).first('id');
  return Boolean(row);
}

/** The saved layout with a short-lived signed picture link, or null. */
async function getLayoutForEstimate(estimateId, { knex = db } = {}) {
  if (!isEstimateId(estimateId)) return null;
  const row = await knex('misting_layouts').where({ estimate_id: estimateId }).first();
  if (!row) return null;
  let snapshotUrl = null;
  try {
    snapshotUrl = await signedUrl(row.snapshot_s3_key, ADMIN_URL_SECONDS);
  } catch (err) {
    logger.warn(`[misting-layout] could not sign the picture link for estimate ${estimateId}: ${err.message}`);
  }
  return toLayout(row, snapshotUrl);
}

async function deleteObject(key, why) {
  if (!key || !config.s3?.bucket) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  } catch (err) {
    logger.warn(`[misting-layout] ${why} delete failed: ${err.message}`);
  }
}

function rowFields(fields, key, actorId) {
  return {
    address: fields.address,
    center_lat: fields.centerLat,
    center_lng: fields.centerLng,
    zoom: fields.zoom,
    map_width: fields.mapWidth,
    map_height: fields.mapHeight,
    // pg serialises a JS array as a Postgres array literal, so every jsonb value goes in as JSON text.
    lines: JSON.stringify(fields.lines),
    nozzles: JSON.stringify(fields.nozzles),
    risers: JSON.stringify(fields.risers),
    pump: fields.pump ? JSON.stringify(fields.pump) : null,
    zones: JSON.stringify(fields.zones),
    nozzle_count: fields.nozzleCount,
    eave_count: fields.eaveCount,
    fence_count: fields.fenceCount,
    riser_count: fields.riserCount,
    linear_ft: fields.linearFt,
    snapshot_s3_key: key,
    updated_by: actorId || null,
  };
}

/**
 * Validate, store the picture, upsert the row, and drop the replaced picture.
 * Throws operational errors (400 bad payload or picture, 404 no such estimate, 413 picture too big, 500 no storage).
 */
async function saveLayout({ estimateId, payload, pngBuffer, actorId = null, knex = db }) {
  const fields = validateLayoutPayload(payload);
  if (!pngBuffer || !looksLikePng(pngBuffer)) throw operationalError('snapshot must be a PNG image');
  if (pngBuffer.length > MAX_SNAPSHOT_BYTES) {
    throw Object.assign(operationalError('Snapshot exceeds the 8MB limit'), { statusCode: 413 });
  }
  if (!config.s3?.bucket) throw Object.assign(operationalError('S3 not configured'), { statusCode: 500 });
  if (!(await estimateExists(estimateId, knex))) {
    throw Object.assign(operationalError('Estimate not found'), { statusCode: 404 });
  }

  const key = `${MISTING_LAYOUT_PREFIX}${estimateId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-layout.png`;
  await s3.send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: pngBuffer, ContentType: 'image/png' }));

  let previousKey = null;
  try {
    await knex.transaction(async (trx) => {
      const existing = await trx('misting_layouts').where({ estimate_id: estimateId }).forUpdate().first('snapshot_s3_key');
      previousKey = existing?.snapshot_s3_key || null;
      const record = rowFields(fields, key, actorId);
      await trx('misting_layouts')
        .insert({ estimate_id: estimateId, created_by: actorId || null, ...record })
        .onConflict('estimate_id')
        .merge({ ...record, updated_at: trx.fn.now() });
    });
  } catch (err) {
    await deleteObject(key, 'orphaned new picture');
    throw err;
  }
  if (previousKey && previousKey !== key) await deleteObject(previousKey, 'replaced picture');
  return getLayoutForEstimate(estimateId, { knex });
}

// The estimate document prints the sketch only for an estimate that carries the misting system, judged by the
// same reader the accept, deposit and booking guards use (it honors an authored proposal that removed the plan and
// ignores stale engine rows), never by searching the stored JSON.
function estimateHasMisting(estimate) {
  try {
    return estimateDataCarriesMosquitoMisting(estimate?.estimate_data, { pricingAuthority: estimate?.pricing_authority });
  } catch {
    return false;
  }
}

/**
 * The /data key for the estimate document (EstimateProposalDocument): `{ mistingLayout }`, or `{}`.
 * `{}` with the gates off, with no saved layout, or for an estimate with no misting system, so those
 * documents stay byte-identical. Fail-soft: a storage hiccup omits the section, never the document.
 */
async function mistingLayoutDocBlock(estimate, { knex = db } = {}) {
  if (!layoutEnabled() || !estimate?.id || !estimateHasMisting(estimate)) return {};
  try {
    const row = await knex('misting_layouts').where({ estimate_id: estimate.id }).first();
    if (!row || !row.snapshot_s3_key) return {};
    // A layout drawn for another address (the estimate was moved to a different property after it was saved) is not
    // printed: its sketch shows the old property's photo.
    if (!sameProperty(row.address, estimate.address)) return {};
    const imageUrl = await signedUrl(row.snapshot_s3_key, DOC_URL_SECONDS);
    if (!imageUrl) return {};
    const zones = parsed(row.zones, []);
    return {
      mistingLayout: {
        imageUrl,
        // Stable per save (each save writes a new picture key) and safe to publish: the emailed-PDF fingerprint
        // reads this instead of the expiring signed link, so replacing a layout invalidates a rendered attachment.
        revision: crypto.createHash('sha256').update(row.snapshot_s3_key).digest('hex').slice(0, 16),
        address: row.address || null,
        counts: {
          nozzles: Number(row.nozzle_count),
          eave: Number(row.eave_count),
          fence: Number(row.fence_count),
          risers: Number(row.riser_count),
          linearFt: Number(row.linear_ft),
          zones: Array.isArray(zones) ? zones.length : 0,
          pump: Boolean(parsed(row.pump, null)),
        },
      },
    };
  } catch (err) {
    logger.warn(`[misting-layout] document section skipped for estimate ${estimate.id}: ${err.message}`);
    return {};
  }
}

module.exports = {
  MISTING_LAYOUT_PREFIX,
  MAX_SNAPSHOT_BYTES,
  layoutEnabled,
  isEstimateId,
  getLayoutForEstimate,
  saveLayout,
  mistingLayoutDocBlock,
  estimateHasMisting,
  estimateExists,
};
