/**
 * Scrape/news-RSS Claude-extraction datetime handling (prod bug, found
 * 2026-09-27): 13 of 14 near-duplicate `events_raw` pairs from the same
 * source/title/url/ET-day differed by EXACTLY 4 hours because
 * normalizeExtractedEvent parsed Claude's `startAt` with a bare
 * `new Date()` — a naive "YYYY-MM-DDTHH:MM:SS" string (no offset/Z) was
 * read as SERVER-local time (Railway runs TZ=UTC), silently dropping the
 * ET→UTC offset. Root cause + prod evidence: parseExtractedStartAt's own
 * header comment in server/services/event-ingestion.js.
 *
 * These tests cover:
 *   1. parseExtractedStartAt: naive vs offset-bearing strings across an
 *      EDT date and an EST date (the DST boundary) land on the SAME
 *      correct instant.
 *   2. extractedEventDedupKeys: the new key is stable across a "drifted"
 *      re-pull (naive vs offset-bearing extraction of the identical
 *      advertised time) — the exact scenario that minted the 13 prod
 *      duplicate pairs — so a post-fix re-pull upserts the SAME row.
 *   3. Two genuinely distinct same-day showtimes at the same URL still
 *      get distinct keys.
 *   4. The legacy (pre-fix) key shape is still computed, for the
 *      upsert's key-shape-migration lookup.
 *
 * See event-ingestion-legacy-key-migration-postgres.test.js for the
 * DB-backed test of the actual upsert migrating a legacy-keyed row.
 */

const {
  parseExtractedStartAt,
  extractedEventDedupKeys,
  normalizeExtractedEvent,
} = require('../services/event-ingestion');

describe('parseExtractedStartAt — ET wall-clock parsing for Claude-extracted startAt', () => {
  test('a naive (no offset) ET wall-clock string and an explicit-offset string agree, in EDT', () => {
    // 2026-09-19 is in EDT (UTC-4). A 7:30pm ET kickoff — the Lakewood
    // Ranch prod example — must land on 23:30Z either way Claude phrases it.
    const naive = parseExtractedStartAt('2026-09-19T19:30:00');
    const offset = parseExtractedStartAt('2026-09-19T19:30:00-04:00');
    expect(naive.toISOString()).toBe('2026-09-19T23:30:00.000Z');
    expect(offset.toISOString()).toBe('2026-09-19T23:30:00.000Z');
    expect(naive.getTime()).toBe(offset.getTime());
  });

  test('a naive ET wall-clock string and an explicit-offset string agree, in EST (DST boundary)', () => {
    // 2026-01-15 is in EST (UTC-5) — the other side of the fall-back
    // transition from the EDT case above. A 9am ET class must land on
    // 14:00Z either way.
    const naive = parseExtractedStartAt('2026-01-15T09:00:00');
    const offset = parseExtractedStartAt('2026-01-15T09:00:00-05:00');
    expect(naive.toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(offset.toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(naive.getTime()).toBe(offset.getTime());
  });

  test('a wall clock inside a DST change is rejected rather than guessed', () => {
    // 2026-03-08 02:30 ET never happens (clocks jump 2:00 → 3:00 EDT), and
    // 2026-11-01 01:30 ET happens twice (EDT, then EST an hour later).
    expect(parseExtractedStartAt('2026-03-08T02:30:00')).toBeNull();
    expect(parseExtractedStartAt('2026-11-01T01:30:00')).toBeNull();
    expect(parseExtractedStartAt('2026-11-01 01:00')).toBeNull();
    // Either side of each change is a single instant and still parses.
    expect(parseExtractedStartAt('2026-03-08T01:59').toISOString()).toBe('2026-03-08T06:59:00.000Z');
    expect(parseExtractedStartAt('2026-03-08T03:00').toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(parseExtractedStartAt('2026-11-01T00:59').toISOString()).toBe('2026-11-01T04:59:00.000Z');
    expect(parseExtractedStartAt('2026-11-01T02:00').toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(parseExtractedStartAt('2026-11-01').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    // An explicit offset is never ambiguous.
    expect(parseExtractedStartAt('2026-11-01T01:30:00-05:00').toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });

  test('null/blank/garbled input returns null, same as before', () => {
    expect(parseExtractedStartAt(null)).toBeNull();
    expect(parseExtractedStartAt('')).toBeNull();
    expect(parseExtractedStartAt('not a date')).toBeNull();
    expect(parseExtractedStartAt(undefined)).toBeNull();
  });

  test('an impossible date or time is rejected instead of rolling forward to a later day', () => {
    for (const raw of [
      '2026-09-19T99:00:00', '2026-09-19 24:00', '2026-09-19T19:60', '2026-02-30', '2026-13-01T10:00',
      '2026-09-19T99:00:00-04:00', '2026-02-30T10:00:00-05:00', '2026-09-19T24:00:00Z',
    ]) {
      expect(parseExtractedStartAt(raw)).toBeNull();
    }
    expect(parseExtractedStartAt('2028-02-29T10:00').toISOString()).toBe('2028-02-29T15:00:00.000Z');
  });

  test('fractional seconds are kept to the millisecond, as the old parser kept them', () => {
    expect(parseExtractedStartAt('2026-09-19T19:30:45.123').toISOString()).toBe('2026-09-19T23:30:45.123Z');
    expect(parseExtractedStartAt('2026-09-19T19:30:45.5').toISOString()).toBe('2026-09-19T23:30:45.500Z');
    expect(parseExtractedStartAt('2026-09-19T19:30:45.1239').toISOString()).toBe('2026-09-19T23:30:45.123Z');
  });

  test('a trailing Z is honored as UTC, not re-interpreted as ET', () => {
    const d = parseExtractedStartAt('2026-06-01T12:00:00Z');
    expect(d.toISOString()).toBe('2026-06-01T12:00:00.000Z');
  });
});

describe('extractedEventDedupKeys — stable dedup key across TZ-format drift', () => {
  test('naive vs offset-bearing extraction of the SAME advertised time yield the SAME key (the prod duplicate scenario, now fixed)', () => {
    // This is exactly the "Sarasota Paradise vs. Greenville Triumph SC"
    // case: one pull's Claude response omitted the offset, the next
    // pull's included it. Both must now upsert the SAME row.
    const naiveStart = parseExtractedStartAt('2026-09-19T19:30:00');
    const offsetStart = parseExtractedStartAt('2026-09-19T19:30:00-04:00');
    const url = 'https://lakewoodranch.com/event/sarasota-paradise-vs-greenville-triumph-sc/';
    const a = extractedEventDedupKeys('Sarasota Paradise vs. Greenville Triumph SC', naiveStart, url);
    const b = extractedEventDedupKeys('Sarasota Paradise vs. Greenville Triumph SC', offsetStart, url);
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId).toBe('sarasota paradise vs. greenville triumph sc|2026-09-19T19:30|' + url);
  });

  test('two distinct same-day showtimes at the same URL get distinct keys', () => {
    const url = 'https://example.com/event/the-show/';
    const matinee = extractedEventDedupKeys('The Show', parseExtractedStartAt('2026-10-10T14:00:00-04:00'), url);
    const evening = extractedEventDedupKeys('The Show', parseExtractedStartAt('2026-10-10T19:30:00-04:00'), url);
    expect(matinee.externalId).not.toBe(evening.externalId);
  });

  test('the legacy (pre-fix) key is the old full-UTC-instant shape', () => {
    const start = parseExtractedStartAt('2026-06-14T10:00:00-04:00');
    const { legacyExternalId } = extractedEventDedupKeys('Boat Parade', start, 'https://x.co/parade');
    expect(legacyExternalId).toBe(`boat parade|${start.toISOString()}|https://x.co/parade`);
  });

  test('every naive form reads as Eastern; free text is rejected', () => {
    expect(parseExtractedStartAt('2026-09-19 19:30:00').toISOString()).toBe('2026-09-19T23:30:00.000Z');
    expect(parseExtractedStartAt('2026-09-19T19:30').toISOString()).toBe('2026-09-19T23:30:00.000Z');
    expect(parseExtractedStartAt('2026-12-19 19:30').toISOString()).toBe('2026-12-20T00:30:00.000Z');
    expect(parseExtractedStartAt('2026-09-19').toISOString()).toBe('2026-09-19T04:00:00.000Z');
    expect(parseExtractedStartAt('2026-09-19 19:30:00+00:00').toISOString()).toBe('2026-09-19T19:30:00.000Z');
    expect(parseExtractedStartAt('September 19, 2026 7:30 PM')).toBeNull();
  });

  test('a null start produces an empty startKey segment in both shapes (undated events)', () => {
    const { externalId, legacyExternalId } = extractedEventDedupKeys('Ongoing Market', null, '');
    expect(externalId).toBe('ongoing market||');
    expect(legacyExternalId).toBe('ongoing market||');
  });
});

describe('normalizeExtractedEvent — end-to-end key stability through the public function', () => {
  const source = { id: 'src-lwr', priority_tier: 2, coverage_geo: ['lakewood-ranch'] };
  const NOW = Date.parse('2026-09-01T12:00:00Z');

  test('a naive-startAt pull and an offset-startAt pull for the same event produce the SAME external_id and the SAME (correct) start_at', () => {
    const url = 'https://lakewoodranch.com/event/sarasota-paradise-vs-greenville-triumph-sc/';
    const naivePull = normalizeExtractedEvent(source, {
      title: 'Sarasota Paradise vs. Greenville Triumph SC',
      startAt: '2026-09-19T19:30:00',
      eventUrl: url,
    }, NOW);
    const offsetPull = normalizeExtractedEvent(source, {
      title: 'Sarasota Paradise vs. Greenville Triumph SC',
      startAt: '2026-09-19T19:30:00-04:00',
      eventUrl: url,
    }, NOW);
    expect(naivePull.row.external_id).toBe(offsetPull.row.external_id);
    expect(naivePull.row.start_at.toISOString()).toBe('2026-09-19T23:30:00.000Z');
    expect(offsetPull.row.start_at.toISOString()).toBe('2026-09-19T23:30:00.000Z');
  });
});
