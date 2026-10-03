/**
 * Tree & Shrub watch items: the technician's own Seen / Not seen choices on the
 * month's watch list (GATE_TS_WATCH_LIST, owner DRAFT 2026-10-01).
 *
 * Tech-facing and storage only. The choices ride the /complete body as
 * treeShrubReview.watchItems and are frozen on the service record
 * (structured_notes.treeShrubWatchItems). No customer report, PDF, SMS or email
 * reads them. Everything here is tolerant: an invalid entry is dropped, never a
 * completion failure, and the gate off stores nothing.
 */
const { etCalendarDayOf } = require('../utils/datetime-et');
const {
  EXTENTS, ITEMS, normalizeWatchKey, validMonth, watchListForMonth,
} = require('../config/tree-shrub-watch-list');

const STATES = ['seen', 'not_seen'];
const SOURCES = ['read', 'tech'];
// A hard stop on how much of the wire list is even looked at; the stored list
// can never be longer than the month's own list (one entry per key).
const MAX_WIRE_ENTRIES = 50;

function tsWatchListLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.tsWatchListLive === 'function' && gates.tsWatchListLive() === true;
}

// The visit's month (1-12) in America/New_York from its scheduled date, or null.
function visitWatchMonth(scheduledDate) {
  if (scheduledDate == null || scheduledDate === '') return null;
  try {
    const day = etCalendarDayOf(scheduledDate);
    return validMonth(Number(String(day).slice(5, 7)));
  } catch {
    return null;
  }
}

// Wire entries -> the durable shape: known keys on THIS month's list only, a
// valid state, the first entry per key, an extent only on a seen item that
// takes one (never a refer-only item). Invalid entries drop.
function normalizeWatchItems(items, month) {
  if (!Array.isArray(items)) return [];
  const allowed = new Set(watchListForMonth(month).map((entry) => entry.key));
  const seen = new Set();
  const out = [];
  for (const raw of items.slice(0, MAX_WIRE_ENTRIES)) {
    if (!raw || typeof raw !== 'object') continue;
    const key = normalizeWatchKey(raw.key);
    if (!key || !allowed.has(key) || seen.has(key) || !STATES.includes(raw.state)) continue;
    seen.add(key);
    const entry = ITEMS[key];
    out.push({
      key,
      label: entry.label,
      state: raw.state,
      extent: raw.state === 'seen' && !entry.referOnly && EXTENTS.includes(raw.extent) ? raw.extent : null,
      source: SOURCES.includes(raw.source) ? raw.source : 'tech',
    });
    if (out.length >= allowed.size) break;
  }
  return out;
}

// The structured_notes fields for a completion, or null when there is nothing
// to freeze (gate off, no valid entries). Independent of the signed preview.
function freezeWatchItems(review, { month, now = new Date() } = {}) {
  if (!tsWatchListLive()) return null;
  const items = normalizeWatchItems(review && review.watchItems, month);
  if (!items.length) return null;
  return {
    treeShrubWatchItems: items,
    treeShrubWatchItemsDecidedAt: now.toISOString(),
  };
}

module.exports = {
  STATES,
  SOURCES,
  tsWatchListLive,
  visitWatchMonth,
  normalizeWatchItems,
  freezeWatchItems,
};
