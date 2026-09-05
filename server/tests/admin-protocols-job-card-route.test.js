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

jest.mock('../models/db', () => {
  const fn = () => ({});
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
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const params = path.includes(':serviceId') ? { serviceId: query.serviceId } : {};
  await handler({ params, query }, res, (err) => { throw err; });
  return res;
}

describe('job-card routes', () => {
  beforeEach(() => {
    delete process.env.GATE_JOB_CARD;
    jobCard.buildJobCard.mockReset();
    jobCard.mixForProduct.mockReset();
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

  test('mix validates gallons and productId', async () => {
    process.env.GATE_JOB_CARD = 'true';
    jobCard.mixForProduct.mockResolvedValue({ amount: 0.75, unit: 'oz' });
    expect((await run('/job-card/mix', { serviceId: SERVICE_ID, productId: SERVICE_ID, gallons: '5' })).statusCode).toBe(400);
    expect((await run('/job-card/mix', { serviceId: SERVICE_ID, productId: 'x', gallons: '1' })).statusCode).toBe(400);
    // The visit's rig decides the carrier: no serviceId, no mix.
    expect((await run('/job-card/mix', { productId: SERVICE_ID, gallons: '1' })).statusCode).toBe(400);
    const ok = await run('/job-card/mix', { serviceId: SERVICE_ID, productId: SERVICE_ID, gallons: '1' });
    expect(ok.body).toEqual({ enabled: true, amount: 0.75, unit: 'oz' });
    expect(jobCard.mixForProduct).toHaveBeenCalledWith(SERVICE_ID, 1, { serviceId: SERVICE_ID });
  });
});
