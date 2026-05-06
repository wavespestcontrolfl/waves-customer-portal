const db = require('../models/db');
const trackingRouter = require('../routes/tracking');

describe('canonical customer tracker query', () => {
  const build = trackingRouter._test.buildCanonicalScheduledServiceQuery;

  test('/active scope excludes future scheduled trackers', () => {
    const { sql, bindings } = build(db, 'cust-1', {
      activeOnly: true,
      today: '2026-05-05',
      nowIso: '2026-05-05T12:00:00.000Z',
    }).toSQL();

    expect(sql).toMatch(/"track_token_expires_at" >=/);
    expect(sql).toMatch(/"track_state" in \((?:\?, ){1}\?\)/);
    expect(sql).toMatch(/"scheduled_date" = \?/);
    expect(bindings).toEqual(expect.arrayContaining([
      'cust-1',
      '2026-05-05T12:00:00.000Z',
      'en_route',
      'on_property',
      'scheduled',
      'complete',
      'cancelled',
      '2026-05-05',
    ]));
  });

  test('/today scope permits today scheduled trackers', () => {
    const { sql, bindings } = build(db, 'cust-2', {
      todayOnly: true,
      today: '2026-05-05',
      nowIso: '2026-05-05T12:00:00.000Z',
    }).toSQL();

    expect(sql).toMatch(/"track_state" in \((?:\?, ){2}\?\)/);
    expect(sql).toMatch(/or (?:".+"\.)?"track_state" in \(\?, \?\)/);
    expect(sql).toMatch(/"scheduled_date" = \?/);
    expect(bindings).toEqual(expect.arrayContaining([
      'cust-2',
      'scheduled',
      'en_route',
      'on_property',
      'complete',
      'cancelled',
      '2026-05-05',
    ]));
  });
});
