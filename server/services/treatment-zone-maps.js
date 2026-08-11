const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');

// Technician-traced treatment perimeter for a visit: the traced path (image +
// geo coordinates), computed linear feet, and a composited satellite snapshot
// PNG stored in S3. One map per scheduled visit — re-tracing replaces it.

// Nested under service-photos/ deliberately: the deployed IAM policy already
// grants PutObject on service-photos/* (the daily photo-upload path), so this
// needs no policy change. A sibling top-level prefix was AccessDenied.
const TREATMENT_ZONE_PREFIX = 'service-photos/treatment-zones/';
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_PATH_POINTS = 500;
const MAX_LINEAR_FT = 100000;

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

function operationalError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.isOperational = true;
  return err;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Path points arrive from the tech client as
// [{ px: { x, y }, latLng: { lat, lng } }, ...] in the static map's physical
// pixel space. Normalize hard — this JSON lands on the customer report path.
function normalizePathPoints(raw) {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw operationalError('pathPoints must be an array of at least 2 points');
  }
  if (raw.length > MAX_PATH_POINTS) {
    throw operationalError(`pathPoints cannot exceed ${MAX_PATH_POINTS} points`);
  }
  return raw.map((point, i) => {
    const x = finiteOrNull(point?.px?.x);
    const y = finiteOrNull(point?.px?.y);
    if (x == null || y == null) {
      throw operationalError(`pathPoints[${i}].px must have finite x and y`);
    }
    const lat = finiteOrNull(point?.latLng?.lat);
    const lng = finiteOrNull(point?.latLng?.lng);
    return {
      px: { x, y },
      latLng: lat != null && lng != null ? { lat, lng } : null,
    };
  });
}

async function saveTreatmentZoneMap({
  scheduledServiceId,
  customerId = null,
  technicianId = null,
  pathPoints,
  closedLoop = false,
  linearFt = null,
  centerLat = null,
  centerLng = null,
  zoom = null,
  address = null,
  snapshotPngBuffer = null,
  // Transparent grass-highlight layer (lawn_highlight saves only) — the
  // report animates this over the snapshot (owner 2026-07-30).
  maskPngBuffer = null,
  captureMode = null,
  knex = db,
}) {
  if (!scheduledServiceId) throw operationalError('scheduledServiceId is required');
  const points = normalizePathPoints(pathPoints);

  const linear = finiteOrNull(linearFt);
  if (linear != null && (linear < 0 || linear > MAX_LINEAR_FT)) {
    throw operationalError('linearFt out of range');
  }

  let snapshotKey = null;
  if (snapshotPngBuffer) {
    if (!config.s3?.bucket) throw operationalError('S3 not configured', 500);
    if (snapshotPngBuffer.length > MAX_SNAPSHOT_BYTES) {
      throw operationalError('Snapshot exceeds the 8MB limit', 413);
    }
    snapshotKey =
      `${TREATMENT_ZONE_PREFIX}${scheduledServiceId}/` +
      `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-map.png`;
    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: snapshotKey,
        Body: snapshotPngBuffer,
        ContentType: 'image/png',
      })
    );
  }

  let maskKey = null;
  if (maskPngBuffer) {
    if (!config.s3?.bucket) throw operationalError('S3 not configured', 500);
    if (maskPngBuffer.length > MAX_SNAPSHOT_BYTES) {
      throw operationalError('Mask exceeds the 8MB limit', 413);
    }
    maskKey =
      `${TREATMENT_ZONE_PREFIX}${scheduledServiceId}/` +
      `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-mask.png`;
    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: maskKey,
        Body: maskPngBuffer,
        ContentType: 'image/png',
      })
    );
  }

  const existing = await knex('treatment_zone_maps')
    .where({ scheduled_service_id: scheduledServiceId })
    .first('id', 'snapshot_s3_key', 'mask_s3_key');

  const record = {
    scheduled_service_id: scheduledServiceId,
    customer_id: customerId || null,
    created_by_technician_id: technicianId || null,
    path_points: JSON.stringify(points),
    closed_loop: Boolean(closedLoop),
    linear_ft: linear == null ? null : Math.round(linear),
    center_lat: finiteOrNull(centerLat),
    center_lng: finiteOrNull(centerLng),
    zoom: finiteOrNull(zoom),
    address: address ? String(address).slice(0, 300) : null,
    snapshot_s3_key: snapshotKey || existing?.snapshot_s3_key || null,
    // The mask FOLLOWS the snapshot: a new snapshot without a mask (spray/
    // outline-fallback save) must CLEAR any stale mask — a leftover
    // highlight layer would pulse over a snapshot it doesn't match.
    mask_s3_key: maskKey || (snapshotKey ? null : existing?.mask_s3_key || null),
    // 'lawn' (turf outline) vs 'lawn_highlight' (grass mask baked into the
    // snapshot — codex P1 #3075: the report must only claim "highlighted"
    // when a highlight was actually saved) vs 'yard' (mosquito outline —
    // turf + landscape beds, owner 2026-08-11) vs 'perimeter' (building
    // spray trace) vs 'interior' (building footprint + interior wash, owner
    // 2026-07-29) — anything else stores NULL, same as legacy rows (codex
    // P1 #3038). Lawn/yard modes and 'interior' are AREA claims: only a
    // closed loop of 3+ points qualifies; open lawn/yard traces downgrade
    // to unlabeled and an open interior trace downgrades to 'perimeter'
    // (still true of the line it draws) so the report never presents a
    // line as a treated area (codex P2 #3038, mirrors the client gate).
    capture_mode: (() => {
      const mode = ['lawn', 'lawn_highlight', 'yard', 'perimeter', 'interior'].includes(captureMode) ? captureMode : null;
      if ((mode === 'lawn' || mode === 'lawn_highlight' || mode === 'yard') && (!closedLoop || points.length < 3)) return null;
      if (mode === 'interior' && (!closedLoop || points.length < 3)) return 'perimeter';
      return mode;
    })(),
    updated_at: knex.fn.now(),
  };

  const [row] = await knex('treatment_zone_maps')
    .insert(record)
    .onConflict('scheduled_service_id')
    .merge()
    .returning('*');

  // Replaced snapshot: drop the orphaned object, best effort only.
  if (snapshotKey && existing?.snapshot_s3_key && existing.snapshot_s3_key !== snapshotKey) {
    try {
      await s3.send(
        new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: existing.snapshot_s3_key })
      );
    } catch (err) {
      logger.warn(`[treatment-zone] stale snapshot delete failed: ${err.message}`);
    }
  }
  // Replaced or cleared mask: same best-effort cleanup.
  if (existing?.mask_s3_key && existing.mask_s3_key !== record.mask_s3_key) {
    try {
      await s3.send(
        new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: existing.mask_s3_key })
      );
    } catch (err) {
      logger.warn(`[treatment-zone] stale mask delete failed: ${err.message}`);
    }
  }

  return row;
}

async function getTreatmentZoneMapForScheduledService(scheduledServiceId, { knex = db } = {}) {
  if (!scheduledServiceId) return null;
  return (
    (await knex('treatment_zone_maps')
      .where({ scheduled_service_id: scheduledServiceId })
      .first()) || null
  );
}

// PDF cache-key component (same pattern as mosquitoReportV2PdfSignature):
// cached report PDFs bake the traced map in, so the key must vary when the
// map they would render changes — a GATE_TREATMENT_ZONE_MAP flip in either
// direction or a re-trace. Returns '' whenever the gate is off or the visit
// has no trace, so untraced records keep their pre-feature keys (no mass
// cache bust). Fail-soft: a lookup error must never block PDF serving.
async function treatmentZonePdfSignature(service, knex = db) {
  try {
    if (!featureGates.isEnabled('treatmentZoneMap')) return '';
    const scheduledServiceId = service?.scheduled_service_id;
    if (!scheduledServiceId) return '';
    const row = await knex('treatment_zone_maps')
      .where({ scheduled_service_id: scheduledServiceId })
      .first('updated_at', 'created_at', 'capture_mode');
    if (!row) return '';
    const stamp = new Date(row.updated_at || row.created_at || 0).getTime();
    // Trace-eligibility component (GATE_TRACE_ELIGIBILITY): the live view
    // suppresses ineligible traces at render, and a cached PDF must not
    // keep serving the old spray map after the flip — owner ruling
    // 2026-08-04: invalidate on next open, no bulk regen. Appended ONLY
    // when the gate is on, so pre-flip keys are untouched and each traced
    // record re-renders exactly once on its next open. Mirrors the render
    // inputs (snapshot findingsType is the authority, live profile widens,
    // display names last) — the verdict itself comes from the shared
    // resolver, so registry changes invalidate here for free.
    let eligibilityComponent = '';
    const { resolveTraceRenderVerdict } = require('./service-report/trace-eligibility');
    // Callers with PARTIAL rows (the PDF lookup path selects a narrow
    // column set) must still key on the same evidence the renderer sees —
    // a missing areas_serviced column made the lookup verdict diverge
    // from the stored one and forced a browser re-render on every
    // attachment fetch (codex P2 r20). Fail-soft: an unloadable row just
    // uses what the caller passed.
    let verdictRecord = service;
    if (service?.id
      && (service.areas_serviced === undefined || service.structured_notes === undefined
        || service.service_data === undefined)) {
      try {
        const fullRow = await knex('service_records')
          .where({ id: service.id })
          .first('areas_serviced', 'structured_notes', 'service_data', 'service_type');
        if (fullRow) verdictRecord = { ...fullRow, ...service };
      } catch { /* partial row stands */ }
    }
    const verdict = await resolveTraceRenderVerdict(verdictRecord, knex);
    if (verdict.eligibility) {
      eligibilityComponent = verdict.suppressed
        ? '-te0'
        : `-te1${verdict.eligibility.variant || ''}`;
      // The capture PRESENTATION keys the cached PDF too (codex P1 r19):
      // the live builder harmonizes variant/copy with capture_mode (a
      // lawn-family capture renders outline regardless of the winning
      // verdict; lawn vs lawn_highlight changes the wording), and the
      // trace timestamp doesn't change at deploy — without the mode in
      // the key, pre-harmonization PDFs would serve stale spray/highlight
      // wording forever. Gate-on only, like the verdict component.
      eligibilityComponent += `-cm${String(row.capture_mode || 'none')}`;
    }
    return `-tz${Number.isFinite(stamp) ? stamp : 0}${eligibilityComponent}`;
  } catch {
    return '';
  }
}

module.exports = {
  saveTreatmentZoneMap,
  getTreatmentZoneMapForScheduledService,
  treatmentZonePdfSignature,
  normalizePathPoints,
  TREATMENT_ZONE_PREFIX,
  MAX_SNAPSHOT_BYTES,
  MAX_PATH_POINTS,
};
