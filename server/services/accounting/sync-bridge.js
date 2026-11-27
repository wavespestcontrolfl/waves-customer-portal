/**
 * Idempotent Subledger-to-GL Sync Bridge.
 *
 * Reads Waves' operational tables (invoices, estimate_deposits, payments,
 * stripe_payout_transactions outflows & fees, stripe_payouts, expenses,
 * finalized & voided payroll_runs) for an Eastern-calendar date range and posts
 * balanced Journal Entries via posting-rules.js + ledger.postJournalEntry().
 *
 * Key guarantees:
 * - PostgreSQL DATE columns are selected as ISO text ('YYYY-MM-DD') and NEVER shifted
 *   via timezone conversion; Eastern conversion applies ONLY to TIMESTAMPTZ columns.
 * - All reads and writes run through the injected `conn` (preserving caller transactions).
 * - Dry runs execute the exact same validation, idempotency, account-active, and period-lock
 *   checks as live runs without mutating the database.
 */

const db = require('../../models/db');
const { etDateString } = require('../../utils/datetime-et');
const { isInternalTestContact } = require('../internal-test-customers');
const { outflowTransactionsQuery } = require('../pnl-report');
const {
  SYSTEM_CODES,
  ensureSystemAccounts,
  dollarsToCents,
  dateCellText,
} = require('./coa-seed');
const {
  assertValidDate,
  validateJournalEntryInput,
  postJournalEntry,
  reverseJournalEntry,
} = require('./ledger');
const rules = require('./posting-rules');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function timestampToEtDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return etDateString(d);
}

function isTestCustomerRow(row) {
  if (!row) return false;
  return isInternalTestContact({
    customerId: row.customer_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
  });
}

function isCommercialProperty(propertyType) {
  const v = String(propertyType || '').trim().toLowerCase();
  return v === 'commercial' || v === 'business';
}

function parseJsonObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return typeof raw === 'object' ? raw : {};
}

function parseLineItems(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function extractAppliedDepositCents(lineItems) {
  let total = 0;
  for (const li of parseLineItems(lineItems)) {
    if (li?.category === 'deposit_credit') {
      total += Math.abs(dollarsToCents(li.amount) || 0);
    }
  }
  return total;
}

function extractSurchargeCents(pay, grossCents) {
  let surcharge = 0;
  if (pay.surcharge_amount_cents != null && Number(pay.surcharge_amount_cents) > 0) {
    surcharge = Math.trunc(Number(pay.surcharge_amount_cents));
  } else {
    const meta = parseJsonObject(pay.metadata);
    const metaSurcharge = meta.card_surcharge != null ? (dollarsToCents(meta.card_surcharge) || 0) : 0;
    if (metaSurcharge > 0) {
      surcharge = metaSurcharge;
    } else if (pay.base_amount_cents != null && Number(pay.base_amount_cents) > 0) {
      surcharge = grossCents - Math.trunc(Number(pay.base_amount_cents));
    }
  }
  return surcharge > 0 && surcharge < grossCents ? surcharge : 0;
}

function resolvePaymentMethod(pay) {
  const proc = String(pay.processor || '').toLowerCase();
  if (proc === 'stripe' || pay.stripe_payment_intent_id || pay.stripe_charge_id) return 'stripe';
  const mt = String(pay.payment_method_type || '').toLowerCase();
  if (mt === 'zelle') return 'zelle';
  if (mt === 'cash') return 'cash';
  if (mt === 'check') return 'check';
  if (mt === 'us_bank_account' || mt === 'ach' || mt === 'bank_transfer') return 'ach_direct';
  return 'ach_direct';
}

function isStripeLedgeredPayment(pay) {
  return String(pay.processor || '').toLowerCase() === 'stripe'
    && Boolean(pay.stripe_charge_id || pay.stripe_payment_intent_id);
}

function paymentAccountCodeForExpense(paymentMethod) {
  const m = String(paymentMethod || '').toLowerCase();
  if (m === 'card' || m === 'credit_card' || m === 'credit') return SYSTEM_CODES.CREDIT_CARD_PRIMARY;
  return SYSTEM_CODES.CHECKING_PRIMARY;
}

function normalizeVendorName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function computeProratedRefundTaxCents(refundTotalCents, linkedInvoice, paymentAmountDollars = null) {
  if (!linkedInvoice || refundTotalCents <= 0) return 0;
  const invTaxCents = Math.max(0, dollarsToCents(linkedInvoice.tax_amount) || 0);
  if (invTaxCents <= 0) return 0;
  const payGrossCents = paymentAmountDollars != null ? Math.max(0, dollarsToCents(paymentAmountDollars) || 0) : 0;
  const invTotalCents = Math.max(0, dollarsToCents(linkedInvoice.total) || 0);
  const denom = Math.max(payGrossCents, invTotalCents);
  if (denom <= 0) return 0;
  if (refundTotalCents >= denom) return Math.min(invTaxCents, refundTotalCents);
  const raw = Math.round((invTaxCents * refundTotalCents) / denom);
  return Math.max(0, Math.min(raw, invTaxCents, refundTotalCents));
}

async function loadSyncCaches(conn) {
  const [accounts, lockedPeriods] = await Promise.all([
    conn('gl_accounts').select('id', 'code', 'active'),
    conn('gl_periods').where({ status: 'locked' }).select('period_month'),
  ]);
  return {
    accountsById: new Map(accounts.map((a) => [String(a.id).toLowerCase(), a])),
    accountsByCode: new Map(accounts.map((a) => [a.code, a])),
    lockedMonths: new Set(lockedPeriods.map((p) => p.period_month)),
    seenPreviewKeys: new Set(),
  };
}

function validatePreviewAccounts(lines, caches) {
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const acct = l.account_id
      ? caches.accountsById.get(String(l.account_id).toLowerCase())
      : caches.accountsByCode.get(l.account_code);
    if (!acct) return `Line ${i + 1}: account ${l.account_code || l.account_id} not found`;
    if (!acct.active) return `Line ${i + 1}: account ${acct.code} is inactive`;
  }
  return null;
}

async function previewEntry(entryInput, ctx, bucket) {
  let normalized;
  try {
    normalized = validateJournalEntryInput(entryInput);
  } catch (err) {
    ctx.stats[bucket].errors.push({ idempotencyKey: entryInput?.idempotencyKey || null, message: err.message });
    return;
  }

  const key = normalized.idempotency_key;
  if (key) {
    if (ctx.caches.seenPreviewKeys.has(key)) {
      ctx.stats[bucket].skipped += 1;
      return;
    }
    const existing = await ctx.conn('gl_journal_entries').where({ idempotency_key: key }).first('id');
    if (existing) {
      ctx.stats[bucket].skipped += 1;
      return;
    }
  }

  const periodMonth = normalized.entry_date.slice(0, 7);
  if (ctx.caches.lockedMonths.has(periodMonth)) {
    ctx.stats[bucket].errors.push({
      idempotencyKey: key,
      message: `Accounting period ${periodMonth} is locked. Post an adjusting or reversing entry in an open period.`,
    });
    return;
  }

  const acctErr = validatePreviewAccounts(normalized.lines, ctx.caches);
  if (acctErr) {
    ctx.stats[bucket].errors.push({ idempotencyKey: key, message: acctErr });
    return;
  }

  if (key) ctx.caches.seenPreviewKeys.add(key);
  ctx.stats[bucket].would_post += 1;
}

async function postOrPreview(entryInput, ctx, bucket) {
  if (ctx.dryRun) {
    await previewEntry(entryInput, ctx, bucket);
    return;
  }
  try {
    const res = await postJournalEntry(entryInput, {
      conn: ctx.conn,
      actorId: ctx.actorId,
      requestMeta: ctx.requestMeta,
    });
    if (res.created) ctx.stats[bucket].posted += 1;
    else ctx.stats[bucket].skipped += 1;
  } catch (err) {
    ctx.stats[bucket].errors.push({ idempotencyKey: entryInput.idempotencyKey, message: err.message });
  }
}

async function reverseOrPreview(origEntry, reversalDate, reason, ctx, bucket) {
  const revKey = `reversal:${origEntry.id}`;
  if (ctx.dryRun) {
    if (origEntry.reversed_by_entry_id || ctx.caches.seenPreviewKeys.has(revKey)) {
      ctx.stats[bucket].skipped += 1;
      return;
    }
    const existingRev = await ctx.conn('gl_journal_entries').where({ idempotency_key: revKey }).first('id');
    if (existingRev) {
      ctx.stats[bucket].skipped += 1;
      return;
    }
    const periodMonth = reversalDate.slice(0, 7);
    if (ctx.caches.lockedMonths.has(periodMonth)) {
      ctx.stats[bucket].errors.push({
        idempotencyKey: revKey,
        message: `Accounting period ${periodMonth} is locked. Reopen or reverse in an open period.`,
      });
      return;
    }
    ctx.caches.seenPreviewKeys.add(revKey);
    ctx.stats[bucket].would_reverse += 1;
    return;
  }

  try {
    await reverseJournalEntry(origEntry.id, {
      reversalDate,
      reason,
      actorId: ctx.actorId,
      requestMeta: ctx.requestMeta,
      conn: ctx.conn,
    });
    ctx.stats[bucket].reversed += 1;
  } catch (err) {
    if (err && err.code === 'ALREADY_REVERSED') ctx.stats[bucket].skipped += 1;
    else ctx.stats[bucket].errors.push({ idempotencyKey: revKey, message: err.message });
  }
}

async function loadInvoicesForLinks(conn, invoiceIds, piIds) {
  const byId = new Map();
  const byPi = new Map();
  if (!(await conn.schema.hasTable('invoices'))) return { byId, byPi };
  const cleanIds = [...new Set(invoiceIds.filter((id) => id && UUID_RE.test(String(id))))];
  const cleanPis = [...new Set(piIds.filter(Boolean))];
  if (!cleanIds.length && !cleanPis.length) return { byId, byPi };

  const rows = await conn('invoices as i')
    .leftJoin('customers as c', 'c.id', 'i.customer_id')
    .where((q) => {
      if (cleanIds.length) q.orWhereIn('i.id', cleanIds);
      if (cleanPis.length) q.orWhereIn('i.stripe_payment_intent_id', cleanPis);
    })
    .select(
      'i.id', 'i.stripe_payment_intent_id', 'i.service_type', 'i.total', 'i.tax_amount',
      'i.subtotal', 'i.discount_amount', 'c.property_type',
    );
  for (const r of rows) {
    byId.set(String(r.id), r);
    if (r.stripe_payment_intent_id) byPi.set(String(r.stripe_payment_intent_id), r);
  }
  return { byId, byPi };
}

function safeNonNegCents(val) {
  return Math.max(0, dollarsToCents(val || 0) || 0);
}

function buildCoveredPrepayVisitPayload(inv, issueDate, serviceLine, isCommercial, taxCents) {
  const rawPreTax = (dollarsToCents(inv.subtotal || 0) || 0) - (dollarsToCents(inv.discount_amount || 0) || 0);
  const amountCents = rawPreTax > 0 ? rawPreTax : Math.max(0, safeNonNegCents(inv.total) - taxCents);
  if (amountCents <= 0) return null;
  return rules.buildUnearnedRecognitionEntry({
    sourceId: `covered-inv:${inv.id}`,
    recognitionDate: issueDate,
    amountCents,
    serviceLine,
    isCommercial,
    customerId: inv.customer_id,
    memo: `Annual prepay covered visit ${inv.invoice_number || inv.id}`,
  });
}

function buildInvoiceGlPayload(inv, prepayInvoiceIds) {
  const issueDate = dateCellText(inv.service_date)
    || timestampToEtDate(inv.sent_at)
    || timestampToEtDate(inv.created_at);
  if (!issueDate) return null;

  const isCommercial = isCommercialProperty(inv.property_type);
  const serviceLine = isCommercial ? 'commercial' : (inv.service_type || 'pest');
  const taxCents = safeNonNegCents(inv.tax_amount);

  if (inv.annual_prepay_covered_term_id) {
    return buildCoveredPrepayVisitPayload(inv, issueDate, serviceLine, isCommercial, taxCents);
  }

  const totalDueCents = safeNonNegCents(inv.total);
  const appliedDepositCents = extractAppliedDepositCents(inv.line_items);
  const appliedCreditCents = Math.min(safeNonNegCents(inv.credit_applied), totalDueCents);
  const subtotalCents = Math.max(0, totalDueCents + appliedDepositCents - taxCents);
  if (subtotalCents + taxCents <= 0) return null;

  return rules.buildInvoiceEntry({
    invoiceId: inv.id,
    invoiceNumber: inv.invoice_number,
    issueDate,
    subtotalCents,
    taxCents,
    appliedDepositCents,
    appliedCreditCents,
    serviceLine,
    isCommercial,
    isAnnualPrepay: Boolean(inv.annual_prepay_term_id || prepayInvoiceIds.has(String(inv.id))),
    customerId: inv.customer_id,
  });
}

async function syncInvoices(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('invoices'))) return;

  const prepayInvoiceIds = new Set();
  if (await conn.schema.hasTable('annual_prepay_terms')) {
    const termRows = await conn('annual_prepay_terms')
      .whereNotNull('prepay_invoice_id')
      .select('prepay_invoice_id');
    for (const t of termRows) prepayInvoiceIds.add(String(t.prepay_invoice_id));
  }

  const rows = await conn('invoices as i')
    .leftJoin('customers as c', 'c.id', 'i.customer_id')
    .whereNotIn('i.status', ['draft', 'scheduled', 'sending', 'void', 'cancelled', 'canceled'])
    .whereNull('i.archived_at')
    .whereRaw(
      "COALESCE(i.service_date, DATE(i.sent_at AT TIME ZONE 'America/New_York'), DATE(i.created_at AT TIME ZONE 'America/New_York')) BETWEEN ?::date AND ?::date",
      [from, to],
    )
    .select(
      'i.id', 'i.invoice_number', 'i.customer_id', 'i.subtotal', 'i.discount_amount', 'i.tax_amount', 'i.total',
      'i.credit_applied', 'i.line_items', 'i.service_type', 'i.annual_prepay_term_id', 'i.annual_prepay_covered_term_id',
      conn.raw('i.service_date::text as service_date'), 'i.sent_at', 'i.created_at',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.property_type',
    );

  for (const inv of rows) {
    if (isTestCustomerRow(inv)) continue;
    const entry = buildInvoiceGlPayload(inv, prepayInvoiceIds);
    if (!entry) continue;
    await postOrPreview(entry, ctx, 'invoices');
  }
}

async function syncEstimateDeposits(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('estimate_deposits'))) return;
  const rows = await conn('estimate_deposits as d')
    .leftJoin('customers as c', 'c.id', 'd.customer_id')
    .whereNotNull('d.received_at')
    .whereRaw("DATE(d.received_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to])
    .select(
      'd.id', 'd.customer_id', 'd.amount', 'd.card_surcharge', 'd.stripe_payment_intent_id', 'd.received_at',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone',
    );

  for (const dep of rows) {
    if (isTestCustomerRow(dep)) continue;
    const paymentDate = timestampToEtDate(dep.received_at);
    const faceCents = dollarsToCents(dep.amount);
    const surchargeCents = Math.max(0, dollarsToCents(dep.card_surcharge || 0) || 0);
    if (!paymentDate || !faceCents || faceCents <= 0) continue;

    const entry = rules.buildPaymentEntry({
      paymentId: dep.id,
      idempotencyKey: `deposit:${dep.id}`,
      paymentDate,
      grossCents: faceCents + surchargeCents,
      feeCents: 0,
      surchargeCents,
      method: 'stripe',
      isDeposit: true,
      customerId: dep.customer_id,
      reference: dep.stripe_payment_intent_id || dep.id,
      memo: 'Estimate acceptance deposit',
    });
    await postOrPreview(entry, ctx, 'deposits');
  }
}

function linkedInvoiceForPayment(pay, invoiceMaps) {
  const meta = parseJsonObject(pay.metadata);
  const metaInvId = meta.invoice_id || meta.dispute_invoice_id;
  if (metaInvId && invoiceMaps.byId.has(String(metaInvId))) return invoiceMaps.byId.get(String(metaInvId));
  if (pay.stripe_payment_intent_id && invoiceMaps.byPi.has(String(pay.stripe_payment_intent_id))) {
    return invoiceMaps.byPi.get(String(pay.stripe_payment_intent_id));
  }
  return null;
}

function collectPaymentInvoiceRefs(rows) {
  const ids = [];
  const pis = [];
  for (const r of rows) {
    const meta = parseJsonObject(r.metadata);
    if (meta.invoice_id) ids.push(meta.invoice_id);
    if (meta.dispute_invoice_id) ids.push(meta.dispute_invoice_id);
    if (r.stripe_payment_intent_id) pis.push(r.stripe_payment_intent_id);
  }
  return { ids, pis };
}

function resolvePaymentContext(pay, linkedInv) {
  const meta = parseJsonObject(pay.metadata);
  const method = resolvePaymentMethod(pay);
  const isDeposit = !linkedInv && !pay.statement_id && /deposit/i.test(String(meta.type || meta.source || ''));
  const isCommercial = isCommercialProperty(linkedInv?.property_type || pay.property_type);
  const serviceLine = isCommercial ? 'commercial' : (linkedInv?.service_type || null);
  const metaInvId = UUID_RE.test(String(meta.invoice_id || '')) ? meta.invoice_id : null;
  return {
    method,
    isDeposit,
    serviceLine,
    invoiceId: linkedInv?.id || metaInvId,
  };
}

async function syncSinglePaymentRow(pay, invoiceMaps, ctx) {
  const paymentDate = dateCellText(pay.payment_date) || timestampToEtDate(pay.created_at);
  const grossCents = dollarsToCents(pay.amount);
  if (!paymentDate || !grossCents || grossCents <= 0) return;

  const linkedInv = linkedInvoiceForPayment(pay, invoiceMaps);
  const pCtx = resolvePaymentContext(pay, linkedInv);

  await postOrPreview(rules.buildPaymentEntry({
    paymentId: pay.id,
    paymentDate,
    grossCents,
    feeCents: 0,
    surchargeCents: extractSurchargeCents(pay, grossCents),
    method: pCtx.method,
    isDeposit: pCtx.isDeposit,
    invoiceId: pCtx.invoiceId,
    customerId: pay.customer_id,
    serviceLine: pCtx.serviceLine,
    reference: pay.stripe_payment_intent_id || pay.id,
  }), ctx, 'payments');

  const manualRefundCents = isStripeLedgeredPayment(pay) ? 0 : safeNonNegCents(pay.refund_amount);
  if (manualRefundCents <= 0) return;

  const taxCents = computeProratedRefundTaxCents(manualRefundCents, linkedInv, pay.amount);
  await postOrPreview(rules.buildRefundEntry({
    refundId: `manual:${pay.id}`,
    idempotencyKey: `refund:manual:${pay.id}`,
    refundDate: timestampToEtDate(pay.refunded_at) || paymentDate,
    subtotalCents: manualRefundCents - taxCents,
    taxCents,
    method: pCtx.method,
    customerId: pay.customer_id,
    invoiceId: linkedInv?.id || null,
    serviceLine: pCtx.serviceLine,
    reference: pay.id,
    reason: `Customer refund (${pCtx.method})`,
  }), ctx, 'refunds');
}

async function syncPayments(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('payments'))) return;
  const rows = await conn('payments as p')
    .leftJoin('customers as c', 'c.id', 'p.customer_id')
    .whereIn('p.status', ['paid', 'refunded', 'disputed'])
    .whereRaw("COALESCE(p.metadata->>'source', '') <> 'invoice_refund'")
    .whereRaw(
      "COALESCE(p.payment_date, DATE(p.created_at AT TIME ZONE 'America/New_York')) BETWEEN ?::date AND ?::date",
      [from, to],
    )
    .select(
      'p.id', 'p.customer_id', 'p.amount', 'p.base_amount_cents', 'p.surcharge_amount_cents',
      'p.refund_amount', 'p.status', 'p.processor', 'p.payment_method_type',
      'p.stripe_payment_intent_id', 'p.stripe_charge_id', 'p.statement_id', 'p.payer_id',
      'p.metadata', conn.raw('p.payment_date::text as payment_date'), 'p.refunded_at', 'p.created_at',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.property_type',
    );

  const nonTestRows = rows.filter((r) => !isTestCustomerRow(r));
  const { ids, pis } = collectPaymentInvoiceRefs(nonTestRows);
  const invoiceMaps = await loadInvoicesForLinks(conn, ids, pis);

  for (const pay of nonTestRows) {
    await syncSinglePaymentRow(pay, invoiceMaps, ctx);
  }
}

function collectOutflowInvoiceRefs(rows) {
  const ids = [];
  const pis = [];
  for (const r of rows) {
    if (r.invoice_id) ids.push(r.invoice_id);
    const meta = parseJsonObject(r.payment_metadata);
    if (meta.invoice_id) ids.push(meta.invoice_id);
    if (meta.dispute_invoice_id) ids.push(meta.dispute_invoice_id);
    if (r.payment_pi) pis.push(r.payment_pi);
  }
  return { ids, pis };
}

function resolveOutflowLinkedInvoice(row, invoiceMaps) {
  const meta = parseJsonObject(row.payment_metadata);
  for (const candidate of [row.invoice_id, meta.invoice_id, meta.dispute_invoice_id]) {
    if (candidate && invoiceMaps.byId.has(String(candidate))) {
      return invoiceMaps.byId.get(String(candidate));
    }
  }
  if (row.payment_pi && invoiceMaps.byPi.has(String(row.payment_pi))) {
    return invoiceMaps.byPi.get(String(row.payment_pi));
  }
  return null;
}

function buildOutflowGlEntry(row, invoiceMaps) {
  const amountCents = dollarsToCents(row.amount);
  const entryDate = timestampToEtDate(row.created_at_stripe);
  if (!entryDate || !amountCents) return null;

  const linkedInv = resolveOutflowLinkedInvoice(row, invoiceMaps);
  const absCents = Math.abs(amountCents);
  const taxCents = computeProratedRefundTaxCents(absCents, linkedInv, row.payment_amount);
  const txnKey = row.stripe_txn_id || row.id;
  const isCommercial = isCommercialProperty(linkedInv?.property_type || row.property_type);
  const common = {
    subtotalCents: absCents - taxCents,
    taxCents,
    method: 'stripe',
    customerId: row.customer_id || row.payment_customer_id || null,
    invoiceId: linkedInv?.id || null,
    serviceLine: isCommercial ? 'commercial' : (linkedInv?.service_type || null),
    reference: txnKey,
    reason: row.description
      ? String(row.description).slice(0, 300)
      : `Stripe ${row.reporting_category || row.type || 'refund'}`,
  };

  if (amountCents < 0) {
    return rules.buildRefundEntry({
      ...common,
      refundId: txnKey,
      idempotencyKey: `refund:spt:${txnKey}`,
      refundDate: entryDate,
    });
  }
  return rules.buildRefundReversalEntry({
    ...common,
    txnId: txnKey,
    idempotencyKey: `refund-reversal:spt:${txnKey}`,
    reversalDate: entryDate,
  });
}

async function syncStripeRefundsAndOutflows(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('stripe_payout_transactions'))) return;
  const rows = await outflowTransactionsQuery(conn, from, to)
    .leftJoin('customers as c', conn.raw('c.id = COALESCE(spt.customer_id, lp.customer_id)'))
    .select(
      'spt.id', 'spt.stripe_txn_id', 'spt.type', 'spt.reporting_category',
      'spt.amount', 'spt.description', 'spt.customer_id', 'spt.invoice_id', 'spt.payment_id',
      'spt.created_at_stripe',
      'lp.customer_id as payment_customer_id', 'lp.amount as payment_amount',
      'lp.metadata as payment_metadata', 'lp.stripe_payment_intent_id as payment_pi',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.property_type',
    );

  const nonTestRows = rows.filter((r) => !isTestCustomerRow({
    ...r,
    customer_id: r.customer_id || r.payment_customer_id,
  }));
  const { ids, pis } = collectOutflowInvoiceRefs(nonTestRows);
  const invoiceMaps = await loadInvoicesForLinks(conn, ids, pis);

  for (const row of nonTestRows) {
    const entry = buildOutflowGlEntry(row, invoiceMaps);
    if (!entry) continue;
    await postOrPreview(entry, ctx, 'refunds');
  }
}

async function syncStripeFees(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('stripe_payout_transactions'))) return;
  const rows = await conn('stripe_payout_transactions as spt')
    .leftJoin('payments as lp', 'lp.id', 'spt.payment_id')
    .leftJoin('customers as c', conn.raw('c.id = COALESCE(spt.customer_id, lp.customer_id)'))
    .where('spt.fee', '<>', 0)
    .whereRaw(
      "DATE(spt.created_at_stripe AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date",
      [from, to],
    )
    .select(
      'spt.id', 'spt.stripe_txn_id', 'spt.fee', 'spt.description',
      'spt.customer_id', 'spt.invoice_id', 'spt.created_at_stripe',
      'lp.customer_id as payment_customer_id',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone',
    );

  for (const row of rows) {
    const customerId = row.customer_id || row.payment_customer_id || null;
    if (isTestCustomerRow({ ...row, customer_id: customerId })) continue;
    const feeDate = timestampToEtDate(row.created_at_stripe);
    const feeCents = dollarsToCents(row.fee);
    if (!feeDate || !feeCents) continue;

    const txnKey = row.stripe_txn_id || row.id;
    const entry = rules.buildStripeFeeEntry({
      txnId: txnKey,
      feeDate,
      feeCents,
      customerId,
      invoiceId: row.invoice_id || null,
      reference: txnKey,
      memo: row.description ? `Stripe fee — ${String(row.description).slice(0, 200)}` : null,
    });
    await postOrPreview(entry, ctx, 'stripe_fees');
  }
}

async function syncStripePayouts(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('stripe_payouts'))) return;
  const rows = await conn('stripe_payouts')
    .where({ status: 'paid' })
    .whereRaw("DATE(arrival_date AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to])
    .select('id', 'stripe_payout_id', 'amount', 'arrival_date');

  for (const p of rows) {
    const arrivalDate = timestampToEtDate(p.arrival_date);
    const amountCents = dollarsToCents(p.amount);
    if (!arrivalDate || !amountCents || amountCents <= 0) continue;

    const entry = rules.buildStripePayoutEntry({
      payoutId: p.id,
      arrivalDate,
      amountCents,
      reference: p.stripe_payout_id || p.id,
    });
    await postOrPreview(entry, ctx, 'stripe_payouts');
  }
}

async function loadVendorLookup(conn) {
  const vendors = await conn('gl_vendors')
    .where({ active: true })
    .select('id', 'display_name', 'legal_name', 'default_account_id', 'is_1099_eligible');
  const byDisplay = new Map();
  const legalCounts = new Map();
  const byLegal = new Map();

  for (const v of vendors) {
    const dKey = normalizeVendorName(v.display_name);
    if (dKey) byDisplay.set(dKey, v);
    const lKey = normalizeVendorName(v.legal_name);
    if (lKey) {
      legalCounts.set(lKey, (legalCounts.get(lKey) || 0) + 1);
      byLegal.set(lKey, v);
    }
  }
  for (const [lKey, count] of legalCounts.entries()) {
    if (count > 1) byLegal.delete(lKey);
  }
  return {
    match(vendorName) {
      const k = normalizeVendorName(vendorName);
      if (!k) return null;
      return byDisplay.get(k) || byLegal.get(k) || null;
    },
  };
}

function buildExpenseSplits(exp, mapped, matchedVendor, amountCents) {
  const dedCents = exp.tax_deductible_amount != null ? dollarsToCents(exp.tax_deductible_amount) : amountCents;
  if (mapped && mapped.schedule_c_line !== '24b' && dedCents != null && dedCents > 0 && dedCents < amountCents) {
    return [
      { accountId: mapped.id, amountCents: dedCents, scheduledServiceId: exp.scheduled_service_id },
      { accountCode: SYSTEM_CODES.OWNER_DRAWS, amountCents: amountCents - dedCents, memo: 'Personal share' },
    ];
  }
  const resolvedAccountId = mapped?.id || matchedVendor?.default_account_id || null;
  return [{
    accountId: resolvedAccountId,
    accountCode: resolvedAccountId ? null : SYSTEM_CODES.OPEX_UNCATEGORIZED,
    amountCents,
    scheduledServiceId: exp.scheduled_service_id,
  }];
}

async function syncExpenses(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('expenses'))) return;
  const [glAccounts, vendorLookup] = await Promise.all([
    conn('gl_accounts')
      .whereNotNull('expense_category_id')
      .select('id', 'code', 'expense_category_id', 'schedule_c_line'),
    loadVendorLookup(conn),
  ]);
  const glByCatId = new Map(glAccounts.map((a) => [a.expense_category_id, a]));

  const rows = await conn('expenses as e')
    .leftJoin('expense_categories as c', 'c.id', 'e.category_id')
    .whereBetween('e.expense_date', [from, to])
    .whereRaw("COALESCE(c.name, '') <> 'Payroll (counted from pay runs)'")
    .whereRaw("COALESCE(c.irs_line, '') NOT IN ('13', '30')")
    .select(
      'e.id', 'e.category_id', 'e.description', 'e.amount', 'e.tax_deductible_amount',
      conn.raw('e.expense_date::text as expense_date'), 'e.vendor_name', 'e.payment_method',
      'e.scheduled_service_id', 'c.name as category_name',
    );

  const unmatchedContractors = new Map();
  for (const exp of rows) {
    const entryDate = dateCellText(exp.expense_date);
    const amountCents = dollarsToCents(exp.amount);
    if (!entryDate || !amountCents || amountCents <= 0) continue;

    const mapped = exp.category_id ? glByCatId.get(exp.category_id) : null;
    const matchedVendor = vendorLookup.match(exp.vendor_name);
    if (exp.vendor_name && !matchedVendor) {
      ctx.stats.expenses.unmatched_vendors += 1;
      const isContractorCat = mapped?.code === SYSTEM_CODES.COGS_SUBCONTRACTORS
        || /contract|subcontract|1099/i.test(String(exp.category_name || ''));
      if (isContractorCat) {
        const key = normalizeVendorName(exp.vendor_name);
        const prev = unmatchedContractors.get(key) || { vendor_name: String(exp.vendor_name).trim(), count: 0, total_cents: 0 };
        prev.count += 1;
        prev.total_cents += amountCents;
        unmatchedContractors.set(key, prev);
      }
    }

    const entry = rules.buildExpenseEntry({
      sourceType: 'expense',
      sourceId: exp.id,
      entryDate,
      paymentAccountCode: paymentAccountCodeForExpense(exp.payment_method),
      splits: buildExpenseSplits(exp, mapped, matchedVendor, amountCents),
      vendorId: matchedVendor ? matchedVendor.id : null,
      memo: [exp.vendor_name, exp.description].filter(Boolean).join(' — ').slice(0, 500) || 'Expense',
    });
    await postOrPreview(entry, ctx, 'expenses');
  }

  ctx.stats.expenses.unmatched_contractor_vendors = Array.from(unmatchedContractors.values());
}

function intCents(v) {
  return Math.trunc(Number(v) || 0);
}

function summarizePayrollChecks(checks) {
  const totals = {
    fieldGrossCents: 0,
    adminGrossCents: 0,
    fieldEmployerTaxCents: 0,
    adminEmployerTaxCents: 0,
    employeeTaxWithheldCents: 0,
    employeeSimpleDeferralCents: 0,
    employerSimpleCents: 0,
    employerHsaCents: 0,
    netPayCents: 0,
  };
  for (const c of checks) {
    const gross = intCents(c.gross_cents);
    const erTax = intCents(c.employer_social_security_cents) + intCents(c.employer_medicare_cents)
      + intCents(c.futa_cents) + intCents(c.fl_reemployment_cents);
    if (String(c.role || '').toLowerCase() === 'admin') {
      totals.adminGrossCents += gross;
      totals.adminEmployerTaxCents += erTax;
    } else {
      totals.fieldGrossCents += gross;
      totals.fieldEmployerTaxCents += erTax;
    }
    totals.employeeTaxWithheldCents += intCents(c.federal_income_tax_cents) + intCents(c.social_security_cents)
      + intCents(c.medicare_cents) + intCents(c.additional_medicare_cents);
    totals.employeeSimpleDeferralCents += intCents(c.simple_deferral_cents);
    totals.employerSimpleCents += intCents(c.simple_employer_cents);
    totals.employerHsaCents += intCents(c.hsa_employer_cents);
    totals.netPayCents += intCents(c.net_cents);
  }
  return totals;
}

async function syncPayrollRuns(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('payroll_runs')) || !(await conn.schema.hasTable('payroll_checks'))) return;

  const runs = await conn('payroll_runs')
    .where({ status: 'finalized' })
    .whereBetween('pay_date', [from, to])
    .select(
      'id',
      conn.raw('week_start::text as week_start'),
      conn.raw('pay_date::text as pay_date'),
    );

  for (const run of runs) {
    const checks = await conn('payroll_checks as pc')
      .leftJoin('technicians as t', 't.id', 'pc.technician_id')
      .where('pc.run_id', run.id)
      .where('pc.status', 'finalized')
      .select('pc.*', 't.role');

    const totals = summarizePayrollChecks(checks);
    const totalDebits = totals.fieldGrossCents + totals.adminGrossCents + totals.employerSimpleCents + totals.employerHsaCents;
    if (totalDebits <= 0) continue;

    const entry = rules.buildPayrollRunEntry({
      runId: run.id,
      payDate: dateCellText(run.pay_date),
      weekLabel: `Week of ${dateCellText(run.week_start)}`,
      ...totals,
    });
    await postOrPreview(entry, ctx, 'payroll_runs');
  }

  // Reconcile previously booked payroll runs that have since been voided.
  const voidedBooked = await conn('payroll_runs as pr')
    .join('gl_journal_entries as e', conn.raw("e.idempotency_key = 'payroll-run:' || pr.id::text"))
    .where('pr.status', 'voided')
    .where('e.status', 'posted')
    .whereNull('e.reversed_by_entry_id')
    .where((q) => {
      q.whereBetween('pr.pay_date', [from, to])
        .orWhereRaw("pr.voided_at IS NOT NULL AND DATE(pr.voided_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
    })
    .select(
      'e.id',
      'e.reversed_by_entry_id',
      'pr.id as run_id',
      conn.raw('pr.pay_date::text as pay_date'),
      'pr.voided_at',
      'pr.void_reason',
    );

  for (const row of voidedBooked) {
    const reversalDate = timestampToEtDate(row.voided_at) || dateCellText(row.pay_date);
    const reason = row.void_reason
      ? `Payroll run voided: ${String(row.void_reason).slice(0, 220)}`
      : 'Payroll run voided';
    await reverseOrPreview(row, reversalDate, reason, ctx, 'payroll_runs');
  }
}

async function syncSubledgersToGl({ fromDate = null, toDate = null, dryRun = false, actorId = null, requestMeta = {}, conn = db } = {}) {
  const today = etDateString(new Date());
  const from = assertValidDate(fromDate || `${today.slice(0, 4)}-01-01`, 'fromDate');
  const to = assertValidDate(toDate || today, 'toDate');
  await ensureSystemAccounts(conn);
  const caches = await loadSyncCaches(conn);

  const makeBucket = (extra = {}) => ({ posted: 0, skipped: 0, would_post: 0, errors: [], ...extra });
  const stats = {
    from,
    to,
    dry_run: Boolean(dryRun),
    invoices: makeBucket(),
    deposits: makeBucket(),
    payments: makeBucket(),
    refunds: makeBucket(),
    stripe_fees: makeBucket(),
    stripe_payouts: makeBucket(),
    expenses: makeBucket({ unmatched_vendors: 0, unmatched_contractor_vendors: [] }),
    payroll_runs: makeBucket({ reversed: 0, would_reverse: 0 }),
  };

  const ctx = { dryRun: Boolean(dryRun), actorId, requestMeta, stats, conn, caches };
  await syncInvoices(conn, from, to, ctx);
  await syncEstimateDeposits(conn, from, to, ctx);
  await syncPayments(conn, from, to, ctx);
  await syncStripeRefundsAndOutflows(conn, from, to, ctx);
  await syncStripeFees(conn, from, to, ctx);
  await syncStripePayouts(conn, from, to, ctx);
  await syncExpenses(conn, from, to, ctx);
  await syncPayrollRuns(conn, from, to, ctx);

  return stats;
}

module.exports = {
  syncSubledgersToGl,
  extractAppliedDepositCents,
  extractSurchargeCents,
  computeProratedRefundTaxCents,
};
