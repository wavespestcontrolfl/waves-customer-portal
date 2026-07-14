const mockReopenStoppedEntryInTransaction = jest.fn();

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn();
  return db;
});
jest.mock('../services/time-tracking', () => ({
  reopenStoppedEntryInTransaction: (...args) => mockReopenStoppedEntryInTransaction(...args),
}));
jest.mock('../services/geofence-matcher', () => ({ logEvent: jest.fn() }));
jest.mock('../services/geofence-handler', () => ({
  markOnPropertyFromGeofence: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const db = require('../models/db');
const router = require('../routes/tech-notifications');

function routeHandler(method, routePath) {
  const layer = router.stack.find(candidate => (
    candidate.route?.path === routePath && candidate.route.methods[method]
  ));
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function responseDouble() {
  const res = {
    json: jest.fn(),
    status: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

function lockedNotificationQuery(row) {
  const query = {};
  query.where = jest.fn(() => query);
  query.forUpdate = jest.fn(() => query);
  query.first = jest.fn(async () => row);
  return query;
}

function claimNotificationQuery() {
  const predicates = [];
  const query = { predicates };
  query.where = jest.fn((predicate) => {
    predicates.push(predicate);
    return query;
  });
  query.whereNull = jest.fn(() => query);
  query.update = jest.fn(async () => (
    predicates.some(predicate => predicate.read === false) ? 0 : 1
  ));
  return query;
}

describe('tech stop-notification undo', () => {
  const handler = routeHandler('post', '/:id/undo-stop');

  beforeEach(() => {
    db.mockReset();
    db.transaction.mockReset();
    mockReopenStoppedEntryInTransaction.mockReset();
  });

  test('allows undo after an auto-dismiss read receipt has already committed', async () => {
    const row = {
      id: 'notification-1',
      technician_id: 'tech-1',
      type: 'geofence_timer_stopped',
      read: true,
      dismissed_at: null,
      created_at: new Date(),
      payload: { time_entry_id: 'entry-1' },
    };
    const lockedQuery = lockedNotificationQuery(row);
    const claimQuery = claimNotificationQuery();
    const trx = jest.fn()
      .mockImplementationOnce(() => lockedQuery)
      .mockImplementationOnce(() => claimQuery);
    db.transaction.mockImplementation(async callback => callback(trx));
    const reopened = { id: 'entry-1', status: 'active' };
    mockReopenStoppedEntryInTransaction.mockResolvedValue(reopened);
    const res = responseDouble();
    const next = jest.fn();

    await handler({
      params: { id: 'notification-1' },
      technicianId: 'tech-1',
    }, res, next);

    expect(mockReopenStoppedEntryInTransaction).toHaveBeenCalledWith(
      trx,
      'tech-1',
      'entry-1',
    );
    expect(claimQuery.predicates).toEqual([{
      id: 'notification-1',
      technician_id: 'tech-1',
    }]);
    expect(claimQuery.whereNull).toHaveBeenCalledWith('dismissed_at');
    expect(res.json).toHaveBeenCalledWith({ timeEntry: reopened });
    expect(res.status).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('keeps explicit dismissal terminal for undo', async () => {
    const row = {
      id: 'notification-1',
      technician_id: 'tech-1',
      type: 'geofence_timer_stopped',
      read: true,
      dismissed_at: new Date(),
      created_at: new Date(),
      payload: { time_entry_id: 'entry-1' },
    };
    const trx = jest.fn(() => lockedNotificationQuery(row));
    db.transaction.mockImplementation(async callback => callback(trx));
    const res = responseDouble();
    const next = jest.fn();

    await handler({
      params: { id: 'notification-1' },
      technicianId: 'tech-1',
    }, res, next);

    expect(mockReopenStoppedEntryInTransaction).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Stop notification was already handled',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
