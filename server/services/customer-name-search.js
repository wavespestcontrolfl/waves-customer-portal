'use strict';

// Sound-alike rows for the admin customer pickers (GATE_CUSTOMER_SEARCH_FUZZY).
//
// The exact picker search (customer-list-search.js) is an ILIKE "contains", so
// a misspelled or sound-alike name ("Orlan damp" for "Orlan Stompf") finds
// nothing. When that exact search finds fewer than EXACT_ROWS_BELOW rows and
// the text looks like a name, this module ranks the customer book with the v2
// name matcher the Intelligence Bar uses and returns up to 8 approximate
// matches for the route to append AFTER the exact rows.
//
// It never reads the gate: the caller decides. It reads nothing but customer
// ids and names (one shared, cached index of every live customer; see
// intelligence-bar/name-match.js) and asks the database which of the few
// survivors the caller's own filtered, scoped query allows, so a technician's
// assigned-visit scope is never widened. Read only; it sends nothing.

const logger = require('./logger');
const {
  isNameLikeSearch, rankNameMatches, prefilterNameIndex, cachedNameIndex, MAX_RESULTS_V2, MAX_SURVIVORS,
} = require('./intelligence-bar/name-match');

// The fuzzy pass runs only when the exact search found fewer rows than this.
const EXACT_ROWS_BELOW = 3;
const MAX_APPROXIMATE_ROWS = MAX_RESULTS_V2; // 8
// Same key, loader and cap as the Intelligence Bar (tools.js exports them), so
// whichever caller warms the 5-minute cache, both get the same whole-book index.
const INDEX_KEY = 'customers:live';

// Words that make a text search an address, not a name: street suffixes, unit
// words and the state. "Main Street", "100 Oak Ave" (a digit already rules it
// out), "Bradenton FL" never run the name pass.
const ADDRESS_WORDS = new Set([
  'st', 'street', 'ave', 'avenue', 'av', 'rd', 'road', 'dr', 'drive', 'ln', 'lane', 'blvd', 'boulevard',
  'ct', 'court', 'cir', 'circle', 'way', 'pl', 'place', 'ter', 'terrace', 'trl', 'trail', 'pkwy', 'parkway',
  'hwy', 'highway', 'loop', 'cv', 'cove', 'apt', 'unit', 'suite', 'ste', 'fl', 'florida',
]);

function normalizedWords(text) {
  return String(text || '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// True when one of the exact rows already matched the text on its address or
// city (the exact search is a "contains" on those columns), so the text is a
// place, not a misspelled name: "Fort Myers" matching a city on file.
// Rows may be raw customer rows (address_line1, city) or schedule rows (address, city).
function matchedOnAddress(search, exactRows) {
  const needle = normalizedWords(search).join(' ');
  if (!needle) return false;
  return (exactRows || []).some((row) => {
    const place = normalizedWords([row.address_line1, row.address_line2, row.address, row.city].filter(Boolean).join(' ')).join(' ');
    return place.includes(needle);
  });
}

function shouldSearchSoundAlike(search, exactTotal, exactRows = []) {
  return typeof search === 'string'
    && isNameLikeSearch(search)
    && Number(exactTotal) < EXACT_ROWS_BELOW
    && !normalizedWords(search).some((word) => ADDRESS_WORDS.has(word))
    && !matchedOnAddress(search, exactRows);
}

// The shared loader: name columns of every live customer, capped like the
// Intelligence Bar's. Required when the cache is cold, not at load time.
function loadNameCandidates(knex) {
  const { nameCandidates, NAME_INDEX_BOOK_CAP } = require('./intelligence-bar/tools');
  return nameCandidates(knex('customers').whereNull('customers.deleted_at'), NAME_INDEX_BOOK_CAP);
}

// Which of the survivors the caller's scoped query allows: one id-only read of
// at most MAX_SURVIVORS + context rows. `scopeQuery` is a customers query with
// the caller's filters and technician scope and NO text search.
async function allowedByScope(knex, scopeQuery, survivors) {
  if (!survivors.length) return survivors;
  const base = scopeQuery || knex('customers').whereNull('customers.deleted_at');
  const rows = await base.clone().clearSelect().clearOrder()
    .select('customers.id').whereIn('customers.id', survivors.map((entry) => entry.id));
  const allowed = new Set(rows.map((row) => row.id));
  return survivors.filter((entry) => allowed.has(entry.id));
}

// The global index is ranked before the caller's filters and scope apply, so
// excluded customers must not use up the candidate slots: walk the ranked list
// in MAX_SURVIVORS chunks (at most ten id-only reads) until MAX_SURVIVORS
// allowed customers are found.
const ALLOWED_SCAN_CHUNKS = 10;
async function allowedSurvivors(knex, scopeQuery, search, index) {
  const ranked = prefilterNameIndex(search, index, { cap: MAX_SURVIVORS * ALLOWED_SCAN_CHUNKS });
  const allowed = [];
  for (let at = 0; at < ranked.length && allowed.length < MAX_SURVIVORS; at += MAX_SURVIVORS) {
    allowed.push(...await allowedByScope(knex, scopeQuery, ranked.slice(at, at + MAX_SURVIVORS)));
  }
  return allowed.slice(0, MAX_SURVIVORS);
}

// The cached index can be up to five minutes old (a customer renamed since, or
// deleted, is still in it). Read the matches' CURRENT names through the caller's
// scoped query and score them again, as the Intelligence Bar does for its rows:
// a customer whose current name no longer qualifies drops out, and the score
// returned is the current one.
async function rescoreCurrentNames(knex, scopeQuery, search, ranked, context) {
  if (!ranked.length) return ranked;
  const base = scopeQuery || knex('customers').whereNull('customers.deleted_at');
  const rows = await base.clone().clearSelect().clearOrder()
    .select('customers.id', 'customers.first_name', 'customers.last_name', 'customers.company_name')
    .whereIn('customers.id', ranked.map((entry) => entry.id));
  return rankNameMatches(search, rows, { v2: true, limit: rows.length || 1, context });
}

// Returns [{ id, score, reasons? }] best first, at most `limit` (8), never one
// of `exactIds`. Any failure returns [] (the exact rows must still show).
async function findSoundAlikeCustomers(knex, search, {
  scopeQuery = null, limit = MAX_APPROXIMATE_ROWS, context = null, exactIds = [],
} = {}) {
  if (!search || !isNameLikeSearch(search)) return [];
  try {
    const cap = Math.min(Math.max(1, Number(limit) || MAX_APPROXIMATE_ROWS), MAX_APPROXIMATE_ROWS);
    const index = await cachedNameIndex(INDEX_KEY, () => loadNameCandidates(knex));
    const survivors = await allowedSurvivors(knex, scopeQuery, search, index);
    if (!survivors.length) return [];
    const skip = new Set(exactIds);
    // Extra slots: an exact row may rank among the matches and is dropped, and a
    // customer renamed since the index was built may fail the rescore below.
    const ranked = rankNameMatches(search, survivors, {
      v2: true, limit: (cap + skip.size) * 2, context, prefiltered: true,
    });
    const current = await rescoreCurrentNames(knex, scopeQuery, search, ranked, context);
    return current.filter((entry) => !skip.has(entry.id)).slice(0, cap);
  } catch (err) {
    logger.warn(`[customer-name-search] sound-alike search skipped: ${err.message}`);
    return [];
  }
}

module.exports = {
  EXACT_ROWS_BELOW, MAX_APPROXIMATE_ROWS, shouldSearchSoundAlike, findSoundAlikeCustomers,
};
