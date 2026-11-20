/**
 * Real migrated PostgreSQL coverage for the sale-time appointment fact.
 * All rows are synthetic and every test rolls back.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-commercial-prepay-sale-secret';
process.env.GATE_RATE_REVIEW = 'false';

let mockPg;

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
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = '00000000-0000-4000-8000-000000000001';
    req.techRole = 'admin';
    req.technician = { name: 'Synthetic Admin' };
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  existingShortUrlFor: jest.fn(async () => null),
  createShortCode: jest.fn(async (url) => ({ code: 'sale1', shortUrl: url })),
  createTrackedShortLink: jest.fn(async (url) => ({ code: 'sale1', shortUrl: url })),
  resolveShortCode: jest.fn(async () => null),
  invoiceShortCodePrefix: jest.fn(() => 'inv'),
}));
jest.mock('../services/notification-service', () => ({
  create: jest.fn(async () => ({ id: 'synthetic-notification' })),
  notifyAdmin: jest.fn(async () => ({})),
  notifyCustomer: jest.fn(async () => ({})),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn(async () => ({})),
}));
jest.mock('../services/receipt-delivery-queue', () => ({
  enqueueReceiptDelivery: jest.fn(async () => null),
  scheduleReceiptDeliveryDrain: jest.fn(),
}));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));

const express = require('express');
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;

jest.setTimeout(120000);

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

postgres('commercial setup sale records preserve the appointment choice', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  let invoiceSend;

  const termStart = () => etDateString(addETDays(new Date(), 2));
  const firstVisitDate = () => etDateString(addETDays(new Date(), 10));

  beforeAll(async () => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)
      || !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) {
      throw new Error('commercial-prepay sale tests require a private local waves_qa_<32 hex> database.');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    mockPg = database;
    if (!await database.schema.hasTable('knex_migrations')) throw new Error('Run development migrations first');

    const InvoiceService = require('../services/invoice');
    invoiceSend = jest.spyOn(InvoiceService, 'sendViaSMSAndEmail').mockResolvedValue({
      ok: true,
      payUrl: '/pay/synthetic-commercial-prepay',
      sms: { ok: false, skipped: true },
      email: { ok: false, skipped: true },
    });

    const app = express();
    app.use(express.json());
    app.use('/admin/customers', require('../routes/admin-customers'));
    app.use((err, _req, res, _next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    mockPg = trx;
  });

  afterEach(async () => {
    await trx?.rollback();
    trx = null;
    mockPg = database;
  });

  afterAll(async () => {
    invoiceSend?.mockRestore();
    if (server) await new Promise((resolve) => server.close(resolve));
    await database?.destroy();
  });

  async function customer() {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await trx('customers').insert({
      id,
      first_name: 'Synthetic',
      last_name: 'Standalone Dispatch',
      company_name: `Synthetic Warehouse ${tag}`,
      phone: `+1941555${String(parseInt(tag, 16) % 10000).padStart(4, '0')}`,
      email: `commercial-sale-${tag}@example.test`,
      property_type: 'commercial',
      active: true,
      address_line1: '123 Synthetic Commerce Way',
      city: 'Bradenton',
      state: 'FL',
      zip: '34205',
    });
    return id;
  }

  async function estimateFixture() {
    const customerId = await customer();
    const estimateId = randomUUID();
    await trx('estimates').insert({
      id: estimateId,
      customer_id: customerId,
      status: 'accepted',
      accepted_at: new Date(),
      token: randomUUID().replace(/-/g, ''),
      customer_name: 'Synthetic Standalone Dispatch',
      customer_phone: '+19415550199',
      customer_email: `${estimateId}@example.test`,
      address: '123 Synthetic Commerce Way, Bradenton, FL 34205',
      monthly_total: 55,
      annual_total: 660,
      onetime_total: 55,
      show_one_time_option: false,
      bill_by_invoice: false,
      category: 'COMMERCIAL',
      estimate_data: JSON.stringify(COMMERCIAL_RODENT_DATA),
      sent_at: new Date(),
    });
    return { customerId, estimateId };
  }

  async function catalogServiceId() {
    const row = await trx('services').where({ service_key: 'rodent_bait_quarterly' }).first('id');
    if (!row) throw new Error('rodent_bait_quarterly catalog row missing — run migrations');
    return row.id;
  }

  async function bookedRoot({ customerId, estimateId = null, pendingSetupFee = 55 }) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id,
      customer_id: customerId,
      service_id: await catalogServiceId(),
      service_type: 'Commercial Rodent Bait Stations',
      scheduled_date: firstVisitDate(),
      window_start: '09:00',
      window_end: '11:00',
      status: 'confirmed',
      source_estimate_id: estimateId,
      estimated_price: 165,
      pending_setup_fee: pendingSetupFee,
      is_recurring: true,
      recurring_pattern: 'quarterly',
    });
    return id;
  }

  async function convert(estimateId, extra = {}) {
    return require('../services/estimate-converter').convertEstimate(estimateId, {
      database: trx,
      billingTerm: 'prepay_annual',
      prepayInvoiceAmount: 660,
      allowFirstApplicationFallback: false,
      skipAutoSchedule: true,
      autoSendInvoice: false,
      skipMembershipEmail: true,
      ...extra,
    });
  }

  const saleFor = (invoiceId) => require('../services/commercial-prepay-sale-record')
    .findUnbookedSale(trx, invoiceId);

  async function postCustomer(customerId, body) {
    const response = await fetch(`${baseUrl}/admin/customers/${customerId}/annual-prepay-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  async function postRecordedCustomer(customerId, body) {
    const response = await fetch(`${baseUrl}/admin/customers/${customerId}/annual-prepay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  const draftRouteBody = (extra = {}) => ({
    amount: 660,
    setupFeeAmount: 99,
    serviceType: 'Commercial Rodent Bait Stations',
    planLabel: 'Commercial Rodent Bait Stations Annual Prepay',
    visitCount: 4,
    coverageCadence: 'quarterly',
    termStart: termStart(),
    ...extra,
  });

  test('the real converter records an invoice-only sale and later booking keeps its immutable evidence', async () => {
    const { customerId, estimateId } = await estimateFixture();
    const result = await convert(estimateId);

    const before = await saleFor(result.draftInvoiceId);
    expect(before).toMatchObject({
      estimateId,
      amount: 55,
      term: { prepay_invoice_id: result.draftInvoiceId, source_estimate_id: estimateId },
      invoice: { id: result.draftInvoiceId, customer_id: customerId },
      reviewContext: {
        saleId: expect.any(String),
        sourceInvoiceId: result.draftInvoiceId,
        customerId,
        estimateId,
        setupAmountCents: 5500,
      },
    });

    const rootId = await bookedRoot({ customerId, estimateId, pendingSetupFee: null });
    const plans = require('../services/secure-appointment-plans');
    const settled = await plans.settledSetupClaimForEstimate(trx, estimateId);
    expect(settled).toMatchObject({ invoice_id: result.draftInvoiceId, scheduled_service_id: null });
    await plans.anchorSetupFeeClaim(trx, { claimId: settled.id, anchorId: rootId });
    expect(await saleFor(result.draftInvoiceId)).toMatchObject({ estimateId, amount: 55 });
  });

  test('the real converter excludes booked, adopted and promised sale paths', async () => {
    const booked = await estimateFixture();
    const bookedId = await bookedRoot({ ...booked, estimateId: booked.estimateId });
    const bookedResult = await convert(booked.estimateId, { bookedAppointmentIds: [bookedId] });
    expect(bookedResult.firstScheduledServiceId).toBe(bookedId);
    expect(await saleFor(bookedResult.draftInvoiceId)).toBeNull();

    const adopted = await estimateFixture();
    const adoptedId = await bookedRoot({ customerId: adopted.customerId, estimateId: adopted.estimateId });
    const adoptedResult = await convert(adopted.estimateId, { adoptedExistingAppointmentId: adoptedId });
    expect(adoptedResult.firstScheduledServiceId).toBe(adoptedId);
    expect(await saleFor(adoptedResult.draftInvoiceId)).toBeNull();

    const promised = await estimateFixture();
    const promisedResult = await convert(promised.estimateId, {
      requestedFirstVisit: { date: firstVisitDate(), windowStart: '13:00', windowEnd: '15:00' },
    });
    expect(await saleFor(promisedResult.draftInvoiceId)).toBeNull();
  });

  test('the real Customer 360 route records only a sale with no visit or promise', async () => {
    const unbookedCustomerId = await customer();
    const unbooked = await postCustomer(unbookedCustomerId, draftRouteBody());
    expect(unbooked.status).toBe(201);
    expect(await saleFor(unbooked.body.invoice.id)).toMatchObject({
      estimateId: null,
      amount: 99,
      invoice: { id: unbooked.body.invoice.id, customer_id: unbookedCustomerId },
    });

    const promisedCustomerId = await customer();
    const promised = await postCustomer(promisedCustomerId, draftRouteBody({
      firstVisitDate: firstVisitDate(),
      firstVisitWindowStart: '09:00',
    }));
    expect(promised.status).toBe(201);
    expect(await saleFor(promised.body.invoice.id)).toBeNull();
    expect(invoiceSend).toHaveBeenCalledTimes(2);
  });

  test.each(['cash', 'check'])('the real recorded-%s route makes its anchorless setup discoverable before review', async (method) => {
    const customerId = await customer();
    const recorded = await postRecordedCustomer(customerId, {
      amount: 759,
      setupFeeAmount: 99,
      serviceType: 'Commercial Rodent Bait Stations',
      planLabel: 'Commercial Rodent Bait Stations Annual Prepay',
      visitCount: 4,
      coverageCadence: 'quarterly',
      termStart: termStart(),
      method,
    });
    expect(recorded.status).toBe(201);
    const records = require('../services/commercial-prepay-sale-record');
    await expect(records.hasRecordedUnbookedSale(trx, recorded.body.invoice.id)).resolves.toBe(true);
    await expect(saleFor(recorded.body.invoice.id)).resolves.toMatchObject({
      estimateId: null,
      amount: 99,
      invoice: { id: recorded.body.invoice.id, customer_id: customerId, status: 'paid' },
    });
  });
});
