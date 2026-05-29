const fs = require('fs');
const path = require('path');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', '..', relativePath), 'utf8');
}

describe('admin estimate roach UI copy', () => {
  const files = [
    'client/src/pages/admin/EstimatePage.jsx',
    'client/src/pages/admin/EstimateToolViewV2.jsx',
  ];

  test.each(files)('%s separates recurring roach activity from standalone cleanouts', (relativePath) => {
    const source = readRepoFile(relativePath);

    expect(source).toContain('Roach Activity on Initial Visit');
    expect(source).toContain('Native / Palmetto / American roaches');
    expect(source).toContain('German roaches');
    expect(source).toContain('Adds a one-time Initial Roach Knockdown line to recurring pest.');
    expect(source).toContain('This is not a recurring per-visit multiplier.');

    expect(source).toContain('Standalone Native Cockroach Treatment');
    expect(source).toContain('German Roach Cleanout');
    expect(source).toContain('Cockroach Specialty Service');
    expect(source).toContain('Standalone / Specialty Services');
    expect(source).toContain('Service Type');
    expect(source).toContain('German Roach Cleanout is a separate specialty program');

    // Severity tier selector drives the 2/3/4-visit flat program price.
    expect(source).toContain('germanRoachSeverity');
    expect(source).toContain('Infestation Severity');
    expect(source).toContain('Light \u2014 2 Visits ($350)');
    expect(source).toContain('Medium \u2014 3 Visits ($450)');
    expect(source).toContain('Heavy \u2014 4 Visits ($550)');

    expect(source).toContain('recurringRoachType');
    expect(source).toContain('standaloneRoachTreatment');
    expect(source).toContain('germanRoachCleanoutSelected');
    expect(source).toContain('Roach Routing Notes');
  });

  test('legacy client preview keeps roach routing metadata explicit', () => {
    const source = readRepoFile('client/src/lib/estimateEngine.js');

    expect(source).toContain("source: 'recurring_pest_roach_activity'");
    expect(source).toContain("source: 'standalone_native_cockroach_treatment'");
    expect(source).toContain("source: 'german_roach_cleanout_selected'");
    expect(source).toContain("pricingModel: 'german_roach_severity_tier_cleanout'");
    expect(source).toContain("skippedService: 'standalone_native_cockroach_treatment'");
    expect(source).toContain("skippedReason: 'recurring_pest_initial_roach_already_covers_regular_roach'");
    expect(source).not.toContain("name: 'German Roach (3-visit)'");
    expect(source).not.toContain("name: 'Regular Roach'");
  });

  test('admin estimator exposes separate palm property and treatment counts', () => {
    const v2 = readRepoFile('client/src/pages/admin/EstimateToolViewV2.jsx');
    const legacy = readRepoFile('client/src/pages/admin/EstimatePage.jsx');
    const fallback = readRepoFile('client/src/lib/estimateEngine.js');

    for (const source of [v2, legacy]) {
      expect(source).toContain('Palms on property');
      expect(source).toContain('Palms to treat');
      expect(source).toContain('palmTreatmentCount');
      expect(source).toContain('Palm count is required for palm injection pricing.');
    }

    expect(v2).toContain('palmInjection');
    expect(v2).toContain('measurements: { palmCount: palmTreatmentCount }');
    expect(fallback).toContain('never fall back to one palm or a');
    expect(fallback).toContain('30% satellite estimate');
  });
});
