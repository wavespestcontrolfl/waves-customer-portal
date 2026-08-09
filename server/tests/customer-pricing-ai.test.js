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
      leftJoin() { return q; },
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
      scheduled_date: FUTURE_SCHEDULED_DATE,
      status: 'scheduled',
      is_recurring: true,
    })),
  });
}

// Recurring-plan rows must be UPCOMING to count as live obligations (the
// ownership loader applies the lifecycle evidence unconditionally) — compute
// the date so the suite never ages out.
const FUTURE_SCHEDULED_DATE = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);

// property_sqft is TREATED LAWN AREA by schema, so a building footprint can
// only come from the lookup — these fixtures carry the address every real
// customer row has so that lookup can run.
const propertyCustomer = (overrides = {}) => ({
  id: 'cust-1',
  waveguard_tier: 'Bronze',
  monthly_rate: 55,
  property_sqft: 2200,
  lot_sqft: 7000,
  lawn_type: 'St. Augustine',
  address_line1: '123 Gulf Dr',
  city: 'Sarasota',
  state: 'FL',
  zip: '34236',
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
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
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
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'I am interested in adding lawn care',
      customer,
    });

    expect(result.currentServices).toEqual(expect.arrayContaining(['Pest Control', 'Lawn Care']));
    expect(result.alreadyIncluded).toContain('Lawn Care');
    expect(result.options).toEqual([]);
  });

  test('upgrade wording does not re-price a service the customer already has', async () => {
    // Owner ruling 2026-08-06: an existing service is never re-quoted from the
    // property profile — their live rate may predate a price change. Upgrade
    // wording used to bypass the already-included filter.
    const customer = propertyCustomer({ id: 'cust-upgrade', waveguard_tier: 'Silver' });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Quarterly Pest Control', 'Lawn Care'], 'Silver'),
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'I want to upgrade my lawn care to something better',
      customer,
    });

    expect(result.alreadyIncluded).toContain('Lawn Care');
    expect(result.options.every(o => o.serviceKey !== 'lawn_care')).toBe(true);
    expect(result.message).toMatch(/not re-pricing/i);
  });

  test('a mixed request prices the new service and still flags the owned one', async () => {
    const customer = propertyCustomer({ id: 'cust-mixed', waveguard_tier: 'Silver' });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Quarterly Pest Control', 'Lawn Care'], 'Silver'),
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'upgrade my lawn care and add mosquito control',
      customer,
    });

    expect(result.alreadyIncluded).toContain('Lawn Care');
    expect(result.options.every(o => o.serviceKey !== 'lawn_care')).toBe(true);
    // The owned half must survive in the reply even though the new half priced.
    expect(result.message).toMatch(/not re-pricing/i);
  });

  test('prices a requested service from the customer property profile', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'I am interested in adding lawn care',
      customer: propertyCustomer({ id: 'cust-price' }),
    });

    expect(result.ok).toBe(true);
    expect(result.requestedServices).toContain('Lawn Care');
    expect(result.property.source).toBe('customer_profile_plus_property_lookup');
    expect(result.options.some(option => option.monthly > 0)).toBe(true);
  });

  test('palm injection pricing prompts for palm count instead of defaulting to one', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
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
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
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
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
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
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
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
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
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

// Codex #3253 r2 regressions: the ownership guard's four escape hatches.
describe('never-re-price guard, r2 regressions', () => {
  test('owned-only request with no home sqft returns the not-re-pricing answer, not PROPERTY_DETAILS_NEEDED', async () => {
    const customer = propertyCustomer({
      id: 'cust-owned-nosqft',
      waveguard_tier: 'Silver',
      property_sqft: null,
      lot_sqft: null,
    });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Quarterly Pest Control', 'Lawn Care'], 'Silver'),
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'I want to upgrade my lawn care',
      customer,
    });

    expect(result.code).not.toBe('PROPERTY_DETAILS_NEEDED');
    expect(result.ok).toBe(true);
    expect(result.alreadyIncluded).toContain('Lawn Care');
    expect(result.options).toEqual([]);
    expect(result.message).toMatch(/not re-pricing/i);
  });

  test('mixed request carries the owned half into every priced option requestDescription', async () => {
    const customer = propertyCustomer({ id: 'cust-mixed-desc', waveguard_tier: 'Silver' });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Quarterly Pest Control', 'Lawn Care'], 'Silver'),
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'upgrade my lawn care and add mosquito control',
      customer,
    });

    expect(result.options.length).toBeGreaterThan(0);
    // Staff read the submitted option's requestDescription, not
    // result.message — the owned upgrade ask must reach them there.
    for (const option of result.options) {
      expect(option.requestDescription).toMatch(/Lawn Care/);
      expect(option.requestDescription).toMatch(/already active/i);
    }
  });

  test('recurring rodent monitoring blocks a fresh rodent quote even though it never qualifies for a tier', async () => {
    const customer = propertyCustomer({ id: 'cust-rodent', waveguard_tier: 'Bronze' });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Rodent Monitoring', 'Quarterly Pest Control'], 'Bronze'),
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'Can you add rodent bait stations?',
      customer,
    });

    expect(result.alreadyIncluded).toContain('Rodent Monitoring');
    expect(result.options.every(o => o.serviceKey !== 'rodent_bait')).toBe(true);
  });

  test('a plan stamped at a secondary property does not suppress a quote at the primary', async () => {
    const customerId = 'cust-multiprop';
    const db = dbForTables({
      customers: [{
        id: customerId, active: true, waveguard_tier: 'Bronze', monthly_rate: 55,
      }],
      scheduled_services: [{
        id: 'svc-secondary',
        service_type: 'Lawn Care',
        scheduled_date: FUTURE_SCHEDULED_DATE,
        status: 'scheduled',
        is_recurring: true,
        service_address_line1: '200 Oak Ave',
      }],
    });
    // The shared mock's columnInfo omits the stamped-address columns; this
    // scenario is ABOUT them, so report them present.
    const baseDb = db;
    const dbWithStamps = (table) => {
      const q = baseDb(table);
      if (table === 'scheduled_services') {
        q.columnInfo = () => ({ is_recurring: {}, service_address_line1: {}, service_address_city: {}, service_address_zip: {} });
      }
      return q;
    };
    const result = await buildCustomerPricingResponse({
      db: dbWithStamps,
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'I am interested in adding lawn care',
      customer: propertyCustomer({ id: customerId, address_line1: '100 Main St' }),
    });

    // Ownership scoped to the priced (primary) property: the Oak Ave plan
    // must not block Main St, and must not be claimed as "on this property."
    expect(result.alreadyIncluded).not.toContain('Lawn Care');
    expect(result.options.some(o => o.serviceKey === 'lawn_care')).toBe(true);
  });
});

// Pre-push P1 on the r2 batch: combined pest-and-rodent plans are
// pest-primary for qualification, but the rodent component is still owned.
describe('combined pest & rodent ownership', () => {
  test('a Pest & Rodent Control plan blocks a fresh rodent quote', async () => {
    const customer = propertyCustomer({ id: 'cust-pest-rodent', waveguard_tier: 'Bronze' });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Pest & Rodent Control'], 'Bronze'),
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'Can you add rodent bait stations?',
      customer,
    });

    expect(result.alreadyIncluded).toContain('Rodent Monitoring');
    expect(result.options.every(o => o.serviceKey !== 'rodent_bait')).toBe(true);
    // The pest half still qualifies exactly as before.
    expect(result.currentServices).toContain('Pest Control');
  });
});

// Pre-push P1 #2: ownership classification must be catalog-authoritative for
// rodent identities — pinned at the classifier level (the end-to-end path is
// behind autoWaveguardTierEnroll).
describe('ownershipKeysForRow catalog authority', () => {
  const { ownershipKeysForRow } = require('../services/waveguard-existing-services');

  test('rodent catalog identity under a stale generic service_type owns rodent only', () => {
    expect(ownershipKeysForRow({
      service_type: 'Pest Control',
      service_key: 'rodent_monitoring',
      service_name: 'Rodent Monitoring',
    })).toEqual(['rodent_bait']);
  });

  test('explicit combined pest & rodent plan owns both', () => {
    expect(ownershipKeysForRow({ service_type: 'Pest & Rodent Control' }).sort())
      .toEqual(['pest_control', 'rodent_bait']);
    expect(ownershipKeysForRow({
      service_type: 'Pest Control',
      service_key: 'pest_rodent_quarterly',
      service_name: 'Pest & Rodent Control',
    }).sort()).toEqual(['pest_control', 'rodent_bait']);
  });

  test('plain rows keep legacy classification', () => {
    expect(ownershipKeysForRow({ service_type: 'Rodent Monitoring' })).toEqual(['rodent_bait']);
    expect(ownershipKeysForRow({ service_type: 'Quarterly Pest Control' })).toEqual(['pest_control']);
  });
});

// Pre-push P1 #3: recurring termite monitoring lacks the 'bait' token the
// qualifier requires — ownership must still see it.
describe('termite monitoring ownership', () => {
  const { ownershipKeysForRow } = require('../services/waveguard-existing-services');

  test('plain recurring termite monitoring row is owned termite', () => {
    expect(ownershipKeysForRow({ service_type: 'Termite Monitoring Service' }))
      .toEqual(['termite_bait']);
  });

  test('termite catalog identity under a stale generic service_type owns termite only', () => {
    expect(ownershipKeysForRow({
      service_type: 'Pest Control',
      service_key: 'termite_monitoring',
      service_name: 'Termite Monitoring Service',
    })).toEqual(['termite_bait']);
  });

  test('an owned termite monitoring plan blocks a fresh termite quote', async () => {
    const customer = propertyCustomer({ id: 'cust-termite', waveguard_tier: 'Bronze' });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Termite Monitoring Service'], 'Bronze'),
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'How much is termite protection?',
      customer,
    });

    expect(result.options.every(o => o.serviceKey !== 'termite')).toBe(true);
  });
});

// Codex #3253 r3: commercial recurring rows are owned families; termite
// bonds are NOT bait monitoring.
describe('commercial ownership and termite bond distinction', () => {
  const { ownershipKeysForRow } = require('../services/waveguard-existing-services');

  test('commercial recurring rows map to owned residential families', () => {
    expect(ownershipKeysForRow({ service_type: 'Commercial Pest Control' })).toEqual(['pest_control']);
    expect(ownershipKeysForRow({ service_type: 'Commercial Turf Treatment Program' })).toEqual(['lawn_care']);
    expect(ownershipKeysForRow({ service_type: 'Commercial Tree & Shrub Care' })).toEqual(['tree_shrub']);
    expect(ownershipKeysForRow({ service_type: 'Commercial Mosquito Control' })).toEqual(['mosquito']);
    expect(ownershipKeysForRow({
      service_type: 'Commercial Termite Bait Monitoring',
    })).toEqual(['termite_bait']);
  });

  test('a recurring termite bond does not own bait monitoring', () => {
    expect(ownershipKeysForRow({
      service_type: 'Termite Bond',
      service_key: 'termite_bond_1yr',
      service_name: 'Termite Bond (1 Year)',
    })).toEqual([]);
  });

  test('a commercial pest plan blocks a fresh residential pest quote', async () => {
    const customer = propertyCustomer({ id: 'cust-commercial', waveguard_tier: null, monthly_rate: 189 });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Commercial Pest Control'], null),
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'How much is pest control?',
      customer,
    });

    expect(result.options.every(o => o.serviceKey !== 'pest_control')).toBe(true);
  });

  test('a termite bond customer can still price bait monitoring', async () => {
    const customer = propertyCustomer({ id: 'cust-bond', waveguard_tier: 'Bronze' });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Termite Bond'], 'Bronze'),
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'How much is termite bait monitoring?',
      customer,
    });

    expect(result.alreadyIncluded).toEqual([]);
    expect(result.options.some(o => o.serviceKey === 'termite')).toBe(true);
  });
});

// Pre-push P1 on the r3 batch: a recognized non-owning catalog product is an
// authoritative exclusion, never a fall-through to stale service_type text.
describe('bond catalog identity under stale bait service_type', () => {
  const { ownershipKeysForRow } = require('../services/waveguard-existing-services');

  test('termite bond catalog stays unowned despite a stale bait-monitoring service_type', () => {
    expect(ownershipKeysForRow({
      service_type: 'Termite Bait Monitoring',
      service_key: 'termite_bond_1yr',
      service_name: 'Termite Bond (1 Year)',
    })).toEqual([]);
  });
});

// Pre-push P1 on the r3 batch: ownership shares the qualifying loader's
// lifecycle evidence (gated) — callbacks / past phantoms / one-time booking
// sources are not live obligations and must not block quotes.
describe('ownership lifecycle evidence', () => {
  // Applied UNCONDITIONALLY (no gate): ownership is a new rule with no
  // legacy behavior to preserve.
  const loadOwnedGated = () => {
    const { loadOwnedRecurringServiceKeys } = require('../services/waveguard-existing-services');
    return loadOwnedRecurringServiceKeys;
  };
  // Relative, not hardcoded: the gated check is scheduled_date >= today (ET),
  // so a literal future date would start failing when the calendar passes it.
  const futureDate = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  test('a callback row is not ownership evidence; a live upcoming row is', async () => {
    const loadOwned = loadOwnedGated();
    const mk = (rows) => dbForTables({
      customers: [{ id: 'cust-gated', active: true, waveguard_tier: 'Bronze', monthly_rate: 55 }],
      scheduled_services: rows,
    });
    const callbackOnly = await loadOwned(mk([{
      id: 'svc-cb', service_type: 'Rodent Monitoring', scheduled_date: futureDate,
      status: 'scheduled', is_recurring: true, is_callback: true,
    }]), 'cust-gated');
    expect(callbackOnly).toEqual([]);

    const live = await loadOwned(mk([{
      id: 'svc-live', service_type: 'Rodent Monitoring', scheduled_date: futureDate,
      status: 'scheduled', is_recurring: true,
    }]), 'cust-gated');
    expect(live).toEqual(['rodent_bait']);
  });

  test('a past-only row is not ownership evidence', async () => {
    const loadOwned = loadOwnedGated();
    const owned = await loadOwned(dbForTables({
      customers: [{ id: 'cust-past', active: true, waveguard_tier: 'Bronze', monthly_rate: 55 }],
      scheduled_services: [{
        id: 'svc-past', service_type: 'Lawn Care', scheduled_date: '2025-01-01',
        status: 'scheduled', is_recurring: true,
      }],
    }), 'cust-past');
    expect(owned).toEqual([]);
  });
});

// Codex #3253 r4: rodent ownership = bait-monitoring products only; owned-only
// requests must not trigger the external property lookup.
describe('r4 regressions', () => {
  const { ownershipKeysForRow } = require('../services/waveguard-existing-services');

  test('rodent trapping / exclusion / one-time specialties are not bait-monitoring ownership', () => {
    expect(ownershipKeysForRow({
      service_type: 'Rodent Trapping', service_key: 'rodent_trapping', service_name: 'Rodent Trapping',
    })).toEqual([]);
    expect(ownershipKeysForRow({
      service_type: 'Rodent Exclusion', service_key: 'rodent_exclusion', service_name: 'Rodent Exclusion',
    })).toEqual([]);
    expect(ownershipKeysForRow({
      service_type: 'Rodent Pest Control', service_key: 'rodent_general_one_time', service_name: 'Rodent Pest Control',
    })).toEqual([]);
    // The bait-monitoring product and the combined plan still count.
    expect(ownershipKeysForRow({ service_type: 'Rodent Monitoring' })).toEqual(['rodent_bait']);
    expect(ownershipKeysForRow({ service_type: 'Pest & Rodent Control' }).sort())
      .toEqual(['pest_control', 'rodent_bait']);
  });

  test('an owned-only request never invokes the property lookup', async () => {
    const lookupSpy = jest.fn(async () => ({ enriched: { homeSqFt: 2400 } }));
    const customer = propertyCustomer({
      id: 'cust-owned-nolookup',
      waveguard_tier: 'Silver',
      property_sqft: null,
      lot_sqft: null,
      address_line1: '123 Gulf Dr',
      city: 'Sarasota',
      state: 'FL',
      zip: '34236',
    });
    const result = await buildCustomerPricingResponse({
      db: activePlanDb(customer.id, ['Quarterly Pest Control', 'Lawn Care'], 'Silver'),
      propertyLookup: lookupSpy,
      prompt: 'I want to upgrade my lawn care',
      customer,
    });

    expect(result.ok).toBe(true);
    expect(result.alreadyIncluded).toContain('Lawn Care');
    expect(result.options).toEqual([]);
    expect(lookupSpy).not.toHaveBeenCalled();
  });
});

// Codex #3253 r4 P1 follow-on: unknown ownership FAILS CLOSED — no prices.
describe('ownership lookup failure fails closed', () => {
  test('a failed catalog join withholds pricing entirely', async () => {
    const base = activePlanDb('cust-failclosed', ['Quarterly Pest Control'], 'Bronze');
    const db = (table) => {
      const q = base(table);
      if (table === 'scheduled_services as s') {
        q.select = () => { throw new Error('join exploded'); };
      }
      return q;
    };
    const result = await buildCustomerPricingResponse({
      db,
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'I am interested in adding lawn care',
      customer: propertyCustomer({ id: 'cust-failclosed' }),
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('PRICING_UNAVAILABLE');
    expect(result.options).toEqual([]);
  });
});

// Pre-push P1 on the r4 batch: an INFORMATIVE catalog identity is
// authoritative even when it owns nothing — no fall-through to stale text.
describe('non-owning catalog identities under stale service_type', () => {
  const { ownershipKeysForRow } = require('../services/waveguard-existing-services');

  test('rodent trapping catalog under stale Pest Control owns nothing', () => {
    expect(ownershipKeysForRow({
      service_type: 'Pest Control', service_key: 'rodent_trapping', service_name: 'Rodent Trapping',
    })).toEqual([]);
  });

  test('palm catalog under stale Tree & Shrub owns nothing', () => {
    expect(ownershipKeysForRow({
      service_type: 'Tree & Shrub Care', service_key: 'palm_injection', service_name: 'Palm Tree Injections',
    })).toEqual([]);
  });

  test('an uninformative catalog still defers to service_type', () => {
    expect(ownershipKeysForRow({
      service_type: 'Lawn Care', service_key: 'premium_home_plan', service_name: 'Premium Home Plan',
    })).toEqual(['lawn_care']);
  });
});

// Codex #3253 r5: key-shaped service_type values must classify; tier
// queries bypass the ownership fail-closed gate.
describe('r5 regressions', () => {
  const { ownershipKeysForRow } = require('../services/waveguard-existing-services');

  test('key-shaped service_type values classify for ownership', () => {
    expect(ownershipKeysForRow({ service_type: 'rodent_bait' })).toEqual(['rodent_bait']);
    expect(ownershipKeysForRow({ service_type: 'rodent_monitoring' })).toEqual(['rodent_bait']);
    expect(ownershipKeysForRow({ service_type: 'pest_rodent_quarterly' }).sort())
      .toEqual(['pest_control', 'rodent_bait']);
    expect(ownershipKeysForRow({ service_type: 'termite_bond_1yr' })).toEqual([]);
  });

  test('a target-tier query is answered despite an ownership lookup failure', async () => {
    const base = activePlanDb('cust-tier-fc', ['Mosquito Control', 'Termite Bait Monitoring'], 'Silver');
    const db = (table) => {
      const q = base(table);
      if (table === 'scheduled_services as s') {
        q.select = () => { throw new Error('join exploded'); };
      }
      return q;
    };
    const result = await buildCustomerPricingResponse({
      db,
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      prompt: 'Price WaveGuard Silver',
      targetTier: 'Silver',
      customer: propertyCustomer({ id: 'cust-tier-fc', waveguard_tier: 'Silver' }),
    });

    expect(result.code).toBe('TARGET_TIER_ALREADY_EARNED');
    expect(result.code).not.toBe('PRICING_UNAVAILABLE');
  });
});

// Codex #3253 r7: a visit still en_route/on_site across ET midnight is the
// customer's plan (same precedent as billed-plan logic, #3241 r5) — the
// ownership date cutoff must not drop it.
describe('live in-progress rows survive the ownership date cutoff', () => {
  const { loadOwnedRecurringServiceKeys } = require('../services/waveguard-existing-services');
  const mk = (rows) => dbForTables({
    customers: [{ id: 'cust-live', active: true, waveguard_tier: 'Bronze', monthly_rate: 55 }],
    scheduled_services: rows,
  });

  test('a past-dated on_site row is still owned; a past-dated scheduled row is not', async () => {
    const onSite = await loadOwnedRecurringServiceKeys(mk([{
      id: 'svc-onsite', service_type: 'Lawn Care', scheduled_date: '2025-01-01',
      status: 'on_site', is_recurring: true,
    }]), 'cust-live');
    expect(onSite).toEqual(['lawn_care']);

    const stale = await loadOwnedRecurringServiceKeys(mk([{
      id: 'svc-stale', service_type: 'Lawn Care', scheduled_date: '2025-01-01',
      status: 'scheduled', is_recurring: true,
    }]), 'cust-live');
    expect(stale).toEqual([]);
  });

  test('a live in-progress callback still never counts', async () => {
    const owned = await loadOwnedRecurringServiceKeys(mk([{
      id: 'svc-live-cb', service_type: 'Lawn Care', scheduled_date: '2025-01-01',
      status: 'en_route', is_recurring: true, is_callback: true,
    }]), 'cust-live');
    expect(owned).toEqual([]);
  });
});

describe('property context reads only columns the customers table actually has', () => {
  // Verified against the live schema 2026-08-09: customers carries bed_sqft,
  // canopy_type, lot_sqft, palm_count, property_sqft, property_type — and
  // NONE of home_sqft / stories / pool / pool_cage / shrub_density /
  // tree_density / landscape_complexity / tree_count / year_built /
  // construction_material / foundation_type / roof_type. Those reads used to
  // resolve undefined and silently take the moderate/false/0 defaults.
  const customerWithBasics = {
    id: 'cust-features',
    monthly_rate: 55,
    address_line1: '123 Gulf Dr',
    city: 'Sarasota',
    state: 'FL',
    zip: '34236',
    property_sqft: 2200,
    lot_sqft: 9000,
  };

  test('a fully-populated profile STILL gets a lookup — bed/palm values are not evidence of pools or density', async () => {
    // Regression for the half-gate: bed_sqft + palm_count present would have
    // skipped the lookup, leaving pool/cage/complexity/treeCount hardcoded.
    let lookedUp = false;
    const { _private } = require('../services/customer-pricing-ai');
    const ctx = await _private.resolvePropertyContext({
      customer: { ...customerWithBasics, bed_sqft: 1800, palm_count: 6 },
      turfProfile: null,
      propertyLookup: async () => {
        lookedUp = true;
        return { enriched: { pool: 'YES', poolCage: 'YES', shrubDensity: 'HEAVY', estimatedTreeCount: 12 } };
      },
    });
    expect(lookedUp).toBe(true);
    expect(ctx.propertyInput.features.pool).toBe(true);
    expect(ctx.propertyInput.features.poolCage).toBe(true);
    expect(ctx.propertyInput.features.shrubs).toBe('heavy');
    expect(ctx.propertyInput.features.treeCount).toBe(12);
    // Stored values still win over the lookup for the fields the profile has.
    expect(ctx.propertyInput.bedArea).toBe(1800);
    expect(ctx.propertyInput.bedAreaSource).toBe('explicit');
  });

  test('a customer with home+lot still gets a lookup, so features are observed not defaulted', async () => {
    let lookedUp = false;
    const result = await buildCustomerPricingResponse({
      db: null,
      prompt: 'I am interested in adding tree and shrub care',
      propertyLookup: async () => {
        lookedUp = true;
        return {
          enriched: {
            homeSqFt: 2200, lotSqFt: 9000,
            pool: 'YES', poolCage: 'YES',
            shrubDensity: 'HEAVY', treeDensity: 'HEAVY',
            estimatedTreeCount: 12, estimatedBedAreaSf: 2600, estimatedPalmCount: 8,
          },
        };
      },
      customer: customerWithBasics,
    });
    // The old gate was (!homeSqFt || !lotSqFt): this customer would never
    // have been looked up, and would have priced pool-less/moderate/zero-tree.
    expect(lookedUp).toBe(true);
    expect(result.ok).toBe(true);
  });

  test('a lookup-derived bed area is labelled ESTIMATED, never explicit', async () => {
    const { _private } = require('../services/customer-pricing-ai');
    const resolve = _private?.resolvePropertyContext;
    if (!resolve) return;
    const fromLookup = await resolve({
      customer: customerWithBasics,
      turfProfile: null,
      propertyLookup: async () => ({ enriched: { estimatedBedAreaSf: 2600, aiConfidence: 88 } }),
    });
    expect(fromLookup.propertyInput.bedArea).toBe(2600);
    // Provenance drives money: the T&S density factor applies to measured
    // sources only, so an AI-derived area must not claim to be measured.
    expect(fromLookup.propertyInput.bedAreaSource).toBe('estimated');

    const fromProfile = await resolve({
      customer: { ...customerWithBasics, bed_sqft: 1800, palm_count: 4 },
      turfProfile: null,
      propertyLookup: async () => ({ enriched: { estimatedBedAreaSf: 2600, aiConfidence: 88 } }),
    });
    expect(fromProfile.propertyInput.bedArea).toBe(1800);
    expect(fromProfile.propertyInput.bedAreaSource).toBe('explicit');
  });
});

describe('AI palm estimates never auto-price palm injection (customer-facing route)', () => {
  test('a lookup palm estimate does not satisfy the measured-count requirement', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      prompt: 'I want palm injections',
      propertyLookup: async () => ({
        enriched: { homeSqFt: 2200, lotSqFt: 9000, estimatedPalmCount: 14 },
      }),
      customer: {
        id: 'cust-palm-est',
        monthly_rate: 55,
        address_line1: '123 Gulf Dr',
        city: 'Sarasota',
        state: 'FL',
        zip: '34236',
        property_sqft: 2200,
        lot_sqft: 9000,
      },
    });
    // An AI count is not a measurement — the customer is asked, not quoted.
    expect(result).toMatchObject({
      ok: false,
      code: 'PROPERTY_DETAILS_NEEDED',
      message: 'Palm count is required for palm injection pricing.',
    });
  });
});

describe('lookup confidence gates every vision-derived price modifier', () => {
  const { _private } = require('../services/customer-pricing-ai');
  const customer = {
    id: 'cust-conf', monthly_rate: 55, property_sqft: 2200, lot_sqft: 9000,
    address_line1: '123 Gulf Dr', city: 'Sarasota', state: 'FL', zip: '34236',
  };
  const enriched = (extra) => ({
    homeSqFt: 2200, pool: 'YES', poolCage: 'YES', shrubDensity: 'HEAVY',
    estimatedTreeCount: 12, estimatedBedAreaSf: 2600, yearBuilt: 1998, ...extra,
  });

  test('a confident read feeds pool/cage/density/trees and the bed area', async () => {
    const ctx = await _private.resolvePropertyContext({
      customer, turfProfile: null, propertyLookup: async () => ({ enriched: enriched({ aiConfidence: 88 }) }),
    });
    expect(ctx.propertyInput.features.pool).toBe(true);
    expect(ctx.propertyInput.features.poolCage).toBe(true);
    expect(ctx.propertyInput.features.shrubs).toBe('heavy');
    expect(ctx.propertyInput.features.treeCount).toBe(12);
    expect(ctx.propertyInput.bedArea).toBe(2600);
  });

  test('a LOW-confidence read moves nothing — features stay at their defaults', async () => {
    const ctx = await _private.resolvePropertyContext({
      customer, turfProfile: null, propertyLookup: async () => ({ enriched: enriched({ aiConfidence: 38 }) }),
    });
    expect(ctx.propertyInput.features.pool).toBe(false);
    expect(ctx.propertyInput.features.poolCage).toBe(false);
    expect(ctx.propertyInput.features.shrubs).toBe('moderate');
    expect(ctx.propertyInput.features.treeCount).toBe(0);
    expect(ctx.propertyInput.bedArea).toBeUndefined();
    // County-sourced facts are not vision reads and still apply.
    expect(ctx.propertyInput.yearBuilt).toBe(1998);
  });

  test('a field-verify flag on the imagery disqualifies the features too', async () => {
    const ctx = await _private.resolvePropertyContext({
      customer,
      turfProfile: null,
      propertyLookup: async () => ({
        enriched: enriched({ aiConfidence: 95, fieldVerifyFlags: [{ field: 'estimatedTurfSf', reason: 'stale imagery', priority: 'HIGH' }] }),
      }),
    });
    expect(ctx.propertyInput.features.pool).toBe(false);
    expect(ctx.propertyInput.bedArea).toBeUndefined();
  });
});

describe('lookup trust: global flags, record-backed pools, bed-area-only T&S', () => {
  const { _private } = require('../services/customer-pricing-ai');
  const customer = {
    id: 'cust-trust', monthly_rate: 55, lot_sqft: 9000,
    address_line1: '123 Gulf Dr', city: 'Sarasota', state: 'FL', zip: '34236',
  };

  test("an 'address' flag adopts NOTHING from the lookup — a wrong-premise quote is never produced", async () => {
    const ctx = await _private.resolvePropertyContext({
      customer, turfProfile: null,
      propertyLookup: async () => ({
        enriched: {
          homeSqFt: 4200, stories: 3, pool: 'YES', poolSource: 'county',
          estimatedBedAreaSf: 5000, aiConfidence: 95,
          fieldVerifyFlags: [{ field: 'address', reason: 'snapped premise', priority: 'HIGH' }],
        },
      }),
    });
    // Not the neighbour's 4,200 sqft home, pool, or bed area.
    expect(ctx.propertyInput.homeSqFt).toBeNull();
    expect(ctx.propertyInput.features.pool).toBe(false);
    expect(ctx.propertyInput.bedArea).toBeUndefined();
    expect(ctx.hasHomeSqFt).toBe(false); // fails closed → PROPERTY_DETAILS_NEEDED
  });

  test('a county-confirmed pool/cage survives a low AI grade (assessor data, not an imagery guess)', async () => {
    const ctx = await _private.resolvePropertyContext({
      customer, turfProfile: null,
      propertyLookup: async () => ({
        enriched: {
          homeSqFt: 2200, aiConfidence: 35,
          pool: 'YES', poolSource: 'county', poolCageSqft: 900, poolCageSize: 'LARGE',
          shrubDensity: 'HEAVY', estimatedTreeCount: 12,
        },
      }),
    });
    expect(ctx.propertyInput.features.pool).toBe(true);
    expect(ctx.propertyInput.features.poolCage).toBe(true);
    expect(ctx.propertyInput.features.poolCageSize).toBe('large');
    // Vision-only reads stay gated at that confidence.
    expect(ctx.propertyInput.features.shrubs).toBe('moderate');
    expect(ctx.propertyInput.features.treeCount).toBe(0);
  });

  test('a vision-only pool stays gated at low confidence', async () => {
    const ctx = await _private.resolvePropertyContext({
      customer, turfProfile: null,
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200, aiConfidence: 35, pool: 'YES', poolSource: 'vision' } }),
    });
    expect(ctx.propertyInput.features.pool).toBe(false);
  });

  test('a stored bed area alone is enough to price Tree & Shrub', async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      prompt: 'I am interested in adding tree and shrub care',
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      customer: {
        id: 'cust-bedonly', monthly_rate: 55, bed_sqft: 2400,
        address_line1: '123 Gulf Dr', city: 'Sarasota', state: 'FL', zip: '34236',
      },
    });
    // No lot_sqft and no lawn area, but priceTreeShrub prices from bedArea.
    expect(result.ok).toBe(true);
    expect(result.options.some((o) => o.serviceKey === 'tree_shrub')).toBe(true);
  });
});
