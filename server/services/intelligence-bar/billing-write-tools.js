/**
 * Intelligence Bar — staff billing writes (owner ruling 2026-10-03: the bar does
 * what the screens do and never sends the operator to another screen).
 *
 *   remove_saved_payment_method  Customer 360 → Cards on File → Remove, plus the
 *                                Auto Pay-off step staff had no screen for
 *   correct_invoice_address      Invoices → Edit address
 *
 * Both are two-step writes (write-gates.js WRITE_TWO_STEP): the unconfirmed call
 * is a PREVIEW that changes nothing, the route fingerprints it at proposal time,
 * and /confirm-action re-runs it and refuses on any drift — one approval = one
 * exact plan. Neither ever runs direct for the owner (owner-direct.js keeps
 * money and customer-facing documents on the card).
 *
 * remove_saved_payment_method plans up to two ordered steps and runs exactly the
 * approved ones, stopping at the first failure:
 *   turn_off_autopay        the portal's own disable (services/autopay-disable.js)
 *                           — behind GATE_IB_STAFF_AUTOPAY_OFF
 *   remove_payment_method   removePaymentMethod with the Auto Pay guard ON, the
 *                           same path as the admin DELETE route and the portal
 * Results carry ids, labels and reasons — never processor ids.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { isEnabled, ibStaffAutopayOffLive } = require('../../config/feature-gates');
const { getAutopaySelectedMethodIds, isBankMethodType, isPaused } = require('../autopay-eligibility');
const { AUTOPAY_OFF_UPDATES, disableAutopayInTransaction, sendAutopayDisabledNotice } = require('../autopay-disable');
const { removePaymentMethod, removalPreview } = require('../payment-method-removal');
const { auditStaffPaymentMethodRemoval } = require('../payment-method-removal-audit');
const { getInvoiceEmailRecipients } = require('../customer-contact');
const InvoiceAddress = require('../invoice-address');
const { formatETDay, formatETDate, formatETTime } = require('../../utils/datetime-et');

const BILLING_WRITE_TOOLS = [
  {
    name: 'remove_saved_payment_method',
    description: `Remove ONE saved card or bank account from a customer's account and, only when the operator says so, turn the account's Auto Pay off first — as ONE confirm card with the steps in order. The first call is a PREVIEW and changes nothing: the method (brand or bank, last four, expiry), whether Auto Pay is using it, the removal notes (a verified bank's debit can take up to 3 business days to stop; a card holding a future secured visit keeps that visit and its agreed late-cancel fee, but the fee can no longer be charged to that card), the ordered steps, and which customer emails may go out. The operator approves the exact steps on the card; the confirmed run executes only those steps, in order, and returns an itemized result (completed / failed / not attempted).
If Auto Pay is USING the method, the call answers that instead of a card: ask the operator, here in the bar, whether to turn Auto Pay off as well, and only if they say yes call again with turn_off_autopay true. Never set turn_off_autopay on your own, and never send the operator to another screen. Turning Auto Pay off is account-wide (never one card), and it is not done when Auto Pay runs on a different method than the one named. If the customer has several saved methods and none is named, the call lists them (brand, last four, whether Auto Pay uses each): ask which.
The customer gets the same notices the portal sends (Auto Pay turned off, payment method removed) only when those notice emails are switched on and the customer has an email on file; the preview says whether that applies. Nothing is charged or refunded. Admin only.
Use for: "remove her saved card", "delete the Visa ending 4242", "take the card off file and turn off Auto Pay".`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'customers.id of the account the method belongs to' },
        payment_method_id: { type: 'string', format: 'uuid', description: 'payment_methods.id to remove. Optional when the customer has exactly one saved method; otherwise the call lists the methods and asks which.' },
        turn_off_autopay: { type: 'boolean', description: 'true only after the OPERATOR said to turn Auto Pay off as well as remove the method. Default false.' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'correct_invoice_address',
    description: `Correct the address PRINTED on ONE invoice and its receipt (the receipt page, the invoice and receipt PDFs, and billing emails that show it). The first call is a PREVIEW and changes nothing: the address printed now and the corrected one. Confirming rewrites only that invoice's address snapshot — amounts, status, the customer's profile, saved properties and payer bill-to are NOT touched, and nothing is re-sent to the customer. A before/after audit row is written. Works on any invoice status except void. Put the full street line, including any unit or suite, in address_line1; give city, two-letter state and ZIP. Identify the invoice by invoice_id or invoice_number — exactly one. Admin only.
Use for: "the receipt has the wrong address", "fix the address on invoice WPC-2026-0042".`,
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', format: 'uuid', description: 'invoices.id (give this or invoice_number, not both)' },
        invoice_number: { type: 'string', description: 'The invoice number as printed, e.g. WPC-2026-0042 (give this or invoice_id, not both)' },
        address_line1: { type: 'string', description: 'Street line including any unit or suite' },
        city: { type: 'string' },
        state: { type: 'string', description: 'Two-letter state code, e.g. FL' },
        zip: { type: 'string', description: '5 digits, or ZIP+4' },
      },
      required: ['address_line1', 'city', 'state', 'zip'],
    },
  },
];

const BANK_NOTE = 'Bank authorizations can take up to 3 business days to stop, so a debit already in progress may still go through.';

const uuid = (v) => (v == null ? '' : String(v).trim().toLowerCase());

function maskEmail(address) {
  const [local, domain] = String(address || '').split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : null;
}

function customerName(c) {
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.company_name || null;
}

function methodLabel(m) {
  return isBankMethodType(m.method_type)
    ? `${m.bank_name || 'Bank account'} ending ${m.bank_last_four || m.last_four || '—'}`
    : `${m.card_brand || 'Card'} ending ${m.last_four || '—'}`;
}

function expiry(m) {
  if (isBankMethodType(m.method_type) || !m.exp_month || !m.exp_year) return null;
  const year = Number(m.exp_year) < 100 ? Number(m.exp_year) + 2000 : Number(m.exp_year);
  return `${String(m.exp_month).padStart(2, '0')}/${year}`;
}

const sortedIds = (ids) => [...ids].map(String).sort();

// ─── remove_saved_payment_method ─────────────────────────────────────

// Who the two portal notices would reach — the sender's own resolver
// (getInvoiceEmailRecipients over the customer + prefs). Both senders sit
// behind GATE_PAYMENT_METHOD_CHANGE_EMAILS and skip a customer with no email,
// so the card says "may" only when both are true.
async function noticePlan(customer, { turnsOff }) {
  const gateOn = isEnabled('paymentMethodChangeEmails');
  const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => ({}));
  const recipients = getInvoiceEmailRecipients(customer, prefs || {})
    .map((r) => maskEmail(String(r.email || '').trim().toLowerCase())).filter(Boolean);
  const notices = [...(turnsOff ? ['Auto Pay turned off'] : []), 'Payment method removed'];
  const willSend = gateOn && recipients.length > 0;
  const summary = willSend
    ? `Customer will be emailed (${recipients.join(', ')}), through the portal's own notices: ${notices.map((n) => `"${n}"`).join(', then ')}`
    : gateOn
      ? 'No customer email: there is no email address on file for the portal notices'
      : 'No customer email: the payment-method change notice emails are switched off (GATE_PAYMENT_METHOD_CHANGE_EMAILS)';
  return { gate_on: gateOn, recipients, notices, will_send: willSend, summary };
}

function holdDisclosure(preview) {
  if (preview?.holdLookupFailed) return { hold_lookup_failed: true, holds_appointment: null };
  const hold = preview?.holdsAppointment;
  if (!hold) return { hold_lookup_failed: false, holds_appointment: null };
  const when = new Date(hold.start);
  const fee = hold.feeAmount != null ? `$${Number(hold.feeAmount).toFixed(2)} ` : '';
  return {
    hold_lookup_failed: false,
    holds_appointment: {
      start: hold.start,
      service_type: hold.serviceType || null,
      fee_amount: hold.feeAmount ?? null,
      text: `This card holds the customer's ${hold.serviceType || 'service'} visit on ${formatETDay(when)}, ${formatETDate(when)} at ${formatETTime(when)}. Removing it does not cancel the visit or the ${fee}late-cancel fee they agreed to, but that fee can no longer be charged to this card.`,
    },
  };
}

// The full plan for one call, or { error } the model can act on. Pure apart
// from reads, deterministic for the same state — the route's fingerprint and
// the executor's re-plan both bind it.
async function planRemoval(input) {
  const customerId = uuid(input?.customer_id);
  if (!customerId) return { error: 'customer_id is required' };
  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
  if (!customer) return { error: 'No customer with that id', code: 'customer_not_found' };

  const methods = await db('payment_methods').where({ customer_id: customerId })
    .orderBy('is_default', 'desc').orderBy('created_at', 'desc');
  if (!methods.length) return { error: 'This customer has no saved payment methods.', code: 'no_saved_methods' };

  // Same fail-closed read as the removal guard: a broken read is a refusal,
  // never a guess about which card Auto Pay is using.
  let selectedIds;
  try {
    selectedIds = await getAutopaySelectedMethodIds(customer, db, { rethrow: true });
  } catch (err) {
    logger.warn(`[intelligence-bar:billing-write] Auto Pay read failed for customer ${customerId}: ${err.message}`);
    return { error: 'Could not check Auto Pay right now — try again in a moment. Nothing was changed.', code: 'autopay_unreadable' };
  }
  const usedBy = (m) => selectedIds.includes(String(m.id));

  const requestedId = uuid(input?.payment_method_id);
  let method = null;
  if (requestedId) {
    method = methods.find((m) => String(m.id) === requestedId);
    if (!method) return { error: "That payment method is not on this customer's account.", code: 'method_not_found' };
  } else if (methods.length === 1) {
    [method] = methods;
  } else {
    return {
      error: 'This customer has several saved payment methods — ask the operator which one to remove, then call again with its payment_method_id.',
      code: 'method_required',
      methods: methods.map((m) => ({ payment_method_id: m.id, label: methodLabel(m), expires: expiry(m), is_default: !!m.is_default, autopay_uses_it: usedBy(m) })),
    };
  }

  const autopayState = customer.autopay_enabled === false ? 'off' : (isPaused(customer) ? 'paused' : 'on');
  const usesMethod = usedBy(method);
  const wantsOff = input?.turn_off_autopay === true;
  const label = methodLabel(method);

  // The one new capability sits behind its own gate: with it off, the in-use
  // card cannot be removed from the bar, and the answer says so plainly.
  if (usesMethod && !ibStaffAutopayOffLive()) {
    return {
      error: `Auto Pay is using ${label}, and turning Auto Pay off from the bar is not switched on yet (GATE_IB_STAFF_AUTOPAY_OFF), so this card cannot be removed from here. Tell the operator exactly that. Nothing was changed.`,
      code: 'autopay_off_not_enabled',
    };
  }
  if (usesMethod && !wantsOff) {
    return {
      error: `Auto Pay${autopayState === 'paused' ? ' (paused, not off)' : ''} is using ${label}, so it cannot be removed on its own. Ask the operator, here in the bar, whether to turn Auto Pay off for this account as well as remove the card. If they say yes, call this tool again with turn_off_autopay: true — they will then confirm one card with both steps. Do not send them to another screen.`,
      code: 'autopay_uses_method',
      autopay_uses_method: true,
      method: { payment_method_id: method.id, label },
    };
  }

  // Auto Pay is turned off only when it is using the method the operator named.
  const turnsOff = usesMethod && wantsOff;
  let autopayNote = null;
  if (wantsOff && !usesMethod) {
    autopayNote = autopayState === 'off'
      ? 'Auto Pay is already off, so there is nothing to turn off — the plan is the removal only.'
      : `Auto Pay is running on a different payment method, not ${label}. Auto Pay is left on and unchanged — only the removal below is planned.`;
  }

  const steps = [
    ...(turnsOff ? [{ step: 'turn_off_autopay', customer_id: customerId, method_id: String(method.id) }] : []),
    { step: 'remove_payment_method', customer_id: customerId, method_id: String(method.id) },
  ].map((s, i) => ({ position: i + 1, ...s }));

  const [removal, notices] = await Promise.all([
    removalPreview({ customerId, methodId: method.id }),
    noticePlan(customer, { turnsOff }),
  ]);
  if (!removal) return { error: "That payment method is not on this customer's account.", code: 'method_not_found' };

  const verifiedBank = isBankMethodType(method.method_type) && method.ach_status === 'verified';
  const name = customerName(customer);
  const pausedUntil = customer.autopay_paused_until ? String(customer.autopay_paused_until instanceof Date ? customer.autopay_paused_until.toISOString() : customer.autopay_paused_until).slice(0, 10) : null;
  const stepLines = {
    turn_off_autopay: `Turn Auto Pay OFF for the whole account — the portal's own Auto Pay switch. Invoices stop being charged automatically${autopayState === 'paused' ? ' (the pause is cleared)' : ''} until Auto Pay is turned back on (the customer can do that in their portal)`,
    remove_payment_method: `Remove ${label} — detaches it from Stripe and deletes it from the account, so no new charges can start on it. The Auto Pay guard stays on`,
  };
  const total = steps.length;
  return {
    preview: true,
    customer_id: customerId,
    customer_name: name,
    method: {
      id: String(method.id), label, kind: isBankMethodType(method.method_type) ? 'bank' : 'card',
      last_four: (isBankMethodType(method.method_type) ? method.bank_last_four || method.last_four : method.last_four) || null,
      expires: expiry(method), is_default: !!method.is_default, verified_bank: verifiedBank,
    },
    autopay: { state: autopayState, enabled: customer.autopay_enabled !== false, uses_this_method: usesMethod, method_ids: sortedIds(selectedIds), ...(pausedUntil ? { paused_until: pausedUntil } : {}) },
    ...(autopayNote ? { autopay_note: autopayNote } : {}),
    steps: steps.map((s) => ({ ...s, kind: 'billing', effect: `Step ${s.position} of ${total}: ${stepLines[s.step]}` })),
    disclosures: { bank_note: verifiedBank ? BANK_NOTE : null, ...holdDisclosure(removal) },
    customer_emails: notices,
    notifies_customer: notices.will_send,
    note_to_operator: 'PLAN ONLY — nothing was changed. Confirm runs exactly these steps, in order; if Auto Pay changes first, the card is refused and you ask again.',
  };
}

// Everything the approval binds: customer, method, Auto Pay state and the
// methods it is using, and the ordered step list.
function planKey(preview) {
  return JSON.stringify([
    preview.customer_id, preview.method?.id, preview.autopay?.enabled, sortedIds(preview.autopay?.method_ids || []),
    (preview.steps || []).map((s) => [s.position, s.step, s.customer_id, s.method_id]),
  ]);
}

class AutopayDrift extends Error {}

const REMOVAL_STEP_RUNNERS = {
  async turn_off_autopay(step, preview, ctx) {
    let outcome;
    try {
      await db.transaction(async (trx) => {
        // Re-check the approved Auto Pay state UNDER the customer lock the
        // disable itself takes (customer row first, then method rows): a
        // switch since the card was shown rolls this back untouched.
        const locked = await trx('customers').where({ id: step.customer_id }).forUpdate()
          .first('id', 'autopay_enabled', 'autopay_payment_method_id', 'ach_status');
        const ids = await getAutopaySelectedMethodIds(locked, trx, { rethrow: true });
        if (JSON.stringify(sortedIds(ids)) !== JSON.stringify(sortedIds(preview.autopay.method_ids)) || (locked?.autopay_enabled !== false) !== preview.autopay.enabled) {
          throw new AutopayDrift('Auto Pay changed');
        }
        outcome = await disableAutopayInTransaction(trx, step.customer_id, {
          updates: { ...AUTOPAY_OFF_UPDATES },
          details: { source: 'intelligence_bar', actor_id: ctx.actorId || null },
        });
      });
    } catch (err) {
      if (err instanceof AutopayDrift) return { status: 'failed', detail: 'Auto Pay changed since the card was shown — nothing was changed. Ask again for a fresh card.' };
      throw err;
    }
    // Awaited (it never rejects): the removal that follows deletes the row the
    // notice names the method from.
    if (outcome.transition) await sendAutopayDisabledNotice({ customerId: step.customer_id, paymentMethodId: outcome.methodId });
    return {
      status: 'completed',
      detail: outcome.transition ? 'Auto Pay turned off' : 'Auto Pay was already off — nothing changed',
      autopay_off: true,
    };
  },
  async remove_payment_method(step, preview, ctx) {
    const removed = await removePaymentMethod({ customerId: step.customer_id, methodId: step.method_id, guard: true, source: 'intelligence_bar' });
    if (!removed.removedMethod) {
      return { status: 'failed', detail: removed.body?.error || 'the payment method was not removed', ...(removed.body?.code ? { code: removed.body.code } : {}) };
    }
    // The detach is final at Stripe: a lost audit row never turns a completed
    // removal into a failure.
    void auditStaffPaymentMethodRemoval({
      actorId: ctx.actorId, customerId: step.customer_id, removedMethod: removed.removedMethod, extraMetadata: { via: 'intelligence_bar' },
    }).catch((err) => logger.warn(`[intelligence-bar:billing-write] removal audit failed for customer ${step.customer_id}: ${err.message}`));
    return { status: 'completed', detail: `${preview.method.label} removed`, card_removed: true };
  },
};

async function removeSavedPaymentMethod(input, actionContext = {}) {
  const preview = await planRemoval(input);
  if (preview.error) return preview;

  // Only /confirm-action sets actionContext.confirmed (route-derived, never a
  // model param) — every other call is the plan.
  if (actionContext.confirmed !== true) return preview;

  const approved = actionContext.executionPins?._verified_removal_plan;
  if (!approved?.steps?.length) {
    return { error: 'This removal has no verified plan attached. Ask again for a fresh confirmation card.', preview_changed: true };
  }
  if (planKey(approved) !== planKey(preview)) {
    return { error: 'What this removal would do changed after the card was shown. Ask again for a fresh confirmation card.', preview_changed: true };
  }

  const actorId = actionContext.technicianId || null;
  const receipt = [];
  let halted = false;
  for (const step of preview.steps) {
    if (halted) {
      receipt.push({ step: step.step, status: 'not_attempted', detail: 'an earlier step did not complete' });
      continue;
    }
    let result;
    try {
      result = await REMOVAL_STEP_RUNNERS[step.step](step, preview, { actorId });
    } catch (err) {
      logger.error(`[intelligence-bar:billing-write] step ${step.step} failed: ${err.message}`);
      result = { status: 'failed', detail: step.step === 'remove_payment_method' && /remove the payment method/i.test(err.message) ? err.message : 'step threw — see server log' };
    }
    receipt.push({ step: step.step, ...result });
    if (result.status !== 'completed') halted = true;
  }

  const completed = receipt.filter((r) => r.status === 'completed').length;
  const autopayOff = receipt.some((r) => r.step === 'turn_off_autopay' && r.status === 'completed');
  const cardRemoved = receipt.some((r) => r.step === 'remove_payment_method' && r.status === 'completed');
  logger.info(`[intelligence-bar:billing-write] remove_saved_payment_method ${preview.customer_id}: ${completed}/${receipt.length} steps completed`);
  const allDone = completed === receipt.length;
  return {
    ...(allDone ? { success: true } : completed ? { partial: true } : { error: 'No step completed.', failed: true }),
    customer_id: preview.customer_id,
    receipt,
    state: { autopay_turned_off: autopayOff, card_removed: cardRemoved },
    note: allDone
      ? 'Every planned step completed. The customer notice emails go out only if they are switched on and an email is on file.'
      : autopayOff && !cardRemoved
        ? `Auto Pay is OFF, but ${preview.method.label} is still on file. This is NOT retried automatically — tell the operator exactly that, then ask again for a fresh plan if they still want the card removed.`
        : 'Some steps did not complete — this is NOT retried automatically. Check the receipt, then ask again for a fresh plan.',
  };
}

// ─── correct_invoice_address ─────────────────────────────────────────

const addressText = (a) => [a.address_line1, a.address_line2, [a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
const shownAddress = (a) => ({ address_line1: a.address_line1 || null, address_line2: a.address_line2 || null, city: a.city || null, state: a.state || null, zip: a.zip || null });

async function planAddressCorrection(input) {
  const invoiceId = uuid(input?.invoice_id);
  const invoiceNumber = String(input?.invoice_number || '').trim();
  if (!invoiceId === !invoiceNumber) return { error: 'Give exactly one of invoice_id or invoice_number.' };

  let corrected;
  try {
    corrected = InvoiceAddress.normalizeInvoiceAddressInput(input);
  } catch (err) {
    if (err?.isOperational) return { error: err.message, code: err.code || 'invalid_address' };
    throw err;
  }

  const invoice = await db('invoices').where(invoiceId ? { id: invoiceId } : { invoice_number: invoiceNumber })
    .first('id', 'invoice_number', 'status', 'customer_id');
  if (!invoice) return { error: 'No invoice matches that.', code: 'invoice_not_found' };
  // Staff correct any non-void invoice (the Invoices page offers no Edit
  // address on a void one); the PUT route itself has no status check.
  if (String(invoice.status || '').toLowerCase() === 'void') {
    return { error: `Invoice ${invoice.invoice_number} is void, so its address is not corrected here.`, code: 'invoice_void' };
  }

  const current = await InvoiceAddress.getInvoiceDisplayedAddress(db, invoice.id);
  if (!current) return { error: 'No invoice matches that.', code: 'invoice_not_found' };
  if (['address_line1', 'address_line2', 'city', 'state', 'zip'].every((k) => (current[k] || null) === (corrected[k] || null))) {
    return { error: `Invoice ${invoice.invoice_number} already prints that address — nothing to correct.`, code: 'no_change' };
  }
  const customer = await db('customers').where({ id: invoice.customer_id }).first('first_name', 'last_name', 'company_name');
  return {
    preview: true,
    invoice_id: String(invoice.id),
    invoice_number: invoice.invoice_number,
    invoice_status: invoice.status,
    customer_id: invoice.customer_id ? String(invoice.customer_id) : null,
    customer_name: customer ? customerName(customer) : null,
    address_printed_now: shownAddress(current),
    address_after_correction: shownAddress(corrected),
    printed_now_text: addressText(current),
    after_correction_text: addressText(corrected),
    does: "Rewrites only this invoice's address snapshot — the address its receipt page, invoice and receipt PDFs and billing emails print.",
    does_not: "Amounts, status, the customer's profile, saved properties and payer bill-to are untouched, and nothing is re-sent to the customer.",
    note_to_operator: 'PREVIEW ONLY — nothing was changed. A before/after audit row is written on confirm.',
  };
}

const addressKey = (p) => JSON.stringify([p.invoice_id, p.invoice_status, p.address_printed_now, p.address_after_correction]);

async function correctInvoiceAddress(input, actionContext = {}) {
  const preview = await planAddressCorrection(input);
  if (preview.error) return preview;
  if (actionContext.confirmed !== true) return preview;

  const approved = actionContext.executionPins?._verified_address_correction;
  if (!approved?.invoice_id) {
    return { error: 'This correction has no verified preview attached. Ask again for a fresh confirmation card.', preview_changed: true };
  }
  if (addressKey(approved) !== addressKey(preview)) {
    return { error: 'The invoice or its printed address changed after the card was shown. Ask again for a fresh confirmation card.', preview_changed: true };
  }
  const done = await InvoiceAddress.correctInvoiceAddressAudited(db, preview.invoice_id, input, {
    actorId: actionContext.technicianId || null, via: 'intelligence_bar',
    // Re-checked under the invoice row lock the writer takes: a correction or a
    // void that landed after the re-plan above writes nothing.
    expect: { before: preview.address_printed_now },
  });
  if (!done) return { error: 'No invoice matches that.', code: 'invoice_not_found' };
  if (done.drift) {
    return done.drift === 'void'
      ? { error: `Invoice ${preview.invoice_number} was voided after the card was shown, so its address was not changed.`, code: 'invoice_void', preview_changed: true }
      : { error: 'The invoice\'s printed address changed after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.', preview_changed: true };
  }
  logger.info(`[intelligence-bar:billing-write] corrected the printed address on invoice ${preview.invoice_id}`);
  return {
    success: true,
    invoice_id: preview.invoice_id,
    invoice_number: preview.invoice_number,
    address_before: preview.address_printed_now,
    address_now: shownAddress(done.after),
    note: "Only this invoice's address snapshot changed (an audit row records before and after). Amounts, status, the customer's profile, saved properties and payer bill-to are untouched, and nothing was re-sent to the customer — a copy they already received still shows the old address.",
    // A paid invoice's receipt can go out again with the corrected address: offer it, never send it here.
    ...(preview.invoice_status === 'paid' ? {
      next_step: `Offer the operator to re-send the corrected receipt now (resend_receipt with invoice_id ${preview.invoice_id}); it goes out only on its own confirmation card.`,
    } : {}),
  };
}

async function executeBillingWriteTool(toolName, input, actionContext = {}) {
  try {
    switch (toolName) {
      case 'remove_saved_payment_method': return await removeSavedPaymentMethod(input || {}, actionContext);
      case 'correct_invoice_address': return await correctInvoiceAddress(input || {}, actionContext);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:billing-write] Tool ${toolName} failed: ${err.message}`);
    return { error: err.message };
  }
}

module.exports = { BILLING_WRITE_TOOLS, executeBillingWriteTool };
