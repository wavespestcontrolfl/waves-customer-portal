/**
 * Review bonuses into pay runs (owner ruling 2026-10-29, D5 part 3a of the
 * first-technician pay plan: "Build the payroll pieces now, switched off", and the
 * plan's item 3, "also imports review bonuses into the pay run"). The import is dark
 * behind GATE_PAYROLL_REVIEW_BONUS_IMPORT and needs GATE_PAYROLL_PAY_LINES.
 *
 * review_incentive_payouts (services/review-incentives.js) holds one row per earned
 * Google review bonus, 'earned' until someone pays it. A pay run turns each earned
 * payout of a W-2 technician into an open 'review_bonus' pay line (source_type
 * 'review_incentive_payout', source_id the payout id), pays it with the check, and
 * finalizing marks the payout 'paid'. Voiding the run puts the payout back to 'earned'.
 *
 * The imported lines are derived data. syncReviewBonusLines runs at the start of
 * draft, recompute and finalize, under the payroll lock, and makes the open imported
 * lines match the payouts again: a bonus the owner marked paid by hand on the Reviews
 * page, or moved to another technician, is never paid by payroll too.
 *
 * Audit events carry ids and counts, never an amount.
 */
const { recordAuditEvent } = require('./audit-log');
const { PayrollError } = require('./payroll-w4');
const { payrollPayLinesLive, payrollReviewBonusImportLive } = require('../config/feature-gates');
const { STAFF_TIME_ZONE, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

const SOURCE_TYPE = 'review_incentive_payout';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE = 'Google review bonus';

// The typeof guards keep a test mock of feature-gates that lacks a reader working (off).
const payLinesOn = () => typeof payrollPayLinesLive === 'function' && payrollPayLinesLive();
const importOn = () => typeof payrollReviewBonusImportLive === 'function' && payrollReviewBonusImportLive();

// The ET calendar date of earned_at, as text so a server time zone can never move a day.
const earnedOnSql = (conn) => conn.raw("to_char((p.earned_at AT TIME ZONE ?)::date, 'YYYY-MM-DD') as earned_on", [STAFF_TIME_ZONE]);
const PAYOUT_COLUMNS = ['p.id', 'p.technician_id', 'p.amount_cents', 'p.status'];

/**
 * Deletes the open imported lines whose payout no longer matches them (paid, gone,
 * moved to another technician, other amount or week), or every open imported line
 * with dropAll (the import gate is off: payroll stops paying review bonuses and they
 * wait on the Reviews page again). Returns the payout ids dropped.
 */
async function dropStaleLines(trx, { lock, dropAll }) {
  const linesQuery = trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE, status: 'open' })
    .select('id', 'technician_id', 'amount_cents', 'source_id', trx.raw("to_char(earned_week_start, 'YYYY-MM-DD') as earned_week_start"));
  if (lock) linesQuery.forUpdate();
  const lines = await linesQuery;
  if (!lines.length) return [];
  const payoutQuery = trx('review_incentive_payouts as p')
    .whereIn('p.id', lines.map((line) => line.source_id).filter((id) => UUID_RE.test(id)))
    .select([...PAYOUT_COLUMNS, earnedOnSql(trx)]);
  if (lock) payoutQuery.forUpdate('p');
  const payouts = new Map((await payoutQuery).map((row) => [row.id, row]));
  const stale = dropAll ? lines : lines.filter((line) => {
    const payout = payouts.get(line.source_id);
    return !payout || payout.status !== 'earned' || payout.technician_id !== line.technician_id
      || Number(payout.amount_cents) !== Number(line.amount_cents)
      || staffWeekStartForWorkDate(payout.earned_on) !== line.earned_week_start;
  });
  if (stale.length) await trx('payroll_pay_lines').whereIn('id', stale.map((line) => line.id)).del();
  return stale.map((line) => line.source_id);
}

/** Inserts a line for every earned payout of a W-2 technician up to weekEnd that has none. */
async function addMissingLines(trx, weekEnd, { lock }) {
  const query = trx('review_incentive_payouts as p')
    .join('technicians as t', 't.id', 'p.technician_id')
    .where('p.status', 'earned')
    .where('p.amount_cents', '>', 0)
    .where('t.employment_type', 'w2')
    .whereRaw('(p.earned_at AT TIME ZONE ?)::date <= ?::date', [STAFF_TIME_ZONE, weekEnd])
    .orderBy([{ column: 'p.earned_at' }, { column: 'p.id' }])
    .select([...PAYOUT_COLUMNS, earnedOnSql(trx)]);
  if (lock) query.forUpdate('p');
  const payouts = await query;
  if (!payouts.length) return [];
  const inserted = await trx('payroll_pay_lines')
    .insert(payouts.map((payout) => ({
      technician_id: payout.technician_id,
      kind: 'review_bonus',
      amount_cents: payout.amount_cents,
      earned_week_start: staffWeekStartForWorkDate(payout.earned_on),
      source_type: SOURCE_TYPE,
      source_id: payout.id,
      note: NOTE,
      created_by: null,
    })))
    .onConflict(trx.raw('(source_type, source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL'))
    .ignore()
    .returning('source_id');
  return inserted.map((row) => (row && row.source_id ? row.source_id : row));
}

/**
 * Makes the open review bonus lines match the payouts, for the pay run of the week ending
 * `weekEnd`. Take it inside the pay run's transaction, after the payroll lock and before
 * the run is worked out. With pay lines off it does nothing. With the import gate off it
 * only drops lines: every open imported line, so payroll stops paying review bonuses. With
 * lock, the payout rows and the open imported lines are read FOR UPDATE, so a manual
 * mark-paid waits for the pay run's transaction. Returns { removed, added } (counts).
 */
async function syncReviewBonusLines(trx, { weekEnd, lock = false, actorId = null } = {}) {
  if (!payLinesOn()) return { removed: 0, added: 0 };
  const importing = importOn();
  const removedIds = await dropStaleLines(trx, { lock, dropAll: !importing });
  const addedIds = importing ? await addMissingLines(trx, weekEnd, { lock }) : [];
  if (removedIds.length || addedIds.length) {
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.review_bonus_lines_synced', resource_type: 'payroll_pay_lines', resource_id: null,
      metadata: {
        week_end: weekEnd, removed_count: removedIds.length, added_count: addedIds.length,
        removed_payout_ids: removedIds, added_payout_ids: addedIds,
      },
    });
  }
  return { removed: removedIds.length, added: addedIds.length };
}

/**
 * Finalize: the payouts behind the review bonus lines this run's checks paid become
 * 'paid' (paid_at now, paid_by the finalizing admin). Each must still be 'earned' and
 * still belong to the line's technician, or the finalize is refused and rolls back.
 */
async function markPayoutsPaid(trx, runId, actorId) {
  const lines = await trx('payroll_pay_lines')
    .whereIn('check_id', trx('payroll_checks').where({ run_id: runId }).select('id'))
    .where({ source_type: SOURCE_TYPE })
    .select('source_id', 'technician_id');
  const byTech = new Map();
  for (const line of lines) byTech.set(line.technician_id, [...(byTech.get(line.technician_id) || []), line.source_id]);
  const changedError = new PayrollError(409, 'A review bonus changed while the run was finalized. Review the new numbers.');
  for (const [technicianId, ids] of byTech) {
    if (!ids.every((id) => UUID_RE.test(id))) throw changedError;
    const changed = await trx('review_incentive_payouts')
      .whereIn('id', ids).where({ technician_id: technicianId, status: 'earned' })
      .update({ status: 'paid', paid_at: trx.fn.now(), paid_by: actorId || null, updated_at: trx.fn.now() });
    if (changed !== ids.length) throw changedError;
  }
}

/** Void: the payouts behind the review bonus lines this run paid go back to 'earned'. */
async function reopenPayoutsOfRun(trx, runId) {
  const lines = await trx('payroll_pay_lines')
    .whereIn('check_id', trx('payroll_checks').where({ run_id: runId }).select('id'))
    .where({ source_type: SOURCE_TYPE })
    .select('source_id');
  const ids = lines.map((line) => line.source_id).filter((id) => UUID_RE.test(id));
  if (!ids.length) return;
  await trx('review_incentive_payouts').whereIn('id', ids).where({ status: 'paid' })
    .update({ status: 'earned', paid_at: null, paid_by: null, updated_at: trx.fn.now() });
}

module.exports = { SOURCE_TYPE, syncReviewBonusLines, markPayoutsPaid, reopenPayoutsOfRun };
