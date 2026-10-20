/**
 * Intelligence Bar — Customer links (the composer's Insert Link sheet)
 * server/services/intelligence-bar/customer-link-tools.js
 *
 * One carded write that gives the bar the links the Communications composer
 * can insert for a customer, through the SAME route-owned handler the
 * composer posts to — never a second builder:
 *
 *   create_customer_link     — one of the Insert Link kinds (reschedule,
 *                              re-service, pay balance, latest estimate,
 *                              referral, consultation, appointment page, prep
 *                              guide, service report, receipt, project report;
 *                              the card request link, the payer statement and the
 *                              contract signing link stay composer-only — a card
 *                              request can enroll a saved card for Auto Pay, the
 *                              statement resolves from the payer's AP phone
 *                              and the contract send needs the composer's own
 *                              Insert Link state (contractId) to activate). Runs admin-communications.js's
 *                              /customer-link, /reschedule-link or
 *                              /reservice-link handler (recipient resolution,
 *                              owner rules, per-kind builders, plain-word
 *                              refusals) and hands back { url, line }.
 *                              Nothing is sent.
 *
 *   send_autopay_setup_link  — texts or emails ONE customer their 30-day Auto
 *                              Pay setup link through autopay-setup-link.js's
 *                              one entry point. The preview and the commit use
 *                              the service's OWN read-only checks (eligibility,
 *                              the saved-card finder, autopayDeliveryPreflight)
 *                              rather than a copy of them, and the commit runs
 *                              the service with requireDeliverable (no link row
 *                              unless the channel can deliver), allowAutoSecure
 *                              false (the bar never enrolls a saved card: that
 *                              turns Auto Pay on, a billing change) and the
 *                              recipient the card showed (re-checked by the
 *                              service before the provider call). A link-only
 *                              Auto Pay link stays on the Customers page.
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
 * trigger_review_request.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { maskPhone } = require('./closeout-repair-tools');
// "f•••@example.com": enough for the operator to recognise the address.
const maskAddress = (address) => String(address || '').replace(/^(.)[^@]*/, '$1•••');

const COMPOSER_ONLY = 'The bar can\'t send this link from here: its send_sms refuses a text carrying it. The Communications composer\'s Insert Link sends it today (verified and recorded there).';
const ANY_SENDER = 'Text it with send_sms, or draft it with draft_sms and let the operator send; the recipient must be this customer\'s own number.';

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
  prep_guide: { label: 'Upcoming visit prep link', route: 'customerLinkInsert', builds: 'the prep guide page for their upcoming visit', sendHow: COMPOSER_ONLY },
  service_report: { label: 'Latest service report link', route: 'customerLinkInsert', builds: 'the latest completed-visit report on the account', sendHow: ANY_SENDER },
  receipt: { label: 'Latest receipt link', route: 'customerLinkInsert', builds: 'the latest paid receipt on the account', sendHow: ANY_SENDER },
  project_report: { label: 'Project report link', route: 'customerLinkInsert', builds: 'the latest project report (WDO, termite, specialty) on the account', sendHow: COMPOSER_ONLY },
};
const KIND_NAMES = Object.keys(KINDS);

// Fields the composer handlers return beside url/line that the operator can use.
const LINK_FACT_FIELDS = ['balance', 'estimate', 'appointment', 'prep', 'report', 'receipt', 'projectReport', 'expiresAt', 'lanes', 'immediateOnly', 'standalone'];

const CUSTOMER_LINK_TOOLS = [
  {
    name: 'create_customer_link',
    description: `Build one of the customer links the Communications composer's Insert Link sheet offers, for ONE customer, exactly as that sheet builds it: reschedule, reservice, pay_balance, estimate, referral, consultation, appointment, prep_guide, service_report, receipt, project_report. The first call returns a PREVIEW and builds nothing: the customer, their number, what the link is and how it may be sent. The operator approves on the confirmation card; the confirmed run builds the link and returns url, line (a ready SMS sentence) and the link's facts (balance, estimate, appointment, expiry). NOTHING IS SENT by this tool. A kind with nothing to link (no open balance, no upcoming visit, no open estimate, no active plan, link switched off) is refused with the plain reason.
Sending: reschedule, reservice, pay_balance, estimate, referral, appointment, service_report and receipt links may ride send_sms (Communications page) or a draft_sms the operator sends. consultation, prep_guide and project_report links are texted from the Communications composer only — its send verifies and records them (claims, sent marks); send_sms refuses a text carrying one. Not here: review requests (trigger_review_request), Auto Pay setup (the Customers page button), card request links (the Communications composer / visit card only: building one can enroll a saved card for Auto Pay), payer statement links and contract signing links (composer only — the statement resolves from the payer's AP phone, and a contract link only activates through the composer's own Insert Link flow). Admin-only.
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
    description: `Text or email ONE customer their 30-day Auto Pay setup link — the Customers page "Auto Pay setup link" button, for a customer with no saved card. delivery sms (default) texts it with the reviewed Auto Pay setup text; email emails it. The first call returns a PREVIEW and sends nothing: the customer, the channel, who it reaches (masked) and what will be created and sent. The operator approves on the confirmation card; the confirmed run sends the link to exactly that recipient and reports sent, or the plain reason it was not sent. Refused with the plain reason when the customer is not eligible (already on Auto Pay, paused, payer-billed, unsupported plan, links switched off) or the channel cannot deliver (no phone or email, opted out or suppressed, texts or the template switched off). Refused when the customer has a saved card on file: enrolling a saved card turns Auto Pay on for the account, a billing change the bar never makes: by the owner's rule that stays on the Customers page. The bar can't make a link-only Auto Pay link (no send) from here yet; create_customer_link does not build it. Nothing is charged by this link; the customer saves a payment method on the page. The link itself is never returned. Admin-only.
Use for: "send the Auto Pay link to this customer", "text Henderson the autopay enrollment link", "email Smith the auto pay setup link"`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The customer' },
        delivery: { type: 'string', enum: ['sms', 'email'], description: 'sms (default) or email' },
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
    .first('id', 'first_name', 'last_name', 'phone');
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
// difference, so a customer whose number changed after the card is
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
  // The handlers catch their own exceptions and answer 500, possibly after a
  // side effect was recorded (a tracked short link, a referral code, an office
  // move approval). That is an unknown outcome, never a definite "blocked":
  // thrown here so the confirmed run's catch reports outcome_unknown.
  if (!answer || answer.status >= 500) {
    throw Object.assign(new Error('customer link handler failed'), { code: `handler_${answer?.status || 'no_answer'}` });
  }
  const body = answer.body || {};
  if (answer.status !== 200 || !body.url) {
    return {
      error: body.error || 'Nothing to link for this customer',
      blocked: true,
      code: body.code || `link_${answer.status}`,
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

const AUTOPAY_DELIVERIES = ['sms', 'email'];
const SAVED_CARD_REFUSAL = 'This customer has a saved card on file. Enrolling it turns Auto Pay on for the account, a billing change the bar does not make. That enrollment stays on the Customers page by the owner\'s rule.';
const CHECK_LATER = ' — try again in a moment';
// The operator's words for the reasons the service's own checks return (the
// shared AUTOPAY_SKIP_REASONS table covers eligibility, the gates and the
// text template); anything else is the pipeline's own plain sentence.
const AUTOPAY_REASON_WORDS = {
  no_customer_phone: 'This customer has no phone number on file — nothing to text.',
  no_customer_email: 'This customer has no valid email address on file — nothing to email.',
  email_opted_out: 'This customer has opted out of email — nothing to email.',
  email_prefs_check_uncertain: `Could not read this customer's email preference${CHECK_LATER}`,
  email_template_inactive: 'The Auto Pay setup email is inactive in Email Templates — activate it before emailing a setup link.',
  email_template_check_uncertain: `Could not check the Auto Pay setup email template${CHECK_LATER}`,
  sms_policy_check_uncertain: `Could not read this customer's texting consent or suppression state${CHECK_LATER}`,
  sms_line_type_check_uncertain: `Could not check whether this number can receive texts${CHECK_LATER}`,
  sms_delivery_check_uncertain: `Could not check whether the text can be delivered${CHECK_LATER}`,
  email_delivery_check_uncertain: `Could not check whether the email can be delivered${CHECK_LATER}`,
  recipient_changed: 'This customer\'s phone number or email changed after the card was shown — nothing was sent. Ask again for a fresh confirmation card.',
  saved_method_available: SAVED_CARD_REFUSAL,
  no_customer: 'A valid customer_id is required',
};
// The service reuses the customer's unexpired setup link as it is (it never
// extends the expiry): one that is about to lapse would reach the customer
// already dead, so the card is not offered for it.
const EXISTING_LINK_MIN_LIFE_MS = 24 * 60 * 60 * 1000;
const etWhen = (date) => `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)} ET`;
const AUTOPAY_UNCERTAIN = 'The Auto Pay setup send outcome is unknown — the provider did not answer. Check the customer\'s messages before trying again.';
const AUTOPAY_UNCERTAIN_REASONS = ['send_outcome_uncertain', 'request_failed'];

function autopayReasonWords(reason) {
  const { AUTOPAY_SKIP_REASONS = {} } = require('../composer-customer-links');
  const code = String(reason || 'skipped');
  return AUTOPAY_REASON_WORDS[code] || AUTOPAY_SKIP_REASONS[code] || `The Auto Pay setup link was not sent: ${code.slice(0, 160)}`;
}
const autopayRefusal = (reason) => (reason === 'saved_method_available'
  ? { error: SAVED_CARD_REFUSAL, blocked: true, code: 'by_owner_rule', rule: 'saved_method_available' }
  : { error: autopayReasonWords(reason), blocked: true, code: String(reason || 'skipped').slice(0, 80) });

// Who the link reaches and the contact the card pins: the number's last ten
// digits for a text, the lower-cased address for an email.
function autopayRecipient(customer, delivery) {
  if (delivery === 'email') {
    const email = String(customer.email || '').trim().toLowerCase();
    return { masked: maskAddress(email), pin: { email }, expected: { email } };
  }
  const digits = last10(customer.phone);
  return { masked: maskPhone(customer.phone), pin: { phone_last10: digits }, expected: { phoneLast10: digits } };
}

// What the send would do with the link row (the service's own dedup read): a
// refusal for a row mid-completion or one about to lapse, else the expiry of
// the existing link it would re-send (null = a new one).
async function autopayLinkPlan(autopay, customerId) {
  const reuse = await autopay.setupLinkReuse(customerId);
  if (reuse.state === 'completing') return { refusal: autopayRefusal('completion_in_progress') };
  const existingExpiry = reuse.state === 'reuse' ? reuse.expiresAt : null;
  if (existingExpiry && existingExpiry.getTime() - Date.now() < EXISTING_LINK_MIN_LIFE_MS) {
    return { refusal: { error: `The customer's existing Auto Pay setup link expires ${etWhen(existingExpiry)}, too soon to re-send. Once it expires, send again and a fresh 30-day link is created.`, blocked: true, code: 'existing_link_expiring' } };
  }
  return { existingExpiry };
}

// The preview: the service's own read-only answers, in order — eligibility,
// the saved card (the bar never enrolls one), then the channel preflight.
async function autopayPlan(input) {
  const delivery = input.delivery === undefined || input.delivery === null ? 'sms' : String(input.delivery);
  if (!AUTOPAY_DELIVERIES.includes(delivery)) return { error: `delivery must be one of ${AUTOPAY_DELIVERIES.join(', ')}. The bar can't make a link-only Auto Pay link from here yet.`, code: 'invalid_target' };
  const id = String(input.customer_id || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) return { error: 'A valid customer_id is required', code: 'invalid_target' };
  const autopay = require('../autopay-setup-link');
  const eligibility = await autopay.setupLinkIneligibility(id);
  if (eligibility.reason) return autopayRefusal(eligibility.reason);
  const { customer } = eligibility;
  if (await autopay.findSavedMethodForAutoSecure(id)) return { error: SAVED_CARD_REFUSAL, blocked: true, code: 'by_owner_rule', rule: 'saved_method_available' };
  if (delivery === 'sms' && !fullUsNumber(customer.phone)) return autopayRefusal('no_customer_phone');
  const preflight = await autopay.autopayDeliveryPreflight({ customerId: id, customer, delivery, trigger: 'admin' });
  if (!preflight.ok) return autopayRefusal(preflight.reason);
  const link = await autopayLinkPlan(autopay, id);
  if (link.refusal) return link.refusal;
  const { existingExpiry } = link;
  const recipient = autopayRecipient(customer, delivery);
  const verb = delivery === 'email' ? 'emails' : 'texts';
  return {
    preview: true,
    customer_id: id,
    customer_name: fullName(customer),
    delivery,
    recipient: recipient.masked,
    reaches: `${delivery === 'email' ? 'email to' : 'text to'} ${recipient.masked}`,
    link: existingExpiry ? 'existing' : 'new',
    does: `${existingExpiry
      ? `re-sends the customer's existing Auto Pay setup link, which expires ${etWhen(existingExpiry)}, by ${delivery === 'email' ? 'email' : 'text'} to ${recipient.masked}`
      : `creates a new Auto Pay setup link, valid 30 days, and ${verb} it to ${recipient.masked}`}. Nothing is charged; the customer saves a payment method on the page. The link is not shown here.`,
    // The authorization contract reads this: the customer is contacted.
    notifies_customer: true,
    // The expiry of the link that would be re-sent (null = a new one): a change between card and confirm refuses.
    _version: { customer_id: id, delivery, ...recipient.pin, link_expires_at: existingExpiry ? existingExpiry.toISOString() : null },
    note: 'PREVIEW ONLY — nothing was sent. Confirm sends exactly this, to exactly this recipient.',
  };
}

// The confirmed run: the pin first, then ONE service call. requireDeliverable
// (no link row unless the channel can deliver), allowAutoSecure false (never
// enroll a saved card) and the recipient the card showed (re-checked by the
// service before the provider call). The bearer link never goes back to the
// model: only the channel, the masked recipient and the expiry do.
async function commitAutopay(input) {
  const plan = await autopayPlan(input);
  if (plan.error) return plan;
  const drift = pinnedVersionRefusal(input._verified_autopay_version, plan._version, 'Auto Pay send');
  if (drift) return drift;
  const { requestAutopaySetupLink } = require('../autopay-setup-link');
  const { customer_id: customerId, delivery } = plan._version;
  const expectedRecipient = delivery === 'email' ? { email: plan._version.email } : { phoneLast10: plan._version.phone_last10 };
  const result = await requestAutopaySetupLink({ customerId, delivery, trigger: 'admin', requireDeliverable: true, allowAutoSecure: false, expectedRecipient });
  if (result?.action === 'sent') {
    return {
      success: true, customer_id: customerId, customer_name: plan.customer_name, delivery, channel: result.channel || delivery,
      recipient: plan.recipient, sent: true, expires_at: result.expiresAt || null,
      summary: `Auto Pay setup link sent by ${(result.channel || delivery) === 'email' ? 'email' : 'text'} to ${plan.recipient}.`,
    };
  }
  const reason = String(result?.reason || 'skipped');
  if (AUTOPAY_UNCERTAIN_REASONS.includes(reason)) return { outcome_unknown: true, error: AUTOPAY_UNCERTAIN, code: reason, customer_id: customerId, delivery };
  return { ...autopayRefusal(reason), customer_id: customerId, delivery, sent: false };
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
    // a tracked short link, an office move approval):
    // never invite a retry as if nothing happened.
    if (input.confirmed === true) {
      return { outcome_unknown: true, code: 'execution_interrupted',
        error: toolName === 'send_autopay_setup_link' ? AUTOPAY_UNCERTAIN
          : 'The link build was interrupted — it may or may not have been built, and its side effects (a referral code, a tracked link, an office move approval) may have been recorded. Check before trying again. Nothing was sent.' };
    }
    return { error: toolName === 'send_autopay_setup_link' ? 'Could not prepare the Auto Pay setup link' : 'Could not prepare the customer link' };
  }
}

module.exports = { CUSTOMER_LINK_TOOLS, executeCustomerLinkTool, CUSTOMER_LINK_KINDS: KINDS };
