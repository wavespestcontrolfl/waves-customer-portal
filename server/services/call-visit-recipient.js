/**
 * Visit-only text recipients (GATE_CALL_GIVEN_VISIT_TEXTS; owner 2026-11-24, "yes, visit only").
 *
 * A caller who books a visit and gives another person's number to be texted ("my husband Bob will
 * be home, text him too, here is his number") gives that person the texts for THAT ONE VISIT: its
 * booking confirmation, its reminders and its en-route text. Nothing else. Anything beyond those
 * three still goes through the Reply-YES flow, unchanged.
 *
 * The permission lives on a visit_text_recipients row tied to the visit. This module never writes
 * customers.service_contacts_consent_at, the service-contact slots, recipient_optin or contact
 * login: an earlier build that made the number an account-wide consented contact leaked into
 * login, review asks, email and the YES flow. It READS the person's existing declines (their own
 * text choices, a recipient_optin decline, STOP / suppression) and honors every one.
 *
 * This is the ONE place that decides who is eligible, who is owed a text, what the text says and
 * how it is sent. Every sender asks it:
 *   - the call pipeline records the number when it books the visit (recordForCall); its confirmation
 *     reaches the person through deliverAppointmentNotice like any other;
 *   - appointment-reminders.js deliverAppointmentNotice, for the confirmation (the call pipeline's included)
 *     and the 72 h / 24 h reminders, once per notice and whatever channel the account holder chose;
 *   - twilio.js sendTechEnRoute.
 *
 * What the person receives is informational copy built here, never the holder's template: no
 * reschedule, confirm or move link (the appointment page link carries the visit's management token)
 * and no tracker link (the tracker token also opens the visit's report, invoice and review cards
 * after completion). The text goes through the same send layer as every other text, with no
 * "customer-initiated" exemption: the send window applies, and a text held for it is persisted and
 * replayed (visit_text_recipient_deferred in messaging/deferred-replay-registry.js) after a fresh
 * visit, gate and decline check.
 */
const db = require('../models/db');
const logger = require('./logger');
const { toE164, isValidNanpNumber } = require('../utils/phone');
const { mapSecondaryContactToLegacy } = require('../utils/extraction-compat');
const { dateOnlyString } = require('../utils/date-only');

const SOURCE = 'call_caller_provided';
const CONSENT_VERSION = 'owner-ruling-2026-11-24-visit-only';
const ROLE = 'visit_text_recipient';
const TABLE = 'visit_text_recipients';
const DEFERRED_ENTRY_POINT = 'visit_text_recipient_deferred';

// The only texts a visit-only recipient gets. `purpose` is the send layer's policy purpose (it also
// names the person's own text choice for that purpose); `notice` is how deliverAppointmentNotice names
// the same notice. A reschedule, cancellation, no-show, arrival, completion, review or any other text
// is not here, so it never reaches the recipient. A reschedule keeps the same visit row, so the
// recipient stays; the reminders the new slot arms reach the recipient again. `deferrable`: a text held
// for the send window is worth sending the next morning (a 24 h reminder would land on the visit day
// and an en-route text would be stale, so those are dropped, as for the account contacts).
const KINDS = {
  confirmation: { purpose: 'appointment_confirmation', messageType: 'confirmation', notice: 'confirmation', deferrable: true, dayOnlyOk: true },
  reminder_72h: { purpose: 'appointment_reminder_72h', messageType: 'reminder_72h', notice: '72h', deferrable: true, dayOnlyOk: true },
  reminder_24h: { purpose: 'appointment_reminder_24h', messageType: 'appointment_reminder', notice: '24h', deferrable: false, dayOnlyOk: false },
  en_route: { purpose: 'tech_en_route', messageType: 'tech_en_route', notice: null, deferrable: false, dayOnlyOk: false },
};

// A recipient gets no text about a visit that is over or cancelled, or that waits to be rebooked: 'rescheduled' is the pending-rebook
// placeholder, which keeps the OBSOLETE date and window, so nothing is announced until the replacement slot is live again
// (the recipient row stays through the move).
const LIVE_STATUSES = ['pending', 'confirmed', 'en_route'];

const lastTen = (value) => String(value || '').replace(/\D/g, '').slice(-10);

/** GATE_CALL_GIVEN_VISIT_TEXTS, read at call time. Every sender asks here, so one test double of feature-gates covers them all. */
function gateLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.callGivenVisitTextsLive === 'function' && gates.callGivenVisitTextsLive() === true;
}

/** The visit-only kind for a holder notice ('confirmation', '72h', '24h' in deliverAppointmentNotice), or null. */
function kindForNotice(notice) {
  return notice ? Object.keys(KINDS).find((kind) => KINDS[kind].notice === notice) || null : null;
}
const purposeFor = (kind) => KINDS[kind].purpose;
const messageTypeFor = (kind) => KINDS[kind].messageType;

/**
 * The V2 extraction's own entries, each judged ALONE: the phone and the request must sit on the same
 * entry, and the request is wants_appointment_texts: the caller agreed this person gets the appointment
 * texts, reminders and en-route text. wants_notifications alone (a report or invoice sent to someone) and
 * on_site alone (a person who will be at the property) never qualify. The merged V1/V2 contact is never
 * used, so one person's flag cannot move onto another person's number. Pure.
 */
function eligibleEntries(v2Extraction, { excludePhones = [] } = {}) {
  const taken = new Set(excludePhones.map(lastTen).filter(Boolean));
  const raw = [v2Extraction?.secondary_contact, ...(Array.isArray(v2Extraction?.secondary_contacts) ? v2Extraction.secondary_contacts : [])];
  const out = [];
  for (const rawEntry of raw) {
    const entry = mapSecondaryContactToLegacy(rawEntry);
    if (!entry || !isValidNanpNumber(entry.phone) || entry.wants_appointment_texts !== true) continue;
    const key = lastTen(entry.phone);
    if (taken.has(key)) continue;
    taken.add(key);
    const role = String(entry.role || '').trim().toLowerCase();
    out.push({
      phoneKey: key,
      phoneE164: toE164(entry.phone),
      firstName: entry.first_name || null,
      lastName: entry.last_name || null,
      role: role && role !== 'unknown' ? role.slice(0, 30) : null,
    });
  }
  return out;
}

/** Every number that belongs to the call itself or to the caller: never a visit-only recipient. */
function callerNumbers({ call = {}, contactPhone = null, extractedPhone = null, v2Extraction = null } = {}) {
  return [
    call.from_phone, call.to_phone, contactPhone, extractedPhone,
    v2Extraction?.caller?.phone_e164, v2Extraction?.caller?.text_phone_e164,
  ].filter(Boolean);
}

async function suppressedNumber(phoneKey, conn) {
  const row = await conn('messaging_suppression')
    .whereRaw("right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ?", [phoneKey])
    .where('active', true)
    .first('phone');
  return !!row;
}

/**
 * Record the people the caller asked to text for the visit the call booked. Idempotent: a retry of
 * the call processing finds the row and changes nothing. Never throws on a refused number; a database
 * error propagates (recordForCall swallows it).
 *
 * `blocked`: the call-level SMS verdict (do-not-contact, the TCPA gate, a disclaimed caller number).
 * `excludePhones`: the call legs and the caller's own numbers (callerNumbers).
 */
async function recordForVisit({ scheduledServiceId, callLogId = null, v2Extraction, excludePhones = [], blocked = false, conn = db }) {
  const result = { recorded: [], skipped: [] };
  if (!scheduledServiceId || blocked) return { ...result, skipped: [{ reason: blocked ? 'call_sms_blocked' : 'no_visit' }] };
  const { disclaimedNumberHeld } = require('./disclaimed-number-holds');
  // The account holder already gets this visit's texts as themselves: no second row for their own number.
  const holder = await conn('scheduled_services as s').join('customers as c', 'c.id', 's.customer_id')
    .where('s.id', scheduledServiceId).first('c.phone');
  for (const entry of eligibleEntries(v2Extraction, { excludePhones: [...excludePhones, holder?.phone] })) {
    if (await disclaimedNumberHeld(entry.phoneE164, conn)) { result.skipped.push({ reason: 'disclaimed_number' }); continue; }
    if (await suppressedNumber(entry.phoneKey, conn)) { result.skipped.push({ reason: 'suppressed' }); continue; }
    const rows = await conn(TABLE).insert({
      scheduled_service_id: scheduledServiceId,
      phone_key: entry.phoneKey,
      phone_e164: entry.phoneE164,
      first_name: entry.firstName ? String(entry.firstName).slice(0, 100) : null,
      last_name: entry.lastName ? String(entry.lastName).slice(0, 100) : null,
      role: entry.role,
      source: SOURCE,
      consent_version: CONSENT_VERSION,
      call_log_id: callLogId,
    }).onConflict(['scheduled_service_id', 'phone_key']).ignore().returning('id');
    result.recorded.push({ phoneKey: entry.phoneKey, created: rows.length > 0 });
  }
  return result;
}

/**
 * The call pipeline's entry, at the point it books the visit. Fail-soft: a write error leaves the person
 * unrecorded (nobody extra is texted) and never touches the booking. `blocked` is the call-level SMS verdict.
 */
async function recordForCall({ scheduledServiceId, customerId, call, contactPhone = null, extracted = {}, v2Extraction, blocked = false }) {
  if (!gateLive() || !customerId) return null;
  try {
    const result = await recordForVisit({
      scheduledServiceId,
      callLogId: call.id,
      v2Extraction,
      excludePhones: callerNumbers({ call, contactPhone, extractedPhone: extracted.phone, v2Extraction }),
      blocked,
    });
    if (result.recorded.length) logger.info(`[call-visit-recipient] ${result.recorded.length} recipient(s) recorded for visit ${scheduledServiceId}`);
    return result;
  } catch (err) {
    logger.warn(`[call-visit-recipient] not recorded for visit ${scheduledServiceId}: ${err.code || err.name || 'error'}`);
    return null;
  }
}

/**
 * Has this person declined, by any existing route? Their own text choices as a service contact (this
 * purpose or texts altogether), a recipient_optin decline on the account, STOP or any active
 * suppression. Read only. Throws on an unreadable answer; callers fail closed.
 */
async function declinedByRecipient({ customerId, phoneKey, phoneE164, purpose, conn = db }) {
  const { contactPhoneDeclinesText } = require('./contact-notification-prefs');
  if (await contactPhoneDeclinesText(customerId, phoneE164, KINDS_BY_PURPOSE[purpose]?.prefsColumn ?? null, { dbh: conn })) return true;
  const optin = await conn('recipient_optin').where({ customer_id: customerId, phone_key: phoneKey, status: 'declined' }).first('status');
  if (optin) return true;
  return suppressedNumber(phoneKey, conn);
}
// The send layer's own prefsColumn per purpose: the person's "do not send me this notice" choice is read from it.
const KINDS_BY_PURPOSE = {
  appointment_confirmation: { prefsColumn: 'appointment_confirmation' },
  appointment_reminder_72h: { prefsColumn: 'service_reminder_72h' },
  appointment_reminder_24h: { prefsColumn: 'service_reminder_24h' },
  tech_en_route: { prefsColumn: 'tech_en_route' },
};

/**
 * The visit-only recipients owed a text of `kind` for this visit right now, as contacts a sender can
 * text. Empty for a visit that is cancelled or over, a number the account holder (or the sender) already
 * texts, anything in `excludePhones`, and anyone who has declined (declinedByRecipient). Fails closed: a
 * read error answers nobody (`throwOnError` re-throws it for the replay, which retries instead).
 */
async function contactsForVisit(scheduledServiceId, kind, { excludePhones = [], conn = db, throwOnError = false } = {}) {
  if (!scheduledServiceId || !KINDS[kind]) return [];
  try {
    const visit = await conn('scheduled_services').where({ id: scheduledServiceId }).first('id', 'status', 'scheduled_date', 'window_start', 'customer_id', 'service_type');
    if (!visit || !LIVE_STATUSES.includes(String(visit.status || ''))) return [];
    const rows = await conn(TABLE).where({ scheduled_service_id: scheduledServiceId }).orderBy('created_at', 'asc');
    if (!rows.length) return [];
    const holder = await conn('customers').where({ id: visit.customer_id }).first('phone');
    const taken = new Set([...excludePhones, holder?.phone].map(lastTen).filter(Boolean));
    const contacts = [];
    for (const row of rows) {
      const contact = taken.has(row.phone_key) ? null : await ownedContact(row, visit, kind, conn);
      if (contact) contacts.push(contact);
    }
    return contacts;
  } catch (err) {
    if (throwOnError) throw err;
    logger.warn(`[call-visit-recipient] recipients unreadable for visit ${scheduledServiceId}: ${err.code || err.name || 'db_error'}`);
    return [];
  }
}

// One recipient row as a contact a sender can text, or null when they have declined.
async function ownedContact(row, visit, kind, conn) {
  if (await declinedByRecipient({ customerId: visit.customer_id, phoneKey: row.phone_key, phoneE164: row.phone_e164, purpose: KINDS[kind].purpose, conn })) return null;
  const windowStart = visit.window_start ? String(visit.window_start).slice(0, 5) : null;
  const scheduledDate = dateOnlyString(visit.scheduled_date);
  return {
    phone: row.phone_e164,
    email: null,
    name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    // Not a service-contact role: the send runs at phone_matches_customer trust. This person has no slot and no login.
    role: ROLE,
    visitRecipientId: row.id,
    claimKey: `${kind}:${scheduledDate || ''}T${windowStart || ''}`,
    visit: { id: visit.id, customerId: visit.customer_id, serviceType: visit.service_type, scheduledDate, windowStart },
  };
}

/**
 * The text itself: informational, with no link of any kind (see the header). Pure.
 * `facts`: { label, day, date, window, dayOnly } for a visit text; { techName, etaMinutes } for en route.
 * `dayOnly`: the holder's notice promised only the day (GATE_DAY_ONLY_PROMISE), so this one does too.
 */
function informationalBody(kind, firstName, facts = {}) {
  const hi = `Hi ${firstName || 'there'},`;
  const label = facts.label || 'Your service';
  const visit = facts.dayOnly
    ? `${label} is scheduled for ${facts.day}, ${facts.date}.`
    : `${label} is scheduled for ${facts.day}, ${facts.date}, arriving ${facts.window}.`;
  const stop = 'Reply STOP to opt out.';
  if (kind === 'confirmation') {
    const next = facts.dayOnly
      ? 'We will text you the arrival window the day before, and again when the technician is on the way.'
      : 'We will text you a reminder before the visit and again when the technician is on the way.';
    return `${hi} Waves here. ${visit} ${next} ${stop}`;
  }
  if (kind === 'en_route') {
    const eta = facts.etaMinutes ? `, about ${facts.etaMinutes} minutes away` : '';
    return `${hi} Waves here. ${facts.techName || 'Your technician'} is on the way${eta}. ${stop}`;
  }
  const next = facts.dayOnly ? ' We will text you the arrival window the day before.' : '';
  return `${hi} a reminder from Waves. ${visit}${next} ${stop}`;
}

/** A send that was accepted, or reached the provider with an unknown fate, or is queued for the replay: the claim stays. */
function deliveryAccepted(result) {
  if (typeof result === 'boolean') return result;
  if (!result) return false;
  if (result.visitRecipientQueued === true) return true;
  const { classifyDeliveryCertainty } = require('./messaging/send-customer-message');
  const certainty = typeof classifyDeliveryCertainty === 'function' ? classifyDeliveryCertainty(result) : null;
  if (certainty === 'sent') return true;
  return (certainty === 'unknown' || certainty === null) && (result.sent === true || result.deliveryOutcome === 'uncertain');
}

/**
 * Run `send` for one recipient at most once per text kind and visit slot. The claim is written before
 * the send and released when nothing reached the provider, so a retry or a second sender never texts
 * the same message twice, and a text that never went out is still owed. Returns { skipped, reason }
 * when the claim was already taken or could not be written (fail closed: no claim, no text).
 */
async function sendOnce(contact, send, { conn = db } = {}) {
  let claimed;
  try {
    claimed = await conn(TABLE)
      .where({ id: contact.visitRecipientId })
      .whereRaw('NOT jsonb_exists(deliveries, ?)', [contact.claimKey])
      .update({ deliveries: conn.raw('deliveries || jsonb_build_object(?::text, now()::text)', [contact.claimKey]) });
  } catch (err) {
    logger.warn(`[call-visit-recipient] claim failed for ${contact.claimKey}: ${err.code || err.name || 'db_error'}`);
    return { skipped: true, reason: 'claim_failed' };
  }
  if (!claimed) return { skipped: true, reason: 'already_sent' };
  let result;
  try {
    result = await send();
  } catch (err) {
    // A throw may have reached the provider: keep the claim (no double text) unless the error proves it did not.
    if (err && err.providerOutcome && !deliveryAccepted(err.providerOutcome)) await releaseClaim(contact.visitRecipientId, contact.claimKey, conn);
    throw err;
  }
  if (!deliveryAccepted(result)) await releaseClaim(contact.visitRecipientId, contact.claimKey, conn);
  return { skipped: false, result };
}

function releaseClaim(visitRecipientId, claimKey, conn = db) {
  return conn(TABLE)
    .where({ id: visitRecipientId })
    .update({ deliveries: conn.raw('deliveries - ?::text', [claimKey]) })
    .catch((err) => logger.warn(`[call-visit-recipient] claim release failed for ${claimKey}: ${err.code || err.name || 'db_error'}`));
}

/**
 * Persist a text the send window held, to replay it later (deferred-replay-registry visit_text_recipient_deferred).
 * The row belongs to the recipient's own number and is frozen to the visit slot it describes. Returns true when queued.
 */
async function queueDeferred({ contact, kind, body, result, promiseMeta = {}, recheckMeta = {}, conn = db }) {
  const TWILIO_NUMBERS = require('../config/twilio-numbers');
  const row = {
    customer_id: contact.visit.customerId,
    direction: 'outbound',
    from_phone: TWILIO_NUMBERS.getOutboundNumber(),
    to_phone: contact.phone,
    message_body: body,
    status: 'scheduled',
    scheduled_for: new Date(result.nextAllowedAt),
    message_type: KINDS[kind].messageType,
    metadata: JSON.stringify({
      entry_point: DEFERRED_ENTRY_POINT,
      scheduled_service_id: contact.visit.id,
      visit_recipient_id: contact.visitRecipientId,
      claim_key: contact.claimKey,
      kind,
      appointment_contact_role: ROLE,
      original_block_code: 'QUIET_HOURS_HOLD',
      ...promiseMeta,
      ...(recheckMeta.arrival_start ? { arrival_start: recheckMeta.arrival_start } : {}),
      replay_purpose: KINDS[kind].purpose,
      slot_scheduled_date: contact.visit.scheduledDate,
      ...(contact.visit.windowStart ? { slot_window_start: contact.visit.windowStart } : {}),
      resolve_from_by_customer: true,
      requires_registered_dispatch: true,
    }),
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await conn('sms_log').insert(row);
      return true;
    } catch (err) {
      if (attempt === 3) logger.error(`[call-visit-recipient] held ${kind} text not queued for visit ${contact.visit.id}: ${err.code || err.name || 'error'}`);
      else await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  return false;
}

/**
 * Text the visit-only recipients of this visit for one kind of notice: the ONE function every sender calls.
 * `excludePhones`: the numbers the sender already texts. `context`: en route only, { techName, etaMinutes }.
 * `dayOnly`: the holder's confirmation or 72 h reminder promised only the day, so this one does too.
 * `gate(contact)`: optional per-recipient check by the sender, 'send' (default), 'skip' or 'abort'
 * (the pipeline lost its claim). Never throws into the sender. Returns false only when a gate aborted.
 */
async function notifyVisitRecipients({ scheduledServiceId, kind, excludePhones = [], context = {}, dayOnly = false, gate = null, conn = db }) {
  if (!gateLive() || !KINDS[kind] || !scheduledServiceId) return true;
  try {
    const contacts = await contactsForVisit(scheduledServiceId, kind, { excludePhones, conn });
    for (const contact of contacts) {
      const verdict = gate ? await gate(contact) : 'send';
      if (verdict === 'abort') return false;
      if (verdict === 'skip') continue;
      await sendToRecipient({ contact, kind, context, dayOnly: dayOnly === true && KINDS[kind].dayOnlyOk, conn });
    }
  } catch (err) {
    logger.warn(`[call-visit-recipient] ${kind} for visit ${scheduledServiceId} skipped: ${err.code || err.name || 'error'}`);
  }
  return true;
}

// The arrival the copy quotes AND the move guard compares, from one read: a later service in a combined reservation
// arrives with the shared start, not its own window_start.
async function arrivalSnapshot(visit, conn) {
  const { spokenArrivalWindow } = require('../utils/sms-time-format');
  let start = visit.windowStart;
  try {
    const row = await conn('scheduled_services').where({ id: visit.id }).first('id', 'reservation_service_mix', 'window_start');
    if (row) start = await require('./reservation-arrival').arrivalStartForService(conn, row);
  } catch (err) {
    logger.warn(`[call-visit-recipient] arrival unreadable for visit ${visit.id}: ${err.code || err.name || 'error'}`);
  }
  const hhmm = String(start || '').slice(0, 5);
  return { hhmm, window: spokenArrivalWindow(hhmm) };
}

// The copy and the slot the send is guarded on. null = nothing sendable.
async function buildMessage(contact, kind, context, dayOnly, conn) {
  const firstName = String(contact.name || '').trim().split(/\s+/)[0] || null;
  if (kind === 'en_route') return { body: informationalBody(kind, firstName, context), slotMs: null, arrivalStart: null };
  const { buildServiceLabel } = require('./appointment-reminders');
  const { parseETDateTime, formatETDay, formatETDate } = require('../utils/datetime-et');
  const arrival = await arrivalSnapshot(contact.visit, conn);
  const at = parseETDateTime(`${contact.visit.scheduledDate}T${arrival.hhmm || '12:00'}`);
  if (!at || Number.isNaN(at.getTime())) return null;
  const body = informationalBody(kind, firstName, {
    label: await buildServiceLabel(contact.visit.id, contact.visit.serviceType),
    day: formatETDay(at),
    date: formatETDate(at),
    window: arrival.window,
    dayOnly,
  });
  return { body, slotMs: arrival.hhmm ? at.getTime() : null, arrivalStart: arrival.hhmm || null };
}

async function sendToRecipient({ contact, kind, context, dayOnly, conn }) {
  const message = await buildMessage(contact, kind, context, dayOnly, conn);
  if (!message) return;
  const { body, slotMs, arrivalStart } = message;
  const { sendCustomerMessage } = require('./messaging/send-customer-message');
  // A day promise carries the same marker the holder's day text records, so the visit's promise history stays one story.
  const promiseMeta = dayOnly
    ? { ...require('./time-promise').DAY_PROMISE_META, ...(slotMs ? { guard_slot_ms: slotMs } : {}), promised_date: contact.visit.scheduledDate }
    : {};
  // What the text said, for the handoff recheck and the replay: the person, the slot, the day promise and the arrival quoted.
  const recheckMeta = {
    scheduled_service_id: contact.visit.id,
    kind,
    visit_recipient_id: contact.visitRecipientId,
    claim_key: contact.claimKey,
    ...(dayOnly ? { promise_level: 'day' } : {}),
    ...(arrivalStart && !dayOnly ? { arrival_start: arrivalStart } : {}),
  };
  const outcome = await sendOnce(contact, async () => {
    // No customerInitiated: this text goes to someone who did not call, so the send window applies.
    const result = await sendCustomerMessage({
      to: contact.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: KINDS[kind].purpose,
      customerId: contact.visit.customerId,
      appointmentId: contact.visit.id,
      ...(slotMs ? { renderedSlotMs: slotMs } : {}),
      ...(dayOnly ? { promisedWindowUnknown: true } : {}),
      identityTrustLevel: 'phone_matches_customer',
      // The permission is re-read at the provider handoff: the contact-login check does not apply to this recipient.
      providerPreSendCheck: () => providerCheck(recheckMeta, { conn }),
      // scheduled_service_id + the role are how a bounce is recognised as the recipient's, never the holder's (appointment-reminders.js handleUndeliveredSms).
      metadata: { original_message_type: KINDS[kind].messageType, appointment_contact_role: ROLE, scheduled_service_id: contact.visit.id, ...promiseMeta },
    });
    if (!result.sent && result.code === 'QUIET_HOURS_HOLD' && result.deferred && result.nextAllowedAt && KINDS[kind].deferrable) {
      if (await queueDeferred({ contact, kind, body, result, promiseMeta, recheckMeta, conn })) return { ...result, visitRecipientQueued: true };
    }
    return result;
  }, { conn });
  if (outcome.skipped) logger.info(`[call-visit-recipient] ${kind} skipped (${outcome.reason}) for visit ${contact.visit.id}`);
  else if (outcome.result.visitRecipientQueued) logger.info(`[call-visit-recipient] ${kind} held for the send window, queued for visit ${contact.visit.id}`);
  else if (!deliveryAccepted(outcome.result)) logger.warn(`[call-visit-recipient] ${kind} not sent for visit ${contact.visit.id}: ${outcome.result.code || outcome.result.reason || 'unknown'}`);
}

/** The slot date of a claim key (`kind:YYYY-MM-DDThh:mm`). */
const claimDate = (claimKey) => String(claimKey || '').slice(String(claimKey || '').indexOf(':') + 1).slice(0, 10);

/**
 * Is this recipient STILL owed this text, right now? Read fresh by the replay and again at the provider handoff of every
 * send: the gate is on, the visit has no callback-number hold (visit-wide: a hold on the caller's number does not
 * protect this other number), the visit is live, the person is still on it and has not declined, and the text still
 * describes the visit: the same slot (a day-only text only needs the same DATE: its promise ignores the hour), and for a
 * text that quoted an arrival, the shared arrival is the one it quoted. Returns { ok, code?, reason? }; throws on an
 * unreadable answer (the caller holds and retries).
 */
async function recipientStillOwed(meta, { conn = db } = {}) {
  const no = (code, reason) => ({ ok: false, code, reason });
  if (!gateLive()) return no('VISIT_TEXT_GATE_OFF', 'gate-off');
  if (await require('./appointment-reminders').callbackNumberHoldActiveForVisit({ scheduledServiceId: meta.scheduled_service_id })) {
    return no('CALLBACK_NUMBER_HOLD', 'callback-number-hold');
  }
  const contacts = await contactsForVisit(meta.scheduled_service_id, meta.kind, { conn, throwOnError: true });
  const mine = contacts.find((contact) => contact.visitRecipientId === meta.visit_recipient_id);
  if (!mine) return no('VISIT_RECIPIENT_NOT_OWED', 'recipient-not-owed');
  const sameSlot = meta.promise_level === 'day' ? claimDate(mine.claimKey) === claimDate(meta.claim_key) : mine.claimKey === meta.claim_key;
  if (!sameSlot) return no('VISIT_SLOT_MOVED', 'slot-moved');
  if (meta.arrival_start && (await arrivalSnapshot(mine.visit, conn)).hhmm !== meta.arrival_start) return no('VISIT_ARRIVAL_MOVED', 'arrival-moved');
  return { ok: true };
}

/** The provider-boundary predicate of a visit-only send (immediate and replayed): the verdict the send layer expects. */
async function providerCheck(meta, { conn = db } = {}) {
  try {
    return await recipientStillOwed(meta, { conn });
  } catch (err) {
    logger.warn(`[call-visit-recipient] handoff recheck unreadable for visit ${meta.scheduled_service_id}: ${err.code || err.name || 'error'}`);
    return { ok: false, code: 'VISIT_RECIPIENT_CHECK_FAILED', reason: 'recheck-failed', retryable: true };
  }
}

/** The replay's fresh check, before a queued text goes out. True when still owed; throws on an unreadable answer. */
async function recipientStillOwedDeferred(meta, { conn = db } = {}) {
  return (await recipientStillOwed(meta, { conn })).ok === true;
}

/** A replay that ended without sending gives the claim back, so a later sender can still owe the text. */
function releaseDeferredClaim(meta, { conn = db } = {}) {
  if (!meta || !meta.visit_recipient_id || !meta.claim_key) return Promise.resolve();
  return releaseClaim(meta.visit_recipient_id, meta.claim_key, conn);
}

module.exports = {
  gateLive,
  SOURCE,
  CONSENT_VERSION,
  ROLE,
  DEFERRED_ENTRY_POINT,
  LIVE_STATUSES,
  kindForNotice,
  purposeFor,
  messageTypeFor,
  eligibleEntries,
  callerNumbers,
  recordForVisit,
  recordForCall,
  declinedByRecipient,
  contactsForVisit,
  informationalBody,
  notifyVisitRecipients,
  sendOnce,
  deliveryAccepted,
  recipientStillOwed,
  recipientStillOwedDeferred,
  providerCheck,
  releaseDeferredClaim,
};
