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
 *
 * ONE SIGNUP EMAIL (GATE_SIGNUP_SINGLE_EMAIL, dark): when the accept route
 * passes `signup`, this same email also carries the property, the plan
 * (membership.started's values) and the Auto Pay authorization
 * (autopay.enrollment_confirmation's payload), and the send result reports
 * which of those sections the RENDERED email actually carried
 * (`result.signup`) so the caller skips the separate emails only for what was
 * folded in. A later acceptance by the same customer the same ET day gets the
 * short per-property template instead. Gate off / no `signup`: exactly the
 * email described above, byte for byte.
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { TZ, parseETDateTime, etDateString, formatETDay, formatETDate, formatETTime } = require('../utils/datetime-et');
const { portalUrl } = require('../utils/portal-url');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { withAccountPrimaryContact } = require('./customer-contact');
const { signupGateLive } = require('./signup-single-email');
const { propertyStreetAddress, propertyStreetLine } = require('../utils/property-display');

function clean(value) {
  return String(value == null ? '' : value).trim();
}

// A deliverable-looking address (local@domain.tld) — a stored `name@host`
// must not stop the estimate contact from being tried (GH Codex r6 P2).
function usableEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value));
}


// ── One signup email (GATE_SIGNUP_SINGLE_EMAIL) ───────────────────────────
const BASE_TEMPLATE_KEY = 'estimate.accepted_onboarding';
const SHORT_TEMPLATE_KEY = 'estimate.accepted_additional_property';
const SENT_ISH = ['sent', 'delivered', 'opened', 'clicked'];
// Sits in the "get the app" paragraph of the full template. The welcome queue
// (new-recurring-welcome-sms.js) skips its email only when a delivered
// combined email still carries these steps — reworded copy fails safe (the
// welcome email then sends as it does today).
const SIGNUP_APP_MARKER = 'enter your texted code';
const SIGNUP_FULL_CATEGORY = 'signup_full';
const SIGNUP_SHORT_CATEGORY = 'signup_short';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Did the RENDERED email (or the stored snapshot of an earlier, deduped send)
// carry this exact text? A section only counts as folded in when the customer
// can actually read it — an admin can publish a template version without the
// new blocks, and the separate email must then still go out.
function renderedCarries(result, needle) {
  const text = clean(needle);
  if (!text) return false;
  const plain = [result?.rendered?.text, result?.message?.text_snapshot].filter((b) => typeof b === 'string');
  const html = [result?.rendered?.html, result?.message?.html_snapshot].filter((b) => typeof b === 'string');
  return plain.some((b) => b.includes(text)) || html.some((b) => b.includes(escapeHtml(text)));
}

// The WHOLE section, not a sample of it: every non-empty value the section was
// built with (headings aside — the text version upper-cases them) must be in
// the delivered email, so an edited template that kept one row but dropped the
// rate, the method or the charge timing does not count as having said it.
function sectionCarried(result, variables = {}) {
  const values = Object.entries(variables)
    .filter(([key, value]) => !key.endsWith('_heading') && clean(value))
    .map(([, value]) => value);
  return values.length > 0 && values.every((value) => renderedCarries(result, value));
}

function isTemplateUnavailable(err) {
  return err?.code === 'EMAIL_TEMPLATE_UNAVAILABLE' || err?.code === 'EMAIL_TEMPLATE_DISABLED';
}

// The property this estimate is for, as the customer reads it: the stamped
// visit address (the address the visit was booked for), else the estimate's
// own property address, else the customer's street address — never the
// profile_label nickname ("Primary"). { full, street } or null.
async function propertyForEstimate({ estimateId, customerId, appointment }) {
  if (appointment?.id) {
    const row = await db('scheduled_services').where({ id: appointment.id })
      .first('service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_state', 'service_address_zip');
    const stamped = {
      address_line1: row?.service_address_line1 ?? appointment.service_address_line1,
      address_line2: row?.service_address_line2 ?? appointment.service_address_line2,
      city: row?.service_address_city ?? appointment.service_address_city,
      state: row?.service_address_state ?? appointment.service_address_state,
      zip: row?.service_address_zip ?? appointment.service_address_zip,
    };
    const full = propertyStreetAddress(stamped);
    if (full) return { full, street: propertyStreetLine(stamped) };
  }
  const estimate = await db('estimates').where({ id: estimateId }).first('address');
  const estimateAddress = clean(estimate?.address);
  if (estimateAddress) return { full: estimateAddress, street: clean(estimateAddress.split(',')[0]) || estimateAddress };
  if (customerId) {
    const cust = await db('customers').where({ id: customerId }).first('address_line1', 'address_line2', 'city', 'state', 'zip');
    const full = propertyStreetAddress(cust || {});
    if (full) return { full, street: propertyStreetLine(cust) };
  }
  return null;
}

// This customer plus every customer on the same account — the same person's
// other properties. Shared by the same-day short-email check and the welcome
// queue's check so the two can never disagree about who "the customer" is.
async function accountCustomerIds(customerId) {
  const ids = new Set([String(customerId)]);
  const self = await db('customers').where({ id: customerId }).first('account_id');
  if (self?.account_id) {
    const siblings = await db('customers').where({ account_id: self.account_id }).select('id');
    for (const sibling of siblings || []) ids.add(String(sibling.id));
  }
  return [...ids];
}

// Has this customer (or a customer on the same account) already been sent the
// FULL signup email at this address earlier today, ET? Then a later acceptance
// is an added property and gets the short email. Only a delivered full email
// counts — if the first acceptance's email failed or was blocked, the next one
// is the first the customer actually received and gets the full version.
async function priorFullSignupEmailToday({ customerId, email, ownKey }) {
  const start = parseETDateTime(`${etDateString()}T00:00`);
  if (!start || !customerId) return false;
  const ids = await accountCustomerIds(customerId);
  const row = await db('email_messages')
    .where({ template_key: BASE_TEMPLATE_KEY, recipient_type: 'customer' })
    .whereIn('recipient_id', ids)
    .whereIn('status', SENT_ISH)
    .whereRaw('lower(recipient_email_snapshot) = ?', [clean(email).toLowerCase()])
    .whereRaw('categories @> ?::jsonb', [JSON.stringify([SIGNUP_FULL_CATEGORY])])
    .where('created_at', '>=', start)
    .whereNot('idempotency_key', ownKey)
    .first('id');
  return !!row;
}

// Everything the combined email adds to the payload, plus which template
// carries it. Never throws — a section that cannot be built is simply absent
// (and its separate email then goes out as it does today).
async function buildSignupEmail({ customerId, estimateId, appointment, email, signup, ownKey }) {
  const safe = async (label, fn) => {
    try { return await fn(); } catch (err) {
      logger.warn(`[estimate-accepted-email] signup ${label} unavailable for estimate ${estimateId}: ${EmailTemplateLibrary.redactEmailAddresses(err.message)}`);
      return null;
    }
  };
  const property = await safe('property', () => propertyForEstimate({ estimateId, customerId, appointment }));
  const priorFull = await safe('day check', () => priorFullSignupEmailToday({ customerId, email, ownKey }));
  const plan = signup.membershipEmail
    ? await safe('plan', () => require('./account-membership-email').buildMembershipStartedSection(signup.membershipEmail))
    : null;
  const payment = signup.paymentMethodRowId
    ? await safe('payment', () => require('./card-enrollment-email').buildAutopayPaymentSection({ customerId, paymentMethodRowId: signup.paymentMethodRowId }))
    : null;
  // A later same-day acceptance is an ADDED property — but only when the
  // email can name it; otherwise the full email (which names nothing it can't)
  // is the honest one.
  const short = !!priorFull && !!property?.street;
  return {
    short,
    templateKey: short ? SHORT_TEMPLATE_KEY : BASE_TEMPLATE_KEY,
    category: short ? SIGNUP_SHORT_CATEGORY : SIGNUP_FULL_CATEGORY,
    plan,
    payment,
    variables: {
      ...(property ? { property_heading: 'Property', property_address: property.full, property_street: property.street } : {}),
      ...(plan ? plan.variables : {}),
      ...(payment ? payment.variables : {}),
    },
  };
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

// `signup` (GATE_SIGNUP_SINGLE_EMAIL only — the accept route passes it for a
// standard recurring signup): { membershipEmail: <sendMembershipStarted args>,
// paymentMethodRowId: <the freshly enrolled in-charge method, or null> }. The
// result then carries `signup: { short, planCovered, paymentCovered }` — what
// the DELIVERED email actually contains — and the caller sends each separate
// email unless its section is covered.
async function sendEstimateAcceptedOnboarding({ customerId, estimateId, serviceLabel, appointment, acceptanceId = null, idempotencyKey, signup = null } = {}) {
  try {
    if (!estimateId) return null;
    // Recipient: the linked customer, else the estimate's own contact — a
    // phoneless one-time accept commits without a customer row, and a linked
    // customer row can carry no usable email while the estimate does.
    const customer = customerId
      ? await db('customers').where({ id: customerId }).first('id', 'first_name', 'email', 'account_id', 'is_primary_profile')
      : null;
    let email = clean(customer?.email);
    const estimateContact = usableEmail(email)
      ? null
      : await db('estimates').where({ id: estimateId }).first('customer_name', 'customer_email');
    if (estimateContact) email = clean(estimateContact.customer_email);
    // Secondary-property accept with no email on the row OR the estimate:
    // the account owner's address (#1995) — same person, minted from their
    // own estimate. Checked last so a row/estimate address always wins.
    if (!usableEmail(email) && customer) {
      const withPrimary = await withAccountPrimaryContact({ ...customer, email: '' });
      if (usableEmail(withPrimary.email)) email = clean(withPrimary.email);
    }
    if (!usableEmail(email)) {
      logger.info(`[estimate-accepted-email] no usable email for ${customerId ? `customer ${customerId}` : `estimate ${estimateId}`}; skipping onboarding email`);
      // Distinct from a failure: nothing to retry until an address exists.
      return { sent: false, outcome: 'no_address' };
    }
    const firstName = clean(customer?.first_name || String(estimateContact?.customer_name || '').split(/\s+/)[0]) || 'there';
    // Only THIS acceptance event's copy (pre-push Codex P1): without an
    // acceptanceId (gate off / unattested pre-gate accept) nothing was shown
    // for this event, so the note stays empty — never the newest row's terms.
    const acceptanceNote = acceptanceId ? await acceptanceNoteFor(estimateId, acceptanceId) : '';
    const ownKey = acceptedOnboardingKey(estimateId, acceptanceId);
    // ONE SIGNUP EMAIL: only for a caller that passed `signup`, only while the
    // gate is on at this moment. Otherwise `combined` stays null and the send
    // below is the email as it has always been.
    let combined = signup && signupGateLive()
      ? await buildSignupEmail({ customerId, estimateId, appointment, email, signup, ownKey })
      : null;
    const sendOnboarding = (variant) => EmailTemplateLibrary.sendTemplate({
      templateKey: variant ? variant.templateKey : BASE_TEMPLATE_KEY,
      to: email,
      payload: {
        first_name: firstName,
        service_type: clean(serviceLabel) || 'service',
        appointment_line: appointmentLineFor(appointment),
        acceptance_note: acceptanceNote,
        customer_portal_url: portalUrl('/login'),
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        ...(variant ? variant.variables : {}),
      },
      recipientType: 'customer',
      recipientId: customerId || null,
      idempotencyKey: idempotencyKey || ownKey,
      triggerEventId: ownKey,
      categories: variant ? ['estimate_accepted_onboarding', variant.category] : ['estimate_accepted_onboarding'],
      // SendGrid 4xx bodies can echo the recipient address — keep provider
      // errors out of the logs and log a redacted reason below.
      suppressProviderErrorLog: true,
    });
    let result;
    try {
      result = await sendOnboarding(combined);
    } catch (err) {
      // The short template (or a disabled/missing one) is unavailable: the
      // customer still gets the plain onboarding email exactly as today, and
      // every separate email goes out because nothing was folded in.
      if (!combined || !isTemplateUnavailable(err)) throw err;
      logger.warn(`[estimate-accepted-email] ${combined.templateKey} unavailable for estimate ${estimateId}; sending the plain onboarding email`);
      combined = null;
      result = await sendOnboarding(null);
    }
    // What the DELIVERED email actually carries — decided from the rendered
    // output (or the snapshot of a deduped earlier send), never from what was
    // requested: a template version without the new blocks folds nothing in.
    const coverage = combined ? {
      short: combined.short,
      planCovered: !!result?.sent && !!combined.plan && sectionCarried(result, combined.plan.variables),
      paymentCovered: !!result?.sent && !!combined.payment && sectionCarried(result, combined.payment.variables),
    } : null;
    const withCoverage = (r) => (coverage ? { ...r, signup: coverage } : r);
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
        return withCoverage({ ...result, copyMissing: true });
      }
    }
    return withCoverage(result);
  } catch (err) {
    const reason = err.status
      ? `SendGrid ${err.status}`
      : EmailTemplateLibrary.redactEmailAddresses(err.message);
    logger.error(`[estimate-accepted-email] failed for estimate ${estimateId}: ${reason}`);
    // Transient (DB / template / provider) — the catch-up sweep retries.
    return { sent: false, outcome: 'failed', reason };
  }
}

module.exports = {
  sendEstimateAcceptedOnboarding,
  acceptedOnboardingKey,
  ACCEPTANCE_COPY_MARKER,
  SIGNUP_APP_MARKER,
  SIGNUP_FULL_CATEGORY,
  accountCustomerIds,
  _private: { appointmentLineFor, acceptanceNoteFor, renderedCarriesAcceptanceCopy, renderedCarries, propertyForEstimate, priorFullSignupEmailToday, buildSignupEmail },
};
