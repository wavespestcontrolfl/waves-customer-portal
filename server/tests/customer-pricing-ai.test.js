const {
  buildCustomerPricingResponse,
  inferRequestedServices,
  serviceKeyFromText,
  tierServicesForCustomer,
} = require('../services/customer-pricing-ai');

function dbForTables(tables = {}) {
  return (table) => ({
    where() { return this; },
    whereNotIn() { return this; },
    select() { return this; },
    limit() { return tables[table] || []; },
    first() { return (tables[table] || [])[0] || null; },
  });
}

function dateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

describe('customer pricing AI helpers', () => {
  test('infers lawn care from natural language', () => {
    expect(serviceKeyFromText('I am interested in adding lawn care')).toBe('lawn_care');
    expect(inferRequestedServices('Can you price mosquito service?', new Set())).toEqual(['mosquito']);
    expect(inferRequestedServices('Can you add rodent bait stations?', new Set())).toEqual(['rodent_bait']);
  });

  test('uses WaveGuard tier as current-service context', () => {
    expect(tierServicesForCustomer({ waveguard_tier: 'Silver' })).toEqual(['pest_control', 'lawn_care']);
    expect(tierServicesForCustomer({ waveguard_tier: 'One-Time' })).toEqual([]);
  });

  test('does not re-price a service already included on the property', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: null,
      prompt: 'I am interested in adding lawn care',
      customer: {
        id: 'cust-1',
        waveguard_tier: 'Silver',
        monthly_rate: 110,
        property_sqft: 2200,
        lot_sqft: 7000,
        lawn_type: 'St. Augustine',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.alreadyIncluded).toContain('Lawn Care');
    expect(result.options).toEqual([]);
  });

  test('prices requested service from the customer property profile', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: null,
      prompt: 'I am interested in adding lawn care',
      customer: {
        id: 'cust-2',
        waveguard_tier: 'Bronze',
        monthly_rate: 55,
        property_sqft: 2200,
        lot_sqft: 7000,
        lawn_type: 'St. Augustine',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.requestedServices).toContain('Lawn Care');
    expect(result.property.source).toBe('customer_profile');
    expect(result.options.length).toBeGreaterThan(0);
    expect(result.options.some(option => option.monthly > 0)).toBe(true);
  });

  test('uses lookup-provided stories when customer stories are missing', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      prompt: 'I am interested in adding termite protection',
      propertyLookup: async () => ({
        enriched: {
          homeSqFt: 2400,
          lotSqFt: 7000,
          stories: 2,
        },
      }),
      customer: {
        id: 'cust-3',
        waveguard_tier: 'Bronze',
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

  test('ignores historical scheduled services when deciding current services', async () => {
    const result = await buildCustomerPricingResponse({
      db: dbForTables({
        scheduled_services: [
          { service_type: 'Lawn Care', status: 'completed', scheduled_date: dateOffset(-14) },
        ],
      }),
      propertyLookup: null,
      prompt: 'I am interested in adding lawn care',
      customer: {
        id: 'cust-4',
        waveguard_tier: 'Bronze',
        monthly_rate: 55,
        property_sqft: 2200,
        lot_sqft: 7000,
        lawn_type: 'St. Augustine',
      },
    });

    expect(result.alreadyIncluded).not.toContain('Lawn Care');
    expect(result.options.length).toBeGreaterThan(0);
  });

  test('uses modeled baseline for add-on delta when billing differs', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: null,
      prompt: 'I am interested in adding lawn care',
      customer: {
        id: 'cust-5',
        waveguard_tier: 'Bronze',
        monthly_rate: 500,
        property_sqft: 2200,
        lot_sqft: 7000,
        lawn_type: 'St. Augustine',
      },
    });
    const option = result.options[0];

    expect(option.estimatedAdditionalMonthly).toBeGreaterThan(0);
    expect(option.estimatedPlanMonthly).toBeNull();
    expect(option.notes.some(note => note.includes('current billing differs'))).toBe(true);
  });

  test('prices a target WaveGuard tier as one plan option', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: null,
      prompt: 'Price WaveGuard Platinum',
      targetTier: 'Platinum',
      customer: {
        id: 'cust-6',
        waveguard_tier: 'Gold',
        monthly_rate: 140,
        property_sqft: 2200,
        lot_sqft: 7000,
        lawn_type: 'St. Augustine',
      },
    });

    expect(result.mode).toBe('waveguard_tier');
    expect(result.targetTier).toBe('Platinum');
    expect(result.options).toHaveLength(1);
    expect(result.options[0].label).toBe('WaveGuard Platinum');
    expect(result.options[0].cadence).toContain('Tree & Shrub Care');
  });

  test('target tier pricing keeps existing non-tier recurring services', async () => {
    const customer = {
      id: 'cust-7',
      waveguard_tier: 'Gold',
      monthly_rate: 140,
      property_sqft: 2200,
      lot_sqft: 7000,
      lawn_type: 'St. Augustine',
    };
    const base = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: null,
      prompt: 'Price WaveGuard Platinum',
      targetTier: 'Platinum',
      customer,
    });
    const withTermite = await buildCustomerPricingResponse({
      db: dbForTables({
        scheduled_services: [
          { service_type: 'Termite Bait Monitoring', status: 'pending', scheduled_date: dateOffset(14) },
        ],
      }),
      propertyLookup: null,
      prompt: 'Price WaveGuard Platinum',
      targetTier: 'Platinum',
      customer,
    });

    expect(withTermite.currentServices).toContain('Termite Bait Monitoring');
    expect(withTermite.options[0].monthly).toBeGreaterThan(base.options[0].monthly);
  });

  test('target tier pricing promotes quotes when existing qualifiers derive a higher tier', async () => {
    const result = await buildCustomerPricingResponse({
      db: dbForTables({
        scheduled_services: [
          { service_type: 'Termite Bait Monitoring', status: 'pending', scheduled_date: dateOffset(14) },
        ],
      }),
      propertyLookup: null,
      prompt: 'Price WaveGuard Gold',
      targetTier: 'Gold',
      customer: {
        id: 'cust-8',
        waveguard_tier: 'Silver',
        monthly_rate: 108,
        property_sqft: 2200,
        lot_sqft: 7000,
        lawn_type: 'St. Augustine',
      },
    });

    expect(result.targetTier).toBe('Platinum');
    expect(result.selectedTier).toBe('Gold');
    expect(result.currentServices).toContain('Termite Bait Monitoring');
    expect(result.options[0].label).toBe('WaveGuard Platinum');
    expect(result.options[0].cadence).toContain('Tree & Shrub Care');
    expect(result.options[0].waveguardTier).toBe('Platinum');
  });

  test('target tier pricing rejects same or lower tiers', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: null,
      prompt: 'Price WaveGuard Silver',
      targetTier: 'Silver',
      customer: {
        id: 'cust-9',
        waveguard_tier: 'Gold',
        monthly_rate: 140,
        property_sqft: 2200,
        lot_sqft: 7000,
        lawn_type: 'St. Augustine',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('TARGET_TIER_NOT_UPGRADE');
    expect(result.currentTier).toBe('Gold');
    expect(result.options).toEqual([]);
  });

  test('target tier pricing carries plan-level manual review warnings', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: null,
      prompt: 'Price WaveGuard Platinum',
      targetTier: 'Platinum',
      customer: {
        id: 'cust-10',
        waveguard_tier: 'Gold',
        monthly_rate: 140,
        property_sqft: 2200,
        lot_sqft: 12000,
        tree_count: 20,
        lawn_type: 'St. Augustine',
      },
    });
    const option = result.options[0];

    expect(result.ok).toBe(true);
    expect(option.manualReview).toBe(true);
    expect(option.confidence).toBe('low');
    expect(option.notes.some(note => note.includes('High tree count'))).toBe(true);
  });
});
