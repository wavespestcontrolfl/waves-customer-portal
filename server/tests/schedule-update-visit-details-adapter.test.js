/**
 * updateVisitDetails (routes/admin-schedule.js) — the Schedule-screen visit
 * edit without an HTTP request, for the Intelligence Bar's
 * reprice_future_visits tool (owner ruling 2026-10-07). It must run the SAME
 * handler as PUT /:id/update-details: these cases pin that the router-level
 * catalog prime runs, the handler's refusal comes back with its own status
 * and body, the handler reads the visit id from params, and an error it hands
 * to next() rejects. Harness from schedule-create-booking-adapter.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));

const db = require('../models/db');
const { updateVisitDetails } = require('../routes/admin-schedule');

function chain(row, seen) {
  const builder = {};
  const self = () => builder;
  for (const m of ['whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orderBy', 'limit', 'select', 'forUpdate', 'forShare', 'leftJoin', 'join', 'andWhere', 'orWhere', 'modify', 'clone']) {
    builder[m] = jest.fn(self);
  }
  builder.where = jest.fn((arg) => { if (arg && typeof arg === 'object') seen.push(arg); return builder; });
  builder.first = jest.fn().mockResolvedValue(row);
  builder.columnInfo = jest.fn().mockResolvedValue({});
  builder.then = (resolve, reject) => Promise.resolve(row === undefined ? [] : [row]).then(resolve, reject);
  return builder;
}

let seen;
beforeEach(() => {
  jest.clearAllMocks();
  seen = [];
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.mockImplementation(() => chain(undefined, seen));
});

const actor = { technicianId: 'staff-1' };

describe('updateVisitDetails runs the PUT /:id/update-details handler', () => {
  // First: the catalog prime is TTL-cached, so only the first call reads it.
  test('runs the router-level percent-discount catalog prime before the handler', async () => {
    await updateVisitDetails({ id: 'visit-1', body: { estimatedPrice: -1 }, actor });
    expect(db.raw).toHaveBeenCalledWith('select service_key, engine_keys from services where engine_keys is not null');
  });

  test("a refusal comes back with the handler's status and body", async () => {
    const result = await updateVisitDetails({ id: 'visit-1', body: { estimatedPrice: -1 }, actor });
    expect(result.status).toBe(422);
    expect(result.json).toEqual({ error: expect.any(String), code: 'NEGATIVE_PRICE' });
  });

  test('the handler reads the visit from the id it is given', async () => {
    const result = await updateVisitDetails({ id: 'visit-404', body: { scheduledDate: '2099-07-01' }, actor });
    expect(result).toEqual({ status: 404, json: { error: 'Service not found' } });
    expect(seen).toContainEqual({ id: 'visit-404' });
  });

  test('an error the handler passes to next() rejects', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(updateVisitDetails({ id: 'visit-1', body: { estimatedPrice: 49 }, actor })).rejects.toThrow('db down');
  });
});
