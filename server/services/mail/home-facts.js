'use strict';

/**
 * Mailer step 2a (shadow): the facts of a new-home prospect's home, read from two free public county sources and
 * arbitrated like the estimator does. Used by the home price pass (services/mail/home-price.js).
 *
 *   - the parcel map, by parcel number: lot size, living area, stories;
 *   - when the map lacks the living area or the stories: the stored permit facts (detail_status 'ok' and not stale), or
 *     the county's permit page, once in 20 hours, stored through the permit reader's own recordResult so the weekly
 *     collector sees it. Stored facts are stale when the row has a CO date the last page read did not see (a plan can
 *     change at CO; the store's detail_stale). Stale facts are never used: the page is read again.
 *
 * Home size = the map's living area, else the permit plan's. Stories = the map's, else the permit's. Lot = the map's.
 * A missing fact is never guessed.
 *
 * Stops (per run, kept in the context): five parcel map failures in a row stop the map. The permit page stops by the
 * permit reader's own rule (its countResult): five failures in a row (the county site is away), or five pages in a row
 * with no building fields (the page structure changed; without the stop a run would mark every permit no_fields). The
 * parcel map's kill switch (COUNTY_PARCEL_GIS_DISABLED) and the permit page's own switch (GATE_PERMIT_DETAIL_SYNC off)
 * stop their source too. A row that needs a stopped source is left as it is. factsProblems says what the caller must
 * fail the run for. Strictly sequential: 0.6 s between map queries, the permit reader's throttle at the reader's own
 * gap (PERMIT_DETAIL_SYNC_MIN_GAP_MS, 2.5 s by default).
 *
 * This module never touches the database itself (the stored permit row comes in as an argument; recordResult is the
 * permit reader's), calls no paid or AI service, and logs nothing: counts and codes only, never a name, an address, a
 * parcel number or a permit number.
 */

const PARCEL_PAUSE_MS = 600;
const PAGE_RETRY_MS = 20 * 60 * 60 * 1000;
const MAX_FAILURES_IN_A_ROW = 5;
// The sizes the price table's columns hold. A number no home has is a missing fact, so it can never fail a save.
const MAX_HOME_SQFT = 1000000;
const MAX_LOT_SQFT = 2000000000;
const MAX_STORIES = 99;

const sleepFor = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const LEFT = Object.freeze({ left: true }); // a row to leave as it is: the source it needs is stopped

/**
 * The parcel map read by parcel number. lookupCountyParcelAttributesById is fail-open: it answers null for a parcel the
 * map does not have, for any error or timeout, and when COUNTY_PARCEL_GIS_DISABLED is on, so a null cannot be told from
 * an outage. A null is therefore a failure here (the row is tried again, and five in a row stop the source). The kill
 * switch is read first, so a run with the map turned off stops at once and does not mark every row failed.
 */
async function lookupParcelOrThrow(parcelPin) {
  const gis = require('../property-lookup/county-parcel-gis');
  if (gis.countyParcelGisDisabled()) throw Object.assign(new Error('parcel map lookups are turned off'), { code: 'parcel_map_disabled' });
  const attributes = await gis.lookupCountyParcelAttributesById('Manatee', parcelPin);
  if (!attributes) throw Object.assign(new Error('the parcel map gave no answer'), { code: 'parcel_map_no_answer' });
  return attributes;
}

// The portal's own switch for the county permit site (GATE_PERMIT_DETAIL_SYNC, read at call time).
const permitPageSwitchOn = () => require('../../config/feature-gates').permitDetailSyncLive();

// The real call for each outside dependency a test did not inject. Loaded one by one, so a test that injects them all
// never opens the permit reader (and with it the database module).
const REAL = {
  lookupParcel: () => lookupParcelOrThrow,
  fetchPermitPage: () => require('../property-lookup/manatee-permit-detail')._private.fetchPermitDetail,
  createThrottle: () => require('../property-lookup/manatee-permit-detail')._private.createThrottle,
  recordPermitResult: () => require('../property-lookup/manatee-permit-detail')._private.recordResult,
  // The permit reader's own stop rule and request gap, so the two readers of the county site agree.
  countPageResult: () => require('../property-lookup/manatee-permit-detail')._private.countResult,
  permitGapMs: () => require('../property-lookup/manatee-permit-detail')._private.minGapMs,
  permitPageOn: () => permitPageSwitchOn,
  sleep: () => sleepFor,
};

/**
 * The context one run reads facts with. `deps` replaces any outside call (tests); `clock` gives the time in ms.
 */
function createFactsContext({ deps = {}, clock = Date.now } = {}) {
  const d = {};
  for (const [name, real] of Object.entries(REAL)) d[name] = deps[name] || real();
  return {
    d,
    clock,
    polite: d.createThrottle({ gapMs: d.permitGapMs(), sleep: d.sleep, now: clock }),
    state: {
      mapQueries: 0, mapFailures: 0, mapStopped: false, mapDisabled: false,
      // pageCounts and pageStreaks are the shapes the permit reader's countResult folds a page status into.
      pages: 0, pageCounts: { ok: 0, noFields: 0, notFound: 0, errors: 0 }, pageStreaks: { noFields: 0, errors: 0 },
      pageStopped: false, pageStop: null, pageOff: false, storeErrors: {},
    },
  };
}

// A code or a class name, never a message: a message can quote a row or a page.
const codeOf = (value) => (typeof value === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(value) ? value : null);
const errorCode = (err) => codeOf(err?.reason) || codeOf(err?.code) || codeOf(err?.name) || 'error';

// A size the table can hold, as a whole number, or null.
function sizeOrNull(value, max) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && Math.round(n) >= 1 && n <= max ? Math.round(n) : null;
}
function storiesOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= MAX_STORIES ? Math.round(n * 10) / 10 : null;
}

/** The size and stories the arbitration picks: the map's first, then the permit's. The lot is the map's only. */
function arbitrate(parcel, permit) {
  const mapHome = sizeOrNull(parcel?.livingAreaSqft, MAX_HOME_SQFT);
  const permitHome = sizeOrNull(permit?.conditioned_sqft, MAX_HOME_SQFT);
  return {
    homeSqft: mapHome || permitHome,
    homeSqftSource: (mapHome && 'parcel_map') || (permitHome && 'permit_plan') || null,
    stories: storiesOrNull(parcel?.stories) || storiesOrNull(permit?.stories),
    lotSqft: sizeOrNull(parcel?.lotSqft, MAX_LOT_SQFT),
  };
}

/** The first fact a home lacks (no_home_size, no_stories, no_lot_size), or null. */
function firstMissing(facts) {
  if (!facts.homeSqft) return 'no_home_size';
  if (!facts.stories) return 'no_stories';
  return facts.lotSqft ? null : 'no_lot_size';
}

// ── The parcel map and the permit page ──

async function readParcel(row, ctx) {
  const { d, state } = ctx;
  if (state.mapStopped) return LEFT;
  if (state.mapQueries > 0) await d.sleep(PARCEL_PAUSE_MS);
  state.mapQueries += 1;
  try {
    const parcel = await d.lookupParcel(row.parcel_pin);
    state.mapFailures = 0;
    return { parcel };
  } catch (err) {
    if (err?.code === 'parcel_map_disabled') {
      state.mapStopped = true;
      state.mapDisabled = true;
      return LEFT;
    }
    state.mapFailures += 1;
    if (state.mapFailures >= MAX_FAILURES_IN_A_ROW) state.mapStopped = true;
    return { failed: 'parcel_map' };
  }
}

// The stored facts of an 'ok' row whose page was not read at its CO date may be an older plan's: they are not used.
const isStale = (permit) => permit.detail_status === 'ok' && permit.detail_stale === true;
const withoutStaleFacts = (permit) => (isStale(permit) ? { ...permit, conditioned_sqft: null, stories: null } : permit);

// One page status ('error' for a failure) folded into the run's counts and streaks by the permit reader's own rule.
// It answers 'structure' or 'outage' when the page must stop for this run.
function countPage(ctx, status) {
  const { d, state } = ctx;
  const stop = d.countPageResult(state.pageCounts, state.pageStreaks, status);
  if (stop) {
    state.pageStopped = true;
    state.pageStop = stop;
  }
}

// The permit page, fetched and stored. A transport failure throws out of the reader: that is a failure of the row, and
// nothing is stored for it (the row's own failed status holds the 20-hour wait).
async function fetchAndStorePage(permit, ctx) {
  const { d, state } = ctx;
  let page;
  try {
    page = await d.fetchPermitPage(permit.permit_no, { polite: ctx.polite });
  } catch {
    countPage(ctx, 'error');
    return { failed: 'permit_page' };
  }
  state.pages += 1;
  let stored = true;
  try {
    await d.recordPermitResult(permit, page.status, page.facts, new Date(ctx.clock()));
  } catch (err) {
    // The result could not be stored: the facts of this read are still used, and the caller fails the run.
    const code = errorCode(err);
    state.storeErrors[code] = (state.storeErrors[code] || 0) + 1;
    stored = false;
  }
  // As the permit reader counts it: a result that could not be stored is an error.
  countPage(ctx, stored ? page.status : 'error');
  // No good read: a stale row's old facts stay unused. A good read is merged as recordResult stores it: a fact the
  // page shows replaces the stored one, and a fact it does not show keeps the stored value.
  if (page.status !== 'ok') return { permit: withoutStaleFacts(permit) };
  const found = Object.fromEntries(Object.entries(page.facts || {}).filter(([, value]) => value !== null && value !== undefined));
  return { permit: { ...permit, ...found, detail_stale: false } };
}

/**
 * The permit's facts for a home the map could not fully size: the stored ones when the page was read at the row's CO
 * date (detail_status 'ok', not stale), else the page, unless it was tried in the last 20 hours. A stale row's stored
 * facts are never used. The permit page's own switch is read before each fetch: off, the page is stopped for the run.
 * { permit } | { failed } | LEFT.
 */
async function permitForGaps(permit, ctx) {
  const { d, state } = ctx;
  if (permit.detail_status === 'ok' && !isStale(permit)) return { permit };
  const fetchedAt = permit.detail_fetched_at ? new Date(permit.detail_fetched_at).getTime() : null;
  if (fetchedAt !== null && ctx.clock() - fetchedAt < PAGE_RETRY_MS) return { permit: withoutStaleFacts(permit) };
  if (!state.pageStopped && !d.permitPageOn()) {
    state.pageStopped = true;
    state.pageOff = true;
  }
  if (state.pageStopped) return LEFT;
  return fetchAndStorePage(permit, ctx);
}

/**
 * The facts of one home. `permit` is its stored permit row (home-price-store permitFacts, with its detail_stale).
 * Returns
 *   LEFT                          the parcel map or the permit page it needs is stopped for this run;
 *   { failed, facts }             a read threw: failed is 'parcel_map' or 'permit_page'; facts are what the map gave;
 *   { facts, missing }            the arbitrated facts { homeSqft, homeSqftSource, stories, lotSqft } and the first
 *                                 missing one (firstMissing), or null when the home has every fact.
 */
async function readHomeFacts(row, permit, ctx) {
  const read = await readParcel(row, ctx);
  if (read.left) return LEFT;
  if (read.failed) return { failed: read.failed, facts: arbitrate(null, null) };
  let facts = arbitrate(read.parcel, null);
  if (!facts.homeSqft || !facts.stories) {
    const more = await permitForGaps(permit, ctx);
    if (more.left) return LEFT;
    if (more.failed) return { failed: more.failed, facts };
    facts = arbitrate(read.parcel, more.permit);
  }
  return { facts, missing: firstMissing(facts) };
}

// ── What the caller reports ──

/** Counts for the run's summary and log line. */
function factsSummary(ctx) {
  const { state } = ctx;
  return {
    mapQueries: state.mapQueries, mapFailuresInARow: state.mapFailures, mapStopped: state.mapStopped, mapDisabled: state.mapDisabled,
    permitPages: state.pages, permitFailuresInARow: state.pageStreaks.errors, permitNoFieldsInARow: state.pageStreaks.noFields,
    permitStopped: state.pageStopped, permitStop: state.pageStop, permitPageOff: state.pageOff,
  };
}

/** Why the run is a failed run, as short sentences with counts and codes only; an empty list for a good run. */
function factsProblems(ctx) {
  const { state } = ctx;
  const problems = [];
  if (state.mapDisabled) problems.push('the parcel map is turned off (COUNTY_PARCEL_GIS_DISABLED)');
  else if (state.mapStopped) problems.push(`the parcel map did not answer (${state.mapFailures} failures in a row)`);
  if (state.pageOff) problems.push('the permit page is turned off (GATE_PERMIT_DETAIL_SYNC)');
  else if (state.pageStop === 'structure') {
    problems.push(`the permit page showed no building fields (${state.pageStreaks.noFields} pages in a row; did the page change?)`);
  } else if (state.pageStopped) problems.push(`the permit page did not answer (${state.pageStreaks.errors} failures in a row)`);
  const stored = Object.entries(state.storeErrors);
  if (stored.length) {
    const count = stored.reduce((sum, [, n]) => sum + n, 0);
    problems.push(`${count} permit page results could not be stored (${stored.map(([code, n]) => `${code}: ${n}`).join('; ')})`);
  }
  return problems;
}

module.exports = {
  createFactsContext, readHomeFacts, factsSummary, factsProblems, arbitrate, firstMissing, LEFT,
  PARCEL_PAUSE_MS, PAGE_RETRY_MS, MAX_FAILURES_IN_A_ROW,
};
