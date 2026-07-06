/**
 * "You're booked — here's what happens next" email, fired post-commit
 * from the public estimate /accept handler (estimate.accepted_onboarding
 * template). Closes the gap between acceptance and the appointment
 * confirmation — the highest-anxiety window in the funnel.
 *
 * appointment_line is composed HERE (the template degrades to plain
 * "between now and your first visit" copy when it's empty): when the
 * accept flow scheduled a first visit, the line carries day, date, and
 * the DISPLAY arrival window — always window_start + 2 hours, never
 * window_end (window_end is the job block that drives scheduling).
 *
 * Best-effort by contract: callers fire-and-forget; a template or
 * SendGrid failure must never affect the accept response. Idempotent
 * per estimate, so an accept retry can't double-send.
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { parseETDateTime, formatETDay, formatETDate, formatETTime } = require('../utils/datetime-et');
const { portalUrl } = require('../utils/portal-url');

function clean(value) {
  return String(value == null ? '' : value).trim();
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// scheduled_services rows carry scheduled_date (DATE) + window_start (TIME).
// Compose the customer-facing line; null when the pieces aren't usable.
function appointmentLineFor(appointment) {
  if (!appointment) return '';
  const datePart = appointment.scheduled_date instanceof Date
    ? appointment.scheduled_date.toISOString().slice(0, 10)
    : String(appointment.scheduled_date || '').slice(0, 10);
  if (!datePart) return '';
  const timePart = appointment.window_start ? String(appointment.window_start).slice(0, 8) : null;
  const start = timePart ? parseETDateTime(`${datePart}T${timePart}`) : null;
  if (!start) {
    const day = parseETDateTime(`${datePart}T00:00`);
    return day ? `Your first visit is scheduled for ${formatETDay(day)}, ${formatETDate(day)}.` : '';
  }
  const end = new Date(start.getTime() + TWO_HOURS_MS);
  return `Your first visit is scheduled for ${formatETDay(start)}, ${formatETDate(start)} with a ${formatETTime(start)}–${formatETTime(end)} arrival window.`;
}

async function sendEstimateAcceptedOnboarding({ customerId, estimateId, serviceLabel, appointment } = {}) {
  try {
    if (!customerId || !estimateId) return null;
    const customer = await db('customers')
      .where({ id: customerId })
      .first('id', 'first_name', 'email');
    const email = clean(customer?.email);
    if (!email || !email.includes('@')) {
      logger.info(`[estimate-accepted-email] no usable email for customer ${customerId}; skipping onboarding email`);
      return null;
    }
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'estimate.accepted_onboarding',
      to: email,
      payload: {
        first_name: clean(customer.first_name) || 'there',
        service_type: clean(serviceLabel) || 'service',
        appointment_line: appointmentLineFor(appointment),
        customer_portal_url: portalUrl('/login'),
      },
      recipientType: 'customer',
      recipientId: customerId,
      idempotencyKey: `estimate.accepted_onboarding:${estimateId}`,
      triggerEventId: `estimate.accepted_onboarding:${estimateId}`,
      categories: ['estimate_accepted_onboarding'],
    });
    logger.info(`[estimate-accepted-email] onboarding email sent for estimate ${estimateId}`);
    return result;
  } catch (err) {
    logger.error(`[estimate-accepted-email] failed for estimate ${estimateId}: ${err.message}`);
    return null;
  }
}

module.exports = { sendEstimateAcceptedOnboarding, _private: { appointmentLineFor } };
