'use strict';

const {
  PILLAR_PROMPTS,
  pickTechAddonPrompt,
  collectResidentialKeysOrNull,
  loadOffCalendarOwnedKeys,
  techAddonPromptFacts,
} = require('../services/tech-addon-prompt');

const REAL_CUSTOMER_COLUMNS = new Set([
  'id', 'property_type', 'building_use', 'active', 'waveguard_tier',
  'address_line1', 'address_line2', 'city', 'zip', 'has_multi_home',
]);

function makeFakeDb({ customerRow = null, throwOnCustomer = false } = {}) {
  const deletedChecked = { called: false };
  const dbh = (table) => {
    const q = {
      where: () => q,
      whereNull: (col) => { if (table === 'customers' && col === 'deleted_at') deletedChecked.called = true; return q; },
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
    };
    return q;
  };
  dbh.deletedChecked = deletedChecked;
  return dbh;
}

const RESIDENTIAL_CUSTOMER = {
  id: 'cust-1',
  property_type: 'single_family',
  building_use: null,
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

const BASE_DEPS = {
  loadCatalogFieldsByRowId: async () => new Map([['svc-1', { service_key: 'pest-quarterly', service_category: 'pest' }]]),
  loadOffCalendarOwnedKeys: async () => [],
  loadOngoingSeriesOwnedKeys: async () => [],
  loadActivePlanHoldFamilies: async () => [],
};

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

  test('suppresses prompt when customer already owns both Pest and Lawn or target is held/billed', () => {
    expect(pickTechAddonPrompt(['pest_control', 'lawn_care'])).toBeNull();
    expect(pickTechAddonPrompt(['pest_control'], { planRateFamilies: ['lawn_care'] })).toBeNull();
    expect(pickTechAddonPrompt(['pest_control'], { heldFamilies: ['lawn_care'] })).toBeNull();
    expect(pickTechAddonPrompt(['lawn_care'], { heldFamilies: ['pest_control'] })).toBeNull();
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
  test('returns Lawn Care prompt, checks deleted_at, uses primary streetScope and strictProbe ledger', async () => {
    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const loadScopedLiveOwnedKeys = jest.fn(async () => ['pest_control']);
    const loadPlanComponents = jest.fn(async () => [{ family_key: 'pest_control', monthly_rate: 39 }]);

    const prompt = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS,
      loadScopedLiveOwnedKeys,
      loadPlanComponents,
    });

    expect(dbh.deletedChecked.called).toBe(true);
    expect(prompt?.targetFamily).toBe('lawn_care');
    expect(loadScopedLiveOwnedKeys).toHaveBeenCalledWith(dbh, 'cust-1', {
      streetScope: {
        estimateStreet: '100mainstreet|sarasota|34231',
        customerPrimaryStreet: '100mainstreet|sarasota|34231',
        requireSharedLocality: true,
      },
    });
    expect(loadPlanComponents).toHaveBeenCalledWith(dbh, 'cust-1', { strictProbe: true });
  });

  test('suppresses prompt for commercial property_type, ANY populated building_use (nonresidential or HOA residential proposal), or commercial catalog row', async () => {
    for (const row of [
      { ...RESIDENTIAL_CUSTOMER, property_type: 'commercial' },
      { ...RESIDENTIAL_CUSTOMER, building_use: 'nonresidential' },
      { ...RESIDENTIAL_CUSTOMER, building_use: 'residential' },
    ]) {
      const dbh = makeFakeDb({ customerRow: row });
      const loadScopedLiveOwnedKeys = jest.fn(async () => ['pest_control']);
      const prompt = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
        ...BASE_DEPS,
        loadScopedLiveOwnedKeys,
        loadPlanComponents: async () => [],
      });
      expect(prompt).toBeNull();
      expect(loadScopedLiveOwnedKeys).not.toHaveBeenCalled();
    }

    const dbh = makeFakeDb({ customerRow: { ...RESIDENTIAL_CUSTOMER, property_type: null } });
    const loadScopedLiveOwnedKeys = jest.fn(async () => ['pest_control']);
    const prompt = await techAddonPromptFacts(
      { ...STAMPED_VISIT, service_type: 'Pest Control' },
      dbh,
      {
        ...BASE_DEPS,
        loadCatalogFieldsByRowId: async () => new Map([['svc-1', { service_key: 'commercial-pest', catalog_name: 'Commercial Pest' }]]),
        loadScopedLiveOwnedKeys,
        loadPlanComponents: async () => [],
      },
    );
    expect(prompt).toBeNull();
    expect(loadScopedLiveOwnedKeys).not.toHaveBeenCalled();
  });

  test('suppresses prompt when an ordinary live recurring row or off-calendar row at this premises is commercial', async () => {
    expect(collectResidentialKeysOrNull([
      { id: 'svc-live-comm', service_type: 'Pest Control', service_key: 'commercial-pest', catalog_name: 'Commercial Pest' },
    ])).toBeNull();

    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const pLive = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS,
      loadScopedLiveOwnedKeys: async () => null,
      loadPlanComponents: async () => [],
    });
    expect(pLive).toBeNull();

    const legacyCommercialRow = {
      id: 'svc-legacy-comm',
      customer_id: 'cust-1',
      service_type: 'Commercial Lawn Care',
      scheduled_date: '2099-01-15',
      status: 'scheduled',
      source: 'recurring',
      is_recurring: null,
      recurring_parent_id: 'parent-1',
      is_callback: false,
      followup_included: false,
      service_address_line1: '100 Main St',
      service_address_city: 'Sarasota',
      service_address_zip: '34231',
    };
    let callIdx = 0;
    const offCalDb = () => {
      const idx = callIdx++;
      const q = {
        where: () => q,
        whereNull: () => q,
        whereNotNull: () => q,
        select: async () => (idx === 0 ? [legacyCommercialRow] : []),
      };
      return q;
    };
    const streetScope = {
      estimateStreet: '100mainstreet|sarasota|34231',
      customerPrimaryStreet: '100mainstreet|sarasota|34231',
      requireSharedLocality: true,
    };
    const offCalResult = await loadOffCalendarOwnedKeys(offCalDb, 'cust-1', {
      streetScope,
      catalogById: new Map(),
    });
    expect(offCalResult).toBeNull();
  });

  test('suppresses prompt when an ongoing series root between visits covers the target family', async () => {
    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const prompt = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS,
      loadScopedLiveOwnedKeys: async () => ['pest_control'],
      loadOngoingSeriesOwnedKeys: async () => ['lawn_care'],
      loadPlanComponents: async () => [],
    });
    expect(prompt).toBeNull();
  });

  test('suppresses prompt when plan-rate ledger contains positive unattributed billed coverage', async () => {
    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const prompt = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS,
      loadScopedLiveOwnedKeys: async () => ['pest_control'],
      loadPlanComponents: async () => [
        { family_key: 'pest_control', monthly_rate: 39 },
        { family_key: 'unattributed', monthly_rate: 45 },
      ],
    });
    expect(prompt).toBeNull();
  });

  test('suppresses prompt when legacy off-calendar recurring visit or active plan hold covers target family', async () => {
    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const p1 = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS,
      loadScopedLiveOwnedKeys: async () => ['pest_control'],
      loadOffCalendarOwnedKeys: async () => ['lawn_care'],
      loadPlanComponents: async () => [],
    });
    expect(p1).toBeNull();

    const p2 = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS,
      loadScopedLiveOwnedKeys: async () => ['pest_control'],
      loadActivePlanHoldFamilies: async () => ['lawn_care'],
      loadPlanComponents: async () => [],
    });
    expect(p2).toBeNull();
  });

  test('suppresses prompt on secondary property so Field Lead never quotes the wrong address', async () => {
    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const loadScopedLiveOwnedKeys = jest.fn(async () => ['pest_control']);
    const secondaryVisit = {
      ...STAMPED_VISIT,
      service_address_line1: '999 Beach Rd',
      service_address_city: 'Venice',
      service_address_zip: '34285',
    };
    const prompt = await techAddonPromptFacts(secondaryVisit, dbh, {
      ...BASE_DEPS,
      loadScopedLiveOwnedKeys,
      loadPlanComponents: async () => [],
    });
    expect(prompt).toBeNull();
    expect(loadScopedLiveOwnedKeys).not.toHaveBeenCalled();
  });

  test('fails closed when ledger, catalog, or plan_holds lookup throws', async () => {
    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const p1 = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS,
      loadScopedLiveOwnedKeys: async () => ['pest_control'],
      loadPlanComponents: async () => { throw new Error('ledger unavailable'); },
    });
    expect(p1).toBeNull();

    const p2 = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS,
      loadScopedLiveOwnedKeys: async () => ['pest_control'],
      loadActivePlanHoldFamilies: async () => { throw new Error('holds unavailable'); },
      loadPlanComponents: async () => [],
    });
    expect(p2).toBeNull();
  });
});
