jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/discount-engine', () => ({
  manualEligibilityFailures: jest.fn(),
  clearCache: jest.fn(),
}));

const db = require('../models/db');
const DiscountEngine = require('../services/discount-engine');
const {
  buildAppointmentPricing,
  calculateVisitFinancialsForAddons,
  calculateStoredVisitFinancials,
} = require('../routes/admin-schedule')._test;

function discountQuery(discount) {
  return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(discount),
  };
}

describe('admin schedule appointment discount eligibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects an ineligible appointment-level discount before applying it', async () => {
    const discount = {
      id: 'discount-1',
      name: 'Military special',
      discount_type: 'percentage',
      amount: 10,
      requires_military: true,
    };
    db.mockReturnValueOnce(discountQuery(discount));
    DiscountEngine.manualEligibilityFailures.mockResolvedValue(['military status']);

    await expect(buildAppointmentPricing({
      serviceRecord: { service_key: 'general_pest', category: 'pest_control', base_price: 150 },
      estimatedPrice: 150,
      serviceAddons: [],
      discountId: discount.id,
      discountType: discount.discount_type,
      customer: { id: 'customer-1', is_military: false },
    })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/not eligible: military status/),
    });

    expect(DiscountEngine.manualEligibilityFailures).toHaveBeenCalledWith(
      discount,
      expect.objectContaining({ id: 'customer-1' }),
      {
        subtotal: 150,
        serviceKey: 'general_pest',
        serviceCategory: 'pest_control',
      }
    );
  });

  test('limits a service-scoped free discount to matching lines', async () => {
    const discount = {
      id: 'discount-1',
      name: 'Free general pest service',
      discount_type: 'free_service',
      amount: 0,
      service_key_filter: 'general_pest',
    };
    db
      .mockReturnValueOnce(discountQuery({ service_key: 'termite_addon', category: 'termite' }))
      .mockReturnValueOnce(discountQuery(discount));
    DiscountEngine.manualEligibilityFailures.mockResolvedValue([]);

    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'general_pest', category: 'pest_control', base_price: 150 },
      estimatedPrice: 150,
      serviceAddons: [{ serviceId: 'addon-1', name: 'Termite add-on', price: 50 }],
      discountId: discount.id,
      discountType: discount.discount_type,
      customer: { id: 'customer-1' },
    });

    expect(pricing.appointmentDiscount.discountDollars).toBe(150);
    expect(pricing.finalPrice).toBe(50);
  });

  test('checks scoped minimum subtotal against matching lines only', async () => {
    const discount = {
      id: 'discount-1',
      name: 'General pest minimum',
      discount_type: 'percentage',
      amount: 10,
      service_key_filter: 'general_pest',
      min_subtotal: 100,
    };
    db
      .mockReturnValueOnce(discountQuery({ service_key: 'termite_addon', category: 'termite' }))
      .mockReturnValueOnce(discountQuery(discount));
    DiscountEngine.manualEligibilityFailures.mockResolvedValue(['minimum subtotal $100']);

    await expect(buildAppointmentPricing({
      serviceRecord: { service_key: 'general_pest', category: 'pest_control', base_price: 50 },
      estimatedPrice: 50,
      serviceAddons: [{ serviceId: 'addon-1', name: 'Termite add-on', price: 100 }],
      discountId: discount.id,
      discountType: discount.discount_type,
      customer: { id: 'customer-1' },
    })).rejects.toMatchObject({ status: 400 });

    expect(DiscountEngine.manualEligibilityFailures).toHaveBeenCalledWith(
      discount,
      expect.objectContaining({ id: 'customer-1' }),
      expect.objectContaining({ subtotal: 50 })
    );
  });

  test('preserves service scope when pricing recurring child add-ons', () => {
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 50,
      primaryServiceKey: 'general_pest',
      primaryServiceCategory: 'pest_control',
      appointmentDiscount: {
        discountType: 'free_service',
        discountAmount: 0,
        serviceKeyFilter: 'general_pest',
        serviceCategoryFilter: null,
      },
    }, [{
      price: 100,
      serviceKey: 'termite_addon',
      serviceCategory: 'termite',
    }]);

    expect(financials).toEqual({
      price: 100,
      appointmentDiscountDollars: 50,
    });
  });

  test('reapplies stored scope when auto-extending a recurring visit', () => {
    const parent = {
      service_id: 'primary-service',
      primary_line_price: 50,
      line_discount_dollars: 0,
      discount_type: 'free_service',
      discount_amount: 0,
    };
    const addons = [{ service_id: 'addon-service', estimated_price: 100 }];
    const scope = {
      isScoped: true,
      serviceKeyFilter: 'general_pest',
      serviceCategoryFilter: null,
      servicesById: new Map([
        ['primary-service', { id: 'primary-service', service_key: 'general_pest', category: 'pest_control' }],
        ['addon-service', { id: 'addon-service', service_key: 'termite_addon', category: 'termite' }],
      ]),
    };

    expect(calculateStoredVisitFinancials(parent, addons, addons, scope)).toEqual({
      price: 100,
      appointmentDiscountDollars: 50,
    });
  });
});
