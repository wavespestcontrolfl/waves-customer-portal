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

const CLOSEOUT_CONCURRENCY = 4;
const CLOSEOUT_MEMO_TTL_MS = 90 * 1000;
const CLOSEOUT_MEMO_MAX = 500;
const memo = new Map();

// The three legacy alert types (admin_alerts lifecycle rows key on them) plus
// a DISTINCT key for the delivery stage: a dismissed missing-report card must
// never mask a later delivery failure on the same visit (admin-alerts dedupes
// on type + source identity and preserves dismissed status on merge).
const CLOSEOUT_ALERT_TYPES = Object.freeze({
  report: 'missing_required_service_report',
  reportDelivery: 'report_delivery_incomplete',
  application: 'missing_required_material_log',
  photos: 'missing_required_photos',
});
const CLOSEOUT_ALERT_LABELS = Object.freeze({
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

async function memoisedCloseoutStatus(serviceId, now) {
  const hit = memo.get(serviceId);
  if (hit && now - hit.at < CLOSEOUT_MEMO_TTL_MS) return hit.value;
  const value = await getCloseoutStatus(serviceId).catch(() => null);
  const fullyRead = Boolean(value && value.found && !(value.unavailable && value.unavailable.length));
  if (fullyRead) {
    if (memo.size >= CLOSEOUT_MEMO_MAX) memo.delete(memo.keys().next().value);
    memo.set(serviceId, { at: now, value });
  }
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
    || completionReason === 'completion_side_effects_resumable';
  if (completionStuck) {
    return [{
      type: CLOSEOUT_ALERT_TYPES.report,
      fact: 'completion',
      reason: completionReason,
      summary: completionReason.includes('resumable')
        ? 'Completion is stuck mid-commit — re-open the completion to resume its side effects.'
        : 'Completed job has no completion record — closeout never committed.',
    }];
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
    issues.push({
      type: CLOSEOUT_ALERT_TYPES.reportDelivery,
      fact: 'reportDelivery',
      reason: delivery.reason,
      summary: delivery.state === 'failed'
        ? 'Service report was published but its delivery failed after retries.'
        : 'Service report was published but was never delivered to the customer.',
    });
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
  CLOSEOUT_ALERT_TYPES,
  CLOSEOUT_ALERT_LABELS,
  CLOSEOUT_CONCURRENCY,
  __private: { memo, openFact },
};
