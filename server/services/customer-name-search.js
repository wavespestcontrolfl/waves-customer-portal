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
  isNameLikeSearch, rankNameMatches, prefilterNameIndex, cachedNameIndex, MAX_RESULTS_V2,
} = require('./intelligence-bar/name-match');

// The fuzzy pass runs only when the exact search found fewer rows than this.
const EXACT_ROWS_BELOW = 3;
const MAX_APPROXIMATE_ROWS = MAX_RESULTS_V2; // 8
// Same cap and key as the Intelligence Bar, so one index serves both.
const INDEX_CAP = 20000;
const INDEX_KEY = 'customers:live';

function shouldSearchSoundAlike(search, exactTotal) {
  return typeof search === 'string'
    && isNameLikeSearch(search)
    && Number(exactTotal) < EXACT_ROWS_BELOW;
}

function loadNameCandidates(knex) {
  return knex('customers').whereNull('customers.deleted_at')
    .select('customers.id', 'customers.first_name', 'customers.last_name', 'customers.company_name')
    .orderBy('customers.id').limit(INDEX_CAP);
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

// Returns [{ id, score, reasons? }] best first, at most `limit` (8), never one
// of `exactIds`. Any failure returns [] (the exact rows must still show).
async function findSoundAlikeCustomers(knex, search, {
  scopeQuery = null, limit = MAX_APPROXIMATE_ROWS, context = null, exactIds = [],
} = {}) {
  if (!search || !isNameLikeSearch(search)) return [];
  try {
    const cap = Math.min(Math.max(1, Number(limit) || MAX_APPROXIMATE_ROWS), MAX_APPROXIMATE_ROWS);
    const index = await cachedNameIndex(INDEX_KEY, () => loadNameCandidates(knex));
    const found = prefilterNameIndex(search, index);
    const survivors = await allowedByScope(knex, scopeQuery, found);
    if (!survivors.length) return [];
    const skip = new Set(exactIds);
    // Extra slots: an exact row may rank among the matches and is dropped.
    const ranked = rankNameMatches(search, survivors, {
      v2: true, limit: cap + skip.size, context, prefiltered: true,
    });
    return ranked.filter((entry) => !skip.has(entry.id)).slice(0, cap);
  } catch (err) {
    logger.warn(`[customer-name-search] sound-alike search skipped: ${err.message}`);
    return [];
  }
}

module.exports = {
  EXACT_ROWS_BELOW, MAX_APPROXIMATE_ROWS, shouldSearchSoundAlike, findSoundAlikeCustomers,
};
