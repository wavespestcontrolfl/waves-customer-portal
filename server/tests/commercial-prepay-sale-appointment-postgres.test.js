/**
 * Real migrated PostgreSQL coverage for the sale-time appointment fact that
 * drives standalone Dispatch review. All records are synthetic and every
 * test rolls back. Customer delivery and provider edges are mocked; the
 * converter, Customer 360 routes, claim writer, audit writer and reader run
 * for real.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-commercial-prepay-sale-secret';
process.env.GATE_RATE_REVIEW = 'false';
process.env.GATE_RECORDED_ANNUAL_PREPAY_RECEIPT = 'false';

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

  async function bookedRoot({ customerId, estimateId = null }) {
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
      pending_setup_fee: 55,
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

  async function postCustomer(customerId, suffix, body) {
    const response = await fetch(`${baseUrl}/admin/customers/${customerId}/${suffix}`, {
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

  test('the real converter records a strictly unbooked setup sale and later anchoring keeps that receipt on the original invoice', async () => {
    const { customerId, estimateId } = await estimateFixture();
    const result = await convert(estimateId);

    const before = await saleFor(result.draftInvoiceId);
    expect(before).toEqual(expect.objectContaining({
      claim: expect.objectContaining({
        invoice_id: result.draftInvoiceId,
        scheduled_service_id: null,
        estimate_id: estimateId,
      }),
      term: expect.objectContaining({
        prepay_invoice_id: result.draftInvoiceId,
        source_estimate_id: estimateId,
      }),
      invoice: expect.objectContaining({ id: result.draftInvoiceId, customer_id: customerId }),
    }));

    // These are the same real claim-resolution and one-way anchor operations
    // the admin booking writer runs after a later estimate-linked booking.
    const rootId = await bookedRoot({ customerId, estimateId });
    const plans = require('../services/secure-appointment-plans');
    const settled = await plans.settledSetupClaimForEstimate(trx, estimateId);
    expect(settled).toMatchObject({ id: before.claim.id, invoice_id: result.draftInvoiceId });
    await expect(plans.anchorSetupFeeClaim(trx, { claimId: settled.id, anchorId: rootId }))
      .resolves.toBe(true);

    const after = await saleFor(result.draftInvoiceId);
    expect(after).toEqual(expect.objectContaining({
      claim: expect.objectContaining({
        id: before.claim.id,
        invoice_id: result.draftInvoiceId,
        scheduled_service_id: rootId,
      }),
      invoice: expect.objectContaining({ id: result.draftInvoiceId }),
    }));
  });

  test('the real converter does not label a booked or explicitly adopted setup as unbooked', async () => {
    const booked = await estimateFixture();
    const bookedId = await bookedRoot({ ...booked, estimateId: booked.estimateId });
    const bookedResult = await convert(booked.estimateId, { bookedAppointmentIds: [bookedId] });
    expect(bookedResult.firstScheduledServiceId).toBe(bookedId);
    expect(await saleFor(bookedResult.draftInvoiceId)).toBeNull();
    expect(await trx('setup_fee_claims').where({ invoice_id: bookedResult.draftInvoiceId }).first())
      .toEqual(expect.objectContaining({ invoice_id: bookedResult.draftInvoiceId }));

    const adopted = await estimateFixture();
    // The real adoption caller stamps the selected row to the estimate before
    // conversion; the converter then takes its ordinary reservation branch.
    const adoptedId = await bookedRoot({
      customerId: adopted.customerId,
      estimateId: adopted.estimateId,
    });
    const adoptedResult = await convert(adopted.estimateId, { adoptedExistingAppointmentId: adoptedId });
    expect(adoptedResult.firstScheduledServiceId).toBe(adoptedId);
    expect(await saleFor(adoptedResult.draftInvoiceId)).toBeNull();
    expect(await trx('setup_fee_claims').where({ invoice_id: adoptedResult.draftInvoiceId }).first())
      .toEqual(expect.objectContaining({ invoice_id: adoptedResult.draftInvoiceId }));
  });

  test.each([
    ['an externally supplied term start', () => ({ annualPrepayTermStart: firstVisitDate() })],
    ['a requested first visit', () => ({
      requestedFirstVisit: { date: firstVisitDate(), windowStart: '13:00', windowEnd: '15:00' },
    })],
  ])('the real converter does not label %s as an unbooked sale', async (_label, options) => {
    const { estimateId } = await estimateFixture();
    const result = await convert(estimateId, options());
    expect(await trx('setup_fee_claims').where({ invoice_id: result.draftInvoiceId }).first())
      .toMatchObject({ scheduled_service_id: null, estimate_id: estimateId });
    expect(await saleFor(result.draftInvoiceId)).toBeNull();
  });

  test('the real Customer 360 invoice route records only the no-visit-promise sale', async () => {
    const unbookedCustomerId = await customer();
    const unbooked = await postCustomer(unbookedCustomerId, 'annual-prepay-invoice', draftRouteBody());
    expect(unbooked.status).toBe(201);
    expect(await saleFor(unbooked.body.invoice.id)).toEqual(expect.objectContaining({
      claim: expect.objectContaining({ invoice_id: unbooked.body.invoice.id }),
      term: expect.objectContaining({ prepay_invoice_id: unbooked.body.invoice.id }),
      invoice: expect.objectContaining({ id: unbooked.body.invoice.id, customer_id: unbookedCustomerId }),
    }));

    const promisedCustomerId = await customer();
    const promised = await postCustomer(promisedCustomerId, 'annual-prepay-invoice', draftRouteBody({
      firstVisitDate: firstVisitDate(),
      firstVisitWindowStart: '09:00',
    }));
    expect(promised.status).toBe(201);
    expect(await trx('setup_fee_claims').where({ invoice_id: promised.body.invoice.id }).first())
      .toMatchObject({ scheduled_service_id: null });
    expect(await saleFor(promised.body.invoice.id)).toBeNull();
    expect(invoiceSend).toHaveBeenCalledTimes(2);
  });

  test('the retrospective already-collected route does not claim the original sale was unbooked', async () => {
    const customerId = await customer();
    const response = await postCustomer(customerId, 'annual-prepay', draftRouteBody({
      // This endpoint treats amount as the collected total, with setup
      // included rather than added on top.
      amount: 759,
      method: 'cash',
      reference: 'synthetic receipt only',
    }));
    expect(response.status).toBe(201);

    expect(await trx('setup_fee_claims').where({ invoice_id: response.body.invoice.id }).first())
      .toEqual(expect.objectContaining({ invoice_id: response.body.invoice.id }));
    expect(await saleFor(response.body.invoice.id)).toBeNull();
  });
});
