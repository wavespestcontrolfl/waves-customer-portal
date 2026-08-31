/**
 * Closeout alerts — the ONE mapping from closeout-status facts to operator
 * alert items, shared by every surface that shows "this completed visit is
 * not closed out":
 *   - services/dashboard-alerts.js  → `closeout_gaps_today` action item (the
 *     feed the dashboard banner + admin bell actually read)
 *   - routes/admin-command-center.js → per-visit issue cards on the
 *     jobs-needing-attention section (admin_alerts lifecycle keys on the
 *     three legacy alert types, kept byte-identical)
 *
 * Also owns the per-visit memo: getCloseoutStatus is ~20-28 indexed probes,
 * and the bell polls every 30s / the dashboard every 3 min. Fully-read
 * results are memoised 90s; a full OR partial outage (found:false, or
 * found:true with `unavailable` probes) is never memoised so the next
 * refresh retries. Memo holds ids/states/reasons only — no PII.
 *
 * READ-ONLY. No writes, no comms.
 */
const { getCloseoutStatus } = require('./closeout-status');

// One status fans out probe groups of up to ~10 concurrent queries; 2 keeps
// a full sweep's worst case at ~20 in-flight queries so a dashboard poll
// can't saturate the shared knex pool (pre-push r14 P1).
const CLOSEOUT_CONCURRENCY = 2;
const CLOSEOUT_MEMO_TTL_MS = 90 * 1000;
// Partial/failed reads memo too, briefly — a partial outage must not re-pay
// the full probe fan-out on every poll tick, but must recover fast.
const CLOSEOUT_MEMO_ERROR_TTL_MS = 20 * 1000;
const CLOSEOUT_MEMO_MAX = 500;
const memo = new Map();

// The three legacy alert types (admin_alerts lifecycle rows key on them) plus
// a DISTINCT key for the delivery stage: a dismissed missing-report card must
// never mask a later delivery failure on the same visit (admin-alerts dedupes
// on type + source identity and preserves dismissed status on merge).
const CLOSEOUT_ALERT_TYPES = Object.freeze({
  completion: 'completion_not_committed',
  report: 'missing_required_service_report',
  reportDelivery: 'report_delivery_incomplete',
  application: 'missing_required_material_log',
  photos: 'missing_required_photos',
});
const CLOSEOUT_ALERT_LABELS = Object.freeze({
  completion_not_committed: 'Completion not committed',
  missing_required_service_report: 'Missing required service report',
  report_delivery_incomplete: 'Report delivery incomplete',
  missing_required_material_log: 'Missing required material log',
  missing_required_photos: 'Missing required photos',
});
// Report-delivery reasons that are in flight or held BY DESIGN — not an
// operator gap (the queue / payment hold / send window owns them).
const TRANSIENT_DELIVERY_REASONS = new Set([
  'awaiting_completion', 'report_not_published', 'delivery_queued', 'delivery_sending',
  'project_delivery_sending', 'project_report_on_hold', 'recap_sms_in_flight',
]);

// The five MAPPED facts are readable — probes outside them (billing,
// follow-up, license context) failing must not mark the visit unreadable
// and hold the alert floor forever (pre-push r14 P1). A failed probe that
// feeds a mapped fact surfaces there as state 'unknown'.
function factsFullyKnown(status) {
  if (!status || !status.found) return false;
  const facts = status.facts || {};
  return Object.keys(CLOSEOUT_ALERT_TYPES)
    .every((k) => facts[k]?.state !== 'unknown');
}

async function memoisedCloseoutStatus(serviceId, now) {
  const hit = memo.get(serviceId);
  if (hit && now - hit.at < (hit.fullyRead ? CLOSEOUT_MEMO_TTL_MS : CLOSEOUT_MEMO_ERROR_TTL_MS)) return hit.value;
  const value = await getCloseoutStatus(serviceId).catch(() => null);
  const fullyRead = factsFullyKnown(value);
  if (memo.size >= CLOSEOUT_MEMO_MAX) memo.delete(memo.keys().next().value);
  memo.set(serviceId, { at: now, value, fullyRead });
  return value;
}

/**
 * Load closeout statuses for many visits with bounded concurrency + memo.
 * Returns Map<serviceId, status|null> (null = the load itself failed).
 */
async function loadCloseoutStatuses(serviceIds, { now = Date.now() } = {}) {
  const out = new Map();
  const ids = [...new Set((serviceIds || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += CLOSEOUT_CONCURRENCY) {
    const slice = ids.slice(i, i + CLOSEOUT_CONCURRENCY);
    const loaded = await Promise.all(slice.map((id) => memoisedCloseoutStatus(id, now)));
    slice.forEach((id, j) => out.set(id, loaded[j]));
  }
  return out;
}

// Open = required and unmet. `awaiting_completion` and in-flight sends are
// transient, not gaps; `unknown` is an outage and never an alert.
function openFact(f) {
  return Boolean(f)
    && (f.state === 'pending' || f.state === 'failed')
    && !['awaiting_completion', 'recap_sms_in_flight'].includes(f.reason);
}

/**
 * Pure: closeout status → alert issues for one visit. Each issue:
 *   { type, fact, reason, summary, requiredPhotoCount?, actualPhotoCount? }
 * An unavailable/not-found status yields [] — never fabricate a gap.
 */
function closeoutIssuesForVisit(status) {
  if (!status || !status.found) return [];
  const facts = status.facts || {};
  const issues = [];

  // A completion that never committed (no record / terminal failed attempt)
  // or is STUCK RESUMABLE (stale claim needing an operator re-POST) is ONE
  // issue — the downstream facts are unknowable until the completion lands.
  // Running states are transient and stay silent.
  const completionReason = facts.completion?.reason || '';
  const completionStuck = facts.completion?.state === 'failed'
    || completionReason === 'completed_visit_without_record'
    || completionReason === 'completion_resumable'
    || completionReason === 'completion_side_effects_resumable'
    // The tech marked the visit incomplete: the row is 'completed' but the
    // work is not — an operator must reschedule or follow up.
    || completionReason === 'record_marked_incomplete';
  if (completionStuck) {
    // Own lifecycle key: a dismissed stuck-completion card must not hide a
    // later missing-report card once the completion lands.
    const summary = completionReason === 'record_marked_incomplete'
      ? 'Technician marked this visit incomplete — reschedule or follow up.'
      : completionReason.includes('resumable')
        ? 'Completion is stuck mid-commit — re-open the completion to resume its side effects.'
        : 'Completed job has no completion record — closeout never committed.';
    return [{ type: CLOSEOUT_ALERT_TYPES.completion, fact: 'completion', reason: completionReason, summary }];
  }

  if (openFact(facts.report)) {
    issues.push({
      type: CLOSEOUT_ALERT_TYPES.report,
      fact: 'report',
      reason: facts.report.reason,
      summary: 'Completed job is missing the required closeout report.',
    });
  }
  // The report artifact and its DELIVERY are separate facts with separate
  // lifecycle keys: a published report whose delivery failed, or was never
  // enqueued / never sent, is an operator gap; in-flight or held-by-design
  // deliveries stay silent.
  const delivery = facts.reportDelivery;
  const deliveryOpen = Boolean(delivery)
    && (delivery.state === 'failed' || delivery.state === 'pending')
    && !TRANSIENT_DELIVERY_REASONS.has(delivery.reason);
  if (deliveryOpen) {
    const deliverySummary = delivery.reason === 'delivery_skipped_no_recipient'
      ? 'Service report could not be sent — no report recipient on file; add an email for this customer.'
      : delivery.state === 'failed'
        ? 'Service report was published but its delivery failed after retries.'
        : 'Service report was published but was never delivered to the customer.';
    issues.push({ type: CLOSEOUT_ALERT_TYPES.reportDelivery, fact: 'reportDelivery', reason: delivery.reason, summary: deliverySummary });
  }
  if (openFact(facts.application)) {
    issues.push({
      type: CLOSEOUT_ALERT_TYPES.application,
      fact: 'application',
      reason: facts.application.reason,
      summary: facts.application.reason === 'all_application_rows_retracted'
        ? 'Every application row on this job was retracted — the required material log is empty.'
        : 'Completed job is missing the required chemical or material application record.',
    });
  }
  if (openFact(facts.photos)) {
    const requiredPhotoCount = Number(facts.photos.required || 0);
    const actualPhotoCount = Number(facts.photos.actual || 0);
    issues.push({
      type: CLOSEOUT_ALERT_TYPES.photos,
      fact: 'photos',
      reason: facts.photos.reason,
      requiredPhotoCount,
      actualPhotoCount,
      summary: `Completed job has ${actualPhotoCount} of ${requiredPhotoCount} required closeout photo${requiredPhotoCount === 1 ? '' : 's'}.`,
    });
  }
  return issues;
}

module.exports = {
  loadCloseoutStatuses,
  closeoutIssuesForVisit,
  factsFullyKnown,
  CLOSEOUT_ALERT_TYPES,
  CLOSEOUT_ALERT_LABELS,
  CLOSEOUT_CONCURRENCY,
  __private: { memo, openFact },
};
