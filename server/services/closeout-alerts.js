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
const gates = require('../config/feature-gates');

// GATE_CLOSEOUT_MONEY_COMMS_ALERTS — the comms / invoice / invoiceDelivery
// facts become per-visit alert issues (and hold the readability floor).
// OFF (default, dev AND prod): the five legacy facts only — byte-identical
// to the pre-gate mapping. Read at CALL time (the techTips idiom) so a flip
// needs no redeploy; fails closed when feature-gates is mocked partially.
function moneyCommsAlertsEnabled() {
  return typeof gates.gateEnvValue === 'function' && gates.gateEnvValue('GATE_CLOSEOUT_MONEY_COMMS_ALERTS') === true;
}

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
  // Not a fact: requirements.unevaluated (GH codex r3 P2). The signature
  // requirement has NO evidence store in the schema, so this card can never
  // auto-clear — the operator verifies on paper and dismisses it (the
  // admin_alerts lifecycle persists the dismissal per visit:type identity).
  signature: 'customer_signature_unverified',
  // Not a fact either: canonical contradictions (GH codex r4 P2) —
  // summarizeCloseout keeps closedOut false on them even when every mapped
  // fact reads done/not_required. Issues carry an `identity` including the
  // code so a NEW contradiction on an already-dismissed visit re-surfaces.
  contradiction: 'closeout_contradiction',
  // Money + comms facts (GATE_CLOSEOUT_MONEY_COMMS_ALERTS): each gets its
  // own lifecycle key so a dismissed report card never masks a failed
  // completion notice or an unminted invoice on the same visit.
  comms: 'completion_notice_failed',
  invoice: 'invoice_not_minted',
  invoiceDelivery: 'invoice_delivery_incomplete',
});
const CLOSEOUT_ALERT_LABELS = Object.freeze({
  completion_not_committed: 'Completion not committed',
  missing_required_service_report: 'Missing required service report',
  report_delivery_incomplete: 'Report delivery incomplete',
  missing_required_material_log: 'Missing required material log',
  missing_required_photos: 'Missing required photos',
  customer_signature_unverified: 'Customer signature unverified',
  closeout_contradiction: 'Closeout records contradict',
  completion_notice_failed: 'Completion notice failed',
  invoice_not_minted: 'Invoice owed but not minted',
  invoice_delivery_incomplete: 'Invoice or receipt delivery incomplete',
});
// Operator copy for the canonical contradiction codes closeout-status
// emits today; unknown future codes fall back to a humanized code so a new
// contradiction never maps to silence.
const CONTRADICTION_SUMMARIES = Object.freeze({
  invoice_on_covered_visit: 'An invoice exists on a visit the billing lane predicts as covered — verify the charge before it bills.',
  invoice_on_non_performed_visit: 'An invoice exists but the visit outcome says nothing was performed — verify before it bills.',
  applications_on_non_performed_visit: 'Application rows were logged but the visit outcome says nothing was performed.',
  record_without_completed_visit: 'A completion record exists but the visit is not marked completed.',
});
// The five closeout FACTS the mapper reads (signature is a requirement, not
// a fact — it has no state and never counts toward readability).
const MAPPED_FACT_KEYS = Object.freeze(['completion', 'report', 'reportDelivery', 'application', 'photos']);
// Readability covers every fact whose inputs can PRODUCE an issue: the five
// mapped facts plus `invoice`, because the invoice/billing inputs also feed
// the invoice_* contradictions (pre-push r18 P1) — with facts.invoice
// 'unknown' those contradictions are silently absent, so treating the read
// as complete would let an outage clear a contradiction alert and the cron
// re-fire it on recovery. followUp/license never hold the floor: they
// produce no issues here (r14). comms/invoiceDelivery join the set ONLY
// while the money+comms gate is on — that is when their outage would hide
// an issue this mapper emits (the gate's one semantic change to holding).
const ISSUE_INPUT_FACT_KEYS = Object.freeze([...MAPPED_FACT_KEYS, 'invoice']);
const MONEY_COMMS_INPUT_FACT_KEYS = Object.freeze([...ISSUE_INPUT_FACT_KEYS, 'comms', 'invoiceDelivery']);
function issueInputFactKeys() {
  return moneyCommsAlertsEnabled() ? MONEY_COMMS_INPUT_FACT_KEYS : ISSUE_INPUT_FACT_KEYS;
}
// Invoice reasons an operator can act on HERE: a frozen required mint that
// never minted, and the expected-<lane>-not-minted family. The two parked
// manual cases (parked_manual_refunded_invoice / _canceled_setup_fee) are
// NOT mapped: /complete already parks a fail-closed, deduped
// terminal_invoice_manual_billing bell notification for them
// (admin-dispatch.js) — a second card here would be a parallel alert path
// with its own dismissal state (GH r3 P1). The invoice fact never emits
// `failed`; awaiting_completion is transient; `unknown` = outage.
const ACTIONABLE_INVOICE_PENDING = (reason) => reason === 'frozen_required_mint_not_minted'
  || /^expected_.+_not_minted$/.test(reason || '');
// Invoice-delivery pending reasons an operator owns: a paid invoice whose
// receipt was never enqueued, and a payer-billed invoice never sent. The
// queue-owned states (receipt_<jobStatus>), the send-window hold,
// no_invoice_yet (the invoice fact's issue, not this one) and
// invoice_draft_unsent (the stale-drafts alert owns that population at
// three days) stay silent; opt-out reads not_required upstream.
const ACTIONABLE_INVOICE_DELIVERY_PENDING = new Set(['paid_receipt_not_sent', 'payer_invoice_unsent']);
// The receipt failures closeout-status emits today, allowlisted so a future
// failed reason never maps to a card whose copy does not describe it.
// NOT completion_sms_failed: that fact reads the shared completion-SMS
// status and cannot tell whether the body carried a pay link (the
// report-only choice, includePayLink === false, shares the stamp — GH r1
// P2), so the comms card owns that failure; resending the notice resends
// the link when one belongs.
const ACTIONABLE_INVOICE_DELIVERY_FAILED = new Set(['receipt_no_recipient', 'receipt_delivery_exhausted']);
// comms emits exactly one failed reason (the provider rejected the
// completion SMS); the card copy is written for it.
const ACTIONABLE_COMMS_FAILED = new Set(['completion_sms_failed']);
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
  return issueInputFactKeys().every((k) => facts[k]?.state !== 'unknown');
}

async function memoisedCloseoutStatus(serviceId, now, fresh = false) {
  const hit = fresh ? null : memo.get(serviceId);
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
 * `fresh: true` bypasses the memo READ (write-sensitive snapshots —
 * dismissals, the state-persisting cron — must not act on a stale count or
 * membership; pre-push r20 P1); the fresh result still refreshes the memo.
 */
async function loadCloseoutStatuses(serviceIds, { now = Date.now(), fresh = false } = {}) {
  const out = new Map();
  const ids = [...new Set((serviceIds || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += CLOSEOUT_CONCURRENCY) {
    const slice = ids.slice(i, i + CLOSEOUT_CONCURRENCY);
    const loaded = await Promise.all(slice.map((id) => memoisedCloseoutStatus(id, now, fresh)));
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
  if (moneyCommsAlertsEnabled()) issues.push(...moneyCommsIssues(facts));
  // Unevaluated requirement (GH codex r3 P2): a catalog service with
  // requires_customer_signature keeps summary.closedOut false even when every
  // fact is done — closeout-status lists it as requirements.unevaluated
  // because no signature evidence store exists. Surface it so the visit is
  // not presented as fully closed out; the operator verifies and dismisses.
  if ((status.requirements?.unevaluated || []).includes('requiresCustomerSignature')) {
    issues.push({
      type: CLOSEOUT_ALERT_TYPES.signature,
      fact: 'requirements',
      reason: 'requires_customer_signature_unevaluated',
      summary: 'This service requires a customer signature, which the portal cannot verify — confirm it was captured, then dismiss.',
    });
  }
  // Canonical contradictions (GH codex r4 P2): every code is an operator
  // issue — records disagree, so the visit must not present as clean. One
  // issue per code; `identity` distinguishes codes inside the shared type so
  // dashboard dismissal membership re-surfaces on a NEW contradiction.
  for (const c of (status.contradictions || [])) {
    if (!c?.code) continue;
    issues.push({
      type: CLOSEOUT_ALERT_TYPES.contradiction,
      fact: 'contradictions',
      reason: c.code,
      identity: `${CLOSEOUT_ALERT_TYPES.contradiction}:${c.code}`,
      summary: CONTRADICTION_SUMMARIES[c.code]
        || `Closeout records contradict each other (${String(c.code).replace(/_/g, ' ')}).`,
    });
  }
  return issues;
}

// Money + comms issues (GATE_CLOSEOUT_MONEY_COMMS_ALERTS). Only what an
// operator must act on: a completion notice the provider rejected, an
// invoice that is owed but was never minted (or is parked for a manual
// bill), and an invoice / receipt that failed to deliver or was never
// sent. Quiet-hours deferral, sending, recap in flight, queue-owned
// receipt states, consent blocks and every not_required rule stay silent
// (owner rulings already encoded in closeout-status). `unknown` never
// alerts — it holds the floor through factsFullyKnown instead.
function moneyCommsIssues(facts) {
  const issues = [];
  const comms = facts.comms;
  if (comms?.state === 'failed' && ACTIONABLE_COMMS_FAILED.has(comms.reason)) {
    issues.push({
      type: CLOSEOUT_ALERT_TYPES.comms,
      fact: 'comms',
      reason: comms.reason,
      // No completion-notice resend endpoint exists and Dispatch will not
      // reopen a committed completion (GH r3 P2) — point at the manual
      // messaging flow the office already uses.
      summary: 'Completion notice to the customer failed to send — send it manually from Communications.',
    });
  }
  const invoice = facts.invoice;
  if (invoice?.state === 'pending' && ACTIONABLE_INVOICE_PENDING(invoice.reason)) {
    const summary = 'This visit owes an invoice that was never minted — create it before the customer is billed elsewhere.';
    // Reason-qualified identity (GH r1 P1): a dismissed expected-not-minted
    // card must not swallow a later parked-manual exception on the same
    // visit — same idiom as the contradiction issues.
    issues.push({
      type: CLOSEOUT_ALERT_TYPES.invoice,
      fact: 'invoice',
      reason: invoice.reason,
      identity: `${CLOSEOUT_ALERT_TYPES.invoice}:${invoice.reason}`,
      summary,
    });
  }
  const delivery = facts.invoiceDelivery;
  const deliveryOpen = Boolean(delivery)
    && ((delivery.state === 'failed' && ACTIONABLE_INVOICE_DELIVERY_FAILED.has(delivery.reason))
      || (delivery.state === 'pending' && ACTIONABLE_INVOICE_DELIVERY_PENDING.has(delivery.reason)));
  if (deliveryOpen) {
    const summary = delivery.reason === 'receipt_no_recipient'
      // Adding a recipient does not retry the completed receipt job (GH
      // r2 P2) — the operator resends from the invoice afterwards.
      ? 'Payment receipt could not be sent — no receipt recipient on file; add an email or mobile for this customer, then resend the receipt from the invoice.'
      : delivery.reason === 'receipt_delivery_exhausted'
        ? 'Payment receipt delivery failed after retries.'
        : delivery.reason === 'paid_receipt_not_sent'
          ? 'Invoice is paid but no receipt was ever sent.'
          : 'Payer-billed invoice was never sent to the payer.';
    // Reason-qualified identity (GH r2 P2): a dismissed paid-but-no-receipt
    // card must not swallow a later exhausted delivery on the same invoice.
    issues.push({
      type: CLOSEOUT_ALERT_TYPES.invoiceDelivery,
      fact: 'invoiceDelivery',
      reason: delivery.reason,
      identity: `${CLOSEOUT_ALERT_TYPES.invoiceDelivery}:${delivery.reason}`,
      summary,
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
  __private: { memo, openFact, moneyCommsIssues },
};
