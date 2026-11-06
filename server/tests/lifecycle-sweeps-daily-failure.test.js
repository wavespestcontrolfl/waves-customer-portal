/**
 * runDailySweeps runs all three sweeps every day (a persistent failure in one
 * must not stall the others), then throws when any failed, so the cron's
 * runExclusive records the job as failed in job_health. A single acceptance
 * row's failure inside a sweep is not a sweep failure.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn() };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-acceptance-record', () => ({ attachAcceptanceOwnership: jest.fn() }));

const db = require('../models/db');
const { runDailySweeps } = require('../services/lifecycle-email-sweeps');

function tables({ termite_bonds = false, estimate_acceptances = false } = {}) {
  const asked = [];
  db.schema.hasTable.mockImplementation(async (name) => {
    asked.push(name);
    const answer = { termite_bonds, estimate_acceptances }[name];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return asked;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runDailySweeps', () => {
  test('a failed bond sweep still runs the other two, then rejects naming it', async () => {
    const asked = tables({ termite_bonds: new Error('connection lost') });
    await expect(runDailySweeps()).rejects.toThrow('lifecycle-email-sweeps: 1 of 3 sweep(s) failed (bond renewal)');
    // Ownership and copy sweeps each checked their table after the bond sweep failed.
    expect(asked.filter((t) => t === 'estimate_acceptances')).toHaveLength(2);
  });

  test('two failed sweeps are both named, and no error text reaches the message', async () => {
    tables({ estimate_acceptances: new Error('boom for pat@example.com') });
    await expect(runDailySweeps()).rejects.toThrow(/^lifecycle-email-sweeps: 2 of 3 sweep\(s\) failed \(acceptance ownership, acceptance copies\)$/);
  });

  test('three clean sweeps resolve with their counts', async () => {
    tables();
    await expect(runDailySweeps()).resolves.toEqual({ bondRenewalsSent: 0, acceptanceOwnershipAttached: 0, acceptanceCopiesSent: 0 });
  });

  test("one acceptance row's failure is not a sweep failure", async () => {
    tables({ estimate_acceptances: true });
    const builder = (rows, first) => {
      const q = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return rows ? (resolve, reject) => Promise.resolve(rows).then(resolve, reject) : undefined;
          if (prop === 'first') return first || (() => q);
          return () => q;
        },
      });
      return q;
    };
    db.mockImplementation((table) => {
      if (table === 'estimates') return builder(null, () => Promise.reject(new Error('estimate read failed')));
      if (table === 'estimate_acceptances') return builder([{ id: 'a1', estimate_id: 'e1', terms_version: 1 }]);
      return builder([]);
    });
    await expect(runDailySweeps()).resolves.toMatchObject({ acceptanceOwnershipAttached: 0 });
  });
});
