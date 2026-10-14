// GET /api/admin/protocols/completion-actions, /lawn/active and /lawn/window with GATE_LAWN_V13 on: Celsius and Blindside are not
// labeled for bahiagrass, so v13 has no bahia track (owner 2026-10-06). An explicit bahia lawn gets the
// same no-program answer here as in the plan, never the St. Augustine chips; mixed and unknown lawns
// keep the one-program fallback; with the gate off the old bahia track still answers.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireAdmin: jest.fn(), requireTechOrAdmin: jest.fn(),
}));

const db = require('../models/db');
const adminProtocolsRouter = require('../routes/admin-protocols');

const handler = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/completion-actions' && layer.route.methods.get).route.stack[0].handle;

function readQuery(rows) {
  const query = {};
  for (const method of ['where', 'orWhere', 'orWhereNull', 'whereIn', 'join', 'select', 'orderByRaw', 'orderBy']) query[method] = jest.fn(() => query);
  query.first = jest.fn(async () => rows[0] || null);
  query.catch = (onRejected) => Promise.resolve(rows).catch(onRejected);
  query.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return query;
}

async function completionActions(query) {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handler({ query: { serviceType: 'Lawn Care', month: '2', ...query } }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

beforeEach(() => {
  db.mockImplementation((table) => {
    if (table === 'products_catalog') return readQuery([]);
    if (table === 'product_aliases') return readQuery([]);
    throw new Error(`Unexpected table: ${table}`);
  });
});
afterEach(() => { delete process.env.GATE_LAWN_V13; });

test('gate on: an explicit bahia lawn gets a 404 no-program answer, never St. Augustine chips', async () => {
  process.env.GATE_LAWN_V13 = 'true';
  for (const key of ['lawnType', 'grassType', 'track']) {
    const res = await completionActions({ [key]: 'Argentine Bahia' });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'lawn_v13_bahia_no_program' }));
  }
});

test('gate on: mixed, unknown and unnamed lawns keep the one v13 program', async () => {
  process.env.GATE_LAWN_V13 = 'true';
  for (const query of [{ grassType: 'mixed' }, { grassType: 'unknown' }, {}]) {
    const res = await completionActions(query);
    expect(res.status).not.toHaveBeenCalled();
    expect(JSON.stringify(res.json.mock.calls[0][0])).toContain('Waves Lawn Program v13');
  }
});

test('gate on: the three v13 tracks answer', async () => {
  process.env.GATE_LAWN_V13 = 'true';
  for (const grassType of ['St. Augustine', 'bermuda', 'zoysia']) {
    const res = await completionActions({ grassType });
    expect(res.status).not.toHaveBeenCalled();
  }
});

test('gate off: the old bahia track still answers', async () => {
  const res = await completionActions({ grassType: 'bahia' });
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json.mock.calls[0][0]).toMatchObject({ track: 'bahia' });
});

// The structured readers never serve the staged bahia protocol (swfl_bahia_10_10) for planning.
describe.each([['/lawn/active'], ['/lawn/window']])('GET %s with GATE_LAWN_V13 on', (path) => {
  const route = adminProtocolsRouter.stack.find((layer) => layer.route?.path === path && layer.route.methods.get).route.stack[0].handle;

  test.each([['grassTrack'], ['grass_track']])('?%s=bahia is the same no-program 404, with no database read', async (param) => {
    process.env.GATE_LAWN_V13 = 'true';
    db.mockImplementation(() => { throw new Error('the staged bahia rows must not be read'); });
    const res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    const next = jest.fn();
    await route({ query: { [param]: 'bahia' } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// Every bahia spelling, in any of the three inputs, is the same no-program answer: decided on the raw
// inputs before an unknown value defaults to St. Augustine.
describe('completion-actions: every bahia spelling', () => {
  const BAHIA = ['D', 'd', 'd_bahia', 'D_Bahia', 'bahia', 'BAHIA', 'bahiagrass', 'Argentine Bahia', 'Pensacola'];

  test.each(BAHIA)('gate on: %s is a 404 no-program answer, in each input', async (value) => {
    process.env.GATE_LAWN_V13 = 'true';
    for (const key of ['lawnType', 'grassType', 'track']) {
      const res = await completionActions({ [key]: value });
      expect({ key, status: res.status.mock.calls[0]?.[0] }).toEqual({ key, status: 404 });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'lawn_v13_bahia_no_program' }));
    }
  });

  test('gate on: bahia in ANY input wins over another input that names a track', async () => {
    process.env.GATE_LAWN_V13 = 'true';
    const res = await completionActions({ lawnType: 'zoysia', grassType: 'D' });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test.each(['D', 'd_bahia'])('gate off: %s is the old bahia track, not St. Augustine', async (value) => {
    const res = await completionActions({ grassType: value });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0]).toMatchObject({ track: 'bahia' });
  });

  test('gate on: other grass is untouched', async () => {
    process.env.GATE_LAWN_V13 = 'true';
    for (const value of ['C1', 'zoysia', 'mixed', 'A']) {
      const res = await completionActions({ grassType: value });
      expect({ value, status: res.status.mock.calls[0]?.[0] }).toEqual({ value, status: undefined });
    }
  });
});
