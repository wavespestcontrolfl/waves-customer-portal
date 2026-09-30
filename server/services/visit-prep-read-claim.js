/**
 * Visit prep reads — the ONE daily cap and claim shared by every read
 * engine (pest: visit-prep-pest-read.js; lawn / tree & shrub:
 * visit-prep-plant-read.js). One cap (VISIT_PREP_READ_DAILY_CAP, engine
 * attempts counted on the ET day each read is claimed), one advisory lock key,
 * one claim transaction, so the engines can never drift apart on budget
 * rules.
 *
 * claimReadSlot proves applicability under the stop lock (withLockedStop:
 * the canonical stop lock plus share locks on the stop's rows), then takes
 * the cap lock last, only for the count and the claim.
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

// The cap counts PAID VISION CALLS: a claim adds `weight` to read_attempts —
// 1 for the pest or plant read, 2 for the combined read (it runs the pest and
// the plant vision call under one claim; owner ruling 2026-09-30) — so a
// combo read is charged honestly and the sum below needs no change.
//
// Every engine ATTEMPT today, not only the ones that stored a result: an
// engine call that failed, or whose result was released because the stop
// changed mid-read, still cost a vision call. Counted on the ET day the
// read was CLAIMED (read_claimed_at), so the sweep re-reading an older
// submission is charged to today (Codex #5320 r12): a row claimed today
// counts all its attempts (at least one) — conservative when an older
// attempt of the same row fell on an earlier day, never an undercount. A
// row claimed before read_claimed_at existed counts by its submission day
// as before: its attempts, or one while it sits in a claimed status.
// Summed in Postgres over the read_claimed_at and created_at indexes
// (Codex #5320 r10 P2).
const CLAIMED_STATUSES = ['pending', 'done', 'failed'];
const ATTEMPTS_SUM_SQL = 'COALESCE(SUM(CASE'
  + ' WHEN read_claimed_at IS NOT NULL THEN (CASE WHEN read_claimed_at >= ? THEN GREATEST(read_attempts, 1) ELSE 0 END)'
  + " ELSE GREATEST(read_attempts, CASE WHEN read_status IN ('pending', 'done', 'failed') THEN 1 ELSE 0 END)"
  + ' END), 0)::int AS count';
async function readsToday(conn, now = new Date()) {
  const day = etDayStart(now);
  const row = await conn('visit_prep_submissions')
    .whereRaw('(read_claimed_at >= ? OR (read_claimed_at IS NULL AND created_at >= ?))', [day, day])
    .first(conn.raw(ATTEMPTS_SUM_SQL, [day]));
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
 * @param {number} [opts.weight] vision calls this claim will spend (default 1; a
 *   combo read passes 2): counted into read_attempts, and the claim is refused
 *   unless the whole weight fits under the daily cap
 * @returns {Promise<{ claimed: true, value: any } | 'unsupported' | 'refused' | 'taken'>}
 */
// Runs `body(trx)` with the stop locked: the canonical stop lock
// (visit-groups.js lockStopForRow, retrying VISIT_STOP_MOVED like
// visit-prep.js withStopLock), then every member row share-locked against
// status/type writers that don't take the stop lock. `onGone(trx)` answers a
// stop that no longer exists; `onMoved()` one that would not hold still
// through the retries. Every locked visit-prep read decision goes through
// here: the claim, the settle, and the sweep's stale-read release.
async function withLockedStop(conn, svc, { body, onGone, onMoved }) {
  const { lockStopForRow } = require('./visit-groups');
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await conn.transaction(async (trx) => {
        if ((await lockStopForRow(trx, svc.id)) === null) return onGone(trx);
        const { techStopMemberIds } = require('./visit-prep');
        const members = await techStopMemberIds(svc, trx);
        await trx('scheduled_services').whereIn('id', [...new Set([svc.id, ...members])]).forShare().select('id');
        return body(trx);
      });
    } catch (err) {
      if (err && err.code === 'VISIT_STOP_MOVED' && attempt < 2) continue;
      if (err && err.code === 'VISIT_STOP_MOVED') return onMoved();
      throw err;
    }
  }
}

async function claimReadSlot(conn, submissionId, svc, {
  applicable, pendingPatch, now = new Date(), expectStatus = UNCLAIMED_STATUSES, weight = 1,
}) {
  return withLockedStop(conn, svc, {
    onGone: () => 'unsupported',
    onMoved: () => 'refused',
    body: async (trx) => {
      const value = await applicable(svc, trx);
      if (!value) return 'unsupported';
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CAP_LOCK_KEY]);
      const own = await trx('visit_prep_submissions').where({ id: submissionId }).first('read_attempts');
      // Any submission day may claim: the cap counts the day the read runs
      // (readsToday), and only the recovery sweep reaches an older one, for
      // a visit that is still upcoming (Codex #5320 r12).
      if (!own) return 'refused';
      if (await readsToday(trx, now) + weight > dailyCap()) return 'refused';
      // Claimed only from a status the caller expected (no engine holds the
      // row): a row another engine already claimed is never taken twice
      // (Codex #5320 r1 P2).
      const updated = await trx('visit_prep_submissions').where({ id: submissionId })
        .whereIn('read_status', expectStatus)
        .update({
          read_status: 'pending',
          read_attempts: (Number(own.read_attempts) || 0) + weight,
          // The pending-staleness clock starts at the claim, not the
          // submission (a sweep may claim hours later; Codex #5320 r10).
          read_claimed_at: now,
          ...(typeof pendingPatch === 'function' ? pendingPatch(value) : pendingPatch),
        });
      if (!updated) return 'taken';
      return { claimed: true, value };
    },
  });
}

/**
 * Stores a finished read only if the stop still wants THIS read: the engine
 * call runs outside any transaction, and the stop can change lines (or
 * subject) while it runs. Under the same stop lock + share locks as the
 * claim, re-proves applicability; a match runs `store(trx)`, anything else
 * releases the claim back to 'none' (its attempt stays counted in
 * read_attempts) and returns 'changed' so the caller re-dispatches for the
 * stop as it is now. A failed engine call settles through here too, so a
 * miss on a stop that changed is re-read, not left 'failed' under the
 * obsolete engine (Codex #5320 r8, r9).
 *
 * @param {object} opts
 * @param {(svc: object, trx: object) => Promise<any>} opts.applicable
 * @param {(value: any) => boolean} opts.matches  does the current value still fit the read made
 * @param {(trx: object) => Promise<void>} opts.store
 * @returns {Promise<'stored' | 'changed'>}
 */
async function settleClaimedRead(conn, submissionId, svc, { applicable, matches, store }) {
  // The released attempt stays counted: a row claimed before read_attempts
  // existed holds 0 and counted only through its claimed status, so the
  // release keeps at least one (pre-push audit P1).
  const release = (trx) => trx('visit_prep_submissions').where({ id: submissionId, read_status: 'pending' })
    .update({
      read_status: 'none', read_ref: null, read_result: null, read_attempts: trx.raw('GREATEST(read_attempts, 1)'),
    });
  const changed = async (trx) => { await release(trx); return 'changed'; };
  return withLockedStop(conn, svc, {
    onGone: changed,
    // A stop that would not hold still is a stop that changed: release the
    // claim (a guarded single-row write, no stop lock needed) and let the
    // caller re-dispatch, never terminalize a paid read as failed
    // (Codex #5320 r10 P2).
    onMoved: () => changed(conn),
    body: async (trx) => {
      if (!matches(await applicable(svc, trx))) return changed(trx);
      await store(trx);
      return 'stored';
    },
  });
}

// Every write an engine makes BEFORE holding a claim ('unsupported' = this
// engine doesn't apply; 'none' = not read: cap refused, photos failed to
// load, claim error) lands only while no engine has claimed the row. Each
// submission runs through every read engine, and one must never overwrite
// another's pending / done / failed.
// `expectStatus` narrows it further for a caller (the recovery sweep)
// entitled to only one starting status.
async function markUnclaimed(conn, submissionId, status, logger, expectStatus = UNCLAIMED_STATUSES) {
  try {
    await conn('visit_prep_submissions')
      .where({ id: submissionId })
      .whereIn('read_status', expectStatus)
      .update({ read_status: status });
  } catch (err) {
    logger?.error?.(`[visit-prep-read] failed to write read_status=${status} submission=${submissionId}: ${err.message}`);
  }
}

const markUnsupported = (conn, submissionId, logger, expectStatus) => markUnclaimed(conn, submissionId, 'unsupported', logger, expectStatus);

// Every "this stop isn't what the read was for" outcome (the locked claim
// found another line, or the stop changed while the engine ran) goes back
// to the ONE dispatcher (visit-prep-read-dispatch.js), which picks the
// engine for the stop as it is now and bounds how often that can repeat
// (Codex #5320 r7–r9). Never engine-to-engine.
function redispatch(args, logger) {
  setImmediate(() => {
    try {
      Promise.resolve(require('./visit-prep-read-dispatch').dispatchVisitPrepRead(args))
        .catch((err) => logger?.error?.(`[visit-prep-read] re-dispatch failed submission=${args.submissionId}: ${err.message}`));
    } catch (err) {
      logger?.error?.(`[visit-prep-read] re-dispatch could not start submission=${args.submissionId}: ${err.message}`);
    }
  });
}

module.exports = { redispatch, settleClaimedRead, withLockedStop, CLAIMED_STATUSES, UNCLAIMED_STATUSES, claimReadSlot, markUnclaimed, markUnsupported, dailyCap, etDayStart, readsToday, CAP_LOCK_KEY };
