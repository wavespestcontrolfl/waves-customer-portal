const {
  GRASS_TYPE_LABELS,
  grassTypeLabel,
  normalizeGrassType,
  irrigationTypeHasSystem,
  loadIrrigationContext,
  loadPriorSummary,
  resolveTrackKey,
  loadCustomerGrassContext,
} = require('../services/lawn-grass-context');

// Minimal knex stub: knex(table).where(...).first() resolves to the
// configured row (or null) for that table.
function fakeKnex(rows) {
  return (table) => ({
    where() { return this; },
    first() { return Promise.resolve(Object.prototype.hasOwnProperty.call(rows, table) ? rows[table] : null); },
  });
}

describe('lawn-grass-context', () => {
  test('grassTypeLabel maps canonical keys and passes through unknowns', () => {
    expect(grassTypeLabel('st_augustine')).toBe('St. Augustine');
    expect(grassTypeLabel('bermuda')).toBe('Bermuda');
    expect(grassTypeLabel('zoysia')).toBe('Zoysia');
    expect(grassTypeLabel('bahia')).toBe('Bahia');
    expect(grassTypeLabel(null)).toBe(null);
    expect(grassTypeLabel('weird_value')).toBe('weird_value');
    expect(GRASS_TYPE_LABELS.unknown).toBe('Unknown');
  });

  test('reads the active turf profile as the canonical source', async () => {
    const knex = fakeKnex({
      customer_turf_profiles: {
        grass_type: 'bermuda',
        track_key: 'bermuda',
        sun_exposure: 'full_sun',
        irrigation_type: 'in_ground',
        lawn_sqft: 8200,
      },
      customers: { lawn_type: 'St. Augustine', property_sqft: 5000 },
    });

    const ctx = await loadCustomerGrassContext('cust-1', knex);
    expect(ctx).toEqual({
      grassType: 'bermuda',
      grassTypeLabel: 'Bermuda',
      trackKey: 'bermuda',
      sunExposure: 'full_sun',
      irrigationSystem: 'in_ground',
      propertySqft: 8200,
    });
  });

  test('loadIrrigationContext: the active profile system first, else the first profile row (active or not), plus inches per week', async () => {
    const row = (turf) => fakeKnex({ customer_turf_profiles: turf });
    expect(await loadIrrigationContext('c', { irrigationSystem: 'in_ground' }, row({ irrigation_type: 'drip', irrigation_inches_per_week: 1.5 }))).toBe('in ground, 1.5 in/wk');
    expect(await loadIrrigationContext('c', { irrigationSystem: null }, row({ irrigation_type: 'hose_end', irrigation_inches_per_week: null }))).toBe('hose end');
    expect(await loadIrrigationContext('c', {}, row({ irrigation_type: null, irrigation_inches_per_week: 0.75 }))).toBe('0.75 in/wk');
    expect(await loadIrrigationContext('c', {}, fakeKnex({}))).toBeNull();
    expect(await loadIrrigationContext('c', null, fakeKnex({}))).toBeNull();
  });

  test('normalizeGrassType maps legacy free-text lawn_type to canonical keys', () => {
    expect(normalizeGrassType('st_augustine')).toBe('st_augustine');
    expect(normalizeGrassType('St. Augustine')).toBe('st_augustine');
    expect(normalizeGrassType('St. Augustine Full Sun')).toBe('st_augustine'); // exact Codex case
    expect(normalizeGrassType('Floratam')).toBe('st_augustine');
    expect(normalizeGrassType('Bermuda (Celebration)')).toBe('bermuda');
    expect(normalizeGrassType('Empire Zoysia')).toBe('zoysia');
    expect(normalizeGrassType('Argentine Bahia')).toBe('bahia');
    expect(normalizeGrassType('Mixed turf')).toBe('mixed');
    expect(normalizeGrassType('crabgrass jungle')).toBe(null);
    expect(normalizeGrassType(null)).toBe(null);
    expect(normalizeGrassType('')).toBe(null);
  });

  test('falls back to NORMALIZED customers.lawn_type / property_sqft when no profile', async () => {
    const knex = fakeKnex({
      customer_turf_profiles: null,
      customers: { lawn_type: 'St. Augustine Full Sun', property_sqft: 6400 },
    });

    const ctx = await loadCustomerGrassContext('cust-2', knex);
    expect(ctx.grassType).toBe('st_augustine'); // normalized, not the raw free-text
    expect(ctx.grassTypeLabel).toBe('St. Augustine'); // matches %St. Augustine% knowledge lookups
    expect(ctx.trackKey).toBe('st_augustine'); // grass type doubles as the protocol track
    expect(ctx.sunExposure).toBe(null);
    expect(ctx.irrigationSystem).toBe(null);
    expect(ctx.propertySqft).toBe(6400);
  });

  test('resolveTrackKey: track_key wins, else grass type doubles as track', () => {
    expect(resolveTrackKey('bermuda', 'st_augustine')).toBe('bermuda'); // explicit track_key wins
    expect(resolveTrackKey(null, 'st_augustine')).toBe('st_augustine'); // fall back to grass type
    expect(resolveTrackKey('', 'zoysia')).toBe('zoysia');
    expect(resolveTrackKey(null, 'mixed')).toBe(null); // mixed/unknown have no protocol track
    expect(resolveTrackKey(null, 'unknown')).toBe(null);
    expect(resolveTrackKey('not_a_track', 'bahia')).toBe('bahia'); // invalid track_key → grass fallback
    expect(resolveTrackKey(null, null)).toBe(null);
  });

  test('profiled customer with grass_type but no track_key still gets a track', async () => {
    const knex = fakeKnex({
      customer_turf_profiles: { grass_type: 'bermuda', track_key: null, lawn_sqft: 7000 },
      customers: null,
    });
    const ctx = await loadCustomerGrassContext('cust-4', knex);
    expect(ctx.grassType).toBe('bermuda');
    expect(ctx.trackKey).toBe('bermuda'); // derived from grass_type, not dropped
  });

  test('profiled mixed-grass customer has no protocol track', async () => {
    const knex = fakeKnex({
      customer_turf_profiles: { grass_type: 'mixed', track_key: null },
      customers: null,
    });
    const ctx = await loadCustomerGrassContext('cust-5', knex);
    expect(ctx.grassType).toBe('mixed');
    expect(ctx.trackKey).toBe(null);
  });

  test('returns an all-null context for a missing customerId', async () => {
    const knex = fakeKnex({});
    const ctx = await loadCustomerGrassContext(null, knex);
    expect(ctx).toEqual({
      grassType: null,
      grassTypeLabel: null,
      trackKey: null,
      sunExposure: null,
      irrigationSystem: null,
      propertySqft: null,
    });
  });

  test('irrigationTypeHasSystem maps the enum to a boolean column safely', () => {
    expect(irrigationTypeHasSystem('in_ground')).toBe(true);
    expect(irrigationTypeHasSystem('mixed')).toBe(true);
    expect(irrigationTypeHasSystem('manual')).toBe(false);
    expect(irrigationTypeHasSystem('none')).toBe(false);
    // Ambiguous / missing / unknown must be null, never a non-boolean that
    // would break the boolean treatment_outcomes.irrigation_system column.
    expect(irrigationTypeHasSystem(null)).toBe(null);
    expect(irrigationTypeHasSystem(undefined)).toBe(null);
    expect(irrigationTypeHasSystem('garden_hose')).toBe(null);
  });

  test('profile grass_type wins over customers.lawn_type', async () => {
    const knex = fakeKnex({
      customer_turf_profiles: { grass_type: 'bahia', track_key: 'bahia' },
      customers: { lawn_type: 'st_augustine', property_sqft: 3000 },
    });
    const ctx = await loadCustomerGrassContext('cust-3', knex);
    expect(ctx.grassType).toBe('bahia');
    expect(ctx.propertySqft).toBe(3000); // falls back to customers when profile has no lawn_sqft
  });

  describe('loadPriorSummary — one loader, the route\'s gate branch', () => {
    const history = require('../services/lawn-assessment-history');
    const visit = { customerId: 'c1', serviceId: 's9', scheduledService: { id: 's9' }, visitDate: '2026-09-08' };

    test('property history ON: the property- and reset-scoped previous visit (historyBeforeVisit), as a string or null', async () => {
      const spy = jest.spyOn(history, 'historyBeforeVisit').mockResolvedValue({ previous: { ai_summary: 'scoped summary' } });
      try {
        const knex = jest.fn();
        expect(await loadPriorSummary({ ...visit, propertyHistoryEnabled: true }, knex)).toBe('scoped summary');
        expect(spy).toHaveBeenCalledWith({ customerId: 'c1', scheduledService: { id: 's9' }, throughVisitDate: '2026-09-08' }, knex);
        expect(knex).not.toHaveBeenCalled(); // never the legacy query
        spy.mockResolvedValue({ previous: null });
        expect(await loadPriorSummary({ ...visit, propertyHistoryEnabled: true }, knex)).toBeNull();
      } finally { spy.mockRestore(); }
    });

    test('property history OFF: the legacy customer-wide lookup — a service scheduled before this visit, never this service', async () => {
      const spy = jest.spyOn(history, 'historyBeforeVisit');
      try {
        const knex = require('knex')({ client: 'pg' });
        let captured;
        const recording = (table) => {
          const q = knex(table);
          const first = q.first.bind(q);
          q.first = (...cols) => { captured = first(...cols).toString(); return Promise.resolve({ ai_summary: 'legacy summary' }); };
          return q;
        };
        expect(await loadPriorSummary({ ...visit, propertyHistoryEnabled: false }, recording)).toBe('legacy summary');
        expect(spy).not.toHaveBeenCalled();
        expect(captured).toBe('select "la"."ai_summary" from "lawn_assessments" as "la" left join "scheduled_services" as "ss" on "la"."service_id" = "ss"."id" where "la"."customer_id" = \'c1\' and "la"."ai_summary" is not null and ("ss"."scheduled_date" < \'2026-09-08\' or ("la"."service_id" is null and "la"."service_date" < \'2026-09-08\')) and ("la"."service_id" is null or not "la"."service_id" = \'s9\') order by COALESCE(ss.scheduled_date, la.service_date) DESC limit 1');
        // No service id: no same-service exclusion.
        await loadPriorSummary({ ...visit, serviceId: null, propertyHistoryEnabled: false }, recording);
        expect(captured).not.toContain('not "la"."service_id"');
        const none = (table) => Object.assign(knex(table), { first: async () => undefined });
        expect(await loadPriorSummary({ ...visit, propertyHistoryEnabled: false }, none)).toBeNull();
      } finally { spy.mockRestore(); }
    });
  });
});
