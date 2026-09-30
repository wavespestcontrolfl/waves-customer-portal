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
// fire time. Older-prompt decisions are untouched.
async function amountsBlock({ decision, outgoingBody }) {
  const realAnswers = typeof decision.prompt_version === 'string' && decision.prompt_version.startsWith('house_voice_v12');
  if (!realAnswers || !decision.customer_id) return null;
  const { outgoingAmountsStale } = require('./sms-amount-recheck');
  const amounts = await outgoingAmountsStale({ customerId: decision.customer_id, body: outgoingBody, promptVersion: decision.prompt_version });
  return amounts.stale ? `amount no longer authorized (${amounts.reason})` : null;
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
    decisionMeta: { promptVersion: decision.prompt_version, draftId: snapshot?.draft_id || null, intendedActions: Array.isArray(snapshot?.intended_actions) ? snapshot.intended_actions : null },
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
    || (await amountsBlock({ decision, outgoingBody }))
    || (await reserviceBlock({ decision, outgoingBody }));
}

/**
 * Whether a decision's snapshot carries the re-service link action — recorded onto a scheduled row's
 * metadata at queue time (admin-communications /schedule-sms) so the scheduled-send recheck does not
 * depend on re-reading the decision to learn it.
 */
function decisionCarriesReserviceLink(decision) {
  const { reserviceCarriesLinkAction } = require('./sms-shadow-drafter');
  const snapshot = parseInputSnapshot(decision && decision.input_snapshot);
  return reserviceCarriesLinkAction(snapshot && snapshot.intended_actions);
}

/**
 * The scheduled-send form of the re-service recheck (scheduler.js): the same verdict as
 * agentDecisionSendBlockReason's re-service leg, for a queued reply whose decision row still has to be
 * read. A plain non-promise message is never blocked by the recheck's own plumbing (pre-push audit P1,
 * PR #5336), and a decision that carries the link action is never let through unchecked because the
 * read failed (round 15). A failure to read the row or to run the check blocks when the body reads as
 * a promise, when the decision is known to carry the action (`carriesAction`, from the scheduled row's
 * own metadata, else the row just read), or — for a decision whose action state is unknown — when the
 * body could plausibly be about a free return visit (reserviceBodyPrescreen); otherwise it sends.
 * Returns a short reason, or null.
 */
async function scheduledReserviceBlockReason({ agentDecisionId, outgoingBody, fallbackCustomerId = null, carriesAction = false, dbh = require('../models/db') }) {
  const { isReserviceOfferPromise, reserviceCarriesLinkAction, reserviceBodyPrescreen } = require('./sms-shadow-drafter');
  const logger = require('./logger');
  let known = carriesAction === true;
  try {
    const row = await dbh('agent_decisions').where({ id: agentDecisionId }).first('input_snapshot', 'customer_id', 'prompt_version');
    // Codex round-16 (PR #5336): a missing row (first() → undefined) is NOT a pre-deploy decision to
    // grandfather — nothing is known about it, so it takes the same fail-closed path as a failed read.
    if (!row) throw new Error('agent decision row not found');
    const snapshot = parseInputSnapshot(row.input_snapshot);
    known = known || reserviceCarriesLinkAction(snapshot && snapshot.intended_actions);
    return await reserviceBlock({ decision: { ...row, customer_id: row.customer_id || fallbackCustomerId }, outgoingBody });
  } catch (err) {
    const block = known || isReserviceOfferPromise(outgoingBody) || (!carriesAction && reserviceBodyPrescreen(outgoingBody));
    logger.warn(`[agent-decision-send-checks] re-service recheck failed for decision ${agentDecisionId}: ${err.message}${block ? '; blocking send' : '; not a re-service message, sending'}`);
    return block ? 'reservice_recheck_failed' : null;
  }
}

module.exports = { agentDecisionSendBlockReason, scheduledReserviceBlockReason, decisionCarriesReserviceLink, parseInputSnapshot };
