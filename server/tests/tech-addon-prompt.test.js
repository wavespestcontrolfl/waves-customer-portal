'use strict';

const {
  PILLAR_PROMPTS,
  CUSTOMER_PROMPT_COLUMNS,
  pickTechAddonPrompt,
  collectResidentialKeysOrNull,
  isRecurringAddonRow,
  loadScopedOngoingRootRows,
  techAddonPromptFacts,
} = require('../services/tech-addon-prompt');

const REAL_CUSTOMER_COLUMNS = new Set([
  'id', 'active', 'deleted_at', 'service_paused_at', 'service_pause_reason', 'pipeline_stage',
  'property_type', 'building_use', 'waveguard_tier', 'contact_role',
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
  active: true,
  deleted_at: null,
  service_paused_at: null,
  service_pause_reason: null,
  pipeline_stage: 'active',
  property_type: 'single_family',
  building_use: null,
  waveguard_tier: 'Bronze',
  contact_role: 'homeowner',
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

const PEST_LIVE_ROW = {
  id: 'svc-1',
  service_type: 'Quarterly Pest Control',
  service_key: 'pest-quarterly',
  service_category: 'pest',
};

const LAWN_LIVE_ROW = {
  id: 'svc-2',
  service_type: 'Lawn Care',
  service_key: 'lawn-care',
  service_category: 'lawn',
};

const BASE_DEPS = {
  planStartBlocker: async () => 'has_plan',
  loadCatalogFieldsByRowId: async () => new Map([['svc-1', { service_key: 'pest-quarterly', service_category: 'pest' }]]),
  loadScopedLiveRows: async () => [PEST_LIVE_ROW],
  loadScopedOffCalendarRows: async () => [],
  loadScopedOngoingRootRows: async () => [],
  loadScopedVisitAddonKeys: async () => [],
  loadActivePrepayCoveredFamilies: async () => [],
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

  test('suppresses prompt when customer already owns both Pest and Lawn or target is held/billed/prepaid', () => {
    expect(pickTechAddonPrompt(['pest_control', 'lawn_care'])).toBeNull();
    expect(pickTechAddonPrompt(['pest_control'], { planRateFamilies: ['lawn_care'] })).toBeNull();
    expect(pickTechAddonPrompt(['pest_control'], { heldFamilies: ['lawn_care'] })).toBeNull();
    expect(pickTechAddonPrompt(['pest_control'], { prepayFamilies: ['lawn_care'] })).toBeNull();
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
  test('returns Lawn Care prompt, checks deleted_at, uses planStartBlocker, primary streetScope, and strictProbe ledger', async () => {
    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const planStartBlocker = jest.fn(async () => 'has_plan');
    const loadScopedLiveRows = jest.fn(async () => [PEST_LIVE_ROW]);
    const loadPlanComponents = jest.fn(async () => [{ family_key: 'pest_control', monthly_rate: 39 }]);

    const prompt = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS,
      planStartBlocker,
      loadScopedLiveRows,
      loadPlanComponents,
    });

    expect(CUSTOMER_PROMPT_COLUMNS).toEqual(expect.arrayContaining(['service_paused_at', 'service_pause_reason', 'pipeline_stage', 'contact_role']));
    expect(dbh.deletedChecked.called).toBe(true);
    expect(planStartBlocker).toHaveBeenCalledWith(dbh, 'cust-1');
    expect(prompt?.targetFamily).toBe('lawn_care');
    expect(loadScopedLiveRows).toHaveBeenCalledWith(dbh, 'cust-1', {
      streetScope: {
        estimateStreet: '100mainstreet|sarasota|34231',
        customerPrimaryStreet: '100mainstreet|sarasota|34231',
        requireSharedLocality: true,
      },
    });
    expect(loadPlanComponents).toHaveBeenCalledWith(dbh, 'cust-1', { strictProbe: true });
  });

  test('excludes churned customers, whole-account operator holds, commercial accounts, and non-plan customers', async () => {
    for (const row of [
      { ...RESIDENTIAL_CUSTOMER, pipeline_stage: 'churned' },
      { ...RESIDENTIAL_CUSTOMER, service_paused_at: new Date('2026-11-20T00:00:00Z'), service_pause_reason: 'operator_hold' },
      { ...RESIDENTIAL_CUSTOMER, active: false },
    ]) {
      const dbh = makeFakeDb({ customerRow: row });
      const loadScopedLiveRows = jest.fn(async () => [PEST_LIVE_ROW]);
      const prompt = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
        ...BASE_DEPS,
        loadScopedLiveRows,
        loadPlanComponents: async () => [],
      });
      expect(prompt).toBeNull();
      expect(loadScopedLiveRows).not.toHaveBeenCalled();
    }

    for (const blocker of ['commercial', 'not_live', null]) {
      const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
      const loadScopedLiveRows = jest.fn(async () => [PEST_LIVE_ROW]);
      const prompt = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
        ...BASE_DEPS,
        planStartBlocker: async () => blocker,
        loadScopedLiveRows,
        loadPlanComponents: async () => [],
      });
      expect(prompt).toBeNull();
      expect(loadScopedLiveRows).not.toHaveBeenCalled();
    }
  });

  test('includes recurring add-ons on scoped visits (respecting cadence and shared isOneTimeOnlyAddonKey) and suppresses duplicate pitch', async () => {
    expect(isRecurringAddonRow({ recurring_pattern: 'quarterly', service_key: 'pest-quarterly' })).toBe(true);
    expect(isRecurringAddonRow({ recurring_pattern: null, service_key: 'pest-quarterly' })).toBe(true);
    expect(isRecurringAddonRow({ recurring_pattern: 'one_time', service_key: 'pest-quarterly' })).toBe(false);
    expect(isRecurringAddonRow({ recurring_pattern: 'none', service_key: 'pest-quarterly' })).toBe(false);
    expect(isRecurringAddonRow({ recurring_pattern: null, service_key: 'area_addon_lawn_insect_spot' })).toBe(false);
    expect(isRecurringAddonRow({ recurring_pattern: null, service_key: 'mosquito_misting_refill' })).toBe(false);
    expect(isRecurringAddonRow({ recurring_pattern: null, service_key: 'waveguard_membership' })).toBe(false);

    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    const loadScopedVisitAddonKeys = jest.fn(async () => ['pest_control']);
    const prompt = await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS,
      loadScopedLiveRows: async () => [LAWN_LIVE_ROW],
      loadScopedVisitAddonKeys,
      loadPlanComponents: async () => [],
    });
    expect(loadScopedVisitAddonKeys).toHaveBeenCalledWith(dbh, ['svc-2']);
    expect(prompt).toBeNull();
  });

  test('applies recurring_template_overrides under scheduler gate and preserves root catalog identity on price-only overrides', async () => {
    const featureGates = require('../config/feature-gates');
    const gateSpy = jest.spyOn(featureGates, 'isEnabled');
    const rootId = '11111111-1111-4111-8111-111111111111';
    const lawnSvcId = '22222222-2222-4222-8222-222222222222';
    const makeRootDb = (rootRow) => (table) => {
      if (table === 'scheduled_services') {
        const q = {
          columnInfo: async () => ({ recurring_ongoing: true, recurring_template_overrides: true }),
          where: () => q,
          whereNull: () => q,
          whereIn: () => q,
          pluck: async () => [rootId],
          select: async () => [rootRow],
        };
        return q;
      }
      if (table === 'services') {
        const q = {
          whereIn: () => q,
          select: async () => [{ id: lawnSvcId, service_key: 'lawn-care', category: 'lawn', name: 'Lawn Care' }],
        };
        return q;
      }
      throw new Error(`Unexpected table: ${table}`);
    };
    const streetScope = {
      estimateStreet: '100mainstreet|sarasota|34231',
      customerPrimaryStreet: '100mainstreet|sarasota|34231',
      requireSharedLocality: true,
    };
    const serviceEditedRoot = {
      id: rootId, customer_id: 'cust-1', service_type: 'Quarterly Pest Control',
      is_recurring: true, recurring_ongoing: true, recurring_parent_id: null,
      service_address_line1: '100 Main St', service_address_city: 'Sarasota', service_address_zip: '34231',
      recurring_template_overrides: JSON.stringify({ service_type: 'Lawn Care', service_id: lawnSvcId }),
    };
    const priceOnlyRoot = {
      ...serviceEditedRoot,
      service_type: 'Quarterly Pest Control',
      recurring_template_overrides: JSON.stringify({ estimated_price: 95 }),
    };
    try {
      gateSpy.mockImplementation((name) => name === 'editApptPriceServiceScope');
      const resolvedOn = await loadScopedOngoingRootRows(makeRootDb(serviceEditedRoot), 'cust-1', {
        streetScope,
        catalogById: new Map([[rootId, { service_key: 'pest-quarterly', service_category: 'pest' }]]),
      });
      expect(collectResidentialKeysOrNull(resolvedOn)).toEqual(['lawn_care']);

      const resolvedPriceOnly = await loadScopedOngoingRootRows(makeRootDb(priceOnlyRoot), 'cust-1', {
        streetScope,
        catalogById: new Map([[rootId, { service_key: 'lawn-care', service_category: 'lawn', service_name: 'Lawn Care' }]]),
      });
      expect(collectResidentialKeysOrNull(resolvedPriceOnly)).toEqual(['lawn_care']);

      gateSpy.mockReturnValue(false);
      const resolvedOff = await loadScopedOngoingRootRows(makeRootDb(serviceEditedRoot), 'cust-1', {
        streetScope,
        catalogById: new Map([[rootId, { service_key: 'pest-quarterly', service_category: 'pest' }]]),
      });
      expect(collectResidentialKeysOrNull(resolvedOff)).toEqual(['pest_control']);

      // Ongoing root moved onto primary street via appointment_address override + unlinked snapshot key
      const movedLegacyLawnRoot = {
        id: rootId, customer_id: 'cust-1', service_type: 'Recurring Service',
        service_key_snapshot: 'lawn-care',
        is_recurring: true, recurring_ongoing: true, recurring_parent_id: null,
        service_address_line1: '999 Old Ave', service_address_city: 'Venice', service_address_zip: '34285',
        recurring_template_overrides: JSON.stringify({
          appointment_address: {
            service_address_line1: '100 Main St', service_address_city: 'Sarasota', service_address_zip: '34231',
          },
        }),
      };
      const resolvedMoved = await loadScopedOngoingRootRows(makeRootDb(movedLegacyLawnRoot), 'cust-1', {
        streetScope,
        catalogById: new Map(),
      });
      expect(collectResidentialKeysOrNull(resolvedMoved)).toEqual(['lawn_care']);
    } finally {
      gateSpy.mockRestore();
    }
  });

  test('suppresses prompt on commercial row, paid prepay coverage, unattributed ledger, plan hold, or secondary property', async () => {
    expect(collectResidentialKeysOrNull([
      { id: 'svc-live-comm', service_type: 'Pest Control', service_key: 'commercial-pest', catalog_name: 'Commercial Pest' },
    ])).toBeNull();

    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    expect(await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS, loadActivePrepayCoveredFamilies: async () => ['lawn_care'], loadPlanComponents: async () => [],
    })).toBeNull();
    expect(await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS, loadActivePrepayCoveredFamilies: async () => null, loadPlanComponents: async () => [],
    })).toBeNull();
    expect(await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS,
      loadPlanComponents: async () => [{ family_key: 'unattributed', monthly_rate: 45 }],
    })).toBeNull();
    expect(await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS, loadActivePlanHoldFamilies: async () => ['lawn_care'], loadPlanComponents: async () => [],
    })).toBeNull();

    const secondaryVisit = {
      ...STAMPED_VISIT,
      service_address_line1: '999 Beach Rd',
      service_address_city: 'Venice',
      service_address_zip: '34285',
    };
    expect(await techAddonPromptFacts(secondaryVisit, dbh, {
      ...BASE_DEPS, loadPlanComponents: async () => [],
    })).toBeNull();
  });

  test('fails closed when ledger, catalog, prepay, or planStartBlocker throws', async () => {
    const dbh = makeFakeDb({ customerRow: RESIDENTIAL_CUSTOMER });
    expect(await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS, loadPlanComponents: async () => { throw new Error('ledger down'); },
    })).toBeNull();
    expect(await techAddonPromptFacts(STAMPED_VISIT, dbh, {
      ...BASE_DEPS, planStartBlocker: async () => { throw new Error('eligibility down'); },
    })).toBeNull();
  });
});
