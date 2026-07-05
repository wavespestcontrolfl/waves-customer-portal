describe('estimate converter annual prepay orchestration', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock('../models/db');
    jest.dontMock('../services/invoice');
    jest.dontMock('../services/annual-prepay-renewals');
    jest.dontMock('../services/estimate-deposits');
  });

  function makeDb(recurringServices, { monthlyTotal = 55, annualTotal = 660, recurringExtra = {} } = {}) {
    const estimate = {
      id: 'estimate-1',
      status: 'accepted',
      customer_id: 'customer-1',
      monthly_total: monthlyTotal,
      annual_total: annualTotal,
      estimate_data: {
        // recurringExtra carries scalar supplemental fields (e.g. rodentBaitMo)
        // that ride OUTSIDE recurring.services — the combo-companion case.
        recurring: { services: recurringServices, ...recurringExtra },
      },
    };
    const customer = {
      id: 'customer-1',
      first_name: 'Pat',
      last_name: 'Customer',
      city: 'Venice',
      property_type: 'residential',
    };

    return jest.fn((table) => {
      if (table === 'estimates') {
        return {
          where: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue(estimate),
        };
      }
      if (table === 'customers') {
        return {
          where: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue(customer),
          update: jest.fn().mockResolvedValue(1),
        };
      }
      if (table === 'scheduled_services') {
        return {
          where: jest.fn().mockReturnThis(),
          whereNotNull: jest.fn().mockReturnThis(),
          whereNull: jest.fn().mockReturnThis(),
          count: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue({ count: 0 }),
        };
      }
      if (table === 'activity_log') {
        return {
          insert: jest.fn().mockResolvedValue([1]),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });
  }

  // Sets up the mocks and returns the term-creation spy + warn spy. The renewals
  // mock returns null so convertEstimate rejects right after the term call — this
  // isolates the createTermForAnnualPrepay arguments (incl. coverage config)
  // without needing to mock the full downstream conversion.
  // estimate-deposits is ALWAYS mocked: the prepay branch's ledger read now
  // fails closed, and the makeDb mock throws on the estimate_deposits table —
  // a clean null read is the default no-deposit path.
  function setup(recurringServices, totals, { deposits = null, invoiceCreateResult = { id: 'invoice-1' } } = {}) {
    const db = makeDb(recurringServices, totals);
    const invoiceService = {
      create: jest.fn().mockResolvedValue(invoiceCreateResult),
      voidInvoice: jest.fn().mockResolvedValue({ id: 'invoice-1', status: 'void' }),
    };
    const renewals = {
      createTermForAnnualPrepay: jest.fn().mockResolvedValue(null),
    };
    const warn = jest.fn();

    jest.doMock('../models/db', () => db);
    jest.doMock('../services/invoice', () => invoiceService);
    jest.doMock('../services/annual-prepay-renewals', () => renewals);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn, error: jest.fn() }));
    jest.doMock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn() }));
    jest.doMock('../services/estimate-deposits', () => deposits || {
      pendingDepositCredit: jest.fn().mockResolvedValue(null),
      consumeDepositCredit: jest.fn().mockResolvedValue(0),
    });

    const EstimateConverter = require('../services/estimate-converter');
    return { EstimateConverter, invoiceService, renewals, warn };
  }

  const convertOpts = { billingTerm: 'prepay_annual', skipAutoSchedule: true };

  test('single recurring service: stamps coverage config on the term + voids the draft when the term is not created', async () => {
    const { EstimateConverter, invoiceService, renewals } = setup([
      { service: 'lawn_care', name: 'Lawn Care', frequency: 'monthly' },
    ]);

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('Annual prepay term was not created');

    expect(invoiceService.create).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      title: expect.stringContaining('Annual Prepay'),
    }));
    const args = renewals.createTermForAnnualPrepay.mock.calls[0][0];
    expect(args).toMatchObject({
      customerId: 'customer-1',
      prepayInvoiceId: 'invoice-1',
      // Lawn-only mix → 5% annual-prepay discount: 660 → 627.
      prepayAmount: 627,
      // NEW: coverage config so the paid-invoice pipeline stamps the visits.
      coverageServiceType: 'Lawn Care',
      coverageVisitCount: 12, // no explicit visitsPerYear → derived from 'monthly'
      coverageCadence: 'monthly',
    });
    expect(invoiceService.voidInvoice).toHaveBeenCalledWith('invoice-1');
  });

  test('acceptance deposit credits the prepay invoice: create carries depositCredit, the ledger consumes exactly the applied amount, and the term records the GROSS prepay', async () => {
    const deposits = {
      pendingDepositCredit: jest.fn().mockResolvedValue({ amount: 49 }),
      consumeDepositCredit: jest.fn().mockResolvedValue(49),
    };
    const { EstimateConverter, invoiceService, renewals } = setup(
      [{ service: 'lawn_care', name: 'Lawn Care', frequency: 'monthly' }],
      undefined,
      // Net invoice total after the $49 credit: 627 gross (660 - 5% prepay
      // discount) minus 49 = 578.
      { deposits, invoiceCreateResult: { id: 'invoice-1', total: 578, applied_deposit_credit: 49 } },
    );

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('Annual prepay term was not created');

    expect(deposits.pendingDepositCredit).toHaveBeenCalledWith('estimate-1', expect.anything());
    expect(invoiceService.create).toHaveBeenCalledWith(expect.objectContaining({
      depositCredit: { amount: 49, estimateId: 'estimate-1' },
    }));
    expect(deposits.consumeDepositCredit).toHaveBeenCalledWith(expect.objectContaining({
      estimateId: 'estimate-1',
      amount: 49,
      invoiceId: 'invoice-1',
    }));
    const args = renewals.createTermForAnnualPrepay.mock.calls[0][0];
    // GROSS = net invoice total (578) + credited deposit (49): recording the
    // net would understate the year by the deposit.
    expect(args).toMatchObject({ prepayAmount: 627 });
  });

  test('deposit ledger READ failure aborts the prepay conversion (fail closed — never mint with a dropped credit)', async () => {
    const deposits = {
      pendingDepositCredit: jest.fn().mockRejectedValue(new Error('connection reset')),
      consumeDepositCredit: jest.fn(),
    };
    const { EstimateConverter, invoiceService } = setup(
      [{ service: 'lawn_care', name: 'Lawn Care', frequency: 'monthly' }],
      undefined,
      { deposits },
    );

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('deposit ledger read failed for annual prepay invoice');
    expect(invoiceService.create).not.toHaveBeenCalled();
  });

  test('deposit allocation mismatch on the prepay invoice throws (rolls back the accept transaction)', async () => {
    const deposits = {
      pendingDepositCredit: jest.fn().mockResolvedValue({ amount: 49 }),
      consumeDepositCredit: jest.fn().mockResolvedValue(20),
    };
    const { EstimateConverter } = setup(
      [{ service: 'lawn_care', name: 'Lawn Care', frequency: 'monthly' }],
      undefined,
      { deposits, invoiceCreateResult: { id: 'invoice-1', total: 578, applied_deposit_credit: 49 } },
    );

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('deposit allocation mismatch');
  });

  test('single quarterly service with explicit visitsPerYear: coverage count comes from the line', async () => {
    const { EstimateConverter, renewals } = setup([
      { service: 'pest_control', name: 'Quarterly Pest Control', frequency: 'quarterly', visitsPerYear: 4 },
    ]);

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('Annual prepay term was not created');

    const args = renewals.createTermForAnnualPrepay.mock.calls[0][0];
    expect(args).toMatchObject({
      coverageServiceType: 'Quarterly Pest Control',
      coverageVisitCount: 4,
      coverageCadence: 'quarterly',
    });
  });

  test('multiple recurring services: annual prepay is HARD-BLOCKED before any write (no term, no invoice)', async () => {
    // A term carries ONE coverage service, so a multi-service prepay can't stamp
    // every covered service → its un-stamped visits would double-bill. The
    // converter must refuse up front, before creating the invoice or term.
    const { EstimateConverter, invoiceService, renewals } = setup([
      { service: 'lawn_care', name: 'Lawn Care', frequency: 'monthly' },
      { service: 'pest_control', name: 'Pest Control', frequency: 'quarterly', visitsPerYear: 4 },
    ]);

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow(/multi-service plans/i);

    // Fail-closed: nothing partial — no draft invoice and no prepay term created.
    expect(invoiceService.create).not.toHaveBeenCalled();
    expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
  });

  test('single service with no resolvable name: fails closed (voids the draft, creates NO term)', async () => {
    // A sparse line ({ service: 'lawn_care' } with no name/serviceName/service_name)
    // → the seeded visits would fall back to the generic 'Service' label and
    // refreshTermSnapshot couldn't stamp them → double bill. The converter must
    // refuse rather than ship an unstampable term.
    const { EstimateConverter, invoiceService, renewals } = setup([
      { service: 'lawn_care' },
    ]);

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toMatchObject({ code: 'ANNUAL_PREPAY_COVERAGE_UNDERIVABLE', statusCode: 422 });

    // No term created, and the draft invoice is voided (not left orphaned).
    expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect(invoiceService.voidInvoice).toHaveBeenCalledWith('invoice-1');
  });

  test('multiple recurring services: block error carries the operator-actionable code', async () => {
    const { EstimateConverter } = setup([
      { service: 'lawn_care', name: 'Lawn Care', frequency: 'monthly' },
      { service: 'tree_shrub', name: 'Tree & Shrub', frequency: 'bimonthly' },
    ]);

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toMatchObject({ code: 'ANNUAL_PREPAY_MULTI_SERVICE_UNSUPPORTED', statusCode: 422 });
  });

  test('single pest line + supplemental rodent-bait companion: BLOCKED (combo would go unstamped)', async () => {
    // rodentBaitMo rides OUTSIDE recurring.services so it isn't counted as a
    // recurring line, but it combines with pest into a "Pest & Rodent Control"
    // visit that single-service coverage can't match → double bill. Must block.
    const { EstimateConverter, invoiceService, renewals } = setup(
      [{ service: 'pest_control', name: 'Quarterly Pest Control', frequency: 'quarterly', visitsPerYear: 4 }],
      { recurringExtra: { rodentBaitMo: 25 } },
    );

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toMatchObject({ code: 'ANNUAL_PREPAY_MULTI_SERVICE_UNSUPPORTED', statusCode: 422 });
    expect(invoiceService.create).not.toHaveBeenCalled();
    expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
  });

  test('single lawn line + stray rodent-bait scalar (no matching primary): NOT blocked — rodent does not combine with lawn', async () => {
    // rodent_bait's combo primary is pest_control, not lawn_care, so it is dropped
    // (never scheduled) → lawn coverage still matches the lawn visit. Prepay proceeds
    // (reaching the term-creation stub, which rejects — proving we passed the block).
    const { EstimateConverter, renewals } = setup(
      [{ service: 'lawn_care', name: 'Lawn Care', frequency: 'monthly' }],
      { recurringExtra: { rodentBaitMo: 25 } },
    );

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('Annual prepay term was not created');
    expect(renewals.createTermForAnnualPrepay).toHaveBeenCalledWith(
      expect.objectContaining({ coverageServiceType: 'Lawn Care' }),
    );
  });
});
