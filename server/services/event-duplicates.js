/**
 * Event duplicate detection + merge helpers.
 *
 * Ingest dedupes only on (source_id, external_id), so the same real-world
 * event scraped from two sources becomes two events_raw rows. These pure
 * helpers (no DB) power the admin merge feature: cluster likely duplicates
 * for review, and rewrite calendar event-id arrays when a merge collapses
 * several rows into one survivor.
 */

const { etParts } = require('../utils/datetime-et');

/**
 * Normalize a title for fuzzy duplicate matching: lowercase, strip
 * punctuation, collapse whitespace, drop a few noise words. Two events with
 * the same normalized title on the same day in the same city are almost
 * certainly the same event from different feeds.
 */
function normalizeEventTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|presents?|featuring|feat|with|at|in)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ET calendar day key (YYYY-MM-DD) for an event's start, or '' if undated. */
function etDayKey(startAt) {
  if (!startAt) return '';
  const p = etParts(new Date(startAt));
  if (!p || !p.year) return '';
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function normalizeCity(city) {
  return String(city || '').trim().toLowerCase();
}

/**
 * Group events into likely-duplicate clusters. Two events cluster when they
 * share a normalized title AND the same ET start day AND the same city.
 * Undated or untitled events are never clustered (too risky to auto-suggest).
 * Only clusters of 2+ are returned, each sorted with a suggested primary
 * first (most complete row: has image, then has url, then earliest pulled).
 *
 * @param {Array} events - events_raw rows (need id, title, start_at, city, image_url, event_url, source_id, pulled_at)
 * @returns {Array<{key:string, events:Array, suggestedPrimaryId:any}>}
 */
function findDuplicateClusters(events) {
  const groups = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    const title = normalizeEventTitle(ev.title);
    const day = etDayKey(ev.start_at);
    const city = normalizeCity(ev.city);
    if (!title || !day || !city) continue; // need all three to claim a dupe
    const key = `${title}|${day}|${city}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  const clusters = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const ranked = [...group].sort(compareForPrimary);
    clusters.push({ key, events: ranked, suggestedPrimaryId: ranked[0].id });
  }
  return clusters;
}

// Prefer the most "complete" row as the suggested primary: image, then url,
// then the earliest-pulled (most established) row.
function compareForPrimary(a, b) {
  const score = (e) => (e.image_url ? 2 : 0) + (e.event_url ? 1 : 0);
  const diff = score(b) - score(a);
  if (diff !== 0) return diff;
  const at = a.pulled_at ? new Date(a.pulled_at).getTime() : Infinity;
  const bt = b.pulled_at ? new Date(b.pulled_at).getTime() : Infinity;
  return at - bt;
}

/**
 * Rewrite a calendar's event_ids array after a merge: every id that was
 * merged away is replaced by its surviving primary, then the array is
 * deduped (preserving order). Returns the new array, or null if nothing
 * changed (so callers can skip the DB write).
 *
 * @param {string[]} eventIds - the calendar row's current event_ids
 * @param {Map<string,string>|Object} mergeMap - mergedId -> primaryId
 * @returns {string[]|null}
 */
function rewriteCalendarEventIds(eventIds, mergeMap) {
  if (!Array.isArray(eventIds) || eventIds.length === 0) return null;
  const lookup = mergeMap instanceof Map ? mergeMap : new Map(Object.entries(mergeMap || {}));
  let changed = false;
  const seen = new Set();
  const out = [];
  for (const id of eventIds) {
    const mapped = lookup.get(id) || id;
    if (mapped !== id) changed = true;
    if (seen.has(mapped)) { changed = true; continue; } // collapsed a dup
    seen.add(mapped);
    out.push(mapped);
  }
  return changed ? out : null;
}

module.exports = {
  normalizeEventTitle,
  findDuplicateClusters,
  rewriteCalendarEventIds,
};
