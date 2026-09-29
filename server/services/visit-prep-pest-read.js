/**
 * Visit prep photos — automatic pest read (PR 5, GATE_VISIT_PREP_PEST_READ,
 * dark). Second-order feature on top of PR 1's visit-prep foundation
 * (services/visit-prep.js): when a customer's visit-prep submission is (or
 * defaults to) the pest topic, this runs the SAME pest v2 engine the app's
 * Photo ID route calls (identifyPestV2, server/routes/photo-id.js ~line
 * 477) over the just-uploaded photos and stores the result in
 * `pest_identifications` with `source = 'visit_prep'`, `mode = 'internal'`
 * — already an allowed mode, no migration needed on that table (verified in
 * production, scope doc §5.3). Internal mode keeps the read out of the
 * customer's own Photo ID history and the prospect funnel; the customer
 * NEVER sees this read.
 *
 * Trigger rule (owner delta on scope doc §5.3 — the topic chips were
 * removed, so most submissions carry `topic: null`):
 *   - submission.topic === 'pest'  → run the read.
 *   - submission.topic === null AND the visit's service line is Pest
 *     Control (server/services/service-line.js's classifyServiceLine on
 *     scheduled_services.service_type; a grouped stop is pest if ANY LIVE
 *     — non-terminal — member is) → run the read.
 *   - submission.topic is 'lawn' / 'tree_shrub' / 'other', OR topic is null
 *     and the service line is anything else → read_status 'unsupported',
 *     no engine call, no cap spent. Lawn and tree & shrub have no engine
 *     yet (scope doc §5.3, "being rebuilt").
 *
 * Called from visit-prep.js's createVisitPrepSubmission — the ONE place a
 * submission is created, never from a route — so every entry point (the
 * public appointment-page POST today, the upcoming customer-auth app
 * route) inherits this for free. Always invoked AFTER that submission's
 * own transaction has already committed, fire-and-forget: the caller does
 * `void triggerVisitPrepPestRead(...)` and never awaits it, so a slow or
 * failing vision call can never add latency to, or fail, the customer's
 * upload response. Every error here is caught and logged; `read_status`
 * is written 'failed' rather than left stuck on 'pending'.
 *
 * Own daily cap, `VISIT_PREP_READ_DAILY_CAP` (default 40, env, read fresh
 * per call) — separate from the app Photo ID route's own per-customer/
 * shared budgets. A capped submission never blocks: the photos still reach
 * the technician, only the read line is withheld (read_status 'failed').
 */

const db = require('../models/db');
const logger = require('./logger');
const PhotoService = require('./photos');
const { identifyPestV2 } = require('./photo-id-v2/pest-engine');
const { classifyServiceLine } = require('./service-line');
const { visitPrepPestReadLive } = require('../config/feature-gates');
const { TERMINAL_ROW_STATUSES } = require('./visit-context/statuses');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');

const DEFAULT_DAILY_CAP = 40;

function dailyCap() {
  const value = Number(process.env.VISIT_PREP_READ_DAILY_CAP);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_DAILY_CAP;
}

// Every LIVE (non-terminal) service_type on svc's CURRENT stop, resolved
// fresh from scheduled_services — same "read current membership, never a
// snapshot" rule visit-prep.js's own stopMemberIds/techStopMemberIds
// follow, kept as its own small query here rather than importing either
// (this module has no need for their tech-ownership or customer-cap
// scoping, only "is any live member a pest visit"). Ungrouped: just svc's
// own type.
async function liveStopServiceTypes(svc, conn) {
  if (!svc?.visit_id) return svc?.service_type ? [svc.service_type] : [];
  const rows = await conn('scheduled_services')
    .where({ visit_id: svc.visit_id })
    .select('service_type', 'status');
  const live = rows.filter((r) => !TERMINAL_ROW_STATUSES.includes(r.status));
  // svc itself always counts — it just committed as part of THIS write, so
  // a stale read of its own row (a status not yet visible on this
  // connection) must never drop it from its own stop.
  if (svc.service_type && !live.some((r) => r.service_type === svc.service_type)) {
    live.push({ service_type: svc.service_type, status: svc.status || null });
  }
  return live.map((r) => r.service_type);
}

async function isPestStop(svc, conn = db) {
  const types = await liveStopServiceTypes(svc, conn);
  return types.some((t) => classifyServiceLine(t) === 'Pest Control');
}

// Decide 'pest' | 'unsupported' BEFORE any engine call or cap check —
// 'unsupported' spends neither.
async function resolveApplicability(topic, svc, conn) {
  if (topic === 'pest') return 'pest';
  if (topic === 'lawn' || topic === 'tree_shrub' || topic === 'other') return 'unsupported';
  // topic === null (the common case since the topic chips were removed):
  // infer from the visit's own service line.
  return (await isPestStop(svc, conn)) ? 'pest' : 'unsupported';
}

// Every read ATTEMPTED today, not only the ones that stored a result: an
// engine call that failed still cost a vision call. pending/done/failed are
// the statuses a pest-applicable submission can reach (unsupported never
// calls the engine and never counts).
// The cap's day is the America/New_York calendar day (AGENTS.md), not
// the DB session's UTC day: midnight ET as an instant, bound as a param.
function etDayStart(now = new Date()) {
  return parseETDateTime(`${etDateString(now)}T00:00`);
}

async function readsToday(conn, now = new Date()) {
  const row = await conn('visit_prep_submissions')
    .whereIn('read_status', ['pending', 'done', 'failed'])
    .where('created_at', '>=', etDayStart(now))
    .count('id as count')
    .first();
  return Number(row?.count || 0);
}

async function setReadStatus(conn, submissionId, status, readRef = null) {
  try {
    await conn('visit_prep_submissions').where({ id: submissionId }).update({
      read_status: status,
      read_ref: readRef,
    });
  } catch (err) {
    logger.error(`[visit-prep-pest-read] failed to write read_status=${status} submission=${submissionId}: ${err.message}`);
  }
}

// Loads every photo's bytes from S3 (PhotoService.getPhotoBase64 — the ONE
// reader for this bucket's pixels, same helper the tech thumbnails and
// admin resize paths use) and hands them to identifyPestV2 in the exact
// `{ data, mimeType }` shape it already consumes from the app's Photo ID
// route.
async function runEngine(photos) {
  const loaded = await Promise.all(photos.map((p) => PhotoService.getPhotoBase64(p.s3Key)));
  return identifyPestV2(loaded);
}

// Insert the read into pest_identifications — mode='internal' (keeps it out
// of the customer's own history + the prospect funnel), source='visit_prep'
// (no CHECK constraint on this column; both verified in production, scope
// doc §5.3). Stores the SAME v1+v2 combined JSON shape photo-id.js's
// handlePest stores for a customer's own Photo ID submission, so the fixed
// fields previsit-brief.js reads back (readFactsFromContract in
// visit-prep.js) come from one well-tested shape.
async function storeIdentification(conn, { svc, submissionId, result }) {
  const { v1, v2, internal } = result;
  const row = await conn('pest_identifications').insert({
    mode: 'internal',
    status: 'analyzed',
    source: 'visit_prep',
    customer_id: svc.customer_id,
    report_contract: JSON.stringify({ ...v1.report_contract, v2 }),
    category: v1.report_contract?.identification?.category || null,
    species_slug: v1.species_slug || null,
    service_line: v1.service_line || null,
    urgency: v1.urgency || null,
    ai_summary: (v1.report_contract?.observations || []).join(' ').slice(0, 2000) || null,
    ai_analysis: JSON.stringify({ engine: 'v2', internal, visit_prep_submission_id: submissionId }),
  }).returning('id');
  return row[0]?.id || row[0];
}

/**
 * @param {object} opts
 * @param {string} opts.submissionId        the just-committed visit_prep_submissions row id
 * @param {object} opts.svc                 the RECHECKED visit row (createVisitPrepSubmission's
 *                                           own `result.current`) — id, customer_id, service_type,
 *                                           visit_id, status
 * @param {string|null} opts.topic           the submission's normalized topic
 * @param {Array<{s3Key:string, mimeType:string}>} opts.photos  the NEW photos this submission stored
 * @param {object} [opts.conn]               defaults to the global pool — this ALWAYS runs after
 *                                            the write transaction has already committed, so it
 *                                            must never be handed that transaction (a caller
 *                                            passing one is a bug: it would hold the connection
 *                                            open across a network vision call).
 * @returns {Promise<void>} never throws — every failure is caught, logged, and written as
 *          read_status='failed' so the row never sticks on 'pending'.
 */
async function triggerVisitPrepPestRead({
  submissionId, svc, topic, photos, conn = db,
} = {}) {
  if (!submissionId || !svc?.id) return;
  if (!visitPrepPestReadLive()) return; // gate off — leave read_status at its 'none' default
  if (!Array.isArray(photos) || photos.length === 0) return;

  let applicability;
  try {
    applicability = await resolveApplicability(topic, svc, conn);
  } catch (err) {
    logger.error(`[visit-prep-pest-read] applicability check failed submission=${submissionId}: ${err.message}`);
    await setReadStatus(conn, submissionId, 'failed');
    return;
  }

  if (applicability === 'unsupported') {
    await setReadStatus(conn, submissionId, 'unsupported');
    return;
  }

  let capCount;
  try {
    capCount = await readsToday(conn);
  } catch (err) {
    logger.error(`[visit-prep-pest-read] daily-cap count failed submission=${submissionId}: ${err.message}`);
    await setReadStatus(conn, submissionId, 'failed');
    return;
  }
  if (capCount >= dailyCap()) {
    logger.warn(`[visit-prep-pest-read] daily cap (${dailyCap()}) reached — submission=${submissionId} not read, photos still delivered`);
    await setReadStatus(conn, submissionId, 'failed');
    return;
  }

  await setReadStatus(conn, submissionId, 'pending');

  let result;
  try {
    result = await runEngine(photos);
  } catch (err) {
    logger.error(`[visit-prep-pest-read] engine threw for submission=${submissionId}: ${err.message}`);
    await setReadStatus(conn, submissionId, 'failed');
    return;
  }

  if (!result.ok) {
    logger.warn(`[visit-prep-pest-read] engine miss (${result.reason}) submission=${submissionId}`);
    await setReadStatus(conn, submissionId, 'failed');
    return;
  }

  let readRef;
  try {
    readRef = await storeIdentification(conn, { svc, submissionId, result });
  } catch (err) {
    logger.error(`[visit-prep-pest-read] storing pest_identifications failed submission=${submissionId}: ${err.message}`);
    await setReadStatus(conn, submissionId, 'failed');
    return;
  }

  await setReadStatus(conn, submissionId, 'done', readRef);
}

module.exports = {
  triggerVisitPrepPestRead,
  dailyCap,
  _internal: { isPestStop, resolveApplicability, liveStopServiceTypes, etDayStart },
};
