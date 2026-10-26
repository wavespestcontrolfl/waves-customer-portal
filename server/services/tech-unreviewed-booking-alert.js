'use strict';

/**
 * The office notice for a booking a technician tried to start before the office reviewed it
 * (census M6, GATE_TECH_STAFF_GUARDS). One notification per visit, per docs/admin-notifications.md:
 * Schedule, needs-you, subject = the visit, done when the booking is confirmed (closeForVisit, from
 * the shared confirm hook in services/outbound-review-confirm.js). A second tap dedupes onto the
 * standing row and rings nothing.
 *
 * Both functions are best effort: they log and resolve, never reject, so the refusal the technician
 * sees and the confirm hook never depend on the bell.
 */
const db = require('../models/db');
const logger = require('./logger');
const { raiseAdminAlert } = require('./admin-alert-compose');
const { lookupCustomerName, fitAction } = require('./admin-alert-names');

const KEY_PREFIX = 'tech-unreviewed-booking:';
const keyFor = (visitId) => `${KEY_PREFIX}${visitId}`;

function dateOnly(value) {
  const text = value instanceof Date ? value.toISOString() : String(value || '');
  const day = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * @param {object} svc  scheduled_services row (id, customer_id, scheduled_date)
 * @param {string} tap  'En Route' or 'On Site'
 */
async function raiseForVisit(svc, tap) {
  try {
    const name = await lookupCustomerName(db, svc.customer_id);
    const day = dateOnly(svc.scheduled_date);
    const link = `/admin/dispatch?tab=schedule${day ? `&date=${day}` : ''}&appointment=${encodeURIComponent(svc.id)}`;
    return await raiseAdminAlert('schedule', {
      area: 'Schedule',
      action: name
        ? fitAction('Schedule', name, [(who) => `review ${who}'s booking before the visit`, (who) => `review ${who}'s booking`])
        : 'review a booking before the visit',
      why: `The technician tapped ${tap}, but the office has not reviewed this booking.`,
      severity: 'needs-you',
      link,
      subject: { type: 'visit', id: String(svc.id) },
      doneWhen: 'visit_confirmed',
      who: 'person',
    }, {
      // One notice per visit, however many times the technician taps.
      dedupeKey: keyFor(svc.id),
      detail: `${name || 'A customer'}'s booking came from a phone call and is still waiting for office review. `
        + `The technician tapped ${tap}; the tap was refused and nothing was confirmed. `
        + 'Confirm the booking (or cancel the visit) before the technician starts it. The customer was not contacted.',
      metadata: { scheduledServiceId: String(svc.id) },
    });
  } catch (err) {
    logger.warn(`[tech-unreviewed-booking] alert failed for ${svc.id}: ${err.message}`);
    return null;
  }
}

// Close the notice once the booking is confirmed. A no-op when none was raised.
async function closeForVisit(visitId, conn = db) {
  try {
    const { closeAdminAlertKeys } = require('./admin-alert-episodes');
    return await closeAdminAlertKeys(conn, [keyFor(visitId)], 'booking_confirmed', {
      resolution: 'The office confirmed the booking.',
    });
  } catch (err) {
    logger.warn(`[tech-unreviewed-booking] close failed for ${visitId}: ${err.message}`);
    return 0;
  }
}

module.exports = { raiseForVisit, closeForVisit, keyFor };
