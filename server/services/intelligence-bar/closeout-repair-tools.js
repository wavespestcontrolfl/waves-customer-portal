/**
 * Intelligence Bar — Closeout repair command (W3)
 *
 * `repair_closeout(service_id)` is a two-step write over the canonical
 * closeout-status service (#3647):
 *
 *   unconfirmed → a PLAN built from getCloseoutStatus: `steps[]` the server
 *                 can safely finish, and `manual[]` open items it will not
 *                 touch (with where they get fixed). Nothing is written.
 *   confirmed   → run exactly the planned steps, in order, and return an
 *                 itemized receipt: completed / failed / not_attempted.
 *
 * The plan is frozen by the standard two-step pin (write-gates.js
 * WRITE_TWO_STEP): the route fingerprints this preview at proposal time and
 * /confirm-action re-runs it and refuses on any drift — one approval = one
 * exact step set (owner rulings 7–8). A partial run reports `partial: true`
 * (outcome partially_completed, ruling 9) and is never re-run automatically.
 *
 * Steps reuse the canonical service functions only:
 *   publish_report      ensureReportToken — mints the report link (internal)
 *   queue_report_email  enqueueServiceReportV1EmailDelivery — the delivery
 *                       worker emails the customer (one row per record)
 *   bill_visit          billing-recovery-bill billVisit — the Billing
 *                       Recovery "Bill" action (invoice + 'billed'
 *                       disposition under the scheduled mint lock); the card
 *                       shows the exact total from previewBillVisit (the
 *                       same mint, rolled back) and the run must match it
 *   send_invoice        InvoiceService.sendViaSMSAndEmail — the Invoices
 *                       page "Send" action, first delivery only; never charges
 *   queue_receipt       enqueueReceiptDelivery — the receipt worker emails
 *                       (and may text) the paid receipt; the card names the
 *                       email recipient from the worker's own resolver
 *                       (invoice-email resolveReceiptEmailRecipient) and
 *                       opt-out check (receiptEmailOptOutState)
 *   book_followup       completion-followup-booking bookCompletionFollowup —
 *                       the Dispatch follow-up CTA: a PENDING $0 visit on the
 *                       frozen verdict's date (idempotent per source visit)
 * Everything else stays manual: field evidence (application log, photos,
 * license) is never generated, payer / auto-charge / parked billing stays
 * with its own flows, and
 * exhausted deliveries have no safe re-queue.
 *
 * Results carry ids, states and reasons — no customer names, phones or
 * addresses.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const CloseoutStatus = require('../closeout-status');
const { ensureReportToken } = require('../service-report/pdf-queue');
const { enqueueServiceReportV1EmailDelivery } = require('../service-report/delivery-queue');
const { isUserFeatureEnabled } = require('../feature-flags');
const { publicPortalUrl } = require('../../utils/portal-url');
const { detectServiceLine } = require('../service-report/service-line-configs');
const BillingRecoveryBill = require('../billing-recovery-bill');
const { firstDeliveryOutcome, resolvedSendOutcome } = require('../invoice-send-outcome');
const { enqueueReceiptDelivery, receiptEmailOptOutState, expectedEmailSkip } = require('../receipt-delivery-queue');
// Lazy: invoice-email pulls in the invoice/PDF graph — loaded only when an
// invoice send or a receipt step is planned, never at IB boot.
const invoiceEmail = () => require('../invoice-email');
// Lazy: the booking service pulls in the whole completion module graph —
// loaded only when a follow-up step is planned or run, never at IB boot.
const followupBooking = () => require('../completion-followup-booking');
const {
  getServiceReportEmailRecipients, PREFS_UNAVAILABLE,
} = require('../customer-contact');

const CLOSEOUT_REPAIR_TOOLS = [
  {
    name: 'repair_closeout',
    description: `Finish the closeout gaps the server can safely repair for ONE completed visit (scheduled_services id). The first call returns a PLAN and changes nothing: the repair steps it would run and the open items it will NOT touch (with where to fix them). The operator approves the exact plan on the confirmation card; the confirmed run executes only those steps and returns an itemized receipt (completed / failed / not attempted).
Repairable today: publish a missing service report link, queue a service-report email that was never queued (the customer gets an email), bill a completed self-pay visit that was never invoiced (the Billing Recovery "Bill" checks; the card shows the exact invoice total) and send that invoice to the customer by email/text exactly as the Invoices "Send" button does — nothing is charged — queue a paid receipt that was never queued (the receipt worker emails it — to the payer's billing inbox for a payer-billed invoice — and may text it per the customer's receipt settings), and book a follow-up visit the completion called for but nobody booked (a PENDING $0 visit on the program-interval date, exactly as the Dispatch follow-up button books it — no text now; the usual reminders go out before the visit).
Never repaired here: application log, photos, technician license (field evidence — never generated), payer-billed / autopay / prepaid billing, re-sends of invoices or receipts that already went out, follow-ups whose date has passed, completion texts, and exhausted/failed deliveries.
Use for: "fix the closeout for this visit", "finish what's missing on the job we just completed". Call get_closeout_status first when the operator only wants to know what is missing.`,
    input_schema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', format: 'uuid', description: 'scheduled_services.id of the visit' },
      },
      required: ['service_id'],
    },
  },
];

// Where each open fact gets fixed when this command will not touch it.
const MANUAL_REMEDY = {
  completion: 'Completion is not finished — resume or finish it from Dispatch; every other fact waits on it.',
  application: 'Application log is field evidence — only the technician can record it; it is never generated.',
  photos: 'Photos are field evidence — only the technician can upload them.',
  report: 'Publish the report from the project page (project-backed visit) or re-check the report posture.',
  reportDelivery: 'No safe re-queue exists for this report delivery — check the customer contact and resend from the report.',
  invoice: 'Bill the visit (or mark it intentionally free) from Billing Recovery.',
  invoiceDelivery: 'Send the invoice or receipt from the invoice page.',
  comms: 'There is no completion-text resend — text the customer from Communications if needed.',
  followUp: 'Book the follow-up from Dispatch.',
  license: 'Technician license data — update the technician record; a closeout never edits it.',
};

const STEP_EFFECTS = {
  publish_report: { kind: 'operational', label: 'Publish the service report link (internal — no message is sent by this step)' },
  queue_report_email: { kind: 'comms', label: 'Queue the service-report email — the delivery worker emails the customer the report on file' },
  bill_visit: { kind: 'billing', label: 'Create the invoice (the Billing Recovery "Bill" action) — nothing is charged' },
  send_invoice: { kind: 'comms', label: 'Send the invoice to the customer (the Invoices "Send" action)' },
  queue_receipt: { kind: 'comms', label: 'Queue the paid receipt — the receipt worker sends it' },
  book_followup: { kind: 'operational', label: 'Book the PENDING $0 follow-up visit (the Dispatch follow-up action)' },
};

// Invoice reason meaning "a customer self-pay invoice was expected and never
// minted" on the LIVE billing expectation. Everything else stays manual:
// payer / auto-charge belong to the AP flow and the charge lane, parked
// reasons are a deliberate human call, and frozen_required_mint_not_minted
// carries the completion's frozen amount/tax/payer contract, which the
// ordinary Bill replay (current price, current tax) would not honour.
const BILLABLE_INVOICE_REASONS = new Set(['expected_invoice_not_minted']);

function parseNotes(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function reportEmailFlagEnabled(technicianId) {
  const envValue = process.env.SERVICE_REPORT_EMAIL_DELIVERY_ENABLED;
  if (envValue !== undefined) return ['1', 'true', 'yes', 'on'].includes(String(envValue).trim().toLowerCase());
  return isUserFeatureEnabled(technicianId || null, 'service_report_email_delivery_enabled', false).catch(() => false);
}

// The report-email step replays completion's own gate (complete-scheduled-
// service.js queueServiceReportEmailIfEligible): a v1 report on a completed,
// non-backfill record whose frozen posture is auto_send, email delivery on,
// never already handled (no delivery row, no notes status, no recap claim),
// and not a grouped visit (the visit summary owns that delivery).
async function reportEmailBlocker(status, recordRow, knex) {
  const posture = status.facts.report?.posture || status.facts.reportDelivery?.posture || null;
  if (status.packet) return 'grouped visit — the visit summary owns report delivery';
  if (!recordRow) return 'service record not found';
  if (recordRow.report_template_version !== 'service_report_v1') return 'not a v1 service report';
  if (!['completed', 'complete'].includes(String(recordRow.status || '').toLowerCase())) return 'service record is not completed';
  const notes = parseNotes(recordRow.structured_notes);
  if (notes.backfill === true) return 'backfilled completion — quiet by contract';
  // Lawn reports: completion holds the email until the grounded
  // recommendations settle, and the worker only re-verifies grounding for
  // those held jobs — an immediate repair enqueue could email stale copy.
  // Classified exactly as the worker does (delivery-queue.js isLawnDelivery).
  if ((recordRow.service_line || detectServiceLine(recordRow.service_type)) === 'lawn') {
    return 'lawn report — grounding readiness is only verified by completion; send it from the report';
  }
  if (posture !== 'auto_send') return `report posture is ${posture || 'unrecorded'}, not auto_send`;
  if (notes.serviceReportV1EmailStatus) return `report email already ${notes.serviceReportV1EmailStatus}`;
  if (recordRow.recap_sms_sent_at) return 'a recap text already claimed this report';
  const existing = await knex('service_report_deliveries')
    .where({ service_record_id: recordRow.id, channel: 'email', report_template_version: 'service_report_v1' })
    .first('id');
  if (existing) return 'a report email row already exists';
  if (!(await reportEmailFlagEnabled(status.visit?.technicianId))) return 'report email delivery is switched off';
  return null;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : null;
}

// Who the receipt worker would reach — through its OWN resolvers, so the card
// never names a different inbox than the send: the opt-out/kill-switch check,
// then resolveReceiptEmailRecipient (payer AP inbox for payer-billed invoices,
// the billing-email authority otherwise). The text/App leg is decided at send
// by the messaging pipeline (consent, channel choice, STOP), so the card
// states it as conditional; payer-billed receipts never reach the homeowner.
// A phone-less customer is still reachable when they chose App for payment
// receipts (sendReceipt's own explicitBillingAppSelected admission).
// A paid, unsent invoice with no receipt job — else why not.
async function receiptInvoiceOrBlocker(invoiceId, knex) {
  const invoice = await knex('invoices').where({ id: invoiceId }).first();
  if (!invoice) return { blocker: 'invoice not found' };
  if (String(invoice.status || '').toLowerCase() !== 'paid') return { blocker: `invoice is ${invoice.status}, not paid` };
  if (invoice.receipt_sent_at) return { blocker: 'receipt already sent' };
  const job = await knex('receipt_delivery_jobs').where({ invoice_id: invoiceId }).first('id');
  if (job) return { blocker: 'a receipt job already exists' };
  const optOut = await receiptEmailOptOutState(invoice);
  if (optOut.prefsLookupFailed) return { blocker: "the customer's receipt settings could not be read" };
  if (optOut.receiptKillSwitch) return { blocker: 'the customer opted out of payment receipts' };
  return { invoice };
}

// The email leg through the worker's resolver. Only the worker's own
// expected skips (no email on file, opted out, Email not the chosen receipt
// channel) mean "no email, on purpose". Any other refusal — a settings
// lookup outage, an aborted resolution — is unknown, not "nobody": the
// worker could still email someone the card didn't name.
async function receiptEmailLeg(invoice) {
  const resolved = await invoiceEmail().resolveReceiptEmailRecipient(invoice, { billingDeliveryCategory: 'payment_receipt' });
  if (resolved.ok) return { email: String(resolved.recipient.email).trim().toLowerCase(), customer: resolved.customer };
  if (!expectedEmailSkip(resolved)) {
    return { blocker: `the receipt email recipient could not be verified (${String(resolved.error || resolved.code || 'unknown').replace(/\.$/, '')})` };
  }
  return { email: null, customer: null, skipReason: String(resolved.error || '') };
}

// Whether the receipt may notify the Waves app: the phone-less admission
// sendReceipt uses (explicitBillingAppSelected), OR the customer's full
// payment-receipt channel resolution — explicit channels or the legacy
// single payment_receipt_channel (billingChannelsPayload, the one reader of
// both) — naming App, which the App routing reads for phone-bearing
// customers too. A prefs read failure is treated as "may" (never hidden).
async function receiptMayReachApp(customerId, emailAvailable, knex) {
  if (await require('../invoice').explicitBillingAppSelected(customerId, 'payment_receipt')) return true;
  const READ_FAILED = Symbol('prefs-read-failed');
  const prefs = await knex('notification_prefs').where({ customer_id: customerId }).first().catch(() => READ_FAILED);
  if (prefs === READ_FAILED) return true;
  const { billingChannelsPayload } = require('../billing-delivery-channels');
  return (billingChannelsPayload(prefs || {}, { emailAvailable }).paymentConfirmationChannels || []).includes('push');
}

async function receiptRecipients(invoiceId, knex) {
  const eligible = await receiptInvoiceOrBlocker(invoiceId, knex);
  if (eligible.blocker) return eligible;
  const { invoice } = eligible;
  const emailLeg = await receiptEmailLeg(invoice);
  if (emailLeg.blocker) return emailLeg;
  const payerBilled = Boolean(invoice.payer_id);
  const phone = payerBilled ? null
    : (emailLeg.customer?.phone || (await knex('customers').where({ id: invoice.customer_id }).first('phone'))?.phone || null);
  const app = !payerBilled && await receiptMayReachApp(invoice.customer_id, Boolean(emailLeg.email), knex);
  if (!emailLeg.email && !phone && !app) return { blocker: emailLeg.skipReason || 'no receipt recipient on file' };
  // Which receipt, for how much — the amount the receipt itself states.
  let amount;
  try {
    amount = await require('../invoice').receiptAmountFor(invoice, { failClosed: true });
  } catch {
    return { blocker: 'the receipt amount could not be verified (payment lookup failed)' };
  }
  return { email: emailLeg.email, phone, app, payerBilled, invoiceNumber: invoice.invoice_number || null, amount };
}

// The card's plain-words description of where a queued receipt can go.
function receiptReach(s) {
  const which = `receipt for ${s.invoice_number ? `invoice ${s.invoice_number}` : 'the paid invoice'}, $${s.amount} paid — `;
  const email = `${which}email to ${s.recipients.length ? s.recipients.join(', ') : 'nobody (no receipt email on file)'}`;
  if (s.payer_billed) return `${email} (the payer's billing inbox — a payer-billed receipt is never texted)`;
  const legs = [s.text_to && `text ${s.text_to}`, s.app && 'a Waves app notification'].filter(Boolean);
  if (!legs.length) return `${email}; no text (no phone on file)`;
  return `${email}; may also send ${legs.join(' or ')}, per the customer's receipt settings (texts wait for 8 AM–8 PM)`;
}

function maskEmail(address) {
  const [local, domain] = String(address || '').split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : null;
}

// The customer + contact prefs the delivery workers resolve recipients from,
// read once per plan. A failed prefs read stays PREFS_UNAVAILABLE so the
// shared resolvers fail closed (no recipients) exactly as the workers do.
async function loadContact(customerId, knex) {
  if (!customerId) return { customer: null, prefs: PREFS_UNAVAILABLE };
  const customer = await knex('customers').where({ id: customerId }).first();
  const prefs = await knex('notification_prefs').where({ customer_id: customerId }).first().catch(() => PREFS_UNAVAILABLE);
  return { customer: customer || null, prefs: prefs || {} };
}

/**
 * Build the repair plan for a loaded closeout status. Pure apart from the
 * precondition reads — never writes. Deterministic for the same state so the
 * two-step fingerprint binds it.
 */
// Report link + report email. Both bind to the record the report facts were
// derived from (closeout-status reportRecordId), which can be a sibling of
// status.record — eligibility, dedupe and execution all use that record.
async function planReportSteps(status, getContact, knex) {
  const facts = status.facts;
  const steps = [];
  const skipped = [];
  const recordId = status.reportRecordId || null;
  const recordRow = recordId
    ? await knex('service_records').where({ id: recordId })
      .first('id', 'status', 'report_template_version', 'report_view_token', 'structured_notes', 'recap_sms_sent_at', 'customer_id', 'service_line', 'service_type')
    : null;

  const reportFact = facts.report;
  const publishable = reportFact?.state === 'pending'
    && ['no_report_artifact', 'form_submitted_not_published'].includes(reportFact.reason)
    && recordRow && !recordRow.report_view_token;
  if (publishable) {
    steps.push({ step: 'publish_report', fact: 'report', reason: reportFact.reason, service_record_id: recordRow.id });
  }

  const deliveryFact = facts.reportDelivery;
  const emailCandidate = deliveryFact?.state === 'pending'
    && (deliveryFact.reason === 'not_enqueued' || (publishable && deliveryFact.reason === 'report_not_published'));
  if (!emailCandidate) return { steps, skipped };
  let blocker = await reportEmailBlocker(status, recordRow, knex);
  // Same resolver the delivery worker sends through — the card names who
  // gets the email, and a plan with nobody to email is not offered.
  const { customer, prefs } = blocker ? {} : await getContact();
  const fullRecipients = blocker ? [] : getServiceReportEmailRecipients(customer, prefs)
    .map((r) => String(r.email || '').trim().toLowerCase()).filter(Boolean).sort();
  const recipients = fullRecipients.map(maskEmail).filter(Boolean);
  if (!blocker && !recipients.length) blocker = 'no report email recipient on file, or report emails are turned off';
  if (blocker) {
    skipped.push({ fact: 'reportDelivery', reason: deliveryFact.reason, why: blocker });
    return { steps, skipped };
  }
  steps.push({
    step: 'queue_report_email',
    fact: 'reportDelivery',
    reason: deliveryFact.reason,
    service_record_id: recordRow.id,
    recipients,
    // Binds the FULL addresses (masks can collide): the confirm-time
    // fingerprint and the executor's plan match both cover this key.
    recipients_key: crypto.createHash('sha256').update(JSON.stringify(fullRecipients)).digest('hex').slice(0, 16),
    ...(publishable ? { depends_on: 'publish_report' } : {}),
  });
  return { steps, skipped };
}

// Draft invoice through the Billing Recovery "Bill" checks, pinned to the
// canonical completion record closeout-status resolved.
async function planInvoiceStep(status, knex) {
  const invoiceFact = status.facts.invoice;
  if (!(invoiceFact?.state === 'pending' && BILLABLE_INVOICE_REASONS.has(invoiceFact.reason))) return {};
  const serviceRecordId = status.record?.id || null;
  // The same read-only checks the Bill button re-runs before minting: a
  // refusal (autopay, payer, prepaid, callback, unpriced…) is the manual fix.
  const assessed = await BillingRecoveryBill.assessVisitBillable(status.serviceId, { serviceRecordId, requireCompletedVisit: true, database: knex });
  if (!assessed.ok) return { skip: { fact: 'invoice', reason: invoiceFact.reason, why: String(assessed.error).replace(/\.$/, '') } };
  // An open card hold is resolved by completion's hold rail, which this
  // repair does not run — the visit stays manual.
  if (await BillingRecoveryBill.liveCardHoldForVisit(status.serviceId, knex)) {
    return { skip: { fact: 'invoice', reason: invoiceFact.reason, why: 'a card hold is still open on this visit — resolve the hold, then bill it from Billing Recovery' } };
  }
  // Deposit-bearing visits stay manual: the mint would consume estimate
  // deposit money, an effect this card does not preview or bind.
  const deposit = await BillingRecoveryBill.pendingDepositForVisit(status.serviceId, knex);
  if (deposit > 0) {
    return { skip: { fact: 'invoice', reason: invoiceFact.reason, why: `an unapplied estimate deposit ($${deposit.toFixed(2)}) would apply — bill it from Billing Recovery` } };
  }
  // The exact invoice: the real Bill action run in a rolled-back transaction.
  const preview = await BillingRecoveryBill.previewBillVisit(status.serviceId, {
    serviceRecordId, requireCompletedVisit: true, refuseDepositCredit: true, refuseLiveCardHold: true,
  });
  if (!preview.ok) return { skip: { fact: 'invoice', reason: invoiceFact.reason, why: String(preview.error).replace(/\.$/, '') } };
  const bill = {
    step: 'bill_visit',
    fact: 'invoice',
    reason: invoiceFact.reason,
    scheduled_service_id: status.serviceId,
    service_record_id: serviceRecordId,
    amount: Number(assessed.price.toFixed(2)),
    total: preview.total,
    subtotal: preview.subtotal,
    discount: preview.discountAmount,
    tax: preview.taxAmount,
    due_date: preview.dueDate || assessed.dueDate || null,
  };
  const send = await planInvoiceSend(status, knex);
  // The send carries the approved total so its boundary can refuse an edited draft.
  return send.step ? { steps: [bill, { ...send.step, total: bill.total }] } : { steps: [bill], skip: send.skip };
}

// Account credit the Send action would consume: sendViaSMSAndEmail runs
// autoApplyAccountCreditIfEnabled first (deploy gate + the customer's own
// auto-apply switch + a positive balance). That money movement is not on the
// card and the send can't pin an amount, so such sends stay manual.
async function accountCreditTheSendWouldApply(customerId, knex) {
  if (!require('../../config/feature-gates').gates.autoApplyAccountCredit) return 0;
  const CustomerCredit = require('../customer-credit');
  if (!(await CustomerCredit.customerAutoApplyEnabled(customerId, knex))) return 0;
  return Number(await CustomerCredit.getBalance(customerId, knex)) || 0;
}

// Who the Send action reaches — its own resolver (invoiceRecipientFor over
// the customer's billing contact) for the email, and the phone on file for
// the pay-link text (the messaging pipeline's consent rules apply at send).
async function planInvoiceSend(status, knex) {
  const why = (text) => ({ skip: { fact: 'invoiceDelivery', reason: 'no_invoice_yet', why: text } });
  const { customer, prefs } = await loadContact(status.visit?.customerId || null, knex);
  if (!customer) return why('the customer record could not be read — send the invoice from the Invoices page');
  if (prefs === PREFS_UNAVAILABLE) return why("the customer's billing settings could not be read — send the invoice from the Invoices page");
  const { email, phone } = invoiceContacts(customer, prefs);
  if (!email && !phone) return why('no invoice email or phone on file — the invoice is created; send it from the Invoices page');
  const credit = await accountCreditTheSendWouldApply(customer.id, knex);
  if (credit > 0) {
    return why(`the send would apply $${credit.toFixed(2)} of the customer's account credit — the invoice is created; send it from the Invoices page`);
  }
  return {
    step: {
      step: 'send_invoice',
      fact: 'invoiceDelivery',
      reason: 'no_invoice_yet',
      scheduled_service_id: status.serviceId,
      depends_on: 'bill_visit',
      recipients: email ? [maskEmail(email)] : [],
      text_to: maskPhone(phone),
      // Binds the FULL email + phone (masks can collide).
      recipients_key: contactsKey(email, phone),
    },
  };
}

// A paid invoice whose receipt was never queued.
async function planReceiptStep(status, knex) {
  const invDelivery = status.facts.invoiceDelivery;
  if (!(invDelivery?.state === 'pending' && invDelivery.reason === 'paid_receipt_not_sent' && invDelivery.invoiceId)) return {};
  const who = await receiptRecipients(invDelivery.invoiceId, knex);
  if (who.blocker) return { skip: { fact: 'invoiceDelivery', reason: invDelivery.reason, why: who.blocker } };
  return {
    step: {
      step: 'queue_receipt',
      fact: 'invoiceDelivery',
      reason: invDelivery.reason,
      invoice_id: invDelivery.invoiceId,
      invoice_number: who.invoiceNumber,
      amount: who.amount,
      recipients: who.email ? [maskEmail(who.email)] : [],
      text_to: maskPhone(who.phone),
      app: who.app === true,
      payer_billed: who.payerBilled,
      // Binds the FULL email + phone + App choice (masks can collide).
      recipients_key: crypto.createHash('sha256').update(JSON.stringify([who.email, who.phone, who.app === true])).digest('hex').slice(0, 16),
    },
  };
}

// The Dispatch follow-up CTA's own dry run on the verdict's date.
async function planFollowupStep(status, knex) {
  const followUpFact = status.facts.followUp;
  if (!(followUpFact?.state === 'pending' && followUpFact.reason === 'followup_required_not_booked')) return {};
  // The Dispatch CTA's own gates, run as a preview on the verdict's date.
  const probe = await followupBooking().bookCompletionFollowup({
    serviceId: status.serviceId, useSuggestedDate: true, dryRun: true, isAdmin: true,
  });
  const would = probe.status === 200 && probe.body?.dryRun && !probe.body.alreadyScheduled ? probe.body.wouldBook : null;
  if (!would) return { skip: { fact: 'followUp', reason: followUpFact.reason, why: followupRefusalWhy(probe) } };
  const tech = would.technicianId
    ? await knex('technicians').where({ id: would.technicianId }).first('name').catch(() => null)
    : null;
  return {
    step: {
      step: 'book_followup',
      fact: 'followUp',
      reason: followUpFact.reason,
      scheduled_service_id: status.serviceId,
      date: would.date,
      window_start: would.windowStart || null,
      window_end: would.windowEnd || null,
      technician_id: would.technicianId || null,
      technician_name: tech?.name || null,
      // The card names this customer; the booking re-checks it on the
      // locked source visit (a merge/repoint refuses).
      customer_id: status.visit?.customerId || null,
      overlap: would.overlap === true,
    },
  };
}

// The Send action's destinations: invoiceRecipientFor (its own email
// resolver) and the phone on file for the pay-link text.
function invoiceContacts(customer, prefs) {
  const { recipient } = invoiceEmail().invoiceRecipientFor(customer, prefs, null);
  return {
    email: recipient?.email ? String(recipient.email).trim().toLowerCase() : null,
    phone: customer.phone || null,
  };
}

function contactsKey(email, phone) {
  return crypto.createHash('sha256').update(JSON.stringify([email, phone])).digest('hex').slice(0, 16);
}

function followupRefusalWhy(probe) {
  const why = probe.body?.alreadyScheduled ? 'a follow-up is already on the schedule' : (probe.body?.error || 'the follow-up cannot be booked');
  return String(why).replace(/\.$/, '');
}

// Every open fact no step covers, with where it gets fixed.
function manualItems(facts, steps, skipped) {
  const manual = [];
  const planned = new Set(steps.map((s) => s.fact));
  const skippedFacts = new Set(skipped.map((s) => s.fact));
  for (const [name, f] of Object.entries(facts)) {
    if (!f || planned.has(name)) continue;
    if (f.state === 'unknown') {
      manual.push({ fact: name, state: f.state, reason: f.reason, fix: 'Lookup outage — status is unverified, not missing; re-check before acting.' });
      continue;
    }
    if (!['pending', 'failed'].includes(f.state) || skippedFacts.has(name)) continue;
    // The report email waits on the report it would deliver.
    if (name === 'reportDelivery' && f.reason === 'report_not_published' && planned.has('report')) continue;
    manual.push({ fact: name, state: f.state, reason: f.reason, fix: MANUAL_REMEDY[name] });
  }
  for (const s of skipped) manual.push({ fact: s.fact, state: facts[s.fact].state, reason: s.reason, fix: `Not repairable here: ${s.why}.` });
  return manual;
}

async function planCloseoutRepair(status, { knex = db } = {}) {
  const facts = status.facts || {};
  if (facts.completion?.state !== 'done') {
    const manual = facts.completion
      ? [{ fact: 'completion', state: facts.completion.state, reason: facts.completion.reason, fix: MANUAL_REMEDY.completion }]
      : [];
    return { steps: [], manual, skipped: [] };
  }
  let contact = null;
  const getContact = async () => {
    contact = contact || await loadContact(status.visit?.customerId || null, knex);
    return contact;
  };
  const report = await planReportSteps({ ...status, facts }, getContact, knex);
  const invoice = await planInvoiceStep({ ...status, facts }, knex);
  const receipt = await planReceiptStep({ ...status, facts }, knex);
  const followup = await planFollowupStep({ ...status, facts }, knex);
  const steps = [...report.steps, ...(invoice.steps || []), ...(receipt.step ? [receipt.step] : []), ...(followup.step ? [followup.step] : [])];
  const skipped = [...report.skipped, ...(invoice.skip ? [invoice.skip] : []), ...(receipt.skip ? [receipt.skip] : []), ...(followup.skip ? [followup.skip] : [])];
  // Who the card is about — resolved by the server, never the model.
  const who = steps.length ? (await getContact()).customer : null;
  const customerName = who ? [who.first_name, who.last_name].filter(Boolean).join(' ') || null : null;
  return { steps, manual: manualItems(facts, steps, skipped), skipped, customerName };
}

const STEP_RUNNERS = {
  async book_followup(step) {
    let booked;
    try {
      // Everything the card showed is pinned BEFORE any write: the
      // approved date goes through the CTA's own match-the-verdict gate,
      // the window and technician are refused on a mismatch.
      booked = await followupBooking().bookCompletionFollowup({
        serviceId: step.scheduled_service_id,
        date: step.date,
        isAdmin: true,
        actorId: step.actor_id || null,
        expectedWindow: { start: step.window_start || null, end: step.window_end || null },
        // The card showed this technician (null = unassigned) and customer.
        expectedTechnicianId: step.technician_id || null,
        expectedCustomerId: step.customer_id || null,
        sourceAction: 'admin_ib',
      });
    } catch (err) {
      if (err && err.statusCode) return { status: 'failed', detail: err.message };
      throw err;
    }
    if (booked.status !== 200 || !booked.body?.appointment) return { status: 'failed', detail: booked.body?.error || 'follow-up not booked' };
    if (String(booked.body.appointment.scheduledDate || '') !== String(step.date)) {
      return { status: 'failed', detail: `an existing follow-up is on ${booked.body.appointment.scheduledDate}, not the approved ${step.date}`, appointment_id: booked.body.appointment.id };
    }
    return {
      status: 'completed',
      detail: booked.body.alreadyScheduled ? 'the follow-up was already booked — nothing new created' : 'pending follow-up booked',
      appointment_id: booked.body.appointment.id,
      ...(booked.body.overlapWarning ? { warning: booked.body.overlapWarning } : {}),
    };
  },
  async publish_report(step, knex) {
    const token = await ensureReportToken(step.service_record_id, knex);
    if (!token) return { status: 'failed', detail: 'service record not found' };
    return { status: 'completed', detail: 'report link published' };
  },
  async queue_report_email(step, knex) {
    const row = await knex('service_records').where({ id: step.service_record_id })
      .first('id', 'customer_id', 'report_view_token', 'scheduled_service_id');
    if (!row?.report_view_token) return { status: 'failed', detail: 'report link is not published' };
    const portalUrl = publicPortalUrl();
    const queued = await enqueueServiceReportV1EmailDelivery({
      serviceRecordId: row.id,
      customerId: row.customer_id,
      token: row.report_view_token,
      reportUrl: `${portalUrl}/report/${row.report_view_token}`,
      pdfUrl: `${portalUrl}/api/reports/${row.report_view_token}`,
      payload: { scheduled_service_id: row.scheduled_service_id || null, source: 'ib_closeout_repair' },
    }, knex);
    if (!queued?.ok) return { status: 'failed', detail: queued?.error || 'report email could not be queued' };
    if (queued.queued === false) return { status: 'completed', detail: `report email already ${queued.delivery?.status || 'queued'} — nothing new queued`, delivery_id: queued.delivery?.id || null };
    return { status: 'completed', detail: 'report email queued', delivery_id: queued.delivery?.id || null };
  },
  async bill_visit(step, knex) {
    const billed = await BillingRecoveryBill.billVisit(step.scheduled_service_id, {
      actorId: step.actor_id || null,
      expectedPrice: step.amount,
      expectedTotal: step.total,
      expectedBreakdown: { subtotal: step.subtotal, discount: step.discount, tax: step.tax },
      refuseDepositCredit: true,
      serviceRecordId: step.service_record_id || null,
      requireCompletedVisit: true,
      refuseLiveCardHold: true,
      database: knex,
    });
    if (!billed.ok) return { status: 'failed', detail: billed.error };
    return { status: 'completed', detail: 'invoice created', invoice_id: billed.invoice.id, invoice_number: billed.invoice.invoice_number || null, total: billed.invoice.total ?? null };
  },
  async send_invoice(step, knex) {
    // The invoice bill_visit just created for this visit (its 'billed'
    // disposition row), sent exactly as the Invoices page Send button sends
    // a first delivery.
    const disposition = await knex('visit_billing_dispositions')
      .where({ scheduled_service_id: step.scheduled_service_id, disposition: 'billed' })
      .first('invoice_id');
    if (!disposition?.invoice_id) return { status: 'failed', detail: 'the created invoice could not be found' };
    // Re-checked right before the send: credit that appeared since the card
    // was shown would be consumed by the send — refuse instead.
    const invoiceRow = await knex('invoices').where({ id: disposition.invoice_id }).first('customer_id', 'total', 'status');
    const blocked = await sendBoundaryRefusal(step, invoiceRow, knex);
    if (blocked) return { status: 'failed', detail: blocked, invoice_id: disposition.invoice_id };
    try {
      const result = await require('../invoice').sendViaSMSAndEmail(disposition.invoice_id, {
        firstDeliveryOnly: true, operatorInitiated: true, actorTechnicianId: step.actor_id || null,
        // Enforced inside the send itself: no account credit is consumed,
        // even if some appeared after the pre-send check below.
        skipAccountCreditAutoApply: true,
        // Re-checked on the claimed row inside the send (no edit can follow).
        expectedTotal: step.total ?? null,
      });
      return { ...invoiceSendOutcome(result), invoice_id: disposition.invoice_id };
    } catch (err) {
      return { ...invoiceSendRefusal(err), invoice_id: disposition.invoice_id };
    }
  },
  async queue_receipt(step, knex) {
    // The unsent check and the enqueue are one transaction on the LOCKED
    // invoice row: a receipt sent by hand in between (receipt_sent_at
    // stamped) refuses instead of queueing a duplicate. A machine-queued
    // receipt (customerInitiated false): its text waits for the 8 AM–8 PM
    // window, exactly like an autopay receipt.
    const queued = await knex.transaction(async (trx) => {
      const inv = await trx('invoices').where({ id: step.invoice_id }).forUpdate().first('id', 'status', 'receipt_sent_at');
      if (!inv || String(inv.status || '').toLowerCase() !== 'paid' || inv.receipt_sent_at) {
        return { refused: inv?.receipt_sent_at ? 'the receipt was sent in the meantime — nothing queued' : 'the invoice is no longer paid — nothing queued' };
      }
      return enqueueReceiptDelivery({ invoiceId: step.invoice_id, source: 'ib_closeout_repair', customerInitiated: false, database: trx });
    });
    if (queued?.refused) return { status: 'failed', detail: queued.refused };
    if (queued?.enqueued) return { status: 'completed', detail: 'receipt queued', receipt_job_id: queued.job?.id || null };
    if (queued?.deduped) return { status: 'completed', detail: 'a receipt job already existed — nothing new queued' };
    return { status: 'failed', detail: queued?.reason || 'receipt could not be queued' };
  },
};

// Right before the send: the destinations must still be the approved ones
// (recipients_key), and no account credit may have appeared.
async function sendBoundaryRefusal(step, invoiceRow, knex) {
  if (!invoiceRow) return 'the created invoice could not be read';
  // The approved total must still be the invoice's total — a draft edited
  // between creation and this send is not the invoice that was approved.
  if (step.total !== undefined && Math.round(Number(invoiceRow.total) * 100) !== Math.round(Number(step.total) * 100)) {
    return `the invoice total changed to $${Number(invoiceRow.total).toFixed(2)} since approval — review it and send it from the Invoices page`;
  }
  const { customer, prefs } = await loadContact(invoiceRow.customer_id, knex);
  if (!customer || prefs === PREFS_UNAVAILABLE) return "the customer's contact settings could not be read — send it from the Invoices page";
  const { email, phone } = invoiceContacts(customer, prefs);
  if (contactsKey(email, phone) !== step.recipients_key) {
    return "the customer's invoice email or phone changed since the card was approved — send it from the Invoices page";
  }
  if ((await accountCreditTheSendWouldApply(invoiceRow.customer_id, knex)) > 0) {
    return 'the customer now has account credit the send would apply — send it from the Invoices page';
  }
  return null;
}

// A send result read through the Invoices Send route's own classifier
// (services/invoice-send-outcome.js) — never a second interpretation.
function invoiceSendOutcome(result) {
  if (result?.code === 'INVOICE_VISIT_TERMINAL') {
    return { status: 'completed', detail: 'the visit became terminal — the invoice was voided instead of sent' };
  }
  if (!result?.ok) return invoiceSendFailure(result);
  if (result.settled_zero_due) return { status: 'completed', detail: 'nothing was due — the invoice was settled, no pay link sent' };
  if (result.covered_by_credit) return { status: 'completed', detail: 'the invoice was fully covered — no pay link sent' };
  const legs = [result.email?.ok && 'emailed', result.sms?.ok && 'texted', result.sms?.scheduled && 'text queued for 8 AM'].filter(Boolean);
  return { status: 'completed', detail: `invoice sent (${legs.join(', ') || 'delivered'})` };
}

function invoiceSendFailure(result) {
  const held = resolvedSendOutcome(result);
  if (held?.type === 'held') return { status: 'failed', detail: `held for review: ${held.reason || held.code}` };
  return { status: 'failed', detail: result?.error || result?.sms?.error || result?.email?.error || 'invoice not sent' };
}

// A thrown send refusal, same classifier: first-delivery no-ops (already
// delivered / queued / in progress) are completed; held codes and anything
// else are a failed step.
function invoiceSendRefusal(err) {
  const outcome = firstDeliveryOutcome(err, true);
  if (outcome?.type === 'noop') {
    return { status: 'completed', detail: outcome.voided ? 'the visit became terminal — the invoice was voided instead of sent' : `nothing re-sent (${outcome.code.replace(/_/g, ' ')})` };
  }
  if (outcome?.type === 'held') return { status: 'failed', detail: `held for review: ${outcome.reason || outcome.code}` };
  return { status: 'failed', detail: err?.message || 'invoice send failed' };
}


async function runStep(step, { knex = db } = {}) {
  const runner = STEP_RUNNERS[step.step];
  return runner ? runner(step, knex) : { status: 'failed', detail: `unknown step ${step.step}` };
}

async function executeCloseoutRepair(steps, { knex = db } = {}) {
  const receipt = [];
  const outcomeByStep = {};
  for (const step of steps) {
    if (step.depends_on && outcomeByStep[step.depends_on] !== 'completed') {
      receipt.push({ step: step.step, fact: step.fact, status: 'not_attempted', detail: `${step.depends_on} did not complete` });
      outcomeByStep[step.step] = 'not_attempted';
      continue;
    }
    let result;
    try {
      result = await runStep(step, { knex });
    } catch (err) {
      logger.error(`[intelligence-bar:closeout-repair] step ${step.step} failed: ${err.message}`);
      result = { status: 'failed', detail: 'step threw — see server log' };
    }
    receipt.push({ step: step.step, fact: step.fact, ...result });
    outcomeByStep[step.step] = result.status;
  }
  return receipt;
}

function stepsKey(steps) {
  return JSON.stringify((steps || []).map((s) => [
    s.step, s.service_record_id || null, s.scheduled_service_id || null, s.invoice_id || null, s.depends_on || null, s.recipients_key || null,
    s.amount ?? null, s.total ?? null, s.subtotal ?? null, s.discount ?? null, s.tax ?? null, s.due_date || null,
    s.date || null, s.window_start || null, s.window_end || null, s.technician_id || null, s.customer_id || null, s.overlap === true,
  ]));
}

const money = (n) => `$${Number(n).toFixed(2)}`;

// The card line for one step — server wording, never model text.
function stepEffect(s) {
  const label = STEP_EFFECTS[s.step].label;
  if (s.step === 'bill_visit') {
    const parts = [`${money(s.subtotal)} services`, s.discount ? `−${money(s.discount)} discounts` : null, `${money(s.tax)} tax`].filter(Boolean);
    return `${label}: ${money(s.total)} total (${parts.join(', ')})${s.due_date ? `, due ${s.due_date}` : ''}`;
  }
  if (s.step === 'queue_receipt') return `${label}: ${receiptReach(s)}`;
  if (s.step === 'book_followup') {
    const window = s.window_start ? ` ${String(s.window_start).slice(0, 5)}–${String(s.window_end || '').slice(0, 5)}` : '';
    const who = s.technician_name || (s.technician_id ? "the source visit's technician" : 'no technician (unassigned)');
    return `${label} on ${s.date}${window} with ${who}${s.overlap ? ' (overlaps another appointment on the schedule — both are kept)' : ''} — nothing is sent now; it is registered for the usual appointment reminders, which go out per the customer's reminder settings`;
  }
  if (s.step === 'send_invoice') {
    const legs = [s.recipients.length && `email to ${s.recipients.join(', ')}`, s.text_to && `text the pay link to ${s.text_to}`].filter(Boolean);
    return `${label}: ${legs.join(' and ')} — this also starts the usual unpaid-invoice reminders`;
  }
  return s.recipients ? `${label} — to ${s.recipients.length ? s.recipients.join(', ') : 'no recipient on file'}` : label;
}

function previewFromPlan(serviceId, status, plan) {
  return {
    preview: true,
    service_id: serviceId,
    service_record_id: status.reportRecordId || null,
    customer_id: status.visit?.customerId || null,
    customer_name: plan.customerName || null,
    visit: [status.visit?.scheduledDate, status.visit?.serviceType].filter(Boolean).join(' · ') || null,
    steps: plan.steps.map((s) => ({
      ...s,
      kind: STEP_EFFECTS[s.step].kind,
      effect: stepEffect(s),
    })),
    manual: plan.manual,
    notifies_customer: plan.steps.some((s) => STEP_EFFECTS[s.step].kind === 'comms'),
    note_to_operator: 'PLAN ONLY — nothing was changed. Confirm runs exactly these steps; the open items under manual are not touched.',
  };
}

async function repairCloseout(input, actionContext = {}) {
  const serviceId = String(input?.service_id || '').trim();
  if (!serviceId) return { error: 'service_id is required' };
  const status = await CloseoutStatus.getCloseoutStatus(serviceId);
  if (!status.found) {
    return status.lookupFailed
      ? { error: 'scheduled_services lookup unavailable — status unknown, not missing', service_id: serviceId }
      : { error: 'No visit with that id', service_id: serviceId };
  }
  const plan = await planCloseoutRepair(status);

  // Only /confirm-action sets actionContext.confirmed (route-derived, never
  // a model param) — every other call is the plan.
  if (actionContext.confirmed !== true) {
    // An empty plan is a tool answer, not a card: a card that can only
    // no-op would consume a pending action for nothing.
    if (!plan.steps.length) {
      return {
        error: status.summary?.closedOut
          ? 'This visit is fully closed out — nothing to repair.'
          : 'Nothing here is repairable by this command — see manual for where each open item gets fixed.',
        code: 'nothing_repairable',
        service_id: serviceId,
        manual: plan.manual,
      };
    }
    return previewFromPlan(serviceId, status, plan);
  }

  // Run ONLY the steps the confirm route just fingerprint-verified against
  // the card (_verified_repair_steps), and only while the live plan is still
  // exactly that set — a step that appeared since (an invoice paid in
  // between) is never added to an approved run. Each step's writer dedupes
  // on its own unique row, so a replay cannot double-send.
  const approved = actionContext.executionPins?._verified_repair_steps;
  if (!Array.isArray(approved) || !approved.length) {
    return { error: 'This repair has no verified plan attached. Ask again for a fresh confirmation card.', preview_changed: true };
  }
  if (stepsKey(approved) !== stepsKey(plan.steps)) {
    return { error: 'What this repair would do changed after the card was shown. Ask again for a fresh confirmation card.', preview_changed: true };
  }
  // The confirming operator is recorded on anything a step writes (the
  // Bill disposition's actor_user_id, the follow-up booking's alert
  // resolution) — route-derived, never a model param.
  const receipt = await executeCloseoutRepair(plan.steps.map((st) => ({ ...st, actor_id: actionContext.technicianId || null })));
  const completed = receipt.filter((r) => r.status === 'completed').length;
  logger.info(`[intelligence-bar:closeout-repair] ${serviceId}: ${completed}/${receipt.length} steps completed`);
  const allDone = completed === receipt.length;
  return {
    ...(allDone ? { success: true } : completed ? { partial: true } : { error: 'No repair step completed.', failed: true }),
    service_id: serviceId,
    receipt,
    manual: plan.manual,
    note: allDone
      ? 'Every planned step completed. Items under manual still need a person.'
      : 'Some steps did not complete — this is NOT re-run automatically. Check the receipt, then ask again for a fresh plan.',
  };
}

async function executeCloseoutRepairTool(toolName, input, actionContext = {}) {
  try {
    switch (toolName) {
      case 'repair_closeout': return await repairCloseout(input, actionContext);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:closeout-repair] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = {
  CLOSEOUT_REPAIR_TOOLS,
  executeCloseoutRepairTool,
  planCloseoutRepair,
  executeCloseoutRepair,
  STEP_EFFECTS,
};
