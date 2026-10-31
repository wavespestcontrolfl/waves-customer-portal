/**
 * Intelligence Bar — compose a NEW email
 * server/services/intelligence-bar/compose-email-tools.js
 *
 * Owner ask 2026-10-28 (IB gap #9: "compose an email from the bar; today it can only reply"): a card that replays the
 * Email page's own Compose + Send.
 *
 *   compose_email — the Email page composer's Send (POST /admin/email/send with no threadId / inReplyTo), run through
 *                   services/email/send-message.js sendEmailMessage: the SAME function the route calls.
 *
 * What the route's send does (read end to end): one Gmail message from the connected mailbox (From "Waves Pest Control
 * <GMAIL_USER_EMAIL>"), To the one address, a UTF-8 subject, an HTML body, and a thread only when replying (a compose has
 * none, so it is a new thread). No signature, attachment, tracking or unsubscribe link is added; no copy is saved or linked
 * to a customer; there is no suppression or opt-out check; only the Gmail message id is logged. The page's composer sends
 * plain text as HTML with the four HTML characters escaped and newlines as <br> (encodeEmailBody); the bar sends its carded
 * text through the same encoding.
 *
 * Scope, on purpose (the stop rule): ONE recipient, plain text, no CC or BCC, no attachment, no thread. A bulk send, a
 * list, an attachment or a reply stays on the Email page or on send_email_reply. A portal link to a customer's account is
 * refused in the body, exactly as send_email_reply refuses it (the same read-only 'email' phase check).
 *
 * It EMAILS a person, so it is ALWAYS a confirm card (write-gates.js two-step), on every admin login, the owner's too (it is
 * not on the owner-direct list), never owner-direct. Admin only, as the Email routes (requireAdmin). Platform path only,
 * dark behind GATE_IB_COMPOSE_EMAIL (which needs GATE_IB_PLATFORM).
 *
 *   unconfirmed -> a PREVIEW: nothing is sent. Its `_version` pins what the card showed: the recipient (address, and the
 *                  customer and name when there is one), the From, the subject and a digest of the exact body.
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift (a customer whose email changed,
 *                  a different subject or body), then sends exactly the carded fields. A double Confirm never sends
 *                  twice: the pending card is claimed by one atomic UPDATE (pending-actions.js claimForConfirm), and this
 *                  executor refuses a second run of the same operation in this process too.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');

function composeEmailLive() {
  return require('../../config/feature-gates').ibComposeEmailLive() === true;
}

const SUBJECT_MAX = 200;
// Owner ruling 2026-10-26 (customer emails are a few short lines) and approval 2026-10-29: the bar's body stops at about 500
// characters. The Email page's own composer keeps its larger limit; this cap is the bar's tool only.
const BODY_MAX = 500;
const CARD_LINE_CHARS = 190;

const COMPOSE_EMAIL_TOOLS = [
  {
    name: 'compose_email',
    description: `Send ONE new email (not a reply) to ONE person: the Email page's Compose and Send, from the office mailbox. The first call returns a PREVIEW and sends nothing: To (name and address), From, the subject, the exact body, and what the send does. The operator approves on the confirmation card; the confirmed run re-checks the recipient, subject and body and refuses if anything changed, then sends exactly what the card showed.
Effects: one email goes to the recipient as a new thread from the office address. It is plain text, sent as written: no signature, attachment, tracking link or unsubscribe link is added. It cannot be unsent. No copy is saved or linked to the customer; it appears in the Gmail Sent folder. No opt-out or suppression check runs (the Email page's Send runs none either). Portal links to a customer's account (appointment, report, receipt, payment, estimate links) are refused in the body.
One recipient, plain text only: no CC or BCC, no attachments, no lists or bulk sends. To answer an existing email use draft_email_reply and send_email_reply; to text a customer use send_sms. Every send needs the operator's approval on the card, the owner's included.
Give customer_id (the customer's email on file is used) OR email_address (any address the operator named), plus subject and body. Find a customer with query_customers first. Write the body as the operator asked; do not add a signature or invent facts. Keep it SHORT, the owner's rule for customer emails: a greeting, the answer in one or two sentences, any ask as one question. No recap of the history, no apology paragraph. The body is at most ${BODY_MAX} characters; a longer one is refused and no card is offered. Refused with the reason: customer not found or no email on file, an invalid address, an empty subject or body, a body or subject that is too long, a portal link in the body.
Use for: "email Sam Sample about tomorrow's visit", "send an email to office@vendor.example asking for a quote", "write a new email to this customer", "email the property manager".`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The customer to email at their email on file (use instead of email_address)' },
        email_address: { type: 'string', description: 'The one address to email, e.g. office@vendor.example (use instead of customer_id)' },
        subject: { type: 'string', description: `The subject line, plain text, up to ${SUBJECT_MAX} characters` },
        body: { type: 'string', description: `The email body, plain text, at most ${BODY_MAX} characters (a few short lines: a greeting, the answer in one or two sentences, any ask as one question), exactly as it should be sent` },
      },
      required: ['subject', 'body'],
    },
    _sideEffects: true,
  },
];

const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
// One address: no whitespace, angle brackets, commas, semicolons, quotes, parentheses or brackets, so the To header can
// only ever name the one carded mailbox.
const ADDRESS_RE = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
 
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const fullName = (c) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.company_name || null;

// The recipient the call names: exactly one of customer_id / email_address. A customer's address is the email on file; a
// typed address is shown with the customer it matches, when exactly one does.
async function resolveRecipient(input, database) {
  const rawId = String(input?.customer_id || '').trim().toLowerCase();
  const rawAddress = String(input?.email_address || '').trim().toLowerCase();
  if (Boolean(rawId) === Boolean(rawAddress)) return refusal('Give exactly one of customer_id or email_address', 'invalid_target');
  if (rawId) {
    if (!UUID_RE.test(rawId)) return refusal('A valid customer_id is required', 'invalid_target');
    const customer = await database('customers').where({ id: rawId }).whereNull('deleted_at').first('id', 'first_name', 'last_name', 'company_name', 'email');
    if (!customer) return refusal('Customer not found. Nothing was sent.', 'customer_not_found');
    const address = String(customer.email || '').trim().toLowerCase();
    if (!address) return refusal(`${fullName(customer) || 'This customer'} has no email on file, so nothing was sent. Add the address on the customer page, or give email_address.`, 'no_email_on_file');
    if (!ADDRESS_RE.test(address)) return refusal(`The email on file for ${fullName(customer) || 'this customer'} is not a usable address, so nothing was sent. Fix it on the customer page.`, 'invalid_address');
    return { address, customerId: customer.id, name: fullName(customer), matches: 1 };
  }
  if (!ADDRESS_RE.test(rawAddress) || rawAddress.length > 254) return refusal('That is not one valid email address. Give a single address, such as name@example.com.', 'invalid_address');
  const owners = await database('customers').whereRaw('LOWER(email) = ?', [rawAddress]).whereNull('deleted_at').limit(3).select('id', 'first_name', 'last_name', 'company_name');
  if (owners.length === 1) return { address: rawAddress, customerId: owners[0].id, name: fullName(owners[0]), matches: 1 };
  return { address: rawAddress, customerId: null, name: null, matches: owners.length };
}

function normalizedContent(input) {
  const subject = String(input?.subject ?? '').trim();
  const body = String(input?.body ?? '').replace(/\r\n?/g, '\n').trim();
  if (!subject) return refusal('A subject is required', 'invalid_subject');
  if (subject.length > SUBJECT_MAX || CONTROL_RE.test(subject)) return refusal(`The subject must be one line of at most ${SUBJECT_MAX} characters`, 'invalid_subject');
  if (!body) return refusal('The body is empty, so nothing was proposed', 'invalid_body');
   
  if (body.length > BODY_MAX) return refusal(`The body is ${body.length} characters; the limit is ${BODY_MAX}. Shorten it to a few short lines: a greeting, the answer in one or two sentences, and any ask as one question. No recap of the history and no apology paragraph. Nothing was proposed.`, 'invalid_body');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) return refusal('The body must be plain text without control characters', 'invalid_body');
  return { subject, body };
}

function planEffects({ toLabel, from, linked }) {
  return [
    { kind: 'comms', text: `One new email goes to ${toLabel} from ${from}. It starts a new thread; it is not a reply.` },
    { kind: 'comms', text: 'It is sent as plain text, exactly as shown. No signature, attachment, tracking link or unsubscribe link is added.' },
    { kind: 'operational', text: 'No opt-out or suppression check runs before it goes (the Email page\'s Send runs none either).' },
    { kind: 'operational', text: 'Portal links to a customer\'s account (appointment, report, receipt, payment or estimate links) are refused in the body.' },
    { kind: 'operational', text: 'No copy is saved or linked to the customer. The message appears in the Gmail Sent folder.' },
    { kind: 'operational', text: 'If Gmail does not confirm the send, the result is reported as unknown and nothing is retried: check the Gmail Sent folder.' },
    linked ? { kind: 'customer', text: 'The address belongs to a customer on file, so this is customer contact.' } : null,
  ].filter(Boolean);
}

async function buildPlan(input, { database = db } = {}) {
  const content = normalizedContent(input);
  if (content.error) return content;
  const recipient = await resolveRecipient(input, database);
  if (recipient.error) return recipient;
  // The same read-only 'email' phase link check send_email_reply runs, on the body as the mail client renders it.
  const linkRefusal = await require('./email-tools').sendEmailReplyProposalRefusal({ body: content.body });
  if (linkRefusal) return linkRefusal;

  const from = require('../email/gmail-client').fromHeader();
  const linked = Boolean(recipient.customerId);
  const toLabel = recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address;
  const owners = recipient.matches > 1 ? `${recipient.matches} customers share this address` : null;
  return {
    preview: true,
    tool: 'compose_email',
    // The card's recipient: name and address, and the customer when one is on file.
    pinned_recipient: { name: recipient.name, email: recipient.address, customer_id: recipient.customerId, linked_customer: linked },
    to_label: toLabel,
    to_note: linked ? 'a customer on file' : (owners || 'not a customer on file'),
    from,
    subject: content.subject,
    body: content.body,
    body_chars: content.body.length,
    effects: planEffects({ toLabel, from, linked }),
    sends_to_customer: linked,
    // What the confirm re-checks: the recipient, the From, the subject and a digest of the exact body.
    _version: {
      to: recipient.address,
      customer_id: recipient.customerId,
      customer_name: recipient.name,
      customer_matches: recipient.matches,
      from,
      subject: content.subject,
      body_digest: digest(content.body),
    },
    note: 'PREVIEW ONLY — nothing was sent. Confirm sends exactly this email; if anything changed it refuses.',
  };
}

async function verifiedPlan(input, pinned) {
  if (!pinned) return { refusal: refusal('Use the confirmation card to approve sending this email.', 'approval_required') };
  const plan = await buildPlan(input);
  if (plan.error) return { refusal: { ...plan, error: `Nothing was sent: ${plan.error}`, preview_changed: true } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: 'The recipient, subject or body changed after the card was shown, so nothing was sent. Ask again for a fresh confirmation card.', code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

// Operations this process has already started (a double Confirm that somehow passed the atomic claim). Bounded.
const STARTED = new Set();
function firstRun(operationId) {
  if (!operationId) return true;
  if (STARTED.has(operationId)) return false;
  STARTED.add(operationId);
  if (STARTED.size > 500) STARTED.delete(STARTED.values().next().value);
  return true;
}

async function commitCompose(input, actionContext) {
  const { plan, refusal: refused } = await verifiedPlan(input, input._verified_compose_email_version);
  if (refused) return refused;
  if (!firstRun(actionContext?.operationId)) {
    return refusal('This email was already sent by this confirmation. Nothing was sent again. Check the Gmail Sent folder.', 'duplicate_confirm', { failed: true });
  }
  const { sendEmailMessage, encodeEmailBody } = require('../email/send-message');
  let reply;
  try {
    reply = await sendEmailMessage({ to: plan.pinned_recipient.email, subject: plan.subject, body: encodeEmailBody(plan.body) });
  } catch (err) {
    logger.error(`[intelligence-bar:compose-email] send threw (${err?.code || err?.name || 'error'})`);
    return { outcome_unknown: true, code: 'execution_interrupted', warning: 'The send was interrupted: Gmail may or may not have sent it. Check the Gmail Sent folder before creating another email.' };
  }
  if (reply.status === 200 && reply.json?.messageId) {
    // Internal ids only: the recipient address stays out of logs.
    logger.info(`[intelligence-bar:compose-email] Sent new email: ${reply.json.messageId}`);
    return {
      success: true,
      state: 'provider_accepted',
      providerMessageId: reply.json.messageId,
      message_id: reply.json.messageId,
      sent_to: plan.pinned_recipient.email,
      subject: plan.subject,
      sent_to_customer: plan.sends_to_customer,
    };
  }
  if (reply.status === 202) {
    return { outcome_unknown: true, warning: 'Gmail did not confirm the send. Check the Gmail Sent folder before creating another email.' };
  }
  return { failed: true, code: 'send_not_accepted', error: 'Gmail did not accept the email, so nothing was sent. Try again.' };
}

// ── card lines (authorization-contract.js) ──────────────────────

const oneLine = (text, max) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

function cardLines(toolName, preview) {
  if (toolName !== 'compose_email' || !preview || preview.preview !== true) return [];
  const contact = preview.pinned_recipient?.linked_customer === true;
  const exact = preview.body;
  const fitsOneLine = exact.length <= CARD_LINE_CHARS && !exact.includes('\n');
  return [
    { kind: 'comms', text: `To: ${preview.to_label} (${preview.to_note})` },
    { kind: 'comms', text: `From: ${preview.from}` },
    { kind: 'comms', text: `Subject: ${preview.subject}` },
    { kind: 'comms', text: fitsOneLine ? `Body: ${exact}` : `Body (${preview.body_chars} characters): ${oneLine(exact, CARD_LINE_CHARS)}` },
    // The whole body, exactly as sent, under "Show more" when it does not fit on the card.
    ...(fitsOneLine ? [] : [{ kind: 'comms', text: `Full body, exactly as sent:\n${exact}`, more: true }]),
    ...(preview.effects || []).map(({ kind, text }) => ({ kind: kind === 'customer' && !contact ? 'operational' : kind, text })),
  ];
}

async function executeComposeEmailTool(toolName, input = {}, actionContext = {}) {
  if (!COMPOSE_EMAIL_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the Email routes (requireAdmin); the confirmed run needs a positive admin flag.
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Sending an email is limited to admin accounts', 'permission_denied');
  }
  if (!composeEmailLive()) return refusal('Composing an email from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitCompose(input, actionContext) : await buildPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:compose-email] ${toolName} failed (${err?.code || err?.name || 'error'})`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', warning: 'The send was interrupted: Gmail may or may not have sent it. Check the Gmail Sent folder before creating another email.' }
      : { error: 'Could not prepare the email' };
  }
}

module.exports = {
  COMPOSE_EMAIL_TOOLS,
  executeComposeEmailTool,
  composeEmailLive,
  cardLines,
  buildPlan,
};
