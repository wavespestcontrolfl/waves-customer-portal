const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { attributionForSourceType } = require('../services/ads/call-attribution');
const { _private: { sourceEvidence } } = require('../services/call-log-analytics');
const migration = require('../models/migrations/20261123170000_google_lsa_line_source');
const retire = require('../models/migrations/20261124000000_google_lsa_line_retire');

const LSA = '+19412135010'; // released Google Local Services line (Bradenton)

describe('Google LSA line released (owner 2026-11-23)', () => {
  // Google forbids a tracking number as the Local Services business phone
  // (support.google.com/localservices/answer/7435507), so the line was released.
  test('the registry no longer carries the line', () => {
    expect(TWILIO_NUMBERS.paidTracking.googleLsa).toBeUndefined();
    expect(TWILIO_NUMBERS.findByNumber(LSA)).toBeNull();
    expect(TWILIO_NUMBERS.getLeadSourceFromNumber(LSA).source).toBe('unknown');
  });

  test('a call the line already recorded keeps the Google LSA label', () => {
    expect(sourceEvidence({ to_phone: LSA, metadata: { numberType: 'google_lsa' } })).toMatchObject({ kind: 'google_ads', label: 'Google LSA' });
  });

  test('the funnel still maps source_type google_lsa to the paid channel', () => {
    expect(attributionForSourceType('google_lsa')).toEqual({ leadSource: 'google_lsa', isPaid: true });
  });
});

describe('20261123170000_google_lsa_line_source', () => {
  function fakeKnex({ existing = null, hasTable = true } = {}) {
    const inserts = [];
    const knex = (table) => ({
      whereIn: (col, vals) => ({ first: async () => { knex.lookups.push({ table, col, vals }); return existing; } }),
      insert: async (row) => { inserts.push({ table, row }); },
    });
    knex.schema = { hasTable: async () => hasTable };
    knex.lookups = [];
    knex.inserts = inserts;
    return knex;
  }

  test('inserts the paid google_lsa row when no row holds the number', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex.lookups[0].vals).toEqual(expect.arrayContaining([LSA, '9412135010', '19412135010', '(941) 213-5010']));
    expect(knex.inserts).toHaveLength(1);
    expect(knex.inserts[0].row).toMatchObject({ source_type: 'google_lsa', channel: 'paid', twilio_phone_number: LSA, is_active: true });
  });

  test('leaves an existing row alone', async () => {
    const knex = fakeKnex({ existing: { id: 'x' } });
    await migration.up(knex);
    expect(knex.inserts).toHaveLength(0);
  });

  test('down never deletes', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});

describe('20261124000000_google_lsa_line_retire', () => {
  function fakeKnex({ hasTable = true } = {}) {
    const calls = [];
    const knex = (table) => {
      const q = { table, wheres: [] };
      calls.push(q);
      const chain = {
        whereIn: (col, vals) => { q.wheres.push({ col, vals }); return chain; },
        where: (w) => { q.wheres.push(w); return chain; },
        update: async (patch) => { q.patch = patch; return 1; },
      };
      return chain;
    };
    knex.schema = { hasTable: async () => hasTable };
    knex.fn = { now: () => 'NOW' };
    knex.calls = calls;
    return knex;
  }

  test('turns only the active google_lsa row for the number off, and keeps it', async () => {
    const knex = fakeKnex();
    await retire.up(knex);
    expect(knex.calls).toHaveLength(1);
    const [q] = knex.calls;
    expect(q.table).toBe('lead_sources');
    expect(q.wheres).toEqual(expect.arrayContaining([
      { col: 'twilio_phone_number', vals: expect.arrayContaining([LSA, '9412135010']) },
      { source_type: 'google_lsa', is_active: true },
    ]));
    expect(q.patch).toEqual({ is_active: false, updated_at: 'NOW' });
  });

  test('no table, no write; down never writes', async () => {
    const knex = fakeKnex({ hasTable: false });
    await retire.up(knex);
    expect(knex.calls).toHaveLength(0);
    await expect(retire.down()).resolves.toBeUndefined();
  });
});
