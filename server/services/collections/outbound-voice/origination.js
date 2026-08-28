/**
 * Outbound call origination for an APPROVED collection case (PR B).
 *
 * The one place a collections call is ever created. Sequence (each step fails
 * closed — any miss means NO dial):
 *
 *   1. GATE_VOICE_LATE_PAYMENT exact-'true' + the existing twilioVoice
 *      feature gate (the same pair of gates the admin click-to-call checks).
 *   2. Case must be current_state 'approved', within its 24h approval window
 *      (approval_expires_at) — expired approvals flip to 'expired' and go
 *      back to the review queue, never dial.
 *   3. FULL policy revalidation at dial time: ContactPolicy.evaluate
 *      (channel 'voice', purpose 'late_payment'). ANY denial — or an eligible
 *      set / balance that no longer matches the approved snapshot — CANCELS
 *      the case (state 'cancelled' + reason). The next shadow/proposal sweep
 *      regenerates a fresh case for Adam; a stale approval never dials.
 *   4. Idempotency: the case's `collections:{customer_id}:{case_version}:{tier}`
 *      key is stamped into call_log metadata; a prior dial under the same key
 *      refuses to dial again.
 *   5. RECORD-THEN-DIAL: the collections contact ledger row is inserted
 *      BEFORE calls.create (PR A doctrine — recordContact THROWS on failure
 *      and the dial is skipped; a failed dial stamps send_failed on the row,
 *      which only ever over-suppresses).
 *   6. call_log row inserted BEFORE calls.create (the admin click-to-call
 *      pattern — webhooks race the insert otherwise), CallSid backfilled.
 *
 * The created call's TwiML is the DTMF consent vestibule
 * (/api/webhooks/twilio/collections-vestibule) — a fixed recorded-message
 * stage with NO ConversationRelay and no audio processing before press-1.
 * AMD is enabled (DetectMessageEnd) so the vestibule webhook can route
 * machine answers to the generic-callback-voicemail decision.
 */

const db = require('../../../models/db');
const logger = require('../../logger');
const ContactPolicy = require('../contact-policy');
const ContactLedger = require('../contact-ledger');
const { normalizeE164 } = require('../consent-provenance');
const { isVoiceLatePaymentEnabled } = require('./gates');
const { anchorInvoiceOf, dueValueOf, daysOverdueOn, dunningTierForOverdue } = require('../account-anchor');
const { etCalendarDayOf } = require('../../../utils/datetime-et');

const CALL_SOURCE = 'collections_voice';

function sortedIds(value) {
  const arr = Array.isArray(value)
    ? value
    : (() => { try { return JSON.parse(value || '[]'); } catch { return []; } })();
  return arr.map(String).sort();
}

async function setCaseState(caseRow, patch, { fromState = 'approved' } = {}) {
  // State-fenced (codex gh-r8): pre-claim transitions run while the row
  // should still be 'approved' — a concurrent invocation that WON the
  // approved→dialing claim must not have its live 'dialing' state
  // clobbered by this loser's expired/cancelled verdict. The post-dial
  // failure path passes fromState 'dialing' (it holds the claim).
  // customer_id is in the fence too (codex gh-r13): a merge can repoint
  // the case while origination evaluates the OLD owner — an expiry/policy
  // denial reached here must not cancel the now winner-owned case using
  // the retired loser's snapshots. A moved row matches 0 and stands down.
  const [updated] = await db('collection_cases')
    .where({ id: caseRow.id, customer_id: caseRow.customer_id, case_version: caseRow.case_version, current_state: fromState })
    .update({ ...patch, updated_at: db.fn.now() })
    .returning('*');
  return updated || null;
}

/**
 * Attempt to originate the collections call for one approved case.
 * Returns { dialed: boolean, reason, callSid?, callLogId? }. Never throws for
 * policy/gate refusals; only genuinely unexpected errors propagate to the
 * caller's catch (which must treat them as "not dialed").
 */
async function originateCollectionCall(caseId, { now = new Date(), clock = () => new Date() } = {}) {
  if (!isVoiceLatePaymentEnabled()) return { dialed: false, reason: 'gated_off' };

  const { isEnabled } = require('../../../config/feature-gates');
  if (!isEnabled('twilioVoice')) return { dialed: false, reason: 'twilio_voice_gate_off' };

  const caseRow = await db('collection_cases').where({ id: caseId }).first();
  if (!caseRow) return { dialed: false, reason: 'case_not_found' };
  if (caseRow.current_state !== 'approved') {
    return { dialed: false, reason: `case_not_approved:${caseRow.current_state}` };
  }
  // A stated payment date (or live-conversation suppression) stamps
  // next_eligible_at on the case (gh prb-r7): dialing before it would break
  // the promise the last call made. Refuse; the queue re-proposes after.
  if (caseRow.next_eligible_at && new Date(caseRow.next_eligible_at).getTime() > now.getTime()) {
    return { dialed: false, reason: 'suppressed_until_next_eligible' };
  }

  // The relay leg must be LIVE before anything dials (gh prb-r5): with the
  // collections gate on but the relay unattached (VOICE_RELAY_ENABLED off,
  // missing key/secret), the customer would press 1 into a dead socket.
  // isRelayAttached is in-process truth — origination runs in the same
  // server that attached (or refused to attach) the ws endpoint.
  try {
    const { isRelayAttached } = require('../../voice-agent/relay-server');
    if (!isRelayAttached()) {
      return { dialed: false, reason: 'relay_unavailable' };
    }
  } catch (err) {
    logger.error(`[collections-voice] relay availability check failed: ${err.message}`);
    return { dialed: false, reason: 'relay_unavailable' };
  }
  const expiresAt = caseRow.approval_expires_at ? new Date(caseRow.approval_expires_at) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    await setCaseState(caseRow, { current_state: 'expired', hold_reason: 'approval_expired_before_dial' });
    return { dialed: false, reason: 'approval_expired' };
  }

  // The number the policy is about to be evaluated AGAINST is snapshotted
  // FIRST (gh prb-r15): the verdict's consent/line-type/suppression checks
  // are phone-specific, so a phone edited mid-evaluation must abort — the
  // post-verdict re-read below refuses on any mismatch rather than dialing
  // a number those checks never saw.
  const preEval = await db('customers')
    .where({ id: caseRow.customer_id }).whereNull('deleted_at')
    .first('id', 'phone');
  const preEvalPhone = normalizeE164(preEval?.phone);
  if (!preEval || !preEvalPhone) {
    await setCaseState(caseRow, { current_state: 'cancelled', hold_reason: 'no_dialable_number' });
    return { dialed: false, reason: 'no_dialable_number' };
  }

  // ── FULL revalidation at dial time ─────────────────────────────────────
  // Supervised = admin-approved case; autodial promotions never ride the
  // owner call-window override (codex P1 on #3555).
  const supervised = ContactPolicy.isSupervisedApprover(caseRow.approved_by);
  const verdict = await ContactPolicy.evaluate(caseRow.customer_id, {
    channel: 'voice', purpose: 'late_payment', now, supervisedDial: supervised,
  });
  if (!verdict.allowed) {
    await setCaseState(caseRow, {
      current_state: 'cancelled',
      hold_reason: `predial_policy_denied: ${verdict.denialReasons.join(', ')}`.slice(0, 500),
    });
    return { dialed: false, reason: 'policy_denied', denialReasons: verdict.denialReasons };
  }
  const liveIds = sortedIds(verdict.eligibleInvoiceIds);
  const approvedIds = sortedIds(caseRow.eligible_invoice_ids);
  const liveSet = new Set(liveIds);
  const liveCents = verdict.eligibleInvoiceCents || {};
  const approvedStillOpen = approvedIds.every((id) => liveSet.has(id));
  // The APPROVED invoices' own remainder must still equal the snapshot
  // (hook P1): a covered invoice paid down while a new one joined would
  // otherwise read as net growth and dial on an approval for a different
  // balance. Growth is only ever NEW invoices joining.
  const approvedRemainderCents = approvedIds.reduce((sum, id) => sum + Number(liveCents[id] || 0), 0);
  const approvedChanged = approvedRemainderCents !== Number(caseRow.eligible_balance_snapshot);
  const setChanged = JSON.stringify(liveIds) !== JSON.stringify(approvedIds);
  if (!approvedStillOpen || approvedChanged) {
    // A covered invoice was paid/credited/reassigned since approval — the
    // approval was for a DIFFERENT balance; never dial on it. Cancel and
    // let the sweep regenerate a fresh proposal card.
    await setCaseState(caseRow, {
      current_state: 'cancelled',
      hold_reason: !approvedStillOpen ? 'predial_invoice_set_changed' : 'predial_balance_changed',
    });
    return { dialed: false, reason: 'snapshot_changed' };
  }
  if (setChanged) {
    // The balance only GREW — a new invoice joined the account (owner ruling
    // 2026-08-28: new invoices join the existing balance silently). The
    // approval was for a TIER too (the idempotency key's suffix = the
    // register Sandy will speak): a joining invoice OLDER than the approved
    // anchor moves the clock, and a call approved as friendly must never go
    // out firm (hook r3 P1) — cancel and let the sweep re-propose at the
    // right tier. Same tier ⇒ re-snapshot ids/balance/anchor date and proceed.
    const liveRows = await db('invoices').whereIn('id', liveIds).select('id', 'due_date', 'created_at');
    const anchor = anchorInvoiceOf(liveRows);
    const liveTier = anchor ? dunningTierForOverdue(daysOverdueOn(now, dueValueOf(anchor))) : null;
    const approvedTier = Number(String(caseRow.idempotency_key || '').split(':').pop());
    if (!anchor || liveTier !== approvedTier) {
      await setCaseState(caseRow, {
        current_state: 'cancelled',
        hold_reason: `predial_tier_changed: approved ${approvedTier}, live ${liveTier}`,
      });
      return { dialed: false, reason: 'snapshot_changed' };
    }
    const resnapped = await setCaseState(caseRow, {
      eligible_invoice_ids: JSON.stringify(liveIds),
      eligible_balance_snapshot: verdict.eligibleBalanceCents,
      earliest_due_date: etCalendarDayOf(dueValueOf(anchor)),
    });
    if (!resnapped) return { dialed: false, reason: 'dial_claim_lost' };
    caseRow.eligible_invoice_ids = liveIds;
    caseRow.eligible_balance_snapshot = verdict.eligibleBalanceCents;
    logger.info(`[collections-origination] case ${caseRow.id} re-snapshotted pre-dial: balance grew to ${verdict.eligibleBalanceCents}c (${liveIds.length} invoices, tier ${liveTier})`);
  }

  const customer = await db('customers').where({ id: caseRow.customer_id }).whereNull('deleted_at').first();
  const toPhone = normalizeE164(customer?.phone);
  if (!customer || !toPhone) {
    await setCaseState(caseRow, { current_state: 'cancelled', hold_reason: 'no_dialable_number' });
    return { dialed: false, reason: 'no_dialable_number' };
  }
  // The verdict binds to the number it evaluated (gh prb-r15).
  if (toPhone !== preEvalPhone) {
    await setCaseState(caseRow, { current_state: 'cancelled', hold_reason: 'phone_changed_during_evaluation' });
    return { dialed: false, reason: 'phone_changed' };
  }

  // ── Idempotency: one dial per case version, restart-safe ───────────────
  const idempotencyKey = caseRow.idempotency_key;
  const prior = await db('call_log')
    .where({ source: CALL_SOURCE })
    .whereRaw("metadata->>'collectionsIdempotencyKey' = ?", [idempotencyKey])
    // A FAILED dial's row must not block the human's re-approval (gh
    // prb-r2) — the failure path resets the case to 'proposed' precisely so
    // it can be retried. COALESCE keeps the NULL leg explicit.
    // Every status the callback route can write for an unanswered attempt
    // (gh prb-r3) — a reapproved retry must not be blocked by any of them.
    .whereRaw("COALESCE(status, '') NOT IN ('failed', 'busy', 'no-answer', 'canceled')")
    .first('id');
  if (prior) return { dialed: false, reason: 'already_dialed', callLogId: prior.id };

  // ── ATOMIC dial claim (codex prb-r1): the probe above is observability,
  // not the boundary — two workers could both read no prior row. The case
  // row itself is the claim: a guarded approved→dialing UPDATE lets exactly
  // one worker proceed; the loser sees zero rows and stands down. A crash
  // after the claim leaves the case visibly stuck in 'dialing' for the
  // supervised pilot's operator to resolve — never a second dial.
  // The claim runs UNDER the customer case lock (codex gh-r10): a merge
  // holds this lock while it reconciles/repoints, and its in-lock
  // dialing-check must be authoritative — without the lock here, a claim
  // could land between the merge's check and its commit and the call
  // would proceed against mid-repoint data.
  const { withCaseLock } = require('../case-lock');
  // Master gate RE-CHECK at the claim boundary (codex gh-r13 P1): the
  // entry check ran before the customer/policy/idempotency reads — an
  // incident kill-switch flip during that window must stop the dial HERE,
  // before any state is claimed or the provider is touched.
  if (!isVoiceLatePaymentEnabled()) return { dialed: false, reason: 'gated_off' };
  // Time-based authorization RE-CHECK with a FRESH clock (codex gh-r14):
  // the entry snapshot of `now` can go stale across the policy evaluation
  // (it may include a Stripe microdeposit lookup) — a claim reached after
  // 18:00 ET or past approval_expires_at must stand down. The window
  // predicate is contact-policy's own; the expiry re-check rides IN the
  // claim's WHERE below via this same fresh clock.
  const claimNow = clock();
  if (!ContactPolicy.isWithinCallWindow(claimNow, { supervised })) {
    return { dialed: false, reason: 'outside_call_window' };
  }
  // customer_id is IN the fence (codex gh-r11): a merge committing between
  // the snapshot reads and this lock acquisition repoints the case to the
  // winner — the policy verdict and phone evaluated above then belong to
  // the retired loser. A moved row claims 0 and stands down.
  const claimed = await withCaseLock(caseRow.customer_id, async (trx) => trx('collection_cases')
    .where({ id: caseRow.id, customer_id: caseRow.customer_id, current_state: 'approved', case_version: caseRow.case_version })
    // The 24h authorization boundary holds INSIDE the atomic claim too (gh
    // prb-r15): the policy revalidation above can cross the deadline, and
    // the earlier expiry check is not the boundary — this WHERE is.
    .where('approval_expires_at', '>', claimNow)
    .update({ current_state: 'dialing', updated_at: trx.fn.now() }));
  if (!claimed) return { dialed: false, reason: 'dial_claim_lost' };

  // From here to calls.create, a thrown persistence failure must RELEASE
  // the claim (gh prb-r4): no Twilio call exists yet, so no status callback
  // will ever reconcile the case — without this it stays stuck in
  // 'dialing' and every retry refuses.
  const releaseClaim = async () => {
    await db('collection_cases')
      .where({ id: caseRow.id, current_state: 'dialing', case_version: caseRow.case_version })
      .update({ current_state: 'approved', updated_at: db.fn.now() })
      .catch((err) => logger.error(`[collections-voice] dial-claim release failed for case ${caseRow.id}: ${err.message}`));
  };

  // ── RECORD-THEN-DIAL: ledger row before any Twilio touch ───────────────
  // recordContact THROWS on failure; the throw propagates and no dial happens
  // (no unledgered customer contact, ever).
  let ledgerEntry;
  try {
    ledgerEntry = await ContactLedger.recordContact({
    customerId: caseRow.customer_id,
    channel: 'voice',
    purpose: 'late_payment',
    invoiceIds: liveIds,
    source: CALL_SOURCE,
    metadata: { collectionCaseId: caseRow.id, caseVersion: caseRow.case_version, idempotencyKey },
    occurredAt: now,
  });
  } catch (err) {
    await releaseClaim();
    throw err;
  }

  const TWILIO_NUMBERS = require('../../../config/twilio-numbers');
  const from = TWILIO_NUMBERS.mainLine.number;

  // call_log BEFORE calls.create (admin click-to-call pattern).
  let callLogRow;
  try {
    [callLogRow] = await db('call_log')
    .insert({
      customer_id: caseRow.customer_id,
      direction: 'outbound',
      from_phone: from,
      to_phone: toPhone,
      status: 'initiated',
      source: CALL_SOURCE,
      metadata: JSON.stringify({
        collectionCaseId: caseRow.id,
        caseVersion: caseRow.case_version,
        collectionsIdempotencyKey: idempotencyKey,
        ledgerId: ledgerEntry.id,
        // Supervision is IMMUTABLE call metadata (codex #3560 P2): the
        // case's approved_by is cleared by writeCallOutcome, so a webhook
        // retry re-deriving it from the case would flip a supervised call
        // to unsupervised mid-flow. Every in-call reader uses this stamp.
        collectionsSupervised: supervised === true,
      }),
    })
    .returning(['id']);
  } catch (err) {
    // Provably pre-provider (gh prb-r14): the call_log insert precedes any
    // Twilio touch, so the row must not consume the frequency windows — a
    // retry after the claim release would otherwise see its own unsent
    // voice row inside the 7-day spacing and cancel the approved case.
    // The stamp result is CHECKED with one retry (gh prb-r16); if the row
    // cannot be marked, the claim is deliberately NOT released — the case
    // stays visibly stuck in 'dialing' for the pilot operator instead of
    // silently un-dialable behind a phantom window.
    let stamped = await ContactLedger.markSendFailed(ledgerEntry, { stage: 'call_log_insert', never_contacted: true });
    if (!stamped) {
      stamped = await ContactLedger.markSendFailed(ledgerEntry, { stage: 'call_log_insert', never_contacted: true });
    }
    if (stamped) {
      await releaseClaim();
    } else {
      logger.error(`[collections-voice] never_contacted stamp FAILED TWICE for ledger ${ledgerEntry.id} — case ${caseRow.id} left in 'dialing' for operator repair`);
    }
    throw err;
  }
  const callLogId = callLogRow?.id;

  // Flipped immediately before the ONE network call below (gh prb-r11):
  // any throw while it is still false (missing Twilio config, client
  // construction) provably happened before the provider was touched.
  // Final master-gate check before the provider (codex gh-r13 P1): the
  // claim and the ledger/call_log writes take real time — a kill-switch
  // flip during them must still stop the call. Release the claim cleanly;
  // no provider request exists, so no callback will ever reconcile it.
  if (!isVoiceLatePaymentEnabled()) {
    // Same stamp-then-release doctrine as the pre-provider failure path
    // (gh prb-r16): unstamped ⇒ claim deliberately kept for the operator.
    let stamped = await ContactLedger.markSendFailed(ledgerEntry, { stage: 'gate_recheck', never_contacted: true });
    if (!stamped) {
      stamped = await ContactLedger.markSendFailed(ledgerEntry, { stage: 'gate_recheck', never_contacted: true });
    }
    if (callLogId) {
      await db('call_log').where({ id: callLogId })
        .update({ status: 'canceled', updated_at: new Date() })
        .catch(() => {});
    }
    if (stamped) {
      await releaseClaim();
    } else {
      logger.error(`[collections-voice] never_contacted stamp FAILED TWICE for ledger ${ledgerEntry.id} — case ${caseRow.id} left in 'dialing' for operator repair (gate recheck)`);
    }
    return { dialed: false, reason: 'gated_off' };
  }

  let providerRequestStarted = false;
  try {
    const twilio = require('twilio');
    const config = require('../../../config');
    if (!config.twilio.accountSid || !config.twilio.authToken) {
      throw new Error('Twilio not configured');
    }
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const domain = process.env.SERVER_DOMAIN || 'portal.wavespestcontrol.com';
    const params = new URLSearchParams({ callLogId: String(callLogId || '') });

    providerRequestStarted = true;
    const call = await client.calls.create({
      to: toPhone,
      from,
      // AMD: DetectMessageEnd waits for a machine greeting to finish, so the
      // vestibule webhook receives AnsweredBy and can route machine answers
      // to the generic-callback-voicemail decision (and 'unknown' to a silent
      // hangup — never a voicemail on an uncertain result).
      machineDetection: 'DetectMessageEnd',
      url: `https://${domain}/api/webhooks/twilio/collections-vestibule?${params.toString()}`,
      // gh prb-r2: busy/no-answer/canceled/failed calls never reach the
      // vestibule — the collections status route is the ONLY thing that can
      // return the case from 'dialing' and record the missed outcome.
      // callLogId rides the query string — loadCollectionsCall requires it
      // (gh prb-r3: without it every real unanswered callback 204'd away).
      statusCallback: `https://${domain}/api/webhooks/twilio/collections-call-status?${params.toString()}`,
      statusCallbackEvent: ['completed'],
    });

    if (callLogId) {
      await db('call_log').where({ id: callLogId }).update({
        twilio_call_sid: call.sid,
        updated_at: new Date(),
      }).catch(() => {});
    }
    // (state already 'dialing' via the atomic claim above)
    logger.info(`[collections-voice] originated call for case ${caseRow.id} v${caseRow.case_version} (callLogId=${callLogId})`);
    return { dialed: true, reason: 'dialed', callSid: call.sid, callLogId };
  } catch (err) {
    // ID-only logging (gh prb-r10): a Twilio rejection message can embed the
    // full destination number — provider status/code carry the diagnosis
    // without writing customer phone PII to the logs.
    logger.error(`[collections-voice] dial failed for case ${caseRow.id}: status=${err?.status ?? 'n/a'} code=${err?.code ?? 'n/a'}`);
    // never_contacted is reserved for DEFINITIVE pre-send rejections (gh
    // prb-r9): a 4xx from Twilio proves the request was refused before any
    // call existed. An ambiguous failure (timeout, connection loss) can
    // land AFTER Twilio created and started the call, so its ledger row
    // keeps consuming the frequency windows — the policy's voice-spacing
    // denial is what stops a re-approval from originating a second live
    // call while the first may still be ringing.
    // A local preflight failure (Twilio unconfigured, client construction)
    // is equally definitive (gh prb-r11): the provider request never
    // started, so the row must not consume the frequency windows —
    // restoring credentials and re-approving should be able to dial.
    const definitiveReject = !providerRequestStarted
      || (Number(err?.status) >= 400 && Number(err?.status) < 500);
    const stampExtra = definitiveReject ? { never_contacted: true } : { ambiguous_provider_failure: true };
    // Stamp checked with one retry (gh prb-r18): an unstamped
    // never_contacted row would block reapproval through the 7-day window
    // for a call that never existed. Ambiguous rows counting on stamp
    // failure is the safe direction (over-suppression) and needs no hold.
    let stamped = await ContactLedger.markSendFailed(ledgerEntry, { stage: 'calls_create', ...stampExtra });
    if (!stamped) stamped = await ContactLedger.markSendFailed(ledgerEntry, { stage: 'calls_create', ...stampExtra });
    if (callLogId) {
      await db('call_log').where({ id: callLogId })
        .update({ status: 'failed', updated_at: new Date() })
        .catch(() => {});
    }
    if (definitiveReject && !stamped) {
      // Never-contacted but unmarkable: leave the case visibly in 'dialing'
      // for the operator instead of returning it to a queue it cannot
      // actually be re-dialed from behind the phantom window.
      logger.error(`[collections-voice] never_contacted stamp FAILED TWICE for ledger ${ledgerEntry.id} — case ${caseRow.id} left in 'dialing' for operator repair`);
      return { dialed: false, reason: 'dial_failed' };
    }
    // Back to the review queue — a dial failure is never silently retried.
    await setCaseState(caseRow, {
      current_state: 'proposed',
      approved_by: null,
      approved_at: null,
      approval_expires_at: null,
      hold_reason: 'dial_failed',
    }, { fromState: 'dialing' }).catch(() => {});
    return { dialed: false, reason: 'dial_failed' };
  }
}

module.exports = { originateCollectionCall, CALL_SOURCE };
