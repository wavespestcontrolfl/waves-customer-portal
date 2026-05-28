const {
  GRASS_TYPE_LABELS,
  grassTypeLabel,
  normalizeGrassType,
  irrigationTypeHasSystem,
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
});
