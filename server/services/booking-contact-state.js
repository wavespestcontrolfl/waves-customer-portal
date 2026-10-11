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

// Why no leg is open: the first switched-off channel the customer's chosen channel needs, else nobody to reach.
function noConfirmationReason(t) {
  if (t.channel !== 'email' && !t.sms) return 'texts are off';
  if ((t.channel === 'email' || t.channel === 'both') && !t.email) return 'email is off';
  return 'no phone or email to reach';
}

// The card's two lines (confirmation, welcome), from the pinned state. Masked; never an address or a full number.
function contactCardLines(state, { sendTexts, welcome }) {
  const lines = [];
  const t = state.toggles;
  if (sendTexts) {
    const text = t.channel !== 'email' && t.sms ? state.textTo.map((p) => maskPhone(p)).filter(Boolean) : [];
    const email = (t.channel === 'email' || t.channel === 'both') && t.email ? state.emailTo.map(maskEmail).filter(Boolean) : [];
    const legs = [text.length && `${text.join(', ')} by text`, email.length && `${email.join(', ')} by email`].filter(Boolean);
    if (!t.confirmation) lines.push('No confirmation message: the customer turned appointment confirmations off');
    else if (legs.length) lines.push(`Confirmation goes to ${legs.join(' and ')}`);
    else lines.push(`No confirmation message: ${noConfirmationReason(t)}`);
  }
  if (welcome) {
    const account = state.accountToggles || t;
    const text = account.sms ? maskPhone(state.holder.phone) : null;
    const email = account.email ? maskEmail(state.holder.email) : null;
    const legs = [text && `${text} by text`, email && `${email} by email`].filter(Boolean);
    lines.push(legs.length ? `Welcome goes to ${legs.join(' and ')}` : 'No welcome message: no phone or email to reach, or texts and email are off');
  }
  return lines;
}

// The durable pin a card-approved booking writes (activity_log, inside the booking transaction) for each visit it
// creates: { scheduled_service_id, contact_key }. The confirmation sender re-checks it against the live customer, so a
// send that happens later (the recovery sweep included) cannot reach recipients the card did not show.
const CONTACT_PIN_ACTION = 'booking_contact_pin';

module.exports = { CONTACT_PIN_ACTION, bookingContactState, contactKey, confirmationKey, welcomeKey, currentContactKey, contactCardLines, maskPhone, maskEmail };
