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
const { getAppointmentContacts } = require('./customer-contact');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { TZ, parseETDateTime, formatETDay, formatETDate, formatETTime, etDateString, addETDays } = require('../utils/datetime-et');

/**
 * Render an SMS body from sms_templates, falling back to the provided default
 * if the template is missing/disabled. Keeps brand voice editable from the
 * Communications → SMS Templates admin page.
 */
async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return fallback;
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
      logger.warn(`[appt-remind] Twilio Lookup failed for ${phone}: ${lookupErr.message} — sending anyway`);
      return false; // Don't block on lookup failures
    }
  } catch (err) {
    logger.warn(`[appt-remind] Landline check error: ${err.message} — sending anyway`);
    return false;
  }
}

// ── Send SMS with landline guard ──

async function safeSend(customerId, phone, body, messageType = 'appointment_reminder', purpose = 'appointment', identityTrustLevel = 'phone_matches_customer') {
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
    const identityTrustLevel = contact.role === 'service_contact'
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
      // Check if already registered
      const existing = await db('appointment_reminders')
        .where({ scheduled_service_id: scheduledServiceId })
        .first();

      if (existing) {
        logger.info(`[appt-remind] Already registered: ${scheduledServiceId}`);
        return existing;
      }

      const apptTime = parseETDateTime(appointmentTime);
      if (isNaN(apptTime.getTime())) {
        logger.error(`[appt-remind] Invalid appointment time: ${appointmentTime}`);
        return null;
      }

      const sendConfirmation = typeof options.sendConfirmation === 'boolean'
        ? options.sendConfirmation
        : (source === 'booking_new' || source === 'admin_manual');

      // Resolve once and persist — cron, reschedule, and cancel all read this
      // column back, so multi-service formatting inherits without extra work.
      const serviceLabel = await buildServiceLabel(scheduledServiceId, serviceType);

      const [record] = await db('appointment_reminders').insert({
        scheduled_service_id: scheduledServiceId,
        customer_id: customerId,
        appointment_time: apptTime,
        service_type: serviceLabel,
        source,
        confirmation_sent: false,
      }).returning('*');

      logger.info(`[appt-remind] Registered: ${scheduledServiceId} (source: ${source})`);

      // Send confirmation SMS for booking_new / admin_manual
      if (sendConfirmation) {
        try {
          const prefs = await getReminderPrefs(customerId);
          if (!prefs.appointmentConfirmation) {
            await db('appointment_reminders')
              .where({ id: record.id })
              .update({ confirmation_sent: true, confirmation_sent_at: new Date() });
            logger.info(`[appt-remind] Confirmation skipped by preference for customer ${customerId}`);
            return record;
          }
          const { customer, techName } = await getCustomerAndTech(customerId, scheduledServiceId);
          if (customer) {
            const day = formatDay(apptTime);
            const date = formatDate(apptTime);
            const time = formatTime(apptTime);

            const sent = await safeSendAppointment(customer, prefs.raw, async (contact) => {
              const firstName = contact.name || customer.first_name || 'there';
              return renderTemplate(
                'appointment_confirmation',
                { first_name: firstName, service_type: serviceLabel, date, time, day },
                `Hello ${firstName}! Your ${serviceLabel} appointment has been successfully scheduled for ${date} at ${time}.\n\nPlease reply to this message if you need any assistance.`,
              );
            }, 'confirmation', 'appointment_confirmation');

            if (sent) {
              await db('appointment_reminders')
                .where({ id: record.id })
                .update({ confirmation_sent: true, confirmation_sent_at: new Date() });
              logger.info(`[appt-remind] Confirmation sent for customer ${customerId} for ${serviceLabel}`);
            } else {
              // Mark as sent even if landline — don't retry
              await db('appointment_reminders')
                .where({ id: record.id })
                .update({ confirmation_sent: true, confirmation_sent_at: new Date() });
            }
          }
        } catch (err) {
          logger.error(`[appt-remind] Confirmation SMS failed: ${err.message}`);
          // Still mark confirmation_sent so reminders can proceed
          await db('appointment_reminders')
            .where({ id: record.id })
            .update({ confirmation_sent: true, confirmation_sent_at: new Date() });
        }
      } else {
        // non-confirmation sources — mark confirmation as "sent" (not applicable)
        await db('appointment_reminders')
          .where({ id: record.id })
          .update({ confirmation_sent: true, confirmation_sent_at: new Date() });
      }

      return record;
    } catch (err) {
      logger.error(`[appt-remind] registerAppointment failed: ${err.message}`);
      return null;
    }
  },

  /**
   * Check and send 72h and 24h reminders.
   * Called by cron every 15 minutes.
   */
  async checkAndSendReminders() {
    const results = { sent72h: 0, sent24h: 0, skipped: 0, errors: 0 };
    const now = new Date();

    try {
      const reminders = await db('appointment_reminders')
        .where({ cancelled: false, confirmation_sent: true })
        .where(function () {
          this.where({ reminder_72h_sent: false }).orWhere({ reminder_24h_sent: false });
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
                `Hello ${firstName}! This is a reminder from Waves that your ${serviceLabel} appointment is scheduled for ${day} at ${time}.\n\nExpect your technician to arrive within a two-hour window of your scheduled start time. Need to reschedule? Log into your Waves Customer Portal at portal.wavespestcontrol.com.\n\nIf you have any questions or need assistance, simply reply to this message.`,
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

          // Skip if booked less than 24h before appointment
          if (hoursFromBookingToAppt < 24) {
            logger.info(`[appt-remind] Skipping 24h reminder for ${r.scheduled_service_id} — booked < 24h before`);
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
                `Hello ${firstName}! This is a reminder from Waves that your ${serviceLabel} appointment is scheduled for tomorrow at ${time}.\n\nExpect your technician to arrive within a two-hour window of your scheduled start time. Your tech will text you when they are 15 minutes out.\n\nIf you have any questions or need assistance, simply reply to this message.`,
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

      // Reset reminder flags
      await db('appointment_reminders')
        .where({ id: record.id })
        .update({
          appointment_time: newApptTime,
          reminder_72h_sent: false,
          reminder_72h_sent_at: null,
          reminder_24h_sent: false,
          reminder_24h_sent_at: null,
          updated_at: new Date(),
        });

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
        await safeSendAppointment(customer, prefs || {}, async (contact) => {
          const firstName = contact.name || customer?.first_name || 'there';
          return renderTemplate(
            'appointment_rescheduled',
            { first_name: firstName, service_type: serviceLabel, day, date, time },
            `Hello ${firstName}! Your ${serviceLabel} with Waves has been rescheduled to ${day}, ${date} at ${time}.\n\n` +
              `Need to change it again? Log into your Waves Customer Portal at portal.wavespestcontrol.com.\n\n` +
              `Questions or requests? Reply to this message.`,
          );
        }, 'appointment_rescheduled', 'appointment_confirmation');
        logger.info(`[appt-remind] Reschedule notice sent for customer ${record.customer_id} - ${record.service_type} -> ${day} ${date}`);
      }

      return record;
    } catch (err) {
      logger.error(`[appt-remind] handleReschedule failed: ${err.message}`);
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
          return renderTemplate(
            'appointment_cancelled',
            { first_name: firstName, service_type: serviceLabel, day, date },
            `Hello ${firstName}! Your ${serviceLabel} with Waves scheduled for ${day}, ${date} has been cancelled.\n\n` +
              `Want to reschedule? Reply to this message and we'll get you back on the calendar.`,
          );
        }, 'appointment_cancelled', 'appointment_cancellation');
        logger.info(`[appt-remind] Cancellation notice sent for customer ${record.customer_id} - ${record.service_type}`);
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
            `Hello ${firstName}! Your Waves ${scopeText} for ${serviceLabel} has been cancelled.\n\n` +
              `Want to reschedule? Reply to this message and we'll get you back on the calendar.`,
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

module.exports = AppointmentReminders;
