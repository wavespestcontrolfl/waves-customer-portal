// The card-fee rails and the deferred-replay registry destructure
// scheduledServiceApptTime from the REAL reminders module at call time, but
// every test that exercises them mocks that module — so an export that only
// existed on the _test bag shipped to prod for three weeks and every secured
// visit's cancel preview fell into its fail-closed "fee may apply" branch
// (2026-09-03). This test loads the real module and checks the contract.
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where: jest.fn().mockReturnThis(), first: jest.fn(async () => null) }));
  db.raw = jest.fn();
  db.fn = { now: jest.fn() };
  return db;
});

describe('appointment-reminders public exports', () => {
  test('scheduledServiceApptTime is a real export (not only on _test)', () => {
    const mod = require('../services/appointment-reminders');
    expect(typeof mod.scheduledServiceApptTime).toBe('function');
  });
});
