/**
 * Intelligence Bar — schedule one customer text for later
 * server/services/intelligence-bar/schedule-sms-tools.js
 *
 * Gap 5 (owner ruling 2026-10-28, B1): a card that replays the Communications page's own "schedule a text"
 * (POST /admin/communications/schedule-sms) through the shared writer both call,
 * services/scheduled-sms-queue.js scheduleCustomerSms: every route guard (translation trial, applicant texts,
 * explicit customer context, street-level hold, marketing and retention refusal, immediate-only links, the Waves
 * from number, the Agent Review draft claim, a future time) and its one transaction. The bar sends no Agent Review
 * draft, reply context, linked visit or translation trial, so those inputs never reach the writer from here.
 *
 *   schedule_sms — one plain customer text to the customer's own number at one day and time.
 *
 * OWNER RULING B1 (2026-10-28), binding: a time from the bar between 8:00 PM and 8:00 AM Eastern is REFUSED and the
 * bar asks for a time from 8 AM to 8 PM. The bar is mostly voice and "at 9" can mean 9 AM or 9 PM.
 *
 * THE BOUNDARY (the dispatcher decides it, not the clock): the scheduled-text sender (scheduler.js, node-cron
 * '*\/5 * * * *') runs every five minutes, at minutes ending in 0 or 5, and sends a queued operator text at the first
 * run on or after its time, with no quiet-hours check (operator rows bypass it). So a text for 10:01 goes at 10:05,
 * and a text for 7:59 PM would go at 8:00 PM, at night. node-cron here also drops a tick under load. The bar therefore
 * accepts 8:00 AM ET through 7:45 PM ET inclusive and refuses 7:46 PM and later (and midnight to 7:59 AM):
 * 7:45 PM goes at the 7:45 run, and still leaves before 8:00 PM if the 7:45 and 7:50 runs are both missed (7:55 is the
 * third). 7:50 PM would survive only one missed run with no room for send time. 8:00 AM is the first accepted minute
 * because a run never sends before the time. The dispatcher and the Communications page keep their behavior (the page
 * may schedule any minute); "send now" at night is not part of this tool. The card says "goes out on the first
 * five-minute check on or after" the time, never "at that exact minute".
 *
 * Always a confirm card, on every login (it texts a customer): never owner-direct, admin only, dark behind
 * GATE_IB_SCHEDULE_SMS (which needs GATE_IB_PLATFORM).
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins what the card showed: the customer id, the
 *                  number the text goes to, the From number, a digest of the exact text, and the send time.
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then runs the shared writer.
 *                  Inside the writer's own thread lock the customer row is re-read (live, same phone) and an identical
 *                  queued text is looked for, so a changed number refuses with nothing written and a repeated Confirm
 *                  queues one text.
 *
 * The queued row is the page's own row shape (message_type manual, admin_user_id, metadata human_authored), so
 * list_queued_messages lists it and cancel_queued_message can cancel it. That holds only while no Agent Review
 * suggestion is pending on the customer's thread: the writer would park it and stamp parked_decision_ids on the text,
 * which the bar's list and cancel refuse. So the card is refused (and Confirm re-checks under the lock) while one waits.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const TWILIO_NUMBERS = require('../../config/twilio-numbers');
const { parseETDateTime, validCalendarDate, formatETDay, formatETDate, formatETTime, etParts } = require('../../utils/datetime-et');

function scheduleSmsLive() {
  return require('../../config/feature-gates').ibScheduleSmsLive() === true;
}

const MESSAGE_MAX_CHARS = 1600;

const SCHEDULE_SMS_TOOLS = [
  {
    name: 'schedule_sms',
    description: `Schedule ONE text message to a customer for a later day and time (the Communications page "Schedule send"). The first call returns a PREVIEW and writes nothing: the exact text, the customer, the number it goes to (last 4 digits), the From number, and the send day and time in words in Eastern Time. The operator approves on the confirmation card; nothing is sent now. The text goes out on the first five-minute check on or after that time (within about 5 minutes) unless it is cancelled first (list_queued_messages, then cancel_queued_message) or the customer has opted out by then.
TIME RULE (owner ruling): only a time from 8:00 AM through 7:45 PM Eastern can be scheduled. Any later time, and any time before 8:00 AM, is refused. Texts go out on a check that runs every five minutes, so a text goes out within about 5 minutes after its time (never before it). The operator is often speaking, and "at 9" can mean 9 AM or 9 PM, so if the operator did not say AM or PM (or morning, evening, noon), ASK which one before you call. Never guess AM or PM. When the answer is a night time or after 7:45 PM, ask for a time from 8 AM to 7:45 PM instead. Pass send_date as YYYY-MM-DD and send_time as 24-hour HH:MM, both Eastern Time; work the weekday from today's date, never from memory.
Refused with the reason: a time that is not in the future, a customer with no phone or an opted-out or blocked number, a link that only works on an immediate send (Auto Pay, contract signing, card request, statement, review request), a marketing or promotional text, an applicant's number. A reply taken from the Agent Review or translation cards is sent now, not scheduled. Admin only. This tool does NOT send now: "text them now" is send_sms.
Use for: "text Henderson tomorrow at 10 AM that we're on our way", "schedule a reminder text for Smith Thursday at 9:30 AM", "send the Millers a text Monday morning at 8".`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The customer to text (from query_customers)' },
        customer_name: { type: 'string', description: 'Or the customer name (use customer_id when you have it)' },
        message: { type: 'string', description: 'The exact text to send, as the operator wants it worded' },
        send_date: { type: 'string', format: 'date', description: 'Day to send, YYYY-MM-DD, Eastern Time' },
        send_time: { type: 'string', description: 'Time to send, 24-hour HH:MM, Eastern Time. 08:00 to 19:59 only.' },
      },
      required: ['message', 'send_date', 'send_time'],
    },
    _sideEffects: true,
  },
];

const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const digits = (value) => String(value || '').replace(/\D/g, '');
const digest = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 32);
const last4 = (phone) => digits(phone).slice(-4) || null;
const last10 = (phone) => (digits(phone).length >= 10 ? digits(phone).slice(-10) : null);
const threadHasPendingSuggestion = (phoneLast10, dbh) => require('../sms-suggest-mode').threadHasPendingSuggestion(phoneLast10, dbh);
const nameOf = (c) => [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim() || c?.company_name || null;

const SUGGESTION_PENDING_REFUSAL = 'This customer has a suggested reply waiting on their thread (Agent Review). Scheduling a text now would tie it to that suggestion, and the bar could not cancel it. Handle the suggested reply on the Communications page first, then ask again. Nothing was scheduled.';

// The accepted clock, in Eastern minutes of the day: 8:00 AM through 7:45 PM (see THE BOUNDARY above).
const EARLIEST_ET_MINUTE = 8 * 60;
const LATEST_ET_MINUTE = 19 * 60 + 45;

function inBarWindowET(at) {
  const { hour, minute } = etParts(at);
  const minuteOfDay = hour * 60 + minute;
  return minuteOfDay >= EARLIEST_ET_MINUTE && minuteOfDay <= LATEST_ET_MINUTE;
}

const NIGHT_TIME_REFUSAL = 'A text from the bar can only be scheduled for a time from 8:00 AM through 7:45 PM Eastern. That time is outside it: texts go out on a check that runs every five minutes, so 7:45 PM is the latest time that always leaves before 8 PM, and the bar does not schedule from 8 PM to 8 AM at all ("at 9" could mean morning or evening). Ask the operator for a time from 8 AM to 7:45 PM, and ask AM or PM if they did not say. Nothing was scheduled.';

// "Thursday, October 30 at 10:00 AM", in Eastern Time.
function sendTimeInWords(at) {
  return `${formatETDay(at)}, ${formatETDate(at)} at ${formatETTime(at)}`;
}

// The send time the call names, as an instant: a strict ET day and 24-hour clock (an ISO string with an offset is
// never taken), inside the bar's 8:00 AM to 7:45 PM window and in the future.
function resolveSendTime(input) {
  const date = String(input?.send_date || '').trim();
  const time = String(input?.send_time || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !validCalendarDate(date)) return refusal('send_date must be a real day in YYYY-MM-DD form (Eastern Time). Ask the operator for the day.', 'invalid_send_time');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return refusal('send_time must be a 24-hour HH:MM clock time (Eastern Time). Ask the operator for the time, with AM or PM.', 'invalid_send_time');
  const at = parseETDateTime(`${date}T${time}`);
  if (Number.isNaN(at.getTime())) return refusal('That day and time could not be read. Ask the operator again.', 'invalid_send_time');
  if (!inBarWindowET(at)) return refusal(NIGHT_TIME_REFUSAL, 'night_time_refused');
  if (at <= new Date()) return refusal('That time has already passed. Ask the operator for a day and time in the future. Nothing was scheduled.', 'send_time_in_the_past');
  return { at };
}

// The one live customer the call names, with the number the text will go to.
async function resolveRecipient(input) {
  const rawId = String(input?.customer_id || '').trim();
  let customer;
  if (rawId) {
    if (!UUID_RE.test(rawId)) return refusal('A valid customer_id is required', 'invalid_target');
    customer = await db('customers').where({ id: rawId.toLowerCase() }).whereNull('deleted_at').first();
  } else if (String(input?.customer_name || '').trim()) {
    const found = await require('./comms-tools').resolveCustomer({ customer_name: String(input.customer_name).trim() });
    if (found?.error) return found;
    customer = found;
  } else {
    return refusal('Give a customer_id or a customer_name', 'invalid_target');
  }
  if (!customer || customer.deleted_at) return refusal('No customer matches. Nothing was scheduled.', 'customer_not_found');
  if (!digits(customer.phone)) return refusal('This customer has no phone number, so no text can be scheduled. Nothing was scheduled.', 'no_phone');
  return { customer };
}

// Everything the card approves: a change in any of it is drift.
function versionOf({ customer, from, message, at }) {
  return {
    customer_id: customer.id,
    // A digest, never the number: the pin rides into the model's context and the stored card.
    to: digest(digits(customer.phone)),
    from,
    text_digest: digest(message),
    send_at: at.getTime(),
  };
}

async function buildPlan(input) {
  const message = typeof input?.message === 'string' ? input.message.trim() : '';
  if (!message) return refusal('The text to send is missing. Ask the operator what it should say.', 'message_required');
  if (message.length > MESSAGE_MAX_CHARS) return refusal(`The text is longer than ${MESSAGE_MAX_CHARS} characters. Shorten it. Nothing was scheduled.`, 'message_too_long');
  const time = resolveSendTime(input);
  if (time.error) return time;
  const target = await resolveRecipient(input);
  if (target.error) return target;
  const { customer } = target;
  const from = TWILIO_NUMBERS.getOutboundNumber();
  if (!TWILIO_NUMBERS.findByNumber(from)) return refusal('The Waves number this text would go from is not available. Nothing was scheduled.', 'from_number_unavailable');
  // The route's own link fence, and the send path's consent, suppression and composer-only-link checks: no card for a
  // text that cannot be queued or could not go out.
  const { scheduledSmsLinkRefusal } = require('../scheduled-sms-queue');
  const linkRefusal = await scheduledSmsLinkRefusal(message, customer.phone);
  if (linkRefusal) return refusal(`${linkRefusal.error}. Nothing was scheduled.`, linkRefusal.status === 503 ? 'link_unverified' : 'link_not_schedulable');
  // The writer repeats the commit-phase link check inside its lock; run it here too so a link built for another
  // customer never gets a card that Confirm would refuse (read-only: the composer-only links are already refused above).
  const foreignLink = await require('./comms-tools').customerLinkSendRefusal(message, customer.phone, customer.id, { phase: 'commit' });
  if (foreignLink) return refusal(`${foreignLink.error} Nothing was scheduled.`, foreignLink.code || 'link_not_schedulable');
  const blocked = await require('./comms-tools').sendSmsProposalRefusal({ customer_id: customer.id, phone: customer.phone, message, message_type: 'manual' });
  if (blocked) return { ...blocked, error: `${blocked.error || 'This text cannot go out.'} Nothing was scheduled.`, code: blocked.code || 'send_blocked' };
  // A suggested reply waiting on this thread would be parked by the queued text, which then cannot be listed or
  // cancelled from the bar (it is tied to an Agent Review suggestion). So the bar does not schedule over one.
  if (await threadHasPendingSuggestion(last10(customer.phone))) return refusal(SUGGESTION_PENDING_REFUSAL, 'suggestion_pending');
  const name = nameOf(customer);
  const when = sendTimeInWords(time.at);
  const plan = {
    preview: true,
    tool: 'schedule_sms',
    customer_id: customer.id,
    customer_name: name,
    to_last4: last4(customer.phone),
    from_number: from,
    message,
    send_at: time.at.toISOString(),
    send_time_et: when,
    sends_now: false,
    effects: [
      { kind: 'comms', text: `Text ${name || 'the customer'} (…${last4(customer.phone)}) from ${from}: “${message}”` },
      { kind: 'operational', text: `Queued for ${when} Eastern. It goes out on the first five-minute check on or after that time, so within about 5 minutes after it (never before). Nothing is sent now.` },
      { kind: 'operational', text: 'It stays in the customer\'s scheduled texts until then: list_queued_messages shows it and cancel_queued_message cancels it before it goes. It will not send if the customer opts out first.' },
    ],
    _version: versionOf({ customer, from, message, at: time.at }),
    note: 'PREVIEW ONLY — nothing was scheduled. Confirm queues exactly this text for exactly this time; if anything changed it refuses.',
  };
  // What the confirmed run acts on, kept off the preview's own keys: the full number never rides in the card or the pin.
  Object.defineProperty(plan, '_target', { value: { customerId: customer.id, to: customer.phone, from, message, sendAt: time.at }, enumerable: false });
  return plan;
}

// The re-derived plan when it still matches the card's pin, or the refusal.
async function verifiedPlan(input, pinned) {
  if (!pinned) return { refusal: refusal('Use the confirmation card to approve this text.', 'approval_required') };
  const plan = await buildPlan(input);
  if (plan.error) return { refusal: { ...plan, error: `Nothing was scheduled: ${plan.error}`, preview_changed: true } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: 'The customer, number, text or time changed after the card was shown, so nothing was scheduled. Ask again for a fresh confirmation card.', code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

// The identical text already queued for this customer at this minute (a repeated Confirm), read inside the lock. It
// counts as THIS card's text only when the bar could list and cancel it: the shared standalone rule
// (comms-tools smsIneligibilityReason, the one list_queued_messages and cancel_queued_message use). A match tied to
// another workflow (an Agent Review decision, a recruiting reply, an invoice send, a send already attempted) is returned
// as `blocked` with that rule's reason, and the caller refuses instead of reporting it as cancelable.
async function alreadyQueued(trx, { customerId, to, from, message, sendAt }) {
  const rows = await trx('sms_log')
    .where({ customer_id: customerId, direction: 'outbound', status: 'scheduled', message_type: 'manual', from_phone: from, to_phone: to, scheduled_for: sendAt })
    .whereRaw('md5(message_body) = md5(?)', [message])
    .orderBy('created_at', 'asc')
    .select('id', 'scheduled_for', 'metadata', 'message_type', 'admin_user_id');
  const { smsIneligibilityReason } = require('./comms-tools');
  const usable = rows.find((row) => !smsIneligibilityReason(row));
  if (usable) return { row: usable };
  return rows.length ? { blocked: smsIneligibilityReason(rows[0]) } : {};
}

// Inside the writer's transaction, after its thread lock: the customer must still be live with the approved number
// (a phone edit between the card and Confirm refuses), and an identical queued text answers a repeated Confirm.
function underLockFor(plan, pinned) {
  const { customerId, to, from, message, sendAt } = plan._target;
  return async (trx) => {
    const live = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forShare().first('phone');
    if (!live || digest(digits(live.phone)) !== pinned.to) {
      return { refuse: { status: 409, code: 'preview_changed', error: 'The customer or their phone number changed after the card was shown. Nothing was scheduled.' } };
    }
    const { row: existing, blocked } = await alreadyQueued(trx, { customerId, to, from, message, sendAt });
    if (existing) return { existing: { id: existing.id, scheduledFor: existing.scheduled_for } };
    if (blocked) return { refuse: { status: 409, code: 'queued_text_not_cancelable', error: `An identical text is already queued for this customer at this time, but it belongs to another workflow, so it is not the text this card would schedule and the bar could not cancel it. ${blocked} Nothing was written. Cancel or let that text send from the Communications page first.` } };
    // A suggestion that arrived after the card: the writer parks every pending one on this thread (its publish takes
    // the same thread lock, so none can land between this read and that park). Refuse instead, nothing written.
    if (await threadHasPendingSuggestion(last10(to), trx)) return { refuse: { status: 409, code: 'suggestion_pending', error: SUGGESTION_PENDING_REFUSAL } };
    return null;
  };
}

async function commitSchedule(input, actionContext) {
  const { plan, refusal: refused } = await verifiedPlan(input, input._verified_schedule_sms_version);
  if (refused) return refused;
  const { customerId, to, from, message, sendAt } = plan._target;
  const base = { customer_id: customerId, customer_name: plan.customer_name, send_time_et: plan.send_time_et, sent_to_customer: false };
  let result;
  try {
    result = await require('../scheduled-sms-queue').scheduleCustomerSms(
      { to, body: message, scheduledFor: sendAt.toISOString(), customerId, fromNumber: from },
      { techRole: 'admin', technicianId: actionContext?.technicianId || null },
      { underLock: underLockFor(plan, input._verified_schedule_sms_version) },
    );
  } catch (err) {
    // The writer threw after the card was approved. Read the queue back: never invite a retry on an unknown outcome.
    const { row } = await alreadyQueued(db, { customerId, to, from, message, sendAt }).catch(() => ({}));
    if (row) return { ...base, success: true, state: 'scheduled', message_id: row.id, warning: true, note: 'The text is queued, but a follow-up step reported a problem. Check the customer\'s scheduled texts before trying again.' };
    logger.error(`[intelligence-bar:schedule-sms] writer failed (${err.code || err.name || 'error'})`);
    return { ...base, outcome_unknown: true, code: 'execution_interrupted', error: 'Scheduling was interrupted — the text may or may not be queued. Check the customer\'s scheduled texts before trying again.' };
  }
  const { status, body } = result;
  if (status !== 200) {
    const message_ = String(body?.error || 'the Communications page refused it');
    const drift = body?.code === 'preview_changed';
    return { ...base, failed: true, code: drift ? 'preview_changed' : (body?.code || 'schedule_refused'), error: `The text was not scheduled: ${message_}`, ...(drift ? { preview_changed: true } : {}) };
  }
  logger.info(`[intelligence-bar:schedule-sms] queued text ${body.id} for customer ${customerId}`);
  return { ...base, success: true, state: 'scheduled', message_id: body.id, scheduled_for: body.scheduledFor, already_queued: body.alreadyQueued === true,
    note: `Queued for ${plan.send_time_et} Eastern. Nothing was sent now. It shows in the customer's scheduled texts and can be cancelled before it goes.` };
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (toolName !== 'schedule_sms' || !preview || preview.preview !== true) return [];
  return (preview.effects || []).map(({ kind, text }) => ({ kind, text }));
}

async function executeScheduleSmsTool(toolName, input = {}, actionContext = {}) {
  if (!SCHEDULE_SMS_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the requireAdmin-grade schedule route; the registry refuses a technician too. The confirmed
  // run needs a positive admin flag (fail closed).
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Scheduling a customer text is limited to admin accounts', 'permission_denied');
  }
  if (!scheduleSmsLive()) return refusal('Scheduling a text from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitSchedule(input, actionContext) : await buildPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:schedule-sms] ${toolName} failed (${err.code || err.name || 'error'})`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'Scheduling was interrupted — the text may or may not be queued. Check the customer\'s scheduled texts before trying again.' }
      : { error: 'Could not prepare the scheduled text' };
  }
}

module.exports = {
  SCHEDULE_SMS_TOOLS,
  executeScheduleSmsTool,
  scheduleSmsLive,
  cardLines,
  sendTimeInWords,
  NIGHT_TIME_REFUSAL,
  SUGGESTION_PENDING_REFUSAL,
};
