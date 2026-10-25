/**
 * Booked lead calls, part 2b (GATE_LEAD_CALL_TEXT_FOLLOWUP, the same gate as
 * lead-call-text-followup.js). Owner 2026-10-24, wording approved:
 *
 *   15 minutes before: the lead gets "Hi {First}, Adam from Waves here. I'll
 *     call you in about 15 minutes." and the owner gets a bell "Leads — call
 *     {Name} at 10:00 AM".
 *   At the time: Adam's cell rings with the press-1 bridge (the CALL ring's
 *     own placeRing); a missed ring raises its "Missed call request" bell.
 *   8 AM: a night CALL whose time question was never answered raises one
 *     bell, "Leads — call {Name} back". No ring at a time the lead did not pick.
 *
 * Runs every minute (scheduler.js, runExclusive). Each step claims its row
 * with a stamp before its side effect, so an overlapping tick never repeats
 * one. One ring at a time: while another lead ring is still live, the next
 * waits for the following tick. A ring more than 30 minutes late goes to the
 * owner instead. The lead reminder never goes before 8 AM (an 8:00 slot gets
 * the owner bell only).
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { inRingHours } = require('./lead-call-reply-ring');
const { etParts, etDateString, formatETTime } = require('../utils/datetime-et');

const REMINDER_LEAD_MS = 15 * 60 * 1000;
const RING_LATE_LIMIT_MS = 30 * 60 * 1000;
const ACTIVE_RING_WINDOW_MS = 15 * 60 * 1000;
const RECENT_CALL_WINDOW_MS = 10 * 60 * 1000;
const BATCH = 25;
const TERMINAL_CALL_STATUSES = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];

const errCode = (err) => String(err?.code || err?.name || 'error');
const phoneDigits = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

function shared() {
  return require('./lead-call-text-followup')._shared;
}

async function loadCustomer(id) {
  return db('customers').where({ id }).whereNull('deleted_at').first();
}

// Stamps `column` on the row iff it is still unset and the row still has
// `state`; true when this tick won the claim.
async function claim(row, column, state, now) {
  const updated = await db('lead_callback_requests').where({ id: row.id, state }).whereNull(column)
    .update({ [column]: now, updated_at: now });
  return updated > 0;
}

function reminderBody(customer) {
  const first = String(customer.first_name || '').trim();
  return `Hi ${first || 'there'}, Adam from Waves here. I'll call you in about 15 minutes.`;
}

// ── 15 minutes before ────────────────────────────────────────────────────
async function sendReminders(now) {
  const { sendFollowup, raiseLeadBell } = shared();
  const rows = await db('lead_callback_requests')
    .where({ state: 'scheduled' }).whereNull('reminded_at')
    .where('scheduled_for', '>', now)
    .where('scheduled_for', '<=', new Date(now.getTime() + REMINDER_LEAD_MS))
    .orderBy('scheduled_for').limit(BATCH);
  let sent = 0;
  for (const row of rows) {
    if (!(await claim(row, 'reminded_at', 'scheduled', now))) continue;
    const customer = await loadCustomer(row.customer_id);
    if (!customer) continue;
    const time = formatETTime(new Date(row.scheduled_for));
    await raiseLeadBell({
      customer, leadId: row.lead_id, requestId: row.id, key: 'lead-callback-reminder',
      actions: [(who) => `call ${who} at ${time}`, (who) => `call ${who}`],
      why: `Booked call in 15 minutes; your cell rings at ${time} with press 1.`,
    });
    if (etParts(now).hour >= 8) {
      await sendFollowup({ customer, phone: row.phone, body: reminderBody(customer), kind: 'call_reminder', requestId: row.id, requireState: 'scheduled' });
    }
    sent += 1;
  }
  return sent;
}

// ── At the booked time ───────────────────────────────────────────────────
// Adam's cell takes one lead ring at a time.
async function ringIsLive(now) {
  const { LEAD_CALL_REPLY_RING_SOURCE } = require('./lead-call-reply-ring');
  const live = await db('call_log')
    .where({ source: LEAD_CALL_REPLY_RING_SOURCE, direction: 'outbound' })
    .whereNotIn('status', TERMINAL_CALL_STATUSES)
    .where('created_at', '>', new Date(now.getTime() - ACTIVE_RING_WINDOW_MS))
    .first('id');
  return !!live;
}

// Runs under placeRing's per-phone lock, for one booked request. The request
// row is locked and moved to done in the same transaction that claims the
// ring, so a TEXT that cancels it either lands first (no ring) or finds it
// done (the ring already started). Never a cancelled call that rings.
function bookedRingBlocker(requestId) {
  return async ({ customer, digits, now }, conn) => {
    const request = await conn('lead_callback_requests').where({ id: requestId }).forUpdate().first('state');
    if (request?.state !== 'scheduled') return 'request_changed';
    if (shared().REAL_CUSTOMER_STAGES.includes(customer.pipeline_stage)) {
      await conn('lead_callback_requests').where({ id: requestId }).update({ state: 'cancelled', updated_at: now });
      return 'existing_customer';
    }
    const recent = await conn('call_log')
      .where({ direction: 'outbound' })
      .where('created_at', '>=', new Date(now.getTime() - RECENT_CALL_WINDOW_MS))
      .where(function toThisPhone() {
        this.whereRaw("RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [digits])
          .orWhereRaw("RIGHT(regexp_replace(COALESCE(metadata->>'leadPhone', ''), '[^0-9]', '', 'g'), 10) = ?", [digits]);
      })
      .first('id');
    // Someone is already on the phone with them: the booked call is answered.
    await conn('lead_callback_requests').where({ id: requestId }).update({ state: 'done', updated_at: now });
    return recent ? 'call_in_progress' : null;
  };
}

async function ringDue(now) {
  const { raiseLeadBell } = shared();
  const { placeRing } = require('./lead-call-reply-ring');
  const rows = await db('lead_callback_requests')
    .where({ state: 'scheduled' }).whereNull('ring_claimed_at')
    .where('scheduled_for', '<=', now)
    .orderBy('scheduled_for').limit(BATCH);
  let rang = 0;
  for (const row of rows) {
    const time = formatETTime(new Date(row.scheduled_for));
    const late = now.getTime() - new Date(row.scheduled_for).getTime() > RING_LATE_LIMIT_MS;
    // Calls ring 8 AM-8 PM only: a slot delayed past 8 PM is the owner's.
    const handOff = late || !inRingHours(now);
    if (!handOff && await ringIsLive(now)) break; // the next tick rings it
    if (!(await claim(row, 'ring_claimed_at', 'scheduled', now))) continue;
    try {
      const customer = await loadCustomer(row.customer_id);
      if (!customer) {
        await db('lead_callback_requests').where({ id: row.id }).update({ state: 'cancelled', updated_at: now });
        continue;
      }
      if (handOff) {
        const moved = await db('lead_callback_requests').where({ id: row.id, state: 'scheduled' }).update({ state: 'needs_owner', updated_at: now });
        if (moved) await raiseLeadBell({ customer, leadId: row.lead_id, requestId: row.id, why: `Booked for ${time}; the ring could not start in time.` });
        continue;
      }
      const result = await placeRing({ customer, fromPhone: row.phone, now, blocker: bookedRingBlocker(row.id) });
      if (result.callLogId) {
        await db('lead_callback_requests').where({ id: row.id }).update({ ring_call_log_id: result.callLogId, updated_at: now });
      }
      if (result.rang) rang += 1;
    } catch (err) {
      // Nothing rang (placeRing throws only before any call exists): free the
      // claim so the next tick tries again, or hands the call off once late.
      logger.error(`[lead-callback-scheduler] ring step failed for request ${row.id} (${errCode(err)})`);
      await db('lead_callback_requests').where({ id: row.id, state: 'scheduled' }).update({ ring_claimed_at: null, updated_at: now })
        .catch((releaseErr) => logger.warn(`[lead-callback-scheduler] ring claim release failed for ${row.id} (${errCode(releaseErr)})`));
    }
  }
  return rang;
}

// ── 8 AM: the time question was never answered ───────────────────────────
async function noAnswerBells(now) {
  if (etParts(now).hour < 8) return 0;
  const { raiseLeadBell } = shared();
  const rows = await db('lead_callback_requests')
    .where({ state: 'asked', kind: 'call_request' })
    .whereNull('answer_text').whereNull('no_answer_at')
    .where('target_date', '<=', etDateString(now))
    .whereRaw("COALESCE(send_outcome, '') <> 'not_sent'")
    .orderBy('created_at').limit(BATCH);
  let rung = 0;
  for (const row of rows) {
    // One statement: still asked AND still unanswered, so an answer that
    // lands at 8 AM keeps its booking.
    const moved = await db('lead_callback_requests').where({ id: row.id, state: 'asked' })
      .whereNull('answer_text').whereNull('no_answer_at')
      .update({ state: 'needs_owner', no_answer_at: now, updated_at: now });
    const customer = moved ? await loadCustomer(row.customer_id) : null;
    if (!customer) continue;
    await raiseLeadBell({ customer, leadId: row.lead_id, requestId: row.id, why: 'Asked for a call after hours and never sent a time.' });
    rung += 1;
  }
  return rung;
}

/**
 * One scheduler tick. Each step runs on its own, so one failing step never
 * stops the others. Returns the counts; never throws.
 */
async function runLeadCallbackTick({ now = new Date() } = {}) {
  if (!isEnabled('leadCallTextFollowup')) return { skipped: 'gate_off' };
  const out = {};
  for (const [name, step] of [['reminded', sendReminders], ['rang', ringDue], ['noAnswer', noAnswerBells]]) {
    try {
      out[name] = await step(now);
    } catch (err) {
      logger.error(`[lead-callback-scheduler] ${name} step failed (${errCode(err)})`);
      out[name] = 'error';
    }
  }
  return out;
}

module.exports = {
  runLeadCallbackTick,
  _test: { reminderBody, bookedRingBlocker, phoneDigits },
};
