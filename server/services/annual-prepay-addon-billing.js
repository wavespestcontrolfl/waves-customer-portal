/**
 * Completing an annual-prepay-COVERED visit: its invoice and its add-ons.
 *
 * The covered BASE work is already paid on the annual prepay invoice, so a
 * live covered visit never carries a collectible invoice for it: an open
 * invoice with no add-ons is SETTLED as non-cash annual-prepay coverage
 * ('prepaid' — no pay link, no payments row, no revenue double-count); one
 * that mixes the base with other charges, or carries applied account /
 * deposit credit, is VOIDED (voidInvoice restores the credit and cancels the
 * PI). A cash-paid / in-flight invoice is left for normal handling, and an
 * invoice-issued closeout's invoice is never touched (the office sent it).
 *
 * ADMIN-BUG-R13 (owner ruling 2026-09-26: auto-bill, an office alert when
 * the amount is unclear; GATE_ANNUAL_PREPAY_ADDON_BILLING) — the visit's
 * add-ons are owed on top of the coverage:
 *   - When the visit has no invoice history (the common case: the prepay
 *     suppresses the completion invoice), they are billed alone through the
 *     shared scheduled-invoice mint — pay link, unpaid completion text. The
 *     bill's id is recorded on the service record, so a retry takes back
 *     its own bill.
 *   - When the visit already has any other invoice — open, paid, in flight,
 *     voided, refunded, payer-billed — what is still owed depends on what
 *     that invoice charged, and the office decides: ONE alert names the
 *     invoice and asks them to bill what it does not already charge.
 *     Deciding that automatically (paid vs in-flight vs mixed vs adopted
 *     invoices, each across crash-and-retry) is the surface that kept
 *     yielding new review findings; it stays human.
 *   - An unclear amount (a visit-wide discount, an add-on awaiting its
 *     price, a grouped closeout) is alerted too; the completion text never
 *     says "all paid" over an alerted remainder.
 * Retry safety: the gate is frozen on the record at its first gate-on pass;
 * a failed add-on read, a failed freeze write, or an office alert that did
 * not land returns a hold (the caller keeps the closeout unfinalized —
 * release + 503 — and the retry decides again).
 */

const db = require('../models/db');
const logger = require('./logger');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('./short-url');
const { etDateString } = require('../utils/datetime-et');

function parseNotes(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

const roundCents = (n) => Math.round(n * 100) / 100;
// How an invoice is named in an office alert.
const invoiceLabel = (invoice) => invoice?.invoice_number || invoice?.id || 'unknown';

// The visit's add-on rows, read strictly — the canonical line builder
// swallows a failed read into "no add-ons", which here would silently skip a
// bill. A priced row is one the builder turns into a line (its base_price
// when set, else its estimated_price, above zero); an explicit zero is free.
// An unpriced row (both prices blank) is a quote still awaiting its price —
// owed, but nothing here can bill it. `fingerprint` pins the rows the lines
// were built from (the mint re-checks it under the visit lock).
async function annualPrepayAddonRows(svc, conn = db) {
  const rows = await conn('scheduled_service_addons')
    .where({ scheduled_service_id: svc.id })
    .orderBy('id')
    .select('id', 'base_price', 'estimated_price');
  const set = (value) => value != null && value !== '';
  const price = (row) => Number(set(row.base_price) ? row.base_price : row.estimated_price) || 0;
  const priced = rows.some((row) => price(row) > 0);
  const unpriced = rows.some((row) => !set(row.base_price) && !set(row.estimated_price));
  return {
    clientIds: new Set(rows.map((row) => `scheduled_${svc.id}_addon_${row.id}`)),
    priced,
    unpriced,
    // Something is owed for the add-ons: a bill, or the office's price.
    owed: priced || unpriced,
    fingerprint: rows.map((row) => `${row.id}:${row.base_price ?? ''}:${row.estimated_price ?? ''}`).join('|'),
  };
}

// What a covered visit owes beyond its coverage — its add-on lines. Built by
// the canonical line builder, so each add-on carries its own gross price and
// its own discount exactly as a normal completion invoice would; the covered
// base line and the discount parented to it drop out. A document-level
// credit (an appointment discount, the builder's "Scheduled price
// adjustment") spans base and add-ons alike and nothing here can say which
// share is the add-ons', so it makes the amount `ambiguous`.
async function annualPrepayExtrasForVisit(svc, addons) {
  if (!addons.priced) return { lines: [], total: 0, ambiguous: false };
  const InvoiceService = require('./invoice');
  const { lineItems } = await InvoiceService.buildLineItemsForScheduledService(svc.id, {
    fallbackDescription: svc.service_type,
  });
  const primaryId = `scheduled_${svc.id}_primary`;
  const lines = lineItems.filter((li) => addons.clientIds.has(li.client_id) || addons.clientIds.has(li.discount_for));
  if (!lines.some((li) => Number(li.amount) > 0)) {
    // A data problem a retry cannot fix (the builder dropped priced rows).
    throw Object.assign(new Error('the visit has priced add-ons but no add-on invoice lines were built'), { code: 'ADDON_LINES_NOT_BUILT' });
  }
  const ambiguous = lineItems.some((li) => Number(li.amount) < 0
    && li.discount_for !== primaryId && !addons.clientIds.has(li.discount_for));
  const total = roundCents(lines.reduce((sum, li) => sum + (Number(li.amount) || 0), 0));
  return { lines: total > 0 ? lines : [], total, ambiguous };
}

// Sort an office invoice's lines against this visit: does it bill only this
// visit's add-ons (a collectible remainder, kept), and does it carry charges
// that are not the covered base (re-billed by the office if it is voided)?
function classifyCoveredVisitInvoice(invoice, addons) {
  const InvoiceService = require('./invoice');
  const lines = InvoiceService._parseInvoiceLineItems(invoice?.line_items);
  const isAddon = (li) => addons.clientIds.has(li.client_id) || addons.clientIds.has(li.discount_for);
  // Ledger-backed estimate deposit credit — a payment toward the bill.
  const isDepositCredit = (li) => String(li.category || '') === 'deposit_credit' && Number(li.amount) < 0;
  const positive = lines.filter((li) => Number(li.amount) > 0);
  return {
    billsOnlyAddons: positive.length > 0 && lines.every((li) => isAddon(li) || isDepositCredit(li)),
    otherCharges: positive.some((li) => !InvoiceService.lineIsBaseApplication(li)),
  };
}

class CoveredVisitCloseout {
  constructor(ctx) {
    this.ctx = ctx;
    this.svc = ctx.svc;
    this.record = ctx.record;
    this.invoice = ctx.invoice;
    this.payUrl = ctx.payUrl;
    this.alreadyPaid = ctx.alreadyPaid;
    this.invoiceCreated = ctx.invoiceCreated;
    // Add-ons are billed or alerted only on a visit that performed its
    // application (visitPerformed mirrors the main auto-invoice gate) and is
    // not a recap-only review.
    this.billable = ctx.visitPerformed && !ctx.recapReviewOnly;
    this.extrasCollectible = false;
    this.owedUnbilled = false;
    this.reasons = [];
    this.lookupError = null;
    this.alertError = null;
    const notes = parseNotes(this.record?.structured_notes);
    this.frozenLive = notes.annualPrepayAddonBilling === true;
    // The add-ons bill an earlier pass of this closeout minted.
    this.ownBillId = notes.annualPrepayAddonsInvoiceId || null;
  }

  // The gate, frozen at the first gate-on pass: a retry resumes an earlier
  // gate-on attempt's bill even if the gate was turned off since. A freeze
  // that cannot be saved holds — no gated money work without its fence.
  async resolveGate() {
    const live = require('../config/feature-gates').gateEnvValue('GATE_ANNUAL_PREPAY_ADDON_BILLING');
    if (live && !this.frozenLive) {
      try {
        await this.ctx.mergeRecordNotesKeys(this.record.id, { annualPrepayAddonBilling: true });
      } catch (err) {
        this.lookupError = err;
        logger.error(`[dispatch] annual-prepay add-on billing freeze write FAILED for visit ${this.svc.id}: ${err.message}`);
      }
    }
    this.live = live || this.frozenLive;
  }

  // The one office alert for add-ons nothing here billed; it keeps the
  // completion text off "all paid". One bell per visit, kept CURRENT: a
  // later pass rewrites it and surfaces it unread, and it names every reason
  // this pass found (a second reason never hides the first).
  async alert(reason, extra = {}) {
    const { svc } = this;
    this.owedUnbilled = true;
    this.reasons.push(reason);
    const reasons = this.reasons.join('; ');
    try {
      const NotificationService = require('./notification-service');
      const bell = await NotificationService.notifyAdmin('billing', 'Annual-prepay add-ons need billing — bill by hand',
        `Completing ${svc.service_type} for customer ${svc.customer_id}: the visit is covered by the annual prepay, but its add-ons were not billed automatically — ${reasons}.`,
        { link: `/admin/customers/${svc.customer_id}`, bell: true, dedupeKey: `annual_prepay_addons_unbilled:${svc.id}`,
          refreshOnDedupe: true,
          metadata: { customerId: svc.customer_id, scheduledServiceId: svc.id, reason: reasons, ...extra } });
      // notifyAdmin returns null when its insert fails.
      if (!bell) throw new Error('the office notification was not recorded');
    } catch (bellErr) {
      this.alertError = this.alertError || bellErr;
      logger.error(`[dispatch] annual-prepay add-ons alert FAILED for ${svc.id} (${reason}): ${bellErr.message}`);
    }
  }

  // Every invoice on the visit or its record other than this closeout's own
  // add-ons bill, in any status (a voided or refunded one is history too).
  async otherInvoices() {
    const { svc, record } = this;
    const query = db('invoices').where((qb) => {
      qb.where({ scheduled_service_id: svc.id });
      if (record?.id) qb.orWhere({ service_record_id: record.id });
    });
    if (this.ownBillId) query.whereNot({ id: this.ownBillId });
    return query.select('id', 'invoice_number', 'status');
  }

  // Take an add-ons bill as the completion's invoice. Nothing due (paid,
  // prepaid, or an estimate deposit covering all of it) = settled: no pay
  // link, no collection prompt. A zero-due draft is closed the canonical way
  // (settleZeroBalance → non-cash prepaid); one that will not close is the
  // office's to reconcile.
  async takeBill(bill) {
    let invoice = bill;
    let settled = ['paid', 'prepaid'].includes(bill.status);
    if (!settled && require('./invoice-helpers').invoiceAmountDue(bill) <= 0) {
      settled = true;
      let settlement = null;
      try {
        settlement = await require('./invoice').settleZeroBalance(bill.id);
      } catch (err) {
        logger.warn(`[dispatch] annual-prepay add-ons bill ${bill.id} zero-due settle failed: ${err.message}`);
      }
      if (settlement?.settled) invoice = settlement.invoice;
      else await this.alert(`add-ons bill ${invoiceLabel(bill)} has nothing due but could not be closed (${settlement?.reason || 'error'}) — close it`, { invoiceId: bill.id });
    }
    this.invoice = invoice;
    this.invoiceCreated = !settled;
    this.alreadyPaid = settled;
    this.extrasCollectible = !settled;
    this.payUrl = settled ? null : await shortenOrPassthrough(`${this.ctx.portalUrl}/pay/${invoice.token}`, {
      kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId: invoice.customer_id,
      codePrefix: invoiceShortCodePrefix(invoice),
    });
  }

  // What the visit owes beyond its coverage, read fresh — or null after
  // alerting (unbuildable lines, an unpriced add-on, a visit-wide discount)
  // or holding (a failed read), or when nothing is owed.
  async billableExtras() {
    let current;
    let addons;
    let extras;
    try {
      current = { ...this.svc, ...(await db('scheduled_services').where({ id: this.svc.id }).first()) };
      addons = await annualPrepayAddonRows(current);
      extras = await annualPrepayExtrasForVisit(current, addons);
    } catch (err) {
      if (err.code !== 'ADDON_LINES_NOT_BUILT') {
        this.lookupError = err;
        logger.error(`[dispatch] annual-prepay add-on lines unreadable for visit ${this.svc.id}: ${err.message}`);
        return null;
      }
      await this.alert('the add-on lines could not be built', { error: String(err.message).slice(0, 200) });
      return null;
    }
    if (addons.unpriced) await this.alert('an add-on has no price yet — price it and bill it');
    if (!extras.lines.length) return null;
    if (extras.ambiguous) {
      await this.alert(`a visit-wide discount applies, so the add-ons' share of it is unclear (they list at $${extras.total.toFixed(2)})`, { addonTotal: extras.total });
      return null;
    }
    return { current, addons, extras };
  }

  // Bill the add-ons on a visit with no invoice history. The mint re-checks
  // the add-on rows under the visit lock (an equal-total edit passes its
  // price guard): moved rows are re-read and billed once more, then alerted.
  async bill() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const read = await this.billableExtras();
      if (!read) return;
      if (this.ctx.packetEffects) {
        await this.alert('the visit is billed on its grouped closeout', { addonTotal: read.extras.total });
        return;
      }
      try {
        await this.mint(read);
        return;
      } catch (err) {
        if (err.code === 'ADDON_LINES_MOVED' && attempt === 0) continue;
        logger.error(`[dispatch] annual-prepay add-ons invoice FAILED for visit ${this.svc.id}: ${err.message}`);
        await this.alert('the add-ons invoice could not be created', { addonTotal: read.extras.total, error: String(err.message).slice(0, 200) });
        return;
      }
    }
  }

  async mint({ current, addons, extras }) {
    const { mintScheduledServiceInvoiceWithDeposit } = require('./scheduled-invoice-mint');
    const { quietBackfill, serviceDate } = this.ctx;
    const minted = await mintScheduledServiceInvoiceWithDeposit({
      svc: current,
      // Quiet backfill closeout: the main backfill mint's posture — the
      // estimate deposit stays on its ledger for the reviewer.
      skipDepositCredit: quietBackfill,
      assertLinesCurrentInTrx: async (trx) => {
        if ((await annualPrepayAddonRows(current, trx)).fingerprint !== addons.fingerprint) {
          throw Object.assign(new Error('the visit\'s add-ons changed while billing'), { code: 'ADDON_LINES_MOVED' });
        }
      },
      buildCreateParams: () => ({
        customerId: current.customer_id,
        serviceRecordId: this.record?.id || null,
        scheduledServiceId: current.id,
        title: current.service_type,
        serviceDate,
        // Backfill: due today (the backdated day would be overdue at once)
        // and off a NET-terms payer's open statement, like the main mint.
        dueDate: quietBackfill ? etDateString() : serviceDate,
        skipAccrual: quietBackfill,
        notes: 'Add-ons beyond your annual prepay coverage. The covered visit itself is already paid.',
        lineItems: extras.lines,
        trustedStoredDiscountSources: ['scheduled_service'],
      }),
    });
    // The mint adopts an invoice another writer committed under its lock:
    // that is an invoice on the visit this closeout did not make.
    if (minted.reused && minted.invoice.id !== this.ownBillId) {
      await this.alert(`invoice ${invoiceLabel(minted.invoice)} (${minted.invoice.status}) appeared on the visit while billing; bill whatever of the add-ons ($${extras.total.toFixed(2)}) it does not already charge`, { invoiceId: minted.invoice.id, addonTotal: extras.total });
      return;
    }
    try {
      await this.ctx.mergeRecordNotesKeys(this.record.id, { annualPrepayAddonsInvoiceId: minted.invoice.id });
      this.ownBillId = minted.invoice.id;
    } catch (err) {
      // A retry then sees an invoice it cannot claim and alerts — never a
      // second bill.
      logger.warn(`[dispatch] annual-prepay add-ons bill ${minted.invoice.id} not recorded on record ${this.record.id}: ${err.message}`);
    }
    await this.takeBill(minted.invoice);
  }

  // The covered base on an open office invoice is never collectible: settle
  // a base-only invoice, void one mixed with other charges (or carrying
  // credit voidInvoice must restore). One billing only this visit's
  // add-ons is kept. Returns what happened to it.
  async reconcileOpenOfficeInvoice(addons) {
    const { svc } = this;
    const InvoiceService = require('./invoice');
    const office = this.invoice;
    const lines = classifyCoveredVisitInvoice(office, addons);
    if (lines.billsOnlyAddons) return { kind: 'kept', invoice: office };
    const settleRes = await InvoiceService.settleInvoiceAsAnnualPrepayCovered(
      office.id, svc.annual_prepay_term_id, { recordedBy: 'system:annual_prepay_completion' },
    );
    if (settleRes.settled) {
      this.invoice = settleRes.invoice;
      this.invoiceCreated = false;
      this.payUrl = null;
      this.alreadyPaid = true;
      return { kind: 'settled', invoice: settleRes.invoice };
    }
    if (!['has_add_ons', 'has_applied_credit', 'has_deposit_credit'].includes(settleRes.reason)) {
      return { kind: 'left', invoice: office }; // payer-billed / in flight: normal handling
    }
    try {
      await InvoiceService.voidInvoice(office.id);
    } catch (voidErr) {
      // voidInvoice can throw AFTER its void committed (the follow-up steps
      // past its transaction); only a void that did not land is a failure.
      const after = await db('invoices').where({ id: office.id }).first('status');
      if (after?.status !== 'void') throw voidErr;
      logger.warn(`[dispatch] annual-prepay covered visit ${svc.id}: invoice ${office.id} voided, then: ${voidErr.message}`);
    }
    this.invoice = null;
    this.invoiceCreated = false;
    this.payUrl = null;
    this.alreadyPaid = true;
    return { kind: 'voided', invoice: office, otherCharges: lines.otherCharges };
  }

  // The visit has an invoice this closeout did not make. Dark, only the
  // covered base is handled. Live, the add-ons (and a voided invoice's
  // other charges) go to the office — one alert naming the invoice.
  async reconcileWithOfficeInvoices(others) {
    const { svc } = this;
    const open = this.invoice?.id && !['paid', 'prepaid', 'void'].includes(this.invoice.status);
    let addons = { clientIds: new Set(), owed: false };
    if (this.live) {
      try {
        addons = await annualPrepayAddonRows(svc);
      } catch (err) {
        this.lookupError = err;
        logger.error(`[dispatch] annual-prepay add-on rows unreadable for visit ${svc.id}: ${err.message}`);
        return;
      }
    }
    let outcome = {};
    if (open) {
      try {
        outcome = await this.reconcileOpenOfficeInvoice(addons);
      } catch (err) {
        logger.warn(`[dispatch] annual-prepay covered visit ${svc.id}: could not settle invoice ${this.invoice?.id}: ${err.message}`);
        outcome = { kind: 'left', invoice: this.invoice };
      }
    }
    // An office bill for the add-ons stays owed (pay link, collection).
    if (outcome.kind === 'kept') await this.takeBill(outcome.invoice);
    if (!this.live || !this.billable) return;
    const named = outcome.invoice || this.ctx.terminalCompletionInvoice || this.invoice || others[0];
    if (outcome.kind === 'voided' && (addons.owed || outcome.otherCharges)) {
      await this.alert(`invoice ${invoiceLabel(named)} was voided because the annual prepay covers the visit; re-bill the add-ons and anything else it charged besides the covered visit`, { voidedInvoiceId: named.id });
    } else if (addons.owed) {
      await this.alert(`the visit already has invoice ${invoiceLabel(named)} (${named.status}); bill whatever of its add-ons that invoice does not already charge`, { invoiceId: named.id });
    }
  }

  async run() {
    // The issued invoice is the customer-facing artifact the office chose to
    // send: never settled, voided, or billed beside.
    if (this.ctx.issuedInvoiceCloseout) return this.outcome();
    await this.resolveGate();
    if (this.lookupError) return this.outcome();
    // Dark: today's behavior — only an open invoice's covered base.
    if (!this.live) {
      if (this.invoice?.id) await this.reconcileWithOfficeInvoices([]);
      return this.outcome();
    }
    // This closeout's own add-ons bill, found again on a retry.
    if (this.ownBillId && this.invoice?.id === this.ownBillId) {
      await this.takeBill(this.invoice);
      return this.outcome();
    }
    let others;
    try {
      others = await this.otherInvoices();
    } catch (err) {
      this.lookupError = err;
      logger.error(`[dispatch] annual-prepay invoice history unreadable for visit ${this.svc.id}: ${err.message}`);
      return this.outcome();
    }
    if (others.length || this.ctx.terminalCompletionInvoice) {
      await this.reconcileWithOfficeInvoices(others);
    } else if (this.billable) {
      await this.bill();
    }
    return this.outcome();
  }

  outcome() {
    let hold = null;
    if (this.lookupError) {
      hold = { code: 'annual_prepay_addons_lookup_failed', error: this.lookupError,
        summary: 'This visit\'s add-ons could not be checked or prepared for billing' };
    } else if (this.alertError) {
      hold = { code: 'annual_prepay_addons_alert_failed', error: this.alertError,
        summary: 'This visit\'s add-ons need the office\'s attention and the office alert could not be recorded' };
    }
    return {
      invoice: this.invoice,
      payUrl: this.payUrl,
      alreadyPaid: this.alreadyPaid,
      invoiceCreated: this.invoiceCreated,
      extrasCollectible: this.extrasCollectible,
      owedUnbilled: this.owedUnbilled,
      hold,
    };
  }
}

async function reconcileCoveredVisitInvoice(ctx) {
  return new CoveredVisitCloseout(ctx).run();
}

module.exports = { reconcileCoveredVisitInvoice };
