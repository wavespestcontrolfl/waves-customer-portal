// Eventastic WP REST items -> extracted events. Fixtures are trimmed copies of
// the public bradentongulfislands.com /wp-json/wp/v2/event response (2026-11-26).
const { eventasticToExtractedEvents, eventasticItemToExtractedEvent } = require('../services/event-json-adapters');
const { normalizeExtractedEvent } = require('../services/event-ingestion');

const item = (meta, extra = {}) => ({
  title: { rendered: 'Christmas in Cortez' },
  link: 'https://www.bradentongulfislands.com/event/christmas-in-cortez/',
  excerpt: { rendered: '<p>Cortez&#8217;s village &amp; fishing festival&#8230;</p>\n' },
  thumb_url: 'https://www.bradentongulfislands.com/wp-content/uploads/cortez.jpg',
  venue_name: false,
  meta_fields: {
    eventastic_start_date: '2026-12-12',
    eventastic_start_time: '10:00 am',
    eventastic_recurring_days: [],
    eventastic_recurring_repeat: '',
    eventastic_addr1: '4415 119th Street West',
    eventastic_city: 'Cortez',
    ...meta,
  },
  ...extra,
});

describe('eventastic adapter', () => {
  test('maps a one-off event: ET wall clock, decoded text, city, street venue, page link', () => {
    expect(eventasticItemToExtractedEvent(item())).toEqual({
      title: 'Christmas in Cortez',
      startAt: '2026-12-12T10:00:00',
      venueName: '4415 119th Street West',
      city: 'Cortez',
      description: 'Cortez’s village & fishing festival…',
      eventUrl: 'https://www.bradentongulfislands.com/event/christmas-in-cortez/',
      imageUrl: 'https://www.bradentongulfislands.com/wp-content/uploads/cortez.jpg',
    });
  });

  test.each([
    ['4:00 pm', '16:00'], ['12:00 pm', '12:00'], ['12:30 am', '00:30'], ['9:05 AM', '09:05'], ['18:45', '18:45'],
  ])('reads start time %s as %s', (raw, hhmm) => {
    expect(eventasticItemToExtractedEvent(item({ eventastic_start_time: raw })).startAt).toBe(`2026-12-12T${hhmm}:00`);
  });

  test.each(['', '   ', 'TBD', '13:00 pm', '10:75 am'])('no usable start time %j falls back to the bare date', (raw) => {
    expect(eventasticItemToExtractedEvent(item({ eventastic_start_time: raw })).startAt).toBe('2026-12-12');
  });

  test('prefers the venue term name over the street address', () => {
    const ev = eventasticItemToExtractedEvent(item({}, { venue_name: [{ name: 'Premier Sports Campus' }] }));
    expect(ev.venueName).toBe('Premier Sports Campus');
  });

  test('skips recurring series and items without a usable start date', () => {
    expect(eventasticItemToExtractedEvent(item({ eventastic_recurring_days: ['Friday'] }))).toBeNull();
    expect(eventasticItemToExtractedEvent(item({ eventastic_recurring_repeat: '3' }))).toBeNull();
    expect(eventasticItemToExtractedEvent(item({ eventastic_start_date: '' }))).toBeNull();
    expect(eventasticItemToExtractedEvent(item({ eventastic_start_date: 'Dec 12' }))).toBeNull();
    expect(eventasticItemToExtractedEvent(item({ eventastic_start_date: '2026-02-30' }))).toBeNull();
    expect(eventasticItemToExtractedEvent(item({}, { title: { rendered: '' } }))).toBeNull();
    expect(eventasticItemToExtractedEvent({ title: { rendered: 'No meta' } })).toBeNull();
  });

  test('a non-array body is a pull failure, not zero events', () => {
    expect(() => eventasticToExtractedEvents({ code: 'rest_no_route' })).toThrow(/not a JSON array/);
    expect(eventasticToExtractedEvents([item(), item({ eventastic_recurring_days: ['Friday'] })])).toHaveLength(1);
  });

  test('output passes the shared normalizer: ET instant, lowercased city, falls back to coverage_geo', () => {
    const source = { id: 's1', coverage_geo: ['bradenton'] };
    const nowMs = Date.parse('2026-11-26T12:00:00Z');
    const row = normalizeExtractedEvent(source, eventasticItemToExtractedEvent(item()), nowMs).row;
    expect(row.start_at.toISOString()).toBe('2026-12-12T15:00:00.000Z'); // 10:00 EST
    expect(row.city).toBe('cortez');
    const noCity = eventasticItemToExtractedEvent(item({ eventastic_city: '' }));
    expect(normalizeExtractedEvent(source, noCity, nowMs).row.city).toBe('bradenton');
  });
});
