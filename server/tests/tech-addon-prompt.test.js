'use strict';

const {
  PILLAR_PROMPTS,
  pickTechAddonPrompt,
  techAddonPromptFacts,
} = require('../services/tech-addon-prompt');

const REAL_CUSTOMER_COLUMNS = new Set([
  'id', 'property_type', 'active', 'waveguard_tier',
  'address_line1', 'address_line2', 'city', 'zip', 'has_multi_home',
]);

function makeFakeDb({ customerRow = null, throwOnCustomer = false } = {}) {
  return (table) => ({
    where: () => ({
      first: async (...cols) => {
        if (throwOnCustomer) throw new Error('db timeout');
        if (table === 'customers') {
          for (const col of cols) {
            if (!REAL_CUSTOMER_COLUMNS.has(col)) {
              throw new Error(`column "${col}" does not exist on customers`);
            }
          }
          return customerRow;
        }
        return null;
      },
    }),
  });
}

const RESIDENTIAL_CUSTOMER = {
  id: 'cust-1',
  property_type: 'single_family',
  active: true,
  waveguard_tier: 'Bronze',
  address_line1: '100 Main St',
  address_line2: null,
  city: 'Sarasota',
  zip: '34231',
  has_multi_home: false,
};

const STAMPED_VISIT = {
  id: 'svc-1',
  customer_id: 'cust-1',
  service_type: 'Quarterly Pest Control',
  service_address_line1: '100 Main St',
  service_address_city: 'Sarasota',
  service_address_zip: '34231',
};

const RESIDENTIAL_CATALOG = async () => new Map([['svc-1', { service_key: 'pest-quarterly', service_category: 'pest' }]]);

describe('pickTechAddonPrompt', () => {
  test('recommends Lawn Care when customer owns only pest_control', () => {
    const prompt = pickTechAddonPrompt(['pest_control']);
    expect(prompt).toMatchObject({
      targetFamily: 'lawn_care',
      targetLabel: 'Lawn Care',
      fieldLeadServiceType: 'Lawn',
    });
  });

  test('recommends Pest Control when customer owns only lawn_care', () => {
    const prompt = pickTechAddonPrompt(['lawn_care']);
    expect(prompt).toMatchObject({
      targetFamily: 'pest_control',
      targetLabel: 'Pest Control',
      fieldLeadServiceType: 'Pest',
    });
  });

  test('suppresses prompt when customer already owns both Pest and Lawn', () => {
    expect(pickTechAddonPrompt(['pest_control', 'lawn_care'])).toBeNull();
  });

  test('suppresses prompt when plan-rate ledger already bills the target family', () => {
    expect(pickTechAddonPrompt(['pest_control'], { planRateFamilies: ['lawn_care'] })).toBeNull();
    expect(pickTechAddonPrompt(['lawn_care'], { planRateFamilies: ['pest_control'] })).toBeNull();
  });

  test('suppresses prompt for non-recurring/neither-pillar and commercial accounts', () => {
    expect(pickTechAddonPrompt([])).toBeNull();
    expect(pickTechAddonPrompt(['mosquito'])).toBeNull();
    expect(pickTechAddonPrompt(['pest_control'], { isCommercial: true })).toBeNull();
  });

  test('carries ZERO dollar prices, percentages, or hardcoded tier claims (owner 2026-11-04)', () => {
    for (const p of Object.values(PILLAR_PROMPTS)) {
      const text = `${p.headline} ${p.detail}`;
      expect(text).not.toMatch(/\$|\d+%|discount|margin|silver|gold|platinum/i);
      expect(text).not.toMatch(/tree|shrub|termite/i);
    }
  });
});

describe('techAddonPromptFacts', () => {
  test('returns Lawn Care prompt with primary streetScope and strictProbe ledger check', async () => {
    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const loadOwnedRecurringServiceKeys = jest.fn(async () => ['pest_control']);
    const loadPlanComponents = jest.fn(async () => [{ family_key: 'pest_control', monthly_rate: 39 }]);

    const prompt = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      loadCatalogFieldsByRowId: RESIDENTIAL_CATALOG,
      loadOwnedRecurringServiceKeys,
      loadPlanComponents,
    });

    expect(prompt?.targetFamily).toBe('lawn_care');
    expect(loadOwnedRecurringServiceKeys).toHaveBeenCalledWith(dbh, 'cust-1', {
      streetScope: {
        estimateStreet: '100mainstreet|sarasota|34231',
        customerPrimaryStreet: '100mainstreet|sarasota|34231',
        requireSharedLocality: true,
      },
    });
    expect(loadPlanComponents).toHaveBeenCalledWith(dbh, 'cust-1', { strictProbe: true });
  });

  test('suppresses prompt when customer has a commercial property_type', async () => {
    const dbh = makeFakeDb({ customerRow: { ...RESIDENTIAL_CUSTOMER, property_type: 'commercial' } });
    const loadOwnedRecurringServiceKeys = jest.fn(async () => ['pest_control']);
    const prompt = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      loadCatalogFieldsByRowId: RESIDENTIAL_CATALOG,
      loadOwnedRecurringServiceKeys,
      loadPlanComponents: async () => [],
    });
    expect(prompt).toBeNull();
    expect(loadOwnedRecurringServiceKeys).not.toHaveBeenCalled();
  });

  test('suppresses prompt when visit catalog row is commercial even with blank property_type', async () => {
    const dbh = makeFakeDb({ customerRow: { ...RESIDENTIAL_CUSTOMER, property_type: null } });
    const loadOwnedRecurringServiceKeys = jest.fn(async () => ['pest_control']);
    const prompt = await techAddonPromptFacts(
      { ...STAMPED_VISIT, service_type: 'Pest Control' },
      dbh,
      {
        loadCatalogFieldsByRowId: async () => new Map([['svc-1', { service_key: 'commercial-pest', catalog_name: 'Commercial Pest' }]]),
        loadOwnedRecurringServiceKeys,
        loadPlanComponents: async () => [],
      },
    );
    expect(prompt).toBeNull();
    expect(loadOwnedRecurringServiceKeys).not.toHaveBeenCalled();
  });

  test('suppresses prompt on secondary property so Field Lead never quotes the wrong address', async () => {
    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const loadOwnedRecurringServiceKeys = jest.fn(async () => ['pest_control']);
    const secondaryVisit = {
      ...STAMPED_VISIT,
      service_address_line1: '999 Beach Rd',
      service_address_city: 'Venice',
      service_address_zip: '34285',
    };
    const prompt = await techAddonPromptFacts(secondaryVisit, dbh, {
      loadCatalogFieldsByRowId: RESIDENTIAL_CATALOG,
      loadOwnedRecurringServiceKeys,
      loadPlanComponents: async () => [],
    });
    expect(prompt).toBeNull();
    expect(loadOwnedRecurringServiceKeys).not.toHaveBeenCalled();
  });

  test('suppresses prompt when customer already has a positive plan-rate component for target family', async () => {
    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const prompt = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      loadCatalogFieldsByRowId: RESIDENTIAL_CATALOG,
      loadOwnedRecurringServiceKeys: async () => ['pest_control'],
      loadPlanComponents: async () => [
        { family_key: 'pest_control', monthly_rate: 39 },
        { family_key: 'lawn_care', monthly_rate: 79 },
      ],
    });
    expect(prompt).toBeNull();
  });

  test('fails closed when plan-rate ledger or catalog lookup fails', async () => {
    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const p1 = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      loadCatalogFieldsByRowId: RESIDENTIAL_CATALOG,
      loadOwnedRecurringServiceKeys: async () => ['pest_control'],
      loadPlanComponents: async () => { throw new Error('ledger unavailable'); },
    });
    expect(p1).toBeNull();

    const p2 = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      loadCatalogFieldsByRowId: async () => null,
      loadOwnedRecurringServiceKeys: async () => ['pest_control'],
      loadPlanComponents: async () => [],
    });
    expect(p2).toBeNull();
  });

  test('suppresses prompt when visit premises cannot be proven (multi-home unstamped visit)', async () => {
    const dbh = makeFakeDb({ customerRow: { ...RESIDENTIAL_CUSTOMER, has_multi_home: true } });
    const loadOwnedRecurringServiceKeys = jest.fn(async () => ['pest_control']);
    const unstampedVisit = { id: 'svc-2', customer_id: 'cust-1', service_type: 'Quarterly Pest Control' };

    const prompt = await techAddonPromptFacts(unstampedVisit, dbh, {
      loadCatalogFieldsByRowId: async () => new Map(),
      loadOwnedRecurringServiceKeys,
      loadPlanComponents: async () => [],
      resolveVisitPropertyScope: async () => ({ key: null, hasEvidence: false }),
      customerHasOnlyPrimaryPremises: async () => false,
    });
    expect(prompt).toBeNull();
    expect(loadOwnedRecurringServiceKeys).not.toHaveBeenCalled();
  });
});
