const {
  GRASS_TYPE_LABELS,
  grassTypeLabel,
  normalizeGrassType,
  irrigationTypeHasSystem,
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
    expect(ctx.trackKey).toBe(null);
    expect(ctx.sunExposure).toBe(null);
    expect(ctx.irrigationSystem).toBe(null);
    expect(ctx.propertySqft).toBe(6400);
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
