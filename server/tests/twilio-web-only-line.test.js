/**
 * The website-only line +19412542617 ((941) 254-2617, bought 2026-11-19).
 * It is a wavespestcontrol.com domain-tracking line: calls to it prove a
 * website visit. It must never be used as an outbound caller ID, never be
 * counted as a shared line, and its lead_sources row must be what an inbound
 * call resolves to, on production and on a fresh database alike.
 */
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { sharedLineNumbers, websiteOnlyLineNumbers } = require('../config/shared-phone-lines');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261119120000_web_line_source');
const aprilSeed = require('../models/migrations/20260401000096_seed_lead_sources');
const { leadSourceNumberVariants } = require('../utils/call-lead-source');

const WEB_LINE = '+19412542617';

describe('website-only line in the Twilio registry', () => {
  test('registers as a hub domain-tracking line with an explicit label', () => {
    const found = TWILIO_NUMBERS.findByNumber(WEB_LINE);
    expect(found).toMatchObject({
      type: 'domain_tracking', domain: 'wavespestcontrol.com', locationId: 'bradenton',
      formatted: '(941) 254-2617', label: 'Main site web-only line',
    });
    expect(TWILIO_NUMBERS.getLeadSourceFromNumber(WEB_LINE)).toMatchObject({ source: 'waves_website', domain: 'wavespestcontrol.com' });
    expect(TWILIO_NUMBERS.isOwnedNumber(WEB_LINE)).toBe(true);
    expect(TWILIO_NUMBERS.portalNumbers).toContain(WEB_LINE);
    expect(TWILIO_NUMBERS.allNumbers.filter((n) => n.number === WEB_LINE)).toHaveLength(1);
  });

  test('is not a shared line; the shared list is exactly the main line plus the office lines', () => {
    expect(sharedLineNumbers(TWILIO_NUMBERS)).toEqual([
      '+19412975749', '+19413187612', '+19412972817', '+19412972606', '+19412973337',
    ]);
    expect(sharedLineNumbers(TWILIO_NUMBERS)).not.toContain(WEB_LINE);
  });

  test('is a website-only line; shared lines and the AI toll-free line are not', () => {
    const websiteOnly = websiteOnlyLineNumbers(TWILIO_NUMBERS);
    expect(websiteOnly).toContain(WEB_LINE);
    expect(websiteOnly).toContain('+19412402066');
    for (const shared of sharedLineNumbers(TWILIO_NUMBERS)) expect(websiteOnly).not.toContain(shared);
    expect(websiteOnly).not.toContain(TWILIO_NUMBERS.tollFree.number);
  });

  test('can never be an outbound caller ID', () => {
    const ids = ['bradenton', 'parrish', 'sarasota', 'venice', 'unknown-location', undefined, null]
      .map((location) => TWILIO_NUMBERS.getOutboundNumber(location));
    expect(ids).not.toContain(WEB_LINE);
    expect(TWILIO_NUMBERS.internalAlertCallerId()).not.toBe(WEB_LINE);
    expect(TWILIO_NUMBERS.mainLine.number).toBe('+19412975749');
    expect(TWILIO_NUMBERS.techVoiceNumber()).not.toBe(WEB_LINE);
  });

  test('the main line stays the first wavespestcontrol.com entry, so a by-domain find picks it', () => {
    const hub = TWILIO_NUMBERS.domainTracking.find((d) => d.domain === 'wavespestcontrol.com');
    expect(hub.number).toBe('+19412975749');
  });
});

describe('migration 20261119120000: lead_sources row for the website-only line', () => {
  // A fake knex over one optional existing row. where(cond).update() changes
  // it only when every cond key matches, as the SQL WHERE would.
  function fakeKnex({ tables = ['lead_sources', 'audit_log'], existing = null } = {}) {
    const calls = { whereIn: null, inserted: [], updates: [] };
    const knex = () => ({
      whereIn: (column, values) => { calls.whereIn = { column, values }; return { first: async () => existing }; },
      insert: async (rows) => { calls.inserted.push(rows); },
      where: (cond) => ({
        update: async (patch) => {
          calls.updates.push({ cond, patch });
          return existing && Object.entries(cond).every(([key, value]) => existing[key] === value) ? 1 : 0;
        },
      }),
    });
    knex.schema = { hasTable: async (name) => tables.includes(name) };
    knex.fn = { now: () => 'NOW()' };
    knex._calls = calls;
    return knex;
  }

  // The row the April registry seed generates for this line on a fresh database.
  async function aprilSeedRow() {
    const knex = fakeKnex();
    await aprilSeed.up(knex);
    return knex._calls.inserted.flat().find((row) => row.twilio_phone_number === WEB_LINE);
  }

  beforeEach(() => recordAuditEvent.mockClear());

  test('production: no row has the number, so it inserts the main_site row, matched on the resolver formats', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex._calls.whereIn.column).toBe('twilio_phone_number');
    expect([...knex._calls.whereIn.values].sort()).toEqual([...leadSourceNumberVariants(WEB_LINE)].sort());
    expect(knex._calls.inserted).toHaveLength(1);
    expect(knex._calls.inserted[0]).toMatchObject({
      source_type: 'main_site', channel: 'organic', domain: 'wavespestcontrol.com', cost_type: 'free',
      twilio_phone_number: WEB_LINE, twilio_phone_sid: 'PN6cf7b72b0908028cea7935aff7e54fcd', is_active: true,
    });
    expect(leadSourceNumberVariants(WEB_LINE)).toContain(knex._calls.inserted[0].twilio_phone_number);
    expect(knex._calls.updates).toEqual([]);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('fresh database: the April seed already made a phone_tracking row for the line', async () => {
    expect(await aprilSeedRow()).toMatchObject({
      name: 'wavespestcontrol.com — General', source_type: 'phone_tracking', channel: 'website_organic', is_active: true,
    });
  });

  test("fresh database: that generated row gets production's attribution and cost, with one audit row", async () => {
    const generated = { id: 'fresh-1', ...(await aprilSeedRow()) };
    const knex = fakeKnex({ existing: generated });
    await migration.up(knex);
    expect(knex._calls.inserted).toEqual([]);
    expect(knex._calls.updates).toHaveLength(1);

    const prod = fakeKnex();
    await migration.up(prod);
    const production = prod._calls.inserted[0];
    expect(knex._calls.updates[0].patch).toEqual({
      name: production.name, source_type: production.source_type, channel: production.channel,
      cost_type: production.cost_type, monthly_cost: production.monthly_cost, updated_at: 'NOW()',
    });

    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    const event = recordAuditEvent.mock.calls[0][0];
    expect(event).toMatchObject({ actor_type: 'system', resource_type: 'lead_sources', resource_id: 'fresh-1', critical: true, trx: knex });
    expect(event.action.length).toBeLessThanOrEqual(96);
  });

  test('an office edit of notes or active status survives: only the five April fields change', async () => {
    const edited = { id: 'fresh-2', ...(await aprilSeedRow()), notes: 'Office note', is_active: false };
    const knex = fakeKnex({ existing: edited });
    await migration.up(knex);
    expect(Object.keys(knex._calls.updates[0].patch).sort())
      .toEqual(['channel', 'cost_type', 'monthly_cost', 'name', 'source_type', 'updated_at']);
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['renamed', { name: 'Website line (renamed)' }],
    ['monthly cost set', { monthly_cost: 9 }],
    ['cost type set', { cost_type: 'free' }],
  ])('a row the office edited (%s) is left as it is', async (_label, edit) => {
    const knex = fakeKnex({ existing: { id: 'office-1', ...(await aprilSeedRow()), ...edit } });
    await migration.up(knex);
    expect(knex._calls.updates[0].cond).toMatchObject({
      id: 'office-1', name: 'wavespestcontrol.com — General', cost_type: 'per_month', monthly_cost: 2.5,
    });
    expect(knex._calls.inserted).toEqual([]);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('skips when the table is absent', async () => {
    const knex = fakeKnex({ tables: [] });
    await migration.up(knex);
    expect(knex._calls).toEqual({ whereIn: null, inserted: [], updates: [] });
  });

  test('down is a documented no-op: the seeded row is never deleted', async () => {
    const knex = fakeKnex();
    await migration.down(knex);
    expect(knex._calls).toEqual({ whereIn: null, inserted: [], updates: [] });
  });
});
