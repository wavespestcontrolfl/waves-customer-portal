const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { _private: { sourceEvidence } } = require('../services/call-log-analytics');
const { attributionForSourceType } = require('../services/ads/call-attribution');
const migration = require('../models/migrations/20261123170000_google_lsa_line_source');

const LSA = '+19412135010'; // Google Local Services profile line (Bradenton)

describe('Google LSA call tracking number', () => {
  test('googleLsa is registered as a paid google_lsa line in Bradenton', () => {
    const line = TWILIO_NUMBERS.paidTracking.googleLsa;
    expect(line).toMatchObject({ number: LSA, source: 'google_lsa', location: 'bradenton' });
  });

  test('findByNumber tags the line as type google_lsa', () => {
    expect(TWILIO_NUMBERS.findByNumber(LSA)).toMatchObject({ type: 'google_lsa', trackingId: 'googleLsa', locationId: 'bradenton' });
  });

  test('getLeadSourceFromNumber and the funnel map both give google_lsa (paid)', () => {
    expect(TWILIO_NUMBERS.getLeadSourceFromNumber(LSA).source).toBe('google_lsa');
    expect(attributionForSourceType('google_lsa')).toEqual({ leadSource: 'google_lsa', isPaid: true });
  });

  test('the call log labels a call to the line Google LSA', () => {
    expect(sourceEvidence({ to_phone: LSA, metadata: { numberType: 'google_lsa' } })).toMatchObject({ kind: 'google_ads', label: 'Google LSA' });
    expect(sourceEvidence({ to_phone: LSA })).toMatchObject({ kind: 'google_ads', label: 'Google LSA' });
  });

  test('the Bradenton city-page line still reads as before', () => {
    expect(TWILIO_NUMBERS.getLeadSourceFromNumber('+19413187612').source).toBe('waves_website');
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
