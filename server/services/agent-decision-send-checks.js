'use strict';
// The revalidations an Agent Review decision must pass at the moment it is
// actually sent (PR #5119 follow-up #6): one place, one verdict, shared by
// the immediate /sms send and the queue-time /schedule-sms verification.
// The route (verifyAgentDecisionForSend) keeps ownership and thread
// staleness and orchestrates; everything below is a pure "may this body go
// out?" question over the decision row and the outgoing text.
//
// Each check refuses rather than rewrites: the reviewer approved specific
// wording, and a fact that moved needs a fresh look, not a silent edit.

function parseInputSnapshot(inputSnapshot) {
  if (!inputSnapshot) return null;
  try {
    return typeof inputSnapshot === 'string' ? JSON.parse(inputSnapshot) : inputSnapshot;
  } catch {
    return null;
  }
}

// The customer's own inbound wording for this decision (independent-review
// P1, round 6, PR #5331) — the thing a confirmation's claimed tender/date
// must be checked against. `decision.inbound_message` is the linked
// sms_log row's body (verifyAgentDecisionForSend's own select, joined at
// query time); input_snapshot's `sms.body` is the same text stashed at
// draft time and covers a decision the caller selected without that join.
function resolveInboundMessage(decision) {
  if (typeof decision?.inbound_message === 'string' && decision.inbound_message) return decision.inbound_message;
  const fromSnapshot = parseInputSnapshot(decision?.input_snapshot)?.sms?.body;
  return typeof fromSnapshot === 'string' ? fromSnapshot : null;
}

// OPEN TIMES: a draft that offered appointment times persists the exact
// (date, window) pairs; a reviewer-edited body is matched to them pair by
// pair, an unverifiable edit refuses, and surviving pairs are rechecked
// against live availability with the same service identity the draft used.
async function openTimesBlock({ decision, outgoingBody }) {
  const snapshot = parseInputSnapshot(decision.input_snapshot)?.open_times_snapshot || null;
  if (!snapshot?.quotedWindows?.length) return null;
  const { openTimesStillOffered, planOpenTimesRecheck } = require('./sms-shadow-drafter');
  const plan = planOpenTimesRecheck({ snapshot, outgoingBody, originalBody: decision.suggested_message });
  if (plan.action === 'refuse') return `open-times unverifiable after edit (${plan.reason})`;
  if (plan.action !== 'recheck') return null;
  const recheck = await openTimesStillOffered({
    city: snapshot.lookup?.city || null,
    customerId: snapshot.lookup?.customerId || null,
    estimateId: snapshot.lookup?.estimateId || null,
    ...(snapshot.lookup?.serviceType ? { serviceType: snapshot.lookup.serviceType } : {}),
    ...(snapshot.lookup?.scheduledServiceId ? { scheduledServiceId: snapshot.lookup.scheduledServiceId } : {}),
    // Which picker minted the offer, and what it needs to be asked again
    // (GATE_SMS_OFFERS_SCHEDULER): absent on a legacy snapshot.
    ...(snapshot.lookup?.source ? { source: snapshot.lookup.source } : {}),
    ...(snapshot.lookup?.serviceKey ? { serviceKey: snapshot.lookup.serviceKey } : {}),
    quotedWindows: plan.quotedWindows,
  });
  return recheck.ok ? null : `open-times stale (${recheck.reason})`;
}

// FOLLOW-UP PROMISE: an escalated real-answers draft's timing phrase must
// still match the current ET window, and an edit may not turn it into
// timing copy the phrase list does not know.
function followupBlock({ decision, outgoingBody }) {
  const { followupPromiseBlockReason, slaDraftedAt } = require('./sms-followup-sla');
  const reason = followupPromiseBlockReason({
    inputSnapshot: decision.input_snapshot,
    promptVersion: decision.prompt_version,
    originalBody: decision.suggested_message,
    body: outgoingBody,
    // Codex #5194 P2: the drafter's own facts-generated instant when the
    // decision carries one, else the row's created_at (slaDraftedAt).
    draftedAt: slaDraftedAt(decision),
  });
  return reason ? `follow-up promise unsendable (${reason})` : null;
}

// AMOUNTS: a real-answers card may carry exact billing figures and can wait
// through a payment; re-read billing now, same check the scheduler runs at
// fire time. Older-prompt decisions are untouched for the AMOUNT half.
//
// Independent-review P1 (round 6, PR #5331): the Zelle recipient-plus-
// invoice-eligibility half must NOT stay gated behind `realAnswers &&
// customer_id` the way the amount half is — ZELLE_RECIPIENT is a live env
// var and the invoice it was drafted against can settle or start a saved-
// card charge at any time, whatever prompt version drafted the body. The
// scheduler's own fire-time path (scheduler.js) already reruns
// outgoingAmountsStale — which runs this same Zelle check first, ahead of
// its own amount rules — for EVERY agent-decision-linked scheduled reply,
// human-edited or not, regardless of prompt version; this immediate-send
// seam now matches it. A body with an affirmative Zelle offer but no
// customer_id on the decision can never be checked against a real invoice —
// fail CLOSED (refuse) rather than let an unverifiable Zelle offer out.
async function amountsBlock({ decision, outgoingBody }) {
  const realAnswers = typeof decision.prompt_version === 'string' && decision.prompt_version.startsWith('house_voice_v12');
  const { outgoingAmountsStale, hasAffirmativeZelleMention, bodyNeedsPaymentRecheck, bodyMakesPaymentClaim } = require('./sms-amount-recheck');
  const hasZelleOffer = hasAffirmativeZelleMention(outgoingBody);
  // Codex round-23 P2: the SAME gate the scheduler's fire-time seam uses (bodyNeedsPaymentRecheck: an amount, an
  // affirmative Zelle offer, a payment-status claim, price grammar — AND a negative Zelle availability claim),
  // so an edited pre-v12 body carrying a Zelle DENIAL is rechecked too. v12 decisions always run the recheck.
  const needsRecheck = realAnswers || bodyNeedsPaymentRecheck(outgoingBody);
  if (!needsRecheck) return null;
  if (!decision.customer_id) {
    // Codex round-28 P2: with no customer to re-read billing for, ANY body the recheck gate selects (an amount, a
    // Zelle offer or DENIAL, a payment-status claim, price grammar) cannot be verified — fail closed, not just Zelle offers.
    // PRECISE classifier (round 29): the broad prescreen would block benign copy like "Your invoice is attached"
    return (hasZelleOffer || bodyMakesPaymentClaim(outgoingBody, { inboundMessage: resolveInboundMessage(decision) })) ? 'amount no longer authorized (amount_recheck_no_customer)' : null;
  }
  // Pre-push audit P1 (finding 2): the invoice the drafter's Zelle fact was
  // built for, so a body carrying a Zelle contact is rechecked against that
  // SAME invoice's CURRENT eligibility, not just its recipient.
  const zelleInvoiceId = parseInputSnapshot(decision.input_snapshot)?.zelle_invoice_id || null;
  const amounts = await outgoingAmountsStale({
    customerId: decision.customer_id,
    body: outgoingBody,
    promptVersion: decision.prompt_version,
    zelleInvoiceId,
    inboundMessage: resolveInboundMessage(decision),
    // A pre-v12 decision reaches here ONLY for its Zelle offer (above): its
    // amount rules stay untouched (trustOwedAmounts on the pooled rule is a
    // no-op after the Zelle check, same as the scheduler's human-authored path).
    trustOwedAmounts: !realAnswers,
  });
  return amounts.stale ? `amount no longer authorized (${amounts.reason})` : null;
}

/**
 * Returns null when the body may go out, else a short reason string the
 * caller logs before superseding the decision.
 */
async function agentDecisionSendBlockReason({ decision, outgoingBody }) {
  return (await openTimesBlock({ decision, outgoingBody }))
    || followupBlock({ decision, outgoingBody })
    || (await amountsBlock({ decision, outgoingBody }));
}

module.exports = { agentDecisionSendBlockReason, parseInputSnapshot };
