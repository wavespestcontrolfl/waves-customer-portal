/**
 * GET /admin/protocols/job-card/:serviceId and /job-card/mix (GATE_JOB_CARD).
 *
 * Pins: the gate is read at call time and answers { enabled: false } with no
 * service work when off; the routes stay tech-accessible (no requireAdmin);
 * the literal /mix segment is registered before the :serviceId param; ids are
 * validated before any read; and the response carries codes only under
 * strip.access.codes.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// db is only touched by the technician ownership check: the chain resolves
// fn.ownedRow (a row = the tech owns the visit; null = not theirs).
jest.mock('../models/db', () => {
  const chain = {};
  for (const m of ['where', 'whereNotIn', 'whereILike', 'orWhereILike', 'orWhereNull', 'orderBy', 'limit']) chain[m] = () => chain;
  chain.select = (...cols) => { fn.selected = cols; return chain; };
  chain.modify = (fn2) => { fn2(chain); return chain; };
  chain.first = async () => fn.ownedRow;
  // Awaiting the chain (the product search) resolves fn.products.
  chain.then = (res, rej) => Promise.resolve(fn.products).then(res, rej);
  function fn() { return chain; }
  fn.ownedRow = null;
  fn.products = [];
  fn.selected = null;
  fn.raw = () => ({});
  fn.schema = { hasTable: async () => true };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-card', () => {
  const actual = jest.requireActual('../services/job-card');
  return {
    ...actual,
    buildJobCard: jest.fn(),
    mixForProduct: jest.fn(),
  };
});

const jobCard = require('../services/job-card');
const protocolsRouter = require('../routes/admin-protocols');

const SERVICE_ID = '11111111-2222-4333-8444-555555555555';

const layerFor = (path) => protocolsRouter.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);

async function run(path, query = {}) {
  const layer = layerFor(path);
  if (!layer) throw new Error(`route not found: GET ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { statusCode: 200, body: null, set: jest.fn(), status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const params = path.includes(':serviceId') ? { serviceId: query.serviceId } : {};
  await handler({ params, query, ...(query.__tech ? { techRole: 'technician', technicianId: 'tech-1' } : {}) }, res, (err) => { throw err; });
  return res;
}
const db = require('../models/db');

describe('job-card routes', () => {
  beforeEach(() => {
    delete process.env.GATE_JOB_CARD;
    delete process.env.GATE_DISPATCH_READINESS;
    jobCard.buildJobCard.mockReset();
    jobCard.mixForProduct.mockReset();
  });

  test('schedule readiness requires both gates and validates the bounded batch before reading', async () => {
    expect((await run('/job-card/readiness', { serviceIds: SERVICE_ID })).body).toEqual({ enabled: false });
    process.env.GATE_JOB_CARD = 'true';
    expect((await run('/job-card/readiness', { serviceIds: SERVICE_ID })).body).toEqual({ enabled: false });
    process.env.GATE_DISPATCH_READINESS = 'true';
    for (const serviceIds of ['', 'invalid', [SERVICE_ID], Array(7).fill(SERVICE_ID).join(',')]) {
      expect((await run('/job-card/readiness', { serviceIds })).statusCode).toBe(400);
    }
    expect(jobCard.buildJobCard).not.toHaveBeenCalled();
  });

  test('readiness deduplicates ids and uses the view without paragraph generation', async () => {
    process.env.GATE_JOB_CARD = 'true';
    process.env.GATE_DISPATCH_READINESS = 'true';
    const summary = { serviceId: SERVICE_ID, issues: [{ kind: 'weather', status: 'hold', label: 'Weather hold' }] };
    jobCard.buildJobCard.mockResolvedValue(summary);
    const response = await run('/job-card/readiness', { serviceIds: `${SERVICE_ID},${SERVICE_ID}` });
    expect(response.body).toEqual({ enabled: true, visits: [summary] });
    expect(jobCard.buildJobCard).toHaveBeenCalledTimes(1);
    expect(jobCard.buildJobCard).toHaveBeenCalledWith(SERVICE_ID, { readinessOnly: true });
    expect(response.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });

  test('readiness withholds another technician’s visit and a visit reassigned while building', async () => {
    process.env.GATE_JOB_CARD = 'true';
    process.env.GATE_DISPATCH_READINESS = 'true';
    db.ownedRow = null;
    const query = { serviceIds: SERVICE_ID, __tech: true };
    expect((await run('/job-card/readiness', query)).body.visits[0].issues[0].label).toBe('Check unavailable');
    expect(jobCard.buildJobCard).not.toHaveBeenCalled();
    db.ownedRow = { id: SERVICE_ID };
    jobCard.buildJobCard.mockImplementation(async () => { db.ownedRow = null; return { serviceId: SERVICE_ID, issues: [] }; });
    expect((await run('/job-card/readiness', query)).body.visits[0].issues[0].label).toBe('Check unavailable');
  });

  test('a failed readiness read stays unknown and a live kill withdraws the batch', async () => {
    process.env.GATE_JOB_CARD = 'true';
    process.env.GATE_DISPATCH_READINESS = 'true';
    jobCard.buildJobCard.mockRejectedValue(new Error('Source unavailable'));
    expect((await run('/job-card/readiness', { serviceIds: SERVICE_ID })).body.visits[0].issues[0].status).toBe('unknown');
    jobCard.buildJobCard.mockImplementation(async () => {
      delete process.env.GATE_DISPATCH_READINESS;
      return { serviceId: SERVICE_ID, issues: [] };
    });
    expect((await run('/job-card/readiness', { serviceIds: SERVICE_ID })).body).toEqual({ enabled: false });
  });

  test('the Tank search route: gate-off answers enabled:false; a 2+ char term returns id/name/category only (Codex r13 P1)', async () => {
    expect((await run('/job-card/products', { q: 'cel', __tech: true })).body).toEqual({ enabled: false, products: [] });
    process.env.GATE_JOB_CARD = 'true';
    expect((await run('/job-card/products', { q: 'c', __tech: true })).body).toEqual({ enabled: true, products: [] });
    db.products = [{ id: 'p1', name: 'Celsius WG', category: 'herbicide' }];
    const res = await run('/job-card/products', { q: 'cel', __tech: true });
    expect(res.body).toEqual({ enabled: true, products: db.products });
    // No rate or pricing columns leave this route.
    expect(db.selected).toEqual(['id', 'name', 'category']);
  });

  test('tech-accessible: neither route carries requireAdmin', () => {
    for (const path of ['/job-card/:serviceId', '/job-card/mix']) {
      expect(layerFor(path).route.stack.map((s) => s.handle.name)).not.toContain('requireAdmin');
    }
  });

  test('/job-card/mix is registered before /job-card/:serviceId', () => {
    const idx = (path) => protocolsRouter.stack.findIndex((l) => l.route && l.route.path === path);
    expect(idx('/job-card/mix')).toBeLessThan(idx('/job-card/:serviceId'));
  });

  test('gate off → { enabled: false } and no service call', async () => {
    const res = await run('/job-card/:serviceId', { serviceId: SERVICE_ID });
    expect(res.body).toEqual({ enabled: false });
    expect(jobCard.buildJobCard).not.toHaveBeenCalled();
    const mix = await run('/job-card/mix', { productId: SERVICE_ID, gallons: '110' });
    expect(mix.body).toEqual({ enabled: false });
    expect(jobCard.mixForProduct).not.toHaveBeenCalled();
  });

  test('gate on → card passes through; bad id is 400 before any read', async () => {
    process.env.GATE_JOB_CARD = 'true';
    jobCard.buildJobCard.mockResolvedValue({ enabled: true, strip: { access: { codes: [{ label: 'Property gate', code: '4545#' }] } }, paragraph: { text: 'Gate code on file.', source: 'template' } });
    const res = await run('/job-card/:serviceId', { serviceId: SERVICE_ID });
    expect(res.statusCode).toBe(200);
    expect(res.body.strip.access.codes[0].code).toBe('4545#');
    expect(res.body.paragraph.text).not.toContain('4545');
    const bad = await run('/job-card/:serviceId', { serviceId: 'nope' });
    expect(bad.statusCode).toBe(400);
    expect(jobCard.buildJobCard).toHaveBeenCalledTimes(1);
  });

  test('a technician token reads only its current assignment; admins are unscoped (PR r2 P1)', async () => {
    process.env.GATE_JOB_CARD = 'true';
    jobCard.buildJobCard.mockResolvedValue({ enabled: true, strip: { access: { codes: [] } } });
    jobCard.mixForProduct.mockResolvedValue({ amount: 1 });
    db.ownedRow = null;
    expect((await run('/job-card/:serviceId', { serviceId: SERVICE_ID, __tech: true })).statusCode).toBe(404);
    expect((await run('/job-card/mix', { serviceId: SERVICE_ID, productId: SERVICE_ID, gallons: '1', __tech: true })).statusCode).toBe(404);
    expect(jobCard.buildJobCard).not.toHaveBeenCalled();
    expect(jobCard.mixForProduct).not.toHaveBeenCalled();
    db.ownedRow = { id: SERVICE_ID };
    expect((await run('/job-card/:serviceId', { serviceId: SERVICE_ID, __tech: true })).statusCode).toBe(200);
    // Ownership lost between the build and the answer → withheld.
    jobCard.buildJobCard.mockImplementation(async () => { db.ownedRow = null; return { enabled: true, strip: { access: { codes: [{ code: '4545#' }] } } }; });
    expect((await run('/job-card/:serviceId', { serviceId: SERVICE_ID, __tech: true })).statusCode).toBe(404);
    // Admin: no db touch, straight through.
    jobCard.buildJobCard.mockResolvedValue({ enabled: true, strip: { access: { codes: [] } } });
    expect((await run('/job-card/:serviceId', { serviceId: SERVICE_ID })).statusCode).toBe(200);
  });

  test('a technician sees no vendor pricing; an admin does; a catalog outage is 503 on both routes (PR r4 P1/P2)', async () => {
    process.env.GATE_JOB_CARD = 'true';
    jobCard.buildJobCard.mockResolvedValue({ enabled: true, strip: { access: { codes: [] } } });
    jobCard.mixForProduct.mockResolvedValue({ amount: 1 });
    db.ownedRow = { id: SERVICE_ID };
    await run('/job-card/:serviceId', { serviceId: SERVICE_ID, __tech: true });
    expect(jobCard.buildJobCard).toHaveBeenLastCalledWith(SERVICE_ID, { includePricing: false });
    await run('/job-card/mix', { serviceId: SERVICE_ID, productId: SERVICE_ID, gallons: '1', __tech: true });
    expect(jobCard.mixForProduct).toHaveBeenLastCalledWith(SERVICE_ID, 1, { serviceId: SERVICE_ID, includePricing: false });
    await run('/job-card/:serviceId', { serviceId: SERVICE_ID });
    expect(jobCard.buildJobCard).toHaveBeenLastCalledWith(SERVICE_ID, { includePricing: true });
    const outage = Object.assign(new Error('Product catalog unavailable'), { statusCode: 503 });
    jobCard.mixForProduct.mockRejectedValue(outage);
    jobCard.buildJobCard.mockRejectedValue(outage);
    expect((await run('/job-card/mix', { serviceId: SERVICE_ID, productId: SERVICE_ID, gallons: '1' })).statusCode).toBe(503);
    expect((await run('/job-card/:serviceId', { serviceId: SERVICE_ID })).statusCode).toBe(503);
  });

  test('mix validates gallons and productId', async () => {
    process.env.GATE_JOB_CARD = 'true';
    jobCard.mixForProduct.mockResolvedValue({ amount: 0.75, unit: 'oz' });
    expect((await run('/job-card/mix', { serviceId: SERVICE_ID, productId: SERVICE_ID, gallons: '5' })).statusCode).toBe(400);
    expect((await run('/job-card/mix', { serviceId: SERVICE_ID, productId: 'x', gallons: '1' })).statusCode).toBe(400);
    // The visit's rig decides the carrier: no serviceId, no mix.
    expect((await run('/job-card/mix', { productId: SERVICE_ID, gallons: '1' })).statusCode).toBe(400);
    const ok = await run('/job-card/mix', { serviceId: SERVICE_ID, productId: SERVICE_ID, gallons: '1' });
    expect(ok.body).toEqual({ enabled: true, amount: 0.75, unit: 'oz' });
    expect(jobCard.mixForProduct).toHaveBeenCalledWith(SERVICE_ID, 1, { serviceId: SERVICE_ID, includePricing: true });
  });
});
