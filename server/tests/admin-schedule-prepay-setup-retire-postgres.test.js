'use strict';

// The real staff booking route with real PostgreSQL rows. The success case
// runs the real acceptance/converter hand-off; only the conflict controls
// replace acceptance to model impossible or competing ledger outcomes.
// External payment infrastructure and post-response communications stay out
// of this focused regression.
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref', 'destroy']) {
    db[name] = (...args) => mockPg[name](...args);
  }
  for (const name of ['schema', 'fn', 'client']) {
    Object.defineProperty(db, name, { get: () => mockPg[name] });
  }
  return db;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(async () => null),
}));

const knex = require('knex');
const { randomUUID } = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');
const acceptance = require('../services/estimate-manual-acceptance');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg;
let trx;

jest.setTimeout(120000);

const day = (offset) => etDateString(addETDays(new Date(), offset));
const FALSE_DOUBLE_CHARGE_WARNING = 'The estimate acceptance covered the bait-station setup, but the booking-time setup stamp had already been consumed or changed — check the customer for a second setup charge and clear or refund it.';

const COMMERCIAL_RODENT_DATA = {
  commercialEstimatedPricing: true,
  engineRequest: { profile: { commercialRiskType: 'warehouse_distribution' } },
  customerSelection: { frequency: 'quarterly' },
  setupFeeQuote: { kind: 'rodent_bait_setup', amount: 55 },
  result: {
    totals: { year2mo: 55, year2: 660 },
    lineItems: [
      {
        name: 'Commercial Rodent Bait Stations', service: 'commercial_rodent_bait',
        frequency: 'quarterly', visitsPerYear: 4, monthly: 55, annual: 660,
        monthlyAfterDiscount: 55, annualAfterDiscount: 660,
        taxable: true, discountable: false, excludeFromPctDiscount: true, isCommercial: true,
      },
      { name: 'Bait Station Setup', service: 'rodent_bait_setup', price: 55, taxable: true },
    ],
    recurring: {
      discount: 0,
      monthlyTotal: 55,
      grandTotal: 55,
      services: [{
        name: 'Commercial Rodent Bait Stations', service: 'commercial_rodent_bait',
        frequency: 'quarterly', visitsPerYear: 4, mo: 55, annual: 660,
        perTreatment: 165, taxable: true, discountable: false,
        excludeFromPctDiscount: true, isCommercial: true,
      }],
    },
    oneTime: {
      items: [{ name: 'Bait Station Setup', service: 'rodent_bait_setup', price: 55 }],
      membershipFee: 0,
    },
  },
};

async function fixture() {
  const customerId = randomUUID();
  const estimateId = randomUUID();
  const decoyRootId = randomUUID();
  await trx('customers').insert({
    id: customerId,
    first_name: 'Synthetic',
    last_name: 'Staff Prepay',
    phone: `+1202555${String(parseInt(customerId.slice(0, 8), 16) % 10000).padStart(4, '0')}`,
    email: `${customerId}@example.invalid`,
    property_type: 'commercial',
  });
  await trx('estimates').insert({
    id: estimateId,
    customer_id: customerId,
    status: 'sent',
    category: 'COMMERCIAL',
    monthly_total: 55,
    annual_total: 660,
    estimate_data: COMMERCIAL_RODENT_DATA,
    token: randomUUID(),
    expires_at: new Date(Date.now() + 14 * 86400000),
  });
  // Valid FK target for the wrong-root control; terminal + unrelated so it
  // cannot participate in the recurring duplicate-series guard.
  await trx('scheduled_services').insert({
    id: decoyRootId,
    customer_id: customerId,
    service_type: 'Synthetic unrelated completed visit',
    scheduled_date: day(-10),
    status: 'completed',
    is_recurring: false,
  });
  const service = await trx('services').where({ service_key: 'rodent_bait_quarterly' }).first('id');
  if (!service) throw new Error('rodent_bait_quarterly catalog fixture missing');
  return { customerId, estimateId, decoyRootId, serviceId: service.id };
}

async function deletedBookedOwnerFixture() {
  const customerId = randomUUID();
  const invoiceId = randomUUID();
  const termId = randomUUID();
  const claimId = randomUUID();
  const soldRootId = randomUUID();
  const neighborRootId = randomUUID();
  const neighborInvoiceId = randomUUID();
  const neighborClaimId = randomUUID();
  await trx('customers').insert({
    id: customerId,
    first_name: 'Synthetic',
    last_name: 'Deleted Setup Owner',
    phone: `+1202555${String(parseInt(customerId.slice(0, 8), 16) % 10000).padStart(4, '0')}`,
    email: `${customerId}@example.invalid`,
    property_type: 'commercial',
    billing_mode: 'annual_prepay',
  });
  const service = await trx('services').where({ service_key: 'rodent_bait_quarterly' }).first('id');
  if (!service) throw new Error('rodent_bait_quarterly catalog fixture missing');
  await trx('scheduled_services').insert([
    {
      id: soldRootId,
      customer_id: customerId,
      service_id: service.id,
      service_type: 'Commercial Rodent Bait Stations',
      scheduled_date: day(-10),
      status: 'completed',
      estimated_price: 55,
      is_recurring: true,
      recurring_pattern: 'quarterly',
      service_address_line1: '55 Deleted Sold Root Way',
    },
    {
      id: neighborRootId,
      customer_id: customerId,
      service_id: service.id,
      service_type: 'Commercial Rodent Bait Stations',
      scheduled_date: day(14),
      status: 'confirmed',
      estimated_price: 73,
      pending_setup_fee: 73,
      is_recurring: true,
      recurring_pattern: 'quarterly',
      service_address_line1: '73 Neighbor Property Road',
    },
  ]);
  const setupLine = (amount) => JSON.stringify([{
    description: 'Bait Station Setup — one-time setup fee',
    quantity: 1,
    unit_price: amount,
    amount,
  }]);
  await trx('invoices').insert([
    {
      id: invoiceId,
      token: randomUUID(),
      invoice_number: `DELETED-${invoiceId.slice(0, 8)}`,
      customer_id: customerId,
      title: 'Commercial Rodent Bait Stations — Annual Prepay',
      status: 'paid',
      paid_at: new Date(),
      subtotal: 55,
      total: 55,
      due_date: day(-10),
      line_items: setupLine(55),
    },
    {
      id: neighborInvoiceId,
      token: randomUUID(),
      invoice_number: `NEIGHBOR-${neighborInvoiceId.slice(0, 8)}`,
      customer_id: customerId,
      scheduled_service_id: neighborRootId,
      title: 'Neighbor setup',
      status: 'draft',
      subtotal: 73,
      total: 73,
      due_date: day(14),
      line_items: setupLine(73),
    },
  ]);
  await trx('annual_prepay_terms').insert({
    id: termId,
    customer_id: customerId,
    prepay_invoice_id: invoiceId,
    plan_label: 'Commercial Rodent Bait Stations',
    monthly_rate: 55,
    prepay_amount: 55,
    term_start: day(-30),
    term_end: day(335),
    status: 'active',
    coverage_service_type: 'Commercial Rodent Bait Stations',
    coverage_visit_count: 4,
    coverage_cadence: 'quarterly',
    commercial_setup_series_root_id: soldRootId,
  });
  await trx('setup_fee_claims').insert([
    {
      id: claimId,
      invoice_id: invoiceId,
      scheduled_service_id: soldRootId,
      amount: 55,
      unbooked_commercial_setup: false,
    },
    {
      id: neighborClaimId,
      invoice_id: neighborInvoiceId,
      scheduled_service_id: neighborRootId,
      amount: 73,
      unbooked_commercial_setup: false,
    },
  ]);
  await trx('scheduled_services').where({ id: soldRootId }).delete();
  expect(await trx('setup_fee_claims').where({ id: claimId }).first('scheduled_service_id'))
    .toEqual({ scheduled_service_id: null });
  return {
    customerId, invoiceId, termId, claimId, soldRootId,
    neighborRootId, neighborInvoiceId, neighborClaimId, serviceId: service.id,
  };
}

async function invokeStaffBooking(ids) {
  const route = require('../routes/admin-schedule').stack.find(
    ({ route: candidate }) => candidate?.path === '/' && candidate.methods.post,
  );
  const req = {
    headers: {},
    technicianId: null,
    body: {
      customerId: ids.customerId,
      sourceEstimateId: ids.estimateId,
      serviceType: 'Commercial Rodent Bait Stations',
      serviceId: ids.serviceId,
      scheduledDate: day(7),
      isRecurring: true,
      recurringPattern: 'quarterly',
      recurringCount: 4,
      allowDuplicateSeries: true,
      assignmentMode: 'unassigned',
      createInvoice: true,
      estimatedPrice: 165,
      primaryLinePrice: 165,
      billingTerm: 'prepay_annual',
      prepayVisitCount: 4,
      sendConfirmationSms: false,
      sendTechNotification: false,
    },
  };
  const next = jest.fn();
  let postResponse;
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) {
      this.body = body;
      if (this.statusCode === 201) {
        postResponse = jest.spyOn(global, 'setImmediate').mockImplementationOnce(() => null);
      }
      return this;
    },
  };
  try {
    await route.route.stack.at(-1).handle(req, res, next);
  } finally {
    postResponse?.mockRestore();
  }
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  expect({ status: res.statusCode, error: res.body?.error }).toEqual({ status: 201, error: undefined });
  return res.body;
}

async function invokeDirectStaffBooking(ids) {
  const route = require('../routes/admin-schedule').stack.find(
    ({ route: candidate }) => candidate?.path === '/' && candidate.methods.post,
  );
  const req = {
    headers: {},
    technicianId: null,
    body: {
      customerId: ids.customerId,
      serviceType: 'Commercial Rodent Bait Stations',
      serviceId: ids.serviceId,
      scheduledDate: day(7),
      isRecurring: true,
      recurringPattern: 'quarterly',
      recurringCount: 2,
      allowDuplicateSeries: true,
      assignmentMode: 'unassigned',
      createInvoice: true,
      estimatedPrice: 55,
      primaryLinePrice: 55,
      sendConfirmationSms: false,
      sendTechNotification: false,
    },
  };
  const next = jest.fn();
  let postResponse;
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) {
      this.body = body;
      if (this.statusCode === 201) {
        postResponse = jest.spyOn(global, 'setImmediate').mockImplementationOnce(() => null);
      }
      return this;
    },
  };
  try {
    await route.route.stack.at(-1).handle(req, res, next);
  } finally {
    postResponse?.mockRestore();
  }
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  expect({ status: res.statusCode, error: res.body?.error }).toEqual({ status: 201, error: undefined });
  return res.body;
}

function mockConverterHandoff(ids, {
  claimRoot = 'booked',
  claimAmount = 55,
  resultingStamp = null,
} = {}) {
  return jest.spyOn(acceptance, 'markEstimateManuallyAccepted').mockImplementation(async (opts) => {
    const rootId = opts.bookedAppointmentIds[0];
    const invoiceId = randomUUID();
    const claimRootId = claimRoot === 'booked' ? rootId : ids.decoyRootId;
    await mockPg('scheduled_services').where({ id: rootId }).update({
      pending_setup_fee: resultingStamp,
      updated_at: new Date(),
    });
    await mockPg('invoices').insert({
      id: invoiceId,
      token: randomUUID(),
      invoice_number: `HANDOFF-${invoiceId.slice(0, 8)}`,
      customer_id: ids.customerId,
      title: 'Commercial Rodent Bait Stations — Annual Prepay',
      status: 'draft',
      subtotal: 715,
      total: 715,
      due_date: day(0),
      line_items: JSON.stringify([
        { description: 'Annual prepay coverage', quantity: 1, unit_price: 660, amount: 660 },
        { description: 'Bait Station Setup — one-time setup fee', quantity: 1, unit_price: 55, amount: 55 },
      ]),
    });
    await mockPg('setup_fee_claims').insert({
      invoice_id: invoiceId,
      scheduled_service_id: claimRootId,
      estimate_id: ids.estimateId,
      amount: claimAmount,
      unbooked_commercial_setup: false,
    });
    await mockPg('estimates').where({ id: ids.estimateId }).update({
      status: 'accepted',
      accepted_at: new Date(),
      updated_at: new Date(),
    });
    return { conversion: { draftInvoiceId: invoiceId }, warnings: [] };
  });
}

postgres('staff prepay-on-book setup stamp hand-off', () => {
  beforeAll(() => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)
      || !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) {
      throw new Error('Staff booking tests require a private local waves_qa_<32 hex> PostgreSQL database.');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    mockPg = trx;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await trx.rollback();
    trx = null;
  });

  afterAll(async () => database?.destroy());

  test('a deleted sold root claim is not offered to or directly anchored on another root', async () => {
    const ids = await deletedBookedOwnerFixture();
    const probeRootId = randomUUID();
    await trx('scheduled_services').insert({
      id: probeRootId,
      customer_id: ids.customerId,
      service_id: ids.serviceId,
      service_type: 'Commercial Rodent Bait Stations',
      scheduled_date: day(7),
      status: 'confirmed',
      estimated_price: 55,
      is_recurring: true,
      recurring_pattern: 'quarterly',
    });
    const plans = require('../services/secure-appointment-plans');

    await expect(plans.liveAnchorlessCoverageSetupClaim(trx, {
      customerId: ids.customerId,
      rootId: probeRootId,
    })).resolves.toBeNull();
    await expect(plans.anchorSetupFeeClaim(trx, {
      claimId: ids.claimId,
      anchorId: probeRootId,
    })).resolves.toBe(false);
    expect(await trx('setup_fee_claims').where({ id: ids.claimId }).first())
      .toMatchObject({ invoice_id: ids.invoiceId, scheduled_service_id: null, amount: '55.00' });
    expect(await trx('scheduled_services').where({ id: probeRootId }).first('pending_setup_fee'))
      .toEqual({ pending_setup_fee: null });
    expect(await trx('scheduled_services').where({ id: ids.neighborRootId }).first('pending_setup_fee'))
      .toEqual({ pending_setup_fee: '73.00' });
  });

  test('ordinary residential coverage claims still anchor while source-owned commercial claims do not', async () => {
    const plans = require('../services/secure-appointment-plans');
    const customerId = randomUUID();
    const rootId = randomUUID();
    const invoiceId = randomUUID();
    const termId = randomUUID();
    const claimId = randomUUID();
    await trx('customers').insert({
      id: customerId,
      first_name: 'Synthetic',
      last_name: 'Residential Coverage',
      phone: `+1202555${String(parseInt(customerId.slice(0, 8), 16) % 10000).padStart(4, '0')}`,
      email: `${customerId}@example.invalid`,
      property_type: 'residential',
    });
    await trx('scheduled_services').insert({
      id: rootId,
      customer_id: customerId,
      service_type: 'Rodent Bait Stations',
      scheduled_date: day(7),
      status: 'confirmed',
      estimated_price: 55,
      is_recurring: true,
      recurring_pattern: 'quarterly',
    });
    await trx('invoices').insert({
      id: invoiceId,
      token: randomUUID(),
      invoice_number: `RES-${invoiceId.slice(0, 8)}`,
      customer_id: customerId,
      title: 'Rodent Bait Stations — Annual Prepay',
      status: 'paid',
      paid_at: new Date(),
      subtotal: 99,
      total: 99,
      due_date: day(0),
      line_items: JSON.stringify([{
        description: 'Bait Station Setup — one-time setup fee', quantity: 1, unit_price: 99, amount: 99,
      }]),
    });
    await trx('annual_prepay_terms').insert({
      id: termId,
      customer_id: customerId,
      prepay_invoice_id: invoiceId,
      plan_label: 'Rodent Bait Stations',
      prepay_amount: 99,
      term_start: day(-30),
      term_end: day(335),
      status: 'active',
      coverage_service_type: 'Rodent Bait Stations',
      coverage_visit_count: 4,
      coverage_cadence: 'quarterly',
    });
    await trx('setup_fee_claims').insert({
      id: claimId,
      invoice_id: invoiceId,
      scheduled_service_id: null,
      amount: 99,
      unbooked_commercial_setup: false,
    });
    await expect(plans.liveAnchorlessCoverageSetupClaim(trx, { customerId, rootId }))
      .resolves.toMatchObject({ id: claimId, invoice_id: invoiceId, amount: '99.00' });
    await expect(plans.anchorSetupFeeClaim(trx, { claimId, anchorId: rootId })).resolves.toBe(true);
    expect(await trx('setup_fee_claims').where({ id: claimId }).first('scheduled_service_id'))
      .toEqual({ scheduled_service_id: rootId });

    const sourceInvoiceId = randomUUID();
    const sourceClaimId = randomUUID();
    await trx('invoices').insert({
      id: sourceInvoiceId,
      token: randomUUID(),
      invoice_number: `SOURCE-${sourceInvoiceId.slice(0, 8)}`,
      customer_id: customerId,
      title: 'Invoice-owned commercial setup',
      status: 'paid',
      paid_at: new Date(),
      subtotal: 55,
      total: 55,
      due_date: day(0),
      line_items: '[]',
    });
    await trx('setup_fee_claims').insert({
      id: sourceClaimId,
      invoice_id: sourceInvoiceId,
      scheduled_service_id: null,
      amount: 55,
      unbooked_commercial_setup: true,
    });
    await expect(plans.anchorSetupFeeClaim(trx, { claimId: sourceClaimId, anchorId: rootId }))
      .resolves.toBe(false);
    expect(await trx('setup_fee_claims').where({ id: sourceClaimId }).first('scheduled_service_id'))
      .toEqual({ scheduled_service_id: null });
  });

  test('a real direct booking after sold-root deletion owes its own setup', async () => {
    const ids = await deletedBookedOwnerFixture();

    const response = await invokeDirectStaffBooking(ids);

    expect(response.warnings || []).not.toContain(FALSE_DOUBLE_CHARGE_WARNING);
    expect(await trx('scheduled_services').where({ id: response.id }).first('pending_setup_fee'))
      .toEqual({ pending_setup_fee: '99.00' });
    expect(await trx('setup_fee_claims').where({ id: ids.claimId }).first())
      .toMatchObject({ invoice_id: ids.invoiceId, scheduled_service_id: null, amount: '55.00' });
    expect(await trx('scheduled_services').where({ id: ids.neighborRootId }).first('pending_setup_fee'))
      .toEqual({ pending_setup_fee: '73.00' });
    expect(await trx('setup_fee_claims').where({ id: ids.neighborClaimId }).first())
      .toMatchObject({ scheduled_service_id: ids.neighborRootId, amount: '73.00' });
  }, 420000);

  test('the converter-cleared stamp with the live same-invoice claim on the booked root is success', async () => {
    const ids = await fixture();

    const response = await invokeStaffBooking(ids);

    expect(response.annualPrepay).toEqual(expect.objectContaining({ applied: true }));
    expect(response.warnings).not.toContain(FALSE_DOUBLE_CHARGE_WARNING);
    expect(await trx('scheduled_services').where({ id: response.id }).first('pending_setup_fee'))
      .toEqual({ pending_setup_fee: null });
    expect(await trx('setup_fee_claims').where({ invoice_id: response.annualPrepay.invoiceId }).first())
      .toMatchObject({
        scheduled_service_id: response.id,
        amount: '55.00',
        estimate_id: ids.estimateId,
      });
  }, 240000);

  test.each([
    ['another root owns the claim', { claimRoot: 'decoy' }],
    ['the claim amount differs', { claimAmount: 54 }],
    ['a different stamp survived', { resultingStamp: 60 }],
  ])('%s still raises the existing double-charge warning', async (_label, handoff) => {
    const ids = await fixture();
    mockConverterHandoff(ids, handoff);

    const response = await invokeStaffBooking(ids);

    expect(response.warnings).toContain(FALSE_DOUBLE_CHARGE_WARNING);
  });
});
