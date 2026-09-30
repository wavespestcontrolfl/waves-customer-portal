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
 * passes `signup`, the email is sent from the gate-on template
 * (estimate.accepted_signup, transactional_required) and also carries the
 * property and the plan (membership.started's values). There is NO payment
 * section: the "Auto Pay is set up" confirmation stays its own email (owner
 * 2026-09-30). The result then says whether the send covered membership.started
 * (`coversMembership`: accepted by the provider AND every plan value rendered);
 * the caller sends membership.started itself when it did not. A later acceptance
 * the same ET day for a DIFFERENT property gets the short per-property
 * template. Gate off / no `signup`: exactly the email described above, byte for
 * byte.
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { TZ, parseETDateTime, etDateString, formatETDay, formatETDate, formatETTime } = require('../utils/datetime-et');
const { portalUrl } = require('../utils/portal-url');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { withAccountPrimaryContact } = require('./customer-contact');
const {
  BASE_TEMPLATE_KEY, SIGNUP_TEMPLATE_KEY, SHORT_TEMPLATE_KEY, SIGNUP_FULL_CATEGORY, SIGNUP_SHORT_CATEGORY,
  QUERY_STATUSES, RETRY_COLUMNS, acceptedForSending, signupGateLive, membershipCoveredBy,
} = require('./signup-single-email');
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

const normalizeAddress = (value) => clean(value).toLowerCase().replace(/\s+/g, ' ');

// Is this an ADDED property? Yes when the customer (or a customer on the same
// account, same address) was already sent a full signup email that the provider
// ACCEPTED (or that is on the retry rail) earlier today, ET, and no signup email
// today (full or short) already named THIS property — a second estimate for a
// property already on the plan (pest in the morning, lawn in the afternoon) is
// not an added property and gets the full email. If the first acceptance's email
// could not be sent, or was refused / suppressed, the next one is the first the
// customer actually received and gets the full version. A later bounce is not
// tracked (owner ruling 2026-09-30): that address cannot receive our mail, so
// nothing we send instead would arrive either.
async function isAddedPropertyToday({ customerId, email, ownKey, property }) {
  const start = parseETDateTime(`${etDateString()}T00:00`);
  if (!start || !customerId) return false;
  const ids = await accountCustomerIds(customerId);
  const rows = await db('email_messages')
    .whereIn('template_key', [SIGNUP_TEMPLATE_KEY, SHORT_TEMPLATE_KEY])
    .where({ recipient_type: 'customer' })
    .whereIn('recipient_id', ids)
    .whereIn('status', QUERY_STATUSES)
    .whereRaw('lower(recipient_email_snapshot) = ?', [clean(email).toLowerCase()])
    .where('created_at', '>=', start)
    .whereNot('idempotency_key', ownKey)
    .select('categories', 'payload_snapshot', 'status', ...RETRY_COLUMNS);
  const parsed = (value, fallback) => {
    if (typeof value !== 'string') return value ?? fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  };
  const earlier = (rows || []).filter(acceptedForSending).map((r) => ({
    full: (parsed(r.categories, []) || []).includes(SIGNUP_FULL_CATEGORY),
    address: normalizeAddress(parsed(r.payload_snapshot, {})?.property_address),
  }));
  if (!earlier.some((e) => e.full)) return false;
  const here = normalizeAddress(property?.full);
  return !earlier.some((e) => e.address && e.address === here);
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
  const plan = signup.membershipEmail
    ? await safe('plan', () => require('./account-membership-email').buildMembershipStartedSection(signup.membershipEmail))
    : null;
  // A later same-day acceptance for a DIFFERENT property is an added property —
  // but only when the email can name it; otherwise the full email (which names
  // nothing it can't) is the honest one.
  const added = property?.street
    ? await safe('day check', () => isAddedPropertyToday({ customerId, email, ownKey, property }))
    : false;
  const short = !!added;
  return {
    short,
    templateKey: short ? SHORT_TEMPLATE_KEY : SIGNUP_TEMPLATE_KEY,
    category: short ? SIGNUP_SHORT_CATEGORY : SIGNUP_FULL_CATEGORY,
    plan,
    variables: {
      ...(property ? { property_heading: 'Property', property_address: property.full, property_street: property.street } : {}),
      ...(plan ? plan.variables : {}),
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

// Who the email goes to: the linked customer, else the estimate's own contact —
// a phoneless one-time accept commits without a customer row, and a linked
// customer row can carry no usable email while the estimate does — and last the
// account owner's address for a secondary property (#1995), so a row / estimate
// address always wins. null when there is no usable address anywhere.
async function resolveRecipient({ customerId, estimateId }) {
  const customer = customerId
    ? await db('customers').where({ id: customerId }).first('id', 'first_name', 'email', 'account_id', 'is_primary_profile')
    : null;
  const own = usableEmail(customer?.email) ? null : await db('estimates').where({ id: estimateId }).first('customer_name', 'customer_email');
  let email = clean(own ? own.customer_email : customer?.email);
  if (!usableEmail(email) && customer) email = clean((await withAccountPrimaryContact({ ...customer, email: '' })).email);
  if (!usableEmail(email)) return null;
  return { email, firstName: clean(customer?.first_name || String(own?.customer_name || '').split(/\s+/)[0]) || 'there' };
}

// One send of the onboarding email: the combined signup variant when given,
// else the plain email. When the combined template (or the short one) is
// unavailable the customer still gets the plain email exactly as today, and
// membership.started goes out separately because nothing was folded in.
// Returns the sendTemplate result and the variant that actually went out.
async function sendOnboardingTemplate(ctx, variant) {
  const send = (v) => EmailTemplateLibrary.sendTemplate({
    templateKey: v ? v.templateKey : BASE_TEMPLATE_KEY,
    to: ctx.recipient.email,
    payload: {
      first_name: ctx.recipient.firstName,
      service_type: clean(ctx.serviceLabel) || 'service',
      appointment_line: appointmentLineFor(ctx.appointment),
      acceptance_note: ctx.acceptanceNote,
      customer_portal_url: portalUrl('/login'),
      company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
      ...v?.variables,
    },
    recipientType: 'customer',
    recipientId: ctx.customerId || null,
    idempotencyKey: ctx.idempotencyKey || ctx.ownKey,
    triggerEventId: ctx.ownKey,
    categories: v ? ['estimate_accepted_onboarding', v.category] : ['estimate_accepted_onboarding'],
    // SendGrid 4xx bodies can echo the recipient address — keep provider
    // errors out of the logs and log a redacted reason below.
    suppressProviderErrorLog: true,
  });
  let sent = { result: null, variant };
  try {
    sent.result = await send(variant);
  } catch (err) {
    if (!variant || !isTemplateUnavailable(err)) throw err;
    logger.warn(`[estimate-accepted-email] ${variant.templateKey} unavailable for estimate ${ctx.estimateId}; sending the plain onboarding email`);
    sent = { result: await send(null), variant: null };
  }
  const { result } = sent;
  if (result?.sent) logger.info(`[estimate-accepted-email] onboarding email sent for estimate ${ctx.estimateId}`);
  else logger.info(`[estimate-accepted-email] onboarding email NOT sent for estimate ${ctx.estimateId} (${result?.blocked ? 'suppression-blocked' : (result?.reason || 'not sent')})`);
  return sent;
}

// The copy went out (a deduped sent-ish row counts) — but only stamp fulfilment
// when the RENDERED email actually carries the note: an admin can publish a
// template version without the optional {{acceptance_note}} block, and a send
// without the copy is not the promised copy (GH Codex r7 P1). The catch-up sweep
// escalates that. Returns true when the note was promised but is missing.
async function stampAcceptanceCopy({ acceptanceNote, acceptanceId, estimateId, result }) {
  if (!acceptanceNote || !result?.sent) return false;
  if (!renderedCarriesAcceptanceCopy(result)) {
    logger.error(`[estimate-accepted-email] onboarding email for estimate ${estimateId} rendered WITHOUT the acceptance copy — the active estimate.accepted_onboarding version lacks {{acceptance_note}}`);
    return true;
  }
  await db('estimate_acceptances')
    .where(acceptanceId ? { id: acceptanceId } : { estimate_id: estimateId })
    .whereNull('copy_emailed_at')
    .update({ copy_emailed_at: new Date() });
  return false;
}

// `signup` (GATE_SIGNUP_SINGLE_EMAIL only — the accept route passes it for a
// standard recurring signup): { membershipEmail: <sendMembershipStarted args> }.
// Then the result also carries `coversMembership`, the send-time answer to "did
// this email make the separate membership.started email unnecessary".
async function sendEstimateAcceptedOnboarding(args = {}) {
  const { customerId, estimateId, acceptanceId, signup } = args;
  try {
    if (!estimateId) return null;
    const recipient = await resolveRecipient(args);
    if (!recipient) {
      logger.info(`[estimate-accepted-email] no usable email for ${customerId ? `customer ${customerId}` : `estimate ${estimateId}`}; skipping onboarding email`);
      // Distinct from a failure: nothing to retry until an address exists.
      return { sent: false, outcome: 'no_address' };
    }
    // Only THIS acceptance event's copy (pre-push Codex P1): without an
    // acceptanceId (gate off / unattested pre-gate accept) nothing was shown
    // for this event, so the note stays empty — never the newest row's terms.
    const acceptanceNote = acceptanceId ? await acceptanceNoteFor(estimateId, acceptanceId) : '';
    const ownKey = acceptedOnboardingKey(estimateId, acceptanceId);
    // ONE SIGNUP EMAIL: only for a caller that passed `signup`, only while the
    // gate is on at this moment. Otherwise the send is the email as it has
    // always been.
    const wanted = signup && signupGateLive()
      ? await buildSignupEmail({ ...args, email: recipient.email, ownKey })
      : null;
    const { result, variant } = await sendOnboardingTemplate({ ...args, recipient, acceptanceNote, ownKey }, wanted);
    const copyMissing = await stampAcceptanceCopy({ acceptanceNote, acceptanceId, estimateId, result });
    // Covered only by a send the provider accepted whose rendered output carries
    // the whole plan section. Every other outcome (no address, a failure, a
    // suppression) simply omits the flag, and the caller sends membership.started.
    const coversMembership = membershipCoveredBy(result, variant?.plan);
    return { ...result, ...(copyMissing && { copyMissing }), ...(coversMembership && { coversMembership }) };
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
  accountCustomerIds,
  _private: { appointmentLineFor, acceptanceNoteFor, renderedCarriesAcceptanceCopy, propertyForEstimate, isAddedPropertyToday, buildSignupEmail },
};
