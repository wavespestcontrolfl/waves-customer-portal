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
});
