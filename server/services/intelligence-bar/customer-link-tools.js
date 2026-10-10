/**
 * Intelligence Bar — Customer links (the composer's Insert Link sheet)
 * server/services/intelligence-bar/customer-link-tools.js
 *
 * Two carded writes that give the bar the links the Communications composer
 * can insert for a customer, through the SAME route-owned handlers the
 * composer posts to — never a second builder:
 *
 *   create_customer_link     — one of the Insert Link kinds (reschedule,
 *                              re-service, pay balance, latest estimate,
 *                              referral, consultation, appointment page, card
 *                              request, prep guide, service report, receipt,
 *                              project report; the payer statement and the
 *                              contract signing link stay composer-only — the
 *                              statement resolves from the payer's AP phone
 *                              and the contract send needs the composer's own
 *                              Insert Link state (contractId) to activate). Runs admin-communications.js's
 *                              /customer-link, /reschedule-link or
 *                              /reservice-link handler (recipient resolution,
 *                              owner rules, per-kind builders, plain-word
 *                              refusals) and hands back { url, line }.
 *                              Nothing is sent.
 *   send_autopay_setup_link  — the Customers page "Auto Pay setup link"
 *                              button: autopay-setup-link.js's one entry
 *                              point (gate, payer exemption, already-on-
 *                              Auto-Pay, saved-card auto-secure, dedup,
 *                              template levers). Texts or emails the link,
 *                              or hands it back for the composer.
 *
 * Both follow the write-gates.js two-step: unconfirmed → a PREVIEW (reads
 * only); the route fingerprints it and the operator approves on the card;
 * confirmed → the mint/send, reported from what the handler returned.
 *
 * Sending a minted link: a text is a customer contact, so the bar's own text
 * tools stay the only senders. The composer's send seam re-verifies and
 * records some kinds at send time (a card request's one-text-ever claim, a
 * prepared contract's activation, prep-guide and statement sent marks, a
 * project report's delivery claim, a consultation's lead binding), and that
 * bookkeeping lives in the composer's /sms route only — so those kinds are
 * texted from the Communications composer, and comms-tools' send_sms refuses
 * a body carrying one (customerLinkSendRefusal). Review requests keep
 * trigger_review_request; Auto Pay keeps send_autopay_setup_link.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { maskPhone, maskEmail } = require('./closeout-repair-tools');

const COMPOSER_ONLY = 'Text it from the Communications composer (Insert Link does the rest: the send is verified and recorded there). The bar\'s send_sms refuses a text carrying this link.';
const ANY_SENDER = 'Text it with send_sms on the Communications page, or draft_sms elsewhere and let the operator send; the recipient must be this customer\'s own number.';

// The Insert Link kinds, in the composer's own vocabulary. `route`: which
// admin-communications.js handler builds it. `builds`: what the confirmed run
// creates, in plain words for the card. `sendHow`: who may text it (above).
const KINDS = {
  // Inside the self-serve move notice window the composer's handler also
  // stamps the office's approval on the visit (office_move_approved_for —
  // approveOfficeMove), so the customer can move it online; the card must
  // say so, like every write it commits (ib-write-tools checklist 4).
  reschedule: { label: 'Reschedule link', route: 'rescheduleLinkInsert', builds: 'a link to move their soonest upcoming visit online; if that visit is inside the self-service notice window, confirming also records the office\'s approval for the customer to move it', sendHow: ANY_SENDER },
  reservice: { label: 'Re-service link', route: 'reserviceLinkInsert', builds: 'their self-serve link to book a free between-visit re-service (active recurring plan required)', sendHow: ANY_SENDER },
  pay_balance: { label: 'Pay balance link', route: 'customerLinkInsert', builds: 'the pay page for the oldest open self-pay invoice on the account (the page offers the rest of the balance)', sendHow: ANY_SENDER },
  estimate: { label: 'Latest estimate link', route: 'customerLinkInsert', builds: 'a tracked link to the newest open estimate on the account', sendHow: ANY_SENDER },
  referral: { label: 'Referral link', route: 'customerLinkInsert', builds: 'their personal referral link (their referral code is created if they have none)', sendHow: ANY_SENDER },
  consultation: { label: 'Free consultation link', route: 'customerLinkInsert', builds: 'a 14-day pick-a-time page for their open lead', sendHow: COMPOSER_ONLY },
  appointment: { label: 'Appointment page link', route: 'customerLinkInsert', builds: 'the appointment page for the soonest upcoming visit on the account', sendHow: ANY_SENDER },
  // A consented saved card already covering the visit is enrolled instead
  // (requestCardForAppointment auto-secure): a committed write with no link.
  card_request: { label: 'Card request link', route: 'customerLinkInsert', builds: 'a secure card-on-file request for their next visit (one text ever per visit); if a consented saved card already covers that visit, confirming enrolls that card for it instead and no link is built', sendHow: COMPOSER_ONLY, autoSecure: true },
  prep_guide: { label: 'Upcoming visit prep link', route: 'customerLinkInsert', builds: 'the prep guide page for their upcoming visit', sendHow: COMPOSER_ONLY },
  service_report: { label: 'Latest service report link', route: 'customerLinkInsert', builds: 'the latest completed-visit report on the account', sendHow: ANY_SENDER },
  receipt: { label: 'Latest receipt link', route: 'customerLinkInsert', builds: 'the latest paid receipt on the account', sendHow: ANY_SENDER },
  project_report: { label: 'Project report link', route: 'customerLinkInsert', builds: 'the latest project report (WDO, termite, specialty) on the account', sendHow: COMPOSER_ONLY },
};
const KIND_NAMES = Object.keys(KINDS);

// Fields the composer handlers return beside url/line that the operator can use.
const LINK_FACT_FIELDS = ['balance', 'estimate', 'appointment', 'prep', 'report', 'receipt', 'projectReport', 'expiresAt', 'lanes', 'immediateOnly', 'standalone'];

const DELIVERIES = ['sms', 'email', 'inline'];
const DELIVERY_WORDS = {
  sms: 'texts the customer the Auto Pay setup link (the reviewed Auto Pay setup text)',
  email: 'emails the customer the Auto Pay setup link',
  inline: 'hands the link back for the composer; nothing is sent',
};

const CUSTOMER_LINK_TOOLS = [
  {
    name: 'create_customer_link',
    description: `Build one of the customer links the Communications composer's Insert Link sheet offers, for ONE customer, exactly as that sheet builds it: reschedule, reservice, pay_balance, estimate, referral, consultation, appointment, card_request, prep_guide, service_report, receipt, project_report. The first call returns a PREVIEW and builds nothing: the customer, their number, what the link is and how it may be sent. The operator approves on the confirmation card; the confirmed run builds the link and returns url, line (a ready SMS sentence) and the link's facts (balance, estimate, appointment, expiry). NOTHING IS SENT by this tool. A kind with nothing to link (no open balance, no upcoming visit, no open estimate, no active plan, link switched off) is refused with the plain reason. card_request: when a consented saved card already covers the visit, the confirmed run enrolls that card for it instead and returns auto_secured with no link (an Auto Pay enrollment confirmation may be emailed).
Sending: reschedule, reservice, pay_balance, estimate, referral, appointment, service_report and receipt links may ride send_sms (Communications page) or a draft_sms the operator sends. consultation, card_request, prep_guide and project_report links are texted from the Communications composer only — its send verifies and records them (claims, sent marks); send_sms refuses a text carrying one. Not here: review requests (trigger_review_request), Auto Pay setup (send_autopay_setup_link), payer statement links and contract signing links (composer only — the statement resolves from the payer's AP phone, and a contract link only activates through the composer's own Insert Link flow). Admin-only.
Use for: "get Henderson a pay link", "send Smith the link to their estimate", "build a referral link for Garcia", "I need the prep guide link for their visit"`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The customer (from query_customers / get_customer_detail)' },
        kind: { type: 'string', enum: KIND_NAMES, description: 'Which link to build' },
      },
      required: ['customer_id', 'kind'],
    },
    _sideEffects: true,
  },
  {
    name: 'send_autopay_setup_link',
    description: `Send (or hand back) a customer's Auto Pay setup link — the Customers page "Auto Pay setup link" button. delivery sms (default) texts it with the reviewed Auto Pay setup text; email emails it; inline builds the 30-day link and returns it for the composer, sending nothing. The first call returns a PREVIEW and does nothing: the customer, the channel and who it reaches (masked), the checks that passed (not payer-billed, not already on Auto Pay, a per-visit or per-application plan). The operator approves on the card; the confirmed run goes through the Auto Pay service's one entry point and reports exactly what it did: sent (with the channel), link_created (inline), auto_secured (a consented saved card already covered it, so that card was enrolled and NOTHING was sent — tell the operator), or the plain reason it was skipped (links switched off, texts switched off, template inactive, already on Auto Pay, paused, payer-billed, unsupported plan). Nothing is charged by this link; the customer saves a payment method on the page. Admin-only.
Use for: "send the Auto Pay link to this customer", "text Henderson the autopay enrollment link", "email Smith the auto pay setup link"`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The customer' },
        delivery: { type: 'string', enum: DELIVERIES, description: 'sms (default), email, or inline (link only, nothing sent)' },
      },
      required: ['customer_id'],
    },
    _sideEffects: true,
  },
];

const last10 = (value) => String(value || '').replace(/\D/g, '').slice(-10);
const fullUsNumber = (value) => { const d = String(value || '').replace(/\D/g, ''); return d.length === 10 || (d.length === 11 && d.startsWith('1')); };
const fullName = (row) => [row?.first_name, row?.last_name].filter(Boolean).join(' ') || null;

async function liveCustomer(customerId) {
  const id = String(customerId || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) return { error: 'A valid customer_id is required', code: 'invalid_target' };
  const row = await db('customers').where({ id }).whereNull('deleted_at')
    .first('id', 'first_name', 'last_name', 'phone', 'email');
  if (!row) return { error: 'Customer not found', code: 'customer_not_found' };
  return { customer: row };
}

// ── create_customer_link ────────────────────────────────────────

// The preview with the customer row it was built from: { plan, customer }.
// `plan` is the preview, or the plain refusal (an `error` object).
async function deriveLinkPlan(input) {
  const kind = String(input.kind || '');
  const spec = KINDS[kind];
  if (!spec) return { plan: { error: `kind must be one of ${KIND_NAMES.join(', ')}`, code: 'invalid_target' } };
  const found = await liveCustomer(input.customer_id);
  if (found.error) return { plan: found };
  const { customer } = found;
  // Same full-number rule as the composer handlers' fullPhoneLast10 (exactly
  // ten digits, or eleven starting with 1): a card is never offered for a
  // number the confirmed handler would refuse.
  if (!fullUsNumber(customer.phone)) return { plan: { error: 'This customer has no full 10-digit US phone on file — customer links are built for their own number.', code: 'no_phone' } };
  const digits = last10(customer.phone);
  const plan = {
    preview: true,
    kind,
    label: spec.label,
    customer_id: customer.id,
    customer_name: fullName(customer),
    phone: maskPhone(customer.phone),
    builds: `${spec.label}: ${spec.builds}, for this customer's own number.`,
    sends: 'Nothing is sent by this step. If there is nothing to link, the confirmed run refuses with the reason.',
    send_how: spec.sendHow,
    ...(spec.autoSecure ? {
      auto_secure: 'If a consented saved card already covers the visit, confirming enrolls that card for it instead, builds no link, and the Auto Pay enrollment confirmation email may go out — the result says auto_secured.',
      // The authorization contract reads this: a conditional customer email.
      notifies_customer: 'may',
    } : {}),
    _version: { customer_id: customer.id, kind, phone_last10: digits },
    note: 'PREVIEW ONLY — no link exists yet. Confirm builds exactly this link.',
  };
  return { plan, customer };
}

async function linkPlan(input) {
  return (await deriveLinkPlan(input)).plan;
}

// The approved card's _version rides to the confirmed run (the route's
// VERIFIED_VERSION_PARAMS hands the fingerprint-verified preview's _version
// as _verified_*_version); the commit re-derives its own and refuses on any
// difference, so a customer whose number or email changed after the card is
// never acted on — and a call with no pin never commits.
function pinnedVersionRefusal(pinned, live, noun) {
  if (!pinned) return { error: 'Use the confirmation card to approve this change.' };
  if (JSON.stringify(live) !== JSON.stringify(pinned)) {
    return { error: `What this ${noun} would do changed after the card was shown — nothing was done. Ask again for a fresh confirmation card.`, preview_changed: true };
  }
  return null;
}

async function buildLink(input) {
  const { plan, customer } = await deriveLinkPlan(input);
  if (plan.error) return plan;
  const drift = pinnedVersionRefusal(input._verified_link_version, plan._version, 'link');
  if (drift) return drift;
  const spec = KINDS[plan.kind];
  // The composer handlers cross-check the phone against the selected
  // customer and expand to the account; the bar always sends the row's own
  // number, so the owner rules that fire on a typed number apply unchanged.
  const answer = await require('../../routes/admin-communications')[spec.route]({
    phone: customer.phone, customerId: plan.customer_id, kind: plan.kind,
  });
  const body = answer?.body || {};
  // A committed write with no link: the composer handler answers 200 +
  // autoSecured when a consented saved card covered the visit and was
  // enrolled for it (card_request). Reported as the success it is.
  if (answer?.status === 200 && body.autoSecured) {
    return {
      success: true, kind: plan.kind, label: spec.label, customer_id: plan.customer_id, customer_name: plan.customer_name,
      auto_secured: true, url: null, sent: false,
      enrollment_confirmation: 'The Auto Pay enrollment confirmation email may have been sent by the enrollment itself.',
      summary: 'A consented saved card already covered the visit: it was enrolled for it and NO link was built. Tell the operator.',
    };
  }
  if (answer?.status !== 200 || !body.url) {
    return {
      error: body.error || 'Nothing to link for this customer',
      blocked: true,
      code: body.code || `link_${answer?.status || 'unavailable'}`,
      kind: plan.kind,
      customer_id: plan.customer_id,
    };
  }
  const facts = Object.fromEntries(LINK_FACT_FIELDS.filter((f) => body[f] !== undefined && body[f] !== null).map((f) => [f, body[f]]));
  return {
    success: true,
    kind: plan.kind,
    label: spec.label,
    customer_id: plan.customer_id,
    customer_name: plan.customer_name,
    url: body.url,
    line: String(body.line || '').trim(),
    ...facts,
    sent: false,
    send_how: spec.sendHow,
  };
}

// ── send_autopay_setup_link ─────────────────────────────────────

const blocked = (error, code) => ({ error, blocked: true, code });
// The service's own address rule (autopay-setup-link.js isEmailLike): the
// confirmed send mints the link row before judging the address, so the
// preview judges it first.
const EMAIL_LIKE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The chosen channel's own read-only levers (the service checks them only
// after minting the link row): no card for a delivery that cannot happen.
const AUTOPAY_CHANNEL_PREFLIGHT = {
  async sms(customer) {
    if (!fullUsNumber(customer.phone)) return blocked('This customer has no full 10-digit US phone on file — nothing to text.', 'no_phone');
    const { AUTOPAY_SKIP_REASONS, autopaySmsLever } = require('../composer-customer-links');
    const lever = await autopaySmsLever();
    return lever ? blocked(AUTOPAY_SKIP_REASONS[lever] || `Auto Pay texts are not available (${lever})`, lever) : null;
  },
  async email(customer) {
    if (!EMAIL_LIKE_RE.test(String(customer.email || '').trim())) return blocked('This customer has no valid email on file — nothing to email.', 'no_customer_email');
    let loaded = null;
    try { loaded = await require('../email-template-library').loadTemplateByKey(require('../autopay-setup-link').EMAIL_TEMPLATE_KEY); } catch { loaded = null; }
    if (!loaded?.activeVersion) return blocked('The Auto Pay setup email is inactive in Email Templates — activate it before emailing a setup link', 'email_template_inactive');
    let prefs;
    try { prefs = await db('notification_prefs').where({ customer_id: customer.id }).first('email_enabled'); } catch { return blocked('Could not read this customer\'s email preference — try again in a moment', 'email_prefs_check_uncertain'); }
    return prefs?.email_enabled === false ? blocked('This customer has opted out of email — nothing to email', 'email_opted_out') : null;
  },
  async inline() { return null; },
};
const AUTOPAY_REACHES = {
  sms: (customer) => `text to ${maskPhone(customer.phone)}`,
  email: (customer) => `email to ${maskEmail(customer.email)}`,
  inline: () => 'nobody — the link comes back here for the composer',
};
// The service enrolls a consented, chargeable saved card BEFORE it validates
// or uses the delivery channel (autopay-setup-link.js requestAutopaySetupLink),
// so a customer with such a card and no phone / an email opt-out still
// succeeds from the Customers page (Codex r7 on #6266 P1). Same read the
// service makes (opt-out included); an unreadable answer falls toward the
// channel preflight, as the service falls toward minting a link.
async function consentedSavedCard(customerId) {
  try { return !!(await require('../payment-method-consents').findConsentedChargeableCard(customerId)); } catch { return false; }
}

async function autopayPlan(input) {
  const delivery = input.delivery === undefined || input.delivery === null ? 'sms' : String(input.delivery);
  if (!DELIVERIES.includes(delivery)) return { error: `delivery must be one of ${DELIVERIES.join(', ')}`, code: 'invalid_target' };
  const found = await liveCustomer(input.customer_id);
  if (found.error) return found;
  const { customer } = found;
  // The service's own read-only eligibility (gate, archived, payer-billed,
  // already on Auto Pay, paused, billing lane) — the card never offers a
  // send the service would skip for a reason known now.
  const eligibility = await require('../autopay-setup-link').setupLinkIneligibility(customer.id);
  if (eligibility.reason) {
    const { AUTOPAY_SKIP_REASONS } = require('../composer-customer-links');
    return blocked(AUTOPAY_SKIP_REASONS[eligibility.reason] || `Auto Pay setup link not available (${eligibility.reason})`, eligibility.reason);
  }
  // Mirror the service's ordering: a consented saved card is enrolled first
  // and the channel is never touched, so its levers do not gate the card.
  const autoSecure = await consentedSavedCard(customer.id);
  if (!autoSecure) {
    const refusal = await AUTOPAY_CHANNEL_PREFLIGHT[delivery](customer);
    if (refusal) return refusal;
  }
  return {
    preview: true,
    customer_id: customer.id,
    customer_name: fullName(customer),
    delivery,
    reaches: autoSecure ? 'nobody by link — a consented saved card already covers this customer, so it is enrolled instead' : AUTOPAY_REACHES[delivery](customer),
    does: autoSecure
      ? 'enrolls the consented saved card for Auto Pay on the spot; NO setup link is built or sent (the Auto Pay enrollment confirmation email may go out). If that card stops qualifying before Confirm, the service falls back to a setup link and judges the delivery channel itself.'
      : `${DELIVERY_WORDS[delivery]}. The link lasts 30 days; nothing is charged until the customer saves a payment method on it.`,
    checks_passed: 'Not payer-billed, not already on Auto Pay, not paused, on a per-visit or per-application plan.',
    auto_secure: 'If a consented saved card already covers this, that card is enrolled on the spot, no setup link is sent, and the Auto Pay enrollment confirmation email may go out — the result says auto_secured.',
    // The authorization contract reads this: a text or email send is a
    // customer contact (irreversible); inline or an expected auto-secure only
    // contacts the customer if the enrollment emails its confirmation.
    notifies_customer: delivery === 'inline' || autoSecure ? 'may' : true,
    _version: { customer_id: customer.id, delivery, phone_last10: last10(customer.phone), email: String(customer.email || '').trim().toLowerCase(), auto_secure: autoSecure },
    note: 'PREVIEW ONLY — nothing was sent. Confirm sends exactly this.',
  };
}

const AUTOPAY_UNCERTAIN = 'The Auto Pay setup send outcome is unknown — the provider did not answer. Check the customer before sending again.';

async function commitAutopay(input) {
  const plan = await autopayPlan(input);
  if (plan.error) return plan;
  const drift = pinnedVersionRefusal(input._verified_autopay_version, plan._version, 'Auto Pay send');
  if (drift) return drift;
  const { AUTOPAY_SKIP_REASONS } = require('../composer-customer-links');
  const { requestAutopaySetupLink } = require('../autopay-setup-link');
  // trigger 'admin' is what the Customers page button passes: the card's
  // Confirm click is the operator's own action (operatorInitiated send).
  const result = await requestAutopaySetupLink({ customerId: plan.customer_id, delivery: plan.delivery, trigger: 'admin' });
  const base = { customer_id: plan.customer_id, customer_name: plan.customer_name, delivery: plan.delivery, action: result?.action || 'skipped' };
  switch (result?.action) {
    case 'sent':
      return { success: true, ...base, channel: result.channel || plan.delivery, sent: true, expires_at: result.expiresAt || null,
        summary: `Auto Pay setup link sent by ${result.channel === 'email' ? 'email' : 'text'}.` };
    case 'link_created':
      return { success: true, ...base, sent: false, url: result.secureUrl || null, expires_at: result.expiresAt || null,
        summary: 'Auto Pay setup link built; nothing was sent. Text it from the Communications composer (its send re-verifies the link).' };
    case 'auto_secured':
      return { success: true, ...base, sent: false, auto_secured: true,
        enrollment_confirmation: 'The Auto Pay enrollment confirmation email may have been sent by the enrollment itself.',
        summary: 'A consented saved card already covered this customer: it was enrolled for Auto Pay and NO setup link was sent (the enrollment confirmation email may have gone out). Tell the operator.' };
    default: {
      const reason = String(result?.reason || 'skipped');
      if (reason === 'send_outcome_uncertain') return { outcome_unknown: true, ...base, error: AUTOPAY_UNCERTAIN, code: reason };
      return { error: AUTOPAY_SKIP_REASONS[reason] || `Auto Pay setup link was not sent (${reason})`, blocked: true, code: reason, ...base };
    }
  }
}

// ── dispatcher ──────────────────────────────────────────────────

async function executeCustomerLinkTool(toolName, input = {}, actionContext = {}) {
  // Admin-only like the requireAdmin routes these mirror; the route and
  // registry refuse a technician too.
  if (actionContext && actionContext.isAdmin === false) {
    return { error: 'Customer links are limited to admin accounts', code: 'permission_denied' };
  }
  try {
    switch (toolName) {
      case 'create_customer_link':
        // Only /confirm-action sets confirmed (route-derived, never a model param).
        return input.confirmed === true ? await buildLink(input) : await linkPlan(input);
      case 'send_autopay_setup_link':
        return input.confirmed === true ? await commitAutopay(input) : await autopayPlan(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:customer-links] ${toolName} failed (${err.code || err.name || 'error'})`);
    // A throw after an approval may follow a committed write (a referral code,
    // a tracked short link, an office move approval, a card auto-secure):
    // never invite a retry as if nothing happened.
    if (input.confirmed === true) {
      return { outcome_unknown: true, code: 'execution_interrupted',
        error: toolName === 'send_autopay_setup_link' ? AUTOPAY_UNCERTAIN
          : 'The link build was interrupted — it may or may not have been built, and its side effects (a referral code, a tracked link, an office move approval, a card auto-secure) may have been recorded. Check before trying again. Nothing was sent.' };
    }
    return { error: 'Could not prepare the customer link' };
  }
}

module.exports = { CUSTOMER_LINK_TOOLS, executeCustomerLinkTool, CUSTOMER_LINK_KINDS: KINDS };
