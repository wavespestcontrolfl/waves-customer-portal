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

async function bookingContactState(customerId) {
  try {
    const AppointmentReminders = require('./appointment-reminders');
    const AppointmentEmail = require('./appointment-email')._private;
    const { getAppointmentContacts } = require('./customer-contact');
    const prefs = await AppointmentReminders.getReminderPrefs(customerId);
    if (prefs.unavailable) return { unavailable: true };
    const customer = await AppointmentEmail.loadCustomer(customerId);
    if (!customer) return { unavailable: true };
    const emailRecipients = await AppointmentEmail.resolveRecipients(customer);
    return {
      unavailable: false,
      textTo: uniqueSorted(getAppointmentContacts(customer, prefs.raw).map((c) => digits10(c.phone))),
      emailTo: uniqueSorted(emailRecipients.map((r) => String(r.email || '').trim().toLowerCase())),
      holder: { phone: digits10(customer.phone), email: String(customer.email || '').trim().toLowerCase() || null },
      toggles: {
        channel: prefs.confirmationChannel, confirmation: prefs.appointmentConfirmation,
        sms: prefs.smsEnabled, email: prefs.emailEnabled,
      },
    };
  } catch {
    return { unavailable: true };
  }
}

// The recipient key the card pins and the rail and the senders compare: a hash, so no address rides the version.
function contactKey(state) {
  return crypto.createHash('sha256').update(JSON.stringify([state.textTo, state.emailTo, state.holder, state.toggles])).digest('hex');
}

// Cheap helper for callers that only need the key (rail, post-commit check).
async function currentContactKey(customerId) {
  const state = await bookingContactState(customerId);
  return state.unavailable ? null : contactKey(state);
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
    const text = t.sms ? maskPhone(state.holder.phone) : null;
    const email = t.email ? maskEmail(state.holder.email) : null;
    const legs = [text && `${text} by text`, email && `${email} by email`].filter(Boolean);
    lines.push(legs.length ? `Welcome goes to ${legs.join(' and ')}` : 'No welcome message: no phone or email to reach, or texts and email are off');
  }
  return lines;
}

// The durable pin a card-approved booking writes (activity_log, inside the booking transaction) for each visit it
// creates: { scheduled_service_id, contact_key }. The confirmation sender re-checks it against the live customer, so a
// send that happens later (the recovery sweep included) cannot reach recipients the card did not show.
const CONTACT_PIN_ACTION = 'booking_contact_pin';

module.exports = { CONTACT_PIN_ACTION, bookingContactState, contactKey, currentContactKey, contactCardLines, maskPhone, maskEmail };
