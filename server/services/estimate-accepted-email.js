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
const { TZ, parseETDateTime, formatETDay, formatETDate, formatETTime } = require('../utils/datetime-et');
const { portalUrl } = require('../utils/portal-url');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

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

// Acceptance-terms copy promised "we ... email you a copy"
// (GATE_ESTIMATE_ACCEPTANCE_TERMS). This email IS that copy: the complete
// verbatim text the customer accepted (from the recorded row, never the live
// constant), the instant and the version — self-contained on purpose, with
// no link back to the estimate page, which staff can archive later (GH
// Codex P0). EMPTY when nothing was recorded — renderBlocks drops the empty
// paragraph, so an email for an accept that showed no terms reads exactly
// as before. Keyed on the RECORD, not the gate: evidence already recorded is
// never hidden by the kill switch.
async function acceptanceNoteFor(estimateId) {
  const row = await db('estimate_acceptances')
    .where({ estimate_id: estimateId })
    .orderBy('accepted_at', 'desc')
    .first('terms_version', 'terms_text', 'accepted_at');
  if (!row) return '';
  const at = row.accepted_at ? new Date(row.accepted_at) : null;
  const when = at && !Number.isNaN(at.getTime())
    ? ` on ${formatETDay(at)}, ${at.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: TZ })} at ${formatETTime(at)} ET`
    : '';
  // One paragraph (the template renderer does not keep line breaks): the
  // line, then each drawer line separated by a middle dot.
  const lines = String(row.terms_text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const [line, ...terms] = lines;
  return `You accepted electronically${when} (terms ${row.terms_version}). What you accepted: \u201c${line || ''}\u201d${terms.length ? ` ${terms.join(' \u00b7 ')}` : ''}`;
}

// `idempotencyKey` is overridable ONLY by the daily catch-up sweep
// (lifecycle-email-sweeps runAcceptanceCopySweep): the stable per-estimate
// key dedupes the normal post-commit send; a retry after a failed/blocked
// row needs a day-scoped key, same pattern as the bond renewal sweep.
async function sendEstimateAcceptedOnboarding({ customerId, estimateId, serviceLabel, appointment, idempotencyKey } = {}) {
  try {
    if (!estimateId) return null;
    // Recipient: the linked customer, else the estimate's own contact — a
    // phoneless one-time accept commits without a customer row, and a linked
    // customer row can carry no usable email while the estimate does.
    const customer = customerId
      ? await db('customers').where({ id: customerId }).first('id', 'first_name', 'email')
      : null;
    let email = clean(customer?.email);
    const estimateContact = email.includes('@')
      ? null
      : await db('estimates').where({ id: estimateId }).first('customer_name', 'customer_email');
    if (estimateContact) email = clean(estimateContact.customer_email);
    if (!email || !email.includes('@')) {
      logger.info(`[estimate-accepted-email] no usable email for ${customerId ? `customer ${customerId}` : `estimate ${estimateId}`}; skipping onboarding email`);
      return null;
    }
    const firstName = clean(customer?.first_name || String(estimateContact?.customer_name || '').split(/\s+/)[0]) || 'there';
    const acceptanceNote = await acceptanceNoteFor(estimateId);
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'estimate.accepted_onboarding',
      to: email,
      payload: {
        first_name: firstName,
        service_type: clean(serviceLabel) || 'service',
        appointment_line: appointmentLineFor(appointment),
        acceptance_note: acceptanceNote,
        customer_portal_url: portalUrl('/login'),
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
      },
      recipientType: 'customer',
      recipientId: customerId || null,
      idempotencyKey: idempotencyKey || `estimate.accepted_onboarding:${estimateId}`,
      triggerEventId: `estimate.accepted_onboarding:${estimateId}`,
      categories: ['estimate_accepted_onboarding'],
      // SendGrid 4xx bodies can echo the recipient address — keep provider
      // errors out of the logs and log a redacted reason below.
      suppressProviderErrorLog: true,
    });
    logger.info(`[estimate-accepted-email] onboarding email sent for estimate ${estimateId}`);
    // The copy went out (a deduped sent-ish row counts): stamp fulfilment so
    // the catch-up sweep stops retrying this acceptance.
    if (acceptanceNote && result?.sent) {
      await db('estimate_acceptances').where({ estimate_id: estimateId }).whereNull('copy_emailed_at')
        .update({ copy_emailed_at: new Date() });
    }
    return result;
  } catch (err) {
    const reason = err.status
      ? `SendGrid ${err.status}`
      : EmailTemplateLibrary.redactEmailAddresses(err.message);
    logger.error(`[estimate-accepted-email] failed for estimate ${estimateId}: ${reason}`);
    return null;
  }
}

module.exports = { sendEstimateAcceptedOnboarding, _private: { appointmentLineFor, acceptanceNoteFor } };
