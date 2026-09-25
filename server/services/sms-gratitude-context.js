'use strict';

// Read-only gratitude send context boundary. Every database dependency is an
// explicit dbh argument so replay/tests can exercise the exact production SQL
// without loading the application database singleton.
const {
  GRATITUDE_INTENT,
  GRATITUDE_POLICY_VERSION,
  buildGratitudeReply,
  gratitudeTimingReason,
  evaluateGratitudeContext,
} = require('./sms-gratitude');
const { phoneIdentitySql } = require('./sms-response-policy');
const { phoneIdentityKey, phoneMatchDigits } = require('../utils/phone');

const SAFE_ACTION = 'none';

function jsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function gratitudeActivation() {
  return require('../config/feature-gates').gateEnvTimestamp('SMS_GRATITUDE_ACTIVATED_AT');
}

// Can a gratitude claim exist? The activation stamp outlives the kill switch,
// so a claim left provider-uncertain stays visible to manual send paths for
// its 24-hour window after the gate is disabled. Clear the stamp only after
// that window. Never stamped and gate off means no claim can exist, so those
// paths stay an exact pass-through while the lane is dark.
// First enable (gate + activation stamp set by a rolling deployment): old
// instances still read both unset and do not coordinate. A process therefore
// makes no gratitude claim until it has run longer than any deploy overlap,
// by which time every instance serving sends reads the same stamp.
const GRATITUDE_ROLLOUT_SETTLE_MS = 15 * 60 * 1000;

function gratitudeRolloutSettled() {
  return process.uptime() * 1000 >= GRATITUDE_ROLLOUT_SETTLE_MS;
}

function gratitudeClaimsPossible() {
  return require('../config/feature-gates').isEnabled('smsGratitudeReplies')
    || gratitudeActivation() !== null;
}

function validateGratitudeDraftContract(row, { expectedReply, expectedPromptVersion } = {}) {
  const rowFailure = [
    [() => !row || row.status !== 'shadow' || row.intent !== GRATITUDE_INTENT, 'draft_not_shadow_gratitude'],
    [() => !row.sms_log_id || !row.customer_id, 'draft_unlinked'],
    [() => row.scheduling_intent === true, 'scheduling_intent'],
    [() => !row.model || row.model === 'deterministic', 'invalid_model'],
    [() => !expectedPromptVersion || row.prompt_version !== expectedPromptVersion, 'prompt_version_mismatch'],
  ].find(([rejected]) => rejected());
  if (rowFailure) return rowFailure[1];

  const meta = jsonObject(row.intended_actions);
  if (!meta) return 'invalid_draft_metadata';
  const metadataFailure = [
    [() => !Array.isArray(meta.actions) || meta.actions.length > 1
      || (meta.actions.length === 1 && meta.actions[0]?.type !== SAFE_ACTION), 'action_required'],
    [() => meta.verify?.converged !== true, 'not_converged'],
    [() => meta.gratitude?.source !== 'live_webhook'
      || meta.gratitude?.policy_version !== GRATITUDE_POLICY_VERSION, 'invalid_gratitude_provenance'],
    [() => meta.gratitude?.actions_verified_safe !== true, 'actions_not_verified_safe'],
    [() => meta.gratitude?.verifier_enabled !== true, 'verifier_disabled'],
    [() => meta.missing_info !== null && meta.missing_info !== undefined
      && String(meta.missing_info).trim(), 'missing_info'],
  ].find(([rejected]) => rejected());
  if (metadataFailure) return metadataFailure[1];

  const flags = jsonArray(row.flags);
  if (!flags) return 'invalid_flags';
  const unsafe = flags.some((flag) => String(flag?.type || '').startsWith('comms_lint:')
    || ['open_complaint', 'cancel_save_active'].includes(flag?.type));
  return [
    [unsafe, 'unsafe_flags'],
    [typeof expectedReply !== 'string' || row.draft_response !== expectedReply, 'edited_draft'],
  ].find(([rejected]) => rejected)?.[1] || null;
}

function mediaCountFromMetadata(value) {
  const metadata = jsonObject(value);
  return metadata && Array.isArray(metadata.media) ? metadata.media.length : null;
}

// Every open-work source that must keep a courtesy closer from concealing
// operational work, as [query, id column] pairs. Built fresh per call so the
// same definitions serve the sequential reader and the one-statement final
// boundary read.
function pendingWorkQueries(dbh, { customerId, threadKey, excludeDecisionId = null }) {
  const openRequest = dbh('service_requests').where({ customer_id: customerId })
    .whereNotIn(dbh.raw("COALESCE(status, 'new')"), ['resolved', 'closed', 'cancelled']);

  const openCallCommitment = dbh('call_commitments as cc')
    .join('call_log as cl', 'cc.call_log_id', 'cl.id')
    .where({ 'cc.status': 'open' })
    .where(function sameCustomerOrThread() {
      this.where('cl.customer_id', customerId);
      if (threadKey) {
        this.orWhereRaw(`(
          ${phoneIdentitySql("BTRIM(COALESCE(cl.from_phone, ''))")} = ?
          OR ${phoneIdentitySql("BTRIM(COALESCE(cl.to_phone, ''))")} = ?
        )`, [threadKey, threadKey]);
      }
    });
  const openSmsCommitment = dbh('call_commitments as cc_sms')
    .join('sms_log as s_commitment', 'cc_sms.sms_log_id', 's_commitment.id')
    .where({ 'cc_sms.status': 'open' })
    .where(function sameCustomerOrThread() {
      this.where('s_commitment.customer_id', customerId);
      if (threadKey) {
        this.orWhereRaw(`(
          ${phoneIdentitySql("BTRIM(COALESCE(s_commitment.from_phone, ''))")} = ?
          OR ${phoneIdentitySql("BTRIM(COALESCE(s_commitment.to_phone, ''))")} = ?
        )`, [threadKey, threadKey]);
      }
    });

  const triage = dbh('triage_items as ti')
    .leftJoin('call_log as ti_call', 'ti.call_log_id', 'ti_call.id')
    .leftJoin('sms_log as ti_sms', 'ti.sms_log_id', 'ti_sms.id')
    .whereIn('ti.status', ['open', 'in_progress'])
    .where(function sameCustomerOrThread() {
      this.where('ti.related_customer_id', customerId)
        .orWhere('ti_call.customer_id', customerId)
        .orWhere('ti_sms.customer_id', customerId);
      if (threadKey) {
        this.orWhereRaw(`(
          ${phoneIdentitySql("BTRIM(COALESCE(ti_call.from_phone, ''))")} = ?
          OR ${phoneIdentitySql("BTRIM(COALESCE(ti_call.to_phone, ''))")} = ?
          OR ${phoneIdentitySql("BTRIM(COALESCE(ti_sms.from_phone, ''))")} = ?
          OR ${phoneIdentitySql("BTRIM(COALESCE(ti_sms.to_phone, ''))")} = ?
        )`, [threadKey, threadKey, threadKey, threadKey]);
      }
    });

  const operatorItem = dbh('operator_inbox_items as oi')
    .leftJoin('sms_log as oi_sms', function joinSmsSource() {
      this.on(dbh.raw("oi.source = 'sms'")).andOn(dbh.raw('oi_sms.id::text = oi.source_id'));
    })
    .whereIn('oi.status', ['open', 'snoozed'])
    .where(function sameCustomerOrThread() {
      this.where('oi.customer_id', customerId);
      if (threadKey) {
        this.orWhereRaw(`(
          ${phoneIdentitySql("BTRIM(COALESCE(oi_sms.from_phone, ''))")} = ?
          OR ${phoneIdentitySql("BTRIM(COALESCE(oi_sms.to_phone, ''))")} = ?
        )`, [threadKey, threadKey]);
      }
    });

  const decision = dbh('agent_decisions as ad')
    .leftJoin('sms_log as s', 'ad.sms_log_id', 's.id')
    .whereIn('ad.status', ['pending_review', 'pending', 'scheduled', 'sending', 'initiated', 'active']);
  // The final provider-boundary recheck runs after this executor has inserted
  // its own `sending` claim. Exclude only that server-owned id; every other
  // pending decision on the customer/thread still blocks the courtesy reply.
  if (excludeDecisionId) decision.whereNot('ad.id', excludeDecisionId);
  if (threadKey) {
    decision.where(function pendingForCustomerOrThread() {
      this.where('ad.customer_id', customerId)
        .orWhereRaw(`(
          ${phoneIdentitySql("BTRIM(COALESCE(s.from_phone, ''))")} = ?
          OR ${phoneIdentitySql("BTRIM(COALESCE(s.to_phone, ''))")} = ?
        )`, [threadKey, threadKey]);
    });
  } else {
    decision.where('ad.customer_id', customerId);
  }
  return [
    [openRequest, 'id'],
    [openCallCommitment, 'cc.id'],
    [openSmsCommitment, 'cc_sms.id'],
    [triage, 'ti.id'],
    [operatorItem, 'oi.id'],
    [decision, 'ad.id'],
  ];
}

async function pendingGratitudeWork(dbh, options) {
  for (const [query, column] of pendingWorkQueries(dbh, options)) {
    if (await query.first(column)) return true;
  }
  return false;
}

// Live customers on the thread phone (two rows are enough to detect ambiguity).
function threadCustomersQuery(dbh, customerPhoneDigits) {
  return dbh('customers').where({ active: true }).whereNull('deleted_at')
    .whereIn(dbh.raw("REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g')"), customerPhoneDigits)
    .limit(2).select('id', 'first_name', 'phone');
}

// Any later exchange on the exact endpoint pair, or null when the endpoints
// cannot be identified (callers treat that as advanced, fail closed).
function threadAdvancedQuery(dbh, { inboundId, fromPhone, toPhone, skipReservationId = null }) {
  const fromKey = phoneIdentityKey(fromPhone);
  const toKey = phoneIdentityKey(toPhone);
  if (!inboundId || !phoneMatchDigits(fromPhone).length || !phoneMatchDigits(toPhone).length
      || !fromKey || !toKey) return null;
  const query = dbh('sms_log').whereNot('id', inboundId)
    // Any still-pending outbound owns the exchange, even if queued before
    // this inbound. Only the caller's exact reservation may be excluded.
    .whereRaw(`(created_at >= (SELECT created_at FROM sms_log WHERE id = ?)
      OR (direction = 'outbound' AND status IN ('accepted','queued','scheduled','sending')))`, [inboundId])
    .whereRaw(`(
      (direction = 'inbound'
        AND ${phoneIdentitySql("BTRIM(COALESCE(from_phone, ''))")} = ?
        AND ${phoneIdentitySql("BTRIM(COALESCE(to_phone, ''))")} = ?)
      OR
      (direction = 'outbound'
        AND (
          ${phoneIdentitySql("BTRIM(COALESCE(from_phone, ''))")} = ?
          OR (
            metadata->>'channel' = 'push'
            AND metadata->>'providerAccepted' = 'true'
            AND ${phoneIdentitySql("BTRIM(COALESCE(metadata->>'provider_from_number', ''))")} = ?
          )
        )
        AND ${phoneIdentitySql("BTRIM(COALESCE(to_phone, ''))")} = ?
        AND status IN ('accepted','queued','sent','delivered','scheduled','sending'))
    )`, [fromKey, toKey, toKey, toKey, fromKey]);
  if (skipReservationId) query.whereNot('id', skipReservationId);
  return query;
}

async function gratitudeThreadAdvanced(dbh, options) {
  const query = threadAdvancedQuery(dbh, options);
  return !query || Boolean(await query.first('id'));
}

/**
 * The final provider-boundary read of mutable thread state as ONE statement:
 * open work and thread advancement are evaluated against a single snapshot,
 * so work that commits between two separate reads cannot be missed. Writers
 * of those tables do not take the thread lock.
 */
async function gratitudeFinalState(dbh, { pending, thread, customer }) {
  const threadQuery = threadAdvancedQuery(dbh, thread);
  if (!threadQuery) return { pendingWork: false, threadAdvanced: true, customerChanged: true };
  const pendingQueries = pendingWorkQueries(dbh, pending);
  const row = await dbh.first(
    dbh.raw(
      `(${pendingQueries.map(() => 'EXISTS (?)').join(' OR ')}) AS pending_work`,
      pendingQueries.map(([query, column]) => query.select(column)),
    ),
    dbh.raw('EXISTS (?) AS thread_advanced', [threadQuery.select('id')]),
    dbh.raw("(SELECT COALESCE(json_agg(c), '[]'::json) FROM (?) c) AS customers", [
      threadCustomersQuery(dbh, phoneMatchDigits(thread.fromPhone)),
    ]),
  );
  // The same identity the claim trusted: exactly one live customer on this
  // phone, the claimed id, the same phone, and the same fixed name reply.
  const customers = Array.isArray(row?.customers) ? row.customers : [];
  const current = customers.length === 1 ? customers[0] : null;
  const customerChanged = ![
    current,
    current?.id === customer.id,
    phoneIdentityKey(current?.phone) === customer.threadKey,
    buildGratitudeReply(current?.first_name) === customer.reply,
  ].every(Boolean);
  return {
    pendingWork: row?.pending_work === true,
    threadAdvanced: row?.thread_advanced !== false,
    customerChanged,
  };
}

async function readGratitudeContext({
  draftId, smsLogId, expectedPromptVersion, now = new Date(), activatedAt = gratitudeActivation(), dbh,
} = {}) {
  const setupFailure = [
    [!dbh, 'context_database_unavailable'],
    [!activatedAt, 'activation_unset'],
  ].find(([rejected]) => rejected);
  if (setupFailure) return { ok: false, reason: setupFailure[1] };
  const draft = await dbh('message_drafts').where({ id: draftId }).first(
    'id', 'sms_log_id', 'customer_id', 'inbound_message', 'draft_response', 'intent',
    'status', 'model', 'prompt_version', 'intended_actions', 'flags', 'scheduling_intent', 'created_at'
  );
  if (![draft, draft?.sms_log_id === smsLogId].every(Boolean)) {
    return { ok: false, reason: 'draft_source_mismatch' };
  }
  const inbound = await dbh('sms_log').where({ id: smsLogId, direction: 'inbound' }).first(
    'id', 'customer_id', 'direction', 'from_phone', 'to_phone', 'message_body', 'metadata', 'created_at'
  );
  const sourceFailure = [
    [() => !inbound?.created_at || !inbound.from_phone || !inbound.to_phone, 'inbound_unavailable'],
    [() => draft.customer_id !== inbound.customer_id
      || draft.inbound_message !== inbound.message_body, 'immutable_source_mismatch'],
    // Automated texts never originate from a technician's own line, and
    // rerouting the reply to the location number would start a separate,
    // unsolicited thread. Thanks sent to a tech line stay with the tech.
    [() => require('../config/twilio-numbers').isTechLine(inbound.to_phone), 'tech_line_thread'],
  ].find(([rejected]) => rejected());
  if (sourceFailure) return { ok: false, reason: sourceFailure[1] };
  const timing = gratitudeTimingReason({ inboundCreatedAt: inbound.created_at, now, activatedAt });
  if (timing) return { ok: false, reason: timing };

  const threadKey = phoneIdentityKey(inbound.from_phone);
  const endpointKey = phoneIdentityKey(inbound.to_phone);
  const customerPhoneDigits = phoneMatchDigits(inbound.from_phone);
  if (![threadKey, endpointKey, customerPhoneDigits.length, phoneMatchDigits(inbound.to_phone).length].every(Boolean)) {
    return { ok: false, reason: 'invalid_thread' };
  }
  const customers = await threadCustomersQuery(dbh, customerPhoneDigits);
  const customer = customers.length === 1 ? customers[0] : null;
  if (![customer, customer?.id === draft.customer_id, customer?.id === inbound.customer_id,
    phoneIdentityKey(customer?.phone) === threadKey].every(Boolean)) {
    return { ok: false, reason: 'customer_untrusted' };
  }
  const expectedReply = buildGratitudeReply(customer.first_name);
  const contractReason = validateGratitudeDraftContract(draft, { expectedReply, expectedPromptVersion });
  if (contractReason) return { ok: false, reason: contractReason };
  if (mediaCountFromMetadata(inbound.metadata) !== 0) return { ok: false, reason: 'media_or_unknown' };

  const from = inbound.from_phone;
  const to = inbound.to_phone;
  if (await gratitudeThreadAdvanced(dbh, { inboundId: inbound.id, fromPhone: from, toPhone: to })) {
    return { ok: false, reason: 'thread_advanced' };
  }
  const rows = await dbh('sms_log')
    .whereRaw("created_at >= (SELECT created_at FROM sms_log WHERE id = ?) - INTERVAL '24 hours'", [inbound.id])
    .whereRaw('created_at <= (SELECT created_at FROM sms_log WHERE id = ?)', [inbound.id])
    .whereRaw(`(
      (direction = 'inbound'
        AND ${phoneIdentitySql("BTRIM(COALESCE(from_phone, ''))")} = ?
        AND ${phoneIdentitySql("BTRIM(COALESCE(to_phone, ''))")} = ?)
      OR
      (direction = 'outbound'
        AND ${phoneIdentitySql("BTRIM(COALESCE(from_phone, ''))")} = ?
        AND ${phoneIdentitySql("BTRIM(COALESCE(to_phone, ''))")} = ?
        AND status IN ('sent','delivered'))
    )`, [threadKey, endpointKey, endpointKey, threadKey])
    .orderBy('created_at', 'desc').limit(201)
    .select('id', 'direction', 'message_body', 'message_type', 'status', 'metadata', 'created_at');
  if (rows.length > 200) return { ok: false, reason: 'context_truncated' };
  const history = rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    body: row.message_body,
    messageType: jsonObject(row.metadata)?.original_message_type || row.message_type,
    // Set at send time only for Comms-composer bodies (services/twilio.js);
    // 'manual' by itself is also written by automated senders.
    humanAuthored: jsonObject(row.metadata)?.human_authored === true,
    createdAt: row.created_at,
    mediaCount: mediaCountFromMetadata(row.metadata),
    // Provider row of a /schedule-sms send; names the queued row it delivered.
    scheduledSourceId: jsonObject(row.metadata)?.scheduled_sms_log_id ?? null,
  }));
  const pendingWork = await pendingGratitudeWork(dbh, { customerId: customer.id, threadKey });
  const policy = evaluateGratitudeContext({
    inbound: { id: inbound.id, direction: inbound.direction, body: inbound.message_body, createdAt: inbound.created_at, mediaCount: 0 },
    history, firstName: customer.first_name, contextComplete: true, pendingWork,
  });
  const policyFailure = [
    [() => !policy.eligible, () => policy.reason || 'policy_rejected'],
    [() => policy.reply !== expectedReply, () => policy.reason || 'policy_rejected'],
  ].find(([rejected]) => rejected());
  if (policyFailure) return { ok: false, reason: policyFailure[1]() };
  return { ok: true, draft, inbound, customer, expectedReply, threadKey };
}

module.exports = {
  jsonObject,
  jsonArray,
  gratitudeActivation,
  gratitudeClaimsPossible,
  gratitudeRolloutSettled,
  GRATITUDE_ROLLOUT_SETTLE_MS,
  validateGratitudeDraftContract,
  mediaCountFromMetadata,
  pendingGratitudeWork,
  gratitudeThreadAdvanced,
  gratitudeFinalState,
  readGratitudeContext,
};
