/**
 * The home quote with the REAL engine input builder and the REAL dry run of the shared estimate save, and no database:
 * the save's one database use here is syncConstantsFromDB (the live price list), which is replaced, so the engine prices
 * on its built-in constants. The test pins the shape of the answer (a server price of one pest line, the engine digest,
 * the setup fee field), never an amount. Every other database read of the save is skipped or fail-soft for a body with
 * no customer; a database handle that throws on any use proves it (see the one read below).
 */
jest.mock('../models/db', () => {
  const db = jest.fn(() => { throw new Error('this test has no database'); });
  db.transaction = jest.fn(() => { throw new Error('this test has no database'); });
  db.raw = jest.fn(() => { throw new Error('this test has no database'); });
  return db;
});
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../services/logger', () => mockLogger);

const pricingEngine = require('../services/pricing-engine');
const db = require('../models/db');
const { priceHome } = require('../services/mail/home-quote');

const row = { id: 'row-1', address_line1: '101 EXAMPLE TRL', city: 'SAMPLETON', state: 'FL', zip: '34212' };
const facts = { homeSqft: 1800, homeSqftSource: 'parcel_map', stories: 1, lotSqft: 8000 };

// The default wiring (the real builder and the real dry run), with the dry run's body kept for inspection.
function realDeps() {
  const bodies = [];
  const { createOrReuseAdminEstimate } = require('../services/admin-estimate-persistence');
  return {
    bodies,
    deps: {
      dryRunEstimate: (body) => {
        bodies.push(body);
        return createOrReuseAdminEstimate({ database: db, body, technicianId: null, technician: null, dryRun: true, requireLivePricing: true });
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(pricingEngine, 'syncConstantsFromDB').mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());

describe('the real engine input and the real dry run of the estimate save, with no database', () => {
  test('a home with every fact is a clean server price of one pest line, with a digest and no customer in the body', async () => {
    const t = realDeps();
    const result = await priceHome(row, facts, t.deps);
    expect(result).toMatchObject({ status: 'priced', ...facts });
    expect(result.priceAnnual).toBeGreaterThan(0);
    expect(result.priceSetupFee).toBeGreaterThanOrEqual(0);
    expect(result.priceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(t.bodies[0]).not.toHaveProperty('customerName');
    expect(t.bodies[0].estimateData.engineInputs.services.pest).toMatchObject({ frequency: 'quarterly' });
    // The dry run wrote nothing and opened no transaction.
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
    // The one read the save makes without a customer is its fail-soft check for a member at this address (a read of
    // customers); the handle's refusal is swallowed, and the answer carries no warning.
    expect(db.mock.calls.length).toBeLessThanOrEqual(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test('a permit plan size prices on the permit-plan source', async () => {
    const result = await priceHome(row, { ...facts, homeSqft: 2100, homeSqftSource: 'permit_plan' }, realDeps().deps);
    expect(result).toMatchObject({ status: 'priced', homeSqft: 2100, homeSqftSource: 'permit_plan' });
  });

  test('the default wiring builds the engine input and runs the dry run itself', async () => {
    const result = await priceHome(row, facts);
    expect(result).toMatchObject({ status: 'priced', homeSqft: 1800 });
  });

  test('the live price list unavailable refuses the save (503): failed / engine, tried again later', async () => {
    pricingEngine.syncConstantsFromDB.mockResolvedValue(false);
    expect(await priceHome(row, facts, realDeps().deps)).toEqual({ status: 'failed', reason: 'engine', ...facts });
  });
});
