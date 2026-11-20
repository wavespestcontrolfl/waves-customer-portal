/**
 * GATE_CAGE_TWO_SIZES (owner 2026-11-19, "cage 1000"): the lookup now sizes a
 * pool cage Medium or Large only, but the website keeps today's manual-quote
 * hold for a cage that the four sizes call Large or Oversized. This drives
 * POST /api/public/quote/calculate with synthetic lookup profiles in both gate
 * states and reads quote_required from the answer.
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
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: false })) }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => false), sendOne: jest.fn(async () => ({})), newsletterGroupId: () => null, serviceGroupId: () => null,
}));
jest.mock('../services/newsletter-subscribers', () => ({ subscribeOrResubscribe: jest.fn(async () => ({ action: 'noop' })) }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn(async () => ({ enrolled: false })) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));

// The route allows 10 quotes an hour per address; this suite sends more.
jest.mock('express-rate-limit', () => () => (req, res, next) => next());

// The route's own cache-only server re-read. A test sets what it answers.
let mockServerLookup = null;
jest.mock('../routes/property-lookup-v2', () => ({
  ...jest.requireActual('../routes/property-lookup-v2'),
  performPropertyLookup: jest.fn(async () => mockServerLookup),
}));

const express = require('express');

const TWO_SIZES = 'GATE_CAGE_TWO_SIZES';
// The first request cold-loads the whole route graph, which can pass 5 s on a busy machine.
jest.setTimeout(30000);

describe('POST /api/public/quote/calculate: pool cage manual-quote hold', () => {
  let server;
  let base;
  let prior;

  beforeAll((done) => {
    prior = process.env[TWO_SIZES];
    const app = express();
    app.use(express.json());
    app.use('/api/public/quote', require('../routes/public-quote'));
    app.use((err, req, res, next) => res.status(500).json({ error: 'boom' }));
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/public/quote`; done(); });
  });
  afterAll((done) => {
    if (prior === undefined) delete process.env[TWO_SIZES];
    else process.env[TWO_SIZES] = prior;
    server.closeAllConnections();
    server.close(done);
  });
  beforeEach(() => { delete process.env[TWO_SIZES]; mockServerLookup = null; });

  const quote = async (cage) => {
    const res = await fetch(`${base}/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Test',
        lastName: 'Quoter',
        email: 'cage.hold@example.com',
        phone: '9415550142',
        address: '123 Sample St, Parrish, FL 34219',
        city: 'Parrish',
        zip: '34219',
        homeSqFt: 1800,
        lotSqFt: 8000,
        stories: 1,
        enriched: { pool: 'YES', poolCage: 'YES', ...cage },
        services: { pest: { frequency: 'quarterly' } },
      }),
    });
    expect(res.status).toBeLessThan(300);
    return res.json();
  };
  // A held cage answers quote_required: true; a priced one leaves it out.
  const held = async (cage) => (await quote(cage)).quote_required === true;

  test('gate on: a 750 and a 1,200 sq ft county cage are still held, a 500 sq ft cage is priced', async () => {
    process.env[TWO_SIZES] = 'true';
    expect(await held({ poolCageSqft: 750, poolCageSize: 'MEDIUM', poolCageLegacySize: 'LARGE' })).toBe(true);
    expect(await held({ poolCageSqft: 1200, poolCageSize: 'LARGE', poolCageLegacySize: 'OVERSIZED' })).toBe(true);
    const priced = await quote({ poolCageSqft: 500, poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM' });
    expect(priced.quote_required).toBeUndefined();
    expect(priced.monthly_total).toBeGreaterThan(0);
  });

  test('gate off: four sizes as today (Large and Oversized held, Medium priced)', async () => {
    expect(await held({ poolCageSqft: 750, poolCageSize: 'LARGE' })).toBe(true);
    expect(await held({ poolCageSqft: 1200, poolCageSize: 'OVERSIZED' })).toBe(true);
    expect(await held({ poolCageSqft: 500, poolCageSize: 'MEDIUM' })).toBe(false);
  });

  // The gate can flip between the lookup and /calculate. /calculate prices from the gate
  // state of THIS request, so a two-size profile from before a rollback prices its four-size answer.
  test('rollback: gate off, a two-size profile (Medium, legacy Large) prices its four-size answer and is held', async () => {
    expect(await held({ poolCageSqft: 750, poolCageSize: 'MEDIUM', poolCageLegacySize: 'LARGE' })).toBe(true);
    expect(await held({ poolCageSqft: 1200, poolCageSize: 'LARGE', poolCageLegacySize: 'OVERSIZED' })).toBe(true);
  });

  test('rollback: gate off, a two-size profile whose four-size answer is Medium is priced', async () => {
    const priced = await quote({ poolCageSqft: 500, poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM' });
    expect(priced.quote_required).toBeUndefined();
    expect(priced.monthly_total).toBeGreaterThan(0);
  });

  test('gate on: a four-size profile from before the flip (no legacy key) with Large is held', async () => {
    process.env[TWO_SIZES] = 'true';
    expect(await held({ poolCageSqft: 750, poolCageSize: 'LARGE' })).toBe(true);
    expect(await held({ poolCageSqft: 500, poolCageSize: 'MEDIUM' })).toBe(false);
  });

  // /calculate is a public API: a caller can send a partial `enriched` with no
  // four-size answer. The server's own cache-only re-read still carries it.
  test('a partial client profile cannot drop the hold: the server re-read carries the four-size answer', async () => {
    mockServerLookup = {
      enriched: { pool: 'YES', poolCage: 'YES', poolCageSize: 'MEDIUM', poolCageLegacySize: 'LARGE', poolCageSqft: 750 },
      propertyRecord: {},
    };
    const partial = { poolCageSize: 'MEDIUM' };
    process.env[TWO_SIZES] = 'true';
    expect(await held(partial)).toBe(true);
    delete process.env[TWO_SIZES];
    expect(await held(partial)).toBe(false);
  });

  test('a visitor who says no cage is never held, even when the re-read has a cage', async () => {
    mockServerLookup = {
      enriched: { pool: 'YES', poolCage: 'YES', poolCageSize: 'MEDIUM', poolCageLegacySize: 'LARGE' },
      propertyRecord: {},
    };
    process.env[TWO_SIZES] = 'true';
    expect(await held({ poolCage: 'NO', poolCageSize: 'NONE' })).toBe(false);
  });

  // A partial client profile can omit poolCage. The engine only holds a cage that is
  // present, so the server re-read supplies it; an explicit NO stays no cage.
  describe('a client that omits poolCage', () => {
    const trustedHeldCage = () => {
      mockServerLookup = {
        enriched: { pool: 'YES', poolCage: 'YES', poolCageSize: 'MEDIUM', poolCageLegacySize: 'LARGE', poolCageSqft: 750 },
        propertyRecord: {},
      };
    };

    test('gate on: omitted poolCage with a trusted held cage is held', async () => {
      trustedHeldCage();
      process.env[TWO_SIZES] = 'true';
      expect(await held({ poolCage: undefined, poolCageSize: 'MEDIUM' })).toBe(true);
      expect(await held({ poolCage: null, pool: undefined })).toBe(true);
      expect(await held({ poolCage: '' })).toBe(true);
    });

    test('gate on: omitted poolCage with a trusted 500 sq ft cage is charged like an explicit YES', async () => {
      mockServerLookup = {
        enriched: { pool: 'YES', poolCage: 'YES', poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM', poolCageSqft: 500 },
        propertyRecord: {},
      };
      process.env[TWO_SIZES] = 'true';
      const explicit = await quote({ poolCage: 'YES', poolCageSize: 'MEDIUM' });
      const omitted = await quote({ poolCage: undefined, poolCageSize: 'MEDIUM' });
      const noCage = await quote({ poolCage: 'NO', poolCageSize: 'NONE' });
      expect(omitted.quote_required).toBeUndefined();
      expect(omitted.monthly_total).toBe(explicit.monthly_total);
      expect(omitted.monthly_total).toBeGreaterThan(noCage.monthly_total);
    });

    test('gate on: an explicit NO (string in any case, or boolean) with a trusted held cage is priced', async () => {
      trustedHeldCage();
      process.env[TWO_SIZES] = 'true';
      expect(await held({ poolCage: 'NO', poolCageSize: 'NONE' })).toBe(false);
      expect(await held({ poolCage: false, poolCageSize: 'NONE' })).toBe(false);
      expect(await held({ poolCage: 'no', poolCageSize: 'NONE' })).toBe(false);
    });

    // The lookup can answer POSSIBLE or UNKNOWN, and the website echoes it: not a decided answer.
    test('gate on: an undecided client answer (POSSIBLE, UNKNOWN, a lowercase yes) takes the re-read\'s held cage', async () => {
      trustedHeldCage();
      process.env[TWO_SIZES] = 'true';
      expect(await held({ poolCage: 'POSSIBLE', poolCageSize: 'MEDIUM' })).toBe(true);
      expect(await held({ poolCage: 'UNKNOWN', poolCageSize: 'NONE' })).toBe(true);
      expect(await held({ poolCage: 'yes' })).toBe(true);
    });

    test('an explicit NO is never held, even when the re-read has a cage over 1,000 sq ft', async () => {
      mockServerLookup = {
        enriched: { pool: 'YES', poolCage: 'YES', poolCageSize: 'LARGE', poolCageLegacySize: 'OVERSIZED', poolCageSqft: 1200 },
        propertyRecord: {},
      };
      process.env[TWO_SIZES] = 'true';
      expect(await held({ poolCage: 'NO', poolCageSize: 'NONE' })).toBe(false);
      expect(await held({ poolCage: false })).toBe(false);
      // Gate off, a two-size profile from before a rollback (it carries the legacy key).
      delete process.env[TWO_SIZES];
      expect(await held({ poolCage: 'NO', poolCageSize: 'NONE', poolCageLegacySize: 'NONE' })).toBe(false);
    });

    test('gate off: both cases are as today (a cage the client omits is not priced, not held)', async () => {
      trustedHeldCage();
      expect(await held({ poolCage: undefined, poolCageSize: 'MEDIUM' })).toBe(false);
      expect(await held({ poolCage: 'NO', poolCageSize: 'NONE' })).toBe(false);
      // A profile with no legacy key is today's code: an undecided answer is no cage.
      expect(await held({ poolCage: 'POSSIBLE', poolCageSize: 'MEDIUM' })).toBe(false);
    });
  });

  // One invariant: the cage size and the hold come from the best evidence under THIS
  // request's gate state; the server's re-read beats the client's hand-built profile.
  describe('best evidence per request', () => {
    const serverSays = (cage) => {
      mockServerLookup = { enriched: { pool: 'YES', poolCage: 'YES', ...cage }, propertyRecord: {} };
    };
    const priced = async (cage) => {
      const answer = await quote(cage);
      expect(answer.quote_required).toBeUndefined();
      return answer.monthly_total;
    };

    test('gate on: the server area 750 beats a client claiming Small: held', async () => {
      process.env[TWO_SIZES] = 'true';
      serverSays({ poolCageSqft: 750, poolCageSize: 'MEDIUM', poolCageLegacySize: 'LARGE' });
      expect(await held({ poolCageSize: 'SMALL' })).toBe(true);
    });

    test('gate on: the server area prices Medium, not the client\'s Small', async () => {
      process.env[TWO_SIZES] = 'true';
      const medium = await priced({ poolCageSqft: 500, poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM' });
      serverSays({ poolCageSqft: 500, poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM' });
      expect(await priced({ poolCageSize: 'SMALL' })).toBe(medium);
    });

    test('gate on: a re-read miss with a client area of 750 and no legacy key is held', async () => {
      process.env[TWO_SIZES] = 'true';
      expect(await held({ poolCageSqft: 750, poolCageSize: 'MEDIUM' })).toBe(true);
    });

    test('gate on: a re-read miss with client legacy Small and no area prices Medium', async () => {
      process.env[TWO_SIZES] = 'true';
      const medium = await priced({ poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM' });
      expect(await priced({ poolCageSize: 'SMALL', poolCageLegacySize: 'SMALL' })).toBe(medium);
      // The fixture can tell the two apart: with the gate off a Small cage prices Small.
      delete process.env[TWO_SIZES];
      expect(await priced({ poolCageSize: 'SMALL' })).not.toBe(medium);
    });

    test('gate off: a two-size client (legacy key) is held when the server re-read says Large, even with client legacy Medium', async () => {
      serverSays({ poolCageSqft: 750, poolCageSize: 'LARGE' });
      expect(await held({ poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM' })).toBe(true);
    });

    test('gate off: a profile with no legacy key is today\'s code (the client size, the re-read ignored)', async () => {
      serverSays({ poolCageSqft: 750, poolCageSize: 'LARGE' });
      expect(await held({ poolCageSize: 'MEDIUM' })).toBe(false);
      expect(await held({ poolCageSize: 'LARGE' })).toBe(true);
    });
  });

  // Rollback branch (gate off, a profile with its own poolCageLegacySize key): an omitted poolCage
  // inherits the re-read's decided cage, as the gate-on path does. An explicit NO stays no cage.
  describe('rollback: a legacy-key profile that omits poolCage', () => {
    const serverSaysCage = () => {
      mockServerLookup = {
        enriched: { pool: 'YES', poolCage: 'YES', poolCageSize: 'LARGE', poolCageSqft: 750 },
        propertyRecord: {},
      };
    };

    test('gate off: omitted poolCage with the re-read saying YES and area 750 is held', async () => {
      serverSaysCage();
      expect(await held({ poolCage: undefined, pool: undefined, poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM' })).toBe(true);
      expect(await held({ poolCage: null, poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM' })).toBe(true);
      expect(await held({ poolCage: '', poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM' })).toBe(true);
    });

    test('gate off: an undecided client answer (POSSIBLE, UNKNOWN) with the re-read saying YES and area 750 is held', async () => {
      serverSaysCage();
      expect(await held({ poolCage: 'POSSIBLE', poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM' })).toBe(true);
      expect(await held({ poolCage: 'UNKNOWN', poolCageSize: 'NONE', poolCageLegacySize: 'MEDIUM' })).toBe(true);
    });

    test('gate off: an explicit NO with the re-read saying YES is not held', async () => {
      serverSaysCage();
      expect(await held({ poolCage: 'NO', poolCageSize: 'NONE', poolCageLegacySize: 'NONE' })).toBe(false);
      expect(await held({ poolCage: false, poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM' })).toBe(false);
    });
  });
});
