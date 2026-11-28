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
const { validDateOnly } = require('../../utils/date-only');
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
  if (typeof value === 'string' && validDateOnly(value.trim())) return value.trim();
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return etDateString(d);
}

function timestampToUtcDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && validDateOnly(value.trim())) return value.trim();
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
      'i.subtotal', 'i.discount_amount', 'i.credit_applied', 'i.line_items',
      'i.annual_prepay_term_id', 'i.annual_prepay_covered_term_id', 'c.property_type',
    );

  const prepayTermByInvoiceId = new Map();
  if (rows.length && (await conn.schema.hasTable('annual_prepay_terms'))) {
    const terms = await conn('annual_prepay_terms')
      .whereIn('prepay_invoice_id', rows.map((r) => r.id))
      .select('id', 'prepay_invoice_id');
    for (const t of terms) prepayTermByInvoiceId.set(String(t.prepay_invoice_id), t.id);
  }

  for (const r of rows) {
    const termId = r.annual_prepay_term_id || prepayTermByInvoiceId.get(String(r.id)) || null;
    const enriched = {
      ...r,
      resolved_prepay_term_id: termId,
      is_annual_prepay: Boolean(termId),
    };
    byId.set(String(r.id), enriched);
    if (r.stripe_payment_intent_id) byPi.set(String(r.stripe_payment_intent_id), enriched);
  }
  return { byId, byPi };
}

// ── 0. Standalone & Refund-Restored Customer Account Credits (2350) ──────────

const REFUND_CREDIT_NOTE_PREFIX = 'Account credit returned — invoice ';
const REFUND_CREDIT_NOTE_SUFFIX = ' fully refunded';

function isRefundCreditRestorationRow(row) {
  if (String(row?.source || '').trim().toLowerCase() !== 'adjustment') return false;
  if (row?.invoice_id == null || !(Number(row?.delta) > 0)) return false;
  const note = String(row?.note || '');
  return note.startsWith(REFUND_CREDIT_NOTE_PREFIX) && note.endsWith(REFUND_CREDIT_NOTE_SUFFIX);
}

function isInvoiceLinkedCreditRow(row) {
  const src = String(row?.source || '').trim().toLowerCase();
  if (src === 'invoice_application' || src === 'invoice_prepaid') return true;
  // Full-refund credit restorations ARE synced (DR 4090 / DR 2100 tax -> CR 2350);
  // void & payer-transfer restores are already reversed via the invoice JE reversal.
  if (isRefundCreditRestorationRow(row)) return false;
  if (src === 'adjustment' && row?.invoice_id != null) return true;
  return false;
}

async function syncCustomerCredits(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('customer_credit_ledger'))) return;
  const rows = await conn('customer_credit_ledger as cl')
    .leftJoin('customers as c', 'c.id', 'cl.customer_id')
    .whereNotIn('cl.source', ['invoice_application', 'invoice_prepaid'])
    .whereRaw(
      "NOT (cl.source = 'adjustment' AND cl.invoice_id IS NOT NULL AND NOT (cl.delta > 0 AND COALESCE(cl.note, '') LIKE ?))",
      [`${REFUND_CREDIT_NOTE_PREFIX}%${REFUND_CREDIT_NOTE_SUFFIX}`],
    )
    .whereRaw(
      "DATE(cl.created_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date",
      [from, to],
    )
    .orderBy('cl.created_at', 'asc')
    .orderBy('cl.id', 'asc')
    .select(
      'cl.id', 'cl.customer_id', 'cl.delta', 'cl.source', 'cl.invoice_id', 'cl.note', 'cl.created_at',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone',
    );

  const refundCreditInvIds = rows
    .filter((r) => isRefundCreditRestorationRow(r) && r.invoice_id)
    .map((r) => r.invoice_id);
  const invMaps = refundCreditInvIds.length
    ? await loadInvoicesForLinks(conn, refundCreditInvIds, [])
    : { byId: new Map() };

  for (const row of rows) {
    if (isTestCustomerRow(row) || isInvoiceLinkedCreditRow(row)) continue;
    const entryDate = timestampToEtDate(row.created_at);
    const deltaCents = dollarsToCents(row.delta);
    if (!entryDate || !deltaCents) continue;

    let taxCents = 0;
    let unearnedCents = 0;
    let invoiceId = null;
    let serviceLine = null;
    if (isRefundCreditRestorationRow(row)) {
      const linkedInv = invMaps.byId.get(String(row.invoice_id)) || null;
      invoiceId = row.invoice_id;
      taxCents = computeProratedRefundTaxCents(deltaCents, linkedInv, null);
      if (linkedInv?.is_annual_prepay) {
        unearnedCents = Math.max(0, deltaCents - taxCents);
      }
      if (linkedInv) {
        serviceLine = isCommercialProperty(linkedInv.property_type) ? 'commercial' : (linkedInv.service_type || null);
      }
    }

    await postOrPreview(rules.buildCustomerCreditEntry({
      ledgerId: row.id,
      entryDate,
      signedDeltaCents: deltaCents,
      creditSource: row.source,
      taxCents,
      unearnedCents,
      invoiceId,
      serviceLine,
      customerId: row.customer_id,
      memo: row.note ? String(row.note).slice(0, 300) : null,
    }), ctx, 'customer_credits');
  }
}

// ── 1. Invoices (Initial Post + Coverage Conversion + Zero/Edit Deltas + Voids) ─

function extractPrepayInvoiceFields(row, prefix) {
  if (!row) return null;
  if (row.prepay_invoice) return row.prepay_invoice;
  const tax = row[`${prefix}_tax`];
  const sub = row[`${prefix}_subtotal`];
  const total = row[`${prefix}_total`];
  if (tax == null && sub == null && total == null) return null;
  return {
    subtotal: sub,
    discount_amount: row[`${prefix}_discount`] ?? 0,
    tax_amount: tax ?? 0,
    total,
    line_items: row[`${prefix}_line_items`] ?? null,
  };
}

/**
 * Pure: strip embedded FL sales tax from a tax-inclusive annual-prepay allocation so
 * earned-revenue recognition debits only the pre-tax portion originally credited to 2300.
 */
function stripPrepaidSalesTaxCents(grossCents, termPrepayCents, prepayInv) {
  if (!(grossCents > 0) || !prepayInv) return Math.max(0, grossCents || 0);
  const invTax = safeNonNegCents(prepayInv.tax_amount);
  if (invTax <= 0) return grossCents;
  const invGross = billedInvoicePrincipalCents(prepayInv);
  const invPreTax = Math.max(0, invGross - invTax);
  if (invPreTax <= 0 || invGross <= invPreTax) return grossCents;
  if (termPrepayCents > 0) {
    if (termPrepayCents <= invPreTax) return grossCents;
    const embeddedTax = Math.min(invTax, termPrepayCents - invPreTax);
    const netTermPrepay = termPrepayCents - embeddedTax;
    return Math.round((grossCents * netTermPrepay) / termPrepayCents);
  }
  return Math.round((grossCents * invPreTax) / invGross);
}

function buildCoveredPrepayVisitPayload(inv, issueDate, serviceLine, isCommercial, taxCents) {
  const prepayInv = extractPrepayInvoiceFields(inv, 'cov_prepay_inv');
  const termPrepayCents = safeNonNegCents(inv.cov_term_prepay_amount ?? inv.term_prepay_amount);
  const termVisitCount = Math.trunc(Number(inv.cov_term_visit_count ?? inv.coverage_visit_count) || 0);
  const discountedVisitRaw = safeNonNegCents(inv.visit_prepaid_amount ?? inv.prepaid_amount);
  const discountedVisitCents = stripPrepaidSalesTaxCents(discountedVisitRaw, termPrepayCents, prepayInv);
  const discountedTermRaw = termPrepayCents > 0 && termVisitCount > 0
    ? Math.round(termPrepayCents / termVisitCount)
    : 0;
  const discountedTermSliceCents = stripPrepaidSalesTaxCents(discountedTermRaw, termPrepayCents, prepayInv);
  const rawPreTax = (dollarsToCents(inv.subtotal || 0) || 0) - (dollarsToCents(inv.discount_amount || 0) || 0);
  const invoicePreTaxCents = rawPreTax > 0 ? rawPreTax : Math.max(0, billedInvoicePrincipalCents(inv) - taxCents);
  const visitFallbackCents = computePrepayVisitRecognitionCents({
    prepaid_amount: null,
    estimated_price: inv.visit_estimated_price ?? inv.estimated_price,
    term_monthly_rate: inv.cov_term_monthly_rate ?? inv.term_monthly_rate,
  });
  const amountCents = discountedVisitCents || discountedTermSliceCents || invoicePreTaxCents || visitFallbackCents;
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

const ISSUED_STATEMENT_STATUSES = ['finalized', 'sent', 'viewed', 'processing', 'paid'];
const EXCLUDED_PREPAY_TERM_STATUSES = ['cancelled', 'canceled', 'void', 'payment_pending'];

function invoiceIssueDate(inv) {
  return dateCellText(inv.service_date)
    || timestampToEtDate(inv.sent_at)
    || timestampToEtDate(inv.statement_finalized_at)
    || timestampToEtDate(inv.statement_sent_at)
    || dateCellText(inv.statement_period_end)
    || timestampToEtDate(inv.created_at);
}

function buildInvoiceGlPayload(inv, prepayInvoiceIds) {
  const issueDate = invoiceIssueDate(inv);
  if (!issueDate) return null;

  const isCommercial = isCommercialProperty(inv.property_type);
  const serviceLine = isCommercial ? 'commercial' : (inv.service_type || 'pest');
  const taxCents = safeNonNegCents(inv.tax_amount);

  if (inv.annual_prepay_covered_term_id) {
    return buildCoveredPrepayVisitPayload(inv, issueDate, serviceLine, isCommercial, taxCents);
  }

  const principalCents = billedInvoicePrincipalCents(inv);
  const appliedDepositCents = invoiceDepositCreditCents(inv);
  const restoredCreditCents = Math.max(0, intCents(inv.refund_restored_credit_cents));
  const appliedCreditCents = Math.min(safeNonNegCents(inv.credit_applied) + restoredCreditCents, principalCents);
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

/**
 * Pure: build the idempotent accrual-only deposit restoration JE when a fully refunded
 * invoice had consumed an estimate deposit. returnAppliedCreditOnRefund() restores the
 * deposit to available customer credit while leaving deposit_credit lines on the invoice,
 * so we reverse earned revenue (and any deposit-funded sales tax uncovered by billed cash
 * principal) and re-credit 2300 Unearned Revenue.
 */
function buildRefundedDepositRestorePayload(inv, prepayInvoiceIds, { recognizedUnearnedCents = 0 } = {}) {
  if (String(inv?.status || '').trim().toLowerCase() !== 'refunded') return null;
  if (inv.annual_prepay_covered_term_id) return null;
  const depositCents = invoiceDepositCreditCents(inv);
  if (depositCents <= 0) return null;
  const restoreDate = timestampToEtDate(inv.updated_at) || invoiceIssueDate(inv);
  if (!restoreDate) return null;

  const principalCents = billedInvoicePrincipalCents(inv);
  const taxCents = safeNonNegCents(inv.tax_amount);
  const taxRestoreCents = Math.min(depositCents, Math.max(0, taxCents - principalCents));
  const nonTaxDepositCents = depositCents - taxRestoreCents;
  const isAnnualPrepay = Boolean(inv.annual_prepay_term_id || prepayInvoiceIds?.has(String(inv.id)));
  const allowanceCents = isAnnualPrepay
    ? Math.min(nonTaxDepositCents, Math.max(0, Math.trunc(Number(recognizedUnearnedCents) || 0)))
    : nonTaxDepositCents;
  if (allowanceCents + taxRestoreCents <= 0) return null;

  const isCommercial = isCommercialProperty(inv.property_type);
  const serviceLine = isCommercial ? 'commercial' : (inv.service_type || 'pest');
  return rules.buildDepositRestoreOnRefundEntry({
    invoiceId: inv.id,
    invoiceNumber: inv.invoice_number,
    restoreDate,
    allowanceCents,
    taxCents: taxRestoreCents,
    customerId: inv.customer_id,
    serviceLine,
  });
}

async function loadBookedInvoiceState(conn, invoiceId) {
  const rows = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where('e.status', 'posted')
    .where((q) => {
      q.where({ 'e.source_type': 'invoice', 'e.source_id': String(invoiceId) })
        .orWhere({ 'e.source_type': 'unearned_recognition', 'e.source_id': `covered-inv:${invoiceId}` });
    })
    .select('e.id as entry_id', 'e.reversed_by_entry_id', 'a.code', 'l.debit_cents', 'l.credit_cents');

  const bookedByCode = new Map();
  const allEntryIds = new Set();
  const activeEntryIds = new Set();
  for (const r of rows) {
    allEntryIds.add(r.entry_id);
    if (!r.reversed_by_entry_id) {
      activeEntryIds.add(r.entry_id);
      const net = Number(r.debit_cents) - Number(r.credit_cents);
      bookedByCode.set(r.code, (bookedByCode.get(r.code) || 0) + net);
    }
  }
  return { bookedByCode, entryCount: activeEntryIds.size, totalEntryCount: allEntryIds.size };
}

async function reverseSupersededPrepayVisitIfAny(trx, inv, adjDate, ctx) {
  if (!inv.annual_prepay_covered_term_id || !inv.scheduled_service_id) return true;
  const visitJe = await trx('gl_journal_entries')
    .where({ source_type: 'unearned_recognition', source_id: `covered-visit:${inv.scheduled_service_id}`, status: 'posted' })
    .whereNull('reversed_by_entry_id')
    .first('id', 'reversed_by_entry_id', trx.raw('entry_date::text as entry_date'));
  if (!visitJe) return true;
  return reverseOrPreview(
    visitJe,
    adjDate || dateCellText(visitJe.entry_date),
    `Superseded by covered invoice ${inv.invoice_number || inv.id}`,
    ctx,
    'invoices',
    { connOverride: trx },
  );
}

async function syncRefundedInvoiceDepositRestore(trx, inv, prepayInvoiceIds, prepayTermByInvoiceId, ctx) {
  if (String(inv?.status || '').trim().toLowerCase() !== 'refunded') return;
  if (inv.annual_prepay_covered_term_id || invoiceDepositCreditCents(inv) <= 0) return;
  const isAnnualPrepay = Boolean(inv.annual_prepay_term_id || prepayInvoiceIds.has(String(inv.id)));
  const termId = inv.annual_prepay_term_id || prepayTermByInvoiceId?.get(String(inv.id)) || null;
  const recognizedUnearnedCents = isAnnualPrepay && termId
    ? await loadRecognizedUnearnedForTerm(trx, termId)
    : 0;
  const restoreEntry = buildRefundedDepositRestorePayload(inv, prepayInvoiceIds, { recognizedUnearnedCents });
  if (!restoreEntry) return;
  await postOrPreview(restoreEntry, ctx, 'invoices', { connOverride: trx });
}

async function syncSingleInvoiceRow(inv, prepayInvoiceIds, prepayTermByInvoiceId, ctx) {
  const desired = buildInvoiceGlPayload(inv, prepayInvoiceIds);
  const fallbackDate = invoiceIssueDate(inv);
  const updatedDate = timestampToEtDate(inv.updated_at);
  const baseDate = desired?.entryDate || fallbackDate;
  const adjDate = updatedDate && baseDate && updatedDate >= baseDate ? updatedDate : baseDate;

  const reconcile = async (trx) => {
    const { bookedByCode, totalEntryCount } = await loadBookedInvoiceState(trx, inv.id);
    if (!(await reverseSupersededPrepayVisitIfAny(trx, inv, adjDate, ctx))) return;

    if (totalEntryCount === 0) {
      if (!desired) return;
      const posted = await postOrPreview(desired, ctx, 'invoices', { connOverride: trx });
      if (!posted) return;
    } else if (adjDate) {
      const adjEntry = buildInvoiceDeltaEntry(inv, desired ? desired.lines : [], bookedByCode, adjDate, totalEntryCount);
      if (!adjEntry) {
        ctx.stats.invoices.skipped += 1;
      } else {
        await postOrPreview(adjEntry, ctx, 'invoices', { isAdjustment: true, connOverride: trx });
      }
    }

    await syncRefundedInvoiceDepositRestore(trx, inv, prepayInvoiceIds, prepayTermByInvoiceId, ctx);
  };

  if (ctx.dryRun) {
    await reconcile(ctx.conn);
  } else {
    await withEntitySyncLock(ctx.conn, `gl-sync-invoice:${inv.id}`, reconcile);
  }
}

async function reconcileVoidedInvoices(conn, from, to, ctx, hasPayerStatements = false) {
  let q = conn('gl_journal_entries as e')
    .join('invoices as i', conn.raw("(e.source_type IN ('invoice', 'refund_deposit_restore') AND e.source_id = i.id::text) OR (e.source_type = 'unearned_recognition' AND e.source_id = 'covered-inv:' || i.id::text)"));
  if (hasPayerStatements) q = q.leftJoin('payer_statements as ps', 'ps.id', 'i.payer_statement_id');

  const voided = await q
    .where('e.status', 'posted')
    .whereNull('e.reversed_by_entry_id')
    .where((sub) => {
      sub.whereIn('i.status', ['void', 'cancelled', 'canceled']).orWhereNotNull('i.archived_at');
      if (hasPayerStatements) {
        sub.orWhere((draftStmt) => {
          draftStmt.where('i.status', 'draft')
            .where((unissued) => unissued.whereNull('i.payer_statement_id').orWhereNotIn('ps.status', ISSUED_STATEMENT_STATUSES));
        });
      }
    })
    .where((sub) => {
      sub.whereBetween('e.entry_date', [from, to])
        .orWhereRaw("DATE(COALESCE(i.archived_at, i.updated_at) AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
      if (hasPayerStatements) {
        sub.orWhereRaw("ps.updated_at IS NOT NULL AND DATE(ps.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
      }
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

async function loadRefundRestoredCreditsByInvoice(conn, refundedInvoiceIds) {
  const map = new Map();
  if (!refundedInvoiceIds.length || !(await conn.schema.hasTable('customer_credit_ledger'))) return map;
  const rows = await conn('customer_credit_ledger')
    .whereIn('invoice_id', refundedInvoiceIds)
    .where({ source: 'adjustment' })
    .where('delta', '>', 0)
    .whereRaw("COALESCE(note, '') LIKE ?", [`${REFUND_CREDIT_NOTE_PREFIX}%${REFUND_CREDIT_NOTE_SUFFIX}`])
    .select('invoice_id', 'delta');
  for (const r of rows) {
    const k = String(r.invoice_id);
    map.set(k, (map.get(k) || 0) + safeNonNegCents(r.delta));
  }
  return map;
}

async function hasSchemaColumn(conn, table, column) {
  if (typeof conn?.schema?.hasColumn !== 'function') return true;
  return conn.schema.hasColumn(table, column);
}

async function syncInvoices(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('invoices'))) return;
  const [hasPayerStatements, hasPrepayTerms, hasScheduledServices] = await Promise.all([
    conn.schema.hasTable('payer_statements'),
    conn.schema.hasTable('annual_prepay_terms'),
    conn.schema.hasTable('scheduled_services'),
  ]);

  const prepayInvoiceIds = new Set();
  const prepayTermByInvoiceId = new Map();
  if (hasPrepayTerms) {
    const termRows = await conn('annual_prepay_terms')
      .whereNotNull('prepay_invoice_id')
      .select('id', 'prepay_invoice_id');
    for (const t of termRows) {
      const k = String(t.prepay_invoice_id);
      prepayInvoiceIds.add(k);
      prepayTermByInvoiceId.set(k, t.id);
    }
  }

  let q = conn('invoices as i').leftJoin('customers as c', 'c.id', 'i.customer_id');
  if (hasPayerStatements) q = q.leftJoin('payer_statements as ps', 'ps.id', 'i.payer_statement_id');
  if (hasPrepayTerms) {
    q = q
      .leftJoin('annual_prepay_terms as cov_term', 'cov_term.id', 'i.annual_prepay_covered_term_id')
      .leftJoin('invoices as cov_prepay_inv', 'cov_prepay_inv.id', 'cov_term.prepay_invoice_id');
  }
  if (hasScheduledServices) q = q.leftJoin('scheduled_services as ss', 'ss.id', 'i.scheduled_service_id');

  const selectCols = [
    'i.id', 'i.invoice_number', 'i.status', 'i.customer_id', 'i.scheduled_service_id', 'i.subtotal', 'i.discount_amount', 'i.tax_amount', 'i.total',
    'i.credit_applied', 'i.line_items', 'i.service_type', 'i.annual_prepay_term_id', 'i.annual_prepay_covered_term_id',
    conn.raw('i.service_date::text as service_date'), 'i.sent_at', 'i.created_at', 'i.updated_at',
    'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.property_type',
  ];
  if (hasPayerStatements) {
    selectCols.push(
      'ps.status as statement_status',
      'ps.finalized_at as statement_finalized_at',
      'ps.sent_at as statement_sent_at',
      conn.raw('ps.period_end::text as statement_period_end'),
    );
  }
  if (hasPrepayTerms) {
    selectCols.push(
      'cov_term.prepay_amount as cov_term_prepay_amount',
      'cov_term.coverage_visit_count as cov_term_visit_count',
      'cov_term.monthly_rate as cov_term_monthly_rate',
      'cov_prepay_inv.subtotal as cov_prepay_inv_subtotal',
      'cov_prepay_inv.discount_amount as cov_prepay_inv_discount',
      'cov_prepay_inv.tax_amount as cov_prepay_inv_tax',
      'cov_prepay_inv.total as cov_prepay_inv_total',
      'cov_prepay_inv.line_items as cov_prepay_inv_line_items',
    );
  }
  if (hasScheduledServices) {
    selectCols.push('ss.prepaid_amount as visit_prepaid_amount', 'ss.estimated_price as visit_estimated_price');
  }

  const rows = await q
    .whereNull('i.archived_at')
    .where((st) => {
      st.whereNotIn('i.status', ['draft', 'scheduled', 'sending', 'void', 'cancelled', 'canceled']);
      if (hasPayerStatements) {
        st.orWhere((stmtChild) => {
          stmtChild.where('i.status', 'draft')
            .whereNotNull('i.payer_statement_id')
            .whereIn('ps.status', ISSUED_STATEMENT_STATUSES);
        });
      }
    })
    .where((win) => {
      win.whereRaw(
        "COALESCE(i.service_date, DATE(i.sent_at AT TIME ZONE 'America/New_York'), DATE(i.created_at AT TIME ZONE 'America/New_York')) BETWEEN ?::date AND ?::date",
        [from, to],
      ).orWhere((edited) => {
        edited.whereRaw("DATE(i.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to])
          .whereExists(function alreadyBooked() {
            this.select(conn.raw('1'))
              .from('gl_journal_entries as ge')
              .where('ge.status', 'posted')
              .where((sub) => {
                sub.whereRaw("ge.source_type = 'invoice' AND ge.source_id = i.id::text")
                  .orWhereRaw("ge.source_type = 'unearned_recognition' AND ge.source_id = 'covered-inv:' || i.id::text");
              });
          });
      }).orWhere((refundedInWin) => {
        refundedInWin.where('i.status', 'refunded')
          .whereRaw("DATE(i.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
      });
      if (hasPayerStatements) {
        win.orWhere((stmtWin) => {
          stmtWin.whereNotNull('i.payer_statement_id')
            .whereIn('ps.status', ISSUED_STATEMENT_STATUSES)
            .whereRaw(
              "DATE(COALESCE(ps.finalized_at, ps.sent_at, ps.period_end::timestamp) AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date",
              [from, to],
            );
        });
      }
    })
    .select(...selectCols);

  const nonTestRows = rows.filter((r) => !isTestCustomerRow(r));
  const refundedIds = nonTestRows
    .filter((r) => String(r.status || '').toLowerCase() === 'refunded')
    .map((r) => r.id);
  const restoredCreditByInv = await loadRefundRestoredCreditsByInvoice(conn, refundedIds);

  for (const inv of nonTestRows) {
    const restoredCents = restoredCreditByInv.get(String(inv.id)) || 0;
    const enriched = restoredCents > 0 ? { ...inv, refund_restored_credit_cents: restoredCents } : inv;
    await syncSingleInvoiceRow(enriched, prepayInvoiceIds, prepayTermByInvoiceId, ctx);
  }

  await reconcileVoidedInvoices(conn, from, to, ctx, hasPayerStatements);
}

/**
 * Pure: determine earned revenue to recognize from 2300 Unearned Revenue when an
 * annual-prepay covered visit completes. Discounted prepay allocations (stamped
 * prepaid_amount or term prepay_amount / coverage_visit_count) always take priority
 * over undiscounted visit estimated_price, with embedded prepaid sales tax stripped
 * so 2300 clears cleanly to $0.00.
 */
function computePrepayVisitRecognitionCents(visit, term = null) {
  if (!visit) return 0;
  const prepayInv = term?.prepay_invoice || extractPrepayInvoiceFields(visit, 'prepay_inv');
  const termPrepay = safeNonNegCents(term?.prepay_amount ?? visit.term_prepay_amount);
  const prepaid = safeNonNegCents(visit.prepaid_amount);
  if (prepaid > 0) return stripPrepaidSalesTaxCents(prepaid, termPrepay, prepayInv);
  const visitCount = Math.trunc(Number(term?.coverage_visit_count ?? visit.coverage_visit_count) || 0);
  if (termPrepay > 0 && visitCount > 0) {
    return stripPrepaidSalesTaxCents(Math.round(termPrepay / visitCount), termPrepay, prepayInv);
  }
  const est = safeNonNegCents(visit.estimated_price);
  if (est > 0) return est;
  const monthly = safeNonNegCents(term?.monthly_rate ?? visit.term_monthly_rate);
  return monthly > 0 ? monthly : 0;
}

async function hasCoveredInvoiceForVisit(trx, visitId) {
  const row = await trx('invoices')
    .where({ scheduled_service_id: visitId })
    .whereNotNull('annual_prepay_covered_term_id')
    .whereNotIn('status', ['void', 'cancelled', 'canceled'])
    .whereNull('archived_at')
    .first('id');
  return Boolean(row);
}

/**
 * Pure: determine whether an annual-prepay term still holds valid paid coverage for
 * completed visits. End-at-term renewal cancellations (status = 'cancelled' with
 * cancel_disposition = 'end_at_term' or legacy renewal_decision = 'cancel') retain
 * paid coverage through term end unless the prepay invoice itself was voided/refunded.
 */
function isPrepayTermCoverageValid(term, prepayInv = null) {
  const status = String(term?.status || '').trim().toLowerCase();
  if (!status || status === 'void' || status === 'payment_pending') return false;
  const invStatus = prepayInv ? String(prepayInv.status || '').trim().toLowerCase() : null;
  if (invStatus && ['void', 'cancelled', 'canceled', 'refunded'].includes(invStatus)) return false;

  if (status === 'cancelled' || status === 'canceled') {
    const disp = term.cancel_disposition == null ? null : String(term.cancel_disposition).trim().toLowerCase();
    const dec = term.renewal_decision == null ? null : String(term.renewal_decision).trim().toLowerCase();
    const isEndAtTerm = disp === 'end_at_term' || (disp === null && dec === 'cancel');
    if (!isEndAtTerm) return false;
    if (prepayInv) {
      return ['paid', 'prepaid'].includes(invStatus) || prepayInv.paid_at != null;
    }
    return true;
  }
  return true;
}

function whereEndAtTermCancelled(q, { hasCancelDisp, hasRenewalDec }) {
  q.whereIn('apt.status', ['cancelled', 'canceled']);
  if (hasCancelDisp && hasRenewalDec) {
    q.where((disp) => {
      disp.where('apt.cancel_disposition', 'end_at_term')
        .orWhere((legacy) => legacy.whereNull('apt.cancel_disposition').where('apt.renewal_decision', 'cancel'));
    });
  } else if (hasCancelDisp) {
    q.where('apt.cancel_disposition', 'end_at_term');
  } else if (hasRenewalDec) {
    q.where('apt.renewal_decision', 'cancel');
  } else {
    q.whereRaw('1 = 0');
  }
  q.where((paid) => {
    paid.whereNull('apt.prepay_invoice_id')
      .orWhereIn('prepay_inv.status', ['paid', 'prepaid'])
      .orWhereNotNull('prepay_inv.paid_at');
  });
}

function wherePrepayTermEligible(q, caps) {
  q.where((st) => {
    st.whereNotIn('apt.status', EXCLUDED_PREPAY_TERM_STATUSES)
      .orWhere((endAtTerm) => whereEndAtTermCancelled(endAtTerm, caps));
  }).where((inv) => {
    inv.whereNull('apt.prepay_invoice_id')
      .orWhereRaw("LOWER(COALESCE(prepay_inv.status, 'paid')) NOT IN ('void', 'cancelled', 'canceled', 'refunded')");
  });
}

function whereCancelledTermRevoked(q, { hasCancelDisp, hasRenewalDec }) {
  q.whereIn('apt.status', ['cancelled', 'canceled']);
  const addUnpaidBranch = (sub) => {
    sub.orWhere((unpaid) => {
      unpaid.whereNotNull('apt.prepay_invoice_id')
        .whereRaw("LOWER(COALESCE(prepay_inv.status, '')) NOT IN ('paid', 'prepaid')")
        .whereNull('prepay_inv.paid_at');
    });
  };
  if (hasCancelDisp && hasRenewalDec) {
    q.where((notEndAtTerm) => {
      notEndAtTerm.whereRaw("apt.cancel_disposition IS NOT NULL AND apt.cancel_disposition <> 'end_at_term'")
        .orWhere((noDisp) => noDisp.whereNull('apt.cancel_disposition').whereRaw("COALESCE(apt.renewal_decision, '') <> 'cancel'"));
      addUnpaidBranch(notEndAtTerm);
    });
  } else if (hasCancelDisp) {
    q.where((notEndAtTerm) => {
      notEndAtTerm.whereRaw("COALESCE(apt.cancel_disposition, '') <> 'end_at_term'");
      addUnpaidBranch(notEndAtTerm);
    });
  } else if (hasRenewalDec) {
    q.where((notEndAtTerm) => {
      notEndAtTerm.whereRaw("COALESCE(apt.renewal_decision, '') <> 'cancel'");
      addUnpaidBranch(notEndAtTerm);
    });
  }
}

function wherePrepayTermRevoked(q, caps) {
  q.whereNull('apt.id')
    .orWhere((invRevoked) => {
      invRevoked.whereNotNull('apt.prepay_invoice_id')
        .whereRaw("LOWER(COALESCE(prepay_inv.status, '')) IN ('void', 'cancelled', 'canceled', 'refunded')");
    })
    .orWhereIn('apt.status', ['void', 'payment_pending'])
    .orWhere((cancelled) => whereCancelledTermRevoked(cancelled, caps));
}

async function syncCompletedAnnualPrepayVisits(conn, from, to, ctx) {
  const hasVisits = await conn.schema.hasTable('scheduled_services');
  const hasTerms = await conn.schema.hasTable('annual_prepay_terms');
  if (!hasVisits || !hasTerms) return;
  if (typeof conn.schema.hasColumn === 'function'
    && !(await conn.schema.hasColumn('scheduled_services', 'annual_prepay_term_id'))) {
    return;
  }

  const [hasCancelDisp, hasRenewalDec] = await Promise.all([
    hasSchemaColumn(conn, 'annual_prepay_terms', 'cancel_disposition'),
    hasSchemaColumn(conn, 'annual_prepay_terms', 'renewal_decision'),
  ]);
  const termCaps = { hasCancelDisp, hasRenewalDec };

  const visits = await conn('scheduled_services as ss')
    .join('annual_prepay_terms as apt', 'apt.id', 'ss.annual_prepay_term_id')
    .leftJoin('invoices as prepay_inv', 'prepay_inv.id', 'apt.prepay_invoice_id')
    .leftJoin('customers as c', 'c.id', 'ss.customer_id')
    .where('ss.status', 'completed')
    .whereNotNull('ss.annual_prepay_term_id')
    .where((eligible) => wherePrepayTermEligible(eligible, termCaps))
    .where((win) => {
      win.whereRaw(
        "COALESCE(DATE(ss.completed_at AT TIME ZONE 'America/New_York'), ss.scheduled_date) BETWEEN ?::date AND ?::date",
        [from, to],
      ).orWhereExists(function voidedSupersedingInvoiceInWindow() {
        this.select(conn.raw('1'))
          .from('invoices as vci')
          .whereRaw('vci.scheduled_service_id = ss.id')
          .whereNotNull('vci.annual_prepay_covered_term_id')
          .whereRaw("(vci.status IN ('void', 'cancelled', 'canceled') OR vci.archived_at IS NOT NULL)")
          .whereRaw("DATE(COALESCE(vci.archived_at, vci.updated_at) AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
      });
    })
    .whereNotExists(function coveredInvoiceExists() {
      this.select(conn.raw('1'))
        .from('invoices as ci')
        .whereRaw('ci.scheduled_service_id = ss.id')
        .whereNotNull('ci.annual_prepay_covered_term_id')
        .whereNotIn('ci.status', ['void', 'cancelled', 'canceled'])
        .whereNull('ci.archived_at');
    })
    .select(
      'ss.id', 'ss.customer_id', 'ss.annual_prepay_term_id', 'ss.service_type',
      'ss.prepaid_amount', 'ss.estimated_price', 'ss.completed_at',
      conn.raw('ss.scheduled_date::text as scheduled_date'),
      'apt.prepay_amount as term_prepay_amount', 'apt.monthly_rate as term_monthly_rate',
      'apt.coverage_visit_count',
      'prepay_inv.subtotal as prepay_inv_subtotal', 'prepay_inv.discount_amount as prepay_inv_discount',
      'prepay_inv.tax_amount as prepay_inv_tax', 'prepay_inv.total as prepay_inv_total',
      'prepay_inv.line_items as prepay_inv_line_items',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.property_type',
    );

  for (const visit of visits) {
    if (isTestCustomerRow(visit)) continue;
    const recognitionDate = timestampToEtDate(visit.completed_at) || dateCellText(visit.scheduled_date);
    const amountCents = computePrepayVisitRecognitionCents(visit);
    if (!recognitionDate || amountCents <= 0) continue;

    const isCommercial = isCommercialProperty(visit.property_type);
    const keyBase = `unearned-visit:${visit.id}`;
    const buildEntry = (idempotencyKey) => rules.buildUnearnedRecognitionEntry({
      sourceId: `covered-visit:${visit.id}`,
      idempotencyKey,
      recognitionDate,
      amountCents,
      serviceLine: isCommercial ? 'commercial' : (visit.service_type || 'pest'),
      isCommercial,
      customerId: visit.customer_id,
      scheduledServiceId: visit.id,
      memo: `Annual prepay covered visit completed (${visit.service_type || 'service'})`,
    });

    const applyVisit = async (trx) => {
      if (await hasCoveredInvoiceForVisit(trx, visit.id)) {
        ctx.stats.invoices.skipped += 1;
        return;
      }
      await postOrRepostSettlement(trx, { keyBase, buildEntry, ctx, bucket: 'invoices' });
    };

    if (ctx.dryRun) {
      await applyVisit(ctx.conn);
    } else {
      await withEntitySyncLock(ctx.conn, `gl-sync-prepay-visit:${visit.id}`, applyVisit);
    }
  }

  // Reverse any visit-level recognition whose visit was un-completed/canceled or whose term coverage was truly revoked
  // (preserving earned revenue on end-at-term renewal cancellations whose paid coverage remained valid).
  const revokedVisits = await conn('gl_journal_entries as e')
    .join('scheduled_services as ss', conn.raw("e.source_type = 'unearned_recognition' AND e.source_id = 'covered-visit:' || ss.id::text"))
    .leftJoin('annual_prepay_terms as apt', 'apt.id', 'ss.annual_prepay_term_id')
    .leftJoin('invoices as prepay_inv', 'prepay_inv.id', 'apt.prepay_invoice_id')
    .where('e.status', 'posted')
    .whereNull('e.reversed_by_entry_id')
    .where((sub) => {
      sub.where('ss.status', '<>', 'completed')
        .orWhereNull('ss.annual_prepay_term_id')
        .orWhere((revoked) => wherePrepayTermRevoked(revoked, termCaps));
    })
    .where((win) => {
      win.whereBetween('e.entry_date', [from, to])
        .orWhereRaw("DATE(ss.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to])
        .orWhereRaw("apt.updated_at IS NOT NULL AND DATE(apt.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
    })
    .select(
      'e.id', 'e.reversed_by_entry_id', conn.raw('e.entry_date::text as entry_date'),
      'ss.status as visit_status', 'ss.updated_at', 'apt.updated_at as term_updated_at',
    );

  for (const row of revokedVisits) {
    const revDate = timestampToEtDate(row.updated_at || row.term_updated_at) || dateCellText(row.entry_date);
    await reverseOrPreview(row, revDate, `Prepaid visit no longer covered (${row.visit_status})`, ctx, 'invoices');
  }
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
      const lockKey = pay.stripe_payment_intent_id
        ? `gl-sync-pi:${pay.stripe_payment_intent_id}`
        : `gl-sync-payment:${pay.id}`;
      await withEntitySyncLock(ctx.conn, lockKey, applyPayment);
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

async function hasGenuinePaymentRowForPi(conn, piId, hasPayments) {
  if (!piId || !hasPayments) return false;
  const row = await conn('payments')
    .where({ stripe_payment_intent_id: piId })
    .whereRaw("COALESCE(metadata->>'source', '') <> 'invoice_refund'")
    .first('id');
  return Boolean(row);
}

/**
 * Pure: recover settled gross + documented card surcharge for a paid Stripe invoice
 * that has no payments row so 1050 Stripe Clearing matches the payout while 1100 A/R clears to $0.00.
 */
function computeGapReceiptAmounts(inv) {
  const creditCents = safeNonNegCents(inv?.credit_applied);
  const principalDueCents = Math.max(0, billedInvoicePrincipalCents(inv) - creditCents);
  const settledGrossCents = Math.max(0, safeNonNegCents(inv?.total) - creditCents);
  const grossCents = Math.max(principalDueCents, settledGrossCents);
  const surchargeCents = Math.max(0, grossCents - principalDueCents);
  return { grossCents, surchargeCents };
}

async function postGapReceiptSerialized({ piId, fallbackKey, hasPayments, entry, ctx }) {
  const applyGap = async (trx) => {
    if (await hasGenuinePaymentRowForPi(trx, piId, hasPayments)) {
      ctx.stats.payments.skipped += 1;
      return;
    }
    if (await hasExistingPaymentEntryForPi(trx, piId)) {
      ctx.stats.payments.skipped += 1;
      return;
    }
    await postOrPreview(entry, ctx, 'payments', { connOverride: trx });
  };
  if (ctx.dryRun) {
    await applyGap(ctx.conn);
  } else {
    await withEntitySyncLock(ctx.conn, piId ? `gl-sync-pi:${piId}` : `gl-sync-payment:${fallbackKey}`, applyGap);
  }
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
    const { grossCents, surchargeCents } = computeGapReceiptAmounts(inv);
    const paymentDate = timestampToEtDate(inv.paid_at);
    if (!paymentDate || grossCents <= 0) continue;

    const serviceLine = isCommercialProperty(inv.property_type) ? 'commercial' : (inv.service_type || 'pest');
    const entry = rules.buildPaymentEntry({
      paymentId: `gap:${inv.id}`,
      idempotencyKey: `payment:gap:${inv.id}`,
      paymentDate,
      grossCents,
      feeCents: 0,
      surchargeCents,
      method: 'stripe',
      invoiceId: inv.id,
      customerId: inv.customer_id,
      serviceLine,
      reference: inv.stripe_payment_intent_id,
      memo: 'Stripe receipt (invoice gap recovery)',
    });
    await postGapReceiptSerialized({
      piId: inv.stripe_payment_intent_id,
      fallbackKey: `gap:${inv.id}`,
      hasPayments,
      entry,
      ctx,
    });
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
    const grossCents = dollarsToCents(m.amount);
    const paymentDate = timestampToEtDate(m.paid_at) || dateCellText(m.payment_date);
    if (!paymentDate || !grossCents || grossCents <= 0) continue;

    const serviceLine = isCommercialProperty(m.property_type) ? 'commercial' : (m.service_type || null);
    const entry = rules.buildPaymentEntry({
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
    });
    await postGapReceiptSerialized({
      piId: m.stripe_payment_intent_id,
      fallbackKey: `gap:${m.invoice_id || m.id}`,
      hasPayments: true,
      entry,
      ctx,
    });
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
    const rec = map.get(key) || { grossCents: 0, taxCents: 0, unearnedCents: 0 };
    const dr = Number(r.debit_cents);
    const cr = Number(r.credit_cents);
    if (r.code === SYSTEM_CODES.REV_REFUNDS_ALLOWANCES) rec.grossCents += (dr - cr);
    if (r.code === SYSTEM_CODES.UNEARNED_REVENUE) {
      rec.grossCents += (dr - cr);
      rec.unearnedCents += (dr - cr);
    }
    if (r.code === SYSTEM_CODES.SALES_TAX_PAYABLE) {
      rec.grossCents += (dr - cr);
      rec.taxCents += (dr - cr);
    }
    map.set(key, rec);
  }
  return map;
}

/**
 * Pure: allocate how much of a pre-tax refund (or refund reversal) on an annual-prepay
 * invoice should release (or restore) 2300 Unearned Revenue vs 4090 Refunds & Allowances.
 */
function computePrepayRefundUnearnedCents({
  isAnnualPrepay,
  isReversal,
  subtotalCents,
  originalUnearnedCents,
  recognizedCents = 0,
  priorUnearnedRefundedCents = 0,
}) {
  if (!isAnnualPrepay || subtotalCents <= 0) return 0;
  if (isReversal) {
    return Math.min(subtotalCents, Math.max(0, Math.trunc(Number(priorUnearnedRefundedCents) || 0)));
  }
  const remaining = Math.max(
    0,
    Math.trunc(Number(originalUnearnedCents) || 0)
      - Math.max(0, Math.trunc(Number(recognizedCents) || 0))
      - Math.max(0, Math.trunc(Number(priorUnearnedRefundedCents) || 0)),
  );
  return Math.min(subtotalCents, remaining);
}

async function loadRecognizedUnearnedForTerm(conn, termId) {
  if (!termId) return 0;
  const sourceIds = [];
  if (await conn.schema.hasTable('invoices')) {
    const covInvs = await conn('invoices')
      .where({ annual_prepay_covered_term_id: termId })
      .select('id');
    for (const ci of covInvs) {
      sourceIds.push(String(ci.id), `covered-inv:${ci.id}`);
    }
  }
  if (await conn.schema.hasTable('scheduled_services')) {
    const visits = await conn('scheduled_services')
      .where({ annual_prepay_term_id: termId })
      .select('id');
    for (const v of visits) sourceIds.push(`covered-visit:${v.id}`);
  }
  if (!sourceIds.length) return 0;

  const row = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where('e.status', 'posted')
    .whereNull('e.reversed_by_entry_id')
    .where('a.code', SYSTEM_CODES.UNEARNED_REVENUE)
    .whereIn('e.source_type', ['invoice', 'unearned_recognition'])
    .whereIn('e.source_id', sourceIds)
    .first(conn.raw('COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint as recognized_cents'));
  return Math.max(0, Math.trunc(Number(row?.recognized_cents) || 0));
}

async function resolveRefundUnearnedCents(trx, linkedInv, { isReversal, subtotalCents, priorUnearnedCents }) {
  if (!linkedInv?.is_annual_prepay || subtotalCents <= 0) return 0;
  const originalUnearnedCents = Math.max(
    0,
    billedInvoicePrincipalCents(linkedInv) + invoiceDepositCreditCents(linkedInv) - safeNonNegCents(linkedInv.tax_amount),
  );
  const recognizedCents = isReversal
    ? 0
    : await loadRecognizedUnearnedForTerm(trx, linkedInv.resolved_prepay_term_id);
  return computePrepayRefundUnearnedCents({
    isAnnualPrepay: true,
    isReversal,
    subtotalCents,
    originalUnearnedCents,
    recognizedCents,
    priorUnearnedRefundedCents: priorUnearnedCents,
  });
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

const OUTFLOW_SOURCE_TYPES = [
  'refund', 'refund_reversal', 'deposit_refund', 'deposit_refund_reversal', 'dispute', 'dispute_reversal',
];

function isDisputeOutflow(row) {
  const cat = String(row?.reporting_category || '').trim().toLowerCase();
  if (cat === 'dispute' || cat === 'dispute_reversal') return true;
  return /dispute/i.test(String(row?.type || ''));
}

function proratedDisputeSurchargeCents(row, absCents) {
  const payGross = safeNonNegCents(row.payment_amount);
  if (payGross <= 0) return 0;
  const fullSurcharge = extractSurchargeCents({
    amount: row.payment_amount,
    surcharge_amount_cents: row.payment_surcharge_cents,
    base_amount_cents: row.payment_base_cents,
    metadata: row.payment_metadata,
  }, payGross);
  if (fullSurcharge <= 0) return 0;
  if (absCents >= payGross) return Math.min(fullSurcharge, absCents - 1);
  const part = Math.round((absCents * fullSurcharge) / payGross);
  return part > 0 && part < absCents ? part : 0;
}

async function findExistingOutflowEntryByTxn(conn, txnKey) {
  const existing = await conn('gl_journal_entries')
    .where({ reference: String(txnKey), status: 'posted' })
    .whereIn('source_type', OUTFLOW_SOURCE_TYPES)
    .whereNull('reversed_by_entry_id')
    .first('id', 'idempotency_key', 'reversed_by_entry_id', conn.raw('entry_date::text as entry_date'));
  if (!existing) return null;
  const lines = await conn('gl_journal_lines as l')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where('l.entry_id', existing.id)
    .select('a.code as account_code', 'l.debit_cents', 'l.credit_cents', 'l.invoice_ref');
  return { ...existing, lines };
}

/**
 * Atomically deduplicate & reclassify a Stripe outflow by `stripe_txn_id` so an outflow
 * initially booked as an unlinked refund that later matches a deposit or dispute never
 * posts a second cash credit to 1050 Stripe Clearing.
 */
async function applyOutflowEntryAtomic(trx, txnKey, entry, entryDate, ctx) {
  const prior = await findExistingOutflowEntryByTxn(trx, txnKey);
  let reversedPrior = false;
  if (prior) {
    if (prior.idempotency_key === entry.idempotencyKey
      || paymentLineSignature(prior.lines) === paymentLineSignature(entry.lines)) {
      ctx.stats.refunds.skipped += 1;
      return false;
    }
    reversedPrior = await reverseOrPreview(
      prior,
      entryDate,
      `Reclassified Stripe outflow ${txnKey}`,
      ctx,
      'refunds',
      { connOverride: trx },
    );
    if (!reversedPrior) return false;
  }
  const posted = await postOrPreview(entry, ctx, 'refunds', { connOverride: trx });
  if (reversedPrior && !posted && !ctx.dryRun) {
    ctx.stats.refunds.reversed = Math.max(0, ctx.stats.refunds.reversed - 1);
    const err = new Error('ABORT_OUTFLOW_RECLASS');
    err.code = 'ABORT_OUTFLOW_RECLASS';
    throw err;
  }
  return posted;
}

async function runWithOutflowLock(conn, lockKey, dryRun, fn) {
  if (dryRun) return fn(conn);
  try {
    return await withEntitySyncLock(conn, lockKey, fn);
  } catch (err) {
    if (err?.code === 'ABORT_OUTFLOW_RECLASS') return false;
    throw err;
  }
}

async function tryHandleUnlinkedDepositOutflow({ row, absCents, amountCents, txnKey, entryDate, customerId, reason, depositMaps, ctx }) {
  const depCheck = findMatchingDepositForOutflow(row, absCents, depositMaps);
  if (depCheck.deposit) {
    const entry = buildDepositOutflowEntry(depCheck.deposit, txnKey, amountCents, entryDate, customerId, reason);
    await runWithOutflowLock(ctx.conn, `gl-sync-outflow:${txnKey}`, ctx.dryRun, (trx) => (
      applyOutflowEntryAtomic(trx, txnKey, entry, entryDate, ctx)
    ));
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

function buildDisputeOutflowEntry({ row, linkedInv, stmtChildren, amountCents, absCents, txnKey, entryDate, customerId, reason }) {
  const surchargeCents = proratedDisputeSurchargeCents(row, absCents);
  const principalCents = absCents - surchargeCents;
  const arAllocations = stmtChildren
    ? allocateStatementPrincipalAcrossInvoices(principalCents, stmtChildren)
    : null;
  const isCommercial = isCommercialProperty(linkedInv?.property_type || row.property_type);
  const common = {
    txnId: txnKey,
    grossCents: absCents,
    surchargeCents,
    customerId,
    invoiceId: arAllocations ? null : (linkedInv?.id || null),
    arAllocations,
    serviceLine: isCommercial ? 'commercial' : (linkedInv?.service_type || null),
    reference: txnKey,
    reason,
  };
  return amountCents < 0
    ? rules.buildDisputeWithdrawalEntry({ ...common, idempotencyKey: `dispute:spt:${txnKey}`, disputeDate: entryDate })
    : rules.buildDisputeReinstatementEntry({ ...common, idempotencyKey: `dispute-reversal:spt:${txnKey}`, reversalDate: entryDate });
}

function buildOutflowRefundEntry({ row, linkedInv, amountCents, absCents, taxCents, unearnedCents = 0, txnKey, expectedKey, entryDate, customerId, reason }) {
  const isCommercial = isCommercialProperty(linkedInv?.property_type || row.property_type);
  const common = {
    subtotalCents: absCents - taxCents,
    unearnedCents,
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

function extractStripeDisputeTokens(description) {
  const text = String(description || '');
  return {
    disputeId: /\b((?:dp|du)_[A-Za-z0-9]+)\b/.exec(text)?.[1] || null,
    chargeId: /\b((?:ch|py)_[A-Za-z0-9]+)\b/.exec(text)?.[1] || null,
    piId: /\b(pi_[A-Za-z0-9]+)\b/.exec(text)?.[1] || null,
  };
}

async function lookupPaymentForUnlinkedDispute(conn, row, absCents) {
  if (!(await conn.schema.hasTable('payments'))) return null;
  const { disputeId, chargeId, piId } = extractStripeDisputeTokens(row.description);
  const selectCols = [
    'id', 'customer_id', 'amount', 'base_amount_cents', 'surcharge_amount_cents',
    'statement_id', 'metadata', 'stripe_payment_intent_id', 'stripe_charge_id',
  ];

  if (disputeId || chargeId || piId) {
    const matched = await conn('payments')
      .whereNot('status', 'canceled')
      .where((q) => {
        if (disputeId) q.orWhereRaw("metadata->>'dispute_id' = ?", [disputeId]);
        if (chargeId) q.orWhere('stripe_charge_id', chargeId);
        if (piId) q.orWhere('stripe_payment_intent_id', piId);
      })
      .select(...selectCols);
    if (matched.length === 1) return matched[0];
  }

  // Fallback: exact cent match against a unique disputed payments row (never guess if ambiguous).
  const byAmt = await conn('payments')
    .where((q) => q.where('status', 'disputed').orWhereRaw("metadata->>'dispute_id' IS NOT NULL"))
    .whereRaw('ROUND(amount * 100) = ?', [absCents])
    .select(...selectCols);
  return byAmt.length === 1 ? byAmt[0] : null;
}

async function resolveDisputeContext(conn, row, absCents, invoiceMaps, stmtMap) {
  let effectiveRow = row;
  let linkedInv = resolveOutflowLinkedInvoice(effectiveRow, invoiceMaps);
  let stmtChildren = effectiveRow.payment_statement_id != null
    ? stmtMap.get(String(effectiveRow.payment_statement_id))
    : null;
  if (linkedInv || stmtChildren) return { effectiveRow, linkedInv, stmtChildren };

  const pay = await lookupPaymentForUnlinkedDispute(conn, row, absCents);
  if (!pay) return { effectiveRow, linkedInv: null, stmtChildren: null };

  effectiveRow = {
    ...row,
    payment_id: pay.id,
    payment_customer_id: pay.customer_id,
    payment_amount: pay.amount,
    payment_base_cents: pay.base_amount_cents,
    payment_surcharge_cents: pay.surcharge_amount_cents,
    payment_statement_id: pay.statement_id,
    payment_metadata: pay.metadata,
    payment_pi: pay.stripe_payment_intent_id,
  };
  if (pay.statement_id != null) {
    const loadedStmt = await loadStatementChildInvoices(conn, [pay.statement_id]);
    stmtChildren = loadedStmt.get(String(pay.statement_id)) || null;
  }
  const meta = parseJsonObject(pay.metadata);
  const invIds = [meta.invoice_id, meta.dispute_invoice_id].filter(Boolean);
  const pis = pay.stripe_payment_intent_id ? [pay.stripe_payment_intent_id] : [];
  if (!stmtChildren && (invIds.length || pis.length)) {
    const loadedInvs = await loadInvoicesForLinks(conn, invIds, pis);
    linkedInv = resolveOutflowLinkedInvoice(effectiveRow, loadedInvs);
  }
  return { effectiveRow, linkedInv, stmtChildren };
}

async function handleDisputeOutflowRow({ row, absCents, amountCents, txnKey, entryDate, reason, invoiceMaps, depositMaps, stmtMap, ctx }) {
  const { effectiveRow, linkedInv, stmtChildren } = await resolveDisputeContext(ctx.conn, row, absCents, invoiceMaps, stmtMap);
  const customerId = effectiveRow.customer_id || effectiveRow.payment_customer_id || null;
  if (linkedInv || stmtChildren) {
    const disputeEntry = buildDisputeOutflowEntry({
      row: effectiveRow, linkedInv, stmtChildren, amountCents, absCents, txnKey, entryDate, customerId, reason,
    });
    await runWithOutflowLock(ctx.conn, `gl-sync-outflow:${txnKey}`, ctx.dryRun, (trx) => (
      applyOutflowEntryAtomic(trx, txnKey, disputeEntry, entryDate, ctx)
    ));
    return;
  }
  const handledDeposit = await tryHandleUnlinkedDepositOutflow({
    row: effectiveRow, absCents, amountCents, txnKey, entryDate, customerId, reason, depositMaps, ctx,
  });
  if (handledDeposit) return;

  // Fail closed: never post an unresolved dispute as a contra-revenue refund (would understate revenue and drive A/R negative on re-payment).
  ctx.stats.refunds.needs_review.push({
    txn_id: txnKey,
    customer_id: customerId,
    amount_cents: absCents,
    reporting_category: row.reporting_category || row.type || 'dispute',
    reason: 'Unresolved Stripe dispute — link to disputed payment/invoice before posting so 1100 A/R stays accurate',
  });
}

/**
 * Pure: allocate a payer-statement refund (or refund reversal) across its child invoices
 * with cumulative per-child FL sales-tax allocation so statement refunds reverse the exact
 * pass-through tax accrued on taxable commercial child invoices without over-reversing.
 */
function allocateStatementRefundAcrossInvoices({ absCents, childInvoices, priorByInvoice = new Map(), isReversal = false }) {
  if (!Array.isArray(childInvoices) || !childInvoices.length || !(absCents > 0)) return null;
  const weighted = childInvoices
    .map((child) => {
      const prior = priorByInvoice.get(String(child.id)) || { grossCents: 0, taxCents: 0, unearnedCents: 0 };
      const due = Math.max(0, billedInvoicePrincipalCents(child) - safeNonNegCents(child.credit_applied));
      const weight = isReversal ? (prior.grossCents > 0 ? prior.grossCents : 0) : due;
      return { child, prior, due, weight };
    });
  const useFallbackDue = weighted.every((w) => w.weight <= 0);
  const active = weighted
    .map((w) => ({ ...w, effWeight: useFallbackDue ? w.due : w.weight }))
    .filter((w) => w.effWeight > 0);
  if (!active.length) return null;

  const weightTotal = active.reduce((s, w) => s + w.effWeight, 0);
  let remaining = absCents;
  const allocations = [];
  for (let i = 0; i < active.length; i += 1) {
    const item = active[i];
    const part = i === active.length - 1
      ? remaining
      : Math.min(remaining, Math.round((absCents * item.effWeight) / weightTotal));
    remaining -= part;
    if (part <= 0) continue;

    const signedDelta = isReversal ? -part : part;
    const taxCents = computeIncrementalRefundTaxCents(item.prior.grossCents, item.prior.taxCents, signedDelta, item.child, null);
    const isCommercial = isCommercialProperty(item.child.property_type);
    allocations.push({
      invoiceId: item.child.id,
      customerId: item.child.customer_id || null,
      serviceLine: isCommercial ? 'commercial' : (item.child.service_type || 'pest'),
      subtotalCents: part - taxCents,
      unearnedCents: 0,
      taxCents,
      grossCents: part,
    });
  }
  return allocations.length ? allocations : null;
}

function buildStatementOutflowRefundEntry({ allocations, amountCents, txnKey, expectedKey, entryDate, customerId, reason }) {
  const common = {
    allocations,
    method: 'stripe',
    customerId,
    reference: txnKey,
    reason,
  };
  return amountCents < 0
    ? rules.buildRefundEntry({ ...common, refundId: txnKey, idempotencyKey: expectedKey, refundDate: entryDate })
    : rules.buildRefundReversalEntry({ ...common, txnId: txnKey, idempotencyKey: expectedKey, reversalDate: entryDate });
}

async function loadCombinedPaymentShares(conn, rows) {
  const byPi = new Map();
  if (!(await conn.schema.hasTable('payments'))) return byPi;
  const candidatePis = [...new Set(
    (rows || [])
      .filter((r) => !r.invoice_id && r.payment_pi)
      .map((r) => String(r.payment_pi)),
  )];
  if (!candidatePis.length) return byPi;

  const payRows = await conn('payments')
    .whereIn('stripe_payment_intent_id', candidatePis)
    .whereNot('status', 'canceled')
    .whereRaw("COALESCE(metadata->>'source', '') <> 'invoice_refund'")
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .select('id', 'stripe_payment_intent_id', 'amount', 'base_amount_cents', 'surcharge_amount_cents', 'customer_id', 'metadata');

  const grouped = new Map();
  for (const p of payRows) {
    const pi = String(p.stripe_payment_intent_id || '');
    if (!pi) continue;
    const list = grouped.get(pi) || [];
    list.push(p);
    grouped.set(pi, list);
  }

  const shareInvIds = [];
  const multiGroups = [];
  for (const [pi, list] of grouped.entries()) {
    if (list.length <= 1) continue;
    multiGroups.push([pi, list]);
    for (const p of list) {
      const meta = parseJsonObject(p.metadata);
      if (meta.invoice_id) shareInvIds.push(meta.invoice_id);
    }
  }
  if (!multiGroups.length || !shareInvIds.length) return byPi;

  const invMaps = await loadInvoicesForLinks(conn, shareInvIds, []);
  for (const [pi, list] of multiGroups) {
    const shares = [];
    for (const p of list) {
      const meta = parseJsonObject(p.metadata);
      const invoice = meta.invoice_id ? invMaps.byId.get(String(meta.invoice_id)) : null;
      const shareCents = safeNonNegCents(p.amount);
      if (invoice && shareCents > 0) {
        shares.push({ invoice, shareCents, paymentAmount: p.amount });
      }
    }
    if (shares.length > 1) byPi.set(pi, shares);
  }
  return byPi;
}

/**
 * Pure: allocate a combined-charge refund (or refund reversal) across every invoice share
 * covered by the combined PaymentIntent with cumulative per-invoice sales-tax allocation.
 */
function allocateCombinedRefundAcrossShares({ absCents, shares, priorByInvoice = new Map(), isReversal = false }) {
  if (!Array.isArray(shares) || !shares.length || !(absCents > 0)) return null;
  const weighted = shares.map((s) => {
    const inv = s.invoice;
    const prior = priorByInvoice.get(String(inv.id)) || { grossCents: 0, taxCents: 0, unearnedCents: 0 };
    const shareAmt = Math.max(0, Math.trunc(Number(s.shareCents) || 0)) || billedInvoicePrincipalCents(inv);
    const weight = isReversal ? (prior.grossCents > 0 ? prior.grossCents : 0) : shareAmt;
    return { share: s, inv, prior, shareAmt, weight };
  });
  const useFallbackShare = weighted.every((w) => w.weight <= 0);
  const active = weighted
    .map((w) => ({ ...w, effWeight: useFallbackShare ? w.shareAmt : w.weight }))
    .filter((w) => w.effWeight > 0);
  if (!active.length) return null;

  const weightTotal = active.reduce((s, w) => s + w.effWeight, 0);
  let remaining = absCents;
  const allocations = [];
  for (let i = 0; i < active.length; i += 1) {
    const item = active[i];
    const part = i === active.length - 1
      ? remaining
      : Math.min(remaining, Math.round((absCents * item.effWeight) / weightTotal));
    remaining -= part;
    if (part <= 0) continue;

    const signedDelta = isReversal ? -part : part;
    const taxCents = computeIncrementalRefundTaxCents(
      item.prior.grossCents, item.prior.taxCents, signedDelta, item.inv, item.share.paymentAmount,
    );
    const isCommercial = isCommercialProperty(item.inv.property_type);
    allocations.push({
      invoiceId: item.inv.id,
      customerId: item.inv.customer_id || null,
      serviceLine: isCommercial ? 'commercial' : (item.inv.service_type || 'pest'),
      subtotalCents: part - taxCents,
      unearnedCents: 0,
      taxCents,
      grossCents: part,
    });
  }
  return allocations.length ? allocations : null;
}

async function enrichPrepayUnearnedOnAllocations(trx, allocations, invoiceById, priorMap, isReversal) {
  const out = [];
  for (const a of allocations || []) {
    const inv = invoiceById.get(String(a.invoiceId));
    if (!inv?.is_annual_prepay || a.subtotalCents <= 0) {
      out.push(a);
      continue;
    }
    const priorUnearnedCents = priorMap.get(String(a.invoiceId))?.unearnedCents || 0;
    const unearnedCents = await resolveRefundUnearnedCents(trx, inv, {
      isReversal,
      subtotalCents: a.subtotalCents,
      priorUnearnedCents,
    });
    out.push({ ...a, unearnedCents });
  }
  return out;
}

function updateDryRunStatementRefundCache(cumRefundsByInvoice, allocations, isReversal) {
  for (const a of allocations || []) {
    const k = String(a.invoiceId);
    const prev = cumRefundsByInvoice.get(k) || { grossCents: 0, taxCents: 0, unearnedCents: 0 };
    const sign = isReversal ? -1 : 1;
    cumRefundsByInvoice.set(k, {
      grossCents: Math.max(0, prev.grossCents + sign * a.grossCents),
      taxCents: Math.max(0, prev.taxCents + sign * a.taxCents),
      unearnedCents: Math.max(0, (prev.unearnedCents || 0) + sign * (a.unearnedCents || 0)),
    });
  }
}

async function applyMultiInvoiceOutflowRefund({ trx, combinedShares, stmtChildren, amountCents, absCents, txnKey, expectedKey, entryDate, customerId, reason, cumRefundsByInvoice, ctx }) {
  const isReversal = amountCents > 0;
  const invList = combinedShares?.length > 1
    ? combinedShares.map((s) => s.invoice)
    : (stmtChildren || []);
  const childIds = invList.map((c) => String(c.id));
  const priorMap = ctx.dryRun
    ? cumRefundsByInvoice
    : await loadPriorRefundTotalsByInvoice(trx, childIds);
  const rawAllocs = combinedShares?.length > 1
    ? allocateCombinedRefundAcrossShares({ absCents, shares: combinedShares, priorByInvoice: priorMap, isReversal })
    : allocateStatementRefundAcrossInvoices({ absCents, childInvoices: stmtChildren, priorByInvoice: priorMap, isReversal });
  if (!rawAllocs) return { handled: false, posted: false };

  const invById = new Map(invList.map((inv) => [String(inv.id), inv]));
  const allocations = await enrichPrepayUnearnedOnAllocations(trx, rawAllocs, invById, priorMap, isReversal);
  const entry = buildStatementOutflowRefundEntry({
    allocations, amountCents, txnKey, expectedKey, entryDate, customerId, reason,
  });
  const posted = await applyOutflowEntryAtomic(trx, txnKey, entry, entryDate, ctx);
  if (posted && ctx.dryRun) {
    updateDryRunStatementRefundCache(cumRefundsByInvoice, allocations, isReversal);
  }
  return { handled: true, posted };
}

function resolveOutflowLockKey({ combinedShares, row, invKey, stmtChildren, txnKey }) {
  if (combinedShares?.length > 1) return `gl-sync-refund-pi:${row.payment_pi}`;
  if (invKey) return `gl-sync-refund-inv:${invKey}`;
  if (stmtChildren?.length) return `gl-sync-refund-stmt:${row.payment_statement_id}`;
  return `gl-sync-outflow:${txnKey}`;
}

async function applySingleInvoiceOutflowRefund({ trx, row, linkedInv, invKey, amountCents, absCents, txnKey, expectedKey, entryDate, customerId, reason, cumRefundsByInvoice, ctx }) {
  let cum = { grossCents: 0, taxCents: 0, unearnedCents: 0 };
  if (invKey) {
    if (ctx.dryRun) {
      cum = cumRefundsByInvoice.get(invKey) || cum;
    } else {
      const freshMap = await loadPriorRefundTotalsByInvoice(trx, [invKey]);
      cum = freshMap.get(invKey) || cum;
    }
  }
  const signedDelta = amountCents < 0 ? absCents : -absCents;
  const taxCents = computeIncrementalRefundTaxCents(cum.grossCents, cum.taxCents, signedDelta, linkedInv, row.payment_amount);
  const subtotalCents = absCents - taxCents;
  const unearnedCents = await resolveRefundUnearnedCents(trx, linkedInv, {
    isReversal: amountCents > 0,
    subtotalCents,
    priorUnearnedCents: cum.unearnedCents || 0,
  });
  const entry = buildOutflowRefundEntry({
    row, linkedInv, amountCents, absCents, taxCents, unearnedCents, txnKey, expectedKey, entryDate, customerId, reason,
  });
  const posted = await applyOutflowEntryAtomic(trx, txnKey, entry, entryDate, ctx);
  if (posted && invKey && ctx.dryRun) {
    const sign = amountCents < 0 ? 1 : -1;
    cumRefundsByInvoice.set(invKey, {
      grossCents: Math.max(0, cum.grossCents + signedDelta),
      taxCents: Math.max(0, cum.taxCents + sign * taxCents),
      unearnedCents: Math.max(0, (cum.unearnedCents || 0) + sign * unearnedCents),
    });
  }
  return posted;
}

function resolveOutflowTarget(row, invoiceMaps, stmtMap, combinedSharesByPi) {
  const combinedShares = !row.invoice_id && row.payment_pi
    ? combinedSharesByPi.get(String(row.payment_pi))
    : null;
  const hasCombined = Boolean(combinedShares?.length > 1);
  const linkedInv = hasCombined ? null : resolveOutflowLinkedInvoice(row, invoiceMaps);
  const stmtChildren = !linkedInv && !hasCombined && row.payment_statement_id != null
    ? stmtMap.get(String(row.payment_statement_id))
    : null;
  return {
    combinedShares: hasCombined ? combinedShares : null,
    linkedInv,
    stmtChildren: stmtChildren?.length ? stmtChildren : null,
    isUnlinked: !linkedInv && !hasCombined && row.payment_statement_id == null,
  };
}

async function syncSingleOutflowRow(row, invoiceMaps, depositMaps, stmtMap, combinedSharesByPi, cumRefundsByInvoice, ctx) {
  const amountCents = dollarsToCents(row.amount);
  const entryDate = timestampToEtDate(row.created_at_stripe);
  if (!entryDate || !amountCents) return;

  const absCents = Math.abs(amountCents);
  const txnKey = row.stripe_txn_id || row.id;
  const customerId = row.customer_id || row.payment_customer_id || null;
  const reason = row.description
    ? String(row.description).slice(0, 300)
    : `Stripe ${row.reporting_category || row.type || 'refund'}`;

  if (isDisputeOutflow(row)) {
    await handleDisputeOutflowRow({
      row, absCents, amountCents, txnKey, entryDate, reason, invoiceMaps, depositMaps, stmtMap, ctx,
    });
    return;
  }

  const { combinedShares, linkedInv, stmtChildren, isUnlinked } = resolveOutflowTarget(
    row, invoiceMaps, stmtMap, combinedSharesByPi,
  );
  if (isUnlinked) {
    const handled = await tryHandleUnlinkedDepositOutflow({
      row, absCents, amountCents, txnKey, entryDate, customerId, reason, depositMaps, ctx,
    });
    if (handled) return;
  }

  const expectedKey = amountCents < 0 ? `refund:spt:${txnKey}` : `refund-reversal:spt:${txnKey}`;
  const invKey = linkedInv ? String(linkedInv.id) : null;
  const lockKey = resolveOutflowLockKey({ combinedShares, row, invKey, stmtChildren, txnKey });

  await runWithOutflowLock(ctx.conn, lockKey, ctx.dryRun, async (trx) => {
    const existing = await trx('gl_journal_entries').where({ idempotency_key: expectedKey }).first('id');
    if (existing) {
      ctx.stats.refunds.skipped += 1;
      return false;
    }

    if (combinedShares || stmtChildren) {
      const multiRes = await applyMultiInvoiceOutflowRefund({
        trx, combinedShares, stmtChildren, amountCents, absCents, txnKey, expectedKey, entryDate, customerId, reason, cumRefundsByInvoice, ctx,
      });
      if (multiRes.handled) return multiRes.posted;
    }

    return applySingleInvoiceOutflowRefund({
      trx, row, linkedInv, invKey, amountCents, absCents, txnKey, expectedKey, entryDate, customerId, reason, cumRefundsByInvoice, ctx,
    });
  });
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
      'lp.base_amount_cents as payment_base_cents', 'lp.surcharge_amount_cents as payment_surcharge_cents',
      'lp.statement_id as payment_statement_id',
      'lp.metadata as payment_metadata', 'lp.stripe_payment_intent_id as payment_pi',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.property_type',
    );

  const nonTestRows = rows.filter((r) => !isTestCustomerRow({
    ...r,
    customer_id: r.customer_id || r.payment_customer_id,
  }));
  const { ids, pis, customerIds } = collectOutflowInvoiceRefs(nonTestRows);
  const statementIds = [...new Set(nonTestRows.map((r) => r.payment_statement_id).filter((id) => id != null))];
  const [invoiceMaps, depositMaps, stmtMap, combinedSharesByPi] = await Promise.all([
    loadInvoicesForLinks(conn, ids, pis),
    loadDepositsForOutflows(conn, customerIds),
    loadStatementChildInvoices(conn, statementIds),
    loadCombinedPaymentShares(conn, nonTestRows),
  ]);
  const stmtChildIds = [...stmtMap.values()].flat().map((c) => String(c.id));
  const combinedInvIds = [...combinedSharesByPi.values()].flat().map((s) => String(s.invoice.id));
  const resolvedInvIds = [...new Set([...invoiceMaps.byId.keys(), ...stmtChildIds, ...combinedInvIds])];
  const cumRefundsByInvoice = ctx.dryRun
    ? await loadPriorRefundTotalsByInvoice(conn, resolvedInvIds)
    : new Map();

  for (const row of nonTestRows) {
    await syncSingleOutflowRow(row, invoiceMaps, depositMaps, stmtMap, combinedSharesByPi, cumRefundsByInvoice, ctx);
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
      'p.stripe_payment_intent_id', 'p.stripe_charge_id', 'p.statement_id', 'p.metadata',
      conn.raw('p.payment_date::text as payment_date'), 'p.refunded_at',
      'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.property_type',
    );

  const nonTestRows = rows.filter((r) => !isTestCustomerRow(r));
  if (!nonTestRows.length) return;
  const auditMarkers = await loadManualPaymentAuditMarkers(conn, nonTestRows.map((r) => r.id));
  const { ids, pis, statementIds } = collectPaymentInvoiceRefs(nonTestRows, auditMarkers);
  const [invoiceMaps, stmtMap] = await Promise.all([
    loadInvoicesForLinks(conn, ids, pis),
    loadStatementChildInvoices(conn, statementIds),
  ]);

  for (const pay of nonTestRows) {
    const cumRefundCents = safeNonNegCents(pay.refund_amount);
    const refundDate = timestampToEtDate(pay.refunded_at) || dateCellText(pay.payment_date);
    if (!refundDate || cumRefundCents <= 0) continue;

    const marker = auditMarkers.get(String(pay.id)) || null;
    const linkedInv = linkedInvoiceForPayment(pay, invoiceMaps, marker);
    const stmtChildren = !linkedInv && pay.statement_id != null ? stmtMap.get(String(pay.statement_id)) : null;
    const lockKey = linkedInv
      ? `gl-sync-refund-inv:${linkedInv.id}`
      : (stmtChildren?.length ? `gl-sync-refund-stmt:${pay.statement_id}` : `gl-sync-manual-refund:${pay.id}`);

    const applyManualRefund = async (trx) => {
      const priorRow = await trx('gl_journal_lines as l')
        .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
        .where('e.status', 'posted')
        .where('e.source_type', 'refund')
        .whereNull('e.reversed_by_entry_id')
        .where((q) => {
          q.where('e.idempotency_key', `refund:manual:${pay.id}`)
            .orWhere('e.idempotency_key', 'like', `refund:manual:${pay.id}:%`);
        })
        .first(trx.raw('COALESCE(SUM(l.credit_cents), 0)::bigint as booked_cents'));

      const alreadyBooked = Math.trunc(Number(priorRow?.booked_cents) || 0);
      const deltaCents = cumRefundCents - alreadyBooked;
      if (deltaCents <= 0) {
        ctx.stats.refunds.skipped += 1;
        return;
      }

      const method = resolvePaymentMethod(pay, linkedInv, marker);
      if (stmtChildren?.length) {
        const priorStmtMap = await loadPriorRefundTotalsByInvoice(trx, stmtChildren.map((c) => String(c.id)));
        const allocations = allocateStatementRefundAcrossInvoices({
          absCents: deltaCents,
          childInvoices: stmtChildren,
          priorByInvoice: priorStmtMap,
          isReversal: false,
        });
        if (allocations) {
          await postOrPreview(rules.buildRefundEntry({
            refundId: `manual:${pay.id}:${cumRefundCents}`,
            idempotencyKey: `refund:manual:${pay.id}:${cumRefundCents}`,
            refundDate,
            allocations,
            method,
            customerId: pay.customer_id,
            reference: pay.id,
            reason: `Manual statement refund (${method})`,
          }), ctx, 'refunds', { connOverride: trx });
          return;
        }
      }

      const cumTax = computeProratedRefundTaxCents(cumRefundCents, linkedInv, pay.amount);
      const prevTax = computeProratedRefundTaxCents(alreadyBooked, linkedInv, pay.amount);
      const deltaTax = Math.max(0, Math.min(deltaCents, cumTax - prevTax));
      const subtotalCents = deltaCents - deltaTax;
      const priorInvTotals = linkedInv ? await loadPriorRefundTotalsByInvoice(trx, [linkedInv.id]) : new Map();
      const priorUnearnedCents = linkedInv ? (priorInvTotals.get(String(linkedInv.id))?.unearnedCents || 0) : 0;
      const unearnedCents = await resolveRefundUnearnedCents(trx, linkedInv, {
        isReversal: false,
        subtotalCents,
        priorUnearnedCents,
      });
      const serviceLine = isCommercialProperty(linkedInv?.property_type || pay.property_type)
        ? 'commercial'
        : (linkedInv?.service_type || null);

      await postOrPreview(rules.buildRefundEntry({
        refundId: `manual:${pay.id}:${cumRefundCents}`,
        idempotencyKey: `refund:manual:${pay.id}:${cumRefundCents}`,
        refundDate,
        subtotalCents,
        unearnedCents,
        taxCents: deltaTax,
        method,
        customerId: pay.customer_id,
        invoiceId: linkedInv?.id || null,
        serviceLine,
        reference: pay.id,
        reason: `Manual customer refund (${method})`,
      }), ctx, 'refunds', { connOverride: trx });
    };

    if (ctx.dryRun) {
      await applyManualRefund(ctx.conn);
    } else {
      await withEntitySyncLock(ctx.conn, lockKey, applyManualRefund);
    }
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

// ── 6. Expenses (Shared-Bill Split, Linked Bank Accounts, Vendor Backfill, Deltas & Deletions) ─

async function loadPlaidGlAccountLookup(conn) {
  const byPlaidExternalId = new Map();
  const byAccountLabel = new Map();
  if (!(await conn.schema.hasTable('plaid_accounts'))) {
    return { byPlaidExternalId, byAccountLabel };
  }
  const rows = await conn('gl_accounts as g')
    .join('plaid_accounts as pa', 'pa.id', 'g.plaid_account_id')
    .where('g.active', true)
    .whereNotNull('g.plaid_account_id')
    .orderBy('g.code', 'asc')
    .select('g.id', 'g.code', 'pa.account_id as plaid_external_id', 'pa.account_label');

  const labelCounts = new Map();
  for (const r of rows) {
    const extId = String(r.plaid_external_id || '').trim();
    if (extId && !byPlaidExternalId.has(extId)) {
      byPlaidExternalId.set(extId, { id: r.id, code: r.code });
    }
    const label = normalizeVendorName(r.account_label);
    if (label) {
      labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
      byAccountLabel.set(label, { id: r.id, code: r.code });
    }
  }
  for (const [label, count] of labelCounts.entries()) {
    if (count > 1) byAccountLabel.delete(label);
  }
  return { byPlaidExternalId, byAccountLabel };
}

/**
 * Pure: resolve the GL cash/credit-card account for a bank_transactions row using
 * its Plaid external account_id first, then a unique Plaid account_label match (for
 * CSV imports), and finally account_type ('card' -> 2000, 'bank' -> fallbackCode).
 */
function resolveBankTxnGlAccount(bankTxn, lookup, fallbackCode = SYSTEM_CODES.CHECKING_PRIMARY) {
  if (!bankTxn) return { accountId: null, accountCode: fallbackCode };
  const extId = String(bankTxn.plaid_account_id || '').trim();
  if (extId && lookup?.byPlaidExternalId?.has(extId)) {
    const hit = lookup.byPlaidExternalId.get(extId);
    return { accountId: hit.id, accountCode: hit.code };
  }
  const label = normalizeVendorName(bankTxn.account_label);
  if (label && lookup?.byAccountLabel?.has(label)) {
    const hit = lookup.byAccountLabel.get(label);
    return { accountId: hit.id, accountCode: hit.code };
  }
  const acctType = String(bankTxn.account_type || '').toLowerCase();
  if (acctType === 'card') return { accountId: null, accountCode: SYSTEM_CODES.CREDIT_CARD_PRIMARY };
  return { accountId: null, accountCode: fallbackCode };
}

const PAYROLL_BENEFITS_FILING_TYPES = new Set(['payroll_simple_deposit', 'payroll_simple_employer']);
const PAYROLL_TAX_FILING_TYPES = new Set([
  'payroll_941_deposit', 'payroll_941', 'payroll_rt6', 'payroll_940', 'payroll_futa_alert',
]);

/**
 * Pure: classify a tax_filing_calendar row into the liability it clears when a bank
 * debit is matched to it ('sales_tax' -> 2100, 'tax_remit' -> 2200, 'benefits_remit' -> 2210).
 * Non-liability filings (1040-ES estimated owner tax, annual returns, 1099/W-2 filings) return null.
 */
function classifyTaxFilingSettlement(filing) {
  const ft = String(filing?.filing_type || '').trim().toLowerCase();
  const sk = String(filing?.source_key || filing?.filing_source_key || '').trim().toLowerCase();
  const title = String(filing?.title || filing?.filing_title || '').trim().toLowerCase();
  const combined = `${ft} ${title}`;

  if (ft === 'dr15_sales_tax' || /dr-?15|sales_tax|sales tax/.test(combined)) {
    return { kind: 'sales_tax', label: 'sales tax remittance' };
  }
  if (PAYROLL_BENEFITS_FILING_TYPES.has(ft) || /simple|hsa|401k|retirement/.test(`${ft} ${sk}`)) {
    return { kind: 'benefits_remit', label: 'payroll benefits remittance' };
  }
  if (
    PAYROLL_TAX_FILING_TYPES.has(ft)
    || /^payroll:(?:941|940|rt6|futa)/.test(sk)
    || /\b(?:941|940|rt-?6|eftps|futa|suta|reemployment)\b/.test(combined)
  ) {
    return { kind: 'tax_remit', label: 'payroll tax remittance' };
  }
  return null;
}

function settlementKeyForTaxFiling(btId, classification) {
  if (!classification) return null;
  if (classification.kind === 'sales_tax') return `sales-tax-remit:bt:${btId}`;
  return `payroll-settle:${classification.kind}:bt:${btId}`;
}

async function loadBankTxnCapabilities(conn) {
  const hasBankTxns = await conn.schema.hasTable('bank_transactions');
  if (!hasBankTxns) {
    return { hasBankTxns: false, hasPlaidCol: false, hasCheckMatch: false, hasFilingMatch: false, hasSuggestionCol: false };
  }
  const [hasPlaidCol, hasCheckMatch, hasFilingMatch, hasSuggestionCol] = await Promise.all([
    hasSchemaColumn(conn, 'bank_transactions', 'plaid_account_id'),
    hasSchemaColumn(conn, 'bank_transactions', 'matched_payroll_check_id'),
    hasSchemaColumn(conn, 'bank_transactions', 'matched_tax_filing_id'),
    hasSchemaColumn(conn, 'bank_transactions', 'suggestion'),
  ]);
  return { hasBankTxns: true, hasPlaidCol, hasCheckMatch, hasFilingMatch, hasSuggestionCol };
}

/**
 * Pure: extract the target expense ID and refund amount (in cents) from a bank_transactions
 * credit row that reduced an expense via apply-refund (`refund_applied` + `refundAppliedTo`)
 * or was terminally released without restoring the expense (`ignored` + `releasedRefundOf`).
 */
function extractMerchantRefundTarget(btRow) {
  if (!btRow) return null;
  const suggestion = parseJsonObject(btRow.suggestion);
  if (btRow.status === 'refund_applied' && suggestion.refundAppliedTo != null) {
    const refundCents = safeNonNegCents(suggestion.refundAmount ?? btRow.amount);
    return refundCents > 0 ? { expenseId: String(suggestion.refundAppliedTo), refundCents } : null;
  }
  if (btRow.status === 'ignored' && suggestion.releasedRefundOf != null) {
    const refundCents = safeNonNegCents(btRow.amount);
    return refundCents > 0 ? { expenseId: String(suggestion.releasedRefundOf), refundCents } : null;
  }
  return null;
}

/**
 * Pure: recover the original gross purchase amount for an expense whose stored `amount` was
 * reduced by one or more applied/released bank-import merchant refunds.
 */
function recoverGrossExpenseCents(expAmount, appliedRefundCents = 0) {
  const netCents = dollarsToCents(expAmount);
  if (netCents == null || netCents < 0) return null;
  return netCents + Math.max(0, Math.trunc(Number(appliedRefundCents) || 0));
}

async function loadMerchantRefundTotalsByExpense(conn, expenseIds, bankCaps) {
  const map = new Map();
  if (!expenseIds.length || !bankCaps.hasBankTxns || !bankCaps.hasSuggestionCol) return map;
  const idStrings = expenseIds.map(String);
  const rows = await conn('bank_transactions as bt')
    .where((q) => {
      q.where((applied) => {
        applied.where('bt.status', 'refund_applied')
          .whereIn(conn.raw("bt.suggestion->>'refundAppliedTo'"), idStrings);
      }).orWhere((released) => {
        released.where('bt.status', 'ignored')
          .whereIn(conn.raw("bt.suggestion->>'releasedRefundOf'"), idStrings);
      });
    })
    .select('bt.id', 'bt.status', 'bt.amount', 'bt.suggestion');

  for (const r of rows) {
    const target = extractMerchantRefundTarget(r);
    if (!target) continue;
    map.set(target.expenseId, (map.get(target.expenseId) || 0) + target.refundCents);
  }
  return map;
}

async function loadMatchedBankTxnsForExpenses(conn, expenseIds, bankCaps) {
  const map = new Map();
  if (!expenseIds.length || !bankCaps.hasBankTxns) return map;
  const hasTaxCal = bankCaps.hasFilingMatch && (await conn.schema.hasTable('tax_filing_calendar'));
  const hasSourceKey = hasTaxCal && (await hasSchemaColumn(conn, 'tax_filing_calendar', 'source_key'));

  let q = conn('bank_transactions as bt').whereIn('bt.matched_expense_id', expenseIds);
  const cols = ['bt.id', 'bt.matched_expense_id', 'bt.account_label', 'bt.account_type', 'bt.matched_at', 'bt.updated_at'];
  if (bankCaps.hasPlaidCol) cols.push('bt.plaid_account_id');
  if (bankCaps.hasCheckMatch) cols.push('bt.matched_payroll_check_id');
  if (bankCaps.hasFilingMatch) cols.push('bt.matched_tax_filing_id');
  if (hasTaxCal) {
    q = q.leftJoin('tax_filing_calendar as tfc', 'tfc.id', 'bt.matched_tax_filing_id');
    cols.push('tfc.filing_type', 'tfc.title as filing_title');
    if (hasSourceKey) cols.push('tfc.source_key as filing_source_key');
  }
  const rows = await q.select(...cols);
  for (const r of rows) {
    if (r.matched_expense_id) map.set(String(r.matched_expense_id), r);
  }
  return map;
}

async function loadVendorLookup(conn) {
  const vendors = await conn('gl_vendors')
    .select('id', 'display_name', 'legal_name', 'default_account_id', 'is_1099_eligible', 'active');
  const byId = new Map();
  const activeByDisplay = new Map();
  const activeLegalCounts = new Map();
  const activeByLegal = new Map();
  const anyByName = new Map();

  for (const v of vendors) {
    byId.set(String(v.id).toLowerCase(), v);
    const dKey = normalizeVendorName(v.display_name);
    const lKey = normalizeVendorName(v.legal_name);
    if (dKey && (!anyByName.has(dKey) || v.active)) anyByName.set(dKey, v);
    if (lKey && (!anyByName.has(lKey) || v.active)) anyByName.set(lKey, v);
    if (v.active === false) continue;
    if (dKey) activeByDisplay.set(dKey, v);
    if (lKey) {
      activeLegalCounts.set(lKey, (activeLegalCounts.get(lKey) || 0) + 1);
      activeByLegal.set(lKey, v);
    }
  }
  for (const [lKey, count] of activeLegalCounts.entries()) {
    if (count > 1) activeByLegal.delete(lKey);
  }
  return {
    byId,
    match(vendorName) {
      const k = normalizeVendorName(vendorName);
      if (!k) return null;
      return activeByDisplay.get(k) || activeByLegal.get(k) || null;
    },
    matchAny(vendorName) {
      const k = normalizeVendorName(vendorName);
      if (!k) return null;
      return activeByDisplay.get(k) || activeByLegal.get(k) || anyByName.get(k) || null;
    },
  };
}

/**
 * Pure: decide whether an existing expense JE's vendor_id should be updated, cleared,
 * or preserved. Preserves historical 1099 attribution when a vendor is deactivated or
 * renamed in gl_vendors, and only replaces/clears on an actual source-expense change.
 */
function decideExpenseVendorAction({ expVendorName, existingVendorId, matchedActiveVendor, vendorById = null }) {
  const existingId = existingVendorId ? String(existingVendorId).toLowerCase() : null;
  if (matchedActiveVendor) {
    const targetId = String(matchedActiveVendor.id).toLowerCase();
    if (existingId === targetId) return { action: 'keep', vendorId: matchedActiveVendor.id };
    return { action: 'set', vendorId: matchedActiveVendor.id };
  }
  if (!existingId) return { action: 'keep', vendorId: null };
  const cleanName = normalizeVendorName(expVendorName);
  if (!cleanName) {
    const existingVendor = vendorById?.get(existingId) || null;
    if (existingVendor && existingVendor.active === false) {
      return { action: 'keep', vendorId: existingVendorId };
    }
    return { action: 'clear', vendorId: null };
  }
  return { action: 'keep', vendorId: existingVendorId };
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
    .select('e.id as entry_id', 'e.reversed_by_entry_id', 'a.code', 'l.debit_cents', 'l.credit_cents');

  const bookedByCode = new Map();
  const allEntryIds = new Set();
  const activeEntryIds = new Set();
  for (const r of rows) {
    allEntryIds.add(r.entry_id);
    if (!r.reversed_by_entry_id) {
      activeEntryIds.add(r.entry_id);
      const net = Number(r.debit_cents) - Number(r.credit_cents);
      bookedByCode.set(r.code, (bookedByCode.get(r.code) || 0) + net);
    }
  }
  return { bookedByCode, entryCount: activeEntryIds.size, totalEntryCount: allEntryIds.size };
}

async function reconcileExpenseVendorAttribution(exp, matchedVendor, vendorById, trx, ctx, { sourceType = 'expense', sourceId = null } = {}) {
  const existing = await trx('gl_journal_entries as e')
    .where({ 'e.source_type': sourceType, 'e.source_id': String(sourceId ?? exp.id), 'e.status': 'posted' })
    .whereNull('e.reversed_by_entry_id')
    .select('e.id');

  let changed = false;
  for (const row of existing) {
    const expLines = await trx('gl_journal_lines as l')
      .join('gl_accounts as a', 'a.id', 'l.account_id')
      .where('l.entry_id', row.id)
      .whereNull('l.reconciliation_id')
      .whereIn('a.account_type', ['cogs', 'expense'])
      .select('l.id', 'l.vendor_id');
    if (!expLines.length) continue;

    const decisions = expLines.map((l) => decideExpenseVendorAction({
      expVendorName: exp.vendor_name,
      existingVendorId: l.vendor_id,
      matchedActiveVendor: matchedVendor,
      vendorById,
    }));
    const actionable = decisions.find((d) => d.action === 'set' || d.action === 'clear');
    if (!actionable) continue;

    changed = true;
    if (ctx.dryRun) {
      ctx.stats.expenses.would_link_vendors += 1;
    } else {
      const isClear = actionable.action === 'clear';
      const res = await linkJournalEntryVendor(row.id, {
        vendorId: isClear ? null : actionable.vendorId,
        allowReplace: !isClear,
        allowClear: isClear,
        reason: isClear
          ? 'Subledger sync cleared empty expense vendor attribution'
          : 'Subledger sync reconciled expense vendor attribution',
        actorId: ctx.actorId,
        requestMeta: ctx.requestMeta,
        conn: trx,
      });
      if (res.updatedLines > 0) ctx.stats.expenses.linked_vendors += 1;
    }
  }
  return changed;
}

function latestAdjustmentDate(entryDate, timestamps) {
  let latest = entryDate;
  for (const ts of timestamps) {
    const d = timestampToEtDate(ts);
    if (d && d > latest) latest = d;
  }
  return latest;
}

async function syncSingleExpenseRow(exp, mapped, matchedVendor, matchedBankTxn, plaidGlLookup, vendorById, ctx, appliedRefundCents = 0) {
  const entryDate = dateCellText(exp.expense_date);
  const amountCents = recoverGrossExpenseCents(exp.amount, appliedRefundCents);
  if (!entryDate || amountCents == null || amountCents < 0) return;

  const isLiabilitySettlement = Boolean(
    matchedBankTxn?.matched_payroll_check_id
    || (matchedBankTxn?.matched_tax_filing_id && classifyTaxFilingSettlement(matchedBankTxn)),
  );
  const resolvedPayment = matchedBankTxn
    ? resolveBankTxnGlAccount(matchedBankTxn, plaidGlLookup, SYSTEM_CODES.CHECKING_PRIMARY)
    : { accountId: null, accountCode: paymentAccountCodeForExpense(exp.payment_method) };

  const desired = amountCents > 0 && !isLiabilitySettlement
    ? rules.buildExpenseEntry({
      sourceType: 'expense',
      sourceId: exp.id,
      entryDate,
      paymentAccountId: resolvedPayment.accountId,
      paymentAccountCode: resolvedPayment.accountCode,
      paymentMethod: exp.payment_method || null,
      bankTransactionId: matchedBankTxn?.id || null,
      splits: buildExpenseSplits(exp, mapped, matchedVendor, amountCents),
      vendorId: matchedVendor ? matchedVendor.id : null,
      memo: [exp.vendor_name, exp.description].filter(Boolean).join(' — ').slice(0, 500) || 'Expense',
    })
    : null;

  const adjDate = latestAdjustmentDate(entryDate, [exp.updated_at, matchedBankTxn?.matched_at, matchedBankTxn?.updated_at]);

  const reconcile = async (trx) => {
    const { bookedByCode, totalEntryCount } = await loadBookedExpenseState(trx, exp.id);
    if (totalEntryCount === 0) {
      if (!desired) return;
      await postOrPreview(desired, ctx, 'expenses', { connOverride: trx });
      return;
    }

    const vendorChanged = await reconcileExpenseVendorAttribution(exp, matchedVendor, vendorById, trx, ctx);
    const adjEntry = buildDeltaEntry({
      sourceType: 'expense',
      sourceId: exp.id,
      keyPrefix: 'expense-adj',
      revisionSeq: totalEntryCount,
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
      if (!vendorChanged) ctx.stats.expenses.skipped += 1;
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

async function reconcileRemovedOrExcludedExpenses(conn, from, to, ctx) {
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

  // Also reverse booked expenses that were recategorized into excluded categories (payroll, depreciation, home office).
  const movedExcluded = await conn('gl_journal_entries as e')
    .join('expenses as ex', conn.raw('ex.id::text = e.source_id'))
    .leftJoin('expense_categories as ec', 'ec.id', 'ex.category_id')
    .where({ 'e.source_type': 'expense', 'e.status': 'posted' })
    .whereNull('e.reversed_by_entry_id')
    .whereRaw("(COALESCE(ec.name, '') = 'Payroll (counted from pay runs)' OR COALESCE(ec.irs_line, '') IN ('13', '30'))")
    .where((win) => {
      win.whereBetween('e.entry_date', [from, to])
        .orWhereRaw("DATE(ex.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
    })
    .select(
      'e.id', 'e.reversed_by_entry_id', conn.raw('e.entry_date::text as entry_date'),
      'ex.updated_at', 'ec.name as category_name',
    );

  for (const row of movedExcluded) {
    const entryDay = dateCellText(row.entry_date);
    const updatedDay = timestampToEtDate(row.updated_at);
    const revDate = updatedDay && updatedDay >= entryDay ? updatedDay : entryDay;
    const label = row.category_name || 'excluded category';
    await reverseOrPreview(row, revDate, `Expense recategorized to ${label} (excluded from expense sync)`, ctx, 'expenses');
  }
}

async function syncExpenses(conn, from, to, ctx, plaidGlLookup = null, bankCapsArg = null) {
  if (!(await conn.schema.hasTable('expenses'))) return;
  const [glAccounts, vendorLookup, bankCaps] = await Promise.all([
    conn('gl_accounts')
      .whereNotNull('expense_category_id')
      .select('id', 'code', 'expense_category_id', 'schedule_c_line'),
    loadVendorLookup(conn),
    bankCapsArg ? Promise.resolve(bankCapsArg) : loadBankTxnCapabilities(conn),
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
      if (bankCaps.hasBankTxns) {
        q.orWhere((bankLinked) => {
          bankLinked.whereExists(function linkedInWindow() {
            this.select(conn.raw('1'))
              .from('bank_transactions as bt')
              .whereRaw('bt.matched_expense_id = e.id')
              .whereRaw("DATE(COALESCE(bt.matched_at, bt.updated_at) AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
          }).whereExists(function alreadyBooked() {
            this.select(conn.raw('1'))
              .from('gl_journal_entries as ge')
              .where({ 'ge.source_type': 'expense', 'ge.status': 'posted' })
              .whereNull('ge.reversed_by_entry_id')
              .whereRaw('ge.source_id = e.id::text');
          });
        });
      }
    })
    .whereRaw("COALESCE(c.name, '') <> 'Payroll (counted from pay runs)'")
    .whereRaw("COALESCE(c.irs_line, '') NOT IN ('13', '30')")
    .select(
      'e.id', 'e.category_id', 'e.description', 'e.amount', 'e.tax_deductible_amount', 'e.notes',
      conn.raw('e.expense_date::text as expense_date'), 'e.vendor_name', 'e.payment_method',
      'e.scheduled_service_id', 'e.updated_at', 'c.name as category_name',
    );

  const [matchedBankByExpense, refundTotalsByExpense] = await Promise.all([
    loadMatchedBankTxnsForExpenses(conn, rows.map((r) => r.id), bankCaps),
    loadMerchantRefundTotalsByExpense(conn, rows.map((r) => r.id), bankCaps),
  ]);
  const unmatchedContractors = new Map();
  for (const exp of rows) {
    const appliedRefundCents = refundTotalsByExpense.get(String(exp.id)) || 0;
    const grossAmountCents = recoverGrossExpenseCents(exp.amount, appliedRefundCents) || 0;
    const mapped = exp.category_id ? glByCatId.get(exp.category_id) : null;
    const matchedVendor = vendorLookup.match(exp.vendor_name);
    const matchedAnyVendor = matchedVendor || vendorLookup.matchAny(exp.vendor_name);
    const matchedBankTxn = matchedBankByExpense.get(String(exp.id)) || null;

    if (exp.vendor_name && !matchedAnyVendor && grossAmountCents > 0) {
      ctx.stats.expenses.unmatched_vendors += 1;
      const isContractorCat = mapped?.code === SYSTEM_CODES.COGS_SUBCONTRACTORS
        || /contract|subcontract|1099/i.test(String(exp.category_name || ''));
      if (isContractorCat) {
        const key = normalizeVendorName(exp.vendor_name);
        const prev = unmatchedContractors.get(key) || { vendor_name: String(exp.vendor_name).trim(), count: 0, total_cents: 0 };
        prev.count += 1;
        prev.total_cents += grossAmountCents;
        unmatchedContractors.set(key, prev);
      }
    }

    await syncSingleExpenseRow(exp, mapped, matchedVendor, matchedBankTxn, plaidGlLookup, vendorLookup.byId, ctx, appliedRefundCents);
  }

  ctx.stats.expenses.unmatched_contractor_vendors = Array.from(unmatchedContractors.values());
  await reconcileRemovedOrExcludedExpenses(conn, from, to, ctx);
  await syncExpenseMerchantRefunds(conn, from, to, ctx, glByCatId, vendorLookup, plaidGlLookup, bankCaps);
}

async function loadBookedExpenseRefundState(conn, bankTxnId) {
  const rows = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where({ 'e.status': 'posted', 'e.source_type': 'expense_refund', 'e.source_id': String(bankTxnId) })
    .select('e.id as entry_id', 'e.reversed_by_entry_id', 'a.code', 'l.debit_cents', 'l.credit_cents');

  const bookedByCode = new Map();
  const allEntryIds = new Set();
  const activeEntryIds = new Set();
  for (const r of rows) {
    allEntryIds.add(r.entry_id);
    if (!r.reversed_by_entry_id) {
      activeEntryIds.add(r.entry_id);
      const net = Number(r.debit_cents) - Number(r.credit_cents);
      bookedByCode.set(r.code, (bookedByCode.get(r.code) || 0) + net);
    }
  }
  return { bookedByCode, activeEntryCount: activeEntryIds.size, totalEntryCount: allEntryIds.size };
}

function buildMerchantRefundDeltaEntry(row, desiredLines, bookedByCode, adjDate, revisionSeq, { matchedVendor = null, accountsById = null } = {}) {
  const detail = [row.vendor_name, row.description || row.exp_description].filter(Boolean).join(' — ');
  return buildDeltaEntry({
    sourceType: 'expense_refund',
    sourceId: row.id,
    keyPrefix: 'expense-refund-adj',
    revisionSeq,
    desiredLines,
    bookedByCode,
    adjustmentDate: adjDate,
    basisScope: 'both',
    reference: String(row.exp_id),
    memo: `Merchant refund adjustment — ${detail || row.exp_id}`.slice(0, 500),
    lineMeta: { vendorId: matchedVendor ? matchedVendor.id : null, paymentMethod: row.payment_method || null },
    accountsById,
  });
}

async function syncSingleMerchantRefundRow(row, mapped, matchedVendor, matchedExpBankTxn, plaidGlLookup, vendorById, ctx) {
  const target = extractMerchantRefundTarget(row);
  const entryDate = dateCellText(row.txn_date);
  if (!target || !entryDate) return;

  const isLiabilitySettlement = Boolean(
    matchedExpBankTxn?.matched_payroll_check_id
    || (matchedExpBankTxn?.matched_tax_filing_id && classifyTaxFilingSettlement(matchedExpBankTxn)),
  );
  if (isLiabilitySettlement) return;

  const fallbackPayCode = paymentAccountCodeForExpense(row.payment_method);
  const resolvedPayment = resolveBankTxnGlAccount(row, plaidGlLookup, fallbackPayCode);
  const expLike = {
    id: row.exp_id,
    notes: row.exp_notes,
    scheduled_service_id: row.scheduled_service_id,
  };
  const splits = buildExpenseSplits(expLike, mapped, matchedVendor, target.refundCents);
  const detail = [row.vendor_name, row.description || row.exp_description].filter(Boolean).join(' — ');
  const memo = `Merchant refund — ${detail || row.exp_id}`.slice(0, 500);
  const keyBase = `expense-refund:bt:${row.id}`;
  const adjDate = latestAdjustmentDate(entryDate, [row.exp_updated_at, row.matched_at, row.updated_at]);
  const buildDesired = (idempotencyKey) => rules.buildExpenseRefundEntry({
    sourceType: 'expense_refund',
    sourceId: row.id,
    idempotencyKey,
    entryDate,
    paymentAccountId: resolvedPayment.accountId,
    paymentAccountCode: resolvedPayment.accountCode,
    paymentMethod: row.payment_method || null,
    bankTransactionId: row.id,
    splits,
    vendorId: matchedVendor ? matchedVendor.id : null,
    reference: String(row.exp_id),
    memo,
  });

  const run = async (trx) => {
    const { bookedByCode, activeEntryCount, totalEntryCount } = await loadBookedExpenseRefundState(trx, row.id);
    if (activeEntryCount === 0) {
      const revKey = totalEntryCount === 0 ? keyBase : `${keyBase}:rev-${totalEntryCount}`;
      await postOrPreview(buildDesired(revKey), ctx, 'expenses', { connOverride: trx });
      return;
    }

    const vendorChanged = await reconcileExpenseVendorAttribution(
      { id: row.exp_id, vendor_name: row.vendor_name },
      matchedVendor,
      vendorById,
      trx,
      ctx,
      { sourceType: 'expense_refund', sourceId: row.id },
    );
    const desired = buildDesired(keyBase);
    const adjEntry = buildMerchantRefundDeltaEntry(row, desired.lines, bookedByCode, adjDate, totalEntryCount, {
      matchedVendor,
      accountsById: ctx.caches.accountsById,
    });
    if (!adjEntry) {
      if (!vendorChanged) ctx.stats.expenses.skipped += 1;
      return;
    }
    await postOrPreview(adjEntry, ctx, 'expenses', { isAdjustment: true, connOverride: trx });
  };

  if (ctx.dryRun) {
    await run(ctx.conn);
  } else {
    await withEntitySyncLock(ctx.conn, `gl-sync-expense-refund:${row.id}`, run);
  }
}

async function reconcileRemovedExpenseMerchantRefunds(conn, from, to, ctx) {
  const stale = await conn('gl_journal_entries as e')
    .leftJoin('bank_transactions as bt', conn.raw('bt.id::text = e.source_id'))
    .leftJoin('expenses as ex', conn.raw("ex.id::text = COALESCE(bt.suggestion->>'refundAppliedTo', bt.suggestion->>'releasedRefundOf')"))
    .leftJoin('expense_categories as ec', 'ec.id', 'ex.category_id')
    .where({ 'e.source_type': 'expense_refund', 'e.status': 'posted' })
    .whereNull('e.reversed_by_entry_id')
    .where((win) => {
      win.whereBetween('e.entry_date', [from, to])
        .orWhereRaw("bt.updated_at IS NOT NULL AND DATE(bt.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to])
        .orWhereRaw("ex.updated_at IS NOT NULL AND DATE(ex.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
    })
    .where((invalid) => {
      invalid.whereNull('bt.id')
        .orWhereRaw("NOT ((bt.status = 'refund_applied' AND bt.suggestion->>'refundAppliedTo' IS NOT NULL) OR (bt.status = 'ignored' AND bt.suggestion->>'releasedRefundOf' IS NOT NULL))")
        .orWhereNull('ex.id')
        .orWhereRaw("COALESCE(ec.name, '') = 'Payroll (counted from pay runs)'")
        .orWhereRaw("COALESCE(ec.irs_line, '') IN ('13', '30')");
    })
    .select(
      'e.id', 'e.reversed_by_entry_id', conn.raw('e.entry_date::text as entry_date'),
      'bt.updated_at as bt_updated_at', 'ex.updated_at as exp_updated_at',
    );

  for (const row of stale) {
    const entryDay = dateCellText(row.entry_date);
    const updatedDay = timestampToEtDate(row.bt_updated_at || row.exp_updated_at);
    const revDate = updatedDay && updatedDay >= entryDay ? updatedDay : entryDay;
    await reverseOrPreview(row, revDate, 'Merchant expense refund undone or target expense removed', ctx, 'expenses');
  }
}

async function syncExpenseMerchantRefunds(conn, from, to, ctx, glByCatId, vendorLookup, plaidGlLookup, bankCaps) {
  if (!bankCaps.hasBankTxns || !bankCaps.hasSuggestionCol) return;
  const cols = [
    'bt.id', 'bt.status', 'bt.amount', 'bt.suggestion', 'bt.description',
    'bt.account_label', 'bt.account_type', 'bt.matched_at', 'bt.updated_at',
    conn.raw('bt.txn_date::text as txn_date'),
    'e.id as exp_id', 'e.category_id', 'e.description as exp_description',
    'e.notes as exp_notes', 'e.vendor_name', 'e.payment_method', 'e.scheduled_service_id',
    'e.updated_at as exp_updated_at',
  ];
  if (bankCaps.hasPlaidCol) cols.push('bt.plaid_account_id');

  const rows = await conn('bank_transactions as bt')
    .join('expenses as e', conn.raw("e.id::text = COALESCE(bt.suggestion->>'refundAppliedTo', bt.suggestion->>'releasedRefundOf')"))
    .leftJoin('expense_categories as c', 'c.id', 'e.category_id')
    .where((q) => {
      q.where((applied) => {
        applied.where('bt.status', 'refund_applied')
          .whereRaw("bt.suggestion->>'refundAppliedTo' IS NOT NULL");
      }).orWhere((released) => {
        released.where('bt.status', 'ignored')
          .whereRaw("bt.suggestion->>'releasedRefundOf' IS NOT NULL");
      });
    })
    .where((win) => {
      win.whereBetween('bt.txn_date', [from, to])
        .orWhereRaw("DATE(COALESCE(bt.matched_at, bt.updated_at) AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to])
        .orWhere((expEdited) => {
          expEdited.whereRaw("e.updated_at IS NOT NULL AND DATE(e.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to])
            .whereExists(function refundAlreadyBooked() {
              this.select(conn.raw('1'))
                .from('gl_journal_entries as ge')
                .where({ 'ge.source_type': 'expense_refund', 'ge.status': 'posted' })
                .whereNull('ge.reversed_by_entry_id')
                .whereRaw('ge.source_id = bt.id::text');
            });
        });
    })
    .whereRaw("COALESCE(c.name, '') <> 'Payroll (counted from pay runs)'")
    .whereRaw("COALESCE(c.irs_line, '') NOT IN ('13', '30')")
    .select(...cols);

  const matchedExpBank = await loadMatchedBankTxnsForExpenses(conn, rows.map((r) => r.exp_id), bankCaps);
  for (const row of rows) {
    const mapped = row.category_id ? glByCatId.get(row.category_id) : null;
    const matchedVendor = vendorLookup.match(row.vendor_name);
    const matchedExpBankTxn = matchedExpBank.get(String(row.exp_id)) || null;
    await syncSingleMerchantRefundRow(row, mapped, matchedVendor, matchedExpBankTxn, plaidGlLookup, vendorLookup.byId, ctx);
  }

  await reconcileRemovedExpenseMerchantRefunds(conn, from, to, ctx);
}

// ── 7. Payroll Runs & Settlements (Mercury Paychecks, Bank-Matched Checks & Tax Filings) ─

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

function matchesSettlementKeyBase(entryKey, keyBase) {
  if (!entryKey || !keyBase) return false;
  return entryKey === keyBase || entryKey.startsWith(`${keyBase}:rev-`);
}

/**
 * Pure: determine whether a bank_transactions debit matched to a payroll check must be
 * excluded from the bank-fallback settlement writer because Mercury owns the paycheck
 * (settled, in-flight, or returned/failed without a genuinely separate subsequent paper check).
 */
function isBankCheckSupersededByMercury(bt, paymentRows) {
  if (!Array.isArray(paymentRows) || !paymentRows.length) return false;
  if (paymentRows.some((p) => p.state === 'sent')) return true;
  const ordered = [...paymentRows].sort((a, b) => Number(a.attempt || 0) - Number(b.attempt || 0));
  const latest = ordered[ordered.length - 1];
  if (latest.state !== 'paper') return true;
  const hasPriorNonPaper = ordered.slice(0, -1).some((p) => p.state !== 'paper');
  if (!hasPriorNonPaper) return false;
  const checkNum = String(latest.check_number || '').trim();
  if (checkNum && String(bt?.description || '').includes(checkNum)) return false;
  const btDay = dateCellText(bt?.txn_date);
  const paperDay = timestampToEtDate(latest.created_at);
  return Boolean(btDay && paperDay && btDay < paperDay);
}

async function postOrRepostSettlement(trx, { keyBase, buildEntry, ctx, bucket }) {
  const existingRows = await trx('gl_journal_entries')
    .where('status', 'posted')
    .where((q) => {
      q.where('idempotency_key', keyBase)
        .orWhere('idempotency_key', 'like', `${keyBase}:rev-%`);
    })
    .select('id', 'idempotency_key', 'reversed_by_entry_id');

  if (existingRows.some((r) => !r.reversed_by_entry_id)) {
    ctx.stats[bucket].skipped += 1;
    return false;
  }
  const revKey = existingRows.length === 0 ? keyBase : `${keyBase}:rev-${existingRows.length}`;
  return postOrPreview(buildEntry(revKey), ctx, bucket, { connOverride: trx });
}

async function applyMercurySettlementAtomic(trx, pp, entry, settlementDate, ctx) {
  let reversedBt = false;
  if (pp.bt_id) {
    const priorBt = await trx('gl_journal_entries')
      .where({ source_type: 'payroll_remittance', source_id: `bt-check:${pp.bt_id}`, status: 'posted' })
      .whereNull('reversed_by_entry_id')
      .first('id', 'reversed_by_entry_id', trx.raw('entry_date::text as entry_date'));
    if (priorBt) {
      reversedBt = await reverseOrPreview(
        priorBt,
        settlementDate,
        `Superseded by Mercury payroll payment ${pp.id}`,
        ctx,
        'payroll_settlements',
        { connOverride: trx },
      );
      if (!reversedBt) return;
    }
  }
  const posted = await postOrPreview(entry, ctx, 'payroll_settlements', { connOverride: trx });
  if (reversedBt && !posted && !ctx.dryRun) {
    ctx.stats.payroll_settlements.reversed = Math.max(0, ctx.stats.payroll_settlements.reversed - 1);
    const err = new Error('ABORT_SETTLEMENT_REPLACEMENT');
    err.code = 'ABORT_SETTLEMENT_REPLACEMENT';
    throw err;
  }
}

async function reconcileRevokedMercuryPayrollPayments(conn, from, to, ctx) {
  const revokedRows = await conn('gl_journal_entries as e')
    .join('payroll_payments as pp', conn.raw("e.idempotency_key = 'payroll-settle:net_pay:pp:' || pp.id::text"))
    .leftJoin('payroll_checks as pc', 'pc.id', 'pp.check_id')
    .where('e.status', 'posted')
    .whereNull('e.reversed_by_entry_id')
    .whereRaw("(pp.state IN ('returned', 'failed', 'cancelled', 'rejected') OR pc.status = 'voided')")
    .where((win) => {
      win.whereBetween('e.entry_date', [from, to])
        .orWhereRaw("DATE(COALESCE(pp.resolved_at, pp.updated_at) AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
    })
    .select(
      'e.id', 'e.reversed_by_entry_id', conn.raw('e.entry_date::text as entry_date'),
      'pp.state as pp_state', 'pp.resolved_at', 'pp.updated_at', 'pp.resolution', 'pc.status as check_status',
    );

  for (const row of revokedRows) {
    const revDate = latestAdjustmentDate(dateCellText(row.entry_date), [row.resolved_at, row.updated_at]);
    const detail = row.resolution ? ` (${String(row.resolution).slice(0, 120)})` : '';
    const reason = row.check_status === 'voided'
      ? 'Payroll paycheck voided'
      : `Mercury payroll payment ${row.pp_state}${detail}`;
    await reverseOrPreview(row, revDate, reason, ctx, 'payroll_settlements');
  }
}

async function syncMercuryPayrollPayments(conn, from, to, ctx, plaidGlLookup, bankCaps) {
  if (!(await conn.schema.hasTable('payroll_payments')) || !(await conn.schema.hasTable('payroll_checks'))) return;

  let q = conn('payroll_payments as pp')
    .join('payroll_checks as pc', 'pc.id', 'pp.check_id')
    .leftJoin('technicians as t', 't.id', 'pc.technician_id')
    .where('pp.state', 'sent')
    .where('pc.status', 'finalized')
    .whereRaw(
      "COALESCE(pp.posted_on, DATE(pp.resolved_at AT TIME ZONE 'America/New_York'), DATE(pp.updated_at AT TIME ZONE 'America/New_York')) BETWEEN ?::date AND ?::date",
      [from, to],
    );
  const cols = [
    'pp.id', 'pp.check_id', 'pp.amount_cents',
    conn.raw('pp.posted_on::text as posted_on'), 'pp.resolved_at', 'pp.updated_at',
    'pc.employee_name', 't.role as employee_role',
  ];
  if (bankCaps.hasCheckMatch) {
    q = q.leftJoin('bank_transactions as bt', 'bt.matched_payroll_check_id', 'pp.check_id');
    cols.push('bt.id as bt_id', 'bt.account_label as bt_account_label', 'bt.account_type as bt_account_type');
    if (bankCaps.hasPlaidCol) cols.push('bt.plaid_account_id as bt_plaid_account_id');
  }
  const sentRows = await q.select(...cols);

  for (const pp of sentRows) {
    const settlementDate = dateCellText(pp.posted_on) || timestampToEtDate(pp.resolved_at || pp.updated_at);
    const amountCents = intCents(pp.amount_cents);
    if (!settlementDate || amountCents <= 0) continue;

    const btRow = pp.bt_id
      ? { id: pp.bt_id, account_label: pp.bt_account_label, account_type: pp.bt_account_type, plaid_account_id: pp.bt_plaid_account_id }
      : null;
    const bankAcct = resolveBankTxnGlAccount(btRow, plaidGlLookup, SYSTEM_CODES.CHECKING_PAYROLL);
    const serviceLine = String(pp.employee_role || '').toLowerCase() === 'admin' ? 'admin' : 'field';
    const entry = rules.buildPayrollSettlementEntry({
      sourceId: `pp:${pp.id}`,
      idempotencyKey: `payroll-settle:net_pay:pp:${pp.id}`,
      settlementDate,
      kind: 'net_pay',
      amountCents,
      bankAccountId: bankAcct.accountId,
      bankAccountCode: bankAcct.accountCode,
      bankTransactionId: pp.bt_id || null,
      serviceLine,
      memo: `Payroll net pay settled via Mercury${pp.employee_name ? ` — ${pp.employee_name}` : ''}`,
    });

    if (ctx.dryRun) {
      await applyMercurySettlementAtomic(ctx.conn, pp, entry, settlementDate, ctx);
    } else {
      try {
        await withEntitySyncLock(ctx.conn, `gl-sync-payroll-check:${pp.check_id}`, (trx) => (
          applyMercurySettlementAtomic(trx, pp, entry, settlementDate, ctx)
        ));
      } catch (err) {
        if (err?.code !== 'ABORT_SETTLEMENT_REPLACEMENT') throw err;
      }
    }
  }

  await reconcileRevokedMercuryPayrollPayments(conn, from, to, ctx);
}

async function loadPayrollPaymentsByCheck(conn, checkIds) {
  const byCheck = new Map();
  if (!checkIds.length) return byCheck;
  const rows = await conn('payroll_payments')
    .whereIn('check_id', checkIds)
    .select('id', 'check_id', 'attempt', 'state', 'check_number', conn.raw('posted_on::text as posted_on'), 'created_at');
  for (const r of rows) {
    const k = String(r.check_id);
    const list = byCheck.get(k) || [];
    list.push(r);
    byCheck.set(k, list);
  }
  return byCheck;
}

async function reconcileUnlinkedBankPayrollChecks(conn, from, to, ctx, hasPayrollPayments) {
  const booked = await conn('gl_journal_entries as e')
    .leftJoin('bank_transactions as bt', conn.raw("e.source_id = 'bt-check:' || bt.id::text"))
    .leftJoin('payroll_checks as pc', 'pc.id', 'bt.matched_payroll_check_id')
    .where({ 'e.source_type': 'payroll_remittance', 'e.status': 'posted' })
    .where('e.source_id', 'like', 'bt-check:%')
    .whereNull('e.reversed_by_entry_id')
    .where((win) => {
      win.whereBetween('e.entry_date', [from, to])
        .orWhereRaw("bt.updated_at IS NOT NULL AND DATE(bt.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
    })
    .select(
      'e.id', 'e.reversed_by_entry_id', conn.raw('e.entry_date::text as entry_date'),
      'bt.id as bt_id', 'bt.matched_payroll_check_id', conn.raw('bt.txn_date::text as txn_date'),
      'bt.description', 'bt.updated_at', 'pc.status as check_status',
    );
  if (!booked.length) return;

  const checkIds = [...new Set(booked.map((r) => r.matched_payroll_check_id).filter(Boolean))];
  const ppByCheck = hasPayrollPayments ? await loadPayrollPaymentsByCheck(conn, checkIds) : new Map();
  const today = etDateString(new Date());

  for (const row of booked) {
    const superseded = row.bt_id && row.matched_payroll_check_id
      ? isBankCheckSupersededByMercury(row, ppByCheck.get(String(row.matched_payroll_check_id)))
      : false;
    const shouldReverse = !row.bt_id || !row.matched_payroll_check_id || row.check_status === 'voided' || superseded;
    if (!shouldReverse) continue;

    const entryDay = dateCellText(row.entry_date);
    const fallbackRevDate = today >= entryDay && today <= to ? today : (to >= entryDay ? to : entryDay);
    const revDate = row.updated_at ? latestAdjustmentDate(entryDay, [row.updated_at]) : fallbackRevDate;
    const reason = row.check_status === 'voided'
      ? 'Payroll paycheck voided'
      : (superseded ? 'Payroll check owned by Mercury transfer' : 'Bank payroll check link removed');
    await reverseOrPreview(row, revDate, reason, ctx, 'payroll_settlements');
  }
}

async function syncBankMatchedPayrollChecks(conn, from, to, ctx, plaidGlLookup, bankCaps) {
  if (!bankCaps.hasCheckMatch || !(await conn.schema.hasTable('payroll_checks'))) return;
  const hasPayrollPayments = await conn.schema.hasTable('payroll_payments');

  let q = conn('bank_transactions as bt')
    .join('payroll_checks as pc', 'pc.id', 'bt.matched_payroll_check_id')
    .leftJoin('technicians as t', 't.id', 'pc.technician_id')
    .whereNotNull('bt.matched_payroll_check_id')
    .where({ 'bt.direction': 'debit', 'pc.status': 'finalized' })
    .where((win) => {
      win.whereBetween('bt.txn_date', [from, to])
        .orWhereRaw("DATE(COALESCE(bt.matched_at, bt.updated_at) AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
    });
  if (hasPayrollPayments) {
    q = q.whereNotExists(function mercuryAttemptOwnsCheck() {
      this.select(conn.raw('1'))
        .from('payroll_payments as pp')
        .whereRaw("pp.check_id = bt.matched_payroll_check_id AND pp.state <> 'paper'")
        .whereNotExists(function laterPaperAttempt() {
          this.select(conn.raw('1'))
            .from('payroll_payments as p2')
            .whereRaw("p2.check_id = pp.check_id AND p2.state = 'paper' AND p2.attempt > pp.attempt");
        });
    });
  }
  const cols = [
    'bt.id', conn.raw('bt.txn_date::text as txn_date'), 'bt.amount', 'bt.description',
    'bt.account_label', 'bt.account_type', 'bt.matched_payroll_check_id', 'pc.employee_name', 't.role as employee_role',
  ];
  if (bankCaps.hasPlaidCol) cols.push('bt.plaid_account_id');
  const rows = await q.select(...cols);

  for (const bt of rows) {
    const settlementDate = dateCellText(bt.txn_date);
    const amountCents = dollarsToCents(bt.amount);
    if (!settlementDate || !amountCents || amountCents <= 0) continue;

    const bankAcct = resolveBankTxnGlAccount(bt, plaidGlLookup, SYSTEM_CODES.CHECKING_PAYROLL);
    const serviceLine = String(bt.employee_role || '').toLowerCase() === 'admin' ? 'admin' : 'field';
    const keyBase = `payroll-settle:net_pay:bt:${bt.id}`;
    const buildEntry = (idempotencyKey) => rules.buildPayrollSettlementEntry({
      sourceId: `bt-check:${bt.id}`,
      idempotencyKey,
      settlementDate,
      kind: 'net_pay',
      amountCents,
      bankAccountId: bankAcct.accountId,
      bankAccountCode: bankAcct.accountCode,
      bankTransactionId: bt.id,
      serviceLine,
      memo: `Payroll net pay cleared bank${bt.employee_name ? ` — ${bt.employee_name}` : ''}`,
    });

    const applyCheck = async (trx) => {
      if (hasPayrollPayments) {
        const ppRows = await trx('payroll_payments')
          .where({ check_id: bt.matched_payroll_check_id })
          .select('id', 'attempt', 'state', 'check_number', trx.raw('posted_on::text as posted_on'), 'created_at');
        if (isBankCheckSupersededByMercury(bt, ppRows)) {
          ctx.stats.payroll_settlements.skipped += 1;
          return;
        }
      }
      await postOrRepostSettlement(trx, { keyBase, buildEntry, ctx, bucket: 'payroll_settlements' });
    };

    if (ctx.dryRun) {
      await applyCheck(ctx.conn);
    } else {
      await withEntitySyncLock(ctx.conn, `gl-sync-payroll-check:${bt.matched_payroll_check_id}`, applyCheck);
    }
  }

  await reconcileUnlinkedBankPayrollChecks(conn, from, to, ctx, hasPayrollPayments);
}

function buildTaxFilingSettlementEntry(bt, cls, settlementDate, amountCents, plaidGlLookup, idempotencyKeyOverride = null) {
  const fallbackCode = cls.kind === 'sales_tax' ? SYSTEM_CODES.CHECKING_PRIMARY : SYSTEM_CODES.CHECKING_PAYROLL;
  const bankAcct = resolveBankTxnGlAccount(bt, plaidGlLookup, fallbackCode);
  const idempotencyKey = idempotencyKeyOverride || settlementKeyForTaxFiling(bt.id, cls);
  if (cls.kind === 'sales_tax') {
    return rules.buildSalesTaxRemittanceEntry({
      sourceId: `bt-filing:${bt.id}`,
      idempotencyKey,
      paymentDate: settlementDate,
      amountCents,
      periodLabel: bt.filing_period_label || bt.filing_title || '',
      bankAccountId: bankAcct.accountId,
      bankAccountCode: bankAcct.accountCode,
      bankTransactionId: bt.id,
    });
  }
  const suffix = bt.filing_period_label ? ` (${bt.filing_period_label})` : '';
  return rules.buildPayrollSettlementEntry({
    sourceId: `bt-filing:${bt.id}`,
    idempotencyKey,
    settlementDate,
    kind: cls.kind,
    amountCents,
    bankAccountId: bankAcct.accountId,
    bankAccountCode: bankAcct.accountCode,
    bankTransactionId: bt.id,
    memo: `${bt.filing_title || cls.label}${suffix}`.slice(0, 300),
  });
}

async function reconcileRemovedTaxFilingSettlements(conn, from, to, ctx, hasSourceKey) {
  const revCols = [
    'e.id', 'e.idempotency_key', 'e.reversed_by_entry_id', conn.raw('e.entry_date::text as entry_date'),
    'bt.id as bt_id', 'bt.matched_tax_filing_id', 'bt.updated_at',
    'tfc.filing_type', 'tfc.title as filing_title',
  ];
  if (hasSourceKey) revCols.push('tfc.source_key as filing_source_key');

  const bookedFilings = await conn('gl_journal_entries as e')
    .leftJoin('bank_transactions as bt', conn.raw("e.source_id = 'bt-filing:' || bt.id::text"))
    .leftJoin('tax_filing_calendar as tfc', 'tfc.id', 'bt.matched_tax_filing_id')
    .where('e.status', 'posted')
    .whereNull('e.reversed_by_entry_id')
    .whereIn('e.source_type', ['payroll_remittance', 'sales_tax_remittance'])
    .where('e.source_id', 'like', 'bt-filing:%')
    .where((win) => {
      win.whereBetween('e.entry_date', [from, to])
        .orWhereRaw("bt.updated_at IS NOT NULL AND DATE(bt.updated_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
    })
    .select(...revCols);

  const today = etDateString(new Date());
  for (const row of bookedFilings) {
    const currentKey = row.bt_id && row.matched_tax_filing_id
      ? settlementKeyForTaxFiling(row.bt_id, classifyTaxFilingSettlement(row))
      : null;
    if (currentKey && matchesSettlementKeyBase(row.idempotency_key, currentKey)) continue;
    const entryDay = dateCellText(row.entry_date);
    const fallbackRevDate = today >= entryDay && today <= to ? today : (to >= entryDay ? to : entryDay);
    const revDate = row.updated_at ? latestAdjustmentDate(entryDay, [row.updated_at]) : fallbackRevDate;
    await reverseOrPreview(row, revDate, 'Bank tax filing link removed or reclassified', ctx, 'payroll_settlements');
  }
}

async function syncBankMatchedTaxFilings(conn, from, to, ctx, plaidGlLookup, bankCaps) {
  if (!bankCaps.hasFilingMatch || !(await conn.schema.hasTable('tax_filing_calendar'))) return;
  const hasSourceKey = await hasSchemaColumn(conn, 'tax_filing_calendar', 'source_key');

  const cols = [
    'bt.id', conn.raw('bt.txn_date::text as txn_date'), 'bt.amount', 'bt.description',
    'bt.account_label', 'bt.account_type', 'bt.matched_tax_filing_id',
    'tfc.filing_type', 'tfc.title as filing_title', 'tfc.period_label as filing_period_label',
  ];
  if (hasSourceKey) cols.push('tfc.source_key as filing_source_key');
  if (bankCaps.hasPlaidCol) cols.push('bt.plaid_account_id');

  const rows = await conn('bank_transactions as bt')
    .join('tax_filing_calendar as tfc', 'tfc.id', 'bt.matched_tax_filing_id')
    .whereNotNull('bt.matched_tax_filing_id')
    .where('bt.direction', 'debit')
    .where((win) => {
      win.whereBetween('bt.txn_date', [from, to])
        .orWhereRaw("DATE(COALESCE(bt.matched_at, bt.updated_at) AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to]);
    })
    .select(...cols);

  for (const bt of rows) {
    const cls = classifyTaxFilingSettlement(bt);
    if (!cls) continue;
    const settlementDate = dateCellText(bt.txn_date);
    const amountCents = dollarsToCents(bt.amount);
    if (!settlementDate || !amountCents || amountCents <= 0) continue;

    const keyBase = settlementKeyForTaxFiling(bt.id, cls);
    const buildEntry = (idempotencyKey) => buildTaxFilingSettlementEntry(
      bt, cls, settlementDate, amountCents, plaidGlLookup, idempotencyKey,
    );
    const applyFiling = (trx) => postOrRepostSettlement(trx, {
      keyBase, buildEntry, ctx, bucket: 'payroll_settlements',
    });

    if (ctx.dryRun) {
      await applyFiling(ctx.conn);
    } else {
      await withEntitySyncLock(ctx.conn, `gl-sync-bt-filing:${bt.id}`, applyFiling);
    }
  }

  await reconcileRemovedTaxFilingSettlements(conn, from, to, ctx, hasSourceKey);
}

async function syncPayrollSettlements(conn, from, to, ctx, plaidGlLookup, bankCaps) {
  await syncMercuryPayrollPayments(conn, from, to, ctx, plaidGlLookup, bankCaps);
  await syncBankMatchedPayrollChecks(conn, from, to, ctx, plaidGlLookup, bankCaps);
  await syncBankMatchedTaxFilings(conn, from, to, ctx, plaidGlLookup, bankCaps);
}

async function syncSubledgersToGl({ fromDate = null, toDate = null, dryRun = false, actorId = null, requestMeta = {}, conn = db } = {}) {
  const today = etDateString(new Date());
  const from = assertValidDate(fromDate || `${today.slice(0, 4)}-01-01`, 'fromDate');
  const to = assertValidDate(toDate || today, 'toDate');
  const [missingSystemAccounts, caches, plaidGlLookup, bankCaps] = await Promise.all([
    findMissingSystemAccountCodes(conn),
    loadSyncCaches(conn),
    loadPlaidGlAccountLookup(conn),
    loadBankTxnCapabilities(conn),
  ]);

  const makeBucket = (extra = {}) => ({ posted: 0, skipped: 0, would_post: 0, errors: [], ...extra });
  const stats = {
    from,
    to,
    dry_run: Boolean(dryRun),
    missing_system_accounts: missingSystemAccounts,
    customer_credits: makeBucket(),
    invoices: makeBucket({ adjusted: 0, would_adjust: 0, reversed: 0, would_reverse: 0 }),
    deposits: makeBucket(),
    payments: makeBucket({ reversed: 0, would_reverse: 0 }),
    refunds: makeBucket({ reversed: 0, would_reverse: 0, needs_review: [] }),
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
    payroll_settlements: makeBucket({ reversed: 0, would_reverse: 0 }),
  };

  const ctx = { dryRun: Boolean(dryRun), actorId, requestMeta, stats, conn, caches };
  await syncCustomerCredits(conn, from, to, ctx);
  await syncInvoices(conn, from, to, ctx);
  await syncCompletedAnnualPrepayVisits(conn, from, to, ctx);
  await syncEstimateDeposits(conn, from, to, ctx);
  await syncPayments(conn, from, to, ctx);
  await syncStripeInvoiceGapPayments(conn, from, to, ctx);
  await syncStripeRefundsAndOutflows(conn, from, to, ctx);
  await syncManualRefunds(conn, from, to, ctx);
  await syncStripeFees(conn, from, to, ctx);
  await syncStripePayouts(conn, from, to, ctx);
  await syncExpenses(conn, from, to, ctx, plaidGlLookup, bankCaps);
  await syncPayrollRuns(conn, from, to, ctx);
  await syncPayrollSettlements(conn, from, to, ctx, plaidGlLookup, bankCaps);

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
  computePrepayRefundUnearnedCents,
  allocateStatementPrincipalAcrossInvoices,
  allocateStatementRefundAcrossInvoices,
  allocateCombinedRefundAcrossShares,
  splitDepositRefundCents,
  findMatchingDepositForOutflow,
  computePrepayVisitRecognitionCents,
  isPrepayTermCoverageValid,
  computeGapReceiptAmounts,
  isDisputeOutflow,
  isInvoiceLinkedCreditRow,
  isRefundCreditRestorationRow,
  extractStripeDisputeTokens,
  resolveBankTxnGlAccount,
  classifyTaxFilingSettlement,
  isBankCheckSupersededByMercury,
  matchesSettlementKeyBase,
  decideExpenseVendorAction,
  extractMerchantRefundTarget,
  recoverGrossExpenseCents,
  buildMerchantRefundDeltaEntry,
  buildExpenseSplits,
  buildInvoiceGlPayload,
  buildRefundedDepositRestorePayload,
  buildInvoiceDeltaEntry,
  timestampToUtcDate,
};
