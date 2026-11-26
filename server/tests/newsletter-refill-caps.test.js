/**
 * Stale-event refill respects the portfolio caps against the surviving lineup
 * (local-first away cap, owner 2026-11-26).
 */
jest.mock('../models/db', () => jest.fn());
const { refillWithinCaps } = require('../services/newsletter-autopilot');

const ev = (id, region_zone, extra = {}) => ({
  id, region_zone, venue_name: `Venue ${id}`, source_id: `src-${id}`, editorial_score: 80, score_breakdown: { penalty_flags: [] }, ...extra,
});

describe('refillWithinCaps', () => {
  test('a lost local pick is not replaced by a third Tampa Bay event', () => {
    const lineupEvents = [ev('a', 'tampa'), ev('b', 'pinellas'), ev('c', 'sarasota'), ev('d', 'manatee'), ev('e', 'south_sarasota')];
    const lineupAlternates = [ev('alt-away', 'pinellas'), ev('alt-local', 'manatee')];
    const ids = refillWithinCaps({
      safeEventIds: ['a', 'b', 'c', 'd'],
      refillCandidates: ['alt-away', 'alt-local'],
      refillExisting: new Set(['alt-away', 'alt-local']),
      lineupEvents,
      lineupAlternates,
    });
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'alt-local']);
  });

  test('an alternate whose row is gone is skipped', () => {
    const ids = refillWithinCaps({
      safeEventIds: ['c'],
      refillCandidates: ['x'],
      refillExisting: new Set(),
      lineupEvents: [ev('c', 'sarasota')],
      lineupAlternates: [ev('x', 'manatee')],
    });
    expect(ids).toEqual(['c']);
  });
});
