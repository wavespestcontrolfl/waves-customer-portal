const fs = require('fs');
const path = require('path');

const migration = require('../models/migrations/20260803200000_structural_product_report_copy.js');

describe('20260803200000 structural product report copy', () => {
  it('guards the Gentrol prefill on exactly what 20260723000001 wrote', () => {
    // If the seeding migration's value drifts, this guard would silently
    // no-op in fresh environments while still firing in prod — the two
    // migrations must stay in lockstep (prev-drift guard, #3134 pattern).
    const seedSource = fs.readFileSync(
      path.join(__dirname, '../models/migrations/20260723000001_species_specific_target_prefill.js'),
      'utf8'
    );
    expect(seedSource).toContain(
      "['Gentrol IGR', ['German cockroaches', 'Drain flies', 'Pantry moths & beetles']"
    );
    expect(migration.GENTROL_PRIOR_TARGETS).toEqual(['German cockroaches', 'Drain flies', 'Pantry moths & beetles']);
  });

  it('replaces the cloned plant-systemic copy only, on the two structural products', () => {
    expect(migration.SUMMARY_FIXES.map((f) => f.name).sort()).toEqual(['Alpine WSG', 'Temprid FX']);
    for (const fix of migration.SUMMARY_FIXES) {
      expect(fix.prior).toBe(migration.CLONED_PLANT_SUMMARY);
      expect(fix.next).not.toBe(fix.prior);
    }
  });

  it('new structural copy makes no plant, safety, or re-entry claims', () => {
    const banned = /plant|foliage|sap.feeding|turf|\bsafe\b|EPA-registered|re-?entry|\b\d+\s*(minutes?|hours?)\b/i;
    for (const fix of migration.SUMMARY_FIXES) {
      expect(fix.next).not.toMatch(banned);
    }
  });

  it('trimmed Gentrol prefill stays a single renderer pest family and within the cap', () => {
    expect(migration.GENTROL_NEXT_TARGETS.length).toBeLessThanOrEqual(3);
    for (const target of migration.GENTROL_NEXT_TARGETS) {
      expect(target).toMatch(/cockroach/i);
    }
  });

  it('down is an explicit no-op', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});

describe('20260803210000 Dominion dual-use copy', () => {
  const dominion = require('../models/migrations/20260803210000_dominion_dual_use_copy.js');
  const parent = require('../models/migrations/20260803200000_structural_product_report_copy.js');

  it('guards on the same cloned prior as the parent migration', () => {
    expect(dominion.CLONED_PLANT_SUMMARY).toBe(parent.CLONED_PLANT_SUMMARY);
  });

  it('targets exactly the two Dominion container rows', () => {
    expect(dominion.DOMINION_ROW_NAMES.sort()).toEqual(['Dominion 2L 1 gal', 'Dominion 2L 27.5 oz']);
  });

  it('dual-use copy names both labeled roles and makes no safety or re-entry claims', () => {
    expect(dominion.DOMINION_DUAL_USE_SUMMARY).toMatch(/termites/i);
    expect(dominion.DOMINION_DUAL_USE_SUMMARY).toMatch(/ornamentals or turf/i);
    expect(dominion.DOMINION_DUAL_USE_SUMMARY).not.toMatch(/\bsafe\b|EPA-registered|re-?entry|\b\d+\s*(minutes?|hours?)\b|barrier|guarantee/i);
  });

  it('down is an explicit no-op', async () => {
    await expect(dominion.down()).resolves.toBeUndefined();
  });
});
