/**
 * Tech Rewards Plan D5-3: the owner's monthly protocol audit. Each month the owner opens
 * five completed lawn / tree & shrub visits per technician, compares what the visit record
 * says (products, rates, targets, photos) with the protocol, and marks each one match or
 * mismatch with a note. The mark is one row in tech_protocol_audits; the protocol-audit part
 * of the season score (tech-rewards-scores.js readAudit) reads those rows. Nothing here
 * touches scheduled_services, service_records or any customer message.
 *
 * Eligible visit (the same visit the score's callbacks part counts): ONE visit per
 * scheduled_service_id, from its newest completed performed (shared list in visit-outcomes.js)
 * record that is not a callback, the technician on the record, service date in the ET calendar
 * month, not an internal test customer. Lawn and tree & shrub only: the record's frozen
 * service_line, else detectServiceLine (the completion report's own classifier) on its service type.
 *
 * The sample is DETERMINISTIC, nothing is stored for it: eligible visits are ordered by
 * sha256(technician id : month : visit id) and the first five are shown. A visit that already
 * has a mark always stays in the sample (a mark is never hidden), then the lowest hashes fill
 * the rest up to five. The same eligible set gives the same five on every load.
 */
const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { PERFORMED_OUTCOME_SQL, VISIT_IS_CALLBACK_SQL } = require('./callback-credit');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { _private: { internalTestVisitSql } } = require('./completion-record-invariants');

const SAMPLE_SIZE = 5;
const AUDIT_LINES = Object.freeze(['lawn', 'tree_shrub']);
const RESULTS = Object.freeze(['match', 'mismatch']);
const MAX_PHOTOS_PER_VISIT = 12;
const PHOTO_URL_SECONDS = 900;
const MAX_NOTE_CHARS = 1000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ProtocolAuditError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ProtocolAuditError';
    this.status = status;
    this.code = code;
  }
}

/** 'YYYY-MM' (default: the current ET month) -> { month: 'YYYY-MM', monthStart: 'YYYY-MM-01' }. */
function parseMonth(raw) {
  const month = raw == null || raw === '' ? etDateString().slice(0, 7) : String(raw);
  if (!MONTH_RE.test(month)) throw new ProtocolAuditError(400, 'INVALID_MONTH', 'month must be YYYY-MM');
  return { month, monthStart: `${month}-01` };
}

/**
 * Eligible visits (see the header), optionally for one month and technician or one visit.
 * Rows carry month = the visit's ET calendar month as 'YYYY-MM-01'.
 */
async function eligibleVisits({ monthStart = null, technicianId = null, scheduledServiceId = null } = {}, conn = db) {
  const where = [];
  const params = [];
  if (monthStart) { where.push("sr.service_date >= ?::date AND sr.service_date < (?::date + interval '1 month')"); params.push(monthStart, monthStart); }
  if (technicianId) { where.push('sr.technician_id = ?'); params.push(technicianId); }
  if (scheduledServiceId) { where.push('sr.scheduled_service_id = ?'); params.push(scheduledServiceId); }
  const { rows } = await conn.raw(`
    SELECT DISTINCT ON (sr.scheduled_service_id)
           sr.scheduled_service_id, sr.id AS record_id, sr.technician_id, sr.customer_id,
           sr.service_type, sr.service_line, sr.protocol_name, sr.area_serviced_sqft,
           to_char(sr.service_date, 'YYYY-MM-DD') AS service_date,
           to_char(date_trunc('month', sr.service_date), 'YYYY-MM-DD') AS month
      FROM service_records sr
      JOIN scheduled_services ss ON ss.id = sr.scheduled_service_id
     WHERE sr.status = 'completed'
       AND sr.scheduled_service_id IS NOT NULL
       AND sr.technician_id IS NOT NULL
       AND NOT ${VISIT_IS_CALLBACK_SQL('sr')}
       AND ${PERFORMED_OUTCOME_SQL('sr')}
       AND NOT (${internalTestVisitSql('sr')})
       ${where.map((clause) => `AND ${clause}`).join('\n       ')}
     ORDER BY sr.scheduled_service_id, sr.created_at DESC, sr.id DESC`, params);
  return rows.filter((row) => AUDIT_LINES.includes(row.service_line || detectServiceLine(row.service_type)));
}

const sampleRank = (technicianId, monthStart, visitId) => crypto.createHash('sha256')
  .update(`${technicianId}:${monthStart}:${visitId}`).digest('hex');

/**
 * Pure: up to SAMPLE_SIZE of one technician's eligible visits for one month. Marked visits
 * (markedIds) always stay; the lowest sha256 ranks fill the rest. Returned in rank order.
 */
function pickSample(rows, { technicianId, monthStart, markedIds = new Set() }) {
  const ranked = rows
    .map((row) => ({ row, rank: sampleRank(technicianId, monthStart, row.scheduled_service_id) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  const kept = ranked.filter(({ row }) => markedIds.has(row.scheduled_service_id));
  const fill = ranked.filter(({ row }) => !markedIds.has(row.scheduled_service_id)).slice(0, Math.max(0, SAMPLE_SIZE - kept.length));
  return [...kept, ...fill].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)).map(({ row }) => row);
}

async function markedVisitIds(technicianId, monthStart, conn = db) {
  const { rows } = await conn.raw(
    'SELECT scheduled_service_id FROM tech_protocol_audits WHERE technician_id = ? AND audit_month = ?::date AND scheduled_service_id IS NOT NULL',
    [technicianId, monthStart],
  );
  return new Set(rows.map((row) => row.scheduled_service_id));
}

const byTechnician = (rows) => {
  const groups = new Map();
  for (const row of rows) groups.set(row.technician_id, [...(groups.get(row.technician_id) || []), row]);
  return groups;
};

async function signedPhotoUrl(s3Key) {
  try {
    return await require('./photos').getViewUrl(s3Key, PHOTO_URL_SECONDS);
  } catch (err) {
    logger.warn(`[tech-protocol-audit] photo presign failed: ${err.message}`);
    return null;
  }
}

// What the owner compares with the protocol, for the sampled records: products with rate, area and
// targets, photos, the customer's name, and the existing mark. Reads only.
async function visitDetails(sampled, conn = db) {
  const recordIds = sampled.map((row) => row.record_id);
  const visitIds = sampled.map((row) => row.scheduled_service_id);
  if (!recordIds.length) return new Map();
  const [products, photos, audits, customers] = await Promise.all([
    conn('service_products').whereIn('service_record_id', recordIds).orderBy('applied_at')
      .select('service_record_id', 'product_name', 'application_rate', 'rate_unit', 'total_amount', 'amount_unit',
        'application_area', 'area_value', 'area_unit', 'targets'),
    conn('service_photos').whereIn('service_record_id', recordIds).orderBy([{ column: 'sort_order' }, { column: 'created_at' }])
      .select('id', 'service_record_id', 'photo_type', 's3_key', 'caption'),
    conn('tech_protocol_audits').whereIn('scheduled_service_id', visitIds)
      .select('scheduled_service_id', 'result', 'note', 'audited_at'),
    conn('customers').whereIn('id', sampled.map((row) => row.customer_id).filter(Boolean)).select('id', 'first_name', 'last_name'),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || null]));
  const auditByVisit = new Map(audits.map((a) => [a.scheduled_service_id, { result: a.result, note: a.note, auditedAt: a.audited_at }]));
  const out = new Map();
  for (const row of sampled) {
    const own = products.filter((p) => p.service_record_id === row.record_id);
    const ownPhotos = photos.filter((p) => p.service_record_id === row.record_id);
    const photoCounts = {};
    for (const p of ownPhotos) photoCounts[p.photo_type] = (photoCounts[p.photo_type] || 0) + 1;
    out.set(row.scheduled_service_id, {
      scheduledServiceId: row.scheduled_service_id,
      recordId: row.record_id,
      serviceDate: row.service_date,
      serviceType: row.service_type,
      serviceLine: row.service_line || detectServiceLine(row.service_type),
      protocolName: row.protocol_name || null,
      areaSqft: row.area_serviced_sqft ?? null,
      customerName: customerName.get(row.customer_id) || null,
      products: own.map((p) => ({
        name: p.product_name,
        rate: p.application_rate == null ? null : Number(p.application_rate),
        rateUnit: p.rate_unit || null,
        totalAmount: p.total_amount == null ? null : Number(p.total_amount),
        amountUnit: p.amount_unit || null,
        area: p.area_value == null ? (p.application_area || null) : `${Number(p.area_value)} ${p.area_unit || ''}`.trim(),
        targets: p.targets || [],
      })),
      counts: { products: own.length, photos: ownPhotos.length, photosByType: photoCounts },
      photos: await Promise.all(ownPhotos.slice(0, MAX_PHOTOS_PER_VISIT).map(async (p) => ({
        id: p.id, type: p.photo_type, caption: p.caption || null, url: p.s3_key ? await signedPhotoUrl(p.s3_key) : null,
      }))),
      audit: auditByVisit.get(row.scheduled_service_id) || null,
    });
  }
  return out;
}

/** The month's audit board: every technician with eligible visits, five sampled visits each. */
async function getBoard(rawMonth, conn = db) {
  const { month, monthStart } = parseMonth(rawMonth);
  const rows = await eligibleVisits({ monthStart }, conn);
  const names = new Map((await conn('technicians').whereIn('id', [...new Set(rows.map((r) => r.technician_id))]).select('id', 'name')).map((t) => [t.id, t.name]));
  const technicians = [];
  for (const [technicianId, own] of byTechnician(rows)) {
    const markedIds = await markedVisitIds(technicianId, monthStart, conn);
    const sampled = pickSample(own, { technicianId, monthStart, markedIds });
    const details = await visitDetails(sampled, conn);
    const visits = sampled.map((row) => details.get(row.scheduled_service_id));
    technicians.push({
      id: technicianId,
      name: names.get(technicianId) || 'Technician',
      eligibleCount: own.length,
      markedCount: visits.filter((v) => v.audit).length,
      visits,
    });
  }
  technicians.sort((a, b) => a.name.localeCompare(b.name));
  return { month, sampleSize: SAMPLE_SIZE, technicians };
}

/**
 * Mark one sampled visit. One row per visit: a second mark changes result, note and audited_at.
 * Refuses a visit that is not eligible or not in its technician's sample for that month.
 */
async function saveMark({ scheduledServiceId, result, note, auditedBy }, conn = db) {
  if (typeof scheduledServiceId !== 'string' || !UUID_RE.test(scheduledServiceId)) throw new ProtocolAuditError(400, 'INVALID_VISIT', 'visit id must be a uuid');
  if (!RESULTS.includes(result)) throw new ProtocolAuditError(400, 'INVALID_RESULT', "result must be 'match' or 'mismatch'");
  const text = note == null ? '' : String(note).trim();
  if (text.length > MAX_NOTE_CHARS) throw new ProtocolAuditError(400, 'NOTE_TOO_LONG', `note must be at most ${MAX_NOTE_CHARS} characters`);
  if (result === 'mismatch' && !text) throw new ProtocolAuditError(400, 'NOTE_REQUIRED', 'a mismatch needs a note');
  const [visit] = await eligibleVisits({ scheduledServiceId }, conn);
  if (!visit) throw new ProtocolAuditError(404, 'NOT_ELIGIBLE', 'not a completed lawn or tree & shrub visit that can be audited');
  const sample = pickSample(
    await eligibleVisits({ monthStart: visit.month, technicianId: visit.technician_id }, conn),
    { technicianId: visit.technician_id, monthStart: visit.month, markedIds: await markedVisitIds(visit.technician_id, visit.month, conn) },
  );
  if (!sample.some((row) => row.scheduled_service_id === visit.scheduled_service_id)) {
    throw new ProtocolAuditError(409, 'NOT_IN_SAMPLE', "this visit is not in the technician's sample for the month");
  }
  const { rows } = await conn.raw(`
    INSERT INTO tech_protocol_audits (technician_id, scheduled_service_id, audit_month, result, note, audited_by, audited_at)
    VALUES (?, ?, ?::date, ?, ?, ?, now())
    ON CONFLICT (scheduled_service_id) DO UPDATE
       SET result = EXCLUDED.result, note = EXCLUDED.note, audited_by = EXCLUDED.audited_by, audited_at = now()
    RETURNING scheduled_service_id, result, note, audited_at`,
  [visit.technician_id, visit.scheduled_service_id, visit.month, result, text || null, auditedBy || null]);
  return { scheduledServiceId: rows[0].scheduled_service_id, result: rows[0].result, note: rows[0].note, auditedAt: rows[0].audited_at };
}

module.exports = { SAMPLE_SIZE, ProtocolAuditError, parseMonth, eligibleVisits, pickSample, getBoard, saveMark };
