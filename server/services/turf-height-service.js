/**
 * Turf height-of-cut persistence + read helpers.
 *
 * The reading is created INSIDE the completion transaction (the service_record
 * is born at completion, so it can't be pre-created against a non-existent FK).
 * The gauge photo is uploaded through the normal service-photo path first — that
 * path already extends the tamper-evident photo chain (photo-chain.js) — and the
 * returned service_photos id is stored as gauge_photo_id.
 *
 * Manual gauge reading is the source of truth on every customer-facing surface;
 * the ocr_* columns are filled asynchronously by the dual-model cross-check (PR2)
 * and stay null/pending here.
 */
const db = require('./../models/db');
const { buildReadingFields } = require('./service-report/turf-height');

const READING_COLUMNS = [
  'id', 'service_record_id', 'customer_id', 'grass_type', 'manual_height_in',
  'ocr_height_in', 'ocr_models', 'ocr_confidence', 'verification_status',
  'target_min_in', 'target_max_in', 'range_status', 'gauge_photo_id',
  'measured_at', 'created_by', 'created_at', 'updated_at',
];

/**
 * Persist one turf-height reading for a completed lawn visit. Call with the
 * completion transaction so the reading commits atomically with the service
 * record. `gaugePhotoId` is an already-uploaded service_photos.id (the handler
 * uploads the gauge image the same way it uploads completion photos, which
 * chains it). Throws `invalid_increment` if the manual value is off-gauge.
 */
async function createTurfHeightReading(knex, {
  serviceRecordId,
  customerId,
  grassType,
  manualHeightIn,
  gaugePhotoId,
  createdBy,
  measuredAt = null,
}) {
  const fields = buildReadingFields(grassType, manualHeightIn); // throws on bad increment
  const [reading] = await knex('turf_height_readings')
    .insert({
      service_record_id: serviceRecordId,
      customer_id: customerId,
      grass_type: grassType,
      manual_height_in: manualHeightIn,
      target_min_in: fields.target_min_in,
      target_max_in: fields.target_max_in,
      range_status: fields.range_status,
      gauge_photo_id: gaugePhotoId,
      created_by: createdBy,
      measured_at: measuredAt || knex.fn.now(),
      verification_status: 'pending', // OCR (PR2) advances this; never blocks
    })
    .returning(READING_COLUMNS);
  return reading;
}

// Fail-soft reads: wrapped in try/catch (not just .catch) so a synchronous
// query-builder issue or a missing table can never crash report rendering.

/** The reading for a single visit (report module + GET endpoint), or null. */
async function getTurfHeightForVisit(serviceRecordId, knex = db) {
  if (!serviceRecordId) return null;
  try {
    return await knex('turf_height_readings')
      .where({ service_record_id: serviceRecordId })
      .first(READING_COLUMNS);
  } catch {
    return null;
  }
}

/** The customer's most recent reading (customer card), or null. Fail-soft. */
async function getLatestTurfHeight(customerId, knex = db) {
  if (!customerId) return null;
  try {
    return await knex('turf_height_readings')
      .where({ customer_id: customerId })
      .orderBy('measured_at', 'desc')
      .first(READING_COLUMNS);
  } catch {
    return null;
  }
}

/** Ordered height history for a customer (trend sparkline). Newest first. */
async function getTurfHeightTrend(customerId, limit = 12, knex = db) {
  if (!customerId) return [];
  const n = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 60);
  try {
    return await knex('turf_height_readings')
      .where({ customer_id: customerId })
      .orderBy('measured_at', 'desc')
      .limit(n)
      .select('id', 'manual_height_in', 'range_status', 'target_min_in', 'target_max_in', 'measured_at');
  } catch {
    return [];
  }
}

module.exports = {
  createTurfHeightReading,
  getTurfHeightForVisit,
  getLatestTurfHeight,
  getTurfHeightTrend,
};
