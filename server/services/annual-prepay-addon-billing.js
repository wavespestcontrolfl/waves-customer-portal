/**
 * Completing an annual-prepay-COVERED visit: its invoice and its add-ons.
 *
 * The covered BASE work is already paid on the annual prepay invoice, so a
 * live covered visit never carries a collectible invoice for it: a
 * pre-existing / pre-minted invoice with no add-ons is SETTLED as non-cash
 * annual-prepay coverage ('prepaid' — no pay link, no payments row, no
 * revenue double-count); one that mixes the base with other charges, or
 * carries applied account / deposit credit, is VOIDED (voidInvoice restores
 * the credit and cancels the PI). A cash-paid / in-flight invoice is left
 * for normal handling, and an invoice-issued closeout's invoice is never
 * touched (the office chose to send it).
 *
 * ADMIN-BUG-R13 (owner ruling 2026-09-26: auto-bill; GATE_ANNUAL_PREPAY_ADDON_BILLING):
 * the visit's add-ons are owed on top of the coverage. They are billed
 * alone through the shared scheduled-invoice mint (pay link, unpaid
 * completion text), or — when the amount is unclear or the bill cannot be
 * cut here — parked as an office alert, and the completion text never says
 * "all paid" over them. Every retry re-derives the same outcome:
 *   - the gate is frozen on the service record at its first gate-on pass,
 *     so a retry resumes an earlier gate-on attempt's bill or void even if
 *     the gate was turned off since;
 *   - an office invoice is recorded on the record BEFORE it is voided, so
 *     a retry after a crash past the void still judges the add-ons bill
 *     against that invoice's own pricing and flags its other charges;
 *   - a failed add-on read, or an office alert that did not land, returns a
 *     hold: the caller keeps the closeout unfinalized (release + 503) and
 *     the retry reads and decides again before anything is sent.
 *
 * reconcileCoveredVisitInvoice returns the completion's invoice state
 * (invoice, payUrl, alreadyPaid, invoiceCreated) plus what the completion
 * text needs (extrasCollectible, owedUnbilled) and the hold, if any.
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

// The visit's add-on rows, read strictly — the canonical line builder
// swallows a failed read into "no add-ons", which here would silently skip a
// bill. A priced row is one the builder turns into a line (its base_price
// when set, else its estimated_price, above zero); an explicit zero is free.
// An unpriced row (both prices blank) is a quote still awaiting its price —
// owed, but nothing here can bill it.
async function annualPrepayAddonRows(svc) {
  const rows = await db('scheduled_service_addons')
    .where({ scheduled_service_id: svc.id })
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
  };
}

// What a covered visit owes beyond its coverage — its add-on lines. Built by
// the canonical line builder, so each add-on carries its own gross price and
// its own discount exactly as a normal completion invoice would; the covered
// base line and the discount parented to it drop out. A document-level
// credit (an appointment discount, the builder's "Scheduled price
// adjustment") spans base and add-ons alike and nothing here can say which
// share is the add-ons', so it makes the amount `ambiguous` — the caller
// alerts the office instead of guessing.
async function annualPrepayExtrasForVisit(svc, addons) {
  if (!addons.priced) return { lines: [], total: 0, ambiguous: false };
  const InvoiceService = require('./invoice');
  const { lineItems } = await InvoiceService.buildLineItemsForScheduledService(svc.id, {
    fallbackDescription: svc.service_type,
  });
  const primaryId = `scheduled_${svc.id}_primary`;
  const lines = lineItems.filter((li) => addons.clientIds.has(li.client_id) || addons.clientIds.has(li.discount_for));
  if (!lines.some((li) => Number(li.amount) > 0)) {
    throw new Error('the visit has priced add-ons but no add-on invoice lines were built');
  }
  const ambiguous = lineItems.some((li) => Number(li.amount) < 0
    && li.discount_for !== primaryId && !addons.clientIds.has(li.discount_for));
  const total = roundCents(lines.reduce((sum, li) => sum + (Number(li.amount) || 0), 0));
  return { lines: total > 0 ? lines : [], total, ambiguous };
}

// Sort an existing invoice's lines against this visit: the covered base, the
// visit's own add-ons (and discounts parented to them), and anything else.
function classifyCoveredVisitInvoice(invoice, addons) {
  const InvoiceService = require('./invoice');
  const lines = InvoiceService._parseInvoiceLineItems(invoice?.line_items);
  const isAddon = (li) => addons.clientIds.has(li.client_id) || addons.clientIds.has(li.discount_for);
  // Ledger-backed estimate deposit credit the shared mint rolls onto the
  // add-ons bill — a payment toward it, not a charge of its own.
  const isDepositCredit = (li) => String(li.category || '') === 'deposit_credit' && Number(li.amount) < 0;
  const positive = lines.filter((li) => Number(li.amount) > 0);
  return {
    // Positive evidence only: every line is one of this visit's add-ons (or
    // a discount / deposit credit on them) and at least one bills something.
    billsOnlyAddons: positive.length > 0 && lines.every((li) => isAddon(li) || isDepositCredit(li)),
    unknownCharges: positive.some((li) => !isAddon(li) && !InvoiceService.lineIsBaseApplication(li)),
  };
}

// Is this invoice the WHOLE remainder the visit owes — only add-on charges
// (never the covered base or any other line), every priced add-on, netting
// to the canonical extras total? A mixed invoice, a subset of the add-ons, a
// stale price, or a remainder the builder cannot vouch for (a visit-wide
// discount) is not, and must never stand in for it.
function invoiceBillsExactExtras(invoice, addons, extras) {
  // An add-on awaiting its price is owed too: nothing bills all of them yet.
  if (!extras || extras.ambiguous || !extras.lines.length || addons.unpriced) return false;
  if (!classifyCoveredVisitInvoice(invoice, addons).billsOnlyAddons) return false;
  const InvoiceService = require('./invoice');
  const onAddons = (li) => addons.clientIds.has(li.client_id) || addons.clientIds.has(li.discount_for);
  const invoiceAddonLines = InvoiceService._parseInvoiceLineItems(invoice?.line_items).filter(onAddons);
  const billedIds = (lines) => new Set(lines.filter((li) => Number(li.amount) > 0).map((li) => li.client_id));
  const want = billedIds(extras.lines);
  const have = billedIds(invoiceAddonLines);
  const net = roundCents(invoiceAddonLines.reduce((sum, li) => sum + (Number(li.amount) || 0), 0));
  return want.size === have.size && [...want].every((id) => have.has(id)) && net === extras.total;
}

// A voided office invoice may have priced the add-ons its own way (a
// discount typed on the invoice, a credit spanning its lines): the re-bill
// is automatic only when it carried no other credit and billed the add-ons
// exactly as the visit prices them. Returns null, or what differed.
function voidedInvoiceRepricing(voidedInvoice, addons, extras, serviceId) {
  const InvoiceService = require('./invoice');
  const primaryId = `scheduled_${serviceId}_primary`;
  const lines = InvoiceService._parseInvoiceLineItems(voidedInvoice.line_items);
  const onAddons = (li) => addons.clientIds.has(li.client_id) || addons.clientIds.has(li.discount_for);
  const addonLines = lines.filter(onAddons);
  const otherCredit = lines.some((li) => Number(li.amount) < 0 && !onAddons(li) && li.discount_for !== primaryId);
  const voidedAddonTotal = roundCents(addonLines.reduce((sum, li) => sum + (Number(li.amount) || 0), 0));
  const differs = addonLines.length > 0 && voidedAddonTotal !== extras.total;
  return otherCredit || differs ? { otherCredit, voidedAddonTotal } : null;
}

// Bill a covered visit's add-ons through the ONE shared scheduled-invoice
// mint (lock chain, packet-ownership check, in-lock adoption, deposit
// roll-forward). An invoice another writer committed first is adopted only
// when it bills exactly this visit's add-ons (invoiceBillsExactExtras);
// anything else comes back as a conflict for the office.
async function mintAnnualPrepayExtrasInvoice(svc, record, extras, addons, { serviceDate, coveredInvoiceId = null, quietBackfill = false }) {
  const { mintScheduledServiceInvoiceWithDeposit } = require('./scheduled-invoice-mint');
  const minted = await mintScheduledServiceInvoiceWithDeposit({
    svc,
    // The covered-base settlement this completion made is the bill's
    // sibling, not a replay of it.
    excludeFromAdoption: coveredInvoiceId ? [coveredInvoiceId] : [],
    // Quiet backfill closeout: the same posture as its main invoice mint —
    // the estimate deposit stays on its ledger for the reviewer.
    skipDepositCredit: quietBackfill,
    buildCreateParams: () => ({
      customerId: svc.customer_id,
      serviceRecordId: record?.id || null,
      scheduledServiceId: svc.id,
      title: svc.service_type,
      serviceDate,
      // Backfill: the backdated visit day would mint the bill already
      // overdue; due today instead, like the main backfill mint.
      dueDate: quietBackfill ? etDateString() : serviceDate,
      // …and off a NET-terms payer's open statement, like the main backfill
      // invoice: a quiet closeout leaves it for review.
      skipAccrual: quietBackfill,
      notes: 'Add-ons beyond your annual prepay coverage. The covered visit itself is already paid.',
      lineItems: extras.lines,
      trustedStoredDiscountSources: ['scheduled_service'],
    }),
  });
  if (minted.reused && !invoiceBillsExactExtras(minted.invoice, addons, extras)) {
    return { conflict: minted.invoice };
  }
  return minted;
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
    // Add-ons may be billed or alerted only on a visit that performed its
    // application (visitPerformed mirrors the main auto-invoice gate) and is
    // not a recap-only review.
    this.billable = ctx.visitPerformed && !ctx.recapReviewOnly;
    this.extrasCollectible = false;
    this.addonsUnbilled = false;
    this.otherChargesOwed = false;
    this.lookupError = null;
    this.alertError = null;
    const notes = parseNotes(this.record?.structured_notes);
    // The office invoice an earlier pass of this closeout voided; null on a
    // first pass.
    this.priorVoidedId = notes.annualPrepayVoidedInvoiceId || null;
    this.priorVoidRevisited = false;
    this.frozenLive = notes.annualPrepayAddonBilling === true;
  }

  // The gate, frozen at the first gate-on pass: a retry resumes what an
  // earlier gate-on attempt started (its bill, its void) even if the gate
  // was turned off since; a first pass with the gate off stays dark. A
  // freeze that cannot be written only loses that protection for this
  // closeout (logged).
  async resolveGate() {
    const live = require('../config/feature-gates').gateEnvValue('GATE_ANNUAL_PREPAY_ADDON_BILLING');
    if (live && !this.frozenLive) {
      try {
        await this.ctx.mergeRecordNotesKeys(this.record.id, { annualPrepayAddonBilling: true });
      } catch (err) {
        // No gated money work without its retry fence: hold for the retry.
        this.lookupError = err;
        logger.error(`[dispatch] annual-prepay add-on billing freeze write FAILED for visit ${this.svc.id}: ${err.message}`);
      }
    }
    this.live = live || this.frozenLive;
  }

  async alert(reason, extra = {}) {
    const { svc } = this;
    this.addonsUnbilled = true;
    try {
      const NotificationService = require('./notification-service');
      const bell = await NotificationService.notifyAdmin('billing', 'Annual-prepay add-ons not billed — bill by hand',
        `Completing ${svc.service_type} for customer ${svc.customer_id}: the visit is covered by the annual prepay, but its add-ons were not billed automatically (${reason}). Bill the add-ons by hand.`,
        { link: `/admin/customers/${svc.customer_id}`, bell: true, dedupeKey: `annual_prepay_addons_unbilled:${svc.id}`,
          // One bell per visit, kept CURRENT: a later pass that hits a
          // different reason or amount rewrites it and surfaces it unread.
          refreshOnDedupe: true,
          metadata: { customerId: svc.customer_id, scheduledServiceId: svc.id, reason, ...extra } });
      // notifyAdmin returns null when its insert fails.
      if (!bell) throw new Error('the office notification was not recorded');
    } catch (bellErr) {
      this.alertError = this.alertError || bellErr;
      logger.error(`[dispatch] annual-prepay add-ons alert FAILED for ${svc.id} (${reason}): ${bellErr.message}`);
    }
  }

  // One fresh read of the visit feeds both the add-on lines and the mint's
  // stale-price guard, so they agree with each other.
  async currentExtras() {
    const current = { ...this.svc, ...(await db('scheduled_services').where({ id: this.svc.id }).first()) };
    const addons = await annualPrepayAddonRows(current);
    return { current, addons, extras: await annualPrepayExtrasForVisit(current, addons) };
  }

  // What the visit owes beyond its coverage, read fresh — or null after
  // alerting the office when it cannot be billed automatically (unreadable
  // lines, a visit-wide discount), or when nothing is owed.
  async billableExtras(meta) {
    let read;
    try {
      read = await this.currentExtras();
    } catch (err) {
      logger.warn(`[dispatch] annual-prepay add-on lines unreadable for visit ${this.svc.id}: ${err.message}`);
      await this.alert('the add-on lines could not be read', { ...meta, error: String(err.message).slice(0, 200) });
      return null;
    }
    if (read.addons.unpriced) {
      // The priced add-ons still bill below; the unpriced one is the office's.
      await this.alert('an add-on has no price yet — price it and bill it', meta);
    }
    if (!read.extras.lines.length) return null;
    if (read.extras.ambiguous) {
      await this.alert('a visit-wide discount applies, so the add-ons\' share is unclear', { ...meta, addonTotal: read.extras.total });
      return null;
    }
    return read;
  }

  async bill({ coveredInvoiceId = null } = {}) {
    const read = await this.billableExtras({});
    if (read) await this.mint(read, { coveredInvoiceId });
  }

  // Mint the add-ons bill (not on a grouped closeout, which bills the visit
  // itself) and take it as the completion's invoice.
  async mint({ current, addons, extras }, { coveredInvoiceId = null, meta = {} } = {}) {
    if (this.ctx.packetEffects) {
      return this.alert('this visit is billed on its grouped closeout', { ...meta, addonTotal: extras.total });
    }
    try {
      const minted = await mintAnnualPrepayExtrasInvoice(current, this.record, extras, addons, {
        serviceDate: this.ctx.serviceDate, coveredInvoiceId, quietBackfill: this.ctx.quietBackfill,
      });
      if (minted.conflict) {
        return this.alert(`invoice ${minted.conflict.invoice_number || minted.conflict.id}, saved on this visit by another writer, does not bill exactly its add-ons`, { ...meta, conflictInvoiceId: minted.conflict.id, addonTotal: extras.total });
      }
      const { invoice, settled } = await this.settleIfNothingDue(minted.invoice);
      this.invoice = invoice;
      // An adopted unpaid bill is delivered like every other reused unpaid
      // completion invoice (the pay link rides the completion text).
      this.invoiceCreated = !settled;
      this.alreadyPaid = settled;
      this.extrasCollectible = !settled;
      this.payUrl = settled ? null : await shortenOrPassthrough(`${this.ctx.portalUrl}/pay/${invoice.token}`, {
        kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId: invoice.customer_id,
        codePrefix: invoiceShortCodePrefix(invoice),
      });
    } catch (err) {
      logger.error(`[dispatch] annual-prepay add-ons invoice FAILED for visit ${this.svc.id}: ${err.message}`);
      return this.alert('the add-ons invoice could not be created', { ...meta, addonTotal: extras.total, error: String(err.message).slice(0, 200) });
    }
    return undefined;
  }

  // An add-ons bill with nothing due — paid, prepaid, or an estimate deposit
  // covering all of it — is settled for the completion: no pay link, no
  // collection prompt. A zero-due draft is closed the canonical way
  // (settleZeroBalance → non-cash prepaid); a refused or failed close leaves
  // it for the send pipeline's own zero-due settlement.
  async settleIfNothingDue(bill) {
    if (['paid', 'prepaid'].includes(bill.status)) return { invoice: bill, settled: true };
    if (require('./invoice-helpers').invoiceAmountDue(bill) > 0) return { invoice: bill, settled: false };
    try {
      const settlement = await require('./invoice').settleZeroBalance(bill.id);
      if (settlement?.settled) return { invoice: settlement.invoice, settled: true };
      logger.warn(`[dispatch] annual-prepay add-ons bill ${bill.id} has nothing due but was not settled (${settlement?.reason || 'refused'})`);
    } catch (err) {
      logger.warn(`[dispatch] annual-prepay add-ons bill ${bill.id} zero-due settle failed: ${err.message}`);
    }
    return { invoice: bill, settled: true };
  }

  // After this closeout voided the covered visit's office invoice — in this
  // pass, or in an earlier one a crash cut short — flag the lines that were
  // neither the covered base nor this visit's add-ons (the office's to
  // re-bill; nothing here can name them), then bill the add-ons against that
  // invoice's own pricing. The flag goes first: a retry that finds the
  // add-ons bill already minted adopts it and never comes back here, and a
  // flag that did not land holds the bill for the retry.
  async afterVoid(voidedInvoice, voidedLines = null) {
    const { svc } = this;
    let unknownCharges = true;
    try {
      unknownCharges = (voidedLines || classifyCoveredVisitInvoice(voidedInvoice, await annualPrepayAddonRows(svc))).unknownCharges;
    } catch (err) {
      logger.warn(`[dispatch] annual-prepay voided invoice ${voidedInvoice.id} unreadable for visit ${svc.id}: ${err.message}`);
    }
    if (unknownCharges) {
      this.otherChargesOwed = true;
      try {
        const NotificationService = require('./notification-service');
        const bell = await NotificationService.notifyAdmin('billing', 'Annual-prepay visit invoice voided — check its other charges',
          `Completing ${svc.service_type} for customer ${svc.customer_id}: invoice ${voidedInvoice.id} was voided because the annual prepay covers the visit, but it also carried charges that are neither the covered visit nor its add-ons. Re-bill any that are owed.`,
          { link: `/admin/customers/${svc.customer_id}`, bell: true, dedupeKey: `annual_prepay_invoice_reconcile:${svc.id}`,
            refreshOnDedupe: true,
            metadata: { customerId: svc.customer_id, scheduledServiceId: svc.id, voidedInvoiceId: voidedInvoice.id } });
        if (!bell) throw new Error('the office notification was not recorded');
      } catch (bellErr) {
        this.alertError = this.alertError || bellErr;
        logger.error(`[dispatch] annual-prepay voided-invoice reconcile alert FAILED for ${svc.id}: ${bellErr.message}`);
        return;
      }
    }
    if (!this.billable) return;
    const meta = { voidedInvoiceId: voidedInvoice.id };
    const read = await this.billableExtras(meta);
    if (!read) return;
    const repriced = voidedInvoiceRepricing(voidedInvoice, read.addons, read.extras, svc.id);
    if (repriced) {
      await this.alert(`invoice ${voidedInvoice.invoice_number || voidedInvoice.id} priced the add-ons differently (it billed $${repriced.voidedAddonTotal.toFixed(2)}${repriced.otherCredit ? ' and carried another credit' : ''}; the visit prices them at $${read.extras.total.toFixed(2)})`, { ...meta, addonTotal: read.extras.total, voidedAddonTotal: repriced.voidedAddonTotal });
      return;
    }
    await this.mint(read, { meta });
  }

  // An open invoice on the covered visit: keep an add-ons bill, settle the
  // covered base, or void a mixed invoice. Dark, the add-ons are not read
  // and nothing beyond the settle / void happens.
  async reconcileOpenInvoice() {
    const { svc } = this;
    const InvoiceService = require('./invoice');
    let addons = null;
    try {
      addons = this.live
        ? await annualPrepayAddonRows(svc).catch((lookupErr) => {
          this.lookupError = lookupErr;
          throw lookupErr;
        })
        : { clientIds: new Set(), priced: false };
      const invoiceLines = classifyCoveredVisitInvoice(this.invoice, addons);
      if (invoiceLines.billsOnlyAddons) return await this.keepAddonsBill(addons);
      // Named settleRes, NOT res (the TDZ-shadow failure class in the caller).
      const settleRes = await InvoiceService.settleInvoiceAsAnnualPrepayCovered(
        this.invoice.id, svc.annual_prepay_term_id, { recordedBy: 'system:annual_prepay_completion' },
      );
      if (settleRes.settled) {
        this.invoice = settleRes.invoice;
        this.invoiceCreated = false;
        this.payUrl = null;
        this.alreadyPaid = true;
        // An office invoice that predates the visit's add-ons settles as
        // covered; the add-ons it never carried are still owed.
        if (this.live && this.billable) await this.bill({ coveredInvoiceId: settleRes.invoice?.id || null });
        return undefined;
      }
      if (['has_add_ons', 'has_applied_credit', 'has_deposit_credit'].includes(settleRes.reason)) {
        return await this.voidMixedInvoice(invoiceLines);
      }
      // else (payer_billed / already_settled / processing): normal handling.
      return undefined;
    } catch (settleErr) {
      logger.warn(`[dispatch] annual-prepay covered visit ${svc.id}: could not settle pre-existing invoice ${this.invoice?.id}: ${settleErr.message}`);
      // Neither settled nor voided (a payment in flight, a concurrent
      // change): the invoice stays for normal handling, and nothing here
      // billed the visit's own add-ons — the office decides.
      if (!this.lookupError && addons?.owed) {
        await this.alert(`invoice ${this.invoice?.invoice_number || this.invoice?.id} could not be reconciled with the annual prepay: ${String(settleErr.message).slice(0, 160)}`, { invoiceId: this.invoice?.id || null });
      }
      return undefined;
    }
  }

  // An open invoice billing only this visit's add-ons is owed. The
  // paid-invoice lookup also sees the covered base settled beside it (a
  // resumed completion links both to the record) — that is not "all paid".
  // It stands for the whole remainder only when it bills every priced
  // add-on at the visit's net; otherwise it keeps its pay link and the
  // office reconciles the rest.
  async keepAddonsBill(addons) {
    const { invoice, settled } = await this.settleIfNothingDue(this.invoice);
    this.invoice = invoice;
    this.extrasCollectible = !settled;
    this.alreadyPaid = settled;
    if (settled) {
      this.payUrl = null;
      this.invoiceCreated = false;
    }
    let extras = null;
    try {
      ({ extras } = await this.currentExtras());
    } catch (err) {
      logger.warn(`[dispatch] annual-prepay add-on lines unreadable for visit ${this.svc.id}: ${err.message}`);
    }
    if (!invoiceBillsExactExtras(this.invoice, addons, extras)) {
      await this.alert(`invoice ${this.invoice.invoice_number || this.invoice.id} bills only some of the add-ons or prices them differently${extras && !extras.ambiguous ? ` (the visit prices them at $${extras.total.toFixed(2)})` : ''}`, { invoiceId: this.invoice.id, addonTotal: extras?.total ?? null });
    }
  }

  // Void an invoice mixing the covered base with other charges (or carrying
  // credit voidInvoice must restore). Live, its id is saved on the record
  // BEFORE the void — unsaved means no void; the office reconciles it.
  async voidMixedInvoice(invoiceLines) {
    const { svc } = this;
    const voidedInvoice = this.invoice;
    const voidedInvoiceId = voidedInvoice.id;
    if (this.live) {
      try {
        await this.ctx.mergeRecordNotesKeys(this.record.id, { annualPrepayVoidedInvoiceId: voidedInvoiceId });
      } catch (markErr) {
        logger.error(`[dispatch] annual-prepay void marker write FAILED for visit ${svc.id} (invoice ${voidedInvoiceId}): ${markErr.message}`);
        return this.alert(`invoice ${voidedInvoice.invoice_number || voidedInvoiceId} bills the covered visit together with other charges and was left as is`, { invoiceId: voidedInvoiceId });
      }
    }
    try {
      await require('./invoice').voidInvoice(voidedInvoiceId);
    } catch (voidErr) {
      // voidInvoice can throw AFTER its void committed (the annual-prepay /
      // follow-up steps past the transaction); only a void that did not
      // land is a failure.
      const after = await db('invoices').where({ id: voidedInvoiceId }).first('status');
      if (String(after?.status || '').toLowerCase() !== 'void') throw voidErr;
      logger.warn(`[dispatch] annual-prepay covered visit ${svc.id}: invoice ${voidedInvoiceId} voided, then: ${voidErr.message}`);
    }
    this.invoice = null;
    this.invoiceCreated = false;
    this.payUrl = null;
    this.alreadyPaid = true;
    if (this.live) await this.afterVoid(voidedInvoice, invoiceLines);
    return undefined;
  }

  // The office invoice an earlier pass recorded before voiding it — trusted
  // only when the void actually landed: a void that failed leaves the id on
  // the record while that invoice stays live (or is later cancelled or paid
  // by someone else). Returns { invoice } for a real void, { missing: true }
  // when the row is gone, or {} for a stale marker.
  async priorVoidedInvoice() {
    const row = await db('invoices').where({ id: this.priorVoidedId }).first();
    if (!row) return { missing: true };
    return row.status === 'void' ? { invoice: row } : {};
  }

  // No invoice on the covered visit. Not over a refunded invoice (nothing is
  // minted beside it while its money can still come back, and the
  // manual-billing alert skips a covered visit — so priced add-ons get their
  // own); a retry whose earlier pass voided the office invoice finishes that
  // void's work instead of billing plainly.
  async reconcileNoInvoice() {
    const { svc } = this;
    const terminal = this.ctx.terminalCompletionInvoice;
    if (terminal) {
      if (!this.billable) return;
      let addons = null;
      try {
        addons = await annualPrepayAddonRows(svc);
      } catch (lookupErr) {
        this.lookupError = lookupErr;
        logger.error(`[dispatch] annual-prepay add-on rows unreadable for visit ${svc.id} (refunded invoice ${terminal.id}): ${lookupErr.message}`);
      }
      if (addons?.owed) {
        await this.alert(`invoice ${terminal.invoice_number || terminal.id} on the visit is ${terminal.status}; bill them once that refund is final`, { terminalInvoiceId: terminal.id });
      }
      return;
    }
    if (this.priorVoidedId) {
      this.priorVoidRevisited = true;
      let prior;
      try {
        prior = await this.priorVoidedInvoice();
      } catch (err) {
        // A transient read: hold for the retry rather than finalize without
        // classifying the voided invoice's other charges.
        this.lookupError = err;
        logger.error(`[dispatch] annual-prepay voided invoice ${this.priorVoidedId} re-read failed for visit ${svc.id}: ${err.message}`);
        return;
      }
      if (prior.invoice) return this.afterVoid(prior.invoice);
      if (prior.missing) {
        return this.alert(`invoice ${this.priorVoidedId}, voided by this closeout, could not be found`, { voidedInvoiceId: this.priorVoidedId });
      }
      // A stale marker (that void never landed): nothing of it to finish.
    }
    if (this.billable) await this.bill();
  }

  // A settled invoice on the covered visit keeps its settlement. This
  // term's covered-base settlement (a retry after a crash between settling
  // the base and minting its add-ons sibling) gets the add-ons billed beside
  // it — the mint adopts a sibling an earlier pass committed, never the base
  // itself. Any other settled invoice stands for the add-ons only when it
  // bills exactly them; otherwise the remainder is the office's.
  async reconcileSettledInvoice() {
    const { svc } = this;
    if (!this.billable || this.ctx.terminalCompletionInvoice) return;
    const status = String(this.invoice.status || '').toLowerCase();
    if (status === 'prepaid' && svc.annual_prepay_term_id
      && String(this.invoice.annual_prepay_covered_term_id || '') === String(svc.annual_prepay_term_id)) {
      await this.bill({ coveredInvoiceId: this.invoice.id });
      return;
    }
    let addons = null;
    let extras = null;
    try {
      addons = await annualPrepayAddonRows(svc);
      if (addons.priced) ({ extras } = await this.currentExtras());
    } catch (lookupErr) {
      if (!addons) this.lookupError = lookupErr;
      logger.warn(`[dispatch] annual-prepay add-ons unreadable against settled invoice ${this.invoice.id} for visit ${svc.id}: ${lookupErr.message}`);
    }
    if (addons?.owed && !invoiceBillsExactExtras(this.invoice, addons, extras)) {
      await this.alert(`invoice ${this.invoice.invoice_number || this.invoice.id} is already ${status} but does not bill exactly the visit's add-ons${extras && !extras.ambiguous ? ` (the visit prices them at $${extras.total.toFixed(2)})` : ''} — check what is still owed`, { invoiceId: this.invoice.id, addonTotal: extras?.total ?? null });
    }
  }

  // A retry that found an invoice on the visit (the add-ons bill an earlier
  // pass minted, perhaps paid or credited since) never revisited the void:
  // its other charges still await the office's re-bill. An unreadable
  // voided invoice counts as owed.
  async rederiveOtherCharges() {
    if (!this.priorVoidedId || this.priorVoidRevisited || this.otherChargesOwed) return;
    try {
      const prior = await this.priorVoidedInvoice();
      this.otherChargesOwed = !!prior.missing
        || (!!prior.invoice && classifyCoveredVisitInvoice(prior.invoice, await annualPrepayAddonRows(this.svc)).unknownCharges);
    } catch (err) {
      this.otherChargesOwed = true;
      logger.warn(`[dispatch] annual-prepay voided invoice ${this.priorVoidedId} re-read failed for visit ${this.svc.id}: ${err.message}`);
    }
  }

  async run() {
    // The issued invoice is the customer-facing artifact the office chose
    // to send: never settled, voided, or billed beside (pre-push P0 on the
    // issued-closeout lane; a replacement would contradict the closeout).
    if (this.ctx.issuedInvoiceCloseout) return this.outcome();
    await this.resolveGate();
    if (this.lookupError) return this.outcome();
    // A void invoice bills nothing: it is the same as none. (The completion's
    // lookups exclude void rows today; the dispatch stays total regardless.)
    const status = String(this.invoice?.status || '').toLowerCase();
    const hasInvoice = !!this.invoice?.id && status !== 'void';
    if (hasInvoice && !['paid', 'prepaid'].includes(status)) {
      await this.reconcileOpenInvoice();
    } else if (this.live && !hasInvoice) {
      await this.reconcileNoInvoice();
    } else if (this.live) {
      await this.reconcileSettledInvoice();
    }
    if (this.live) await this.rederiveOtherCharges();
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
      // Add-ons owed but only alerted, or a voided invoice's other charges
      // awaiting the office's re-bill: never "all paid" over either.
      owedUnbilled: this.addonsUnbilled || this.otherChargesOwed,
      hold,
    };
  }
}

async function reconcileCoveredVisitInvoice(ctx) {
  return new CoveredVisitCloseout(ctx).run();
}

module.exports = { reconcileCoveredVisitInvoice };
