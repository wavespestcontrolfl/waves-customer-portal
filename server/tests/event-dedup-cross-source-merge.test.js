/**
 * Cross-source event dedup: tolerant matching added for the missed-merge
 * bug (prod, 2026-09-27) — the same real-world happening reported by two
 * feeds with cosmetic differences (punctuation/case in the title, a
 * URL-slug vs a proper-name city, minor formatting in the venue name, and a
 * few minutes' drift in the reported start time) must cluster and be safe
 * to auto-merge; genuinely distinct events (different day, different venue,
 * a real showtime difference) must not.
 *
 * These tests exercise event-duplicates.js's findDuplicateClusters +
 * normalizeEventTitle and event-dedup.js's isAutoMergeableCluster +
 * pickSurvivor directly — no DB. The existing broader test coverage for
 * these two modules lives in newsletter.test.js; this file adds the
 * scenarios named in the newsletter-quality dedup fix without touching
 * that shared file.
 */

const { normalizeEventTitle, findDuplicateClusters } = require('../services/event-duplicates');
const {
  pickSurvivor,
  isAutoMergeableCluster,
  computeSurvivorBackfill,
} = require('../services/event-dedup');

const ev = (o) => ({ image_url: null, event_url: null, pulled_at: null, admin_status: 'pending', ...o });

describe('cross-source dedup: the two-feed soccer case (prod 2026-09-27 shape)', () => {
  // Mirrors the missed-merge report: same happening, two feeds, a
  // punctuation/case variant title, a city recorded as a slug on one side
  // and a proper name on the other, a venue name with cosmetic formatting
  // differences, and a few minutes of start-time drift.
  const feedA = ev({
    id: 'a',
    source_id: 'source-lakewoodranch-com',
    title: 'Sarasota Paradise vs. Greenville Triumph SC',
    start_at: '2026-09-19T23:30:00.000Z',
    city: 'lakewood-ranch',
    venue_name: 'Premier Sports Campus at Lakewood Ranch',
    editorial_score: 70,
  });
  const feedB = ev({
    id: 'b',
    source_id: 'source-sports-aggregator',
    title: 'Sarasota Paradise VS Greenville Triumph SC!',
    start_at: '2026-09-19T23:34:00.000Z', // 4 min drift — different feed, same kickoff
    city: 'Lakewood Ranch',
    venue_name: 'Premier Sports Campus At Lakewood Ranch.',
    editorial_score: 65,
  });

  test('findDuplicateClusters groups the two feeds into one cluster', () => {
    const clusters = findDuplicateClusters([feedA, feedB]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].events.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  test('isAutoMergeableCluster accepts the pair (tolerant title/city/venue formatting, close start times)', () => {
    expect(isAutoMergeableCluster([feedA, feedB])).toBe(true);
  });

  test('the higher-priority-curated row survives even though the pending duplicate scored higher', () => {
    // Real prod shape: both pending, feedA scored higher (70 vs 65) — but if
    // a human had already approved/featured the lower-scored duplicate, that
    // curation must never be lost to the higher-scoring pending row.
    const approvedB = { ...feedB, admin_status: 'approved' };
    const survivor = pickSurvivor([feedA, approvedB]);
    expect(survivor.id).toBe('b');
  });
});

describe('cross-source dedup: normalizeEventTitle already tolerates "vs." vs "vs" vs case vs emoji', () => {
  test('punctuation/case/emoji variants normalize identically', () => {
    const variants = [
      'Sarasota Paradise vs. Greenville Triumph SC',
      'Sarasota Paradise vs Greenville Triumph SC',
      'SARASOTA PARADISE VS GREENVILLE TRIUMPH SC',
      '⚽️ Sarasota Paradise vs. Greenville Triumph SC!!',
    ];
    const normalized = new Set(variants.map(normalizeEventTitle));
    expect(normalized.size).toBe(1);
  });
});

describe('cross-source dedup: conservative boundaries are preserved', () => {
  test('same title, same venue, different ET days does NOT cluster (different performances)', () => {
    const clusters = findDuplicateClusters([
      ev({ id: 'a', title: 'Sarasota Paradise vs. Greenville Triumph SC', start_at: '2026-09-19T23:30:00.000Z', city: 'lakewood-ranch', venue_name: 'Premier Sports Campus at Lakewood Ranch', source_id: 's1' }),
      ev({ id: 'b', title: 'Sarasota Paradise vs. Greenville Triumph SC', start_at: '2026-09-26T23:30:00.000Z', city: 'lakewood-ranch', venue_name: 'Premier Sports Campus at Lakewood Ranch', source_id: 's2' }),
    ]);
    expect(clusters).toHaveLength(0);
  });

  test('a weekly series on different dates does not cluster across those dates', () => {
    const clusters = findDuplicateClusters([
      ev({ id: 'a', title: 'Sarasota Farmers Market', start_at: '2026-09-19T13:00:00.000Z', city: 'sarasota', source_id: 's1' }),
      ev({ id: 'b', title: 'Sarasota Farmers Market', start_at: '2026-09-26T13:00:00.000Z', city: 'sarasota', source_id: 's2' }),
    ]);
    expect(clusters).toHaveLength(0);
  });

  test('same title, same day, DIFFERENT venues does not auto-merge (even with tolerant formatting)', () => {
    const cluster = [
      ev({ id: 'a', title: 'Trivia Night', start_at: '2026-09-19T23:00:00.000Z', city: 'sarasota', venue_name: 'The Blind Tiger', source_id: 's1' }),
      ev({ id: 'b', title: 'Trivia Night', start_at: '2026-09-19T23:05:00.000Z', city: 'sarasota', venue_name: 'Fins at Lido Beach', source_id: 's2' }),
    ];
    // They do cluster (title+day+city match) — manual review, not auto-merge.
    expect(findDuplicateClusters(cluster)).toHaveLength(1);
    expect(isAutoMergeableCluster(cluster)).toBe(false);
  });

  test('a genuine matinee-vs-evening showing (same venue, hours apart) does not auto-merge', () => {
    const cluster = [
      ev({ id: 'a', title: 'The Nutcracker', start_at: '2026-12-10T19:00:00.000Z', city: 'sarasota', venue_name: 'Van Wezel', source_id: 's1' }),
      ev({ id: 'b', title: 'The Nutcracker', start_at: '2026-12-10T23:00:00.000Z', city: 'sarasota', venue_name: 'Van Wezel', source_id: 's2' }),
    ];
    expect(isAutoMergeableCluster(cluster)).toBe(false);
  });

  test('blank venue on either side still blocks auto-merge', () => {
    const cluster = [
      ev({ id: 'a', title: 'Community Cleanup', start_at: '2026-09-19T13:00:00.000Z', city: 'venice', venue_name: null, source_id: 's1' }),
      ev({ id: 'b', title: 'Community Cleanup', start_at: '2026-09-19T13:05:00.000Z', city: 'venice', venue_name: 'City Park', source_id: 's2' }),
    ];
    expect(isAutoMergeableCluster(cluster)).toBe(false);
  });

  test('a date-only (ET-midnight) row is not auto-merged with a timed row, so the real start time is never suppressed', () => {
    const cluster = [
      ev({ id: 'a', title: 'Sarasota Paradise vs. Greenville Triumph SC', start_at: '2026-09-19T04:00:00.000Z', city: 'lakewood-ranch', venue_name: 'Premier Sports Campus at Lakewood Ranch', source_id: 's1' }), // ET midnight
      ev({ id: 'b', title: 'Sarasota Paradise vs. Greenville Triumph SC', start_at: '2026-09-19T23:30:00.000Z', city: 'lakewood-ranch', venue_name: 'Premier Sports Campus at Lakewood Ranch', source_id: 's2' }),
    ];
    expect(isAutoMergeableCluster(cluster)).toBe(false);
  });
});

describe('cross-source dedup: full auto-merge decision keeps digest-required fields and curation', () => {
  test('backfill still carries event_url onto the survivor when the cluster auto-merges on tolerant matching', () => {
    const survivor = ev({ id: 'a', title: 'Sarasota Paradise vs. Greenville Triumph SC', start_at: '2026-09-19T23:30:00.000Z', city: 'lakewood-ranch', venue_name: 'Premier Sports Campus at Lakewood Ranch', source_id: 's1', event_url: null, admin_status: 'approved' });
    const loser = ev({ id: 'b', title: 'Sarasota Paradise VS Greenville Triumph SC', start_at: '2026-09-19T23:34:00.000Z', city: 'Lakewood Ranch', venue_name: 'Premier Sports Campus At Lakewood Ranch.', source_id: 's2', event_url: 'https://example.com/e' });
    const cluster = [survivor, loser];
    expect(isAutoMergeableCluster(cluster)).toBe(true);
    expect(pickSurvivor(cluster).id).toBe('a'); // approved beats pending regardless of completeness
    expect(computeSurvivorBackfill(survivor, [loser])).toEqual({ event_url: 'https://example.com/e' });
  });
});

describe('cross-source dedup: half-hour-apart sessions stay distinct', () => {
  test('10:00 and 10:30 sessions of the same program at one venue are not auto-merged', () => {
    const cluster = [
      ev({ id: 'a', title: 'Toddler Tide Pool Tour', start_at: '2026-10-10T14:00:00.000Z', city: 'sarasota', venue_name: 'Bayfront Aquarium', source_id: 's1' }),
      ev({ id: 'b', title: 'Toddler Tide Pool Tour', start_at: '2026-10-10T14:30:00.000Z', city: 'sarasota', venue_name: 'Bayfront Aquarium', source_id: 's2' }),
    ];
    expect(isAutoMergeableCluster(cluster)).toBe(false);
  });
});
