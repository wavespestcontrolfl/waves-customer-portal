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
  bookingCreatesWaveGuardCoverage,
  buildAppointmentPricing,
  calculateVisitFinancialsForAddons,
  calculateStoredVisitFinancials,
  lineExcludedFromPercentDiscount,
  isPercentDiscountType,
  computePriceServiceGroupChanges,
  loadStoredDiscountScope,
  clearAppointmentDiscountCatalogFields,
  appointmentDiscountInputChanged,
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
        recurringMembershipBooking: false,
      }
    );
  });

  test('threads the recurring-membership booking context to every eligibility check', async () => {
    const discount = {
      id: 'discount-1',
      name: 'WaveGuard Member Discount',
      discount_type: 'percentage',
      amount: 15,
      requires_waveguard_tier: 'Bronze',
    };
    db.mockReturnValueOnce(discountQuery(discount));
    DiscountEngine.manualEligibilityFailures.mockResolvedValue([]);

    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'pest_general_quarterly', category: 'pest_control', base_price: 150 },
      estimatedPrice: 150,
      serviceAddons: [],
      discountId: discount.id,
      discountType: discount.discount_type,
      customer: { id: 'customer-1', waveguard_tier: null },
      recurringMembershipBooking: true,
    });

    expect(DiscountEngine.manualEligibilityFailures).toHaveBeenCalledWith(
      discount,
      expect.objectContaining({ id: 'customer-1' }),
      expect.objectContaining({ recurringMembershipBooking: true })
    );
    expect(pricing.appointmentDiscount.discountDollars).toBe(22.5);
    expect(pricing.finalPrice).toBe(127.5);
  });

  test('recognizes which bookings create WaveGuard plan coverage', () => {
    const quarterlyPest = {
      serviceType: 'General Pest Control',
      serviceRecord: { service_key: 'pest_general_quarterly', name: 'Quarterly Pest Control' },
      customer: { id: 'customer-1', waveguard_tier: null },
      scheduledDate: '2099-01-04',
    };

    expect(bookingCreatesWaveGuardCoverage({
      isRecurring: true, isCallback: false, ...quarterlyPest,
    })).toBe(true);
    // One-time bookings never enroll anyone.
    expect(bookingCreatesWaveGuardCoverage({
      isRecurring: false, isCallback: false, ...quarterlyPest,
    })).toBe(false);
    // Callbacks/re-services are free re-treatments, never plan coverage.
    expect(bookingCreatesWaveGuardCoverage({
      isRecurring: true, isCallback: true, ...quarterlyPest,
    })).toBe(false);
    // Rodent-led recurring work is not a WaveGuard plan family.
    expect(bookingCreatesWaveGuardCoverage({
      isRecurring: true,
      isCallback: false,
      ...quarterlyPest,
      serviceType: 'Rodent Trapping',
      serviceRecord: { service_key: 'rodent_trapping', name: 'Rodent Trapping' },
    })).toBe(false);
    // Commercial rows are flat plans outside the residential tiers.
    expect(bookingCreatesWaveGuardCoverage({
      isRecurring: true,
      isCallback: false,
      ...quarterlyPest,
      serviceType: 'Commercial Pest Control',
      serviceRecord: { service_key: 'commercial_pest', name: 'Commercial Pest Control' },
    })).toBe(false);
    // Commercial-sentinel customers are outside the residential tier system
    // entirely — enrollment fail-closes on them and so does this evidence.
    expect(bookingCreatesWaveGuardCoverage({
      isRecurring: true,
      isCallback: false,
      ...quarterlyPest,
      customer: { id: 'customer-2', waveguard_tier: 'Commercial' },
    })).toBe(false);
    // A past-dated series is backfill, not upcoming coverage — the tier sync
    // only counts upcoming rows, so it must not buy member pricing either.
    expect(bookingCreatesWaveGuardCoverage({
      isRecurring: true, isCallback: false, ...quarterlyPest, scheduledDate: '2020-01-01',
    })).toBe(false);
    expect(bookingCreatesWaveGuardCoverage({
      isRecurring: true, isCallback: false, ...quarterlyPest, scheduledDate: null,
    })).toBe(false);
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

  test('reapplies a category-scoped discount after add-ons are replaced', () => {
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 100,
      primaryServiceKey: 'general_pest',
      primaryServiceCategory: 'pest_control',
      appointmentDiscount: {
        discountType: 'free_service',
        discountAmount: 0,
        serviceKeyFilter: null,
        serviceCategoryFilter: 'termite',
      },
    }, [{
      price: 50,
      serviceKey: 'termite_addon',
      serviceCategory: 'termite',
    }]);

    expect(financials).toEqual({
      price: 100,
      appointmentDiscountDollars: 50,
    });
  });

  test('maps term-suffixed catalog keys onto the percent-discount exclusion family', () => {
    expect(lineExcludedFromPercentDiscount('termite_bond_1yr')).toBe(true);
    expect(lineExcludedFromPercentDiscount('termite_bond')).toBe(true);
    expect(lineExcludedFromPercentDiscount('rodent_bait')).toBe(true);
    expect(lineExcludedFromPercentDiscount('termite_bond_5yr')).toBe(true);
    expect(lineExcludedFromPercentDiscount('palm_injection_semiannual')).toBe(true);
    expect(lineExcludedFromPercentDiscount('rodent_bait_quarterly')).toBe(true);
    expect(lineExcludedFromPercentDiscount('bed_bug_treatment')).toBe(true);
    expect(lineExcludedFromPercentDiscount('termite_bait')).toBe(false);
    expect(lineExcludedFromPercentDiscount('pest_general_quarterly')).toBe(false);
    expect(lineExcludedFromPercentDiscount(null)).toBe(false);
  });

  test('keeps the termite bond out of a percentage appointment discount', () => {
    // Quarterly pest $117 + bait $105.30 + bond $60, WaveGuard Silver 10%:
    // the bond is a fixed warranty rider and never takes the bundle %.
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 117,
      primaryServiceKey: 'pest_general_quarterly',
      primaryServiceCategory: 'pest_control',
      appointmentDiscount: {
        discountType: 'percentage',
        discountAmount: 10,
        serviceKeyFilter: null,
        serviceCategoryFilter: null,
      },
    }, [
      { price: 105.3, serviceKey: 'termite_bait', serviceCategory: 'termite' },
      { price: 60, serviceKey: 'termite_bond_1yr', serviceCategory: 'termite' },
    ]);

    expect(financials).toEqual({
      price: 260.07,
      appointmentDiscountDollars: 22.23,
    });
  });

  test('treats variable percentages like percentages for the exclusion', () => {
    expect(isPercentDiscountType('percentage')).toBe(true);
    expect(isPercentDiscountType('variable_percentage')).toBe(true);
    expect(isPercentDiscountType('fixed_amount')).toBe(false);
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 100,
      primaryServiceKey: 'pest_general_quarterly',
      primaryServiceCategory: 'pest_control',
      appointmentDiscount: {
        discountType: 'variable_percentage',
        discountAmount: 10,
        serviceKeyFilter: null,
        serviceCategoryFilter: null,
      },
    }, [{ price: 60, serviceKey: 'termite_bond_1yr', serviceCategory: 'termite' }]);
    expect(financials).toEqual({ price: 150, appointmentDiscountDollars: 10 });
  });

  test('prices the initially created visit with the same bond exclusion as its children', async () => {
    const discount = {
      id: 'discount-silver',
      name: 'WaveGuard Silver',
      discount_type: 'percentage',
      amount: 10,
    };
    db
      .mockReturnValueOnce(discountQuery({ service_key: 'termite_bond_1yr', category: 'termite', base_price: 60 }))
      .mockReturnValueOnce(discountQuery(discount));
    DiscountEngine.manualEligibilityFailures.mockResolvedValue([]);

    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'pest_general_quarterly', category: 'pest_control', base_price: 117 },
      estimatedPrice: 117,
      serviceAddons: [{ serviceId: 'bond-1', name: 'Termite Bond Service (1-Year Term)', price: 60 }],
      discountId: discount.id,
      discountType: discount.discount_type,
      customer: { id: 'customer-1' },
    });

    expect(pricing.appointmentDiscount.discountDollars).toBe(11.7);
    expect(pricing.finalPrice).toBe(165.3);
  });

  test('treats a same-valued preset switch with a different scope as a price change', () => {
    const before = {
      primary_line_price: 117,
      discount_type: 'percentage',
      discount_amount: 10,
      discount_id: 'preset-unscoped',
      discount_service_key_filter: null,
      discount_service_category_filter: null,
    };
    const updates = {
      primary_line_price: 117,
      discount_type: 'percentage',
      discount_amount: 10,
      discount_id: 'preset-termite',
      discount_service_key_filter: null,
      discount_service_category_filter: 'termite',
    };
    const groups = computePriceServiceGroupChanges(before, updates);
    expect(groups.priceChanged).toBe(true);
    expect(groups.fields.discount_id).toBe('preset-termite');
    expect(groups.fields.discount_service_category_filter).toBe('termite');
    expect(computePriceServiceGroupChanges(before, { ...updates, discount_id: 'preset-unscoped', discount_service_category_filter: null }).priceChanged).toBe(false);
  });

  test('still spreads a fixed-dollar appointment discount across every line', () => {
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 100,
      primaryServiceKey: 'pest_general_quarterly',
      primaryServiceCategory: 'pest_control',
      appointmentDiscount: {
        discountType: 'fixed_amount',
        discountAmount: 25,
        serviceKeyFilter: null,
        serviceCategoryFilter: null,
      },
    }, [{ price: 60, serviceKey: 'termite_bond_1yr', serviceCategory: 'termite' }]);

    expect(financials).toEqual({ price: 135, appointmentDiscountDollars: 25 });
  });

  test('keeps the bond out of the percentage base on stored replays', () => {
    const parent = {
      service_id: 'pest-service',
      service_key_snapshot: 'pest_general_quarterly',
      primary_line_price: 117,
      line_discount_dollars: 0,
      discount_type: 'percentage',
      discount_amount: 10,
    };
    const addons = [
      { service_id: 'bait-service', service_key_snapshot: 'termite_bait', estimated_price: 105.3 },
      { service_id: 'bond-service', service_key_snapshot: 'termite_bond_1yr', estimated_price: 60 },
    ];

    expect(calculateStoredVisitFinancials(parent, addons, addons, null)).toEqual({
      price: 260.07,
      appointmentDiscountDollars: 22.23,
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

  test('loads immutable stored scope without rereading the discount catalog', async () => {
    const database = jest.fn(() => { throw new Error('Catalog must not be queried'); });

    const scope = await loadStoredDiscountScope(database, {
      service_id: 'primary-service',
      service_key_snapshot: 'general_pest',
      service_category_snapshot: 'pest_control',
      discount_service_key_filter: 'general_pest',
      discount_service_category_filter: null,
    });

    expect(database).not.toHaveBeenCalled();
    expect(scope.serviceKeyFilter).toBe('general_pest');
    expect(scope.servicesById.get('primary-service')).toMatchObject({ service_key: 'general_pest' });
  });

  test('aborts recurring pricing when a scoped service identity snapshot is missing', async () => {
    const database = jest.fn();

    await expect(loadStoredDiscountScope(database, {
      service_id: 'missing-service',
      discount_service_key_filter: 'general_pest',
    })).rejects.toThrow(/identity snapshot is missing/);
    expect(database).not.toHaveBeenCalled();
  });

  test('clears an old scope snapshot when an appointment discount changes', () => {
    expect(appointmentDiscountInputChanged({
      discount_type: 'percentage',
      discount_amount: 10,
    }, 'fixed_amount', 25)).toBe(true);
    expect(appointmentDiscountInputChanged({
      discount_type: 'percentage',
      discount_amount: 10,
    }, 'percentage', 10)).toBe(false);

    const updates = {
      discount_id: 'discount-1',
      discount_name: 'Scoped discount',
      discount_service_key_filter: 'general_pest',
      discount_service_category_filter: 'pest_control',
    };
    const cols = {
      discount_id: {},
      discount_name: {},
      discount_service_key_filter: {},
      discount_service_category_filter: {},
    };
    clearAppointmentDiscountCatalogFields(updates, cols);

    expect(updates).toMatchObject({
      discount_id: null,
      discount_name: null,
      discount_service_key_filter: null,
      discount_service_category_filter: null,
    });
  });
});
