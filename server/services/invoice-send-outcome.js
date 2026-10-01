/**
 * How a first-delivery invoice send came out — the ONE classifier shared by
 * every Invoices send path (/:id/send, /batch/send, create + send, the
 * keyed-retry batch) and the Intelligence Bar closeout repair's
 * send_invoice step, so no caller carries a second, drifting reading of the
 * same business outcomes. Moved verbatim from routes/admin-invoices.js.
 */

// A FIRST delivery finding either of these codes reports a no-op success
// instead of a conflict (round-6 P1 #4131) — shared by every first-delivery
// send path below (create + immediate send, the batch keyed-retry send,
// /batch/send, and /:id/send).
const FIRST_DELIVERY_NOOP_CODES = new Set(['already_delivered', 'queued_pay_link', 'delivery_in_progress']);

// One classifier shared by every first-delivery/held-outcome site (the
// batch create's own send, the batch keyed-retry, /batch/send per-invoice,
// and /:id/send) — Codex round-1 P2 (PR #4633): the no-op/held shape was
// hand-built at each of the four call sites. A stale-claim review hold is
// ALWAYS held, regardless of firstDeliveryOnly — none of these callers
// ever sets overridesReviewHold, so a parked row refuses no matter what
// the row's own stamps look like. An already_delivered/queued_pay_link
// code is a no-op success ONLY for a genuine first delivery — the same
// code on an explicit Resend is a real conflict the caller must still
// treat as a failure (returns null).
function firstDeliveryOutcome(err, firstDeliveryOnly) {
  if (err?.code === 'stale_claim_review_hold') {
    return {
      type: 'held',
      code: 'stale_claim_review_hold',
      reason: 'Invoice is parked under a stale-claim review hold (delivery unverified) — not sent; use Resend to confirm and clear it',
    };
  }
  // Pre-push audit P1 (#4131 slice 4): a thrown deposit_settlement_pending
  // (the claim-path race re-check) reports the SAME retryable refusal the
  // RESOLVED chokepoint outcome already does — without this branch the
  // thrown form fell through to the generic failure handling below (a 500
  // on /:id/send) for the SAME underlying condition. NOT gated on
  // firstDeliveryOnly: an explicit Resend can hit this exact race too.
  // Unlike zero_due below, this branch stays live even though no current
  // caller still THROWS this code (Codex round-5 audit #4131 slice 4) —
  // resolvedSendOutcome forwards a RESOLVED deposit_settlement_pending
  // refusal through this exact branch too (see below).
  if (err?.code === 'deposit_settlement_pending') {
    return {
      type: 'held',
      code: 'deposit_settlement_pending',
      reason: err.message,
    };
  }
  // Codex round-6 audit P1 (#4131 slice 4): a terminal-visit zero-due
  // invoice the void sweep safety-refused to touch (a live PaymentIntent,
  // money in flight, an unverifiable Stripe lookup) is distinct from a
  // COMPLETED void (INVOICE_VISIT_TERMINAL, a genuine no-op success below)
  // — this one is un-voided and must surface as held for an operator, not
  // silently reported handled. Reachable only as a RESOLVED result (see
  // resolvedSendOutcome) — zeroDueDirectSendOutcome/zeroDueWrapperOutcome
  // never throw it.
  if (err?.code === 'INVOICE_VISIT_TERMINAL_UNVOIDED') {
    return {
      type: 'held',
      code: 'INVOICE_VISIT_TERMINAL_UNVOIDED',
      reason: err.message,
    };
  }
  // Codex round-9 audit P2 (#4131 slice 4): the COMPLETED terminal-visit
  // void (INVOICE_VISIT_TERMINAL — the sweep DID void it, distinct from
  // the un-voided refusal just above) is a genuine no-op success:
  // zeroDueDirectSendOutcome/zeroDueWrapperOutcome's own comment calls it
  // exactly that. Before this branch nothing here recognized this code at
  // all, so a resolved result fell through every check below (never
  // matching the held/noop/409 branches) straight into the callers'
  // generic-failure handling — /batch/send counted a completed void as a
  // batch failure and /:id/send returned a bare 400, even though the
  // sweep had already committed and nothing was left for the operator to
  // fix. Not gated on firstDeliveryOnly — the void already committed
  // regardless of whether this call was a first delivery or a resend.
  if (err?.code === 'INVOICE_VISIT_TERMINAL') {
    return {
      type: 'noop',
      code: 'INVOICE_VISIT_TERMINAL',
      voided: true,
    };
  }
  // Codex round-7 audit P1 (#4131 slice 4): the single _zeroDueRetried
  // retry exhausted (the balance changed again while resolving the send)
  // — genuinely retryable, held for review the same as
  // deposit_settlement_pending, never reported as a plain failure.
  if (err?.code === 'balance_changed_retry') {
    return {
      type: 'held',
      code: 'balance_changed_retry',
      reason: err.message,
    };
  }
  // NOTE: a thrown zero_due used to be recognized here too (a settlement
  // that ran INSIDE claimInvoiceForSend's own claim, reported as a noop
  // success). Codex round-5 audit #4131 slice 4 confirmed it dead: since
  // the chokepoint rework, zero-due settlement is never thrown as a
  // success sentinel — sendViaSMS/sendViaSMSAndEmail always RESOLVE it
  // (ok: true, settled_zero_due: true), and a resolved ok:true result
  // never reaches this classifier at all (resolvedSendOutcome below only
  // forwards a !ok result). Removed along with its mock-only test.
  if (firstDeliveryOnly && FIRST_DELIVERY_NOOP_CODES.has(err?.code)) {
    return {
      type: 'noop',
      code: err.code,
      already_delivered: err.code === 'already_delivered',
      queued_delivery: err.code === 'queued_pay_link',
      // Pre-push audit P1 (PR #4633): a concurrent first-delivery claim
      // already won this exact race — the customer's pay link is on its
      // way, just not from this request. A no-op success, never a failure.
      in_progress: err.code === 'delivery_in_progress',
    };
  }
  return null;
}

// A RESOLVED sendViaSMS/sendViaSMSAndEmail result and a THROWN claim-path
// error report the exact same business refusals in two different shapes —
// deposit_settlement_pending's resolved form (settleZeroDueBeforeSend's
// chokepoint resolving a settlement refusal, #4131 slice 4 round-5) used to
// fall through EVERY caller's generic failure handling instead of the held
// treatment its thrown form already got (converged onto the 409 in
// firstDeliveryOutcome above). Normalizing a resolved !ok result into the
// same {code, message} shape firstDeliveryOutcome already reads routes
// BOTH forms through that ONE classifier — never a second, drifting copy
// of the same business rule. firstDeliveryOnly is irrelevant here (the
// codes this recognizes are never gated on it), so it is always false.
function resolvedSendOutcome(result) {
  if (!result || result.ok) return null;
  // Direct sendViaSMS shapes carry their explanation as `reason`; the wrapper's
  // as `error`. Read both so the held reason survives into the batch response.
  return firstDeliveryOutcome({ code: result.code, message: result.error ?? result.reason }, false);
}

module.exports = { FIRST_DELIVERY_NOOP_CODES, firstDeliveryOutcome, resolvedSendOutcome };
