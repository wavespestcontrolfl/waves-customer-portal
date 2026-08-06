/**
 * Appointment Reminder Service v2
 *
 * Manages SMS reminders for scheduled services:
 *   - Confirmation SMS (on booking, for booking_new / admin_manual sources)
 *   - 72-hour reminder
 *   - 24-hour reminder
 *   - Reschedule / cancellation notices
 *
 * Landline detection via Twilio Lookup API — skips SMS for landlines.
 * All dates displayed in America/New_York timezone.
 */

const db = require('../models/db');
const logger = require('./logger');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { readCachedLineType, cacheLineType } = require('./messaging/validators/line-type');
const { getAppointmentContacts, isServiceContactRole, firstNameFrom, PREFS_UNAVAILABLE } = require('./customer-contact');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { TZ, parseETDateTime, formatETDay, formatETDate, formatETTime, etDateString, addETDays, etParts } = require('../utils/datetime-et');
const AppointmentEmail = require('./appointment-email');
const NotificationService = require('./notification-service');
const { buildRescheduleLink } = require('./reschedule-link');
const { buildAppointmentLink } = require('./appointment-link');

// Service states for which a reminder must never fire. A reminder row can be
// armed (cancelled=false) while its underlying scheduled_service moved into one
// of these states through a path that didn't flip the row's cancelled flag —
// recurring-series cancels, bulk status edits, the customer-portal
// reschedule-request flow, day-of skip/no-show, etc. The cron re-checks the
// live service status at send time so no phantom reminder goes out. Statuses
// match scheduled_services_status_check; lowercased before lookup, with the
// 'canceled' spelling tolerated defensively.
//
// Two tiers:
//  - SELF_HEAL: genuinely terminal — the row will never produce a future visit,
//    so mark it cancelled and never re-check it.
//  - 'rescheduled': a pending-rebook marker, NOT terminal. The customer-portal
//    request flow sets it before staff pick the new slot; the rebook reuses the
//    same row via handleReschedule (which re-arms it). So skip the stale-slot
//    text but leave the row armed — never self-cancel it, or the rebooked
//    appointment loses its reminders.
const SELF_HEAL_TERMINAL_STATUSES = new Set(['cancelled', 'canceled', 'completed', 'skipped', 'no_show']);
const REMINDER_BLOCKING_STATUSES = new Set([...SELF_HEAL_TERMINAL_STATUSES, 'rescheduled']);

// Per-run cap for the registration self-heal sweep (selfHealMissingReminderRows).
// Bounds each 15-min cron run; a large backlog drains within a few hours.
const SELF_HEAL_REGISTRATION_LIMIT = 25;

// ── SMS → email fallback ──
// Appointment texts are SMS-first. When the SMS cannot be delivered (landline /
// carrier-undeliverable / no mobile / blocked) we send the same information by
// email instead so the customer still gets the notice. Only confirmation, 72h,
// 24h, and en-route messages are covered (en-route email lives in services/twilio.js
// for the live send; the async-delivery path here only learns the landline for it).
const FALLBACK_KIND_LABEL = {
  confirmation: 'appointment confirmation',
  '72h': '72-hour appointment reminder',
  '24h': '24-hour appointment reminder',
  en_route: 'technician en-route notice',
};

// messaging_audit_log purpose / original_message_type → fallback kind.
const PURPOSE_TO_KIND = {
  appointment_confirmation: 'confirmation',
  appointment_reminder_72h: '72h',
  appointment_reminder_24h: '24h',
  tech_en_route: 'en_route',
};
const MTYPE_TO_KIND = {
  confirmation: 'confirmation',
  appointment_confirmation: 'confirmation',
  reminder_72h: '72h',
  reminder_24h: '24h',
  tech_en_route: 'en_route',
};

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim().toLowerCase());
}

// True when at least one of the appointment's SMS recipients (the same set
// getAppointmentContacts routes sends to) has a delivered SMS in the last 60
// days AND could still receive one today: SMS not disabled at the customer
// level and no active suppression (STOP / wrong number / DNC / carrier
// landline) on that number. Checking the recipient set — not just the primary
// phone — matters when the notice routes to a distinct service contact; the
// owner's phone being reachable doesn't reach the person the appointment
// notifies. Best-effort — DB misses fail open per leg but never throw.
async function hasTextReachableApptRecipient(customer) {
  const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => PREFS_UNAVAILABLE);
  // sms_enabled=false blocks every SMS to this customer at send time, so a
  // past delivery can't make them text-reachable today.
  if (prefs?.sms_enabled === false) return false;

  // Same opt-in hold as the send path: a held (unconfirmed) recipient can't
  // count as text-reachable, or the no-reachable-channel human alert gets
  // suppressed by a phone we deliberately are not texting (#2956 r4).
  const { filterRecipientsByOptin } = require('./recipient-optin');
  const reachableContacts = await filterRecipientsByOptin(
    getAppointmentContacts(customer, prefs || {}), customer.id
  ).catch(() => getAppointmentContacts(customer, prefs || {}));
  for (const contact of reachableContacts) {
    const digits = lastTenDigits(contact.phone);
    if (!digits) continue;
    const delivered = await db('sms_log')
      .whereRaw("right(regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g'), 10) = ?", [digits])
      .where('status', 'delivered')
      .where('created_at', '>=', db.raw("now() - interval '60 days'"))
      .first('id')
      .catch(() => null);
    if (!delivered) continue;
    // An active suppression blocks every send now, regardless of history.
    const suppressed = await db('messaging_suppression')
      .whereRaw("right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ?", [digits])
      .where('active', true)
      .first('phone')
      .catch(() => null);
    if (!suppressed) return true;
  }
  return false;
}

// Raise a single admin alert when an appointment notice can reach the customer
// by neither SMS nor email, so a human can call them or add an email. Deduped to
// one bell entry per customer+occurrence per 24h.
async function alertNoReachableChannel({ customerId, kind, scheduledServiceId = null, emailReason = 'missing' }) {
  try {
    if (!customerId) return;
    const dedupeKey = `appt-no-channel:${customerId}:${scheduledServiceId || kind}`;
    const existing = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
      .where('created_at', '>=', db.raw("now() - interval '24 hours'"))
      .first('id')
      .catch(() => null);
    if (existing) return;

    const customer = await db('customers').where({ id: customerId }).first().catch(() => null);

    // False-positive guard: this alert claims the customer is reachable by
    // "neither text nor email". But a one-off Twilio 30006 permanently caches the
    // primary phone as landline, and a suppressed email (hard bounce / spam
    // complaint) blocks the email leg — so a customer whose mobile actually
    // DELIVERS texts can wrongly trip this bell. Before ringing it, confirm there
    // is genuinely no working text channel — judged against the numbers this
    // appointment actually notifies AND their current eligibility, so an old
    // delivery to an opted-out number (or to the owner when the notice routes
    // to a service contact) doesn't swallow a real alert.
    if (customer && await hasTextReachableApptRecipient(customer)) {
      logger.info(`[appt-remind] Suppressed no-channel alert for customer ${customerId} (${kind}) — recent delivered SMS to an appointment recipient proves text-reachable`);
      return;
    }

    const name = customer
      ? ([customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || customer.company_name || 'Customer')
      : 'Customer';
    const label = FALLBACK_KIND_LABEL[kind] || 'appointment notice';
    // State the ACTUAL email failure. The old copy hardcoded "(landline / no
    // mobile) and there is no email on file", which misreported suppressed
    // addresses as missing ones (prod 2026-07-07: customer HAD an email on
    // file — it was hard-bounced) and asserted a landline diagnosis this
    // code never made. SMS failure detail isn't available here; don't guess.
    const emailClause = emailReason === 'suppressed'
      ? 'the email address on file is suppressed (hard bounce / do-not-email) — collect a working address'
      : 'there is no email on file';
    await NotificationService.notifyAdmin(
      'alert',
      'Appointment notice undeliverable — no text or email',
      `${name}: the ${label} could not be delivered by text, and ${emailClause}. Call the customer.`,
      {
        link: customerId ? `/admin/customers/${customerId}` : '/admin/communications',
        metadata: { dedupeKey, customer_id: customerId, scheduled_service_id: scheduledServiceId, kind },
      },
    );
    logger.warn(`[appt-remind] No reachable channel for customer ${customerId} (${kind})`);
  } catch (err) {
    logger.warn(`[appt-remind] no-channel alert failed for ${customerId}: ${err.message}`);
  }
}

// Normalize a stored channel preference. Anything but 'email' / 'both' (incl.
// null / legacy rows) means SMS-first.
function apptChannel(value) {
  return value === 'email' || value === 'both' ? value : 'sms';
}

// Send the email version of an appointment notice. Returns the raw send result
// ({ ok, skipped, blocked, reason, ... }). Idempotent via AppointmentEmail's
// per-occurrence keys, so calling it as both a fallback and a primary send for
// the same occurrence will not double-deliver. Best-effort — never throws.
async function sendAppointmentNoticeEmail({ kind, customerId, scheduledServiceId = null, apptTime = null, serviceLabel = 'service', rescheduleUrl = null }) {
  try {
    if (!customerId) return { ok: false, reason: 'no_customer' };
    // Callers that already minted the reschedule link for their SMS leg pass
    // it through; paths that reach email directly (undelivered-SMS fallback,
    // booking's channel-aware confirmation) mint it here so the email's
    // "Reschedule appointment" CTA still renders. Best-effort — null just
    // hides the CTA block.
    let resolvedRescheduleUrl = rescheduleUrl;
    if (!resolvedRescheduleUrl && scheduledServiceId && (kind === 'confirmation' || kind === '72h' || kind === '24h')) {
      resolvedRescheduleUrl = (await buildRescheduleLink(scheduledServiceId, { customerId })).url;
    }
    if (kind === 'confirmation') {
      return await AppointmentEmail.sendAppointmentConfirmationEmail({ customerId, scheduledServiceId, appointmentTime: apptTime, serviceLabel, rescheduleUrl: resolvedRescheduleUrl });
    }
    if (kind === '72h' || kind === '24h') {
      return await AppointmentEmail.sendAppointmentReminderEmail({ customerId, scheduledServiceId, appointmentTime: apptTime, serviceLabel, kind, rescheduleUrl: resolvedRescheduleUrl });
    }
    return { ok: false, reason: 'unsupported_kind' };
  } catch (err) {
    logger.error(`[appt-remind] ${kind} email send error for ${customerId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Send the email version of an appointment notice after the SMS could not be
// delivered. Returns true if the email was sent. On no-email-on-file, raises the
// no-channel admin alert. Best-effort — never throws.
async function deliverAppointmentEmailFallback({ kind, customerId, scheduledServiceId = null, apptTime = null, serviceLabel = 'service' }) {
  if (!customerId) return false;
  const res = await sendAppointmentNoticeEmail({ kind, customerId, scheduledServiceId, apptTime, serviceLabel });
  if (res?.ok) {
    logger.info(`[appt-remind] ${kind} email fallback sent for customer ${customerId} (SMS undeliverable)`);
    return true;
  }
  if ((res?.skipped && res.reason === 'missing_email') || res?.blocked) {
    // No usable channel: the SMS failed and email is either unavailable (no
    // address on file) or suppressed (hard bounce / spam complaint / do-not-email,
    // which block even transactional sends). Alert a human to reach the customer.
    await alertNoReachableChannel({
      customerId,
      kind,
      scheduledServiceId,
      emailReason: res?.blocked ? 'suppressed' : 'missing',
    });
  } else if (res?.reason !== 'unsupported_kind') {
    logger.warn(`[appt-remind] ${kind} email fallback not sent for customer ${customerId}: ${res?.reason || res?.error || 'unknown'}`);
  }
  return false;
}

// Deliver an appointment notice honoring the customer's channel preference
// (sms | email | both). `smsAttempt` is an async closure that performs the
// real SMS send and resolves true when the customer was reached by text.
//   'sms'   → SMS first; on delivery failure fall back to email (legacy default)
//   'email' → email only; if there is no usable email, fall back to SMS so the
//             customer is still reached (no admin alert unless BOTH fail)
//   'both'  → send SMS and email
// Returns true if the customer was reached on any channel. Best-effort.
async function deliverAppointmentNotice({ channel, kind, customerId, scheduledServiceId = null, apptTime = null, serviceLabel = 'service', rescheduleUrl = null, smsAttempt }) {
  const ch = apptChannel(channel);
  const emailArgs = { kind, customerId, scheduledServiceId, apptTime, serviceLabel, rescheduleUrl };

  // Run the caller's SMS closure defensively. Some callers (e.g. the estimate
  // accept flow) throw on a blocked/undeliverable send; for email/both that must
  // not abort the email leg or bubble out of the booking/accept flow — treat a
  // throw as "not reached" so the email still goes out and the alert logic runs.
  const runSms = async () => {
    try {
      return await smsAttempt();
    } catch (err) {
      logger.warn(`[appt-remind] ${kind} SMS attempt threw for ${customerId}: ${err.message}`);
      return false;
    }
  };

  // The no-channel alert copy states the ACTUAL email failure — carry it
  // from whichever email result this path saw (suppressed vs missing).
  const emailReasonOf = (res) => (res?.blocked ? 'suppressed' : 'missing');

  if (ch === 'email') {
    const res = await sendAppointmentNoticeEmail(emailArgs);
    if (res?.ok) return true;
    // No usable email (none on file / suppressed) — reach them by text instead.
    logger.info(`[appt-remind] ${kind} email channel unavailable for ${customerId} (${res?.reason || res?.error || 'unknown'}) — falling back to SMS`);
    const smsOk = await runSms();
    if (!smsOk) await alertNoReachableChannel({ customerId, kind, scheduledServiceId, emailReason: emailReasonOf(res) });
    return smsOk;
  }

  if (ch === 'both') {
    const smsOk = await runSms();
    const emailRes = await sendAppointmentNoticeEmail(emailArgs);
    const emailOk = !!emailRes?.ok;
    // Neither channel reached the customer — raise the same human-follow-up
    // alert the SMS-only path uses.
    if (!smsOk && !emailOk) await alertNoReachableChannel({ customerId, kind, scheduledServiceId, emailReason: emailReasonOf(emailRes) });
    return smsOk || emailOk;
  }

  // 'sms' default — unchanged behavior.
  const smsOk = await runSms();
  if (!smsOk) await deliverAppointmentEmailFallback(emailArgs);
  return smsOk;
}

// Reconstruct an appointment's ET instant from its scheduled_services row —
// scheduled_date (DATE) + window_start (TIME) composed into the naive shape
// parseETDateTime expects. Returns null when the row or fields are missing.
// throwOnError (Codex #3153 r16 P1): fee-rail callers must distinguish "the
// visit genuinely has no time" (null — fee-free is correct) from "the
// lookup FAILED" (unresolved — a fee may still apply); the default
// fail-soft null is unchanged for every existing caller.
async function scheduledServiceApptTime(scheduledServiceId, { throwOnError = false } = {}) {
  try {
    const svc = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('scheduled_date', 'window_start');
    if (!svc) return null;
    const datePart = svc.scheduled_date instanceof Date
      ? svc.scheduled_date.toISOString().slice(0, 10)
      : String(svc.scheduled_date || '').slice(0, 10);
    const timePart = svc.window_start ? String(svc.window_start).slice(0, 8) : null;
    return (datePart && timePart) ? parseETDateTime(`${datePart}T${timePart}`) : null;
  } catch (err) {
    logger.warn(`[appt-remind] appt-time lookup failed for service ${scheduledServiceId}: ${err.message}`);
    if (throwOnError) throw err;
    return null;
  }
}

// Deliver a booking confirmation honoring the customer's account-level
// confirmation channel (sms | email | both). Self-service booking paths (portal
// self-book, estimate acceptance, call-created) send their own confirmation SMS
// instead of going through deliverConfirmation, so without this they would
// ignore an Email/Both preference. `smsAttempt` runs the caller's existing SMS
// send and resolves true when the customer was reached.
//
// The default 'sms' path is deliberately unchanged — it just runs smsAttempt, so
// existing customers see identical behavior. Only an explicit email/both
// preference routes through the channel-aware deliverAppointmentNotice (which
// adds the email send and the both-failed admin alert). Best-effort: a
// prefs-lookup failure falls back to the plain SMS send.
async function deliverConfirmationByChannel({ customerId, scheduledServiceId = null, apptTime = null, serviceLabel = 'service', smsAttempt }) {
  let channel = 'sms';
  let confirmationOn = true;
  try {
    const prefs = await getReminderPrefs(customerId);
    channel = prefs.confirmationChannel;
    confirmationOn = prefs.appointmentConfirmation;
  } catch (err) {
    logger.warn(`[appt-remind] confirmation channel lookup failed for ${customerId}: ${err.message} — sending SMS`);
  }
  // Default 'sms', OR the customer opted out of New Appointment Confirmation:
  // run the caller's SMS send only. That send goes through sendCustomerMessage,
  // which already enforces the appointment_confirmation opt-out (suppressing it
  // for opted-out customers) — and we must NOT email them, because the email
  // path bypasses that validator.
  if (channel === 'sms' || !confirmationOn) return smsAttempt();

  // email / both — resolve the appointment time for the email body when the
  // caller didn't pass one, so the confirmation email shows the right ET slot.
  let resolvedApptTime = apptTime;
  if (!resolvedApptTime && scheduledServiceId) {
    resolvedApptTime = await scheduledServiceApptTime(scheduledServiceId);
  }
  return deliverAppointmentNotice({
    channel,
    kind: 'confirmation',
    customerId,
    scheduledServiceId,
    apptTime: resolvedApptTime,
    serviceLabel,
    smsAttempt,
  });
}

function lastTenDigits(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

/**
 * Render an SMS body from sms_templates. If the template is missing/disabled,
 * callers skip the SMS rather than sending hardcoded customer copy.
 */
async function renderTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body) return body;
    }
  } catch { /* fall through */ }
  logger.warn(`[appt-remind] SMS template ${templateKey} is missing or inactive`);
  return null;
}

// Appointment-page copy ladder (GATE_APPOINTMENT_PAGE). The _v2 rows are
// the short link-first bodies that point at /appointment/:token — the same
// gate that makes that page reachable, so copy and destination can never
// go live apart. Semantics mirror the rain-out v3 ladder:
//   - gate off            -> render the original row, unchanged;
//   - _v2 renders         -> use it;
//   - _v2 row ABSENT      -> rolled-back migration, fall back to the
//                            original so the customer still gets a text;
//   - _v2 row DISABLED    -> that is the ops kill switch: return null so
//                            the send stops rather than silently reverting
//                            to long copy the operator just turned off.
// v2Vars is a lazy async FACTORY, not an object: building the v2 vars mints
// a never-expiring appointment short link, so it must run only when the v2
// body will actually render — gate on AND the row present and active. An
// eager build minted an unreachable short_codes row on every legacy send
// and every email-only delivery (codex r2).
async function renderAppointmentPageTemplate(baseKey, v2VarsFactory, legacyVars, context = {}) {
  if (process.env.GATE_APPOINTMENT_PAGE === 'true') {
    const v2Key = `${baseKey}_v2`;
    // Fail-soft like renderTemplate: a transient DB error here must not
    // escape — the confirmation path would mark the reminder sent without
    // delivering, and the call-booking path would skip its card-request
    // funnel. Unknowable v2 state = stop this send (same direction as the
    // kill switch: never guess between v2 and legacy copy).
    let row;
    try {
      row = await db('sms_templates').where({ template_key: v2Key }).first('id', 'is_active');
    } catch (err) {
      logger.warn(`[appt-remind] ${v2Key} state lookup failed (${err.message}) - skipping send rather than guessing`);
      return null;
    }
    if (row) {
      if (row.is_active === false) {
        logger.warn(`[appt-remind] ${v2Key} disabled - skipping send rather than reverting to legacy copy`);
        return null;
      }
      const body = await renderTemplate(v2Key, await v2VarsFactory(), context);
      if (body) return body;
      // Active row that failed to render (audited upstream) keeps the same
      // stop-don't-revert semantics as the kill switch.
      logger.warn(`[appt-remind] ${v2Key} did not render - skipping send rather than reverting to legacy copy`);
      return null;
    }
    // Row absent = rolled-back migration; fall back so the customer still
    // gets a text.
  }
  return renderTemplate(baseKey, legacyVars, context);
}

async function renderRequiredTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body) return body;
    }
  } catch (err) {
    throw new Error(`SMS template ${templateKey} could not be rendered: ${err.message}`);
  }
  throw new Error(`SMS template ${templateKey} is missing or inactive`);
}

// Date formatting helpers live in utils/datetime-et.js — re-aliased here to
// keep the existing call sites below unchanged.
const formatDay = formatETDay;
const formatDate = formatETDate;
const formatTime = formatETTime;

// The customer-facing arrival phrase ("between 8:00 AM and 10:00 AM") for the
// {window} placeholder in the 72h/24h reminders. Delegates to
// spokenArrivalWindow so this and TwilioService.sendServiceReminder cannot
// drift — getTemplate suppresses the whole SMS on an unresolved placeholder,
// so every reminder sender must supply {window} the same way.
// Pure ET clock math (never wall-clock arithmetic on the Date), so a DST
// boundary can't stretch or shrink the quoted window.
function formatArrivalWindow(apptTime) {
  const { spokenArrivalWindow, UNKNOWN_ARRIVAL_WINDOW } = require('../utils/sms-time-format');
  try {
    const { hour, minute } = etParts(apptTime);
    return spokenArrivalWindow(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  } catch {
    return UNKNOWN_ARRIVAL_WINDOW;
  }
}

// The {window} value for appointment_confirmation_v2. All THREE confirmation
// senders (this file, call-recording-processor, estimate-public) resolve it
// here so they cannot drift the way {time} did: estimate acceptance was
// passing an arrival RANGE into {time} while the other two passed an exact
// start, so the same placeholder meant two different things (codex r9).
// window_start off the booked row is the canonical source — the call
// pipeline's EXTRACTED preferred time can differ from what was actually
// booked, and the row exists at render time on every path (codex r4/r5).
// Fail-soft by construction: spokenArrivalWindow returns the UNKNOWN phrase
// rather than null, so a missing or unreadable window degrades the sentence
// instead of leaving {window} unresolved — an unresolved placeholder makes
// getTemplate suppress the ENTIRE message.
async function confirmationArrivalWindow({ scheduledServiceId = null, windowStart = null } = {}) {
  const { spokenArrivalWindow, UNKNOWN_ARRIVAL_WINDOW } = require('../utils/sms-time-format');
  try {
    let start = windowStart;
    if (!start && scheduledServiceId) {
      const row = await db('scheduled_services').where({ id: scheduledServiceId }).first('window_start');
      start = row?.window_start || null;
    }
    return spokenArrivalWindow(String(start || '').slice(0, 5));
  } catch {
    return UNKNOWN_ARRIVAL_WINDOW;
  }
}

// Admin-disambiguation parentheticals only — frequency words ("Monthly",
// "Bi-Monthly", "Semiannual"), interval phrases ("Every 6 Weeks"), and
// term phrases ("10-Year Term"). Parens with semantic customer-facing
// content like "(Termite Letter)" on WDO Inspection do NOT match and
// stay intact in customer SMS.
const ADMIN_PAREN_RE = /\s*\((?:[A-Z][a-z]+(?:-[A-Z][a-z]+)?|Every \d+ \w+|\d+-Year Term)\)/g;

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

function sanitizeLookupError(value) {
  return String(value || '')
    .replace(/https:\/\/lookups\.twilio\.com\/v2\/PhoneNumbers\/[^?\s)]+/gi, 'https://lookups.twilio.com/v2/PhoneNumbers/[phone]')
    .replace(/%2B\d{10,15}/g, '[phone]')
    .replace(/\+\d{10,15}\b/g, '[phone]')
    .replace(/\b\d{10,15}\b/g, '[phone]');
}

// Per-component cleanup: strips trailing admin-paren and em/en-dash
// suffixes from a single service name. Only safe on one component at a
// time (e.g. a single services.name value). Returns empty string on
// falsy input so callers can filter empties out of joined output.
// Do NOT apply to already-joined multi-service strings — the em-dash
// regex is anchored to end-of-string and would greedily eat any
// "& second service" tail past the first em-dash.
function smsServiceLabel(name) {
  if (!name) return '';
  return String(name)
    .replace(ADMIN_PAREN_RE, '')
    .replace(/\s+[—–]\s+.+$/, '')
    .trim();
}

// Defensive cleanup for already-stored appointment_reminders.service_type
// values, which may be joined multi-service strings ("A & B", Oxford
// "A, B, and C") from the newer multi-service flow OR legacy single-
// service strings from before. Strips admin parens globally and em/en-
// dash suffixes only at component boundaries (immediately before " & ",
// ", ", or end-of-string), so joined strings like "Rodent Sanitation
// — Heavy & Mosquito Control" become "Rodent Sanitation & Mosquito
// Control" without dropping the trailing component.
function smsServiceLabelStored(name) {
  if (!name) return 'service';
  const cleaned = String(name)
    .replace(ADMIN_PAREN_RE, '')
    .replace(/\s+[—–]\s+[^&,]+?(?=\s+&\s+|,\s+|\s*$)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || String(name);
}

// Joined service label for multi-service appointments. Returns the parent name
// alone for single-service visits, "A & B" for two, and Oxford-comma style
// "A, B, and C" for three or more. The result is persisted into
// appointment_reminders.service_type so the cron / reschedule / cancel paths
// inherit it automatically without re-querying addons.
async function buildServiceLabel(scheduledServiceId, parentName) {
  const fallback = smsServiceLabel(parentName) || 'service';
  try {
    const addons = await db('scheduled_service_addons')
      .where({ scheduled_service_id: scheduledServiceId })
      .pluck('service_name');
    const all = [parentName, ...addons].map(smsServiceLabel).filter(Boolean);
    if (all.length <= 1) return fallback;
    if (all.length === 2) return `${all[0]} & ${all[1]}`;
    return `${all.slice(0, -1).join(', ')}, and ${all[all.length - 1]}`;
  } catch {
    return fallback;
  }
}

async function buildMergedServiceLabel(conn, { customerId, apptTime, nextLabel }) {
  // Rebuild the merged label from the PRISTINE service names of every
  // reminder sharing this customer+slot — never parse a merged label back
  // apart. Real service names contain both list delimiters (e.g. "Rodent
  // Trapping, Exclusion & Sanitation Service", "Tree & Shrub Care"), so any
  // string split corrupts them. Suppressed sibling rows keep their
  // scheduled_service_id, which joins to the untouched source name;
  // ar.service_type is only the fallback for legacy rows with no link.
  // Only services the customer will actually receive at this slot belong in
  // the label: a 'rescheduled' pending-rebook placeholder or terminal row
  // parked on the slot must not be advertised in confirmations/reminders.
  // Suppressed-but-sendable siblings stay — the owner texts on their behalf.
  // EXCEPT windowless pre-closed placeholders (windows_preclosed): those
  // services only share the 08:00 slot by convention, not by clock time, so
  // an 8 AM owner's texts must never advertise them.
  // Legacy rows with no linked service keep their fallback label.
  const rows = await conn('appointment_reminders as ar')
    .leftJoin('scheduled_services as ss', 'ss.id', 'ar.scheduled_service_id')
    .where({ 'ar.customer_id': customerId, 'ar.appointment_time': apptTime, 'ar.cancelled': false, 'ar.windows_preclosed': false })
    .andWhere(function liveServiceSendableOrLegacy() {
      this.whereNull('ss.id').orWhereIn('ss.status', ['pending', 'confirmed', 'en_route', 'on_site']);
    })
    .orderBy('ar.created_at', 'asc')
    .select('ar.scheduled_service_id', conn.raw('coalesce(ss.service_type, ar.service_type) as label'));

  // Each part must be the same customer-facing label registration stored:
  // parent + add-ons + smsServiceLabel cleanup (buildServiceLabel semantics,
  // but through the caller's connection so in-transaction addon rows are
  // visible). Raw ss.service_type would silently drop add-ons.
  const candidateLabels = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    let label = String(r.label || '').trim();
    if (r.scheduled_service_id) {
      try {
        const addons = await conn('scheduled_service_addons')
          .where({ scheduled_service_id: r.scheduled_service_id })
          .pluck('service_name');
        const all = [label, ...(Array.isArray(addons) ? addons : [])].map(smsServiceLabel).filter(Boolean);
        if (all.length === 2) label = `${all[0]} & ${all[1]}`;
        else if (all.length > 2) label = `${all.slice(0, -1).join(', ')}, and ${all[all.length - 1]}`;
        else if (all.length === 1) label = all[0];
      } catch { /* keep the base label */ }
    }
    candidateLabels.push(label);
  }
  candidateLabels.push(String(nextLabel || '').trim());

  const parts = [];
  for (const raw of candidateLabels) {
    const label = String(raw || '').trim();
    if (!label) continue;
    const lower = label.toLowerCase();
    // 'service' is the smsServiceLabel fallback placeholder, not a real
    // component — merging it produces "service & Quarterly Pest Control".
    // It only survives via the final fallback when NO real label exists.
    if (lower === 'service') continue;
    // Same containment semantics the pairwise merge had: skip a candidate an
    // existing part already covers; a candidate that covers existing parts
    // replaces them.
    if (parts.some((part) => part.toLowerCase().includes(lower))) continue;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (lower.includes(parts[i].toLowerCase())) parts.splice(i, 1);
    }
    parts.push(label);
  }
  if (parts.length === 0) return String(nextLabel || '').trim() || 'service';
  if (parts.length === 1) return parts[0];
  // List-style join (owner call 07-06): "A, B & C".
  return `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
}

function reminderFlagsCoveredByNotice(appointmentTime, now = new Date()) {
  const apptTime = appointmentTime instanceof Date ? appointmentTime : new Date(appointmentTime);
  const msUntil = apptTime.getTime() - now.getTime();
  const hoursUntil = msUntil / 3600000;
  const apptDateET = etDateString(apptTime);
  const tomorrowET = etDateString(addETDays(now, 1));

  return {
    alreadyInside72hWindow: hoursUntil > 0 && hoursUntil <= 72.25,
    alreadyInside24hWindow: hoursUntil > 0 && hoursUntil <= 24.25 && apptDateET === tomorrowET,
  };
}

// The reminder cron's 72h branch only delivers while the appointment is more
// than 24.25 hours out (checkAndSendReminders: `hoursUntil > 24.25` — the
// boundary where the 24h reminder takes over, plus the 15-minute cron slack).
// Every compensating re-arm — handleReschedule's failed-notice path below,
// the dispatch route's rearmRescheduleReminderWindows, reschedule-sms's
// blocked-confirmation re-arm — must consult this before clearing
// reminder_72h_sent: an armed 72h flag on a closer appointment can never
// fire, so the cron would just re-select the row every 15 minutes until the
// appointment is cancelled or the row is otherwise closed, while the covered
// flag the caller's own sync stamped was already the correct terminal state
// (the re-armed 24h window carries the fallback notice for those). Exported
// on the service object so those callers reuse this exact boundary instead
// of hardcoding their own copy of 24.25.
function reminder72hStillReachable(appointmentTime, now = new Date()) {
  const apptTime = appointmentTime instanceof Date ? appointmentTime : new Date(appointmentTime);
  if (isNaN(apptTime.getTime())) return false;
  return (apptTime.getTime() - now.getTime()) / 3600000 > 24.25;
}

// The 24h twin: the cron's 24h branch only delivers while the appointment
// START is still in the future (checkAndSendReminders: `hoursUntil > 0`).
// That band matters because a same-day reschedule can be VALID with a past
// start — the slot is judged by its window END, which hasn't elapsed — so a
// compensating re-arm that clears reminder_24h_sent after the start passed
// leaves an armed flag the cron can never fire, and the row re-enters every
// 15-minute scan until something else closes it. Same contract as the 72h
// helper above: every compensating re-arm consults this before clearing
// reminder_24h_sent, never a local copy of the boundary.
function reminder24hStillReachable(appointmentTime, now = new Date()) {
  const apptTime = appointmentTime instanceof Date ? appointmentTime : new Date(appointmentTime);
  if (isNaN(apptTime.getTime())) return false;
  return apptTime.getTime() > now.getTime();
}

// ── Landline detection ──

async function isLandline(customerId, phone) {
  try {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return false;
    const primaryDigits = String(customer.phone || '').replace(/\D/g, '').slice(-10);
    const checkedDigits = String(phone || '').replace(/\D/g, '').slice(-10);
    const isPrimaryPhone = primaryDigits && checkedDigits && primaryDigits === checkedDigits;

    // Shared phone-keyed cache first — the SAME phone_line_types cache the send
    // pipeline's check_line_type validator uses. Covers primary AND service-
    // contact numbers, so a number is looked up at most once across both paths
    // (a 'hit' here means no second Twilio Lookup, even for service contacts that
    // the legacy customers.line_type primary cache never covered).
    const cached = await readCachedLineType(phone);
    if (cached.state === 'hit') {
      if (cached.lineType === 'landline') {
        logger.info(`[appt-remind] Skipping SMS — cached landline for ${maskPhone(phone)}`);
        return true;
      }
      return false;
    }

    // Legacy customers.line_type primary-phone cache (other readers still use it).
    // Deliberately NOT promoted into the shared phone_line_types cache: the admin
    // phone-edit path changes customers.phone WITHOUT clearing line_type, so this
    // value can describe a PREVIOUS number — seeding it could brand a newly-entered
    // mobile (and anyone sharing it) as a landline and block it globally once the
    // gate is on. Only fresh Twilio lookups (below) seed the shared cache, which
    // also re-validates a stale legacy entry on the next send.
    if (isPrimaryPhone && customer.line_type) {
      if (customer.line_type === 'landline') {
        logger.info(`[appt-remind] Skipping SMS — cached landline for customer ${customerId}`);
        return true;
      }
      return false; // cached as mobile/voip/etc
    }

    // Lookup via Twilio
    try {
      const twilio = require('twilio');
      const config = require('../config');
      if (!config.twilio.accountSid || !config.twilio.authToken) return false;

      const client = twilio(config.twilio.accountSid, config.twilio.authToken);
      const lookup = await client.lookups.v2.phoneNumbers(phone).fetch({ fields: 'line_type_intelligence' });
      const lineType = lookup.lineTypeIntelligence?.type || 'unknown';

      // Seed the shared phone-keyed cache (all phones) so neither path looks this
      // number up again, then keep the legacy primary-phone cache for its readers.
      await cacheLineType(phone, lineType);
      if (isPrimaryPhone) {
        await db('customers').where({ id: customerId }).update({ line_type: lineType });
      }

      if (lineType === 'landline') {
        logger.info(`[appt-remind] Landline detected for customer ${customerId}, skipping SMS`);
        return true;
      }
      return false;
    } catch (lookupErr) {
      logger.warn(`[appt-remind] Twilio Lookup failed for ${maskPhone(phone)}: ${sanitizeLookupError(lookupErr.message)} - sending anyway`);
      return false; // Don't block on lookup failures
    }
  } catch (err) {
    logger.warn(`[appt-remind] Landline check error: ${err.message} — sending anyway`);
    return false;
  }
}

// ── Send SMS with landline guard ──

async function safeSend(customerId, phone, body, messageType = 'appointment_reminder', purpose = 'appointment', identityTrustLevel = 'phone_matches_customer', metaExtra = {}, preDispatchCheck = null, sendOutcome = null) {
  if (!body) {
    // A null render is a transient failure (template lookup catch returns
    // null) — callers with a durable claim must keep it for the sweep
    // rather than clearing the obligation (codex #3233 r12).
    if (sendOutcome && typeof sendOutcome === 'object') sendOutcome.retryable = true;
    logger.warn(`[appt-remind] Empty SMS body for customer ${customerId}, skipping ${messageType}`);
    return false;
  }
  if (!phone) {
    logger.warn(`[appt-remind] No phone for customer ${customerId}, skipping SMS`);
    return false;
  }

  if (await isLandline(customerId, phone)) {
    return false;
  }

  const result = await sendCustomerMessage({
    to: phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose,
    customerId,
    identityTrustLevel,
    metadata: { original_message_type: messageType, ...metaExtra },
    // Canonical visit linkage for the audit row (messaging_audit_log.
    // appointment_id) — sms_log metadata does NOT survive the provider
    // handoff (twilio-sms.js forwards an allowlist), so the audit record is
    // the only queryable delivery evidence per visit (codex #3233 r2).
    ...(metaExtra.scheduled_service_id ? { appointmentId: String(metaExtra.scheduled_service_id) } : {}),
    // Optional caller-supplied final recheck at the provider handoff —
    // race-sensitive senders (the admin reschedule notice) abort here if
    // the appointment moved or went terminal while validators ran.
    ...(typeof preDispatchCheck === 'function' ? { preDispatchCheck } : {}),
  });
  // Callers that must distinguish transient provider failures (Twilio
  // 429/5xx/timeouts — sendCustomerMessage returns { sent:false,
  // retryable:true }) from deterministic non-delivery pass an out-param:
  // the boolean return alone collapses that distinction (codex #3233 r6).
  if (sendOutcome && typeof sendOutcome === 'object') {
    // Sticky-true across a multi-contact loop (codex r7): one retryable
    // failure must survive a later contact's deterministic block.
    sendOutcome.retryable = sendOutcome.retryable === true || result.retryable === true;
    sendOutcome.blockedCode = result.code || null;
  }
  if (result.blocked || result.sent === false) {
    logger.warn(`[appt-remind] SMS blocked for customer ${customerId}: ${result.code || 'unknown'} ${result.reason || ''}`);
    return false;
  }
  return true;
}

async function safeSendAppointment(customer, prefs, renderBody, messageType = 'appointment_reminder', purpose = 'appointment', metaExtra = {}, sendOptions = {}) {
  const contacts = getAppointmentContacts(customer, prefs);
  if (!contacts.length) {
    logger.warn(`[appt-remind] No appointment contact for customer ${customer?.id || 'unknown'}, skipping SMS`);
    return false;
  }

  let sentAny = false;
  // Recipient double opt-in hold (gated): third-party contacts the portal
  // flow has asked to confirm (pending/declined row) don't get texts until
  // they reply YES. No row = grandfathered. Shared with the twilio.js
  // en-route/arrived loops; fail-open on lookup errors.
  const { filterRecipientsByOptin } = require('./recipient-optin');
  let allowedContacts = await filterRecipientsByOptin(contacts, customer.id);
  // Hold emptied a NON-empty list: fall back to the primary account holder
  // (always a legitimate recipient of their own appointment changes; their
  // own consent is validated at send time) so reschedule/cancel/no-show
  // notices from DIRECT callers never silently vanish (#2956 codex r7).
  // …but NEVER over an explicit opt-out (codex #2992 P1): the resolver now
  // honors a stored `false`, so re-adding the holder here would reinstate
  // exactly the messages the toggle promises to stop. An unreadable preference
  // is treated the same way — fail closed rather than guess.
  const { prefsUnavailable: primaryPrefsUnavailable } = require('./customer-contact');
  const primaryOptedOut = primaryPrefsUnavailable(prefs) || prefs?.appointment_notify_primary === false;
  if (!allowedContacts.length && contacts.length && !primaryOptedOut) {
    const { getPrimaryContact } = require('./customer-contact');
    const primary = getPrimaryContact(customer);
    if (primary.phone) {
      logger.info(`[appt-remind] All recipients held by opt-in for customer ${customer.id} — falling back to primary for ${messageType}`);
      allowedContacts = [{ ...primary, role: 'primary' }];
    }
  }
  for (const contact of allowedContacts) {
    const body = typeof renderBody === 'function' ? await renderBody(contact) : renderBody;
    const identityTrustLevel = isServiceContactRole(contact.role)
      ? 'service_contact_authorized'
      : 'phone_matches_customer';
    const sent = await safeSend(customer.id, contact.phone, body, messageType, purpose, identityTrustLevel, metaExtra, sendOptions.preDispatchCheck || null, sendOptions.sendOutcome || null);
    sentAny = sentAny || sent;
  }
  return sentAny;
}

// ── Get customer + tech info ──

async function getCustomerAndTech(customerId, scheduledServiceId) {
  const customer = await db('customers').where({ id: customerId }).first();
  let techName = null;

  if (scheduledServiceId) {
    try {
      const svc = await db('scheduled_services')
        .where({ 'scheduled_services.id': scheduledServiceId })
        .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
        .select('technicians.name as tech_name')
        .first();
      techName = svc?.tech_name || null;
    } catch { /* technician join may fail */ }
  }

  return { customer, techName };
}

// Delivery channel is an account-level "how to reach me" preference, saved on
// the account owner's (primary profile's) row in the portal. Send paths load
// prefs by each appointment's service-property customer id, so a secondary
// property would otherwise miss the channel choice and default to SMS.
// Resolve it from the account's primary customer profile. (customers.account_id
// references customer_accounts.id, NOT a customers.id — so look up the primary
// profile rather than reading prefs by account_id directly.)
// `customerRow` is an optional pre-fetched customers row (must include
// account_id / is_primary_profile) so callers that already loaded the customer
// skip the extra query. Falls back to the passed `prefs` row on any miss.
async function resolveChannelPrefsRow(customerId, prefs = null, customerRow = null) {
  let channelPrefs = prefs;
  const customer = (customerRow && customerRow.account_id !== undefined)
    ? customerRow
    : await db('customers').where({ id: customerId }).first('account_id', 'is_primary_profile').catch(() => null);
  if (customer && customer.is_primary_profile !== true && customer.account_id) {
    const primary = await db('customers')
      .where({ account_id: customer.account_id, is_primary_profile: true })
      .first('id')
      .catch(() => null);
    if (primary && String(primary.id) !== String(customerId)) {
      const ownerPrefs = await db('notification_prefs').where({ customer_id: primary.id }).first().catch(() => null);
      if (ownerPrefs) channelPrefs = ownerPrefs;
    }
  }
  return channelPrefs;
}

async function getReminderPrefs(customerId) {
  const prefs = await db('notification_prefs').where({ customer_id: customerId }).first().catch(() => PREFS_UNAVAILABLE);
  const channelPrefs = await resolveChannelPrefsRow(customerId, prefs);

  return {
    raw: prefs || {},
    smsEnabled: prefs?.sms_enabled !== false,
    appointmentConfirmation: prefs?.appointment_confirmation !== false,
    serviceReminder72h: prefs?.service_reminder_72h !== false,
    serviceReminder24h: prefs?.service_reminder_24h !== false,
    confirmationChannel: apptChannel(channelPrefs?.appointment_confirmation_channel),
    reminder72hChannel: apptChannel(channelPrefs?.service_reminder_72h_channel),
    reminder24hChannel: apptChannel(channelPrefs?.service_reminder_24h_channel),
  };
}

// Deliver the confirmation SMS for an already-inserted reminder `record`.
// Split out of registerAppointment so the slow Twilio lookup + send can be
// driven either inline (booking_new / call-recording) or off the request path
// (admin manual save) without duplicating the prefs/landline/mark-sent logic.
// Operates on the record passed in — it does NOT re-fetch by default — so the
// inline callers keep their exact query sequence. The deferred path passes
// recheckBeforeSend so a same-second cancel/reschedule landing after the row
// was first read can still suppress the now-stale send.
async function deliverConfirmation(record, { scheduledServiceId, customerId, apptTime, serviceLabel, recheckBeforeSend = false }) {
  if (apptTime.getTime() <= Date.now()) {
    await db('appointment_reminders')
      .where({ id: record.id })
      .update({ confirmation_sent: true, confirmation_sent_at: new Date() });
    logger.warn(
      `[appt-remind] Confirmation skipped for past appointment ${scheduledServiceId} ` +
      `at ${apptTime.toISOString()}`,
    );
    return false;
  }

  try {
    const prefs = await getReminderPrefs(customerId);
    if (!prefs.appointmentConfirmation) {
      await db('appointment_reminders')
        .where({ id: record.id })
        .update({ confirmation_sent: true, confirmation_sent_at: new Date() });
      logger.info(`[appt-remind] Confirmation skipped by preference for customer ${customerId}`);
      return false;
    }
    const { customer } = await getCustomerAndTech(customerId, scheduledServiceId);
    if (customer) {
      // Deferred path only: between sendConfirmation's initial read and this
      // send, an admin can cancel or reschedule the just-created appointment.
      // The cancel handler flips cancelled=true; the reschedule handler claims
      // confirmation_sent=true. Either means this confirmation is now redundant
      // (the cancel/reschedule notice owns the customer message and, for a
      // reschedule, our formatted time would be stale), so skip the send.
      if (recheckBeforeSend) {
        const fresh = await db('appointment_reminders').where({ id: record.id }).first();
        if (!fresh || fresh.cancelled || fresh.confirmation_sent) {
          logger.info(`[appt-remind] Confirmation superseded by cancel/reschedule for ${scheduledServiceId}`);
          return false;
        }
      }

      const day = formatDay(apptTime);
      const date = formatDate(apptTime);
      const time = formatTime(apptTime);

      // Self-serve reschedule deep link — one mint shared by the SMS clause
      // and the email CTA. Best-effort: a null link renders clean copy.
      const reschedule = await buildRescheduleLink(scheduledServiceId, { customerId });
      // Honor the customer's channel preference (sms | email | both). The
      // 'sms' default is unchanged: SMS first, email fallback on failure.
      const sent = await deliverAppointmentNotice({
        channel: prefs.confirmationChannel,
        kind: 'confirmation',
        customerId,
        scheduledServiceId,
        apptTime,
        serviceLabel,
        rescheduleUrl: reschedule.url,
        smsAttempt: () => safeSendAppointment(customer, prefs.raw, async (contact) => {
          const firstName = firstNameFrom(contact.name) || customer.first_name || 'there';
          return renderAppointmentPageTemplate(
            'appointment_confirmation',
            async () => {
              // Confirm-first label ONLY when there is something to confirm:
              // a self-booked visit is inserted already confirmed
              // (routes/booking.js), and asking that customer to "view and
              // confirm" points at a page with no Confirm button.
              const svcRow = await db('scheduled_services')
                .where({ id: scheduledServiceId })
                .first('status', 'customer_confirmed');
              const alreadyConfirmed = String(svcRow?.status || '').toLowerCase() === 'confirmed'
                || !!svcRow?.customer_confirmed;
              const appointmentLink = await buildAppointmentLink(scheduledServiceId, {
                customerId,
                label: alreadyConfirmed ? 'Everything about your visit' : 'View and confirm your appointment',
              });
              // {window}, not {time} — the v2 body quotes the 2-hour arrival
              // promise, and every sender resolves it through the one helper.
              const window = await confirmationArrivalWindow({ scheduledServiceId });
              return { first_name: firstName, service_type: serviceLabel, date, time, day, window, appointment_line: appointmentLink.line };
            },
            { first_name: firstName, service_type: serviceLabel, date, time, day, reschedule_line: reschedule.line },
            { workflow: 'appointment_confirmation', entity_type: 'scheduled_service', entity_id: scheduledServiceId },
          );
        }, 'confirmation', 'appointment_confirmation', { scheduled_service_id: scheduledServiceId }),
      });

      // Mark sent whether or not delivery succeeded (landline / block) so
      // reminders can proceed and we don't retry the confirmation.
      await db('appointment_reminders')
        .where({ id: record.id })
        .update({ confirmation_sent: true, confirmation_sent_at: new Date() });
      if (sent) {
        logger.info(`[appt-remind] Confirmation sent for customer ${customerId} for ${serviceLabel}`);
      }
      return sent;
    }
    return false;
  } catch (err) {
    logger.error(`[appt-remind] Confirmation SMS failed: ${err.message}`);
    // Still mark confirmation_sent so reminders can proceed
    await db('appointment_reminders')
      .where({ id: record.id })
      .update({ confirmation_sent: true, confirmation_sent_at: new Date() });
    return false;
  }
}

// A reminder-registration failure used to be logger.error-only, so the
// customer silently got NO confirmation and NO 72h/24h reminder texts.
// Surface it on the admin notification feed, deduped per visit so replays
// (regenerate-brief, sweeps) don't stack cards. Best-effort by contract:
// an alert failure must never throw back into the registration path.
async function alertRegistrationFailure({ scheduledServiceId, customerId, source, errorMessage }) {
  try {
    const NotificationService = require('./notification-service');
    const dedupeKey = `reminder-registration-failed:${scheduledServiceId || customerId || 'unknown'}`;
    const existing = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
      .where('created_at', '>=', db.raw("now() - interval '72 hours'"))
      .first('id');
    if (existing) return;
    await NotificationService.notifyAdmin(
      'alert',
      'Appointment reminders not registered',
      `Reminder registration failed for visit ${scheduledServiceId || '(unknown)'}${source ? ` (${source})` : ''} — the customer will get no confirmation or 72h/24h reminder texts unless the visit is re-saved.${errorMessage ? ` Error: ${errorMessage}` : ''}`,
      {
        link: '/admin/dispatch',
        metadata: {
          dedupeKey,
          scheduled_service_id: scheduledServiceId || null,
          customer_id: customerId || null,
          source: source || null,
        },
      },
    );
  } catch (err) {
    logger.warn(`[appt-remind] registration-failure alert failed: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
// MAIN SERVICE
// ══════════════════════════════════════════════════════════════
const AppointmentReminders = {

  // Exposed for route-level registration wrappers (spawned-visit path in
  // admin-schedule) that catch their own errors outside registerAppointment.
  alertRegistrationFailure,

  /**
   * Durably register a reminder row for a freshly-created visit using the
   * caller's transaction (`conn`), so the reminder row commits atomically with
   * the visit and never depends on a later backfill/sweep to exist. No
   * confirmation SMS is sent (these are system-seeded visits, not customer
   * bookings) — confirmation_sent is marked true ("not applicable") so the
   * 72h/24h reminder pass in checkAndSendReminders() still picks the row up.
   * Idempotent per scheduled_service_id. Callers should run this inside a
   * SAVEPOINT (nested trx) and swallow failures so a reminder hiccup can never
   * roll back the visit/payment it rides with. Unlike registerAppointment() this
   * takes the caller's conn rather than opening its own transaction.
   */
  async registerVisitReminderInTx(conn, { scheduledServiceId, customerId, appointmentTime, serviceType, source, createdAt }) {
    if (!conn || !scheduledServiceId || !customerId) return null;
    const apptTime = parseETDateTime(appointmentTime);
    if (isNaN(apptTime.getTime())) return null;
    const now = new Date();
    const serviceLabel = smsServiceLabelStored(serviceType) || serviceType || null;
    const reminderSource = source || 'system_seed';
    // Optional booking-time override (self-heal passes the visit's real
    // created_at): the 72h pass reads created_at as the booking time, so a
    // late-registered row must not look freshly booked. Default DB now().
    const createdAtOverride = createdAt ? { created_at: createdAt } : {};

    // Serialize against concurrent registrations for the same customer+time
    // (mirrors registerAppointment) so the same-time check below can't race.
    await conn.raw('select pg_advisory_xact_lock(hashtext(?))', [
      `appointment-reminder:${customerId}:${apptTime.toISOString()}`,
    ]);

    // Idempotent per scheduled_service_id.
    const existing = await conn('appointment_reminders')
      .where({ scheduled_service_id: scheduledServiceId })
      .first('id');
    if (existing) return existing;

    // Same-customer/same-time de-dup — windowless seeds all default to 08:00, so
    // a seed can collide with another service's reminder on the same date. Merge
    // the label into the existing row and insert THIS one fully suppressed (all
    // flags sent) so checkAndSendReminders() never sends two texts for one slot.
    // Only a real OWNER counts (non-suppressed row the cron will deliver
    // for) — a 'rescheduled' pending-rebook placeholder or terminal row
    // parked on the slot must not swallow the new registration, or the
    // real appointment would get no notifications at all. Unlinked legacy
    // rows (NULL scheduled_service_id) DO own: the cron skips its
    // live-status guard for them, so they send.
    const sameAppointment = await conn('appointment_reminders')
      .where({ customer_id: customerId, appointment_time: apptTime, cancelled: false, suppressed_by_sibling: false })
      .andWhere(function ownerDeliverable() {
        this.whereNull('scheduled_service_id').orWhereExists(function ownerServiceSendable() {
          this.select(1)
            .from('scheduled_services')
            .whereRaw('scheduled_services.id = appointment_reminders.scheduled_service_id')
            .whereIn('status', ['pending', 'confirmed', 'en_route', 'on_site']);
        });
      })
      .orderBy([
        { column: 'reminder_72h_sent', order: 'asc' },
        { column: 'reminder_24h_sent', order: 'asc' },
        { column: 'created_at', order: 'asc' },
      ])
      .first();
    if (sameAppointment) {
      const merged = await buildMergedServiceLabel(conn, { customerId, apptTime, nextLabel: serviceLabel });
      if (merged !== sameAppointment.service_type) {
        await conn('appointment_reminders')
          .where({ id: sameAppointment.id })
          .update({ service_type: merged, updated_at: now });
      }
      const [suppressed] = await conn('appointment_reminders')
        .insert({
          scheduled_service_id: scheduledServiceId,
          customer_id: customerId,
          appointment_time: apptTime,
          // The suppressed row keeps its own pristine label (it never sends;
          // buildMergedServiceLabel reads per-row names, not the merged one).
          service_type: serviceLabel,
          source: reminderSource,
          confirmation_sent: true,
          confirmation_sent_at: now,
          reminder_72h_sent: true,
          reminder_72h_sent_at: now,
          reminder_24h_sent: true,
          reminder_24h_sent_at: now,
          cancelled: false,
          // Durable marker — sibling suppression must be distinguishable from
          // genuinely delivered reminders (the DB sync trigger's departure
          // promotion only re-arms marked rows).
          suppressed_by_sibling: true,
          ...createdAtOverride,
        })
        .returning('*');
      return suppressed;
    }

    // Pre-mark any reminder window that's already unreachable for this seed —
    // annual-prepay terms often start today and windowless seeds default to 08:00,
    // so the first visit can be past/too-close. Without this the cron would keep
    // re-reading the row every 15 min for a window it can never satisfy. 72h band
    // is (24.25h, 72.25h]; the 24h reminder can still fire for any future time.
    const hoursUntil = (apptTime.getTime() - now.getTime()) / 3600000;
    const seventyTwoMissed = hoursUntil <= 24.25;
    const twentyFourMissed = hoursUntil <= 0;
    const [record] = await conn('appointment_reminders')
      .insert({
        scheduled_service_id: scheduledServiceId,
        customer_id: customerId,
        appointment_time: apptTime,
        service_type: serviceLabel,
        source: reminderSource,
        confirmation_sent: true,
        confirmation_sent_at: now,
        reminder_72h_sent: seventyTwoMissed,
        reminder_72h_sent_at: seventyTwoMissed ? now : null,
        reminder_24h_sent: twentyFourMissed,
        reminder_24h_sent_at: twentyFourMissed ? now : null,
        cancelled: false,
        ...createdAtOverride,
      })
      .returning('*');
    return record;
  },

  /**
   * Register an appointment for reminders.
   * Sources: 'booking_new', 'admin_manual' => insert + send confirmation (default)
   *          any other source              => insert only (no confirmation)
   *
   * Pass `options.sendConfirmation` (boolean) to override the source-based default —
   * e.g. admin_manual with the "Send confirmation SMS" checkbox unchecked passes false.
   *
   * Pass `options.closeReminderWindows` (boolean) when the visit has NO time
   * window: the row still registers at the canonical date+08:00 slot time
   * (the convention the DB sync trigger, the self-heal sweep, and the
   * same-slot dedup all COALESCE on), but it is inserted as a NON-DELIVERING
   * PLACEHOLDER — both reminder windows pre-closed in the same insert, so the
   * cron never texts "at 8:00 AM" for a time nobody chose, plus two markers:
   *   • suppressed_by_sibling=true takes the row out of slot OWNERSHIP
   *     everywhere the one-owner-per-slot machinery looks (this method's
   *     dedup, registerVisitReminderInTx's dedup, the DB sync trigger's
   *     arrival check, promotion's no-owner-remains check). A REAL 8 AM
   *     visit registered later therefore inserts ARMED instead of landing
   *     suppressed behind a row that will never send — and conversely this
   *     path SKIPS the same-slot dedup entirely, so an existing real 8 AM
   *     owner never absorbs the date-only service (no label merge, no
   *     promotable sibling): the placeholder inserts identically whether or
   *     not an owner holds the 08:00 slot.
   *   • windows_preclosed=true is the durable marker the DB machinery keys
   *     placeholder semantics on: sibling promotion on slot departure skips
   *     it (the placeholder must never be promoted into an armed 08:00
   *     sender), and the sync trigger holds it suppressed with both windows
   *     closed across date-only moves while the service stays windowless.
   * When a real window is later set, the sync trigger's time_changed branch
   * clears the marker, re-decides slot ownership, and re-arms the windows
   * from the real start — from then on the row is an ordinary registration.
   * Until then, the row's existence keeps selfHealMissingReminderRows (which
   * registers row-less windowless visits at 08:00 ARMED) from resurrecting
   * the 8 AM promise. Confirmation keeps its normal source-based handling.
   */
  async registerAppointment(scheduledServiceId, customerId, appointmentTime, serviceType, source, options = {}) {
    try {
      const apptTime = parseETDateTime(appointmentTime);
      if (isNaN(apptTime.getTime())) {
        logger.error(`[appt-remind] Invalid appointment time: ${appointmentTime}`);
        return null;
      }

      // Resolve once and persist — cron, reschedule, and cancel all read this
      // column back, so multi-service formatting inherits without extra work.
      const serviceLabel = await buildServiceLabel(scheduledServiceId, serviceType);

      const sendConfirmation = typeof options.sendConfirmation === 'boolean'
        ? options.sendConfirmation
        : (source === 'booking_new' || source === 'admin_manual');
      const closeReminderWindows = options.closeReminderWindows === true;

      const registration = await db.transaction(async (trx) => {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [
          `appointment-reminder:${customerId}:${apptTime.toISOString()}`,
        ]);

        const existing = await trx('appointment_reminders')
          .where({ scheduled_service_id: scheduledServiceId })
          .first();

        if (existing) {
          return { record: existing, serviceLabel: existing.service_type, inserted: false, reason: 'already_registered' };
        }

        // Windowless pre-closed placeholder — see the closeReminderWindows
        // JSDoc above. One INSERT (a register-then-close pair would leave a
        // gap where a cron tick could send an 08:00-stamped reminder), and
        // deliberately WITHOUT the same-slot dedup below: the placeholder
        // never owns the slot, never merges its label into a real owner,
        // never sends, and is never promoted, so it inserts the same way
        // whether or not an owner holds 08:00. All three flags — 72h, 24h,
        // AND confirmation — close in this one INSERT: the post-transaction
        // confirmation mark would leave a crash window for the stranded-
        // confirmation sweep. (suppressed_by_sibling is set explicitly, so
        // the legacy fingerprint trigger has nothing to re-derive.)
        if (closeReminderWindows) {
          const windowsClosedAt = new Date();
          const [record] = await trx('appointment_reminders').insert({
            scheduled_service_id: scheduledServiceId,
            customer_id: customerId,
            appointment_time: apptTime,
            service_type: serviceLabel,
            source,
            // Confirmation closes IN the insert, not via the post-transaction
            // mark: a windowless visit has no time to confirm, and a crash
            // between insert and mark would leave the row for the stranded-
            // confirmation sweep, which would text an 08:00 confirmation —
            // the exact send this placeholder exists to suppress.
            confirmation_sent: true,
            confirmation_sent_at: windowsClosedAt,
            reminder_72h_sent: true,
            reminder_72h_sent_at: windowsClosedAt,
            reminder_24h_sent: true,
            reminder_24h_sent_at: windowsClosedAt,
            // Placeholder markers — suppressed_by_sibling removes the row
            // from slot ownership; windows_preclosed keeps promotion and the
            // sync trigger from ever arming it while the visit is windowless.
            suppressed_by_sibling: true,
            windows_preclosed: true,
          }).returning('*');

          return { record, serviceLabel, inserted: true };
        }

        // Owner-only dedup — see registerVisitReminderInTx: a suppressed
        // sibling or a cron-blocked ('rescheduled'/terminal) placeholder
        // parked on the slot must not swallow this registration, while an
        // unlinked legacy row (which the cron delivers for) still owns.
        const sameAppointment = await trx('appointment_reminders')
          .where({ customer_id: customerId, appointment_time: apptTime, cancelled: false, suppressed_by_sibling: false })
          .andWhere(function ownerDeliverable() {
            this.whereNull('scheduled_service_id').orWhereExists(function ownerServiceSendable() {
              this.select(1)
                .from('scheduled_services')
                .whereRaw('scheduled_services.id = appointment_reminders.scheduled_service_id')
                .whereIn('status', ['pending', 'confirmed', 'en_route', 'on_site']);
            });
          })
          .orderBy([
            { column: 'reminder_72h_sent', order: 'asc' },
            { column: 'reminder_24h_sent', order: 'asc' },
            { column: 'created_at', order: 'asc' },
          ])
          .first();

        if (sameAppointment) {
          const mergedServiceLabel = await buildMergedServiceLabel(trx, { customerId, apptTime, nextLabel: serviceLabel });
          if (mergedServiceLabel !== sameAppointment.service_type) {
            await trx('appointment_reminders')
              .where({ id: sameAppointment.id })
              .update({ service_type: mergedServiceLabel, updated_at: new Date() });
          }

          const now = new Date();
          const [suppressedRecord] = await trx('appointment_reminders').insert({
            scheduled_service_id: scheduledServiceId,
            customer_id: customerId,
            appointment_time: apptTime,
            // Pristine per-row label — see buildMergedServiceLabel.
            service_type: serviceLabel,
            source,
            confirmation_sent: true,
            confirmation_sent_at: now,
            reminder_72h_sent: true,
            reminder_72h_sent_at: now,
            reminder_24h_sent: true,
            reminder_24h_sent_at: now,
            // Durable marker — see registerVisitReminderInTx.
            suppressed_by_sibling: true,
          }).returning('*');

          return {
            record: suppressedRecord,
            serviceLabel: mergedServiceLabel,
            inserted: false,
            reason: 'same_appointment',
          };
        }

        const [record] = await trx('appointment_reminders').insert({
          scheduled_service_id: scheduledServiceId,
          customer_id: customerId,
          appointment_time: apptTime,
          service_type: serviceLabel,
          source,
          confirmation_sent: false,
        }).returning('*');

        return { record, serviceLabel, inserted: true };
      });

      const { record } = registration;
      if (!registration.inserted) {
        if (registration.reason === 'same_appointment') {
          logger.info(
            `[appt-remind] Same customer appointment already registered: ` +
            `${customerId} at ${apptTime.toISOString()} (${record.scheduled_service_id}); ` +
            `merged ${scheduledServiceId} into reminder label`,
          );
        } else {
          logger.info(`[appt-remind] Already registered: ${scheduledServiceId}`);
        }
        return record;
      }

      logger.info(`[appt-remind] Registered: ${scheduledServiceId} (source: ${source})`);

      if (!sendConfirmation) {
        // non-confirmation sources — mark confirmation as "sent" (not
        // applicable). Pre-closed placeholders already stamped it in their
        // insert (crash-window fix) — skip the redundant write.
        if (!record.windows_preclosed) {
          await db('appointment_reminders')
            .where({ id: record.id })
            .update({ confirmation_sent: true, confirmation_sent_at: new Date() });
        }
        return record;
      }

      // The caller wants a confirmation SMS. With deferConfirmation set (admin
      // manual save path) the durable reminder row is already inserted above —
      // leave confirmation_sent=false and let the caller fire the slow Twilio
      // send off the request path via sendConfirmation(). This keeps the row
      // durable before the HTTP response so a same-second cancel/reschedule can
      // still find and update it. Other callers (booking_new, call-recording)
      // send inline as before.
      if (options.deferConfirmation) {
        return record;
      }

      await deliverConfirmation(record, {
        scheduledServiceId,
        customerId,
        apptTime,
        serviceLabel: registration.serviceLabel,
      });
      return record;
    } catch (err) {
      logger.error(`[appt-remind] registerAppointment failed: ${err.message}`);
      await alertRegistrationFailure({ scheduledServiceId, customerId, source, errorMessage: err.message });
      return null;
    }
  },

  /**
   * Send the confirmation SMS for an already-registered reminder row, looked up
   * by scheduled_service_id. Split out of registerAppointment so the slow
   * Twilio lookup + send can run off the request path while the row itself is
   * inserted durably and synchronously (see registerAppointment's
   * deferConfirmation option). Idempotent — a row that already has
   * confirmation_sent set is skipped.
   */
  async sendConfirmation(scheduledServiceId) {
    try {
      const record = await db('appointment_reminders')
        .where({ scheduled_service_id: scheduledServiceId })
        .first();
      if (!record) {
        logger.warn(`[appt-remind] sendConfirmation: no reminder row for ${scheduledServiceId}`);
        return false;
      }
      if (record.confirmation_sent) return false;
      // The row is now inserted before the HTTP response, so a same-second
      // cancel/reschedule can flip cancelled=true before this deferred send
      // runs — don't text a confirmation for an appointment that's already gone.
      if (record.cancelled) {
        logger.info(`[appt-remind] sendConfirmation: skipping cancelled appointment ${scheduledServiceId}`);
        return false;
      }
      return await deliverConfirmation(record, {
        scheduledServiceId,
        customerId: record.customer_id,
        apptTime: new Date(record.appointment_time),
        serviceLabel: record.service_type,
        recheckBeforeSend: true,
      });
    } catch (err) {
      logger.error(`[appt-remind] sendConfirmation failed: ${err.message}`);
      return false;
    }
  },

  /**
   * Registration self-heal. Every cron / reschedule / cancel path in this
   * service drives off appointment_reminders — but a visit inserted outside
   * the booking paths (manual DB backfill, one-off script) never got a row
   * registered, so that customer silently gets no confirmation and no
   * 72h/24h reminders (2026-07-15: a customer's re-anchored quarterly series
   * had no rows — no reminder would ever have fired). Register any future,
   * non-terminal visit that lacks a row. registerVisitReminderInTx semantics
   * apply: no confirmation SMS goes out (confirmation_sent=true),
   * already-unreachable windows are pre-marked, and same-customer/same-time
   * visits merge into one reminder. Capped per run; the 15-min cadence
   * drains a backlog within hours. Never throws.
   */
  async selfHealMissingReminderRows() {
    let healed = 0;
    try {
      const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');
      const missing = await db('scheduled_services as ss')
        .leftJoin('appointment_reminders as ar', 'ar.scheduled_service_id', 'ss.id')
        .whereNull('ar.id')
        .whereNotNull('ss.customer_id')
        .whereNotIn('ss.status', [...SELF_HEAL_TERMINAL_STATUSES])
        // scheduled_date is a DATE column — compare against the ET calendar
        // day as a plain date string (a timestamptz bound would shift the
        // boundary by the session offset).
        .where('ss.scheduled_date', '>=', etDateString(new Date()))
        // Dispatch-owned pending bookings (call follow-ups, outbound-review
        // bookings) are left unarmed ON PURPOSE until the office confirms —
        // arming them here would text the customer first. admin-schedule
        // registers them at the office-confirm transition. NULL-safe on
        // purpose: NOT (pending AND source_action IN (...)) is NULL — not
        // true — for NULL source_action, which would silently drop ordinary
        // pending visits with no source marker from the sweep.
        .where(function () {
          this.whereNot('ss.status', 'pending')
            .orWhereNull('ss.source_action')
            .orWhereNotIn('ss.source_action', DISPATCH_OWNED_PENDING_SOURCE_ACTIONS);
        })
        .whereNotExists(function () {
          this.select(1)
            .from('customers')
            .whereRaw('customers.id = ss.customer_id')
            .whereNotNull('customers.deleted_at');
        })
        .orderBy('ss.scheduled_date', 'asc')
        .limit(SELF_HEAL_REGISTRATION_LIMIT)
        .select('ss.id', 'ss.customer_id', 'ss.scheduled_date', 'ss.window_start', 'ss.service_type', 'ss.created_at');

      for (const svc of missing) {
        try {
          // DATE columns hydrate as a JS Date at UTC midnight (TZ=UTC in
          // prod) — take the UTC calendar day, same as scheduledServiceApptTime.
          // Formatting that instant in ET would move the day back by one.
          const datePart = svc.scheduled_date instanceof Date
            ? svc.scheduled_date.toISOString().slice(0, 10)
            : String(svc.scheduled_date || '').slice(0, 10);
          const windowStart = String(svc.window_start || '').slice(0, 5) || '08:00';
          const record = await db.transaction(async (trx) => {
            // Owner from the LOCKED visit row (Codex #3109 r26): a
            // merge-undo can reverse-repoint the visit between the sweep's
            // unlocked read and this insert — the FOR UPDATE serializes
            // against that repoint, so the reminder always stamps the
            // visit's CURRENT owner (a vanished/ownerless row skips).
            const lockedVisit = await trx('scheduled_services')
              .where({ id: svc.id }).forUpdate().first('customer_id');
            if (!lockedVisit || !lockedVisit.customer_id) return null;
            return AppointmentReminders.registerVisitReminderInTx(trx, {
            scheduledServiceId: svc.id,
            customerId: lockedVisit.customer_id,
            appointmentTime: `${datePart}T${windowStart}`,
            serviceType: svc.service_type,
            source: 'cron_selfheal',
            // Preserve the visit's real booking time: the 72h pass skips
            // "booked < 72h before appointment" off created_at, and a healed
            // row stamped with the cron time would wrongly skip that reminder.
            createdAt: svc.created_at,
            });
          });
          if (record) healed += 1;
        } catch (err) {
          logger.error(`[appt-remind] Self-heal registration failed for ${svc.id}: ${err.message}`);
        }
      }
      if (healed) {
        logger.info(
          `[appt-remind] Self-healed ${healed} missing reminder row(s)` +
          (missing.length === SELF_HEAL_REGISTRATION_LIMIT ? ' (cap hit — more next run)' : '')
        );
      }
    } catch (err) {
      logger.error(`[appt-remind] Self-heal registration sweep failed: ${err.message}`);
    }
    return healed;
  },

  /**
   * Check and send 72h and 24h reminders.
   * Called by cron every 15 minutes.
   */
  async checkAndSendReminders() {
    const results = { sent72h: 0, sent24h: 0, skipped: 0, errors: 0 };
    const now = new Date();

    // Registration self-heal first, so a visit missing its reminder row joins
    // this same run's confirmation-recovery and reminder passes below.
    await AppointmentReminders.selfHealMissingReminderRows();

    // Durability backstop for deferred confirmations. Admin saves insert the
    // reminder row with confirmation_sent=false and fire the Twilio send off the
    // request path (setImmediate). If the process restarts before that send runs,
    // the row would be stranded at confirmation_sent=false — and since the main
    // reminder query below requires confirmation_sent=true, the customer would
    // also miss the 72h/24h reminders. Heal any stranded row here before the
    // reminder pass; the 2-minute age floor keeps us from racing an in-flight
    // deferred task. sendConfirmation is idempotent and marks confirmation_sent
    // even on landline/failure/past, so a recovered future row can also pick up
    // its reminder in the same run.
    try {
      const staleCutoff = new Date(now.getTime() - 2 * 60 * 1000);
      const stranded = await db('appointment_reminders')
        // windows_preclosed belt-and-braces: placeholders insert with the
        // confirmation already closed, but a pre-closed row must never be
        // healable into an 08:00 confirmation even if a flag write regresses.
        .where({ cancelled: false, confirmation_sent: false, windows_preclosed: false })
        .where('created_at', '<', staleCutoff)
        .whereNotExists(function () {
          this.select(1)
            .from('customers')
            .whereRaw('customers.id = appointment_reminders.customer_id')
            .whereNotNull('customers.deleted_at');
        })
        .select('scheduled_service_id');
      for (const r of stranded) {
        try {
          await AppointmentReminders.sendConfirmation(r.scheduled_service_id);
        } catch (e) {
          logger.error(`[appt-remind] Deferred confirmation recovery failed for ${r.scheduled_service_id}: ${e.message}`);
        }
      }
      if (stranded.length) {
        logger.info(`[appt-remind] Recovered ${stranded.length} stranded confirmation(s)`);
      }
    } catch (e) {
      logger.error(`[appt-remind] Deferred confirmation recovery sweep failed: ${e.message}`);
    }

    try {
      const reminders = await db('appointment_reminders')
        .where({ cancelled: false, confirmation_sent: true })
        // Belt-and-braces marker exclusion: a windowless pre-closed
        // placeholder is normally hidden from this scan by its closed flags
        // alone, but any writer that mistakenly clears them would put the
        // row straight into the send set — texting the 08:00 placeholder
        // time nobody chose. Excluding the durable marker outright means a
        // future flag-clearing bug can never text; a real window arrival
        // clears windows_preclosed (DB sync trigger) and re-admits the row.
        .where({ windows_preclosed: false })
        .where(function () {
          this.where({ reminder_72h_sent: false }).orWhere({ reminder_24h_sent: false });
        })
        .whereNotExists(function () {
          this.select(1)
            .from('customers')
            .whereRaw('customers.id = appointment_reminders.customer_id')
            .whereNotNull('customers.deleted_at');
        })
        .select('*');

      for (const r of reminders) {
        // Live-status guard. The reminder row carries its own cancelled flag, but
        // that flag is only as good as the cancel path that should have set it.
        // Re-read the source-of-truth service status here so a job that moved to
        // a reminder-blocking state after its row was armed can never text the
        // customer. Truly terminal states self-heal the row; 'rescheduled' is a
        // pending-rebook marker, so we skip the send but leave the row armed for
        // the rebook (see status-set comments above).
        if (r.scheduled_service_id) {
          const svc = await db('scheduled_services')
            .where({ id: r.scheduled_service_id })
            .first('status');
          const svcStatus = String(svc?.status || '').toLowerCase();
          if (REMINDER_BLOCKING_STATUSES.has(svcStatus)) {
            if (SELF_HEAL_TERMINAL_STATUSES.has(svcStatus)) {
              await db('appointment_reminders')
                .where({ id: r.id })
                .update({ cancelled: true, updated_at: new Date() });
            }
            logger.info(
              `[appt-remind] Skipping reminders for ${r.scheduled_service_id} — ` +
              `service status '${svcStatus}'` +
              (SELF_HEAL_TERMINAL_STATUSES.has(svcStatus) ? '; marked reminder cancelled' : ''),
            );
            results.skipped++;
            continue;
          }
        }

        const apptTime = new Date(r.appointment_time);
        const msUntil = apptTime.getTime() - now.getTime();
        const hoursUntil = msUntil / 3600000;
        const createdAt = new Date(r.created_at);
        const hoursFromBookingToAppt = (apptTime.getTime() - createdAt.getTime()) / 3600000;

        // ── 72-hour reminder ──
        // The cron runs every 15 minutes, but deploy restarts or short outages
        // can miss the exact 30-minute band. Treat any future appointment
        // inside the upper bound as due, while leaving the 24h reminder to own
        // the final day.
        if (!r.reminder_72h_sent && hoursUntil > 24.25 && hoursUntil <= 72.25) {
          const prefs = await getReminderPrefs(r.customer_id);
          const channel72 = prefs.reminder72hChannel;
          // Skip only if the reminder is off, or it is SMS-only and the
          // customer has opted out of texts. An email/both preference still
          // sends by email even when SMS is suppressed.
          if (!prefs.serviceReminder72h || (channel72 === 'sms' && !prefs.smsEnabled)) {
            // Close the window like the neighboring skip branches — an
            // unmarked preference skip re-enters every 15-minute scan forever.
            // Guarded on appointment_time like the post-send flag update
            // below: a concurrent move re-arms this row with the NEW time,
            // and an unguarded close by id would stomp the re-arm and
            // silently close the new appointment's reminder. 0 rows matched
            // = the row moved out from under us; skip the bookkeeping and
            // leave the re-armed row alone.
            const closed72 = await db('appointment_reminders')
              .where({ id: r.id })
              .where('appointment_time', r.appointment_time)
              .update({ reminder_72h_sent: true, reminder_72h_sent_at: new Date() });
            if (closed72 === 0) {
              logger.info(`[appt-remind] 72h preference-skip close skipped for ${r.scheduled_service_id} — appointment moved during scan; leaving re-armed row`);
            } else {
              logger.info(`[appt-remind] Skipping 72h reminder for ${r.scheduled_service_id} — disabled by customer preference`);
              results.skipped++;
            }
            continue;
          }

          // Skip if booked less than 72h before appointment
          if (hoursFromBookingToAppt < 72) {
            logger.info(`[appt-remind] Skipping 72h reminder for ${r.scheduled_service_id} — booked < 72h before`);
            results.skipped++;
            // Mark as sent so we don't re-check
            await db('appointment_reminders')
              .where({ id: r.id })
              .update({ reminder_72h_sent: true, reminder_72h_sent_at: new Date() });
            continue;
          }

          try {
            const { customer } = await getCustomerAndTech(r.customer_id, r.scheduled_service_id);
            if (!customer) { results.skipped++; continue; }

            const day = formatDay(apptTime);
            const date = formatDate(apptTime);
            const time = formatTime(apptTime);

            const serviceLabel = smsServiceLabelStored(r.service_type);
            // Self-serve reschedule deep link — one mint shared by the SMS
            // clause and the email CTA. Best-effort: null renders clean copy.
            const reschedule = await buildRescheduleLink(r.scheduled_service_id, { customerId: r.customer_id });
            // Card-hold fee policy clause (card-on-file spec Phase 1) — ''
            // for non-held bookings so the template placeholder resolves
            // clean. Lazy require: estimate-card-holds requires THIS module
            // for appointment times, so a top-level import would cycle.
            const cardHoldPolicyLine72 = await require('./estimate-card-holds')
              .cardHoldReminderLine(r.scheduled_service_id);
            await deliverAppointmentNotice({
              channel: channel72,
              kind: '72h',
              customerId: r.customer_id,
              scheduledServiceId: r.scheduled_service_id,
              apptTime,
              serviceLabel,
              rescheduleUrl: reschedule.url,
              smsAttempt: () => safeSendAppointment(customer, prefs.raw, async (contact) => {
                const firstName = firstNameFrom(contact.name) || customer?.first_name || 'there';
                return renderTemplate(
                  'reminder_72h',
                  { first_name: firstName, service_type: serviceLabel, day, date, time, window: formatArrivalWindow(apptTime), reschedule_line: reschedule.line, card_hold_policy_line: cardHoldPolicyLine72 },
                  { workflow: 'appointment_reminder_72h', entity_type: 'scheduled_service', entity_id: r.scheduled_service_id },
                );
              }, 'reminder_72h', 'appointment_reminder_72h', { scheduled_service_id: r.scheduled_service_id }),
            });

            // Guard on appointment_time: a concurrent move re-arms this row
            // (DB sync trigger / handleReschedule) with the NEW time — an
            // unguarded update by id would stomp that re-arm and silently
            // close the new slot's reminder. 0 rows matched = the row moved
            // out from under us; skip the sent bookkeeping (the re-armed row
            // owns the new state).
            const flagged72 = await db('appointment_reminders')
              .where({ id: r.id })
              .where('appointment_time', r.appointment_time)
              .update({ reminder_72h_sent: true, reminder_72h_sent_at: new Date() });

            if (flagged72 === 0) {
              logger.info(`[appt-remind] 72h flag skipped for ${r.scheduled_service_id} — appointment moved during send; leaving re-armed row`);
            } else {
              results.sent72h++;
              logger.info(`[appt-remind] 72h reminder sent for customer ${r.customer_id} - ${r.service_type}`);
            }
          } catch (err) {
            results.errors++;
            logger.error(`[appt-remind] 72h reminder failed for ${r.scheduled_service_id}: ${err.message}`);
          }
        }

        // ── 24-hour reminder ──
        if (!r.reminder_24h_sent && hoursUntil > 0 && hoursUntil <= 24.25) {
          const prefs = await getReminderPrefs(r.customer_id);
          const channel24 = prefs.reminder24hChannel;
          // Skip only if the reminder is off, or it is SMS-only and the
          // customer has opted out of texts. An email/both preference still
          // sends by email even when SMS is suppressed.
          if (!prefs.serviceReminder24h || (channel24 === 'sms' && !prefs.smsEnabled)) {
            // Close the window like the neighboring skip branches — see the
            // 72h twin above: guarded on appointment_time so a concurrent
            // move's re-arm is never stomped; 0 rows matched = the row
            // moved, skip the bookkeeping and leave the re-armed row alone.
            const closed24 = await db('appointment_reminders')
              .where({ id: r.id })
              .where('appointment_time', r.appointment_time)
              .update({ reminder_24h_sent: true, reminder_24h_sent_at: new Date() });
            if (closed24 === 0) {
              logger.info(`[appt-remind] 24h preference-skip close skipped for ${r.scheduled_service_id} — appointment moved during scan; leaving re-armed row`);
            } else {
              logger.info(`[appt-remind] Skipping 24h reminder for ${r.scheduled_service_id} — disabled by customer preference`);
              results.skipped++;
            }
            continue;
          }

          const apptDateET = etDateString(apptTime);
          const tomorrowET = etDateString(addETDays(now, 1));
          if (apptDateET !== tomorrowET) {
            logger.info(`[appt-remind] Skipping 24h reminder for ${r.scheduled_service_id} — appointment is not tomorrow in ET`);
            results.skipped++;
            await db('appointment_reminders')
              .where({ id: r.id })
              .update({ reminder_24h_sent: true, reminder_24h_sent_at: new Date() });
            continue;
          }

          try {
            const { customer } = await getCustomerAndTech(r.customer_id, r.scheduled_service_id);
            if (!customer) { results.skipped++; continue; }

            const time = formatTime(apptTime);

            const serviceLabel = smsServiceLabelStored(r.service_type);
            // Self-serve reschedule deep link — one mint shared by the SMS
            // clause and the email CTA. Best-effort: null renders clean copy.
            const reschedule = await buildRescheduleLink(r.scheduled_service_id, { customerId: r.customer_id });
            // Card-hold fee policy clause — see the 72h twin above.
            const cardHoldPolicyLine24 = await require('./estimate-card-holds')
              .cardHoldReminderLine(r.scheduled_service_id);
            await deliverAppointmentNotice({
              channel: channel24,
              kind: '24h',
              customerId: r.customer_id,
              scheduledServiceId: r.scheduled_service_id,
              apptTime,
              serviceLabel,
              rescheduleUrl: reschedule.url,
              smsAttempt: () => safeSendAppointment(customer, prefs.raw, async (contact) => {
                const firstName = firstNameFrom(contact.name) || customer?.first_name || 'there';
                return renderAppointmentPageTemplate(
                  'reminder_24h',
                  // v2: the page carries the detail — body keeps the arrival
                  // window + fee disclosure and hands off to the link.
                  // BOTH var sets carry {window} AND {time}: getTemplate
                  // suppresses the whole SMS on an unresolved placeholder,
                  // and this render must survive either body shape (v2 or
                  // legacy) plus an admin edit that reintroduces {time}.
                  async () => {
                    const appointment24 = await buildAppointmentLink(r.scheduled_service_id, { customerId: r.customer_id });
                    return { first_name: firstName, service_type: serviceLabel, time, window: formatArrivalWindow(apptTime), appointment_line: appointment24.line, card_hold_policy_line: cardHoldPolicyLine24 };
                  },
                  { first_name: firstName, service_type: serviceLabel, time, window: formatArrivalWindow(apptTime), reschedule_line: reschedule.line, card_hold_policy_line: cardHoldPolicyLine24 },
                  { workflow: 'appointment_reminder_24h', entity_type: 'scheduled_service', entity_id: r.scheduled_service_id },
                );
              }, 'appointment_reminder', 'appointment_reminder_24h', { scheduled_service_id: r.scheduled_service_id }),
            });

            // Same appointment_time guard as the 72h flag above — a
            // concurrent move re-armed this row for its new time; don't
            // stomp that re-arm after sending for the old one.
            const flagged24 = await db('appointment_reminders')
              .where({ id: r.id })
              .where('appointment_time', r.appointment_time)
              .update({ reminder_24h_sent: true, reminder_24h_sent_at: new Date() });

            if (flagged24 === 0) {
              logger.info(`[appt-remind] 24h flag skipped for ${r.scheduled_service_id} — appointment moved during send; leaving re-armed row`);
            } else {
              results.sent24h++;
              logger.info(`[appt-remind] 24h reminder sent for customer ${r.customer_id} - ${r.service_type}`);
            }
          } catch (err) {
            results.errors++;
            logger.error(`[appt-remind] 24h reminder failed for ${r.scheduled_service_id}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`[appt-remind] checkAndSendReminders failed: ${err.message}`);
      results.errors++;
    }

    if (results.sent72h > 0 || results.sent24h > 0) {
      logger.info(`[appt-remind] Reminder run: 72h=${results.sent72h}, 24h=${results.sent24h}, skipped=${results.skipped}, errors=${results.errors}`);
    }

    return results;
  },

  /**
   * Async delivery-failure fallback. Called from the Twilio status webhook when an
   * outbound SMS comes back undelivered/failed. If it was an appointment text we
   * cover (confirmation / 72h / 24h / en-route), learn the landline on carrier
   * 30006 so future texts route to email at send time, and — for confirmation /
   * 72h / 24h — send the email version now so the customer still gets the notice.
   *
   * En-route notices are intentionally NOT re-sent by email after the fact (a late
   * ETA is stale/misleading); we only learn the landline. Best-effort; never throws.
   */
  async handleUndeliveredSms({ sid, status, errorCode, to } = {}) {
    try {
      if (!sid) return;
      const audit = await db('messaging_audit_log')
        .where({ provider_message_id: sid })
        .orderBy('created_at', 'desc')
        .first();
      if (!audit || audit.channel !== 'sms') return;

      const mtype = audit.metadata?.original_message_type || '';
      const kind = PURPOSE_TO_KIND[audit.purpose] || MTYPE_TO_KIND[mtype];
      if (!kind) return; // not an appointment message this fallback covers

      const customerId = audit.customer_id;
      if (!customerId) return;

      const customer = await db('customers').where({ id: customerId }).first().catch(() => null);
      if (!customer) return;

      const scheduledServiceId = audit.metadata?.scheduled_service_id || null;
      const primaryDigits = lastTenDigits(customer.phone);
      const targetDigits = lastTenDigits(to);

      // We deliberately do NOT suppress the email when another sibling SMS "looks
      // accepted". Twilio acceptance (sent_at) is not delivery, and the status
      // webhook updates sms_log — not messaging_audit_log — so a sibling row can
      // look accepted while it too bounced; inferring cross-channel delivery from a
      // single callback is unreliable and previously dropped real notices. Instead
      // we always attempt the email on a covered appointment bounce and rely on the
      // per-occurrence email idempotency key to prevent a genuine duplicate. Worst
      // case is a benign extra email when the customer already got the text —
      // acceptable for a "we couldn't reach you by text" notice.

      // Carrier 30006 = "landline or unreachable carrier" — learn it (primary
      // phone only) so future appointment texts skip SMS and go straight to email
      // at send time.
      if (String(errorCode) === '30006' && primaryDigits && primaryDigits === targetDigits && customer.line_type !== 'landline') {
        await db('customers').where({ id: customerId }).update({ line_type: 'landline' });
        logger.info(`[appt-remind] Cached customer ${customerId} primary phone as landline (Twilio 30006)`);
      }

      if (kind === 'en_route') {
        // A late en-route ETA email is stale — don't send it. Only alert if the
        // customer has no email either, so a human can still reach them.
        if (!looksLikeEmail(customer.email)) {
          await alertNoReachableChannel({ customerId, kind, scheduledServiceId });
        }
        return;
      }

      // confirmation / 72h / 24h: reconstruct the appointment details and email it.
      let apptTime = null;
      let serviceLabel = 'service';
      const reminderRow = scheduledServiceId
        ? await db('appointment_reminders').where({ scheduled_service_id: scheduledServiceId }).first().catch(() => null)
        : await db('appointment_reminders')
          .where({ customer_id: customerId, cancelled: false })
          .where('appointment_time', '>=', db.raw("now() - interval '1 hour'"))
          .orderBy('appointment_time', 'asc')
          .first()
          .catch(() => null);
      // If the appointment was cancelled (a cancellation callback can arrive after
      // handleCancellation flips the row), don't email stale appointment details —
      // the cancellation notice owns the customer message.
      if (reminderRow?.cancelled) {
        logger.info(`[appt-remind] Skipping email fallback for cancelled appointment ${scheduledServiceId || customerId}`);
        return;
      }
      if (reminderRow) {
        apptTime = new Date(reminderRow.appointment_time);
        serviceLabel = smsServiceLabelStored(reminderRow.service_type);
      }

      await deliverAppointmentEmailFallback({ kind, customerId, scheduledServiceId, apptTime, serviceLabel });
    } catch (err) {
      logger.error(`[appt-remind] handleUndeliveredSms failed: ${err.message}`);
    }
  },

  /**
   * Handle appointment reschedule — reset reminder flags and notify customer.
   */
  async handleReschedule(scheduledServiceId, newTime, options = {}) {
    try {
      const sendNotification = options.sendNotification !== false;
      // Callers that send their own reschedule notice off this path (the
      // dispatch route renders + sends, then calls markRescheduleNoticeSent)
      // pass coverDueWindows:true so we cover any already-due window now —
      // see the covered-flags comment below.
      const coverDueWindows = options.coverDueWindows === true;
      const record = await db('appointment_reminders')
        .where({ scheduled_service_id: scheduledServiceId })
        .first();

      if (!record) {
        logger.warn(`[appt-remind] Reschedule: no record for ${scheduledServiceId}`);
        return null;
      }

      // Optional stale-move guard: a caller that committed its own schedule
      // write earlier (IB batch mover) passes the slot it committed; if a
      // NEWER reschedule has already landed a different date/start on the
      // service row, this invocation is stale. Enforced ATOMICALLY below —
      // the reminder UPDATE itself carries a WHERE EXISTS on the service
      // row still holding the expected slot, so a move that lands between
      // any read here and the write makes the update miss instead of
      // stomping the winner's reminder state.
      const expectGuard = (query) => {
        if (!(options.expectSchedule && options.expectSchedule.date)) return query;
        const expectStart = options.expectSchedule.windowStart
          ? String(options.expectSchedule.windowStart).slice(0, 5)
          : null;
        return query.whereExists(function whereServiceStillAtSlot() {
          this.select(1)
            .from('scheduled_services')
            .where('scheduled_services.id', scheduledServiceId)
            .whereRaw('scheduled_services.scheduled_date = ?::date', [String(options.expectSchedule.date)])
            .modify((q) => {
              if (expectStart) q.whereRaw("to_char(scheduled_services.window_start, 'HH24:MI') = ?", [expectStart]);
            });
        });
      };

      const newApptTime = parseETDateTime(newTime);
      if (isNaN(newApptTime.getTime())) {
        logger.error(`[appt-remind] Reschedule: invalid time ${newTime}`);
        return null;
      }

      // Reset reminder flags. If we successfully send a reschedule notice
      // below, we mark any already-due reminder windows as sent so cron does
      // not immediately repeat the same appointment details.
      //
      // When this path won't send a notice itself (sendNotification:false),
      // the caller owns the customer message — two sub-cases:
      //   • coverDueWindows:true — the caller WILL send its own reschedule
      //     notice (the dispatch route renders + sends, then calls
      //     markRescheduleNoticeSent). Cover any window already due for the
      //     new time now, so the 15-min reminder cron can't fire a day-before
      //     reminder in the gap before the caller's notice lands and
      //     double-text the customer.
      //   • otherwise — a truly silent move (e.g. an admin "don't notify"
      //     reschedule). Leave the 24h window pending so the cron still
      //     delivers the normal day-before reminder; a silent reshuffle must
      //     not strand the customer with no message at all. The 72h window
      //     stays covered when due — firing it the instant after a move would
      //     just echo details the customer hasn't been told changed.
      // Future windows stay unsent in every case, so reminders follow the
      // new appointment time.
      const covered = sendNotification
        ? { alreadyInside72hWindow: false, alreadyInside24hWindow: false }
        : coverDueWindows
          ? reminderFlagsCoveredByNotice(newApptTime)
          : { ...reminderFlagsCoveredByNotice(newApptTime), alreadyInside24hWindow: false };

      // Resolve the post-reschedule state of each reminder window:
      //   • A real start-time move re-arms from the covered/pending value
      //     above (old sent state is irrelevant — it was for a different time).
      //   • A same-start edit (duration-only resize, notifyCustomer:false)
      //     preserves an ALREADY-SENT flag so the cron can't re-send a
      //     duplicate. A still-pending flag on a same-start edit falls through
      //     to the covered value, so a notifying edit (coverDueWindows) still
      //     covers the due window and the cron can't race the route's SMS.
      const startMoved = newApptTime.getTime() !== new Date(record.appointment_time).getTime();
      const now = new Date();
      const resolveFlag = (coveredVal, prevSent, prevSentAt) => {
        if (!startMoved && prevSent) return { sent: true, at: prevSentAt };
        return { sent: coveredVal, at: coveredVal ? now : null };
      };
      const rescheduleUpdate = {
        appointment_time: newApptTime,
        // Re-arm the row: a reschedule moves the appointment to a live new time,
        // so clear any cancelled flag a prior self-heal (or stale cancel path)
        // left behind, otherwise the rebooked visit would never be reminded. The
        // cron's live-status guard re-checks the service each run, so this can
        // never resurrect a reminder for a still-terminal service.
        cancelled: false,
        updated_at: now,
      };
      // Marker carve-out — a windowless pre-closed placeholder
      // (windows_preclosed) or a sibling-suppressed row NEVER recomputes its
      // reminder windows here. Their flags are HELD closed by the DB
      // machinery (the sync trigger keeps a placeholder closed across
      // date-only moves and only re-arms it when a real window arrives; a
      // suppressed row's slot owner carries the messaging — same carve-out
      // markRescheduleNoticeSent and every no-send re-arm take). The admin
      // bulk/dispatch paths call this AFTER their service update, so an
      // unmarked recompute would clear the trigger-held flags and the 15-min
      // cron would text the 08:00 placeholder time nobody chose (or
      // double-text beside the slot owner). appointment_time / cancelled /
      // the confirmation supersede below still sync normally.
      if (!record.windows_preclosed && !record.suppressed_by_sibling) {
        const r72 = resolveFlag(covered.alreadyInside72hWindow, record.reminder_72h_sent, record.reminder_72h_sent_at);
        const r24 = resolveFlag(covered.alreadyInside24hWindow, record.reminder_24h_sent, record.reminder_24h_sent_at);
        rescheduleUpdate.reminder_72h_sent = r72.sent;
        rescheduleUpdate.reminder_72h_sent_at = r72.at;
        rescheduleUpdate.reminder_24h_sent = r24.sent;
        rescheduleUpdate.reminder_24h_sent_at = r24.at;
      }
      // A reschedule supersedes a still-pending creation confirmation — admin
      // saves defer the confirmation SMS off the request path, so a reschedule
      // landing in that window must claim the slot. This suppresses the deferred
      // sendConfirmation (which skips confirmation_sent rows) so the customer
      // gets the reschedule notice below, not a stale-time confirmation after it.
      if (!record.confirmation_sent) {
        rescheduleUpdate.confirmation_sent = true;
        rescheduleUpdate.confirmation_sent_at = new Date();
      }
      const syncedRows = await expectGuard(
        db('appointment_reminders').where({ id: record.id }),
      ).update(rescheduleUpdate);
      if (options.expectSchedule && syncedRows === 0) {
        logger.info(`[appt-remind] Reschedule sync skipped for ${scheduledServiceId} — the service no longer holds the caller's slot`);
        return { skippedStale: true };
      }

      if (!sendNotification) {
        logger.info(`[appt-remind] Reschedule notice suppressed for ${scheduledServiceId}`);
        return record;
      }

      // Send reschedule notice. Any unsent outcome — safeSendAppointment
      // returning false, a missing customer, or a throw anywhere in the
      // attempt — must re-arm the 72h window so the cron's fallback reminder
      // still delivers the new time. Without this, the DB sync trigger's
      // pre-covered flag survives (startMoved sees the already-synced
      // appointment_time) and the customer would get only the 24h text.
      let noticeSent = false;
      try {
        const { customer } = await getCustomerAndTech(record.customer_id, scheduledServiceId);
        if (customer) {
          const prefs = await db('notification_prefs').where({ customer_id: record.customer_id }).first().catch(() => PREFS_UNAVAILABLE);
          const day = formatDay(newApptTime);
          const date = formatDate(newApptTime);
          const time = formatTime(newApptTime);

          const serviceLabel = smsServiceLabelStored(record.service_type);
          noticeSent = await safeSendAppointment(customer, prefs || {}, async (contact) => {
            const firstName = firstNameFrom(contact.name) || customer?.first_name || 'there';
            return renderRequiredTemplate('appointment_rescheduled', {
              first_name: firstName,
              service_type: serviceLabel,
              day,
              date,
              time,
            }, {
              workflow: 'appointment_rescheduled',
              entity_type: 'scheduled_service',
              entity_id: scheduledServiceId,
            });
          }, 'appointment_rescheduled', 'appointment_confirmation', { scheduled_service_id: scheduledServiceId });
          if (noticeSent) {
            await this.markRescheduleNoticeSent(scheduledServiceId);
            logger.info(`[appt-remind] Reschedule notice sent for customer ${record.customer_id}`);
          }
        }
      } finally {
        if (!noticeSent && reminder72hStillReachable(newApptTime)) {
          // Re-arm ONLY while the appointment is still inside the 72h
          // delivery band (reminder72hStillReachable — the cron's 72h branch
          // never fires once hoursUntil <= 24.25, so a false flag there would
          // just keep the row in every 15-minute scan forever; the still-armed
          // 24h window carries the fallback). Guarded three ways so a failed
          // attempt only re-arms state it still owns:
          //   • appointment_time — a newer reschedule to a different time
          //     (which may have sent its own notice) makes this a no-op;
          //   • updated_at = this invocation's own write — an overlapping
          //     SAME-time attempt that succeeded afterward (its
          //     markRescheduleNoticeSent bumps updated_at) is not clobbered;
          //   • suppressed_by_sibling — a row the DB sync trigger suppressed
          //     under a slot owner stays quiet; re-arming it would
          //     double-text the customer.
          await db('appointment_reminders')
            .where({
              id: record.id,
              appointment_time: newApptTime,
              updated_at: now,
              suppressed_by_sibling: false,
            })
            .update({ reminder_72h_sent: false, reminder_72h_sent_at: null, updated_at: new Date() })
            .catch((rearmErr) => logger.error(`[appt-remind] 72h re-arm after failed notice failed: ${rearmErr.message}`));
        }
      }

      return record;
    } catch (err) {
      logger.error(`[appt-remind] handleReschedule failed: ${err.message}`);
      return null;
    }
  },

  async markRescheduleNoticeSent(scheduledServiceIds, options = {}) {
    try {
      const ids = Array.isArray(scheduledServiceIds)
        ? [...new Set(scheduledServiceIds.filter(Boolean))]
        : [scheduledServiceIds].filter(Boolean);
      if (!ids.length) return { updated: 0 };

      // Optional per-service guard ({ [serviceId]: { appointmentTime,
      // updatedAt } }): the close lands only while the row still matches the
      // caller's pre-send snapshot, making guard + close one conditional
      // UPDATE — a newer reschedule that re-armed for its own slot keeps its
      // fallback reminders and the zero-row update is the concurrency signal.
      const guardsByServiceId = options.guardsByServiceId || null;

      const records = await db('appointment_reminders')
        .whereIn('scheduled_service_id', ids)
        .select('id', 'scheduled_service_id', 'appointment_time', 'suppressed_by_sibling');

      const now = new Date();
      let updated = 0;
      for (const record of records || []) {
        // A sibling-suppressed row must stay fully suppressed — recomputing
        // its flags from the appointment time would put it back in the cron's
        // send set alongside the slot's owner (duplicate reminders).
        if (record.suppressed_by_sibling) continue;
        const guard = guardsByServiceId ? guardsByServiceId[record.scheduled_service_id] : null;
        // Judge the covered windows against the GUARDED time when one is
        // supplied — that is the slot the caller's notice actually promised.
        const flagTime = guard ? guard.appointmentTime : record.appointment_time;
        const { alreadyInside72hWindow, alreadyInside24hWindow } = reminderFlagsCoveredByNotice(flagTime, now);
        let query = db('appointment_reminders').where({ id: record.id });
        if (guard) {
          query = query
            .where('appointment_time', guard.appointmentTime)
            .where('updated_at', guard.updatedAt);
        }
        const changed = await query.update({
          reminder_72h_sent: alreadyInside72hWindow,
          reminder_72h_sent_at: alreadyInside72hWindow ? new Date() : null,
          reminder_24h_sent: alreadyInside24hWindow,
          reminder_24h_sent_at: alreadyInside24hWindow ? new Date() : null,
          updated_at: new Date(),
        });
        if (guard && changed === 0) {
          logger.info(`[appt-remind] reschedule-notice close skipped for ${record.scheduled_service_id} — reminder row moved on under the guard`);
          continue;
        }
        updated += changed;
      }

      return { updated };
    } catch (err) {
      logger.error(`[appt-remind] markRescheduleNoticeSent failed: ${err.message}`);
      return null;
    }
  },

  /**
   * Handle appointment cancellation — mark cancelled and notify customer.
   */
  async handleCancellation(scheduledServiceId, options = {}) {
    // Optional out-param: callers that surface send results to the operator
    // pass options.outcome = {} and read notificationSent/notificationError
    // off it afterwards. The return contract (record | null) is unchanged —
    // existing callers ignore the return value.
    const outcome = (options.outcome && typeof options.outcome === 'object') ? options.outcome : null;
    const reportOutcome = (sent, error) => {
      if (!outcome) return;
      outcome.notificationSent = sent;
      outcome.notificationError = error;
    };
    try {
      const sendNotification = options.sendNotification !== false;
      const record = await db('appointment_reminders')
        .where({ scheduled_service_id: scheduledServiceId })
        .first();

      if (!record) {
        logger.info(`[appt-remind] Cancellation: no reminder record for ${scheduledServiceId}`);
        reportOutcome(false, 'No reminder record for this visit — no cancellation text was sent');
        return null;
      }

      await db('appointment_reminders')
        .where({ id: record.id })
        .update({ cancelled: true, updated_at: new Date() });

      // A restored visit is LIVE — a stale cancellation worker must not
      // re-close its reminder row or touch claims (codex r13).
      const svcNow = await db('scheduled_services')
        .where({ id: scheduledServiceId })
        .first('status');
      if (svcNow && String(svcNow.status) !== 'cancelled') {
        logger.info(`[appt-remind] Cancellation skipped for ${scheduledServiceId} — visit is ${svcNow.status}`);
        reportOutcome(false, `visit is ${svcNow.status} — no cancellation processed`);
        return record;
      }

      // Send-once via the dedicated atomic claim. `cancelled` is NOT
      // usable as evidence — the status-sync trigger (20260720000000) sets
      // it during the cancel transition itself, before any caller runs
      // (codex #3233 r1). Whoever takes the claim owns the notice; a
      // sendNotification:false caller claims too, because suppression is a
      // decision that must block a later auto-send regardless of ordering.
      // A stale 'pending' claim (>15 min, i.e. a crash between claim and
      // provider acceptance) is reclaimable so the crash window cannot
      // recreate the silent-cancellation failure (r3); 'suppressed' and
      // 'sent' are terminal and never reclaimed.
      // Captured BEFORE any claim/adoption rewrites it: the pre-existing
      // token identifies this row's GROUP, so a sibling adoption can still
      // recognize a series acceptance linked to the representative (r12).
      const priorClaimToken = record.cancellation_notice_at || null;

      // options.claimToken = the caller already holds the durable claim
      // (job-status trx claim or the stale-claim sweep) — verify ownership
      // by the claim timestamp (fence token, codex r4) instead of
      // re-claiming. Otherwise take the claim atomically here.
      const claimToken = options.claimToken || null;
      let noticeToken;
      let claimed;
      if (claimToken) {
        noticeToken = claimToken;
        claimed = await db('appointment_reminders')
          .where({ id: record.id }).whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
          .where('cancellation_notice_at', claimToken)
          .update({ updated_at: new Date() });
      } else if (!sendNotification) {
        // Suppression claims terminally IN ONE atomic update (codex r5):
        // a pending-then-suppress two-step could crash between statements
        // and leave a pending lease the sweep would later SEND against the
        // caller's explicit don't-text intent.
        noticeToken = new Date();
        claimed = await db('appointment_reminders')
          .where({ id: record.id })
          .where(function claimable() {
            this.whereNull('cancellation_notice_at')
              .orWhereIn('cancellation_notice_state', ['pending', 'pending_notify']);
          })
          .update({ cancellation_notice_at: noticeToken, cancellation_notice_state: 'suppressed', updated_at: noticeToken });
      } else {
        noticeToken = new Date();
        // Tokenless claims (routes) take NULL rows AND adopt any 'pending'
        // row — the shared writer now persists a pending claim in the
        // cancel transaction for caller-owned paths too (codex r7), and
        // the route's awaited call is its settler. Fences (ownership
        // recheck at the handoff + token-conditional finalize + the
        // accepted-audit pre-send check) keep a stolen lease from
        // double-texting.
        claimed = await db('appointment_reminders')
          .where({ id: record.id })
          .where(function claimable() {
            this.whereNull('cancellation_notice_at')
              .orWhereIn('cancellation_notice_state', ['pending', 'pending_notify']);
          })
          .update({ cancellation_notice_at: noticeToken, cancellation_notice_state: 'pending', updated_at: noticeToken });
      }

      if (!sendNotification) {
        if (claimToken && claimed) {
          // Fenced: only the claim owner may finalize as suppressed.
          await db('appointment_reminders')
            .where({ id: record.id }).whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
            .where('cancellation_notice_at', noticeToken)
            .update({ cancellation_notice_state: 'suppressed', updated_at: new Date() });
        }
        logger.info(`[appt-remind] Cancellation notice suppressed for ${scheduledServiceId}`);
        return record;
      }

      // Scoped to the CURRENT cancellation cycle (codex r9): a visit
      // restored to live and cancelled again must not reconcile against
      // the first cancellation's SMS — only audits at/after the latest
      // cancelled transition count.
      const acceptedCancellationAudit = async () => Boolean(await db('messaging_audit_log')
        .where({ appointment_id: String(scheduledServiceId), purpose: 'appointment_cancellation' })
        .whereNotNull('sent_at')
        .whereRaw("provider_message_id ~ '^(SM|MM)'")
        .whereRaw(
          "sent_at >= (SELECT COALESCE(MAX(h.transitioned_at), '-infinity') FROM job_status_history h WHERE h.job_id = ? AND h.to_status = 'cancelled' AND h.from_status <> 'cancelled')",
          [scheduledServiceId],
        )
        .first('id'));

      if (!claimed) {
        logger.info(`[appt-remind] Cancellation notice already handled for ${scheduledServiceId} — not re-sending`);
        reportOutcome(false, 'A cancellation notice was already handled for this visit');
        return record;
      }

      // Accepted-before-dispatch guard (codex r7): a prior worker can
      // persist provider acceptance and die before finalizing — a
      // reclaimed/adopted lease must recognize that and finalize instead
      // of re-texting the customer.
      const groupAccepted = async () => {
        if (!priorClaimToken) return false;
        return Boolean(await db('messaging_audit_log as ml')
          .join('appointment_reminders as rep', db.raw('rep.scheduled_service_id::text = ml.appointment_id'))
          .where('rep.customer_id', record.customer_id)
          .where('rep.cancellation_notice_at', priorClaimToken)
          .where('ml.purpose', 'appointment_cancellation')
          .whereNotNull('ml.sent_at')
          .whereRaw("ml.provider_message_id ~ '^(SM|MM)'")
          // Current cycle only (codex r13): bound by the representative's
          // latest real cancelled transition.
          .whereRaw(
            "ml.sent_at >= (SELECT COALESCE(MAX(h.transitioned_at), '-infinity') FROM job_status_history h WHERE h.job_id = rep.scheduled_service_id AND h.to_status = 'cancelled' AND h.from_status <> 'cancelled')",
          )
          .first('ml.id'));
      };
      if (await acceptedCancellationAudit() || await groupAccepted()) {
        await db('appointment_reminders')
          .where({ id: record.id }).whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
          .where('cancellation_notice_at', noticeToken)
          .update({ cancellation_notice_state: 'sent', updated_at: new Date() });
        // The customer DID get the text (prior attempt, provider-accepted)
        // — report success so bulk/single operators don't see a phantom
        // notification failure (codex r9).
        reportOutcome(true, null);
        logger.info(`[appt-remind] Cancellation notice already accepted for ${scheduledServiceId} — reconciled as sent`);
        return record;
      }

      // Claim finalization (codex r2 P2 + r3 P2): the claim survives only a
      // successful send or deliberate suppression. On a failed attempt the
      // claim is released for retry — UNLESS a recipient was already
      // accepted by the provider (multi-contact partial failure: the audit
      // row for THIS visit's cancellation carries a genuine Twilio SID), in
      // which case releasing would let a retry double-text the accepted
      // recipient; the claim finalizes as 'sent' instead.
      const finalizeClaim = async (sentOk, { retryable = false } = {}) => {
        try {
          let accepted = Boolean(sentOk);
          if (!accepted) {
            accepted = await acceptedCancellationAudit();
          }
          // Fenced by the claim token (codex r4): if the lease was
          // reclaimed while we worked (stale-claim sweep), our finalize
          // matches 0 rows and the current owner's state stands — the
          // evidence check above keeps the reclaimer from double-texting.
          //
          // Failure disposition (codex r5): a RETRYABLE failure (thrown
          // render/provider/transport error) keeps the 'pending' lease so
          // the 15-minute sweep re-attempts — hook-owned entry points do
          // not reliably re-trigger, so releasing would restore the
          // silent-cancellation loss. A deterministic non-delivery
          // (blocked / opted out / no eligible recipient) releases the
          // claim: re-attempting cannot change the outcome, and a route
          // retry stays possible.
          if (!accepted && retryable) {
            // Keep the pending lease ONLY while the sweep runs to settle
            // it — with the gate off there is no sweep, so parking would
            // strand the claim and block an immediate route retry for the
            // lease duration (codex r7). Gate off → release for retry.
            const { isEnabled } = require('../config/feature-gates');
            if (isEnabled('cancelNoticeHook')) return false;
          }
          await db('appointment_reminders')
            .where({ id: record.id }).whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
            .where('cancellation_notice_at', noticeToken)
            .update(accepted
              ? { cancellation_notice_state: 'sent', updated_at: new Date() }
              : { cancellation_notice_at: null, cancellation_notice_state: null, updated_at: new Date() });
          return accepted;
        } catch (finalizeErr) {
          logger.warn(`[appt-remind] notice-claim finalize failed for ${scheduledServiceId}: ${finalizeErr.message}`);
          return Boolean(sentOk);
        }
      };

      // Send cancellation notice
      try {
        const { customer } = await getCustomerAndTech(record.customer_id, scheduledServiceId);
        if (customer) {
          const prefs = await db('notification_prefs').where({ customer_id: record.customer_id }).first().catch(() => PREFS_UNAVAILABLE);
          const apptTime = new Date(record.appointment_time);
          const day = formatDay(apptTime);
          const date = formatDate(apptTime);

          const serviceLabel = smsServiceLabelStored(record.service_type);
          const sendOutcome = {};
          const noticeSent = await safeSendAppointment(customer, prefs || {}, async (contact) => {
            const firstName = firstNameFrom(contact.name) || customer?.first_name || 'there';
            return renderRequiredTemplate('appointment_cancelled', {
              first_name: firstName,
              service_type: serviceLabel,
              day,
              date,
            }, {
              workflow: 'appointment_cancelled',
              entity_type: 'scheduled_service',
              entity_id: scheduledServiceId,
            });
          }, 'appointment_cancelled', 'appointment_cancellation', { scheduled_service_id: scheduledServiceId }, {
            sendOutcome,
            // Lease-ownership recheck AT the provider handoff (codex r6):
            // customer lookup, prefs, rendering, and the line lookup all
            // run between the claim check and dispatch — a worker paused
            // past the 15-minute lease must not send after a sweep
            // reclaim.
            preDispatchCheck: async () => {
              const own = await db('appointment_reminders')
                .where({ id: record.id }).whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
                .where('cancellation_notice_at', noticeToken)
                .first('id');
              if (!own) return { ok: false, code: 'notice_claim_lost', reason: 'cancellation-notice lease was reclaimed' };
              // A restore during the post-commit gap means this notice is
              // stale — the visit is live again (codex r10).
              const svc = await db('scheduled_services')
                .where({ id: scheduledServiceId })
                .first('status');
              return String(svc?.status) === 'cancelled'
                ? { ok: true }
                : { ok: false, code: 'appointment_restored', reason: `appointment is now ${svc?.status || 'missing'}` };
            },
          });
          if (noticeSent) {
            logger.info(`[appt-remind] Cancellation notice sent for customer ${record.customer_id}`);
            await finalizeClaim(true);
          } else {
            // Transient provider failure keeps the pending lease for the
            // sweep; deterministic non-delivery releases (codex r6 — the
            // provider layer catches 429/5xx/timeouts, so they arrive
            // here as sent:false + retryable, never as a throw).
            await finalizeClaim(false, { retryable: sendOutcome.retryable === true });
          }
          reportOutcome(noticeSent, noticeSent
            ? null
            : 'customer was not notified (no eligible recipient, opted out, or the text was blocked)');
        } else {
          await finalizeClaim(false);
          reportOutcome(false, 'Customer not found');
        }
      } catch (sendErr) {
        await finalizeClaim(false, { retryable: true });
        throw sendErr;
      }

      return record;
    } catch (err) {
      logger.error(`[appt-remind] handleCancellation failed: ${err.message}`);
      reportOutcome(false, err.message);
      return null;
    }
  },

  /**
   * Handle a no-show — notify the customer that we missed them and invite
   * them to get back on the schedule. Fired from the dispatch "Mark as
   * no-show" action. Unlike handleCancellation this reads the appointment
   * timing straight off scheduled_services (a no-show may not have an
   * appointment_reminders row) so the notice still sends. Best-effort:
   * landline/opt-out guards and template-missing all degrade to no send,
   * never throw.
   */
  async handleNoShow(scheduledServiceId, options = {}) {
    try {
      // Supersede any reminder row for this visit so a deferred
      // confirmation still queued for the same-day appointment can't fire
      // after it's been no-showed — the deferred-confirmation path
      // suppresses on cancelled/confirmation_sent. Runs regardless of the
      // notify preference: the visit is terminal either way. Best-effort.
      try {
        await db('appointment_reminders')
          .where({ scheduled_service_id: scheduledServiceId })
          .update({ cancelled: true, updated_at: new Date() });
      } catch (e) {
        logger.warn(`[appt-remind] no-show reminder supersede failed: ${e.message}`);
      }

      const sendNotification = options.sendNotification !== false;
      if (!sendNotification) {
        logger.info(`[appt-remind] No-show notice suppressed for ${scheduledServiceId}`);
        return null;
      }

      const svc = await db('scheduled_services')
        .where({ 'scheduled_services.id': scheduledServiceId })
        .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
        .select(
          'scheduled_services.customer_id',
          'scheduled_services.scheduled_date',
          'scheduled_services.window_start',
          'scheduled_services.service_type',
          'technicians.name as tech_name',
        )
        .first();
      if (!svc) {
        logger.info(`[appt-remind] No-show: scheduled service ${scheduledServiceId} not found`);
        return null;
      }

      const { customer } = await getCustomerAndTech(svc.customer_id, scheduledServiceId);
      if (!customer) return null;

      const prefs = await db('notification_prefs').where({ customer_id: svc.customer_id }).first().catch(() => PREFS_UNAVAILABLE);

      // scheduled_date is a DATE, window_start a TIME — compose into the
      // naive 'YYYY-MM-DDTHH:MM:SS' shape parseETDateTime expects so the
      // displayed time lands in ET.
      const datePart = svc.scheduled_date instanceof Date
        ? svc.scheduled_date.toISOString().slice(0, 10)
        : String(svc.scheduled_date || '').slice(0, 10);
      const timePart = svc.window_start ? String(svc.window_start).slice(0, 8) : null;
      const apptDate = (datePart && timePart) ? parseETDateTime(`${datePart}T${timePart}`) : null;
      const time = apptDate ? formatTime(apptDate) : 'your scheduled time';
      const techFirst = (svc.tech_name ? String(svc.tech_name).trim().split(/\s+/)[0] : '') || 'the team';

      // The status route only blocks FUTURE no-shows, so a back-dated visit
      // can still be marked — "today" would then be wrong. Render "today"
      // only for a same-day miss; otherwise name the actual day/date.
      let when = 'today';
      if (datePart && datePart !== etDateString()) {
        const dayDate = apptDate || parseETDateTime(`${datePart}T00:00`);
        when = `on ${formatDay(dayDate)}, ${formatDate(dayDate)}`;
      }

      await safeSendAppointment(customer, prefs || {}, async (contact) => {
        const customerFirst = firstNameFrom(contact.name) || customer?.first_name || 'there';
        return renderTemplate('appointment_no_show', {
          first_name: customerFirst,
          tech_name: techFirst,
          when,
          time,
        }, {
          workflow: 'appointment_no_show',
          entity_type: 'scheduled_service',
          entity_id: scheduledServiceId,
        });
        // messageType keeps the no-show label for analytics; the messaging
        // policy `purpose` reuses the registered transactional
        // 'appointment_cancellation' profile (a no-show notice is the same
        // class of "your appointment isn't happening — let's rebook" comms,
        // and 'appointment_no_show' is not a registered MessagePurpose).
      }, 'appointment_no_show', 'appointment_cancellation');
      logger.info(`[appt-remind] No-show notice sent for customer ${svc.customer_id}`);

      // Email twin (appointment.no_show template) — second channel like the
      // other appointment notices. Best-effort: an email failure never
      // fails the SMS leg or the status flip. `when` is the same composed
      // same-day/back-dated phrase the SMS used; the fee outcome comes
      // from the dispatch route (options.feeCharged) so the charge line
      // is always truthful.
      try {
        const AppointmentEmail = require('./appointment-email');
        await AppointmentEmail.sendAppointmentNoShowEmail({
          customerId: svc.customer_id,
          scheduledServiceId,
          serviceLabel: svc.service_type,
          missedWhen: when,
          noShowReason: options.noShowReason || '',
          feeOutcome: options.feeOutcome
            || (options.feeCharged === true ? 'charged' : 'none'),
        });
      } catch (e) {
        logger.error(`[appt-remind] no-show email failed for ${scheduledServiceId}: ${e.message}`);
      }

      return { customer_id: svc.customer_id };
    } catch (err) {
      logger.error(`[appt-remind] handleNoShow failed: ${err.message}`);
      return null;
    }
  },

  /**
   * Handle recurring appointment cancellation — mark all reminder records
   * cancelled, then send one series-level notice through the same guarded
   * contact path as single-appointment cancellation.
   */
  // Durable-retry sweep for the shared-writer cancellation-notice hook
  // (codex #3233 r4). The job-status trx commits a 'pending' claim with
  // the cancel transition; the immediate post-commit worker only sends
  // when delivery evidence already exists. This sweep — run from the
  // 15-minute reminder cron — reclaims stale pending leases and settles
  // them: evidence by now (late audit persist, crashed worker) → send;
  // still none → terminal silent suppression. Fenced by the reclaim token.
  async sweepStaleCancellationClaims() {
    try {
      // Age-out runs regardless of the gate (r12): a notice older than
      // 72h is moot — texting "your visit was cancelled" days later is
      // worse than silence, and claims born before a gate-off period must
      // not replay on re-enable. Released to NULL so a future re-cancel
      // evaluates fresh.
      await db('appointment_reminders')
        .whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
        .where('cancellation_notice_at', '<', db.raw("now() - interval '72 hours'"))
        // Terminal (codex r13): releasing to NULL let a cancelled→cancelled
        // retry reclaim and text a days-old cancellation. A genuine future
        // cycle passes through a live restore, which clears markers.
        .update({ cancellation_notice_state: 'suppressed', updated_at: new Date() });
      const { isEnabled } = require('../config/feature-gates');
      if (!isEnabled('cancelNoticeHook')) return { swept: 0 };
      const stale = await db('appointment_reminders as ar')
        .join('scheduled_services as ss', 'ss.id', 'ar.scheduled_service_id')
        .whereIn('ar.cancellation_notice_state', ['pending', 'pending_notify'])
        .where('ar.cancellation_notice_at', '<', db.raw("now() - interval '15 minutes'"))
        .where('ss.status', 'cancelled')
        .orderBy('ar.cancellation_notice_at', 'asc')
        .limit(20)
        .select('ar.id as reminder_id', 'ar.scheduled_service_id', 'ar.customer_id',
          'ar.cancellation_notice_state as claim_state',
          'ar.cancellation_notice_at as claim_at');
      // Group by (customer, original claim timestamp): a series
      // cancellation claims every target with ONE shared token, so rows
      // sharing both are one obligation. Recovering them independently
      // would send N per-visit texts where the customer was owed one
      // combined notice (codex #3233 r6) — instead the group settles as a
      // unit: one representative message (or silent close), siblings
      // finalized as suppressed. Single visits form groups of one and
      // behave exactly as before.
      const seeds = new Map();
      for (const row of stale) {
        const key = `${row.customer_id || 'none'}|${new Date(row.claim_at).toISOString()}`;
        if (!seeds.has(key)) seeds.set(key, row);
      }
      let settled = 0;
      for (const seed of seeds.values()) {
        // Re-fetch the COMPLETE group for this (customer, claim token):
        // the row-level LIMIT above can split a >20-visit series across
        // ticks, and a partial group loses the representative linkage the
        // accepted-send check needs (codex r7). Groups are settled whole.
        const group = await db('appointment_reminders as ar')
          .join('scheduled_services as ss', 'ss.id', 'ar.scheduled_service_id')
          .whereIn('ar.cancellation_notice_state', ['pending', 'pending_notify'])
          .where('ar.cancellation_notice_at', seed.claim_at)
          .where('ss.status', 'cancelled')
          .modify((q) => {
            if (seed.customer_id) q.where('ar.customer_id', seed.customer_id);
            else q.whereNull('ar.customer_id');
          })
          .select('ar.id as reminder_id', 'ar.scheduled_service_id', 'ar.cancellation_notice_state as claim_state');
        if (!group.length) continue;
        // A caller-owned notify claim (route crashed before its awaited
        // handler) sends on recovery regardless of prior reminder
        // evidence — the operator explicitly asked for the text (r11).
        const callerNotify = group.some((g) => g.claim_state === 'pending_notify');
        const token = new Date();
        const reminderIds = group.map((g) => g.reminder_id);
        const serviceIds = group.map((g) => String(g.scheduled_service_id));
        const reclaimed = await db('appointment_reminders')
          .whereIn('id', reminderIds)
          .whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
          .where('cancellation_notice_at', '<', db.raw("now() - interval '15 minutes'"))
          .update({ cancellation_notice_at: token, updated_at: token });
        if (!reclaimed) continue;
        // A stale lease can already carry an ACCEPTED cancellation send
        // (provider acceptance is audited before the claim finalizes — a
        // crash or failed marker update in that window leaves pending +
        // accepted; series sends stamp their representative visit).
        // Finalize WITHOUT redispatching (codex r5).
        const alreadyAccepted = Boolean(await db('messaging_audit_log')
          .whereIn('appointment_id', serviceIds)
          .where({ purpose: 'appointment_cancellation' })
          .whereNotNull('sent_at')
          .whereRaw("provider_message_id ~ '^(SM|MM)'")
          // Current cancellation cycle only (codex r9) — see
          // acceptedCancellationAudit.
          .whereRaw(
            "sent_at >= (SELECT COALESCE(MAX(h.transitioned_at), '-infinity') FROM job_status_history h WHERE h.job_id = messaging_audit_log.appointment_id::uuid AND h.to_status = 'cancelled' AND h.from_status <> 'cancelled')",
          )
          .first('id'));
        if (alreadyAccepted) {
          await db('appointment_reminders')
            .whereIn('id', reminderIds)
            .whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
            .where('cancellation_notice_at', token)
            .update({ cancellation_notice_state: 'sent', updated_at: new Date() });
          settled += group.length;
          continue;
        }
        const delivered = Boolean(await db('messaging_audit_log')
          .whereIn('appointment_id', serviceIds)
          .whereIn('purpose', ['appointment_reminder_72h', 'appointment_reminder_24h', 'appointment_confirmation'])
          .whereNotNull('sent_at')
          .whereRaw("provider_message_id ~ '^(SM|MM)'")
          .first('id'));
        if (group.length > 1) {
          // Multi-visit group = a series obligation: recovery must send the
          // COMBINED series template, not a single-visit "your visit on X
          // was cancelled" text (codex r8). handleSeriesCancellation adopts
          // the pending claims, sends the series copy, and finalizes
          // retryable-aware.
          await this.handleSeriesCancellation(
            group.map((g) => g.scheduled_service_id),
            group[0].scheduled_service_id,
            // No scope passed (codex r13): recovery cannot know series-vs-
            // following; the default wording covers both truthfully.
            { sendNotification: delivered || callerNotify, claimToken: token },
          );
          settled += group.length;
          continue;
        }
        const [representative, ...siblings] = group;
        if (siblings.length) {
          // Fenced: consolidate the group onto the representative — the
          // one message (or silent close) below covers all of them.
          await db('appointment_reminders')
            .whereIn('id', siblings.map((g) => g.reminder_id))
            .whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
            .where('cancellation_notice_at', token)
            .update({ cancellation_notice_state: 'suppressed', updated_at: new Date() });
        }
        await this.handleCancellation(representative.scheduled_service_id, {
          sendNotification: delivered || callerNotify,
          claimToken: token,
        });
        settled += group.length;
      }
      if (settled) logger.info(`[appt-remind] cancellation-claim sweep settled ${settled} stale lease(s)`);
      return { swept: settled };
    } catch (err) {
      logger.warn(`[appt-remind] cancellation-claim sweep failed: ${err.message}`);
      return { swept: 0, error: true };
    }
  },

  async handleSeriesCancellation(scheduledServiceIds, representativeScheduledServiceId, options = {}) {
    // Same optional out-param contract as handleCancellation — callers that
    // surface send results pass options.outcome = {} and read
    // notificationSent/notificationError afterwards.
    const outcome = (options.outcome && typeof options.outcome === 'object') ? options.outcome : null;
    const reportOutcome = (sent, error) => {
      if (!outcome) return;
      outcome.notificationSent = sent;
      outcome.notificationError = error;
    };
    try {
      const ids = [...new Set((scheduledServiceIds || []).filter(Boolean))];
      if (!ids.length) {
        reportOutcome(false, 'No appointments to notify about');
        return null;
      }

      await db('appointment_reminders')
        .whereIn('scheduled_service_id', ids)
        .update({ cancelled: true, updated_at: new Date() });

      const sendNotification = options.sendNotification !== false;

      // Claim every target's cancellation-notice marker (codex #3233 r4):
      // the combined series message IS these visits' notice (or its
      // deliberate suppression) — without the claim, a later same-status
      // retry through a single-cancel route could take a target's null
      // marker and send an unwanted per-visit text. Suppression claims
      // terminally in one update; a notifying series claims 'pending' and
      // finalizes only after the combined send is attempted (r5 — marking
      // 'sent' upfront made a failed send unretryable). Unclaimed rows
      // only: never clobber an existing terminal state.
            const seriesToken = new Date();
      const priorGroupToken = options.claimToken instanceof Date ? options.claimToken : null;
      await db('appointment_reminders')
        .whereIn('scheduled_service_id', ids)
        .where(function claimable() {
          // Adopt unclaimed rows, rows under OUR provided group token
          // (route trx claim / sweep reclaim), and stale leases — never a
          // fresh foreign single-visit lease mid-send (codex r13): those
          // must stay visible to the handoff fence.
          this.whereNull('cancellation_notice_at');
          if (priorGroupToken) this.orWhere('cancellation_notice_at', priorGroupToken);
          this.orWhere(function staleLease() {
            this.whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
              .where('cancellation_notice_at', '<', db.raw("now() - interval '15 minutes'"));
          });
        })
        .update({
          cancellation_notice_at: seriesToken,
          cancellation_notice_state: sendNotification ? 'pending' : 'suppressed',
          updated_at: seriesToken,
        });
      // Fenced (token) bulk finalize: sent on acceptance, released for
      // retry otherwise. Rows another owner reclaimed are left alone.
      const finalizeSeriesClaims = async (accepted, { retryable = false } = {}) => {
        try {
          if (!accepted && retryable) {
            // Transient provider failure: keep the pending leases so the
            // sweep's group recovery retries — releasing would strand the
            // series (targets are already cancelled, so the dispatch
            // retry finds nothing to re-cancel; codex r7). Gate off = no
            // sweep → release for a manual retry.
            const { isEnabled } = require('../config/feature-gates');
            if (isEnabled('cancelNoticeHook')) return;
          }
          await db('appointment_reminders')
            .whereIn('scheduled_service_id', ids)
            .whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
            .where('cancellation_notice_at', seriesToken)
            .update(accepted
              ? { cancellation_notice_state: 'sent', updated_at: new Date() }
              : { cancellation_notice_at: null, cancellation_notice_state: null, updated_at: new Date() });
        } catch (finalizeErr) {
          logger.warn(`[appt-remind] series notice-claim finalize failed: ${finalizeErr.message}`);
        }
      };
      if (!sendNotification) {
        logger.info(`[appt-remind] Series cancellation notices suppressed for ${ids.length} appointment(s)`);
        return { cancelledCount: ids.length };
      }

      try {
      let record = null;
      if (representativeScheduledServiceId) {
        record = await db('appointment_reminders')
          .where({ scheduled_service_id: representativeScheduledServiceId })
          .first();
      }
      if (!record) {
        record = await db('appointment_reminders')
          .whereIn('scheduled_service_id', ids)
          .orderBy('appointment_time', 'asc')
          .first();
      }
      if (!record) {
        logger.info(`[appt-remind] Series cancellation: no reminder records for ${ids.length} appointment(s)`);
        reportOutcome(false, 'No reminder records for these visits — no cancellation text was sent');
        await finalizeSeriesClaims(false);
        return { cancelledCount: ids.length };
      }

      const { customer } = await getCustomerAndTech(record.customer_id, representativeScheduledServiceId || record.scheduled_service_id);
      if (customer) {
        const prefs = await db('notification_prefs').where({ customer_id: record.customer_id }).first().catch(() => PREFS_UNAVAILABLE);
        const scopeText = options.scope === 'series' ? 'recurring series' : 'future recurring appointments';
        const serviceLabel = smsServiceLabelStored(options.serviceType || record.service_type);
        const sendOutcome = {};
        const noticeSent = await safeSendAppointment(customer, prefs || {}, async (contact) => {
          const firstName = firstNameFrom(contact.name) || customer?.first_name || 'there';
          return renderTemplate(
            'appointment_series_cancelled',
            { first_name: firstName, service_type: serviceLabel, scope: scopeText },
            { workflow: 'appointment_series_cancelled', entity_type: 'scheduled_service', entity_id: representativeScheduledServiceId || record.scheduled_service_id },
          );
        }, 'appointment_series_cancelled', 'appointment_cancellation',
        // Representative-visit linkage: the sweep's accepted-cancellation
        // check recognizes the combined send through this audit row.
        // Row-backed linkage (codex r13): record always has a reminder
        // row, so acceptance reconciliation can find the group through it
        // even when the preferred representative lacks one.
        { scheduled_service_id: record.scheduled_service_id }, {
          sendOutcome,
          // Ownership fence at the provider handoff (codex r7): if the
          // sweep reclaimed this series while we rendered, stand down —
          // its group recovery owns the notice now.
          preDispatchCheck: async () => {
            // Full-group ownership (codex r8): any target's pending claim
            // held under a FOREIGN token means a single-visit worker
            // adopted it — sending the combined notice too would
            // double-text. Own at least one target AND no foreign claims.
            const own = await db('appointment_reminders')
              .whereIn('scheduled_service_id', ids)
              .whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
              .where('cancellation_notice_at', seriesToken)
              .first('id');
            const foreign = await db('appointment_reminders')
              .whereIn('scheduled_service_id', ids)
              .where(function notOurToken() {
                this.whereNot('cancellation_notice_at', seriesToken)
                  // A restored target's marker was cleared to NULL — the
                  // series no longer describes reality (r12).
                  .orWhereNull('cancellation_notice_at');
              })
              .where(function foreignOwner() {
                // A pending foreign claim = an adopter mid-send; a SENT
                // row stamped after our claim = an adopter that already
                // texted (codex r9). Either way the combined send would
                // double-text.
                this.whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
                  .orWhere(function freshSent() {
                    this.where('cancellation_notice_state', 'sent')
                      .where('updated_at', '>=', seriesToken);
                  });
              })
              .first('id');
            return (own && !foreign)
              ? { ok: true }
              : { ok: false, code: 'notice_claim_lost', reason: 'series notice lease was reclaimed or partially adopted' };
          },
        });
        if (noticeSent) {
          logger.info(`[appt-remind] Series cancellation notice sent for customer ${record.customer_id} - ${ids.length} appointment(s)`);
        }
        await finalizeSeriesClaims(Boolean(noticeSent), { retryable: sendOutcome.retryable === true });
        reportOutcome(noticeSent, noticeSent
          ? null
          : 'customer was not notified (no eligible recipient, opted out, or the text was blocked)');
      } else {
        await finalizeSeriesClaims(false);
        reportOutcome(false, 'Customer not found');
      }

      return { ...record, cancelledCount: ids.length };
      } catch (sendErr) {
        // Thrown lookup/pref/validation/audit errors are retryable — keep
        // the pending leases for the sweep (codex r13), then surface.
        await finalizeSeriesClaims(false, { retryable: true });
        throw sendErr;
      }
    } catch (err) {
      logger.error(`[appt-remind] handleSeriesCancellation failed: ${err.message}`);
      reportOutcome(false, err.message);
      return null;
    }
  },
};

// Exposed so other appointment send paths (e.g. the en-route send in
// services/twilio.js, which has no Twilio delivery callback when the SMS is
// skipped locally) can raise the same deduped "no reachable channel" admin alert.
AppointmentReminders.alertNoReachableChannel = alertNoReachableChannel;

// Exposed so self-service booking paths (booking, estimate acceptance,
// call-created) can route their own confirmation SMS through the customer's
// account-level confirmation channel preference.
AppointmentReminders.deliverConfirmationByChannel = deliverConfirmationByChannel;

// Exposed so the tech-tracking send paths in services/twilio.js can honor the
// customer's account-level delivery channel (en_route_channel /
// tech_arrived_channel) with the same normalization and primary-profile
// resolution the appointment reminders use.
AppointmentReminders.apptChannel = apptChannel;
AppointmentReminders.resolveChannelPrefsRow = resolveChannelPrefsRow;
// Shared re-arm boundaries (see each function's own comment) — the dispatch
// and reschedule-sms compensating re-arms consult these instead of hardcoding
// the cron's 24.25h / start-in-the-future cutoffs.
AppointmentReminders.reminder72hStillReachable = reminder72hStillReachable;
AppointmentReminders.reminder24hStillReachable = reminder24hStillReachable;
// Shared appointment-notice fanout (recipient routing, opt-in holds,
// landline guard) — the admin reschedule notice sends through this instead
// of texting customers.phone directly, so appointment_notify_primary and
// service-contact routing always apply.
AppointmentReminders.safeSendAppointment = safeSendAppointment;
// Sanitized customer-facing service label (strips admin suffixes; the
// reminder row's stored value already folds in add-on lines) — shared so
// the admin reschedule notice renders the same label as every reminder.
AppointmentReminders.smsServiceLabelStored = smsServiceLabelStored;

AppointmentReminders._test = {
  maskPhone,
  sanitizeLookupError,
  apptChannel,
  deliverAppointmentNotice,
  deliverConfirmationByChannel,
  scheduledServiceApptTime,
  sendAppointmentNoticeEmail,
  getReminderPrefs,
};

// Exposed for unit tests (e.g. the shared line-type cache consolidation).
AppointmentReminders._internals = { isLandline };

// Shared with the OTHER booking-confirmation senders (estimate acceptance,
// call pipeline) so gate-on means link-first copy everywhere, not only for
// this service's own confirmation path.
AppointmentReminders.renderAppointmentPageTemplate = renderAppointmentPageTemplate;
// Exported for the other two confirmation senders (call-recording-processor,
// estimate-public) so all three quote the arrival window identically.
AppointmentReminders.confirmationArrivalWindow = confirmationArrivalWindow;

module.exports = AppointmentReminders;
