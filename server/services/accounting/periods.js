/**
 * Monthly Accounting Periods (Close & Lock Books).
 *
 * Locking a period enforces immutability both in service code and via the Postgres
 * triggers installed in 20261127140000_accounting_gl_core.js.
 */

const db = require('../../models/db');
const { recordAuditEvent } = require('../audit-log');
const { AccountingError } = require('./ledger');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertValidMonth(periodMonth) {
  const m = String(periodMonth || '').trim();
  if (!MONTH_RE.test(m)) {
    throw new AccountingError(400, 'periodMonth must be YYYY-MM (e.g. 2026-10)');
  }
  return m;
}

async function listPeriods({ conn = db } = {}) {
  const [stored, activity] = await Promise.all([
    conn('gl_periods').orderBy('period_month', 'desc').select('*'),
    conn('gl_journal_entries')
      .where({ status: 'posted' })
      .groupByRaw("to_char(entry_date, 'YYYY-MM')")
      .select(
        conn.raw("to_char(entry_date, 'YYYY-MM') as period_month"),
        conn.raw('COUNT(*)::int as entry_count'),
      ),
  ]);

  const byMonth = new Map(stored.map((p) => [p.period_month, p]));
  const countByMonth = new Map(activity.map((a) => [a.period_month, Number(a.entry_count)]));
  const allMonths = [...new Set([...byMonth.keys(), ...countByMonth.keys()])].sort().reverse();

  return allMonths.map((month) => {
    const p = byMonth.get(month);
    return {
      period_month: month,
      status: p ? p.status : 'open',
      entry_count: countByMonth.get(month) || 0,
      closed_at: p?.closed_at || null,
      locked_at: p?.locked_at || null,
      reopened_at: p?.reopened_at || null,
      notes: p?.notes || null,
    };
  });
}

async function transitionPeriod(periodMonth, targetStatus, { notes = null, actorId = null, requestMeta = {}, conn = db } = {}) {
  const month = assertValidMonth(periodMonth);
  const cleanNotes = notes ? String(notes).trim().slice(0, 500) : null;

  return conn.transaction(async (trx) => {
    const existing = await trx('gl_periods').where({ period_month: month }).forUpdate().first();
    const prevStatus = existing ? existing.status : 'open';

    if (targetStatus === 'soft_closed' && prevStatus === 'locked') {
      throw new AccountingError(409, `Period ${month} is locked — reopen it explicitly before changing status`);
    }
    if (targetStatus === 'open' && !cleanNotes) {
      throw new AccountingError(400, 'A reason/note is required to reopen a closed or locked period');
    }

    const now = trx.fn.now();
    const patch = {
      status: targetStatus,
      notes: cleanNotes || existing?.notes || null,
      updated_at: now,
    };
    if (targetStatus === 'soft_closed') {
      patch.closed_at = now;
      patch.closed_by = actorId;
    } else if (targetStatus === 'locked') {
      patch.locked_at = now;
      patch.locked_by = actorId;
      if (!existing?.closed_at) {
        patch.closed_at = now;
        patch.closed_by = actorId;
      }
    } else if (targetStatus === 'open') {
      patch.reopened_at = now;
      patch.reopened_by = actorId;
    }

    let saved;
    if (existing) {
      [saved] = await trx('gl_periods').where({ period_month: month }).update(patch).returning('*');
    } else {
      [saved] = await trx('gl_periods').insert({ period_month: month, ...patch }).returning('*');
    }

    await recordAuditEvent({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId,
      action: `accounting.period.${targetStatus}`,
      resource_type: 'gl_period',
      resource_id: saved.id,
      metadata: { period_month: month, previous_status: prevStatus, new_status: targetStatus, notes: cleanNotes },
      ip_address: requestMeta.ip || null,
      user_agent: requestMeta.userAgent || null,
      critical: true,
      trx,
    });

    return saved;
  });
}

module.exports = {
  assertValidMonth,
  listPeriods,
  closePeriod: (month, opts) => transitionPeriod(month, 'soft_closed', opts),
  lockPeriod: (month, opts) => transitionPeriod(month, 'locked', opts),
  reopenPeriod: (month, opts) => transitionPeriod(month, 'open', opts),
};
