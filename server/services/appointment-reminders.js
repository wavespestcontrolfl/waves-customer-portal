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
const { getServiceContact } = require('./customer-contact');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { TZ, parseETDateTime, formatETDay, formatETDate, formatETTime } = require('../utils/datetime-et');

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

    // Check cached line_type
    if (customer.line_type) {
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

      // Cache on customer record
      await db('customers').where({ id: customerId }).update({ line_type: lineType });

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

async function safeSend(customerId, phone, body, messageType = 'appointment_reminder') {
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
    purpose: 'appointment',
    customerId,
    identityTrustLevel: 'phone_matches_customer',
    metadata: { original_message_type: messageType },
  });
  if (result.blocked || result.sent === false) {
    logger.warn(`[appt-remind] SMS blocked for customer ${customerId}: ${result.code || 'unknown'} ${result.reason || ''}`);
    return false;
  }
  return true;
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
          const { customer, techName } = await getCustomerAndTech(customerId, scheduledServiceId);
          const contact = getServiceContact(customer);
          if (contact.phone) {
            const day = formatDay(apptTime);
            const date = formatDate(apptTime);
            const time = formatTime(apptTime);
            const firstName = contact.name || customer.first_name || 'there';

            const body = await renderTemplate(
              'appointment_confirmation',
              { first_name: firstName, service_type: serviceLabel, date, time, day },
              `Hello ${firstName}! Your ${serviceLabel} appointment has been successfully scheduled for ${date} at ${time}.\n\nPlease reply to this message if you need any assistance.`,
            );

            const sent = await safeSend(customerId, contact.phone, body, 'confirmation');

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
        if (!r.reminder_72h_sent && hoursUntil >= 71.75 && hoursUntil <= 72.25) {
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
            const contact = getServiceContact(customer);
            if (!contact.phone) { results.skipped++; continue; }

            const firstName = contact.name || customer?.first_name || 'there';
            const day = formatDay(apptTime);
            const date = formatDate(apptTime);
            const time = formatTime(apptTime);

            const serviceLabel = smsServiceLabelStored(r.service_type);
            const body = await renderTemplate(
              'reminder_72h',
              { first_name: firstName, service_type: serviceLabel, day, date, time },
              `Hello ${firstName}! This is a reminder from Waves that your ${serviceLabel} appointment is scheduled for ${day} at ${time}.\n\nExpect your technician to arrive within a two-hour window of your scheduled start time. Need to reschedule? Log into your Waves Customer Portal at portal.wavespestcontrol.com.\n\nIf you have any questions or need assistance, simply reply to this message.`,
            );

            await safeSend(r.customer_id, contact.phone, body);

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
        if (!r.reminder_24h_sent && hoursUntil >= 23.75 && hoursUntil <= 24.25) {
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
            const contact = getServiceContact(customer);
            if (!contact.phone) { results.skipped++; continue; }

            const firstName = contact.name || customer?.first_name || 'there';
            const time = formatTime(apptTime);

            const serviceLabel = smsServiceLabelStored(r.service_type);
            const body = await renderTemplate(
              'reminder_24h',
              { first_name: firstName, service_type: serviceLabel, time },
              `Hello ${firstName}! This is a reminder from Waves that your ${serviceLabel} appointment is scheduled for tomorrow at ${time}.\n\nExpect your technician to arrive within a two-hour window of your scheduled start time. Your tech will text you when they are 15 minutes out.\n\nIf you have any questions or need assistance, simply reply to this message.`,
            );

            await safeSend(r.customer_id, contact.phone, body);

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
  async handleReschedule(scheduledServiceId, newTime) {
    try {
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

      // Send reschedule notice
      const { customer } = await getCustomerAndTech(record.customer_id, scheduledServiceId);
      const contact = getServiceContact(customer);
      if (contact.phone) {
        const firstName = contact.name || customer?.first_name || 'there';
        const day = formatDay(newApptTime);
        const date = formatDate(newApptTime);
        const time = formatTime(newApptTime);

        const serviceLabel = smsServiceLabelStored(record.service_type);
        const body = await renderTemplate(
          'appointment_rescheduled',
          { first_name: firstName, service_type: serviceLabel, day, date, time },
          `Hello ${firstName}! Your ${serviceLabel} with Waves has been rescheduled to ${day}, ${date} at ${time}.\n\n` +
            `Please ensure gates are unlocked and pets are secured before we arrive.\n\n` +
            `Questions? Reply to this message.\nThank you for choosing Waves!`,
        );

        await safeSend(record.customer_id, contact.phone, body);
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
      const contact = getServiceContact(customer);
      if (contact.phone) {
        const firstName = contact.name || customer?.first_name || 'there';
        const apptTime = new Date(record.appointment_time);
        const day = formatDay(apptTime);
        const date = formatDate(apptTime);

        const serviceLabel = smsServiceLabelStored(record.service_type);
        const body = await renderTemplate(
          'appointment_cancelled',
          { first_name: firstName, service_type: serviceLabel, day, date },
          `Hello ${firstName}! Your ${serviceLabel} with Waves scheduled for ${day}, ${date} has been cancelled.\n\n` +
            `Need to rebook? Reply to this message and we'll get you scheduled.\nThank you for choosing Waves!`,
        );

        await safeSend(record.customer_id, contact.phone, body);
        logger.info(`[appt-remind] Cancellation notice sent for customer ${record.customer_id} - ${record.service_type}`);
      }

      return record;
    } catch (err) {
      logger.error(`[appt-remind] handleCancellation failed: ${err.message}`);
      return null;
    }
  },
};

module.exports = AppointmentReminders;
