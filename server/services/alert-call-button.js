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
//
// The Waves Admin iPhone push carries the same Call (owner 2026-11-02, "A Call button on the phone push
// notification itself"): pushCallAction names the row and its version, the app shows Call on the notification, and
// its tap opens the portal, which runs this row's Call through the bell (NotificationBell.jsx, alertCall).

const db = require('../models/db');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { normalizePhone, isValidNanpNumber } = require('../utils/phone');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;
const SMS_SID_RE = /^(?:SM|MM)[0-9a-f]{32}$/i;
const CALL_PROMPT = 'Waves rings your phone first, then you press 1 to connect.';
const OFF_MESSAGE = 'These buttons are turned off. Open the alert to act on it.';
// The notification category the Waves Admin app registers with a Call action (ios/WavesPay StaffAlerts.swift).
const PUSH_CATEGORY = 'WAVES_CALL';

const gates = () => require('../config/feature-gates');
const alertButtons = () => require('./admin-alert-buttons');

// A number the Call Log would dial: a real US or Canada line that is not one of Waves' own, in E.164.
function callableNumber(value) {
  if (!isValidNanpNumber(value)) return null;
  const phone = normalizePhone(value);
  return TWILIO_NUMBERS.findByNumber(phone) ? null : phone;
}

// The Call Log's "Call back" body for a call as it stands now: the caller's number (the number called, for an
// outbound call), else the linked customer's, naming the customer only when it dials their own number.
async function callLogBody(where) {
  const call = await db('call_log').where(where).first('id', 'direction', 'from_phone', 'to_phone', 'customer_id');
  if (!call) return null;
  const customer = call.customer_id ? await db('customers').where({ id: call.customer_id }).whereNull('deleted_at').first('id', 'phone') : null;
  const dialed = String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone;
  const to = callableNumber(dialed) || callableNumber(customer?.phone);
  if (!to) return null;
  const ownNumber = customer && normalizePhone(customer.phone) === to;
  return { to, ...(ownNumber ? { customerId: customer.id } : {}), source: 'call-log-callback', relatedCallId: call.id };
}

// The body a page's Call button posts for a number and the customer it is hinted to; null with no number to dial.
const hintedBody = (phone, customerId) => {
  const to = callableNumber(phone);
  return to ? { to, ...(customerId ? { customerIdHint: customerId } : {}) } : null;
};

// The records a row can name, in the order a row names one, each with the body its linked page's Call button
// posts, read as the record stands now: a call (the Call Log's "Call back"; by its Twilio id for a row raised during
// the call), a lead (the Leads page's Call Now: the lead's number, its customer as the hint), a customer (their
// page's Call) and an unknown sender's text (the Communications thread's Call back).
const RECORDS = [
  ['callLogId', UUID_RE, (id) => callLogBody({ id })],
  ['callSid', CALL_SID_RE, (sid) => callLogBody({ twilio_call_sid: sid })],
  ['leadId', UUID_RE, async (id) => {
    const lead = await db('leads').where({ id }).whereNull('deleted_at').first('phone', 'customer_id');
    return lead ? hintedBody(lead.phone, lead.customer_id) : null;
  }],
  ['customerId', UUID_RE, async (id) => {
    const customer = await db('customers').where({ id }).whereNull('deleted_at').first('id', 'phone');
    return customer ? hintedBody(customer.phone, customer.id) : null;
  }],
  ['smsSid', SMS_SID_RE, async (sid) => {
    const text = await db('sms_log').where({ twilio_sid: sid, direction: 'inbound' }).first('from_phone', 'customer_id');
    return text ? hintedBody(text.from_phone, text.customer_id) : null;
  }],
];
const namedRecord = (ids) => RECORDS.find(([key, re]) => re.test(String(ids?.[key] || '')));

// The buttons for a row about one caller, or null when the row names no record to call. The first record in
// RECORDS order the row knows is named. `close` ('called_back' | 'handled') adds that close-only button after Call.
function callButtons({ close, ...ids } = {}) {
  const record = namedRecord(ids);
  const closeButton = close ? alertButtons().closeNoteButtons(close).items[0] : null;
  if (!record) return closeButton ? { kind: 'close_note', items: [closeButton] } : null;
  const args = { [record[0]]: String(ids[record[0]]) };
  return { kind: 'call_back', items: [{ id: 'call', label: 'Call', prompt: CALL_PROMPT, args }, ...(closeButton ? [closeButton] : [])] };
}

// The body the linked page's Call button posts, from the record as it stands now; null when there is no number to
// call.
async function callBody(args = {}) {
  const record = namedRecord(args);
  return record ? record[2](args[record[0]]) : null;
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

// The Call action on the Waves Admin push for a bell row this emission wrote: its id and the version the bell
// serves now, so the app's Call runs that row's button on the row the push showed. Null when the gate is off, the
// row is done or gone, or it carries no Call button. The app shows the action for PUSH_CATEGORY only.
async function pushCallAction(rowId) {
  if (!UUID_RE.test(String(rowId || '')) || !gates().alertCallButtonLive()) return null;
  const { NOTIFICATION_VERSION_SQL } = require('./notification-service')._private;
  const row = await db('notifications').where({ id: rowId, recipient_type: 'admin' }).whereNull('done_at')
    .first('metadata', db.raw(`${NOTIFICATION_VERSION_SQL} AS version`));
  let meta = row?.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  const items = meta?.buttons?.kind === 'call_back' && Array.isArray(meta.buttons.items) ? meta.buttons.items : [];
  if (!row?.version || !items.some((item) => item?.id === 'call')) return null;
  return { callAction: `${rowId}.${row.version}`, apnsCategory: PUSH_CATEGORY };
}

module.exports = { callButtons, buttonHandler, pushCallAction, PUSH_CATEGORY, _private: { callBody, callOutcome, callableNumber, CALL_PROMPT } };
