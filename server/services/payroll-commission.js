/**
 * Commission ledger into pay runs (owner rulings 2026-10-29, D5 part 3b-2 of the first-technician
 * pay plan). Dark behind GATE_PAYROLL_COMMISSION_LEDGER; needs GATE_PAYROLL_PAY_LINES.
 *
 * The rulings:
 *  - The technician earns 10% of what Waves COLLECTS for the NEW service only, in its first 12
 *    months, on work the technician brings in (estimates.sold_by_technician_id, part 3b-1). Paid
 *    in the next payroll after each payment, even after the technician leaves. Office-booked calls
 *    and web plans do not count. Collected = net of sales tax, the card surcharge and refunds.
 *  - A new customer pays on every payment on the new plan in its first 12 months. An existing
 *    customer's add-on pays only on the add-on's own invoice lines; a payment that covers several
 *    lines is split by each line's share.
 *  - A prepaid year pays its 10% in the next payroll. A refund inside the 12 months comes off the
 *    technician's next commission, never below $0 and never from wages. After the technician
 *    leaves, payments keep paying until the 12 months end. A refund dated after the 12 months is not
 *    taken back.
 *
 * Refunds are read from the payment row (status, refund_amount, refunded_surcharge_cents). The row keeps no
 * refund date, so the date is judged like this: a refund is taken off while the sale's 12 months still run
 * (today's Eastern date <= window_end), or when the payment record's last change (updated_at, an upper bound on
 * when the refund happened) is inside them. A refund first seen only after the 12 months, on a record changed
 * after them, is not taken back. Each entry stores the refunded base it has deducted so far
 * (refund_counted_cents); when the row shows less refunded than that (a refund failed, a dispute was won) the
 * money kept counts again. Every entry recomputes on every sync, so a refund inside the 12 months comes off the
 * next commission, never below $0 and never from wages; nothing is taken back when no later commission comes.
 * A refunded row with no refund amount and a disputed row count as refunded in full. A full refund of a combined
 * charge is stamped on each per-invoice row at its own share, so it reaches each invoice; a partial refund of a
 * combined charge touches no row and is not seen.
 *
 * Attribution is fixed when a payment is first counted: the entry stores the invoice the payment belongs to and that
 * invoice's share of the estimate and cash figures (share_own_cents, share_all_cents, pre_tax_cents, tax_cents) as
 * they were then. From then on the entry is computed from that snapshot and the payment's own status and refunds,
 * never from today's visits, add-on rows or invoice lines (Update Details deletes and re-inserts a visit's add-on
 * rows with new ids, and a later edit of the visits or lines must not move money already counted or paid). A line
 * not yet counted is matched to a sold add-on by its row id, or by the pair (host visit in its client_id, service key)
 * of a current add-on row of the estimate, and invoices are searched by the add-on rows' host visits too, so an invoice
 * billed before a row was replaced and paid after is still found. A sold visit's lines are its primary line and its
 * scheduled price top-up (scheduled_price_topup_<visit>, invoice.js), which brings a stale primary price up to the fee.
 *
 * Discounts: an invoice line's value is its amount less its discounts as the invoice writer allocates them. The saved
 * discount lines are replayed through the writer's own engine (discount-stack.js stackDocumentDiscounts) the way
 * invoice.js replays them on every later save: each at its frozen dollars, in its frozen canonical order (fixed credits
 * before percentages), a line discount on its line, a document-wide one on the lines its scope names (key AND
 * category). The sold lines' share of the invoice is their value over all.
 *
 * Payer statements (GATE_PAYER_STATEMENTS): settleStatementPaid writes ONE payment row for a whole NET-terms statement
 * (customer_id NULL, statement_id set) and marks the statement's child invoices paid. That row pays each child invoice
 * the invoice's total over the positive totals of the statement's invoices that are not void, so a sold invoice on a
 * statement gets its own entry (statement_part_cents over statement_total_cents), fixed like the rest of the snapshot.
 *
 * Deposits: an estimate deposit has no payments row. The deposit ledger (estimate_deposits) holds it, with its refunds
 * and disputes, so each collected deposit row counts as a payment (payment_source 'estimate_deposit', payment_id = the
 * deposit id): its face value less what was returned, on the estimate's invoice it was credited on (depositInvoice).
 *
 * Tables (migrations 20261029200000, 20261029203000 and 20261029204000): commission_sales (one per
 * accepted estimate sold by a W-2 technician; insert-only, except a customer merge moves its
 * customer_id) and commission_entries (one per sale, payment and invoice: what counted and what it
 * earns). The pay lines are payroll_pay_lines of kind 'commission', source_type
 * 'commission_payment', source_id '<entry id>:<n>'.
 *
 * syncCommissionLines runs where syncReviewBonusLines runs (start of draft, recompute and finalize,
 * under the payroll lock, before the run is worked out). It is derived data: the open ledger lines
 * are rebuilt from the entries every time and left alone when nothing changed. Payments, invoices
 * and visits are only read, never row-locked. Money is integer cents (BigInt, half-up). Audit
 * events carry ids and counts, never an amount or a customer name.
 *
 * Not built: monthly-membership dues (payments with no invoice) are not counted; the owner adds a
 * manual commission pay line for them.
 */
const { recordAuditEvent } = require('./audit-log');
const { stackDocumentDiscounts } = require('./discount-stack');
const { roundDiv } = require('./payroll-calc');
const { payrollPayLinesLive, payrollCommissionLedgerLive } = require('../config/feature-gates');
const { payrollUnits } = require('../utils/payroll-units');
const { etDateString } = require('../utils/datetime-et');
const { STAFF_TIME_ZONE, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

const SOURCE_TYPE = 'commission_payment';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The acceptance mint's own stamp (estimate-public.js, estimate-converter.js): every line of that invoice is the estimate's.
const AUTO_MINT_RE = /Auto-generated from accepted estimate #([0-9a-f-]{8,})/gi;
// Any invoice that names the estimate in its notes, as acceptedEstimateIdFromNotes (setup-fee-alert-reconcile.js) reads
// it (the office bills a missed setup fee or first application that way), kept here so payroll does not load the
// notification stack.
const NAMED_ESTIMATE_RE = /accepted estimate #([0-9a-f-]{8,})/gi;
// The lines the office or the completion mint bills for an accepted estimate with no line id: its one-time setup fees
// and its first application (invoice.js lineIsBaseApplication).
const SETUP_FEE_RE = /one-time setup fee/i;
const FIRST_APPLICATION_RE = /^first (service )?application$/i;
const INVOICE_NUMBER_RE = /^[A-Za-z0-9-]+$/;
const DESCRIPTION_RE = /^Invoice ([A-Za-z0-9-]+) — /;
const ADDON_CLIENT_RE = /^scheduled_([0-9a-f-]+)_addon_(.+)$/i;
const PRIMARY_CLIENT_RE = /^scheduled_([0-9a-f-]+)_primary$/i;
// invoice.js buildScheduledServiceInvoiceLines: the line that tops a visit's stale primary price up to its fee.
const TOPUP_CLIENT_RE = /^scheduled_price_topup_([0-9a-f-]+)$/i;

// The typeof guards keep a test mock of feature-gates that lacks a reader working (off).
const payLinesOn = () => typeof payrollPayLinesLive === 'function' && payrollPayLinesLive();
const ledgerOn = () => typeof payrollCommissionLedgerLive === 'function' && payrollCommissionLedgerLive();
// Date.now (not new Date()) so a test can set the day.
const todayEt = () => etDateString(new Date(Date.now()));
const rowsOf = (result) => (result && result.rows) || [];

// ---- 1. Sales

/** Inserts a sale for every accepted estimate sold by a W-2 technician (accepted by weekEnd) that has none. */
async function addSales(trx, weekEnd) {
  const result = await trx.raw(`
    INSERT INTO commission_sales (estimate_id, technician_id, customer_id, accepted_on, window_end)
    SELECT e.id, e.sold_by_technician_id, e.customer_id, d.accepted_on,
           (d.accepted_on + interval '12 months' - interval '1 day')::date
      FROM estimates e
      JOIN technicians t ON t.id = e.sold_by_technician_id
      CROSS JOIN LATERAL (SELECT (e.accepted_at AT TIME ZONE ?)::date AS accepted_on) d
     WHERE e.accepted_at IS NOT NULL AND t.employment_type = 'w2' AND d.accepted_on <= ?::date
       AND NOT EXISTS (SELECT 1 FROM commission_sales s WHERE s.estimate_id = e.id)
    ON CONFLICT (estimate_id) DO NOTHING
    RETURNING id`, [STAFF_TIME_ZONE, weekEnd]);
  return rowsOf(result).length;
}

const loadSales = (trx, weekEnd) => trx('commission_sales as s')
  .leftJoin('customers as c', 'c.id', 's.customer_id')
  .where('s.accepted_on', '<=', weekEnd)
  .orderBy([{ column: 's.accepted_on' }, { column: 's.id' }])
  .select('s.id', 's.estimate_id', 's.technician_id', 's.customer_id', 's.rate_bps',
    trx.raw("to_char(s.accepted_on, 'YYYY-MM-DD') as accepted_on"),
    trx.raw("to_char(s.window_end, 'YYYY-MM-DD') as window_end"),
    'c.first_name', 'c.last_name');

// ---- 2. Lineage of an estimate: its visits, its add-ons, the invoices that carry them

async function lineageOf(trx, sale) {
  const estimateId = String(sale.estimate_id);
  const visits = await trx('scheduled_services')
    .where(function ofEstimate() {
      this.where('source_estimate_id', estimateId).orWhereRaw("area_addon_scope->>'sourceEstimateId' = ?", [estimateId]);
    })
    .select('id', 'customer_id', 'first_application_invoice_id');
  const addons = await trx('scheduled_service_addons')
    .whereRaw("area_addon_scope->>'sourceEstimateId' = ?", [estimateId])
    .select('id', 'scheduled_service_id', 'service_key_snapshot');
  return {
    visitIds: new Set(visits.map((v) => v.id)),
    addonIds: new Set(addons.map((a) => a.id)),
    // Update Details deletes and re-inserts a visit's add-on rows with new ids, keeping the scope, the host visit and the
    // service key, while an invoice keeps the old row id in its line's client_id: the (host visit, service key) pair
    // is the stable identity of a sold add-on.
    addonHosts: [...new Set(addons.map((a) => a.scheduled_service_id))],
    addonPairs: new Set(addons.filter((a) => a.service_key_snapshot).map((a) => `${a.scheduled_service_id}|${a.service_key_snapshot}`)),
    customerIds: [...new Set([sale.customer_id, ...visits.map((v) => v.customer_id)].filter(Boolean))],
    firstApplicationInvoiceIds: visits.map((v) => v.first_application_invoice_id).filter(Boolean),
  };
}

/** Invoice ids that may carry the estimate's lines. Narrowed to the customer's invoices by the caller. */
async function candidateInvoiceIds(trx, sale, lineage) {
  const estimateId = String(sale.estimate_id);
  const visitIds = [...lineage.visitIds];
  const clientIds = [
    ...visitIds.flatMap((v) => [`scheduled_${v}_primary`, `scheduled_price_topup_${v}`]),
    ...[...lineage.addonIds].map((a) => `scheduled_%_addon_${a}`),
    ...lineage.addonHosts.map((host) => `scheduled_${host}_addon_%`),
  ];
  const exact = clientIds.filter((id) => !id.includes('%'));
  const addonLike = clientIds.filter((id) => id.includes('%'));
  const found = new Set(lineage.firstApplicationInvoiceIds);
  const add = (rows) => rows.forEach((row) => { if (row && row.id) found.add(row.id); });
  const mine = (query) => query.whereIn('i.customer_id', lineage.customerIds);
  add(await mine(trx('invoices as i')).where('i.notes', 'ilike', `%accepted estimate #${estimateId}%`).select('i.id'));
  add(await trx('setup_fee_claims').where({ estimate_id: estimateId }).select('invoice_id as id'));
  add(await trx('annual_prepay_terms').where({ source_estimate_id: estimateId }).whereNotNull('prepay_invoice_id').select('prepay_invoice_id as id'));
  if (visitIds.length) {
    add(await mine(trx('invoices as i')).whereIn('i.scheduled_service_id', visitIds).select('i.id'));
    add(await trx('visit_completion_packet_items').whereIn('scheduled_service_id', visitIds).whereNotNull('invoice_id').select('invoice_id as id'));
  }
  if (exact.length || addonLike.length) {
    add(await mine(trx('invoices as i')).whereRaw(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.line_items) = 'array' THEN i.line_items ELSE '[]'::jsonb END) li
         WHERE li->>'client_id' = ANY(?::text[]) OR li->>'client_id' LIKE ANY(?::text[]))`,
      [exact, addonLike],
    ).select('i.id'));
  }
  return [...found];
}

/**
 * True when the invoice line is one of the estimate's: its visit's primary line or price top-up, or its add-on's line
 * (by row id or by host visit and service key).
 */
function lineBelongs(net, lineage) {
  const visitLine = PRIMARY_CLIENT_RE.exec(net.clientId) || TOPUP_CLIENT_RE.exec(net.clientId);
  if (visitLine) return lineage.visitIds.has(visitLine[1]);
  const addon = ADDON_CLIENT_RE.exec(net.clientId);
  if (!addon) return false;
  // The row id of today, or the pair a replaced row still carries (host visit from the client id, the line's service key).
  return lineage.addonIds.has(addon[2]) || Boolean(net.serviceKey && lineage.addonPairs.has(`${addon[1]}|${net.serviceKey}`));
}

/**
 * The estimate's share of one invoice as { own, all } cents (share = own / all), from what `proof` shows about it:
 *  - proof.mint (the acceptance mint, stamped "Auto-generated from accepted estimate #<id>"): every line is the
 *    estimate's, share 1.
 *  - Otherwise the value (after discounts, see lineNets) of the estimate's lines over all lines. A line with a line id is
 *    the estimate's when lineBelongs. A line with no line id is the estimate's when no line of the invoice has an id and
 *    the invoice is the estimate's own (proof.own: its prepay term or first application invoice) or bills only its
 *    visits; or when it is a setup fee or first application line (net.named) and the invoice carries the estimate's
 *    setup fee claim or names the estimate in its notes (proof.named). A completion invoice that carries a setup fee
 *    can also carry another estimate's add-on, so it is never counted whole.
 */
function shareOf(invoice, proof, lineage, linkedVisitIds) {
  if (proof.mint) return { own: 1n, all: 1n };
  const lines = Array.isArray(invoice.line_items) ? invoice.line_items.filter(Boolean) : [];
  const nets = lineNets(lines);
  const unnamedMine = proof.own || (linkedVisitIds.length > 0 && linkedVisitIds.every((id) => lineage.visitIds.has(id)));
  if (!nets.length) return unnamedMine ? { own: 1n, all: 1n } : { own: 0n, all: 1n };
  const identified = nets.some((net) => net.clientId);
  const mine = (net) => (net.clientId ? lineBelongs(net, lineage) : (!identified && unnamedMine) || (proof.named && net.named));
  const sum = (list) => list.reduce((total, net) => total + net.net, 0n);
  return { own: sum(nets.filter(mine)), all: sum(nets) };
}

/** The estimate ids a note names through `pattern` (lower case). */
const namedIn = (notes, pattern) => [...String(notes || '').matchAll(pattern)].map((match) => match[1].toLowerCase());

// The frozen dollars and the canonical sort key a saved discount line replays with: invoice.js storedDiscountDollars
// and frozenSortKeyFields.
const hasNumber = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const storedDollars = (item) => Math.max(0, Math.round((hasNumber(item.discount_dollars)
  ? Number(item.discount_dollars) : Math.abs(Number(item.amount) || 0)) * 100) / 100);
const sortKeyOf = (item) => (item.stack_sort_kind == null ? {}
  : { sortKind: item.stack_sort_kind, sortValue: item.stack_sort_value, sortCap: item.stack_sort_cap });

/**
 * The lines a saved document-wide discount reaches, as invoice.js stackInvoiceDocumentDiscounts resolves a stored stamp:
 * null (every line) when it names no scope; else the lines matching EVERY scope it names (service key AND category).
 * A stamp the writer once resolved strictly (document_scope_strict) stays strict; any other scoped stamp reaches every
 * line of an invoice that carries no service key at all (a pre-scope invoice).
 */
function scopedLines(item, positives) {
  const key = item.document_scope_service_key;
  const category = item.document_scope_service_category;
  if (!key && !category) return null;
  const keyed = positives.some((line) => line.service_key != null && String(line.service_key) !== '');
  if (item.document_scope_strict !== true && !keyed) return null;
  return positives.map((line, i) => ((!key || String(line.service_key || '') === String(key))
    && (!category || String(line.service_category || '') === String(category)) ? i : -1)).filter((i) => i >= 0);
}

/**
 * What each positive line of an invoice is worth after its discounts, in cents, as the invoice writer allocates them:
 * the saved discount lines are replayed through stackDocumentDiscounts (discount-stack.js), the engine invoice.js prices
 * with, the way the writer itself replays them on every later save (each as a fixed amount of its frozen dollars, in its
 * frozen canonical order). A discount that names a line comes off that line; one whose line is gone is $0 (the writer
 * resolves it to $0); any other discount line is document-wide (scopedLines). A deposit_credit line is a prior payment,
 * not a discount (the deposit row counts as a payment, see depositPayment), and is left out. An invoice-level discount that never
 * became a line (a create-time discountIds pick, in discount_amount only) changes no line's share of the invoice.
 */
function lineNets(lines) {
  const positives = lines.filter((line) => Number(line.amount) > 0);
  const indexById = new Map();
  positives.forEach((line, i) => { if (line.client_id) indexById.set(String(line.client_id), i); });
  const lineTerms = positives.map(() => []);
  const documentTerms = [];
  for (const item of lines) {
    if (!(Number(item.amount) < 0) || item.category === 'deposit_credit') continue;
    const term = { discountType: 'fixed_amount', amount: storedDollars(item), ...sortKeyOf(item) };
    if (item.discount_for) {
      const at = indexById.get(String(item.discount_for));
      if (at !== undefined) lineTerms[at].push(term);
      continue;
    }
    const eligibleLines = scopedLines(item, positives);
    documentTerms.push({ ...term, ...(eligibleLines ? { eligibleLines } : {}), id: item.discount_id });
  }
  const stacked = stackDocumentDiscounts({
    lines: positives.map((line, i) => ({ gross: Math.max(0, Number(line.amount) || 0), terms: lineTerms[i] })),
    documentTerms,
  });
  return positives.map((line, i) => {
    const clientId = typeof line.client_id === 'string' && line.client_id ? line.client_id : null;
    const description = String(line.description || '').trim();
    return {
      clientId,
      serviceKey: line.service_key || null,
      named: !clientId && (line.category === 'Setup fee' || SETUP_FEE_RE.test(description) || FIRST_APPLICATION_RE.test(description)),
      net: payrollUnits(stacked.lines[i].net),
    };
  });
}

/** The customer's invoices that carry part of the estimate: Map invoice id -> invoice row plus its share and cash figures. */
async function estimateInvoices(trx, sale, lineage) {
  const ids = await candidateInvoiceIds(trx, sale, lineage);
  if (!ids.length || !lineage.customerIds.length) return new Map();
  const invoices = await trx('invoices').whereIn('id', ids).whereIn('customer_id', lineage.customerIds)
    .select('id', 'customer_id', 'invoice_number', 'notes', 'line_items', 'scheduled_service_id', 'subtotal', 'discount_amount', 'tax_amount',
      'total', 'status', 'payer_statement_id', 'created_at', 'updated_at');
  const packetRows = await trx('visit_completion_packet_items').whereIn('invoice_id', invoices.map((i) => i.id)).select('invoice_id', 'scheduled_service_id');
  const [claims, terms] = await Promise.all([
    trx('setup_fee_claims').where({ estimate_id: String(sale.estimate_id) }).select('invoice_id'),
    trx('annual_prepay_terms').where({ source_estimate_id: String(sale.estimate_id) }).select('prepay_invoice_id'),
  ]);
  const claimIds = new Set(claims.map((c) => c.invoice_id));
  const ownIds = new Set([...terms.map((t) => t.prepay_invoice_id), ...lineage.firstApplicationInvoiceIds]);
  const estimateId = String(sale.estimate_id).toLowerCase();
  const result = new Map();
  for (const invoice of invoices) {
    const preTax = payrollUnits(invoice.subtotal) - payrollUnits(invoice.discount_amount);
    if (preTax <= 0n) continue;
    const proof = {
      mint: namedIn(invoice.notes, AUTO_MINT_RE).includes(estimateId),
      own: ownIds.has(invoice.id),
      named: claimIds.has(invoice.id) || namedIn(invoice.notes, NAMED_ESTIMATE_RE).includes(estimateId),
    };
    const linked = [invoice.scheduled_service_id, ...packetRows.filter((p) => p.invoice_id === invoice.id).map((p) => p.scheduled_service_id)].filter(Boolean);
    const share = shareOf(invoice, proof, lineage, linked);
    if (share.own <= 0n || share.all <= 0n) continue;
    result.set(invoice.id, {
      ...invoice, mintedHere: proof.mint, preTax, tax: payrollUnits(invoice.tax_amount), totalCents: payrollUnits(invoice.total), share,
    });
  }
  return result;
}

const etDateOf = (value) => etDateString(value instanceof Date ? value : new Date(value));

// ---- 2b. The estimate's deposits

// Deposit rows that hold money Waves collected (estimate-deposits.js): pending and failed never collected anything.
const COLLECTED_DEPOSITS = ['received', 'credited', 'refunding', 'refunded'];

const depositColumns = ['id', 'status', 'amount', 'refunded_amount', 'credited_invoice_id', 'received_at', 'created_at', 'updated_at'];

/**
 * An estimate deposit has no payments row (estimate-deposits.js markDepositReceived): the deposit ledger
 * (estimate_deposits) holds it, and a refund or a dispute of it is recorded there too (refunded_amount, the face value
 * returned; status 'refunded' when all of it went back), while an invoice it was credited on keeps its deposit_credit
 * line for manual reconciliation. So the deposit row itself is the payment (id = the deposit id): its face value
 * (amount, which leaves out the card surcharge) less refunded_amount, dated the day it was received and never before
 * the sale, and refunds judged on the row's last change (countedRefund's 12-month rule).
 */
function depositPayment(deposit, sale) {
  const received = etDateOf(deposit.received_at || deposit.created_at);
  return {
    id: deposit.id,
    status: deposit.status === 'refunded' ? 'refunded' : 'paid',
    refund_amount: deposit.refunded_amount,
    refunded_surcharge_cents: 0,
    base_cents: payrollUnits(deposit.amount).toString(),
    payment_on: received > sale.accepted_on ? received : sale.accepted_on,
    updated_on: etDateOf(deposit.updated_at || deposit.created_at),
  };
}

const carriesDepositCredit = (invoice, estimateId) => (Array.isArray(invoice.line_items) ? invoice.line_items : [])
  .some((line) => line && line.category === 'deposit_credit' && Number(line.amount) < 0
    && (!line.estimate_id || String(line.estimate_id).toLowerCase() === estimateId));

/**
 * The estimate's invoice a deposit is counted on (its share and cash figures, as for a payment on it): the invoice that
 * absorbed all of it (credited_invoice_id); else the first of the estimate's invoices that carries a deposit credit for
 * it; else the acceptance mint. None yet (the deposit sits on no invoice of the estimate): not counted yet.
 */
function depositInvoice(deposit, invoices, estimateId) {
  if (deposit.credited_invoice_id && invoices.has(deposit.credited_invoice_id)) return invoices.get(deposit.credited_invoice_id);
  const byAge = [...invoices.values()].sort((a, b) => (new Date(a.created_at) - new Date(b.created_at)) || (a.id < b.id ? -1 : 1));
  return byAge.find((invoice) => carriesDepositCredit(invoice, estimateId)) || byAge.find((invoice) => invoice.mintedHere) || null;
}

/**
 * Per payer statement, what its one settlement payment is spread over: the sum of the positive totals of its child
 * invoices that are not void, in cents. Map statement id (text) -> cents.
 */
async function statementTotals(trx, statementIds) {
  const totals = new Map();
  if (!statementIds.length) return totals;
  const rows = await trx('invoices').whereIn('payer_statement_id', statementIds).whereNot('status', 'void').where('total', '>', 0)
    .select('payer_statement_id', 'total');
  for (const row of rows) {
    const id = String(row.payer_statement_id);
    totals.set(id, (totals.get(id) || 0n) + payrollUnits(row.total));
  }
  return totals;
}

// ---- 3. Payments to invoices (one invoice per payment row) and what counts

/**
 * The invoice a payment row belongs to, in the order loadPaymentForInvoice (receipt-payment.js) reads them: the
 * invoice id in metadata; only without it, an invoice with the same Stripe PaymentIntent; only without either, the
 * invoice named in the manual description `Invoice <number> — <method>`. A match on more than one invoice is no match.
 */
function invoiceOfPayment(payment, customerInvoices) {
  const sameCustomer = customerInvoices.filter((invoice) => invoice.customer_id === payment.customer_id);
  if (payment.metadata_invoice_id) {
    return sameCustomer.find((invoice) => invoice.id === payment.metadata_invoice_id) || null;
  }
  const byIntent = payment.stripe_payment_intent_id
    ? sameCustomer.filter((invoice) => invoice.stripe_payment_intent_id === payment.stripe_payment_intent_id) : [];
  if (byIntent.length) return byIntent.length === 1 ? byIntent[0] : null;
  const described = DESCRIPTION_RE.exec(String(payment.description || ''));
  if (!described || !INVOICE_NUMBER_RE.test(described[1])) return null;
  const byNumber = sameCustomer.filter((invoice) => invoice.invoice_number === described[1]);
  return byNumber.length === 1 ? byNumber[0] : null;
}

/**
 * The estimate's invoices one payment row pays, each as { invoice, part, of }: the invoice gets part / of of the
 * payment. A payer statement's settlement row (statement_id set) pays each of the statement's child invoices that is not
 * void its total over the statement's total (statementTotals); a part above its total is no match. Any other row pays
 * the one invoice invoiceOfPayment names, whole (part and of null).
 */
function paidInvoices(payment, invoices, customerInvoices, totals) {
  if (payment.statement_id) {
    const of = totals.get(String(payment.statement_id)) || 0n;
    return [...invoices.values()]
      .filter((invoice) => String(invoice.payer_statement_id) === String(payment.statement_id) && invoice.status !== 'void'
        && invoice.totalCents > 0n && invoice.totalCents <= of)
      .map((invoice) => ({ invoice, part: invoice.totalCents, of }));
  }
  const linked = invoiceOfPayment(payment, customerInvoices);
  const invoice = linked && invoices.get(linked.id);
  return invoice ? [{ invoice, part: null, of: null }] : [];
}

// Payment statuses that are cash Waves collected (a disputed row counts as refunded in full until the dispute is won,
// when the row returns to 'paid'). Every other status counts 0 and is not loaded.
const COUNTED_STATUSES = ['paid', 'refunded', 'disputed'];

/**
 * The base of a payment (the card surcharge is not in base) the row shows as refunded, in cents: the refunded cash
 * (refund_amount) without the surcharge share of it (refunded_surcharge_cents), at most the base. A 'refunded' row
 * with no refund amount and a 'disputed' row show the whole base.
 */
function refundedNow(payment) {
  const base = BigInt(payment.base_cents);
  const refundedTotal = payrollUnits(payment.refund_amount);
  if (payment.status === 'disputed' || (payment.status === 'refunded' && refundedTotal <= 0n)) return base;
  const refunded = refundedTotal - BigInt(payment.refunded_surcharge_cents || 0);
  if (refunded <= 0n) return 0n;
  return refunded < base ? refunded : base;
}

/**
 * The refunded base this entry deducts: what the row shows now when that is no more than the entry deducted so far (money
 * kept counts again); a larger refund only while the 12 months run or when the record's last change is inside them.
 */
function countedRefund(payment, previous, sale, today) {
  const now = refundedNow(payment);
  if (now <= previous) return now;
  return today <= sale.window_end || payment.updated_on <= sale.window_end ? now : previous;
}

/**
 * counted = (base - counted refund) x statement part x cash factor x share, half-up in one division; commission = counted
 * x rate, half-up. `snap` is the invoice's cash and share figures { preTax, tax, own, all } and its part of a statement
 * payment { part, of } (null for a payment of one invoice) as they were when the payment was first counted.
 */
function commissionOf(payment, refund, snap, rateBps) {
  const net = BigInt(payment.base_cents) - refund;
  const part = snap.part == null ? 1n : snap.part;
  const of = snap.of == null ? 1n : snap.of;
  const denominator = (snap.preTax + snap.tax) * snap.all * of;
  const counted = denominator > 0n && net > 0n ? roundDiv(net * part * snap.preTax * snap.own, denominator) : 0n;
  return { counted, commission: roundDiv(counted * BigInt(rateBps), 10000n) };
}

const paymentColumns = (trx) => ['p.id', 'p.customer_id', 'p.statement_id', 'p.status', 'p.description', 'p.refund_amount', 'p.stripe_payment_intent_id',
  trx.raw('COALESCE(p.refunded_surcharge_cents, 0) as refunded_surcharge_cents'),
  trx.raw("NULLIF(p.metadata->>'invoice_id', '') as metadata_invoice_id"),
  trx.raw("to_char(p.payment_date, 'YYYY-MM-DD') as payment_on"),
  trx.raw("to_char((p.updated_at AT TIME ZONE ?)::date, 'YYYY-MM-DD') as updated_on", [STAFF_TIME_ZONE]),
  trx.raw('COALESCE(p.base_amount_cents, ROUND(p.amount * 100))::bigint as base_cents')];

/**
 * The payments inside the sale's window (up to the run's week) that have no entry yet: the sale's customers' payments,
 * and the settlement rows of the payer statements that carry its invoices (those rows have no customer).
 */
async function loadNewPayments(trx, { customerIds, statementIds }, sale, weekEnd, skipIds) {
  const to = sale.window_end < weekEnd ? sale.window_end : weekEnd;
  if (sale.accepted_on > to) return [];
  return trx('payments as p')
    .where(function paidForSale() {
      this.whereIn('p.customer_id', customerIds);
      if (statementIds.length) this.orWhereIn('p.statement_id', statementIds);
    })
    .whereBetween('p.payment_date', [sale.accepted_on, to])
    .whereIn('p.status', COUNTED_STATUSES)
    .whereNotIn('p.id', skipIds)
    .select(paymentColumns(trx));
}

/**
 * The entries to write for money seen for the first time, one figure per payment and invoice, with the invoice, its
 * share, its cash figures and its part of the payment as they are NOW: the estimate's collected deposit rows
 * (depositPayment, on the invoice depositInvoice names), and every payment inside the sale's window that pays one of the
 * estimate's invoices (a statement payment can pay several). `skip` holds the payment and deposit ids already counted.
 */
async function newFigures(trx, sale, weekEnd, skip, today) {
  const lineage = await lineageOf(trx, sale);
  const invoices = await estimateInvoices(trx, sale, lineage);
  if (!invoices.size) return [];
  const figures = [];
  const add = (payment, source, { invoice, part, of }) => {
    const snap = { preTax: invoice.preTax, tax: invoice.tax, own: invoice.share.own, all: invoice.share.all, part, of };
    const refund = countedRefund(payment, 0n, sale, today);
    figures.push({ source, paymentId: payment.id, paymentOn: payment.payment_on, invoiceId: invoice.id, snap, refund, ...commissionOf(payment, refund, snap, sale.rate_bps) });
  };
  const to = sale.window_end < weekEnd ? sale.window_end : weekEnd;
  const deposits = await trx('estimate_deposits').where({ estimate_id: String(sale.estimate_id) }).whereIn('status', COLLECTED_DEPOSITS)
    .whereNotIn('id', [...skip.deposits]).select(depositColumns);
  for (const deposit of deposits) {
    const invoice = depositInvoice(deposit, invoices, String(sale.estimate_id).toLowerCase());
    const paid = depositPayment(deposit, sale);
    if (invoice && paid.payment_on <= to) add(paid, 'estimate_deposit', { invoice, part: null, of: null });
  }
  const statementIds = [...new Set([...invoices.values()].map((invoice) => invoice.payer_statement_id).filter(Boolean).map(String))];
  const payments = await loadNewPayments(trx, { customerIds: lineage.customerIds, statementIds }, sale, weekEnd, [...skip.payments]);
  if (!payments.length) return figures;
  const customerInvoices = await trx('invoices').whereIn('customer_id', lineage.customerIds)
    .select('id', 'customer_id', 'invoice_number', 'stripe_payment_intent_id');
  const totals = await statementTotals(trx, statementIds);
  for (const payment of payments) {
    for (const paid of paidInvoices(payment, invoices, customerInvoices, totals)) add(payment, 'payment', paid);
  }
  return figures;
}

const bigOrNull = (value) => (value == null ? null : BigInt(value));
const moneyKey = (source, id) => `${source}:${id}`;

/** The payment rows and the deposit rows (depositPayment) the entries follow now. Map moneyKey -> payment-like row. */
async function moneyOf(trx, sale, entries) {
  const ids = (source) => [...new Set(entries.filter((entry) => entry.payment_source === source).map((entry) => entry.payment_id))];
  const paymentIds = ids('payment');
  const depositIds = ids('estimate_deposit');
  const payments = paymentIds.length ? await trx('payments as p').whereIn('p.id', paymentIds).select(paymentColumns(trx)) : [];
  const deposits = depositIds.length ? await trx('estimate_deposits').whereIn('id', depositIds).select(depositColumns) : [];
  const money = new Map(payments.map((payment) => [moneyKey('payment', payment.id), payment]));
  for (const deposit of deposits) {
    // A deposit row whose payment never completed holds no money (COLLECTED_DEPOSITS): it counts 0, like a failed payment.
    if (COLLECTED_DEPOSITS.includes(deposit.status)) money.set(moneyKey('estimate_deposit', deposit.id), depositPayment(deposit, sale));
  }
  return money;
}

/**
 * The new figures of the entries a sale already has, from the snapshot each stored when its payment was first counted,
 * never from the current visits, add-on rows, invoice lines or statements. Only the payment's own status and refunds
 * move them. A payment that is gone, or has an uncounted status, counts 0 with the refund it deducted left as it was.
 */
async function entryFigures(trx, sale, entries, weekEnd, today) {
  const due = entries.filter((entry) => entry.payment_on <= weekEnd);
  const money = due.length ? await moneyOf(trx, sale, due) : new Map();
  return due.map((entry) => {
    const previous = BigInt(entry.refund_counted_cents);
    const payment = money.get(moneyKey(entry.payment_source, entry.payment_id));
    if (!payment || !COUNTED_STATUSES.includes(payment.status)) return { entry, counted: 0n, commission: 0n, refund: previous };
    const snap = {
      preTax: BigInt(entry.pre_tax_cents), tax: BigInt(entry.tax_cents), own: BigInt(entry.share_own_cents), all: BigInt(entry.share_all_cents),
      part: bigOrNull(entry.statement_part_cents), of: bigOrNull(entry.statement_total_cents),
    };
    const refund = countedRefund(payment, previous, sale, today);
    return { entry, refund, ...commissionOf(payment, refund, snap, sale.rate_bps) };
  });
}

// ---- 4. Entries

const textOrNull = (value) => (value == null ? null : value.toString());

const entryRow = (sale, figure) => ({
  sale_id: sale.id, payment_id: figure.paymentId, payment_source: figure.source, technician_id: sale.technician_id, payment_on: figure.paymentOn,
  counted_cents: figure.counted.toString(), commission_cents: figure.commission.toString(), refund_counted_cents: figure.refund.toString(),
  invoice_id: figure.invoiceId, share_own_cents: figure.snap.own.toString(), share_all_cents: figure.snap.all.toString(),
  pre_tax_cents: figure.snap.preTax.toString(), tax_cents: figure.snap.tax.toString(),
  statement_part_cents: textOrNull(figure.snap.part), statement_total_cents: textOrNull(figure.snap.of),
});

/**
 * Writes the entries of one sale. A payment seen late still gets its entries, with the invoices and shares it has then;
 * that attribution is fixed from then on. An entry follows its payment row (see countedRefund for which refunds count),
 * so a refund inside the 12 months comes off the next commission.
 */
async function syncEntries(trx, sale, weekEnd, today) {
  const existing = await trx('commission_entries').where({ sale_id: sale.id })
    .select('id', 'payment_id', 'payment_source', 'counted_cents', 'commission_cents', 'refund_counted_cents', 'share_own_cents', 'share_all_cents',
      'pre_tax_cents', 'tax_cents', 'statement_part_cents', 'statement_total_cents', trx.raw("to_char(payment_on, 'YYYY-MM-DD') as payment_on"));
  const countedIds = (source) => new Set(existing.filter((entry) => entry.payment_source === source).map((entry) => entry.payment_id));
  const figures = await newFigures(trx, sale, weekEnd, { payments: countedIds('payment'), deposits: countedIds('estimate_deposit') }, today);
  const inserts = figures.filter((figure) => figure.counted > 0n).map((figure) => entryRow(sale, figure));
  if (inserts.length) await trx('commission_entries').insert(inserts);
  let updated = 0;
  for (const { entry, counted, commission, refund } of await entryFigures(trx, sale, existing, weekEnd, today)) {
    if (BigInt(entry.counted_cents) === counted && BigInt(entry.commission_cents) === commission
      && BigInt(entry.refund_counted_cents) === refund) continue;
    await trx('commission_entries').where({ id: entry.id }).update({
      counted_cents: counted.toString(), commission_cents: commission.toString(), refund_counted_cents: refund.toString(), updated_at: trx.fn.now(),
    });
    updated += 1;
  }
  return { added: inserts.length, updated };
}

// ---- 5. Lines

const monthDay = (ymd) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;

/** The note on a line: which customer's payment, never an amount. */
function noteOf(entry) {
  const first = String(entry.first_name || '').trim().slice(0, 60);
  const last = String(entry.last_name || '').trim().slice(0, 1).toUpperCase();
  const who = first ? `${first}${last ? ` ${last}.` : ''}` : 'customer';
  return `Commission: ${who}, payment ${monthDay(entry.payment_on)}`;
}

/**
 * The lines a technician is owed now: what the entries up to weekEnd earn, less what paid lines already paid
 * (a refund shrinks an entry, so the difference comes off this commission), newest payment first. Nothing when
 * that is not above 0: a refund owed back carries to the next commission, never below $0, never from wages.
 */
function desiredLines(entries, paidByEntry, sourceIds, weekEnd) {
  const earned = entries.filter((e) => e.payment_on <= weekEnd);
  const paidTotal = [...paidByEntry.values()].reduce((a, b) => a + b, 0n);
  let due = earned.reduce((total, e) => total + BigInt(e.commission_cents), 0n) - paidTotal;
  const lines = [];
  const newestFirst = [...earned].sort((a, b) => (a.payment_on === b.payment_on ? (a.id < b.id ? -1 : 1) : (a.payment_on < b.payment_on ? 1 : -1)));
  for (const entry of newestFirst) {
    if (due <= 0n) break;
    const remaining = BigInt(entry.commission_cents) - (paidByEntry.get(entry.id) || 0n);
    if (remaining <= 0n) continue;
    const amount = remaining < due ? remaining : due;
    due -= amount;
    lines.push({
      kind: 'commission',
      amount_cents: Number(amount),
      earned_week_start: staffWeekStartForWorkDate(entry.payment_on),
      covers_from: staffWeekStartForWorkDate(entry.accepted_on),
      covers_to: entry.payment_on,
      source_type: SOURCE_TYPE,
      source_id: sourceIds.get(entry.id) || `${entry.id}:1`,
      note: noteOf(entry),
      created_by: null,
    });
  }
  return lines;
}

const lineKey = (line) => [line.source_id, line.amount_cents, line.earned_week_start, line.covers_from, line.covers_to, line.note].join('|');
const entryIdOf = (sourceId) => String(sourceId).split(':')[0];
const suffixOf = (sourceId) => Number(String(sourceId).split(':')[1]) || 0;

/**
 * The source_id each entry's next line takes (source_id is unique across every status). An entry that already has an
 * open line keeps that line's id, so a line a void reopened is kept as it is; any other entry takes the highest suffix
 * among its paid or voided lines + 1, never the count of them (a void can reopen :1 while :2 stays paid).
 */
function sourceIdsOf(openLines, highest) {
  const ids = new Map();
  for (const line of [...openLines].sort((a, b) => (a.source_id < b.source_id ? -1 : 1))) {
    const id = entryIdOf(line.source_id);
    if (!ids.has(id)) ids.set(id, line.source_id);
  }
  for (const [id, top] of highest) if (!ids.has(id)) ids.set(id, `${id}:${top + 1}`);
  return ids;
}

const lineColumns = (trx) => ['id', 'technician_id', 'status', 'amount_cents', 'source_id', 'note',
  trx.raw("to_char(earned_week_start, 'YYYY-MM-DD') as earned_week_start"),
  trx.raw("to_char(covers_from, 'YYYY-MM-DD') as covers_from"),
  trx.raw("to_char(covers_to, 'YYYY-MM-DD') as covers_to")];

const group = (rows, keyOf) => {
  const map = new Map();
  for (const row of rows) map.set(keyOf(row), [...(map.get(keyOf(row)) || []), row]);
  return map;
};

async function loadLedgerLines(trx, lock) {
  const openQuery = trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE, status: 'open' }).select(lineColumns(trx));
  if (lock) openQuery.forUpdate();
  const open = await openQuery;
  const closed = await trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE }).whereNot({ status: 'open' }).select(lineColumns(trx));
  return { open, closed };
}

const loadEntries = (trx) => trx('commission_entries as n')
  .join('commission_sales as s', 's.id', 'n.sale_id')
  .leftJoin('customers as c', 'c.id', 's.customer_id')
  .join('technicians as t', 't.id', 'n.technician_id')
  .where('t.employment_type', 'w2')
  .select('n.id', 'n.technician_id', 'n.commission_cents', 'c.first_name', 'c.last_name',
    trx.raw("to_char(n.payment_on, 'YYYY-MM-DD') as payment_on"),
    trx.raw("to_char(s.accepted_on, 'YYYY-MM-DD') as accepted_on"));

/** Makes the open ledger lines match the entries. Returns the ids of the lines removed and the source ids of the lines added. */
async function syncLines(trx, weekEnd, lock) {
  const [entries, { open, closed }] = await Promise.all([loadEntries(trx), loadLedgerLines(trx, lock)]);
  const entriesByTech = group(entries, (e) => e.technician_id);
  const openByTech = group(open, (l) => l.technician_id);
  const closedByTech = group(closed, (l) => l.technician_id);
  const removed = [];
  const added = [];
  const techIds = new Set([...entriesByTech.keys(), ...openByTech.keys()]);
  for (const technicianId of techIds) {
    const techClosed = closedByTech.get(technicianId) || [];
    const paidByEntry = new Map();
    const highest = new Map();
    for (const line of techClosed) {
      const id = entryIdOf(line.source_id);
      highest.set(id, Math.max(highest.get(id) || 0, suffixOf(line.source_id)));
      if (line.status === 'paid') paidByEntry.set(id, (paidByEntry.get(id) || 0n) + BigInt(line.amount_cents));
    }
    const current = openByTech.get(technicianId) || [];
    const wanted = desiredLines(entriesByTech.get(technicianId) || [], paidByEntry, sourceIdsOf(current, highest), weekEnd);
    const keep = new Set(wanted.map(lineKey));
    const have = new Set(current.map(lineKey));
    const stale = current.filter((line) => !keep.has(lineKey(line)));
    const fresh = wanted.filter((line) => !have.has(lineKey(line)));
    if (stale.length) await trx('payroll_pay_lines').whereIn('id', stale.map((l) => l.id)).del();
    if (fresh.length) await trx('payroll_pay_lines').insert(fresh.map((line) => ({ ...line, technician_id: technicianId })));
    removed.push(...stale.map((l) => l.id));
    added.push(...fresh.map((l) => l.source_id));
  }
  return { removed, added };
}

/** Ledger gate off: every open ledger line comes off. Paid lines stay. Returns the ids removed. */
async function dropOpenLines(trx, lock) {
  const query = trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE, status: 'open' }).select('id');
  if (lock) query.forUpdate();
  const ids = (await query).map((row) => row.id);
  if (ids.length) await trx('payroll_pay_lines').whereIn('id', ids).del();
  return ids;
}

async function audit(trx, actorId, weekEnd, metadata) {
  await recordAuditEvent({
    trx, critical: true, actor_type: 'admin', actor_id: actorId,
    action: 'payroll.commission_lines_synced', resource_type: 'payroll_pay_lines', resource_id: null,
    metadata: { week_end: weekEnd, ...metadata },
  });
}

/**
 * Makes the commission ledger and its open pay lines match the payments, for the pay run of the week ending
 * `weekEnd`. Take it inside the pay run's transaction, after the payroll lock and before the run is worked out.
 * With pay lines off it does nothing. With the ledger gate off it only removes the open ledger lines. With lock,
 * the technician's open ledger lines are read FOR UPDATE. Returns { removed, added } (line counts).
 */
async function syncCommissionLines(trx, { weekEnd, lock = false, actorId = null } = {}) {
  if (!payLinesOn()) return { removed: 0, added: 0 };
  if (!ledgerOn()) {
    const dropped = await dropOpenLines(trx, lock);
    if (dropped.length) await audit(trx, actorId, weekEnd, { ledger: 'off', removed_count: dropped.length, removed_line_ids: dropped });
    return { removed: dropped.length, added: 0 };
  }
  const today = todayEt();
  const salesAdded = await addSales(trx, weekEnd);
  let entriesAdded = 0;
  let entriesUpdated = 0;
  for (const sale of await loadSales(trx, weekEnd)) {
    const done = await syncEntries(trx, sale, weekEnd, today);
    entriesAdded += done.added;
    entriesUpdated += done.updated;
  }
  const { removed, added } = await syncLines(trx, weekEnd, lock);
  if (removed.length || added.length) {
    await audit(trx, actorId, weekEnd, {
      removed_count: removed.length, added_count: added.length, removed_line_ids: removed, added_entry_line_ids: added,
      sales_added: salesAdded, entries_added: entriesAdded, entries_updated: entriesUpdated,
    });
  }
  return { removed: removed.length, added: added.length };
}

module.exports = { SOURCE_TYPE, syncCommissionLines };
