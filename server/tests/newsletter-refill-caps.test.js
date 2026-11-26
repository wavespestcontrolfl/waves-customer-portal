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
    const refillPool = [ev('alt-away', 'pinellas'), ev('alt-away-2', 'tampa'), ev('pool-local', 'manatee')];
    const ids = refillWithinCaps({
      safeEventIds: ['a', 'b', 'c', 'd'],
      refillPool,
      refillExisting: new Set(['alt-away', 'alt-away-2', 'pool-local']),
      lineupEvents,
    });
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'pool-local']);
  });

  test('an alternate whose row is gone is skipped', () => {
    const ids = refillWithinCaps({
      safeEventIds: ['c'],
      refillPool: [ev('x', 'manatee')],
      refillExisting: new Set(),
      lineupEvents: [ev('c', 'sarasota')],
    });
    expect(ids).toEqual(['c']);
  });

  test('competing caps: the refill finds the fuller lineup a greedy pick would miss', () => {
    const lineupEvents = [
      ev('s1', 'tampa', { source_id: 'X', editorial_score: 95 }),
      ev('s2', 'sarasota', { source_id: 'A' }),
      ev('s3', 'manatee', { source_id: 'Y' }),
    ];
    const refillPool = [
      ev('p1', 'pinellas', { source_id: 'A', editorial_score: 84 }),
      ev('p2', 'pinellas', { source_id: 'B', editorial_score: 83 }),
      ev('p3', 'south_sarasota', { source_id: 'A', editorial_score: 82 }),
    ];
    const ids = refillWithinCaps({
      safeEventIds: ['s1', 's2', 's3'],
      refillPool,
      refillExisting: new Set(['p1', 'p2', 'p3']),
      lineupEvents,
    });
    expect(ids).toHaveLength(5);
    expect(ids).toEqual(expect.arrayContaining(['s1', 's2', 's3', 'p2', 'p3']));
  });
});
