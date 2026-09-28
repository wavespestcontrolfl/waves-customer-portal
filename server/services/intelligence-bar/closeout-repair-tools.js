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
 *                       Recovery "Bill" action: a DRAFT invoice + 'billed'
 *                       disposition under the scheduled mint lock (never
 *                       sent, never charged)
 * Everything else stays manual. Paid receipts too: the receipt worker routes
 * per invoice (payer AP inbox, billing-email authority, channel settings), so
 * a card here could not name the real recipients without a second copy of
 * that routing. Otherwise: field evidence (application log, photos,
 * license) is never generated, payer / auto-charge / parked billing stays
 * with its own flows, follow-up booking lives inline in its route, and
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
const {
  getServiceReportEmailRecipients, PREFS_UNAVAILABLE,
} = require('../customer-contact');

const CLOSEOUT_REPAIR_TOOLS = [
  {
    name: 'repair_closeout',
    description: `Finish the closeout gaps the server can safely repair for ONE completed visit (scheduled_services id). The first call returns a PLAN and changes nothing: the repair steps it would run and the open items it will NOT touch (with where to fix them). The operator approves the exact plan on the confirmation card; the confirmed run executes only those steps and returns an itemized receipt (completed / failed / not attempted).
Repairable today: publish a missing service report link, queue a service-report email that was never queued (the customer gets an email), and bill a completed self-pay visit that was never invoiced (a DRAFT invoice through the Billing Recovery "Bill" checks — never sent or charged).
Never repaired here: application log, photos, technician license (field evidence — never generated), payer-billed / autopay / prepaid billing, invoice and receipt sends, follow-up booking, completion texts, and exhausted/failed deliveries.
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
  bill_visit: { kind: 'billing', label: 'Create a DRAFT invoice (the Billing Recovery "Bill" action) — not sent, not charged' },
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
async function planCloseoutRepair(status, { knex = db } = {}) {
  const facts = status.facts || {};
  const steps = [];
  const manual = [];
  const skipped = [];
  const addManual = (name, why) => {
    const f = facts[name];
    manual.push({ fact: name, state: f.state, reason: f.reason, fix: why || MANUAL_REMEDY[name] });
  };

  if (facts.completion?.state !== 'done') {
    if (facts.completion) addManual('completion');
    return { steps, manual, skipped };
  }

  // The report facts were derived from the record owning the report artifact
  // (closeout-status reportRecordId), which can be a sibling of status.record
  // — eligibility, dedupe and execution all bind to that same record.
  const recordId = status.reportRecordId || null;
  const recordRow = recordId
    ? await knex('service_records').where({ id: recordId })
      .first('id', 'status', 'report_template_version', 'report_view_token', 'structured_notes', 'recap_sms_sent_at', 'customer_id', 'service_line', 'service_type')
    : null;

  let contact = null;
  const getContact = async () => {
    contact = contact || await loadContact(status.visit?.customerId || null, knex);
    return contact;
  };

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
  if (emailCandidate) {
    let blocker = await reportEmailBlocker(status, recordRow, knex);
    // Same resolver the delivery worker sends through — the card names who
    // gets the email, and a plan with nobody to email is not offered.
    const { customer, prefs } = blocker ? {} : await getContact();
    const fullRecipients = blocker ? [] : getServiceReportEmailRecipients(customer, prefs)
      .map((r) => String(r.email || '').trim().toLowerCase()).filter(Boolean).sort();
    const recipients = fullRecipients.map(maskEmail).filter(Boolean);
    if (!blocker && !recipients.length) blocker = 'no report email recipient on file, or report emails are turned off';
    if (blocker) skipped.push({ fact: 'reportDelivery', reason: deliveryFact.reason, why: blocker });
    else {
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
    }
  }

  const invoiceFact = facts.invoice;
  if (invoiceFact?.state === 'pending' && BILLABLE_INVOICE_REASONS.has(invoiceFact.reason)) {
    // The same read-only checks the Bill button re-runs before minting: a
    // refusal (autopay, payer, prepaid, callback, unpriced…) is the manual fix.
    const assessed = await BillingRecoveryBill.assessVisitBillable(status.serviceId, { database: knex });
    // Deposit-bearing visits stay manual: the mint would consume estimate
    // deposit money, an effect this card does not preview or bind.
    const deposit = assessed.ok ? await BillingRecoveryBill.pendingDepositForVisit(status.serviceId, knex) : 0;
    if (!assessed.ok) skipped.push({ fact: 'invoice', reason: invoiceFact.reason, why: String(assessed.error).replace(/\.$/, '') });
    else if (deposit > 0) {
      skipped.push({ fact: 'invoice', reason: invoiceFact.reason, why: `an unapplied estimate deposit ($${deposit.toFixed(2)}) would apply — bill it from Billing Recovery` });
    } else {
      steps.push({
        step: 'bill_visit',
        fact: 'invoice',
        reason: invoiceFact.reason,
        scheduled_service_id: status.serviceId,
        amount: Number(assessed.price.toFixed(2)),
      });
    }
  }

  const planned = new Set(steps.map((s) => s.fact));
  const skippedFacts = new Set(skipped.map((s) => s.fact));
  for (const [name, f] of Object.entries(facts)) {
    if (!f || planned.has(name)) continue;
    if (f.state === 'unknown') {
      manual.push({ fact: name, state: f.state, reason: f.reason, fix: 'Lookup outage — status is unverified, not missing; re-check before acting.' });
    } else if ((f.state === 'pending' || f.state === 'failed') && !skippedFacts.has(name)) {
      // The report email waits on the report it would deliver.
      if (name === 'reportDelivery' && f.reason === 'report_not_published' && planned.has('report')) continue;
      addManual(name);
    }
  }
  for (const s of skipped) manual.push({ fact: s.fact, state: facts[s.fact].state, reason: s.reason, fix: `Not repairable here: ${s.why}.` });
  // Who the card is about — resolved by the server, never the model.
  const who = steps.length ? (await getContact()).customer : null;
  const customerName = who ? [who.first_name, who.last_name].filter(Boolean).join(' ') || null : null;
  return { steps, manual, skipped, customerName };
}

async function runStep(step, { knex = db } = {}) {
  switch (step.step) {
    case 'bill_visit': {
      const billed = await BillingRecoveryBill.billVisit(step.scheduled_service_id, {
        actorId: step.actor_id || null, expectedPrice: step.amount, refuseDepositCredit: true, database: knex,
      });
      if (!billed.ok) return { status: 'failed', detail: billed.error };
      return { status: 'completed', detail: `draft invoice created (not sent)`, invoice_id: billed.invoice.id, total: billed.invoice.total ?? null };
    }
    case 'publish_report': {
      const token = await ensureReportToken(step.service_record_id, knex);
      if (!token) return { status: 'failed', detail: 'service record not found' };
      return { status: 'completed', detail: 'report link published' };
    }
    case 'queue_report_email': {
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
    }
    default:
      return { status: 'failed', detail: `unknown step ${step.step}` };
  }
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
    s.step, s.service_record_id || null, s.scheduled_service_id || null, s.depends_on || null, s.recipients_key || null, s.amount ?? null,
  ]));
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
      effect: s.step === 'bill_visit'
        ? `${STEP_EFFECTS[s.step].label}: visit price $${s.amount.toFixed(2)} — the draft replays the visit's line items and discounts and adds tax; review it before sending`
        : s.recipients ? `${STEP_EFFECTS[s.step].label} — to ${s.recipients.length ? s.recipients.join(', ') : 'no recipient on file'}` : STEP_EFFECTS[s.step].label,
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
  // Bill disposition's actor_user_id) — route-derived, never a model param.
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
