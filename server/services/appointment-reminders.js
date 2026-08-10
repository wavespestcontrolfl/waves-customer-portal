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
// Boundary-rotation generation guard (codex #3233 r37).
const PROCESS_BOOT_AT = new Date();
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { readCachedLineType, cacheLineType, NON_SMS_LINE_TYPES } = require('./messaging/validators/line-type');
const { getAppointmentContacts, isServiceContactRole, firstNameFrom, PREFS_UNAVAILABLE } = require('./customer-contact');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { TZ, parseETDateTime, formatETDay, formatETDate, formatETTime, etDateString, addETDays, etParts } = require('../utils/datetime-et');
const AppointmentEmail = require('./appointment-email');
const NotificationService = require('./notification-service');
const { buildRescheduleLink } = require('./reschedule-link');
const { buildAppointmentLink } = require('./appointment-link');
// Canonical service_type normalization — the estimate-backed label recovery
// compares stored fall-through values against this exact transform; reusing
// the writer's implementation keeps the two from drifting.
const { cappedServiceType } = require('./slot-reservation');

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

// Send-window pre-check for the 72h/24h reminder legs (GATE_SMS_SEND_WINDOW,
// owner ruling 2026-08-07). Checked BEFORE the send attempt because a
// canonical-path block inside safeSendAppointment would cascade into the
// email fallback + the no-reachable-channel alert and still mark the
// reminder sent — a night email plus a burned reminder is exactly the
// behavior the window exists to stop. Pure-email reminders are untouched;
// 'both' holds the whole notice so one deferral covers both legs.
function reminderSendWindowHold(channel, { smsEnabled = true } = {}) {
  if (apptChannel(channel) === 'email') return false;
  // SMS opt-out: the SMS leg can never send, so holding "for the window"
  // would only starve the email fallback (and for a pre-8AM visit, kill
  // the notice entirely) — proceed and let deliverAppointmentNotice's
  // normal opt-out block route to email immediately.
  if (smsEnabled === false) return false;
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('smsSendWindow')) return false;
  const { isWithinSendWindowET } = require('./messaging/send-window');
  return !isWithinSendWindowET();
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
//
// `smsOutcome` (optional): the same out-param object the caller passed into
// safeSendAppointment. When the SMS leg was refused by the send-window
// boundary re-check at the provider handoff (blockedCode QUIET_HOURS_HOLD —
// the reminderSendWindowHold pre-check passed at 19:59 but the clock crossed
// 20:00 during the template/link/lookup awaits), the notice is DEFERRED, not
// failed: no email fallback, no no-channel alert. Callers see false + the
// blockedCode and leave their row unmarked so the next cron tick re-decides
// (72h/confirmation re-send at 8:00 AM; the 24h branch's own pre-check
// applies the same-day skip ruling).
async function deliverAppointmentNotice({ channel, kind, customerId, scheduledServiceId = null, apptTime = null, serviceLabel = 'service', rescheduleUrl = null, smsAttempt, smsOutcome = null }) {
  const ch = apptChannel(channel);
  const emailArgs = { kind, customerId, scheduledServiceId, apptTime, serviceLabel, rescheduleUrl };
  const smsHeld = () => !!smsOutcome && smsOutcome.blockedCode === 'QUIET_HOURS_HOLD';

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
    if (!smsOk && smsHeld()) {
      // Transient window hold, not an unreachable customer — no alert; the
      // caller leaves its row unmarked and the next tick retries (the email
      // leg is idempotent per occurrence, so re-running it is safe).
      logger.info(`[appt-remind] ${kind} SMS fallback for ${customerId} held at the send-window boundary — notice deferred`);
      return false;
    }
    if (!smsOk) await alertNoReachableChannel({ customerId, kind, scheduledServiceId, emailReason: emailReasonOf(res) });
    return smsOk;
  }

  if (ch === 'both') {
    const smsOk = await runSms();
    if (!smsOk && smsHeld()) {
      // The SMS leg defers to the window; the EMAIL leg is not subject to
      // it and goes out NOW. Returning false still leaves the caller's row
      // unmarked, so the sweep/next tick re-runs this notice for the SMS
      // leg alone — the email send is idempotent per occurrence, so the
      // replay cannot double-deliver it. Holding the email with the SMS
      // (the old shape) lost BOTH legs for a night booking of a pre-8AM
      // visit: at 08:00 the past-appointment guard closes the row before
      // the sweep can deliver anything.
      const heldEmailRes = await sendAppointmentNoticeEmail(emailArgs);
      logger.info(`[appt-remind] ${kind} SMS leg for ${customerId} held at the send-window boundary — SMS deferred, email leg ${heldEmailRes?.ok ? 'sent now' : `not sent (${heldEmailRes?.reason || heldEmailRes?.error || 'unknown'})`}`);
      return false;
    }
    const emailRes = await sendAppointmentNoticeEmail(emailArgs);
    const emailOk = !!emailRes?.ok;
    // Neither channel reached the customer — raise the same human-follow-up
    // alert the SMS-only path uses.
    if (!smsOk && !emailOk) await alertNoReachableChannel({ customerId, kind, scheduledServiceId, emailReason: emailReasonOf(emailRes) });
    return smsOk || emailOk;
  }

  // 'sms' default — unchanged behavior (except the boundary hold: a hold is
  // a deferral, and the night email fallback plus a marked row is exactly
  // what the send window exists to stop).
  const smsOk = await runSms();
  if (!smsOk && smsHeld()) {
    logger.info(`[appt-remind] ${kind} SMS for ${customerId} held at the send-window boundary — notice deferred`);
    return false;
  }
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

// The estimate-accept path keeps scheduled_services.service_type canonical
// for protocol/default lookups; when the accepted service has no canonical
// mapping it falls back to the estimate's raw service_interest category
// ("Termite" for a Pre-Slab Termiticide Treatment). That category is wrong
// as customer-facing SMS copy — the accepted label survives in the
// "Accepted service mix: X." notes line, so recover it from there. Only
// single-service mixes qualify: multi-service visits are labeled by the
// addon join in buildServiceLabel, and substituting a joined mix here
// would list the same services twice. Visit-count prefixes ("6x Lawn
// Care") are stripped — counts belong in estimates, not reminders.
const SERVICE_MIX_NOTE_RE = /(?:^|\n)Accepted service mix:[ \t]*([^\n]+?)\.?[ \t]*(?:\n|$)/;

function acceptedMixServiceName(notes) {
  const match = SERVICE_MIX_NOTE_RE.exec(String(notes || ''));
  if (!match) return null;
  const cleaned = match[1]
    .replace(/\b\d+x\s+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Multi-service detection keys on the producer's literal ' + ' join
  // (formatServiceProfileLabel in estimate-slot-availability.js) — '&' and
  // commas appear in legitimate single-service names ("Tree & Shrub") and
  // must not disqualify recovery.
  if (!cleaned || cleaned.includes(' + ')) return null;
  // No length cap: appointment_reminders.service_type is text
  // (20260428000010 widened it precisely so joined labels never truncate).
  return cleaned;
}


// Returns the accepted-estimate service name when the stored parent label is
// just the estimate's raw category (the canonical-mapping fall-through
// signature: service_type === estimates.service_interest, or the 'Estimate
// service' default). Mapped canonical labels ("Quarterly Pest Control") and
// anything without a usable mix line pass through unchanged.
async function estimateBackedServiceName(scheduledServiceId, parentName, conn = db) {
  const stored = String(parentName || '').trim();
  if (!stored) return parentName;
  try {
    const svc = await conn('scheduled_services as s')
      .leftJoin('estimates as e', 'e.id', 's.source_estimate_id')
      .where('s.id', scheduledServiceId)
      .first('s.notes', 'e.service_interest');
    if (!svc) return parentName;
    const interest = cappedServiceType(svc.service_interest, '');
    if (stored !== interest && stored !== 'Estimate service') return parentName;
    const mixName = acceptedMixServiceName(svc.notes);
    if (!mixName || mixName === stored) return parentName;
    return mixName;
  } catch {
    return parentName;
  }
}

// Joined service label for multi-service appointments. Returns the parent name
// alone for single-service visits, "A & B" for two, and Oxford-comma style
// "A, B, and C" for three or more. The result is persisted into
// appointment_reminders.service_type so the cron / reschedule / cancel paths
// inherit it automatically without re-querying addons.
async function buildServiceLabel(scheduledServiceId, parentName) {
  const resolvedParent = await estimateBackedServiceName(scheduledServiceId, parentName);
  const fallback = smsServiceLabel(resolvedParent) || 'service';
  try {
    const addons = await db('scheduled_service_addons')
      .where({ scheduled_service_id: scheduledServiceId })
      .pluck('service_name');
    const all = [resolvedParent, ...addons].map(smsServiceLabel).filter(Boolean);
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
      // coalesce() above re-reads the raw canonical ss.service_type, so the
      // estimate fall-through category would resurface in merged labels
      // without the same recovery registration applies.
      label = await estimateBackedServiceName(r.scheduled_service_id, label, conn);
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
      if (NON_SMS_LINE_TYPES.has(cached.lineType)) {
        logger.info(`[appt-remind] Skipping SMS — cached ${cached.lineType} for ${maskPhone(phone)}`);
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
      if (NON_SMS_LINE_TYPES.has(customer.line_type)) {
        logger.info(`[appt-remind] Skipping SMS — cached ${customer.line_type} for customer ${customerId}`);
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

      if (NON_SMS_LINE_TYPES.has(lineType)) {
        logger.info(`[appt-remind] ${lineType} detected for customer ${customerId}, skipping SMS`);
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

async function safeSend(customerId, phone, body, messageType = 'appointment_reminder', purpose = 'appointment', identityTrustLevel = 'phone_matches_customer', metaExtra = {}, preDispatchCheck = null, sendOutcome = null, operatorInitiated = false) {
  // Per-contact phase state (codex r19): dispatchStarted must reflect THIS
  // attempt only — a prior contact's handoff must not classify a later
  // contact's pre-dispatch throw as uncertain. (retryable/dispatchUncertain
  // stay sticky across the loop by design.)
  if (sendOutcome && typeof sendOutcome === 'object') sendOutcome.dispatchStarted = false;
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

  let result;
  try {
    result = await sendCustomerMessage({
    to: phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose,
    customerId,
    identityTrustLevel,
    // Send-window exemption for AUTHENTICATED operator actions only (the
    // rain-out/quick-move contract): a dispatcher marking a visit no-show
    // at 20:30 and explicitly asking to notify is acting live, and the
    // window exists to stop AUTOMATED night sends. Threaded from the
    // route through the handler — never defaulted true, and cron/
    // customer-driven callers leave it false so they stay fenced.
    ...(operatorInitiated === true ? { operatorInitiated: true } : {}),
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
  } catch (sendErr) {
    // Only a throw AFTER the provider handoff began is dispatch-uncertain
    // (audit persistence follows dispatch); the fence preDispatchCheck
    // marks dispatchStarted immediately before the handoff, so earlier
    // throws (contact load, validation, blocked-audit) stay retryable
    // (codex r16/r17).
    if (sendOutcome && typeof sendOutcome === 'object' && sendOutcome.dispatchStarted === true) {
      // A KNOWN provider outcome on the error (attached by the canonical
      // sender when audit persistence throws) beats phase inference: a
      // definite sent:false is a plain retryable failure (codex r18).
      if (sendErr && sendErr.providerOutcome && sendErr.providerOutcome.sent === false) {
        sendOutcome.retryable = sendOutcome.retryable === true || sendErr.providerOutcome.retryable === true;
      } else {
        sendOutcome.dispatchUncertain = true;
      }
    }
    throw sendErr;
  }
  // Callers that must distinguish transient provider failures (Twilio
  // 429/5xx/timeouts — sendCustomerMessage returns { sent:false,
  // retryable:true }) from deterministic non-delivery pass an out-param:
  // the boolean return alone collapses that distinction (codex #3233 r6).
  if (sendOutcome && typeof sendOutcome === 'object') {
    // Sticky-true across a multi-contact loop (codex r7): one retryable
    // failure must survive a later contact's deterministic block. A
    // THROWING preDispatchCheck surfaces as a blocked result with code
    // PRE_DISPATCH_CHECK_FAILED — that's transient infra (our fence's DB
    // read failed), retryable, not a deterministic block (codex r25).
    sendOutcome.retryable = sendOutcome.retryable === true || result.retryable === true
      // Consent/suppression lookup failures are transient infra by
      // contract (codex r47) — terminal suppression would drop the
      // notice permanently on a blip.
      || result.code === 'PRE_DISPATCH_CHECK_FAILED'
      || result.code === 'CONSENT_LOOKUP_FAILED';
    // QUIET_HOURS_HOLD is STICKY across the contact fanout (like
    // retryable/providerAccepted): a later opted-out contact's block must
    // not erase the evidence that an eligible contact was held at the
    // boundary — the callers' defer-don't-close decision reads this code.
    sendOutcome.blockedCode = sendOutcome.blockedCode === 'QUIET_HOURS_HOLD'
      ? 'QUIET_HOURS_HOLD'
      : (result.code || null);
    // NON-sticky per-call evidence for safeSendAppointment's fan-out loop:
    // the sticky blockedCode above cannot say WHICH contact was held once
    // an earlier contact set it, so the loop reads this call's own code
    // (reset by the loop before each contact). deferred + nextAllowedAt
    // ride along so a held contact can be queued on the scheduled rail.
    sendOutcome.lastCode = result.code || null;
    sendOutcome.lastDeferred = result.deferred === true;
    sendOutcome.lastNextAllowedAt = result.nextAllowedAt || null;
  }
  if (result.blocked || result.sent === false) {
    logger.warn(`[appt-remind] SMS blocked for customer ${customerId}: ${result.code || 'unknown'} ${result.reason || ''}`);
    return false;
  }
  // Sticky fanout acceptance (codex r34): once ANY contact was accepted
  // by the provider, a later contact's throw must not classify the whole
  // fanout as retryable — a retry would double-text the accepted
  // recipient. Callers finalize 'sent' when this is set.
  if (sendOutcome && typeof sendOutcome === 'object') sendOutcome.providerAccepted = true;
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
  // Callers that need outcome classification pass their own object; a local
  // one otherwise, so per-call hold evidence is always readable here.
  const sharedOutcome = (sendOptions.sendOutcome && typeof sendOptions.sendOutcome === 'object')
    ? sendOptions.sendOutcome
    : {};
  const heldContacts = [];
  for (const contact of allowedContacts) {
    const body = typeof renderBody === 'function' ? await renderBody(contact) : renderBody;
    const identityTrustLevel = isServiceContactRole(contact.role)
      ? 'service_contact_authorized'
      : 'phone_matches_customer';
    // Reset the NON-sticky per-call fields before each contact — a held
    // predecessor's evidence must not classify a later opted-out/landline
    // contact (which returns false without touching them) as held.
    sharedOutcome.lastCode = null;
    sharedOutcome.lastDeferred = false;
    sharedOutcome.lastNextAllowedAt = null;
    const sent = await safeSend(customer.id, contact.phone, body, messageType, purpose, identityTrustLevel, metaExtra, sendOptions.preDispatchCheck || null, sharedOutcome, sendOptions.operatorInitiated === true);
    if (!sent && sharedOutcome.lastCode === 'QUIET_HOURS_HOLD'
      && sharedOutcome.lastDeferred && sharedOutcome.lastNextAllowedAt) {
      heldContacts.push({ contact, body, nextAllowedAt: sharedOutcome.lastNextAllowedAt });
    }
    sentAny = sentAny || sent;
  }
  // Partial fan-out across the 20:00 boundary (codex r20): one accepted
  // contact makes callers finalize 'sent', so a later held contact would
  // silently vanish — persist ONLY the held recipients on the scheduled
  // rail (call-booking secondary precedent). When NOTHING was accepted the
  // callers' own defer/skip paths re-fire the whole notice, so queueing
  // here too would double-text — rows are queued only on partial success.
  // EXCEPT for callers that HAVE no re-fire path (codex r21): a terminal
  // one-shot notice (no-show) is dropped outright by a full hold, so those
  // callers opt into queueing every held contact by passing
  // queueHeldContactsOnFullHold. Safe only where no cron/sweep re-sends.
  if ((sentAny || sendOptions.queueHeldContactsOnFullHold === true) && heldContacts.length) {
    await queueHeldNoticeContacts({ customer, heldContacts, messageType, purpose, metaExtra });
  }
  return sentAny;
}

// Persist the held recipients of a PARTIALLY delivered appointment-notice
// fan-out on the scheduled-SMS rail. The row belongs to the CONTACT's phone
// (frozen at enqueue — NO refresh_customer_phone; a send-time swap to the
// account holder would misdeliver); the registry's contact-slot recheck
// re-runs the same contact resolution the fan-out used at 8:00 AM. A held
// 24h reminder is SKIPPED, not queued: its 8:00 AM replay lands on the
// visit's own day (owner ruling 2026-08-07 — the Tsai/Louis incident class),
// and the delivered contact already carries the reminder.
async function queueHeldNoticeContacts({ customer, heldContacts, messageType, purpose, metaExtra }) {
  if (purpose === 'appointment_reminder_24h') {
    logger.info(`[appt-remind] ${heldContacts.length} held 24h-reminder contact(s) for customer ${customer.id} SKIPPED — an 8AM replay would land on the visit's own day`);
    return;
  }
  const TWILIO_NUMBERS = require('../config/twilio-numbers');
  // Which visit state the notice DESCRIBES (codex r22). A confirmation or
  // prep text is about an UPCOMING visit, so the shared liveness predicate
  // is right for it. A cancellation / no-show notice is the opposite: its
  // visit is deliberately terminal, so the liveness predicate would drop
  // the replay outright (and, if the visit were restored overnight, would
  // instead send a frozen cancellation for a live appointment). Stamp the
  // statuses the replay must still find so the registry can check the
  // right thing.
  const TERMINAL_NOTICE_STATUSES = {
    // Both spellings: the self-heal set treats 'canceled' as equivalent, so
    // a row written either way must still replay.
    appointment_cancelled: ['cancelled', 'canceled'],
    appointment_no_show: ['no_show'],
  };
  const requiredVisitStatuses = TERMINAL_NOTICE_STATUSES[messageType] || null;
  for (const held of heldContacts) {
    try {
      await db('sms_log').insert({
        customer_id: customer.id,
        direction: 'outbound',
        from_phone: TWILIO_NUMBERS.getOutboundNumber(),
        to_phone: held.contact.phone,
        message_body: held.body,
        status: 'scheduled',
        scheduled_for: new Date(held.nextAllowedAt),
        message_type: messageType,
        metadata: JSON.stringify({
          entry_point: 'appointment_notice_contact_deferred',
          ...(metaExtra.scheduled_service_id ? { scheduled_service_id: metaExtra.scheduled_service_id } : {}),
          appointment_contact_role: held.contact.role || null,
          original_block_code: 'QUIET_HOURS_HOLD',
          replay_purpose: purpose,
          ...(requiredVisitStatuses ? { required_visit_statuses: requiredVisitStatuses } : {}),
          resolve_from_by_customer: true,
        }),
      });
      logger.info(`[appt-remind] ${messageType} to ${held.contact.role || 'contact'} held outside the 8AM-8PM ET send window — queued for ${held.nextAllowedAt}`);
    } catch (queueErr) {
      // The fan-out already partially delivered — re-arming the whole
      // notice would double-text the accepted contact, so a failed
      // enqueue can only be surfaced loudly.
      logger.error(`[appt-remind] held ${messageType} requeue failed for ${held.contact.role || 'contact'} (customer ${customer.id}): ${queueErr.message}`);
    }
  }
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

      // Outside the send window: return WITHOUT marking confirmation_sent —
      // the stranded-confirmation sweep (every 15 min) re-calls this
      // function and the text goes out when the window opens at 8:00 AM.
      // Attempting the send instead would burn the confirmation: the
      // canonical-path block collapses to false here, the email fallback
      // fires at night, and the unconditional mark below ends all retries.
      if (reminderSendWindowHold(prefs.confirmationChannel, { smsEnabled: prefs.smsEnabled })) {
        // 'both': the customer's requested EMAIL is not subject to the SMS
        // window — send it NOW and defer only the SMS leg via the unmarked
        // row. Idempotent per occurrence, so the sweep's replay (which
        // re-enters through deliverAppointmentNotice) can't double-send it.
        // Without this, an after-20:00 booking of an 08:00 visit delivered
        // NEITHER leg: the sweep's every-15-min replay stayed held all
        // night, and at 08:00 the past-appointment guard above closes the
        // row before the window ever admits the SMS.
        if (apptChannel(prefs.confirmationChannel) === 'both') {
          const heldEmailRes = await sendAppointmentNoticeEmail({ kind: 'confirmation', customerId, scheduledServiceId, apptTime, serviceLabel });
          logger.info(`[appt-remind] Confirmation for ${scheduledServiceId} held — email leg ${heldEmailRes?.ok ? 'sent now' : `not sent (${heldEmailRes?.reason || heldEmailRes?.error || 'unknown'})`}, SMS deferred`);
        }
        logger.info(`[appt-remind] Confirmation for ${scheduledServiceId} deferred — outside 8AM-8PM ET send window`);
        return false;
      }

      const day = formatDay(apptTime);
      const date = formatDate(apptTime);
      const time = formatTime(apptTime);

      // Self-serve reschedule deep link — one mint shared by the SMS clause
      // and the email CTA. Best-effort: a null link renders clean copy.
      const reschedule = await buildRescheduleLink(scheduledServiceId, { customerId });
      // Honor the customer's channel preference (sms | email | both). The
      // 'sms' default is unchanged: SMS first, email fallback on failure.
      // smsOutcome carries a provider-handoff QUIET_HOURS_HOLD (the pre-check
      // above passed, then the clock crossed 20:00 mid-flight) back out so
      // the hold defers instead of burning the confirmation below.
      const smsOutcome = {};
      const sent = await deliverAppointmentNotice({
        channel: prefs.confirmationChannel,
        kind: 'confirmation',
        customerId,
        scheduledServiceId,
        apptTime,
        serviceLabel,
        rescheduleUrl: reschedule.url,
        smsOutcome,
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
        }, 'confirmation', 'appointment_confirmation', { scheduled_service_id: scheduledServiceId }, { sendOutcome: smsOutcome }),
      });

      // Boundary hold — same treatment as the pre-check above: return
      // WITHOUT marking, so the stranded-confirmation sweep re-calls this
      // function and the text goes out when the window opens at 8:00 AM.
      if (!sent && smsOutcome.blockedCode === 'QUIET_HOURS_HOLD') {
        logger.info(`[appt-remind] Confirmation for ${scheduledServiceId} held at the send-window boundary — deferred, row left unmarked`);
        return false;
      }

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
    // Label recovery reads through the caller's conn — borrowing a second
    // pool connection while conn holds a transaction could stall the
    // payment/booking txn behind pool exhaustion (max 20). Same-txn seeded
    // visits are visible on conn and simply aren't fall-through cases; the
    // helper fails open on error either way.
    const estimateBacked = await estimateBackedServiceName(scheduledServiceId, serviceType, conn);
    const serviceLabel = smsServiceLabelStored(estimateBacked) || estimateBacked || null;
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

          // Outside the send window: leave the row UNMARKED — the
          // 15-minute cron re-checks it and the reminder goes out when the
          // window opens at 8:00 AM, still days ahead of the visit. (A row
          // that ages into the 24h band overnight is owned by the 24h
          // branch on the morning tick.) Deliberately not counted as
          // skipped: nothing was decided, only deferred.
          if (reminderSendWindowHold(channel72, { smsEnabled: prefs.smsEnabled })) {
            logger.info(`[appt-remind] 72h reminder for ${r.scheduled_service_id} deferred — outside 8AM-8PM ET send window`);
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
            // smsOutcome carries a provider-handoff QUIET_HOURS_HOLD (the
            // pre-check above passed at 19:59, the clock crossed 20:00
            // mid-flight) back out so the hold defers instead of marking.
            const smsOutcome72 = {};
            const reached72 = await deliverAppointmentNotice({
              channel: channel72,
              kind: '72h',
              customerId: r.customer_id,
              scheduledServiceId: r.scheduled_service_id,
              apptTime,
              serviceLabel,
              rescheduleUrl: reschedule.url,
              smsOutcome: smsOutcome72,
              smsAttempt: () => safeSendAppointment(customer, prefs.raw, async (contact) => {
                const firstName = firstNameFrom(contact.name) || customer?.first_name || 'there';
                return renderTemplate(
                  'reminder_72h',
                  { first_name: firstName, service_type: serviceLabel, day, date, time, window: formatArrivalWindow(apptTime), reschedule_line: reschedule.line, card_hold_policy_line: cardHoldPolicyLine72 },
                  { workflow: 'appointment_reminder_72h', entity_type: 'scheduled_service', entity_id: r.scheduled_service_id },
                );
              }, 'reminder_72h', 'appointment_reminder_72h', { scheduled_service_id: r.scheduled_service_id }, { sendOutcome: smsOutcome72 }),
            });

            // Boundary hold — leave the row UNMARKED, same as the pre-check
            // defer: the 15-minute cron re-selects it and the reminder goes
            // out at 8:00 AM, still days ahead of the visit.
            if (!reached72 && smsOutcome72.blockedCode === 'QUIET_HOURS_HOLD') {
              logger.info(`[appt-remind] 72h reminder for ${r.scheduled_service_id} held at the send-window boundary — deferred, row left unmarked`);
              continue;
            }

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

          // Outside the send window (owner ruling 2026-08-07): an EVENING
          // hold's deferred send would land on the visit's own day — an
          // 8:00 AM text for that morning's appointment reminds nobody, so
          // close the reminder. A PRE-OPENING hold (e.g. a 7:45 AM restart
          // draining backlog) is different: the window opens later TODAY,
          // still a full day before tomorrow's visit — defer like the 72h
          // leg instead of burning the reminder. Same appointment_time-
          // guarded close as the preference skip so a concurrent move's
          // re-arm is never stomped.
          if (reminderSendWindowHold(channel24, { smsEnabled: prefs.smsEnabled })) {
            const { nextSendWindowOpenET } = require('./messaging/send-window');
            if (etDateString(nextSendWindowOpenET(now)) < apptDateET) {
              logger.info(`[appt-remind] 24h reminder for ${r.scheduled_service_id} deferred — outside 8AM-8PM ET send window, window reopens before the visit day`);
              continue;
            }
            // 'both' channel: the SKIP ruling applies to the SMS leg (a
            // deferred text would land on the visit's own day), but the
            // customer's requested EMAIL is not subject to the SMS window —
            // deliver it now so closing the row drops one leg, not both.
            // Best-effort + idempotent per occurrence; an email failure
            // still closes (same as the SMS-only skip, where nothing sends).
            if (apptChannel(channel24) === 'both') {
              const emailRes = await sendAppointmentNoticeEmail({
                kind: '24h',
                customerId: r.customer_id,
                scheduledServiceId: r.scheduled_service_id,
                apptTime,
                serviceLabel: smsServiceLabelStored(r.service_type),
              });
              logger.info(`[appt-remind] 24h night skip for ${r.scheduled_service_id} — email leg ${emailRes?.ok ? 'sent' : `not sent (${emailRes?.reason || emailRes?.error || 'unknown'})`} before close`);
            }
            const closedWindow24 = await db('appointment_reminders')
              .where({ id: r.id })
              .where('appointment_time', r.appointment_time)
              .update({ reminder_24h_sent: true, reminder_24h_sent_at: new Date() });
            if (closedWindow24 === 0) {
              logger.info(`[appt-remind] 24h send-window close skipped for ${r.scheduled_service_id} — appointment moved during scan; leaving re-armed row`);
            } else {
              logger.info(`[appt-remind] Skipping 24h reminder for ${r.scheduled_service_id} — outside 8AM-8PM ET send window; a deferred send would land on the visit day`);
              results.skipped++;
            }
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
            // smsOutcome carries a provider-handoff QUIET_HOURS_HOLD back
            // out — see the 72h twin above.
            const smsOutcome24 = {};
            const reached24 = await deliverAppointmentNotice({
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
              }, 'appointment_reminder', 'appointment_reminder_24h', { scheduled_service_id: r.scheduled_service_id }, { sendOutcome: smsOutcome24 }),
              smsOutcome: smsOutcome24,
            });

            // Boundary hold — leave the row UNMARKED and let the next
            // 15-minute tick re-decide: its pre-check above applies the
            // owner's ruling (defer when the window reopens before the
            // visit day, otherwise skip+close), which this mid-flight
            // point must not re-implement.
            if (!reached24 && smsOutcome24.blockedCode === 'QUIET_HOURS_HOLD') {
              logger.info(`[appt-remind] 24h reminder for ${r.scheduled_service_id} held at the send-window boundary — deferred to the next scan's window ruling`);
              continue;
            }

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
      const rescheduleNoticeOutcome = {};
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
          }, 'appointment_rescheduled', 'appointment_confirmation', { scheduled_service_id: scheduledServiceId }, { sendOutcome: rescheduleNoticeOutcome });
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
        // Send-window hold: the generic 72h/24h re-arm can be UNREACHABLE
        // for a next-day move (the 24h band closes before the window
        // reopens), which would silence the one notice this path exists to
        // deliver. Re-arm the CONFIRMATION instead — the 15-minute
        // stranded-confirmation sweep re-calls deliverConfirmation, whose
        // own pre-check defers to 8:00 AM and then sends the standard
        // confirmation carrying the NEW time. Same guards as the 72h
        // re-arm so a newer reschedule's state is never clobbered.
        if (!noticeSent && rescheduleNoticeOutcome.blockedCode === 'QUIET_HOURS_HOLD') {
          await db('appointment_reminders')
            .where({
              id: record.id,
              appointment_time: newApptTime,
              suppressed_by_sibling: false,
              cancelled: false,
            })
            .update({ confirmation_sent: false, confirmation_sent_at: null, updated_at: new Date() })
            .catch((rearmErr) => logger.error(`[appt-remind] confirmation re-arm after held reschedule notice failed: ${rearmErr.message}`));
          logger.info(`[appt-remind] Reschedule notice for ${scheduledServiceId} held (send window) — confirmation re-armed for the stranded-confirmation sweep`);
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

      // A restored visit is LIVE — a stale cancellation worker must not
      // re-close its reminder row or touch claims (codex r13; ordered BEFORE the cancelled flag write — r14).
      const svcNow = await db('scheduled_services')
        .where({ id: scheduledServiceId })
        .first('status');
      if (svcNow && String(svcNow.status) !== 'cancelled') {
        logger.info(`[appt-remind] Cancellation skipped for ${scheduledServiceId} — visit is ${svcNow.status}`);
        reportOutcome(false, `visit is ${svcNow.status} — no cancellation processed`);
        return record;
      }

      // Guarded in ONE statement (codex r20): a restoration committing
      // between the status read above and this write must not be
      // re-closed.
      const closed = await db('appointment_reminders')
        .where({ id: record.id })
        .whereRaw("EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.status = 'cancelled')")
        .update({ cancelled: true, updated_at: new Date() });
      if (!closed) {
        // A restoration won the race after the status read (codex r24) —
        // touch nothing further (a suppressed stamp here would block the
        // NEXT cancellation's notice).
        logger.info(`[appt-remind] Cancellation skipped for ${scheduledServiceId} — visit restored mid-flight`);
        reportOutcome(false, 'visit was restored mid-flight — no cancellation processed');
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
        // Suppression claims terminally IN ONE atomic update (codex r5),
        // with the same singleton-only adoption guards as the notify path
        // (codex r19): a shared series token is the series/sweep's — a
        // single-visit suppress must not swallow the whole group's notice.
        noticeToken = require('./job-status').nextClaimTs();
        claimed = await db('appointment_reminders')
          .where({ id: record.id })
          // Still-cancelled guard (codex r25): a restoration after the
          // guarded close must not be stamped suppressed.
          .whereRaw("EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.status = 'cancelled')")
          .where(function claimable() {
            this.whereNull('cancellation_notice_at')
              .orWhere(function singletonPending() {
                // pending_notify is ROUTE-owned — the route's own awaited
                // call adopts it immediately (the 90s in-flight guard only
                // protects hook-owned 'pending' workers, which always hold
                // a claimToken; codex r21). Singleton-only in both cases.
                this.where(function ownable() {
                  this.where('cancellation_notice_state', 'pending_notify')
                    .orWhere(function agedPending() {
                      this.where('cancellation_notice_state', 'pending')
                        .where('cancellation_notice_at', '<', db.raw("now() - interval '90 seconds'"));
                    });
                })
                  .whereRaw('NOT EXISTS (SELECT 1 FROM appointment_reminders sib WHERE sib.cancellation_notice_at = appointment_reminders.cancellation_notice_at AND sib.id <> appointment_reminders.id AND sib.cancellation_notice_state IN (\'pending\', \'pending_notify\'))');
              });
          })
          .update({ cancellation_notice_at: noticeToken, cancellation_notice_state: 'suppressed', updated_at: noticeToken });
      } else {
        noticeToken = require('./job-status').nextClaimTs();
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
              .orWhere(function freshSingleton() {
                // Adopt fresh pending claims only when NOT group-shared —
                // a same-token sibling means an in-progress series owns
                // this obligation (r14); stale groups belong to the sweep.
                // >=90s old only (r20): an ACTIVE hook worker settles in
                // seconds — don't steal a lease mid-flight.
                // pending_notify is ROUTE-owned — the route's own awaited
                // call adopts it immediately (the 90s in-flight guard only
                // protects hook-owned 'pending' workers, which always hold
                // a claimToken; codex r21). Singleton-only in both cases.
                this.where(function ownable() {
                  this.where('cancellation_notice_state', 'pending_notify')
                    .orWhere(function agedPending() {
                      this.where('cancellation_notice_state', 'pending')
                        .where('cancellation_notice_at', '<', db.raw("now() - interval '90 seconds'"));
                    });
                })
                  .whereRaw('NOT EXISTS (SELECT 1 FROM appointment_reminders sib WHERE sib.cancellation_notice_at = appointment_reminders.cancellation_notice_at AND sib.id <> appointment_reminders.id AND sib.cancellation_notice_state IN (\'pending\', \'pending_notify\'))');
              })
              .orWhere(function staleLease() {
                // Stale SINGLETON leases only (codex r18): a stale shared
                // (series) group is the sweep's — it recovers with the
                // combined copy, not a per-visit text.
                this.whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
                  .where('cancellation_notice_at', '<', db.raw("now() - interval '15 minutes'"))
                  .whereRaw('NOT EXISTS (SELECT 1 FROM appointment_reminders sib WHERE sib.cancellation_notice_at = appointment_reminders.cancellation_notice_at AND sib.id <> appointment_reminders.id AND sib.cancellation_notice_state IN (\'pending\', \'pending_notify\'))');
              });
          })
          .update({ cancellation_notice_at: noticeToken, cancellation_notice_state: db.raw("CASE WHEN cancellation_notice_state = 'pending_notify' THEN 'pending_notify' ELSE 'pending' END"), updated_at: noticeToken });
      }

      if (!sendNotification) {
        if (claimToken && claimed) {
          // Fenced: only the claim owner may finalize as suppressed —
          // and only while the visit is STILL cancelled (codex r39): a
          // restoration whose marker clear was swallowed must not receive
          // a terminal marker that blocks its next real cancellation.
          await db('appointment_reminders')
            .where({ id: record.id }).whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
            .where('cancellation_notice_at', noticeToken)
            .whereRaw("EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.status = 'cancelled')")
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
        .whereRaw("(provider_message_id ~ '^(SM|MM)' OR channel = 'email')")
        .whereRaw(
          "sent_at >= (SELECT COALESCE(MAX(h.transitioned_at), '-infinity') FROM job_status_history h WHERE h.job_id = ? AND h.to_status = 'cancelled' AND h.from_status <> 'cancelled')",
          [scheduledServiceId],
        )
        .first('id'));

      if (!claimed) {
        // A terminal 'sent' marker means the customer HAS the text — a
        // lost-response retry must report success, not a phantom failure
        // (codex r29).
        const current = await db('appointment_reminders')
          .where({ id: record.id })
          .first('cancellation_notice_state');
        // 'sent' alone is not delivery proof (codex r35): it is also the
        // in-flight pre-dispatch fence, which a retryable provider failure
        // later reverts. Report success only on real audit evidence; an
        // evidence-less 'sent' is "being handled", not "delivered".
        if (current?.cancellation_notice_state === 'sent' && await acceptedCancellationAudit()) {
          logger.info(`[appt-remind] Cancellation notice already SENT for ${scheduledServiceId} — reconciled as success`);
          reportOutcome(true, null);
        } else if (current?.cancellation_notice_state === 'sent') {
          logger.info(`[appt-remind] Cancellation notice for ${scheduledServiceId} is claimed and in flight — not re-sending`);
          reportOutcome(false, 'A cancellation notice is already being handled for this visit');
        } else {
          logger.info(`[appt-remind] Cancellation notice already handled for ${scheduledServiceId} — not re-sending`);
          reportOutcome(false, 'A cancellation notice was already handled for this visit');
        }
        return record;
      }

      // Pre-stamp state (codex r23): the retryable revert must restore
      // pending_notify for caller-owned claims, not plain pending.
      const preStampState = (await db('appointment_reminders')
        .where({ id: record.id })
        .first('cancellation_notice_state'))?.cancellation_notice_state || 'pending';

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
      const finalizeClaim = async (sentOk, { retryable = false, uncertain = false } = {}) => {
        try {
          let accepted = Boolean(sentOk);
          // Dispatch-uncertain (r16): the provider may have accepted but
          // the audit never persisted — silence beats a double-text, so
          // finalize as sent.
          if (!accepted && uncertain) accepted = true;
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
            // Revert OUR pre-dispatch 'sent' stamp to pending first
            // (codex r22) — retaining must retain a RETRYABLE state.
            await db('appointment_reminders')
              .where({ id: record.id, cancellation_notice_state: 'sent' })
              .where('cancellation_notice_at', noticeToken)
              .update({ cancellation_notice_state: preStampState === 'pending_notify' ? 'pending_notify' : 'pending', updated_at: new Date() });
            // Keep the pending lease ONLY when something will settle it.
            // With the gate ON the 15-minute sweep re-attempts; parking a
            // ROUTE claim with the gate off would strand it and block an
            // immediate route retry for the lease duration (codex r7).
            // But a caller-supplied claimToken means the SWEEP or hook
            // already owns this obligation (existing-claim settlement runs
            // UNGATED while late-claim creation is gated) — releasing it
            // with the gate off would drop the owed notice forever, so
            // sweep-owned retryable claims are retained regardless of the
            // gate (codex r32).
            const { isEnabled } = require('../config/feature-gates');
            // A retryable lease is retained ONLY when a worker is actually
            // scheduled to settle it (codex r42): with cronJobs disabled
            // the sweep never runs, so retention would strand the claim
            // indefinitely. Released NULL markers are recovered by the
            // late-claim fallback once cron returns (72h window).
            if (isEnabled('cronJobs') && (claimToken || isEnabled('cancelNoticeHook'))) return false;
            // Explicit RELEASE — falling through would hit the terminal
            // 'suppressed' write reserved for deterministic non-delivery.
            // Only plain 'pending' releases (codex r43): the late-claim
            // sweep recreates released rows as evidence-gated 'pending',
            // which would silently drop an operator-requested notify for
            // a visit with no prior reminder. 'pending_notify' keeps its
            // lease — a route retry adopts it after 15 minutes, and the
            // sweep settles it (intent intact) once cron returns.
            await db('appointment_reminders')
              .where({ id: record.id })
              .where('cancellation_notice_state', 'pending')
              .where('cancellation_notice_at', noticeToken)
              .update({ cancellation_notice_at: null, cancellation_notice_state: null, updated_at: new Date() });
            return false;
          }
          await db('appointment_reminders')
            .where({ id: record.id })
            // Includes the pre-dispatch 'sent' stamp under OUR token so a
            // definite provider failure reverts it (codex r21).
            .whereIn('cancellation_notice_state', ['pending', 'pending_notify', 'sent'])
            .where('cancellation_notice_at', noticeToken)
            // Still-cancelled (codex r40): a restoration committing after
            // the handoff stamp (with its marker clear swallowed) must
            // not receive a REASSERTED terminal marker — leave the stale
            // stamp for the restoration repair to clear.
            .whereRaw("EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.status = 'cancelled')")
            .update(accepted
              ? { cancellation_notice_state: 'sent', updated_at: new Date() }
              // Deterministic non-delivery is TERMINAL (codex r39): a
              // released (null) marker is indistinguishable from a lost
              // claim, so the late-claim fallback would re-mint and
              // re-attempt the blocked send every 15 minutes for 72h —
              // and could text a stale notice if the block lifts.
              : { cancellation_notice_state: 'suppressed', updated_at: new Date() });
          return accepted;
        } catch (finalizeErr) {
          logger.warn(`[appt-remind] notice-claim finalize failed for ${scheduledServiceId}: ${finalizeErr.message}`);
          return Boolean(sentOk);
        }
      };

      // Send cancellation notice
      const sendOutcome = {};
      try {
        const { customer } = await getCustomerAndTech(record.customer_id, scheduledServiceId);
        if (customer) {
          const prefs = await db('notification_prefs').where({ customer_id: record.customer_id }).first().catch(() => PREFS_UNAVAILABLE);
          const apptTime = new Date(record.appointment_time);
          const day = formatDay(apptTime);
          const date = formatDate(apptTime);

          const serviceLabel = smsServiceLabelStored(record.service_type);
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
                .where({ id: record.id })
                // Includes our own pre-dispatch 'sent' stamp so contact
                // fanout continues (codex r23).
                .whereIn('cancellation_notice_state', ['pending', 'pending_notify', 'sent'])
                .where('cancellation_notice_at', noticeToken)
                .first('id');
              if (!own) return { ok: false, code: 'notice_claim_lost', reason: 'cancellation-notice lease was reclaimed' };
              // A restore during the post-commit gap means this notice is
              // stale — the visit is live again (codex r10).
              const svc = await db('scheduled_services')
                .where({ id: scheduledServiceId })
                .first('status');
              if (String(svc?.status) !== 'cancelled') {
                return { ok: false, code: 'appointment_restored', reason: `appointment is now ${svc?.status || 'missing'}` };
              }
              // Durable pre-dispatch stamp (codex r21): a process exit
              // between provider acceptance and audit persistence must
              // read as SENT, never retry. A definite failure reverts via
              // the token-fenced finalize below; a pre-acceptance crash
              // sacrifices the notice rather than risking a double text.
              // Accepts our own prior stamp (multi-contact fanout) and
              // MUST win rows — zero rows means a restoration cleared the
              // claim mid-flight (codex r22).
              const stamped = await db('appointment_reminders')
                .where({ id: record.id })
                .whereIn('cancellation_notice_state', ['pending', 'pending_notify', 'sent'])
                .where('cancellation_notice_at', noticeToken)
                // Still-cancelled guard IN the stamp itself (codex r33):
                // a restoration whose marker-clear failed (job-status
                // catches that and commits the live status anyway) can
                // land between the status read above and this update —
                // the token alone would still match. Zero rows = abort.
                .whereRaw("EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.status = 'cancelled')")
                .update({ cancellation_notice_state: 'sent', updated_at: new Date() });
              if (!stamped) {
                return { ok: false, code: 'notice_claim_lost', reason: 'claim cleared before dispatch (restoration?)' };
              }
              sendOutcome.dispatchStarted = true;
              return { ok: true };
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
        // An earlier contact's provider acceptance is sticky (codex r34):
        // finalize sent — sacrificing the failed contact's copy beats
        // re-texting the accepted one when the audit insert also failed.
        const accepted = sendOutcome.providerAccepted === true || sendOutcome.dispatchUncertain === true;
        await finalizeClaim(false, {
          retryable: !accepted,
          uncertain: accepted,
        });
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
      }, 'appointment_no_show', 'appointment_cancellation', { scheduled_service_id: scheduledServiceId }, {
        // Authenticated dispatcher click with an explicit notify choice —
        // exempt from the send window (rain-out/quick-move contract).
        // options.operatorInitiated is threaded by the route; a future
        // autonomous caller that omits it stays fenced AND keeps its
        // notice via the hold rail below.
        operatorInitiated: options.operatorInitiated === true,
        // A no-show notice is a one-shot: no cron re-fires it and the
        // status is already terminal, so a full after-hours hold would
        // drop it permanently for phone-only customers (codex r21).
        // Queue every held contact for the window open instead.
        queueHeldContactsOnFullHold: true,
      });
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
      // Stamp the linkage epoch on the FIRST sweep tick of a
      // linkage-capable instance (codex r32): the migration seeds the row
      // with NULL (everything legacy) because it runs preDeploy while the
      // old instance still owns sending. By the first tick here, this
      // deploy owns sending, so now() is a true capability boundary.
      // Idempotent — only ever fills NULL.
      await db('ops_email_send_state')
        .where({ email_key: 'cancel-notice-linkage-epoch' })
        .whereNull('last_sent_at')
        .update({ last_sent_at: db.fn.now(), updated_at: db.fn.now() })
        .catch(() => {});

      // Late-claim fallback (codex r25) — claim CREATION is gated like
      // every other creation path (codex r26): a dark feature must not
      // mint new obligations; settlement of existing ones stays ungated.
      const { isEnabled: gateEnabled } = require('../config/feature-gates');
      if (!gateEnabled('cancelNoticeHook')) {
        // Segment the enable boundary (codex r36): while the gate is off,
        // keep the boundary cleared so re-enabling stamps a fresh one and
        // gate-off cancellations never backfill late claims.
        // Generation guard (codex r37): only clear a marker stamped
        // BEFORE this process booted — during an off→on rolling deploy a
        // draining gate-off pod must not delete the boundary the new
        // gate-on pod just stamped.
        await db('ops_email_send_state')
          .where({ email_key: 'cancel-notice-hook-enabled-at' })
          .where('last_sent_at', '<', PROCESS_BOOT_AT)
          .del()
          .catch(() => {});
        // Durable record of the newest observed DISABLE (codex r42): even
        // if a draining gate-on pod recreates the enable boundary after
        // our one-shot clear, the next enable sees enabled < disabled and
        // replaces the stale value instead of ignoring it.
        await db.raw(
          "INSERT INTO ops_email_send_state (email_key, last_sent_at, updated_at) VALUES ('cancel-notice-hook-disabled-at', ?, now()) ON CONFLICT (email_key) DO UPDATE SET last_sent_at = GREATEST(ops_email_send_state.last_sent_at, EXCLUDED.last_sent_at), updated_at = now()",
          [PROCESS_BOOT_AT],
        ).catch(() => {});
      }
      if (gateEnabled('cancelNoticeHook')) {
      // (codex r25): a cancel whose in-trx claim AND
      // in-memory fallback were both lost (savepoint failure + crash)
      // leaves a recent cancelled visit with NO claim. Claim it here,
      // backdated to its cancel time so this same run can settle it.
      // Residual: a suppress-intent cancel hitting that double failure
      // may get a (truthful) notice — accepted, evidence-gated anyway.
      // Durable rollout boundary (codex r34): stamped once, the first
      // time the hook is seen enabled — cancels before it never late-claim.
      // Stamped with THIS POD'S BOOT TIME, not now() (codex r39): a
      // draining gate-on pod that recreates the marker after an on-off
      // deploy writes a value OLDER than the new gate-off pod's boot, so
      // that pod's guarded delete can still remove it — generation
      // ownership works in both directions.
      await db('ops_email_send_state')
        .insert({ email_key: 'cancel-notice-hook-enabled-at', last_sent_at: PROCESS_BOOT_AT, updated_at: db.fn.now() })
        .onConflict('email_key')
        .ignore()
        .catch(() => {});
      // A surviving boundary OLDER than the newest observed disable
      // belongs to a previous enable interval (codex r42) — replace it
      // with this generation's boot instead of ignoring it. A boundary
      // from an uninterrupted enable interval is newer than any disable
      // and is preserved.
      await db.raw(
        "UPDATE ops_email_send_state SET last_sent_at = ?, updated_at = now() WHERE email_key = 'cancel-notice-hook-enabled-at' AND last_sent_at < COALESCE((SELECT ds.last_sent_at FROM ops_email_send_state ds WHERE ds.email_key = 'cancel-notice-hook-disabled-at'), '-infinity'::timestamptz)",
        [PROCESS_BOOT_AT],
      ).catch(() => {});
      // Driven from the (indexed) recent cancellation history, not a scan
      // of every unclaimed reminder row (codex r34). Bounded by the 72h
      // age-out horizon: a claim older than that would be suppressed
      // unsent anyway, so scanning further back buys nothing — and within
      // it, a sweep delayed past the old 25-minute window still recovers.
      await db('appointment_reminders')
        .whereNull('cancellation_notice_at')
        // Current-era guard (codex r47): a draining gate-on pod must not
        // late-claim cancels committed after a NEWER disable was stamped
        // (on→off rolling deploy) — late-claiming is allowed only while
        // the enable boundary postdates the newest observed disable.
        .whereRaw("COALESCE((SELECT last_sent_at FROM ops_email_send_state WHERE email_key = 'cancel-notice-hook-enabled-at'), '-infinity'::timestamptz) > COALESCE((SELECT last_sent_at FROM ops_email_send_state WHERE email_key = 'cancel-notice-hook-disabled-at'), '-infinity'::timestamptz)")
        .whereIn('scheduled_service_id', function recentCancels() {
          this.select('h.job_id').from('job_status_history as h')
            .where('h.to_status', 'cancelled')
            .whereNot('h.from_status', 'cancelled')
            .whereRaw("h.transitioned_at >= GREATEST(COALESCE((SELECT last_sent_at FROM ops_email_send_state WHERE email_key = 'cancel-notice-hook-enabled-at'), 'infinity'::timestamptz), now() - interval '72 hours')");
        })
        .whereRaw(`EXISTS (
          SELECT 1 FROM scheduled_services ss
          WHERE ss.id = appointment_reminders.scheduled_service_id
            AND ss.status = 'cancelled'
        )`)
        .update({
          cancellation_notice_at: db.raw("COALESCE((SELECT ok2.last_sent_at FROM ops_email_send_state ok2 WHERE ok2.email_key = 'cn-ci-' || appointment_reminders.scheduled_service_id::text AND ok2.last_sent_at >= now() - interval '72 hours'), (SELECT MAX(h.transitioned_at) FROM job_status_history h WHERE h.job_id = appointment_reminders.scheduled_service_id AND h.to_status = 'cancelled' AND h.from_status <> 'cancelled'))"),
          // A durable caller-intent outbox row (written in the cancel's
          // own transaction when the in-trx claim savepoint failed —
          // codex #3238 r7/r8) upgrades the late claim to pending_notify
          // AND restores the shared group token stored as its value, so
          // partial series failures rejoin their siblings' group. Only
          // FRESH rows (within the 72h horizon) are honored.
          // Live-sibling survivor check applies here too (codex r11): a
          // merged-slot survivor downgrades the outbox intent to the
          // evidence-gated default rather than texting against a live
          // visit.
          // Survivor rows are TERMINALLY suppressed (codex r13), matching
          // the in-trx and post-commit classifications — a plain pending
          // could still send on prior-reminder evidence (or ride a shared
          // group's callerNotify) despite the live sibling visit.
          cancellation_notice_state: db.raw("CASE WHEN NOT (NOT EXISTS (SELECT 1 FROM appointment_reminders sib3 WHERE sib3.customer_id = appointment_reminders.customer_id AND sib3.appointment_time = appointment_reminders.appointment_time AND sib3.cancelled = false AND sib3.id <> appointment_reminders.id)) THEN 'suppressed' WHEN EXISTS (SELECT 1 FROM ops_email_send_state ok WHERE ok.email_key = 'cn-ci-' || appointment_reminders.scheduled_service_id::text AND ok.last_sent_at >= now() - interval '72 hours') THEN 'pending_notify' ELSE 'pending' END"),
          updated_at: new Date(),
        });
      // Consume outbox rows only once their intent is APPLIED — marker
      // present and no longer plain 'pending' (codex r8/r9) — and age out
      // anything past the 72h horizon.
      // Consume only TERMINALLY SUPPRESSED intent (codex r11/r12): even a
      // 'pending_notify' marker can be mid-flight — an active sender that
      // cached plain 'pending' before the upgrade would revert to that
      // cached state on a retryable failure, and a consumed outbox could
      // not re-upgrade it. Keys for notify/sent cycles are removed by the
      // restoration transaction, the live-visit void, or the 72h age-out;
      // the upgrade pass is idempotent in the meantime.
      await db.raw(
        "DELETE FROM ops_email_send_state ok WHERE ok.email_key LIKE 'cn-ci-%' AND (ok.last_sent_at < now() - interval '72 hours' OR EXISTS (SELECT 1 FROM appointment_reminders ar WHERE 'cn-ci-' || ar.scheduled_service_id::text = ok.email_key AND ar.cancellation_notice_state = 'suppressed'))",
      ).catch(() => {});
      }

      // Apply outstanding caller intent to plain 'pending' markers BEFORE
      // ungated settlement (codex r9, ungated by r17): the route's own
      // tokenless claim writes plain pending — if the route then dies, the
      // outbox is the only record of the operator's notify intent and must
      // upgrade the marker, not be consumed past it. This runs OUTSIDE the
      // gate check: settlement below intentionally settles residue with the
      // gate off, and durable intent recorded while the gate was on must be
      // applied before that residue is judged — otherwise a gate-off sweep
      // could terminally suppress an operator-requested notice.
      try {
        // Outbox-backed rows classify BOTH ways (codex r15): survivor-free
        // upgrades to pending_notify; a live-sibling survivor stamps
        // terminal suppressed so evidence-gated settlement cannot text
        // against the surviving visit.
        await db.raw(
          "UPDATE appointment_reminders SET cancellation_notice_state = CASE WHEN NOT EXISTS (SELECT 1 FROM appointment_reminders sib3 WHERE sib3.customer_id = appointment_reminders.customer_id AND sib3.appointment_time = appointment_reminders.appointment_time AND sib3.cancelled = false AND sib3.id <> appointment_reminders.id) THEN 'pending_notify' ELSE 'suppressed' END, updated_at = now() WHERE cancellation_notice_state = 'pending' AND EXISTS (SELECT 1 FROM ops_email_send_state ok WHERE ok.email_key = 'cn-ci-' || appointment_reminders.scheduled_service_id::text AND ok.last_sent_at >= now() - interval '72 hours')",
        );
      } catch (upgradeErr) {
        // Un-applied caller intent must never reach settlement (codex
        // r14): a plain-pending row with no delivery evidence would be
        // terminally suppressed and its outbox consumed. Abort this tick;
        // everything retries in 15 minutes.
        logger.warn(`[appt-remind] outbox upgrade failed — aborting sweep tick: ${upgradeErr.message}`);
        return;
      }

      // Repair pass (codex r22): a restoration whose in-trx marker clear
      // failed leaves a stale terminal marker on a LIVE visit — shed it
      // here so a later real cancellation notices normally.
      // Driven from the LIVE-visit population (codex r35 perf, r46
      // durability): a marker on a LIVE visit is the anomaly this
      // repairs, and that population is small and bounded — unlike the
      // ever-growing terminal-marker history (r35) or a time-bounded
      // restoration window that a >7-day cron outage would out-age (r46).
      // Eligibility persists until the stale marker is actually cleared.
      // Marker clear and outbox void commit or fail TOGETHER (codex
      // r10/r14): clearing the marker while the void transiently fails
      // would let a restore-and-recancel inherit the old cycle's intent.
      await db.transaction(async (rtrx) => {
        await rtrx('appointment_reminders')
          .whereNotNull('cancellation_notice_state')
          .whereIn('scheduled_service_id', function liveVisits() {
            this.select('ss.id').from('scheduled_services as ss')
              .whereIn('ss.status', ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site']);
          })
          .update({ cancellation_notice_at: null, cancellation_notice_state: null, updated_at: new Date() });
        await rtrx.raw(
          "DELETE FROM ops_email_send_state ok WHERE ok.email_key LIKE 'cn-ci-%' AND EXISTS (SELECT 1 FROM scheduled_services ss WHERE 'cn-ci-' || ss.id::text = ok.email_key AND ss.status IN ('pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'))",
        );
      });

      // Age-out runs regardless of the gate (r12): a notice older than
      // 72h is moot — texting "your visit was cancelled" days later is
      // worse than silence, and claims born before a gate-off period must
      // not replay on re-enable. Released to NULL so a future re-cancel
      // evaluates fresh.
      await db('appointment_reminders')
        .whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
        // Aged from the ORIGINAL cancellation (r14): reclaims refresh the
        // claim token every 15 minutes during an outage, so the token
        // cannot carry the age — the visit's latest real cancelled
        // transition can. Terminal 'suppressed' (r13): releasing let a
        // cancelled→cancelled retry text a days-old cancellation.
        .whereRaw(
          "COALESCE((SELECT MAX(h.transitioned_at) FROM job_status_history h WHERE h.job_id = appointment_reminders.scheduled_service_id AND h.to_status = 'cancelled' AND h.from_status <> 'cancelled'), (SELECT ss2.updated_at FROM scheduled_services ss2 WHERE ss2.id = appointment_reminders.scheduled_service_id), appointment_reminders.cancellation_notice_at) < now() - interval '72 hours'",
        )
        .update({ cancellation_notice_state: 'suppressed', updated_at: new Date() });
      // No gate check for SETTLEMENT (codex r20): pending leases only
      // exist if the gate was on when the cancel committed — settling
      // that residue (send or close) is finishing owed work, not new
      // feature activity. Claim CREATION remains gated in job-status.
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
          .where({ purpose: 'appointment_cancellation' })
          .whereNotNull('sent_at')
          .whereRaw("(provider_message_id ~ '^(SM|MM)' OR channel = 'email')")
          .where(function linkedOrGroupEra() {
            this.whereIn('appointment_id', serviceIds)
              // A restored representative leaves the pending group but its
              // acceptance still proves THIS group's send (codex r18):
              // same customer, accepted at/after the group claim.
              .orWhere(function customerScoped() {
                // Restored-representative audits only (codex r19): the
                // visit must be LIVE again — an audit linked to a
                // still-cancelled other visit is that visit's own notice,
                // not this group's.
                this.whereRaw(
                  "appointment_id IN (SELECT ss3.id::text FROM scheduled_services ss3 WHERE ss3.customer_id = ? AND ss3.status <> 'cancelled')",
                  [seed.customer_id],
                ).where('sent_at', '>=', seed.claim_at)
                  // 30-min bound (r20): an unrelated cancel-then-restored
                  // visit's own notice outside this group's send window
                  // must not reconcile it. Residual overlap within the
                  // window is accepted and documented.
                  .whereRaw("sent_at <= ?::timestamptz + interval '30 minutes'", [seed.claim_at]);
              });
          })
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
        let delivered = Boolean(await db('messaging_audit_log')
          .whereIn('appointment_id', serviceIds)
          .whereIn('purpose', ['appointment_reminder_72h', 'appointment_reminder_24h', 'appointment_confirmation'])
          .whereNotNull('sent_at')
          .whereRaw("(provider_message_id ~ '^(SM|MM)' OR channel = 'email')")
          .first('id'));
        if (!delivered) {
          // Appointment EMAILS audit into customer_interactions (r23).
          delivered = Boolean(await db('customer_interactions')
            .where({ interaction_type: 'email_outbound' })
            .whereRaw("metadata->>'scheduled_service_id' = ANY(?)", [serviceIds])
            .whereRaw("metadata->>'status' = 'sent'")
            .first('id'));
        }
        if (!delivered) {
          // Legacy-grace (r15): pre-epoch rows have unlinked audits.
          delivered = Boolean(await db('appointment_reminders')
            .whereIn('id', reminderIds)
            // Self-calibrating epoch (codex r27): "legacy" = created
            // before the first appointment-linked audit row ever written,
            // so a late deploy or rolling old pod cannot misclassify.
            .whereRaw("created_at < (SELECT COALESCE((SELECT last_sent_at FROM ops_email_send_state WHERE email_key = 'cancel-notice-linkage-epoch'), 'infinity'))")
            .where(function announced() {
              this.where('reminder_72h_sent', true)
                .orWhere('reminder_24h_sent', true)
                .orWhere('confirmation_sent', true);
            })
            // Flags are bookkeeping (registration pre-sets confirmation_sent;
            // closed windows mark sent without sending — codex r29): also
            // require a REAL customer-level reminder/confirmation SMS
            // (genuine SID), the best obtainable evidence for
            // pre-linkage rows.
            .whereRaw(`EXISTS (
              SELECT 1 FROM sms_log lsl
              WHERE lsl.customer_id = appointment_reminders.customer_id
                AND lsl.direction = 'outbound'
                AND lsl.twilio_sid ~ '^(SM|MM)'
                -- Per-FLAG correlation (codex r35): a confirmation flag is
                -- only announced by a confirmation SMS near registration
                -- (real bookings text within minutes; seeded rows never
                -- do), a reminder flag only by a reminder SMS inside the
                -- visit's own reminder window — an overlapping visit's
                -- SMS months apart can no longer be borrowed.
                AND (
                  (appointment_reminders.confirmation_sent = true
                    AND lsl.message_type = 'confirmation'
                    AND lsl.created_at BETWEEN appointment_reminders.created_at - interval '5 minutes'
                                           AND appointment_reminders.created_at + interval '1 hour')
                  OR ((appointment_reminders.reminder_72h_sent = true OR appointment_reminders.reminder_24h_sent = true)
                    AND lsl.message_type IN ('reminder_72h', 'appointment_reminder')
                    AND lsl.created_at BETWEEN appointment_reminders.appointment_time - interval '80 hours'
                                           AND appointment_reminders.appointment_time)
                )
            )`)
            .first('id'));
        }
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
        // Restored (live) targets keep their re-armed reminders (r16).
        .whereRaw("EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.status = 'cancelled')")
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
            // Shared monotonic generator (r17): the sweep groups on THIS value —
      // an inline new Date() could collide across independent series.
      const seriesToken = require('./job-status').nextClaimTs();
      const priorGroupToken = options.claimToken instanceof Date ? options.claimToken : null;
      await db('appointment_reminders')
        .whereIn('scheduled_service_id', ids)
        // Still-cancelled applies to EVERY adoption branch (codex r39) —
        // prior-token and stale-lease rows restored mid-flight must not
        // be stamped (especially not terminally suppressed).
        .whereRaw("EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.status = 'cancelled')")
        .where(function claimable() {
          // Adopt unclaimed rows, rows under OUR provided group token
          // (route trx claim / sweep reclaim), and stale leases — never a
          // fresh foreign single-visit lease mid-send (codex r13): those
          // must stay visible to the handoff fence.
          this.where(function unclaimedStillCancelled() {
            this.whereNull('cancellation_notice_at')
              // Restoration deliberately cleared this marker — a live
              // target must not be re-claimed by the series sender (r14).
              .whereRaw("EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.status = 'cancelled')");
          });
          if (priorGroupToken) this.orWhere('cancellation_notice_at', priorGroupToken);
          this.orWhere(function staleLease() {
            this.whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
              .where('cancellation_notice_at', '<', db.raw("now() - interval '15 minutes'"));
          });
        })
        .update({
          cancellation_notice_at: seriesToken,
          cancellation_notice_state: sendNotification
            ? db.raw("CASE WHEN cancellation_notice_state = 'pending_notify' THEN 'pending_notify' ELSE 'pending' END")
            : 'suppressed',
          updated_at: seriesToken,
        });
      // Fenced (token) bulk finalize: sent on acceptance, released for
      // retry otherwise. Rows another owner reclaimed are left alone.
      const finalizeSeriesClaims = async (accepted, { retryable = false } = {}) => {
        try {
          if (!accepted && retryable) {
            // Revert OUR pre-dispatch stamps to pending first (r22).
            await db('appointment_reminders')
              .whereIn('scheduled_service_id', ids)
              .where({ cancellation_notice_state: 'sent' })
              .where('cancellation_notice_at', seriesToken)
              .update({ cancellation_notice_state: 'pending', updated_at: new Date() });
            const notifyRowIds = seriesSendOutcome.notifyRowIds || [];
            if (notifyRowIds.length) {
              await db('appointment_reminders')
                .whereIn('id', notifyRowIds)
                .where({ cancellation_notice_state: 'pending' })
                .where('cancellation_notice_at', seriesToken)
                .update({ cancellation_notice_state: 'pending_notify', updated_at: new Date() });
            }
            // Keep the leases REGARDLESS of the hook gate (r14): a series
            // has no manual retry, so the sweep's ungated settlement is
            // the only recovery. But with cronJobs disabled NO sweep will
            // ever run (codex r42) — release to NULL instead so the
            // late-claim fallback recovers the obligation once cron
            // returns, rather than stranding pending leases forever.
            const { isEnabled: cronGate } = require('../config/feature-gates');
            if (!cronGate('cronJobs')) {
              // Plain 'pending' only (codex r43) — 'pending_notify' keeps
              // its lease so the caller-notify intent survives for the
              // sweep to settle without re-deriving delivery evidence.
              // AND only as a UNIT (codex r44): a mixed group (one
              // target's savepoint failed and was re-adopted plain) must
              // not split — released members would late-claim into a
              // second group and the customer would get two combined
              // texts. Any pending_notify sibling retains the whole group.
              await db('appointment_reminders')
                .whereIn('scheduled_service_id', ids)
                .where('cancellation_notice_state', 'pending')
                .where('cancellation_notice_at', seriesToken)
                .whereRaw("NOT EXISTS (SELECT 1 FROM appointment_reminders sib WHERE sib.cancellation_notice_at = appointment_reminders.cancellation_notice_at AND sib.cancellation_notice_state = 'pending_notify')")
                .update({ cancellation_notice_at: null, cancellation_notice_state: null, updated_at: new Date() });
            }
            return;
          }
          await db('appointment_reminders')
            .whereIn('scheduled_service_id', ids)
            // Includes the pre-dispatch 'sent' stamp under OUR token so a
            // definite failure reverts it (codex r21).
            .whereIn('cancellation_notice_state', ['pending', 'pending_notify', 'sent'])
            .where('cancellation_notice_at', seriesToken)
            // Still-cancelled (codex r40), same as the singleton finalize.
            .whereRaw("EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.status = 'cancelled')")
            .update(accepted
              ? { cancellation_notice_state: 'sent', updated_at: new Date() }
              // Terminal, same as the singleton finalize (codex r39) —
              // released rows would be re-minted by the late-claim
              // fallback and re-attempted indefinitely.
              : { cancellation_notice_state: 'suppressed', updated_at: new Date() });
        } catch (finalizeErr) {
          logger.warn(`[appt-remind] series notice-claim finalize failed: ${finalizeErr.message}`);
        }
      };
      if (!sendNotification) {
        logger.info(`[appt-remind] Series cancellation notices suppressed for ${ids.length} appointment(s)`);
        return { cancelledCount: ids.length };
      }

      const seriesSendOutcome = {};
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
        Object.assign(seriesSendOutcome, {});
        const sendOutcome = seriesSendOutcome;
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
              // Includes our own pre-dispatch 'sent' stamps so contact
              // fanout continues (codex r25).
              .whereIn('cancellation_notice_state', ['pending', 'pending_notify', 'sent'])
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
            if (!own || foreign) {
              return { ok: false, code: 'notice_claim_lost', reason: 'series notice lease was reclaimed or partially adopted' };
            }
            // A restored target's claim columns are fully NULL and its
            // visit is live — the combined copy would be wrong (r17).
            const restored = await db('scheduled_services')
              .whereIn('id', ids)
              .whereNot('status', 'cancelled')
              .first('id');
            if (restored) {
              return { ok: false, code: 'appointment_restored', reason: 'a series target is live again' };
            }
            // Pre-stamp notify set (codex r23): the retryable revert must
            // restore pending_notify per row.
            // Captured ONCE (codex r27): the second contact's check runs
            // after the stamp and would overwrite the set with [].
            if (!Array.isArray(seriesSendOutcome.notifyRowIds)) {
              const notifyRows = await db('appointment_reminders')
                .whereIn('scheduled_service_id', ids)
                .where({ cancellation_notice_state: 'pending_notify' })
                .where('cancellation_notice_at', seriesToken)
                .select('id');
              seriesSendOutcome.notifyRowIds = notifyRows.map((r) => r.id);
            }
            // Durable pre-dispatch stamp for the group (codex r21/r22):
            // accepts our own prior stamp; zero rows = cleared mid-flight.
            const stamped = await db('appointment_reminders')
              .whereIn('scheduled_service_id', ids)
              .whereIn('cancellation_notice_state', ['pending', 'pending_notify', 'sent'])
              .where('cancellation_notice_at', seriesToken)
              .update({ cancellation_notice_state: 'sent', updated_at: new Date() });
            if (!stamped) {
              return { ok: false, code: 'notice_claim_lost', reason: 'group claims cleared before dispatch' };
            }
            // Post-stamp restored re-check (codex r23): a restoration
            // landing between the status scan and the stamp cleared one
            // target's claim without failing the multi-row stamp.
            const restoredLate = await db('scheduled_services')
              .whereIn('id', ids)
              .whereNot('status', 'cancelled')
              .first('id');
            if (restoredLate) {
              return { ok: false, code: 'appointment_restored', reason: 'a series target went live after the stamp' };
            }
            seriesSendOutcome.dispatchStarted = true;
            return { ok: true };
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
        // Thrown lookup/pref/validation errors are retryable; a
        // dispatch-uncertain throw finalizes sent (r16) — silence beats a
        // double combined text.
        if (seriesSendOutcome
          && (seriesSendOutcome.dispatchUncertain === true || seriesSendOutcome.providerAccepted === true)) {
          await finalizeSeriesClaims(true);
        } else {
          await finalizeSeriesClaims(false, { retryable: true });
        }
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
  acceptedMixServiceName,
  estimateBackedServiceName,
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
