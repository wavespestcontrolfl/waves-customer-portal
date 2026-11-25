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
 * reschedule, confirm or move link (the appointment page link carries the visit's management token).
 * The en-route text alone carries a tracker link (owner 2026-11-24, "yes he gets it"), and it is the person's OWN:
 * a map-only token minted on the recipient's row (track_token), never the holder's tracker token (that one opens the
 * report, the invoice and the other visits' links after completion). routes/track-public.js serves that token a
 * reduced view of this one visit. The other texts carry no link. The text goes through the same send layer as every
 * other text, with no
 * "customer-initiated" exemption: the send window applies, and a text held for it is persisted and
 * replayed (visit_text_recipient_deferred in messaging/deferred-replay-registry.js) after a fresh
 * visit, gate and decline check.
 */
const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const logger = require('./logger');
const { toE164, isValidNanpNumber } = require('../utils/phone');
const { mapSecondaryContactToLegacy } = require('../utils/extraction-compat');
const { dateOnlyString } = require('../utils/date-only');
const { recipientLinkEligible } = require('./track-token-expiry');
const { SCHEDULED_SMS_MAX_ATTEMPTS } = require('./messaging/scheduled-sms-limits');

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
async function recordForVisit({ scheduledServiceId, customerId = null, callLogId = null, v2Extraction, excludePhones = [], blocked = false, conn = db }) {
  const result = { recorded: [], skipped: [] };
  if (!scheduledServiceId || blocked) return { ...result, skipped: [{ reason: blocked ? 'call_sms_blocked' : 'no_visit' }] };
  const { disclaimedNumberHeld } = require('./disclaimed-number-holds');
  // The account holder already gets this visit's texts as themselves: no second row for their own number.
  const holder = await conn('scheduled_services as s').join('customers as c', 'c.id', 's.customer_id')
    .where('s.id', scheduledServiceId).first('c.phone', 's.customer_id');
  // The row is bound to the customer whose call authorized it: that customer must be the visit's own (never a visit that is
  // already someone else's), and every later send and tracker read requires the visit to still belong to them.
  if (!holder || !holder.customer_id || (customerId && String(customerId) !== String(holder.customer_id))) {
    return { ...result, skipped: [{ reason: 'customer_mismatch' }] };
  }
  for (const entry of eligibleEntries(v2Extraction, { excludePhones: [...excludePhones, holder?.phone] })) {
    if (await disclaimedNumberHeld(entry.phoneE164, conn, { strict: true })) { result.skipped.push({ reason: 'disclaimed_number' }); continue; }
    if (await suppressedNumber(entry.phoneKey, conn)) { result.skipped.push({ reason: 'suppressed' }); continue; }
    const fresh = {
      scheduled_service_id: scheduledServiceId,
      phone_key: entry.phoneKey,
      phone_e164: entry.phoneE164,
      first_name: entry.firstName ? String(entry.firstName).slice(0, 100) : null,
      last_name: entry.lastName ? String(entry.lastName).slice(0, 100) : null,
      role: entry.role,
      source: SOURCE,
      consent_version: CONSENT_VERSION,
      call_log_id: callLogId,
    };
    // NEVER rebound in place. One transaction per number, serialized per visit by an advisory lock (no row lock on the visit):
    // the visit's customer is re-read inside it, and when the same visit and number already have a row that is not bound to that
    // customer (never bound, or bound to one the visit has left) the row is DELETED and a fresh one is INSERTED, so its id is new.
    // Anything queued or in flight under the old id (a held text, a replay, a handoff recheck, a tracker token) finds no row and
    // drops. A row already bound to the visit's customer is left exactly as it is.
    const outcome = await conn.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['visit_text_recipient', String(scheduledServiceId)]);
      const visit = await trx('scheduled_services').where({ id: scheduledServiceId }).first('customer_id');
      if (!visit || !visit.customer_id || (customerId && String(customerId) !== String(visit.customer_id))) return 'customer_mismatch';
      const existing = await trx(TABLE).where({ scheduled_service_id: scheduledServiceId, phone_key: entry.phoneKey }).first('id', 'customer_id');
      if (existing && existing.customer_id && String(existing.customer_id) === String(visit.customer_id)) return 'kept';
      if (existing) await trx(TABLE).where({ id: existing.id }).del();
      await trx(TABLE).insert({ ...fresh, customer_id: visit.customer_id });
      return 'created';
    });
    if (outcome === 'customer_mismatch') { result.skipped.push({ reason: 'customer_mismatch' }); continue; }
    const rows = outcome === 'created' ? [1] : [];
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
      customerId,
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
  // The person's own saved choices row: a direct read (code-only errors, no write), whatever GATE_CONTACT_LOGIN says. That gate
  // only governs whether the contact pages and the holder's senders use the table; a decline saved there is a decline for this
  // feature too. contactPhoneDeclinesText is not used (it skips with the gate off and logs err.message). failClosed: a missing
  // or unreadable choices table THROWS (a send is held and retried, the link answers an error) instead of reading as "no choices".
  const prefs = require('./contact-notification-prefs');
  if (!prefs.contactAllows(await prefs.getContactPrefRow(customerId, phoneE164, { dbh: conn, failClosed: true }), KINDS_BY_PURPOSE[purpose]?.prefsColumn ?? null, 'sms')) return true;
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
async function contactsForVisit(scheduledServiceId, kind, { excludePhones = [], conn = db, throwOnError = false, anyVisitStatus = false } = {}) {
  if (!scheduledServiceId || !KINDS[kind]) return [];
  try {
    const visit = await conn('scheduled_services').where({ id: scheduledServiceId }).first('id', 'status', 'scheduled_date', 'window_start', 'customer_id', 'service_type');
    // `anyVisitStatus`: the tracker link also serves a visit that is on site or just completed (its own lifetime rule limits it); a send never does.
    if (!visit || (!anyVisitStatus && !LIVE_STATUSES.includes(String(visit.status || '')))) return [];
    const rows = await conn(TABLE).where({ scheduled_service_id: scheduledServiceId }).orderBy('created_at', 'asc');
    if (!rows.length) return [];
    const holder = await conn('customers').where({ id: visit.customer_id }).first('phone');
    const taken = new Set([...excludePhones, holder?.phone].map(lastTen).filter(Boolean));
    const contacts = [];
    for (const row of rows) {
      // A row bound to another customer (the visit was reassigned) or to none is nobody's to text.
      const contact = taken.has(row.phone_key) || !rowBelongsToVisitCustomer(row, visit) ? null : await ownedContact(row, visit, kind, conn);
      if (contact) contacts.push(contact);
    }
    return contacts;
  } catch (err) {
    if (throwOnError) throw err;
    logger.warn(`[call-visit-recipient] recipients unreadable for visit ${scheduledServiceId}: ${err.code || err.name || 'db_error'}`);
    return [];
  }
}

// The row was recorded for THIS visit's customer. A null customer_id (never bound) or another customer's is never eligible.
function rowBelongsToVisitCustomer(row, visit) {
  return Boolean(row && visit && row.customer_id && visit.customer_id && String(row.customer_id) === String(visit.customer_id));
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
    // The customer this row was recorded for, carried in every send's recheck and replay: a row with another binding is another row.
    recipientCustomerId: row.customer_id,
    claimKey: `${kind}:${scheduledDate || ''}T${windowStart || ''}`,
    visit: { id: visit.id, customerId: visit.customer_id, serviceType: visit.service_type, scheduledDate, windowStart },
  };
}

/**
 * The text itself: informational, no management link (see the header). Pure.
 * `facts`: { label, day, date, window, dayOnly } for a visit text; { techName, etaMinutes, trackUrl } for en route
 * (trackUrl: an https link or nothing; anything else is dropped; the sender never passes it, buildMessage derives it).
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
    const url = typeof facts.trackUrl === 'string' && /^https:\/\/\S+$/.test(facts.trackUrl) ? facts.trackUrl : null;
    const track = url ? ` Track live: ${url}` : '';
    return `${hi} Waves here. ${facts.techName || 'Your technician'} is on the way${eta}.${track} ${stop}`;
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
  // The claim value is a token, so a release (this send's own, or a queued replay's) removes ONLY the claim it made.
  const claimToken = randomUUID();
  let claimed;
  try {
    claimed = await conn(TABLE)
      .where({ id: contact.visitRecipientId, customer_id: contact.visit.customerId })
      .whereRaw('NOT jsonb_exists(deliveries, ?)', [contact.claimKey])
      .update({ deliveries: conn.raw('deliveries || jsonb_build_object(?::text, ?::text)', [contact.claimKey, claimToken]) });
  } catch (err) {
    logger.warn(`[call-visit-recipient] claim failed for ${contact.claimKey}: ${err.code || err.name || 'db_error'}`);
    return { skipped: true, reason: 'claim_failed' };
  }
  if (!claimed) return { skipped: true, reason: 'already_sent' };
  let result;
  try {
    result = await send(claimToken);
  } catch (err) {
    // A throw may have reached the provider: keep the claim (no double text) unless the error proves it did not.
    if (err && err.providerOutcome && !deliveryAccepted(err.providerOutcome)) await releaseClaim(contact.visitRecipientId, contact.claimKey, claimToken, conn);
    throw err;
  }
  if (!deliveryAccepted(result)) await releaseClaim(contact.visitRecipientId, contact.claimKey, claimToken, conn);
  return { skipped: false, result };
}

// Removes the claim only while it still holds `claimToken` (never another sender's newer claim). Best-effort for a send's own
// release; `throwOnError` is for the replay's terminal hook, which the worker retries.
async function releaseClaim(visitRecipientId, claimKey, claimToken, conn = db, { throwOnError = false } = {}) {
  const release = conn(TABLE)
    .where({ id: visitRecipientId })
    .whereRaw('deliveries ->> ? = ?', [claimKey, String(claimToken || '')])
    .update({ deliveries: conn.raw('deliveries - ?::text', [claimKey]) });
  if (throwOnError) return release;
  return release.catch((err) => logger.warn(`[call-visit-recipient] claim release failed for ${claimKey}: ${err.code || err.name || 'db_error'}`));
}

/**
 * Persist a text the send window held, to replay it later (deferred-replay-registry visit_text_recipient_deferred).
 * The row belongs to the recipient's own number and is frozen to the visit slot it describes. Returns true when queued.
 */
async function queueDeferred({ contact, kind, body, result, promiseMeta = {}, recheckMeta = {}, claimToken = null, conn = db }) {
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
      claim_token: claimToken,
      kind,
      appointment_contact_role: ROLE,
      original_block_code: 'QUIET_HOURS_HOLD',
      ...promiseMeta,
      ...(recheckMeta.arrival_start ? { arrival_start: recheckMeta.arrival_start } : {}),
      ...(recheckMeta.recipient_hint ? { recipient_hint: recheckMeta.recipient_hint } : {}),
      ...(recheckMeta.recipient_customer_id ? { recipient_customer_id: recheckMeta.recipient_customer_id } : {}),
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
 * `excludePhones`: the numbers the sender already texts. `context`: en route only, { techName, etaMinutes, trackUrlFor(token) }.
 * `dayOnly`: the holder's confirmation or 72 h reminder promised only the day, so this one does too.
 * `gate(contact)`: optional per-recipient check by the sender, 'send' (default), 'skip' or 'abort'
 * (the pipeline lost its claim). Never throws into the sender. Returns false only when a gate aborted.
 */
async function notifyVisitRecipients({ scheduledServiceId, kind, excludePhones = [], context = {}, dayOnly = false, gate = null, conn = db }) {
  if (!gateLive() || !KINDS[kind] || !scheduledServiceId) return true;
  let contacts;
  try {
    contacts = await contactsForVisit(scheduledServiceId, kind, { excludePhones, conn, throwOnError: true });
  } catch (err) {
    // A lookup that throws is NOT "nobody is owed": the person named on the call may have been left without a text. No retry
    // (a late retry cannot prove it is still for the same slot); ONE admin bell per visit and notice, so someone can text them.
    logger.warn(`[call-visit-recipient] ${kind} for visit ${scheduledServiceId}: recipients unreadable (${err.code || err.name || 'error'})`);
    await raiseUnsentBell({ scheduledServiceId, kind });
    return true;
  }
  try {
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

// The bell for a notice that could not be sent because the recipients could not be read. The copy and the dedupe key carry no
// phone number, name or link (the row is about the visit, whose page lists the person); one bell per visit and kind.
const UNSENT_WORDS = {
  confirmation: 'The booking text',
  reminder_72h: 'The 3-day reminder',
  reminder_24h: 'The next-day reminder',
  en_route: 'The on-the-way text',
};
// The dispatch page opens a visit on its day: `date` (the visit's Eastern scheduled date, YYYY-MM-DD) rides in the link as the page's
// own `date` parameter. The handoff path knows it from the claim key; the lookup path reads it (a failed read leaves it out).
async function visitDateForBell(scheduledServiceId, date) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return date;
  try {
    const row = await db('scheduled_services').where({ id: scheduledServiceId }).first('scheduled_date');
    return dateOnlyString(row && row.scheduled_date) || null;
  } catch {
    return null;
  }
}

// "Bob, ending 0002": a first name and the last 4 digits, enough for staff to tell who; never the full number.
function recipientHint(contact) {
  const first = String(contact.name || '').trim().split(/\s+/)[0] || 'The person';
  const last4 = String(contact.phone || '').replace(/\D/g, '').slice(-4);
  return last4 ? `${first}, ending ${last4}` : first;
}

async function raiseUnsentBell({ scheduledServiceId, kind, date = null, hint = null }) {
  try {
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const day = await visitDateForBell(scheduledServiceId, date);
    await raiseAdminAlert('appointment', {
      area: 'Schedule',
      action: 'check the person named on the call before texting',
      // One sentence of at most 110 characters: what was not sent, and what staff check before texting by hand.
      why: `${UNSENT_WORDS[kind] || 'A text'} was not sent; check they are on the visit, its time and that they may be texted.`,
      severity: 'needs-you',
      link: `/admin/dispatch?tab=schedule${day ? `&date=${encodeURIComponent(day)}` : ''}&appointment=${encodeURIComponent(scheduledServiceId)}`,
      subject: { type: 'visit', id: String(scheduledServiceId) },
      doneWhen: 'visit_checked',
      who: 'person',
    }, {
      bell: true,
      // Who to check: the recipient when it is known (the handoff path), every named person when the lookup itself failed.
      detail: hint
        ? `${hint} was not sent this text. Check them, and anyone else named on the call, before texting: still on the visit, the visit time, and that they may be texted.`
        : 'The people named on the call could not be read, so none of them may have been sent this text. Check every person the caller named on this visit before texting: still on the visit, the visit time, and that they may be texted.',
      dedupeKey: `visit-recipient-text-unsent:${scheduledServiceId}:${kind}`,
      metadata: { scheduledServiceId: String(scheduledServiceId), kind },
    });
  } catch (err) {
    logger.warn(`[call-visit-recipient] unsent bell for visit ${scheduledServiceId} not raised: ${err.code || err.name || 'error'}`);
  }
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

/**
 * The recipient's OWN map-only tracker credential, minted on first use. One atomic write: two senders racing get the
 * same token. The holder's tracker token is never read here: it opens the report, the invoice and the other visits' links.
 */
async function ensureTrackToken(visitRecipientId, customerId, conn = db) {
  const rows = await conn(TABLE)
    .where({ id: visitRecipientId, customer_id: customerId })
    // Minted once, in the recipient's own recognizable shape (vr_ + 48 hex); a token of any other shape is replaced by one.
    .update({ track_token: conn.raw(`CASE WHEN track_token ~ '^vr_[a-f0-9]{48}$' THEN track_token ELSE ${RECIPIENT_TRACK_TOKEN_MINT_SQL} END`) })
    .returning('track_token');
  const first = Array.isArray(rows) ? rows[0] : null;
  return (first && typeof first === 'object' ? first.track_token : first) || null;
}

// The recipient's tracker link: the sender supplies `context.trackUrlFor(token)` (it knows the public origin and the
// shortener); this module only mints the token. Any failure sends the text without the link.
async function recipientTrackUrl(contact, context, conn) {
  if (!context || typeof context.trackUrlFor !== 'function') return null;
  try {
    // Nothing is minted for a link that could not open right now: the visit must satisfy the SAME eligibility rule the tracker
    // route and the resolver apply (a live finite expiry on the visit's own link, and a live state: en route, on site or just
    // completed; not parked or rebooking). Otherwise the text goes without the link and no token is made.
    const visit = await readLinkVisit(contact.visit.id, conn);
    if (!visit || !recipientLinkEligible(visit)) return null;
    const token = await ensureTrackToken(contact.visitRecipientId, contact.visit.customerId, conn);
    return token ? await context.trackUrlFor(token) : null;
  } catch (err) {
    logger.warn(`[call-visit-recipient] tracker link unavailable for visit ${contact.visit.id}: ${err.code || err.name || 'error'}`);
    return null;
  }
}

const { RECIPIENT_TRACK_TOKEN_RE: TRACK_TOKEN_RE, RECIPIENT_TRACK_TOKEN_MINT_SQL } = require('../utils/recipient-track-token');

/**
 * The visit a recipient's tracker token opens, or null. The link works only while the gate is on, the row still exists
 * (it goes with the visit), and the person is still owed the en-route text by the SAME check the send makes at the provider handoff (recipientPermission: no callback-number hold,
 * no decline, STOP, suppression or do-not-contact), and the visit's own link has a live expiry on record (a null
 * expiry is refused). The caller serves the reduced, map-only view. Throws on an unreadable answer (the route answers an error, never an open view).
 */
async function visitForTrackToken(token, { conn = db } = {}) {
  if (!gateLive() || !TRACK_TOKEN_RE.test(token || '')) return null;
  try {
    return await resolveTrackToken(token, conn);
  } catch (err) {
    // A knex error message carries the bound values: never let the token reach a log through it.
    throw Object.assign(new Error('visit-only tracker link lookup failed'), { code: err && err.code });
  }
}

async function resolveTrackToken(token, conn) {
  const row = await conn(TABLE).where({ track_token: token }).first('id', 'scheduled_service_id', 'customer_id');
  if (!row) return null;
  // The cheap check FIRST: the short lifetime (en route within 3 h of en_route_at, on site within 4 h of arrived_at, or up to two
  // hours after completion; never scheduled,
  // cancelled, skipped, parked or rebooking) and a live, finite expiry on the visit's own tracker link. A closed link
  // answers here, with no permission read at all.
  // After the token lookup, ANY failure (the visit read, the permission reads, the final recheck) answers null, exactly as an
  // unknown token does, with a code-only log: only an error on the token lookup above may surface as an error (a 500).
  try {
    const visit = await readLinkVisit(row.scheduled_service_id, conn);
    if (!visit || !rowBelongsToVisitCustomer(row, visit) || !recipientLinkEligible(visit)) return null;
    // Only a link that can still open pays for the permission reads: the same check the en-route send makes at the
    // provider handoff, read fresh on every request.
    const permission = await recipientPermission({ scheduled_service_id: row.scheduled_service_id, kind: 'en_route', visit_recipient_id: row.id, recipient_customer_id: row.customer_id }, { conn, anyVisitStatus: true });
    if (!permission.ok) return null;
    // The final recheck: the visit as it stands now, after the permission reads.
    const again = await readLinkVisit(row.scheduled_service_id, conn);
    if (!again || !rowBelongsToVisitCustomer(row, again) || !recipientLinkEligible(again)) return null;
    return { visitId: visit.id, recipientId: row.id, customerId: again.customer_id };
  } catch (err) {
    logger.warn(`[call-visit-recipient] tracker link check unreadable (code=${err && err.code ? err.code : 'none'}), answering as unknown`);
    return null;
  }
}

// Every field recipientLinkEligible reads (the one rule shared with the track route).
function readLinkVisit(scheduledServiceId, conn) {
  return conn('scheduled_services').where({ id: scheduledServiceId })
    .first('id', 'customer_id', 'status', 'track_state', 'completed_at', 'en_route_at', 'arrived_at', 'track_token_expires_at', 'customer_pick_by', 'window_start');
}

// The copy and the slot the send is guarded on. null = nothing sendable.
async function buildMessage(contact, kind, context, dayOnly, conn) {
  const firstName = String(contact.name || '').trim().split(/\s+/)[0] || null;
  if (kind === 'en_route') {
    // The tracker link (a minted token and a short-code row, each a bearer credential) is made only AFTER this send wins
    // the once-per-slot claim, by withLink: a skipped or repeated attempt mints nothing. `body` is the copy without it.
    return {
      body: informationalBody(kind, firstName, { ...context, trackUrl: null }),
      slotMs: null,
      arrivalStart: null,
      withLink: async () => informationalBody(kind, firstName, { ...context, trackUrl: await recipientTrackUrl(contact, context, conn) }),
    };
  }
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
  const { body, slotMs, arrivalStart, withLink } = message;
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
    // Who staff should check if this text cannot be confirmed at the handoff: the first name and the LAST 4 digits only.
    recipient_hint: recipientHint(contact),
    recipient_customer_id: contact.recipientCustomerId,
    ...(dayOnly ? { promise_level: 'day' } : {}),
    ...(arrivalStart && !dayOnly ? { arrival_start: arrivalStart } : {}),
  };
  const outcome = await sendOnce(contact, async (claimToken) => {
    // The claim is won: only now is the en-route link made.
    const sendBody = withLink ? await withLink() : body;
    // No customerInitiated: this text goes to someone who did not call, so the send window applies.
    const result = await sendCustomerMessage({
      to: contact.phone,
      body: sendBody,
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
      if (await queueDeferred({ contact, kind, body, result, promiseMeta, recheckMeta, claimToken, conn })) return { ...result, visitRecipientQueued: true };
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
const noVerdict = (code, reason) => ({ ok: false, code, reason });

/**
 * The permission half of "still owed": the gate is on, the visit has no callback-number hold, and the person is still on
 * the visit and has declined nothing (own text choices, opt-in decline, STOP, any active suppression or do-not-contact).
 * ONE function for the send's handoff recheck (recipientStillOwed, below, adds the slot checks), the replay and the
 * tracker link (visitForTrackToken), so no door opens that another keeps shut. Returns { ok:true, mine } or a verdict.
 * `anyVisitStatus`: the tracker link also serves a visit that is on site or just completed. Throws on an unreadable answer.
 */
async function recipientPermission(meta, { conn = db, anyVisitStatus = false } = {}) {
  if (!gateLive()) return noVerdict('VISIT_TEXT_GATE_OFF', 'gate-off');
  // The raw reader THROWS on a failed read (the boolean wrapper turns it into "held"): a failed read retries, never drops the text.
  if (await require('./disclaimed-number-holds').disclaimedNumberHeldForVisit({ scheduledServiceId: meta.scheduled_service_id }, conn, { strict: true })) {
    return noVerdict('CALLBACK_NUMBER_HOLD', 'callback-number-hold');
  }
  const contacts = await contactsForVisit(meta.scheduled_service_id, meta.kind, { conn, throwOnError: true, anyVisitStatus });
  const mine = contacts.find((contact) => contact.visitRecipientId === meta.visit_recipient_id);
  if (!mine) return noVerdict('VISIT_RECIPIENT_NOT_OWED', 'recipient-not-owed');
  // The row must be the one the send was built with: its id (found above) AND its customer binding. A caller with no recorded
  // customer is not owed. This also drops any text queued before the binding existed, deliberately and with no backfill:
  // GATE_CALL_GIVEN_VISIT_TEXTS has never been on in production, so no such queued row exists.
  if (!meta.recipient_customer_id || String(mine.recipientCustomerId || '') !== String(meta.recipient_customer_id)) {
    return noVerdict('VISIT_RECIPIENT_NOT_OWED', 'recipient-not-owed');
  }
  // The hold on the visit above is the HOLDER's number; the person's own number can be held by another call.
  if (await require('./disclaimed-number-holds').disclaimedNumberHeld(mine.phone, conn, { strict: true })) {
    return noVerdict('RECIPIENT_NUMBER_HOLD', 'recipient-number-hold');
  }
  // A do-not-contact request heard on any call with the person's number (a plain read of call_log).
  // A do-not-contact request or an explicit "no texts" heard on any call with the number, in every place a spoken number
  // lives: ONE read of call_log (a plain read, no logging), because the link re-reads this on every poll.
  const vetoes = await require('./messaging/auto-text-holds').callVetoesForNumber(mine.phone, { dbi: conn });
  if (vetoes.doNotContact) return noVerdict('CALL_DO_NOT_CONTACT', 'asked-not-to-be-contacted');
  if (vetoes.smsDeclined) return noVerdict('CALL_SMS_DECLINED', 'said-no-texts');
  return { ok: true, mine };
}

async function recipientStillOwed(meta, { conn = db } = {}) {
  const no = noVerdict;
  const permission = await recipientPermission(meta, { conn });
  if (!permission.ok) return permission;
  const { mine } = permission;
  const sameSlot = meta.promise_level === 'day' ? claimDate(mine.claimKey) === claimDate(meta.claim_key) : mine.claimKey === meta.claim_key;
  if (!sameSlot) return no('VISIT_SLOT_MOVED', 'slot-moved');
  if (meta.arrival_start && (await arrivalSnapshot(mine.visit, conn)).hhmm !== meta.arrival_start) return no('VISIT_ARRIVAL_MOVED', 'arrival-moved');
  // A queued day-only text is frozen: it may go only while the day promise still stands (the 24-hour reminder still on, no later
  // promise delivered). A fresh send just made that decision with the holder's, so only a replay re-asks.
  if (meta.replay && meta.promise_level === 'day') {
    const verdict = await require('./appointment-reminders').revalidateDelayedDaySend({ customerId: mine.visit.customerId, scheduledServiceId: meta.scheduled_service_id });
    if (verdict !== 'day') return no('VISIT_DAY_PROMISE_STALE', verdict === 'suppress' ? 'day-promise-superseded' : 'day-promise-no-longer-valid');
  }
  return { ok: true };
}

/** The provider-boundary predicate of a visit-only send (immediate and replayed): the verdict the send layer expects. */
async function providerCheck(meta, { conn = db } = {}) {
  try {
    return await recipientStillOwed(meta, { conn });
  } catch (err) {
    logger.warn(`[call-visit-recipient] handoff recheck unreadable for visit ${meta.scheduled_service_id}: ${err.code || err.name || 'error'}`);
    // Unreadable is not a decline: the text is held and may never be retried, so tell staff (the same bell, once per visit and notice).
    // An immediate send is never retried, so it rings now. A deferred replay retries a retryable check failure: it rings only when
    // THIS is the replay's last attempt (the scheduler counts the attempt in scheduled_sms_attempts and gives up at the cap).
    if (meta.replay && !isLastReplayAttempt(meta)) {
      return { ok: false, code: 'VISIT_RECIPIENT_CHECK_FAILED', reason: 'recheck-failed', retryable: true };
    }
    await raiseUnsentBell({ scheduledServiceId: meta.scheduled_service_id, kind: meta.kind, date: claimDate(meta.claim_key), hint: meta.recipient_hint });
    return { ok: false, code: 'VISIT_RECIPIENT_CHECK_FAILED', reason: 'recheck-failed', retryable: true };
  }
}

// The scheduler counts each replay attempt in scheduled_sms_attempts (this attempt included) and gives up at the cap.
function isLastReplayAttempt(meta) {
  return (Number(meta && meta.scheduled_sms_attempts) || 1) >= SCHEDULED_SMS_MAX_ATTEMPTS;
}

/** The replay's fresh check, before a queued text goes out. True when still owed; throws on an unreadable answer. */
async function recipientStillOwedDeferred(meta, { conn = db } = {}) {
  try {
    return (await recipientStillOwed({ ...meta, replay: true }, { conn })).ok === true;
  } catch (err) {
    // An unreadable answer is retried, and staff hear about it only when the LAST attempt also could not read it: the text then
    // ends undelivered (the same deduped bell the handoff check raises). The bell never changes the rethrow below.
    if (isLastReplayAttempt(meta)) {
      await raiseUnsentBell({ scheduledServiceId: meta.scheduled_service_id, kind: meta.kind, date: claimDate(meta.claim_key), hint: meta.recipient_hint });
    }
    // The replay registry logs a thrown error's message, and a knex message carries the bound values (a phone, a claim): rethrow
    // a fresh error with only the code. It still throws, so the registry holds the row for a retry (retryable).
    throw Object.assign(new Error('visit-only replay recheck failed'), { code: err && err.code });
  }
}

/** A replay that ended without sending gives ITS claim back (matched by its token), so a later sender can still owe the text. A
 *  repeat of this hook after another sender has claimed the slot deletes nothing. A failed release throws: the worker retries it. */
function releaseDeferredClaim(meta, { conn = db } = {}) {
  if (!meta || !meta.visit_recipient_id || !meta.claim_key || !meta.claim_token) return Promise.resolve();
  return Promise.resolve(releaseClaim(meta.visit_recipient_id, meta.claim_key, meta.claim_token, conn, { throwOnError: true }))
    .catch((err) => { throw Object.assign(new Error('visit-only replay release failed'), { code: err && err.code }); });
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
  ensureTrackToken,
  visitForTrackToken,
  notifyVisitRecipients,
  sendOnce,
  deliveryAccepted,
  recipientStillOwed,
  recipientStillOwedDeferred,
  providerCheck,
  releaseDeferredClaim,
};
