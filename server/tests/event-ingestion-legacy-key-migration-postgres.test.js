/**
 * upsertExtractedEvents' legacy-key migration, against a real PostgreSQL
 * connection: changing the scrape/news-RSS dedup key shape (full UTC
 * instant → ET calendar day + ET wall-clock time, see
 * extractedEventDedupKeys in server/services/event-ingestion.js) must NOT
 * mint a duplicate row purely from the key-format change. A row already
 * stored under the OLD key shape for the identical title+start+url is
 * renamed onto the new shape before the insert/merge, so the SAME row is
 * updated in place (id + created_at preserved) instead of a sibling being
 * inserted.
 *
 * DB-backed, self-skips without DATABASE_URL (same convention as
 * accept-path-service-identity.test.js). upsertExtractedEvents reads the
 * shared db singleton directly (no injectable connection), so this writes
 * a fully synthetic, uniquely-named event_sources row (and its cascaded
 * events_raw rows) against the REAL tables rather than an isolated schema
 * — cleaned up in afterAll regardless of pass/fail. No customer data is
 * touched; event_sources/events_raw carry no PII.
 */

const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('upsertExtractedEvents — legacy dedup-key migration on real PostgreSQL', () => {
  jest.setTimeout(30000);

  const db = require('../models/db');
  const { upsertExtractedEvents, extractedEventDedupKeys, parseExtractedStartAt } = require('../services/event-ingestion');

  const feedUrl = `https://test.invalid/event-ingestion-tz-migration/${randomUUID()}`;
  let sourceId;

  beforeAll(async () => {
    const [row] = await db('event_sources').insert({
      name: `TEST event-ingestion-tz-migration ${randomUUID()}`,
      url: 'https://test.invalid/',
      feed_url: feedUrl,
      feed_type: 'scrape',
      enabled: false, // never picked up by the real cron
      coverage_geo: '{}', // pg text[] literal, same convention as the seed migration
    }).returning('id');
    sourceId = row.id || row;
  });

  afterAll(async () => {
    if (sourceId) {
      // CASCADE (migration 20260427000003) removes the events_raw rows too.
      await db('event_sources').where({ id: sourceId }).del();
    }
    await db.destroy();
  });

  test('a legacy-shaped row is renamed onto the new key and updated in place, not duplicated', async () => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = 'TEST Legacy Key Migration Event';
    const url = 'https://test.invalid/legacy-migration-event/';
    const start = parseExtractedStartAt('2026-11-05T18:00:00-05:00'); // EST
    const { externalId: newKey, legacyExternalId: legacyKey } = extractedEventDedupKeys(title, start, url);
    expect(newKey).not.toBe(legacyKey); // the two shapes really do differ

    // Seed a row under the OLD (pre-fix) key shape, as if pulled before
    // this change shipped, with a distinguishing description so the test
    // can prove the SAME row was updated (not a fresh insert).
    const [seeded] = await db('events_raw').insert({
      source_id: sourceId,
      external_id: legacyKey,
      title,
      description: 'seeded under the legacy key shape',
      start_at: start,
      event_url: url,
    }).returning(['id', 'created_at']);

    // Re-run the extraction path as if this were the next scheduled pull —
    // this is what a source cron does after the fix ships, with Claude
    // extracting the identical event.
    const { upserted, dropped } = await upsertExtractedEvents(source, [
      { title, startAt: '2026-11-05T18:00:00-05:00', eventUrl: url, description: 'updated on re-pull' },
    ]);
    expect(upserted).toBe(1);
    expect(dropped).toBe(0);

    const rows = await db('events_raw').where({ source_id: sourceId });
    expect(rows).toHaveLength(1); // no duplicate minted
    expect(rows[0].id).toBe(seeded.id); // the SAME row, renamed in place
    expect(rows[0].external_id).toBe(newKey);
    expect(rows[0].description).toBe('updated on re-pull');
  });

  test('with no legacy row present, a fresh pull inserts once under the new key', async () => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = 'TEST Fresh Pull Event';
    const url = 'https://test.invalid/fresh-pull-event/';

    const first = await upsertExtractedEvents(source, [
      { title, startAt: '2026-11-06T09:00:00-05:00', eventUrl: url },
    ]);
    expect(first.upserted).toBe(1);

    const second = await upsertExtractedEvents(source, [
      { title, startAt: '2026-11-06T09:00:00-05:00', eventUrl: url },
    ]);
    expect(second.upserted).toBe(1);

    const rows = await db('events_raw').where({ source_id: sourceId, title });
    expect(rows).toHaveLength(1);
  });
});
