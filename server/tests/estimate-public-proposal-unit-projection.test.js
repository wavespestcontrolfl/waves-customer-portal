process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// GET /:token/data projects the authored proposal field-by-field for the
// on-page glass render and the headless document. The reviewed unit label is
// part of the documented public contract (docs/public-route-contracts.md):
// without it a 14,768 sq ft × $0.0755 line renders as a bare number (GH codex
// P0 on #4305).
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => gate === 'estimateCommercialGlass'),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  getCachedLookup: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn().mockResolvedValue(null),
  publicMembershipView: jest.fn((snapshot) => snapshot ?? null),
}));
jest.mock('../services/estimate-deposits', () => ({
  ensureDepositSatisfied: jest.fn(),
  resolveDepositPolicyForEstimate: jest.fn().mockResolvedValue({ enforced: false, required: false, slotRequired: false }),
  computeDepositAmount: jest.fn(() => 0),
  pendingDepositCredit: jest.fn(),
  consumeDepositCredit: jest.fn(),
  refundUnconsumedDeposits: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const estimatePublicRouter = require('../routes/estimate-public');

let dbRows = {};
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereNotNull: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain),
    orWhere: jest.fn(() => chain),
    orWhereRaw: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(result),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([1]),
    then: undefined,
  };
  return chain;
}
db.mockImplementation((table) => chainFor(dbRows[table]));

const PROPOSAL = {
  enabled: true,
  title: 'Commercial Service Proposal',
  buildings: [{
    name: 'Synthetic slab',
    lineItems: [
      { description: 'Slab perimeter treatment', quantity: 14768, unit: 'sqft', unitPrice: 0.0755, frequency: 'quarterly', taxable: false },
      { description: 'Inspection', quantity: 1, unitPrice: 95, frequency: 'one_time', taxable: false },
    ],
  }],
};

function estimateRow() {
  return {
    id: 'est-unit-projection', token: 'unitprojectiontoken', status: 'sent', sent_at: null, viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester', customer_phone: null, customer_email: null,
    address: '123 Trust Ln, Bradenton, FL 34203', satellite_url: null, waveguard_tier: 'Bronze', bill_by_invoice: false,
    monthly_total: 0, annual_total: 4459.16, onetime_total: 95,
    estimate_data: { proposal: PROPOSAL },
  };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

describe('GET /:token/data — proposal line projection', () => {
  beforeEach(() => { dbRows = { estimates: estimateRow() }; });

  test('projects the reviewed unit with the decimal quantity, rate and cent-rounded amount', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data`);
      expect(res.status).toBe(200);
      const body = await res.json();
      const lines = body.proposal.buildings[0].lineItems;
      expect(lines[0]).toMatchObject({ description: 'Slab perimeter treatment', quantity: 14768, unit: 'sqft', unitPrice: 0.0755, amount: 1114.98, frequency: 'quarterly' });
      // Unit-less lines do not grow a null field.
      expect(lines[1]).not.toHaveProperty('unit');
      expect(lines[1]).toMatchObject({ quantity: 1, unitPrice: 95, amount: 95 });
    });
  });
});
