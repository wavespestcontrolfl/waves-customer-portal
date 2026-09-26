const fs = require('fs');
const path = require('path');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', '..', relativePath), 'utf8');
}

describe('admin estimate roach UI copy', () => {
  test('the live admin estimator explains recurring roach activity without a per-visit multiplier', () => {
    const source = readRepoFile('client/src/pages/admin/EstimateToolViewV2.jsx');

    expect(source).toContain('label="Roach Activity"');
    expect(source).toContain('Native / Palmetto / American roaches');
    expect(source).toContain('German roaches');
    expect(source).toContain('Adds a one-time Cockroach Treatment line to recurring pest.');
    expect(source).toContain('This is not a recurring per-visit multiplier.');
    expect(source).toContain('recurringRoachType');
  });

  test('the live admin estimator keeps standalone native and German cleanouts explicit', () => {
    const source = readRepoFile('client/src/pages/admin/EstimateToolViewV2.jsx');

    expect(source).toContain('Standalone Native Cockroach Treatment');
    expect(source).toContain('German Roach Cleanout');
    expect(source).toContain('Cockroach Treatment Service');
    expect(source).toContain('Standalone / Specialty Services');
    expect(source).toContain('Service Type');
    expect(source).toContain('German Roach Cleanout is a separate specialty program');

    // Severity tier selector drives the 2/3/4-visit flat program price.
    expect(source).toContain('germanRoachSeverity');
    expect(source).toContain('Infestation Severity');
    expect(source).toContain('Light \u2014 2 Visits ($350)');
    expect(source).toContain('Medium \u2014 3 Visits ($450)');
    expect(source).toContain('Heavy \u2014 4 Visits ($550)');

    expect(source).toContain('standaloneRoachTreatment');
    expect(source).toContain('germanRoachCleanoutSelected');
    // Renamed 2026-07: the box now carries all hoisted pricing review
    // reasons, not just roach routing.
    expect(source).toContain('Pricing Review Notes');
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
    const fallback = readRepoFile('client/src/lib/estimateEngine.js');

    expect(v2).toContain('Palms on property');
    expect(v2).toContain('Palms to treat');
    expect(v2).toContain('palmTreatmentCount');
    expect(v2).toContain('Palm count is required for palm injection pricing.');

    expect(v2).toContain('palmInjection');
    expect(v2).toContain('measurements: { palmCount: palmTreatmentCount }');
    expect(fallback).toContain('never fall back to one palm or a');
    expect(fallback).toContain('30% satellite estimate');
  });
});
