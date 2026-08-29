/**
 * With a weekly watering plan on the card, every actionable watering
 * statement defers to the plan (codex #3565 gh-r27): insight-card actions,
 * the root-cause sentence, the surplus watering-in aftercare clause.
 */
const { buildLawnInsightCards } = require('../services/service-report/lawn-report-insights');
const { buildRootCause } = require('../services/service-report/lawn-report-v2');

const PLAN = { title: 'This week: check the rain before you water', detail: '…' };

describe('insight cards defer to the plan', () => {
  const waterCard = (water, extra = {}) => buildLawnInsightCards({ categories: [], water, grassLabel: 'St. Augustine', ...extra }).find((c) => c.category === 'water');
  test('deficit: no "add irrigation time" when a plan is present', () => {
    expect(waterCard({ status: 'deficit' }).customerAction).toMatch(/Add a little irrigation time/);
    const withPlan = waterCard({ status: 'deficit', weekPlan: PLAN });
    expect(withPlan.customerAction).toMatch(/Follow this week’s watering plan below/);
    expect(withPlan.customerAction).not.toMatch(/irrigation time/);
    expect(withPlan.nextVisitPlan).not.toMatch(/added water/);
    expect(withPlan.wavesAction).toMatch(/this week’s watering plan/);
  });
  test('surplus: no "ease back by one cycle" when a plan is present (watering-in variant included)', () => {
    expect(waterCard({ status: 'surplus' }).customerAction).toMatch(/Ease back on irrigation by one cycle/);
    expect(waterCard({ status: 'surplus', weekPlan: PLAN }).customerAction).toMatch(/Follow this week’s watering plan below — it already accounts for the extra water/);
    expect(waterCard({ status: 'surplus', weekPlan: PLAN }, { waterInRequired: true }).customerAction).toMatch(/^Water in today’s application as directed, then follow this week’s watering plan below/);
  });
});

describe('root cause defers to the plan', () => {
  test('surplus and deficit name the plan; other stories unchanged', () => {
    expect(buildRootCause({ effectiveWaterStatus: 'deficit' })).toMatch(/a bit more even watering/);
    expect(buildRootCause({ effectiveWaterStatus: 'deficit', weekPlan: PLAN })).toMatch(/this week’s watering plan below sets the runs/);
    expect(buildRootCause({ effectiveWaterStatus: 'surplus', weekPlan: PLAN })).toMatch(/this week’s watering plan below already eases back/);
    expect(buildRootCause({ effectiveWaterStatus: 'balanced', coverageWatch: true, weekPlan: PLAN })).toMatch(/uneven sprinkler coverage/);
  });
});

describe('surplus aftercare clause', () => {
  test('source pin: with a plan the watering-in exception points at the plan, not "the reduced schedule"', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'service-report', 'lawn-report-v2.js'), 'utf8');
    expect(src).toMatch(/after it, follow this week’s watering plan\.'/);
    expect(src).toMatch(/weekPlan: water \? water\.weekPlan : null \}\);/);
  });
});
