const migration = require('../models/migrations/20260927130000_add_venue_event_sources');

function knexStub({ hasTable = true } = {}) {
  const inserted = [];
  const deleted = [];
  let insertPayload = null;

  const builder = {
    insert(rows) {
      insertPayload = rows;
      inserted.push(...rows);
      return builder;
    },
    onConflict() {
      return builder;
    },
    ignore() {
      return Promise.resolve();
    },
    whereIn(col, values) {
      deleted.push({ col, values });
      return builder;
    },
    del() {
      return Promise.resolve(deleted.length);
    },
  };

  const knex = jest.fn(() => builder);
  knex.schema = { hasTable: jest.fn(async () => hasTable) };
  return { knex, inserted, deleted, getInsertPayload: () => insertPayload };
}

describe('add venue event sources migration', () => {
  test('inserts exactly the 6 new venue sources with onConflict(feed_url).ignore()', async () => {
    const { knex, inserted } = knexStub();

    await migration.up(knex);

    expect(inserted).toHaveLength(6);
    const names = inserted.map((r) => r.name);
    expect(names).toEqual([
      'Benchmark International Arena — Events',
      'The Dalí Museum — Events',
      'Venice Performing Arts Center — Events',
      'Yuengling Center — Events',
      'Ruth Eckerd Hall — Events',
      'The Mahaffey Theater — Shows',
    ]);
  });

  test('every row is enabled by default, tier 1, and carries a non-empty coverage_geo', async () => {
    const { knex, inserted } = knexStub();
    await migration.up(knex);

    for (const row of inserted) {
      expect(row.priority_tier).toBe(1);
      expect(row.enabled).not.toBe(false);
      expect(typeof row.coverage_geo).toBe('string');
      expect(row.coverage_geo).toMatch(/^\{[a-z0-9-]+(,[a-z0-9-]+)*\}$/);
    }
  });

  test('ical rows carry no scrape_config; scrape rows carry a verified contentSelector', async () => {
    const { knex, inserted } = knexStub();
    await migration.up(knex);

    const byName = Object.fromEntries(inserted.map((r) => [r.name, r]));

    expect(byName['Benchmark International Arena — Events'].feed_type).toBe('ical');
    expect(byName['Benchmark International Arena — Events'].scrape_config).toBeUndefined();
    expect(byName['The Dalí Museum — Events'].feed_type).toBe('ical');
    expect(byName['Venice Performing Arts Center — Events'].feed_type).toBe('ical');
    expect(byName['Yuengling Center — Events'].feed_type).toBe('ical');

    const reh = byName['Ruth Eckerd Hall — Events'];
    expect(reh.feed_type).toBe('scrape');
    expect(JSON.parse(reh.scrape_config)).toEqual({
      contentSelector: '.eventList.event_list_grid',
      maxHtmlChars: 60000,
      maxEvents: 20,
    });

    const mahaffey = byName['The Mahaffey Theater — Shows'];
    expect(mahaffey.feed_type).toBe('scrape');
    expect(JSON.parse(mahaffey.scrape_config)).toEqual({
      contentSelector: '.vc_grid-container',
      maxHtmlChars: 60000,
      maxEvents: 20,
    });
  });

  test('every feed_url is unique (no accidental duplicate insert)', async () => {
    const { knex, inserted } = knexStub();
    await migration.up(knex);

    const feedUrls = inserted.map((r) => r.feed_url);
    expect(new Set(feedUrls).size).toBe(feedUrls.length);
  });

  test('no-ops when event_sources does not exist', async () => {
    const { knex, inserted } = knexStub({ hasTable: false });

    await migration.up(knex);

    expect(inserted).toHaveLength(0);
    expect(knex).not.toHaveBeenCalled();
  });

  test('down is a no-op and never deletes sources (rows may predate this migration)', async () => {
    const { knex, deleted } = knexStub();

    await migration.down(knex);

    expect(deleted).toHaveLength(0);
    expect(knex).not.toHaveBeenCalled();
  });
});
