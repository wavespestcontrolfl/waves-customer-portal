// A rescheduled Eventastic post updates its one events_raw row (real PostgreSQL).
// Self-skips without DATABASE_URL. Writes a synthetic, disabled event_sources row
// against the real tables and removes it in afterAll (events_raw cascades).
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;

// Relative dates: the pipeline drops events outside now-24h .. now+90d.
const { etDateString, addETDays } = require('../utils/datetime-et');
const ymd = (daysFromNow) => etDateString(addETDays(new Date(), daysFromNow));

(SKIP ? describe.skip : describe)('eventastic reschedule on real PostgreSQL', () => {
  jest.setTimeout(30000);
  const db = require('../models/db');
  const { upsertExtractedEvents } = require('../services/event-ingestion');
  const { eventasticToExtractedEvents } = require('../services/event-json-adapters');
  let source;

  const post = (meta, title) => ({
    id: 987654,
    title: { rendered: title },
    link: 'https://test.invalid/event/reschedule/',
    excerpt: { rendered: '<p>Test</p>' },
    meta_fields: { eventastic_city: 'Bradenton', eventastic_recurring_days: [], ...meta },
  });

  beforeAll(async () => {
    const [row] = await db('event_sources').insert({
      name: `TEST event-json-reschedule ${randomUUID()}`,
      url: 'https://test.invalid/',
      feed_url: `https://test.invalid/event-json-reschedule/${randomUUID()}`,
      feed_type: 'json',
      enabled: false,
      coverage_geo: '{bradenton}',
    }).returning('id');
    source = { id: row.id || row, coverage_geo: ['bradenton'] };
  });

  afterAll(async () => {
    if (source) await db('event_sources').where({ id: source.id }).del();
    await db.destroy();
  });

  test('moving the date and retitling the post updates the same row', async () => {
    const first = eventasticToExtractedEvents([post({ eventastic_start_date: ymd(10), eventastic_start_time: '6:00 pm' }, 'Harbor Night')]);
    expect((await upsertExtractedEvents(source, first, { trustStableIds: true })).upserted).toBe(1);
    const [original] = await db('events_raw').where({ source_id: source.id });

    const moved = eventasticToExtractedEvents([post({ eventastic_start_date: ymd(17), eventastic_start_time: '7:30 pm' }, 'Harbor Night (new date)')]);
    expect((await upsertExtractedEvents(source, moved, { trustStableIds: true })).upserted).toBe(1);

    const rows = await db('events_raw').where({ source_id: source.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(original.id);
    expect(rows[0].external_id).toBe('wp:987654');
    expect(rows[0].title).toBe('Harbor Night (new date)');
    expect(rows[0].start_at.getTime()).toBeGreaterThan(original.start_at.getTime());
  });

  // Publisher moves an item the pipeline already holds outside the 90-day
  // window, or into the past: the row must follow, not stay eligible under its
  // old date. Items we never held stay dropped when outside the window.
  const trusted = { trustStableIds: true };
  const only = (meta, title, id) => eventasticToExtractedEvents([{ ...post(meta, title), id }]);

  test.each([
    ['past the 90-day window', 200],
    ['into the past', -10],
  ])('a known post rescheduled %s updates its row instead of staying at the old date', async (_label, days) => {
    const id = days > 0 ? 987001 : 987002;
    await upsertExtractedEvents(source, only({ eventastic_start_date: ymd(12), eventastic_start_time: '6:00 pm' }, 'Dock Concert', id), trusted);
    const [original] = await db('events_raw').where({ source_id: source.id, external_id: `wp:${id}` });
    expect(original).toBeDefined();

    const moved = only({ eventastic_start_date: ymd(days), eventastic_start_time: '6:00 pm' }, 'Dock Concert', id);
    const result = await upsertExtractedEvents(source, moved, trusted);
    expect(result).toEqual({ upserted: 1, dropped: 0 });

    const rows = await db('events_raw').where({ source_id: source.id, external_id: `wp:${id}` });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(original.id);
    // The row now carries the publisher's new date, so selection by start_at no longer finds it.
    expect(etDateString(rows[0].start_at)).toBe(ymd(days));
    expect(etDateString(original.start_at)).toBe(ymd(12));
  });

  test('a post we never held that is outside the window is still dropped', async () => {
    const result = await upsertExtractedEvents(source, only({ eventastic_start_date: ymd(200) }, 'Far Future Fair', 987003), trusted);
    expect(result).toEqual({ upserted: 0, dropped: 1 });
    expect(await db('events_raw').where({ source_id: source.id, external_id: 'wp:987003' })).toHaveLength(0);
  });

  test('without the opt-in an externalId is ignored: the row key stays derived', async () => {
    const withId = [{ ...only({ eventastic_start_date: ymd(14), eventastic_start_time: '7:00 pm' }, 'Model Made', 987004)[0], externalId: 'attacker-key' }];
    await upsertExtractedEvents(source, withId);
    expect(await db('events_raw').where({ source_id: source.id, external_id: 'attacker-key' })).toHaveLength(0);
    expect(await db('events_raw').where({ source_id: source.id }).where('external_id', 'like', 'model made|%')).toHaveLength(1);
  });
});
