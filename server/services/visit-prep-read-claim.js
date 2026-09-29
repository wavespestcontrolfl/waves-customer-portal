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
// The statuses no read engine holds.
const UNCLAIMED_STATUSES = ['none', 'unsupported'];
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
 * @param {object|(value: any) => object} opts.pendingPatch  the columns written with
 *   read_status 'pending' (a function receives the applicability value)
 * @param {Date} [opts.now]
 * @param {string[]} [opts.expectStatus] statuses the claim may take the row from
 * @returns {Promise<{ claimed: true, value: any } | 'unsupported' | 'refused' | 'taken'>}
 */
async function claimReadSlot(conn, submissionId, svc, {
  applicable, pendingPatch, now = new Date(), expectStatus = UNCLAIMED_STATUSES,
}) {
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
        // Claimed only from a status the caller expected (no engine holds the
        // row): a row another engine already claimed is never taken twice
        // (Codex #5320 r1 P2).
        const updated = await trx('visit_prep_submissions').where({ id: submissionId })
          .whereIn('read_status', expectStatus)
          .update({ read_status: 'pending', ...(typeof pendingPatch === 'function' ? pendingPatch(value) : pendingPatch) });
        if (!updated) return 'taken';
        return { claimed: true, value };
      });
    } catch (err) {
      if (err && err.code === 'VISIT_STOP_MOVED' && attempt < 2) continue;
      if (err && err.code === 'VISIT_STOP_MOVED') return 'refused';
      throw err;
    }
  }
}

// Every write an engine makes BEFORE holding a claim ('unsupported' = this
// engine doesn't apply; 'none' = not read: cap refused, photos failed to
// load, claim error) lands only while no engine has claimed the row. Each
// submission runs through every read engine, and one must never overwrite
// another's pending / done / failed.
async function markUnclaimed(conn, submissionId, status, logger) {
  try {
    await conn('visit_prep_submissions')
      .where({ id: submissionId })
      .whereIn('read_status', UNCLAIMED_STATUSES)
      .update({ read_status: status });
  } catch (err) {
    logger?.error?.(`[visit-prep-read] failed to write read_status=${status} submission=${submissionId}: ${err.message}`);
  }
}

const markUnsupported = (conn, submissionId, logger) => markUnclaimed(conn, submissionId, 'unsupported', logger);

module.exports = { UNCLAIMED_STATUSES, claimReadSlot, markUnclaimed, markUnsupported, dailyCap, etDayStart, readsToday, CAP_LOCK_KEY };
