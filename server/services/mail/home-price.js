'use strict';

/**
 * Mailer step 2a (shadow): the run that facts and prices the new-home prospects. For each due `eligible` row of the
 * new-home list (home-price-store dueForPrice), in order:
 *   1. the stored permit row (permitFacts): none is a failure (failed / permit_row, tried again on a later run); a permit
 *      that was canceled or withdrawn since the list took it is settled as not_clean / permit_canceled; a permit that is
 *      not a new single-family home is settled as not_clean / not_single_family;
 *   2. the home's facts (home-facts readHomeFacts: the parcel map, then the permit's facts or page for what the map
 *      lacks, arbitrated): a source that is stopped leaves the row as it is; a failed read is failed; a missing fact is
 *      missing_fact (never guessed, tried again on a later run);
 *   3. the price (home-quote priceHome: a dry run of the shared estimate save): priced, not_clean or failed;
 *   4. the result is saved (home-price-store savePriceResult, given the due row).
 *
 * Only free public county sources are read. Nothing here calls a paid or AI service or the property lookup. The only
 * writes are the price columns of mail_prospects and the permit page result (through the permit reader's recordResult).
 * Nothing calls runHomePrices yet: the cron tick is the next PR.
 *
 * Limits: strictly sequential; a 20 minute budget, which also ends a permit page read between two of its requests;
 * at most 40 homes handled in one run. A home left for a stopped source is not one of the 40: the run goes on to the
 * homes behind it (it looks at up to 200 due rows), so homes that wait for the permit page cannot hold back homes that
 * need no page. Three errors in a row that are not a row's own stop the run (the database is away), and so do three
 * price engine failures in a row (the engine or the live price list is away). The run THROWS at its end, after logging, when a source was away (the facts reader says so), when the
 * price engine failed for every home it was asked or three times in a row, when a row could not be read or saved, or
 * when the database was away, so the job's health row records a failure. Rows left only by the row cap or the budget do
 * not make it throw.
 *
 * The log line holds counts and codes only: never a name, an address, a parcel number or a permit number.
 */

const logger = require('../logger');
const homeFacts = require('./home-facts');
const { priceHome } = require('./home-quote');

const BUDGET_MS = 20 * 60 * 1000;
const ROW_CAP = 40; // homes handled (read and saved, kept or failed) in one run
const READ_CAP = 200; // due rows one run looks at: a home left for a stopped source is not one of the 40
const MAX_ERRORS_IN_A_ROW = 3;
const MAX_ENGINE_FAILURES_IN_A_ROW = 3;
const SINGLE_FAMILY_WORK = 'new single family';

// The store, loaded here, not at the top: a test that injects the three calls never opens the database module.
function resolveDeps(deps = {}) {
  const names = ['dueForPrice', 'permitFacts', 'savePriceResult'];
  if (!names.some((n) => !deps[n])) return deps;
  const store = require('./home-price-store');
  return { dueForPrice: store.dueForPrice, permitFacts: store.permitFacts, savePriceResult: store.savePriceResult, ...deps };
}

const bump = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };

// A code or a class name, never a message: a message can quote a row or a page.
const codeOf = (value) => (typeof value === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(value) ? value : null);
const errorCode = (err) => codeOf(err?.reason) || codeOf(err?.code) || codeOf(err?.name) || 'error';

const isSingleFamily = (permit) => String(permit?.type_of_work || '').trim().replace(/\s+/g, ' ').toLowerCase() === SINGLE_FAMILY_WORK;

/** The result to save for one row, or null to leave the row as it is. */
async function resultFor(row, ctx) {
  const permit = await ctx.d.permitFacts(row.permit_no);
  // No permit row is not an answer: a row that exists and is not a new single-family home is settled, a missing one is
  // tried again on a later run.
  if (!permit) return { status: 'failed', reason: 'permit_row' };
  if (permit.canceled) return { status: 'not_clean', reason: 'permit_canceled' };
  if (!isSingleFamily(permit)) return { status: 'not_clean', reason: 'not_single_family' };
  const read = await homeFacts.readHomeFacts(row, permit, ctx.facts);
  if (read.left) return null;
  if (read.failed) return { status: 'failed', reason: read.failed, ...read.facts };
  if (read.missing) return { status: 'missing_fact', reason: read.missing, ...read.facts };
  const result = await priceHome(row, read.facts, ctx.deps);
  // The price engine's own failures are counted: a row's failed / engine result is saved (tried again later), but an
  // engine that is away must fail the run and must not be asked 40 times.
  const { state } = ctx;
  const engineFailed = result.status === 'failed' && result.reason === 'engine';
  state.quotes += 1;
  state.engineFailures += engineFailed ? 1 : 0;
  state.engineStreak = engineFailed ? state.engineStreak + 1 : 0;
  return result;
}

async function handleRow(row, ctx) {
  const { d, state } = ctx;
  const result = await resultFor(row, ctx);
  if (!result) {
    state.left += 1;
    return;
  }
  // The whole due row: the store checks the row's version, so a stale run cannot replace a newer result.
  const saved = await d.savePriceResult(row, result);
  if (!saved.written) {
    state.kept += 1;
    return;
  }
  bump(state.byStatus, result.status);
  if (result.reason) bump(state.byReason, `${result.status}/${result.reason}`);
}

// A value the table refused (SQLSTATE class 22 or 23) is this row's own error, and it is an answer from the database.
const tableRefused = (err) => /^2[23][0-9A-Z]{3}$/.test(String(err?.code || ''));
// A TypeError or RangeError is this row's own error too, but it says nothing about the database (the store throws it
// before any query).
const isArgumentError = (err) => err?.name === 'TypeError' || err?.name === 'RangeError';

// The streak of errors that are not a row's own, after one more error: an answer from the database starts it again,
// an argument error leaves it as it is, anything else adds one.
function nextErrorStreak(streak, err) {
  if (tableRefused(err)) return 0;
  return isArgumentError(err) ? streak : streak + 1;
}

// The due rows, one at a time, until 40 homes were handled, the budget is spent, the database is away or the price
// engine is away. A row left for a stopped source is not one of the 40. Each stop is judged right after the row that
// causes it: the last row of a batch counts too, and a spent budget cannot hide it.
async function handleDueRows(due, ctx, startedAt, summary) {
  let errorStreak = 0;
  let handled = 0;
  for (const row of due) {
    if (ctx.clock() - startedAt >= BUDGET_MS) { summary.budgetSpent = true; return; }
    if (handled >= ROW_CAP) { summary.capReached = true; return; }
    const leftBefore = ctx.state.left;
    try {
      await handleRow(row, ctx);
      errorStreak = 0;
    } catch (err) {
      errorStreak = nextErrorStreak(errorStreak, err);
      bump(ctx.state.errors, errorCode(err));
    }
    if (ctx.state.left === leftBefore) handled += 1;
    // Several errors in a row that are not a row's own mean the database is away: the rest waits.
    if (errorStreak >= MAX_ERRORS_IN_A_ROW) { summary.errorStop = true; return; }
    // Several price engine failures in a row mean the engine or the live price list is away: the rest waits.
    if (ctx.state.engineStreak >= MAX_ENGINE_FAILURES_IN_A_ROW) { summary.engineStop = true; return; }
  }
  // Every row of the read was looked at. A full read means more may wait behind it.
  summary.capReached = due.length >= READ_CAP;
}

async function readDueRows(d, startedAt) {
  try {
    return await d.dueForPrice({ limit: READ_CAP, now: new Date(startedAt) });
  } catch (err) {
    // A database error can quote the query and its values: only its code leaves the module.
    throw new Error(`Mail home prices: the due rows could not be read (${errorCode(err)})`);
  }
}

// Why the run is a failed run: what the facts reader reports, and this run's own errors. Counts and codes only.
function problemsOf(ctx, summary) {
  const problems = [...homeFacts.factsProblems(ctx.facts)]; // a copy: the reader's own list is not this function's to change
  if (summary.errorStop) problems.push('stopped after errors in a row');
  const { quotes, engineFailures } = ctx.state;
  if (summary.engineStop) problems.push(`stopped after ${MAX_ENGINE_FAILURES_IN_A_ROW} price engine failures in a row`);
  else if (quotes > 0 && engineFailures === quotes) problems.push(`the price engine failed for every home it was asked (${quotes})`);
  const errors = Object.entries(ctx.state.errors);
  if (errors.length) {
    const count = errors.reduce((sum, [, n]) => sum + n, 0);
    problems.push(`${count} rows could not be read or saved (${errors.map(([code, n]) => `${code}: ${n}`).join('; ')})`);
  }
  return problems;
}

// The run's clock. A function is used as it is. A time in ms is the run's START: the clock then advances with real
// time from it, so the budget and the 20-hour page rule still measure elapsed time.
function clockOf(now) {
  if (typeof now === 'function') return () => Number(now());
  const start = Number(now);
  const realStart = Date.now();
  return () => start + (Date.now() - realStart);
}

/**
 * One run of the pass. `now` is a clock function, or the run's start time in ms. `deps` replaces an outside call
 * (tests): the three store calls here (dueForPrice, permitFacts, savePriceResult), and the ones home-facts and home-quote
 * take. Returns the summary; throws after logging it when the run is a failed run (see the top of the file).
 */
async function runHomePrices({ now = Date.now, deps } = {}) {
  const d = resolveDeps(deps);
  const clock = clockOf(now);
  const startedAt = clock();
  const state = { left: 0, kept: 0, byStatus: {}, byReason: {}, errors: {}, quotes: 0, engineFailures: 0, engineStreak: 0 };
  // The facts reader gets the run's deadline: a permit page read is up to 14 requests, and none is sent after it.
  const facts = homeFacts.createFactsContext({ deps: d, clock, deadline: startedAt + BUDGET_MS });
  const ctx = { d, deps: d, state, clock, facts };
  const due = await readDueRows(d, startedAt);
  const summary = { due: due.length, capReached: false, budgetSpent: false, errorStop: false, engineStop: false };
  await handleDueRows(due, ctx, startedAt, summary);
  Object.assign(summary, {
    priced: state.byStatus.priced || 0, byStatus: state.byStatus, byReason: state.byReason, left: state.left, kept: state.kept,
    quotes: state.quotes, engineFailures: state.engineFailures,
    ...homeFacts.factsSummary(ctx.facts), errors: state.errors, ms: clock() - startedAt,
  });
  logger.info(`Mail home prices: ${JSON.stringify(summary)}`);
  const problems = problemsOf(ctx, summary);
  if (problems.length) throw Object.assign(new Error(`Mail home prices: ${problems.join('; ')}`), { summary });
  return summary;
}

module.exports = { runHomePrices, BUDGET_MS, ROW_CAP, READ_CAP, MAX_ERRORS_IN_A_ROW, MAX_ENGINE_FAILURES_IN_A_ROW };
