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

// A deliverable-looking address (local@domain.tld) — a stored `name@host`
// must not stop the estimate contact from being tried (GH Codex r6 P2).
function usableEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value));
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
async function acceptanceNoteFor(estimateId, acceptanceId = null) {
  const row = await db('estimate_acceptances')
    .where(acceptanceId ? { id: acceptanceId } : { estimate_id: estimateId })
    .orderBy('accepted_at', 'desc')
    .first('id', 'terms_version', 'terms_text', 'accepted_at');
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

// `acceptanceId` scopes the copy to ONE acceptance event: an estimate can be
// accepted again after a revision (a new estimate_acceptances row), and that
// acceptance's copy must not dedupe against the first one's email — so the
// note, the idempotency key and the fulfilment stamp all key on the record
// (pre-push Codex P1). Without one (gate off / pre-gate accept) the legacy
// per-estimate key applies, exactly as before.
// `idempotencyKey` is overridable ONLY by the daily catch-up sweep: a retry
// after a failed/blocked row needs a day-scoped key (bond-renewal pattern).
function acceptedOnboardingKey(estimateId, acceptanceId) {
  return acceptanceId
    ? `estimate.accepted_onboarding:${estimateId}:acc:${acceptanceId}`
    : `estimate.accepted_onboarding:${estimateId}`;
}

// Returns the sendTemplate result on a send ({sent:true} / {sent:false,
// blocked:true} for a suppression), {sent:false, outcome:'no_address'} when
// no usable email exists, {sent:false, outcome:'failed'} on a transient
// failure, or null when called without an estimate. Callers that fire-and-
// forget ignore it; the catch-up sweep keys its retry / escalate decision on it.
// Distinctive lead-in of acceptanceNoteFor(); the rendered email (or the
// stored snapshot of an earlier send) must contain it for the send to count
// as the promised copy.
const ACCEPTANCE_COPY_MARKER = 'You accepted electronically';
function renderedCarriesAcceptanceCopy(result) {
  const bodies = [
    result?.rendered?.text, result?.rendered?.html,
    result?.message?.text_snapshot, result?.message?.html_snapshot,
  ].filter((b) => typeof b === 'string');
  return bodies.some((b) => b.includes(ACCEPTANCE_COPY_MARKER));
}

async function sendEstimateAcceptedOnboarding({ customerId, estimateId, serviceLabel, appointment, acceptanceId = null, idempotencyKey } = {}) {
  try {
    if (!estimateId) return null;
    // Recipient: the linked customer, else the estimate's own contact — a
    // phoneless one-time accept commits without a customer row, and a linked
    // customer row can carry no usable email while the estimate does.
    const customer = customerId
      ? await db('customers').where({ id: customerId }).first('id', 'first_name', 'email')
      : null;
    let email = clean(customer?.email);
    const estimateContact = usableEmail(email)
      ? null
      : await db('estimates').where({ id: estimateId }).first('customer_name', 'customer_email');
    if (estimateContact) email = clean(estimateContact.customer_email);
    if (!usableEmail(email)) {
      logger.info(`[estimate-accepted-email] no usable email for ${customerId ? `customer ${customerId}` : `estimate ${estimateId}`}; skipping onboarding email`);
      // Distinct from a failure: nothing to retry until an address exists.
      return { sent: false, outcome: 'no_address' };
    }
    const firstName = clean(customer?.first_name || String(estimateContact?.customer_name || '').split(/\s+/)[0]) || 'there';
    const acceptanceNote = await acceptanceNoteFor(estimateId, acceptanceId);
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
      idempotencyKey: idempotencyKey || acceptedOnboardingKey(estimateId, acceptanceId),
      triggerEventId: acceptedOnboardingKey(estimateId, acceptanceId),
      categories: ['estimate_accepted_onboarding'],
      // SendGrid 4xx bodies can echo the recipient address — keep provider
      // errors out of the logs and log a redacted reason below.
      suppressProviderErrorLog: true,
    });
    if (result?.sent) logger.info(`[estimate-accepted-email] onboarding email sent for estimate ${estimateId}`);
    else logger.info(`[estimate-accepted-email] onboarding email NOT sent for estimate ${estimateId} (${result?.blocked ? 'suppression-blocked' : (result?.reason || 'not sent')})`);
    // The copy went out (a deduped sent-ish row counts) — but only stamp
    // fulfilment when the RENDERED email actually carries the note: an
    // admin can publish a template version without the optional
    // {{acceptance_note}} block, and a send without the copy is not the
    // promised copy (GH Codex r7 P1). The catch-up sweep escalates that.
    if (acceptanceNote && result?.sent) {
      if (renderedCarriesAcceptanceCopy(result)) {
        await db('estimate_acceptances')
          .where(acceptanceId ? { id: acceptanceId } : { estimate_id: estimateId })
          .whereNull('copy_emailed_at')
          .update({ copy_emailed_at: new Date() });
      } else {
        logger.error(`[estimate-accepted-email] onboarding email for estimate ${estimateId} rendered WITHOUT the acceptance copy — the active estimate.accepted_onboarding version lacks {{acceptance_note}}`);
        return { ...result, copyMissing: true };
      }
    }
    return result;
  } catch (err) {
    const reason = err.status
      ? `SendGrid ${err.status}`
      : EmailTemplateLibrary.redactEmailAddresses(err.message);
    logger.error(`[estimate-accepted-email] failed for estimate ${estimateId}: ${reason}`);
    // Transient (DB / template / provider) — the catch-up sweep retries.
    return { sent: false, outcome: 'failed', reason };
  }
}

module.exports = { sendEstimateAcceptedOnboarding, acceptedOnboardingKey, ACCEPTANCE_COPY_MARKER, _private: { appointmentLineFor, acceptanceNoteFor, renderedCarriesAcceptanceCopy } };
