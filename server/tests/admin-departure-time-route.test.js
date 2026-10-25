/**
 * GET/PUT /admin/schedule/departure-time: the Settings → Scheduling "Day start"
 * control. Drives the handlers on router.stack against a mocked db (the repo
 * convention for admin-schedule.js, see admin-schedule-checkout-stacking-gate).
 */
const mockState = { row: undefined, readError: null, inserts: [], merges: [] };
const mockDb = jest.fn((table) => {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => {
    if (mockState.readError) throw mockState.readError;
    return table === 'system_settings' ? mockState.row : undefined;
  });
  q.insert = jest.fn((row) => { mockState.inserts.push({ table, row }); return q; });
  q.onConflict = jest.fn(() => q);
  q.merge = jest.fn(async (patch) => { mockState.merges.push(patch); });
  return q;
});
mockDb.fn = { now: jest.fn(() => 'NOW') };
jest.mock('../models/db', () => mockDb);

const adminScheduleRouter = require('../routes/admin-schedule');

function handlerFor(method) {
  const layer = adminScheduleRouter.stack.find(
    (l) => l.route && l.route.path === '/departure-time' && l.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function run(method, body) {
  const req = { body, params: {}, query: {}, headers: {} };
  const res = {
    statusCode: 200,
    body: undefined,
    status: jest.fn(function status(c) { this.statusCode = c; return this; }),
    json: jest.fn(function json(b) { this.body = b; return this; }),
  };
  const next = jest.fn();
  return handlerFor(method)(req, res, next).then(() => ({ res, next }));
}

const GATE = 'GATE_AUTO_DISPATCH_DAY_RULES';
let priorGate;
beforeEach(() => {
  priorGate = process.env[GATE];
  delete process.env[GATE];
  mockState.row = undefined;
  mockState.readError = null;
  mockState.inserts = [];
  mockState.merges = [];
  jest.clearAllMocks();
});
afterEach(() => {
  if (priorGate === undefined) delete process.env[GATE];
  else process.env[GATE] = priorGate;
});

describe('GET /departure-time', () => {
  it('reports 07:30 and saved false before anyone saves a time', async () => {
    const { res } = await run('get');
    expect(res.body).toEqual({
      departureTime: '07:30', saved: false, inUse: false, earliest: '06:00', latest: '08:00', stepMinutes: 15,
    });
  });

  it('reports the saved time', async () => {
    mockState.row = { value: '"07:00"' };
    const { res } = await run('get');
    expect(res.body.departureTime).toBe('07:00');
    expect(res.body.saved).toBe(true);
  });

  it('reports 08:00 for a saved value that is not valid', async () => {
    mockState.row = { value: '"07:10"' };
    const { res } = await run('get');
    expect(res.body.departureTime).toBe('08:00');
    expect(res.body.saved).toBe(true);
  });

  it('inUse follows the gate', async () => {
    process.env[GATE] = 'true';
    expect((await run('get')).res.body.inUse).toBe(true);
    delete process.env[GATE];
    expect((await run('get')).res.body.inUse).toBe(false);
  });

  it('passes a failed read to next', async () => {
    mockState.readError = new Error('db down');
    const { res, next } = await run('get');
    expect(next).toHaveBeenCalledWith(mockState.readError);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('PUT /departure-time', () => {
  it('stores the time as a JSON string and returns it', async () => {
    process.env[GATE] = 'true';
    const { res } = await run('put', { departureTime: '07:00' });
    expect(res.body).toEqual({ success: true, departureTime: '07:00', inUse: true });
    expect(mockState.inserts).toHaveLength(1);
    expect(mockState.inserts[0].table).toBe('system_settings');
    expect(mockState.inserts[0].row).toMatchObject({
      key: 'schedule_departure_time', value: '"07:00"', category: 'scheduling',
    });
    expect(mockState.merges[0]).toEqual({ value: '"07:00"', updated_at: 'NOW' });
  });

  it.each([
    ['07:10', '07:10'],
    ['05:45', '05:45'],
    ['08:15', '08:15'],
    ['a number', 700],
    ['an array', ['07:00']],
    ['missing', undefined],
  ])('rejects %s without writing', async (_label, departureTime) => {
    const { res } = await run('put', departureTime === undefined ? {} : { departureTime });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'departureTime must be a time from 06:00 to 08:00 in 15-minute steps' });
    expect(mockState.inserts).toHaveLength(0);
  });
});
