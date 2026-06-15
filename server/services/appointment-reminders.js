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
const { getAppointmentContacts, isServiceContactRole } = require('./customer-contact');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { TZ, parseETDateTime, formatETDay, formatETDate, formatETTime, etDateString, addETDays } = require('../utils/datetime-et');

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

function mergeServiceLabels(existingLabel, nextLabel) {
  const existing = smsServiceLabelStored(existingLabel);
  const next = smsServiceLabelStored(nextLabel);
  if (!existing || existing === 'service') return next || 'service';
  if (!next || next === 'service') return existing;

  const existingLower = existing.toLowerCase();
  const nextLower = next.toLowerCase();
  if (existingLower.includes(nextLower)) return existing;
  if (nextLower.includes(existingLower)) return next;

  return /(?:\s&\s|,\s)/.test(existing)
    ? `${existing}, and ${next}`
    : `${existing} & ${next}`;
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

    // customer.line_type is a customer-primary-phone cache. Service-contact
    // phones must not poison or inherit it.
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

      // Cache only for the customer's primary phone. Service-contact numbers
      // can differ per property and need a phone-specific cache before reuse.
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

async function safeSend(customerId, phone, body, messageType = 'appointment_reminder', purpose = 'appointment', identityTrustLevel = 'phone_matches_customer') {
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
    metadata: { original_message_type: messageType },
  });
  if (result.blocked || result.sent === false) {
    logger.warn(`[appt-remind] SMS blocked for customer ${customerId}: ${result.code || 'unknown'} ${result.reason || ''}`);
    return false;
  }
  return true;
}

async function safeSendAppointment(customer, prefs, renderBody, messageType = 'appointment_reminder', purpose = 'appointment') {
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
    const sent = await safeSend(customer.id, contact.phone, body, messageType, purpose, identityTrustLevel);
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
  return {
    raw: prefs || {},
    smsEnabled: prefs?.sms_enabled !== false,
    appointmentConfirmation: prefs?.appointment_confirmation !== false,
    serviceReminder72h: prefs?.service_reminder_72h !== false,
    serviceReminder24h: prefs?.service_reminder_24h !== false,
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

      const sent = await safeSendAppointment(customer, prefs.raw, async (contact) => {
        const firstName = contact.name || customer.first_name || 'there';
        return renderTemplate(
          'appointment_confirmation',
          { first_name: firstName, service_type: serviceLabel, date, time, day },
          { workflow: 'appointment_confirmation', entity_type: 'scheduled_service', entity_id: scheduledServiceId },
        );
      }, 'confirmation', 'appointment_confirmation');

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
          const mergedServiceLabel = mergeServiceLabels(sameAppointment.service_type, serviceLabel);
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
            service_type: mergedServiceLabel,
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
          if (!prefs.smsEnabled || !prefs.serviceReminder72h) {
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
            await safeSendAppointment(customer, prefs.raw, async (contact) => {
              const firstName = contact.name || customer?.first_name || 'there';
              return renderTemplate(
                'reminder_72h',
                { first_name: firstName, service_type: serviceLabel, day, date, time },
                { workflow: 'appointment_reminder_72h', entity_type: 'scheduled_service', entity_id: r.scheduled_service_id },
              );
            }, 'reminder_72h', 'appointment_reminder_72h');

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
          if (!prefs.smsEnabled || !prefs.serviceReminder24h) {
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
            await safeSendAppointment(customer, prefs.raw, async (contact) => {
              const firstName = contact.name || customer?.first_name || 'there';
              return renderTemplate(
                'reminder_24h',
                { first_name: firstName, service_type: serviceLabel, time },
                { workflow: 'appointment_reminder_24h', entity_type: 'scheduled_service', entity_id: r.scheduled_service_id },
              );
            }, 'appointment_reminder', 'appointment_reminder_24h');

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

AppointmentReminders._test = {
  maskPhone,
  sanitizeLookupError,
};

module.exports = AppointmentReminders;
