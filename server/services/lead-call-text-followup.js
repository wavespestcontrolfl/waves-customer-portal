/**
 * Lead call/text follow-ups (GATE_LEAD_CALL_TEXT_FOLLOWUP, off unless exactly
 * 'true'). Owner 2026-10-24, wording approved word for word:
 *
 *   TEXT, any hour:   "Great, we can handle it by text! What service(s) are you interested in?"
 *   CALL after hours: "Got it! What time tomorrow works best for us to call you?"
 *   a clear time:     "You're all set. We'll call you tomorrow at 10:00 AM."
 *
 * Never "we're closed" (owner: "we are open 24 hrs"). A daytime CALL is the
 * ring's job (lead-call-reply-ring.js); here it only cancels an open time ask.
 *
 * The time answer books a 15-minute slot (8:00 AM to 7:45 PM ET). A slot
 * another lead already holds moves this one to the next free slot, and the
 * confirmation names the booked time. An unclear answer, a time outside
 * 8 AM-8 PM, a day with no free slot after the time, or our own text that
 * did not send, raises one Leads bell instead of a text. The reminder texts
 * and the call at the booked time are a later change (part 2b); until it
 * lands this gate stays off.
 *
 * Only a reply to OUR lead text counts (the ring's own check), never an
 * existing customer, one follow-up of each kind per phone per 24 h, one open
 * follow-up per phone, one booked call per slot (lead_callback_requests).
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { parseCallTextReply } = require('./sms-service-intent');
const { etParts, etDateString, addETDays, parseETDateTime, formatETTime, dateOnlyString } = require('../utils/datetime-et');

const ENTRY_POINT = 'lead_call_text_followup';
const TEXT_REPLY_BODY = 'Great, we can handle it by text! What service(s) are you interested in?';
const NIGHT_CALL_BODY = 'Got it! What time tomorrow works best for us to call you?';
const ONE_PER_KIND_WINDOW_MS = 24 * 60 * 60 * 1000;
const ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIRST_SLOT_MINUTES = 8 * 60;
const LAST_SLOT_MINUTES = 19 * 60 + 45;
const SLOT_MINUTES = 15;
// Same set as lead-call-reply-ring.js: a row in one of these is a customer.
const REAL_CUSTOMER_STAGES = ['active_customer', 'won', 'at_risk'];

function phoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function inCallHours(now) {
  const { hour } = etParts(now);
  return hour >= 8 && hour < 20;
}

function fullName(customer) {
  return [customer?.first_name, customer?.last_name]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ') || 'a lead';
}

// ── Time answers ─────────────────────────────────────────────────────────
// Words around a time that change nothing: "10am works", "around 2 please".
const FILLER = /\b(?:tomorrow|tmrw|tmr|works?|working|would|be|is|are|good|great|fine|perfect|ok|okay|sure|yes|yeah|yep|please|pls|plz|thanks?|thank you|ty|around|about|at|by|maybe|probably|sounds|that|for|me|best|time|call|any|anytime|o'?clock|ish)\b/g;
// "after 10", "before noon", "between 10 and 12", "10-11": a range, not a time.
const RANGE = /\b(?:after|before|between|until|till|til|or|and|from|to|later|earlier|whenever|any ?time)\b|\d\s*-\s*\d/;

/**
 * A single clock time from a short reply. Returns { minutes } (minutes after
 * midnight ET), or null when the reply is not one plain time. A bare hour
 * reads 8-11 as morning and 12-7 as afternoon (calls run 8 AM-8 PM).
 */
function parseCallTime(text) {
  if (typeof text !== 'string') return null;
  let s = text.toLowerCase().replace(/[’']/g, "'").replace(/[.,!?;]+/g, ' ').trim();
  if (!s || s.length > 60) return null;
  if (RANGE.test(s)) return null;
  s = s.replace(/\b12\s*noon\b|\bnoon\b|\bmidday\b/g, '12:00 pm');
  s = s.replace(/\bin the (?:morning)\b|\bmorning\b/g, ' am ').replace(/\bin the (?:afternoon|evening)\b|\bafternoon\b|\bevening\b|\btonight\b/g, ' pm ');
  s = s.replace(/\ba\s*m\b/g, 'am').replace(/\bp\s*m\b/g, 'pm');
  s = s.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s+(am|pm))?$/.exec(s);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] == null ? 0 : Number(m[2]);
  const meridiem = m[3] || m[4] || null;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
  else if (meridiem === 'pm') hour = hour === 12 ? 12 : hour + 12;
  else hour = hour >= 8 && hour <= 11 ? hour : (hour === 12 ? 12 : hour + 12);
  return { minutes: hour * 60 + minute };
}

// The ET day a night ask is for: after 8 PM it is the next day. Between
// midnight and 8 AM "tomorrow" is read as the coming morning (a lead texting
// at 1 AM means after they sleep), so the day is today; the confirmation
// names it ("today at 10:00 AM"), so the lead sees which day was booked.
function targetDateFor(askedAt) {
  return etParts(askedAt).hour >= 20 ? etDateString(addETDays(askedAt, 1)) : etDateString(askedAt);
}

function slotInstant(date, minutes) {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return parseETDateTime(`${date}T${hh}:${mm}`);
}

// ── Eligibility ──────────────────────────────────────────────────────────
async function closeStaleRows(digits, now, conn = db) {
  const phoneMatch = ["RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ?", [digits]];
  await conn('lead_callback_requests').where({ state: 'asked' }).whereRaw(...phoneMatch)
    .where('created_at', '<', new Date(now.getTime() - ANSWER_WINDOW_MS))
    .update({ state: 'cancelled', updated_at: now });
}

async function sentKindRecently({ digits, kind, now }, conn = db) {
  return conn('lead_callback_requests')
    .where({ kind })
    .whereRaw("RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ?", [digits])
    .where('created_at', '>=', new Date(now.getTime() - ONE_PER_KIND_WINDOW_MS))
    .whereNot({ send_outcome: 'not_sent' })
    .first('id');
}

async function newestLeadId(customerId) {
  const lead = await db('leads').where({ customer_id: customerId }).whereNull('deleted_at')
    .orderBy('created_at', 'desc').first('id');
  return lead?.id || null;
}

// ── Sending ──────────────────────────────────────────────────────────────
async function sendFollowup({ customer, phone, body, kind, requestId }) {
  const { sendCustomerMessage } = require('./messaging/send-customer-message');
  const { isRealProviderSend, isAmbiguousProviderOutcome } = require('./sms-auto-send');
  let result;
  try {
    result = await sendCustomerMessage({
      to: phone,
      body,
      channel: 'sms',
      audience: 'lead',
      purpose: 'conversational',
      customerId: customer.id,
      identityTrustLevel: 'phone_matches_customer',
      entryPoint: ENTRY_POINT,
      metadata: {
        original_message_type: 'auto_reply',
        templateKey: `${ENTRY_POINT}_${kind}`,
        leadCallbackRequestId: requestId,
      },
    });
  } catch (err) {
    result = err?.providerOutcome && typeof err.providerOutcome === 'object' ? err.providerOutcome : null;
    if (!result) {
      logger.warn(`[lead-call-text-followup] send threw for customer ${customer.id} (${String(err?.code || err?.name || 'error')})`);
      return 'uncertain';
    }
  }
  if (result?.sent && isRealProviderSend(result)) return 'sent';
  if (isAmbiguousProviderOutcome(result)) return 'uncertain';
  return 'not_sent';
}

async function raiseLeadBell({ customer, leadId, requestId, why }) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const { fitAction } = require('./admin-alert-names');
  try {
    await raiseAdminAlert('lead', {
      area: 'Leads',
      action: fitAction('Leads', fullName(customer), [(who) => `call ${who} back`, (who) => `call ${who}`]),
      why,
      severity: 'needs-you',
      link: leadId ? `/admin/leads?lead=${leadId}` : `/admin/customers?customerId=${encodeURIComponent(customer.id)}`,
      subject: leadId ? { type: 'lead', id: String(leadId) } : { type: 'customer', id: String(customer.id) },
      doneWhen: 'lead_contacted',
      who: 'person',
    }, { bell: true, dedupeKey: `lead-call-text-followup:${requestId}`, metadata: { leadId, customerId: customer.id, leadCallbackRequestId: requestId } });
  } catch (err) {
    logger.warn(`[lead-call-text-followup] bell failed for customer ${customer.id} (${String(err?.code || err?.name || 'error')})`);
  }
}

// Settles only a row still in the claimed state: a TEXT answer or a
// daytime CALL that cancelled it while our text was going out wins.
async function settleSend(requestId, outcome, { sentState, now }) {
  await db('lead_callback_requests').where({ id: requestId, state: 'asked' }).update({
    send_outcome: outcome,
    state: outcome === 'not_sent' ? 'cancelled' : sentState,
    updated_at: now,
  });
  if (outcome !== 'not_sent') {
    await db('lead_callback_requests').where({ id: requestId }).whereNot({ state: 'asked' }).whereNull('send_outcome')
      .update({ send_outcome: outcome, updated_at: now });
  }
}

// ── Flows ────────────────────────────────────────────────────────────────
async function startFollowup({ customer, fromPhone, smsLogId, kind, now }) {
  const digits = phoneDigits(fromPhone);
  const { leadTextBlocker } = require('./lead-call-reply-ring');
  const blocker = await leadTextBlocker({ customer, digits, now });
  if (blocker) return { action: 'none', reason: blocker };
  const leadId = await newestLeadId(customer.id);

  // The once-a-day check and the claim share one per-phone lock, and the
  // claim commits before the text goes out: a second handler for the same
  // phone waits, then finds this row (in flight or sent) and stops.
  const claim = await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${ENTRY_POINT}:${digits}`]);
    if (await sentKindRecently({ digits, kind, now }, trx)) return { reason: 'sent_today' };
    const phoneMatch = ["RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ?", [digits]];
    // A TEXT answer replaces an open night ask: the lead chose text instead.
    if (kind === 'text_reply') {
      await trx('lead_callback_requests').where({ state: 'asked', kind: 'call_request' }).whereRaw(...phoneMatch)
        .update({ state: 'cancelled', updated_at: now });
    }
    const open = await trx('lead_callback_requests').whereIn('state', ['asked', 'scheduled']).whereRaw(...phoneMatch).first('id');
    if (open) return { reason: 'open_followup' };
    const [row] = await trx('lead_callback_requests').insert({
      customer_id: customer.id,
      lead_id: leadId,
      phone: fromPhone,
      kind,
      state: 'asked',
      request_sms_log_id: smsLogId,
      target_date: kind === 'call_request' ? targetDateFor(now) : null,
    }).returning(['id']);
    return { requestId: row.id };
  });
  if (!claim.requestId) return { action: 'none', reason: claim.reason };
  const { requestId } = claim;

  if (kind === 'text_reply') {
    // A lead whose intake state was cleared (a repeat form) gets it back, so
    // the service answer runs the quote flow like a first reply.
    await db('customers').where({ id: customer.id }).whereNull('lead_intake_status')
      .update({ lead_intake_status: 'awaiting_service', updated_at: now });
  }
  const body = kind === 'text_reply' ? TEXT_REPLY_BODY : NIGHT_CALL_BODY;
  const outcome = await sendFollowup({ customer, phone: fromPhone, body, kind, requestId });
  await settleSend(requestId, outcome, { sentState: kind === 'text_reply' ? 'done' : 'asked', now });
  if (outcome === 'not_sent') {
    await raiseLeadBell({
      customer, leadId, requestId,
      why: kind === 'text_reply'
        ? 'Replied TEXT to our lead text; our reply asking which service did not send.'
        : 'Replied CALL after 8 PM; our text asking for a call time did not send.',
    });
  }
  return { action: kind === 'text_reply' ? 'text_reply_sent' : 'time_asked', outcome };
}

// Books the first free slot at or after `minutes` on the request's day.
async function bookSlot(request, minutes, now) {
  for (let m = minutes; m <= LAST_SLOT_MINUTES; m += SLOT_MINUTES) {
    const at = slotInstant(request.target_date, m);
    if (at <= now) continue;
    try {
      const updated = await db('lead_callback_requests').where({ id: request.id, state: 'asked' })
        .update({ state: 'scheduled', scheduled_for: at, updated_at: now });
      return updated ? at : null;
    } catch (err) {
      if (err?.code !== '23505') throw err; // the slot is held: try the next one
    }
  }
  return null;
}

// target_date is a DATE: pg hands it back as midnight UTC, which ET would
// read as the day before. dateOnlyString keeps the calendar day.
function dateText(value) {
  return dateOnlyString(value) || '';
}

async function answerTimeAsk({ customer, request, body, smsLogId, now }) {
  const { whyWithQuote } = require('./admin-alert-names');
  await db('lead_callback_requests').where({ id: request.id })
    .update({ answer_sms_log_id: smsLogId, answer_text: String(body).slice(0, 500), updated_at: now });
  const toOwner = async (why) => {
    await db('lead_callback_requests').where({ id: request.id, state: 'asked' }).update({ state: 'needs_owner', updated_at: now });
    await raiseLeadBell({ customer, leadId: request.lead_id, requestId: request.id, why });
    return { action: 'owner_bell' };
  };

  const parsed = parseCallTime(body);
  if (!parsed) return toOwner(whyWithQuote({ lead: 'Asked for a call; their time reply: ', quote: String(body).trim() }));
  const asked = formatETTime(slotInstant(dateText(request.target_date), parsed.minutes));
  if (parsed.minutes < FIRST_SLOT_MINUTES || parsed.minutes > LAST_SLOT_MINUTES) {
    return toOwner(`Asked for a call at ${asked}, outside 8 AM to 8 PM; pick a time with them.`);
  }
  // Round up to the slot grid: 10:05 books 10:15.
  const start = Math.ceil(parsed.minutes / SLOT_MINUTES) * SLOT_MINUTES;
  const booked = await bookSlot({ ...request, target_date: dateText(request.target_date) }, start, now);
  if (!booked) return toOwner(`Asked for a call at ${asked}; no call slot is free after that time.`);

  const dayWord = etDateString(booked) === etDateString(now) ? 'today' : 'tomorrow';
  const confirm = `You're all set. We'll call you ${dayWord} at ${formatETTime(booked)}.`;
  const outcome = await sendFollowup({ customer, phone: request.phone, body: confirm, kind: 'call_confirm', requestId: request.id });
  if (outcome === 'not_sent') {
    await raiseLeadBell({ customer, leadId: request.lead_id, requestId: request.id, why: `Call booked for ${formatETTime(booked)}; our confirmation text did not send.` });
  }
  return { action: 'booked', scheduledFor: booked, outcome };
}

/**
 * Called by the SMS webhook after the ack for every inbound text the intake
 * machine did not consume. Returns { action, ... }. Never throws.
 */
async function handleLeadReply({ customer, body, fromPhone, smsLogId = null, now = new Date() }) {
  try {
    if (!isEnabled('leadCallTextFollowup')) return { action: 'none', reason: 'gate_off' };
    if (!customer?.id || typeof body !== 'string' || !body.trim()) return { action: 'none', reason: 'no_input' };
    if (!/^\+1\d{10}$/.test(String(fromPhone || ''))) return { action: 'none', reason: 'bad_phone' };
    const digits = phoneDigits(fromPhone);
    await closeStaleRows(digits, now);

    const choice = parseCallTextReply(body);
    if (choice === 'text') return startFollowup({ customer, fromPhone, smsLogId, kind: 'text_reply', now });
    if (choice === 'call') {
      if (inCallHours(now)) {
        // The ring calls them now; an open time ask is no longer needed.
        await db('lead_callback_requests').where({ state: 'asked', kind: 'call_request' })
          .whereRaw("RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ?", [digits])
          .update({ state: 'cancelled', updated_at: now });
        return { action: 'none', reason: 'ring_handles_day_call' };
      }
      return startFollowup({ customer, fromPhone, smsLogId, kind: 'call_request', now });
    }

    const open = await db('lead_callback_requests')
      .where({ state: 'asked', kind: 'call_request', customer_id: customer.id })
      .whereRaw("RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ?", [digits])
      .whereNot({ send_outcome: 'not_sent' })
      .orderBy('created_at', 'desc')
      .first();
    if (!open) return { action: 'none', reason: 'no_open_ask' };
    // Still a lead? A row that became a customer since the question closes.
    if (REAL_CUSTOMER_STAGES.includes(customer.pipeline_stage)) {
      await db('lead_callback_requests').where({ id: open.id, state: 'asked' }).update({ state: 'cancelled', updated_at: now });
      return { action: 'none', reason: 'existing_customer' };
    }
    return answerTimeAsk({ customer, request: open, body, smsLogId, now });
  } catch (err) {
    // Code only: a knex message carries the bindings (the phone digits).
    logger.error(`[lead-call-text-followup] failed for customer ${customer?.id} (${String(err?.code || err?.name || 'error')})`);
    return { action: 'none', reason: 'error' };
  }
}

module.exports = {
  handleLeadReply,
  parseCallTime,
  ENTRY_POINT,
  TEXT_REPLY_BODY,
  NIGHT_CALL_BODY,
  _test: { targetDateFor, slotInstant, bookSlot, dateText },
};
