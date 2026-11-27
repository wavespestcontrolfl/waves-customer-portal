/**
 * Idempotent Subledger-to-GL Sync Bridge.
 *
 * Reads Waves' operational tables (invoices, estimate_deposits, payments,
 * paid-Stripe-invoice gaps & refunded gap markers, stripe_payout_transactions
 * outflows/deposit refunds & fees, manual refunds by refund date, stripe_payouts,
 * expenses, and finalized/voided payroll_runs) for a calendar date range and
 * posts balanced Journal Entries via posting-rules.js + ledger.js.
 *
 * Key guarantees:
 * - PostgreSQL DATE columns are selected as ISO text ('YYYY-MM-DD') and NEVER shifted;
 *   Stripe payout arrival_date uses UTC calendar day matching ARRIVAL_DAY_SQL; Eastern
 *   conversion applies only to event TIMESTAMPTZ columns.
 * - All reads and writes run through the injected `conn` (preserving caller transactions).
 * - Dry runs perform ZERO database writes while executing the exact same validation,
 *   idempotency, account-active, and period-lock checks as live runs.
 * - Source edits, prepay-coverage conversions, reductions to $0, voids/deletions,
 *   undone manual payments, and late payment rows after gap recovery all reconcile
 *   through immutable dated adjustments or reversals under entity-level advisory locks.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const { etDateString } = require('../../utils/datetime-et');
const { isInternalTestContact } = require('../internal-test-customers');
const { invoicePrincipalCents, invoiceDepositCreditCents } = require('../invoice-helpers');
const { outflowTransactionsQuery } = require('../pnl-report');
const { bookedSharePct } = require('../tax-shared-bills');
const {
  SYSTEM_CODES,
  findMissingSystemAccountCodes,
  dollarsToCents,
  dateCellText,
} = require('./coa-seed');
const {
  assertValidDate,
  validateJournalEntryInput,
  postJournalEntry,
  reverseJournalEntry,
  linkJournalEntryVendor,
} = require('./ledger');
const rules = require('./posting-rules');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BANK_DIRECT_TENDERS = new Set(['zelle', 'us_bank_account', 'ach', 'ach_direct', 'bank_transfer', 'wire', 'direct_deposit']);
const UNDEPOSITED_TENDERS = new Set(['cash', 'check', 'cheque', 'paper_check', 'money_order']);
const ARRIVAL_DAY_SQL = "(arrival_date AT TIME ZONE 'UTC')::date";
const MANUAL_PAYMENT_RECORDED_ACTION = 'invoice.manual_payment_recorded';
const MANUAL_PAYMENT_UNDONE_ACTION = 'invoice.manual_payment_undone';

function safeNonNegCents(val) {
  return Math.max(0, dollarsToCents(val || 0) || 0);
}

function billedInvoicePrincipalCents(inv) {
  if (!inv) return 0;
  if (inv.subtotal != null) return invoicePrincipalCents(inv);
  return safeNonNegCents(inv.total);
}

function timestampToEtDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return etDateString(d);
}

function timestampToUtcDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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

function extractAppliedDepositCents(lineItems) {
  return invoiceDepositCreditCents({ line_items: lineItems });
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

/**
 * Resolve tender across all durable payment-method sources:
 * Stripe processor/PI/charge -> 'stripe' (1050 Stripe Clearing);
 * otherwise payments.payment_method_type -> metadata.payment_method ->
 * manual-payment audit marker method -> linked invoice.payment_method.
 * Cash, checks, and unrecorded manual tenders route to Undeposited Funds (1060).
 */
function resolvePaymentMethod(pay, linkedInv = null, auditMarker = null) {
  const proc = String(pay.processor || '').toLowerCase();
  if (proc === 'stripe' || pay.stripe_payment_intent_id || pay.stripe_charge_id) return 'stripe';
  const meta = parseJsonObject(pay.metadata);
  const raw = String(
    pay.payment_method_type
    || meta.payment_method
    || auditMarker?.method
    || linkedInv?.payment_method
    || '',
  ).trim().toLowerCase();
  if (raw === 'zelle') return 'zelle';
  if (BANK_DIRECT_TENDERS.has(raw)) return 'ach_direct';
  if (raw === 'cash') return 'cash';
  if (UNDEPOSITED_TENDERS.has(raw)) return 'check';
  return 'check';
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
  const invTaxCents = safeNonNegCents(linkedInvoice.tax_amount);
  if (invTaxCents <= 0) return 0;
  const payGrossCents = paymentAmountDollars != null ? safeNonNegCents(paymentAmountDollars) : 0;
  const invTotalCents = billedInvoicePrincipalCents(linkedInvoice);
  const denom = Math.max(payGrossCents, invTotalCents);
  if (denom <= 0) return 0;
  if (refundTotalCents >= denom) return Math.min(invTaxCents, refundTotalCents);
  const raw = Math.round((invTaxCents * refundTotalCents) / denom);
  return Math.max(0, Math.min(raw, invTaxCents, refundTotalCents));
}

/**
 * Pure: allocate sales-tax reversal incrementally from cumulative refunded gross so
 * repeated partial refunds never reverse more tax than the invoice accrued.
 */
function computeIncrementalRefundTaxCents(priorGrossCents, priorTaxCents, signedRefundDeltaCents, linkedInvoice, paymentAmountDollars = null) {
  const delta = Math.trunc(Number(signedRefundDeltaCents) || 0);
  if (delta === 0 || !linkedInvoice) return 0;
  const priorGross = Math.max(0, Math.trunc(Number(priorGrossCents) || 0));
  const priorTax = Math.max(0, Math.trunc(Number(priorTaxCents) || 0));

  if (delta > 0) {
    const targetCumTax = computeProratedRefundTaxCents(priorGross + delta, linkedInvoice, paymentAmountDollars);
    return Math.max(0, Math.min(delta, targetCumTax - priorTax));
  }
  const absRev = Math.abs(delta);
  const targetCumTax = computeProratedRefundTaxCents(Math.max(0, priorGross - absRev), linkedInvoice, paymentAmountDollars);
  return Math.max(0, Math.min(absRev, priorTax - targetCumTax));
}

function allocateStatementPrincipalAcrossInvoices(principalCents, childInvoices) {
  const valid = (childInvoices || [])
    .map((inv) => {
      const due = Math.max(0, billedInvoicePrincipalCents(inv) - safeNonNegCents(inv.credit_applied));
      const isCommercial = isCommercialProperty(inv.property_type);
      return {
        invoiceId: inv.id,
        customerId: inv.customer_id || null,
        serviceLine: isCommercial ? 'commercial' : (inv.service_type || 'pest'),
        due,
      };
    })
    .filter((c) => c.due > 0);
  if (!valid.length || principalCents <= 0) return null;

  const totalDue = valid.reduce((s, c) => s + c.due, 0);
  let remaining = principalCents;
  const allocations = [];
  for (let i = 0; i < valid.length; i += 1) {
    const c = valid[i];
    const part = i === valid.length - 1
      ? remaining
      : Math.min(remaining, Math.round((principalCents * c.due) / totalDue));
    remaining -= part;
    if (part > 0) {
      allocations.push({
        invoiceId: c.invoiceId,
        customerId: c.customerId,
        serviceLine: c.serviceLine,
        amountCents: part,
      });
    }
  }
  return allocations.length ? allocations : null;
}

function splitDepositRefundCents(absCents, deposit) {
  const faceCents = safeNonNegCents(deposit.amount);
  const surchargeTotal = safeNonNegCents(deposit.card_surcharge);
  const gross = faceCents + surchargeTotal;
  if (gross <= 0 || surchargeTotal <= 0) {
    return { principalCents: absCents, surchargeCents: 0 };
  }
  if (absCents >= gross) {
    return { principalCents: faceCents, surchargeCents: absCents - faceCents };
  }
  const surchargeCents = Math.min(surchargeTotal, Math.round((absCents * surchargeTotal) / gross));
  return { principalCents: absCents - surchargeCents, surchargeCents };
}

function mapLinesToNetByCode(lines, accountsById = null) {
  const map = new Map();
  for (const l of lines || []) {
    const code = l.accountCode || l.account_code
      || (accountsById && l.accountId ? accountsById.get(String(l.accountId).toLowerCase())?.code : null);
    if (!code) continue;
    const net = (l.debitCents || 0) - (l.creditCents || 0);
    map.set(code, (map.get(code) || 0) + net);
  }
  return map;
}

function buildDeltaEntry({
  sourceType,
  sourceId,
  keyPrefix,
  revisionSeq,
  desiredLines,
  bookedByCode,
  adjustmentDate,
  basisScope,
  reference,
  memo,
  lineMeta = {},
  accountsById = null,
}) {
  const desiredByCode = mapLinesToNetByCode(desiredLines || [], accountsById);
  const allCodes = [...new Set([...desiredByCode.keys(), ...bookedByCode.keys()])].sort();
  const deltaLines = [];
  for (const code of allCodes) {
    const delta = (desiredByCode.get(code) || 0) - (bookedByCode.get(code) || 0);
    if (delta === 0) continue;
    deltaLines.push({
      accountCode: code,
      debitCents: delta > 0 ? delta : 0,
      creditCents: delta < 0 ? Math.abs(delta) : 0,
      ...lineMeta,
      memo: 'Source update adjustment',
    });
  }
  if (deltaLines.length < 2) return null;

  const stateSig = allCodes.map((c) => `${c}:${desiredByCode.get(c) || 0}`).join('|');
  const hash = crypto.createHash('sha256').update(stateSig).digest('hex').slice(0, 12);
  return {
    entryDate: adjustmentDate,
    entryType: 'adjusting',
    basisScope,
    sourceType,
    sourceId: String(sourceId),
    idempotencyKey: `${keyPrefix}:${sourceId}:seq-${revisionSeq}:${hash}`,
    reference: reference || String(sourceId),
    memo,
    lines: deltaLines,
  };
}

function buildInvoiceDeltaEntry(inv, desiredLines, bookedByCode, adjustmentDate, revisionSeq = 1) {
  return buildDeltaEntry({
    sourceType: 'invoice',
    sourceId: inv.id,
    keyPrefix: 'invoice-adj',
    revisionSeq,
    desiredLines,
    bookedByCode,
    adjustmentDate,
    basisScope: 'accrual_only',
    reference: inv.invoice_number || String(inv.id),
    memo: `Invoice adjustment ${inv.invoice_number || inv.id}`,
    lineMeta: { customerId: inv.customer_id || null, invoiceRef: String(inv.id) },
  });
}

// ── Shared Execution & Dry-Run Helpers ───────────────────────────────────────

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

async function previewEntry(entryInput, ctx, bucket, { isAdjustment = false } = {}) {
  let normalized;
  try {
    normalized = validateJournalEntryInput(entryInput);
  } catch (err) {
    ctx.stats[bucket].errors.push({ idempotencyKey: entryInput?.idempotencyKey || null, message: err.message });
    return false;
  }

  const key = normalized.idempotency_key;
  if (key) {
    if (ctx.caches.seenPreviewKeys.has(key)) {
      ctx.stats[bucket].skipped += 1;
      return false;
    }
    const existing = await ctx.conn('gl_journal_entries').where({ idempotency_key: key }).first('id');
    if (existing) {
      ctx.stats[bucket].skipped += 1;
      return false;
    }
  }

  const periodMonth = normalized.entry_date.slice(0, 7);
  if (ctx.caches.lockedMonths.has(periodMonth)) {
    ctx.stats[bucket].errors.push({
      idempotencyKey: key,
      message: `Accounting period ${periodMonth} is locked. Post an adjusting or reversing entry in an open period.`,
    });
    return false;
  }

  const acctErr = validatePreviewAccounts(normalized.lines, ctx.caches);
  if (acctErr) {
    ctx.stats[bucket].errors.push({ idempotencyKey: key, message: acctErr });
    return false;
  }

  if (key) ctx.caches.seenPreviewKeys.add(key);
  if (isAdjustment) ctx.stats[bucket].would_adjust += 1;
  else ctx.stats[bucket].would_post += 1;
  return true;
}

async function postOrPreview(entryInput, ctx, bucket, { isAdjustment = false, connOverride = null } = {}) {
  if (ctx.dryRun) {
    return previewEntry(entryInput, ctx, bucket, { isAdjustment });
  }
  try {
    const res = await postJournalEntry(entryInput, {
      conn: connOverride || ctx.conn,
      actorId: ctx.actorId,
      requestMeta: ctx.requestMeta,
    });
    if (res.created) {
      if (isAdjustment) ctx.stats[bucket].adjusted += 1;
      else ctx.stats[bucket].posted += 1;
      return true;
    }
    ctx.stats[bucket].skipped += 1;
    return false;
  } catch (err) {
    ctx.stats[bucket].errors.push({ idempotencyKey: entryInput.idempotencyKey, message: err.message });
    return false;
  }
}

async function reverseOrPreview(origEntry, reversalDate, reason, ctx, bucket, { connOverride = null } = {}) {
  const revKey = `reversal:${origEntry.id}`;
  if (ctx.dryRun) {
    if (origEntry.reversed_by_entry_id || ctx.caches.seenPreviewKeys.has(revKey)) {
      ctx.stats[bucket].skipped += 1;
      return false;
    }
    const existingRev = await ctx.conn('gl_journal_entries').where({ idempotency_key: revKey }).first('id');
    if (existingRev) {
      ctx.stats[bucket].skipped += 1;
      return false;
    }
    const periodMonth = reversalDate.slice(0, 7);
    if (ctx.caches.lockedMonths.has(periodMonth)) {
      ctx.stats[bucket].errors.push({
        idempotencyKey: revKey,
        message: `Accounting period ${periodMonth} is locked. Reopen or reverse in an open period.`,
      });
      return false;
    }
    ctx.caches.seenPreviewKeys.add(revKey);
    ctx.stats[bucket].would_reverse += 1;
    return true;
  }

  try {
    await reverseJournalEntry(origEntry.id, {
      reversalDate,
      reason,
      actorId: ctx.actorId,
      requestMeta: ctx.requestMeta,
      conn: connOverride || ctx.conn,
    });
    ctx.stats[bucket].reversed += 1;
    return true;
  } catch (err) {
    if (err && err.code === 'ALREADY_REVERSED') ctx.stats[bucket].skipped += 1;
    else ctx.stats[bucket].errors.push({ idempotencyKey: revKey, message: err.message });
    return false;
  }
}

async function withEntitySyncLock(conn, lockKey, fn) {
  const run = async (trx) => {
    if (typeof trx.raw === 'function') {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [lockKey]);
    }
    return fn(trx);
  };
  if (conn.isTransaction || typeof conn.transaction !== 'function') return run(conn);
  return conn.transaction(run);
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
      'i.id', 'i.stripe_payment_intent_id', 'i.service_type', 'i.payment_method', 'i.total', 'i.tax_amount',
      'i.subtotal', 'i.discount_amount', 'i.credit_applied', 'i.line_items', 'c.property_type',
    );
  for (const r of rows) {
    byId.set(String(r.id), r);
    if (r.stripe_payment_intent_id) byPi.set(String(r.stripe_payment_intent_id), r);
  }
  return { byId, byPi };
}

// ── 1. Invoices (Initial Post + Coverage Conversion + Zero/Edit Deltas + Voids) ─

function buildCoveredPrepayVisitPayload(inv, issueDate, serviceLine, isCommercial, taxCents) {
  const rawPreTax = (dollarsToCents(inv.subtotal || 0) || 0) - (dollarsToCents(inv.discount_amount || 0) || 0);
  const amountCents = rawPreTax > 0 ? rawPreTax : Math.max(0, billedInvoicePrincipalCents(inv) - taxCents);
  if (amountCents <= 0) return null;
  const revCode = rules.revenueAccountCodeFor(serviceLine, isCommercial);
  const invoiceRef = String(inv.id);
  return {
    entryDate: issueDate,
    entryType: 'adjusting',
    basisScope: 'accrual_only',
    sourceType: 'invoice',
    sourceId: invoiceRef,
    idempotencyKey: `invoice:${inv.id}`,
    reference: inv.invoice_number || invoiceRef,
    memo: `Annual prepay covered visit ${inv.invoice_number || inv.id}`,
    lines: [
      { accountCode: SYSTEM_CODES.UNEARNED_REVENUE, debitCents: amountCents, creditCents: 0, customerId: inv.customer_id, serviceLine, invoiceRef },
      { accountCode: revCode, debitCents: 0, creditCents: amountCents, customerId: inv.customer_id, serviceLine, invoiceRef },
    ],
  };
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

  const principalCents = billedInvoicePrincipalCents(inv);
  const appliedDepositCents = invoiceDepositCreditCents(inv);
  const appliedCreditCents = Math.min(safeNonNegCents(inv.credit_applied), principalCents);
  const subtotalCents = Math.max(0, principalCents + appliedDepositCents - taxCents);
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

async function loadBookedInvoiceState(conn, invoiceId) {
  const rows = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where('e.status', 'posted')
    .whereNull('e.reversed_by_entry_id')
    .where((q) => {
      q.where({ 'e.source_type': 'invoice', 'e.source_id': String(invoiceId) })
        .orWhere({ 'e.source_type': 'unearned_recognition', 'e.source_id': `covered-inv:${invoiceId}` });
    })
    .select('e.id as entry_id', 'a.code', 'l.debit_cents', 'l.credit_cents');

  const bookedByCode = new Map();
  const entryIds = new Set();
  for (const r of rows) {
    entryIds.add(r.entry_id);
    const net = Number(r.debit_cents) - Number(r.credit_cents);
    bookedByCode.set(r.code, (bookedByCode.get(r.code) || 0) + net);
  }
  return { bookedByCode, entryCount: entryIds.size };
}

async function syncSingleInvoiceRow(inv, prepayInvoiceIds, ctx) {
  const desired = buildInvoiceGlPayload(inv, prepayInvoiceIds);
  const fallbackDate = dateCellText(inv.service_date)
    || timestampToEtDate(inv.sent_at)
    || timestampToEtDate(inv.created_at);
  const updatedDate = timestampToEtDate(inv.updated_at);
  const baseDate = desired?.entryDate || fallbackDate;
  const adjDate = updatedDate && baseDate && updatedDate >= baseDate ? updatedDate : baseDate;

  const reconcile = async (trx) => {
    const { bookedByCode, entryCount } = await loadBookedInvoiceState(trx, inv.id);
    if (entryCount === 0) {
      if (!desired) return;
      await postOrPreview(desired, ctx, 'invoices', { connOverride: trx });
      return;
    }

    if (!adjDate) return;
    const adjEntry = buildInvoiceDeltaEntry(inv, desired ? desired.lines : [], bookedByCode, adjDate, entryCount);
    if (!adjEntry) {
      ctx.stats.invoices.skipped += 1;
      return;
    }
    await postOrPreview(adjEntry, ctx, 'invoices', { isAdjustment: true, connOverride: trx });
  };

  if (ctx.dryRun) {
    await reconcile(ctx.conn);
  } else {
    await withEntitySyncLock(ctx.conn, `gl-sync-invoice:${inv.id}`, reconcile);
  }
}

async function reconcileVoidedInvoices(conn, from, to, ctx) {
  const voided = await conn('gl_journal_entries as e')
    .join('invoices as i', conn.raw("(e.source_type = 'invoice' AND e.source_id = i.id::text) OR (e.source_type = 'unearned_recognition' AND e.source_id = 'covered-inv:' || i.id::text)"))
    .where('e.status', 'posted')
    .whereNull('e.reversed_by_entry_id')
    .where((q) => q.whereIn('i.status', ['void', 'cancelled', 'canceled']).orWhereNotNull('i.archived_at'))
    .where((q) => {
      q.whereBetween('e.entry_date', [from, to])
        .orWhereRaw("DATE(COALESCE(i.archived_at, i.updated_at) AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
    })
    .select(
      'e.id', 'e.reversed_by_entry_id', conn.raw('e.entry_date::text as entry_date'),
      'i.invoice_number', 'i.status as invoice_status', 'i.archived_at', 'i.updated_at',
    );

  for (const row of voided) {
    const revDate = timestampToEtDate(row.archived_at || row.updated_at) || dateCellText(row.entry_date);
    const reason = `Invoice ${row.invoice_number || row.id} ${row.archived_at ? 'archived' : row.invoice_status}`;
    await reverseOrPreview(row, revDate, reason, ctx, 'invoices');
  }
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
    .where((q) => {
      q.whereRaw(
        "COALESCE(i.service_date, DATE(i.sent_at AT TIME ZONE 'America/New_York'), DATE(i.created_at AT TIME ZONE 'America/New_York')) BETWEEN ?::date AND ?::date",
        [from, to],
      ).orWhere((edited) => {
        edited.whereRaw("DATE(i.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to])
          .whereExists(function alreadyBooked() {
            this.select(conn.raw('1'))
              .from('gl_journal_entries as ge')
              .where('ge.status', 'posted')
              .whereNull('ge.reversed_by_entry_id')
              .where((sub) => {
                sub.whereRaw("ge.source_type = 'invoice' AND ge.source_id = i.id::text")
                  .orWhereRaw("ge.source_type = 'unearned_recognition' AND ge.source_id = 'covered-inv:' || i.id::text");
              });
          });
      });
    })
    .select(
      'i.id', 'i.invoice_number', 'i.customer_id', 'i.subtotal', 'i.discount_amount', 'i.tax_amount', 'i.total',
      'i.credit_applied', 'i.line_items', 'i.service_type', 'i.annual_prepay_term_id', 'i.annual_prepay_covered_term_id',
      conn.raw('i.service_date::text as service_date'), 'i.sent_at', 'i.created_at', 'i.updated_at',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.property_type',
    );

  for (const inv of rows) {
    if (isTestCustomerRow(inv)) continue;
    await syncSingleInvoiceRow(inv, prepayInvoiceIds, ctx);
  }

  await reconcileVoidedInvoices(conn, from, to, ctx);
}

// ── 2. Estimate Deposits ─────────────────────────────────────────────────────

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
    const surchargeCents = safeNonNegCents(dep.card_surcharge);
    if (!paymentDate || !faceCents || faceCents <= 0) continue;

    await postOrPreview(rules.buildPaymentEntry({
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
    }), ctx, 'deposits');
  }
}

// ── 3. Payments (Manual Audit Recovery, Statement Allocations, Undo & Gaps) ──

async function loadManualPaymentAuditMarkers(conn, paymentIds) {
  const byPaymentId = new Map();
  if (!paymentIds.length || !(await conn.schema.hasTable('audit_log'))) return byPaymentId;
  const rows = await conn('audit_log')
    .where({ action: MANUAL_PAYMENT_RECORDED_ACTION, resource_type: 'invoices' })
    .whereIn(conn.raw("metadata->>'paymentId'"), paymentIds.map(String))
    .select('resource_id as invoice_id', 'metadata');
  for (const r of rows) {
    const meta = parseJsonObject(r.metadata);
    if (meta.paymentId) {
      byPaymentId.set(String(meta.paymentId), {
        invoiceId: r.invoice_id || null,
        method: meta.method || null,
      });
    }
  }
  return byPaymentId;
}

function linkedInvoiceForPayment(pay, invoiceMaps, auditMarker = null) {
  const meta = parseJsonObject(pay.metadata);
  const candidates = [meta.invoice_id, meta.dispute_invoice_id, auditMarker?.invoiceId];
  for (const id of candidates) {
    if (id && invoiceMaps.byId.has(String(id))) return invoiceMaps.byId.get(String(id));
  }
  if (pay.stripe_payment_intent_id && invoiceMaps.byPi.has(String(pay.stripe_payment_intent_id))) {
    return invoiceMaps.byPi.get(String(pay.stripe_payment_intent_id));
  }
  return null;
}

function collectPaymentInvoiceRefs(rows, auditMarkers = new Map()) {
  const ids = [];
  const pis = [];
  const statementIds = [];
  for (const r of rows) {
    const meta = parseJsonObject(r.metadata);
    const marker = auditMarkers.get(String(r.id));
    if (meta.invoice_id) ids.push(meta.invoice_id);
    if (meta.dispute_invoice_id) ids.push(meta.dispute_invoice_id);
    if (marker?.invoiceId) ids.push(marker.invoiceId);
    if (r.stripe_payment_intent_id) pis.push(r.stripe_payment_intent_id);
    if (r.statement_id != null) statementIds.push(r.statement_id);
  }
  return { ids, pis, statementIds: [...new Set(statementIds)] };
}

async function loadStatementChildInvoices(conn, statementIds) {
  const byStatement = new Map();
  if (!statementIds.length || !(await conn.schema.hasTable('invoices'))) return byStatement;
  const rows = await conn('invoices as i')
    .leftJoin('customers as c', 'c.id', 'i.customer_id')
    .whereIn('i.payer_statement_id', statementIds)
    .whereNotIn('i.status', ['void', 'cancelled', 'canceled'])
    .whereNull('i.archived_at')
    .orderBy('i.created_at', 'asc')
    .select(
      'i.id', 'i.payer_statement_id', 'i.customer_id', 'i.subtotal', 'i.discount_amount',
      'i.tax_amount', 'i.total', 'i.credit_applied', 'i.line_items', 'i.service_type', 'c.property_type',
    );
  for (const r of rows) {
    const k = String(r.payer_statement_id);
    const list = byStatement.get(k) || [];
    list.push(r);
    byStatement.set(k, list);
  }
  return byStatement;
}

function resolvePaymentContext(pay, linkedInv, auditMarker, statementInvoicesByStmt) {
  const meta = parseJsonObject(pay.metadata);
  const method = resolvePaymentMethod(pay, linkedInv, auditMarker);
  const isDeposit = !linkedInv && !pay.statement_id && /deposit/i.test(String(meta.type || meta.source || ''));
  const isCommercial = isCommercialProperty(linkedInv?.property_type || pay.property_type);
  const serviceLine = isCommercial ? 'commercial' : (linkedInv?.service_type || null);
  const fallbackInvId = UUID_RE.test(String(meta.invoice_id || ''))
    ? meta.invoice_id
    : (UUID_RE.test(String(auditMarker?.invoiceId || '')) ? auditMarker.invoiceId : null);
  const stmtChildren = pay.statement_id != null ? statementInvoicesByStmt.get(String(pay.statement_id)) : null;
  return {
    method,
    isDeposit,
    serviceLine,
    invoiceId: linkedInv?.id || fallbackInvId,
    stmtChildren,
  };
}

function paymentLineSignature(lines) {
  return [...(lines || [])]
    .map((l) => [
      l.accountCode || l.account_code || '',
      Math.trunc(Number(l.debitCents ?? l.debit_cents) || 0),
      Math.trunc(Number(l.creditCents ?? l.credit_cents) || 0),
      String(l.invoiceRef ?? l.invoice_ref ?? ''),
    ].join(':'))
    .sort()
    .join('|');
}

async function findSupersedingGapEntry(conn, pay, invoiceId) {
  if (!pay.stripe_payment_intent_id && !invoiceId) return null;
  const gapEntry = await conn('gl_journal_entries')
    .where({ source_type: 'payment', status: 'posted' })
    .whereNull('reversed_by_entry_id')
    .where((q) => {
      if (invoiceId) q.orWhere('idempotency_key', `payment:gap:${invoiceId}`);
      if (pay.stripe_payment_intent_id) {
        q.orWhere((sub) => sub.where('reference', pay.stripe_payment_intent_id).where('idempotency_key', 'like', 'payment:gap:%'));
      }
    })
    .first('id', 'reversed_by_entry_id', conn.raw('entry_date::text as entry_date'));
  if (!gapEntry) return null;
  const gapLines = await conn('gl_journal_lines as l')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where('l.entry_id', gapEntry.id)
    .select('a.code as account_code', 'l.debit_cents', 'l.credit_cents', 'l.invoice_ref');
  return { ...gapEntry, lines: gapLines };
}

async function syncSinglePaymentRow(pay, invoiceMaps, auditMarkers, statementInvoicesByStmt, ctx) {
  const paymentDate = dateCellText(pay.payment_date) || timestampToEtDate(pay.created_at);
  const grossCents = dollarsToCents(pay.amount);
  if (!paymentDate || !grossCents || grossCents <= 0) return;

  const auditMarker = auditMarkers.get(String(pay.id)) || null;
  const linkedInv = linkedInvoiceForPayment(pay, invoiceMaps, auditMarker);
  const pCtx = resolvePaymentContext(pay, linkedInv, auditMarker, statementInvoicesByStmt);
  const surchargeCents = extractSurchargeCents(pay, grossCents);
  const principalCents = grossCents - surchargeCents;
  const arAllocations = pCtx.stmtChildren
    ? allocateStatementPrincipalAcrossInvoices(principalCents, pCtx.stmtChildren)
    : null;

  const entry = rules.buildPaymentEntry({
    paymentId: pay.id,
    paymentDate,
    grossCents,
    feeCents: 0,
    surchargeCents,
    method: pCtx.method,
    isDeposit: pCtx.isDeposit,
    invoiceId: arAllocations ? null : pCtx.invoiceId,
    arAllocations,
    customerId: pay.customer_id,
    serviceLine: pCtx.serviceLine,
    reference: pay.stripe_payment_intent_id || pay.id,
  });

  // Reconcile any prior Stripe gap receipt atomically so a late payments row never duplicates or orphans it.
  const applyPayment = async (trx) => {
    const priorGap = await findSupersedingGapEntry(trx, pay, pCtx.invoiceId);
    let reversedGap = false;
    if (priorGap) {
      if (paymentLineSignature(priorGap.lines) === paymentLineSignature(entry.lines)) {
        ctx.stats.payments.skipped += 1;
        return;
      }
      reversedGap = await reverseOrPreview(
        priorGap,
        paymentDate,
        `Superseded by settled payment ${pay.id}`,
        ctx,
        'payments',
        { connOverride: trx },
      );
      if (!reversedGap) return;
    }
    const posted = await postOrPreview(entry, ctx, 'payments', { connOverride: trx });
    if (reversedGap && !posted && !ctx.dryRun) {
      ctx.stats.payments.reversed = Math.max(0, ctx.stats.payments.reversed - 1);
      const rollbackErr = new Error('ABORT_GAP_REPLACEMENT');
      rollbackErr.code = 'ABORT_GAP_REPLACEMENT';
      throw rollbackErr;
    }
  };

  if (ctx.dryRun) {
    await applyPayment(ctx.conn);
  } else {
    try {
      await withEntitySyncLock(ctx.conn, `gl-sync-payment:${pay.stripe_payment_intent_id || pay.id}`, applyPayment);
    } catch (err) {
      if (err?.code !== 'ABORT_GAP_REPLACEMENT') throw err;
    }
  }
}

async function reconcileCanceledPayments(conn, from, to, ctx) {
  const canceled = await conn('gl_journal_entries as e')
    .join('payments as p', conn.raw("e.idempotency_key = 'payment:' || p.id::text"))
    .where('e.status', 'posted')
    .whereNull('e.reversed_by_entry_id')
    .whereIn('p.status', ['canceled', 'cancelled'])
    .where((q) => {
      q.whereBetween('p.payment_date', [from, to])
        .orWhereRaw(
          "DATE(COALESCE((p.metadata->'manualPaymentUndo'->>'at')::timestamptz, p.updated_at) AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date",
          [from, to],
        );
    })
    .select(
      'e.id', 'e.reversed_by_entry_id', conn.raw('e.entry_date::text as entry_date'),
      'p.id as payment_id', 'p.metadata', 'p.updated_at',
    );
  if (!canceled.length) return;

  const undoAuditByPayment = new Map();
  if (await conn.schema.hasTable('audit_log')) {
    const audits = await conn('audit_log')
      .where({ action: MANUAL_PAYMENT_UNDONE_ACTION })
      .whereIn(conn.raw("metadata->>'paymentId'"), canceled.map((r) => String(r.payment_id)))
      .select('created_at', 'metadata');
    for (const a of audits) {
      const m = parseJsonObject(a.metadata);
      if (m.paymentId) undoAuditByPayment.set(String(m.paymentId), { at: m.at || a.created_at, reason: m.reason || null });
    }
  }

  for (const row of canceled) {
    const meta = parseJsonObject(row.metadata);
    const undo = meta.manualPaymentUndo || undoAuditByPayment.get(String(row.payment_id)) || {};
    const revDate = timestampToEtDate(undo.at || row.updated_at) || dateCellText(row.entry_date);
    const reason = undo.reason
      ? `Manual payment undone: ${String(undo.reason).slice(0, 220)}`
      : 'Payment canceled/undone';
    await reverseOrPreview(row, revDate, reason, ctx, 'payments');
  }
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
      'p.status', 'p.processor', 'p.payment_method_type',
      'p.stripe_payment_intent_id', 'p.stripe_charge_id', 'p.statement_id', 'p.payer_id',
      'p.metadata', conn.raw('p.payment_date::text as payment_date'), 'p.created_at',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.property_type',
    );

  const nonTestRows = rows.filter((r) => !isTestCustomerRow(r));
  const manualIds = nonTestRows
    .filter((r) => !(String(r.processor || '').toLowerCase() === 'stripe' || r.stripe_payment_intent_id || r.stripe_charge_id))
    .map((r) => r.id);
  const auditMarkers = await loadManualPaymentAuditMarkers(conn, manualIds);
  const { ids, pis, statementIds } = collectPaymentInvoiceRefs(nonTestRows, auditMarkers);
  const [invoiceMaps, stmtMap] = await Promise.all([
    loadInvoicesForLinks(conn, ids, pis),
    loadStatementChildInvoices(conn, statementIds),
  ]);

  for (const pay of nonTestRows) {
    await syncSinglePaymentRow(pay, invoiceMaps, auditMarkers, stmtMap, ctx);
  }

  await reconcileCanceledPayments(conn, from, to, ctx);
}

async function hasExistingPaymentEntryForPi(conn, piId) {
  if (!piId) return false;
  const existing = await conn('gl_journal_entries')
    .where({ source_type: 'payment', reference: piId, status: 'posted' })
    .whereNull('reversed_by_entry_id')
    .first('id');
  return Boolean(existing);
}

async function syncStripeInvoiceGapPayments(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('invoices'))) return;
  const hasPayments = await conn.schema.hasTable('payments');

  let q = conn('invoices as i')
    .leftJoin('customers as c', 'c.id', 'i.customer_id')
    .where({ 'i.status': 'paid', 'i.processor': 'stripe' })
    .whereNotNull('i.stripe_payment_intent_id')
    .whereNull('i.archived_at')
    .whereRaw("i.paid_at >= ?::timestamp AT TIME ZONE 'America/New_York'", [`${from}T00:00:00`])
    .whereRaw("i.paid_at < (?::timestamp + INTERVAL '1 day') AT TIME ZONE 'America/New_York'", [`${to}T00:00:00`]);

  if (hasPayments) {
    q = q.whereNotExists(function noGenuinePayment() {
      this.select(conn.raw('1'))
        .from('payments as p')
        .whereRaw('p.stripe_payment_intent_id = i.stripe_payment_intent_id')
        .whereRaw("COALESCE(p.metadata->>'source', '') <> 'invoice_refund'");
    });
  }

  const gapInvoices = await q.select(
    'i.id', 'i.customer_id', 'i.subtotal', 'i.discount_amount', 'i.tax_amount', 'i.total',
    'i.credit_applied', 'i.line_items', 'i.service_type', 'i.stripe_payment_intent_id', 'i.paid_at',
    'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.property_type',
  );

  for (const inv of gapInvoices) {
    if (isTestCustomerRow(inv)) continue;
    if (await hasExistingPaymentEntryForPi(conn, inv.stripe_payment_intent_id)) {
      ctx.stats.payments.skipped += 1;
      continue;
    }
    const grossCents = Math.max(0, billedInvoicePrincipalCents(inv) - safeNonNegCents(inv.credit_applied));
    const paymentDate = timestampToEtDate(inv.paid_at);
    if (!paymentDate || grossCents <= 0) continue;

    const serviceLine = isCommercialProperty(inv.property_type) ? 'commercial' : (inv.service_type || 'pest');
    await postOrPreview(rules.buildPaymentEntry({
      paymentId: `gap:${inv.id}`,
      idempotencyKey: `payment:gap:${inv.id}`,
      paymentDate,
      grossCents,
      feeCents: 0,
      method: 'stripe',
      invoiceId: inv.id,
      customerId: inv.customer_id,
      serviceLine,
      reference: inv.stripe_payment_intent_id,
      memo: 'Stripe receipt (invoice gap recovery)',
    }), ctx, 'payments');
  }

  if (hasPayments) {
    await syncRefundedGapReceiptMarkers(conn, from, to, ctx);
  }
}

async function syncRefundedGapReceiptMarkers(conn, from, to, ctx) {
  const markers = await conn('payments as m')
    .leftJoin('invoices as gi', 'gi.stripe_payment_intent_id', 'm.stripe_payment_intent_id')
    .leftJoin('customers as c', conn.raw('c.id = COALESCE(m.customer_id, gi.customer_id)'))
    .whereRaw("m.metadata->>'source' = 'invoice_refund'")
    .whereNotExists(function noGenuinePayment() {
      this.select(conn.raw('1'))
        .from('payments as p2')
        .whereRaw('p2.stripe_payment_intent_id = m.stripe_payment_intent_id')
        .whereRaw("COALESCE(p2.metadata->>'source', '') <> 'invoice_refund'");
    })
    .whereRaw(
      "DATE(COALESCE(gi.paid_at AT TIME ZONE 'America/New_York', m.payment_date::timestamp)) BETWEEN ?::date AND ?::date",
      [from, to],
    )
    .select(
      'm.id', 'm.customer_id', 'm.amount', 'm.base_amount_cents', 'm.surcharge_amount_cents',
      'm.metadata', 'm.stripe_payment_intent_id', conn.raw('m.payment_date::text as payment_date'),
      'gi.id as invoice_id', 'gi.customer_id as invoice_customer_id', 'gi.service_type', 'gi.paid_at',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.property_type',
    );

  for (const m of markers) {
    const customerId = m.customer_id || m.invoice_customer_id || null;
    if (isTestCustomerRow({ ...m, customer_id: customerId })) continue;
    if (await hasExistingPaymentEntryForPi(conn, m.stripe_payment_intent_id)) {
      ctx.stats.payments.skipped += 1;
      continue;
    }
    const grossCents = dollarsToCents(m.amount);
    const paymentDate = timestampToEtDate(m.paid_at) || dateCellText(m.payment_date);
    if (!paymentDate || !grossCents || grossCents <= 0) continue;

    const serviceLine = isCommercialProperty(m.property_type) ? 'commercial' : (m.service_type || null);
    await postOrPreview(rules.buildPaymentEntry({
      paymentId: `gap:${m.invoice_id || m.id}`,
      idempotencyKey: `payment:gap:${m.invoice_id || m.id}`,
      paymentDate,
      grossCents,
      feeCents: 0,
      surchargeCents: extractSurchargeCents(m, grossCents),
      method: 'stripe',
      invoiceId: m.invoice_id || null,
      customerId,
      serviceLine,
      reference: m.stripe_payment_intent_id || m.id,
      memo: 'Stripe receipt (refunded gap invoice recovery)',
    }), ctx, 'payments');
  }
}

// ── 4. Refunds (Stripe Outflows w/ Cumulative Tax, Verified Deposits, Manual) ─

function collectOutflowInvoiceRefs(rows) {
  const ids = [];
  const pis = [];
  const customerIds = [];
  for (const r of rows) {
    if (r.invoice_id) ids.push(r.invoice_id);
    const meta = parseJsonObject(r.payment_metadata);
    if (meta.invoice_id) ids.push(meta.invoice_id);
    if (meta.dispute_invoice_id) ids.push(meta.dispute_invoice_id);
    if (r.payment_pi) pis.push(r.payment_pi);
    const cid = r.customer_id || r.payment_customer_id;
    if (cid) customerIds.push(cid);
  }
  return { ids, pis, customerIds: [...new Set(customerIds)] };
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

async function loadDepositsForOutflows(conn, customerIds) {
  const byPi = new Map();
  const byCustomer = new Map();
  if (!(await conn.schema.hasTable('estimate_deposits'))) return { byPi, byCustomer };

  const q = conn('estimate_deposits')
    .where((sub) => {
      sub.where('refunded_amount', '>', 0).orWhereIn('status', ['refunded', 'refunding']);
    })
    .select('id', 'customer_id', 'amount', 'credited_amount', 'refunded_amount', 'card_surcharge', 'stripe_payment_intent_id', 'status');
  if (customerIds.length) q.whereIn('customer_id', customerIds);
  const rows = await q;

  for (const d of rows) {
    if (d.stripe_payment_intent_id) byPi.set(String(d.stripe_payment_intent_id), d);
    if (d.customer_id) {
      const list = byCustomer.get(String(d.customer_id)) || [];
      list.push(d);
      byCustomer.set(String(d.customer_id), list);
    }
  }
  return { byPi, byCustomer };
}

/**
 * Pure: match an unlinked Stripe outflow to an unused estimate deposit ONLY when
 * verified by an exact PaymentIntent reference OR a unique exact amount match.
 * Never guesses on a mismatched single candidate; flags ambiguous outflows for review.
 */
function findMatchingDepositForOutflow(row, absCents, depositMaps) {
  if (row.payment_id || row.invoice_id) return { deposit: null, ambiguous: false };
  const desc = String(row.description || '');
  for (const [pi, dep] of depositMaps.byPi.entries()) {
    if (desc.includes(pi)) return { deposit: dep, ambiguous: false };
  }
  const cid = row.customer_id ? String(row.customer_id) : null;
  if (!cid || !depositMaps.byCustomer.has(cid)) return { deposit: null, ambiguous: false };

  const candidates = depositMaps.byCustomer.get(cid);
  const exactMatches = candidates.filter((d) => {
    const face = safeNonNegCents(d.amount);
    const refFace = safeNonNegCents(d.refunded_amount);
    const sur = safeNonNegCents(d.card_surcharge);
    return (refFace > 0 && (absCents === refFace || absCents === refFace + sur))
      || (face > 0 && absCents === face + sur);
  });
  if (exactMatches.length === 1) return { deposit: exactMatches[0], ambiguous: false };
  return { deposit: null, ambiguous: candidates.length > 0 };
}

async function loadPriorRefundTotalsByInvoice(conn, invoiceIds) {
  const map = new Map();
  if (!invoiceIds.length) return map;
  const rows = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where('e.status', 'posted')
    .whereNull('e.reversed_by_entry_id')
    .whereIn('e.source_type', ['refund', 'refund_reversal'])
    .whereIn('l.invoice_ref', invoiceIds.map(String))
    .select('l.invoice_ref', 'a.code', 'l.debit_cents', 'l.credit_cents');

  for (const r of rows) {
    const key = String(r.invoice_ref);
    const rec = map.get(key) || { grossCents: 0, taxCents: 0 };
    const dr = Number(r.debit_cents);
    const cr = Number(r.credit_cents);
    if (r.code === SYSTEM_CODES.REV_REFUNDS_ALLOWANCES) rec.grossCents += (dr - cr);
    if (r.code === SYSTEM_CODES.SALES_TAX_PAYABLE) {
      rec.grossCents += (dr - cr);
      rec.taxCents += (dr - cr);
    }
    map.set(key, rec);
  }
  return map;
}

function buildDepositOutflowEntry(dep, txnKey, amountCents, entryDate, customerId, reason) {
  const { principalCents, surchargeCents } = splitDepositRefundCents(Math.abs(amountCents), dep);
  if (amountCents < 0) {
    return rules.buildDepositRefundEntry({
      txnId: txnKey,
      idempotencyKey: `deposit-refund:spt:${txnKey}`,
      refundDate: entryDate,
      principalCents,
      surchargeCents,
      method: 'stripe',
      customerId,
      reference: txnKey,
      reason,
    });
  }
  return rules.buildDepositRefundReversalEntry({
    txnId: txnKey,
    idempotencyKey: `deposit-refund-reversal:spt:${txnKey}`,
    reversalDate: entryDate,
    principalCents,
    surchargeCents,
    method: 'stripe',
    customerId,
    reference: txnKey,
    reason,
  });
}

async function tryHandleUnlinkedDepositOutflow({ row, absCents, amountCents, txnKey, entryDate, customerId, reason, depositMaps, ctx }) {
  const depCheck = findMatchingDepositForOutflow(row, absCents, depositMaps);
  if (depCheck.deposit) {
    await postOrPreview(
      buildDepositOutflowEntry(depCheck.deposit, txnKey, amountCents, entryDate, customerId, reason),
      ctx,
      'refunds',
    );
    return true;
  }
  if (depCheck.ambiguous) {
    ctx.stats.refunds.needs_review.push({
      txn_id: txnKey,
      customer_id: customerId,
      amount_cents: absCents,
      reason: 'Unverified Stripe outflow for customer with refunded deposit — link manually before reducing 2300',
    });
    return true;
  }
  return false;
}

function buildOutflowRefundEntry({ row, linkedInv, amountCents, absCents, taxCents, txnKey, expectedKey, entryDate, customerId, reason }) {
  const isCommercial = isCommercialProperty(linkedInv?.property_type || row.property_type);
  const common = {
    subtotalCents: absCents - taxCents,
    taxCents,
    method: 'stripe',
    customerId,
    invoiceId: linkedInv?.id || null,
    serviceLine: isCommercial ? 'commercial' : (linkedInv?.service_type || null),
    reference: txnKey,
    reason,
  };
  return amountCents < 0
    ? rules.buildRefundEntry({ ...common, refundId: txnKey, idempotencyKey: expectedKey, refundDate: entryDate })
    : rules.buildRefundReversalEntry({ ...common, txnId: txnKey, idempotencyKey: expectedKey, reversalDate: entryDate });
}

async function syncSingleOutflowRow(row, invoiceMaps, depositMaps, cumRefundsByInvoice, ctx) {
  const amountCents = dollarsToCents(row.amount);
  const entryDate = timestampToEtDate(row.created_at_stripe);
  if (!entryDate || !amountCents) return;

  const absCents = Math.abs(amountCents);
  const txnKey = row.stripe_txn_id || row.id;
  const customerId = row.customer_id || row.payment_customer_id || null;
  const reason = row.description
    ? String(row.description).slice(0, 300)
    : `Stripe ${row.reporting_category || row.type || 'refund'}`;

  const linkedInv = resolveOutflowLinkedInvoice(row, invoiceMaps);
  if (!linkedInv) {
    const handled = await tryHandleUnlinkedDepositOutflow({
      row, absCents, amountCents, txnKey, entryDate, customerId, reason, depositMaps, ctx,
    });
    if (handled) return;
  }

  const expectedKey = amountCents < 0 ? `refund:spt:${txnKey}` : `refund-reversal:spt:${txnKey}`;
  const existing = await ctx.conn('gl_journal_entries').where({ idempotency_key: expectedKey }).first('id');
  if (existing) {
    ctx.stats.refunds.skipped += 1;
    return;
  }

  // Allocate sales tax from cumulative refunded gross per invoice so separate partial refunds never over-reverse tax.
  const invKey = linkedInv ? String(linkedInv.id) : null;
  const cum = invKey ? (cumRefundsByInvoice.get(invKey) || { grossCents: 0, taxCents: 0 }) : { grossCents: 0, taxCents: 0 };
  const signedDelta = amountCents < 0 ? absCents : -absCents;
  const taxCents = computeIncrementalRefundTaxCents(cum.grossCents, cum.taxCents, signedDelta, linkedInv, row.payment_amount);

  const entry = buildOutflowRefundEntry({
    row, linkedInv, amountCents, absCents, taxCents, txnKey, expectedKey, entryDate, customerId, reason,
  });
  const posted = await postOrPreview(entry, ctx, 'refunds');
  if (posted && invKey) {
    cumRefundsByInvoice.set(invKey, {
      grossCents: Math.max(0, cum.grossCents + signedDelta),
      taxCents: Math.max(0, cum.taxCents + (amountCents < 0 ? taxCents : -taxCents)),
    });
  }
}

async function syncStripeRefundsAndOutflows(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('stripe_payout_transactions'))) return;
  const rows = await outflowTransactionsQuery(conn, from, to)
    .leftJoin('customers as c', conn.raw('c.id = COALESCE(spt.customer_id, lp.customer_id)'))
    .orderBy('spt.created_at_stripe', 'asc')
    .orderBy('spt.id', 'asc')
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
  const { ids, pis, customerIds } = collectOutflowInvoiceRefs(nonTestRows);
  const [invoiceMaps, depositMaps] = await Promise.all([
    loadInvoicesForLinks(conn, ids, pis),
    loadDepositsForOutflows(conn, customerIds),
  ]);
  const resolvedInvIds = [...new Set([...invoiceMaps.byId.keys()])];
  const cumRefundsByInvoice = await loadPriorRefundTotalsByInvoice(conn, resolvedInvIds);

  for (const row of nonTestRows) {
    await syncSingleOutflowRow(row, invoiceMaps, depositMaps, cumRefundsByInvoice, ctx);
  }
}

async function syncManualRefunds(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('payments'))) return;
  const rows = await conn('payments as p')
    .leftJoin('customers as c', 'c.id', 'p.customer_id')
    .whereIn('p.status', ['paid', 'refunded', 'disputed'])
    .where('p.refund_amount', '>', 0)
    .whereRaw("COALESCE(p.metadata->>'source', '') <> 'invoice_refund'")
    .whereRaw("NOT (COALESCE(p.processor, '') = 'stripe' AND (p.stripe_charge_id IS NOT NULL OR p.stripe_payment_intent_id IS NOT NULL))")
    .whereRaw(
      "DATE(COALESCE(p.refunded_at AT TIME ZONE 'America/New_York', p.payment_date::timestamp)) BETWEEN ?::date AND ?::date",
      [from, to],
    )
    .select(
      'p.id', 'p.customer_id', 'p.amount', 'p.refund_amount', 'p.processor', 'p.payment_method_type',
      'p.stripe_payment_intent_id', 'p.stripe_charge_id', 'p.metadata',
      conn.raw('p.payment_date::text as payment_date'), 'p.refunded_at',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.property_type',
    );

  const nonTestRows = rows.filter((r) => !isTestCustomerRow(r));
  if (!nonTestRows.length) return;
  const auditMarkers = await loadManualPaymentAuditMarkers(conn, nonTestRows.map((r) => r.id));
  const { ids, pis } = collectPaymentInvoiceRefs(nonTestRows, auditMarkers);
  const invoiceMaps = await loadInvoicesForLinks(conn, ids, pis);

  for (const pay of nonTestRows) {
    const cumRefundCents = safeNonNegCents(pay.refund_amount);
    const refundDate = timestampToEtDate(pay.refunded_at) || dateCellText(pay.payment_date);
    if (!refundDate || cumRefundCents <= 0) continue;

    const priorRow = await conn('gl_journal_lines as l')
      .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
      .where('e.status', 'posted')
      .where('e.source_type', 'refund')
      .whereNull('e.reversed_by_entry_id')
      .where((q) => {
        q.where('e.idempotency_key', `refund:manual:${pay.id}`)
          .orWhere('e.idempotency_key', 'like', `refund:manual:${pay.id}:%`);
      })
      .first(conn.raw('COALESCE(SUM(l.credit_cents), 0)::bigint as booked_cents'));

    const alreadyBooked = Math.trunc(Number(priorRow?.booked_cents) || 0);
    const deltaCents = cumRefundCents - alreadyBooked;
    if (deltaCents <= 0) {
      ctx.stats.refunds.skipped += 1;
      continue;
    }

    const marker = auditMarkers.get(String(pay.id)) || null;
    const linkedInv = linkedInvoiceForPayment(pay, invoiceMaps, marker);
    const cumTax = computeProratedRefundTaxCents(cumRefundCents, linkedInv, pay.amount);
    const prevTax = computeProratedRefundTaxCents(alreadyBooked, linkedInv, pay.amount);
    const deltaTax = Math.max(0, Math.min(deltaCents, cumTax - prevTax));
    const method = resolvePaymentMethod(pay, linkedInv, marker);
    const serviceLine = isCommercialProperty(linkedInv?.property_type || pay.property_type)
      ? 'commercial'
      : (linkedInv?.service_type || null);

    await postOrPreview(rules.buildRefundEntry({
      refundId: `manual:${pay.id}:${cumRefundCents}`,
      idempotencyKey: `refund:manual:${pay.id}:${cumRefundCents}`,
      refundDate,
      subtotalCents: deltaCents - deltaTax,
      taxCents: deltaTax,
      method,
      customerId: pay.customer_id,
      invoiceId: linkedInv?.id || null,
      serviceLine,
      reference: pay.id,
      reason: `Manual customer refund (${method})`,
    }), ctx, 'refunds');
  }
}

// ── 5. Stripe Processing Fees & Payouts (UTC Calendar Day per ARRIVAL_DAY_SQL) ─

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
    await postOrPreview(rules.buildStripeFeeEntry({
      txnId: txnKey,
      feeDate,
      feeCents,
      customerId,
      invoiceId: row.invoice_id || null,
      reference: txnKey,
      memo: row.description ? `Stripe fee — ${String(row.description).slice(0, 200)}` : null,
    }), ctx, 'stripe_fees');
  }
}

async function syncStripePayouts(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('stripe_payouts'))) return;
  const rows = await conn('stripe_payouts')
    .where({ status: 'paid' })
    .whereRaw(`${ARRIVAL_DAY_SQL} BETWEEN ?::date AND ?::date`, [from, to])
    .select(
      'id',
      'stripe_payout_id',
      'amount',
      'arrival_date',
      conn.raw("to_char(arrival_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as arrival_day"),
    );

  for (const p of rows) {
    const arrivalDate = dateCellText(p.arrival_day) || timestampToUtcDate(p.arrival_date);
    const amountCents = dollarsToCents(p.amount);
    if (!arrivalDate || !amountCents || amountCents <= 0) continue;

    await postOrPreview(rules.buildStripePayoutEntry({
      payoutId: p.id,
      arrivalDate,
      amountCents,
      reference: p.stripe_payout_id || p.id,
    }), ctx, 'stripe_payouts');
  }
}

// ── 6. Expenses (Shared-Bill Split, Vendor Backfill, Edit Deltas & Deletions) ─

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
  const resolvedAccountId = mapped?.id || matchedVendor?.default_account_id || null;
  const resolvedCode = resolvedAccountId ? null : SYSTEM_CODES.OPEX_UNCATEGORIZED;
  const sharedPct = bookedSharePct(exp.notes);
  if (sharedPct != null && sharedPct >= 0 && sharedPct < 100) {
    const pctHundredths = Math.round(sharedPct * 100);
    const bizCents = Math.min(amountCents, Math.max(0, Math.floor((amountCents * pctHundredths + 5000) / 10000)));
    const personalCents = amountCents - bizCents;
    const splits = [];
    if (bizCents > 0) {
      splits.push({
        accountId: resolvedAccountId,
        accountCode: resolvedCode,
        amountCents: bizCents,
        scheduledServiceId: exp.scheduled_service_id,
      });
    }
    if (personalCents > 0) {
      splits.push({ accountCode: SYSTEM_CODES.OWNER_DRAWS, amountCents: personalCents, memo: 'Shared bill personal share' });
    }
    return splits;
  }
  return [{
    accountId: resolvedAccountId,
    accountCode: resolvedCode,
    amountCents,
    scheduledServiceId: exp.scheduled_service_id,
  }];
}

async function loadBookedExpenseState(conn, expenseId) {
  const rows = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where({ 'e.status': 'posted', 'e.source_type': 'expense', 'e.source_id': String(expenseId) })
    .whereNull('e.reversed_by_entry_id')
    .select('e.id as entry_id', 'a.code', 'l.debit_cents', 'l.credit_cents');

  const bookedByCode = new Map();
  const entryIds = new Set();
  for (const r of rows) {
    entryIds.add(r.entry_id);
    const net = Number(r.debit_cents) - Number(r.credit_cents);
    bookedByCode.set(r.code, (bookedByCode.get(r.code) || 0) + net);
  }
  return { bookedByCode, entryCount: entryIds.size };
}

async function backfillExpenseVendorIfNeeded(exp, matchedVendor, trx, ctx) {
  if (!matchedVendor) return;
  const existing = await trx('gl_journal_entries as e')
    .where({ 'e.source_type': 'expense', 'e.source_id': String(exp.id), 'e.status': 'posted' })
    .whereNull('e.reversed_by_entry_id')
    .select('e.id');

  for (const row of existing) {
    const unlinked = await trx('gl_journal_lines as l')
      .join('gl_accounts as a', 'a.id', 'l.account_id')
      .where('l.entry_id', row.id)
      .whereNull('l.vendor_id')
      .whereNull('l.reconciliation_id')
      .whereIn('a.account_type', ['cogs', 'expense'])
      .first('l.id');
    if (!unlinked) continue;

    if (ctx.dryRun) {
      ctx.stats.expenses.would_link_vendors += 1;
    } else {
      await linkJournalEntryVendor(row.id, {
        vendorId: matchedVendor.id,
        reason: 'Subledger sync matched newly registered vendor',
        actorId: ctx.actorId,
        requestMeta: ctx.requestMeta,
        conn: trx,
      });
      ctx.stats.expenses.linked_vendors += 1;
    }
  }
}

async function syncSingleExpenseRow(exp, mapped, matchedVendor, ctx) {
  const entryDate = dateCellText(exp.expense_date);
  const amountCents = dollarsToCents(exp.amount);
  if (!entryDate || amountCents == null || amountCents < 0) return;

  const desired = amountCents > 0
    ? rules.buildExpenseEntry({
      sourceType: 'expense',
      sourceId: exp.id,
      entryDate,
      paymentAccountCode: paymentAccountCodeForExpense(exp.payment_method),
      paymentMethod: exp.payment_method || null,
      splits: buildExpenseSplits(exp, mapped, matchedVendor, amountCents),
      vendorId: matchedVendor ? matchedVendor.id : null,
      memo: [exp.vendor_name, exp.description].filter(Boolean).join(' — ').slice(0, 500) || 'Expense',
    })
    : null;

  const updatedDate = timestampToEtDate(exp.updated_at);
  const adjDate = updatedDate && updatedDate >= entryDate ? updatedDate : entryDate;

  const reconcile = async (trx) => {
    const { bookedByCode, entryCount } = await loadBookedExpenseState(trx, exp.id);
    if (entryCount === 0) {
      if (!desired) return;
      await postOrPreview(desired, ctx, 'expenses', { connOverride: trx });
      return;
    }

    await backfillExpenseVendorIfNeeded(exp, matchedVendor, trx, ctx);
    const adjEntry = buildDeltaEntry({
      sourceType: 'expense',
      sourceId: exp.id,
      keyPrefix: 'expense-adj',
      revisionSeq: entryCount,
      desiredLines: desired ? desired.lines : [],
      bookedByCode,
      adjustmentDate: adjDate,
      basisScope: 'both',
      reference: String(exp.id),
      memo: `Expense adjustment — ${[exp.vendor_name, exp.description].filter(Boolean).join(' — ').slice(0, 420) || exp.id}`,
      lineMeta: { vendorId: matchedVendor ? matchedVendor.id : null, paymentMethod: exp.payment_method || null },
      accountsById: ctx.caches.accountsById,
    });
    if (!adjEntry) {
      ctx.stats.expenses.skipped += 1;
      return;
    }
    await postOrPreview(adjEntry, ctx, 'expenses', { isAdjustment: true, connOverride: trx });
  };

  if (ctx.dryRun) {
    await reconcile(ctx.conn);
  } else {
    await withEntitySyncLock(ctx.conn, `gl-sync-expense:${exp.id}`, reconcile);
  }
}

async function reconcileDeletedExpenses(conn, from, to, ctx) {
  const deleted = await conn('gl_journal_entries as e')
    .where({ 'e.source_type': 'expense', 'e.status': 'posted' })
    .whereNull('e.reversed_by_entry_id')
    .whereBetween('e.entry_date', [from, to])
    .whereNotExists(function expenseStillExists() {
      this.select(conn.raw('1')).from('expenses as ex').whereRaw('ex.id::text = e.source_id');
    })
    .select('e.id', 'e.reversed_by_entry_id', conn.raw('e.entry_date::text as entry_date'));

  const today = etDateString(new Date());
  for (const row of deleted) {
    const entryDay = dateCellText(row.entry_date);
    const revDate = today >= entryDay && today <= to ? today : (to >= entryDay ? to : entryDay);
    await reverseOrPreview(row, revDate, 'Source expense deleted', ctx, 'expenses');
  }
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
    .where((q) => {
      q.whereBetween('e.expense_date', [from, to])
        .orWhere((edited) => {
          edited.whereRaw("DATE(e.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to])
            .whereExists(function alreadyBooked() {
              this.select(conn.raw('1'))
                .from('gl_journal_entries as ge')
                .where({ 'ge.source_type': 'expense', 'ge.status': 'posted' })
                .whereNull('ge.reversed_by_entry_id')
                .whereRaw('ge.source_id = e.id::text');
            });
        });
    })
    .whereRaw("COALESCE(c.name, '') <> 'Payroll (counted from pay runs)'")
    .whereRaw("COALESCE(c.irs_line, '') NOT IN ('13', '30')")
    .select(
      'e.id', 'e.category_id', 'e.description', 'e.amount', 'e.tax_deductible_amount', 'e.notes',
      conn.raw('e.expense_date::text as expense_date'), 'e.vendor_name', 'e.payment_method',
      'e.scheduled_service_id', 'e.updated_at', 'c.name as category_name',
    );

  const unmatchedContractors = new Map();
  for (const exp of rows) {
    const amountCents = dollarsToCents(exp.amount);
    const mapped = exp.category_id ? glByCatId.get(exp.category_id) : null;
    const matchedVendor = vendorLookup.match(exp.vendor_name);

    if (exp.vendor_name && !matchedVendor && amountCents > 0) {
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

    await syncSingleExpenseRow(exp, mapped, matchedVendor, ctx);
  }

  ctx.stats.expenses.unmatched_contractor_vendors = Array.from(unmatchedContractors.values());
  await reconcileDeletedExpenses(conn, from, to, ctx);
}

// ── 7. Payroll Runs (Finalized Posts + Voided Run Reversals) ─────────────────

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

    await postOrPreview(rules.buildPayrollRunEntry({
      runId: run.id,
      payDate: dateCellText(run.pay_date),
      weekLabel: `Week of ${dateCellText(run.week_start)}`,
      ...totals,
    }), ctx, 'payroll_runs');
  }

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
  const [missingSystemAccounts, caches] = await Promise.all([
    findMissingSystemAccountCodes(conn),
    loadSyncCaches(conn),
  ]);

  const makeBucket = (extra = {}) => ({ posted: 0, skipped: 0, would_post: 0, errors: [], ...extra });
  const stats = {
    from,
    to,
    dry_run: Boolean(dryRun),
    missing_system_accounts: missingSystemAccounts,
    invoices: makeBucket({ adjusted: 0, would_adjust: 0, reversed: 0, would_reverse: 0 }),
    deposits: makeBucket(),
    payments: makeBucket({ reversed: 0, would_reverse: 0 }),
    refunds: makeBucket({ needs_review: [] }),
    stripe_fees: makeBucket(),
    stripe_payouts: makeBucket(),
    expenses: makeBucket({
      adjusted: 0,
      would_adjust: 0,
      reversed: 0,
      would_reverse: 0,
      linked_vendors: 0,
      would_link_vendors: 0,
      unmatched_vendors: 0,
      unmatched_contractor_vendors: [],
    }),
    payroll_runs: makeBucket({ reversed: 0, would_reverse: 0 }),
  };

  const ctx = { dryRun: Boolean(dryRun), actorId, requestMeta, stats, conn, caches };
  await syncInvoices(conn, from, to, ctx);
  await syncEstimateDeposits(conn, from, to, ctx);
  await syncPayments(conn, from, to, ctx);
  await syncStripeInvoiceGapPayments(conn, from, to, ctx);
  await syncStripeRefundsAndOutflows(conn, from, to, ctx);
  await syncManualRefunds(conn, from, to, ctx);
  await syncStripeFees(conn, from, to, ctx);
  await syncStripePayouts(conn, from, to, ctx);
  await syncExpenses(conn, from, to, ctx);
  await syncPayrollRuns(conn, from, to, ctx);

  return stats;
}

module.exports = {
  syncSubledgersToGl,
  billedInvoicePrincipalCents,
  extractAppliedDepositCents,
  extractSurchargeCents,
  resolvePaymentMethod,
  computeProratedRefundTaxCents,
  computeIncrementalRefundTaxCents,
  allocateStatementPrincipalAcrossInvoices,
  splitDepositRefundCents,
  findMatchingDepositForOutflow,
  buildExpenseSplits,
  buildInvoiceGlPayload,
  buildInvoiceDeltaEntry,
  timestampToUtcDate,
};
