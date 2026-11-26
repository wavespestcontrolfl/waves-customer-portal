/**
 * The public calculator and pest above 5,500 sq ft (owner 2026-11-26, new quotes only). The route clamps a residential home size at
 * 20,000 sq ft; before the rule a clamp changed nothing for pest (flat top), now it would price a 24,000 sq ft two-story home as a
 * 10,000 sq ft footprint. A posted size above the ceiling parks the quote for a hand price instead.
 */
jest.mock('../models/db', () => {
  const recorded = [];
  let seq = 0;
  const makeBuilder = (table) => {
    const state = { table };
    const builder = new Proxy(function builderTarget() {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve, reject) => Promise.resolve(state.result !== undefined ? state.result : []).then(resolve, reject);
        }
        if (prop === 'catch') return (reject) => Promise.resolve(state.result !== undefined ? state.result : []).catch(reject);
        if (prop === 'first') return async () => null;
        if (prop === 'insert') {
          return (data) => {
            const rows = Array.isArray(data) ? data : [data];
            rows.forEach((row) => recorded.push({ op: 'insert', table, row }));
            state.result = rows.map(() => ({ id: `id-${seq += 1}` }));
            return builder;
          };
        }
        if (prop === 'update') {
          return (data) => { recorded.push({ op: 'update', table, row: data }); state.result = 1; return builder; };
        }
        if (prop === 'del' || prop === 'delete') return async () => 0;
        if (prop === 'count') return () => { state.result = [{ count: '0' }]; return builder; };
        if (prop === 'returning') return () => builder;
        return () => builder;
      },
      apply() { return builder; },
    });
    return builder;
  };
  const db = jest.fn((table) => makeBuilder(table));
  db.raw = jest.fn((sql) => ({ toSQL: () => sql, sql }));
  db.fn = { now: () => new Date(), uuid: () => 'uuid' };
  db.transaction = jest.fn(async (cb) => cb(db));
  db.schema = { hasTable: async () => true, hasColumn: async () => true };
  db.__recorded = recorded;
  return db;
});
// The route allows 10 quotes an hour per address; this suite sends more.
jest.mock('express-rate-limit', () => () => (req, res, next) => next());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: false })) }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => false), sendOne: jest.fn(async () => ({})), newsletterGroupId: () => null, serviceGroupId: () => null,
}));
jest.mock('../services/newsletter-subscribers', () => ({ subscribeOrResubscribe: jest.fn(async () => ({ action: 'noop' })) }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn(async () => ({ enrolled: false })) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));

const express = require('express');
const db = require('../models/db');



describe('POST /api/public/quote/calculate: pest above the 5,500 sq ft table (new quotes only, owner 2026-11-26)', () => {
  let server;
  let base;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/public/quote', require('../routes/public-quote'));
    app.use((err, req, res, next) => res.status(500).json({ error: 'boom' }));
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/public/quote`; done(); });
  });
  afterAll((done) => { server.closeAllConnections(); server.close(done); });

  const calculate = async (homeSqFt, stories, services = { pest: { frequency: 'quarterly' } }, lotSqFt = 9000) => {
    db.__recorded.length = 0;
    const res = await fetch(`${base}/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Casey', lastName: 'Sample', email: 'casey.sample@example.com', phone: '9415550142',
        address: '123 Sample St, Parrish, FL 34219', city: 'Parrish', zip: '34219',
        homeSqFt, ...(lotSqFt === null ? {} : { lotSqFt }), stories, services,
      }),
    });
    const json = await res.json();
    return { status: res.status, json };
  };

  test('a 12,000 sq ft one-story home prices its full footprint: $128 + $8 x 6.5 = $180 a visit, never the flat $128', async () => {
    const { status, json } = await calculate(12000, 1);
    expect(status).toBeLessThan(300);
    expect(json.quote_required).toBeFalsy();
    const stored = db.__recorded.find((w) => w.table === 'estimates' && w.op === 'insert');
    expect(JSON.stringify(stored.row)).toMatch(/"legacyPestAboveTable":false/);
    expect(json.per_application).toBe(180);
  });

  test('a 24,000 sq ft two-story home is not priced as a truncated 10,000 sq ft footprint: the quote goes to the team', async () => {
    const { status, json } = await calculate(24000, 2);
    expect(status).toBeLessThan(300);
    expect(json.quote_required).toBe(true);
    expect(json.reason).toBe('home_size_above_public_limit');
    expect(json.per_application).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/164|10,?000/);
    // The stored draft keeps the real size, so a later staff re-price never reads the clamped one.
    const stored = db.__recorded.find((w) => w.table === 'estimates' && w.op === 'insert');
    expect(JSON.stringify(stored.row)).toContain('24000');
  });

  test('a 24,000 sq ft pest + exclusion draft stores ONE real size everywhere: the engine input, the exclusion line and the lead data', async () => {
    const { json } = await calculate(24000, 2, { pest: { frequency: 'quarterly' }, exclusion: { stories: 2 } });
    expect(json.quote_required).toBe(true);
    expect(json.reason).toBe('home_size_above_public_limit');
    const estimateRow = db.__recorded.find((w) => w.table === 'estimates' && w.op === 'insert');
    const estimateData = typeof estimateRow.row.estimate_data === 'string' ? JSON.parse(estimateRow.row.estimate_data) : estimateRow.row.estimate_data;
    const inputs = estimateData.engineInput;
    expect(inputs.homeSqFt).toBe(24000);
    expect(inputs.services.exclusion.homeSqFt).toBe(24000);
    const leadRows = db.__recorded.filter((w) => w.table === 'leads' && w.row && w.row.extracted_data);
    expect(leadRows.length).toBeGreaterThan(0);
    const sizes = leadRows.map((w) => (typeof w.row.extracted_data === 'string' ? JSON.parse(w.row.extracted_data) : w.row.extracted_data).homeSqFt)
      .filter((v) => v !== undefined);
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((v) => v === 24000)).toBe(true);
    expect(JSON.stringify(db.__recorded)).not.toMatch(/"homeSqFt":20000/);
  });

  test('a manual-review line beside pest keeps its own service, reason and message: top dressing wins over the home-size hold', async () => {
    const { status, json } = await calculate(24000, 2, { pest: { frequency: 'quarterly' }, topDressing: {} });
    expect(status).toBeLessThan(300);
    expect(json.quote_required).toBe(true);
    // The manual line's own answer (here the turf-confirmation reason top dressing parks on) is kept whole.
    expect(json.reason).toBe('low_confidence_turf_requires_field_verification');
    expect(json.reason).not.toBe('home_size_above_public_limit');
    expect(json.message).not.toMatch(/A home this size is priced by our team/);
  });

  test('a junk finite home size (1e300) is parked and bounded at 200,000 sq ft: it never reaches the price arithmetic or a size column', async () => {
    const { status, json } = await calculate(1e300, 1, { pest: { frequency: 'quarterly' }, exclusion: { stories: 1 } });
    expect(status).toBeLessThan(300);
    expect(json.quote_required).toBe(true);
    expect(json.reason).toBe('home_size_above_public_limit');
    const estimateRow = db.__recorded.find((w) => w.table === 'estimates' && w.op === 'insert');
    const estimateData = typeof estimateRow.row.estimate_data === 'string' ? JSON.parse(estimateRow.row.estimate_data) : estimateRow.row.estimate_data;
    expect(estimateData.engineInput.homeSqFt).toBe(200000);
    expect(estimateData.engineInput.services.exclusion.homeSqFt).toBe(200000);
    // Nothing the request wrote holds the junk number, and no stored price overflowed to null (JSON has no Infinity).
    const written = JSON.stringify(db.__recorded);
    expect(written).not.toMatch(/1e\+?300/i);
    const prices = (estimateData.result?.lineItems || estimateData.engineResult?.lineItems || []).flatMap((line) => [line.price, line.annual, line.monthly]);
    expect(prices.filter((value) => value !== undefined && value !== null).every((value) => Number.isFinite(value))).toBe(true);
    const sizes = db.__recorded.filter((w) => w.table === 'leads' && w.row && w.row.extracted_data)
      .map((w) => (typeof w.row.extracted_data === 'string' ? JSON.parse(w.row.extracted_data) : w.row.extracted_data).homeSqFt)
      .filter((v) => v !== undefined);
    expect(sizes.every((v) => v === 200000)).toBe(true);
  });

  test.each(['Infinity', '-Infinity', 'NaN', 'abc', '1,800', true, false, [24000], [12000], { value: 24000 }, null])('a home size that is no number (%p) takes the 2,000 sq ft default: never clamped, parked or stored as null', async (bad) => {
    const baseline = await calculate(2000, 1);
    const { status, json } = await calculate(bad, 1);
    expect(status).toBeLessThan(300);
    expect(json.quote_required).toBeFalsy();
    expect(json.per_application).toBe(baseline.json.per_application);
    const row = db.__recorded.find((w) => w.table === 'estimates' && w.op === 'insert');
    const data = typeof row.row.estimate_data === 'string' ? JSON.parse(row.row.estimate_data) : row.row.estimate_data;
    expect(data.engineInput.homeSqFt).toBe(2000);
    const lead = db.__recorded.filter((w) => w.table === 'leads' && w.row && w.row.extracted_data)
      .map((w) => (typeof w.row.extracted_data === 'string' ? JSON.parse(w.row.extracted_data) : w.row.extracted_data).homeSqFt)
      .filter((v) => v !== undefined);
    expect(lead.every((v) => v === 2000)).toBe(true);
  });

  test('the synthetic-lot fallback follows the real size: a 24,000 sq ft pest + lawn quote with no lot stores 96,000, and the lot cap still holds', async () => {
    await calculate(24000, 2, { pest: { frequency: 'quarterly' }, lawn: { track: 'st_augustine' } }, null);
    const stored = (n) => {
      const row = db.__recorded.find((w) => w.table === 'estimates' && w.op === 'insert');
      const data = typeof row.row.estimate_data === 'string' ? JSON.parse(row.row.estimate_data) : row.row.estimate_data;
      return data.engineInput.lotSqFt;
    };
    expect(stored()).toBe(96000);
    await calculate(60000, 2, { pest: { frequency: 'quarterly' } }, null);
    expect(stored()).toBe(200000);
  });

  test('a size at the ceiling still prices (20,000 sq ft two-story = 10,000 footprint = $164)', async () => {
    const atLimit = await calculate(20000, 2);
    expect(atLimit.json.quote_required).toBeFalsy();
    expect(atLimit.json.per_application).toBe(164);
    // A quote without pest at the ceiling is not parked by this rule either.
    const baitAtLimit = await calculate(20000, 2, { rodentBait: {} });
    expect(baitAtLimit.status).toBe(200);
    expect(baitAtLimit.json.quote_required).toBeFalsy();
  });

  test('a quote WITHOUT pest above the ceiling goes to the team too and stores the real size, so pest added later is priced from it', async () => {
    const baitOnly = await calculate(24000, 2, { rodentBait: {} });
    expect(baitOnly.status).toBe(202);
    expect(baitOnly.json.quote_required).toBe(true);
    expect(baitOnly.json.reason).toBe('home_size_above_public_limit');
    const row = db.__recorded.find((w) => w.table === 'estimates' && w.op === 'insert');
    const data = typeof row.row.estimate_data === 'string' ? JSON.parse(row.row.estimate_data) : row.row.estimate_data;
    // The stored engine input holds the real size, never the 20,000 it would have been cut to.
    expect(data.engineInput.homeSqFt).toBe(24000);
    // Pest added to that estimate later prices the real 12,000 sq ft footprint ($128 + $8 x 6.5 = $180), not the cut 10,000 ($164).
    const { generateEstimate } = require('../services/pricing-engine');
    const later = generateEstimate({ ...data.engineInput, services: { ...data.engineInput.services, pest: { frequency: 'quarterly' } } });
    const pest = later.lineItems.find((line) => line.service === 'pest_control');
    expect(pest.footprintUsed).toBe(12000);
    expect(pest.basePrice).toBe(180);
    // A lawn line parked for its own reason keeps that reason; the size is stored whole all the same.
    const lawnOnly = await calculate(24000, 2, { lawn: { track: 'st_augustine' } });
    expect(lawnOnly.json.quote_required).toBe(true);
    const lawnRow = db.__recorded.find((w) => w.table === 'estimates' && w.op === 'insert');
    const lawnData = typeof lawnRow.row.estimate_data === 'string' ? JSON.parse(lawnRow.row.estimate_data) : lawnRow.row.estimate_data;
    expect(lawnData.engineInput.homeSqFt).toBe(24000);
  });
});
