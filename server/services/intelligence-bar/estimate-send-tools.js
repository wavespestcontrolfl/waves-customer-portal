/**
 * Intelligence Bar — send an existing draft estimate from the bar (owner ruling
 * 2026-11-24: "send an estimate from the bar").
 *
 *   send_estimate   the estimate page's Send dialog, for ONE unsent draft, sent
 *                   now: GET /api/admin/estimates/:id/send-preview builds the card
 *                   and POST /api/admin/estimates/:id/send sends, both run through
 *                   the routes' own handlers (routes/admin-estimates.js
 *                   estimateSendPreviewForBar / sendEstimateFromBar). The preview,
 *                   the messageVersion and expectedEditVersion review pins, the send
 *                   attempt record, ESTIMATE_REVIEW_STALE, SEND_OUTCOME_UNCERTAIN, the
 *                   pricing-authority gate and sendEstimateNow are the route's own.
 *                   Nothing here re-implements one of them, and the route's refusal
 *                   (any 4xx) is returned in its own words, never retried.
 *
 * A two-step write (write-gates.js WRITE_TWO_STEP): the unconfirmed call is a PREVIEW
 * that sends nothing; /confirm-action re-runs it, refuses on any drift, and this file
 * then re-derives the card once more and compares it with the pinned `_version`
 * before the route's handler runs. Always a confirm card, admin only, never
 * owner-direct. Dark behind GATE_IB_SEND_ESTIMATE.
 *
 * The send attempt identifier is the pending action's id (actionContext.operationId):
 * one per card, so a second Confirm of the same card is the route's own replay and
 * never a second message. It is not part of the card, which must read the same on
 * every re-run.
 *
 * Allow-list (everything else is refused with a plain reason): an unsent draft
 * (never sent, viewed, accepted, declined, expired, scheduled, sending), no estimate
 * group, not a commercial proposal, an immediate send, sendMethod sms / email / both.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { ibSendEstimateLive } = require('../../config/feature-gates');
const { UUID_RE } = require('./task-context');
const { maskPhone, maskEmail } = require('./closeout-repair-tools');
const { money } = require('./rate-change');

const SEND_METHODS = ['sms', 'email', 'both'];

const ESTIMATE_SEND_TOOLS = [
  {
    name: 'send_estimate',
    description: `Send ONE existing unsent DRAFT estimate to the customer from the bar, exactly as the estimate page's Send dialog does for an immediate send: a text, an email, or both. Use it when the operator says to send a quote that is already built ("send her the estimate", "text him the quote", "email the Smith estimate").
The first call is a PREVIEW and sends nothing. The confirmation card shows the estimate, the customer (first name and last initial), where it goes (masked phone and email), the channel, the exact text and email the customer will get, and the totals. Confirm sends it, once, and it cannot be unsent.
Refused with the reason: an estimate that is not an unsent draft (already sent, viewed, accepted, declined, expired, scheduled, sending), one that is part of a group, a commercial proposal, one the estimate page itself will not send (engine review, address, palm count, re-price hold), a channel with no phone, email or message, and any request to send later (no scheduled sends here). Admin only. Relay a refusal as it is.
send_method is optional: sms, email or both. Left out, it uses every channel the customer has (both when there is a phone and an email).
Use for: "send her the estimate", "text the quote to him", "email the lawn estimate to Pat".`,
    input_schema: {
      type: 'object',
      properties: {
        estimate_id: { type: 'string', format: 'uuid', description: 'estimates.id of the unsent draft estimate to send' },
        customer_id: { type: 'string', format: 'uuid', description: 'customers.id of the customer the operator named, when the estimate is linked to one — the estimate must belong to this customer' },
        send_method: { type: 'string', enum: SEND_METHODS, description: 'sms (text only), email (email only) or both. Optional: default is every channel the customer has.' },
      },
      required: ['estimate_id'],
    },
    _sideEffects: true,
  },
];

const uuid = (v) => (v == null ? '' : String(v).trim().toLowerCase());
const refuse = (error, code, extra = {}) => ({ error: `${error} Nothing was sent.`, code, ...extra });
// The estimate page's own refusal, in its own words (nothing added to the message).
const routeRefusal = (error, code, extra = {}) => ({ error: String(error), code, nothing_sent: true, ...extra });

// Anything that asks for a later send: this tool sends now, or not at all.
const SCHEDULE_KEYS = ['scheduledAt', 'scheduled_at', 'send_at', 'send_later', 'schedule_at'];

// What each non-draft status says, in the words an operator reads.
const STATUS_REFUSALS = {
  sent: ['That estimate was already sent to the customer.', 'estimate_already_sent'],
  viewed: ['That estimate was already sent and the customer has opened it.', 'estimate_already_sent'],
  accepted: ['That estimate was already accepted.', 'estimate_accepted'],
  declined: ['That estimate was declined.', 'estimate_declined'],
  expired: ['That estimate expired.', 'estimate_expired'],
  scheduled: ['That estimate is already scheduled to send.', 'estimate_scheduled'],
  sending: ['That estimate is being sent right now.', 'estimate_sending'],
  send_failed: ['An earlier send of that estimate failed. Check the estimate page before sending again.', 'estimate_send_failed'],
};

// "First L." — never the full name on a card.
function nameLabel(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

// The call's own refusals, before the row is read.
function inputRefusal(input) {
  const estimateId = uuid(input?.estimate_id);
  if (!estimateId || !UUID_RE.test(estimateId)) return refuse('A valid estimate_id is required.', 'invalid_target');
  if (input.customer_id != null && input.customer_id !== '' && !UUID_RE.test(uuid(input.customer_id))) return refuse('customer_id must be a valid id.', 'invalid_target');
  if (SCHEDULE_KEYS.some((key) => input[key] != null && input[key] !== '')) {
    return refuse('The bar can\'t schedule a send from here yet. It sends an estimate now, or not at all.', 'scheduled_send_unsupported');
  }
  if (input.send_method != null && !SEND_METHODS.includes(input.send_method)) {
    return refuse('send_method must be sms, email or both.', 'invalid_send_method');
  }
  return null;
}

// The narrow allow-list: an unsent, ungrouped, non-proposal draft the customer owns.
function draftRefusal(estimate, customerId) {
  if (customerId && estimate.customer_id && uuid(estimate.customer_id) !== customerId) {
    return refuse('That estimate belongs to a different customer than the one you named. Check which estimate to send.', 'estimate_customer_mismatch');
  }
  if (customerId && !estimate.customer_id) {
    return refuse('That estimate is not linked to the customer you named, so the bar can\'t send it from here. Check which customer the estimate belongs to.', 'estimate_customer_mismatch');
  }
  if (estimate.archived_at) return refuse('That estimate is archived, so the bar can\'t send it from here.', 'estimate_archived');
  const status = String(estimate.status || 'draft');
  if (STATUS_REFUSALS[status]) return refuse(...STATUS_REFUSALS[status]);
  if (status !== 'draft') return refuse(`That estimate is ${status}, not an unsent draft.`, 'estimate_not_draft');
  if (estimate.sent_at) return refuse('That estimate was already sent to the customer once, and the bar can\'t resend an estimate from here yet.', 'estimate_already_sent');
  if (estimate.scheduled_at) return refuse('That estimate is already scheduled to send.', 'estimate_scheduled');
  if (estimate.price_locked_at) return refuse('That estimate\'s price is locked, so it cannot be sent from here.', 'estimate_price_locked');
  if (estimate.estimate_group_id) return refuse('This estimate is part of a group, and the bar can\'t send a grouped estimate from here yet.', 'grouped_estimate');
  if (require('../estimate-manual-acceptance').isCommercialProposalEstimate(estimate)) {
    return refuse('This is a commercial proposal. The bar can\'t send proposals from here yet.', 'commercial_proposal');
  }
  return null;
}

// What the estimate page's own preview says blocks the send, in its own words.
function previewRefusal(preview) {
  if (preview.blockReason) return routeRefusal(preview.blockReason, 'page_refuses');
  if (preview.uncertainAttempt) {
    return refuse('An earlier send of this estimate has an uncertain outcome, so the bar can\'t send it again from here. Check its delivery records first.', 'send_outcome_uncertain');
  }
  // The dialog asks the operator to type the palm count from the aerial photo; the bar cannot.
  if (preview.satellitePalmCount != null) {
    return refuse('This estimate needs the palm count from the aerial photo typed in before it is sent, and the bar can\'t take that count from here yet.', 'palm_count_required');
  }
  return null;
}

// The channels the card sends on: the operator's choice, or every channel the
// customer has. A channel needs a deliverable address AND the route's own rendered message.
function channelsFor(preview, requested) {
  const smsReady = !!preview.customerPhone && !preview.smsBlockReason && !!preview.messages?.sms;
  const emailReady = !!preview.customerEmail && !!preview.messages?.email;
  const why = (channel) => {
    if (channel === 'sms') {
      if (!preview.customerPhone) return 'There is no phone number saved on this estimate.';
      if (preview.smsBlockReason) return preview.smsBlockReason;
      return 'The text template is unavailable.';
    }
    return preview.customerEmail ? 'The email template is unavailable.' : 'There is no email address saved on this estimate.';
  };
  const ready = { sms: smsReady, email: emailReady };
  if (requested) {
    const wanted = requested === 'both' ? ['sms', 'email'] : [requested];
    const missing = wanted.find((channel) => !ready[channel]);
    return missing ? refuse(`Cannot ${requested === 'both' ? 'send by both channels' : `send by ${missing === 'sms' ? 'text' : 'email'}`}: ${why(missing)}`, 'channel_unavailable') : { sendMethod: requested };
  }
  if (smsReady && emailReady) return { sendMethod: 'both' };
  if (smsReady) return { sendMethod: 'sms' };
  if (emailReady) return { sendMethod: 'email' };
  return refuse(`This estimate has no channel it can be sent on. Text: ${why('sms')} Email: ${why('email')}`, 'no_channel');
}

function totalsLine(estimate) {
  const parts = [];
  if (Number(estimate.monthly_total) > 0) parts.push(`${money(estimate.monthly_total)} a month`);
  if (Number(estimate.annual_total) > 0) parts.push(`${money(estimate.annual_total)} a year`);
  if (Number(estimate.onetime_total) > 0) parts.push(`${money(estimate.onetime_total)} one-time`);
  return parts;
}

// The whole card for one call, or { error, code } the model relays. Reads only.
async function planSend(input) {
  const bad = inputRefusal(input || {});
  if (bad) return bad;
  const estimate = await db('estimates').where({ id: uuid(input.estimate_id) }).first();
  if (!estimate) return refuse('No estimate with that id.', 'estimate_not_found');
  const blocked = draftRefusal(estimate, uuid(input.customer_id));
  if (blocked) return blocked;

  // The estimate page's own preview: the message, the review pins and what blocks the send.
  const reply = await require('../../routes/admin-estimates').estimateSendPreviewForBar({ estimateId: String(estimate.id) });
  const preview = reply.json || {};
  if (reply.status !== 200 || preview.error) return routeRefusal(preview.error || 'The estimate could not be checked.', preview.code || 'page_refuses');
  // Same row as the one checked above: a draft that moved on in between is refused.
  if (String(preview.status) !== 'draft' || !preview.editVersion || !preview.messageVersion) {
    return refuse('The estimate changed while it was being checked. Ask again for a fresh confirmation card.', 'estimate_changed', { preview_changed: true });
  }
  const refused = previewRefusal(preview);
  if (refused) return refused;
  const channel = channelsFor(preview, input.send_method);
  if (channel.error) return channel;
  return cardFor(estimate, preview, channel.sendMethod);
}

// The card: what is sent, to whom (masked), on which channel, the route's exact message, the totals and the pins.
function cardFor(estimate, preview, sendMethod) {
  const sms = sendMethod !== 'email';
  const email = sendMethod !== 'sms';
  return {
    preview: true,
    tool: 'send_estimate',
    estimate_id: String(estimate.id),
    customer_id: estimate.customer_id ? String(estimate.customer_id) : null,
    estimate: { label: `estimate ${String(estimate.token || estimate.id).slice(0, 8)}`, status: 'draft', tier: estimate.waveguard_tier || null, totals: totalsLine(estimate) },
    customer_name: nameLabel(estimate.customer_name) || 'the customer',
    send_method: sendMethod,
    channels: [sms && 'text', email && 'email'].filter(Boolean),
    recipients: { text: sms ? maskPhone(preview.customerPhone) : null, email: email ? maskEmail(preview.customerEmail) : null },
    sms_text: sms ? String(preview.messages.sms) : null,
    email_subject: email ? String(preview.messages.email.subject || '') : null,
    email_text: email ? String(preview.messages.email.text || '') : null,
    address: preview.address || null,
    // What approval binds: the saved estimate (its whole-row witness), the exact message the route
    // rendered, and the channel. Any change before Confirm refuses the card.
    _version: {
      estimate_id: String(estimate.id),
      edit_version: preview.editVersion,
      message_version: preview.messageVersion,
      send_method: sendMethod,
    },
    note_to_operator: 'PREVIEW ONLY — nothing was sent. Confirm sends it through the estimate page\'s Send.',
  };
}

// The route's reply in the tool's words. A refusal (4xx) keeps the route's own message.
function sendOutcome(preview, reply) {
  const { status, json = {} } = reply;
  const base = { estimate_id: preview.estimate_id, customer_id: preview.customer_id };
  const code = json.code || null;
  if (code === 'ESTIMATE_REVIEW_STALE') return { ...base, ...routeRefusal(json.error, code, { preview_changed: true }), failed: true, status };
  // Another send may be in flight or may have reached a provider: never invite a retry.
  if (code === 'SEND_OUTCOME_UNCERTAIN') return { ...base, outcome_unknown: true, code, error: `${json.error} Do not send it again until you have checked.`, status };
  const channels = json.channels || {};
  const results = Object.entries(channels).map(([channel, r]) => ({
    channel: channel === 'sms' ? 'text' : channel,
    status: r?.uncertain ? 'unknown' : (r?.ok && r.real !== false ? 'sent' : 'not_sent'),
    ...(r?.error ? { error: String(r.error) } : {}),
  }));
  if (results.some((r) => r.status === 'unknown')) {
    return { ...base, outcome_unknown: true, code: code || 'delivery_uncertain', channels: results,
      error: 'Delivery of the estimate could not be confirmed — it may or may not have gone out. Check the estimate page before sending again.', status };
  }
  if (status === 200 && json.success === true && json.sent === true) {
    const sentOn = results.filter((r) => r.status === 'sent').map((r) => r.channel);
    const missed = results.filter((r) => r.status === 'not_sent');
    // The page recorded the send but no provider took a message (a suppressed text reads ok, not real).
    if (!sentOn.length && json.replayed !== true) {
      return { ...base, failed: true, code: 'no_message_handed_off', channels: results,
        error: 'The estimate page recorded the send, but no message was handed to a provider (the text is switched off or suppressed). Check the estimate page before sending again.', status };
    }
    return {
      ...base, success: true, replayed: json.replayed === true, channels: results,
      ...(missed.length ? { warning: `The estimate went out by ${sentOn.join(' and ') || 'no channel'}, but not by ${missed.map((r) => r.channel).join(' and ')}.` } : {}),
      message: json.replayed === true
        ? `${preview.customer_name}'s ${preview.estimate.label} was already sent from this card. Nothing new was sent.`
        : `${preview.customer_name}'s ${preview.estimate.label} was sent by ${sentOn.join(' and ') || 'no channel'}.`,
    };
  }
  if (status === 200 && json.scheduled === true) {
    return { ...base, failed: true, code: 'unexpected_schedule', error: 'The estimate was scheduled instead of sent. Check the estimate page.', status };
  }
  // The route's own refusal, verbatim: a 4xx, or the 422 "not sent on any requested channel".
  return { ...base, failed: true, code: code || 'send_failed', channels: results, nothing_sent: true,
    error: String(json.error || 'The estimate was not sent on any requested channel.'), status };
}

async function commitSend(input, actionContext) {
  const pinned = input._verified_estimate_send_version;
  if (!pinned?.estimate_id) return refuse('Use the confirmation card to approve this send.', 'approval_required');
  const operationId = String(actionContext?.operationId || '').trim();
  if (!operationId) return refuse('This send has no approved card attached. Ask again for a fresh confirmation card.', 'approval_required');
  const plan = await planSend(input);
  if (plan.error) return { ...plan, preview_changed: true };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { error: 'The estimate, its message or its recipient changed after the card was shown. Nothing was sent. Ask again for a fresh confirmation card.', preview_changed: true };
  }
  // The estimate page's Send, through the route's own handler. The review pins ride in the body
  // as the dialog sends them: the route refuses a changed estimate or message (ESTIMATE_REVIEW_STALE)
  // on its own read, before any claim. No scheduledAt, no engine-review or uncertain-send
  // acknowledgement, no palm count: those are the operator's, on the page.
  const reply = await require('../../routes/admin-estimates').sendEstimateFromBar({
    estimateId: plan.estimate_id,
    body: {
      sendMethod: pinned.send_method,
      expectedEditVersion: pinned.edit_version,
      messageVersion: pinned.message_version,
      idempotencyKey: `bar-${operationId}`.slice(0, 120),
    },
  });
  const result = sendOutcome(plan, reply);
  logger.info(`[intelligence-bar:estimate-send] estimate ${plan.estimate_id}: ${result.success ? 'sent' : (result.code || 'not sent')}`);
  return result;
}

// ── Card lines (authorization-contract.js pushes them as they are) ──
function cardLines(toolName, preview) {
  if (toolName !== 'send_estimate' || !preview || preview.preview !== true) return [];
  const e = preview.estimate;
  const lines = [
    { kind: 'customer', text: `Sends ${e.label} to ${preview.customer_name}${e.tier ? ` (${e.tier})` : ''}` },
  ];
  if (preview.address) lines.push({ kind: 'customer', text: `Service address: ${preview.address}` });
  lines.push({ kind: 'billing', text: e.totals.length ? `Totals: ${e.totals.join(', ')}` : 'Totals: none on the estimate' });
  if (preview.recipients.text) lines.push({ kind: 'comms', text: `Text to ${preview.recipients.text}: ${preview.sms_text}` });
  if (preview.recipients.email) {
    lines.push({ kind: 'comms', text: `Email to ${preview.recipients.email}, subject: ${preview.email_subject}` });
    lines.push({ kind: 'comms', text: `Email text: ${String(preview.email_text).replace(/\s+/g, ' ').trim()}`, more: true });
  }
  lines.push({ kind: 'comms', text: 'Delivery replaces the full estimate link with a tracked secure link to the same estimate' });
  lines.push({ kind: 'operational', text: 'Sends now, once. The estimate becomes sent. It cannot be unsent' });
  return lines;
}

async function executeEstimateSendTool(toolName, input = {}, actionContext = {}) {
  if (toolName !== 'send_estimate') return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the requireAdmin estimate routes; the registry refuses a technician too.
  // The confirmed run needs a positive admin flag (fail closed).
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return { error: 'Sending estimates is limited to admin accounts', code: 'permission_denied' };
  }
  if (!ibSendEstimateLive()) {
    return refuse('Sending an estimate from the bar is not switched on yet (GATE_IB_SEND_ESTIMATE), so the bar can\'t do it from here yet.', 'send_estimate_not_enabled');
  }
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitSend(input, actionContext) : await planSend(input);
  } catch (err) {
    logger.error(`[intelligence-bar:estimate-send] ${toolName} failed (${err.code || err.name || 'error'}): ${err.message}`);
    // A throw after an approval may follow a sent message: never invite a retry.
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The send was interrupted — it may or may not have happened. Check the estimate page before trying again.' }
      : { error: 'Could not prepare the estimate send' };
  }
}

module.exports = { ESTIMATE_SEND_TOOLS, executeEstimateSendTool, cardLines, _private: { planSend, sendOutcome } };
