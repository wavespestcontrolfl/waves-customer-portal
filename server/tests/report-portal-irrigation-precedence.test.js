/**
 * Mixed-source irrigation precedence — the customer's portal schedule
 * (explicit inches, or the figure derived from minutes × days × head type)
 * outranks technician turf/assessment readings everywhere a report reads
 * irrigation, so the lawn-profile figure and the water balance can never
 * come from different sources (pre-push audit P1 on 9a2c33a2a).
 */
const { buildLawnWaterContext, portalIrrigationInches, resolveCanonicalLawnRender } = require('../services/service-report/report-data');

const DERIVED_PREFS = {
  // 20 min × 4 days on spray (1.5"/hr) → 2.00"
  irrigation_inches_per_week: null,
  irrigation_run_minutes: 20,
  watering_days: ['Mon', 'Wed', 'Fri', 'Sun'],
  irrigation_system_type: ['spray'],
};

describe('portalIrrigationInches', () => {
  test('explicit portal inches outrank the derived figure', () => {
    expect(portalIrrigationInches({ ...DERIVED_PREFS, irrigation_inches_per_week: '1.25' })).toBe(1.25);
  });

  test('derives from runtime entries when inches are blank', () => {
    expect(portalIrrigationInches(DERIVED_PREFS)).toBe(2);
  });

  test('a zero-inch legacy value falls through to derivation — <= 0 is "no schedule" everywhere', () => {
    expect(portalIrrigationInches({ ...DERIVED_PREFS, irrigation_inches_per_week: 0 })).toBe(2);
    expect(portalIrrigationInches({ ...DERIVED_PREFS, irrigation_inches_per_week: '0', irrigation_run_minutes: null })).toBeNull();
  });

  test('toggle OFF blocks derivation — the runtime entries describe a system the customer says is not running', () => {
    expect(portalIrrigationInches({ ...DERIVED_PREFS, irrigation_system: false })).toBeNull();
    expect(portalIrrigationInches({ ...DERIVED_PREFS, irrigation_system: true })).toBe(2);
    // An explicit typed value keeps the existing prefs-only suppression
    // semantics downstream — the resolver still returns it.
    expect(portalIrrigationInches({ ...DERIVED_PREFS, irrigation_system: false, irrigation_inches_per_week: 1.25 })).toBe(1.25);
  });

  test('declines to null when derivation cannot be honest', () => {
    expect(portalIrrigationInches({ ...DERIVED_PREFS, irrigation_system_type: ['spray', 'rotor'] })).toBeNull();
    expect(portalIrrigationInches(null)).toBeNull();
  });
});

describe('PDF signature tracks portal irrigation state', () => {
  // Stub knex: no linked assessment (bare-signature path), prefs row served
  // for property_preferences. A prefs edit that changes the resolved inches
  // (or the toggle) MUST change the signature, or /api/reports/:token keeps
  // serving a cached PDF with the old water balance (GH codex P1 #3478 r15).
  const stubKnex = (prefsRow) => (table) => {
    const chain = {
      where: () => chain,
      orderBy: () => chain,
      first: async () => (table === 'property_preferences' ? prefsRow : undefined),
    };
    return chain;
  };
  const SERVICE = { customer_id: 'c1', service_line: 'lawn' };

  test('signature is stable for unchanged prefs and moves when derived inches or the toggle change', async () => {
    const base = { customer_id: 'c1', irrigation_system: true, ...DERIVED_PREFS };
    const a = await resolveCanonicalLawnRender(SERVICE, stubKnex(base));
    const b = await resolveCanonicalLawnRender(SERVICE, stubKnex({ ...base }));
    expect(a.signature).toBe(b.signature);
    const minutesChanged = await resolveCanonicalLawnRender(SERVICE, stubKnex({ ...base, irrigation_run_minutes: 40 }));
    expect(minutesChanged.signature).not.toBe(a.signature);
    const toggledOff = await resolveCanonicalLawnRender(SERVICE, stubKnex({ ...base, irrigation_system: false }));
    expect(toggledOff.signature).not.toBe(a.signature);
  });
});

describe('failed prefs read never caches', () => {
  // Source pin (same style as lawn-week-weather-freeze): the render-time
  // prefs read must distinguish failure from absence and ride the
  // weekWeatherUncacheable gate both PDF cache sites already honor — a
  // blipped read rendering tech values must not be stored under the
  // portal-stamped cache key (GH codex P1 #3478 r18).
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');

  test('prefs read failure marks the render uncacheable', () => {
    expect(source).toMatch(/prefsReadFailed = true/);
    expect(source).toMatch(/weekWeatherUncacheable: weekWeatherUnfrozen \|\| !!weekWeatherPendingReason \|\| prefsReadFailed/);
    expect(source).toMatch(/portalPrefsReadFailed: prefsReadFailed/);
  });

  test('pinned (emailed) delivery defers with a retryable error on a failed prefs read', () => {
    // Uncacheable only stops STORING — the queue would still email the
    // blipped render. The delivery gate mirrors the unfrozen-week one.
    const queueSource = fs.readFileSync(path.join(__dirname, '../services/service-report/pdf-queue.js'), 'utf8');
    expect(queueSource).toMatch(/portalPrefsReadFailed && isDeliveryPin/);
    expect(queueSource).toMatch(/portal_prefs_read_failed/);
    expect(queueSource).toMatch(/portalPrefsReadFailed && isDeliveryPin\)[\s\S]{0,300}?retryable = true/);
  });
});

describe('mixed sources agree across the report', () => {
  test('derived portal schedule beats turf and assessment readings in the water balance', () => {
    const ctx = buildLawnWaterContext({
      assessment: { irrigation_inches_per_week: '0.4' },
      turfProfile: { irrigation_inches_per_week: '0.75' },
      propertyPrefs: DERIVED_PREFS,
    });
    expect(ctx.irrigationInchesPerWeek).toBe(2);
  });

  test('tech readings still fill in when the portal has nothing usable', () => {
    const ctx = buildLawnWaterContext({
      assessment: { irrigation_inches_per_week: '0.4' },
      turfProfile: { irrigation_inches_per_week: '0.75' },
      propertyPrefs: { ...DERIVED_PREFS, irrigation_run_minutes: null },
    });
    expect(ctx.irrigationInchesPerWeek).toBe(0.75);
  });
});
