/**
 * BOUNCE GUARD — stop a visit from ping-ponging back onto a date auto-dispatch
 * recently moved it off of, without putting a move-count cap on the visit.
 *
 * Under flex mode, maxAutoMovesPerVisit defaults to 0 (owner 2026-11-22 /
 * 2026-11-26: no per-visit move-count cap before the 25h / told-time freeze).
 * Without a cycle guard, nightly route shifts can bounce one visit back and
 * forth between two dates across consecutive nights (e.g. Jan 1 -> Dec 31 ->
 * Jan 4 -> Dec 31 -> Jan 6).
 *
 * Rule: an ordinary optimization may not move a visit BACK onto a date that
 * auto-dispatch moved it off of (`reschedule_log.original_date` with the
 * auto-dispatch day-move signature) within the last `config.bounceCooldownDays`
 * days (30 in flex mode; 0 turns it off).
 *
 * Exemptions (never blocked):
 *   - conflict moves (closed day, customer blackout, overlap, mowing day,
 *     saved preferred day) — the visit cannot stay where it is;
 *   - first placement of an unplaced recurring due-date visit;
 *   - same-day re-times (date does not change).
 *
 * Checked in pass 1 (bulk read), pass 2 (single-visit recheck), and atomically
 * inside the move transaction (apply.js makeMoveGuard and makeMemberGuard).
 */
const logger = require('../logger');
const { toDateStr } = require('./dates');
const { DAY_MOVE_SQL } = require('./move-limit');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function cooldownOf(config) {
  const n = Number(config && config.bounceCooldownDays);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function cutoffFor(nowDate, days) {
  const base = nowDate instanceof Date ? nowDate.getTime() : new Date(nowDate).getTime();
  return new Date(base - days * MS_PER_DAY);
}

function isUnplacedDueDate(row) {
  return Boolean(row && row.recurring_dispatch_due_date && !row.window_start);
}

/**
 * Map<serviceId, Set<YYYY-MM-DD>> of original_date values auto-dispatch moved
 * each service OFF of within the last `days` days. Throws on DB failure.
 */
async function fetchRecentLeftDates(conn, serviceIds, nowDate, days) {
  const byService = new Map();
  if (!days || !serviceIds || serviceIds.length === 0) return byService;
  const cutoff = cutoffFor(nowDate, days);
  const cutoffMs = cutoff.getTime();
  const rows = await conn('reschedule_log')
    .whereIn('scheduled_service_id', serviceIds)
    .where('reason_code', 'auto_dispatch')
    .where('initiated_by', 'auto_dispatch')
    .whereRaw(DAY_MOVE_SQL)
    .where('created_at', '>=', cutoff)
    .select('scheduled_service_id', 'original_date', 'created_at');
  for (const r of rows || []) {
    if (r.created_at != null) {
      const ts = new Date(r.created_at).getTime();
      if (Number.isFinite(ts) && ts < cutoffMs) continue;
    }
    const leftDate = toDateStr(r.original_date);
    if (!leftDate) continue;
    const key = String(r.scheduled_service_id);
    let dates = byService.get(key);
    if (!dates) { dates = new Set(); byService.set(key, dates); }
    dates.add(leftDate);
  }
  return byService;
}

/**
 * Orchestrator bulk/recheck read: empty map when off, null on read failure
 * (callers fail closed and degrade the run).
 */
async function loadRecentLeftDates(conn, serviceIds, nowDate, config) {
  const days = cooldownOf(config);
  if (!days) return new Map();
  if (!serviceIds || serviceIds.length === 0) return new Map();
  try {
    return await fetchRecentLeftDates(conn, serviceIds, nowDate, days);
  } catch (err) {
    logger.error(`[auto-dispatch] bounce-guard history read failed — no visit moves this run: ${err.message}`);
    return null;
  }
}

function isBounceBackDate(recentLeftDates, dateStr) {
  if (!recentLeftDates || recentLeftDates.size === 0 || !dateStr) return false;
  const target = toDateStr(dateStr);
  return Boolean(target && recentLeftDates.has(target));
}

/**
 * Write-transaction check (apply.js makeMoveGuard and makeMemberGuard):
 * refuses an ordinary day move back onto a date auto-dispatch moved any of
 * `rows` off of within `config.bounceCooldownDays`.
 */
async function assertNotBouncingBack(trx, rows, destDate, config, refuse, nowDate = new Date()) {
  const days = cooldownOf(config);
  if (!days || (config && config.sourceConflict)) return;
  const dest = toDateStr(destDate);
  if (!dest) return;
  const checked = (rows || []).filter((r) => r && !isUnplacedDueDate(r) && toDateStr(r.scheduled_date) !== dest);
  if (!checked.length) return;
  const recent = await fetchRecentLeftDates(trx, checked.map((r) => r.id), nowDate, days);
  const hit = checked.find((r) => isBounceBackDate(recent.get(String(r.id)), dest));
  if (hit) {
    throw refuse(hit.id, `would bounce back to ${dest}, which auto-dispatch moved it off within the last ${days} days`);
  }
}

module.exports = {
  cooldownOf, cutoffFor, fetchRecentLeftDates, loadRecentLeftDates, isBounceBackDate, assertNotBouncingBack,
};
