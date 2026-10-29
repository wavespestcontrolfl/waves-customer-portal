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
 * Refunds are read from the payment row itself (status, refund_amount, refunded_surcharge_cents), with no
 * date condition: a paid or refunded payment counts at its base less the refunded cash without the card
 * surcharge share of it, a refunded row with no refund amount and a disputed row count 0 (a won dispute returns
 * the row to 'paid'). Every entry recomputes on every sync, so a refund of a counted payment comes off the next
 * commission whenever it happens; nothing is taken back when no later commission comes. A full refund of a combined
 * charge is stamped on each per-invoice row at its own share, so it reaches each invoice; a partial refund of a
 * combined charge touches no row and is not seen.
 *
 * Discounts: an invoice line's value is its amount less its discounts (invoice.js negative lines). A discount_for
 * line comes off its parent line; any other negative line (document-wide, a referral or deposit credit, a
 * discount_for naming a line that is gone) is spread over every positive line, or only the lines its service key or
 * category scope names, in proportion to their values. The sold lines' share of the invoice is their value over all.
 *
 * Tables (migration 20261029200000): commission_sales (one per accepted estimate sold by a W-2
 * technician, insert-only) and commission_entries (one per sale and payment: what counted and what
 * it earns). The pay lines are payroll_pay_lines of kind 'commission', source_type
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
const { roundDiv } = require('./payroll-calc');
const { payrollPayLinesLive, payrollCommissionLedgerLive } = require('../config/feature-gates');
const { payrollUnits } = require('../utils/payroll-units');
const { STAFF_TIME_ZONE, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

const SOURCE_TYPE = 'commission_payment';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Same pattern as acceptedEstimateIdFromNotes (setup-fee-alert-reconcile.js), kept here so payroll does not
// load the notification stack.
const MINTED_NOTE_RE = /accepted estimate #([0-9a-f-]{8,})/i;
const INVOICE_NUMBER_RE = /^[A-Za-z0-9-]+$/;
const DESCRIPTION_RE = /^Invoice ([A-Za-z0-9-]+) — /;
const ADDON_CLIENT_RE = /^scheduled_([0-9a-f-]+)_addon_(.+)$/i;
const PRIMARY_CLIENT_RE = /^scheduled_([0-9a-f-]+)_primary$/i;

// The typeof guards keep a test mock of feature-gates that lacks a reader working (off).
const payLinesOn = () => typeof payrollPayLinesLive === 'function' && payrollPayLinesLive();
const ledgerOn = () => typeof payrollCommissionLedgerLive === 'function' && payrollCommissionLedgerLive();
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
    .select('id');
  return {
    visitIds: new Set(visits.map((v) => v.id)),
    addonIds: new Set(addons.map((a) => a.id)),
    customerIds: [...new Set([sale.customer_id, ...visits.map((v) => v.customer_id)].filter(Boolean))],
    firstApplicationInvoiceIds: visits.map((v) => v.first_application_invoice_id).filter(Boolean),
  };
}

/** Invoice ids that may carry the estimate's lines. Narrowed to the customer's invoices by the caller. */
async function candidateInvoiceIds(trx, sale, lineage) {
  const estimateId = String(sale.estimate_id);
  const visitIds = [...lineage.visitIds];
  const clientIds = [
    ...visitIds.map((v) => `scheduled_${v}_primary`),
    ...[...lineage.addonIds].map((a) => `scheduled_%_addon_${a}`),
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

/** True when the invoice line is one of the estimate's: its visit's primary line, or its add-on's line. */
function lineBelongs(clientId, lineage) {
  const primary = PRIMARY_CLIENT_RE.exec(clientId);
  if (primary) return lineage.visitIds.has(primary[1]);
  const addon = ADDON_CLIENT_RE.exec(clientId);
  return Boolean(addon) && lineage.addonIds.has(addon[2]);
}

/**
 * The estimate's share of one invoice as { own, all } cents (share = own / all): 1 for an invoice minted from the
 * estimate; for another invoice the value (after discounts, see netLines) of the lines that belong to it over all lines; an invoice with no
 * line ids counts whole when every visit it bills is the estimate's.
 */
function shareOf(invoice, minted, lineage, linkedVisitIds) {
  if (minted) return { own: 1n, all: 1n };
  const lines = Array.isArray(invoice.line_items) ? invoice.line_items.filter(Boolean) : [];
  const nets = netLines(lines);
  if (nets.some((net) => net.clientId)) {
    const sum = (list) => list.reduce((total, net) => total + net.net, 0n);
    return { own: sum(nets.filter((net) => net.clientId && lineBelongs(net.clientId, lineage))), all: sum(nets) };
  }
  const whole = linkedVisitIds.length > 0 && linkedVisitIds.every((id) => lineage.visitIds.has(id));
  return whole ? { own: 1n, all: 1n } : { own: 0n, all: 1n };
}

/**
 * What each positive line of an invoice is worth after its discounts, in cents (invoice.js discount lines are negative
 * lines). A negative line whose discount_for names a positive line comes off that line. Any other negative line (no
 * discount_for, a referral or deposit credit, a discount_for naming a line that is gone) reaches the whole document: it
 * is spread over its pool in proportion to the lines' nets, in whole cents, and the pool is every positive line, or only
 * the lines matching document_scope_service_key / document_scope_service_category when either is set (and some line
 * carries a key or category at all). A net never goes below 0.
 */
function netLines(lines) {
  const nets = lines.filter((line) => payrollUnits(line.amount) > 0n).map((line) => ({
    clientId: typeof line.client_id === 'string' && line.client_id ? line.client_id : null,
    serviceKey: line.service_key || null,
    serviceCategory: line.service_category || null,
    net: payrollUnits(line.amount),
  }));
  const byId = new Map(nets.filter((net) => net.clientId).map((net) => [net.clientId, net]));
  const wide = [];
  for (const line of lines) {
    const amount = payrollUnits(line.amount);
    if (amount >= 0n) continue;
    const parent = line.discount_for ? byId.get(String(line.discount_for)) : null;
    if (parent) parent.net += amount; else wide.push(line);
  }
  for (const net of nets) if (net.net < 0n) net.net = 0n;
  for (const line of wide) spreadOver(documentPool(nets, line), -payrollUnits(line.amount));
  return nets;
}

function documentPool(nets, line) {
  const key = line.document_scope_service_key;
  const category = line.document_scope_service_category;
  if (!key && !category) return nets;
  // An invoice that carries no service keys or categories at all cannot be narrowed: the credit reaches every line.
  if (!nets.some((net) => net.serviceKey || net.serviceCategory)) return nets;
  return nets.filter((net) => (key && net.serviceKey === key) || (category && net.serviceCategory === category));
}

function spreadOver(pool, amount) {
  const total = pool.reduce((sum, net) => sum + net.net, 0n);
  if (total <= 0n) return;
  const cut = amount < total ? amount : total;
  for (const net of pool) {
    const part = roundDiv(cut * net.net, total);
    net.net -= part < net.net ? part : net.net;
  }
}

/** The customer's invoices that carry part of the estimate: Map invoice id -> invoice row plus its share and cash figures. */
async function estimateInvoices(trx, sale, lineage) {
  const ids = await candidateInvoiceIds(trx, sale, lineage);
  if (!ids.length || !lineage.customerIds.length) return new Map();
  const invoices = await trx('invoices').whereIn('id', ids).whereIn('customer_id', lineage.customerIds)
    .select('id', 'customer_id', 'invoice_number', 'notes', 'line_items', 'scheduled_service_id', 'subtotal', 'discount_amount', 'tax_amount');
  const packetRows = await trx('visit_completion_packet_items').whereIn('invoice_id', invoices.map((i) => i.id)).select('invoice_id', 'scheduled_service_id');
  const [claims, terms] = await Promise.all([
    trx('setup_fee_claims').where({ estimate_id: String(sale.estimate_id) }).select('invoice_id'),
    trx('annual_prepay_terms').where({ source_estimate_id: String(sale.estimate_id) }).select('prepay_invoice_id'),
  ]);
  const mintedIds = new Set([...claims.map((c) => c.invoice_id), ...terms.map((t) => t.prepay_invoice_id), ...lineage.firstApplicationInvoiceIds]);
  const result = new Map();
  for (const invoice of invoices) {
    const preTax = payrollUnits(invoice.subtotal) - payrollUnits(invoice.discount_amount);
    if (preTax <= 0n) continue;
    const noted = MINTED_NOTE_RE.exec(String(invoice.notes || ''));
    const minted = mintedIds.has(invoice.id) || Boolean(noted && noted[1].toLowerCase() === String(sale.estimate_id).toLowerCase());
    const linked = [invoice.scheduled_service_id, ...packetRows.filter((p) => p.invoice_id === invoice.id).map((p) => p.scheduled_service_id)].filter(Boolean);
    const share = shareOf(invoice, minted, lineage, linked);
    if (share.own <= 0n || share.all <= 0n) continue;
    result.set(invoice.id, { ...invoice, preTax, tax: payrollUnits(invoice.tax_amount), share });
  }
  return result;
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

// Only these payment statuses are cash Waves collected. A disputed payment counts 0 (a won dispute returns the row
// to 'paid' and it counts again), and so does every other status.
const COUNTED_STATUSES = ['paid', 'refunded'];

/**
 * What a payment leaves after refunds, in cents, read from the payment row itself with no date condition: its base
 * (the card surcharge is not in base) less the refunded cash (refund_amount) without the surcharge share of it
 * (refunded_surcharge_cents), never below 0. 'refunded' with no refund amount on the row counts 0.
 */
function netCents(payment) {
  if (!COUNTED_STATUSES.includes(payment.status)) return 0n;
  const refundedTotal = payrollUnits(payment.refund_amount);
  if (payment.status === 'refunded' && refundedTotal <= 0n) return 0n;
  const refunded = refundedTotal - BigInt(payment.refunded_surcharge_cents || 0);
  const net = BigInt(payment.base_cents) - (refunded > 0n ? refunded : 0n);
  return net > 0n ? net : 0n;
}

/** counted = net x cash factor x share, half-up in one division; commission = counted x rate, half-up. */
function commissionOf(payment, invoice, rateBps) {
  const net = netCents(payment);
  const denominator = (invoice.preTax + invoice.tax) * invoice.share.all;
  const counted = denominator > 0n ? roundDiv(net * invoice.preTax * invoice.share.own, denominator) : 0n;
  return { counted, commission: roundDiv(counted * BigInt(rateBps), 10000n) };
}

async function loadPayments(trx, customerIds, sale, weekEnd) {
  const to = sale.window_end < weekEnd ? sale.window_end : weekEnd;
  if (sale.accepted_on > to) return [];
  return trx('payments as p')
    .whereIn('p.customer_id', customerIds)
    .whereBetween('p.payment_date', [sale.accepted_on, to])
    .whereIn('p.status', COUNTED_STATUSES)
    .select('p.id', 'p.customer_id', 'p.status', 'p.description', 'p.refund_amount', 'p.stripe_payment_intent_id',
      trx.raw('COALESCE(p.refunded_surcharge_cents, 0) as refunded_surcharge_cents'),
      trx.raw("NULLIF(p.metadata->>'invoice_id', '') as metadata_invoice_id"),
      trx.raw("to_char(p.payment_date, 'YYYY-MM-DD') as payment_on"),
      trx.raw('COALESCE(p.base_amount_cents, ROUND(p.amount * 100))::bigint as base_cents'));
}

/** The commission of every payment inside the sale's window that belongs to one of the estimate's invoices: Map payment id -> figures. */
async function figuresOfSale(trx, sale, weekEnd) {
  const lineage = await lineageOf(trx, sale);
  const invoices = await estimateInvoices(trx, sale, lineage);
  const figures = new Map();
  if (!invoices.size) return figures;
  const payments = await loadPayments(trx, lineage.customerIds, sale, weekEnd);
  if (!payments.length) return figures;
  const customerInvoices = await trx('invoices').whereIn('customer_id', lineage.customerIds)
    .select('id', 'customer_id', 'invoice_number', 'stripe_payment_intent_id');
  const ofSale = payments.map((payment) => {
    const linked = invoiceOfPayment(payment, customerInvoices);
    return { payment, invoice: linked && invoices.get(linked.id) };
  }).filter((row) => row.invoice);
  for (const { payment, invoice } of ofSale) {
    const { counted, commission } = commissionOf(payment, invoice, sale.rate_bps);
    figures.set(payment.id, { paymentOn: payment.payment_on, counted, commission });
  }
  return figures;
}

// ---- 4. Entries

/**
 * Writes the entries of one sale. A payment seen late still gets its entry. An entry always follows the payment row
 * as it is now, so a refund of a counted payment comes off the next commission whenever it happens.
 */
async function syncEntries(trx, sale, weekEnd) {
  const figures = await figuresOfSale(trx, sale, weekEnd);
  const existing = await trx('commission_entries').where({ sale_id: sale.id })
    .select('id', 'payment_id', 'counted_cents', 'commission_cents', trx.raw("to_char(payment_on, 'YYYY-MM-DD') as payment_on"));
  const byPayment = new Map(existing.map((entry) => [entry.payment_id, entry]));
  const inserts = [];
  const changes = [];
  for (const [paymentId, figure] of figures) {
    const entry = byPayment.get(paymentId);
    if (!entry && figure.counted > 0n) {
      inserts.push({ sale_id: sale.id, payment_id: paymentId, technician_id: sale.technician_id, payment_on: figure.paymentOn,
        counted_cents: figure.counted.toString(), commission_cents: figure.commission.toString() });
    } else if (entry) {
      changes.push({ entry, counted: figure.counted, commission: figure.commission });
    }
  }
  // An entry whose payment is gone (or no longer belongs to the estimate) counts 0, up to the run's week.
  for (const entry of existing) {
    if (!figures.has(entry.payment_id) && entry.payment_on <= weekEnd) changes.push({ entry, counted: 0n, commission: 0n });
  }
  if (inserts.length) await trx('commission_entries').insert(inserts);
  let updated = 0;
  for (const { entry, counted, commission } of changes) {
    if ((BigInt(entry.counted_cents) === counted && BigInt(entry.commission_cents) === commission)) continue;
    await trx('commission_entries').where({ id: entry.id })
      .update({ counted_cents: counted.toString(), commission_cents: commission.toString(), updated_at: trx.fn.now() });
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
  const salesAdded = await addSales(trx, weekEnd);
  let entriesAdded = 0;
  let entriesUpdated = 0;
  for (const sale of await loadSales(trx, weekEnd)) {
    const done = await syncEntries(trx, sale, weekEnd);
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
