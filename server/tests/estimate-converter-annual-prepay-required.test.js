describe('estimate converter annual prepay orchestration', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock('../models/db');
    jest.dontMock('../services/invoice');
    jest.dontMock('../services/annual-prepay-renewals');
  });

  function makeDb() {
    const estimate = {
      id: 'estimate-1',
      status: 'accepted',
      customer_id: 'customer-1',
      monthly_total: 55,
      annual_total: 660,
      estimate_data: {
        recurring: {
          services: [{ service: 'lawn_care', name: 'Lawn Care', frequency: 'monthly' }],
        },
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

  test('voids annual prepay draft invoice and rejects conversion when the term is not created', async () => {
    const db = makeDb();
    const invoiceService = {
      create: jest.fn().mockResolvedValue({ id: 'invoice-1' }),
      voidInvoice: jest.fn().mockResolvedValue({ id: 'invoice-1', status: 'void' }),
    };
    const renewals = {
      createTermForAnnualPrepay: jest.fn().mockResolvedValue(null),
    };

    jest.doMock('../models/db', () => db);
    jest.doMock('../services/invoice', () => invoiceService);
    jest.doMock('../services/annual-prepay-renewals', () => renewals);
    jest.doMock('../services/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
    jest.doMock('../services/account-membership-email', () => ({
      sendMembershipStarted: jest.fn(),
    }));

    const EstimateConverter = require('../services/estimate-converter');

    await expect(EstimateConverter.convertEstimate('estimate-1', {
      billingTerm: 'prepay_annual',
      skipAutoSchedule: true,
    })).rejects.toThrow('Annual prepay term was not created');

    expect(invoiceService.create).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      title: expect.stringContaining('Annual Prepay'),
    }));
    expect(renewals.createTermForAnnualPrepay).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      prepayInvoiceId: 'invoice-1',
      prepayAmount: 660,
    }));
    expect(invoiceService.voidInvoice).toHaveBeenCalledWith('invoice-1');
  });
});
