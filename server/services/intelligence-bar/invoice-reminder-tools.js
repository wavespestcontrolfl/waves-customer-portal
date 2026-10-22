/**
 * Intelligence Bar — invoice reminders and scheduled sends
 * server/services/intelligence-bar/invoice-reminder-tools.js
 *
 * Cards that replay the Invoices page's own handlers, in process (admin-invoices.js followupControlFromBar,
 * sendReminderNowFromBar, scheduleSendFromBar), so every refusal and rule is the route's own. Dark behind
 * GATE_IB_INVOICE_REMINDERS (which needs GATE_IB_PLATFORM). Always a confirm card (write-gates.js two-step), admin only,
 * never owner-direct, platform path only. No refund, no charge, no invoice edit.
 *
 *   pause_invoice_reminders  — the follow-up panel "Pause"  (POST /admin/invoices/:id/followup/pause).  Sends nothing.
 *   resume_invoice_reminders — the panel "Resume"           (POST .../followup/resume).                 Sends nothing now;
 *                              the next reminder goes out on its normal schedule, and one that is already due can go out
 *                              at the next reminder run (the card says so).
 *   stop_invoice_reminders   — the panel "Stop"             (POST .../followup/stop).                   Sends nothing.
 *   send_invoice_reminder_now — the panel "Send next now"   (POST .../followup/send-now).  SENDS: external_action. The card
 *                              shows each channel, the masked recipient and the exact message; the handler keeps its own
 *                              opt-out, collections-policy, dedupe and dispute-hold rules. The bar adds: only inside the
 *                              8 AM to 8 PM ET text window, never for a customer on combined reminders, a payer-billed
 *                              invoice, a paused reminder, a reminder that would also draw account credit, or a text with
 *                              alternate wordings (the exact text could not be shown).
 *   schedule_invoice_send    — "Schedule send"              (POST /admin/invoices/:id/schedule-send).   external_action: the
 *                              invoice goes out later by the scheduler. The card shows the Eastern time, the channels and
 *                              the masked recipients.
 *
 *   unconfirmed -> a PREVIEW: nothing is written or sent. Its `_version` pins what the card showed (invoice edit time and
 *                  status, the reminder row, the recipients, the message text).
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then runs the handler. send-now and
 *                  schedule-send also hand the handler the invoice edit time (and the reminder step) the card showed, and the
 *                  handler refuses 409 PREVIEW_CHANGED on a difference (schedule-send inside its own UPDATE).
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { maskPhone, maskEmail } = require('./closeout-repair-tools');
const { approvalDigest, phoneKey, emailKey } = require('../../utils/approval-digest');

function invoiceRemindersLive() {
  return require('../../config/feature-gates').ibInvoiceRemindersLive() === true;
}

const TARGET_PROPS = {
  invoice_id: { type: 'string', format: 'uuid', description: 'The existing invoice (from get_customer_invoices)' },
  invoice_number: { type: 'string', description: 'The invoice number, e.g. WPC-2026-0534 (use instead of invoice_id)' },
};
const REASON_PROP = { type: 'string', maxLength: 200, description: 'Why (optional; staff-only note kept on the reminder)' };

const INVOICE_REMINDER_TOOLS = [
  {
    name: 'pause_invoice_reminders',
    description: `Pause ONE invoice's automatic payment reminders: the Invoices page follow-up panel "Pause". The first call returns a PREVIEW and changes nothing. The operator approves on the confirmation card; the confirmed run re-checks it and refuses if anything changed.
Effect: no further reminder goes out for this invoice until it is resumed. Nothing is sent to the customer. Only an active reminder sequence can be paused. Refused with the reason: no reminders on the invoice, already paused or stopped, a paid or void invoice, a customer on combined reminders, a reminder being sent right now. Admin only.
Takes invoice_id OR invoice_number, exactly one, and an optional short reason.
Use for: "pause the reminders on this invoice", "hold off on dunning invoice WPC-2026-0534", "she said she'd pay Friday, stop the reminders for now".`,
    input_schema: { type: 'object', properties: { ...TARGET_PROPS, reason: REASON_PROP } },
    _sideEffects: true,
  },
  {
    name: 'resume_invoice_reminders',
    description: `Resume ONE invoice's paused payment reminders: the Invoices page follow-up panel "Resume". The first call returns a PREVIEW and changes nothing. The operator approves on the confirmation card; the confirmed run re-checks it and refuses if anything changed.
Effect: the reminder sequence is active again. Nothing is sent now; the next reminder goes out on its normal schedule, and one that is already due can go out at the next reminder run. Only a paused sequence can be resumed (a stopped sequence cannot). Refused with the reason: no reminders on the invoice, not paused, a paid or void invoice, a customer on combined reminders, an Auto Pay hold. Admin only.
Takes invoice_id OR invoice_number, exactly one.
Use for: "resume the reminders on this invoice", "turn the dunning back on for WPC-2026-0534".`,
    input_schema: { type: 'object', properties: { ...TARGET_PROPS } },
    _sideEffects: true,
  },
  {
    name: 'stop_invoice_reminders',
    description: `Stop ONE invoice's automatic payment reminders for good: the Invoices page follow-up panel "Stop". The first call returns a PREVIEW and changes nothing. The operator approves on the confirmation card; the confirmed run re-checks it and refuses if anything changed.
Effect: no further reminder goes out for this invoice, and a stopped sequence is not restarted from the bar. Nothing is sent to the customer. Refused with the reason: no reminders on the invoice, already stopped, a paid or void invoice, a customer on combined reminders, a reminder being sent right now. Admin only.
Takes invoice_id OR invoice_number, exactly one, and an optional short reason.
Use for: "stop the reminders on this invoice", "waive the dunning for WPC-2026-0534", "customer disputed it, no more reminders".`,
    input_schema: { type: 'object', properties: { ...TARGET_PROPS, reason: REASON_PROP } },
    _sideEffects: true,
  },
  {
    name: 'send_invoice_reminder_now',
    description: `Send ONE invoice's NEXT payment reminder to the customer right now: the Invoices page follow-up panel "Send next now". This TEXTS and/or EMAILS the customer. The first call returns a PREVIEW and sends nothing: the step, each channel, who it reaches (masked) and the exact message. The operator approves on the confirmation card; the confirmed run re-checks all of it, refuses if anything changed, and reports whether anything went out.
The handler keeps its own rules: a leg is not sent if the customer opted out, the collections policy blocks it, or that step was already delivered. Refused with the reason: no active reminder sequence, a paid or void invoice, outside 8 AM to 8 PM Eastern, a customer on combined reminders, a payer-billed invoice, a paused or stopped reminder, a collections hold, account credit that would be applied first, a pending bank verification, a reminder text with alternate wordings, nothing due, no phone and no email. Admin only.
Takes invoice_id OR invoice_number, exactly one.
Use for: "send the next reminder now", "remind her about invoice WPC-2026-0534 today", "push the reminder out".`,
    input_schema: { type: 'object', properties: { ...TARGET_PROPS } },
    _sideEffects: true,
  },
  {
    name: 'schedule_invoice_send',
    description: `Schedule ONE unsent invoice (a draft, or one already scheduled) to be sent to the customer at a set Eastern time: the Invoices page "Schedule send". Nothing is sent now; the invoice scheduler sends it at that time as the Send button would (the pay-link text and the invoice email, following the customer's delivery choices and the 8 AM to 8 PM text window). The first call returns a PREVIEW and changes nothing: the time (ET), the channels and who it reaches (masked). The operator approves on the confirmation card; the confirmed run re-checks it and refuses if anything changed.
No review request is asked for. Refused with the reason: not a draft or scheduled invoice, a time that is not in the future, billed to a payer or a payer's monthly statement, nothing due, no phone and no email. Admin only.
Takes invoice_id OR invoice_number (exactly one) and send_at_et, the Eastern wall-clock time as YYYY-MM-DDTHH:MM.
Use for: "schedule invoice WPC-2026-0534 for Monday 9 AM", "send this invoice tomorrow morning".`,
    input_schema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        send_at_et: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$', description: 'Eastern wall-clock time to send, YYYY-MM-DDTHH:MM (24-hour)' },
      },
    },
    _sideEffects: true,
  },
];

const money = (value) => `$${(Math.round((Number(value) || 0) * 100) / 100).toFixed(2)}`;
const cents = (value) => Math.round((Number(value) || 0) * 100);
const msOf = (value) => (value ? new Date(value).getTime() : null);
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const toPage = (error, code, invoiceId) => refusal(`${error} Use the Invoices page for this one.`, code, { invoice_id: invoiceId });
const flat = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function etWhen(value) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return 'an unknown time';
  const { formatETDate, formatETTime } = require('../../utils/datetime-et');
  return `${formatETDate(at)} ${formatETTime(at)} ET`;
}

async function customerName(customerId) {
  const c = await db('customers').where({ id: customerId }).first('first_name', 'last_name', 'company_name');
  return [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.company_name || null;
}

// The invoice the call names: exactly one of id / number.
async function resolveInvoice(input) {
  const rawId = String(input?.invoice_id || '').trim();
  const rawNumber = String(input?.invoice_number || '').trim();
  if (Boolean(rawId) === Boolean(rawNumber)) return refusal('Give exactly one of invoice_id or invoice_number', 'invalid_target');
  if (rawId && !UUID_RE.test(rawId)) return refusal('A valid invoice_id is required', 'invalid_target');
  const invoice = rawId
    ? await db('invoices').where({ id: rawId.toLowerCase() }).first()
    : await db('invoices').where({ invoice_number: rawNumber.toUpperCase() }).first();
  return invoice ? { invoice } : refusal('Invoice not found', 'invoice_not_found');
}

// Who owes the invoice RIGHT NOW (invoice-payer-ownership.js, the live Bill-To resolver, not the snapshot columns). Only a
// verified customer-owned invoice goes on; a payer-owned one, or an answer that cannot be verified, is refused (fail closed).
async function ownerRefusal(invoice) {
  const { invoiceWithdrawnFromCustomer } = require('../invoice-helpers');
  if (invoice.payer_id || invoiceWithdrawnFromCustomer(invoice)) {
    return toPage('This invoice is billed to a payer, not the customer.', 'payer_owned', invoice.id);
  }
  let verdict;
  try {
    verdict = await require('../invoice-payer-ownership').invoicePayerOwnership(invoice, db);
  } catch {
    verdict = 'payer_unverifiable';
  }
  if (verdict === null) return null;
  return verdict === 'payer_owned'
    ? toPage('This invoice is billed to a payer, not the customer.', 'payer_owned', invoice.id)
    : refusal('The bar could not verify who owes this invoice, so nothing was offered. Use the Invoices page for this one.', 'unverified', { invoice_id: invoice.id });
}

// ── reminder controls: pause / resume / stop ───────────────────────────

const CONTROLS = {
  pause_invoice_reminders: { control: 'pause', allowed: ['active'], verb: 'pause', done: ['paused'] },
  resume_invoice_reminders: { control: 'resume', allowed: ['paused'], verb: 'resume', done: ['active', 'autopay_hold', 'completed'] },
  stop_invoice_reminders: { control: 'stop', allowed: ['active', 'paused'], verb: 'stop', done: ['stopped'] },
};

// The reminder row and whether the customer is on combined reminders (the panel's own two reads).
async function reminderState(invoice) {
  const Wiring = require('../customer-dunning/wiring');
  const seq = await db('invoice_followup_sequences').where({ invoice_id: invoice.id }).first();
  const combined = seq
    ? await Wiring.customerScheduleSummary(seq.customer_id)
    : await Wiring.customerScheduleSummaryForInvoice(invoice.id);
  return { seq, combined };
}

const seqVersion = (seq) => (seq ? {
  id: seq.id,
  status: seq.status,
  step_index: seq.step_index,
  next_touch_at: msOf(seq.next_touch_at),
  touches_sent: Number(seq.touches_sent) || 0,
  in_flight: Boolean(seq.touch_claimed_at),
} : null);

// A reminder the bar may not resume: held for a payer (Bill-To withdrawal pauses it with the payer's debt, and a resume would
// clear that hold), or an invoice that is not the customer's own.
async function resumeOwnerRefusal(invoice, seq) {
  if (/payer/i.test(String(seq.paused_reason || ''))) {
    return toPage('These reminders are held because the invoice is billed to a payer.', 'payer_owned', invoice.id);
  }
  return ownerRefusal(invoice);
}

const STATE_WORDS = { pause: 'paused', resume: 'resumed', stop: 'stopped', send: 'sent now' };

// The refusal for a reminder row the card cannot act on, or null.
function sequenceRefusal(invoice, seq, combined, { statuses, what }) {
  const at = invoice.id;
  if (combined) return toPage('This customer is on combined reminders (one reminder for all their open invoices).', 'combined_reminders', at);
  if (!seq) return refusal(`Invoice ${invoice.invoice_number} has no automatic reminders to ${what}.`, 'no_reminders', { invoice_id: at });
  if (seq.touch_claimed_at) {
    return refusal('A reminder for this invoice is being sent right now. Wait a minute, then ask again.', 'send_in_progress', { invoice_id: at });
  }
  if (statuses.includes(seq.status)) return null;
  const hint = seq.status === 'autopay_hold' ? ' (held for Auto Pay; use the Invoices page)' : '';
  return refusal(`The reminders on invoice ${invoice.invoice_number} are ${seq.status.replace('_', ' ')}${hint}, so they cannot be ${STATE_WORDS[what]} from the bar.`, 'wrong_reminder_state', { invoice_id: at, reminder_status: seq.status });
}

// The refusals every reminder card shares, or { invoice, seq, steps }.
async function loadReminderTarget(input, { statuses, what }) {
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const FollowUps = require('../invoice-followups');
  if (FollowUps.isTerminalInvoice(invoice)) {
    return refusal(`Invoice ${invoice.invoice_number} is ${String(invoice.status).toLowerCase()}, so its reminders are finished.`, 'invoice_terminal', { invoice_id: invoice.id });
  }
  let state;
  try {
    state = await reminderState(invoice);
  } catch (err) {
    logger.warn(`[intelligence-bar:invoice-reminders] reminder read failed (${err.code || err.name || 'error'})`);
    return refusal('The bar could not read this invoice’s reminders, so nothing was offered. Use the Invoices page for this one.', 'unverified', { invoice_id: invoice.id });
  }
  const { seq, combined } = state;
  const refused = sequenceRefusal(invoice, seq, combined, { statuses, what });
  if (refused) return refused;
  const held = what === 'resume' ? await resumeOwnerRefusal(invoice, seq) : null;
  if (held) return held;
  return { invoice, seq, steps: FollowUps.followupSteps() };
}

function cleanReason(input) {
  const reason = flat(input?.reason).slice(0, 200);
  return reason || null;
}

// What each control does, for the card.
function pauseEffects({ invoice, seq, stepLabel }) {
  const due = stepLabel && seq.next_touch_at ? ` The next one (${stepLabel}) was due ${etWhen(seq.next_touch_at)}.` : '';
  return [{ kind: 'operational', text: `Automatic reminders for invoice ${invoice.invoice_number} stop going out until they are resumed.${due}` }];
}

function stopEffects({ invoice }) {
  const effects = [{ kind: 'operational', text: `All remaining automatic reminders for invoice ${invoice.invoice_number} stop for good. The bar cannot restart a stopped reminder sequence.` }];
  if (invoice.stripe_payment_intent_id) {
    effects.push({ kind: 'billing', text: 'If this invoice is part of another invoice’s combined card payment that is still unpaid, the bar does not stop it (that would cancel the payment session): it refuses and leaves the stop to the Invoices page.' });
  }
  return effects;
}

function resumeEffects({ invoice, seq, stepLabel }) {
  const FollowUps = require('../invoice-followups');
  const next = FollowUps.computeNextTouchAt(seq.anchor_at || invoice.sent_at || invoice.sms_sent_at || invoice.created_at, seq.step_index);
  const effects = [];
  if (!next) {
    effects.push({ kind: 'operational', text: `Every reminder step has already been used on invoice ${invoice.invoice_number}, so resuming marks its reminders finished.` });
  } else {
    effects.push({ kind: 'operational', text: `Automatic reminders for invoice ${invoice.invoice_number} start again. The next one (${stepLabel || `step ${seq.step_index + 1}`}) is due ${etWhen(next)}.` });
    if (next.getTime() <= Date.now()) {
      effects.push({ kind: 'comms', text: 'That time has already passed, so the reminder can go out to the customer at the next reminder run (within minutes), not at a time you pick.' });
    }
  }
  if (seq.is_autopay_held) effects.push({ kind: 'operational', text: 'These reminders carry an Auto Pay hold: if the customer is still on Auto Pay they return to that hold instead of becoming active.' });
  return effects;
}

const CONTROL_EFFECTS = { pause: pauseEffects, stop: stopEffects, resume: resumeEffects };

async function buildControlPlan(toolName, input) {
  const spec = CONTROLS[toolName];
  const loaded = await loadReminderTarget(input, { statuses: spec.allowed, what: spec.verb });
  if (loaded.error) return loaded;
  const { invoice, seq, steps } = loaded;
  const reason = spec.control === 'resume' ? null : cleanReason(input);
  const effects = [
    ...CONTROL_EFFECTS[spec.control]({ invoice, seq, stepLabel: steps[seq.step_index]?.label || null }),
    { kind: 'comms', text: spec.control === 'resume' ? 'Nothing is sent right now.' : 'Nothing is sent to the customer or anyone else.' },
  ];
  return {
    preview: true,
    tool: toolName,
    control: spec.control,
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: await customerName(invoice.customer_id),
    status: invoice.status,
    reminder_status: seq.status,
    reason,
    effects,
    sends_to_customer: false,
    _body: reason ? { reason } : {},
    _approved: { sequenceId: seq.id, status: seq.status, stepIndex: seq.step_index },
    _version: {
      tool: toolName,
      invoice_id: invoice.id,
      status: invoice.status,
      updated_at: msOf(invoice.updated_at),
      total: cents(invoice.total),
      credit_applied: cents(invoice.credit_applied),
      customer_id: invoice.customer_id || null,
      payer_id: invoice.payer_id || null,
      payment_intent: invoice.stripe_payment_intent_id || null,
      reminder: seqVersion(seq),
      reason: reason || null,
    },
    note: 'PREVIEW ONLY — nothing was changed. Confirm applies exactly this; if anything changed it refuses.',
  };
}

// The re-derived plan when it still matches the card's pin, or the refusal.
async function verifiedPlan(build, pinned, what) {
  if (!pinned) return { refusal: refusal(`Use the confirmation card to approve this ${what}.`, 'approval_required') };
  const plan = await build();
  if (plan.error) return { refusal: { error: `Nothing was changed: ${plan.error}`, code: plan.code, preview_changed: true, ...(plan.code === 'by_owner_rule' ? { reason: plan.reason } : {}) } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: `The invoice or its reminders changed after the card was shown, so nothing was ${what === 'send' ? 'sent' : 'changed'}. Ask again for a fresh confirmation card.`, code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

async function readReminder(invoiceId) {
  return db('invoice_followup_sequences').where({ invoice_id: invoiceId }).first('status', 'step_index', 'touches_sent', 'last_touch_at');
}

// The handler threw. Read the reminder back: only a visible new state is reported as done.
async function controlThrown(spec, plan, base, err) {
  const now = await readReminder(plan.invoice_id).catch(() => null);
  if (now && spec.done.includes(now.status)) {
    return { ...base, success: true, reminder_status: now.status, sent_to_customer: false, warning: true,
      note: `The reminders on invoice ${plan.invoice_number} are now ${now.status.replace('_', ' ')}, but the Invoices page reported a problem. Check the invoice.` };
  }
  logger.error(`[intelligence-bar:invoice-reminders] ${spec.control} handler failed (${err.code || err.name || 'error'})`);
  return { ...base, outcome_unknown: true, code: 'execution_interrupted',
    error: `The ${spec.verb} was interrupted — it may or may not have happened. Check the invoice’s reminders before trying again.` };
}

// The handler's refusal, in the tool's words, or null for a 200.
function controlRefusal({ status, json }, base) {
  const code = json?.code;
  if (status === 409 && code === 'PREVIEW_CHANGED') {
    return { ...base, failed: true, code: 'preview_changed', preview_changed: true, error: `Nothing was changed: ${json.error}` };
  }
  if (status === 409 && code === 'NEEDS_INVOICES_PAGE') {
    return { ...base, failed: true, code: 'needs_invoices_page', error: `Nothing was changed: ${json.error} Stop it from the Invoices page.` };
  }
  if (status === 200) return null;
  return { ...base, failed: true, code: status === 404 ? 'not_found' : 'reminder_refused', error: `The reminders were not changed: ${json?.error || 'the Invoices page refused it'}` };
}

async function commitControl(toolName, input, actionContext) {
  const spec = CONTROLS[toolName];
  const { plan, refusal: refused } = await verifiedPlan(() => buildControlPlan(toolName, input), input._verified_invoice_reminder_version, spec.verb);
  if (refused) return refused;
  const base = { invoice_id: plan.invoice_id, invoice_number: plan.invoice_number, customer_id: plan.customer_id };
  let result;
  try {
    result = await require('../../routes/admin-invoices').followupControlFromBar({
      invoiceId: plan.invoice_id, control: spec.control, body: plan._body, actor: { technicianId: actionContext?.technicianId || null },
      approved: plan._approved,
    });
  } catch (err) {
    return controlThrown(spec, plan, base, err);
  }
  const refusedByHandler = controlRefusal(result, base);
  if (refusedByHandler) return refusedByHandler;
  const now = await readReminder(plan.invoice_id).catch(() => null);
  if (!now || !spec.done.includes(now.status)) {
    return { ...base, outcome_unknown: true, code: 'reminder_unverified',
      error: 'The Invoices page answered, but the reminders do not read as changed. Check the invoice before trying again.' };
  }
  logger.info(`[intelligence-bar:invoice-reminders] ${spec.control} reminders on ${plan.invoice_id}`);
  const word = { pause: 'paused', resume: 'active again', stop: 'stopped' }[spec.control];
  return { ...base, success: true, reminder_status: now.status, sent_to_customer: false,
    note: `The reminders on invoice ${plan.invoice_number} are ${now.status === 'completed' ? 'finished (every step was used)' : word}. Nothing was sent to anyone.` };
}

// ── send_invoice_reminder_now ──────────────────────────────────

// The text of one reminder step as the card shows it and the service pins it (invoice-followups renderApprovalSmsBody: base
// wording, the pay link as a token). Alternate wordings (A/B variants) make the exact text unknowable, so they refuse.
async function reminderSmsBody(step, ctx) {
  const FollowUps = require('../invoice-followups');
  if (!step.template_key) return { body: null };
  const variants = await require('../sms-template-variants').activeVariants(step.template_key);
  if (variants.length) return { varies: true };
  return { body: (await FollowUps.renderApprovalSmsBody(step, ctx)) || null };
}

const PAY_LINK_TOKEN = '[pay link]';
const lowerEmail = emailKey;
const digitsOf = phoneKey;

// The email leg as the card shows it. `recipientEmail` is the address the service pins whether or not a template exists. The
// payload is built by the same function the send uses (invoice-followups followupEmailPayload) and the card pins the digest of
// the whole rendered email, which the send re-renders and compares (a changed greeting, amount or wording refuses the leg).
async function reminderEmail(step, customer, invoice) {
  const FollowUps = require('../invoice-followups');
  const { recipient, to, refusal: noRecipient } = await require('../billing-email-sender').operatorEmailRecipient(customer, 'ib-invoice-reminders');
  const recipientEmail = noRecipient ? null : lowerEmail(to);
  const templateKey = FollowUps.FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID[step.id];
  if (!templateKey) return { none: 'this step has no email', recipientEmail };
  if (noRecipient) return { none: 'no usable email is on file', recipientEmail };
  const { formatDateOnly } = require('../../utils/date-only');
  const payload = FollowUps.followupEmailPayload({
    recipient, customer, invoice,
    invoiceTitle: invoice.title || 'your service',
    invoiceNumber: invoice.invoice_number || '',
    serviceDateClause: invoice.service_date ? ` completed on ${formatDateOnly(invoice.service_date, { fallback: '' })}` : '',
    payUrl: PAY_LINK_TOKEN,
  });
  const fingerprint = await FollowUps.renderedEmailFingerprint(templateKey, payload);
  if (!fingerprint) return { none: 'the email template is not set up', recipientEmail };
  return { to, recipientEmail, templateKey, subject: fingerprint.subject, text: fingerprint.text, contentHash: fingerprint.contentHash, renderedDigest: fingerprint.digest };
}

// What the live customer, credit and bank state would change about the message: a refusal, or null (fail closed).
async function sendNowLiveRefusal(invoice) {
  const at = invoice.id;
  try {
    if (await require('../collections/collection-hold').customerHasActiveMessagingHoldChecked(invoice.customer_id)) {
      return refusal('This customer has a collections hold on billing messages. Send the reminder from the Invoices page if you mean to override it.', 'collection_hold', { invoice_id: at });
    }
    if (await require('../customer-credit').autoApplyWouldApply(invoice)) {
      return toPage('Account credit would be applied to this invoice before the reminder goes out, which would change the amount.', 'credit_would_apply', at);
    }
    const bankCheck = require('../../config/feature-gates').gates.divertMicrodepositDunning && invoice.stripe_payment_intent_id;
    if (bankCheck && await require('../stripe').isInvoiceAwaitingMicrodepositVerification(invoice, { throwOnError: true })) {
      return toPage('This invoice is waiting on the customer’s bank verification, so the reminder text differs.', 'bank_verification', at);
    }
  } catch (err) {
    logger.warn(`[intelligence-bar:invoice-reminders] send-now check failed (${err.code || err.name || 'error'})`);
    return refusal('The bar could not check the customer’s hold, credit or bank verification, so nothing was offered. Use the Invoices page for this one.', 'unverified', { invoice_id: at });
  }
  return null;
}

// Everything that must hold before a reminder is composed: { step, dueCents, customer } or a refusal.
async function sendNowGround(invoice, seq, steps) {
  const at = invoice.id;
  if (!require('../messaging/send-window').isWithinSendWindowET()) {
    return refusal('Reminders are not sent from the bar between 8 PM and 8 AM Eastern. Ask again in the morning, or use the Invoices page.', 'outside_send_window', { invoice_id: at });
  }
  const owner = await ownerRefusal(invoice);
  if (owner) return owner;
  const step = steps[seq.step_index];
  if (!step) return refusal(`Every reminder step has already been used on invoice ${invoice.invoice_number}.`, 'nothing_to_send', { invoice_id: at });
  const dueCents = cents(require('../invoice-helpers').invoiceAmountDue(invoice));
  if (dueCents <= 0) return refusal('Nothing is due on this invoice, so there is no reminder to send.', 'nothing_due', { invoice_id: at });
  const customer = await db('customers').where({ id: invoice.customer_id }).first();
  if (!customer || customer.deleted_at) return refusal('The customer record is deleted or missing, so no reminder can be sent.', 'customer_unavailable', { invoice_id: at });
  return (await sendNowLiveRefusal(invoice)) || { step, dueCents, customer };
}

// The text leg: { sms } (null when there is nothing to send) or a refusal.
async function sendNowText(invoice, step, customer, dueCents) {
  if (!customer.phone) return { sms: null };
  const { formatDateOnly } = require('../../utils/date-only');
  const rendered = await reminderSmsBody(step, {
    name: customer.first_name, invoiceTitle: invoice.title, amount: (dueCents / 100).toFixed(2),
    serviceDate: formatDateOnly(invoice.service_date, { fallback: '' }), invoiceId: invoice.id,
  });
  if (rendered.varies) {
    return refusal('This reminder text has alternate wordings, so the exact text cannot be shown on a card. Send it from the Invoices page.', 'text_varies', { invoice_id: invoice.id });
  }
  return { sms: rendered.body ? { phone: String(customer.phone), body: rendered.body } : null };
}

function sendNowEffects({ seq, step, total }) {
  return [
    { kind: 'comms', text: `Sends reminder step ${seq.step_index + 1} of ${total}${step.label ? ` (${step.label})` : ''} now, even if the schedule had it for later (it was due ${seq.next_touch_at ? etWhen(seq.next_touch_at) : 'on its schedule'}). The following reminders then move on from that step.` },
    { kind: 'comms', text: 'Each channel is sent unless the customer opted out, the collections policy blocks it, or that step was already delivered; a blocked reminder is held and nothing goes out. The 8 AM to 8 PM Eastern text window is checked again when you confirm.' },
    { kind: 'comms', text: `The pay link shown as ${PAY_LINK_TOKEN} is this invoice’s own pay link.` },
  ];
}

// The recipients and text the service re-checks at dispatch (invoice-followups approvalDrift), and the email content hash.
function sendNowApproval({ invoice, seq, customer, sms, email, dueCents }) {
  return {
    invoiceUpdatedAtMs: msOf(invoice.updated_at),
    sequenceId: seq.id,
    status: seq.status,
    stepIndex: seq.step_index,
    // The balance the text and email state: the service refuses any other amount, and never draws credit on this send.
    dueCents,
    emailContentHash: email.none ? null : email.contentHash,
    // The whole rendered email (greeting, amount, wording; the pay link as a token): the send re-renders and compares.
    emailRenderedDigest: email.none ? null : email.renderedDigest,
    // What may go out, and the exact text: the send uses this body as it is and skips a channel that is not listed.
    channels: { sms: Boolean(sms), email: !email.none },
    smsBody: sms ? sms.body : null,
    phoneDigest: approvalDigest(digitsOf(customer.phone)),
    emailDigest: approvalDigest(email.recipientEmail),
    smsDigest: sms ? approvalDigest(sms.body) : null,
  };
}

function sendNowCard({ invoice, seq, step, steps, dueCents, customer, sms, email }) {
  const stepText = `${seq.step_index + 1} of ${steps.length}${step.label ? ` (${step.label})` : ''}`;
  const noText = customer.phone ? 'the reminder text template is switched off' : 'no phone is on file';
  return {
    preview: true,
    tool: 'send_invoice_reminder_now',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    status: invoice.status,
    amount_due: money(dueCents / 100),
    step: stepText,
    channels: [sms && 'text', !email.none && 'email'].filter(Boolean).join(' and '),
    text_line: sms ? `Text to ${maskPhone(sms.phone)}: "${sms.body}" Not sent if the customer opted out of texts.` : `No text: ${noText}.`,
    email_line: email.none ? `No email: ${email.none}.` : `Email to ${maskEmail(email.to)}, subject "${email.subject}". Not sent if the customer’s email is suppressed.`,
    email_body: email.none ? null : email.text,
    effects: sendNowEffects({ seq, step, total: steps.length }),
    sends_to_customer: true,
    _approved: sendNowApproval({ invoice, seq, customer, sms, email, dueCents }),
    _version: {
      tool: 'send_invoice_reminder_now',
      invoice_id: invoice.id,
      status: invoice.status,
      updated_at: msOf(invoice.updated_at),
      due_cents: dueCents,
      customer_id: invoice.customer_id || null,
      reminder: seqVersion(seq),
      step: step.id,
      recipients: digest({ phone: sms ? digitsOf(sms.phone) : null, email: email.none ? null : email.recipientEmail }),
      sms_text: sms ? digest(sms.body) : null,
      email_text: email.none ? null : email.renderedDigest,
    },
    note: 'PREVIEW ONLY — nothing was sent. Confirm sends exactly this; if anything changed it refuses.',
  };
}

async function buildSendNowPlan(input) {
  const loaded = await loadReminderTarget(input, { statuses: ['active'], what: 'send' });
  if (loaded.error) return loaded;
  const { invoice, seq, steps } = loaded;
  const ground = await sendNowGround(invoice, seq, steps);
  if (ground.error) return ground;
  const { step, dueCents, customer } = ground;
  const text = await sendNowText(invoice, step, customer, dueCents);
  if (text.error) return text;
  let email;
  try {
    email = await reminderEmail(step, customer, invoice);
  } catch (err) {
    logger.warn(`[intelligence-bar:invoice-reminders] email preview failed (${err.code || err.name || 'error'})`);
    return refusal('The bar could not prepare the reminder email preview, so nothing was offered. Use the Invoices page for this one.', 'unverified', { invoice_id: invoice.id });
  }
  if (!text.sms && email.none) {
    const noText = customer.phone ? 'the reminder text template is switched off' : 'no phone is on file';
    return refusal(`No reminder can go out: ${noText}, and ${email.none}. Use the Invoices page for this one.`, 'invoice_no_channel', { invoice_id: invoice.id });
  }
  return { ...sendNowCard({ invoice, seq, step, steps, dueCents, customer, sms: text.sms, email }), customer_name: await customerName(invoice.customer_id) };
}

async function commitSendNow(input, actionContext) {
  const { plan, refusal: refused } = await verifiedPlan(() => buildSendNowPlan(input), input._verified_invoice_reminder_version, 'send');
  if (refused) return refused;
  const base = { invoice_id: plan.invoice_id, invoice_number: plan.invoice_number, customer_id: plan.customer_id };
  let result;
  try {
    result = await require('../../routes/admin-invoices').sendReminderNowFromBar({
      invoiceId: plan.invoice_id, actor: { technicianId: actionContext?.technicianId || null }, approvedReminder: plan._approved,
    });
  } catch (err) {
    logger.error(`[intelligence-bar:invoice-reminders] send-now handler failed (${err.code || err.name || 'error'})`);
    // A throw may follow a delivered message: never invite a retry.
    return { ...base, outcome_unknown: true, code: 'execution_interrupted',
      error: 'The reminder send was interrupted — it may or may not have gone out. Check the invoice timeline before trying again.' };
  }
  const { status, json } = result;
  if (status === 409 && json?.code === 'PREVIEW_CHANGED') {
    return { ...base, failed: true, code: 'preview_changed', preview_changed: true, error: `Nothing was sent: ${json.error}` };
  }
  if (status !== 200) {
    return { ...base, failed: true, code: status === 409 ? 'reminder_refused' : 'send_failed', error: `The reminder was not sent: ${json?.error || 'the Invoices page refused it'}` };
  }
  return sendNowOutcome(base, plan, json?.reminder);
}

// What each channel did, in the operator's words. The handler reports per-leg states (invoice-followups.js emailLegReport and
// the text branch of fireTouch); "sent" is a new delivery, and an unreadable or uncertain leg is "unknown", never "not sent".
const LEG_REASONS = {
  collections_policy_denied: 'held by the collections policy',
  collection_hold: 'held by a collections hold',
  not_approved: 'it was not on the card',
  customer_schedule: 'the customer is on a combined reminder schedule',
  no_reminder_step: 'every reminder step was already used',
  ownership_unverified: 'who owes the invoice could not be verified',
  customer_unavailable: 'the customer record is deleted or missing',
  preferences_unavailable: 'the customer’s channel choices could not be read',
  invoice_unreadable: 'the invoice could not be read again',
  not_sent_before_dispatch: 'the reminder stopped before anything was sent',
  missing_email: 'no usable email on file',
  no_customer_phone: 'no phone on file',
  missing_template: 'the message template is switched off',
  ledger_unavailable: 'the contact record could not be written',
  template_unavailable: 'the email template is unavailable',
  billing_email_not_selected: 'the customer did not choose email for invoices',
  send_window: 'it waits for the 8 AM text window',
  invoice_not_eligible: 'the invoice is no longer eligible',
  invoice_payer_billed: 'the invoice is billed to a payer',
  email_content_changed: 'the email changed after the card was shown',
};
function legSentence(label, leg) {
  const why = leg?.reason ? (LEG_REASONS[leg.reason] || String(leg.reason).replace(/_/g, ' ')) : null;
  switch (leg?.state) {
    case 'sent': return `${label}: sent.`;
    case 'already_delivered': return `${label}: already delivered earlier, not sent again.`;
    case 'queued': return `${label}: queued${why ? ` (${why})` : ''}, not sent yet.`;
    case 'held': return `${label}: held${why ? ` (${why})` : ''}, not sent; the reminder stays on its schedule.`;
    case 'skipped': return `${label}: skipped${why ? ` (${why})` : ''}, not sent.`;
    case 'not_sent': return `${label}: not sent${why ? ` (${why})` : ''}.`;
    default: return `${label}: unknown, check the invoice timeline${why ? ` (${why})` : ''}.`;
  }
}

function sendNowOutcome(base, plan, reminder) {
  if (reminder?.notClaimed) {
    return { ...base, failed: true, code: 'reminder_busy', sent_to_customer: false,
      error: 'Nothing was sent: another run had this reminder or it changed. Check the invoice timeline, then ask again.' };
  }
  const legs = reminder?.legs;
  if (!legs?.sms || !legs?.email) {
    return { ...base, outcome_unknown: true, code: 'delivery_unknown',
      error: 'Whether the reminder went out is unknown. Check the invoice timeline before sending again.' };
  }
  const entries = [['Text', legs.sms], ['Email', legs.email]];
  const sentences = entries.map(([label, leg]) => legSentence(label, leg)).join(' ');
  const states = entries.map(([, leg]) => leg?.state);
  const sentAny = states.includes('sent');
  const legsOut = { text: legs.sms, email: legs.email };
  logger.info(`[intelligence-bar:invoice-reminders] reminder send-now on ${plan.invoice_id}: text ${states[0]}, email ${states[1]}`);
  if (states.some((state) => !['sent', 'already_delivered', 'queued', 'held', 'skipped', 'not_sent'].includes(state))) {
    return { ...base, outcome_unknown: true, code: 'delivery_unknown', sent_to_customer: sentAny, legs: legsOut,
      error: `Delivery could not be fully established. ${sentences} Check the invoice timeline before sending again.` };
  }
  if (sentAny) {
    return { ...base, success: true, sent_to_customer: true, legs: legsOut, note: `Reminder step ${plan.step}. ${sentences}` };
  }
  return { ...base, success: true, sent_to_customer: false, code: 'not_sent', legs: legsOut,
    note: `Nothing was sent to the customer. ${sentences}` };
}

// ── schedule_invoice_send ──────────────────────────────────────

// The Eastern wall-clock time the call names, as an instant: { text, when } or a refusal. Refused: a day or clock that does
// not exist (Date would roll 2099-13-45 over), a wall time the spring-forward gap skips (parseETDateTime moves it an hour),
// and a wall time the fall-back hour repeats (two instants, one wall clock: the card could not say which one sends).
function parseSendAt(input, invoiceId) {
  const invalid = (error, code = 'invalid_time') => refusal(error, code, { invoice_id: invoiceId });
  const text = String(input?.send_at_et || '').trim();
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  const [year, month, day, hour, minute] = parts ? parts.slice(1).map(Number) : [];
  const calendar = parts && new Date(Date.UTC(year, month - 1, day));
  if (!parts || calendar.toISOString().slice(0, 10) !== text.slice(0, 10) || hour > 23 || minute > 59) {
    return invalid('send_at_et must be an Eastern time like 2026-10-27T09:30');
  }
  const { parseETDateTime, etParts, etWallClockOccurrences } = require('../../utils/datetime-et');
  const when = parseETDateTime(text);
  if (Number.isNaN(when.getTime())) return invalid('send_at_et is not a valid time');
  const live = etParts(when);
  if ([live.year, live.month, live.day, live.hour, live.minute].join() !== [year, month, day, hour, minute].join()) {
    return invalid('That Eastern time does not exist (the clocks spring forward over it). Pick a time outside 2:00 to 2:59 AM that day.');
  }
  if (etWallClockOccurrences(when) !== 1) {
    return invalid('That Eastern time happens twice (the clocks fall back over it), so the send time would be ambiguous. Pick a time outside 1:00 to 1:59 AM that day.');
  }
  if (when.getTime() <= Date.now() + 2 * 60 * 1000) return invalid('The send time must be at least a few minutes in the future.', 'time_not_future');
  return { text, when };
}

function scheduleStatusRefusal(invoice, status) {
  if (['draft', 'scheduled'].includes(status)) return null;
  return refusal(`Invoice ${invoice.invoice_number} is ${status || 'not a draft'}; only a draft or an already-scheduled invoice can be scheduled.`, 'not_schedulable', { invoice_id: invoice.id });
}

// The other invoice-side refusals for scheduling, or null.
async function scheduleInvoiceRefusal(invoice) {
  const at = invoice.id;
  if (!invoice.updated_at) return refusal('This invoice cannot be pinned for approval, so nothing was offered. Use the Invoices page for this one.', 'unverified', { invoice_id: at });
  if (invoice.payer_statement_id) return refusal('Invoice is billed on the payer’s monthly statement; it cannot be scheduled for individual send.', 'payer_statement', { invoice_id: at });
  return ownerRefusal(invoice);
}

function scheduleEffects({ invoice, when, dueCents, phone, email, rescheduling }) {
  const replaces = rescheduling ? ` (it replaces the time ${etWhen(invoice.scheduled_send_at)})` : '';
  const textTo = phone ? ` to ${maskPhone(phone)}` : ' (no phone on file, so no text)';
  const emailTo = email ? ` to ${maskEmail(email)}` : ' (no email on file, so no email)';
  return [
    { kind: 'comms', text: `Nothing is sent now. The invoice scheduler sends invoice ${invoice.invoice_number} (${money(dueCents / 100)} due) at ${etWhen(when)}${replaces}.` },
    { kind: 'comms', text: `When it goes out it sends the pay-link text${textTo} and the invoice email${emailTo}, following the customer’s delivery choices at that time. The text waits for the 8 AM to 8 PM Eastern window.` },
    { kind: 'comms', text: 'No review request is asked for.' },
    { kind: 'operational', text: 'The invoice becomes Scheduled. Its details are re-checked when it sends; a paid, voided or changed invoice may not go out.' },
  ];
}

async function buildSchedulePlan(input) {
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const status = String(invoice.status || '').toLowerCase();
  const notSchedulable = scheduleStatusRefusal(invoice, status);
  if (notSchedulable) return notSchedulable;
  const sendAt = parseSendAt(input, invoice.id);
  if (sendAt.error) return sendAt;
  const refused = await scheduleInvoiceRefusal(invoice);
  if (refused) return refused;
  const { text, when } = sendAt;
  const dueCents = cents(require('../invoice-helpers').invoiceAmountDue(invoice));
  if (dueCents <= 0) return refusal('Nothing is due on this invoice, so there is nothing to send.', 'nothing_due', { invoice_id: invoice.id });
  const who = await require('../../routes/admin-invoices').getInvoiceDeliveryRecipients(invoice.id);
  if (!who) return refusal('Invoice not found', 'invoice_not_found');
  const phone = who.primaryContact?.phone ? String(who.primaryContact.phone) : null;
  const email = who.emailRecipient?.email ? String(who.emailRecipient.email) : null;
  if (!phone && !email) return refusal('No usable phone or email is on file, so nothing could be sent. Use the Invoices page for this one.', 'invoice_no_channel', { invoice_id: invoice.id });
  return {
    preview: true,
    tool: 'schedule_invoice_send',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: who.customerName || await customerName(invoice.customer_id),
    status: invoice.status,
    amount_due: money(dueCents / 100),
    send_at_et: text,
    send_at_text: etWhen(when),
    channels: [phone && 'text', email && 'email'].filter(Boolean).join(' and '),
    effects: scheduleEffects({ invoice, when, dueCents, phone, email, rescheduling: status === 'scheduled' && invoice.scheduled_send_at }),
    sends_to_customer: false,
    _scheduled_for: text,
    _version: {
      tool: 'schedule_invoice_send',
      invoice_id: invoice.id,
      status: invoice.status,
      updated_at: msOf(invoice.updated_at),
      due_cents: dueCents,
      customer_id: invoice.customer_id || null,
      scheduled_send_at: msOf(invoice.scheduled_send_at),
      send_at: when.getTime(),
      recipients: digest({ phone: digitsOf(phone), email: lowerEmail(email) }),
    },
    note: 'PREVIEW ONLY — nothing was scheduled. Confirm schedules exactly this; if anything changed it refuses.',
  };
}

// The handler threw: read the invoice back before saying anything.
async function scheduleThrown(plan, base, err) {
  logger.error(`[intelligence-bar:invoice-reminders] schedule handler failed (${err.code || err.name || 'error'})`);
  const now = await db('invoices').where({ id: plan.invoice_id }).first('status', 'scheduled_send_at').catch(() => null);
  if (now?.status === 'scheduled' && msOf(now.scheduled_send_at) === plan._version.send_at) {
    return { ...base, success: true, status: 'scheduled', sent_to_customer: false, warning: true,
      note: `Invoice ${plan.invoice_number} is scheduled for ${plan.send_at_text}, but the Invoices page reported a problem. Check the invoice.` };
  }
  return { ...base, outcome_unknown: true, code: 'execution_interrupted',
    error: 'The scheduling was interrupted — it may or may not have happened. Check the invoice before trying again.' };
}

function scheduleRefusal({ status, json }, base) {
  if (status === 200) return null;
  if (status === 409 && json?.code === 'PREVIEW_CHANGED') {
    return { ...base, failed: true, code: 'preview_changed', preview_changed: true, error: `Nothing was scheduled: ${json.error}` };
  }
  return { ...base, failed: true, code: status === 404 ? 'not_found' : 'schedule_refused', error: `The invoice was not scheduled: ${json?.error || 'the Invoices page refused it'}` };
}

async function commitSchedule(input, actionContext) {
  const { plan, refusal: refused } = await verifiedPlan(() => buildSchedulePlan(input), input._verified_invoice_reminder_version, 'schedule');
  if (refused) return refused;
  const base = { invoice_id: plan.invoice_id, invoice_number: plan.invoice_number, customer_id: plan.customer_id };
  let result;
  try {
    result = await require('../../routes/admin-invoices').scheduleSendFromBar({
      invoiceId: plan.invoice_id,
      body: { scheduledFor: plan._scheduled_for },
      actor: { technicianId: actionContext?.technicianId || null },
      approvedSchedule: { updatedAtMs: plan._version.updated_at },
    });
  } catch (err) {
    return scheduleThrown(plan, base, err);
  }
  const refusedByHandler = scheduleRefusal(result, base);
  if (refusedByHandler) return refusedByHandler;
  const { json } = result;
  if (json?.invoice?.status !== 'scheduled' || msOf(json.invoice.scheduled_send_at) !== plan._version.send_at) {
    return { ...base, outcome_unknown: true, code: 'schedule_unverified',
      error: 'The Invoices page answered, but the invoice does not read as scheduled for that time. Check the invoice before trying again.' };
  }
  logger.info(`[intelligence-bar:invoice-reminders] scheduled invoice ${plan.invoice_id}`);
  return { ...base, success: true, status: 'scheduled', scheduled_for: plan.send_at_text, sent_to_customer: false,
    note: `Invoice ${plan.invoice_number} is scheduled to send at ${plan.send_at_text}. Nothing was sent now.` };
}

// ── card lines (authorization-contract.js) ──────────────────────

const CARD_HEAD = {
  pause_invoice_reminders: 'Pause reminders on',
  resume_invoice_reminders: 'Resume reminders on',
  stop_invoice_reminders: 'Stop reminders on',
};

function cardLines(toolName, preview) {
  if (!preview || preview.preview !== true || preview.tool !== toolName) return [];
  const effects = (preview.effects || []).map(({ kind, text }) => ({ kind, text }));
  const who = preview.customer_name || preview.customer_id;
  if (CARD_HEAD[toolName]) {
    return [
      { kind: 'customer', text: `${CARD_HEAD[toolName]} invoice ${preview.invoice_number} for ${who} (reminders now ${String(preview.reminder_status).replace('_', ' ')})` },
      ...(preview.reason ? [{ kind: 'operational', text: `Reason noted: "${preview.reason}"` }] : []),
      ...effects,
    ];
  }
  if (toolName === 'send_invoice_reminder_now') {
    return [
      { kind: 'customer', text: `Send the next reminder on invoice ${preview.invoice_number} to ${who} now (${preview.amount_due} due, step ${preview.step})` },
      { kind: 'comms', text: `Channels: ${preview.channels}` },
      { kind: 'comms', text: preview.text_line },
      { kind: 'comms', text: preview.email_line },
      ...(preview.email_body ? [{ kind: 'comms', text: `Email body: ${flat(preview.email_body)}`, more: true }] : []),
      ...effects,
    ];
  }
  if (toolName === 'schedule_invoice_send') {
    return [
      { kind: 'customer', text: `Schedule invoice ${preview.invoice_number} for ${who} (${preview.amount_due} due) to send at ${preview.send_at_text}` },
      { kind: 'comms', text: `Channels when it sends: ${preview.channels}` },
      ...effects,
    ];
  }
  return [];
}

async function executeInvoiceReminderTool(toolName, input = {}, actionContext = {}) {
  if (!INVOICE_REMINDER_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the requireAdmin routes it runs; the registry refuses a technician too. The confirmed run needs a
  // positive admin flag (fail closed).
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Invoice reminders and scheduled sends are limited to admin accounts', 'permission_denied');
  }
  if (!invoiceRemindersLive()) return refusal('Invoice reminders and scheduled sends from the bar are switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    if (input.confirmed === true) {
      if (CONTROLS[toolName]) return await commitControl(toolName, input, actionContext);
      return toolName === 'send_invoice_reminder_now' ? await commitSendNow(input, actionContext) : await commitSchedule(input, actionContext);
    }
    if (CONTROLS[toolName]) return await buildControlPlan(toolName, input);
    return toolName === 'send_invoice_reminder_now' ? await buildSendNowPlan(input) : await buildSchedulePlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:invoice-reminders] ${toolName} failed (${err.code || err.name || 'error'})`);
    // A throw after an approval may follow a sent message: never invite a retry.
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The action was interrupted — it may or may not have happened. Check the invoice before trying again.' }
      : { error: 'Could not prepare this invoice reminder action' };
  }
}

module.exports = {
  INVOICE_REMINDER_TOOLS,
  executeInvoiceReminderTool,
  invoiceRemindersLive,
  cardLines,
};
