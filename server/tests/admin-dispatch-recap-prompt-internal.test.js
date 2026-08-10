/**
 * buildFindingsRecapPrompt must never feed internal fields to the
 * customer-copy model (pre-push P1 on the T&S calibration lane): internal
 * fields are tech-facing data — compliance entries (IRAC/FRAC, pollinator
 * status) and pricing-calibration capture (bed sqft, palm/tree counts,
 * density, access) — and the recommendations paragraph is customer-facing.
 * The persisted-snapshot side of the same contract lives in
 * buildTypedReportSnapshot (findings skip internal); this pins the
 * prompt side.
 */
const { buildFindingsRecapPrompt } = require('../routes/admin-dispatch')._test;
const { findingsSchemaForType } = require('../services/service-report/activity-indicators');

describe('buildFindingsRecapPrompt internal-field filter', () => {
  test('tree_shrub calibration + compliance values never reach the prompt; customer-grade findings still do', () => {
    const prompt = buildFindingsRecapPrompt({
      schema: findingsSchemaForType('tree_shrub'),
      values: {
        plant_groups: 'Palms,Shrubs',
        landscape_condition: 'Good',
        bed_sqft_serviced: '2400',
        palm_count_total: '8',
        tree_count_total: '3',
        shrub_density: 'Heavy',
        access_difficulty: 'Difficult',
        pollinator_status: 'Blooming — bees active',
        irac_frac_logged: 'Yes',
      },
      chips: ['Continue Tree & Shrub program'],
      serviceType: 'Tree & Shrub Service',
      commsContext: '',
    });
    expect(prompt).toContain('Plant groups serviced: Palms,Shrubs');
    expect(prompt).toContain('Overall landscape condition: Good');
    expect(prompt).not.toContain('2400');
    expect(prompt).not.toContain('Ornamental bed area');
    expect(prompt).not.toContain('Palms on property');
    expect(prompt).not.toContain('Trees on property');
    expect(prompt).not.toContain('Shrub density');
    expect(prompt).not.toContain('Access difficulty');
    expect(prompt).not.toContain('pollinator');
    expect(prompt).not.toContain('IRAC');
  });
});
