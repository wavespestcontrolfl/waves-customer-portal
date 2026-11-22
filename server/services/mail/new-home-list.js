'use strict';

/**
 * The new-home mail list, shadow only (nothing is sent and nothing reads the table yet). Nothing calls this module
 * yet either: the two cron ticks come in the next PR.
 *
 * A run reads the last few days of the Manatee County Clerk's public deed list, keeps the deeds where a builder (a
 * company) sold a home to a person, matches each deed to a parcel and to a new-home permit, and stores ONE
 * mail_prospects row per home.
 *
 * The Clerk fills in From, To and Description over about two days (same day 0%, next day 56%, two days 85%), so
 * every run re-reads several days and skips deeds that are not filled in yet. A deed is settled once it is eligible,
 * held back or not eligible and is never asked about again. An `unmatched` deed is tried again after a wait, because
 * the permit or the parcel may appear later; that goes on while its day is one of the days a run reads.
 *
 * One deed that cannot be judged or saved does not stop the deeds after it: it is counted, and the run throws at
 * its end. The run also throws at its end when a day could not be read, the parcel map did not answer, or a deed
 * was left unjudged on the last day a run reads it, so a site that is away for days is seen before its deeds
 * leave the read. The log line and the thrown error hold counts, dates and codes only, never a name or an address.
 */

const crypto = require('node:crypto');
const logger = require('../logger');
const { addETDays, etParts, etDateString } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');
const { parseLegal, chooseParcel } = require('./deed-parcel-match');

const LIST_KEY = 'new_home';
const SOURCE = 'manatee_clerk_deed';
const MIN_PRICE = 150000;
const NIGHT_DAYS = 6;
const NOON_DAYS = 2;
const RETRY_AFTER_MS = 20 * 60 * 60 * 1000;
const DAY_PAUSE_MS = 4000; // the Clerk site sits behind Cloudflare: one page at a time, slowly
const PARCEL_PAUSE_MS = 600;
const MAX_PARCEL_QUERIES = 120;
const MAX_LOOKUP_FAILURES_IN_A_ROW = 5;
const MAX_ERRORS_IN_A_ROW = 3;
const HOLD_BACK_ONE_IN = 5;
const SETTLED_STATUSES = new Set(['eligible', 'held_back', 'not_eligible']);

// Endings that are also written letter by letter ("L.L.C.", "L L C", "L.P."): each is matched in both forms.
const LETTER_ENDINGS = ['LLC', 'LC', 'LP', 'LLP', 'LLLP', 'PLLC', 'PA', 'NA'];
const COMPANY_WORDS = [
  ...LETTER_ENDINGS, ...LETTER_ENDINGS.map((ending) => ending.split('').join(' ')),
  'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD',
  'LIMITED', 'HOMES', 'HOME', 'BUILDERS', 'CONSTRUCTION', 'DEVELOPMENT', 'COMMUNITIES', 'PROPERTIES',
  'HOLDINGS', 'INVESTMENTS', 'PARTNERS', 'PARTNERSHIP', 'GROUP', 'VENTURES', 'ENTERPRISES', 'FUND', 'BANK',
  'REALTY', 'RENTALS', 'CAPITAL', 'ASSOCIATES', 'MANAGEMENT', 'SERVICES', 'HOUSING', 'MINISTRIES',
  'ASSOCIATION', 'ASSN', 'CHURCH', 'FOUNDATION', 'COUNTY', 'CITY', 'STATE', 'DEPARTMENT', 'AUTHORITY',
];
const TRUST_WORDS = ['TRUST', 'TRUSTEE', 'TRUSTEES', 'TR', 'TRS', 'REVOCABLE', 'IRREVOCABLE', 'ESTATE'];

// Whole words only, after punctuation turns into spaces ("L.L.C." reads as "L L C", "M/I HOMES" as "M I HOMES").
// A letter-by-letter ending is matched as its own words, so initials before it do not hide it ("A B L.L.C.").
const wordMatcher = (words) => new RegExp(`(?:^| )(?:${words.join('|')})(?: |$)`);
const COMPANY_RE = wordMatcher(COMPANY_WORDS);
const TRUST_RE = wordMatcher(TRUST_WORDS);
const spaced = (name) => String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

const isCompanyName = (name) => COMPANY_RE.test(spaced(name));
const isTrustName = (name) => TRUST_RE.test(spaced(name));
// A builder is a company that does not sell as a trust or a trustee. A person's capacity can hold a company word
// ("TESTER ALEX CO-TRUSTEE" reads as "CO TRUSTEE"), and so can a trust's name ("TESTER HOME TRUST").
const isBuilderName = (name) => isCompanyName(name) && !isTrustName(name);

function buyerKind(toNames) {
  if (toNames.some(isCompanyName)) return 'company';
  if (toNames.some(isTrustName)) return 'trust';
  return 'person';
}

/** A deed worth looking at, or the reason it is not (counted, never stored). */
function candidateFromRow(row) {
  if (String(row.type || '').trim().toUpperCase() !== 'DEED') return { skip: 'other_type' };
  if (!row.from.length || !row.to.length || !row.description) return { skip: 'not_filled' };
  if (row.consideration === null || row.consideration < MIN_PRICE) return { skip: 'low_price' };
  if (!row.from.every(isCompanyName)) return { skip: 'person_seller' };
  if (!row.from.every(isBuilderName)) return { skip: 'trust_seller' };
  return {
    candidate: {
      instrument: row.instrument,
      date: row.date,
      sellerNames: row.from,
      recipientNames: row.to,
      consideration: row.consideration,
      description: row.description,
      buyerKind: buyerKind(row.to),
    },
  };
}

/**
 * Fixed for a home forever: one in five homes gets no card and is the comparison group for the ones that do. It is
 * a hash of the parcel, not a random draw, so a re-read never moves a home between the groups.
 */
function holdBack(listKey, parcelPin) {
  const digest = crypto.createHash('sha256').update(`${listKey}:${parcelPin}`).digest();
  return digest.readUInt32BE(0) % HOLD_BACK_ONE_IN === 0;
}

function baseRow(candidate) {
  return {
    list_key: LIST_KEY,
    source: SOURCE,
    source_ref: candidate.instrument,
    recorded_date: candidate.date,
    seller_names: candidate.sellerNames,
    recipient_names: candidate.recipientNames,
    buyer_kind: candidate.buyerKind,
    consideration: candidate.consideration,
    legal_description: candidate.description,
  };
}

const withStatus = (row, status, reason = null) => ({ ...row, status, reason });

// The map's numbers go into columns of a fixed size (stories is decimal(4,1)). A number no house has is stored as
// unknown, so it can never make the save fail.
const sizeOrNull = (value, max) => (Number.isFinite(value) && value > 0 && value <= max ? value : null);

function matchedRow(row, choice) {
  const { parcel, permit, basis } = choice;
  const live = holdBack(LIST_KEY, parcel.parid) ? 'held_back' : 'eligible';
  return {
    ...withStatus(row, live),
    match_basis: basis,
    parcel_pin: parcel.parid,
    permit_no: permit.permit_no,
    co_date: dateOnlyString(permit.co_date) || null,
    address_line1: parcel.addressLine1,
    city: parcel.city,
    state: 'FL',
    zip: parcel.zip,
    subdivision: parcel.subdivision,
    living_sqft: sizeOrNull(parcel.livingSqft, 1000000),
    stories: sizeOrNull(parcel.stories, 99),
    year_built: sizeOrNull(parcel.yearBuilt, 9999),
  };
}

/** The row to save for one deed. The only map query happens in step 3. */
async function evaluate(candidate, deps) {
  const row = baseRow(candidate);
  if (candidate.buyerKind === 'company') return withStatus(row, 'not_eligible', 'company_buyer');
  if (candidate.buyerKind === 'trust') return withStatus(row, 'not_eligible', 'trust_buyer');
  const legal = parseLegal(candidate.description);
  if (!legal) return withStatus(row, 'not_eligible', 'no_lot');
  let parcels;
  try {
    parcels = await deps.queryParcels(legal);
  } catch {
    return withStatus(row, 'unmatched', 'lookup_failed');
  }
  const permitsByParid = await deps.newHomePermitsForParcels(parcels);
  const choice = chooseParcel({ sellerNames: candidate.sellerNames, parcels, permitsByParid });
  if (choice.status !== 'matched') return withStatus(row, 'unmatched', choice.status);
  const { addressLine1, zip } = choice.parcel;
  if (!/^\d/.test(addressLine1 || '') || !/^\d{5}$/.test(zip || '')) return withStatus(row, 'unmatched', 'no_address');
  if (await deps.addressKnownToWaves(addressLine1, zip)) return withStatus(row, 'not_eligible', 'known_address');
  return matchedRow(row, choice);
}

/** Calendar days in America/New_York ending today, weekends removed, newest first (YYYY-MM-DD). */
function daysToRead(mode, now = Date.now()) {
  const at = new Date(typeof now === 'function' ? now() : now);
  const count = mode === 'noon' ? NOON_DAYS : NIGHT_DAYS;
  const days = [];
  for (let back = 0; back < count; back += 1) {
    const day = addETDays(at, -back); // noon UTC on that ET calendar day: clear of the daylight-time seam
    const dow = etParts(day).dayOfWeek;
    if (dow !== 0 && dow !== 6) days.push(etDateString(day));
  }
  return days;
}

const sleepFor = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function resolveDeps(deps = {}) {
  const names = ['fetchDayList', 'queryParcels', 'findBySourceRefs', 'newHomePermitsForParcels', 'addressKnownToWaves', 'saveProspect'];
  let base = { sleep: sleepFor };
  if (names.some((n) => !deps[n])) {
    // Loaded here, not at the top: a test that injects every dependency never opens the database module.
    const store = require('./prospect-store');
    base = {
      ...base,
      fetchDayList: require('./clerk-deed-list').fetchDayList,
      queryParcels: require('./deed-parcel-match').queryParcels,
      findBySourceRefs: store.findBySourceRefs,
      newHomePermitsForParcels: store.newHomePermitsForParcels,
      addressKnownToWaves: store.addressKnownToWaves,
      saveProspect: store.saveProspect,
    };
  }
  return { ...base, ...deps };
}

const bump = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };

// A code or a class name, never a message: a message can quote a row or a page.
const codeOf = (value) => (typeof value === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(value) ? value : null);
const errorCode = (err) => codeOf(err?.reason) || codeOf(err?.code) || codeOf(err?.name) || 'error';

// Errors that belong to one deed, not to something every deed needs. They are counted, and they never add to the
// errors-in-a-row stop; any other error can be a dependency that is away (the database, its pool).
// A row PostgreSQL refused (SQLSTATE class 22, a value that does not fit; class 23, a constraint) also shows that
// the database answered, so the count starts again. An error of the code on this deed's data (TypeError,
// RangeError) says nothing about the database, so the count stays as it is.
const isRefusedRow = (err) => /^2[23][0-9A-Z]{3}$/.test(String(err?.code || ''));
const isCodeError = (err) => err?.name === 'TypeError' || err?.name === 'RangeError';

// A day that cannot be read is recorded and the run goes on with the other days.
async function readDays(days, d, summary) {
  const rows = [];
  const failures = [];
  for (let i = 0; i < days.length; i += 1) {
    if (i > 0) await d.sleep(DAY_PAUSE_MS);
    try {
      const { rows: dayRows } = await d.fetchDayList(days[i]);
      rows.push(...dayRows);
      summary.daysRead += 1;
    } catch (err) {
      summary.daysFailed += 1;
      failures.push(`${days[i]}: ${errorCode(err)}`);
    }
  }
  return { rows, failures };
}

function collectCandidates(rows, summary) {
  const seen = new Set();
  const candidates = [];
  for (const row of rows) {
    summary.deeds += 1;
    const { skip, candidate } = candidateFromRow(row);
    if (skip) bump(summary.skipped, skip);
    else if (!seen.has(candidate.instrument)) {
      seen.add(candidate.instrument);
      candidates.push(candidate);
    }
  }
  return candidates;
}

// Why an already stored deed is not asked about again, or null when it is due.
function whyNotDue(existing, nowMs) {
  if (!existing) return null;
  if (SETTLED_STATUSES.has(existing.status)) return 'settled';
  const checked = existing.last_checked_at ? new Date(existing.last_checked_at).getTime() : 0;
  return nowMs - checked < RETRY_AFTER_MS ? 'retry_wait' : null;
}

const needsMapQuery = (candidate) => candidate.buyerKind === 'person' && parseLegal(candidate.description) !== null;

async function evaluateAndSave(candidates, d, summary, readTomorrow) {
  const state = { queries: 0, failStreak: 0, errorStreak: 0 };
  // Counts and spaces the map queries, so the cap and the failure stop hold for any caller of evaluate.
  const countedDeps = {
    newHomePermitsForParcels: d.newHomePermitsForParcels,
    addressKnownToWaves: d.addressKnownToWaves,
    queryParcels: async (legal) => {
      if (state.queries > 0) await d.sleep(PARCEL_PAUSE_MS);
      state.queries += 1;
      try {
        const parcels = await d.queryParcels(legal);
        state.failStreak = 0;
        return parcels;
      } catch (err) {
        state.failStreak += 1;
        throw err;
      }
    },
  };
  for (const candidate of candidates) {
    const mapStopped = state.queries >= MAX_PARCEL_QUERIES || state.failStreak >= MAX_LOOKUP_FAILURES_IN_A_ROW;
    // Several errors in a row that are not a deed's own mean the database is away: every deed left waits.
    if (state.errorStreak >= MAX_ERRORS_IN_A_ROW || (mapStopped && needsMapQuery(candidate))) {
      bump(summary.skipped, 'waits_for_next_run'); // not saved: the next run asks again
      // ...unless no later run reads its day: then the deed is lost, and the run must not end as a good run.
      if (!readTomorrow.has(candidate.date)) bump(summary.leftOnLastDay, candidate.date);
      continue;
    }
    try {
      const row = await evaluate(candidate, countedDeps);
      const stored = await d.saveProspect(row);
      state.errorStreak = 0;
      // Counted as the table holds it, not as this run judged it. The store saves a home that is already live
      // under another deed as not_eligible / duplicate_parcel or duplicate_permit, and it keeps a more careful
      // answer that another run saved for this deed in the meantime (written: false).
      bump(summary.saved, stored.status);
      if (stored.reason) bump(summary.savedByReason, `${stored.status}/${stored.reason}`);
      if (!stored.written) summary.keptAnswers += 1;
    } catch (err) {
      // One deed that cannot be judged or saved must not stop the deeds after it. It is not saved, so the next
      // run tries it again, and this run throws at its end. Only an error that is not the deed's own counts
      // toward the stop: three refused rows in a row must not make every deed after them wait.
      if (isRefusedRow(err)) state.errorStreak = 0;
      else if (!isCodeError(err)) state.errorStreak += 1;
      bump(summary.errors, errorCode(err));
    }
  }
  summary.mapQueries = state.queries;
  // The count at the end of the run: the stop holds it at its limit, and it equals mapQueries when no query of
  // this run was answered.
  summary.mapFailuresInARow = state.failStreak;
}

async function runNewHomeList({ mode = 'night', now = Date.now, deps } = {}) {
  const d = resolveDeps(deps);
  const nowMs = typeof now === 'function' ? now() : Number(now);
  const days = daysToRead(mode, nowMs);
  const summary = {
    mode, days: days.length, daysRead: 0, daysFailed: 0, deeds: 0, skipped: {}, saved: {}, savedByReason: {}, errors: {},
    keptAnswers: 0, mapQueries: 0, mapFailuresInARow: 0, leftOnLastDay: {},
  };
  const { rows, failures } = await readDays(days, d, summary);
  const candidates = collectCandidates(rows, summary);
  let existingRows = [];
  if (candidates.length) {
    try {
      existingRows = await d.findBySourceRefs(LIST_KEY, SOURCE, candidates.map((c) => c.instrument));
    } catch (err) {
      // No deed can be judged without the stored rows. A database error can quote the query and its values, so
      // only its code leaves the module, like every other error here.
      logger.info(`Mail new-home list (${mode}): ${JSON.stringify(summary)}`);
      throw new Error(`Mail new-home list: the stored deeds could not be read (${errorCode(err)})`);
    }
  }
  const bySourceRef = new Map(existingRows.map((r) => [r.source_ref, r]));
  const due = [];
  for (const candidate of candidates) {
    const existing = bySourceRef.get(candidate.instrument);
    const why = whyNotDue(existing, nowMs);
    if (why) bump(summary.skipped, why);
    else due.push({ candidate, retry: existing ? 1 : 0 });
  }
  // The map-query budget goes first to what cannot wait: a deed never judged before a retry, and an older day
  // before a newer one (the oldest day is the first to leave the read). The page order stays inside a day.
  due.sort((a, b) => (a.retry - b.retry) || a.candidate.date.localeCompare(b.candidate.date));
  // A day is on its last read when tomorrow's night run no longer reads it (the noon run reads less).
  const readTomorrow = new Set(daysToRead('night', addETDays(new Date(nowMs), 1)));
  await evaluateAndSave(due.map((item) => item.candidate), d, summary, readTomorrow);
  logger.info(`Mail new-home list (${mode}): ${JSON.stringify(summary)}`);
  const problems = [];
  if (failures.length) problems.push(`${failures.length} of ${days.length} days failed (${failures.join('; ')})`);
  const errors = Object.entries(summary.errors);
  if (errors.length) {
    const count = errors.reduce((sum, [, n]) => sum + n, 0);
    problems.push(`${count} deeds could not be judged or saved (${errors.map(([code, n]) => `${code}: ${n}`).join('; ')})`);
  }
  const left = Object.entries(summary.leftOnLastDay);
  if (left.length) {
    const count = left.reduce((sum, [, n]) => sum + n, 0);
    problems.push(`${count} deeds were not judged on the last day a run reads them (${left.map(([day, n]) => `${day}: ${n}`).join('; ')})`);
  }
  // The parcel map did not answer: the stop tripped, or every query of this run failed. Its deeds are stored as
  // unmatched / lookup_failed and tried again, but a run that learned nothing from the map is not a good run.
  const mapAway = summary.mapFailuresInARow >= MAX_LOOKUP_FAILURES_IN_A_ROW
    || (summary.mapQueries > 0 && summary.mapFailuresInARow === summary.mapQueries);
  if (mapAway) problems.push(`the parcel map did not answer (${summary.mapFailuresInARow} failures in a row)`);
  if (problems.length) throw new Error(`Mail new-home list: ${problems.join('; ')}`);
  return summary;
}

module.exports = {
  LIST_KEY, SOURCE, MIN_PRICE, NIGHT_DAYS, NOON_DAYS, RETRY_AFTER_MS, DAY_PAUSE_MS,
  PARCEL_PAUSE_MS, MAX_PARCEL_QUERIES, MAX_LOOKUP_FAILURES_IN_A_ROW, MAX_ERRORS_IN_A_ROW, HOLD_BACK_ONE_IN,
  isCompanyName, isTrustName, buyerKind, candidateFromRow, holdBack, evaluate, daysToRead, runNewHomeList,
};
