const {
  buildCustomerPricingResponse,
  inferRequestedServices,
  serviceKeyFromText,
} = require('../services/customer-pricing-ai');

function dbForTables(tables = {}) {
  return (table) => {
    const rows = tables[table] || [];
    const q = {
      where() { return q; },
      whereNotIn() { return q; },
      orWhereNull() { return q; },
      select() { return rows; },
      limit() { return rows; },
      first() { return rows[0] || null; },
      columnInfo() {
        return table === 'scheduled_services' ? { is_recurring: {} } : {};
      },
    };
    return q;
  };
}

function activePlanDb(customerId, serviceTypes, tier = 'Bronze') {
  return dbForTables({
    customers: [{ id: customerId, active: true, waveguard_tier: tier, monthly_rate: 55 }],
    scheduled_services: serviceTypes.map((service_type, index) => ({
      id: `svc-${index + 1}`,
      service_type,
      scheduled_date: '2026-08-01',
      status: 'scheduled',
      is_recurring: true,
    })),
  });
}

const propertyCustomer = (overrides = {}) => ({
  id: 'cust-1',
  waveguard_tier: 'Bronze',
  monthly_rate: 55,
  property_sqft: 2200,
  lot_sqft: 7000,
  lawn_type: 'St. Augustine',
  ...overrides,
});

describe('customer pricing AI helpers', () => {
  test('infers services from natural language', () => {
    expect(serviceKeyFromText('I am interested in adding lawn care')).toBe('lawn_care');
    expect(inferRequestedServices('Can you price mosquito service?', new Set())).toEqual(['mosquito']);
    expect(inferRequestedServices('Can you add rodent bait stations?', new Set())).toEqual(['rodent_bait']);
  });

  test('does not invent service coverage from a WaveGuard tier label', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: null,
      prompt: 'I am interested in adding lawn care',
      customer: propertyCustomer({ waveguard_tier: 'Silver', monthly_rate: 110 }),
    });

    expect(result.currentServices).toEqual([]);
    expect(result.alreadyIncluded).not.toContain('Lawn Care');
    expect(result.options.length).toBeGreaterThan(0);
  });

  test('does not re-price a service present in authoritative recurring rows', async () => {
    const customer = propertyCustomer({ id: 'cust-existing', waveguard_tier: 'Silver' });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Quarterly Pest Control', 'Lawn Care'], 'Silver'),
      propertyLookup: null,
      prompt: 'I am interested in adding lawn care',
      customer,
    });

    expect(result.currentServices).toEqual(expect.arrayContaining(['Pest Control', 'Lawn Care']));
    expect(result.alreadyIncluded).toContain('Lawn Care');
    expect(result.options).toEqual([]);
  });

  test('prices a requested service from the customer property profile', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: null,
      prompt: 'I am interested in adding lawn care',
      customer: propertyCustomer({ id: 'cust-price' }),
    });

    expect(result.ok).toBe(true);
    expect(result.requestedServices).toContain('Lawn Care');
    expect(result.property.source).toBe('customer_profile');
    expect(result.options.some(option => option.monthly > 0)).toBe(true);
  });

  test('palm injection pricing prompts for palm count instead of defaulting to one', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: null,
      prompt: 'I am interested in palm injection',
      customer: propertyCustomer({ id: 'cust-palm' }),
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'PROPERTY_DETAILS_NEEDED',
      message: 'Palm count is required for palm injection pricing.',
    });
  });

  test('uses lookup-provided stories when customer stories are missing', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      prompt: 'I am interested in adding termite protection',
      propertyLookup: async () => ({
        enriched: { homeSqFt: 2400, lotSqFt: 7000, stories: 2 },
      }),
      customer: {
        id: 'cust-lookup',
        monthly_rate: 55,
        address_line1: '123 Gulf Dr',
        city: 'Sarasota',
        state: 'FL',
        zip: '34236',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.property.source).toBe('property_lookup');
    expect(result.property.stories).toBe(2);
  });

  test('uses modeled baseline for add-on delta when billing differs', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: null,
      prompt: 'I am interested in adding lawn care',
      customer: propertyCustomer({ id: 'cust-mismatch', monthly_rate: 500 }),
    });
    const option = result.options[0];

    expect(option.estimatedAdditionalMonthly).toBeGreaterThan(0);
    expect(option.estimatedPlanMonthly).toBeNull();
    expect(option.notes.some(note => note.includes('current billing differs'))).toBe(true);
  });
});

describe('count-based WaveGuard tier truth', () => {
  test('target-tier-only requests require the customer to choose actual services', async () => {
    const customer = propertyCustomer({ id: 'cust-tier', waveguard_tier: 'Gold' });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Pest Control', 'Lawn Care', 'Termite Bait Monitoring'], 'Gold'),
      propertyLookup: null,
      prompt: 'Price WaveGuard Platinum',
      targetTier: 'Platinum',
      customer,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'SERVICES_REQUIRED_FOR_TIER',
      targetTier: 'Platinum',
      requiredServiceCount: 4,
      additionalServiceCount: 1,
      options: [],
    });
    expect(result.currentServices).toEqual(expect.arrayContaining([
      'Pest Control',
      'Lawn Care',
      'Termite Bait Monitoring',
    ]));
    expect(result.message).toMatch(/choose the 1 service/i);
  });

  test('a stored Gold label does not fabricate three current services', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: null,
      prompt: 'Price WaveGuard Platinum',
      targetTier: 'Platinum',
      customer: propertyCustomer({ id: 'cust-no-rows', waveguard_tier: 'Gold' }),
    });

    expect(result.currentServices).toEqual([]);
    expect(result.additionalServiceCount).toBe(4);
    expect(result.options).toEqual([]);
  });

  test('reports an already-earned tier from any qualifying service combination', async () => {
    const customer = propertyCustomer({ id: 'cust-any-combo', waveguard_tier: 'Silver' });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Mosquito Control', 'Termite Bait Monitoring'], 'Silver'),
      propertyLookup: null,
      prompt: 'Price WaveGuard Silver',
      targetTier: 'Silver',
      customer,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'TARGET_TIER_ALREADY_EARNED',
      requiredServiceCount: 2,
      additionalServiceCount: 0,
      options: [],
    });
    expect(result.currentServices).toEqual(expect.arrayContaining([
      'Mosquito Control',
      'Termite Bait Monitoring',
    ]));
  });
});
