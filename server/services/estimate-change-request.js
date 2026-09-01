// Customer soft exit on a sent estimate (GATE_ESTIMATE_SOFT_EXIT) — the two
// non-decline outcomes of the "Not what you expected?" sheet:
//
//   change request   — "I'd like to change something": parks ONE open
//                      service_requests row (requested_service =
//                      'estimate_change_request') + an admin bell. The
//                      estimate is NEVER mutated; the office sends the
//                      revision.
//   still deciding   — a soft signal only: one activity_log row, no request
//                      row, no bell. It exists so the loss taxonomy can tell
//                      "went quiet while deciding" from "never engaged", and
//                      so a parked request queue never fills with non-asks.
//
// Design constraints (all owner rulings carried over from the measurement
// review, which this module rides):
// - No customer comms from this flow — the sheet's success state is the
//   confirmation; the owner sends any follow-up.
// - No estimate write. The only durable rows are service_requests /
//   activity_log.
//
// Mechanism reuse (find-the-existing-mechanism rule): same service_requests
// table + open-request partial unique index as add-service and measurement
// review, a DEDICATED requested_service key so a change request coexists
// with a real add-service or re-measure on the same estimate, and the
// measurement review's own notify core (lease + advisory lock + crash-
// idempotent send) so the one-request/one-bell contract has one
// implementation.

const db = require('../models/db');
const logger = require('./logger');
const {
  INACTIVE_ESTIMATE_STATUSES,
  SOURCE_PUBLIC_ESTIMATE,
  OPEN_REQUEST_TERMINAL_STATUSES,
  resolveEstimateCustomer,
} = require('./estimate-add-service-request');
const {
  sendOfficeNotification,
  dedupedOutcome,
  defaultViewabilityCheck,
} = require('./estimate-measurement-review');

const CHANGE_REQUEST_SERVICE_KEY = 'estimate_change_request';
const CHANGE_REQUEST_KIND = {
  category: 'estimate_change_request',
  tag: 'estimate-change-request',
  lock: 'estimate-change-request-notify',
};

// Chip set on the sheet's "change something" branch — keys are the API
// contract, labels are what the office reads. Free text arrives via `note`.
const CHANGE_REQUEST_TOPICS = {
  price: 'The price',
  services: 'Which services are included',
  schedule: 'How often you visit',
  other: 'Something else',
};

function cleanText(value, max = 500) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}

function normalizeTopics(topics) {
  if (!Array.isArray(topics)) return [];
  const seen = new Set();
  const keys = [];
  for (const raw of topics) {
    const key = String(raw || '').trim();
    if (CHANGE_REQUEST_TOPICS[key] && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function isSoftExitEligible(estimate) {
  if (!estimate) return false;
  const status = String(estimate.status || '').toLowerCase();
  return !INACTIVE_ESTIMATE_STATUSES.includes(status);
}

function notFound() {
  const err = new Error('Estimate not found');
  err.status = 404;
  return err;
}

/**
 * Park a change request for the office. Same contract as
 * createEstimateMeasurementReview: viewability + eligibility re-validated on
 * the LOCKED row, call-side verdict re-checked inside the transaction, open-
 * request dedupe pre-checked under the lock, notification after commit.
 */
async function createEstimateChangeRequest({
  estimateToken,
  topics,
  note,
  database = db,
  viewabilityCheck = defaultViewabilityCheck,
  callSideBlockedFor = async () => false,
} = {}) {
  const token = String(estimateToken || '').trim();
  if (!token) throw notFound();

  const topicKeys = normalizeTopics(topics);
  const cleanNote = cleanText(note, 500);

  const estimate = await database('estimates').where({ token }).first();
  if (!estimate || !viewabilityCheck(estimate) || !isSoftExitEligible(estimate)) {
    throw notFound();
  }
  // Content validation only AFTER the token cleared the public eligibility
  // gates (measurement-review precedent): a 400 for an unknown token would
  // let anonymous probes distinguish gate state.
  if (!cleanNote) {
    const err = new Error('Tell us what you would like changed so we can send a revised estimate.');
    err.status = 400;
    throw err;
  }

  const runSerialized = typeof database.transaction === 'function'
    ? (fn) => database.transaction(async (trx) => {
      await trx('estimates').where({ id: estimate.id }).forUpdate().first();
      const locked = await trx('estimates').where({ id: estimate.id }).first();
      return fn(trx, locked || estimate);
    })
    : (fn) => fn(database, estimate);
  const serialized = typeof database.transaction === 'function';

  const outcome = await runSerialized(async (dbx, lockedEstimate) => {
    if (!viewabilityCheck(lockedEstimate) || !isSoftExitEligible(lockedEstimate)) throw notFound();
    if (await callSideBlockedFor(dbx, lockedEstimate)) throw notFound();
    return createChangeRequestRow({ database: dbx, estimate: lockedEstimate, topicKeys, cleanNote, serialized });
  });

  if (outcome && outcome.notify) {
    await sendOfficeNotification(database, outcome.notify, CHANGE_REQUEST_KIND);
    delete outcome.notify;
  }
  return outcome;
}

async function createChangeRequestRow({ database, estimate, topicKeys, cleanNote, serialized = false }) {
  const existingOpen = await database('service_requests')
    .where({ estimate_id: estimate.id, requested_service: CHANGE_REQUEST_SERVICE_KEY })
    .whereNotIn(database.raw("COALESCE(status, 'new')"), OPEN_REQUEST_TERMINAL_STATUSES)
    .first();
  if (existingOpen) return dedupedOutcome(existingOpen, estimate.id);

  const customer = await resolveEstimateCustomer(database, estimate, {
    sourceDetail: 'estimate_change_request',
    // The estimate row is never mutated by this flow — skip the resolver's
    // customer_id backfill exactly as the measurement review does.
    skipEstimateBackfill: true,
  });

  const estimateNumber = estimate.estimate_number || estimate.id;
  const topicLabels = topicKeys.map((k) => CHANGE_REQUEST_TOPICS[k]);
  const subject = `Change request on estimate #${estimateNumber}`;
  const description = [
    `Customer asked for a change to estimate ${estimateNumber} before deciding.`,
    topicLabels.length ? `About: ${topicLabels.join('; ')}.` : null,
    `Customer note: ${cleanNote}`,
    'Send a revised estimate; the sent estimate stays as-is until then and still expires on its normal date.',
  ].filter(Boolean).join(' ');

  let request;
  try {
    [request] = await database('service_requests').insert({
      customer_id: customer.id,
      estimate_id: estimate.id,
      requested_service: CHANGE_REQUEST_SERVICE_KEY,
      source: SOURCE_PUBLIC_ESTIMATE,
      category: 'change_request',
      subject,
      description,
      urgency: 'routine',
      status: 'new',
      pricing_revision: JSON.stringify({
        type: 'estimate_change_request',
        topics: topicKeys,
        note: cleanNote,
      }),
    }).returning('*');
  } catch (err) {
    if (err.code === '23505') {
      if (serialized) throw err;
      const dupe = await database('service_requests')
        .where({ estimate_id: estimate.id, requested_service: CHANGE_REQUEST_SERVICE_KEY })
        .whereNotIn(database.raw("COALESCE(status, 'new')"), OPEN_REQUEST_TERMINAL_STATUSES)
        .first();
      if (dupe) return dedupedOutcome(dupe, estimate.id);
    }
    throw err;
  }

  logger.info(`[estimate-change-request] request ${request.id} for estimate ${estimate.id} (${topicKeys.join(',') || 'note-only'})`);
  return {
    success: true,
    deduped: false,
    notify: {
      subject,
      description,
      customerId: customer.id,
      estimateId: estimate.id,
      requestId: request.id,
    },
  };
}

/**
 * "Still deciding" — the soft signal. One activity_log row per estimate per
 * day (the sheet can be reopened; the signal must not become a counter), no
 * request row, no bell, no estimate write. Same viewability + eligibility
 * gates as the change request so a dead token cannot write anything, and the
 * same serialized transaction: the estimate row is locked, every gate and
 * the call-side verdict re-run on the LOCKED row, and the once-per-day dedupe
 * read + insert happen under that lock so two concurrent taps cannot both
 * pass the check (pre-push codex P0).
 */
async function recordEstimateStillDeciding({
  estimateToken,
  database = db,
  viewabilityCheck = defaultViewabilityCheck,
  callSideBlockedFor = async () => false,
} = {}) {
  const token = String(estimateToken || '').trim();
  if (!token) throw notFound();
  const estimate = await database('estimates').where({ token }).first();
  if (!estimate || !viewabilityCheck(estimate) || !isSoftExitEligible(estimate)) throw notFound();

  const runSerialized = typeof database.transaction === 'function'
    ? (fn) => database.transaction(async (trx) => {
      await trx('estimates').where({ id: estimate.id }).forUpdate().first();
      const locked = await trx('estimates').where({ id: estimate.id }).first();
      return fn(trx, locked || estimate);
    })
    : (fn) => fn(database, estimate);

  return runSerialized(async (dbx, lockedEstimate) => {
    if (!viewabilityCheck(lockedEstimate) || !isSoftExitEligible(lockedEstimate)) throw notFound();
    if (await callSideBlockedFor(dbx, lockedEstimate)) throw notFound();

    const recent = await dbx('activity_log')
      .where({ estimate_id: lockedEstimate.id, action: 'estimate_customer_still_deciding' })
      .where('created_at', '>', dbx.raw("NOW() - interval '1 day'"))
      .first();
    if (recent) return { success: true, deduped: true };

    await dbx('activity_log').insert({
      customer_id: lockedEstimate.customer_id || null,
      estimate_id: lockedEstimate.id,
      action: 'estimate_customer_still_deciding',
      description: 'Customer said they are still deciding on their estimate.',
      metadata: JSON.stringify({ source: SOURCE_PUBLIC_ESTIMATE }),
    });
    logger.info(`[estimate-change-request] still-deciding signal for estimate ${lockedEstimate.id}`);
    return { success: true, deduped: false };
  });
}

module.exports = {
  CHANGE_REQUEST_SERVICE_KEY,
  CHANGE_REQUEST_TOPICS,
  normalizeTopics,
  isSoftExitEligible,
  createEstimateChangeRequest,
  recordEstimateStillDeciding,
};
