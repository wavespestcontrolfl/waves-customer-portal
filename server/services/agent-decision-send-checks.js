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

// Real-answers drafts (prompt family house_voice_v12*) are the ones whose facts
// carry billing amounts and LABEL FACTS; older drafts are left as they were.
const isRealAnswersDecision = (decision) => typeof decision.prompt_version === 'string' && decision.prompt_version.startsWith('house_voice_v12');
// Owner ruling 2026-10-01: a STAFF EDIT is the staff member's own wording, so the payment-status contract does not judge it. Edited =
// the outgoing body differs (whitespace-normalized) from the AI draft stored on the decision. No stored draft => the body is treated as
// the AI's: STRICT. Auto-send never carries an edit and never passes this.
const normalizeBody = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
function bodyIsStaffEdited(storedDraft, outgoingBody) {
  const stored = normalizeBody(storedDraft);
  return !!stored && normalizeBody(outgoingBody) !== stored;
}

// The customer's own inbound wording for this decision - what scopes the
// payment-status detector and names the invoice a Zelle offer is about.
// `decision.inbound_message` is the linked
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

// AMOUNTS + PAYMENT STATUS: a real-answers card may carry exact billing figures and payment-status sentences and can wait
// through a payment; re-read billing now, same check the scheduler runs at fire time. Older-prompt decisions are untouched for
// both halves.
//
// PAYMENT STATUS (owner ruling 2026-10-01): the FINAL body of every real-answers decision may state a payment / invoice / refund /
// balance status only by copying, verbatim, a sentence its payment_status_snapshot recorded - and each copied sentence must still
// be one the records render now. An edited sentence, a status typed in, or a status on a decision that copied none is held.
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
  const realAnswers = isRealAnswersDecision(decision);
  const { outgoingAmountsStale, hasAffirmativeZelleMention, hasNegativeZelleAvailabilityClaim, bodyNeedsPaymentRecheck } = require('./sms-amount-recheck');
  // Codex round-23 P2: a Zelle OFFER or DENIAL is rechecked for every decision (an edited pre-v12 body too); v12 decisions always
  // run the whole recheck.
  const zelleClaim = hasAffirmativeZelleMention(outgoingBody) || hasNegativeZelleAvailabilityClaim(outgoingBody);
  if (!realAnswers && !zelleClaim) return null;
  // A staff edit's free-text status is theirs: it neither needs the contract's reads nor can the contract fail it. Zelle and amount rules stay.
  const staffEdited = realAnswers && bodyIsStaffEdited(decision.suggested_message, outgoingBody);
  if (!decision.customer_id) {
    // With no customer to re-read billing for, ANY body the recheck would judge (an amount, a Zelle claim, a payment-status
    // assertion, price grammar) cannot be verified - fail closed. Benign copy ("Your invoice is attached") needs no billing.
    return (zelleClaim || bodyNeedsPaymentRecheck(outgoingBody, { inboundMessage: resolveInboundMessage(decision), promptVersion: decision.prompt_version, statusVocabulary: !staffEdited })) ? 'amount no longer authorized (amount_recheck_no_customer)' : null;
  }
  // Pre-push audit P1 (finding 2): the invoice the drafter's Zelle fact was
  // built for, so a body carrying a Zelle contact is rechecked against that
  // SAME invoice's CURRENT eligibility, not just its recipient.
  const snapshot = parseInputSnapshot(decision.input_snapshot);
  const amounts = await outgoingAmountsStale({
    customerId: decision.customer_id,
    body: outgoingBody,
    promptVersion: decision.prompt_version,
    zelleInvoiceId: snapshot?.zelle_invoice_id || null,
    inboundMessage: resolveInboundMessage(decision),
    paymentStatusSnapshot: snapshot?.payment_status_snapshot || null,
    humanEditedBody: staffEdited,
    // A pre-v12 decision reaches here ONLY for its Zelle claim (above): its amount rules stay untouched.
    trustOwedAmounts: !realAnswers,
  });
  // the invoice a Zelle offer was checked against: the provider-boundary check inspects its live PaymentIntent (Codex round-50 P1)
  if (!amounts.stale) {
    decision.zelle_boundary_invoice_id = amounts.zelleInvoiceId || null;
    decision.zelle_boundary_denial = amounts.zelleDenial || null;
  }
  return amounts.stale ? `amount no longer authorized (${amounts.reason})` : null;
}

// LABEL FACTS: the reply guard runs on the FINAL body of every real-answers
// decision, whatever the reviewer did to it (an edited label sentence, a time
// typed in, and a body on a decision that copied no sentence all read the same
// way: label timing is allowed only as a verbatim sentence from the decision's
// own snapshot). A draft that copied a sentence also persists which visit it
// came from; that timing must still be the customer's current latest performed
// visit (a newer visit, a visit today or a changed label refuses). Older-prompt
// decisions without a snapshot are untouched.
async function labelFactsBlockReason({ decision, outgoingBody, dbh }) {
  const input = parseInputSnapshot(decision.input_snapshot);
  const snapshot = input?.label_facts_snapshot || null;
  if (!snapshot && !isRealAnswersDecision(decision)) return null;
  // The customer's own text (stored on the decision) says which label kind was asked, so a bare "yes" /
  // "it's okay" is held even when the draft copied no sentence; without it only answer-shaped bodies are held.
  return require('./sms-label-facts').labelFactsSendBlockReason({ snapshot, body: outgoingBody, inbound: input?.sms?.body, ...(dbh ? { conn: dbh } : {}) });
}
async function labelFactsBlock({ decision, outgoingBody }) {
  const reason = await labelFactsBlockReason({ decision, outgoingBody });
  return reason ? `label timing no longer current (${reason})` : null;
}

// The scheduled-send version of the same check: the scheduler reads the decision row itself, and a row it cannot read (missing,
// or not yet visible) must never mean "no snapshot, so send" - the reply guard cannot run without the decision, so it refuses.
async function scheduledLabelFactsBlock({ decision, outgoingBody }) {
  if (!decision) return 'label timing could not be checked (the agent decision was not found)';
  return labelFactsBlock({ decision, outgoingBody });
}

// LIVE ETA (independent review + Codex round-1 finding, PR #5334): a
// minutes-away/ETA claim is a draft-time GPS snapshot that can sit in the
// composer for hours — revalidate it against the SAME two conditions the
// scheduler's queued-send path and the auto-send executor check (see
// sms-eta-freshness.js): the visit is still customer-facing en_route AND
// the draft's facts are still fresh. Fails closed on any missing evidence.
// ONE consult point for "the recheck could not READ the state" (Codex round-42 P2): the set
// lives in sms-eta-freshness (both its own 'eta_claim_recheck_failed' and this module's
// 'eta_recheck_failed'). Lazy require: that module and this one reference each other's
// callers, and tests replace it wholesale.
function isEtaInfrastructureFailure(reason) {
  return require('./sms-eta-freshness').isEtaInfrastructureFailure(reason);
}
// Does an agentDecisionSendBlockReason string ('live ETA unsendable (<reason>)') carry an
// infrastructure failure rather than a verdict about the message?
function blockReasonIsEtaInfrastructure(blockReason) {
  const m = /^live ETA unsendable \(([a-z_]+)\)$/.exec(String(blockReason || ''));
  return Boolean(m) && isEtaInfrastructureFailure(m[1]);
}
// LABEL FACTS (Codex #5416 r31 P2): a label recheck that could not READ the latest visit says nothing about the message
// either - the attempt is refused, but the decision is not retired as stale.
const LABEL_RECHECK_INFRASTRUCTURE_REASONS = new Set(['label_facts_recheck_failed']);
const isLabelRecheckInfrastructureFailure = (reason) => LABEL_RECHECK_INFRASTRUCTURE_REASONS.has(reason);
function blockReasonIsLabelInfrastructure(blockReason) {
  const m = /^label timing no longer current \(([a-z_]+)\)$/.exec(String(blockReason || ''));
  return Boolean(m) && isLabelRecheckInfrastructureFailure(m[1]);
}
/** Any send-time recheck that could not read its state (live ETA or label facts): refuse, keep the decision retryable. */
const blockReasonIsRecheckInfrastructure = (blockReason) => blockReasonIsEtaInfrastructure(blockReason) || blockReasonIsLabelInfrastructure(blockReason);

async function etaBlockReason({ decision, outgoingBody, dbh }) {
  const snapshot = parseInputSnapshot(decision.input_snapshot);
  const { etaClaimBlockReason } = require('./sms-eta-freshness');
  return etaClaimBlockReason({
    liveEtaSnapshot: snapshot?.live_eta_snapshot || null,
    factsGeneratedAt: snapshot?.facts_generated_at || null,
    // The draft's technician first name(s), persisted independently of live entries
    // (round-42 P2); absent on older decisions, which keep the entries-only behavior.
    techNames: Array.isArray(snapshot?.tech_names) ? snapshot.tech_names : [],
    // The persisted prompt version decides whether status wording needs a LIVE STATUS fact, so a
    // v12 decision stays strict across a gate rollback (round-45 P2).
    promptVersion: decision.prompt_version ?? null,
    outgoingBody,
    // The provider-boundary predicates pass the handoff's own connection (Codex #5334 P1); undefined = the root pool.
    dbh,
  });
}

async function etaBlock({ decision, outgoingBody }) {
  const reason = await etaBlockReason({ decision, outgoingBody });
  return reason ? `live ETA unsendable (${reason})` : null;
}

// The scheduler's queued-send path (Codex round-10 P2, PR #5334): the same
// check the immediate send runs, reading the claimed decision row itself so
// scheduler.js carries one flat call instead of a nested parse block. Fails
// CLOSED on any read/parse/recheck error — 'eta_recheck_failed'.
async function scheduledEtaBlockReason({ decisionId, outgoingBody, skip = false, dbh }) {
  if (skip) return null; // an earlier revalidation already blocked this send
  try {
    const conn = dbh || require('../models/db');
    const decision = await conn('agent_decisions').where({ id: decisionId }).first('input_snapshot', 'prompt_version');
    return await etaBlockReason({ decision: decision || {}, outgoingBody, dbh });
  } catch (err) {
    require('./logger').warn(`[agent-decision-send-checks] LIVE ETA revalidation failed for decision ${decisionId}: ${err.message}; blocking send`);
    return 'eta_recheck_failed';
  }
}

// The same ETA revalidation as a PROVIDER-BOUNDARY predicate (Codex round-40 P2):
// twilio.js runs a registered `providerPreSendCheck` after every other await (the
// executor's recipient lookup, the pipeline's policy work) immediately before its
// request, so a visit that changes state during those awaits still stops the send.
// The scheduler keeps its earlier scheduledEtaBlockReason (fail-fast, and it retires
// the decision with a customer-safe note); this closes the remaining window.
// Refusal is terminal (the visit is provably stale) except an unreadable recheck,
// which rides the bounded retry rail — never sent unverified.
//
// CONNECTION (Codex #5334 P1): twilio.js passes the handoff's own connection as `dbi` (the held
// transaction when a `withSmsHandoff` is in play). Every read here goes through it — a read through
// the root pool while the handoff holds a pool connection can wait on a connection that never frees
// (two concurrent sends with DB_POOL_MAX=2) and sees a different snapshot than the handoff.
function etaProviderPreSendCheck({ decisionId, getBody }) {
  const check = async ({ dbi } = {}) => {
    const outgoingBody = typeof getBody === 'function' ? getBody() : getBody;
    const reason = await scheduledEtaBlockReason({ decisionId, outgoingBody, dbh: dbi });
    if (reason == null) return { ok: true };
    const retryable = isEtaInfrastructureFailure(reason);
    return {
      ok: false,
      code: retryable ? 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY' : 'LIVE_ETA_STALE_AT_BOUNDARY',
      reason: `live ETA unsendable (${reason})`,
      ...(retryable ? { retryable: true } : {}),
    };
  };
  return markRepeatable(check);
}

// BILLING FACTS at the TRUE provider boundary (Codex round-48 P1): the immediate Agent Review send rechecks amounts, payment status
// and Zelle in verifyAgentDraftDecision, then the route still awaits link / claim / consent / policy steps - a customer paying in that
// gap could make an approved "Your account balance is $100.00" false before it reaches Twilio. Codex round-49 P1: repeating the full
// recheck there needs a second pool connection while the handoff holds one, so the route takes the customer's billing FINGERPRINT
// before the full recheck (billingFingerprintForSend) and the boundary re-reads it in one query on the handoff connection: any change
// refuses as retryable (the retry reruns the full recheck). Registered only for a body the recheck judges.
// A staff edit's own status wording is not judged by the contract (owner ruling 2026-10-01) - nor by the boundary (local review P2).
const billingBoundaryJudged = (decision, body) => {
  const realAnswers = typeof decision?.prompt_version === 'string' && decision.prompt_version.startsWith('house_voice_v12');
  const staffEdited = realAnswers && bodyIsStaffEdited(decision?.suggested_message, body);
  return require('./sms-amount-recheck').bodyNeedsBillingBoundaryCheck(body, {
    inboundMessage: resolveInboundMessage(decision), promptVersion: decision?.prompt_version, statusVocabulary: !staffEdited,
  });
};
async function billingFingerprintForSend({ decision, outgoingBody }) {
  if (!decision?.customer_id || !billingBoundaryJudged(decision, String(outgoingBody || ''))) return undefined;
  return require('./billing-fingerprint').billingFingerprint(decision.customer_id);
}
function amountsProviderPreSendCheck({ decision, getBody }) {
  if (!decision?.id) return undefined;
  const body = String((typeof getBody === 'function' ? getBody() : getBody) || '');
  if (!billingBoundaryJudged(decision, body)) return undefined;
  return require('./billing-fingerprint').billingUnchangedProviderPreSendCheck({
    customerId: decision.customer_id, fingerprint: decision.billing_fingerprint ?? null,
    zelleInvoiceId: decision.zelle_boundary_invoice_id ?? null, zelleDenial: decision.zelle_boundary_denial ?? null, getBody,
  });
}

// Snapshot-carrying variant for a caller that already holds the decision's live-ETA
// snapshot in memory (the auto-send executor's claim): same check, same verdicts, no
// extra row read.
function etaSnapshotProviderPreSendCheck({ liveEtaSnapshot, factsGeneratedAt, techNames = [], promptVersion = null, getBody }) {
  const check = async ({ dbi } = {}) => {
    const { etaClaimBlockReason } = require('./sms-eta-freshness');
    const outgoingBody = typeof getBody === 'function' ? getBody() : getBody;
    let reason;
    try {
      reason = await etaClaimBlockReason({ liveEtaSnapshot, factsGeneratedAt, techNames, promptVersion, outgoingBody, dbh: dbi });
    } catch (err) {
      require('./logger').warn(`[agent-decision-send-checks] LIVE ETA boundary recheck failed: ${err.message}; blocking send`);
      reason = 'eta_recheck_failed';
    }
    if (reason == null) return { ok: true };
    const retryable = isEtaInfrastructureFailure(reason);
    return {
      ok: false,
      code: retryable ? 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY' : 'LIVE_ETA_STALE_AT_BOUNDARY',
      reason: `live ETA unsendable (${reason})`,
      ...(retryable ? { retryable: true } : {}),
    };
  };
  return markRepeatable(check);
}

// LABEL FACTS at the TRUE provider boundary (Codex #5416 P1, after #5334's boundary predicates landed): the
// send-time label recheck runs before the handoff, policy and recipient awaits, so a newer visit completed
// during them could still let the previous visit's timing reach the provider. The same recheck re-reads the
// customer's latest performed visit through the handoff's connection (`dbi`) immediately before the request.
// A recheck that could not READ the visit rides the bounded retry rail; every other refusal is terminal.
function labelFactsBoundaryVerdict(reason) {
  if (reason == null) return { ok: true };
  const retryable = isLabelRecheckInfrastructureFailure(reason);
  return {
    ok: false,
    code: retryable ? 'LABEL_FACTS_CHECK_FAILED_AT_BOUNDARY' : 'LABEL_FACTS_STALE_AT_BOUNDARY',
    reason: `label timing no longer current (${reason})`,
    ...(retryable ? { retryable: true } : {}),
  };
}
function labelFactsProviderPreSendCheck({ decisionId, getBody }) {
  const check = async ({ dbi } = {}) => {
    const outgoingBody = typeof getBody === 'function' ? getBody() : getBody;
    let reason;
    try {
      const conn = dbi || require('../models/db');
      const decision = await conn('agent_decisions').where({ id: decisionId }).first('input_snapshot', 'prompt_version');
      // a decision row that cannot be read never means "no snapshot, so send"
      reason = decision ? await labelFactsBlockReason({ decision, outgoingBody, dbh: dbi }) : 'label_facts_decision_not_found';
    } catch (err) {
      require('./logger').warn(`[agent-decision-send-checks] LABEL FACTS boundary recheck failed for decision ${decisionId}: ${err.message}; blocking send`);
      reason = 'label_facts_recheck_failed';
    }
    return labelFactsBoundaryVerdict(reason);
  };
  return markRepeatable(check);
}
// Snapshot-carrying variant for the auto-send executor's claim (no row read): the same rule the executor's
// own recheck applies - every real-answers draft runs the reply guard, an older-prompt draft only with a snapshot.
function labelFactsSnapshotProviderPreSendCheck({ labelFactsSnapshot = null, inboundMessage = null, promptVersion = null, getBody }) {
  if (!labelFactsSnapshot && !(typeof promptVersion === 'string' && promptVersion.startsWith('house_voice_v12'))) return undefined;
  const check = async ({ dbi } = {}) => {
    const outgoingBody = typeof getBody === 'function' ? getBody() : getBody;
    let reason;
    try {
      reason = await require('./sms-label-facts').labelFactsSendBlockReason({ snapshot: labelFactsSnapshot, body: outgoingBody, inbound: inboundMessage, ...(dbi ? { conn: dbi } : {}) });
    } catch (err) {
      require('./logger').warn(`[agent-decision-send-checks] LABEL FACTS boundary recheck failed: ${err.message}; blocking send`);
      reason = 'label_facts_recheck_failed';
    }
    return labelFactsBoundaryVerdict(reason);
  };
  return markRepeatable(check);
}

// A predicate that is a pure, idempotent state read declares itself safe to run AGAIN after
// the sender's durable attempt marker (twilio.js re-runs `afterMarker` right before the SDK
// request and undoes the marker on refusal, Codex round-43 P2). Non-flagged predicates keep
// their documented once-only contract.
function markRepeatable(check) {
  check.afterMarker = check;
  return check;
}

// Run several provider-boundary predicates in order; the first refusal wins.
// undefined entries are skipped; returns undefined when there is nothing to run.
function composeProviderPreSendChecks(...checks) {
  const active = checks.filter((c) => typeof c === 'function');
  if (!active.length) return undefined;
  if (active.length === 1) return active[0];
  const run = (list) => async (ctx) => {
    for (const check of list) {
      const verdict = await check(ctx);
      if (!verdict || verdict.ok !== true) return verdict;
    }
    return { ok: true };
  };
  const composed = run(active);
  // Only the repeatable components re-run after the marker; the others are not re-invoked.
  const repeatable = active.filter((c) => typeof c.afterMarker === 'function').map((c) => c.afterMarker);
  if (repeatable.length) composed.afterMarker = run(repeatable);
  return composed;
}

// RE-SERVICE PROMISE (Codex round-3 P2): a reviewed card can promise a free
// re-service and then sit — in the composer, or in the scheduled-send
// window — long enough for the customer's eligibility to change (their
// plan cancelled, they already used the re-service through another
// channel) before it actually fires. Revalidates against LIVE eligibility
// via reservicePromiseStillEligible (reservice-scheduler.js, the same
// mechanism the composer's /reservice-link route uses), keyed on the
// lane(s) validateReserviceOffer resolved at DRAFT time (input_snapshot's
// reservice_lanes_snapshot) — never re-derived from the (possibly edited)
// outgoing body, and fails closed on no snapshot, no customer, or a lookup
// error.
async function reserviceBlock({ decision, outgoingBody }) {
  const { reservicePromiseStillEligible } = require('./sms-shadow-drafter');
  const snapshot = parseInputSnapshot(decision.input_snapshot);
  const reason = await reservicePromiseStillEligible({
    outgoingBody,
    customerId: decision.customer_id,
    promisedLanes: snapshot?.reservice_lanes_snapshot || null,
    // Codex round-9 (PR #5336): lets a PRE-DEPLOY decision (no snapshot, older
    // prompt version) be grandfathered onto live eligibility instead of being
    // rejected outright; new-version decisions missing a snapshot stay closed.
    decisionMeta: { promptVersion: decision.prompt_version, draftId: snapshot?.draft_id || null, intendedActions: Array.isArray(snapshot?.intended_actions) ? snapshot.intended_actions : null, bookedCallbacks: snapshot?.reservice_booked_snapshot || null,
      // Codex round-21 P2: a pre-deploy estimate-conversion decision has no draft_id; its inbound rides the snapshot (sms.body).
      inboundMessage: (snapshot?.sms && typeof snapshot.sms.body === 'string' ? snapshot.sms.body : null) },
  });
  return reason ? `re-service promise unsendable (${reason})` : null;
}

/**
 * Returns null when the body may go out, else a short reason string the
 * caller logs before superseding the decision.
 */
async function agentDecisionSendBlockReason({ decision, outgoingBody }) {
  return (await openTimesBlock({ decision, outgoingBody }))
    || followupBlock({ decision, outgoingBody })
    || (await labelFactsBlock({ decision, outgoingBody }))
    || (await amountsBlock({ decision, outgoingBody }))
    || (await reserviceBlock({ decision, outgoingBody }))
    || (await etaBlock({ decision, outgoingBody }));
}

/**
 * The scheduled-send form of the re-service recheck (scheduler.js): the same verdict as
 * agentDecisionSendBlockReason's re-service leg, for a queued reply whose decision row still has to be
 * read. FAIL CLOSED (round 19): a scheduled send backed by an agent decision whose row cannot be read
 * (a throw, or no row) BLOCKS whatever the body says. The only sends it lets through are a readable row
 * that does not carry the link action with a non-promise body. Returns a short reason, or null.
 */
async function scheduledReserviceBlockReason({ agentDecisionId, outgoingBody, fallbackCustomerId = null, dbh = require('../models/db') }) {
  const { reserviceCarriesLinkAction } = require('./sms-shadow-drafter');
  const logger = require('./logger');
  let known = false;
  try {
    const row = await dbh('agent_decisions').where({ id: agentDecisionId }).first('input_snapshot', 'customer_id', 'prompt_version');
    // Codex round-16/19 (PR #5336): a missing row is not a pre-deploy decision to grandfather — nothing is
    // known about it, so it takes the same fail-closed path as a failed read.
    if (!row) throw new Error('agent decision row not found');
    const snapshot = parseInputSnapshot(row.input_snapshot);
    known = known || reserviceCarriesLinkAction(snapshot && snapshot.intended_actions);
    return await reserviceBlock({ decision: { ...row, customer_id: row.customer_id || fallbackCustomerId }, outgoingBody });
  } catch (err) {
    // Codex round-19 P1: any agent-decision-backed scheduled send whose decision cannot be read BLOCKS,
    // whatever the body says — a body that evades both the promise detector and the prescreen must not
    // send just because a pre-deploy queued row carries no marker of the action. The only send
    // this recheck lets through is a READABLE row that does not carry the action with a non-promise body.
    logger.warn(`[agent-decision-send-checks] re-service recheck failed for decision ${agentDecisionId}: ${err.message}; blocking send${known ? ' (decision carries the re-service link action)' : ''}`);
    return 'reservice_recheck_failed';
  }
}

module.exports = { bodyIsStaffEdited, agentDecisionSendBlockReason, scheduledReserviceBlockReason, parseInputSnapshot, labelFactsBlock, scheduledLabelFactsBlock, scheduledEtaBlockReason, isEtaInfrastructureFailure, blockReasonIsEtaInfrastructure, etaProviderPreSendCheck, etaSnapshotProviderPreSendCheck, labelFactsProviderPreSendCheck, labelFactsSnapshotProviderPreSendCheck, amountsProviderPreSendCheck, billingFingerprintForSend, composeProviderPreSendChecks, markRepeatable, isLabelRecheckInfrastructureFailure, blockReasonIsLabelInfrastructure, blockReasonIsRecheckInfrastructure };
