'use strict';

// Cash forecast: one standing bell for a low week (owner 2026-11-04 D4 A: "One bell when a week ahead ends
// below your floor on the expected line. It closes itself when no week is below the floor. ... It rings when
// a low week first appears, not every day.").
//
// Same shape as services/unbilled-visits-list.js (docs/admin-notifications.md section 1): ONE needs-you bell
// row, refreshed every day, rings again only when a WEEK joins the low list (or the list comes back after it
// was empty), and closes itself (done) when no week ahead ends below the floor. It reads the forecast
// (load.js + engine.js: the portal's own data, Plaid's free /accounts/get and Stripe's balance) and writes
// only that one admin alert row: no customer message, no paid API call.
//
// Owner only, like the forecast: the row carries metadata.ownerOnly (left out of the Recently done list and
// the Activity feed for any other login), and its headline and why carry no money figures. Only admin logins
// read the open bell list; today the owner is the only one.
//
// Judged only when the line can be judged. No floor set, or no expected line (last year's months not set):
// nothing can be below the floor, so an open row closes. A balance that was not read, or only in part: no
// proof either way, so the row is left as it is.
//
// GATE_CASH_FORECAST (strict 'true', read at call time). Off = the daily cron does nothing.

const db = require('../../models/db');
const { cashForecastLive, alertEpisodesLive } = require('../../config/feature-gates');
const { composeAdminAlert, raiseAdminAlert } = require('../admin-alert-compose');
const { shortDateET } = require('../admin-alert-names');

const DEDUPE_KEY = 'cash-forecast-low-week';
const CATEGORY = 'billing';
const LINK = '/admin/banking?tab=forecast';
const DONE_WHEN = 'no_low_week';

// A week's start day (YYYY-MM-DD) as the bell names it: "Dec 14".
const weekWords = (day) => shortDateET(new Date(`${day}T12:00:00Z`));

// The weeks ahead whose end on the expected line is below the floor, earliest first.
function lowWeeks(forecast, floorUsd) {
  return forecast.weeks.filter((w) => w.end_expected !== null && w.end_expected < floorUsd).map((w) => w.week_start);
}

// The bell for a non-empty list (pure): the composeAdminAlert spec, the detail text and the ring stamps.
function composeLowWeeks(weeks) {
  const count = weeks.length;
  const first = weekWords(weeks[0]);
  const why = count === 1
    ? `The week of ${first} ends below your floor on the expected line.`
    : `${count} weeks ahead end below your floor on the expected line, the first the week of ${first}.`;
  const detail = [
    `${count === 1 ? 'One week' : `${count} weeks`} of the next 13 end${count === 1 ? 's' : ''} below your floor on the expected line:`,
    ...weeks.map((w) => `Week of ${weekWords(w)}`),
    'Open Banking → Cash forecast for the amounts and each week\'s lines.',
  ].join('\n');
  const spec = {
    area: 'Billing',
    action: 'check the low week on the cash forecast',
    why,
    severity: 'needs-you',
    link: LINK,
    subject: { type: 'check', id: DEDUPE_KEY },
    doneWhen: DONE_WHEN,
    who: 'person',
  };
  return { spec, detail, itemKeys: [...weeks], count };
}

// A refresh rings only when a week joins the low list.
function ringOnNewWeek(itemKeys) {
  return (_existing, existingMeta) => {
    const prior = new Set(Array.isArray(existingMeta?.itemKeys) ? existingMeta.itemKeys.map(String) : []);
    return itemKeys.some((key) => !prior.has(key));
  };
}

async function raiseLowWeeks(composed, dedupeKey) {
  const opts = {
    dedupeKey,
    // GATE_ADMIN_BELL_POLICY admits a billing row only when the site asks: ring unless the owner silenced the
    // category (notification-bell-policy.js).
    bellDefault: true,
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewWeek(composed.itemKeys),
    bumpOnRefresh: true,
    detail: composed.detail,
    metadata: { itemKeys: composed.itemKeys, count: composed.count, ownerOnly: true },
  };
  if (!alertEpisodesLive()) return raiseAdminAlert(CATEGORY, composed.spec, opts);
  const alert = composeAdminAlert(composed.spec);
  return require('../admin-alert-episodes').raiseAdminAlertWithReopen(CATEGORY, alert.headline, alert.why, {
    ...opts, link: alert.link, metadata: { ...opts.metadata, ...alert.metadata },
  });
}

async function closeLowWeeks(database, dedupeKey, resolution) {
  if (!alertEpisodesLive()) return 0;
  return require('../admin-alert-episodes').closeAdminAlertKeys(database, [dedupeKey], DONE_WHEN, { resolution });
}

// The forecast the tab shows, with the owner's settings it was computed from (lazy, so the cron module
// loads nothing until it runs).
async function loadForecast() {
  const { loadForecastInput } = require('./load');
  const { computeForecast } = require('./engine');
  const input = await loadForecastInput();
  return { ...computeForecast(input), settings: input.settings };
}

// Why the line cannot be judged today, or null. `close` says whether an open row should close.
function notJudged(forecast) {
  const floorCents = forecast.settings?.floor_cents;
  if (floorCents === null || floorCents === undefined) return { reason: 'no_floor', close: 'No floor is set on the cash forecast' };
  if (!forecast.expected_available) return { reason: 'no_expected_line', close: 'The cash forecast has no expected line until last year\'s months are set' };
  if (forecast.opening.bank_usd === null || forecast.opening.partial) return { reason: 'balance_unread', close: null };
  return null;
}

/**
 * Daily cron entry point. Returns { skipped } when the gate is off, otherwise { count, outcome }: raised |
 * refreshed | unchanged | suppressed | closed | clear | not_judged (with reason). A read failure throws
 * (runExclusive records it in job_health) and never closes the row. `load` returns the forecast with its
 * settings; `dedupeKey` is the row's key (tests set both).
 */
async function runCashForecastLowWeek({ database = db, gateEnabled, load = loadForecast, dedupeKey = DEDUPE_KEY } = {}) {
  if (!(gateEnabled ?? cashForecastLive())) return { skipped: 'disabled' };
  const forecast = await load();
  const off = notJudged(forecast);
  if (off) {
    const closed = off.close ? Number(await closeLowWeeks(database, dedupeKey, off.close)) || 0 : 0;
    return { count: 0, outcome: closed ? 'closed' : 'not_judged', reason: off.reason };
  }
  const weeks = lowWeeks(forecast, forecast.settings.floor_cents / 100);
  if (!weeks.length) {
    const closed = Number(await closeLowWeeks(database, dedupeKey, 'No week ahead ends below your floor')) || 0;
    return { count: 0, outcome: closed ? 'closed' : 'clear' };
  }
  const composed = composeLowWeeks(weeks);
  const result = await raiseLowWeeks(composed, dedupeKey);
  if (!result) throw new Error('cash forecast low-week bell was not written');
  let outcome = 'unchanged';
  // The owner silenced billing bells: the bell policy wrote nothing.
  if (result.suppressed) outcome = 'suppressed';
  else if (!result.deduped) outcome = 'raised';
  else if (result.refreshed) outcome = result.rung === false ? 'refreshed' : 'raised';
  return { count: composed.count, outcome };
}

module.exports = {
  runCashForecastLowWeek,
  DEDUPE_KEY,
  _private: { lowWeeks, composeLowWeeks, ringOnNewWeek, notJudged },
};
