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
  buildPercentExclusionCatalog,
  appointmentDiscountIdentityChanged,
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

  test('resolves percent-discount exclusion by engine identity, then explicit aliases', () => {
    const catalog = buildPercentExclusionCatalog([
      { service_key: 'rodent_bait_quarterly', engine_keys: ['rodent_bait'] },
      { service_key: 'rodent_bait_setup', engine_keys: '["rodent_bait_setup"]' },
      { service_key: 'bed_bug_treatment', engine_keys: ['bed_bug', 'bed_bug_chemical'] },
      { service_key: 'termite_bait', engine_keys: ['termite_bait'] },
      { service_key: 'termite_bond_1yr', engine_keys: null },
    ]);
    // engine identity wins — including over a would-be prefix guess
    expect(lineExcludedFromPercentDiscount('rodent_bait_quarterly', catalog)).toBe(true);
    expect(lineExcludedFromPercentDiscount('rodent_bait_setup', catalog)).toBe(false);
    expect(lineExcludedFromPercentDiscount('bed_bug_treatment', catalog)).toBe(true);
    expect(lineExcludedFromPercentDiscount('termite_bait', catalog)).toBe(false);
    // no engine link → pricing map, then the explicit alias table
    expect(lineExcludedFromPercentDiscount('termite_bond', catalog)).toBe(true);
    expect(lineExcludedFromPercentDiscount('termite_bond_1yr', catalog)).toBe(true);
    expect(lineExcludedFromPercentDiscount('termite_bond_5yr', catalog)).toBe(true);
    expect(lineExcludedFromPercentDiscount('palm_injection_semiannual', catalog)).toBe(true);
    // the archived nutritional program is NOT an injection variant (r11 P1)
    expect(lineExcludedFromPercentDiscount('palm_treatment', catalog)).toBe(false);
    expect(lineExcludedFromPercentDiscount('rodent_bait', catalog)).toBe(true);
    // unknown prefixed keys are NOT inferred
    expect(lineExcludedFromPercentDiscount('rodent_bait_setup', new Map())).toBe(false);
    expect(lineExcludedFromPercentDiscount('pest_general_quarterly', catalog)).toBe(false);
    expect(lineExcludedFromPercentDiscount(null, catalog)).toBe(false);
  });

  test('a preset replaced by an equivalent custom discount counts as a discount change', () => {
    const existing = { discount_type: 'percentage', discount_amount: 10, discount_id: 'preset-termite' };
    expect(appointmentDiscountIdentityChanged(existing, undefined)).toBe(true);
    expect(appointmentDiscountIdentityChanged(existing, 'preset-other')).toBe(true);
    expect(appointmentDiscountIdentityChanged(existing, 'preset-termite')).toBe(false);
    expect(appointmentDiscountIdentityChanged({ discount_id: null }, undefined)).toBe(false);
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

  test('parent creation honors the preset cap, including an explicit $0 (r11 P1)', async () => {
    const capped = {
      id: 'discount-capped',
      name: '10% capped at $5',
      discount_type: 'percentage',
      amount: 10,
      max_discount_dollars: 5,
    };
    db.mockReturnValueOnce(discountQuery(capped));
    DiscountEngine.manualEligibilityFailures.mockResolvedValue([]);
    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'pest_general_quarterly', category: 'pest_control', base_price: 200 },
      estimatedPrice: 200,
      serviceAddons: [],
      discountId: capped.id,
      discountType: capped.discount_type,
      customer: { id: 'customer-1' },
    });
    expect(pricing.appointmentDiscount.discountDollars).toBe(5);
    expect(pricing.finalPrice).toBe(195);

    // a numeric 0 cap is a real cap, not "uncapped" — children clamp to $0
    // via calculateVisitFinancialsForAddons, so the parent must too
    const zeroCapped = { ...capped, id: 'discount-zero', max_discount_dollars: 0 };
    db.mockReturnValueOnce(discountQuery(zeroCapped));
    DiscountEngine.manualEligibilityFailures.mockResolvedValue([]);
    const zeroPricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'pest_general_quarterly', category: 'pest_control', base_price: 200 },
      estimatedPrice: 200,
      serviceAddons: [],
      discountId: zeroCapped.id,
      discountType: zeroCapped.discount_type,
      customer: { id: 'customer-1' },
    });
    expect(zeroPricing.appointmentDiscount.discountDollars).toBe(0);
    expect(zeroPricing.finalPrice).toBe(200);
  });

  test('honors a preset max_discount_dollars cap on edit like creation does', () => {
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 200,
      primaryServiceKey: 'pest_general_quarterly',
      primaryServiceCategory: 'pest_control',
      appointmentDiscount: {
        discountType: 'percentage',
        discountAmount: 10,
        maxDiscountDollars: 5,
        serviceKeyFilter: null,
        serviceCategoryFilter: null,
      },
    }, []);
    expect(financials).toEqual({ price: 195, appointmentDiscountDollars: 5 });
    // an explicit $0 cap (Postgres hands it back as "0.00") is a real cap
    const zero = calculateVisitFinancialsForAddons({
      primaryNet: 200,
      primaryServiceKey: 'pest_general_quarterly',
      primaryServiceCategory: 'pest_control',
      appointmentDiscount: { discountType: 'percentage', discountAmount: 10, maxDiscountDollars: '0.00', serviceKeyFilter: null, serviceCategoryFilter: null },
    }, []);
    expect(zero).toEqual({ price: 200, appointmentDiscountDollars: null });
  });

  test('stored replays honor the snapshotted preset cap', () => {
    const parent = {
      service_id: 'pest-service',
      service_key_snapshot: 'pest_general_quarterly',
      primary_line_price: 200,
      line_discount_dollars: 0,
      discount_type: 'percentage',
      discount_amount: 10,
      discount_max_dollars: 5,
    };
    expect(calculateStoredVisitFinancials(parent, [], [], null)).toEqual({ price: 195, appointmentDiscountDollars: 5 });
    const groups = computePriceServiceGroupChanges(
      { primary_line_price: 200, discount_type: 'percentage', discount_amount: 10, discount_id: 'uncapped' },
      { primary_line_price: 200, discount_type: 'percentage', discount_amount: 10, discount_id: 'capped', discount_max_dollars: 5 },
    );
    expect(groups.priceChanged).toBe(true);
    expect(groups.fields.discount_max_dollars).toBe(5);
    // a catalog cap change on the SAME preset still counts (r8 P1)
    expect(computePriceServiceGroupChanges(
      { primary_line_price: 200, discount_type: 'percentage', discount_amount: 10, discount_id: 'capped', discount_max_dollars: 5 },
      { primary_line_price: 200, discount_type: 'percentage', discount_amount: 10, discount_id: 'capped', discount_max_dollars: 8 },
    ).priceChanged).toBe(true);
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
