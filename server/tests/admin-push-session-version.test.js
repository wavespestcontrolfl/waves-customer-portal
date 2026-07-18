jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ listTriggers: jest.fn(() => []) }));
jest.mock('../services/push-notifications', () => ({
  status: jest.fn(() => ({ available: false, configured: false })),
  sendToAdminUser: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  staffTokenVersionMatches: (token, tech) => (
    token?.type === 'access'
    && Number.isInteger(token.tokenVersion)
    && token.tokenVersion === Number(tech?.auth_token_version)
  ),
}));

const db = require('../models/db');
const { subscribe } = require('../routes/admin-push')._handlers;

function builder({ first, rows = [], returning = [], updateResult = 1 } = {}) {
  const query = {};
  for (const method of ['forUpdate', 'insert', 'orderBy', 'where', 'whereIn', 'whereRaw']) {
    query[method] = jest.fn(() => query);
  }
  query.first = jest.fn(async () => first);
  query.returning = jest.fn(async () => returning);
  query.update = jest.fn(async () => updateResult);
  query.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  query.catch = (reject) => Promise.resolve(rows).catch(reject);
  return query;
}

function installTransaction(steps) {
  const remaining = [...steps];
  const trx = jest.fn((table) => {
    const step = remaining.shift();
    if (!step) throw new Error(`Unexpected transaction query: ${table}`);
    expect(table).toBe(step.table);
    return step.query;
  });
  db.transaction.mockImplementation(async (callback) => callback(trx));
  return { trx, remaining };
}

function request(tokenVersion = 7) {
  return {
    body: {
      subscription: { endpoint: 'https://push.example/device', keys: { auth: 'a' } },
      deviceInfo: 'Browser device',
    },
    headers: { 'user-agent': 'Test browser' },
    technicianId: 'tech-1',
    staffToken: { type: 'access', tokenVersion },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('admin push staff-session binding', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects a request whose staff version rotated after middleware auth', async () => {
    const technician = builder({
      first: {
        id: 'tech-1', active: true, role: 'admin', auth_token_version: 8,
        must_change_password: false,
      },
    });
    const tx = installTransaction([{ table: 'technicians', query: technician }]);
    const res = response();
    const next = jest.fn();

    await subscribe(request(7), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');
    expect(technician.forUpdate).toHaveBeenCalled();
    expect(tx.trx).toHaveBeenCalledTimes(1);
  });

  test('stores the current credential version on a new subscription', async () => {
    const technician = builder({
      first: {
        id: 'tech-1', active: true, role: 'technician', auth_token_version: 7,
        must_change_password: false,
      },
    });
    const lookup = builder({ rows: [] });
    const insert = builder({ returning: [{ id: 'sub-1' }] });
    installTransaction([
      { table: 'technicians', query: technician },
      { table: 'push_subscriptions', query: lookup },
      { table: 'push_subscriptions', query: insert },
    ]);
    const res = response();

    await subscribe(request(), res, jest.fn());

    expect(res.body).toEqual({ ok: true, id: 'sub-1' });
    expect(insert.insert).toHaveBeenCalledWith(expect.objectContaining({
      admin_user_id: 'tech-1',
      role: 'technician',
      active: true,
      staff_token_version: 7,
    }));
  });

  test('reactivation refreshes the version and deactivates endpoint duplicates', async () => {
    const technician = builder({
      first: {
        id: 'tech-1', active: true, role: 'admin', auth_token_version: 7,
        must_change_password: false,
      },
    });
    const lookup = builder({ rows: [{ id: 'sub-1' }, { id: 'sub-duplicate' }] });
    const keep = builder();
    const duplicates = builder();
    installTransaction([
      { table: 'technicians', query: technician },
      { table: 'push_subscriptions', query: lookup },
      { table: 'push_subscriptions', query: keep },
      { table: 'push_subscriptions', query: duplicates },
    ]);
    const res = response();

    await subscribe(request(), res, jest.fn());

    expect(res.body).toEqual({ ok: true, id: 'sub-1', reactivated: true });
    expect(keep.update).toHaveBeenCalledWith(expect.objectContaining({
      active: true,
      staff_token_version: 7,
    }));
    expect(duplicates.whereIn).toHaveBeenCalledWith('id', ['sub-duplicate']);
    expect(duplicates.update).toHaveBeenCalledWith({ active: false });
  });
});
