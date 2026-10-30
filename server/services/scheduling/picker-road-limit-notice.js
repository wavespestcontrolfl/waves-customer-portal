/**
 * What the staff pickers say when their Google road-time spending is stopped
 * (GATE_PICKER_ROAD_LIMIT_NOTICE; owner 2026-10-29, route-dispatcher audit
 * fix F). Staff only: nothing here reaches a customer.
 *
 * Two parts, both off with the gate (unset = byte-identical, no new response
 * field, no notification):
 *
 * 1. A refused reservation (picker-road-spend.js: the user's day, the
 *    account's day, the account's month, or no counter at all = fail closed)
 *    is noted for the find-time request that asked. The request is scoped
 *    with AsyncLocalStorage (`trackRoadLimit`, a middleware on the route), so
 *    every purchase of the request is covered (the route check, the picked
 *    hour, the best-times chips) without carrying a handle through them, and
 *    a reservation made by anything else (rain-out, the Intelligence Bar)
 *    finds no scope and records nothing. The route answers `road_limit`
 *    `{ reason, note }`; the pickers print the note beside the "~" legend.
 *
 * 2. When the month's spend first reaches 80% of the month limit, ONE admin
 *    notification for that month (dedupe key `picker-road-month-80:<YYYY-MM>`,
 *    Eastern month): the spend and the limit, nothing to act on tonight, so
 *    it is a single `needs-you` row under category `system`, which rings
 *    unless the owner silenced that category (docs/admin-notifications.md
 *    sections 3 and 4: once a month is far inside the ring allowance, no
 *    ring gate or quiet refresh is needed). A dedupe hit refreshes nothing.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const { gateEnvValue } = require('../../config/feature-gates');
const logger = require('../logger');

const GATE = 'GATE_PICKER_ROAD_LIMIT_NOTICE';
const MONTH_PERCENT = 80;
const CATEGORY = 'system';

const pickerRoadLimitNoticeLive = () => gateEnvValue(GATE);

// The staff line for each refusal reason picker-road-spend.js returns; any
// other reason (no staff user) is not a limit and gets no line.
const NOTES = {
  user_daily_cap: 'Google road times paused: your own daily limit reached. Times marked ~ use the estimate.',
  daily_cap: 'Google road times paused: daily limit reached. Times marked ~ use the estimate.',
  monthly_cap: 'Google road times paused: month limit reached. Times marked ~ use the estimate.',
  counter_unavailable: 'Google road times paused: the spending counter is unavailable. Times marked ~ use the estimate.',
};

const scope = new AsyncLocalStorage();

/** Express middleware: scopes one find-time request, only while the gate is on. */
function trackRoadLimit(req, _res, next) {
  if (!pickerRoadLimitNoticeLive()) return next();
  const store = { reason: null };
  req.pickerRoadLimit = store;
  return scope.run(store, next);
}

/** Called by picker-road-spend.js on a refusal; a no-op outside a tracked request. */
function noteRoadRefusal(reason) {
  const store = scope.getStore();
  if (store && !store.reason && NOTES[reason]) store.reason = reason;
}

/** `{ reason, note }` for the response, or null (nothing refused, or the gate was off). */
function roadLimitOf(req) {
  const reason = req?.pickerRoadLimit?.reason;
  return reason ? { reason, note: NOTES[reason] } : null;
}

// Tenths of a cent -> "$160" or "$161.40".
function usd(mills) {
  const cents = Math.round(mills / 10);
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

// month -> 'pending' | 'done': this process asks once a month; the dedupe key
// is what keeps it to one row across processes and restarts.
const asked = new Map();

/**
 * Called after a reservation that was allowed, with the month's spend so far
 * (account, tenths of a cent) and the month limit. At 80% or more it raises
 * the month's one notification, and keeps asking on later purchases only
 * until that has been stored (or deduped), so a failed write is retried.
 * Never throws.
 */
async function noteMonthSpend({ day, monthMills, capMills }) {
  try {
    if (!pickerRoadLimitNoticeLive() || !(capMills > 0)) return;
    if (monthMills * 100 < capMills * MONTH_PERCENT) return;
    const month = String(day).slice(0, 7);
    if (asked.has(month)) return;
    asked.set(month, 'pending');
    let stored = false;
    try {
      const alert = await require('../admin-alert-compose').raiseAdminAlert(CATEGORY, {
        area: 'System',
        action: 'review the Google road time limit',
        why: `Google road times at ${MONTH_PERCENT}% of the month limit: ${usd(monthMills)} of ${usd(capMills)}.`,
        severity: 'needs-you',
        link: '/admin/schedule',
        subject: { type: 'check', id: 'picker-road-month' },
        doneWhen: 'month_limit_reviewed',
        who: 'person',
      }, {
        bellDefault: true,
        dedupeKey: `picker-road-month-80:${month}`,
        detail: `The staff pickers have used ${usd(monthMills)} of Google road times this month, against the ${usd(capMills)} month limit (Google's list price, before its free usage). At the limit the pickers stop buying Google road times and show the straight-line estimate, marked ~, until next month. To change the limit, set PICKER_ROAD_MONTHLY_CAP_CENTS in Railway. This notice comes once a month.`,
        metadata: { lane: 'picker_road_spend', month, spentMills: monthMills, capMills },
      });
      stored = Boolean(alert) && (alert.id != null || alert.suppressed === true || alert.deduped === true);
    } finally {
      if (stored) asked.set(month, 'done'); else asked.delete(month);
    }
  } catch (err) {
    logger.warn(`[picker-road-spend] month notice failed: ${err && err.message}`);
  }
}

module.exports = {
  pickerRoadLimitNoticeLive, trackRoadLimit, noteRoadRefusal, roadLimitOf, noteMonthSpend,
  _test: { NOTES, asked, usd },
};
