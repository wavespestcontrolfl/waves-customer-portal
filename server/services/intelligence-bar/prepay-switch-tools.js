/**
 * Intelligence Bar — switch a per-application customer to annual prepay
 * server/services/intelligence-bar/prepay-switch-tools.js
 *
 * Owner request 2026-11-05 ("switch a customer from per application to annual prepay" from the bar), owner
 * choices the same day: a confirm card that commits the switch, collected in person afterwards; it may leave the
 * prepay unpaid (unlike the on-site sheet's collect-only rule of 2026-08-12).
 *
 *   switch_visit_to_annual_prepay — the Schedule on-site "Switch to annual prepay" (POST /admin/schedule/:id/prepay-switch),
 *                                   run through admin-schedule.js runPrepaySwitch: the same one-transaction switch, in
 *                                   process, so every refusal, price and lock is the route's own.
 *
 * Annual prepay is not a billing type the bar sets (billing-mode-change.js refuses it): it is a prepay invoice and
 * its term. What the switch writes: the series' unsent per-application draft (setup fee + first application, from
 * the estimate accept) becomes void, with a marker naming the prepay; an UNPAID annual prepay invoice is minted at
 * the server-computed price (computeAnnualPrepayPreview); a payment_pending annual-prepay term is created. The
 * customer moves to annual prepay only when that invoice is paid (the payment sync activates the term, stamps the
 * covered visits and sets billing_mode). Voiding the prepay from Invoices cancels the term and re-mints the
 * per-application invoice from the marker. It sends NO text, email or call and charges nothing.
 *
 * Always a confirm card (write-gates.js two-step), admin only, never owner-direct, platform path only, dark behind
 * GATE_IB_PREPAY_SWITCH (which needs GATE_IB_PLATFORM; independent of GATE_ONSITE_PREPAY_SWITCH).
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins the visit, the customer's billing type and every
 *                  figure the card shows (amount, setup line, visits, cadence, service, term start, the invoices it voids).
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then runs the switch with
 *                  those figures as `expected`; the switch re-checks them under its locks and refuses on a difference.
 *                  A renewal amount noticed to the customer (GATE_RATE_REVIEW) is never overridden from the bar.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');

function prepaySwitchLive() {
  return require('../../config/feature-gates').ibPrepaySwitchLive() === true;
}

const PREPAY_SWITCH_TOOLS = [
  {
    name: 'switch_visit_to_annual_prepay',
    description: `Switch ONE customer billed per application to ANNUAL PREPAY, from one of their live visits (pending, confirmed, en route or on site): the Schedule visit's "Switch to annual prepay". Annual prepay is not a billing type you set with update_customer: it is a prepay invoice for the year, and the customer moves to annual prepay when that invoice is PAID.
The first call returns a PREVIEW and writes nothing: the customer, the visit, the year's price (computed by the server from the series' per-visit price and cadence, with the prepay discount), any bait-station setup line, the number of visits covered, the start of the term, and the per-application invoice it voids. The operator approves on the confirmation card; the confirmed run re-checks all of it and refuses if anything changed.
Effects: the series' unsent per-application invoice (setup fee and first application from the estimate) is voided, and its setup fee is waived; an UNPAID annual prepay invoice is created. Nothing is sent to the customer (no text, email or call) and no card is charged: collect the invoice afterwards (charge their card or record the payment on the invoice). Until it is paid the customer is not yet on annual prepay. Voiding the prepay invoice from Invoices puts the per-application invoice back.
Refused with the reason when the switch does not apply: no per-visit price, a one-time or unsupported cadence, add-ons or boosters, a visit already closed out, a sent or paid per-application invoice, more than one live invoice, a deposit or account credit on it, a third-party payer, an existing annual prepay term, a renewal amount already given to the customer. Admin only.
Takes appointment_id: the customer's live visit in the series (find it with get_schedule_view or the customer's detail first).
Use for: "switch Pat Sample to annual prepay", "move this customer from per application to annual prepay", "he wants to prepay the year", "set up annual prepay for the visit I'm at".`,
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', format: 'uuid', description: 'The customer\'s live visit (scheduled service) in the series to switch' },
      },
      required: ['appointment_id'],
    },
    _sideEffects: true,
  },
];

const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const money = (value) => `$${(Math.round((Number(value) || 0) * 100) / 100).toFixed(2)}`;
const cents = (value) => Math.round((Number(value) || 0) * 100);

const CADENCE_WORDS = {
  monthly: 'monthly', every_6_weeks: 'every 6 weeks', lawn_rounds_9: 'lawn rounds, 9 a year', bimonthly: 'every other month',
  quarterly: 'quarterly', triannual: 'every 4 months', semiannual: 'twice a year', annual: 'once a year',
};

function dayOf(value) {
  return value ? require('../../utils/datetime-et').etCalendarDayOf(value) : null;
}

function customerName(c) {
  return [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.company_name || null;
}

function schedule() {
  return require('../../routes/admin-schedule');
}

// Everything the card approves: a change in any of it is drift.
function versionOf({ visit, customer, mint, supersedes }) {
  return {
    visit_id: visit.id,
    visit_status: visit.status || null,
    visit_date: dayOf(visit.scheduled_date),
    customer_id: visit.customer_id,
    billing_mode: customer?.billing_mode || null,
    amount: cents(mint.amount),
    setup_fee: cents(mint.setupFeeAmount),
    visit_count: Number(mint.visitCount) || 0,
    cadence: mint.coverageCadence || null,
    service: mint.serviceType || null,
    term_start: mint.termStart || null,
    supersedes: supersedes.map((inv) => schedule().prepaySwitchSupersedeKey(inv)).sort(),
  };
}

async function buildPlan(input) {
  const visitId = String(input?.appointment_id || '').trim().toLowerCase();
  if (!UUID_RE.test(visitId)) return refusal('A valid appointment_id (the customer\'s visit) is required', 'invalid_target');
  const visit = await db('scheduled_services').where({ id: visitId })
    .first('id', 'customer_id', 'status', 'scheduled_date', 'service_type');
  if (!visit) return refusal('Visit not found', 'not_found');
  const customer = await db('customers').where({ id: visit.customer_id })
    .first('id', 'first_name', 'last_name', 'company_name', 'billing_mode');
  if (!customer) return refusal('The visit\'s customer was not found', 'not_found');
  const name = customerName(customer);

  const p = await schedule().computeAnnualPrepayPreview({ scheduledServiceId: visitId }, db, { switchLane: true });
  if (p.httpStatus) return refusal(`Nothing was proposed: ${p.httpBody?.error || 'the switch is not available for this visit'}.`, 'not_available', { appointment_id: visitId });
  if (!p.eligible) return refusal(`${name || 'This customer'} can't be switched to annual prepay from this visit: it ${p.blockReason}. Nothing was proposed.`, 'not_eligible', { appointment_id: visitId, reason: p.blockReason });

  const mint = p.mintPayload;
  const supersedes = Array.isArray(p.supersedes) ? p.supersedes : [];
  const setupFee = Number(mint.setupFeeAmount) > 0 ? Number(mint.setupFeeAmount) : 0;
  const total = (cents(mint.amount) + cents(setupFee)) / 100;
  const cadence = CADENCE_WORDS[mint.coverageCadence] || String(mint.coverageCadence || '').replace(/_/g, ' ');
  const effects = [
    { kind: 'billing', text: `Creates an UNPAID annual prepay invoice: ${mint.serviceType}, ${mint.visitCount} visit${Number(mint.visitCount) === 1 ? '' : 's'} (${cadence}) for ${money(mint.amount)}${p.discountLabel ? ` (${p.discountLabel} prepay discount off ${money(p.annualBase)})` : ''}, term starting ${mint.termStart}.` },
    ...(setupFee > 0 ? [{ kind: 'billing', text: `The bait-station setup bills on the same invoice as its own line: ${money(setupFee)}.` }] : []),
    { kind: 'billing', text: `Invoice total: ${money(total)}. Collect it from the invoice afterwards (charge their card or record the payment).` },
    ...supersedes.map((inv) => ({ kind: 'billing', text: `Voids the unsent per-application invoice ${inv.invoiceNumber || inv.id} (${money(inv.total)}).` })),
    ...(p.setupFee?.amount > 0 ? [{ kind: 'billing', text: `The ${money(p.setupFee.amount)} setup fee on it is waived with the prepay.` }] : []),
    { kind: 'billing', text: 'The customer moves to annual prepay only when this invoice is paid; their visits are then marked prepaid for the year. Until then they are not covered.' },
    { kind: 'billing', text: 'If it is not collected, void the prepay invoice from Invoices: the per-application invoice comes back.' },
    { kind: 'comms', text: 'Nothing is sent: no text, email or call goes to the customer. No card is charged.' },
  ];
  return {
    preview: true,
    tool: 'switch_visit_to_annual_prepay',
    appointment_id: visit.id,
    customer_id: visit.customer_id,
    customer_name: name,
    visit_date: dayOf(visit.scheduled_date),
    visit_status: visit.status || null,
    service: mint.serviceType,
    billing_before: customer.billing_mode || 'not set',
    prepay_amount: money(mint.amount),
    setup_fee: setupFee > 0 ? money(setupFee) : null,
    invoice_total: money(total),
    visits_covered: Number(mint.visitCount) || 0,
    cadence,
    term_start: mint.termStart,
    voids: supersedes.map((inv) => ({ invoice_number: inv.invoiceNumber || null, amount: money(inv.total) })),
    effects,
    sends_to_customer: false,
    _version: versionOf({ visit, customer, mint, supersedes }),
    _expected: {
      customerId: String(visit.customer_id),
      amount: mint.amount,
      setupFeeAmount: setupFee,
      visitCount: mint.visitCount,
      coverageCadence: mint.coverageCadence,
      serviceType: mint.serviceType,
      termStart: mint.termStart,
      supersedeKeys: supersedes.map((inv) => schedule().prepaySwitchSupersedeKey(inv)),
    },
    note: 'PREVIEW ONLY — nothing was changed. Confirm makes exactly this switch; if anything changed it refuses.',
  };
}

async function commitSwitch(input, actionContext) {
  const pinned = input._verified_prepay_switch_version;
  if (!pinned) return refusal('Use the confirmation card to approve this switch.', 'approval_required');
  const plan = await buildPlan(input);
  if (plan.error) return { ...plan, error: `Nothing was changed: ${plan.error}`, preview_changed: true };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return refusal('The visit or the prepay figures changed after the card was shown, so nothing was switched. Ask again for a fresh confirmation card.', 'preview_changed', { preview_changed: true });
  }
  const base = { appointment_id: plan.appointment_id, customer_id: plan.customer_id };
  let out;
  try {
    out = await schedule().runPrepaySwitch({
      visitId: plan.appointment_id,
      switchLane: true,
      expected: plan._expected,
      acknowledgeNoticedAmount: false,
      actor: { id: actionContext?.technicianId || null, name: null, source: 'ib_prepay_switch' },
      auditSource: 'Intelligence Bar switch',
    });
  } catch (err) {
    // One transaction: it committed or it did not. Read back whether a prepay term now exists for the customer.
    logger.error(`[intelligence-bar:prepay-switch] switch failed (${err.code || err.name || 'error'})`);
    return { ...base, outcome_unknown: true, code: 'execution_interrupted',
      error: 'The switch was interrupted — it may or may not have happened. Check the customer\'s invoices before trying again.' };
  }
  if (out.httpStatus) {
    if (out.noticedRenewalAmount) {
      return { ...base, failed: true, code: 'noticed_renewal_amount',
        error: `Nothing was switched: ${out.httpBody?.error || 'the customer was already told a different renewal amount'}. Use the visit's Switch to annual prepay sheet, where staff can confirm the amount.` };
    }
    const message = out.httpBody?.error || out.httpBody?.message || 'the switch was refused';
    return { ...base, failed: true, code: out.drift ? 'preview_changed' : 'switch_refused', error: `Nothing was switched: ${message}`,
      ...(out.drift ? { preview_changed: true } : {}) };
  }
  logger.info(`[intelligence-bar:prepay-switch] switched visit ${plan.appointment_id}: minted ${out.invoice?.invoice_number}`);
  return {
    ...base,
    success: true,
    invoice_id: out.invoice?.id || null,
    invoice_number: out.invoice?.invoice_number || null,
    invoice_total: money(out.invoice?.total),
    voided: (out.voided || []).map((v) => v.invoiceNumber || v.id),
    sent_to_customer: false,
    note: `Annual prepay invoice ${out.invoice?.invoice_number || ''} (${money(out.invoice?.total)}) is created and UNPAID. ${plan.customer_name || 'The customer'} moves to annual prepay when it is paid: collect it from the invoice. Nothing was sent to anyone.`.replace(/\s+/g, ' '),
  };
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (toolName !== 'switch_visit_to_annual_prepay' || !preview || preview.preview !== true) return [];
  return [
    { kind: 'billing', text: `Switch ${preview.customer_name || preview.customer_id} to annual prepay (billing now: ${preview.billing_before}), from the ${preview.visit_date || ''} ${preview.service} visit (${preview.visit_status})`.replace(/\s+/g, ' ') },
    ...(preview.effects || []).map(({ kind, text }) => ({ kind, text })),
  ];
}

async function executePrepaySwitchTool(toolName, input = {}, actionContext = {}) {
  if (!PREPAY_SWITCH_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the requireAdmin switch route; the confirmed run needs a positive admin flag (fail closed).
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Switching a customer to annual prepay is limited to admin accounts', 'permission_denied');
  }
  if (!prepaySwitchLive()) return refusal('Switching to annual prepay from the bar is switched off (GATE_IB_PREPAY_SWITCH). Nothing was changed.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitSwitch(input, actionContext) : await buildPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:prepay-switch] ${toolName} failed (${err.code || err.name || 'error'})`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The switch was interrupted — it may or may not have happened. Check the customer\'s invoices before trying again.' }
      : { error: 'Could not prepare the switch' };
  }
}

module.exports = {
  PREPAY_SWITCH_TOOLS,
  executePrepaySwitchTool,
  prepaySwitchLive,
  cardLines,
};
