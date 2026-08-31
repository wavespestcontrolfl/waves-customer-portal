/**
 * GATE_SEPARATE_COMBO_VISITS — the two TRUE two-program combined routes
 * (pest+termite bait, lawn+T&S) retire; the bait+BOND rider routes keep
 * combining; gate off is byte-identical to today. The catalog-row
 * archive deliberately ships LATER (the permanent-flip data pass) — a
 * dark-shipped migration would break the gate-off rollback contract.
 */
const {
  combineRecurringServicesForScheduling,
  recurringServiceKey,
} = require('../services/estimate-converter');

afterEach(() => { delete process.env.GATE_SEPARATE_COMBO_VISITS; });

describe('combineRecurringServicesForScheduling under GATE_SEPARATE_COMBO_VISITS', () => {
  test('pest + termite bait: no combined row — the bait rewrites to a STANDALONE catalog unit', () => {
    // Standalone (not `remaining`): the standalone pipeline schedules and
    // seeds on BOTH accept branches (rodent-bait precedent), and standalone
    // termite seeding requires exactly 4 visits — which the retired route's
    // companionDefaultPattern semantics supply for a sparse legacy line.
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const { remaining, combos, standalone } = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
      { name: 'Termite Bait Station System', frequency: 'quarterly' },
    ]);
    expect(combos).toEqual([]);
    expect(standalone).toEqual([{
      catalogServiceKey: 'termite_bait',
      service: { name: 'Termite Bait Station Service', frequency: 'quarterly', visitsPerYear: 4 },
    }]);
    expect(remaining.map((l) => recurringServiceKey(l))).toEqual(['pest_control']);
  });

  test('a COUNT-LESS bait companion (companionDefaultPattern shape) still rewrites with visitsPerYear 4', () => {
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const { standalone, remaining } = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
      { name: 'Termite Bait Station System' }, // no cadence, no count
    ]);
    expect(standalone).toHaveLength(1);
    expect(standalone[0].service.visitsPerYear).toBe(4);
    expect(remaining).toHaveLength(1);
  });

  test('a mismatched-cadence or conflicted bait line keeps its pre-existing per-line semantics', () => {
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const mismatched = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
      { name: 'Termite Bait Station System', frequency: 'monthly' },
    ]);
    expect(mismatched.standalone).toEqual([]);
    expect(mismatched.remaining).toHaveLength(2);
    const conflicted = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
      { name: 'Termite Bait Station System', frequency: 'quarterly', visitsPerYear: 4, appsPerYear: 6 },
    ]);
    expect(conflicted.standalone).toEqual([]);
    expect(conflicted.remaining).toHaveLength(2);
  });

  test('a bait line with NO pest primary is untouched (nothing was retired for it)', () => {
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const { standalone, remaining } = combineRecurringServicesForScheduling([
      { name: 'Termite Bait Station System' },
    ]);
    expect(standalone).toEqual([]);
    expect(remaining).toHaveLength(1);
  });

  test('lawn + tree & shrub schedule as TWO standalone lines', () => {
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const { remaining, combos } = combineRecurringServicesForScheduling([
      { name: 'Lawn Fertilization & Weed Control', frequency: 'bimonthly', appsPerYear: 6 },
      { name: 'Tree & Shrub Care Program', frequency: 'bimonthly', visitsPerYear: 6 },
    ]);
    expect(combos).toEqual([]);
    expect(remaining).toHaveLength(2);
  });

  test('accepted MONTHLY beside a stale quarterly pest line declines the rewrite (parity with the combine)', () => {
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const { remaining, combos, standalone } = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
      { name: 'Termite Bait Station System', frequency: 'quarterly' },
    ], { acceptFrequency: 'monthly' });
    expect(combos).toEqual([]);
    expect(standalone).toEqual([]);
    expect(remaining).toHaveLength(2);
  });

  test('the ACCEPTED quarterly cadence is stamped onto a stale monthly pest line when separating', () => {
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const { remaining, standalone } = combineRecurringServicesForScheduling([
      { name: 'Pest Control Plan', frequency: 'monthly' },
      { name: 'Termite Bait Station System', frequency: 'quarterly' },
    ], { acceptFrequency: 'quarterly' });
    expect(standalone).toHaveLength(1);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].frequency).toBe('quarterly'); // accept wins over the stale line
  });

  test('restamping strips a stale count that disagrees with the accepted cadence (r12 parity)', () => {
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const { remaining, standalone } = combineRecurringServicesForScheduling([
      { name: 'Pest Control Plan', frequency: 'monthly', visitsPerYear: 12 },
      { name: 'Termite Bait Station System', frequency: 'quarterly' },
    ], { acceptFrequency: 'quarterly' });
    expect(standalone).toHaveLength(1);
    expect(remaining[0].frequency).toBe('quarterly');
    expect(remaining[0].visitsPerYear).toBeUndefined(); // 12 would seed 3 years of quarterly visits
  });

  test('an AGREEING count survives the restamp', () => {
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const { remaining } = combineRecurringServicesForScheduling([
      { name: 'Pest Control Plan', frequency: 'monthly', visitsPerYear: 4 },
      { name: 'Termite Bait Station System', frequency: 'quarterly' },
    ], { acceptFrequency: 'quarterly' });
    expect(remaining[0].frequency).toBe('quarterly');
    expect(remaining[0].visitsPerYear).toBe(4);
  });

  test('a cadence-less pest line with no accepted selection never separates-with-rewrite', () => {
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const { remaining, standalone } = combineRecurringServicesForScheduling([
      { name: 'Pest Control Plan' },
      { name: 'Termite Bait Station System', frequency: 'quarterly' },
    ]);
    expect(standalone).toEqual([]);
    expect(remaining).toHaveLength(2);
  });

  test('an INELIGIBLE bond (mismatched cadence) no longer suppresses the bait rewrite', () => {
    // audit P0: pest + count-less bait + monthly bond — the bond cannot
    // combine, so the bait must still reach the standalone pipeline.
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const { remaining, combos, standalone } = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
      { name: 'Termite Bait Station System' },
      { name: 'Termite Bond (5-Year Term)', service: 'termite_bond_5yr', frequency: 'monthly' },
    ]);
    expect(combos).toEqual([]);
    expect(standalone).toEqual([{
      catalogServiceKey: 'termite_bait',
      service: { name: 'Termite Bait Station Service', frequency: 'quarterly', visitsPerYear: 4 },
    }]);
    expect(remaining.map((l) => recurringServiceKey(l)).sort()).toEqual(['pest_control', 'termite_bond_5yr']);
  });

  test('identity-aware reserved matching reads label AND durable catalog identity', () => {
    const converter = require('../services/estimate-converter');
    const { identityAwareComboMatches } = converter._test || converter;
    const combo = { route: { primaryKey: 'termite_bait', companionKey: 'termite_bond_5yr' } };
    const idMap = new Map([['svc-bait', 'termite_bait']]);
    // Adopted reservation: stale pest label, authoritative bait identity.
    const staleLabelBait = { service_type: 'Pest Control Plan', service_id: 'svc-bait', service_key_snapshot: null };
    expect(identityAwareComboMatches([staleLabelBait], combo, idMap)).toHaveLength(1);
    // Snapshot fallback when the id is unresolved.
    const snapshotBait = { service_type: 'Pest Control Plan', service_id: null, service_key_snapshot: 'termite_bait' };
    expect(identityAwareComboMatches([snapshotBait], combo, idMap)).toHaveLength(1);
    // A genuinely unrelated reservation stays zero-match.
    const pestRow = { service_type: 'Quarterly Pest Control Service', service_id: null, service_key_snapshot: 'pest_general_quarterly' };
    expect(identityAwareComboMatches([pestRow], combo, idMap)).toHaveLength(0);
  });

  test('the reserved branch promotes the pest program when the BAIT owns the reservation (source guard)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/estimate-converter.js'), 'utf8');
    expect(src).toContain('promotedRetiredPestUnits');
    expect(src).toContain('...promotedRetiredPestUnits]');
    // Zero-match combos (pest-owned reservation beside a kept bait+bond
    // combo) promote alongside the reserved visit, gate-scoped.
    expect(src).toContain('promotedComboUnits');
    expect(src).toContain('...promotedComboUnits,');
    expect(src.slice(src.indexOf('const promotedComboUnits'), src.indexOf('const promotedComboUnits') + 900)).toContain('identityAwareComboMatches');
    // The rewrite and the promotion share ONE classification under the gate…
    expect(src).toContain('const comboRewritePairs =');
    // …and the retired-pair detection counts a bait+bond COMBO as bait
    // coverage in BOTH the promotion and the lock pre-pass.
    expect(src.match(/combo\.route\.primaryKey === 'termite_bait'/g)).toHaveLength(2);
    expect(src.match(/PEST_CADENCE_CATALOG_KEYS\[/g)).toHaveLength(2); // promotion + lock pre-pass
    expect(src).toContain('prePassRetiredPestPair');
  });

  test('pest + bait + BOND: pest separates, and the bond RIDES the bait visit (v1 never could)', () => {
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const { remaining, combos, standalone } = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
      { name: 'Termite Bait Station System', frequency: 'quarterly' },
      { name: 'Termite Bond (5-Year Term)', service: 'termite_bond_5yr', frequency: 'quarterly' },
    ]);
    expect(standalone).toEqual([]); // bait NOT spliced — the rider route claims it
    expect(combos).toHaveLength(1);
    expect(combos[0].service.name).toBe('Quarterly Termite Bait Station + Termite Bond Service (5-Year Term)');
    expect(remaining.map((l) => recurringServiceKey(l))).toEqual(['pest_control']);
  });

  test('termite bait + BOND still combines — the bond is a rider, not a second program', () => {
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    const { combos, remaining } = combineRecurringServicesForScheduling([
      { name: 'Termite Bait Station System', frequency: 'quarterly' },
      { name: 'Termite Bond (5-Year Term)', service: 'termite_bond_5yr', frequency: 'quarterly' },
    ]);
    expect(combos).toHaveLength(1);
    expect(combos[0].service.name).toBe('Quarterly Termite Bait Station + Termite Bond Service (5-Year Term)');
    expect(remaining).toEqual([]);
  });

  test('the reserved-accept surfaces carry the tree & shrub promotion under the gate (source guard)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/estimate-converter.js'), 'utf8');
    // Promotion filter and lock pre-pass both include tree_shrub only under
    // the gate, and both resolve the T&S cadence→catalog map.
    expect(src).toContain("...(process.env.GATE_SEPARATE_COMBO_VISITS === 'true' ? ['tree_shrub'] : [])");
    expect(src.match(/TREE_SHRUB_CADENCE_CATALOG_KEYS\[pattern\]/g)).toHaveLength(2);
    expect(src).toContain("fam === 'tree_shrub'\n                && process.env.GATE_SEPARATE_COMBO_VISITS === 'true'");
  });

  test('gate off: the two-program routes still combine exactly as before', () => {
    const { combos } = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
      { name: 'Termite Bait Station System', frequency: 'quarterly' },
    ]);
    expect(combos).toHaveLength(1);
    expect(combos[0].service.name).toBe('Quarterly Pest + Termite Bait Station Service');
  });
});
