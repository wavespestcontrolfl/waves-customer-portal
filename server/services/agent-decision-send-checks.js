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
// fire time. Older-prompt decisions are untouched.
async function amountsBlock({ decision, outgoingBody }) {
  if (!isRealAnswersDecision(decision) || !decision.customer_id) return null;
  const { outgoingAmountsStale } = require('./sms-amount-recheck');
  const amounts = await outgoingAmountsStale({ customerId: decision.customer_id, body: outgoingBody, promptVersion: decision.prompt_version });
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
// The open-loop recheck's unreadable read (PR #5499) is infrastructure too: the
// composer keeps the card for a retry instead of superseding it.
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
// OPEN LOOPS (PR #5499): an open-loop recheck that could not read its rows is infrastructure too.
const blockReasonIsOpenLoopsInfrastructure = (blockReason) => String(blockReason || '') === 'open-loop facts stale (open_loops_recheck_failed)';
/** Any send-time recheck that could not read its state (live ETA, label facts, open loops): refuse, keep the decision retryable. */
const blockReasonIsRecheckInfrastructure = (blockReason) => blockReasonIsEtaInfrastructure(blockReason)
  || blockReasonIsLabelInfrastructure(blockReason) || blockReasonIsOpenLoopsInfrastructure(blockReason);

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

// Open-loop commitments at the provider boundary, for a caller holding the ids in
// memory (the auto-send executor's claim). Closed → refused; an unreadable recheck
// → refused retryably (nothing is known to be stale). No ids → undefined (no check).
function openLoopsProviderPreSendCheck({ commitmentIds, customerId = null, status = null, factsGeneratedAt = null }) {
  const ids = Array.isArray(commitmentIds) ? commitmentIds.filter((id) => typeof id === 'string' && id) : [];
  if (!ids.length && !status) return undefined;
  const generatedIso = factsGeneratedAt instanceof Date && Number.isFinite(factsGeneratedAt.getTime()) ? factsGeneratedAt.toISOString() : factsGeneratedAt;
  const check = async ({ dbi } = {}) => {
    const snapshot = {
      visit_loop_commitment_ids: ids,
      ...(status ? { visit_loop_status: status } : {}),
      ...(generatedIso ? { facts_generated_at: generatedIso } : {}),
    };
    const reason = await openLoopsBlockReason({ decision: { input_snapshot: snapshot }, customerId, dbh: dbi });
    if (reason == null) return { ok: true };
    const retryable = reason === 'open_loops_recheck_failed';
    return {
      ok: false,
      code: retryable ? 'OPEN_LOOPS_CHECK_FAILED_AT_BOUNDARY' : 'OPEN_LOOPS_STALE_AT_BOUNDARY',
      reason: `open-loop facts stale (${reason})`,
      ...(retryable ? { retryable: true } : {}),
    };
  };
  return markRepeatable(check);
}

// The gratitude lane's fixed thank-you (PR #5499 audit): it sends after a quiet
// period, so a window can pass, a delay appear, or a promise be recorded
// while it waits. At the provider boundary the customer's facts are rebuilt (strict,
// commitments included); anything that must be answered refuses the courtesy
// reply. An unreadable rebuild refuses retryably. Gate-off: no check.
function gratitudeOpenLoopsProviderPreSendCheck({ customerId }) {
  if (!require('../config/feature-gates').gateEnvValue('GATE_SMS_REAL_ANSWERS') || !customerId) return undefined;
  const check = async ({ dbi } = {}) => {
    let fresh;
    try {
      fresh = await require('./visit-loops-facts').loadVisitLoops({ customerId, conn: dbi || require('../models/db'), strict: true, withCommitments: true });
    } catch (err) {
      require('./logger').warn(`[agent-decision-send-checks] gratitude open-loop recheck failed: ${err.message}; blocking send`);
      return { ok: false, code: 'OPEN_LOOPS_CHECK_FAILED_AT_BOUNDARY', reason: 'open-loop facts stale (open_loops_recheck_failed)', retryable: true };
    }
    return require('./sms-shadow-drafter').visitLoopsNeedAnswer({ visitLoops: fresh })
      ? { ok: false, code: 'OPEN_LOOPS_NEED_ANSWER_AT_BOUNDARY', reason: 'open-loop facts need an answer (gratitude refused)' }
      : { ok: true };
  };
  return markRepeatable(check);
}

// The decision-row form (reviewer composer send, scheduled replay): reads the
// decision through the handoff's connection, then the same verdicts. Like the
// LIVE ETA boundary form, a row that reads back absent carries nothing to recheck
// (the earlier send-time check already failed closed on it); a read error refuses
// retryably.
function openLoopsDecisionProviderPreSendCheck({ decisionId }) {
  const check = async ({ dbi } = {}) => {
    let reason;
    try {
      const conn = dbi || require('../models/db');
      const row = await conn('agent_decisions').where({ id: decisionId }).first('input_snapshot', 'customer_id');
      reason = await openLoopsBlockReason({ decision: row || {}, dbh: conn });
    } catch (err) {
      require('./logger').warn(`[agent-decision-send-checks] open-loop boundary recheck failed for decision ${decisionId}: ${err.message}; blocking send`);
      reason = 'open_loops_recheck_failed';
    }
    if (reason == null) return { ok: true };
    const retryable = reason === 'open_loops_recheck_failed';
    return {
      ok: false,
      code: retryable ? 'OPEN_LOOPS_CHECK_FAILED_AT_BOUNDARY' : 'OPEN_LOOPS_STALE_AT_BOUNDARY',
      reason: `open-loop facts stale (${reason})`,
      ...(retryable ? { retryable: true } : {}),
    };
  };
  return markRepeatable(check);
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

// OPEN LOOPS (PR #5499): a draft grounded on "WE OWE THEM" / "THEY ARE WAITING ON
// US FOR" lines can sit in review while that promise is fulfilled, dismissed,
// superseded by a call reprocess, or edited by staff. The draft persisted each
// rendered call_commitments row as "id:rev" (rev = visit-loops-facts
// commitmentRevision of what it restated); every one must still be open, live and
// unedited at send time.
// VISIT STATUS (visit_loop_status): a draft that showed a delay or a passed window
// has its facts rebuilt for the customer at send: any change to that
// signature (a reschedule, a completion, a resolved alert) refuses — one check for
// every such line, whatever wording the reply used.
// Fails closed on a read error. Returns null or a reason code.
// A commitment line's relative wording ("later today") means the ET day the facts
// were built: past that day the reply is refused rather than sent with a shifted
// meaning. No stamp = refused.
function commitmentDayChanged(snapshot, now) {
  const at = Date.parse(snapshot?.facts_generated_at || '');
  const { etDateString } = require('../utils/datetime-et');
  return !Number.isFinite(at) || etDateString(new Date(at)) !== etDateString(now);
}
// Each ref must still be in THIS customer's open list from the same canonical
// readers the facts came from: that one question covers closed, dismissed,
// superseded-by-reprocess (staleAiRowSql) and relinked-to-another-customer rows;
// the revision covers a staff edit to a row that stayed open.
async function commitmentsChanged(conn, refs, customerId) {
  if (!customerId) return true;
  const { commitmentRevision, allOpenCallCommitments, allSmsLane } = require('./visit-loops-facts');
  // each rendered SMS/email lane on its own page, as the facts loader reads them
  const [calls, promises, requests] = await Promise.all([
    allOpenCallCommitments(conn, { customerId }),
    allSmsLane(conn, { customerId, lane: 'promise' }),
    allSmsLane(conn, { customerId, lane: 'request' }),
  ]);
  const live = new Map([...(calls || []), ...(promises || []), ...(requests || [])].map((r) => [String(r.id), r]));
  return refs.some(({ id, rev }) => !live.has(id) || (rev && commitmentRevision(live.get(id)) !== rev));
}
// The same question for VISIT STATUS: rebuild the facts for the customer (strict —
// a failed read throws — and with commitments) and compare their signature with
// the draft's; an open promise or request the draft did not show (recorded since,
// or unreadable when it was drafted) refuses too, so it goes to review.
async function visitStatusReason(conn, signature, customerId, refs) {
  if (!customerId) return 'visit_status_changed';
  const facts = require('./visit-loops-facts');
  const fresh = await facts.loadVisitLoops({ customerId, conn, strict: true, withCommitments: true });
  if (facts.visitStatusSignature(fresh) !== signature) return 'visit_status_changed';
  const shown = new Set(refs.map((r) => r.id));
  const unseen = [...(fresh.weOwe || []), ...(fresh.customerWaiting || [])].some((c) => c && c.id != null && !shown.has(String(c.id)));
  return unseen ? 'commitment_appeared' : null;
}
const objectOrNull = (value) => (value && typeof value === 'object' ? value : null);
async function openLoopsBlockReason({ decision, customerId = decision?.customer_id, dbh, now = new Date() }) {
  const snapshot = objectOrNull(parseInputSnapshot(decision?.input_snapshot)) || {};
  const refs = [...new Set([].concat(snapshot.visit_loop_commitment_ids || []))]
    .filter((ref) => typeof ref === 'string' && ref)
    .map((ref) => { const [id, rev = null] = ref.split(':'); return { id, rev }; });
  // a persisted status is checked even when its signature is null: the section was
  // rendered with nothing time-sensitive, and a fact that appeared since refuses
  const status = objectOrNull(snapshot.visit_loop_status);
  if (refs.length && commitmentDayChanged(snapshot, now)) return 'commitment_day_changed';
  if (!refs.length && !status) return null;
  try {
    const conn = dbh || require('../models/db');
    if (refs.length && await commitmentsChanged(conn, refs, customerId)) return 'commitment_closed';
    return status ? await visitStatusReason(conn, status.signature || null, customerId, refs) : null;
  } catch (err) {
    require('./logger').warn(`[agent-decision-send-checks] open-loop recheck failed: ${err.message}; blocking send`);
    return 'open_loops_recheck_failed';
  }
}
async function openLoopsBlock({ decision }) {
  const reason = await openLoopsBlockReason({ decision });
  return reason ? `open-loop facts stale (${reason})` : null;
}
// The scheduler's queued-send form: reads the decision row itself; fails closed.
async function scheduledOpenLoopsBlockReason({ agentDecisionId, dbh }) {
  try {
    const conn = dbh || require('../models/db');
    const row = await conn('agent_decisions').where({ id: agentDecisionId }).first('input_snapshot', 'customer_id');
    if (!row) throw new Error('agent decision row not found');
    return await openLoopsBlockReason({ decision: row, dbh: conn });
  } catch (err) {
    require('./logger').warn(`[agent-decision-send-checks] open-loop recheck failed for decision ${agentDecisionId}: ${err.message}; blocking send`);
    return 'open_loops_recheck_failed';
  }
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
    || (await openLoopsBlock({ decision }))
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

module.exports = { agentDecisionSendBlockReason, scheduledReserviceBlockReason, scheduledOpenLoopsBlockReason, openLoopsBlockReason, openLoopsProviderPreSendCheck, openLoopsDecisionProviderPreSendCheck, gratitudeOpenLoopsProviderPreSendCheck, parseInputSnapshot, labelFactsBlock, scheduledLabelFactsBlock, scheduledEtaBlockReason, isEtaInfrastructureFailure, blockReasonIsEtaInfrastructure, isLabelRecheckInfrastructureFailure, blockReasonIsLabelInfrastructure, blockReasonIsRecheckInfrastructure, etaProviderPreSendCheck, etaSnapshotProviderPreSendCheck, labelFactsProviderPreSendCheck, labelFactsSnapshotProviderPreSendCheck, composeProviderPreSendChecks, markRepeatable };
