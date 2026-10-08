// GET /api/admin/protocols/lawn/window serves the staged v13 window from the database. After
// 20261007175000 the rows of the four count-capped products carry the cap (gates.annualMaxApps and
// annual_counter.maxApplications), so the schedule cards, reports and field screens can show it.
// Runs against the migrated test database (read only); self-skips without DATABASE_URL.
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const CAPPED = ['Celsius WG', 'Certainty Turf Herbicide', 'Blindside Herbicide', 'Arena 50 WDG'];

describeDb('GET /lawn/window carries the v13 count caps', () => {
  const saved = process.env.GATE_LAWN_V13;
  let router;
  let db;
  beforeAll(() => { db = require('../models/db'); router = require('../routes/admin-protocols'); });
  afterAll(async () => {
    if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
    await db.destroy();
  });

  async function windowFor(date, grassTrack) {
    const layer = router.stack.find((l) => l.route && l.route.path === '/lawn/window' && l.route.methods.get);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
    await handler({ query: { date, grassTrack } }, res, (err) => { throw err; });
    return res;
  }

  test.each(['2026-02-10', '2026-05-12', '2026-06-16'])('%s: every capped product in the window carries annualMaxApps 2 and maxApplications 2', async (date) => {
    process.env.GATE_LAWN_V13 = 'true';
    const res = await windowFor(date, 'st_augustine');
    expect(res.statusCode).toBe(200);
    const products = res.body.context.products.filter((p) => CAPPED.includes(p.protocolProductName));
    expect(products.length).toBeGreaterThan(0);
    for (const product of products) {
      expect(product.gates.annualMaxApps).toBe(2);
      expect(product.annualCounter.maxApplications).toBe(2);
    }
  });

  test('Blindside, the after-cap weed spot, is listed in a Celsius window as a spot row (never a default) with its cap', async () => {
    process.env.GATE_LAWN_V13 = 'true';
    const res = await windowFor('2026-03-10', 'st_augustine');
    const names = res.body.context.products.map((p) => p.protocolProductName);
    expect(names).toContain('Celsius WG');
    const blindside = res.body.context.products.find((p) => p.protocolProductName === 'Blindside Herbicide');
    expect(blindside).toMatchObject({ role: 'post_emergent_spot', applicationMode: 'spot', defaultInPlan: false });
    expect(blindside.gates).toMatchObject({ trigger: 'celsius_annual_cap_reached', annualMaxApps: 2 });
    expect(blindside.annualCounter.maxApplications).toBe(2);
  });

  // Owner 2026-10-08 (20261008120000): February weed spots are Celsius alone; Blindside is a November-through-March product.
  test.each([['2026-02-10', ['Celsius WG']], ['2026-05-12', ['Celsius WG', 'Certainty Turf Herbicide', 'LESCO 90/10 Nonionic Surfactant']]])('%s: the weed products the window lists after the weed-season retirement', async (date, expected) => {
    process.env.GATE_LAWN_V13 = 'true';
    const res = await windowFor(date, 'st_augustine');
    const weed = res.body.context.products.map((p) => p.protocolProductName)
      .filter((name) => ['Celsius WG', 'Certainty Turf Herbicide', 'LESCO 90/10 Nonionic Surfactant', 'Blindside Herbicide'].includes(name));
    expect(weed.sort()).toEqual([...expected].sort());
  });

  test('a product that is not capped carries none', async () => {
    process.env.GATE_LAWN_V13 = 'true';
    const res = await windowFor('2026-05-12', 'st_augustine');
    for (const product of res.body.context.products.filter((p) => !CAPPED.includes(p.protocolProductName))) {
      expect(product.gates.annualMaxApps).toBeUndefined();
    }
  });
});
