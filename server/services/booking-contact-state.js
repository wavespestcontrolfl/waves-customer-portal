/**
 * Who a booking's customer messages will reach, and whether they are on.
 *
 * The Intelligence Bar's start_program card names the recipients of the booking confirmation and the welcome, pins
 * them, and the booking re-reads them after the customer row lock (CONTACT_CHANGED rail) and again just before the
 * deferred confirmation and welcome go out. The reads are the senders' own, not a copy of their rules:
 *   - the confirmation toggles and channel: appointment-reminders getReminderPrefs;
 *   - the text recipients: customer-contact getAppointmentContacts, as safeSendAppointment calls it;
 *   - the email recipients: appointment-email resolveRecipients;
 *   - the welcome goes to the account holder's own phone and email (new-recurring-welcome-sms reads the row).
 * Each pin is built from the row ITS sender reads, through that sender's own exported loader (no copy): the text leg from
 * the raw row appointment-reminders getCustomerAndTech returns (a secondary profile's blank phone stays blank), the email
 * leg from appointment-email loadCustomer, the welcome from new-recurring-welcome-sms loadWelcomeCustomer. Every read goes
 * through `conn` (the booking transaction when one is given), never the global pool: a booking holding its connection
 * must not wait on a second one.
 *
 * Two scopes, two keys. The CONFIRMATION is scoped to the property the visits are stamped with: the real sender passes
 * the visit id, so a saved property's own toggles and "send these to me too" (property_notification_prefs, via
 * property-notification-prefs resolvePropertyPrefs, the visit rule keyed by property id) decide who it reaches. The
 * WELCOME is account-level: the holder's row and the account toggles. confirmationKey and welcomeKey hash them apart.
 * A read that cannot be completed is { unavailable: true }; callers refuse rather than guess.
 */
const crypto = require('crypto');

const digits10 = (value) => String(value || '').replace(/\D/g, '').slice(-10);
const uniqueSorted = (list) => [...new Set(list.filter(Boolean))].sort();

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : null;
}

function maskEmail(address) {
  const [local, domain] = String(address || '').split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : null;
}

const toggleSet = (prefs) => ({
  channel: prefs.confirmationChannel, confirmation: prefs.appointmentConfirmation,
  sms: prefs.smsEnabled, email: prefs.emailEnabled,
});

// `propertyId`: the saved property the visits are stamped with (null = the customer row decides, as for a primary or
// unstamped visit). `toggles`/`textTo`/`emailTo` are that property's; `accountToggles` and `holder` are the account's.
async function bookingContactState(customerId, { propertyId = null, conn = null } = {}) {
  try {
    const AppointmentReminders = require('./appointment-reminders');
    const AppointmentEmail = require('./appointment-email')._private;
    const { loadWelcomeCustomer } = require('./new-recurring-welcome-sms');
    const { getAppointmentContacts } = require('./customer-contact');
    const handle = conn || require('../models/db');
    const accountPrefs = await AppointmentReminders.getReminderPrefs(customerId, { conn: handle });
    if (accountPrefs.unavailable) return { unavailable: true };
    const prefs = propertyId ? await AppointmentReminders.getReminderPrefs(customerId, { propertyId, conn: handle }) : accountPrefs;
    if (prefs.unavailable) return { unavailable: true };
    const textCustomer = (await AppointmentReminders.getCustomerAndTech(customerId, null, handle)).customer;
    const emailCustomer = await AppointmentEmail.loadCustomer(customerId, handle);
    const welcomeCustomer = await loadWelcomeCustomer(customerId, handle);
    if (!textCustomer || !emailCustomer || !welcomeCustomer) return { unavailable: true };
    const emailRecipients = await AppointmentEmail.resolveRecipients(emailCustomer, { propertyId, conn: handle });
    return {
      unavailable: false,
      textTo: uniqueSorted(getAppointmentContacts(textCustomer, prefs.raw).map((c) => digits10(c.phone))),
      emailTo: uniqueSorted(emailRecipients.map((r) => String(r.email || '').trim().toLowerCase())),
      holder: { phone: digits10(welcomeCustomer.phone), email: String(welcomeCustomer.email || '').trim().toLowerCase() || null },
      toggles: toggleSet(prefs),
      accountToggles: toggleSet(accountPrefs),
    };
  } catch {
    return { unavailable: true };
  }
}

// Share-lock the rows the recipient key is read from, inside the booking transaction and BEFORE the key is read: the
// account primary's customers row (the contact fallback of a secondary profile), the customer's own notification_prefs row, the account owner's (the confirmation channel is read from the owner's row for a
// secondary profile) and the saved property's per-property row. A writer that updates one of them (the admin
// notification-prefs save locks its row FOR UPDATE) then waits for the booking to commit, or commits first and is seen,
// so it cannot slip in between the rail's read and the booking commit. Rows are taken in sorted order.
async function lockContactPrefs(conn, customerId, { propertyId = null } = {}) {
  // A secondary profile with blank contact fields has its email and phone filled from the account primary's customers row
  // (appointment-email loadCustomer, withAccountPrimaryContact), so that row is part of what the key is read from. FOR SHARE
  // (not KEY SHARE): an ordinary UPDATE of the primary's phone or email must wait for the booking. Own row first (the
  // caller holds it FOR UPDATE), then this fallback row, then the prefs rows. One statement, no preceding read.
  await conn('customers')
    .whereRaw(
      `id <> ? AND is_primary_profile = true AND deleted_at IS NULL
        AND account_id = (SELECT account_id FROM customers WHERE id = ? AND is_primary_profile IS NOT TRUE)`,
      [customerId, customerId],
    )
    .forShare().select('id');
  // One locking statement per table and no preceding read: the rails take every lock before their first read. The owner
  // row is found inside the statement (the profile itself, plus the account primary when the profile is a secondary one).
  await conn('notification_prefs')
    .whereRaw(
      `customer_id IN (SELECT id FROM customers WHERE id = ?
        OR (is_primary_profile = true AND account_id = (SELECT account_id FROM customers WHERE id = ? AND is_primary_profile IS NOT TRUE)))`,
      [customerId, customerId],
    )
    .orderBy('customer_id').forShare().select('customer_id');
  if (propertyId) await conn('property_notification_prefs').where({ property_id: propertyId }).forShare().select('property_id');
}

const sha = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');

// The keys the card pins and the rail and the senders compare: hashes, so no address rides the version.
// The confirmation key covers who the confirmation reaches and whether it is on (the property's scope);
// the welcome key covers the account holder's own phone and email and the account toggles.
const confirmationKey = (state) => sha([state.textTo, state.emailTo, state.toggles]);
const welcomeKey = (state) => sha([state.holder, state.accountToggles || state.toggles]);
const contactKey = confirmationKey;

// Cheap helper for callers that only need one key (rail, post-commit check, send-time check).
// kind 'confirmation' (default) is scoped to `propertyId`; kind 'welcome' is account-level.
async function currentContactKey(customerId, { propertyId = null, kind = 'confirmation', conn = null } = {}) {
  const state = await bookingContactState(customerId, kind === 'welcome' ? { conn } : { propertyId, conn });
  if (state.unavailable) return null;
  return kind === 'welcome' ? welcomeKey(state) : confirmationKey(state);
}

// The confirmation key from rows the CALLER already loaded (the deferred sender's own prefs and customer row), so the send
// it guards goes to exactly the recipients hashed here. The text leg is built from those rows (the sender's SMS attempt is
// handed the same rows); only the email leg is read now, through the email sender's own loaders. null = could not be read.
async function confirmationKeyFromLoaded(customerId, { prefs, textCustomer, propertyId = null, conn = null, out = null } = {}) {
  try {
    if (!prefs || prefs.unavailable || !textCustomer) return null;
    const AppointmentEmail = require('./appointment-email')._private;
    const { getAppointmentContacts } = require('./customer-contact');
    const handle = conn || require('../models/db');
    const emailCustomer = await AppointmentEmail.loadCustomer(customerId, handle);
    if (!emailCustomer) return null;
    const emailRecipients = await AppointmentEmail.resolveRecipients(emailCustomer, { propertyId, conn: handle });
    const state = {
      textTo: uniqueSorted(getAppointmentContacts(textCustomer, prefs.raw).map((c) => digits10(c.phone))),
      emailTo: uniqueSorted(emailRecipients.map((r) => String(r.email || '').trim().toLowerCase())),
      toggles: toggleSet(prefs),
    };
    // `out`: the caller's out-param for the checked email set (the email leg is limited to it).
    if (out) out.emailTo = state.emailTo;
    return confirmationKey(state);
  } catch {
    return null;
  }
}

// Why no leg is open: the first switched-off channel the customer's chosen channel needs, else nobody to reach.
function noConfirmationReason(t) {
  if (t.channel !== 'email' && !t.sms) return 'texts are off';
  if ((t.channel === 'email' || t.channel === 'both') && !t.email) return 'email is off';
  return 'no phone or email to reach';
}

// The card's two lines (confirmation, welcome), from the pinned state. Masked; never an address or a full number.
// The confirmation legs the pinned state reaches ("***0134 by text", "l***@example.com by email"); empty when confirmations
// are off or no channel has anyone to reach. The card's confirmation line and the receipt's "queued" claim both read this.
function confirmationLegs(state) {
  const t = state.toggles;
  if (!t.confirmation) return [];
  const text = t.channel !== 'email' && t.sms ? state.textTo.map((p) => maskPhone(p)).filter(Boolean) : [];
  const email = (t.channel === 'email' || t.channel === 'both') && t.email ? state.emailTo.map(maskEmail).filter(Boolean) : [];
  return [text.length && `${text.join(', ')} by text`, email.length && `${email.join(', ')} by email`].filter(Boolean);
}

function confirmationLine(state) {
  const legs = confirmationLegs(state);
  if (!state.toggles.confirmation) return 'No confirmation message: the customer turned appointment confirmations off';
  return legs.length ? `Confirmation goes to ${legs.join(' and ')}` : `No confirmation message: ${noConfirmationReason(state.toggles)}`;
}

// The welcome legs the pinned state reaches, masked: the account holder's own phone (when texts are on) and email (when
// email is on and today's signup email does not already cover it). The card line and the receipt's "queued" claim both
// read this. A leg is null when it is off or has nobody to reach.
function welcomeLegs(state, { welcomeEmailCovered = false } = {}) {
  const account = state.accountToggles || state.toggles;
  return {
    text: account.sms ? maskPhone(state.holder.phone) : null,
    // The welcome EMAIL is skipped when today's signup email already covers it (GATE_SIGNUP_SINGLE_EMAIL); the text is not.
    email: account.email && !welcomeEmailCovered ? maskEmail(state.holder.email) : null,
  };
}

function contactCardLines(state, { sendTexts, welcome, welcomeEmailCovered = false }) {
  const lines = [];
  const t = state.toggles;
  if (sendTexts) lines.push(confirmationLine(state));
  if (welcome) {
    const { text, email } = welcomeLegs(state, { welcomeEmailCovered });
    const legs = [text && `${text} by text`, email && `${email} by email`].filter(Boolean);
    lines.push(legs.length ? `Welcome goes to ${legs.join(' and ')}` : 'No welcome message: no phone or email to reach, or texts and email are off');
  }
  return lines;
}

// The durable pin a card-approved booking writes (activity_log, inside the booking transaction) for each visit it
// creates: { scheduled_service_id, contact_key }. The confirmation sender re-checks it against the live customer, so a
// send that happens later (the recovery sweep included) cannot reach recipients the card did not show.
const CONTACT_PIN_ACTION = 'booking_contact_pin';

module.exports = { CONTACT_PIN_ACTION, lockContactPrefs, bookingContactState, contactKey, confirmationKey, welcomeKey, currentContactKey, confirmationKeyFromLoaded, contactCardLines, confirmationLegs, welcomeLegs, maskPhone, maskEmail };
