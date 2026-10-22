/**
 * GATE_NEWSLETTER_CLICK_BOUND: the URL freeze and the image side effects
 * compile to valid knex SQL (no stray named bindings from casts), and the
 * freeze keys on send history as well as admin_status.
 */

const { eventUrlMergeValue, revivalResetFields } = require('../services/event-ingestion');

afterEach(() => { delete process.env.GATE_NEWSLETTER_CLICK_BOUND; });

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_NEWSLETTER_CLICK_BOUND = 'true'; });

  test('event_url merge keeps the stored URL for approved, featured or ever-sent events', () => {
    const { sql, bindings } = eventUrlMergeValue('https://venue.example/new').toSQL();
    expect(sql).toContain("events_raw.admin_status IN ('approved', 'featured')");
    expect(sql).toContain('jsonb_exists(ns.event_ids, CAST(events_raw.id AS text))');
    expect(sql).toContain('alternate_event_ids');
    expect(bindings).toEqual(['https://venue.example/new']);
  });

  test('image fields compare against the effective merged URL and keep the paired image', () => {
    const f = revivalResetFields();
    for (const col of ['image_url', 'image_backfill_attempted_at']) {
      const { sql, bindings } = f[col].toSQL();
      expect(sql).toContain('THEN events_raw.event_url ELSE EXCLUDED.event_url END');
      expect(sql).not.toMatch(/:jsonb|:text/);
      expect(bindings.every((b) => b instanceof Date || typeof b === 'string')).toBe(true);
    }
    expect(f.image_url.toSQL().sql).toContain('IS DISTINCT FROM EXCLUDED.event_url THEN events_raw.image_url');
  });
});

test('gate off: the image fields compare against EXCLUDED.event_url exactly as before', () => {
  const { sql } = revivalResetFields().image_url.toSQL();
  expect(sql).toContain('events_raw.event_url IS DISTINCT FROM EXCLUDED.event_url) THEN EXCLUDED.image_url');
  expect(sql).not.toContain('newsletter_sends');
});
