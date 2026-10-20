process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// codex #6343 r14: the fence compares the document's own input, the payload the
// headless page renders, built by the REAL composeEstimateDataPayload (not a
// stand-in) over a light database fake. Covers: an unchanged estimate hashes the
// same across builds; each input the document prints (linked customer contact,
// a line-item edit, billing, the linked appointment) changes the hash; the
// per-request fields are the only ones that differ between two payloads.
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  mock.schema = { hasTable: jest.fn(async () => false), hasColumn: jest.fn(async () => true) };
  return mock;
});
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn((gate) => gate === 'estimateCommercialGlass' || gate === 'estimateDocPdf'),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({ getCachedLookup: jest.fn().mockResolvedValue(null) }));
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

const db = require('../models/db');
const estimatePublic = require('../routes/estimate-public');
const emailPdf = require('../services/estimate-email-pdf');

let dbRows = {};
let writes = [];
function chainFor(table, result) {
  const chain = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNotIn', 'whereNotNull', 'whereRaw', 'whereNot', 'andWhere', 'orWhere', 'orWhereRaw', 'leftJoin', 'select', 'orderBy', 'limit']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.first = jest.fn(async () => result);
  chain.update = jest.fn(async () => { writes.push(`${table}.update`); return 1; });
  chain.insert = jest.fn(async () => { writes.push(`${table}.insert`); return [1]; });
  chain.then = undefined;
  return chain;
}
db.mockImplementation((table) => chainFor(table, dbRows[table]));

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

function estimateRow(overrides = {}) {
  return {
    id: 'est-doc-input', token: 'docinputtoken', status: 'sent', sent_at: null, viewed_at: null,
    expires_at: '2099-01-01T00:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z',
    customer_id: 'cust-1', customer_name: 'Pat Tester', customer_phone: null, customer_email: 'pat@example.com',
    address: '123 Trust Ln, Bradenton, FL 34203', satellite_url: null, waveguard_tier: 'Bronze', bill_by_invoice: false,
    monthly_total: 0, annual_total: 4459.16, onetime_total: 95,
    estimate_data: { proposal: PROPOSAL },
    ...overrides,
  };
}
const customer = (overrides = {}) => ({
  id: 'cust-1', first_name: 'Pat', last_name: 'Tester', email: 'pat@example.com', phone: '9415550101',
  address_line1: '123 Trust Ln', city: 'Bradenton', state: 'FL', zip: '34203', ...overrides,
});

const hash = (row, opts) => emailPdf.documentInputHash(structuredClone(row), opts);

beforeEach(() => {
  writes = [];
  dbRows = { estimates: estimateRow(), customers: customer() };
});

describe('the document input hash (codex #6343 r14)', () => {
  test('an unchanged estimate hashes the same across builds, and the pdf pass writes nothing', async () => {
    const row = estimateRow();
    const first = await hash(row);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await hash(row);
    expect(second).toBe(first);
    expect(await hash(row)).toBe(first);
    expect(writes).toEqual([]);
  });

  test('the row handed in is never touched', async () => {
    const row = estimateRow();
    const before = JSON.stringify(row);
    await hash(row);
    expect(JSON.stringify(row)).toBe(before);
  });

  test('the only fields that differ between two payloads of the same unchanged estimate are the per-request ones', async () => {
    const compose = async () => estimatePublic.composeEstimateDataPayload(estimateRow(), { isPdfRenderPass: true, docRenderPin: { validThrough: null } });
    const first = await compose();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await compose();
    const diff = [];
    const walk = (a, b, path) => {
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path}.${key}`);
      } else if (JSON.stringify(a) !== JSON.stringify(b)) diff.push(path);
    };
    walk(first, second, '');
    expect(diff.sort()).toEqual(['.estimate.askToken', '.meta.generatedAt']);
    // And neither is in the projection.
    const projected = JSON.stringify(emailPdf.documentInputProjection(first));
    expect(projected).not.toContain(first.estimate.askToken);
    expect(projected).not.toContain(first.meta.generatedAt);
  });

  test('a customer phone edit on the linked customer, behind a blank phone on the estimate, changes the hash', async () => {
    const before = await hash(estimateRow());
    dbRows.customers = customer({ phone: '9415550199' });
    expect(await hash(estimateRow())).not.toBe(before);
  });

  test('a customer name or address edit behind blank estimate fields changes it too', async () => {
    const row = estimateRow({ customer_name: '', address: '' });
    const before = await hash(row);
    dbRows.customers = customer({ first_name: 'Patricia' });
    const renamed = await hash(row);
    expect(renamed).not.toBe(before);
    dbRows.customers = customer({ first_name: 'Patricia', address_line1: '9 Elsewhere Rd' });
    expect(await hash(row)).not.toBe(renamed);
  });

  test('a line-item edit changes it', async () => {
    const before = await hash(estimateRow());
    const edited = structuredClone(PROPOSAL);
    edited.buildings[0].lineItems[1].unitPrice = 120;
    expect(await hash(estimateRow({ estimate_data: { proposal: edited } }))).not.toBe(before);
  });

  test('a billing change on the customer (a new monthly membership) changes it', async () => {
    const before = await hash(estimateRow());
    dbRows.customers = customer({ pipeline_stage: 'active_customer', monthly_rate: 59, billing_mode: 'monthly_membership' });
    const member = await hash(estimateRow());
    expect(member).not.toBe(before);
    dbRows.customers = customer({ pipeline_stage: 'active_customer', monthly_rate: 59, billing_mode: 'per_application' });
    expect(await hash(estimateRow())).not.toBe(member);
  });

  test('a linked appointment appearing, then moving, changes it', async () => {
    // A plain recurring estimate (a commercial proposal is quote-required, which hides any appointment).
    // Its own id: the pricing bundle is cached per estimate id for a few minutes.
    const row = estimateRow({
      id: 'est-doc-input-appt', monthly_total: 55, annual_total: 660, onetime_total: 0,
      estimate_data: {
        scheduled_service_id: 'appt-1',
        lineItems: [{ displayName: 'Pest Control', monthlyPrice: 55 }],
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', mo: 55 }] } },
      },
    });
    const before = await hash(row);
    const appt = (overrides = {}) => ({
      id: 'appt-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: '2099-05-01', window_start: '09:00:00', window_end: '11:00:00',
      service_type: 'Quarterly Pest Control', source_estimate_id: 'est-doc-input-appt', ...overrides,
    });
    dbRows.scheduled_services = appt();
    const booked = await hash(row);
    expect(booked).not.toBe(before);
    expect(await hash(row)).toBe(booked);
    dbRows.scheduled_services = appt({ scheduled_date: '2099-05-02' });
    expect(await hash(row)).not.toBe(booked);
  });

  test('a satellite image change changes it', async () => {
    const before = await hash(estimateRow());
    const url = 'https://maps.googleapis.com/maps/api/staticmap?center=27.4,-82.5&zoom=19&size=640x640&maptype=satellite';
    expect(await hash(estimateRow({ satellite_url: url }))).not.toBe(before);
  });

  test('the pinned valid-through date is part of it; the delivery send leaves the printed date out', async () => {
    const row = estimateRow();
    const a = await hash(row, { validThrough: '2099-02-01T00:00:00.000Z' });
    const b = await hash(row, { validThrough: '2099-03-01T00:00:00.000Z' });
    expect(a).not.toBe(b);
    expect(await hash(row, { validThrough: '2099-02-01T00:00:00.000Z', omitExpiry: true }))
      .toBe(await hash(row, { validThrough: '2099-03-01T00:00:00.000Z', omitExpiry: true }));
  });
});
