/**
 * /api/tech/answers — dark behind GATE_TECH_INSTANT_ANSWERS. The visit filter
 * is always the signed-in technician's id, for an admin login too.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../config/feature-gates', () => ({ techInstantAnswersLive: jest.fn(() => true) }));
jest.mock('../services/previsit-brief', () => ({ deterministicVisitFacts: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { techInstantAnswersLive } = require('../config/feature-gates');
const { deterministicVisitFacts } = require('../services/previsit-brief');
const router = require('../routes/tech-answers');

function handlerFor(path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
  return layer.route.stack[0].handle;
}
function res() {
  const r = { statusCode: 200, body: null };
  r.status = jest.fn((c) => { r.statusCode = c; return r; });
  r.json = jest.fn((b) => { r.body = b; return r; });
  return r;
}
async function get(path, req = {}) {
  const r = res();
  const next = jest.fn();
  await handlerFor(path)({ technicianId: 'tech-1', techRole: 'technician', params: {}, ...req }, r, next);
  return { r, next };
}

let wheres;
function primeDb(rows) {
  wheres = [];
  db.raw = jest.fn((sql) => sql);
  db.mockImplementation(() => {
    const chain = {
      leftJoin: () => chain,
      where: (col, val) => { wheres.push([col, val]); return chain; },
      whereRaw: () => chain,
      orderByRaw: () => chain,
      select: async () => rows,
    };
    return chain;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  techInstantAnswersLive.mockReturnValue(true);
  primeDb([]);
});

describe('gate off', () => {
  test('both routes answer 404 and touch nothing', async () => {
    techInstantAnswersLive.mockReturnValue(false);
    const index = await get('/');
    expect(index.r.statusCode).toBe(404);
    expect(index.r.body).toEqual({ error: 'Not found' });
    const one = await get('/:kind', { params: { kind: 'next_stop' } });
    expect(one.r.statusCode).toBe(404);
    expect(one.r.body).toEqual({ error: 'Not found' });
    expect(db).not.toHaveBeenCalled();
  });
});

describe('gate on', () => {
  test('GET / lists the three kinds with labels', async () => {
    const { r } = await get('/');
    expect(r.body).toEqual({
      kinds: [
        { kind: 'next_stop', label: 'Next stop' },
        { kind: 'access_notes', label: 'Access notes' },
        { kind: 'last_treatment', label: 'Last treatment' },
      ],
    });
  });

  test('an unknown kind is a 400 and reads nothing', async () => {
    for (const kind of ['nope', '__proto__', 'constructor']) {
      const { r } = await get('/:kind', { params: { kind } });
      expect(r.statusCode).toBe(400);
    }
    expect(db).not.toHaveBeenCalled();
  });

  test('a known kind returns { kind, title, lines, visitId }', async () => {
    primeDb([{ id: 'v1', customer_id: 'c1', status: 'confirmed', service_type: 'Lawn Care', window_start: '10:00:00', window_end: '12:00:00', first_name: 'Pat', last_name: 'Sample', address_line1: '12 Example Way', city: 'Venice' }]);
    const { r } = await get('/:kind', { params: { kind: 'next_stop' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({
      kind: 'next_stop',
      title: 'Next stop',
      visitId: 'v1',
      lines: ['Customer: Pat Sample', 'Address: 12 Example Way, Venice', 'Window: 10:00 AM–12:00 PM', 'Service: Lawn Care'],
    });
  });

  test('no stop today answers 200 with a null visit id', async () => {
    const { r } = await get('/:kind', { params: { kind: 'last_treatment' } });
    expect(r.body).toEqual({ kind: 'last_treatment', title: 'No stop', lines: ['No more stops on your route today.'], visitId: null });
    expect(deterministicVisitFacts).not.toHaveBeenCalled();
  });

  test('an admin login is still scoped to its own technician id', async () => {
    await get('/:kind', { params: { kind: 'next_stop' }, technicianId: 'admin-tech', techRole: 'admin' });
    expect(wheres).toContainEqual(['scheduled_services.technician_id', 'admin-tech']);
  });

  test('a failure logs the code only and passes a sanitized 500 on', async () => {
    db.mockImplementation(() => { throw Object.assign(new Error('select where customer Pat Sample failed'), { code: '57P01' }); });
    const { r, next } = await get('/:kind', { params: { kind: 'next_stop' } });
    expect(r.json).not.toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err).toMatchObject({ statusCode: 500, isOperational: true, code: '57P01', message: 'Tech answers next_stop failed' });
    expect(logger.error).toHaveBeenCalledWith('[tech-answers] next_stop failed (57P01)');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('Pat Sample');
  });
});
