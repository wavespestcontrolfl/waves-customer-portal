/**
 * True Bank & Credit Card Statement Reconciliation (QuickBooks-style).
 *
 * Opening balance + cleared statement activity must equal Statement Ending Balance
 * to $0.00 (difference_cents === 0) before a reconciliation can be finalized.
 * Finalized lines are protected from silent modification by a Postgres trigger.
 */

const db = require('../../models/db');
const { recordAuditEvent } = require('../audit-log');
const { naturalBalanceCents, dateCellText } = require('./coa-seed');
const { AccountingError, assertValidDate, assertOptionalUuid } = require('./ledger');

const RECONCILABLE_SUB_TYPES = new Set([
  'checking', 'savings', 'stripe_clearing', 'undeposited_funds', 'credit_card', 'loan_payable',
]);

function computeReconciliationMath(account, openingBalanceCents, endingBalanceCents, clearedLines) {
  let clearedActivityCents = 0;
  for (const line of clearedLines) {
    clearedActivityCents += naturalBalanceCents(account, line.debit_cents, line.credit_cents);
  }
  const clearedBalanceCents = Math.trunc(Number(openingBalanceCents) || 0) + clearedActivityCents;
  const differenceCents = Math.trunc(Number(endingBalanceCents) || 0) - clearedBalanceCents;
  return {
    cleared_activity_cents: clearedActivityCents,
    cleared_balance_cents: clearedBalanceCents,
    difference_cents: differenceCents,
    cleared_line_count: clearedLines.length,
    can_finish: differenceCents === 0,
  };
}

async function listReconciliations({ accountId = null, conn = db } = {}) {
  let q = conn('gl_reconciliations as r')
    .join('gl_accounts as a', 'a.id', 'r.account_id')
    .orderBy('r.statement_end_date', 'desc')
    .orderBy('r.created_at', 'desc')
    .select(
      'r.*',
      conn.raw('r.statement_start_date::text as statement_start_date'),
      conn.raw('r.statement_end_date::text as statement_end_date'),
      'a.code as account_code',
      'a.name as account_name',
      'a.account_type',
      'a.sub_type',
      'a.normal_balance',
    );
  if (accountId) q = q.where('r.account_id', assertOptionalUuid(accountId, 'accountId'));
  const rows = await q;
  return rows.map((r) => ({
    ...r,
    statement_start_date: dateCellText(r.statement_start_date),
    statement_end_date: dateCellText(r.statement_end_date),
    opening_balance_cents: Number(r.opening_balance_cents),
    ending_balance_cents: Number(r.ending_balance_cents),
    cleared_balance_cents: Number(r.cleared_balance_cents),
    difference_cents: Number(r.difference_cents),
    cleared_line_count: Number(r.cleared_line_count),
  }));
}

async function startReconciliation({
  accountId,
  statementStartDate = null,
  statementEndDate,
  openingBalanceCents = null,
  endingBalanceCents,
  notes = null,
  actorId = null,
  requestMeta = {},
  conn = db,
}) {
  const validAcctId = assertOptionalUuid(accountId, 'accountId');
  if (!validAcctId) throw new AccountingError(400, 'accountId is required');
  const endDate = assertValidDate(statementEndDate, 'statementEndDate');
  const startDate = statementStartDate ? assertValidDate(statementStartDate, 'statementStartDate') : null;
  if (startDate && startDate > endDate) {
    throw new AccountingError(400, 'statementStartDate cannot be after statementEndDate');
  }
  const endingCents = Number(endingBalanceCents);
  if (!Number.isSafeInteger(endingCents)) {
    throw new AccountingError(400, 'endingBalanceCents must be an exact integer in cents');
  }

  return conn.transaction(async (trx) => {
    const account = await trx('gl_accounts').where({ id: validAcctId }).first();
    if (!account) throw new AccountingError(404, 'Account not found');
    if (!RECONCILABLE_SUB_TYPES.has(account.sub_type)) {
      throw new AccountingError(400, `Account ${account.code} (${account.name}) is not a reconcilable bank, card, clearing, or loan account`);
    }

    const open = await trx('gl_reconciliations')
      .where({ account_id: validAcctId, status: 'in_progress' })
      .first('id');
    if (open) {
      throw new AccountingError(409, 'An in-progress reconciliation already exists for this account. Finish or continue it first.');
    }

    const prior = await trx('gl_reconciliations')
      .where({ account_id: validAcctId, status: 'reconciled' })
      .orderBy('statement_end_date', 'desc')
      .select(trx.raw('statement_end_date::text as statement_end_date'), 'ending_balance_cents')
      .first();

    if (prior) {
      const priorEndDate = dateCellText(prior.statement_end_date);
      if (priorEndDate && endDate <= priorEndDate) {
        throw new AccountingError(
          409,
          `Statement end date (${endDate}) must be after the latest finalized statement (${priorEndDate}). Reopen the later statement first to reconcile an earlier period.`,
          'STATEMENT_DATE_ORDER',
        );
      }
    }

    let openingCents;
    if (prior) {
      const priorEndingCents = Number(prior.ending_balance_cents);
      if (openingBalanceCents != null) {
        const supplied = Number(openingBalanceCents);
        if (!Number.isSafeInteger(supplied)) {
          throw new AccountingError(400, 'openingBalanceCents must be an exact integer in cents');
        }
        if (supplied !== priorEndingCents) {
          throw new AccountingError(
            409,
            `Opening balance ($${(supplied / 100).toFixed(2)}) must match the prior finalized statement ending balance ($${(priorEndingCents / 100).toFixed(2)}).`,
            'OPENING_BALANCE_MISMATCH',
          );
        }
      }
      openingCents = priorEndingCents;
    } else if (openingBalanceCents != null) {
      openingCents = Number(openingBalanceCents);
      if (!Number.isSafeInteger(openingCents)) {
        throw new AccountingError(400, 'openingBalanceCents must be an exact integer in cents');
      }
    } else {
      openingCents = 0;
    }

    const diffCents = endingCents - openingCents;
    const [created] = await trx('gl_reconciliations')
      .insert({
        account_id: validAcctId,
        statement_start_date: startDate,
        statement_end_date: endDate,
        opening_balance_cents: openingCents,
        ending_balance_cents: endingCents,
        cleared_balance_cents: openingCents,
        difference_cents: diffCents,
        cleared_line_count: 0,
        status: 'in_progress',
        notes: notes ? String(notes).trim().slice(0, 500) : null,
      })
      .returning('*');

    await recordAuditEvent({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId,
      action: 'accounting.reconciliation.start',
      resource_type: 'gl_reconciliation',
      resource_id: created.id,
      metadata: {
        account_code: account.code,
        statement_end_date: endDate,
        opening_balance_cents: openingCents,
        ending_balance_cents: endingCents,
      },
      ip_address: requestMeta.ip || null,
      user_agent: requestMeta.userAgent || null,
      critical: true,
      trx,
    });

    return getReconciliationWorkspace(created.id, { conn: trx });
  });
}

async function getReconciliationWorkspace(reconciliationId, { conn = db } = {}) {
  const validId = assertOptionalUuid(reconciliationId, 'reconciliationId');
  if (!validId) throw new AccountingError(400, 'reconciliationId is required');

  const rec = await conn('gl_reconciliations')
    .where({ id: validId })
    .select(
      '*',
      conn.raw('statement_start_date::text as statement_start_date'),
      conn.raw('statement_end_date::text as statement_end_date'),
    )
    .first();
  if (!rec) throw new AccountingError(404, 'Reconciliation not found');
  const account = await conn('gl_accounts').where({ id: rec.account_id }).first();
  const endDate = dateCellText(rec.statement_end_date);

  const lines = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .leftJoin('gl_vendors as v', 'v.id', 'l.vendor_id')
    .where('l.account_id', rec.account_id)
    .where('e.status', 'posted')
    .where('e.entry_date', '<=', endDate)
    .where((q) => {
      if (rec.status === 'reconciled') {
        q.where('l.reconciliation_id', validId);
      } else {
        q.whereNull('l.reconciliation_id').orWhere('l.reconciliation_id', validId);
      }
    })
    .orderBy('e.entry_date', 'asc')
    .orderBy('e.entry_number', 'asc')
    .select(
      'l.id',
      'l.entry_id',
      'l.debit_cents',
      'l.credit_cents',
      'l.memo as line_memo',
      'l.reconciliation_id',
      'e.entry_number',
      conn.raw('e.entry_date::text as entry_date'),
      'e.entry_type',
      'e.source_type',
      'e.memo as entry_memo',
      'e.reference',
      'v.display_name as vendor_name',
    );

  const formatted = lines.map((l) => {
    const debitCents = Number(l.debit_cents);
    const creditCents = Number(l.credit_cents);
    return {
      id: l.id,
      entry_id: l.entry_id,
      entry_number: Number(l.entry_number),
      entry_date: dateCellText(l.entry_date),
      entry_type: l.entry_type,
      source_type: l.source_type,
      memo: l.line_memo || l.entry_memo,
      reference: l.reference,
      vendor_name: l.vendor_name || null,
      debit_cents: debitCents,
      credit_cents: creditCents,
      delta_cents: naturalBalanceCents(account, debitCents, creditCents),
      cleared: l.reconciliation_id === validId,
    };
  });

  const clearedLines = formatted.filter((l) => l.cleared);
  const math = computeReconciliationMath(account, rec.opening_balance_cents, rec.ending_balance_cents, clearedLines);

  return {
    reconciliation: {
      ...rec,
      statement_start_date: dateCellText(rec.statement_start_date),
      statement_end_date: endDate,
      opening_balance_cents: Number(rec.opening_balance_cents),
      ending_balance_cents: Number(rec.ending_balance_cents),
      ...math,
    },
    account,
    lines: formatted,
  };
}

async function toggleClearedLines(reconciliationId, { lineIds, cleared, actorId = null, requestMeta = {}, conn = db }) {
  const validId = assertOptionalUuid(reconciliationId, 'reconciliationId');
  if (!validId) throw new AccountingError(400, 'reconciliationId is required');
  if (!Array.isArray(lineIds) || !lineIds.length) {
    throw new AccountingError(400, 'lineIds[] is required');
  }
  const cleanIds = lineIds.map((id, i) => assertOptionalUuid(id, `lineIds[${i}]`));
  const shouldClear = Boolean(cleared);

  return conn.transaction(async (trx) => {
    const rec = await trx('gl_reconciliations')
      .where({ id: validId })
      .forUpdate()
      .select('*', trx.raw('statement_end_date::text as statement_end_date'))
      .first();
    if (!rec) throw new AccountingError(404, 'Reconciliation not found');
    if (rec.status !== 'in_progress') {
      throw new AccountingError(409, 'Only an in-progress reconciliation can clear or unclear lines');
    }

    const account = await trx('gl_accounts').where({ id: rec.account_id }).first();
    const endDate = dateCellText(rec.statement_end_date);

    let updatedRows = [];
    if (shouldClear) {
      updatedRows = await trx('gl_journal_lines')
        .whereIn('id', cleanIds)
        .where('account_id', rec.account_id)
        .whereNull('reconciliation_id')
        .whereIn('entry_id', function eligibleEntries() {
          this.select('id')
            .from('gl_journal_entries')
            .where('status', 'posted')
            .where('entry_date', '<=', endDate);
        })
        .update({ reconciliation_id: validId, cleared_at: trx.fn.now() })
        .returning('id');
    } else {
      updatedRows = await trx('gl_journal_lines')
        .whereIn('id', cleanIds)
        .where('reconciliation_id', validId)
        .update({ reconciliation_id: null, cleared_at: null })
        .returning('id');
    }

    const clearedLines = await trx('gl_journal_lines')
      .where({ reconciliation_id: validId })
      .select('debit_cents', 'credit_cents');
    const math = computeReconciliationMath(account, rec.opening_balance_cents, rec.ending_balance_cents, clearedLines);

    await trx('gl_reconciliations')
      .where({ id: validId })
      .update({
        cleared_balance_cents: math.cleared_balance_cents,
        difference_cents: math.difference_cents,
        cleared_line_count: math.cleared_line_count,
        updated_at: trx.fn.now(),
      });

    const changedLineIds = (updatedRows || []).map((r) => (typeof r === 'string' ? r : r.id)).filter(Boolean);
    await recordAuditEvent({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId,
      action: shouldClear ? 'accounting.reconciliation.clear_lines' : 'accounting.reconciliation.unclear_lines',
      resource_type: 'gl_reconciliation',
      resource_id: validId,
      metadata: {
        account_code: account.code,
        statement_end_date: endDate,
        cleared: shouldClear,
        requested_line_ids: cleanIds,
        changed_line_ids: changedLineIds,
        cleared_line_count: math.cleared_line_count,
        difference_cents: math.difference_cents,
      },
      ip_address: requestMeta.ip || null,
      user_agent: requestMeta.userAgent || null,
      critical: true,
      trx,
    });

    return getReconciliationWorkspace(validId, { conn: trx });
  });
}

async function finishReconciliation(reconciliationId, { actorId = null, requestMeta = {}, conn = db } = {}) {
  const validId = assertOptionalUuid(reconciliationId, 'reconciliationId');
  if (!validId) throw new AccountingError(400, 'reconciliationId is required');

  return conn.transaction(async (trx) => {
    const rec = await trx('gl_reconciliations')
      .where({ id: validId })
      .forUpdate()
      .select('*', trx.raw('statement_end_date::text as statement_end_date'))
      .first();
    if (!rec) throw new AccountingError(404, 'Reconciliation not found');
    if (rec.status !== 'in_progress') {
      throw new AccountingError(409, 'Reconciliation is not in progress');
    }

    const account = await trx('gl_accounts').where({ id: rec.account_id }).first();
    const clearedLines = await trx('gl_journal_lines')
      .where({ reconciliation_id: validId })
      .select('debit_cents', 'credit_cents');
    const math = computeReconciliationMath(account, rec.opening_balance_cents, rec.ending_balance_cents, clearedLines);

    if (math.difference_cents !== 0) {
      throw new AccountingError(
        409,
        `Cannot finalize reconciliation: difference is $${(math.difference_cents / 100).toFixed(2)} (must be $0.00)`,
        'RECONCILIATION_UNBALANCED',
      );
    }

    await trx('gl_reconciliations')
      .where({ id: validId })
      .update({
        status: 'reconciled',
        cleared_balance_cents: math.cleared_balance_cents,
        difference_cents: 0,
        cleared_line_count: math.cleared_line_count,
        reconciled_at: trx.fn.now(),
        reconciled_by: actorId,
        updated_at: trx.fn.now(),
      });

    await recordAuditEvent({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId,
      action: 'accounting.reconciliation.finish',
      resource_type: 'gl_reconciliation',
      resource_id: validId,
      metadata: {
        account_code: account.code,
        statement_end_date: dateCellText(rec.statement_end_date),
        ending_balance_cents: Number(rec.ending_balance_cents),
        cleared_line_count: math.cleared_line_count,
      },
      ip_address: requestMeta.ip || null,
      user_agent: requestMeta.userAgent || null,
      critical: true,
      trx,
    });

    return getReconciliationWorkspace(validId, { conn: trx });
  });
}

async function reopenReconciliation(reconciliationId, { reason = '', actorId = null, requestMeta = {}, conn = db } = {}) {
  const validId = assertOptionalUuid(reconciliationId, 'reconciliationId');
  if (!validId) throw new AccountingError(400, 'reconciliationId is required');
  const cleanReason = String(reason || '').trim().slice(0, 300);
  if (!cleanReason) throw new AccountingError(400, 'A reason is required to reopen a reconciliation');

  return conn.transaction(async (trx) => {
    const rec = await trx('gl_reconciliations')
      .where({ id: validId })
      .forUpdate()
      .select('*', trx.raw('statement_end_date::text as statement_end_date'))
      .first();
    if (!rec) throw new AccountingError(404, 'Reconciliation not found');
    if (rec.status !== 'reconciled') {
      throw new AccountingError(409, 'Only a finalized reconciliation can be reopened');
    }

    const open = await trx('gl_reconciliations')
      .where({ account_id: rec.account_id, status: 'in_progress' })
      .first('id');
    if (open) {
      throw new AccountingError(409, 'Finish or clear the existing in-progress reconciliation on this account first');
    }

    await trx('gl_reconciliations')
      .where({ id: validId })
      .update({
        status: 'in_progress',
        reopened_at: trx.fn.now(),
        reopened_by: actorId,
        notes: `${rec.notes ? `${rec.notes}\n` : ''}Reopened: ${cleanReason}`.slice(0, 1000),
        updated_at: trx.fn.now(),
      });

    await recordAuditEvent({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId,
      action: 'accounting.reconciliation.reopen',
      resource_type: 'gl_reconciliation',
      resource_id: validId,
      metadata: { reason: cleanReason, statement_end_date: dateCellText(rec.statement_end_date) },
      ip_address: requestMeta.ip || null,
      user_agent: requestMeta.userAgent || null,
      critical: true,
      trx,
    });

    return getReconciliationWorkspace(validId, { conn: trx });
  });
}

module.exports = {
  RECONCILABLE_SUB_TYPES,
  computeReconciliationMath,
  listReconciliations,
  startReconciliation,
  getReconciliationWorkspace,
  toggleClearedLines,
  finishReconciliation,
  reopenReconciliation,
};
