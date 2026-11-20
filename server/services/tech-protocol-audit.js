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
  // The visit's canonical record (the newest completed performed non-callback sibling) is chosen FIRST over the
  // whole visit; only then do the month, technician and visit filters apply to it. A visit is a candidate when
  // any of its records is dated in the month (the candidate list is bounded before the newest is picked).
  const candidate = [];
  const outer = [];
  const params = [];
  if (monthStart) {
    candidate.push("AND y.service_date >= ?::date AND y.service_date < (?::date + interval '1 month')");
    outer.push("AND c.service_date >= ?::date AND c.service_date < (?::date + interval '1 month')");
    params.push(monthStart, monthStart);
  }
  if (scheduledServiceId) candidate.push('AND y.scheduled_service_id = ?');
  const candidateParams = monthStart ? [monthStart, monthStart] : [];
  if (scheduledServiceId) candidateParams.push(scheduledServiceId);
  if (technicianId) { outer.push('AND c.technician_id = ?'); params.push(technicianId); }
  const { rows } = await conn.raw(`
    SELECT c.scheduled_service_id, c.id AS record_id, c.technician_id, c.customer_id,
           c.service_type, c.service_line, c.protocol_name, c.area_serviced_sqft,
           to_char(c.service_date, 'YYYY-MM-DD') AS service_date,
           to_char(date_trunc('month', c.service_date), 'YYYY-MM-DD') AS month, c.created_at AS record_created_at
      FROM (
        SELECT DISTINCT ON (sr.scheduled_service_id) sr.*
          FROM service_records sr
          JOIN scheduled_services ss ON ss.id = sr.scheduled_service_id
         WHERE sr.status = 'completed'
           AND sr.technician_id IS NOT NULL
           AND NOT ${VISIT_IS_CALLBACK_SQL('sr')}
           AND ${PERFORMED_OUTCOME_SQL('sr')}
           AND NOT (${internalTestVisitSql('sr')})
           AND sr.scheduled_service_id IN (SELECT y.scheduled_service_id FROM service_records y WHERE y.scheduled_service_id IS NOT NULL
                                           ${candidate.join(' ')})
         ORDER BY sr.scheduled_service_id, sr.created_at DESC, sr.id DESC
      ) c
     WHERE TRUE ${outer.join(' ')}`, [...candidateParams, ...params]);
  return rows.filter((row) => AUDIT_LINES.includes(row.service_line || detectServiceLine(row.service_type)));
}

/**
 * SQL for the audit rows that still count (the board and the score's readAudit read the SAME rule). A mark counts
 * only while it matches its visit's CURRENT canonical record (newest completed performed non-callback sibling):
 * the same technician and the same ET month, and no replacement record created after the mark. A moved visit
 * therefore leaves the old technician's score, and a replaced record asks for a new mark. A row whose visit was
 * deleted (scheduled_service_id NULL) keeps counting: nothing is left to compare it with. Alias `a` = the audit row.
 */
const CURRENT_AUDIT_FROM_SQL = `tech_protocol_audits a
  LEFT JOIN LATERAL (
    SELECT sr.technician_id, sr.created_at, to_char(date_trunc('month', sr.service_date), 'YYYY-MM-DD') AS month
      FROM service_records sr
     WHERE sr.scheduled_service_id = a.scheduled_service_id
       AND sr.status = 'completed'
       AND NOT ${VISIT_IS_CALLBACK_SQL('sr')}
       AND ${PERFORMED_OUTCOME_SQL('sr')}
     ORDER BY sr.created_at DESC, sr.id DESC
     LIMIT 1) cur ON TRUE`;
const CURRENT_AUDIT_WHERE_SQL = `(a.scheduled_service_id IS NULL
    OR (cur.technician_id = a.technician_id AND cur.month = to_char(a.audit_month, 'YYYY-MM-DD') AND cur.created_at <= a.audited_at))`;

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

// The mark a visit shows: counted (audit) or stale (needsRecheck) by the same rule as CURRENT_AUDIT_WHERE_SQL.
function auditState(a, row) {
  if (!a) return { audit: null, needsRecheck: false };
  const current = a.technician_id === row.technician_id && a.month_key === row.month.slice(0, 7)
    && new Date(row.record_created_at).getTime() <= new Date(a.audited_at).getTime();
  return current ? { audit: { result: a.result, note: a.note, auditedAt: a.audited_at }, needsRecheck: false } : { audit: null, needsRecheck: true };
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
      .select('scheduled_service_id', 'technician_id', conn.raw("to_char(audit_month, 'YYYY-MM') AS month_key"), 'result', 'note', 'audited_at'),
    conn('customers').whereIn('id', sampled.map((row) => row.customer_id).filter(Boolean)).select('id', 'first_name', 'last_name'),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || null]));
  // A mark counts here by the score's own rule (see CURRENT_AUDIT_FROM_SQL): it must match the technician and
  // month the visit shows now, and be newer than its record. Otherwise it reads as unmarked, flagged "needs
  // re-check" (a moved visit or a replaced record); marking again re-attributes it.
  const auditRow = new Map(audits.map((a) => [a.scheduled_service_id, a]));
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
      ...auditState(auditRow.get(row.scheduled_service_id), row),
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
 * Mark one sampled visit. One row per visit: a second mark changes result, note, audited_at and re-attributes
 * the row to the technician and month the visit shows now. Refuses a visit that is not eligible or not in its
 * technician's sample for the month, and a recordId (the record the owner reviewed) that is no longer the
 * visit's canonical record. The check and the write run under one lock per technician and month, so two
 * marks can never both pass the five-visit sample.
 */
async function saveMark({ scheduledServiceId, recordId = null, result, note, auditedBy }, conn = db) {
  if (typeof scheduledServiceId !== 'string' || !UUID_RE.test(scheduledServiceId)) throw new ProtocolAuditError(400, 'INVALID_VISIT', 'visit id must be a uuid');
  if (!RESULTS.includes(result)) throw new ProtocolAuditError(400, 'INVALID_RESULT', "result must be 'match' or 'mismatch'");
  const text = note == null ? '' : String(note).trim();
  if (text.length > MAX_NOTE_CHARS) throw new ProtocolAuditError(400, 'NOTE_TOO_LONG', `note must be at most ${MAX_NOTE_CHARS} characters`);
  if (result === 'mismatch' && !text) throw new ProtocolAuditError(400, 'NOTE_REQUIRED', 'a mismatch needs a note');
  const [first] = await eligibleVisits({ scheduledServiceId }, conn);
  if (!first) throw new ProtocolAuditError(404, 'NOT_ELIGIBLE', 'not a completed lawn or tree & shrub visit that can be audited');
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`tech-protocol-audit:${first.technician_id}:${first.month}`]);
    const [visit] = await eligibleVisits({ scheduledServiceId }, trx);
    if (!visit || visit.technician_id !== first.technician_id || visit.month !== first.month || (recordId && recordId !== visit.record_id)) {
      throw new ProtocolAuditError(409, 'STALE_VISIT', 'this visit changed since it was loaded: reload and review it again');
    }
    const sample = pickSample(
      await eligibleVisits({ monthStart: visit.month, technicianId: visit.technician_id }, trx),
      { technicianId: visit.technician_id, monthStart: visit.month, markedIds: await markedVisitIds(visit.technician_id, visit.month, trx) },
    );
    if (!sample.some((row) => row.scheduled_service_id === visit.scheduled_service_id)) {
      throw new ProtocolAuditError(409, 'NOT_IN_SAMPLE', "this visit is not in the technician's sample for the month");
    }
    const { rows } = await trx.raw(`
      INSERT INTO tech_protocol_audits (technician_id, scheduled_service_id, audit_month, result, note, audited_by, audited_at)
      VALUES (?, ?, ?::date, ?, ?, ?, now())
      ON CONFLICT (scheduled_service_id) DO UPDATE
         SET technician_id = EXCLUDED.technician_id, audit_month = EXCLUDED.audit_month,
             result = EXCLUDED.result, note = EXCLUDED.note, audited_by = EXCLUDED.audited_by, audited_at = now()
      RETURNING scheduled_service_id, result, note, audited_at`,
    [visit.technician_id, visit.scheduled_service_id, visit.month, result, text || null, auditedBy || null]);
    return { scheduledServiceId: rows[0].scheduled_service_id, result: rows[0].result, note: rows[0].note, auditedAt: rows[0].audited_at };
  });
}

module.exports = { CURRENT_AUDIT_FROM_SQL, CURRENT_AUDIT_WHERE_SQL, SAMPLE_SIZE, ProtocolAuditError, parseMonth, eligibleVisits, pickSample, getBoard, saveMark };
