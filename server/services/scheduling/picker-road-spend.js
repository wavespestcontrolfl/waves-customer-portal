/**
 * Durable spend ceilings for the staff pickers' Google road times
 * (GATE_PICKER_ROAD_CHECK; owner 2026-10-27: "the dispatcher needs to run
 * every time we create, reschedule, etc, we just have to make sure costs are
 * appropriate").
 *
 * Every Google lookup the pickers buy is counted in picker_road_spend: one
 * row per (bucket, Eastern day), bucket 'all' for the account and
 * 'staff:<id>' for the staff user who asked. A preload reserves its lookups
 * BEFORE it calls Google, in one transaction:
 *   - the user's day stays within PICKER_ROAD_USER_DAILY_CAP_CENTS,
 *   - the account's day stays within PICKER_ROAD_DAILY_CAP_CENTS,
 *   - the account's month stays within PICKER_ROAD_MONTHLY_CAP_CENTS.
 * Any cap crossed = the transaction rolls back (nothing counted) and the
 * search uses the app's own drive model ("~") instead of Google.
 *
 * Cost per lookup (Google's list price, before the monthly free usage):
 * traffic-aware = Route Matrix Pro, 1 cent; plain road time = Essentials,
 * 0.5 cent. Stored as elements; the caps compare tenths of a cent.
 *
 * Fails CLOSED: no counter (DB error) = no Google, model numbers. Never
 * throws.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');

const MILLS = { pro: 10, plain: 5 }; // tenths of a cent per element
const ACCOUNT = 'all';

function capCents(envVar, fallback) {
  const raw = process.env[envVar];
  if (raw !== undefined && /^\s*\d+\s*$/.test(String(raw))) {
    const n = parseInt(raw, 10);
    if (Number.isSafeInteger(n) && n >= 0) return n;
  }
  return fallback;
}

// Defaults in cents, Google's list price before its monthly free usage
// (measured 10-27: ~61 cents a new search for one technician, so $10 a day is
// ~16 new searches). One office login today, so the per-user day equals the
// account's; lower it when a second login is added. The owner can change each
// in Railway with no deploy: they are read at every reservation.
const DEFAULTS = { dailyCents: 1000, userDailyCents: 1000, monthlyCents: 20000 };

function caps() {
  return {
    dayMills: capCents('PICKER_ROAD_DAILY_CAP_CENTS', DEFAULTS.dailyCents) * 10,
    userDayMills: capCents('PICKER_ROAD_USER_DAILY_CAP_CENTS', DEFAULTS.userDailyCents) * 10,
    monthMills: capCents('PICKER_ROAD_MONTHLY_CAP_CENTS', DEFAULTS.monthlyCents) * 10,
  };
}
caps.DEFAULTS = DEFAULTS;

const costMills = (pro, plain) => Number(pro || 0) * MILLS.pro + Number(plain || 0) * MILLS.plain;

class CapReached extends Error {}

const WARN_EVERY_MS = 60 * 1000;
let lastWarnAt = 0;
function warn(message) {
  const t = Date.now();
  if (t - lastWarnAt < WARN_EVERY_MS) return;
  lastWarnAt = t;
  logger.warn(`[picker-road-spend] ${message}`);
}

/**
 * Reserve `pro` traffic-aware and `plain` road-time lookups for `spender`
 * (a staff id). { allowed: true } or { allowed: false, reason }.
 */
async function reserveRoadSpend({ spender, pro = 0, plain = 0, now = new Date(), conn = db } = {}) {
  if (!(pro > 0) && !(plain > 0)) return { allowed: true };
  if (!spender) return { allowed: false, reason: 'no_staff_user' };
  const limits = caps();
  const day = etDateString(now);
  const monthStart = `${day.slice(0, 7)}-01`;
  try {
    await conn.transaction(async (trx) => {
      const earlier = await trx('picker_road_spend')
        .where({ bucket: ACCOUNT }).where('day', '>=', monthStart).where('day', '<', day)
        .sum({ pro: 'pro_elements', plain: 'plain_elements' }).first();
      const result = await trx.raw(
        `INSERT INTO picker_road_spend (bucket, day, pro_elements, plain_elements)
         VALUES (?, ?::date, ?, ?), (?, ?::date, ?, ?)
         ON CONFLICT (bucket, day) DO UPDATE SET
           pro_elements = picker_road_spend.pro_elements + EXCLUDED.pro_elements,
           plain_elements = picker_road_spend.plain_elements + EXCLUDED.plain_elements,
           updated_at = now()
         RETURNING bucket, pro_elements, plain_elements`,
        [ACCOUNT, day, pro, plain, `staff:${spender}`, day, pro, plain],
      );
      const rows = result?.rows || [];
      const account = rows.find((r) => r.bucket === ACCOUNT);
      const user = rows.find((r) => r.bucket !== ACCOUNT);
      if (!account || !user) throw new Error('counter returned no row');
      const accountDay = costMills(account.pro_elements, account.plain_elements);
      if (costMills(user.pro_elements, user.plain_elements) > limits.userDayMills) throw new CapReached('user_daily_cap');
      if (accountDay > limits.dayMills) throw new CapReached('daily_cap');
      if (costMills(earlier?.pro, earlier?.plain) + accountDay > limits.monthMills) throw new CapReached('monthly_cap');
      // The running day, so the logs read as the bill does (list price).
      logger.info(`[picker-road-spend] +${pro} traffic-aware, +${plain} plain lookups: today $${(accountDay / 1000).toFixed(2)}`
        + ` of $${(limits.dayMills / 1000).toFixed(2)}`);
    });
    return { allowed: true };
  } catch (err) {
    if (err instanceof CapReached) {
      warn(`${err.message} reached: Google road times paused, the pickers use the model`);
      return { allowed: false, reason: err.message };
    }
    warn(`counter unavailable, no Google (fail closed): ${err && err.message}`);
    return { allowed: false, reason: 'counter_unavailable' };
  }
}

module.exports = { reserveRoadSpend, caps, costMills, _test: { MILLS } };
