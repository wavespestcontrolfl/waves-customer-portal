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
           AND NOT ${VISIT_IS_CALLBACK_SQL('sr')}
           AND ${PERFORMED_OUTCOME_SQL('sr')}
           AND NOT (${internalTestVisitSql('sr')})
           AND sr.scheduled_service_id IN (SELECT y.scheduled_service_id FROM service_records y WHERE y.scheduled_service_id IS NOT NULL
                                           ${candidate.join(' ')})
         ORDER BY sr.scheduled_service_id, sr.created_at DESC, sr.id DESC
      ) c
     WHERE c.technician_id IS NOT NULL ${outer.join(' ')}`, [...candidateParams, ...params]);
  // the technician check runs AFTER the newest record is picked: a newest record with no technician makes the
  // visit unauditable instead of letting an older assigned sibling put it in that technician's sample
  return rows.filter((row) => AUDIT_LINES.includes(row.service_line || detectServiceLine(row.service_type)));
}

const sampleRank = (technicianId, monthStart, visitId) => crypto.createHash('sha256')
  .update(`${technicianId}:${monthStart}:${visitId}`).digest('hex');

const compareRank = (x, y) => (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : 0);

/**
 * Pure: up to SAMPLE_SIZE of one technician's eligible visits for one month. Counted marks (markedIds) always
 * stay; `reserved` more counted marks sit on visits that are not on the list (a deleted visit, a corrected
 * service line) and use up slots; the lowest sha256 ranks fill the rest. Returned in rank order.
 */
function pickSample(rows, { technicianId, monthStart, markedIds = new Set(), reserved = 0 }) {
  const ranked = rows
    .map((row) => ({ row, rank: sampleRank(technicianId, monthStart, row.scheduled_service_id) }))
    .sort(compareRank);
  const kept = ranked.filter(({ row }) => markedIds.has(row.scheduled_service_id));
  const fill = ranked.filter(({ row }) => !markedIds.has(row.scheduled_service_id)).slice(0, Math.max(0, SAMPLE_SIZE - kept.length - reserved));
  return [...kept, ...fill].sort(compareRank).map(({ row }) => row);
}

/**
 * A mark counts only while it matches its visit's CURRENT eligible record (the ONE eligibility, eligibleVisits):
 * the same technician and ET month, and no replacement record made after the mark. A moved visit leaves the old
 * technician's score; a replaced record asks for a new mark. A row whose visit was deleted (scheduled_service_id
 * NULL) keeps counting: nothing is left to compare it with. Pure.
 */
function markIsCurrent(mark, visit) {
  if (!mark.scheduled_service_id) return true;
  return Boolean(visit) && mark.technician_id === visit.technician_id && mark.month === visit.month
    && new Date(visit.record_created_at).getTime() <= new Date(mark.audited_at).getTime();
}

/**
 * The marks that count toward a technician's score for audit months fromMonth..toMonth ('YYYY-MM-01'): the current
 * marks (markIsCurrent), at most SAMPLE_SIZE per month, the lowest sample ranks first, so a visit that returns to a
 * technician can never make a sixth counted mark. The board and the score's readAudit both read this.
 */
async function countedMarks(technicianId, { fromMonth, toMonth }, conn = db) {
  const { rows } = await conn.raw(
    `SELECT id, scheduled_service_id, technician_id, result, audited_at, to_char(audit_month, 'YYYY-MM-DD') AS month
       FROM tech_protocol_audits
      WHERE technician_id = ? AND audit_month >= ?::date AND audit_month <= ?::date`,
    [technicianId, fromMonth, toMonth],
  );
  const counted = [];
  for (const month of [...new Set(rows.map((r) => r.month))]) {
    const visits = new Map((await eligibleVisits({ monthStart: month, technicianId }, conn)).map((v) => [v.scheduled_service_id, v]));
    counted.push(...rows.filter((r) => r.month === month && markIsCurrent(r, visits.get(r.scheduled_service_id)))
      .map((mark) => ({ mark, rank: sampleRank(technicianId, month, mark.scheduled_service_id || mark.id) }))
      .sort(compareRank).slice(0, SAMPLE_SIZE).map(({ mark }) => mark));
  }
  return counted;
}

// One technician's sample for one month, from its eligible visits `own`: counted marks stay, the rest is filled by rank.
async function sampleFor(own, technicianId, monthStart, conn = db) {
  const counted = await countedMarks(technicianId, { fromMonth: monthStart, toMonth: monthStart }, conn);
  const markedIds = new Set(counted.map((m) => m.scheduled_service_id).filter(Boolean));
  const reserved = counted.length - own.filter((row) => markedIds.has(row.scheduled_service_id)).length;
  return { sample: pickSample(own, { technicianId, monthStart, markedIds, reserved }), counted: markedIds };
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
    logger.warn(`[tech-protocol-audit] photo presign failed (${err.code || err.name || 'error'})`);
    return null;
  }
}

// The mark a visit shows: counted (audit), or an old mark that no longer counts (needsRecheck).
function auditState(a, counted) {
  if (!a) return { audit: null, needsRecheck: false };
  return counted ? { audit: { result: a.result, note: a.note, auditedAt: a.audited_at }, needsRecheck: false } : { audit: null, needsRecheck: true };
}

// What the owner compares with the protocol, for the sampled records: products with rate, area and
// targets, photos, the customer's name, and the existing mark. Reads only.
async function visitDetails(sampled, countedIds, conn = db) {
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
  // A mark shows only while it counts (countedMarks, the score's own rule); otherwise the visit reads as unmarked,
  // flagged "needs re-check" (a moved visit, a replaced record); marking again re-attributes it.
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
      technicianId: row.technician_id,
      month: row.month.slice(0, 7),
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
      ...auditState(auditRow.get(row.scheduled_service_id), countedIds.has(row.scheduled_service_id)),
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
    const { sample: sampled, counted } = await sampleFor(own, technicianId, monthStart, conn);
    const details = await visitDetails(sampled, counted, conn);
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
async function saveMark({ scheduledServiceId, technicianId, month, recordId, result, note, auditedBy }, conn = db) {
  if (typeof scheduledServiceId !== 'string' || !UUID_RE.test(scheduledServiceId)) throw new ProtocolAuditError(400, 'INVALID_VISIT', 'visit id must be a uuid');
  if (typeof technicianId !== 'string' || !UUID_RE.test(technicianId) || !MONTH_RE.test(String(month))) {
    throw new ProtocolAuditError(400, 'INVALID_CONTEXT', 'technicianId and month (YYYY-MM) of the board are required');
  }
  // the record the owner reviewed is required: without it a replacement record could inherit the judgment
  if (typeof recordId !== 'string' || !UUID_RE.test(recordId)) throw new ProtocolAuditError(400, 'INVALID_RECORD', 'recordId of the reviewed record is required');
  if (!RESULTS.includes(result)) throw new ProtocolAuditError(400, 'INVALID_RESULT', "result must be 'match' or 'mismatch'");
  const text = note == null ? '' : String(note).trim();
  if (text.length > MAX_NOTE_CHARS) throw new ProtocolAuditError(400, 'NOTE_TOO_LONG', `note must be at most ${MAX_NOTE_CHARS} characters`);
  if (result === 'mismatch' && !text) throw new ProtocolAuditError(400, 'NOTE_REQUIRED', 'a mismatch needs a note');
  const [first] = await eligibleVisits({ scheduledServiceId }, conn);
  if (!first) throw new ProtocolAuditError(404, 'NOT_ELIGIBLE', 'not a completed lawn or tree & shrub visit that can be audited');
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`tech-protocol-audit:${first.technician_id}:${first.month}`]);
    const [visit] = await eligibleVisits({ scheduledServiceId }, trx);
    // the mark is filed under the technician and month the board showed; any other current record is refused
    if (!visit || visit.technician_id !== first.technician_id || visit.month !== first.month
      || visit.technician_id !== technicianId.toLowerCase() || visit.month.slice(0, 7) !== month || recordId.toLowerCase() !== visit.record_id) {
      throw new ProtocolAuditError(409, 'STALE_VISIT', 'this visit changed since it was loaded: reload and review it again');
    }
    const { sample } = await sampleFor(await eligibleVisits({ monthStart: visit.month, technicianId: visit.technician_id }, trx), visit.technician_id, visit.month, trx);
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

module.exports = { SAMPLE_SIZE, ProtocolAuditError, parseMonth, eligibleVisits, pickSample, countedMarks, getBoard, saveMark };
