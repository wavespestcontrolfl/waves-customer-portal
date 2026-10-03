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
 *   - When the visit has no invoice at all (the common case: the prepay
 *     suppresses the completion invoice) and every add-on has a clear price,
 *     they are billed alone through the shared scheduled-invoice mint — pay
 *     link, unpaid completion text. That bill, minted in this pass, is the
 *     only invoice the completion ever collects.
 *   - Anything else is the office's: any invoice already on the visit (its
 *     own history, the one the completion selected, one an earlier attempt
 *     of this closeout minted — any status), an issued invoice that does not
 *     carry every add-on, an add-on awaiting its price, a visit-wide
 *     discount, a grouped closeout. ONE alert says what the office must
 *     bill; nothing that was on the visit before this pass is collected, and
 *     the completion text never says "all paid" over it. Deciding more of
 *     that automatically is the surface that kept yielding new review
 *     findings; it stays human.
 * Retry safety: the gate is frozen on the record at its first gate-on pass;
 * a failed read, a failed freeze write, or an office alert that did not
 * land returns a hold (the caller keeps the closeout unfinalized — release
 * + 503 — and the retry decides again).
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
  const isUnpriced = (row) => !set(row.base_price) && !set(row.estimated_price);
  const clientId = (row) => `scheduled_${svc.id}_addon_${row.id}`;
  const owedRows = rows.filter((row) => price(row) > 0 || isUnpriced(row));
  return {
    clientIds: new Set(rows.map(clientId)),
    // The add-ons something is owed for: a bill, or the office's price.
    owedClientIds: new Set(owedRows.map(clientId)),
    priced: rows.some((row) => price(row) > 0),
    unpriced: rows.some(isUnpriced),
    owed: owedRows.length > 0,
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
async function annualPrepayExtrasForVisit(svc, addons, database = null) {
  if (!addons.priced) return { lines: [], total: 0, ambiguous: false };
  const InvoiceService = require('./invoice');
  const { lineItems } = await InvoiceService.buildLineItemsForScheduledService(svc.id, {
    fallbackDescription: svc.service_type,
    // An outage throws (a hold, retried) instead of reading as "no add-ons".
    strictReads: true,
    database,
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
// visit's add-ons (kept, not voided — its add-on charges stay owed), and
// does it carry charges that are not the covered base (re-billed by the
// office if it is voided)?
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
    this.lookupError = null;
    this.alertError = null;
    this.frozenLive = parseNotes(this.record?.structured_notes).annualPrepayAddonBilling === true;
  }

  // The gate, frozen at the first gate-on pass: a retry resumes an earlier
  // gate-on attempt even if the gate was turned off since. A freeze that
  // cannot be saved holds — no gated money work without its fence.
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

  // A read this closeout cannot decide without: hold for the retry.
  hold(err, what) {
    this.lookupError = err;
    logger.error(`[dispatch] annual-prepay ${what} unreadable for visit ${this.svc.id}: ${err.message}`);
  }

  // The one office alert for add-ons nothing here billed; it keeps the
  // completion text off "all paid". One bell per visit, kept CURRENT: a
  // later pass rewrites it and surfaces it unread. It never asserts that no
  // invoice exists — another writer can commit one at any moment — so it
  // always sends staff to the visit's invoices before they bill.
  async alert(reason, extra = {}) {
    const { svc } = this;
    this.owedUnbilled = true;
    try {
      const NotificationService = require('./notification-service');
      const bell = await NotificationService.notifyAdmin('billing', 'Annual-prepay add-ons need billing — check the visit\'s invoices first',
        `Completing ${svc.service_type} for customer ${svc.customer_id}: the visit is covered by the annual prepay, but its add-ons were not billed automatically — ${reason}. Check the visit's invoices first and bill only what none of them already charges.`,
        { link: `/admin/customers?customerId=${encodeURIComponent(svc.customer_id)}`, bell: true, dedupeKey: `annual_prepay_addons_unbilled:${svc.id}`,
          refreshOnDedupe: true,
          metadata: { customerId: svc.customer_id, scheduledServiceId: svc.id, reason, ...extra } });
      // notifyAdmin returns null when its insert fails.
      if (!bell) throw new Error('the office notification was not recorded');
    } catch (bellErr) {
      this.alertError = this.alertError || bellErr;
      logger.error(`[dispatch] annual-prepay add-ons alert FAILED for ${svc.id} (${reason}): ${bellErr.message}`);
    }
  }

  // Every invoice on the visit or its record, in any status (a voided or
  // refunded one is history too), oldest first.
  async invoiceHistory(conn = db) {
    const { svc, record } = this;
    return conn('invoices').where((qb) => {
      qb.where({ scheduled_service_id: svc.id });
      if (record?.id) qb.orWhere({ service_record_id: record.id });
    }).orderBy('created_at');
  }

  // Take the bill minted in this pass as the completion's invoice. Nothing
  // due (an estimate deposit covering all of it) = settled: no pay link, no
  // collection prompt. A zero-due draft is closed the canonical way
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
  // alerting (unbuildable lines, an add-on awaiting its price, a visit-wide
  // discount) or holding (a failed read), or when nothing is owed. A bill
  // is cut only when every owed add-on has a clear price: never a partial
  // bill beside an amount the office still has to decide.
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
        this.hold(err, 'add-on lines');
        return null;
      }
      await this.alert('the add-on lines could not be built', { error: String(err.message).slice(0, 200) });
      return null;
    }
    if (addons.unpriced) {
      await this.alert('an add-on has no price yet — price the add-ons and bill them');
      return null;
    }
    if (!extras.lines.length) return null;
    if (extras.ambiguous) {
      await this.alert(`a visit-wide discount applies, so the add-ons' share of it is unclear (they list at $${extras.total.toFixed(2)})`, { addonTotal: extras.total });
      return null;
    }
    return { current, addons, extras };
  }

  // Bill the add-ons on a visit with no invoice. The mint re-checks, under
  // the visit lock, what was decided before it (recheckInTrx): moved lines
  // are re-read and billed once more, then alerted.
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
        if (err.code === 'ADDON_RECHECK_READ_FAILED') {
          this.hold(err, 'add-on re-check');
          return;
        }
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
      // Re-checked under the visit lock. Invoice history: the mint adopts
      // only a live invoice, so one another writer made (and voided) since
      // the history read, or linked by the record alone, is found here. The
      // add-on rows and canonical lines: an edit the mint's price guard
      // cannot see (an add-on replaced at the same price, a discount moved
      // between lines at the same total) sends bill() back to decide again.
      // A status makes every failure here terminal for the deposit retry.
      recheckInTrx: async (trx) => {
        let moved;
        try {
          const [appeared] = await this.invoiceHistory(trx);
          if (appeared) throw Object.assign(new Error('an invoice appeared on the visit while billing'), { code: 'INVOICE_HISTORY_APPEARED', invoice: appeared });
          const lockedAddons = await annualPrepayAddonRows(current, trx);
          const lockedExtras = await annualPrepayExtrasForVisit(current, lockedAddons, trx);
          moved = lockedAddons.fingerprint !== addons.fingerprint || JSON.stringify(lockedExtras) !== JSON.stringify(extras);
        } catch (err) {
          if (['INVOICE_HISTORY_APPEARED', 'ADDON_LINES_NOT_BUILT'].includes(err.code)) throw Object.assign(err, { status: 409 });
          // A read that failed under the lock is an outage, not a conflict:
          // bill() holds for the retry.
          throw Object.assign(new Error(`the add-ons could not be re-checked under the lock: ${err.message}`), { code: 'ADDON_RECHECK_READ_FAILED', status: 409 });
        }
        if (moved) throw Object.assign(new Error('the visit\'s add-ons changed while billing'), { code: 'ADDON_LINES_MOVED', status: 409 });
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
    }).catch((err) => {
      if (err.code !== 'INVOICE_HISTORY_APPEARED') throw err;
      return { invoice: err.invoice, reused: true };
    });
    // An invoice another writer committed first — adopted by the mint, or
    // found under its lock in a status it does not adopt — is on the visit
    // and this closeout did not make it.
    if (minted.reused) {
      await this.alert(`invoice ${invoiceLabel(minted.invoice)} (${minted.invoice.status}) appeared on the visit while billing; bill whatever of the add-ons ($${extras.total.toFixed(2)}) it does not already charge`, { invoiceId: minted.invoice.id, addonTotal: extras.total });
      return;
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
    if (classifyCoveredVisitInvoice(office, addons).billsOnlyAddons) return { kind: 'kept', invoice: office };
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
    let voidErr = null;
    try {
      await InvoiceService.voidInvoice(office.id);
    } catch (err) {
      voidErr = err;
    }
    // The row as it was voided: an edit that landed after this closeout's
    // snapshot (a charge added by hand) is part of what was voided, so its
    // charges decide the office's follow-up. voidInvoice can throw AFTER its
    // void committed (the follow-up steps past its transaction); only a void
    // that did not land is a failure.
    let after;
    try {
      after = await db('invoices').where({ id: office.id }).first();
    } catch (err) {
      // What was voided (or whether the void landed) is unknown: hold, and
      // the retry decides from the row as it then reads.
      throw Object.assign(err, { holdCloseout: true });
    }
    if (voidErr && after?.status !== 'void') throw voidErr;
    if (voidErr) logger.warn(`[dispatch] annual-prepay covered visit ${svc.id}: invoice ${office.id} voided, then: ${voidErr.message}`);
    const voided = after || office;
    this.invoice = null;
    this.invoiceCreated = false;
    this.payUrl = null;
    this.alreadyPaid = true;
    return { kind: 'voided', invoice: voided, otherCharges: classifyCoveredVisitInvoice(voided, addons).otherCharges };
  }

  // The visit already has invoices. Dark, only the covered base is handled.
  // Live, what is still owed is the office's call: one alert listing every
  // invoice, and none of them is collected by the completion.
  async reconcileWithOfficeInvoices(history) {
    const { svc } = this;
    const open = this.invoice?.id && !['paid', 'prepaid', 'void'].includes(this.invoice.status);
    let addons = { clientIds: new Set(), owed: false };
    if (this.live) {
      try {
        addons = await annualPrepayAddonRows(svc);
      } catch (err) {
        this.hold(err, 'add-on rows');
        return;
      }
    }
    let outcome = {};
    if (open) {
      try {
        outcome = await this.reconcileOpenOfficeInvoice(addons);
      } catch (err) {
        if (err.holdCloseout) {
          this.hold(err, 'voided invoice');
          return;
        }
        logger.warn(`[dispatch] annual-prepay covered visit ${svc.id}: could not settle invoice ${this.invoice?.id}: ${err.message}`);
        outcome = { kind: 'left', invoice: this.invoice };
      }
    }
    if (!this.live) return;
    // The history as it stands now: an invoice voided above reads void.
    const listed = history.map((inv) => (outcome.kind === 'voided' && inv.id === outcome.invoice.id ? { ...inv, status: 'void' } : inv));
    // A voided invoice that charged more than the covered visit — voided
    // above, on an earlier attempt, or by the office — is re-billed by hand,
    // on any visit: those charges may be owed whether or not the add-ons
    // were done.
    const voidedCharges = (outcome.kind === 'voided' && outcome.otherCharges)
      || listed.some((inv) => inv.status === 'void' && classifyCoveredVisitInvoice(inv, addons).otherCharges);
    const listing = listed.map((inv) => `${invoiceLabel(inv)} (${inv.status})`).join(', ');
    const invoiceIds = listed.map((inv) => inv.id);
    if (voidedCharges) {
      await this.alert(`its invoices (${listing}) include a voided one that charged more than the covered visit; re-bill whatever it charged besides the covered visit that no other invoice covers`, { invoiceIds });
    } else if ((this.billable && addons.owed) || outcome.kind === 'kept') {
      // Owed add-ons beside an existing invoice, or an office bill for just
      // the add-ons kept as the office made it (its price may have changed
      // since — even to free): the office checks it; the completion never
      // collects it.
      const one = listed.length === 1;
      await this.alert(`the visit already has ${one ? 'invoice' : 'invoices'} ${listing} and the completion collected none; check ${one ? 'it' : 'them'} against the add-ons as they stand now — bill what is missing, adjust what changed, and send`, { invoiceIds });
    }
  }

  // The issued invoice is the customer-facing artifact the office chose to
  // send: never settled, voided, or billed beside. Owed add-ons it does not
  // carry are the office's to bill.
  async checkIssuedInvoice() {
    if (!this.billable) return;
    let addons;
    try {
      addons = await annualPrepayAddonRows(this.svc);
    } catch (err) {
      this.hold(err, 'add-on rows');
      return;
    }
    const lines = require('./invoice')._parseInvoiceLineItems(this.invoice?.line_items);
    const carried = new Set(lines.map((li) => li.client_id));
    if ([...addons.owedClientIds].every((id) => carried.has(id))) return;
    await this.alert(`the office issued invoice ${invoiceLabel(this.invoice)} (${this.invoice?.status || 'unknown'}) without every add-on on the visit; bill the add-ons it does not charge`, { invoiceId: this.invoice?.id || null });
  }

  async run() {
    await this.resolveGate();
    if (this.lookupError) return this.outcome();
    // Dark: today's behavior — only an open invoice's covered base, and an
    // issued invoice is never touched.
    if (!this.live) {
      if (this.invoice?.id && !this.ctx.issuedInvoiceCloseout) await this.reconcileWithOfficeInvoices([]);
      return this.outcome();
    }
    // The completion's own invoice lookups failed: an invoice may exist that
    // nothing here can see (a same-estimate sibling, say). Hold — the retry
    // re-runs the lookups — rather than decide blind.
    if (this.ctx.invoiceLookupFailed) {
      this.hold(new Error('the completion\'s invoice lookups failed'), 'invoice lookups');
      return this.outcome();
    }
    if (this.ctx.issuedInvoiceCloseout) {
      await this.checkIssuedInvoice();
      return this.outcome();
    }
    let history;
    try {
      history = await this.invoiceHistory();
    } catch (err) {
      this.hold(err, 'invoice history');
      return this.outcome();
    }
    // The invoice the completion selected for the visit (a same-estimate
    // sibling, say) is history too, even when it is not linked to the visit.
    const known = [this.invoice, this.ctx.terminalCompletionInvoice]
      .filter((inv) => inv?.id && !history.some((h) => h.id === inv.id));
    const evidence = [...history, ...known];
    if (evidence.length) {
      await this.reconcileWithOfficeInvoices(evidence);
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
    // Routed to the office with nothing collectible: the completion presents
    // no invoice — no pay link, no with-invoice text, no payer AP delivery
    // (the handler also keeps it out of account credit and Auto Pay).
    const officeReview = this.owedUnbilled && !this.extrasCollectible;
    return {
      invoice: this.invoice,
      payUrl: officeReview ? null : this.payUrl,
      alreadyPaid: this.alreadyPaid,
      invoiceCreated: officeReview ? false : this.invoiceCreated,
      extrasCollectible: this.extrasCollectible,
      owedUnbilled: this.owedUnbilled,
      hold,
    };
  }
}

async function reconcileCoveredVisitInvoice(ctx) {
  return new CoveredVisitCloseout(ctx).run();
}

module.exports = { reconcileCoveredVisitInvoice, annualPrepayAddonRows, classifyCoveredVisitInvoice };
