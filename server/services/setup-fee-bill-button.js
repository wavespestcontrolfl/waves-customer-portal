'use strict';

// "Bill and send" on the "Completed first visit needs manual billing" bell (GATE_SETUP_FEE_BILL_BUTTON; owner
// 2026-11-24 "do whateverr you rec", after a Mark Won first visit on 11-23 completed with no invoice and the owner
// billed and sent it by hand). Button kind `setup_fee_bill` (admin-alert-buttons.js).
//
// The tap does what the owner did by hand, through the same server steps the Intelligence Bar cards use:
//   1. create_invoice: one invoice linked to the completed visit with the two lines the bell names ("First service
//      application" and "WaveGuard Membership — one-time setup fee") and "accepted estimate #<id>" in the notes. The
//      Invoices page create handler runs it: the mint lock, the setup-fee alert lock and reconcile, the approved-scope
//      recheck under the locks, and the total check are all the route's own.
//   2. send_invoice: the Invoices page send of that invoice, by text. A customer the text cannot reach is refused
//      before anything is created (the Invoices page sends by email).
//
// It runs only on the plain case the bell row was raised for (the completion found nothing billed): one parked
// visit, no live invoice on it, no part of the fee or the application billed anywhere, the alert still open and not
// resolved. Anything else answers "use the Invoices page" and changes nothing. The amounts come from the row's
// button args, written by the completion when it raised the row, and the visit must still read as it did then.

const db = require('../models/db');
const logger = require('./logger');

const DEDUPE_PREFIX = 'unminted_setup_fee_manual_billing:';
const APPLICATION_LINE = 'First service application';
const FEE_LINE = 'WaveGuard Membership — one-time setup fee';

function live() {
  return process.env.GATE_SETUP_FEE_BILL_BUTTON === 'true';
}

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

// Never "bill it" outright: the refusal may be coverage. Staff check what exists, then bill only what is unpaid.
const office = (why) => ({ ok: false, code: 'office', message: `${why} Check the customer's invoices, then bill only what is still unpaid from the Invoices page.` });
const centsOk = (n) => Number.isSafeInteger(n) && n > 0;
// A visit price column as cents, -1 for none (button args hold numbers only).
const priceCents = (value) => (value == null || value === '' ? -1 : Math.round(Number(value) * 100));

// The row's metadata, read as the plain case: this estimate's alert, one parked visit, nothing covered.
function metadataFacts(meta) {
  const dedupeKey = String(meta.dedupeKey || '');
  if (!dedupeKey.startsWith(DEDUPE_PREFIX)) return { refusal: office('This alert is not a first-visit billing alert.') };
  const estimateId = dedupeKey.slice(DEDUPE_PREFIX.length);
  if (!estimateId || String(meta.sourceEstimateId || '') !== estimateId) return { refusal: office('This alert does not name its estimate.') };
  const visitId = String(meta.scheduledServiceId || '');
  const parked = Array.isArray(meta.parkedVisitIds) ? meta.parkedVisitIds.map(String) : [];
  if (!visitId || parked.some((id) => id !== visitId)) return { refusal: office('More than one visit is unbilled on this estimate.') };
  if (meta.liveBesideInvoiceId) return { refusal: office('Another invoice is already on this visit.') };
  if (meta.billButtonDraftInvoiceId) return { refusal: office('A draft invoice was already created from this alert.') };
  const covered = [meta.resolvedCovered === true, meta.feeCovered, meta.applicationCovered, meta.feeOnOpenInvoice,
    Number(meta.coveredFeeCents) > 0].some(Boolean);
  if (covered) return { refusal: office('Part of this bill is already covered.') };
  if (!meta.serviceRecordId || !meta.customerId) return { refusal: office('This alert does not name its visit.') };
  return { estimateId, visitId };
}

// The button's amounts, equal to the row's recorded ones, for a visit billed at its own explicit price.
function amountFacts(item, meta, visitId) {
  const args = item?.args || {};
  const [applicationCents, feeCents, priceBasis, primaryCents] = ['applicationCents', 'feeCents', 'priceCents', 'primaryCents']
    .map((key) => Number(args[key]));
  if (!Number.isSafeInteger(priceBasis) || !Number.isSafeInteger(primaryCents)) return { refusal: office('The visit price on this alert is not readable.') };
  // Only a visit billed at its own explicit price (no primary line, no rate fallback): the button proves that price.
  if (priceBasis !== applicationCents || primaryCents !== -1) return { refusal: office('This visit is not billed at its own listed price.') };
  if (!centsOk(applicationCents) || !centsOk(feeCents)) return { refusal: office('The amounts on this alert are not readable.') };
  if (feeCents !== Number(meta.expectedSetupFeeCents)
    || applicationCents !== Number(meta.expectedApplicationCentsByVisit?.[visitId])) {
    return { refusal: office('The amounts on this alert changed since it was raised.') };
  }
  return { applicationCents, feeCents, priceCents: priceBasis, primaryCents };
}

// The row's own facts, or a refusal. Never trusts the row's words: amounts are checked against the records below.
function readRow(row, item) {
  if (!row?.id) return { refusal: office('This alert is not readable.') };
  const meta = parseMetadata(row?.metadata);
  const ids = metadataFacts(meta);
  if (ids.refusal) return ids;
  const amounts = amountFacts(item, meta, ids.visitId);
  if (amounts.refusal) return amounts;
  return {
    rowId: String(row.id), item, ...ids, serviceRecordId: String(meta.serviceRecordId), customerId: String(meta.customerId), ...amounts,
  };
}

// The records must still read as the plain case: the visit completed for this customer and estimate, and the fee
// not settled anywhere on the account (setupFeeSettledElsewhere: paid, waived, prepay).
async function recordsRefusal(facts) {
  const visit = await db('scheduled_services').where({ id: facts.visitId }).first('id', 'customer_id', 'source_estimate_id', 'status');
  if (!visit || String(visit.customer_id) !== facts.customerId || String(visit.source_estimate_id || '') !== facts.estimateId) {
    return office('The visit on this alert changed.');
  }
  if (visit.status !== 'completed') return office('The visit is no longer completed.');
  // Bring the row up to date first: the reconcile resolves it when a stamped invoice, a prepay or a payment now
  // covers either charge. A row it touched no longer reads as the plain case.
  await require('./setup-fee-alert-reconcile').reconcileSetupFeeAlert({ customerId: facts.customerId, sourceEstimateId: facts.estimateId, actorLabel: 'bill-button' });
  const row = await db('notifications').where({ id: facts.rowId }).first('done_at', 'metadata');
  const meta = parseMetadata(row?.metadata);
  if (!row || row.done_at != null || meta.resolvedCovered === true || meta.feeCovered || meta.applicationCovered) {
    return office('Part of this bill is already covered.');
  }
  return null;
}

// Taken first in the create transaction, before the card's customer FOR SHARE and visit lock: the account's setup-fee
// advisory lock first (matching InvoiceService.create's global lock order so an unlinked fee invoice can never ABBA
// deadlock on setup_fee_account vs customers), then the customer row FOR UPDATE, then the customer's live invoice
// rows FOR UPDATE (in id order). Waits are bounded (3 s): lock timeout (55P03) or deadlock (40P01) refuses retryably.
function customerPreLock(facts) {
  return async (trx) => {
    await trx.raw("SET LOCAL lock_timeout = '3s'");
    try {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`setup_fee_account:${facts.customerId}`]);
      await trx('customers').where({ id: facts.customerId }).forUpdate().first('id');
      await trx('invoices').where({ customer_id: facts.customerId })
        .whereNotIn('status', ['void', 'cancelled', 'canceled']).orderBy('id').forUpdate().select('id');
    } catch (err) {
      if (err?.code === '55P03' || err?.code === '40P01') {
        throw Object.assign(new Error('This customer\'s invoices are being changed right now, so nothing was created. Try again in a minute'),
          { isOperational: true, statusCode: 409, code: 'IB_SCOPE_CHANGED' });
      }
      throw err;
    }
    await trx.raw('SET LOCAL lock_timeout TO DEFAULT');
  };
}

// Run inside the create transaction, after the card's own locks (visit mint lock, the setup-fee alert lock) and its
// scope recheck: nothing may cover either charge now. Throws a 409 to refuse; nothing is created.
// Other billing that owns the visit or changes its lines. Returns the refusal reason, or null.
async function visitBillingRefusal(trx, facts, visit) {
  if (await trx('scheduled_service_addons').where({ scheduled_service_id: facts.visitId }).first('id')) return 'The visit has add-ons';
  const Recovery = require('./billing-recovery-bill');
  // A card hold on the visit (held, charging, or a charge whose outcome is in review) may already collect it.
  if (await Recovery.liveCardHoldForVisit(facts.visitId, trx)) return 'A card hold is open on this visit';
  // Billing Recovery handled the visit (Mark free, Bill, Billed elsewhere): a live disposition refuses.
  const disposition = await Recovery.currentDisposition(trx, facts.visitId);
  if (disposition && !disposition.stale) return 'Billing Recovery already handled this visit';
  // A priced member visit billed on its trip's combined first-application invoice (the mint's own guard).
  try {
    await require('./estimate-first-application-invoice').refuseCoveredMemberMintInTrx(trx, facts.visitId);
  } catch (err) {
    if (err?.code === 'FIRST_APPLICATION_COVERED') return 'The trip\'s combined first-application invoice bills this visit';
    throw err;
  }
  // GATE_INVOICE_ESTIMATE_DISCOUNT_LINES: the visit invoice would list the estimate's discounts as their own lines,
  // which this two-line invoice cannot. Fail closed on an unreadable breakdown.
  if (require('../config/feature-gates').invoiceEstimateDiscountLinesLive()) {
    let breakdown;
    try {
      ({ breakdown } = await trx.transaction((sp) => require('./completion-pricing').acceptedVisitBreakdown(visit, { database: sp })));
    } catch {
      return 'The estimate discount check failed';
    }
    if (breakdown && Math.round(Number(breakdown.amount) * 100) === facts.applicationCents) return 'This visit\'s invoice lists estimate discounts';
  }
  return null;
}

// The visit-side checks, shared by the create transaction and the send claim (nothing that reads invoices, so the
// new draft never trips them): the visit as the button priced it, and nothing else covering the application.
// Returns the refusal reason, or null.
async function applicationCoverageRefusal(trx, facts, visit) {
  if (!visit || String(visit.customer_id) !== facts.customerId || String(visit.source_estimate_id || '') !== facts.estimateId
    || visit.status !== 'completed') {
    return 'The visit changed';
  }
  // Monthly dues: a dues or prepay billing lane, or dues collected for the visit's month, cover the application
  // (the completion's own check, under its month lock).
  const Lane = require('./billing-lane');
  const customer = await trx('customers').where({ id: facts.customerId }).first();
  if (['monthly_membership', 'annual_prepay'].includes(Lane.resolveBillingLane(customer || {}).mode)) {
    return 'Monthly dues or a prepay cover this customer';
  }
  const month = require('../utils/date-only').dateOnlyString(visit.scheduled_date).slice(0, 7);
  // Bounded, like the scheduled mint: a dues-invoice void can hold the month lock while it waits on this customer.
  if (!(await Lane.acquireMembershipDuesMonthLockBounded(trx, facts.customerId, month))) {
    return 'Monthly dues billing is busy for this customer; try again in a minute';
  }
  if (await Lane.monthlyDuesCollected(trx, facts.customerId, new Date(`${month}-15T12:00:00Z`), { excludeScheduledServiceId: visit.id })) {
    return 'Monthly dues already cover this visit';
  }
  // The visit's price as the completion priced the bell: a correction since refuses (the button amount is stale).
  if (priceCents(visit.estimated_price) !== facts.priceCents || priceCents(visit.primary_line_price) !== facts.primaryCents) {
    return 'The visit price changed since the visit was completed';
  }
  const billingWhy = await visitBillingRefusal(trx, facts, visit);
  if (billingWhy) return billingWhy;
  if (visit.prepaid_method || Number(visit.prepaid_amount) > 0) return 'The visit has a prepayment';
  let bought;
  try {
    bought = await trx.transaction((sp) => require('./annual-prepay-renewals').prepayYearBillingVisit(visit, sp));
  } catch {
    return 'The prepay check failed';
  }
  if (bought) return 'A prepay year already bills this visit';
  if (await trx('retention_offers').where({ customer_id: facts.customerId, status: 'granted' }).first('id')) {
    return 'A granted retention offer could discount this visit';
  }
  return null;
}

async function feeCoverageRefusal(trx, facts) {
  const { acceptedEstimateIdFromNotes } = require('./setup-fee-alert-reconcile');
  const live = await trx('invoices').where({ customer_id: facts.customerId })
    .whereNotIn('status', ['void', 'cancelled', 'canceled']).select('id', 'notes', 'line_items');
  if (live.some((inv) => String(acceptedEstimateIdFromNotes(inv.notes) || '').toLowerCase() === facts.estimateId.toLowerCase())) {
    return 'An invoice for this estimate already exists';
  }
  // Any live invoice on the account (a draft included) that carries setup-fee or membership money.
  const { carriesWaveguardFeeLine } = require('./setup-fee-obligation');
  if (live.some((inv) => carriesWaveguardFeeLine(inv))) return 'A setup or membership fee (or its waiver) is already on an invoice for this account';
  const settled = await require('./setup-fee-obligation').setupFeeSettledElsewhere(trx, {
    customerId: facts.customerId, expectedFeeCents: facts.feeCents, sourceEstimateId: facts.estimateId,
  });
  if (settled?.settled || (settled?.partial || []).length || (settled?.open || []).length) return 'Setup fee money is already on this account';
  const Prepay = require('./annual-prepay-renewals');
  const term = await Prepay.coveredTermsAsOf(trx, null).where('t.source_estimate_id', facts.estimateId).first('t.id');
  if (term) return 'An annual prepay covers this estimate';
  return null;
}

async function feeObligationRefusal(trx, facts, visit) {
  // The fee must still be the never-invoiced one, owed in full: no stamp queued on the series for a later
  // completion (or in flight), no office handoff, the detector's own amount. The detector reads with the
  // completion's own arguments.
  const seriesId = visit.recurring_parent_id || visit.id;
  const parent = await trx('scheduled_services').where({ id: seriesId }).first('pending_setup_fee');
  if (Number(parent?.pending_setup_fee || 0) !== 0) return 'A setup fee is queued on this plan';
  const obligation = await require('./setup-fee-obligation').findUnmintedSetupFeeObligation({
    sourceEstimateId: facts.estimateId, customerId: facts.customerId, excludeScheduledServiceId: visit.id,
    visitPlanRow: { recurring_parent_id: visit.recurring_parent_id, is_recurring: visit.is_recurring },
  }, trx);
  if (!obligation?.owed || Math.round(Number(obligation.setupFee) * 100) !== facts.feeCents
    || (obligation.unconsumableStamps || []).length) {
    return 'The setup fee is no longer owed as the alert says';
  }
  return null;
}

async function alertRefusal(trx, facts) {
  // The alert as it stands now: a completion may have re-parked it (another visit, new amounts) after the tap.
  const row = await trx('notifications').where({ id: facts.rowId }).first('id', 'done_at', 'metadata');
  if (!row || row.done_at != null) return 'This alert was resolved';
  const now = readRow(row, facts.item);
  if (now.refusal || now.visitId !== facts.visitId || now.applicationCents !== facts.applicationCents || now.feeCents !== facts.feeCents) {
    return 'This alert changed after the tap';
  }
  return null;
}

function coverageRecheck(facts) {
  const covered = (why) => Object.assign(new Error(`${why}, so nothing was created.`), { isOperational: true, statusCode: 409, code: 'IB_SCOPE_CHANGED' });
  return async (trx) => {
    const feeWhy = await feeCoverageRefusal(trx, facts);
    if (feeWhy) throw covered(feeWhy);
    // The visit as the card's lock holds it: no add-ons (one may be the WaveGuard Membership line already in its
    // price), no prepayment of any size, and no prepay year (paid or awaiting payment) that already bills it.
    const visit = await trx('scheduled_services').where({ id: facts.visitId }).first();
    if (!visit) throw covered('The visit changed');
    const obligationWhy = await feeObligationRefusal(trx, facts, visit);
    if (obligationWhy) throw covered(obligationWhy);
    const applicationWhy = await applicationCoverageRefusal(trx, facts, visit);
    if (applicationWhy) throw covered(applicationWhy);
    // Account credit the page's send would draw (the bar's send never draws it): the page bills that case.
    const wouldDraw = await require('./customer-credit').autoApplyWouldApply({
      customer_id: facts.customerId, total: (facts.applicationCents + facts.feeCents) / 100, credit_applied: 0, amount_paid: 0,
    }, trx);
    if (wouldDraw) throw covered('Account credit would apply to this invoice');
    const Deposits = require('./estimate-deposits');
    await Deposits.acquireEstimateDepositLedgerLock(trx, facts.estimateId);
    if (await Deposits.pendingDepositCredit(facts.estimateId, trx)) throw covered('An estimate deposit is waiting to be applied');
    const alertWhy = await alertRefusal(trx, facts);
    if (alertWhy) throw covered(alertWhy);
  };
}

function invoiceInput(facts) {
  return {
    customer_id: facts.customerId,
    service_record_id: facts.serviceRecordId,
    line_items: [
      { description: APPLICATION_LINE, quantity: 1, unit_price: facts.applicationCents / 100 },
      { description: FEE_LINE, quantity: 1, unit_price: facts.feeCents / 100 },
    ],
    notes: `accepted estimate #${facts.estimateId}`,
  };
}

// The send step can text this customer, checked BEFORE anything is created: a draft the button cannot deliver would
// retire the alert unsent. Text only: no collections hold, invoices by text, a phone on file.
async function deliveryRefusal(customerId) {
  const Send = require('./intelligence-bar/invoice-action-tools');
  if (await Send.messagingHold(customerId)) return office('A collections hold stops messages to this customer.');
  if (!(await Send.billingChannelState(customerId, db, 'text')).supported) return office('This customer does not get invoices by text.');
  if (!(await require('../routes/admin-sms-templates').isTemplateActive('invoice', { requireRow: true }))) return office('The invoice text template is switched off.');
  const prefs = await db('notification_prefs').where({ customer_id: customerId }).first('sms_enabled');
  if (prefs && prefs.sms_enabled === false) return office('This customer opted out of texts.');
  const who = await db('customers').where({ id: customerId }).first('phone');
  const digits = String(who?.phone || '').replace(/\D/g, '');
  if (digits.length < 10) return office('No usable phone is on file for this customer.');
  // An active suppression on the phone (a spoken opt-out, a wrong-number flag, a staff do-not-contact) blocks
  // every text to it (recipient-optin.js phoneSuppressed).
  const suppressed = await db('messaging_suppression')
    .whereRaw("right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ?", [digits.slice(-10)])
    .where('active', true).first('phone');
  if (suppressed) return office('Texts to this customer\'s phone are blocked.');
  // A first send that would also mark an open lead won is refused by Step 2: check BEFORE creating the draft
  // so we never mint an unsent draft deterministically whenever the customer has an open lead.
  const leadTargets = await require('./lead-estimate-link').invoiceSentConversionTargets(customerId, db);
  if (leadTargets?.unreadable) return office('Open leads for this customer could not be checked.');
  return (leadTargets?.leadIds || []).length ? office('Sending this invoice would also mark an open lead won.') : null;
}

function stampPendingDraftOnAlert(facts) {
  return async (trx, created) => {
    if (!facts?.rowId || !created?.id) return;
    const patch = {
      billButtonDraftInvoiceId: String(created.id),
      billButtonDraftInvoiceNumber: created.invoice_number || null,
      billButtonSendState: 'send_pending',
    };
    await trx('notifications').where({ id: facts.rowId }).update({
      metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(patch)]),
    });
  };
}

// Step 1: the create card's plan, refused unless it is exactly the plain case, then its commit on that plan.
async function createInvoice(facts) {
  const Create = require('./intelligence-bar/create-invoice-tools');
  const undeliverable = await deliveryRefusal(facts.customerId);
  if (undeliverable) return { refusal: undeliverable };
  const input = invoiceInput(facts);
  const plan = await Create.planDraftInvoice(input);
  if (plan.error) return { refusal: office(`The invoice could not be prepared: ${plan.error}`) };
  if ((plan._approved?.visitInvoices || []).length) return { refusal: office('An invoice is already on this visit.') };
  if (String(plan._approved?.scheduledServiceId || '') !== facts.visitId) return { refusal: office('The service record no longer links this visit.') };
  // The total the button shows, exactly: tax or any other change refuses.
  if (plan._approved?.expectedTotalCents !== facts.applicationCents + facts.feeCents) {
    return { refusal: office('The invoice total differs from the amount on the button (tax or a discount applies).') };
  }
  const created = await Create.commitDraftInvoice({
    ...input,
    _verified_invoice_create_version: plan._version,
    _callerPreLock: customerPreLock(facts),
    _callerRecheck: coverageRecheck(facts),
    // Persist the draft id onto the alert inside the create transaction so a crash between create and send
    // cannot let a sweep auto-resolve the bell from the unsent draft.
    _callerPostCreate: stampPendingDraftOnAlert(facts),
    // Defer the post-create alert reconcile until Step 2 finishes so an unsent draft never closes the bell as RESOLVED.
    _deferSetupFeeReconcile: true,
  });
  if (created.success) return { created };
  if (created.outcome_unknown) {
    return { refusal: { ok: false, code: 'unknown', message: 'The invoice may or may not have been created. Check the customer’s invoices before you try again.' } };
  }
  return { refusal: office(created.error || 'The invoice was not created.') };
}

// Step 2: the send card's plan and commit, by text.
// The send plan must describe the draft this tap created, unchanged: the two lines, the total, never sent, and the
// edit time the plan pinned (the send claim enforces that version from here on).
async function draftUnchanged(invoiceId, plan, facts) {
  const inv = await db('invoices').where({ id: invoiceId }).first('status', 'total', 'sent_at', 'updated_at', 'line_items');
  if (!inv || inv.status !== 'draft' || inv.sent_at) return false;
  let lines = inv.line_items;
  if (typeof lines === 'string') { try { lines = JSON.parse(lines); } catch { return false; } }
  const want = [[APPLICATION_LINE, facts.applicationCents], [FEE_LINE, facts.feeCents]];
  const sameLines = Array.isArray(lines) && lines.length === 2
    && lines.every((li, i) => li?.description === want[i][0] && Math.round(Number(li.amount) * 100) === want[i][1]);
  return sameLines && Math.round(Number(inv.total) * 100) === facts.applicationCents + facts.feeCents
    && plan._version?.total_cents === facts.applicationCents + facts.feeCents
    && Number.isFinite(facts.createdVersion) && plan._version?.invoice_version === facts.createdVersion
    && new Date(inv.updated_at).getTime() === facts.createdVersion;
}

// The send claim's own check on the claimed row (run at the claim and again at the provider handoff), in the claim's
// locked transaction. Records a coverage conflict so the tap never tells staff to send the draft by hand.
function sendVerify(facts) {
  const state = { conflict: false };
  state.verify = async (claimed, database) => {
    if (await require('./customer-credit').autoApplyWouldApply(claimed, database)) {
      return 'Account credit would apply to this invoice, so it was not sent. Send it from the Invoices page.';
    }
    // The visit-side checks again: dues, a prepayment, a prepay year, a price change since the create.
    const visit = await database('scheduled_services').where({ id: facts.visitId }).first();
    const visitWhy = await applicationCoverageRefusal(database, facts, visit);
    if (visitWhy) {
      state.conflict = true;
      return `${visitWhy}, so this invoice was not sent.`;
    }
    // Another live invoice that now bills either charge (committed after the create released its locks): one on this
    // visit, or one with a WaveGuard fee line of any amount (a $0 line is a waiver). Or the fee settled elsewhere.
    const Fee = require('./setup-fee-obligation');
    // Non-blocking locks in a savepoint: the send claim already holds claimed.id FOR UPDATE, so waiting on
    // setup_fee_account or another invoice row could form an ABBA cycle (40P01). pg_try_advisory_xact_lock and
    // FOR UPDATE NOWAIT refuse contention immediately instead of deadlocking.
    let others;
    try {
      others = await database.transaction(async (sp) => {
        const lockRes = await sp.raw('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS acquired', [`setup_fee_account:${claimed.customer_id}`]);
        if (lockRes?.rows?.[0]?.acquired !== true) {
          throw Object.assign(new Error('setup_fee_account busy'), { code: '55P03' });
        }
        return sp('invoices').where({ customer_id: claimed.customer_id }).whereNot('id', claimed.id)
          .whereNotIn('status', ['void', 'cancelled', 'canceled']).orderBy('id').forUpdate().noWait()
          .select('id', 'notes', 'line_items', 'scheduled_service_id', 'service_record_id');
      });
    } catch (err) {
      if (err?.code !== '55P03' && err?.code !== '40P01') throw err;
      state.conflict = true;
      return 'Another invoice for this customer is being changed right now, so this one was not sent.';
    }
    const { acceptedEstimateIdFromNotes } = require('./setup-fee-alert-reconcile');
    const onVisit = others.some((inv) => String(inv.scheduled_service_id || '') === facts.visitId
      || String(inv.service_record_id || '') === facts.serviceRecordId
      || String(acceptedEstimateIdFromNotes(inv.notes) || '').toLowerCase() === facts.estimateId.toLowerCase());
    const settled = await Fee.setupFeeSettledElsewhere(database, {
      customerId: claimed.customer_id, expectedFeeCents: facts.feeCents, sourceEstimateId: facts.estimateId,
    });
    if (onVisit || others.some((inv) => Fee.carriesWaveguardFeeLine(inv)) || settled?.settled) {
      state.conflict = true;
      return 'Another invoice now bills this visit or the setup fee, so this one was not sent.';
    }
    return null;
  };
  return state;
}

async function sendInvoice(invoiceId, technicianId, facts) {
  const Send = require('./intelligence-bar/invoice-action-tools');
  const plan = await Send.planInvoiceSend({ invoice_id: invoiceId });
  // A pay-link text already scheduled owns the delivery: keep that answer.
  if (plan.code === 'invoice_send_queued') return { code: 'invoice_send_queued' };
  if (plan.error) return { error: plan.error };
  // A lead the send would mark won (the plan's applied lead set) is outside what the confirm prompt names, so the
  // draft stays for the Invoices page card. The other effects (the text, its reminders, the visit closeout, the
  // informational rows) are what any send of this invoice does.
  if (plan._lead_targets && plan._lead_targets !== 'none') return { error: 'this send would also mark a lead won' };
  if (!(await draftUnchanged(invoiceId, plan, facts))) {
    const inv = await db('invoices').where({ id: invoiceId }).first('status', 'sent_at');
    // Someone else may have sent or edited it: never ask for a blind resend.
    return { outcome_unknown: true, code: inv?.sent_at || inv?.status !== 'draft' ? 'sent_elsewhere' : 'draft_changed' };
  }
  const input = { invoice_id: invoiceId };
  // Under the send claim: account credit that became available after the create would reduce this bill, and the
  // bar's send never draws credit, so the draft stays for the Invoices page.
  const check = sendVerify(facts);
  const result = await Send.commitInvoiceSend({ ...input, _verified_invoice_send_version: plan._version, _callerVerify: check.verify }, { isAdmin: true, technicianId });
  return check.conflict && !sentOk(result) ? { ...result, conflict: true } : result;
}

const sentOk = (result) => result?.text?.status === 'sent';

const changedElsewhere = (number) => `Invoice ${number} was created, then changed or sent by someone else, so this button did not send it. Check its delivery history before you send it.`;

// A send whose record could not be finished (the message may have gone out): check, never resend.
function unknownSendOutcome(number, sent) {
  return {
    ok: true, keepOpen: true, resolution: `Billed ${number} from the bell; send unconfirmed`,
    message: sent.code === 'draft_changed' || sent.code === 'sent_elsewhere'
      ? changedElsewhere(number)
      : `Invoice ${number} was created. Its send could not be confirmed: check the invoice before you send it again.`,
  };
}

function noSendNeededOutcome(number, sent) {
  const why = sent.code === 'invoice_send_queued' ? 'Its pay-link text is already scheduled and will go out.' : (sent.note || 'It needs no other send.');
  return { ok: true, message: `Invoice ${number} was created. ${why}`, resolution: `Billed ${number} from the bell`, keepOpen: true };
}

async function clearPendingDraftOnAlert(row) {
  if (!row?.id) return;
  try {
    await db('notifications').where({ id: row.id }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) - 'billButtonDraftInvoiceId' - 'billButtonDraftInvoiceNumber' - 'billButtonSendState'"),
    });
  } catch (err) {
    logger.warn(`[setup-fee-bill-button] could not clear pending draft marker on alert ${row.id}: ${err.message}`);
  }
}

async function reconcileAfterBillButtonSend(row, facts, created) {
  await clearPendingDraftOnAlert(row);
  try {
    await require('./setup-fee-alert-reconcile').reconcileSetupFeeAlert({
      customerId: facts.customerId,
      sourceEstimateId: facts.estimateId,
      actorLabel: ` bill-button ${created.invoice_id}:`,
    });
  } catch (err) {
    logger.error(`[setup-fee-bill-button] setup-fee alert reconcile failed after send of ${created.invoice_id}: ${err.message}`);
  }
}

async function reopenAlertForUnsentDraft(row, created, message, sendState) {
  try {
    const NotificationService = require('./notification-service');
    const number = created.invoice_number || 'the new invoice';
    const bodyColumns = NotificationService.adminBodyColumns(
      'billing',
      `ACTION NEEDED: draft invoice ${number} was created from this alert but not sent. ${message}`,
    );
    const patch = {
      resolvedCovered: false,
      billButtonDraftInvoiceId: String(created.invoice_id),
      billButtonDraftInvoiceNumber: created.invoice_number || null,
      billButtonSendState: sendState,
    };
    await db('notifications').where({ id: row.id }).update({
      ...bodyColumns,
      done_at: null,
      done_by: null,
      resolution: null,
      read_at: null,
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(patch)]),
    });
  } catch (err) {
    logger.warn(`[setup-fee-bill-button] could not reopen alert ${row?.id} for draft ${created?.invoice_id}: ${err.message}`);
  }
}

async function finalizeRefusedSend(row, created, sent, facts, number) {
  const now = await db('invoices').where({ id: created.invoice_id }).first('status', 'sent_at');
  if (!now || now.sent_at || now.status !== 'draft') {
    await reconcileAfterBillButtonSend(row, facts, created);
    return {
      ok: true, keepOpen: true, resolution: `Billed ${number} from the bell; send unconfirmed`, message: changedElsewhere(number),
    };
  }
  logger.warn(`[setup-fee-bill-button] alert ${row.id}: created ${created.invoice_id}, send ${sent?.code || 'not confirmed'}`);
  const out = {
    ok: true,
    message: `Invoice ${number} was created but not sent (${sent?.error || 'the send was refused'}). Send it from the Invoices page.`,
    resolution: `Billed ${number} from the bell; not sent`,
    keepOpen: true,
  };
  await reopenAlertForUnsentDraft(row, created, out.message, sent?.code || 'send_refused');
  return out;
}

// What the tap answers once the invoice exists: Step 1 deferred the alert reconcile until Step 2 finishes, so
// only a confirmed/no-send-needed delivery resolves the bell; any unsent draft or unconfirmed send keeps/reopens
// the bell naming the draft invoice number so staff are never silently told "RESOLVED — no action needed".
async function sendOutcome(row, created, sent, facts) {
  const number = created.invoice_number || 'the new invoice';
  if (sent?.outcome_unknown) {
    const out = unknownSendOutcome(number, sent);
    if (sent.code === 'sent_elsewhere') await reconcileAfterBillButtonSend(row, facts, created);
    else await reopenAlertForUnsentDraft(row, created, out.message, sent.code || 'unconfirmed');
    return out;
  }
  if (sent?.conflict) {
    logger.warn(`[setup-fee-bill-button] alert ${row.id}: created ${created.invoice_id}, send refused: coverage changed`);
    const out = {
      ok: true, keepOpen: true, resolution: `Billed ${number} from the bell; not sent (coverage changed)`,
      message: `Invoice ${number} was created but not sent: ${sent.error || 'something else now covers part of it'} Reconcile it with the customer's other billing on the Invoices page before you send anything.`,
    };
    await reopenAlertForUnsentDraft(row, created, out.message, 'coverage_conflict');
    return out;
  }
  if (sentOk(sent)) {
    logger.info(`[setup-fee-bill-button] alert ${row.id}: created and sent ${created.invoice_id}`);
    await reconcileAfterBillButtonSend(row, facts, created);
    return { ok: true, message: `Invoice ${number} for ${created.amount} was created and sent.`, resolution: `Billed and sent ${number} from the bell`, keepOpen: true };
  }
  if (sent?.success === true || sent?.code === 'invoice_send_queued') {
    await reconcileAfterBillButtonSend(row, facts, created);
    return noSendNeededOutcome(number, sent);
  }
  return finalizeRefusedSend(row, created, sent, facts, number);
}

// Every outcome that created an invoice leaves the row to the stamped-invoice reconcile the create runs (keepOpen):
// it closes the row only when every parked visit is billed, so a visit parked meanwhile keeps its instruction.
const buttonHandler = {
  live,
  // Served only while the row still reads as the plain case (a reconcile may have rewritten it to name a covered
  // charge or another parked visit); the tap checks again.
  async visibleItems(rows) {
    const out = new Map();
    for (const row of rows) {
      const meta = parseMetadata(row.metadata);
      const item = (meta.buttons?.items || []).find((i) => i.id === 'bill_send');
      if (!item || readRow(row, item).refusal) continue;
      out.set(row.id, ['bill_send']);
    }
    return out;
  },
  async run({ row, item, technicianId }) {
    if (item?.id !== 'bill_send') return { ok: false, code: 'unknown_action', message: 'This button is not known.' };
    const facts = readRow(row, item);
    if (facts.refusal) return facts.refusal;
    const refused = await recordsRefusal(facts);
    if (refused) return refused;
    const { created, refusal } = await createInvoice(facts);
    if (refusal) return refusal;
    let sent;
    try {
      sent = await sendInvoice(created.invoice_id, technicianId, { ...facts, createdVersion: created.invoice_version });
    } catch (err) {
      logger.error(`[setup-fee-bill-button] send of ${created.invoice_id} failed (${err.code || err.name || 'error'})`);
      sent = { outcome_unknown: true };
    }
    return sendOutcome(row, created, sent, facts);
  },
};

// The button a completion puts on the row it raises for the plain case (both charges unbilled).
function billButtons({ applicationCents, feeCents, visit }) {
  if (!centsOk(applicationCents) || !centsOk(feeCents) || !visit) return null;
  const total = ((applicationCents + feeCents) / 100).toFixed(2);
  return {
    kind: 'setup_fee_bill',
    items: [{
      id: 'bill_send',
      label: `Bill and send $${total}`,
      prompt: 'Bill the visit and setup fee on one invoice, then text it with payment reminders?',
      args: { applicationCents, feeCents, priceCents: priceCents(visit.estimated_price), primaryCents: priceCents(visit.primary_line_price) },
    }],
  };
}

module.exports = { buttonHandler, billButtons, _private: { readRow, customerPreLock, coverageRecheck, sendVerify, invoiceInput, APPLICATION_LINE, FEE_LINE } };
