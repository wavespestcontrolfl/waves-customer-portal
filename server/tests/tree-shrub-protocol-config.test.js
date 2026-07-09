const protocols = require('../config/protocols.json');

function treeShrubText() {
  return JSON.stringify(protocols.tree_shrub);
}

function visit(month) {
  return protocols.tree_shrub.visits.find((row) => row.month === month);
}

describe('10/10 SWFL tree and shrub protocol config', () => {
  test('is published as the active tree and shrub program', () => {
    const program = protocols.tree_shrub;

    // Display name was refined to "Tree & Shrub Protocol" (#1799); the
    // version string still pins the 10/10 SWFL program identity.
    expect(program.name).toMatch(/Tree & Shrub Protocol/);
    expect(program.version).toBe('2026.06-swfl-tree-shrub-10');
    expect(program.visits).toHaveLength(12);
    expect(program.notes.join('\n')).toMatch(/IRAC\/FRAC/);
    expect(program.notes.join('\n')).toMatch(/ordinance/i);
    expect(program.final_operating_sentence).toMatch(/legal by ordinance zone/);
  });

  test('keeps Snapshot as the quarterly bed differentiator', () => {
    const snapshotVisits = protocols.tree_shrub.visits
      .filter((row) => /Snapshot 2\.5TG/i.test(row.primary))
      .map((row) => row.visit);

    expect(snapshotVisits).toEqual([1, 4, 7, 10]);
    expect(protocols.tree_shrub.calibration.snapshot_rates.join('\n')).toMatch(/2\.3 lb\/1,000 sq ft/);
    expect(protocols.tree_shrub.calibration.snapshot_rates.join('\n')).toMatch(/4\.6 lb\/1,000 sq ft/);
  });

  test('blocks old summer N/P fertilizer defaults during Sarasota and Manatee blackout months', () => {
    const summerPrimary = ['Jun', 'Jul', 'Aug', 'Sep']
      .map((month) => visit(month).primary)
      .join('\n');

    expect(summerPrimary).not.toMatch(/8-2-12|13-0-13|Alfalfa Meal/i);
    expect(visit('Jul').notes).toMatch(/blocked on Sarasota\/Manatee landscape accounts/);
    expect(protocols.tree_shrub.service_area_rules.map((row) => row.zone)).toEqual([
      'Sarasota/Venice',
      'North Port',
      'Manatee/Parrish',
      'Other/Unknown',
    ]);
  });

  test('removes prior neonic, oil-copper, and fungicide-classification mistakes', () => {
    const text = treeShrubText();

    expect(visit('Mar').primary).not.toMatch(/Zylam/i);
    expect(visit('Jun').primary).not.toMatch(/Merit/i);
    expect(visit('Sep').primary).not.toMatch(/Merit/i);
    expect(visit('Jul').primary).not.toMatch(/Zylam/i);
    expect(text).not.toMatch(/FRAC 33|SuffOil-X \+ Talstar|Propizol palm injection|take-all root rot/i);
    expect(text).toMatch(/FRAC P07/);
    expect(text).toMatch(/Group 4A\/neonic-style pressure/);
  });

  test('keeps palm and tree injections separate from tiers', () => {
    const addOns = protocols.tree_shrub.injection_add_ons;

    expect(addOns.included_in_tiers).toBe(false);
    expect(addOns.minimum_price_per_palm).toBe(35);
    expect(addOns.record_required).toEqual(expect.arrayContaining([
      'Plant species',
      'DBH or palm size class',
      'Product',
      'Dose',
      'Number of ports',
      'Photos',
      'Follow-up date',
    ]));
    expect(addOns.products.join('\n')).toMatch(/IMA-jet.*4A\/neonic pressure/i);
  });
});
