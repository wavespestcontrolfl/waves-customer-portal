'use strict';

// Call booking check (owner 2026-11-22, "fix"): the visit the call agent booked, against what the call said.
//
// On 2026-11-21 a caller asked for a one-time ant treatment the same day. The call's stored reading (the V2
// extraction) named the one-time service. The booking wrote a monthly plan visit, and the texts to the customer
// named the plan. The owner corrected the visit 82 minutes later. Nothing told the office in between.
//
// Every 15 minutes in office hours this job reads each open visit the call agent booked in the last 7 days and
// the stored reading of its call. One problem today, one Schedule bell, raised once for a visit:
//   service  the call named a one-time service and the visit is a plan visit.
// A bell's key and metadata carry the problem's name, so a second problem adds a row to KINDS and CLOSED.
//
// CLOSE: each run first judges every open bell again from the visit as it stands now. A bell closes itself only
// on evidence: the visit and the reading agree now, or the visit is done, cancelled or gone. While the reading
// or the catalog cannot be read (a call being processed again, a name the catalog no longer holds) the bell
// stays open, because a closed bell never rings again: the dedupe key holds a visit to one bell for each problem.
//
// The check does not run the recurring-intent rule (applyRecurringIntentDefault) before it judges. That rule
// reads cadence words in the transcript, and it is the step this check watches: in a 90-day replay it changed
// the reading's service on 6 calls and each was a misread. A reading that itself says the caller asked about a
// plan (service_intent) does not ring.
//
// Why every 15 minutes: in 90 days two visits had this problem, and the office corrected the 2026-11-21 one
// within 82 minutes, on the day of the visit. A daily run would have seen it only after it was fixed.
//
// Read-only except admin notifications. Nothing goes to a customer and no paid API is called. No gate: it texts
// no one, moves no money and changes no record.

const db = require('../models/db');
const logger = require('./logger');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { isInternalTestCustomerId } = require('./internal-test-customers');
const { VISIT_NEVER_RAN_STATUSES } = require('./invoice-helpers');
const { OFFICE_REVIEW_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');

const OWN_PREFIX = 'call-booking-check:';
const AREA = 'Schedule';
const LOOKBACK_DAYS = 7;
// The markers a call writes on a primary visit it books itself: the auto-booking, and the two kinds that wait
// for the office to confirm (an outbound-callback booking, a voice-agent or street-level pending booking).
const CALL_BOOKED_SOURCE_ACTIONS = Object.freeze(['ai_call_pipeline', ...OFFICE_REVIEW_PENDING_SOURCE_ACTIONS]);
// A visit the office can still correct before it is billed: a bell is raised only for these.
const OPEN_STATUSES = Object.freeze(['pending', 'confirmed', 'en_route', 'on_site']);
// A visit that finished or will never run: its bell closes. 'rescheduled' is in neither list. A pending
// reschedule request parks the same row and staff can confirm it again with the same service, so its bell
// stays open (admin-alert-relevance.js reads visit statuses the same way).
const CLOSED_VISIT_STATUSES = new Set([...VISIT_NEVER_RAN_STATUSES, 'completed']);

// Why a bell closed: the reason code stored on the row, and the one line a person reads.
const CLOSED = Object.freeze({
  service: { reason: 'service_agrees', text: 'The visit and the call now agree on the service' },
  visitClosed: { reason: 'visit_closed', text: 'The visit is done or cancelled' },
  gone: { reason: 'visit_gone', text: 'The visit is gone' },
});
// The problems this job knows. A bell's metadata.problem is one of these.
const KINDS = Object.freeze(['service']);

const nameKey = (name) => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();

// ------------------------------------------------------------------ judge (pure)

function readingOf(visit) {
  const stored = visit.ai_extraction_enriched;
  if (!stored) return null;
  if (typeof stored === 'object') return stored;
  try { return JSON.parse(stored); } catch { return null; }
}

const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();

// What the visit and the reading of its call say about the service, as they stand now:
//   problem  the reading names a one-time service and the visit is a plan visit ({ verdict, heard });
//   agrees   the visit is a one-time visit, or the reading names a plan or says the caller asked about one;
//   unknown  one side cannot be read: no valid reading, a name the catalog does not hold or holds under two
//            billing types, or a visit with no catalog row.
// `billingByName` maps a catalog service name to its billing type.
function judgeService(visit, billingByName) {
  if (visit.row_billing_type === 'one_time') return { verdict: 'agrees' };
  const reading = visit.v2_extraction_status === 'valid' ? readingOf(visit) : null;
  const request = reading && reading.service_request;
  if (!visit.row_billing_type || !request || typeof request !== 'object') return { verdict: 'unknown' };
  const heard = tidy(request.specific_service_name);
  const heardBilling = billingByName.get(nameKey(heard));
  if (!heardBilling) return { verdict: 'unknown' };
  if (heardBilling !== 'one_time' || request.service_intent === 'recurring_membership_inquiry') return { verdict: 'agrees' };
  return { verdict: 'problem', heard };
}

// What an open bell should do now: a CLOSED key, or null to stay open.
function closeKeyFor(kind, visit, billingByName) {
  if (!visit) return 'gone';
  if (CLOSED_VISIT_STATUSES.has(String(visit.status))) return 'visitClosed';
  return judgeService(visit, billingByName).verdict === 'agrees' ? kind : null;
}

// ------------------------------------------------------------------- copy (pure)

function specFor({ visit, heard, name }) {
  const { cutAtWord, MAX_WHY_CHARS } = require('./admin-alert-compose');
  const { fitAction } = require('./admin-alert-names');
  const booked = tidy(visit.row_name || visit.service_type || 'a visit');
  // Each service name gets half of the room the fixed words leave.
  const room = Math.floor((MAX_WHY_CHARS - 'Booked as ; the call asked for .'.length) / 2);
  return {
    area: AREA,
    severity: 'needs-you',
    who: 'person',
    link: `/admin/dispatch?tab=schedule&date=${encodeURIComponent(visit.visit_date)}&appointment=${encodeURIComponent(visit.id)}`,
    subject: { type: 'visit', id: String(visit.id) },
    action: name
      ? fitAction(AREA, name, [(who) => `check the service on ${who}'s visit`, (who) => `check ${who}'s visit`])
      : 'check the service on a phone-booked visit',
    why: `Booked as ${cutAtWord(booked, room)}; the call asked for ${cutAtWord(tidy(heard), room)}.`,
    doneWhen: 'visit_service_one_time',
  };
}

function detailFor({ visit, heard, name }) {
  const booked = tidy(visit.row_name || visit.service_type || 'a visit');
  return `${name || 'A customer'}: the visit booked from a phone call for ${visit.visit_date} is "${booked}", a plan visit. `
    + `The call's reading names "${tidy(heard)}", a one-time service. `
    + 'Change the visit\'s service if the caller asked for a one-time job. '
    + 'Nothing was changed and the customer was not contacted.';
}

// ------------------------------------------------------------------- reads

// A visit with its catalog row and the stored reading of its call. Left joins, so the close pass still reads
// a visit whose call or catalog row cannot be read now. Voice sandbox calls are left out.
function visitRows() {
  return whereNotSandboxCall(
    db('scheduled_services as ss')
      .leftJoin('call_log as cl', 'cl.id', 'ss.source_call_log_id')
      .leftJoin('services as sv', 'sv.id', 'ss.service_id'),
    'cl.source',
  ).select(
    'ss.*',
    db.raw("to_char(ss.scheduled_date, 'YYYY-MM-DD') as visit_date"),
    'cl.v2_extraction_status', 'cl.ai_extraction_enriched',
    'sv.name as row_name', 'sv.service_key as row_service_key', 'sv.billing_type as row_billing_type',
  );
}

// The primary visits a call booked itself (not a follow-up child, not a row a person made from the call) whose
// call has a valid reading.
function callBookedVisits() {
  return visitRows()
    .whereIn('ss.source_action', CALL_BOOKED_SOURCE_ACTIONS)
    .whereNull('ss.parent_service_id')
    .where('cl.v2_extraction_status', 'valid');
}

// Catalog service name -> billing type. A name two rows share with different billing types reads as unknown.
async function loadBillingByName() {
  const byName = new Map();
  for (const row of await db('services').select('name', 'billing_type')) {
    const key = nameKey(row.name);
    byName.set(key, byName.has(key) && byName.get(key) !== row.billing_type ? null : row.billing_type);
  }
  return byName;
}

// ------------------------------------------------------------------ passes

// Judge each open bell again, from its visit read by id; close the ones evidence closes. Returns { closed, failed }.
async function closePass(episodes, billingByName, now) {
  const bells = (await episodes.openAdminAlertMetadata(db, OWN_PREFIX))
    .filter((meta) => meta.scheduledServiceId && KINDS.includes(meta.problem));
  const tally = { closed: 0, failed: 0 };
  if (!bells.length) return tally;
  const ids = [...new Set(bells.map((meta) => String(meta.scheduledServiceId)))];
  const visits = new Map((await visitRows().whereIn('ss.id', ids)).map((visit) => [String(visit.id), visit]));
  for (const meta of bells) {
    try {
      const key = closeKeyFor(meta.problem, visits.get(String(meta.scheduledServiceId)), billingByName);
      if (key) {
        tally.closed += Number(await episodes.closeAdminAlertKeys(
          db, [`${OWN_PREFIX}${meta.problem}:${meta.scheduledServiceId}`], CLOSED[key].reason, { now, resolution: CLOSED[key].text },
        )) || 0;
      }
    } catch (err) {
      tally.failed += 1;
      logger.warn(`[call-booking-check] close check failed for visit ${meta.scheduledServiceId}: ${err.message}`);
    }
  }
  return tally;
}

// Raise one bell. Returns 1 when a new row rang, 0 when the visit already has a row for this problem.
async function raiseBell(visit, heard) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const { lookupCustomerName } = require('./admin-alert-names');
  const name = await lookupCustomerName(db, visit.customer_id);
  const result = await raiseAdminAlert('schedule', specFor({ visit, heard, name }), {
    bell: true,
    dedupeKey: `${OWN_PREFIX}service:${visit.id}`,
    detail: detailFor({ visit, heard, name }),
    metadata: {
      scheduledServiceId: String(visit.id), customerId: visit.customer_id && String(visit.customer_id),
      callLogId: String(visit.source_call_log_id), problem: 'service',
    },
  });
  if (!result) throw new Error('call booking check bell was not written');
  return result.suppressed || result.deduped ? 0 : 1;
}

// Judge every open call-booked visit of the last 7 days; raise a bell for each one with a problem.
async function raisePass(billingByName, now) {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const visits = (await callBookedVisits().where('ss.created_at', '>=', since).whereIn('ss.status', OPEN_STATUSES))
    .filter((visit) => !isInternalTestCustomerId(visit.customer_id));
  const tally = { raised: 0, failed: 0, candidates: visits.length };
  for (const visit of visits) {
    try {
      const judged = judgeService(visit, billingByName);
      if (judged.verdict === 'problem') tally.raised += await raiseBell(visit, judged.heard);
    } catch (err) {
      tally.failed += 1;
      logger.warn(`[call-booking-check] bell failed for visit ${visit.id}: ${err.message}`);
    }
  }
  return tally;
}

/**
 * Cron entry point (every 15 minutes in office hours). Returns { skipped } when alert episodes are off, else
 * { raised, closed, candidates, outcome }. A visit that failed is counted and the run throws after the others,
 * so runExclusive records it in job_health. Every read and write uses the server's own connection, the one the
 * alert writer uses. `now` is for tests.
 */
async function runCallBookingCheck({ now = new Date() } = {}) {
  const gates = require('../config/feature-gates');
  // ALERT_EPISODES off: this job closes only through admin-alert-episodes, so it stands down rather than raise
  // bells it could never close. A test that mocks feature-gates without the reader keeps the default.
  if (typeof gates.alertEpisodesLive === 'function' && !gates.alertEpisodesLive()) return { skipped: 'episodes_off' };
  const billingByName = await loadBillingByName();
  const closed = await closePass(require('./admin-alert-episodes'), billingByName, now);
  const raised = await raisePass(billingByName, now);
  const failed = closed.failed + raised.failed;
  if (failed) throw new Error(`${failed} call booking check${failed === 1 ? '' : 's'} failed`);
  return {
    raised: raised.raised, closed: closed.closed, candidates: raised.candidates,
    outcome: raised.raised || closed.closed ? 'changed' : 'clear',
  };
}

module.exports = {
  runCallBookingCheck,
  OWN_PREFIX,
  _private: { judgeService, closeKeyFor, specFor, detailFor, CLOSED },
};
