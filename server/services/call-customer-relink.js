/**
 * Repoint (or unlink) one call's customer. Extracted VERBATIM from
 * PUT /api/admin/call-recordings/calls/:id/customer so the Attach-as-contact card action
 * (routes/admin-triage.js) relinks a call by the same rules, in the same transaction shape.
 *
 * Two steps, as in the route:
 *   1. relinkCallCustomerTx(trx, call, customerId, override): the link, the lead and timeline
 *      moves and the customer_creation_failed repair. Run it INSIDE a transaction. Returns the
 *      move summary, { notFound: true } for a missing/deleted target, or null when a pass holds
 *      the call's claim (the caller answers 409).
 *   2. afterCallRelink(call, customerId): best-effort work AFTER the commit (voice message
 *      re-home, promise re-judge). Returns { warnings, promisesReopened }.
 */
const db = require('../models/db');
const logger = require('./logger');

function maskSid(sid) {
  if (!sid) return 'none';
  const value = String(sid);
  return value.length <= 8 ? `${value.slice(0, 2)}…` : `${value.slice(0, 2)}…${value.slice(-6)}`;
}

async function relinkCallCustomerTx(trx, call, customerId, override) {
  // The target is validated under its row lock IN the transaction —
  // customers first, then call_log, the merge flow's lock order — so a
  // merge or retirement of that customer serializes against the relink
  // instead of landing between a check and the write (Codex r6 P2).
  if (customerId) {
    const customer = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate().first('id');
    if (!customer) return { notFound: true };
  }
  // An UNLINK also severs the call's durable lead linkage (Codex r9
  // P2): the lead stamp keys the processor writes (the same set its
  // own clear uses) and the lead's twilio_call_sid arm, which the
  // estimator engine and the same-call lead reuse resolve through.
  // The lead itself stays — it may be a real inquiry — it just no
  // longer claims this call. A relink to a person leaves them alone.
  const LEAD_STAMP_KEYS = ['lead_id', 'lead_prior_state', 'lead_written_state', 'lead_stamp_seq', 'lead_link_via'];
  const metadataExpr = customerId
    ? "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{customer_link_override}', ?::jsonb, true)"
    : `jsonb_set(COALESCE(metadata, '{}'::jsonb) ${LEAD_STAMP_KEYS.map((k) => `- '${k}'`).join(' ')}, '{customer_link_override}', ?::jsonb, true)`;
  const relinked = await trx('call_log').where({ id: call.id })
    .whereRaw("processing_status IS DISTINCT FROM 'processing'")
    .update({
      customer_id: customerId,
      metadata: db.raw(metadataExpr, [JSON.stringify(override)]),
      updated_at: new Date(),
    });
  if (!relinked) return null;
  let leadsUnlinked = 0;
  if (!customerId && call.twilio_call_sid) {
    leadsUnlinked = await trx('leads').where({ twilio_call_sid: call.twilio_call_sid }).update({ twilio_call_sid: null, updated_at: new Date() });
  }
  // A relink that MOVES the call between two customers repoints the
  // call-created lead to the new owner in the same transaction (Codex
  // #3764 r5 P1): the lead is keyed by this call's twilio_call_sid and,
  // left under the previous customer, findReusableCallLead rejects it on
  // a later reprocess (a lead another customer owns is ineligible —
  // applySameCallLeadEligibility) and mints and NOTIFIES a second lead
  // for the same call. Only a lead still owned by the PREVIOUS customer
  // moves; an unclaimed (NULL) lead is already eligible for the new owner
  // and is left alone, and both the SID and stamp arms reuse the
  // repointed row afterward. converted_at / status are untouched — this
  // re-attributes an already-owned lead, never a new conversion.
  let leadsReconciled = 0;
  if (customerId && call.twilio_call_sid && call.customer_id && call.customer_id !== customerId) {
    leadsReconciled = await trx('leads')
      .where({ twilio_call_sid: call.twilio_call_sid, customer_id: call.customer_id })
      .update({ customer_id: customerId, updated_at: new Date() });
  }
  const timeline = trx('customer_interactions')
    .where({ interaction_type: 'call' })
    .whereRaw("metadata ->> 'call_log_id' = ?", [String(call.id)]);
  const rows = customerId
    ? await timeline.update({ customer_id: customerId })
    : await timeline.del();
  // A call with no keyed timeline entry yet gets one on link: an earlier
  // unlink deleted it, or the pass never wrote one (customer creation
  // failed, or the call predates the keyed entry). The processor writes
  // this row only during a pass and this endpoint runs none, so the
  // corrected call would otherwise be missing from the customer's
  // timeline (Codex #3764 r1 P2). Same conflict target as the
  // processor's insert, so a concurrent pass cannot double it.
  let created = 0;
  if (customerId && rows === 0) {
    const phone = call.direction === 'outbound' ? call.to_phone : call.from_phone;
    const inserted = await trx.raw(
      `INSERT INTO customer_interactions (customer_id, interaction_type, subject, body, metadata)
       VALUES (?, 'call', ?, ?, ?::jsonb)
       ON CONFLICT ((metadata ->> 'call_log_id')) WHERE interaction_type = 'call' AND metadata ->> 'call_log_id' IS NOT NULL DO NOTHING`,
      [
        customerId,
        `${call.direction === 'outbound' ? 'Outbound' : 'Inbound'} call — linked by operator`,
        call.call_summary || `Call${phone ? ` from ${phone}` : ''} linked to this customer by the office.`,
        JSON.stringify({ call_log_id: call.id, twilio_call_sid: call.twilio_call_sid || null, linked_by_operator: true }),
      ],
    );
    created = inserted?.rowCount ?? 0;
  }
  // The operator's correction IS the fix for an earlier
  // customer_creation_failed: its card resolves here (no reprocess runs
  // from this endpoint), and the review flag clears only when no other
  // open card still needs a person.
  const repaired = await trx('triage_items')
    .where({ call_log_id: call.id, reason_code: 'customer_creation_failed' })
    .whereIn('status', ['open', 'in_progress'])
    .update({ status: 'resolved', resolved_at: new Date(), resolution_note: customerId ? `Customer set by operator (${customerId})` : 'Unlinked by operator' });
  if (repaired > 0) {
    await trx('call_log')
      .where({ id: call.id })
      .whereNotExists(trx('triage_items').where('triage_items.call_log_id', call.id).whereIn('triage_items.status', ['open', 'in_progress']))
      .update({ review_status: null });
  }
  return { timelineRows: rows, timelineCreated: created, repaired, leadsUnlinked, leadsReconciled };
}

async function afterCallRelink(call, customerId) {
  const warnings = [];
  if (call.twilio_call_sid) {
    // Best-effort here; a failure is reported, not silently swallowed.
    // For a LINK the hourly call-log relink sweep re-homes any linked
    // call whose thread still sits under another customer; an UNLINK's
    // detach (the sync moves the message to the caller's unowned thread)
    // has no sweep behind it — the sweep only walks linked rows — so the
    // office retries the unlink.
    // The helper catches its own errors and returns null (Codex #3764 r2
    // P1), so the null result is the failure signal — not a rejection.
    const synced = await require('./conversations').syncVoiceMessageForCall(call.twilio_call_sid)
      .catch((e) => {
        logger.warn(`[call-recordings] voice message re-home after relink failed for ${maskSid(call.twilio_call_sid)}: ${e.message}`);
        return null;
      });
    if (synced === null) {
      warnings.push(customerId
        ? 'voice_message_rehome_failed: the hourly relink sweep will retry it'
        : 'voice_message_rehome_failed: the recording is still in the previous customer\'s thread; retry the unlink');
    }
  }
  // A promise kept by a booking for its promised slot was matched through
  // the call's customer: re-judge the call's promises now that the link
  // committed. Gate off writes nothing — the commitments sweep judges it
  // once the gate is back (listSlotKeptCallIds). Best-effort: a failed
  // refresh leaves it to that sweep.
  let promisesReopened = 0;
  if (require('../config/feature-gates').isEnabled('callCommitments')) {
    const refreshed = await require('./call-commitments').refreshFulfillment(db, call.id).catch((e) => {
      logger.warn(`[call-recordings] promise refresh after relink failed for call ${call.id}: ${e.message}`);
      return {};
    });
    promisesReopened = refreshed.reopened || 0;
  }
  return { warnings, promisesReopened };
}

module.exports = { relinkCallCustomerTx, afterCallRelink };
