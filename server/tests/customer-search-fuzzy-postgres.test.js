/**
 * Sound-alike rows in the admin customer pickers (GATE_CUSTOMER_SEARCH_FUZZY),
 * against a real migrated PostgreSQL database and the real routes.
 *
 * GET /admin/customers?search= and GET /admin/schedule/list?search= append up
 * to 8 `approximate: true` rows after the exact rows when the exact search
 * finds fewer than 3 and the text reads as a name. Gate off is the exact
 * search only. A technician's assigned-visit scope is never widened.
 *
 * Synthetic names only. Every row this suite inserts is deleted in afterAll.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const SKIP = !process.env.DATABASE_URL;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The role comes from a header so one server plays admin and technician.
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.techRole = req.headers['x-test-role'] || 'admin';
    req.technicianId = req.headers['x-test-tech'] || null;
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const { randomUUID } = require('crypto');

jest.setTimeout(120000);

(SKIP ? describe.skip : describe)('customer picker sound-alike rows (GATE_CUSTOMER_SEARCH_FUZZY)', () => {
  const express = require('express');
  let db;
  let server;
  let base;
  let resetNameIndexCache;
  const tag = `fz${randomUUID().slice(0, 8)}`;
  const ids = {};
  let techId;
  let otherTechId;
  const futureDate = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

  const customer = (key, first, last, extra = {}) => {
    ids[key] = randomUUID();
    return {
      id: ids[key], first_name: first, last_name: last,
      phone: `+1941555${String(Object.keys(ids).length).padStart(4, '0')}`,
      company_name: tag, active: true, ...extra,
    };
  };

  const get = async (path, headers = {}) => {
    const res = await fetch(`${base}${path}`, { headers });
    return { status: res.status, body: await res.json() };
  };
  const names = (rows) => rows.map((row) => `${row.firstName} ${row.lastName}`);

  beforeAll(async () => {
    db = require('../models/db');
    ({ resetNameIndexCache } = require('../services/intelligence-bar/name-match'));
    const app = express();
    app.use(express.json());
    app.use('/admin/customers', require('../routes/admin-customers'));
    app.use('/admin/schedule', require('../routes/admin-schedule'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;

    await db('customers').insert([
      customer('stompf', 'Orlan', 'Stompf', { waveguard_tier: 'Gold' }),
      customer('stimpf', 'Orlan', 'Stimpf'),
      customer('brantmoor', 'Zxqvel', 'Brantmoor'),
      customer('exactA', 'Quillon', 'Fenwrick'),
      customer('exactB', 'Quillon', 'Fenwrock'),
      customer('exactC', 'Quillon', 'Fenwrack'),
      customer('exactD', 'Quillon', 'Fenwreck'),
      customer('townsman', 'Dara', 'Wexley', { city: 'Brantmoorton', address_line1: '9 Sample Way' }),
      customer('streetman', 'Pell', 'Marwick', { address_line1: '4 Quillow Street' }),
    ]);
    techId = randomUUID();
    otherTechId = randomUUID();
    await db('technicians').insert([{ id: techId, name: `Tech ${tag}` }, { id: otherTechId, name: `Other ${tag}` }]);
    await db('scheduled_services').insert([
      { customer_id: ids.stompf, technician_id: otherTechId, scheduled_date: futureDate(3), service_type: 'Pest Control', status: 'confirmed' },
      { customer_id: ids.stimpf, technician_id: techId, scheduled_date: futureDate(2), service_type: 'Pest Control', status: 'confirmed' },
    ]);
  });

  afterAll(async () => {
    delete process.env.GATE_CUSTOMER_SEARCH_FUZZY;
    if (db) {
      const mine = Object.values(ids);
      await db('scheduled_services').whereIn('customer_id', mine).del().catch(() => {});
      await db('technicians').whereIn('id', [techId, otherTechId].filter(Boolean)).del().catch(() => {});
      await db('customers').where({ company_name: tag }).del().catch(() => {});
      await db.destroy();
    }
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    delete process.env.GATE_CUSTOMER_SEARCH_FUZZY;
    resetNameIndexCache();
  });

  describe('gate off', () => {
    test('a sound-alike search finds nothing, exactly as today, with no new keys', async () => {
      const { status, body } = await get('/admin/customers?search=Orlan%20damp');
      expect(status).toBe(200);
      expect(body.customers).toEqual([]);
      expect(body.total).toBe(0);
      expect(body).not.toHaveProperty('approximateCount');
    });

    test('a schedule list sound-alike search finds nothing and adds no keys', async () => {
      const { body } = await get(`/admin/schedule/list?search=Orlan%20damp&from=${futureDate(0)}`);
      expect(body.services).toEqual([]);
      expect(body).not.toHaveProperty('approximateCount');
    });

    test('exact rows carry no approximate flag', async () => {
      const { body } = await get('/admin/customers?search=Stompf');
      expect(names(body.customers)).toEqual(['Orlan Stompf']);
      expect(body.customers[0]).not.toHaveProperty('approximate');
    });
  });

  describe('gate on: GET /admin/customers', () => {
    beforeEach(() => { process.env.GATE_CUSTOMER_SEARCH_FUZZY = 'true'; });

    test('a misspelled search returns approximate rows after nothing, best first', async () => {
      const { body } = await get('/admin/customers?search=Orlan%20damp');
      expect(names(body.customers)).toEqual(expect.arrayContaining(['Orlan Stompf', 'Orlan Stimpf']));
      expect(body.customers.every((row) => row.approximate === true)).toBe(true);
      expect(body.customers.every((row) => Array.isArray(row.matchReasons))).toBe(true);
      expect(body.approximateCount).toBe(body.customers.length);
      expect(body.total).toBe(0);
      expect(body.totalPages).toBe(1);
      // The rows are the full directory rows, so any picker can use them.
      expect(body.customers[0]).toEqual(expect.objectContaining({ id: expect.any(String), phone: expect.any(String), propertyCount: expect.any(Number) }));
    });

    test('approximate rows follow the exact rows; the exact rows, total and paging are unchanged', async () => {
      const off = await (async () => {
        delete process.env.GATE_CUSTOMER_SEARCH_FUZZY;
        return get('/admin/customers?search=Stompf');
      })();
      process.env.GATE_CUSTOMER_SEARCH_FUZZY = 'true';
      const on = await get('/admin/customers?search=Stompf');
      expect(names(off.body.customers)).toEqual(['Orlan Stompf']);
      const exactOn = on.body.customers.filter((row) => !row.approximate);
      expect(exactOn).toEqual(off.body.customers);
      expect(on.body.customers.slice(0, exactOn.length)).toEqual(exactOn);
      expect(on.body.customers.length).toBeGreaterThan(exactOn.length);
      expect(names(on.body.customers.slice(exactOn.length))).toContain('Orlan Stimpf');
      expect(on.body.total).toBe(off.body.total);
      expect(on.body.totalPages).toBe(off.body.totalPages);
      expect(on.body.page).toBe(off.body.page);
      expect(on.body.approximateCount).toBe(on.body.customers.length - exactOn.length);
    });

    test('three or more exact rows: no sound-alike pass', async () => {
      const { body } = await get('/admin/customers?search=Quillon');
      expect(body.total).toBe(4);
      expect(body.customers.every((row) => !row.approximate)).toBe(true);
      expect(body.approximateCount).toBe(0);
    });

    test('never on page 2', async () => {
      const { body } = await get('/admin/customers?search=Orlan%20damp&page=2');
      expect(body.customers).toEqual([]);
      expect(body.approximateCount).toBe(0);
    });

    test('a phone, email or address search never runs the sound-alike pass', async () => {
      for (const search of ['941-555-9999', 'orlan@example.test', '12 Orlan Stompf St']) {
        const { body } = await get(`/admin/customers?search=${encodeURIComponent(search)}`);
        expect(body.customers).toEqual([]);
        expect(body.approximateCount).toBe(0);
      }
    });

    test('a text-only address search never runs the name pass', async () => {
      // "Brantmoorton" is a city on file; "Brantmoor" is also a customer's last name.
      const city = await get('/admin/customers?search=Brantmoorton');
      expect(names(city.body.customers)).toEqual(['Dara Wexley']);
      expect(city.body.approximateCount).toBe(0);
      // A street word: the search is an address.
      const street = await get('/admin/customers?search=Quillow%20Street');
      expect(names(street.body.customers)).toEqual(['Pell Marwick']);
      expect(street.body.approximateCount).toBe(0);
      const none = await get('/admin/customers?search=Wexford%20Street');
      expect(none.body.customers).toEqual([]);
    });

    test('the directory filters still apply to approximate rows', async () => {
      const { body } = await get('/admin/customers?search=Orlan%20damp&tier=Gold');
      expect(names(body.customers)).toEqual(['Orlan Stompf']);
    });

    test('a technician only gets approximate customers with their own current visit', async () => {
      const tech = await get('/admin/customers?search=Orlan%20damp', { 'x-test-role': 'technician', 'x-test-tech': techId });
      expect(names(tech.body.customers)).toEqual(['Orlan Stimpf']);
      expect(tech.body.customers[0].approximate).toBe(true);
      expect(tech.body.total).toBe(0);
      const admin = await get('/admin/customers?search=Orlan%20damp');
      expect(names(admin.body.customers)).toEqual(expect.arrayContaining(['Orlan Stompf', 'Orlan Stimpf']));
    });

    test('a technician with no visits gets nothing', async () => {
      const tech = await get('/admin/customers?search=Orlan%20damp', { 'x-test-role': 'technician', 'x-test-tech': randomUUID() });
      expect(tech.body.customers).toEqual([]);
      expect(tech.body.approximateCount).toBe(0);
    });
  });

  describe('gate on: GET /admin/schedule/list', () => {
    beforeEach(() => { process.env.GATE_CUSTOMER_SEARCH_FUZZY = 'true'; });

    test('upcoming appointments of sound-alike customers follow the exact rows; total stays exact', async () => {
      const { body } = await get(`/admin/schedule/list?search=Orlan%20damp&from=${futureDate(0)}`);
      expect(body.total).toBe(0);
      expect(body.services.length).toBe(2);
      expect(body.services.every((row) => row.approximate === true)).toBe(true);
      expect(body.approximateCount).toBe(2);
      expect(body.services.map((row) => row.customerName).sort()).toEqual(['Orlan Stimpf', 'Orlan Stompf']);
    });

    test('exact rows come first and are unchanged', async () => {
      delete process.env.GATE_CUSTOMER_SEARCH_FUZZY;
      const off = await get(`/admin/schedule/list?search=Stompf&from=${futureDate(0)}`);
      process.env.GATE_CUSTOMER_SEARCH_FUZZY = 'true';
      const on = await get(`/admin/schedule/list?search=Stompf&from=${futureDate(0)}`);
      expect(off.body.services.map((row) => row.customerName)).toEqual(['Orlan Stompf']);
      expect(on.body.services.slice(0, off.body.services.length)).toEqual(off.body.services);
      expect(on.body.services.slice(off.body.services.length).map((row) => row.customerName)).toEqual(['Orlan Stimpf']);
      expect(on.body.total).toBe(off.body.total);
    });

    test('the row cap keeps the best-ranked customer first: a lower-ranked customer\'s many visits cannot hide it', async () => {
      const first = (await get('/admin/customers?search=Orlan%20damp')).body.customers.map((row) => row.id);
      expect(first.length).toBe(2);
      const [best, second] = first;
      // 30 early visits for the second-ranked customer; the best match has one, later.
      await db('scheduled_services').insert(Array.from({ length: 30 }, (_, n) => ({
        customer_id: second, technician_id: techId, scheduled_date: futureDate(10 + n), service_type: 'Lawn Care', status: 'confirmed',
      })));
      await db('scheduled_services').where({ customer_id: best }).update({ scheduled_date: futureDate(90) });
      try {
        const { body } = await get(`/admin/schedule/list?search=Orlan%20damp&from=${futureDate(0)}`);
        expect(body.services.length).toBe(25);
        expect(body.services[0].customerId).toBe(best);
        expect(body.services.filter((row) => row.customerId === second).length).toBe(24);
      } finally {
        await db('scheduled_services').where({ customer_id: second, service_type: 'Lawn Care' }).del();
      }
    });

    test('a technician only gets their own assigned appointments', async () => {
      const { body } = await get(`/admin/schedule/list?search=Orlan%20damp&from=${futureDate(0)}`, { 'x-test-role': 'technician', 'x-test-tech': techId });
      expect(body.services.map((row) => row.customerName)).toEqual(['Orlan Stimpf']);
      expect(body.services[0].approximate).toBe(true);
    });

    test('no search: no new keys', async () => {
      const { body } = await get(`/admin/schedule/list?from=${futureDate(0)}`);
      expect(body).not.toHaveProperty('approximateCount');
    });
  });

  describe('candidate budget and the shared name index', () => {
    const BUDGET_TAG = `${tag}-budget`;
    const lastId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    beforeAll(async () => {
      // 501 customers with the same sound-alike name; only the last one by id is Platinum.
      const rows = Array.from({ length: 500 }, (_, n) => ({
        first_name: 'Zara', last_name: 'Quillfern', phone: `+1555${String(8000000 + n)}`, company_name: BUDGET_TAG, active: true,
      }));
      rows.push({ id: lastId, first_name: 'Zara', last_name: 'Quillfern', phone: '+15558009999', company_name: BUDGET_TAG, active: true, waveguard_tier: 'Platinum' });
      await db('customers').insert(rows);
    });
    afterAll(async () => { await db('customers').where({ company_name: BUDGET_TAG }).del(); });
    beforeEach(() => { process.env.GATE_CUSTOMER_SEARCH_FUZZY = 'true'; });

    test('filters apply before the candidate budget is used up: 501 matching names, a filter allowing only the last', async () => {
      const { body } = await get('/admin/customers?search=Zara%20Quilfern&tier=Platinum');
      expect(body.customers.map((row) => row.id)).toEqual([lastId]);
      expect(body.customers[0].approximate).toBe(true);
    });

    const liveCount = async () => Number((await db('customers').whereNull('deleted_at').count('* as n').first()).n);
    const cachedEntries = async () => (await require('../services/intelligence-bar/name-match').cachedNameIndex('customers:live', () => { throw new Error('index should be cached'); })).entries.length;
    const warmLikeTheBar = () => {
      const { nameCandidates, NAME_INDEX_BOOK_CAP } = require('../services/intelligence-bar/tools');
      return require('../services/intelligence-bar/name-match')
        .cachedNameIndex('customers:live', () => nameCandidates(db('customers').whereNull('customers.deleted_at'), NAME_INDEX_BOOK_CAP));
    };

    test('either caller warms the same whole-book index: picker first, then the Bar', async () => {
      const fillers = Array.from({ length: 20100 }, (_, n) => ({
        first_name: `Filler${n}`, last_name: 'Cap', phone: `+1556${String(n).padStart(7, '0')}`, company_name: BUDGET_TAG, active: true,
      })); // more than the old 20,000 picker cap
      for (let at = 0; at < fillers.length; at += 2000) await db('customers').insert(fillers.slice(at, at + 2000));
      const total = await liveCount();
      expect(total).toBeGreaterThan(20000);
      resetNameIndexCache();
      await get('/admin/customers?search=Orlan%20damp');
      expect(await cachedEntries()).toBe(total);
      await warmLikeTheBar(); // already cached: the Bar reads the picker's index
      expect(await cachedEntries()).toBe(total);
    });

    test('either caller warms the same whole-book index: the Bar first, then the picker', async () => {
      const total = await liveCount();
      resetNameIndexCache();
      await warmLikeTheBar();
      expect(await cachedEntries()).toBe(total);
      const { body } = await get('/admin/customers?search=Orlan%20damp');
      expect(names(body.customers)).toEqual(expect.arrayContaining(['Orlan Stompf']));
      expect(await cachedEntries()).toBe(total);
    });
  });

  describe('performance on 20,000 customers', () => {
    const PERF_TAG = `${tag}-perf`;
    const syllables = ['ba', 'ke', 'ri', 'mon', 'tal', 'dor', 'fen', 'lu', 'sha', 'vin', 'co', 'pe', 'gar', 'hen', 'jo', 'wil', 'nor', 'sti', 'tre', 'qua'];
    const word = (n) => {
      let out = '';
      let v = n;
      for (let i = 0; i < 3; i += 1) { out += syllables[v % syllables.length]; v = Math.floor(v / syllables.length) + i; }
      return out[0].toUpperCase() + out.slice(1);
    };

    beforeAll(async () => {
      const rows = [];
      for (let n = 0; n < 20000; n += 1) {
        rows.push({
          first_name: word(n * 7 + 1), last_name: word(n * 13 + 5), phone: `+1555${String(n).padStart(7, '0')}`.slice(0, 20),
          company_name: PERF_TAG, active: true,
        });
      }
      for (let at = 0; at < rows.length; at += 2000) await db('customers').insert(rows.slice(at, at + 2000));
    });
    afterAll(async () => { await db('customers').where({ company_name: PERF_TAG }).del(); });

    test('the sound-alike pass adds well under 100 ms once the name index is warm', async () => {
      const search = encodeURIComponent('Orlan damp');
      const time = async () => {
        const started = process.hrtime.bigint();
        await get(`/admin/customers?search=${search}`);
        return Number(process.hrtime.bigint() - started) / 1e6;
      };
      // Warm the route (plans, pools) and the name index.
      delete process.env.GATE_CUSTOMER_SEARCH_FUZZY;
      await time();
      process.env.GATE_CUSTOMER_SEARCH_FUZZY = 'true';
      resetNameIndexCache();
      const cold = await time();
      const offRuns = [];
      const onRuns = [];
      for (let i = 0; i < 7; i += 1) {
        delete process.env.GATE_CUSTOMER_SEARCH_FUZZY;
        offRuns.push(await time());
        process.env.GATE_CUSTOMER_SEARCH_FUZZY = 'true';
        onRuns.push(await time());
      }
      const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
      const added = median(onRuns) - median(offRuns);
      console.info(`[fuzzy perf] 20,000 customers: cold ${cold.toFixed(0)} ms (first call after a restart or 5 minutes), warm median +${added.toFixed(0)} ms (off ${median(offRuns).toFixed(0)}, on ${median(onRuns).toFixed(0)})`);
      expect(added).toBeLessThan(100);
      expect(cold).toBeLessThan(2500);
    });
  });
});
