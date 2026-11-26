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
    expect((await upsertExtractedEvents(source, first)).upserted).toBe(1);
    const [original] = await db('events_raw').where({ source_id: source.id });

    const moved = eventasticToExtractedEvents([post({ eventastic_start_date: ymd(17), eventastic_start_time: '7:30 pm' }, 'Harbor Night (new date)')]);
    expect((await upsertExtractedEvents(source, moved)).upserted).toBe(1);

    const rows = await db('events_raw').where({ source_id: source.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(original.id);
    expect(rows[0].external_id).toBe('wp:987654');
    expect(rows[0].title).toBe('Harbor Night (new date)');
    expect(rows[0].start_at.getTime()).toBeGreaterThan(original.start_at.getTime());
  });
});
