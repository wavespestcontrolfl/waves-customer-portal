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

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg;
let trx;

jest.setTimeout(90000);

const day = (offset) => etDateString(addETDays(new Date(), offset));

async function seedSale({
  marker = true,
  customerType = 'commercial',
  coverageServiceType = 'Commercial Rodent Bait Stations',
  invoiceTitle = 'Commercial Rodent Bait Stations - Annual Prepay',
  estimateData = null,
  conversionEvidence = null,
  saleTimeBooking = false,
  saleTimeChild = false,
} = {}) {
  const ids = {
    customerId: randomUUID(),
    estimateId: randomUUID(),
    invoiceId: randomUUID(),
    termId: randomUUID(),
    claimId: randomUUID(),
    olderRootId: randomUUID(),
    otherPropertyRootId: randomUUID(),
    olderInvoiceId: randomUUID(),
    olderClaimId: randomUUID(),
    saleRootId: randomUUID(),
    saleChildId: randomUUID(),
  };
  const originalPi = `pi_original_${randomUUID().slice(0, 12)}`;
  await trx('customers').insert({
    id: ids.customerId,
    first_name: 'Synthetic',
    last_name: 'Original Invoice',
    phone: `+1202555${String(parseInt(ids.customerId.slice(0, 8), 16) % 10000).padStart(4, '0')}`,
    email: `${ids.customerId}@example.invalid`,
    property_type: customerType,
    billing_mode: 'annual_prepay',
  });
  await trx('estimates').insert({
    id: ids.estimateId,
    customer_id: ids.customerId,
    status: 'accepted',
    category: 'COMMERCIAL',
    estimate_data: estimateData || {},
    token: randomUUID(),
  });
  const scheduled = [
    {
      id: ids.olderRootId,
      customer_id: ids.customerId,
      service_type: 'Commercial Rodent Bait Stations',
      scheduled_date: day(14),
      status: 'pending',
      estimated_price: 73,
      pending_setup_fee: 73,
      is_recurring: true,
      service_address_line1: '73 Older Visit Lane',
    },
    {
      id: ids.otherPropertyRootId,
      customer_id: ids.customerId,
      service_type: 'Commercial Rodent Bait Stations',
      scheduled_date: day(21),
      status: 'pending',
      estimated_price: 61,
      pending_setup_fee: 41,
      is_recurring: true,
      service_address_line1: '41 Second Property Road',
    },
  ];
  if (saleTimeBooking) {
    scheduled.push({
      id: ids.saleRootId,
      customer_id: ids.customerId,
      service_type: 'Commercial Rodent Bait Stations',
      scheduled_date: day(7),
      status: 'pending',
      estimated_price: 55,
      pending_setup_fee: null,
      is_recurring: true,
      recurring_pattern: 'quarterly',
      source_estimate_id: ids.estimateId,
      service_address_line1: 'Booked Sale Series Way',
    });
    if (saleTimeChild) {
      scheduled.push({
        id: ids.saleChildId,
        customer_id: ids.customerId,
        service_type: 'Commercial Rodent Bait Stations',
        scheduled_date: day(35),
        status: 'pending',
        estimated_price: 55,
        pending_setup_fee: null,
        is_recurring: true,
        recurring_parent_id: ids.saleRootId,
        recurring_pattern: 'quarterly',
        source_estimate_id: ids.estimateId,
        service_address_line1: 'Booked Sale Series Way',
      });
    }
  }
  await trx('scheduled_services').insert(scheduled);
  const setupLine = (amount) => [{
    description: 'Bait Station Setup — one-time setup fee',
    quantity: 1,
    unit_price: amount,
    amount,
    category: 'Setup fee',
  }];
  await trx('invoices').insert([
    {
      id: ids.invoiceId,
      token: randomUUID(),
      invoice_number: `SRC-${ids.invoiceId.slice(0, 8)}`,
      customer_id: ids.customerId,
      title: invoiceTitle,
      status: 'paid',
      paid_at: new Date(),
      stripe_payment_intent_id: originalPi,
      subtotal: 55,
      total: 55,
      due_date: day(0),
      line_items: JSON.stringify(setupLine(55)),
    },
    {
      id: ids.olderInvoiceId,
      token: randomUUID(),
      invoice_number: `OLD-${ids.olderInvoiceId.slice(0, 8)}`,
      customer_id: ids.customerId,
      scheduled_service_id: ids.olderRootId,
      title: 'Older $73 job',
      status: 'draft',
      subtotal: 73,
      total: 73,
      due_date: day(14),
      line_items: JSON.stringify(setupLine(73)),
    },
  ]);
  await trx('annual_prepay_terms').insert({
    id: ids.termId,
    customer_id: ids.customerId,
    source_estimate_id: ids.estimateId,
    prepay_invoice_id: ids.invoiceId,
    plan_label: coverageServiceType,
    monthly_rate: 55,
    prepay_amount: 55,
    term_start: saleTimeChild ? day(35) : saleTimeBooking ? day(7) : day(0),
    term_end: day(365),
    status: 'active',
    coverage_service_type: coverageServiceType,
    coverage_visit_count: 4,
    coverage_cadence: 'quarterly',
  });
  await trx('setup_fee_claims').insert([
    {
      id: ids.claimId,
      invoice_id: ids.invoiceId,
      scheduled_service_id: null,
      estimate_id: ids.estimateId,
      amount: 55,
      unbooked_commercial_setup: marker,
    },
    {
      id: ids.olderClaimId,
      invoice_id: ids.olderInvoiceId,
      scheduled_service_id: ids.olderRootId,
      amount: 73,
      unbooked_commercial_setup: false,
    },
  ]);
  if (conversionEvidence) {
    const firstScheduledServiceId = conversionEvidence.firstScheduledServiceId === 'saleRoot'
      ? ids.saleRootId
      : conversionEvidence.firstScheduledServiceId === 'saleChild'
        ? ids.saleChildId
        : conversionEvidence.firstScheduledServiceId;
    await trx('activity_log').insert({
      customer_id: ids.customerId,
      action: 'estimate_converted',
      description: `Estimate #${ids.estimateId} converted: synthetic legacy ownership evidence`,
      metadata: JSON.stringify({
        estimateId: ids.estimateId,
        firstScheduledServiceId,
        scheduledCount: conversionEvidence.scheduledCount,
      }),
    });
  }
  const [payment] = await trx('payments').insert({
    customer_id: ids.customerId,
    payment_date: day(-1),
    amount: 55,
    status: 'paid',
    stripe_payment_intent_id: originalPi,
    processor: 'stripe',
    metadata: { invoice_id: ids.invoiceId },
    description: 'Original commercial prepay',
  }).returning('*');
  return { ids, originalPi, payment, setupLine };
}

async function expectUnrelatedRowsUnchanged(ids, before) {
  expect(await trx('scheduled_services').whereIn('id', [ids.olderRootId, ids.otherPropertyRootId]).orderBy('id'))
    .toEqual(before.roots);
  expect(await trx('invoices').where({ id: ids.olderInvoiceId }).first()).toEqual(before.invoice);
  expect(await trx('setup_fee_claims').where({ id: ids.olderClaimId }).first()).toEqual(before.claim);
}

async function bookFromAcceptedEstimate(ids) {
  const service = await trx('services').where({ service_key: 'rodent_bait_quarterly' }).first('id');
  const route = require('../routes/admin-schedule').stack.find(({ route: r }) => r?.path === '/' && r.methods.post);
  const req = {
    headers: {}, body: {
      customerId: ids.customerId, sourceEstimateId: ids.estimateId,
      serviceType: 'Commercial Rodent Bait Stations', serviceId: service.id,
      scheduledDate: day(31), isRecurring: true, recurringPattern: 'quarterly', recurringCount: 2,
      allowDuplicateSeries: true, assignmentMode: 'unassigned',
      createInvoice: true, estimatedPrice: 45, primaryLinePrice: 45,
      sendConfirmationSms: false, sendTechNotification: false,
    },
  };
  // The booking transaction is complete at the 201. Leave the outgoing
  // notifications queued after that response outside this database test.
  const next = jest.fn();
  let postResponse;
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) {
      this.body = body;
      if (this.statusCode === 201) postResponse = jest.spyOn(global, 'setImmediate').mockImplementationOnce(() => null);
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
  return res.body.id;
}

postgres('commercial prepay original-invoice ownership', () => {
  beforeAll(() => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)
      || !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) {
      throw new Error('Original-invoice tests require a private local waves_qa_<32 hex> PostgreSQL database.');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    mockPg = trx;
  });

  afterEach(async () => {
    await trx.rollback();
    trx = null;
  });

  afterAll(async () => database?.destroy());

  test('legacy recovery requires durable zero-booking evidence and preserves a historical booked series', async () => {
    const { findOriginalCommercialPrepayInvoice } = require('../services/commercial-prepay-original-invoice');

    const termProven = await seedSale({
      marker: null,
      conversionEvidence: { firstScheduledServiceId: null, scheduledCount: 0 },
    });
    await expect(findOriginalCommercialPrepayInvoice(trx, termProven.ids.invoiceId))
      .resolves.toMatchObject({ claim: { id: termProven.ids.claimId } });

    const estimateProven = await seedSale({
      marker: null,
      coverageServiceType: 'Rodent Bait Stations',
      invoiceTitle: 'Rodent Bait Stations - Annual Prepay',
      estimateData: {
        result: { recurring: { services: [{ service: 'commercial_rodent_bait' }] } },
      },
      conversionEvidence: { firstScheduledServiceId: null, scheduledCount: 0 },
    });
    await expect(findOriginalCommercialPrepayInvoice(trx, estimateProven.ids.invoiceId))
      .resolves.toMatchObject({ term: { id: estimateProven.ids.termId } });

    const ambiguousCommercial = await seedSale({
      marker: null,
      customerType: 'commercial',
      coverageServiceType: 'Rodent Bait Stations',
      invoiceTitle: 'Commercial Rodent Bait Stations - Annual Prepay',
      estimateData: {},
    });
    await expect(findOriginalCommercialPrepayInvoice(trx, ambiguousCommercial.ids.invoiceId))
      .resolves.toBeNull();

    const malformedZero = await seedSale({
      marker: null,
      conversionEvidence: { firstScheduledServiceId: null, scheduledCount: null },
    });
    await expect(findOriginalCommercialPrepayInvoice(trx, malformedZero.ids.invoiceId))
      .resolves.toBeNull();

    const conflicting = await seedSale({
      marker: null,
      conversionEvidence: { firstScheduledServiceId: null, scheduledCount: 0 },
    });
    await trx('activity_log').insert({
      customer_id: conflicting.ids.customerId,
      action: 'estimate_converted',
      description: `Estimate #${conflicting.ids.estimateId} converted: conflicting booked evidence`,
      metadata: JSON.stringify({
        estimateId: conflicting.ids.estimateId,
        firstScheduledServiceId: conflicting.ids.olderRootId,
        scheduledCount: 1,
      }),
      created_at: new Date(Date.now() + 60_000),
    });
    await expect(findOriginalCommercialPrepayInvoice(trx, conflicting.ids.invoiceId))
      .resolves.toBeNull();

    const booked = await seedSale({
      marker: null,
      saleTimeBooking: true,
      conversionEvidence: { firstScheduledServiceId: null, scheduledCount: 1 },
    });
    await trx('activity_log').where({ customer_id: booked.ids.customerId, action: 'estimate_converted' })
      .update({ metadata: JSON.stringify({
        estimateId: booked.ids.estimateId,
        firstScheduledServiceId: booked.ids.saleRootId,
        scheduledCount: 1,
      }) });
    await expect(findOriginalCommercialPrepayInvoice(trx, booked.ids.invoiceId)).resolves.toBeNull();

    const malformedOccurrence = await seedSale({
      marker: null,
      saleTimeBooking: true,
      conversionEvidence: { firstScheduledServiceId: 'not-a-uuid', scheduledCount: 1 },
    });
    await trx('setup_fee_claims').where({ id: malformedOccurrence.ids.claimId })
      .update({ scheduled_service_id: malformedOccurrence.ids.saleRootId });
    const malformedTerm = await trx('annual_prepay_terms')
      .where({ id: malformedOccurrence.ids.termId }).first();
    await expect(require('../services/commercial-prepay-original-invoice')
      .bookedCommercialSetupRootId(trx, malformedTerm)).resolves.toBeNull();
  });

  test('migration distinguishes the sale occurrence from a later mutable claim anchor', async () => {
    const soldCommercialService = {
      result: { recurring: { services: [{ service: 'commercial_rodent_bait' }] } },
    };
    const residentialServiceWithCommercialNoise = {
      notes: 'Customer asked about commercial_rodent_bait but declined it.',
      result: {
        recurring: { services: [{ service: 'rodent_bait' }] },
        unusedVariants: [{ service: 'commercial_rodent_bait' }],
      },
      declinedOptions: [{ service: 'commercial_rodent_bait' }],
    };
    const commercial = await seedSale({
      marker: null,
      saleTimeBooking: true,
      conversionEvidence: { firstScheduledServiceId: 'saleRoot', scheduledCount: 1 },
    });
    const selectedChild = await seedSale({
      marker: null,
      saleTimeBooking: true,
      saleTimeChild: true,
      conversionEvidence: { firstScheduledServiceId: 'saleChild', scheduledCount: 1 },
    });
    const wrongServiceChild = await seedSale({
      marker: null,
      saleTimeBooking: true,
      saleTimeChild: true,
      conversionEvidence: { firstScheduledServiceId: 'saleChild', scheduledCount: 1 },
    });
    await trx('scheduled_services').where({ id: wrongServiceChild.ids.saleChildId }).update({
      service_id: null,
      service_type: 'General Pest Control',
    });
    const bookedBySoldService = await seedSale({
      marker: null,
      customerType: 'residential',
      coverageServiceType: 'Rodent Bait Stations',
      estimateData: soldCommercialService,
      saleTimeBooking: true,
      conversionEvidence: { firstScheduledServiceId: 'saleRoot', scheduledCount: 1 },
    });
    const bookedResidentialNoise = await seedSale({
      marker: null,
      customerType: 'residential',
      coverageServiceType: 'Rodent Bait Stations',
      estimateData: residentialServiceWithCommercialNoise,
      saleTimeBooking: true,
      conversionEvidence: { firstScheduledServiceId: 'saleRoot', scheduledCount: 1 },
    });
    for (const seeded of [bookedBySoldService, bookedResidentialNoise]) {
      await trx('scheduled_services').where({ id: seeded.ids.saleRootId }).update({
        service_id: null,
        service_type: 'Rodent Bait Stations',
      });
    }
    const laterBooking = await seedSale({
      marker: null,
      conversionEvidence: { firstScheduledServiceId: null, scheduledCount: 0 },
    });
    const unbookedBySoldService = await seedSale({
      marker: null,
      customerType: 'residential',
      coverageServiceType: 'Rodent Bait Stations',
      estimateData: soldCommercialService,
      conversionEvidence: { firstScheduledServiceId: null, scheduledCount: 0 },
    });
    const unbookedResidentialNoise = await seedSale({
      marker: null,
      customerType: 'residential',
      coverageServiceType: 'Rodent Bait Stations',
      estimateData: residentialServiceWithCommercialNoise,
      conversionEvidence: { firstScheduledServiceId: null, scheduledCount: 0 },
    });
    const unbookedAmbiguous = await seedSale({
      marker: null,
      customerType: 'residential',
      coverageServiceType: 'Rodent Bait Stations',
      estimateData: { notes: 'commercial_rodent_bait appears only in a note' },
      conversionEvidence: { firstScheduledServiceId: null, scheduledCount: 0 },
    });
    const mismatchedOccurrence = await seedSale({
      marker: null,
      saleTimeBooking: true,
      conversionEvidence: { firstScheduledServiceId: null, scheduledCount: 1 },
    });
    await trx('activity_log').where({
      customer_id: mismatchedOccurrence.ids.customerId,
      action: 'estimate_converted',
    }).update({ metadata: JSON.stringify({
      estimateId: mismatchedOccurrence.ids.estimateId,
      firstScheduledServiceId: mismatchedOccurrence.ids.olderRootId,
      scheduledCount: 1,
    }) });
    const absentEvidence = await seedSale({ marker: null, saleTimeBooking: true });
    const residential = await seedSale({ marker: null, saleTimeBooking: true, customerType: 'residential', coverageServiceType: 'Rodent Bait Stations' });
    await trx('scheduled_services').where({ id: residential.ids.saleRootId }).update({ service_type: 'Rodent Bait Stations' });
    for (const { ids } of [commercial, wrongServiceChild, bookedBySoldService,
      bookedResidentialNoise, mismatchedOccurrence, absentEvidence, residential]) {
      await trx('setup_fee_claims').where({ id: ids.claimId }).update({ scheduled_service_id: ids.saleRootId });
    }
    // Legacy acceptance sometimes attached the fee to the selected child.
    // The migrated term and its claim must agree on the verified series root.
    await trx('setup_fee_claims').where({ id: selectedChild.ids.claimId })
      .update({ scheduled_service_id: selectedChild.ids.saleChildId });
    for (const { ids } of [laterBooking, unbookedBySoldService, unbookedResidentialNoise, unbookedAmbiguous]) {
      await trx('setup_fee_claims').where({ id: ids.claimId }).update({ scheduled_service_id: ids.olderRootId });
    }
    const migration = require('../models/migrations/20261119235000_unbooked_commercial_setup');
    await migration.down(trx);
    await migration.up(trx);
    const stored = (id) => trx('annual_prepay_terms').where({ id }).first('commercial_setup_series_root_id');
    expect((await stored(commercial.ids.termId)).commercial_setup_series_root_id).toBe(commercial.ids.saleRootId);
    expect((await stored(selectedChild.ids.termId)).commercial_setup_series_root_id).toBe(selectedChild.ids.saleRootId);
    expect((await stored(bookedBySoldService.ids.termId)).commercial_setup_series_root_id)
      .toBe(bookedBySoldService.ids.saleRootId);
    for (const seeded of [laterBooking, unbookedBySoldService, unbookedResidentialNoise,
      unbookedAmbiguous, wrongServiceChild, bookedResidentialNoise, mismatchedOccurrence,
      absentEvidence, residential]) {
      expect((await stored(seeded.ids.termId)).commercial_setup_series_root_id).toBeNull();
    }
    expect(await trx('setup_fee_claims').where({ id: commercial.ids.claimId }).first())
      .toMatchObject({ scheduled_service_id: commercial.ids.saleRootId, unbooked_commercial_setup: false });
    expect(await trx('setup_fee_claims').where({ id: selectedChild.ids.claimId }).first())
      .toMatchObject({ scheduled_service_id: selectedChild.ids.saleRootId, unbooked_commercial_setup: false });
    expect(await trx('setup_fee_claims').where({ id: bookedBySoldService.ids.claimId }).first())
      .toMatchObject({ scheduled_service_id: bookedBySoldService.ids.saleRootId, unbooked_commercial_setup: false });
    for (const seeded of [laterBooking, unbookedBySoldService]) {
      expect(await trx('setup_fee_claims').where({ id: seeded.ids.claimId }).first())
        .toMatchObject({ scheduled_service_id: null, unbooked_commercial_setup: true });
    }
    for (const seeded of [unbookedResidentialNoise, unbookedAmbiguous]) {
      expect(await trx('setup_fee_claims').where({ id: seeded.ids.claimId }).first())
        .toMatchObject({ scheduled_service_id: seeded.ids.olderRootId, unbooked_commercial_setup: null });
    }
    for (const seeded of [wrongServiceChild, bookedResidentialNoise, mismatchedOccurrence,
      absentEvidence, residential]) {
      expect(await trx('setup_fee_claims').where({ id: seeded.ids.claimId }).first())
        .toMatchObject({ scheduled_service_id: seeded.ids.saleRootId, unbooked_commercial_setup: null });
    }

    await trx('setup_fee_claims').where({ id: commercial.ids.claimId }).del();
    await trx('setup_fee_claims').where({ id: selectedChild.ids.claimId }).del();
    expect((await stored(commercial.ids.termId)).commercial_setup_series_root_id).toBe(commercial.ids.saleRootId);
    expect((await stored(selectedChild.ids.termId)).commercial_setup_series_root_id).toBe(selectedChild.ids.saleRootId);
    expect((await stored(residential.ids.termId)).commercial_setup_series_root_id).toBeNull();
  });

  test('payment and refund of an invoice-only sale leave the only other bait series and its invoice alone', async () => {
    const { ids, payment } = await seedSale();
    await trx('scheduled_services').where({ id: ids.otherPropertyRootId }).update({ status: 'cancelled' });
    await trx('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'payment_pending' });
    const other = () => trx('scheduled_services').where({ id: ids.olderRootId }).first();
    const otherInvoice = () => trx('invoices').where({ id: ids.olderInvoiceId }).first();
    const originalClaim = () => trx('setup_fee_claims').where({ invoice_id: ids.invoiceId }).first();
    const initial = await other();
    const invoiceBefore = await otherInvoice();
    const claimBefore = await originalClaim();
    const renewals = require('../services/annual-prepay-renewals');
    await renewals.syncTermForInvoicePayment(ids.invoiceId, trx);
    expect(await trx('annual_prepay_terms').where({ id: ids.termId }).first('status'))
      .toEqual({ status: 'active' });
    expect(await other()).toEqual(initial);
    expect(await otherInvoice()).toEqual(invoiceBefore);
    expect(await originalClaim()).toEqual(claimBefore);

    // A later booking linked to the selling estimate is also the only live
    // series that the old refund path could choose for an empty setup stamp.
    await trx('scheduled_services').where({ id: ids.olderRootId })
      .update({ source_estimate_id: ids.estimateId, pending_setup_fee: null });
    const booked = await other();
    await trx('payments').where({ id: payment.id }).update({
      status: 'refunded', refund_status: 'full', refund_amount: 55,
    });
    await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'refunded', paid_at: null });
    await renewals.syncTermForRefundedPayment(await trx('payments').where({ id: payment.id }).first(), trx);
    expect(await trx('annual_prepay_terms').where({ id: ids.termId }).first('status'))
      .toEqual({ status: 'cancelled' });
    expect(await other()).toEqual(booked);
    expect(await otherInvoice()).toEqual(invoiceBefore);
    expect(await originalClaim()).toEqual(claimBefore);
  });

  test('a Customer 360 first-visit promise seeds and covers only its own new series on payment', async () => {
    const { ids } = await seedSale({ coverageServiceType: 'Rodent Bait Stations' });
    const renewals = require('../services/annual-prepay-renewals');
    const before = {
      roots: await trx('scheduled_services').whereIn('id', [ids.olderRootId, ids.otherPropertyRootId]).orderBy('id'),
      invoice: await trx('invoices').where({ id: ids.olderInvoiceId }).first(),
      claim: await trx('setup_fee_claims').where({ id: ids.olderClaimId }).first(),
    };
    const promisedDate = day(7);
    await trx('setup_fee_claims').where({ id: ids.claimId }).update({ estimate_id: null });
    await trx('annual_prepay_terms').where({ id: ids.termId }).update({
      source_estimate_id: null,
      status: 'payment_pending',
      first_visit_date: promisedDate,
      first_visit_window_start: '08:00',
      last_scheduled_service_id: null,
      last_scheduled_service_date: null,
    });
    await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'draft', paid_at: null });

    await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'paid', paid_at: new Date() });
    await renewals.syncTermForInvoicePayment(ids.invoiceId, trx);

    const term = await trx('annual_prepay_terms').where({ id: ids.termId }).first();
    expect(term.status).toBe('active');
    expect(etDateString(term.first_visit_date)).toBe(promisedDate);
    const owned = await trx('scheduled_services')
      .where({ annual_prepay_term_id: ids.termId })
      .orderBy(['scheduled_date', 'id']);
    expect(owned).toHaveLength(4);
    expect(owned[0]).toMatchObject({
      window_start: '08:00:00',
      prepaid_method: 'annual_prepay_invoice',
      prepaid_amount: '13.75',
    });
    expect(etDateString(owned[0].scheduled_date)).toBe(promisedDate);
    expect(new Set(owned.map((row) => row.recurring_parent_id || row.id)).size).toBe(1);
    for (const visit of owned) {
      await expect(renewals.annualPrepayCoversVisit(visit, trx, { throwOnError: true }))
        .resolves.toBe(true);
    }
    await expectUnrelatedRowsUnchanged(ids, before);
    expect(await trx('setup_fee_claims').where({ id: ids.claimId }).first())
      .toMatchObject({
        invoice_id: ids.invoiceId,
        scheduled_service_id: null,
        unbooked_commercial_setup: true,
      });

    const plans = require('../services/secure-appointment-plans');
    const root = owned.find((row) => !row.recurring_parent_id);
    expect(root.source_estimate_id).toBeNull();
    for (const row of [root, owned.find((visit) => visit.recurring_parent_id)]) {
      await expect(plans.resolveDirectRodentSetupObligation(trx, row)).resolves.toBe(0);
    }
    // Run the Customer 360 renewal resolver with this paid series as its
    // only live candidate. The two other series continue to own their fees.
    const renewal = await trx.transaction();
    try {
      await renewal('scheduled_services').whereIn('id', [ids.olderRootId, ids.otherPropertyRootId]).update({ status: 'cancelled' });
      await expect(plans.findDirectRodentSetupObligationForCoverage(renewal, {
        customerId: ids.customerId, coverageServiceType: term.coverage_service_type,
      })).resolves.toBeNull();
    } finally {
      await renewal.rollback();
    }
    await expect(plans.resolveDirectRodentSetupObligation(trx, { id: ids.olderRootId })).resolves.toBe(73);
    const ownedIds = owned.map((row) => row.id);
    await renewals.syncTermForInvoicePayment(ids.invoiceId, trx);
    expect((await trx('scheduled_services')
      .where({ annual_prepay_term_id: ids.termId })
      .orderBy(['scheduled_date', 'id']))
      .map((row) => row.id)).toEqual(ownedIds);
    await expectUnrelatedRowsUnchanged(ids, before);
  });

  test('staff booking still carries the disclosed setup when the estimate has no invoice-owned fee', async () => {
    const { ids } = await seedSale({ estimateData: {
      result: { oneTime: { items: [{ service: 'rodent_bait_setup', price: 55 }] } },
    } });
    await trx('setup_fee_claims').where({ id: ids.claimId }).delete();
    const bookedId = await bookFromAcceptedEstimate(ids);
    expect(await trx('scheduled_services').where({ id: bookedId }).first('source_estimate_id', 'pending_setup_fee'))
      .toEqual({ source_estimate_id: ids.estimateId, pending_setup_fee: '55.00' });
  }, 240000);
});
