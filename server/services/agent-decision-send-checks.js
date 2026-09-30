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
    ...(snapshot.lookup?.scheduledServiceId ? { scheduledServiceId: snapshot.lookup.scheduledServiceId } : {}),
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

// LIVE ETA (independent review + Codex round-1 finding, PR #5334): a
// minutes-away/ETA claim is a draft-time GPS snapshot that can sit in the
// composer for hours — revalidate it against the SAME two conditions the
// scheduler's queued-send path and the auto-send executor check (see
// sms-eta-freshness.js): the visit is still customer-facing en_route AND
// the draft's facts are still fresh. Fails closed on any missing evidence.
async function etaBlockReason({ decision, outgoingBody }) {
  const snapshot = parseInputSnapshot(decision.input_snapshot);
  const { etaClaimBlockReason } = require('./sms-eta-freshness');
  return etaClaimBlockReason({
    liveEtaSnapshot: snapshot?.live_eta_snapshot || null,
    factsGeneratedAt: snapshot?.facts_generated_at || null,
    outgoingBody,
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
async function scheduledEtaBlockReason({ decisionId, outgoingBody, skip = false }) {
  if (skip) return null; // an earlier revalidation already blocked this send
  try {
    const db = require('../models/db');
    const decision = await db('agent_decisions').where({ id: decisionId }).first('input_snapshot');
    return await etaBlockReason({ decision: decision || {}, outgoingBody });
  } catch (err) {
    require('./logger').warn(`[agent-decision-send-checks] LIVE ETA revalidation failed for decision ${decisionId}: ${err.message}; blocking send`);
    return 'eta_recheck_failed';
  }
}

/**
 * Returns null when the body may go out, else a short reason string the
 * caller logs before superseding the decision.
 */
async function agentDecisionSendBlockReason({ decision, outgoingBody }) {
  return (await openTimesBlock({ decision, outgoingBody }))
    || followupBlock({ decision, outgoingBody })
    || (await amountsBlock({ decision, outgoingBody }))
    || (await etaBlock({ decision, outgoingBody }));
}

module.exports = { agentDecisionSendBlockReason, parseInputSnapshot, scheduledEtaBlockReason };
