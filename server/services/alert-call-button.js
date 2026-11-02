'use strict';

// The Call button on an admin bell row about one caller (docs/admin-notifications.md section 2, part 9; owner
// 2026-11-02: "for the voicemail, or missed call notifications, or any other related to calls, cant we add a call
// button, where we can call them from the admin notification"). Kind `call_back` in admin-alert-buttons.js.
//
// Call does what the linked page's own Call button does, through the same server step: the handler behind
// POST /api/admin/communications/call, run in-process (placeCallFromAlert), with the body that button sends. For a
// call, the Call Log's "Call back" ({ to, customerId?, source: 'call-log-callback', relatedCallId }); for a customer
// or a lead, the Call on their page ({ to, customerIdHint }). Waves rings the owner's phone first and connects on
// press 1, as every admin Call button does. The record is read again at the tap; the row's words are never dialed.
//
// Unlike the other buttons, Call leaves the row open: a call can ring out. The row closes when the call reaches the
// caller (its own done-when), with its close button, or with Done.
//
// A row may carry one close-only button after Call (Called back on a missed call, Handled on a text thread), so it
// keeps the close button it had before this kind. Each button follows its own gate: Call GATE_ALERT_CALL_BUTTON,
// the close button GATE_ALERT_CLOSE_BUTTONS (and its tap is the close_note step itself).

const db = require('../models/db');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { normalizePhone, isValidNanpNumber } = require('../utils/phone');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;
const CALL_PROMPT = 'Waves rings your phone first, then you press 1 to connect.';
const OFF_MESSAGE = 'These buttons are turned off. Open the alert to act on it.';

const gates = () => require('../config/feature-gates');
const alertButtons = () => require('./admin-alert-buttons');

// The buttons for a row about one caller, or null when the row names no record to call. One record, in this order:
// `callLogId` (the call the row is about), `callSid` (the same, by its Twilio id, for a row raised during the call),
// `customerId` (a customer or a lead). `close` ('called_back' | 'handled') adds that close-only button after Call.
function callButtons({ callLogId, callSid, customerId, close } = {}) {
  let args = null;
  if (UUID_RE.test(String(callLogId || ''))) args = { callLogId: String(callLogId) };
  else if (CALL_SID_RE.test(String(callSid || ''))) args = { callSid: String(callSid) };
  else if (UUID_RE.test(String(customerId || ''))) args = { customerId: String(customerId) };
  const closeButton = close ? alertButtons().closeNoteButtons(close).items[0] : null;
  if (!args) return closeButton ? { kind: 'close_note', items: [closeButton] } : null;
  return { kind: 'call_back', items: [{ id: 'call', label: 'Call', prompt: CALL_PROMPT, args }, ...(closeButton ? [closeButton] : [])] };
}

// A number the Call Log would dial: a real US or Canada line that is not one of Waves' own, in E.164.
function callableNumber(value) {
  if (!isValidNanpNumber(value)) return null;
  const phone = normalizePhone(value);
  return TWILIO_NUMBERS.findByNumber(phone) ? null : phone;
}

const liveCustomer = (id) => db('customers').where({ id }).whereNull('deleted_at').first('id', 'phone');

// The Call Log's "Call back" body for a call as it stands now: the caller's number (the number called, for an
// outbound call), else the linked customer's, naming the customer only when it dials their own number.
async function callLogBody(where) {
  const call = await db('call_log').where(where).first('id', 'direction', 'from_phone', 'to_phone', 'customer_id');
  if (!call) return null;
  const customer = call.customer_id ? await liveCustomer(call.customer_id) : null;
  const dialed = String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone;
  const to = callableNumber(dialed) || callableNumber(customer?.phone);
  if (!to) return null;
  const ownNumber = customer && normalizePhone(customer.phone) === to;
  return { to, ...(ownNumber ? { customerId: customer.id } : {}), source: 'call-log-callback', relatedCallId: call.id };
}

// The body the linked page's Call button posts, from the record as it stands now; null when there is no number to
// call. A call: the Call Log's "Call back". A customer or a lead: the Call on their page.
async function callBody({ callLogId, callSid, customerId } = {}) {
  if (UUID_RE.test(String(callLogId || ''))) return callLogBody({ id: callLogId });
  if (CALL_SID_RE.test(String(callSid || ''))) return callLogBody({ twilio_call_sid: callSid });
  if (!UUID_RE.test(String(customerId || ''))) return null;
  const customer = await liveCustomer(customerId);
  const to = callableNumber(customer?.phone);
  return to ? { to, customerIdHint: customer.id } : null;
}

// What the call step answered, as a tap's result. 200 + success: the owner's phone is ringing. 409: the step's own
// refusal (a callback is already ringing, or was started a minute ago), shown as it reads. Anything else (calls
// turned off, a number the step refuses, Twilio not set up) refuses here and the page is the place to act.
function callOutcome({ status, json } = {}) {
  if (status === 200 && json?.success === true) {
    return { ok: true, keepOpen: true, message: 'Calling your phone now. Press 1 to connect.' };
  }
  if (status === 409) {
    const message = typeof json?.error === 'string' && json.error.trim() ? json.error.trim() : 'A call to them is already going.';
    return { ok: false, code: 'busy', message };
  }
  return { ok: false, code: 'refused', message: 'That call could not start. Open the alert to call them.' };
}

async function placeCall({ item, technicianId }) {
  const body = await callBody(item.args || {});
  if (!body) return { ok: false, code: 'no_number', message: 'No number to call. Open the alert to act on it.' };
  const answer = await require('../routes/admin-communications').placeCallFromAlert({ body, technicianId });
  return callOutcome(answer);
}

const buttonHandler = {
  live: () => gates().alertCallButtonLive() || gates().alertCloseButtonsLive(),
  // Each stored button follows its own gate; no record is read here (the tap reads it).
  visibleItems(rows) {
    const call = gates().alertCallButtonLive();
    const close = gates().alertCloseButtonsLive();
    const served = (item) => (item?.id === 'call' ? call : close);
    return new Map(rows.map((row) => [row.id, (row.metadata?.buttons?.items || []).filter(served).map((item) => item.id)]));
  },
  async run(tap) {
    if (tap.item.id !== 'call') {
      if (!gates().alertCloseButtonsLive()) return { ok: false, code: 'off', message: OFF_MESSAGE };
      return alertButtons()._private.closeNoteHandler.run(tap);
    }
    if (!gates().alertCallButtonLive()) return { ok: false, code: 'off', message: OFF_MESSAGE };
    return placeCall(tap);
  },
};

module.exports = { callButtons, buttonHandler, _private: { callBody, callOutcome, callableNumber, CALL_PROMPT } };
