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

async function pendingGratitudeWork(dbh, { customerId, threadLast10 }) {
  const openRequest = await dbh('service_requests').where({ customer_id: customerId })
    .whereNotIn(dbh.raw("COALESCE(status, 'new')"), ['resolved', 'closed', 'cancelled']).first('id');
  if (openRequest) return true;

  const openCallCommitment = dbh('call_commitments as cc')
    .join('call_log as cl', 'cc.call_log_id', 'cl.id')
    .where({ 'cc.status': 'open' })
    .where(function sameCustomerOrThread() {
      this.where('cl.customer_id', customerId);
      if (threadLast10) {
        this.orWhereRaw(`(
          RIGHT(REGEXP_REPLACE(COALESCE(cl.from_phone, ''), '[^0-9]', '', 'g'), 10) = ?
          OR RIGHT(REGEXP_REPLACE(COALESCE(cl.to_phone, ''), '[^0-9]', '', 'g'), 10) = ?
        )`, [threadLast10, threadLast10]);
      }
    });
  if (await openCallCommitment.first('cc.id')) return true;
  const openSmsCommitment = dbh('call_commitments as cc_sms')
    .join('sms_log as s_commitment', 'cc_sms.sms_log_id', 's_commitment.id')
    .where({ 'cc_sms.status': 'open' })
    .where(function sameCustomerOrThread() {
      this.where('s_commitment.customer_id', customerId);
      if (threadLast10) this.orWhereRaw("RIGHT(REGEXP_REPLACE(COALESCE(s_commitment.from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [threadLast10]);
    });
  if (await openSmsCommitment.first('cc_sms.id')) return true;

  const triage = dbh('triage_items as ti')
    .leftJoin('call_log as ti_call', 'ti.call_log_id', 'ti_call.id')
    .leftJoin('sms_log as ti_sms', 'ti.sms_log_id', 'ti_sms.id')
    .whereIn('ti.status', ['open', 'in_progress'])
    .where(function sameCustomerOrThread() {
      this.where('ti.related_customer_id', customerId)
        .orWhere('ti_call.customer_id', customerId)
        .orWhere('ti_sms.customer_id', customerId);
      if (threadLast10) {
        this.orWhereRaw(`(
          RIGHT(REGEXP_REPLACE(COALESCE(ti_call.from_phone, ''), '[^0-9]', '', 'g'), 10) = ?
          OR RIGHT(REGEXP_REPLACE(COALESCE(ti_call.to_phone, ''), '[^0-9]', '', 'g'), 10) = ?
          OR RIGHT(REGEXP_REPLACE(COALESCE(ti_sms.from_phone, ''), '[^0-9]', '', 'g'), 10) = ?
          OR RIGHT(REGEXP_REPLACE(COALESCE(ti_sms.to_phone, ''), '[^0-9]', '', 'g'), 10) = ?
        )`, [threadLast10, threadLast10, threadLast10, threadLast10]);
      }
    });
  if (await triage.first('ti.id')) return true;

  const operatorItem = dbh('operator_inbox_items as oi')
    .leftJoin('sms_log as oi_sms', function joinSmsSource() {
      this.on(dbh.raw("oi.source = 'sms'")).andOn(dbh.raw('oi_sms.id::text = oi.source_id'));
    })
    .whereIn('oi.status', ['open', 'snoozed'])
    .where(function sameCustomerOrThread() {
      this.where('oi.customer_id', customerId);
      if (threadLast10) {
        this.orWhereRaw(`(
          RIGHT(REGEXP_REPLACE(COALESCE(oi_sms.from_phone, ''), '[^0-9]', '', 'g'), 10) = ?
          OR RIGHT(REGEXP_REPLACE(COALESCE(oi_sms.to_phone, ''), '[^0-9]', '', 'g'), 10) = ?
        )`, [threadLast10, threadLast10]);
      }
    });
  if (await operatorItem.first('oi.id')) return true;

  const decision = dbh('agent_decisions as ad')
    .leftJoin('sms_log as s', 'ad.sms_log_id', 's.id')
    .whereIn('ad.status', ['pending_review', 'pending', 'scheduled', 'sending', 'initiated', 'active']);
  if (threadLast10) {
    decision.where(function pendingForCustomerOrThread() {
      this.where('ad.customer_id', customerId)
        .orWhereRaw("RIGHT(REGEXP_REPLACE(COALESCE(s.from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [threadLast10]);
    });
  } else {
    decision.where('ad.customer_id', customerId);
  }
  return Boolean(await decision.first('ad.id'));
}

async function gratitudeThreadAdvanced(dbh, { inboundId, fromPhone, toPhone, skipReservationId = null }) {
  if (!inboundId || !fromPhone || !toPhone) return true;
  const query = dbh('sms_log').whereNot('id', inboundId)
    // Any still-pending outbound owns the exchange, even if queued before
    // this inbound. Only the caller's exact reservation may be excluded.
    .whereRaw(`(created_at >= (SELECT created_at FROM sms_log WHERE id = ?)
      OR (direction = 'outbound' AND status IN ('queued','scheduled','sending')))`, [inboundId])
    .whereRaw(`(
      (direction = 'inbound' AND from_phone = ? AND to_phone = ?)
      OR
      (direction = 'outbound' AND from_phone = ? AND to_phone = ?
        AND status IN ('queued','sent','delivered','scheduled','sending'))
    )`, [fromPhone, toPhone, toPhone, fromPhone]);
  if (skipReservationId) query.whereNot('id', skipReservationId);
  return Boolean(await query.first('id'));
}

async function readGratitudeContext({
  draftId, smsLogId, expectedPromptVersion, now = new Date(), activatedAt = gratitudeActivation(), dbh,
} = {}) {
  if (!dbh) return { ok: false, reason: 'context_database_unavailable' };
  if (!activatedAt) return { ok: false, reason: 'activation_unset' };
  const draft = await dbh('message_drafts').where({ id: draftId }).first(
    'id', 'sms_log_id', 'customer_id', 'inbound_message', 'draft_response', 'intent',
    'status', 'model', 'prompt_version', 'intended_actions', 'flags', 'scheduling_intent', 'created_at'
  );
  if (!draft || draft.sms_log_id !== smsLogId) return { ok: false, reason: 'draft_source_mismatch' };
  const inbound = await dbh('sms_log').where({ id: smsLogId, direction: 'inbound' }).first(
    'id', 'customer_id', 'direction', 'from_phone', 'to_phone', 'message_body', 'metadata', 'created_at'
  );
  const sourceFailure = [
    [() => !inbound?.created_at || !inbound.from_phone || !inbound.to_phone, 'inbound_unavailable'],
    [() => draft.customer_id !== inbound.customer_id
      || draft.inbound_message !== inbound.message_body, 'immutable_source_mismatch'],
  ].find(([rejected]) => rejected());
  if (sourceFailure) return { ok: false, reason: sourceFailure[1] };
  const timing = gratitudeTimingReason({ inboundCreatedAt: inbound.created_at, now, activatedAt });
  if (timing) return { ok: false, reason: timing };

  const threadLast10 = String(inbound.from_phone).replace(/\D/g, '').slice(-10);
  if (!threadLast10) return { ok: false, reason: 'invalid_thread' };
  const customers = await dbh('customers').where({ active: true }).whereNull('deleted_at')
    .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [threadLast10])
    .limit(2).select('id', 'first_name', 'phone');
  if (customers.length !== 1 || customers[0].id !== draft.customer_id) return { ok: false, reason: 'customer_untrusted' };
  const customer = customers[0];
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
      (direction = 'inbound' AND from_phone = ? AND to_phone = ?)
      OR
      (direction = 'outbound' AND from_phone = ? AND to_phone = ? AND status IN ('sent','delivered'))
    )`, [from, to, to, from])
    .orderBy('created_at', 'desc').limit(201)
    .select('id', 'direction', 'message_body', 'message_type', 'status', 'metadata', 'created_at');
  if (rows.length > 200) return { ok: false, reason: 'context_truncated' };
  const history = rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    body: row.message_body,
    messageType: jsonObject(row.metadata)?.original_message_type || row.message_type,
    createdAt: row.created_at,
    mediaCount: mediaCountFromMetadata(row.metadata),
  }));
  const pendingWork = await pendingGratitudeWork(dbh, { customerId: customer.id, threadLast10 });
  const policy = evaluateGratitudeContext({
    inbound: { id: inbound.id, direction: inbound.direction, body: inbound.message_body, createdAt: inbound.created_at, mediaCount: 0 },
    history, firstName: customer.first_name, contextComplete: true, pendingWork,
  });
  if (!policy.eligible || policy.reply !== expectedReply) return { ok: false, reason: policy.reason || 'policy_rejected' };
  return { ok: true, draft, inbound, customer, expectedReply, threadLast10 };
}

module.exports = {
  jsonObject,
  jsonArray,
  gratitudeActivation,
  validateGratitudeDraftContract,
  mediaCountFromMetadata,
  pendingGratitudeWork,
  gratitudeThreadAdvanced,
  readGratitudeContext,
};
