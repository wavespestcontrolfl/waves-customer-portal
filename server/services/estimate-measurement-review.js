// "Does the lawn size look off?" — the customer challenge flow for the
// treatable-area line on the estimate (owner GO 2026-08-12).
//
// Design constraints, all owner rulings:
// - The customer NEVER self-adjusts the priced area (a customer-set basis
//   reintroduces shown ≠ billed). A challenge parks a review request for the
//   office; the estimate stays exactly as sent until the office re-measures
//   and sends a revision.
// - No customer comms from this flow — the sheet's success state is the
//   confirmation, and the office sends any follow-up (owner sends all comms).
// - No tech-visit promise anywhere in the copy (owner 2026-08-12: verify-on-
//   first-visit wording writes a work order for the field tech).
//
// Mechanism reuse (find-the-existing-mechanism rule): rides the same
// `service_requests` table + open-request unique index the add-service flow
// uses (migration 20260606000001) — `requested_service` is a DEDICATED key
// ('lawn_area_review') so a re-measure request can coexist with a real
// "add lawn care" request on the same estimate, while duplicate OPEN
// re-measures dedupe on the partial unique index exactly like add-service.

const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const {
  INACTIVE_ESTIMATE_STATUSES,
  SOURCE_PUBLIC_ESTIMATE,
  OPEN_REQUEST_TERMINAL_STATUSES,
  resolveEstimateCustomer,
} = require('./estimate-add-service-request');

const MEASUREMENT_REVIEW_SERVICE_KEY = 'lawn_area_review';

// Chip set shown on the sheet — keys are the API contract, labels are what
// the office reads on the request. Free-text arrives separately via `note`.
const MEASUREMENT_REVIEW_REASONS = {
  less_lawn: 'We have less lawn than that',
  rock_or_beds: 'Part of the yard is rock or beds',
  new_pool_or_landscaping: 'New pool or landscaping',
  fenced_area: "A fenced area shouldn't be treated",
  bigger: "It's bigger than that",
};

function cleanText(value, max = 500) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}

function normalizeReasons(reasons) {
  if (!Array.isArray(reasons)) return [];
  const seen = new Set();
  const keys = [];
  for (const raw of reasons) {
    const key = String(raw || '').trim();
    if (MEASUREMENT_REVIEW_REASONS[key] && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function isMeasurementReviewEligible(estimate) {
  if (!estimate) return false;
  const status = String(estimate.status || '').toLowerCase();
  return !INACTIVE_ESTIMATE_STATUSES.includes(status);
}

// The FULL customer-viewability contract (publication, expiry, archive,
// linkage-invalidation) — codex #3376 r2: a leaked draft/archived/past-
// expiry token must not be able to park a request, resolve a customer, or
// ring the office for an estimate every customer-facing read already
// refuses. Lazy require: estimate-public itself requires this service only
// inside its route handler, so the cycle never bites at load time.
function defaultViewabilityCheck(estimate) {
  const { isEstimateCustomerViewable } = require('../routes/estimate-public');
  return isEstimateCustomerViewable(estimate);
}

async function createEstimateMeasurementReview({
  estimateToken,
  reasons,
  note,
  database = db,
  viewabilityCheck = defaultViewabilityCheck,
  // callSideBlockedFor(dbx, estimateRow) -> Promise<bool> — the DURABLE
  // call-side linkage verdict (AGENTS.md call-pipeline fail-closed rules),
  // re-checked INSIDE the transaction on the locked row (local audit P0:
  // call processing can invalidate the linkage after the route's pre-check,
  // and the service must not create/link a customer from wrong-lead data).
  // Reads through the transaction connection so the verdict is consistent
  // with the locked row. Default fail-OPEN only for direct unit callers;
  // the route always passes the real check.
  callSideBlockedFor = async () => false,
  // basisFor(estimateRow) -> { sqft, source } | null — the priced lawn basis,
  // built by the route from the SAME helpers that render the area line.
  // Called TWICE: pre-lock for the fast 404 (pest-only estimates take no
  // lawn challenge, indistinguishable from an unknown token) and AGAIN on
  // the LOCKED row (local audit P1: a concurrent revision can change or
  // remove the basis while this request waits — stored metadata must come
  // from the locked row, never the pre-lock read).
  basisFor = () => null,
} = {}) {
  const token = String(estimateToken || '').trim();
  if (!token) {
    const err = new Error('Estimate not found');
    err.status = 404;
    throw err;
  }

  const reasonKeys = normalizeReasons(reasons);
  const cleanNote = cleanText(note, 500);
  // A challenge with neither a chip nor a note carries nothing the office
  // can act on — reject rather than park an empty request.
  if (!reasonKeys.length && !cleanNote) {
    const err = new Error('Tell us what looks off so we can re-check it.');
    err.status = 400;
    throw err;
  }

  const estimate = await database('estimates').where({ token }).first();
  // All three gates, all 404 (indistinguishable): the full customer-
  // viewability contract; this flow's own accepted/declined exclusion (a
  // customer who accepted the price challenges through the office, not the
  // sheet — viewability alone still renders accepted estimates); and the
  // lawn-basis requirement (no lawn line, no lawn challenge).
  if (!estimate || !viewabilityCheck(estimate) || !isMeasurementReviewEligible(estimate) || !basisFor(estimate)) {
    const err = new Error('Estimate not found');
    err.status = 404;
    throw err;
  }

  // Serialize per-estimate (codex #3376 P1): two concurrent first-time POSTs
  // for an estimate with no linked customer would BOTH reach the attach-or-
  // create resolver and mint duplicate customer profiles before either
  // insert hits the dedupe index. A row lock on the estimate makes the
  // second request wait, see the first's customer_id backfill, and dedupe
  // normally. Falls back to unserialized on databases without transaction
  // support (unit-test mocks) — the route always passes real knex.
  const runSerialized = typeof database.transaction === 'function'
    ? (fn) => database.transaction(async (trx) => {
      await trx('estimates').where({ id: estimate.id }).forUpdate().first();
      const locked = await trx('estimates').where({ id: estimate.id }).first();
      return fn(trx, locked || estimate);
    })
    : (fn) => fn(database, estimate);
  // Unserialized fallback: no lock exists, so the pre-lock basis is the best
  // available — used only by unit-test mocks; the route always passes knex.


  const serialized = typeof database.transaction === 'function';
  const outcome = await runSerialized(async (dbx, lockedEstimate) => {
    // Re-validate EVERYTHING on the LOCKED row (local audit P1s): a
    // concurrent accept/decline/archive/expiry/linkage-invalidation — or a
    // revision that changes/removes the lawn basis — can commit while this
    // request waited on the lock. Status checks and the basis both re-derive
    // from the locked row; the stored metadata is the locked basis, never
    // the pre-lock read.
    const lockedBasis = basisFor(lockedEstimate);
    if (!viewabilityCheck(lockedEstimate) || !isMeasurementReviewEligible(lockedEstimate) || !lockedBasis) {
      const err = new Error('Estimate not found');
      err.status = 404;
      throw err;
    }
    // Call-side verdict on the LOCKED row, through the trx connection
    // (local audit P0) — fail closed before any customer/request write.
    if (await callSideBlockedFor(dbx, lockedEstimate)) {
      const err = new Error('Estimate not found');
      err.status = 404;
      throw err;
    }
    return createReviewRow({
      database: dbx,
      estimate: lockedEstimate,
      reasonKeys,
      cleanNote,
      shownSqFt: lockedBasis.sqft,
      shownSource: lockedBasis.source,
      serialized,
    });
  });

  // Office notification AFTER the transaction commits (local audit P1):
  // inside the trx a later commit failure would leave a notification
  // pointing at a rolled-back request, and notifyAdmin's own DB/network
  // round-trips would hold the estimate row lock for their duration.
  if (outcome && outcome.notify) {
    await sendOfficeNotification(outcome.notify);
    delete outcome.notify;
  }
  return outcome;
}

// notifyAdmin swallows persistence errors and resolves null/suppressed
// rather than rejecting, and this is the flow's ONLY handoff — retry once,
// then log LOUDLY; the request row stands either way (extension-route
// pattern).
async function sendOfficeNotification({ subject, description, customerId, estimateId, requestId }) {
  const attempt = () => NotificationService.notifyAdmin(
    'estimate_measurement_review',
    subject,
    description,
    {
      // Deep-link to the Customer 360 PANEL (codex #3376: the standalone
      // requests page is gone; note the ?customerId=<id> panel form).
      link: `/admin/customers?customerId=${customerId}`,
      metadata: { estimateId, requestId, customerId },
    }
  ).catch((err) => {
    logger.error(`[estimate-measurement-review] admin notification threw for request ${requestId}: ${err.message}`);
    return null;
  });
  const first = await attempt();
  // suppressed:true is POLICY (internal/demo accounts must not ring the
  // bell), not an outage — terminal success, no retry, no loud error
  // (codex #3376 final head P3).
  if (first?.suppressed) {
    logger.info(`[estimate-measurement-review] admin notification suppressed by policy for request ${requestId}`);
    return;
  }
  if (first?.id) return;
  const second = await attempt();
  if (second?.suppressed || second?.id) return;
  logger.error(`[estimate-measurement-review] admin notification FAILED TWICE for request ${requestId} — request row stands, office unnotified; surface via the requests panel sweep`);
}

async function createReviewRow({ database, estimate, reasonKeys, cleanNote, shownSqFt, shownSource, serialized = false }) {
  // Pre-insert dedupe. Under the serialized path this runs while HOLDING the
  // estimate row lock, so it is authoritative — and it must be, because on
  // Postgres a 23505 unique violation ABORTS the surrounding transaction and
  // any follow-up query in the catch would 500 (local audit P1). The catch
  // below only services the unserialized (mock/test) path.
  const existingOpen = await database('service_requests')
    .where({ estimate_id: estimate.id, requested_service: MEASUREMENT_REVIEW_SERVICE_KEY })
    .whereNotIn(database.raw("COALESCE(status, 'new')"), OPEN_REQUEST_TERMINAL_STATUSES)
    .first();
  if (existingOpen) return { success: true, deduped: true };

  const customer = await resolveEstimateCustomer(database, estimate, {
    // Attribution reflects the actual entry point, not the add-service flow
    // this resolver was born in (codex #3376).
    sourceDetail: 'estimate_measurement_review',
  });

  const estimateNumber = estimate.estimate_number || estimate.id;
  const reasonLabels = reasonKeys.map((k) => MEASUREMENT_REVIEW_REASONS[k]);
  const shown = Number(shownSqFt);
  const shownLine = Number.isFinite(shown) && shown > 0
    ? `Estimate showed ${Math.round(shown).toLocaleString()} sq ft${shownSource ? ` (${cleanText(shownSource, 80)})` : ''}.`
    : null;

  const subject = `Re-measure lawn for estimate #${estimateNumber}`;
  const description = [
    `Customer says the treatable lawn area looks off on estimate ${estimateNumber}.`,
    reasonLabels.length ? `Reasons: ${reasonLabels.join('; ')}.` : null,
    shownLine,
    cleanNote ? `Customer note: ${cleanNote}` : null,
    'Re-measure and send a revised estimate; the sent estimate stays valid until then.',
  ].filter(Boolean).join(' ');

  let request;
  try {
    [request] = await database('service_requests').insert({
      customer_id: customer.id,
      estimate_id: estimate.id,
      requested_service: MEASUREMENT_REVIEW_SERVICE_KEY,
      source: SOURCE_PUBLIC_ESTIMATE,
      category: 'measurement_review',
      subject,
      description,
      urgency: 'routine',
      status: 'new',
      pricing_revision: JSON.stringify({
        type: 'lawn_area_review',
        reasons: reasonKeys,
        note: cleanNote || null,
        shownSqFt: Number.isFinite(shown) && shown > 0 ? Math.round(shown) : null,
        shownSource: cleanText(shownSource, 80) || null,
      }),
    }).returning('*');
  } catch (err) {
    // Partial unique index on open (estimate_id, requested_service): a second
    // open challenge on the same estimate is the same ask — return the
    // existing one instead of erroring the sheet.
    if (err.code === '23505') {
      // Serialized path: the row lock made the pre-check authoritative, and
      // the aborted transaction cannot run another query — rethrow and let
      // the transaction roll back (this indicates a bug, not a normal race).
      if (serialized) throw err;
      const dupe = await database('service_requests')
        .where({ estimate_id: estimate.id, requested_service: MEASUREMENT_REVIEW_SERVICE_KEY })
        .whereNotIn(database.raw("COALESCE(status, 'new')"), OPEN_REQUEST_TERMINAL_STATUSES)
        .first();
      if (dupe) return { success: true, deduped: true };
    }
    throw err;
  }

  logger.info(`[estimate-measurement-review] request ${request.id} for estimate ${estimate.id} (${reasonKeys.join(',') || 'note-only'})`);

  // Notification payload only — the SEND happens after the transaction
  // commits (local audit P1: an in-trx send can point at a rolled-back
  // request and holds the estimate row lock through network round-trips).
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

module.exports = {
  MEASUREMENT_REVIEW_SERVICE_KEY,
  MEASUREMENT_REVIEW_REASONS,
  normalizeReasons,
  isMeasurementReviewEligible,
  createEstimateMeasurementReview,
};
