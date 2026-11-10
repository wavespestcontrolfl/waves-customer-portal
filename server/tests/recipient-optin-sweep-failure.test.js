/**
 * The 15-minute recipient opt-in cron (runRecipientOptinSweeps). A failed
 * candidate read used to return an empty result, so job_health recorded
 * success. Now each sweep rethrows the failed read, the cron body still runs
 * the other sweep, and throws after both. One recipient's failed dispatch is
 * not a job failure.
 */
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn(async () => undefined);
  db.raw = jest.fn((sql) => sql);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  onSiteCallerDemoteLive: jest.fn(() => true),
}));

const db = require('../models/db');
const optin = require('../services/recipient-optin');

// A chainable query stub: every builder method returns the chain; the named
// terminal methods settle with the given handler.
function chain(handlers = {}) {
  const q = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (handlers[prop]) return handlers[prop];
      return () => q;
    },
  });
  return q;
}

const readFails = () => Promise.reject(Object.assign(new Error('connection lost'), { code: '57P01' }));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runRecipientOptinSweeps', () => {
  // The undispatched sweep ends its candidate read with .limit(); the follow-up
  // sweep's read goes through .groupBy() first. Each read is counted and may fail.
  function sweepReads({ failUndispatched = false, failFollowUp = false } = {}) {
    const reads = { undispatched: 0, followUp: 0 };
    const settle = (name, fail) => () => {
      reads[name] += 1;
      return fail ? readFails() : Promise.resolve([]);
    };
    db.mockImplementation(() => chain({
      limit: settle('undispatched', failUndispatched),
      groupBy: () => chain({ limit: settle('followUp', failFollowUp) }),
    }));
    return reads;
  }

  test('a failed read in the first sweep still runs the second sweep, then rejects', async () => {
    const reads = sweepReads({ failUndispatched: true });
    await expect(optin.runRecipientOptinSweeps()).rejects.toThrow('recipient-optin-sweep: 1 step(s) failed (undispatched asks)');
    // The follow-up sweep ran its own read after the first sweep failed.
    expect(reads.followUp).toBe(1);
    expect(reads.undispatched).toBeGreaterThan(0);
  });

  test('a failed read in the second sweep rejects after the first sweep ran', async () => {
    const reads = sweepReads({ failFollowUp: true });
    await expect(optin.runRecipientOptinSweeps()).rejects.toThrow('recipient-optin-sweep: 1 step(s) failed (on-site follow-ups)');
    expect(reads.followUp).toBe(1);
    expect(reads.undispatched).toBeGreaterThan(0);
  });

  test('two clean sweeps resolve', async () => {
    const reads = sweepReads();
    await expect(optin.runRecipientOptinSweeps()).resolves.toBeUndefined();
    expect(reads.followUp).toBe(1);
    expect(reads.undispatched).toBeGreaterThan(0);
  });

  test('both sweeps failing names both steps, with no row data in the message', async () => {
    db.mockImplementation(() => chain({ limit: readFails, groupBy: () => chain({ limit: readFails }) }));
    await expect(optin.runRecipientOptinSweeps()).rejects.toThrow(/^recipient-optin-sweep: 2 step\(s\) failed \(undispatched asks, on-site follow-ups\)$/);
  });

  test("one recipient's failed dispatch is not a job failure", async () => {
    db.mockImplementation((table) => {
      if (table === 'recipient_optin') {
        return chain({ limit: async () => [{ id: 'r1', customer_id: 'c1', phone_key: '5550100123' }] });
      }
      if (table === 'customers') return chain({ first: () => Promise.reject(new Error('customer read failed')) });
      return chain({ limit: async () => [] });
    });
    // The undispatched sweep logs the row's failure and moves on; the follow-up
    // sweep's read then returns the same row list as customers to settle (none).
    await expect(optin.sweepUndispatchedOptins()).resolves.toEqual({ swept: 0 });
  });
});
