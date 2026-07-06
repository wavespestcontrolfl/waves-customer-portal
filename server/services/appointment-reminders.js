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
const { getAppointmentContacts, isServiceContactRole } = require('./customer-contact');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { TZ, parseETDateTime, formatETDay, formatETDate, formatETTime, etDateString, addETDays } = require('../utils/datetime-et');
const AppointmentEmail = require('./appointment-email');
const NotificationService = require('./notification-service');
const { buildRescheduleLink } = require('./reschedule-link');

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

// Raise a single admin alert when an appointment notice can reach the customer
// by neither SMS nor email, so a human can call them or add an email. Deduped to
// one bell entry per customer+occurrence per 24h.
async function alertNoReachableChannel({ customerId, kind, scheduledServiceId = null }) {
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
    const name = customer
      ? ([customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || customer.company_name || 'Customer')
      : 'Customer';
    const label = FALLBACK_KIND_LABEL[kind] || 'appointment notice';
    await NotificationService.notifyAdmin(
      'alert',
      'Appointment notice undeliverable — no text or email',
      `${name}: the ${label} could not be delivered by text (landline / no mobile) and there is no email on file. Call the customer or add an email address.`,
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
    await alertNoReachableChannel({ customerId, kind, scheduledServiceId });
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

  if (ch === 'email') {
    const res = await sendAppointmentNoticeEmail(emailArgs);
    if (res?.ok) return true;
    // No usable email (none on file / suppressed) — reach them by text instead.
    logger.info(`[appt-remind] ${kind} email channel unavailable for ${customerId} (${res?.reason || res?.error || 'unknown'}) — falling back to SMS`);
    const smsOk = await runSms();
    if (!smsOk) await alertNoReachableChannel({ customerId, kind, scheduledServiceId });
    return smsOk;
  }

  if (ch === 'both') {
    const smsOk = await runSms();
    const emailRes = await sendAppointmentNoticeEmail(emailArgs);
    const emailOk = !!emailRes?.ok;
    // Neither channel reached the customer — raise the same human-follow-up
    // alert the SMS-only path uses.
    if (!smsOk && !emailOk) await alertNoReachableChannel({ customerId, kind, scheduledServiceId });
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
async function scheduledServiceApptTime(scheduledServiceId) {
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
  const rows = await conn('appointment_reminders as ar')
    .leftJoin('scheduled_services as ss', 'ss.id', 'ar.scheduled_service_id')
    .where({ 'ar.customer_id': customerId, 'ar.appointment_time': apptTime, 'ar.cancelled': false })
    .orderBy('ar.created_at', 'asc')
    .select(conn.raw('coalesce(ss.service_type, ar.service_type) as label'));

  const parts = [];
  for (const raw of [...rows.map((r) => r.label), nextLabel]) {
    const label = String(raw || '').trim();
    if (!label) continue;
    const lower = label.toLowerCase();
    // Same containment semantics the pairwise merge had: skip a candidate an
    // existing part already covers; a candidate that covers existing parts
    // replaces them.
    if (parts.some((part) => part.toLowerCase().includes(lower))) continue;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (lower.includes(parts[i].toLowerCase())) parts.splice(i, 1);
    }
    parts.push(label);
  }
  if (parts.length === 0) return String(nextLabel || '').trim();
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

async function safeSend(customerId, phone, body, messageType = 'appointment_reminder', purpose = 'appointment', identityTrustLevel = 'phone_matches_customer', metaExtra = {}) {
  if (!body) {
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
  });
  if (result.blocked || result.sent === false) {
    logger.warn(`[appt-remind] SMS blocked for customer ${customerId}: ${result.code || 'unknown'} ${result.reason || ''}`);
    return false;
  }
  return true;
}

async function safeSendAppointment(customer, prefs, renderBody, messageType = 'appointment_reminder', purpose = 'appointment', metaExtra = {}) {
  const contacts = getAppointmentContacts(customer, prefs);
  if (!contacts.length) {
    logger.warn(`[appt-remind] No appointment contact for customer ${customer?.id || 'unknown'}, skipping SMS`);
    return false;
  }

  let sentAny = false;
  for (const contact of contacts) {
    const body = typeof renderBody === 'function' ? await renderBody(contact) : renderBody;
    const identityTrustLevel = isServiceContactRole(contact.role)
      ? 'service_contact_authorized'
      : 'phone_matches_customer';
    const sent = await safeSend(customer.id, contact.phone, body, messageType, purpose, identityTrustLevel, metaExtra);
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

async function getReminderPrefs(customerId) {
  const prefs = await db('notification_prefs').where({ customer_id: customerId }).first().catch(() => null);

  // Delivery channel is an account-level "how to reach me" preference, saved on
  // the account owner's (primary profile's) row in the portal. Reminders load
  // prefs by each appointment's service-property customer id, so a secondary
  // property would otherwise miss the channel choice and default to SMS.
  // Resolve it from the account's primary customer profile. (customers.account_id
  // references customer_accounts.id, NOT a customers.id — so look up the primary
  // profile rather than reading prefs by account_id directly.)
  let channelPrefs = prefs;
  const customer = await db('customers').where({ id: customerId }).first('account_id', 'is_primary_profile').catch(() => null);
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
          const firstName = contact.name || customer.first_name || 'there';
          return renderTemplate(
            'appointment_confirmation',
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

// ══════════════════════════════════════════════════════════════
// MAIN SERVICE
// ══════════════════════════════════════════════════════════════
const AppointmentReminders = {

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
  async registerVisitReminderInTx(conn, { scheduledServiceId, customerId, appointmentTime, serviceType, source }) {
    if (!conn || !scheduledServiceId || !customerId) return null;
    const apptTime = parseETDateTime(appointmentTime);
    if (isNaN(apptTime.getTime())) return null;
    const now = new Date();
    const serviceLabel = smsServiceLabelStored(serviceType) || serviceType || null;
    const reminderSource = source || 'system_seed';

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
    const sameAppointment = await conn('appointment_reminders')
      .where({ customer_id: customerId, appointment_time: apptTime, cancelled: false })
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

        const sameAppointment = await trx('appointment_reminders')
          .where({ customer_id: customerId, appointment_time: apptTime, cancelled: false })
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
        // non-confirmation sources — mark confirmation as "sent" (not applicable)
        await db('appointment_reminders')
          .where({ id: record.id })
          .update({ confirmation_sent: true, confirmation_sent_at: new Date() });
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
   * Check and send 72h and 24h reminders.
   * Called by cron every 15 minutes.
   */
  async checkAndSendReminders() {
    const results = { sent72h: 0, sent24h: 0, skipped: 0, errors: 0 };
    const now = new Date();

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
        .where({ cancelled: false, confirmation_sent: false })
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
            logger.info(`[appt-remind] Skipping 72h reminder for ${r.scheduled_service_id} — disabled by customer preference`);
            results.skipped++;
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
            await deliverAppointmentNotice({
              channel: channel72,
              kind: '72h',
              customerId: r.customer_id,
              scheduledServiceId: r.scheduled_service_id,
              apptTime,
              serviceLabel,
              rescheduleUrl: reschedule.url,
              smsAttempt: () => safeSendAppointment(customer, prefs.raw, async (contact) => {
                const firstName = contact.name || customer?.first_name || 'there';
                return renderTemplate(
                  'reminder_72h',
                  { first_name: firstName, service_type: serviceLabel, day, date, time, reschedule_line: reschedule.line },
                  { workflow: 'appointment_reminder_72h', entity_type: 'scheduled_service', entity_id: r.scheduled_service_id },
                );
              }, 'reminder_72h', 'appointment_reminder_72h', { scheduled_service_id: r.scheduled_service_id }),
            });

            await db('appointment_reminders')
              .where({ id: r.id })
              .update({ reminder_72h_sent: true, reminder_72h_sent_at: new Date() });

            results.sent72h++;
            logger.info(`[appt-remind] 72h reminder sent for customer ${r.customer_id} - ${r.service_type}`);
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
            logger.info(`[appt-remind] Skipping 24h reminder for ${r.scheduled_service_id} — disabled by customer preference`);
            results.skipped++;
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
            await deliverAppointmentNotice({
              channel: channel24,
              kind: '24h',
              customerId: r.customer_id,
              scheduledServiceId: r.scheduled_service_id,
              apptTime,
              serviceLabel,
              rescheduleUrl: reschedule.url,
              smsAttempt: () => safeSendAppointment(customer, prefs.raw, async (contact) => {
                const firstName = contact.name || customer?.first_name || 'there';
                return renderTemplate(
                  'reminder_24h',
                  { first_name: firstName, service_type: serviceLabel, time, reschedule_line: reschedule.line },
                  { workflow: 'appointment_reminder_24h', entity_type: 'scheduled_service', entity_id: r.scheduled_service_id },
                );
              }, 'appointment_reminder', 'appointment_reminder_24h', { scheduled_service_id: r.scheduled_service_id }),
            });

            await db('appointment_reminders')
              .where({ id: r.id })
              .update({ reminder_24h_sent: true, reminder_24h_sent_at: new Date() });

            results.sent24h++;
            logger.info(`[appt-remind] 24h reminder sent for customer ${r.customer_id} - ${r.service_type}`);
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
      const r72 = resolveFlag(covered.alreadyInside72hWindow, record.reminder_72h_sent, record.reminder_72h_sent_at);
      const r24 = resolveFlag(covered.alreadyInside24hWindow, record.reminder_24h_sent, record.reminder_24h_sent_at);
      const rescheduleUpdate = {
        appointment_time: newApptTime,
        // Re-arm the row: a reschedule moves the appointment to a live new time,
        // so clear any cancelled flag a prior self-heal (or stale cancel path)
        // left behind, otherwise the rebooked visit would never be reminded. The
        // cron's live-status guard re-checks the service each run, so this can
        // never resurrect a reminder for a still-terminal service.
        cancelled: false,
        reminder_72h_sent: r72.sent,
        reminder_72h_sent_at: r72.at,
        reminder_24h_sent: r24.sent,
        reminder_24h_sent_at: r24.at,
        updated_at: now,
      };
      // A reschedule supersedes a still-pending creation confirmation — admin
      // saves defer the confirmation SMS off the request path, so a reschedule
      // landing in that window must claim the slot. This suppresses the deferred
      // sendConfirmation (which skips confirmation_sent rows) so the customer
      // gets the reschedule notice below, not a stale-time confirmation after it.
      if (!record.confirmation_sent) {
        rescheduleUpdate.confirmation_sent = true;
        rescheduleUpdate.confirmation_sent_at = new Date();
      }
      await db('appointment_reminders')
        .where({ id: record.id })
        .update(rescheduleUpdate);

      if (!sendNotification) {
        logger.info(`[appt-remind] Reschedule notice suppressed for ${scheduledServiceId}`);
        return record;
      }

      // Send reschedule notice
      const { customer } = await getCustomerAndTech(record.customer_id, scheduledServiceId);
      if (customer) {
        const prefs = await db('notification_prefs').where({ customer_id: record.customer_id }).first().catch(() => null);
        const day = formatDay(newApptTime);
        const date = formatDate(newApptTime);
        const time = formatTime(newApptTime);

        const serviceLabel = smsServiceLabelStored(record.service_type);
        const sent = await safeSendAppointment(customer, prefs || {}, async (contact) => {
          const firstName = contact.name || customer?.first_name || 'there';
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
        }, 'appointment_rescheduled', 'appointment_confirmation');
        if (sent) {
          await this.markRescheduleNoticeSent(scheduledServiceId);
          logger.info(`[appt-remind] Reschedule notice sent for customer ${record.customer_id}`);
        }
      }

      return record;
    } catch (err) {
      logger.error(`[appt-remind] handleReschedule failed: ${err.message}`);
      return null;
    }
  },

  async markRescheduleNoticeSent(scheduledServiceIds) {
    try {
      const ids = Array.isArray(scheduledServiceIds)
        ? [...new Set(scheduledServiceIds.filter(Boolean))]
        : [scheduledServiceIds].filter(Boolean);
      if (!ids.length) return { updated: 0 };

      const records = await db('appointment_reminders')
        .whereIn('scheduled_service_id', ids)
        .select('id', 'appointment_time');

      const now = new Date();
      let updated = 0;
      for (const record of records || []) {
        const { alreadyInside72hWindow, alreadyInside24hWindow } = reminderFlagsCoveredByNotice(record.appointment_time, now);
        await db('appointment_reminders')
          .where({ id: record.id })
          .update({
            reminder_72h_sent: alreadyInside72hWindow,
            reminder_72h_sent_at: alreadyInside72hWindow ? new Date() : null,
            reminder_24h_sent: alreadyInside24hWindow,
            reminder_24h_sent_at: alreadyInside24hWindow ? new Date() : null,
            updated_at: new Date(),
          });
        updated++;
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
    try {
      const sendNotification = options.sendNotification !== false;
      const record = await db('appointment_reminders')
        .where({ scheduled_service_id: scheduledServiceId })
        .first();

      if (!record) {
        logger.info(`[appt-remind] Cancellation: no reminder record for ${scheduledServiceId}`);
        return null;
      }

      await db('appointment_reminders')
        .where({ id: record.id })
        .update({ cancelled: true, updated_at: new Date() });

      if (!sendNotification) {
        logger.info(`[appt-remind] Cancellation notice suppressed for ${scheduledServiceId}`);
        return record;
      }

      // Send cancellation notice
      const { customer } = await getCustomerAndTech(record.customer_id, scheduledServiceId);
      if (customer) {
        const prefs = await db('notification_prefs').where({ customer_id: record.customer_id }).first().catch(() => null);
        const apptTime = new Date(record.appointment_time);
        const day = formatDay(apptTime);
        const date = formatDate(apptTime);

        const serviceLabel = smsServiceLabelStored(record.service_type);
        await safeSendAppointment(customer, prefs || {}, async (contact) => {
          const firstName = contact.name || customer?.first_name || 'there';
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
        }, 'appointment_cancelled', 'appointment_cancellation');
        logger.info(`[appt-remind] Cancellation notice sent for customer ${record.customer_id}`);
      }

      return record;
    } catch (err) {
      logger.error(`[appt-remind] handleCancellation failed: ${err.message}`);
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

      const prefs = await db('notification_prefs').where({ customer_id: svc.customer_id }).first().catch(() => null);

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
        const customerFirst = contact.name || customer?.first_name || 'there';
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
  async handleSeriesCancellation(scheduledServiceIds, representativeScheduledServiceId, options = {}) {
    try {
      const ids = [...new Set((scheduledServiceIds || []).filter(Boolean))];
      if (!ids.length) return null;

      await db('appointment_reminders')
        .whereIn('scheduled_service_id', ids)
        .update({ cancelled: true, updated_at: new Date() });

      const sendNotification = options.sendNotification !== false;
      if (!sendNotification) {
        logger.info(`[appt-remind] Series cancellation notices suppressed for ${ids.length} appointment(s)`);
        return { cancelledCount: ids.length };
      }

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
        return { cancelledCount: ids.length };
      }

      const { customer } = await getCustomerAndTech(record.customer_id, representativeScheduledServiceId || record.scheduled_service_id);
      if (customer) {
        const prefs = await db('notification_prefs').where({ customer_id: record.customer_id }).first().catch(() => null);
        const scopeText = options.scope === 'series' ? 'recurring series' : 'future recurring appointments';
        const serviceLabel = smsServiceLabelStored(options.serviceType || record.service_type);
        await safeSendAppointment(customer, prefs || {}, async (contact) => {
          const firstName = contact.name || customer?.first_name || 'there';
          return renderTemplate(
            'appointment_series_cancelled',
            { first_name: firstName, service_type: serviceLabel, scope: scopeText },
            { workflow: 'appointment_series_cancelled', entity_type: 'scheduled_service', entity_id: representativeScheduledServiceId || record.scheduled_service_id },
          );
        }, 'appointment_series_cancelled', 'appointment_cancellation');
        logger.info(`[appt-remind] Series cancellation notice sent for customer ${record.customer_id} - ${ids.length} appointment(s)`);
      }

      return { ...record, cancelledCount: ids.length };
    } catch (err) {
      logger.error(`[appt-remind] handleSeriesCancellation failed: ${err.message}`);
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

module.exports = AppointmentReminders;
