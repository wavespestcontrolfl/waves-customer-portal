/**
 * Visit prep reads — the ONE daily cap and claim shared by every read
 * engine (pest: visit-prep-pest-read.js; lawn / tree & shrub:
 * visit-prep-plant-read.js). One cap (VISIT_PREP_READ_DAILY_CAP, counted over
 * visit_prep_submissions.read_status for the ET day), one advisory lock key,
 * one claim transaction, so the engines can never drift apart on budget
 * rules.
 *
 * claimReadSlot proves applicability under the canonical stop lock
 * (visit-groups.js lockStopForRow, retrying VISIT_STOP_MOVED like
 * visit-prep.js withStopLock), share-locks the stop's rows against
 * status/type writers that don't take the stop lock, then takes the cap lock
 * last, only for the count and the claim. Only a submission from TODAY (ET)
 * may claim: the cap counts by submission day.
 */
const { etDateString, parseETDateTime } = require('../utils/datetime-et');

const DEFAULT_DAILY_CAP = 40;
const CAP_LOCK_KEY = 'visit-prep-pest-read-cap';

function dailyCap() {
  const value = Number(process.env.VISIT_PREP_READ_DAILY_CAP);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_DAILY_CAP;
}

// The cap's day is the America/New_York calendar day (AGENTS.md), not the
// DB session's UTC day: midnight ET as an instant, bound as a param.
function etDayStart(now = new Date()) {
  return parseETDateTime(`${etDateString(now)}T00:00`);
}

// Every read ATTEMPTED today, not only the ones that stored a result: an
// engine call that failed still cost a vision call. pending/done/failed are
// the statuses a claimed submission can reach (none/unsupported never
// claimed a slot and never count).
async function readsToday(conn, now = new Date()) {
  const row = await conn('visit_prep_submissions')
    .whereIn('read_status', ['pending', 'done', 'failed'])
    .where('created_at', '>=', etDayStart(now))
    .count('id as count')
    .first();
  return Number(row?.count || 0);
}

/**
 * @param {object} conn
 * @param {string} submissionId
 * @param {object} svc  the anchor scheduled_services row ({ id, visit_id, ... })
 * @param {object} opts
 * @param {(svc: object, trx: object) => Promise<any>} opts.applicable
 *   re-proves the engine applies to the stop, inside the locked claim;
 *   a falsy return means unsupported, anything else is handed back.
 * @param {object} opts.pendingPatch  the columns written with read_status 'pending'
 * @param {Date} [opts.now]
 * @returns {Promise<{ claimed: true, value: any } | 'unsupported' | 'refused'>}
 */
async function claimReadSlot(conn, submissionId, svc, { applicable, pendingPatch, now = new Date() }) {
  const { lockStopForRow } = require('./visit-groups');
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await conn.transaction(async (trx) => {
        if ((await lockStopForRow(trx, svc.id)) === null) return 'unsupported';
        const { techStopMemberIds } = require('./visit-prep');
        const members = await techStopMemberIds(svc, trx);
        await trx('scheduled_services').whereIn('id', [...new Set([svc.id, ...members])]).forShare().select('id');
        const value = await applicable(svc, trx);
        if (!value) return 'unsupported';
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CAP_LOCK_KEY]);
        const own = await trx('visit_prep_submissions').where({ id: submissionId }).first('created_at');
        if (!own || new Date(own.created_at) < etDayStart(now)) return 'refused';
        if (await readsToday(trx, now) >= dailyCap()) return 'refused';
        await trx('visit_prep_submissions').where({ id: submissionId }).update({ read_status: 'pending', ...pendingPatch });
        return { claimed: true, value };
      });
    } catch (err) {
      if (err && err.code === 'VISIT_STOP_MOVED' && attempt < 2) continue;
      if (err && err.code === 'VISIT_STOP_MOVED') return 'refused';
      throw err;
    }
  }
}

// "This engine doesn't apply" — written only while no engine has claimed
// the row. Every submission runs through each read engine, and the one that
// doesn't apply must never overwrite the other's pending / done / failed.
async function markUnsupported(conn, submissionId, logger) {
  try {
    await conn('visit_prep_submissions')
      .where({ id: submissionId })
      .whereIn('read_status', ['none', 'unsupported'])
      .update({ read_status: 'unsupported' });
  } catch (err) {
    logger?.error?.(`[visit-prep-read] failed to mark unsupported submission=${submissionId}: ${err.message}`);
  }
}

module.exports = { claimReadSlot, markUnsupported, dailyCap, etDayStart, readsToday, CAP_LOCK_KEY };
