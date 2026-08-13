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
  shownSqFt,
  shownSource,
  database = db,
  viewabilityCheck = defaultViewabilityCheck,
  // Whether the estimate actually carries a priced lawn basis — computed by
  // the route from the SAME helpers that render the area line (codex #3376:
  // a pest-only estimate must not accept a lawn challenge; 404 keeps it
  // indistinguishable from an unknown token). Defaults true only for direct
  // service callers/tests; the route always passes the real verdict.
  lawnBasisPresent = true,
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
  if (!estimate || !viewabilityCheck(estimate) || !isMeasurementReviewEligible(estimate) || !lawnBasisPresent) {
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

  const serialized = typeof database.transaction === 'function';
  return runSerialized(async (dbx, lockedEstimate) => createReviewRow({
    database: dbx,
    estimate: lockedEstimate,
    reasonKeys,
    cleanNote,
    shownSqFt,
    shownSource,
    serialized,
  }));
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

  // Office-only notification — never the customer.
  await NotificationService.notifyAdmin(
    'estimate_measurement_review',
    subject,
    description,
    {
      // Deep-link to the Customer 360 PANEL (codex #3376: the standalone
      // requests page is gone — requests are worked from the notification
      // deep-link; note the ?customerId=<id> panel form, NOT /customers/<id>).
      link: `/admin/customers?customerId=${customer.id}`,
      metadata: { estimateId: estimate.id, requestId: request.id, customerId: customer.id },
    }
  ).catch((err) => {
    logger.error(`[estimate-measurement-review] admin notification failed for request ${request.id}: ${err.message} — request row stands`);
  });

  return { success: true, deduped: false };
}

module.exports = {
  MEASUREMENT_REVIEW_SERVICE_KEY,
  MEASUREMENT_REVIEW_REASONS,
  normalizeReasons,
  isMeasurementReviewEligible,
  createEstimateMeasurementReview,
};
