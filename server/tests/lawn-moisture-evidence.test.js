jest.mock('../models/db', () => jest.fn(() => { throw new Error('Unexpected database access'); }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => false }));

const { mergePhotoComposites } = require('../services/lawn-photo-merge');
const { averageScores, mapToDisplayScores, applySeasonalAdjustment } = require('../services/lawn-assessment');
const { buildLawnAssessmentReportData } = require('../services/service-report/report-data');
const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');

const SERVICE = { id: 'record-1', customer_id: 'customer-1', scheduled_service_id: 'visit-1' };
const ASSESSMENT = {
  id: 'assessment-1', customer_id: SERVICE.customer_id, service_record_id: SERVICE.id,
  confirmed_by_tech: true,
  // No dated weather/photo fixture: every read stays within this in-memory DB.
  service_date: null,
  turf_density: 88, weed_suppression: 92, color_health: 86, stress_damage: 90,
};

function assessmentDb(rows) {
  return table => {
    expect([
      'lawn_assessments', 'lawn_assessment_photos', 'customer_turf_profiles',
      'property_preferences', 'property_health_snapshots',
    ]).toContain(table);
    let selected = table === 'lawn_assessments' ? rows : [];
    const query = {
      where(criteria) {
        selected = selected.filter(row => Object.entries(criteria).every(([key, value]) => row[key] === value));
        return query;
      },
      whereNotNull: () => query,
      orderBy: () => query,
      limit: () => query,
      first: async () => selected[0] || null,
      catch: () => Promise.resolve(selected),
    };
    return query;
  };
}

const reportFor = row => buildLawnAssessmentReportData(SERVICE, 'lawn', assessmentDb([row]));

describe('moisture evidence survives assessment persistence and report projection', () => {
  test.each([
    [undefined, undefined, null],
    ['unknown', 'modrate', null],
    [true, ['severe'], null],
    ['severe', undefined, 'severe'],
    ['invalid', 'minor', 'minor'],
    ['none', null, 'none'],
    ['none', 'severe', 'moderate'],
  ])('provider values %j / %j persist as %j', async (first, second, expected) => {
    const { composite } = averageScores({ drought_stress: first }, { drought_stress: second });
    const display = mapToDisplayScores(composite);
    const report = await reportFor({ ...ASSESSMENT, composite_scores: JSON.stringify(display) });
    expect(report.droughtStress).toBe(expected);
    const rendered = buildLawnReportV2({ lawnAssessment: report });
    expect(rendered.water.droughtSignal).toBe(expected === null ? null : expected !== 'none');
    if (expected === null) expect(rendered.snapshot.noActionNeeded).toBe(false);
  });

  test('missing or malformed photos cannot erase a valid provider finding', async () => {
    const photos = [
      averageScores({ drought_stress: ['severe'] }, null),
      averageScores({}, { drought_stress: 'invalid' }),
      averageScores(null, { drought_stress: 'minor' }),
    ];
    const display = mapToDisplayScores(mergePhotoComposites(photos));
    expect((await reportFor({ ...ASSESSMENT, composite_scores: JSON.stringify(display) })).droughtStress).toBe('minor');
    expect(mapToDisplayScores(mergePhotoComposites(photos.slice(0, 2))).drought_stress).toBeNull();
  });

  test.each(['none', 'minor', 'moderate', 'severe'])('%s survives display mapping, seasonal adjustment and JSON storage', async severity => {
    const display = mapToDisplayScores({ drought_stress: severity, observations: 'Synthetic lawn observation.' });
    const adjusted = applySeasonalAdjustment(display, 1);
    expect(adjusted.drought_stress).toBe(severity);
    const report = await reportFor({
      ...ASSESSMENT,
      composite_scores: JSON.stringify(display),
      adjusted_scores: JSON.stringify(adjusted),
    });
    expect(report.droughtStress).toBe(severity);
    expect(buildLawnReportV2({ lawnAssessment: report }).water.coverageWatch).toBe(severity !== 'none');
  });

  test('a localized severe photo survives the multi-photo merge and persistence', async () => {
    const photos = ['none', 'none', 'severe'].map(drought_stress => ({ composite: { drought_stress } }));
    const display = mapToDisplayScores(mergePhotoComposites(photos));
    const report = await reportFor({ ...ASSESSMENT, composite_scores: JSON.stringify(display) });
    expect(report.droughtStress).toBe('severe');
  });

  test.each([undefined, null, '', 'unknown', 'moderate drought', true, ['severe']])('unusable severity %j stays unknown at both boundaries', async drought_stress => {
    expect(mapToDisplayScores({ drought_stress }).drought_stress).toBeNull();
    const report = await reportFor({ ...ASSESSMENT, composite_scores: { drought_stress } });
    expect(report.droughtStress).toBeNull();
  });

  test.each([null, undefined, '{broken', '{}'])('legacy composite %j remains unknown despite prose or a low combined stress score', async composite_scores => {
    const report = await reportFor({
      ...ASSESSMENT, composite_scores, stress_damage: 35,
      observations: 'Visible signs of underwatering have not yet resolved.',
    });
    expect(report.droughtStress).toBeNull();
  });

  test('projects only the allowlisted cause and retains the separate technician flag', async () => {
    const report = await reportFor({
      ...ASSESSMENT,
      composite_scores: { drought_stress: 'severe', debug: 'INTERNAL_MODEL_DETAILS' },
      claude_raw: { debug: 'INTERNAL_MODEL_DETAILS' },
      gemini_raw: { debug: 'INTERNAL_MODEL_DETAILS' },
      stress_flags: JSON.stringify({ drought_stress: false }),
    });
    expect(report.droughtStress).toBe('severe');
    expect(report.scores.stressFlags.drought_stress).toBe(false);
    expect(buildLawnReportV2({ lawnAssessment: report }).water.coverageWatch).toBe(false);
    expect(JSON.stringify(report)).not.toContain('INTERNAL_MODEL_DETAILS');
    expect(report).not.toHaveProperty('composite_scores');
  });

  test.each([
    ['unconfirmed', { confirmed_by_tech: false }],
    ['another customer', { customer_id: 'customer-2' }],
    ['another visit', { service_record_id: 'record-2' }],
  ])('%s assessment cannot supply moisture evidence', async (_label, overrides) => {
    const row = { ...ASSESSMENT, composite_scores: { drought_stress: 'severe' }, ...overrides };
    expect(await reportFor(row)).toBeNull();
    await expect(buildLawnAssessmentReportData(SERVICE, 'lawn', assessmentDb([row]), { pinnedAssessmentId: row.id }))
      .rejects.toMatchObject({ code: 'pinned_assessment_unavailable' });
  });
});
