/**
 * Core General Ledger Engine — immutable double-entry journal posting, reversals,
 * Chart of Accounts management, and running-balance Account Registers.
 *
 * Invariants enforced both in JS (fast, clear 400/409 errors) and in Postgres:
 * - Every journal entry has >= 2 lines and SUM(debit_cents) === SUM(credit_cents).
 * - Every line has strictly one positive side (debit OR credit), exact integer cents.
 * - Dates are calendar-validated Eastern dates ('YYYY-MM-DD').
 * - Entries dated inside a 'locked' gl_periods month are refused.
 * - Reversals create an exact mirror entry (never delete history).
 * - Every write logs a critical audit_log event in the same transaction.
 */

const db = require('../../models/db');
const { etDateString, validCalendarDate } = require('../../utils/datetime-et');
const { recordAuditEvent } = require('../audit-log');
const {
  ACCOUNT_TYPES,
  NORMAL_BALANCE_BY_TYPE,
  naturalBalanceCents,
  dateCellText,
} = require('./coa-seed');

const ENTRY_TYPES = new Set([
  'operational', 'adjusting', 'opening_balance', 'depreciation', 'transfer', 'reversal', 'closing',
]);
const BASIS_SCOPES = new Set(['both', 'accrual_only', 'cash_only']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINE_CENTS = 99_999_999_999; // ~$1B single line guard

class AccountingError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'AccountingError';
    this.status = status;
    this.code = code;
  }
}

function assertValidDate(dateStr, field = 'entryDate') {
  if (typeof dateStr !== 'string' || !validCalendarDate(dateStr)) {
    throw new AccountingError(400, `${field} must be a valid YYYY-MM-DD calendar date`);
  }
  return dateStr;
}

function assertOptionalUuid(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new AccountingError(400, `${field} must be a valid UUID`);
  }
  return value.toLowerCase();
}

function pickKey(obj, camel, snake, fallback = undefined) {
  if (obj[camel] !== undefined) return obj[camel];
  if (obj[snake] !== undefined) return obj[snake];
  return fallback;
}

function optionalText(value, maxLen) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, maxLen) : null;
}

function parseLineSides(raw, index) {
  const debitCents = Number(pickKey(raw, 'debitCents', 'debit_cents', 0));
  const creditCents = Number(pickKey(raw, 'creditCents', 'credit_cents', 0));
  if (!Number.isSafeInteger(debitCents) || !Number.isSafeInteger(creditCents)) {
    throw new AccountingError(400, `Line ${index + 1} debitCents and creditCents must be exact integer cents`);
  }
  if (debitCents < 0 || creditCents < 0 || debitCents > MAX_LINE_CENTS || creditCents > MAX_LINE_CENTS) {
    throw new AccountingError(400, `Line ${index + 1} amount out of valid range`);
  }
  if ((debitCents > 0) === (creditCents > 0)) {
    throw new AccountingError(400, `Line ${index + 1} must have strictly positive debit OR credit (never both or zero)`);
  }
  return { debitCents, creditCents };
}

function normalizeLine(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new AccountingError(400, `Line ${index + 1} must be an object`);
  }
  const accountId = assertOptionalUuid(pickKey(raw, 'accountId', 'account_id'), `lines[${index}].accountId`);
  const accountCode = optionalText(pickKey(raw, 'accountCode', 'account_code'), 16);
  if (!accountId && !accountCode) {
    throw new AccountingError(400, `Line ${index + 1} requires accountId or accountCode`);
  }
  const { debitCents, creditCents } = parseLineSides(raw, index);

  return {
    line_order: index,
    account_id: accountId,
    account_code: accountCode,
    debit_cents: debitCents,
    credit_cents: creditCents,
    memo: optionalText(raw.memo, 300),
    customer_id: assertOptionalUuid(pickKey(raw, 'customerId', 'customer_id'), `lines[${index}].customerId`),
    vendor_id: assertOptionalUuid(pickKey(raw, 'vendorId', 'vendor_id'), `lines[${index}].vendorId`),
    service_line: optionalText(pickKey(raw, 'serviceLine', 'service_line'), 40),
    invoice_ref: optionalText(pickKey(raw, 'invoiceRef', 'invoice_ref'), 120),
    payment_method: optionalText(pickKey(raw, 'paymentMethod', 'payment_method'), 30),
    scheduled_service_id: assertOptionalUuid(pickKey(raw, 'scheduledServiceId', 'scheduled_service_id'), `lines[${index}].scheduledServiceId`),
    bank_transaction_id: assertOptionalUuid(pickKey(raw, 'bankTransactionId', 'bank_transaction_id'), `lines[${index}].bankTransactionId`),
  };
}

function assertBalancedLines(lines) {
  let totalDebits = 0n;
  let totalCredits = 0n;
  for (const l of lines) {
    totalDebits += BigInt(l.debit_cents);
    totalCredits += BigInt(l.credit_cents);
  }
  if (totalDebits !== totalCredits) {
    const diff = Number(totalDebits - totalCredits);
    throw new AccountingError(
      400,
      `Journal entry is out of balance by $${(Math.abs(diff) / 100).toFixed(2)} (debits=${totalDebits}c, credits=${totalCredits}c)`,
      'UNBALANCED_ENTRY',
    );
  }
  return Number(totalDebits);
}

/**
 * Pure validation of a double-entry journal payload.
 * Returns normalized { entry_date, entry_type, basis_scope, source_type, source_id,
 * idempotency_key, memo, reference, lines, totalCents }.
 */
function validateJournalEntryInput(input) {
  if (!input || typeof input !== 'object') {
    throw new AccountingError(400, 'Journal entry payload is required');
  }
  const entryDate = assertValidDate(pickKey(input, 'entryDate', 'entry_date'), 'entryDate');
  const entryType = String(pickKey(input, 'entryType', 'entry_type', 'adjusting')).trim();
  if (!ENTRY_TYPES.has(entryType)) throw new AccountingError(400, `Invalid entryType: ${entryType}`);
  const basisScope = String(pickKey(input, 'basisScope', 'basis_scope', 'both')).trim();
  if (!BASIS_SCOPES.has(basisScope)) throw new AccountingError(400, `Invalid basisScope: ${basisScope}`);

  const memo = String(input.memo || '').trim();
  if (!memo || memo.length > 500) throw new AccountingError(400, 'memo is required (1–500 chars)');

  const rawLines = input.lines;
  if (!Array.isArray(rawLines) || rawLines.length < 2 || rawLines.length > 200) {
    throw new AccountingError(400, 'A journal entry requires between 2 and 200 balanced lines');
  }

  const lines = rawLines.map((line, i) => normalizeLine(line, i));
  const totalCents = assertBalancedLines(lines);

  return {
    entry_date: entryDate,
    entry_type: entryType,
    basis_scope: basisScope,
    source_type: optionalText(pickKey(input, 'sourceType', 'source_type', 'manual'), 40) || 'manual',
    source_id: optionalText(pickKey(input, 'sourceId', 'source_id'), 120),
    idempotency_key: optionalText(pickKey(input, 'idempotencyKey', 'idempotency_key'), 200),
    memo,
    reference: optionalText(input.reference, 120),
    reverses_entry_id: assertOptionalUuid(pickKey(input, 'reversesEntryId', 'reverses_entry_id'), 'reversesEntryId'),
    lines,
    totalCents,
  };
}

async function acquirePeriodLock(trx, periodMonth) {
  if (trx && typeof trx.raw === 'function') {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`gl-period:${periodMonth}`]);
  }
}

async function assertPeriodOpen(trx, entryDate) {
  const periodMonth = entryDate.slice(0, 7);
  await acquirePeriodLock(trx, periodMonth);
  const period = await trx('gl_periods').where({ period_month: periodMonth }).first('status');
  if (period && period.status === 'locked') {
    throw new AccountingError(
      409,
      `Accounting period ${periodMonth} is locked. Post an adjusting or reversing entry in an open period.`,
      'PERIOD_LOCKED',
    );
  }
}

async function resolveLineAccounts(trx, lines) {
  const ids = [...new Set(lines.map((l) => l.account_id).filter(Boolean))];
  const codes = [...new Set(lines.map((l) => l.account_code).filter(Boolean))];

  const rows = await trx('gl_accounts')
    .where((q) => {
      if (ids.length) q.orWhereIn('id', ids);
      if (codes.length) q.orWhereIn('code', codes);
    })
    .select('id', 'code', 'name', 'active', 'account_type', 'normal_balance');

  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  const byCode = new Map(rows.map((r) => [r.code, r]));

  return lines.map((l, idx) => {
    const acct = l.account_id ? byId.get(l.account_id) : byCode.get(l.account_code);
    if (!acct) {
      throw new AccountingError(400, `Line ${idx + 1}: account ${l.account_code || l.account_id} not found`);
    }
    if (!acct.active) {
      throw new AccountingError(409, `Line ${idx + 1}: account ${acct.code} (${acct.name}) is inactive`);
    }
    return { ...l, account_id: acct.id };
  });
}

async function loadEntryWithLines(conn, entryId) {
  const entry = await conn('gl_journal_entries')
    .where({ id: entryId })
    .select('*', conn.raw('entry_date::text as entry_date'))
    .first();
  if (!entry) return null;
  const lines = await conn('gl_journal_lines as l')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .leftJoin('gl_vendors as v', 'v.id', 'l.vendor_id')
    .where('l.entry_id', entryId)
    .orderBy('l.line_order', 'asc')
    .select(
      'l.*',
      'a.code as account_code',
      'a.name as account_name',
      'a.account_type',
      'a.normal_balance',
      'v.display_name as vendor_name',
    );
  return {
    ...entry,
    entry_date: dateCellText(entry.entry_date),
    lines: lines.map((l) => ({
      ...l,
      debit_cents: Number(l.debit_cents),
      credit_cents: Number(l.credit_cents),
    })),
  };
}

function canonicalLinesFingerprint(lines) {
  return [...(lines || [])]
    .map((l) => [
      String(l.account_id || '').toLowerCase(),
      Math.trunc(Number(l.debit_cents) || 0),
      Math.trunc(Number(l.credit_cents) || 0),
      String(l.customer_id || '').toLowerCase(),
      String(l.vendor_id || '').toLowerCase(),
      String(l.invoice_ref || ''),
    ].join(':'))
    .sort()
    .join('|');
}

function entryPayloadsMatch(existingEntry, normalized, resolvedLines) {
  if (dateCellText(existingEntry.entry_date) !== normalized.entry_date) return false;
  if (existingEntry.entry_type !== normalized.entry_type) return false;
  if (existingEntry.basis_scope !== normalized.basis_scope) return false;
  if (existingEntry.source_type !== normalized.source_type) return false;
  if (existingEntry.memo !== normalized.memo) return false;
  return canonicalLinesFingerprint(existingEntry.lines) === canonicalLinesFingerprint(resolvedLines);
}

/**
 * Resolve stored account normal_balance values for opening balances and reject any
 * caller-supplied normalBalance that conflicts with the Chart of Accounts.
 */
async function resolveOpeningBalanceItems(items, { conn = db } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AccountingError(400, 'At least one opening balance item is required');
  }
  const ids = [...new Set(items.map((i) => assertOptionalUuid(i.accountId ?? i.account_id, 'items[].accountId')).filter(Boolean))];
  const codes = [...new Set(items.map((i) => optionalText(i.accountCode ?? i.account_code, 16)).filter(Boolean))];
  if (!ids.length && !codes.length) {
    throw new AccountingError(400, 'Each opening balance item requires accountId or accountCode');
  }

  const rows = await conn('gl_accounts')
    .where((q) => {
      if (ids.length) q.orWhereIn('id', ids);
      if (codes.length) q.orWhereIn('code', codes);
    })
    .select('id', 'code', 'name', 'active', 'normal_balance');
  const byId = new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));
  const byCode = new Map(rows.map((r) => [r.code, r]));

  return items.map((item, idx) => {
    const accountId = assertOptionalUuid(item.accountId ?? item.account_id, `items[${idx}].accountId`);
    const accountCode = optionalText(item.accountCode ?? item.account_code, 16);
    const acct = accountId ? byId.get(accountId) : byCode.get(accountCode);
    if (!acct) {
      throw new AccountingError(400, `Opening balance item ${idx + 1}: account ${accountCode || accountId} not found`);
    }
    if (!acct.active) {
      throw new AccountingError(409, `Opening balance item ${idx + 1}: account ${acct.code} is inactive`);
    }
    const rawBal = item.balanceCents ?? item.balance_cents;
    if (
      rawBal === null
      || rawBal === undefined
      || typeof rawBal === 'boolean'
      || (typeof rawBal === 'string' && rawBal.trim() === '')
      || !Number.isSafeInteger(Number(rawBal))
    ) {
      throw new AccountingError(
        400,
        `Opening balance item ${idx + 1} (${acct.code} ${acct.name}): balanceCents must be an exact integer in cents`,
      );
    }
    const supplied = item.normalBalance ?? item.normal_balance;
    if (supplied != null && supplied !== '' && supplied !== acct.normal_balance) {
      throw new AccountingError(
        400,
        `Opening balance item ${idx + 1} (${acct.code} ${acct.name}): normalBalance "${supplied}" conflicts with stored normal balance "${acct.normal_balance}"`,
      );
    }
    return {
      accountId: acct.id,
      accountCode: acct.code,
      balanceCents: Number(rawBal),
      normalBalance: acct.normal_balance,
    };
  });
}

/**
 * Post a balanced double-entry journal entry atomically.
 * If `idempotencyKey` already exists with an identical payload, returns `{ entry, created: false }`.
 * If `idempotencyKey` was previously used for a DIFFERENT payload, throws 409 IDEMPOTENCY_CONFLICT.
 */
async function postJournalEntry(input, { conn = db, actorId = null, requestMeta = {} } = {}) {
  const normalized = validateJournalEntryInput(input);

  const run = async (trx) => {
    if (normalized.idempotency_key) {
      const existing = await trx('gl_journal_entries')
        .where({ idempotency_key: normalized.idempotency_key })
        .first('id');
      if (existing) {
        const existingEntry = await loadEntryWithLines(trx, existing.id);
        const resolvedForCompare = await resolveLineAccounts(trx, normalized.lines);
        if (!entryPayloadsMatch(existingEntry, normalized, resolvedForCompare)) {
          throw new AccountingError(
            409,
            'This submission key was already used for a different journal entry. Review the posted entry or open a fresh form before retrying.',
            'IDEMPOTENCY_CONFLICT',
          );
        }
        return { entry: existingEntry, created: false };
      }
    }

    await assertPeriodOpen(trx, normalized.entry_date);
    const resolvedLines = await resolveLineAccounts(trx, normalized.lines);

    const [header] = await trx('gl_journal_entries')
      .insert({
        entry_date: normalized.entry_date,
        entry_type: normalized.entry_type,
        basis_scope: normalized.basis_scope,
        source_type: normalized.source_type,
        source_id: normalized.source_id,
        idempotency_key: normalized.idempotency_key,
        status: 'posted',
        reverses_entry_id: normalized.reverses_entry_id,
        memo: normalized.memo,
        reference: normalized.reference,
        created_by: actorId,
      })
      .returning('*');

    await trx('gl_journal_lines').insert(
      resolvedLines.map((l) => ({
        entry_id: header.id,
        line_order: l.line_order,
        account_id: l.account_id,
        debit_cents: l.debit_cents,
        credit_cents: l.credit_cents,
        memo: l.memo,
        customer_id: l.customer_id,
        vendor_id: l.vendor_id,
        service_line: l.service_line,
        invoice_ref: l.invoice_ref,
        payment_method: l.payment_method,
        scheduled_service_id: l.scheduled_service_id,
        bank_transaction_id: l.bank_transaction_id,
      })),
    );

    await recordAuditEvent({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId,
      action: 'accounting.je.post',
      resource_type: 'gl_journal_entry',
      resource_id: header.id,
      metadata: {
        entry_number: Number(header.entry_number),
        entry_date: normalized.entry_date,
        entry_type: normalized.entry_type,
        source_type: normalized.source_type,
        total_cents: normalized.totalCents,
        line_count: resolvedLines.length,
      },
      ip_address: requestMeta.ip || null,
      user_agent: requestMeta.userAgent || null,
      critical: true,
      trx,
    });

    return { entry: await loadEntryWithLines(trx, header.id), created: true };
  };

  return conn.isTransaction ? run(conn) : conn.transaction(run);
}

/**
 * Reverse an existing journal entry by posting an exact mirror entry (debit <-> credit)
 * in an open period. Original entry is never deleted.
 */
async function reverseJournalEntry(entryId, { reversalDate = null, reason = '', actorId = null, requestMeta = {}, conn = db } = {}) {
  const validId = assertOptionalUuid(entryId, 'entryId');
  if (!validId) throw new AccountingError(400, 'entryId is required');
  const revDate = assertValidDate(reversalDate || etDateString(new Date()), 'reversalDate');
  const cleanReason = String(reason || '').trim().slice(0, 300);
  if (!cleanReason) throw new AccountingError(400, 'A reversal reason is required');

  const run = async (trx) => {
    const orig = await trx('gl_journal_entries').where({ id: validId }).forUpdate().first();
    if (!orig) throw new AccountingError(404, 'Journal entry not found');
    if (orig.reversed_by_entry_id) {
      throw new AccountingError(409, 'Journal entry has already been reversed', 'ALREADY_REVERSED');
    }

    await assertPeriodOpen(trx, revDate);
    const origLines = await trx('gl_journal_lines').where({ entry_id: validId }).orderBy('line_order', 'asc');
    if (origLines.length < 2) {
      throw new AccountingError(409, 'Original journal entry has no reversible lines');
    }

    const mirrorLines = origLines.map((l) => ({
      accountId: l.account_id,
      debitCents: Number(l.credit_cents),
      creditCents: Number(l.debit_cents),
      memo: l.memo ? `Reversal: ${l.memo}`.slice(0, 300) : null,
      customerId: l.customer_id,
      vendorId: l.vendor_id,
      serviceLine: l.service_line,
      invoiceRef: l.invoice_ref,
      paymentMethod: l.payment_method,
      scheduledServiceId: l.scheduled_service_id,
    }));

    const { entry: reversal } = await postJournalEntry({
      entryDate: revDate,
      entryType: 'reversal',
      basisScope: orig.basis_scope,
      sourceType: 'reversal',
      sourceId: orig.id,
      idempotencyKey: `reversal:${orig.id}`,
      reversesEntryId: orig.id,
      memo: `Reversal of JE #${orig.entry_number}: ${cleanReason}`.slice(0, 500),
      reference: orig.reference,
      lines: mirrorLines,
    }, { conn: trx, actorId, requestMeta });

    await trx('gl_journal_entries')
      .where({ id: orig.id })
      .update({ reversed_by_entry_id: reversal.id, updated_at: trx.fn.now() });

    await recordAuditEvent({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId,
      action: 'accounting.je.reverse',
      resource_type: 'gl_journal_entry',
      resource_id: orig.id,
      metadata: {
        original_entry_number: Number(orig.entry_number),
        reversal_entry_id: reversal.id,
        reversal_date: revDate,
        reason: cleanReason,
      },
      ip_address: requestMeta.ip || null,
      user_agent: requestMeta.userAgent || null,
      critical: true,
      trx,
    });

    return { originalId: orig.id, reversal };
  };

  return conn.isTransaction ? run(conn) : conn.transaction(run);
}

/**
 * Audited vendor-link backfill on an existing journal entry's unlinked P&L expense/COGS lines.
 * Never mutates dollar amounts, accounts, or reconciled balance-sheet lines.
 */
async function linkJournalEntryVendor(entryId, { vendorId, reason = 'Link vendor for 1099 tracking', actorId = null, requestMeta = {}, conn = db } = {}) {
  const validEntryId = assertOptionalUuid(entryId, 'entryId');
  const validVendorId = assertOptionalUuid(vendorId, 'vendorId');
  if (!validEntryId || !validVendorId) {
    throw new AccountingError(400, 'entryId and vendorId are required');
  }
  const cleanReason = String(reason || '').trim().slice(0, 300) || 'Link vendor for 1099 tracking';

  const run = async (trx) => {
    const entry = await trx('gl_journal_entries').where({ id: validEntryId }).first('id', 'entry_number', 'status');
    if (!entry) throw new AccountingError(404, 'Journal entry not found');
    const vendor = await trx('gl_vendors').where({ id: validVendorId }).first('id', 'display_name', 'active');
    if (!vendor) throw new AccountingError(404, 'Vendor not found');
    if (!vendor.active) throw new AccountingError(409, `Vendor "${vendor.display_name}" is inactive`);

    const eligible = await trx('gl_journal_lines as l')
      .join('gl_accounts as a', 'a.id', 'l.account_id')
      .where('l.entry_id', validEntryId)
      .whereNull('l.vendor_id')
      .whereNull('l.reconciliation_id')
      .whereIn('a.account_type', ['cogs', 'expense'])
      .select('l.id');
    const lineIds = eligible.map((r) => r.id);
    if (!lineIds.length) {
      return { entry: await loadEntryWithLines(trx, validEntryId), updatedLines: 0 };
    }

    await trx('gl_journal_lines')
      .whereIn('id', lineIds)
      .update({ vendor_id: validVendorId });

    await recordAuditEvent({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId,
      action: 'accounting.je.link_vendor',
      resource_type: 'gl_journal_entry',
      resource_id: validEntryId,
      metadata: {
        entry_number: Number(entry.entry_number),
        vendor_id: validVendorId,
        vendor_name: vendor.display_name,
        updated_line_ids: lineIds,
        reason: cleanReason,
      },
      ip_address: requestMeta.ip || null,
      user_agent: requestMeta.userAgent || null,
      critical: true,
      trx,
    });

    return { entry: await loadEntryWithLines(trx, validEntryId), updatedLines: lineIds.length };
  };

  return conn.isTransaction ? run(conn) : conn.transaction(run);
}

// ── Chart of Accounts CRUD ───────────────────────────────────────────────────

async function listAccounts({ includeInactive = false, conn = db } = {}) {
  let q = conn('gl_accounts as a')
    .leftJoin('plaid_accounts as pa', 'pa.id', 'a.plaid_account_id')
    .orderBy('a.sort_order', 'asc')
    .orderBy('a.code', 'asc')
    .select(
      'a.*',
      'pa.account_label as plaid_account_label',
      'pa.mask as plaid_mask',
    );
  if (!includeInactive) q = q.where('a.active', true);
  const accounts = await q;

  const balances = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .where('e.status', 'posted')
    .groupBy('l.account_id')
    .select(
      'l.account_id',
      conn.raw('COALESCE(SUM(l.debit_cents), 0)::bigint as debit_cents'),
      conn.raw('COALESCE(SUM(l.credit_cents), 0)::bigint as credit_cents'),
      conn.raw('COUNT(*)::int as line_count'),
    );
  const balById = new Map(balances.map((b) => [b.account_id, b]));

  return accounts.map((a) => {
    const b = balById.get(a.id) || { debit_cents: 0, credit_cents: 0, line_count: 0 };
    const debitCents = Number(b.debit_cents);
    const creditCents = Number(b.credit_cents);
    return {
      ...a,
      debit_cents: debitCents,
      credit_cents: creditCents,
      balance_cents: naturalBalanceCents(a, debitCents, creditCents),
      line_count: Number(b.line_count),
    };
  });
}

function parseNewAccountInput(input = {}) {
  const code = String(input.code || '').trim();
  const name = String(input.name || '').trim();
  const accountType = String(pickKey(input, 'accountType', 'account_type', '')).trim();
  if (!/^[0-9]{4}(?:-[0-9]{1,3})?$/.test(code)) {
    throw new AccountingError(400, 'Account code must be 4 digits (e.g. 6410 or 2000-1)');
  }
  if (!name || name.length > 120) throw new AccountingError(400, 'Account name is required (max 120 chars)');
  if (!ACCOUNT_TYPES.includes(accountType)) {
    throw new AccountingError(400, `accountType must be one of ${ACCOUNT_TYPES.join(', ')}`);
  }
  const normalBalance = pickKey(input, 'normalBalance', 'normal_balance', NORMAL_BALANCE_BY_TYPE[accountType]);
  if (!['debit', 'credit'].includes(normalBalance)) {
    throw new AccountingError(400, 'normalBalance must be debit or credit');
  }
  const deductiblePct = Number(pickKey(input, 'deductiblePct', 'deductible_pct', 100));
  if (!Number.isInteger(deductiblePct) || deductiblePct < 0 || deductiblePct > 100) {
    throw new AccountingError(400, 'deductiblePct must be an integer between 0 and 100');
  }
  return {
    code,
    name,
    account_type: accountType,
    sub_type: optionalText(pickKey(input, 'subType', 'sub_type', 'operating_expense'), 40) || 'operating_expense',
    normal_balance: normalBalance,
    parent_account_id: assertOptionalUuid(pickKey(input, 'parentAccountId', 'parent_account_id'), 'parentAccountId'),
    plaid_account_id: assertOptionalUuid(pickKey(input, 'plaidAccountId', 'plaid_account_id'), 'plaidAccountId'),
    schedule_c_line: optionalText(pickKey(input, 'scheduleCLine', 'schedule_c_line'), 16),
    form_1120s_line: optionalText(pickKey(input, 'form1120sLine', 'form_1120s_line'), 16),
    deductible_pct: deductiblePct,
    is_system: false,
    active: true,
    description: optionalText(input.description, 500),
    sort_order: Number.isInteger(Number(input.sortOrder)) ? Number(input.sortOrder) : parseInt(code.slice(0, 4), 10),
  };
}

async function createAccount(input, { actorId = null, requestMeta = {}, conn = db } = {}) {
  const row = parseNewAccountInput(input || {});

  return conn.transaction(async (trx) => {
    const dup = await trx('gl_accounts').where({ code: row.code }).first('id');
    if (dup) throw new AccountingError(409, `Account code ${row.code} already exists`);

    const [created] = await trx('gl_accounts').insert(row).returning('*');
    await recordAuditEvent({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId,
      action: 'accounting.account.create',
      resource_type: 'gl_account',
      resource_id: created.id,
      metadata: { code: created.code, name: created.name, account_type: created.account_type },
      ip_address: requestMeta.ip || null,
      user_agent: requestMeta.userAgent || null,
      critical: true,
      trx,
    });
    return created;
  });
}

function buildAccountUpdatePatch(existing, patch) {
  const update = {};
  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim();
    if (!name || name.length > 120) throw new AccountingError(400, 'Account name must be 1–120 chars');
    update.name = name;
  }
  if (patch.description !== undefined) update.description = optionalText(patch.description, 500);

  const lineVal = pickKey(patch, 'scheduleCLine', 'schedule_c_line');
  if (lineVal !== undefined) update.schedule_c_line = optionalText(lineVal, 16);

  const dedVal = pickKey(patch, 'deductiblePct', 'deductible_pct');
  if (dedVal !== undefined) {
    const pct = Number(dedVal);
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new AccountingError(400, 'deductiblePct must be 0–100');
    update.deductible_pct = pct;
  }

  const plaidVal = pickKey(patch, 'plaidAccountId', 'plaid_account_id');
  if (plaidVal !== undefined) update.plaid_account_id = assertOptionalUuid(plaidVal, 'plaidAccountId');

  if (patch.active !== undefined) {
    if (existing.is_system && patch.active === false) {
      throw new AccountingError(409, 'System accounts cannot be deactivated');
    }
    update.active = Boolean(patch.active);
  }
  return update;
}

async function updateAccount(id, patch, { actorId = null, requestMeta = {}, conn = db } = {}) {
  const validId = assertOptionalUuid(id, 'id');
  if (!validId) throw new AccountingError(400, 'Account id is required');

  return conn.transaction(async (trx) => {
    const existing = await trx('gl_accounts').where({ id: validId }).forUpdate().first();
    if (!existing) throw new AccountingError(404, 'Account not found');

    const update = buildAccountUpdatePatch(existing, patch);
    const [updated] = await trx('gl_accounts')
      .where({ id: validId })
      .update({ ...update, updated_at: trx.fn.now() })
      .returning('*');

    await recordAuditEvent({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId,
      action: 'accounting.account.update',
      resource_type: 'gl_account',
      resource_id: validId,
      metadata: { code: existing.code, changed_fields: Object.keys(update) },
      ip_address: requestMeta.ip || null,
      user_agent: requestMeta.userAgent || null,
      critical: true,
      trx,
    });
    return updated;
  });
}

// ── Journal Entry Listing & Account Register ─────────────────────────────────

function buildJournalListQuery(conn, filters) {
  let q = conn('gl_journal_entries as e');
  if (filters.from) q = q.where('e.entry_date', '>=', assertValidDate(filters.from, 'from'));
  if (filters.to) q = q.where('e.entry_date', '<=', assertValidDate(filters.to, 'to'));
  if (filters.sourceType) q = q.where('e.source_type', String(filters.sourceType).trim());
  if (filters.entryType) q = q.where('e.entry_type', String(filters.entryType).trim());
  const term = optionalText(filters.search, 120);
  if (term) {
    const like = `%${term}%`;
    q = q.where((sub) => sub.where('e.memo', 'ilike', like).orWhere('e.reference', 'ilike', like));
  }
  return q;
}

async function listJournalEntries(opts = {}) {
  const conn = opts.conn || db;
  const safeLimit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
  const safeOffset = Math.max(parseInt(opts.offset, 10) || 0, 0);
  const q = buildJournalListQuery(conn, opts);

  const [{ total }] = await q.clone().count('* as total');
  const headers = await q
    .clone()
    .orderBy('e.entry_date', 'desc')
    .orderBy('e.entry_number', 'desc')
    .limit(safeLimit)
    .offset(safeOffset)
    .select('e.*', conn.raw('e.entry_date::text as entry_date'));

  if (!headers.length) {
    return { entries: [], total: Number(total), limit: safeLimit, offset: safeOffset };
  }

  const allLines = await conn('gl_journal_lines as l')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .leftJoin('gl_vendors as v', 'v.id', 'l.vendor_id')
    .whereIn('l.entry_id', headers.map((h) => h.id))
    .orderBy('l.line_order', 'asc')
    .select('l.*', 'a.code as account_code', 'a.name as account_name', 'a.account_type', 'v.display_name as vendor_name');

  const linesByEntry = new Map();
  for (const l of allLines) {
    const list = linesByEntry.get(l.entry_id) || [];
    list.push({ ...l, debit_cents: Number(l.debit_cents), credit_cents: Number(l.credit_cents) });
    linesByEntry.set(l.entry_id, list);
  }

  return {
    entries: headers.map((h) => {
      const lines = linesByEntry.get(h.id) || [];
      return {
        ...h,
        entry_date: dateCellText(h.entry_date),
        total_cents: lines.reduce((sum, l) => sum + l.debit_cents, 0),
        lines,
      };
    }),
    total: Number(total),
    limit: safeLimit,
    offset: safeOffset,
  };
}

async function queryPriorRunningBalance(q, account, openingCents, safeOffset) {
  let running = openingCents;
  if (safeOffset <= 0) return running;
  const prior = await q
    .clone()
    .orderBy('e.entry_date', 'asc')
    .orderBy('e.entry_number', 'asc')
    .orderBy('l.line_order', 'asc')
    .limit(safeOffset)
    .select('l.debit_cents', 'l.credit_cents');
  for (const p of prior) {
    running += naturalBalanceCents(account, p.debit_cents, p.credit_cents);
  }
  return running;
}

function formatRegisterTransactions(account, rows, startRunning) {
  let running = startRunning;
  const transactions = rows.map((r) => {
    const debitCents = Number(r.debit_cents);
    const creditCents = Number(r.credit_cents);
    const deltaCents = naturalBalanceCents(account, debitCents, creditCents);
    running += deltaCents;
    return {
      id: r.id,
      entry_id: r.entry_id,
      entry_number: Number(r.entry_number),
      entry_date: dateCellText(r.entry_date),
      entry_type: r.entry_type,
      source_type: r.source_type,
      memo: r.line_memo || r.entry_memo,
      reference: r.reference,
      vendor_name: r.vendor_name || null,
      service_line: r.service_line || null,
      debit_cents: debitCents,
      credit_cents: creditCents,
      delta_cents: deltaCents,
      running_balance_cents: running,
      reconciled: r.reconciliation_status === 'reconciled',
      cleared: Boolean(r.reconciliation_id),
      reversed: Boolean(r.reversed_by_entry_id),
    };
  });
  return { transactions, pageClosingCents: running };
}

async function queryAccountOpeningBalance(conn, account, safeFrom) {
  if (!safeFrom) return 0;
  const pre = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .where('l.account_id', account.id)
    .where('e.status', 'posted')
    .where('e.entry_date', '<', safeFrom)
    .first(
      conn.raw('COALESCE(SUM(l.debit_cents), 0)::bigint as debit_cents'),
      conn.raw('COALESCE(SUM(l.credit_cents), 0)::bigint as credit_cents'),
    );
  return naturalBalanceCents(account, pre?.debit_cents, pre?.credit_cents);
}

async function getAccountRegister(accountId, { from = null, to = null, limit = 100, offset = 0, conn = db } = {}) {
  const validId = assertOptionalUuid(accountId, 'accountId');
  if (!validId) throw new AccountingError(400, 'accountId is required');
  const account = await conn('gl_accounts').where({ id: validId }).first();
  if (!account) throw new AccountingError(404, 'Account not found');

  const safeFrom = from ? assertValidDate(from, 'from') : null;
  const safeTo = to ? assertValidDate(to, 'to') : null;
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const openingCents = await queryAccountOpeningBalance(conn, account, safeFrom);

  let q = conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .leftJoin('gl_vendors as v', 'v.id', 'l.vendor_id')
    .leftJoin('gl_reconciliations as r', 'r.id', 'l.reconciliation_id')
    .where('l.account_id', validId)
    .where('e.status', 'posted');
  if (safeFrom) q = q.where('e.entry_date', '>=', safeFrom);
  if (safeTo) q = q.where('e.entry_date', '<=', safeTo);

  const periodSummary = await q
    .clone()
    .first(
      conn.raw('COUNT(*)::int as total'),
      conn.raw('COALESCE(SUM(l.debit_cents), 0)::bigint as debit_cents'),
      conn.raw('COALESCE(SUM(l.credit_cents), 0)::bigint as credit_cents'),
    );
  const total = Number(periodSummary?.total || 0);
  const fullClosingCents = openingCents
    + naturalBalanceCents(account, periodSummary?.debit_cents, periodSummary?.credit_cents);

  const rows = await q
    .clone()
    .orderBy('e.entry_date', 'asc')
    .orderBy('e.entry_number', 'asc')
    .orderBy('l.line_order', 'asc')
    .limit(safeLimit)
    .offset(safeOffset)
    .select(
      'l.id',
      'l.entry_id',
      'l.debit_cents',
      'l.credit_cents',
      'l.memo as line_memo',
      'l.service_line',
      'l.reconciliation_id',
      'l.cleared_at',
      'e.entry_number',
      conn.raw('e.entry_date::text as entry_date'),
      'e.entry_type',
      'e.source_type',
      'e.memo as entry_memo',
      'e.reference',
      'e.reversed_by_entry_id',
      'v.display_name as vendor_name',
      'r.status as reconciliation_status',
    );

  const startRunning = await queryPriorRunningBalance(q, account, openingCents, safeOffset);
  const { transactions, pageClosingCents } = formatRegisterTransactions(account, rows, startRunning);

  return {
    account,
    opening_balance_cents: openingCents,
    page_closing_balance_cents: pageClosingCents,
    closing_balance_cents: fullClosingCents,
    total,
    limit: safeLimit,
    offset: safeOffset,
    transactions,
  };
}

module.exports = {
  AccountingError,
  ENTRY_TYPES,
  BASIS_SCOPES,
  assertValidDate,
  assertOptionalUuid,
  acquirePeriodLock,
  validateJournalEntryInput,
  resolveOpeningBalanceItems,
  postJournalEntry,
  reverseJournalEntry,
  linkJournalEntryVendor,
  loadEntryWithLines,
  listAccounts,
  createAccount,
  updateAccount,
  listJournalEntries,
  getAccountRegister,
};
