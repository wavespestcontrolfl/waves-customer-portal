// public-ranges must price every published service from engine constants
// alone (no DB) — a sweep error here means an engine signature changed and
// the agent-readable pricing surface would silently lose a service.
const { computePublicPricingRanges, _internals } = require('../services/pricing-engine/public-ranges');

const EXPECTED_KEYS = [
  'general_pest_quarterly',
  'cockroach_treatment',
  'german_roach_cleanout',
  'german_roach_initial',
  'bed_bug_treatment',
  'mosquito_program',
  'wasp_hornet_removal',
  'flea_elimination',
  'rodent_bait_program',
  'rodent_trapping',
  'rodent_sanitation',
  'rodent_exclusion',
  'termite_bait_install',
  'termite_bait_monitoring',
  'termite_trenching',
  'pre_slab_termiticide',
  'wdo_inspection',
  'lawn_care_program',
  'one_time_lawn',
  'lawn_pest_knockdown',
  'one_time_pest',
  'one_time_mosquito',
  'bora_care',
  'rodent_wire_mesh',
  'rodent_bird_boxes',
  'trap_only_retainer',
  'recurring_foam',
  'rodent_inspection',
  'rodent_guarantee',
  'dethatching',
  'foam_drill',
  'lawn_plugging',
  'top_dressing',
  'tree_shrub_care',
  'palm_injection',
];

// Services that genuinely bill monthly — the only ones allowed a per-month unit.
const MONTHLY_BILLED_KEYS = new Set([
  'rodent_bait_program',
  'tree_shrub_care',
  'trap_only_retainer',
]);

describe('public pricing ranges', () => {
  let payload;

  beforeAll(() => {
    // Compute the baseline with both purchase gates explicitly unset so the
    // expected-key assertions don't depend on the ambient environment.
    const priorBond = process.env.GATE_TERMITE_BOND_OPTION;
    const priorRental = process.env.GATE_TERMITE_STATION_RENTAL;
    delete process.env.GATE_TERMITE_BOND_OPTION;
    delete process.env.GATE_TERMITE_STATION_RENTAL;
    try {
      payload = computePublicPricingRanges();
    } finally {
      if (priorBond !== undefined) process.env.GATE_TERMITE_BOND_OPTION = priorBond;
      if (priorRental !== undefined) process.env.GATE_TERMITE_STATION_RENTAL = priorRental;
    }
  });

  test('every service sweeps without errors', () => {
    expect(payload.errors).toEqual([]);
  });

  test('all expected services are present exactly once', () => {
    const keys = payload.services.map((s) => s.key);
    expect(keys.sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every range is a non-negative low <= high pair', () => {
    for (const s of payload.services) {
      expect(Number.isFinite(s.low)).toBe(true);
      expect(Number.isFinite(s.high)).toBe(true);
      // wasp_hornet_removal legitimately floors at $0 (bundled inclusion
      // with a recurring plan); everything else must price above zero.
      if (s.key === 'wasp_hornet_removal') expect(s.low).toBeGreaterThanOrEqual(0);
      else expect(s.low).toBeGreaterThan(0);
      expect(s.high).toBeGreaterThanOrEqual(s.low);
    }
  });

  test('units obey the owner copy rules', () => {
    for (const s of payload.services) {
      const text = `${s.name} ${s.unit} ${s.notes || ''}`;
      // "per visit" is banned customer-facing copy everywhere (owner rule;
      // only commercial is exempt, and commercial is not published here).
      // Visit COUNTS ("2-visit package") are fine; the unit phrasing is not.
      expect(text).not.toMatch(/per visit|\$\s*\d[\d,.]*\s*\/\s*visit/i);
      if (s.unit === 'per month') {
        expect(MONTHLY_BILLED_KEYS.has(s.key)).toBe(true);
      }
      // No per-year units: even the termite bond rides quarterly
      // applications (owner copy rule: no combined annual totals).
      expect(s.unit).not.toMatch(/per year/i);
      expect(text).toBeTruthy();
    }
    const pest = payload.services.find((s) => s.key === 'general_pest_quarterly');
    expect(pest.unit).toBe('per application');
    const lawn = payload.services.find((s) => s.key === 'lawn_care_program');
    expect(lawn.unit).toBe('per application');
  });

  test('no lawn or pest combined monthly totals are published', () => {
    const lawn = payload.services.find((s) => s.key === 'lawn_care_program');
    const pest = payload.services.find((s) => s.key === 'general_pest_quarterly');
    for (const s of [lawn, pest]) {
      expect(s.unit).not.toMatch(/month/i);
      expect(`${s.name} ${s.notes || ''}`).not.toMatch(/\$\d+\s*\/\s*mo/i);
    }
  });

  test('disclaimer points agents at the exact-quote calculator', () => {
    expect(payload.disclaimer).toContain('/pest-control-calculator/');
    expect(payload.currency).toBe('USD');
    expect(new Date(payload.generatedAt).getTime()).not.toBeNaN();
  });

  test('cache serves between syncs and refreshes when a sync applied', () => {
    // Run the identity assertion in the same gate-disabled context used for
    // the baseline, so an ambient gate value can't change the cache key.
    const priorBond = process.env.GATE_TERMITE_BOND_OPTION;
    const priorRental = process.env.GATE_TERMITE_STATION_RENTAL;
    delete process.env.GATE_TERMITE_BOND_OPTION;
    delete process.env.GATE_TERMITE_STATION_RENTAL;
    try {
      const a = computePublicPricingRanges();
      const b = computePublicPricingRanges();
      expect(b).toBe(a); // no sync between calls — cached payload is current
      const refreshed = computePublicPricingRanges({ refresh: true });
      expect(refreshed).not.toBe(a);
      expect(refreshed.services.map((s) => s.key)).toEqual(a.services.map((s) => s.key));
    } finally {
      if (priorBond !== undefined) process.env.GATE_TERMITE_BOND_OPTION = priorBond;
      if (priorRental !== undefined) process.env.GATE_TERMITE_STATION_RENTAL = priorRental;
    }
  });

  // Gate tests must not depend on the ambient environment: explicitly unset
  // the gate for the off assertion, and restore the caller's value after.
  function withGate(gate, value, fn) {
    const prior = process.env[gate];
    if (value === undefined) delete process.env[gate];
    else process.env[gate] = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env[gate];
      else process.env[gate] = prior;
    }
  }

  test('termite bond publishes only while its purchase gate is on', () => {
    withGate('GATE_TERMITE_BOND_OPTION', undefined, () => {
      const ungated = computePublicPricingRanges();
      expect(ungated.services.find((s) => s.key === 'termite_bond')).toBeUndefined();
    });
    withGate('GATE_TERMITE_BOND_OPTION', 'true', () => {
      const gated = computePublicPricingRanges();
      const bond = gated.services.find((s) => s.key === 'termite_bond');
      expect(bond).toBeDefined();
      expect(bond.unit).toBe('per application');
      expect(gated.errors).toEqual([]);
    });
  });

  test('termite station rental publishes only while its purchase gate is on', () => {
    withGate('GATE_TERMITE_STATION_RENTAL', undefined, () => {
      const ungated = computePublicPricingRanges();
      expect(ungated.services.find((s) => s.key === 'termite_station_rental')).toBeUndefined();
    });
    withGate('GATE_TERMITE_STATION_RENTAL', 'true', () => {
      const gated = computePublicPricingRanges();
      const rental = gated.services.find((s) => s.key === 'termite_station_rental');
      expect(rental).toBeDefined();
      expect(rental.unit).toBe('per application');
      expect(gated.errors).toEqual([]);
    });
  });

  test('buildRows exposes sweep errors instead of throwing', () => {
    const { rows, errors } = _internals.buildRows();
    expect(Array.isArray(rows)).toBe(true);
    expect(Array.isArray(errors)).toBe(true);
    expect(errors).toEqual([]);
  });
});
