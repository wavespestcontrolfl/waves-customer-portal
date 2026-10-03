// New-sod mode over the whole payload (lawn-new-sod-payload.js): one rule that replaces or
// removes every watering / irrigation / mowing module the clients read. Synthetic data only.
// The rendered-document proof is client/src/pages/ServiceReportDocument.newSod.test.jsx.

const { enforceNewSodPayload, NEW_SOD_PAYLOAD_RULES } = require('../services/service-report/lawn-new-sod-payload');
const { collectRenderedImageUrls } = require('../services/service-report/rendered-image-urls');

const { maximalLawnPayload } = require('./helpers/new-sod-maximal-payload');
const maximal = maximalLawnPayload;

describe('enforceNewSodPayload', () => {
  const out = enforceNewSodPayload(maximal());

  test('the rules table names every module it enforces', () => {
    expect(Object.keys(NEW_SOD_PAYLOAD_RULES).length).toBeGreaterThanOrEqual(14);
  });

  test('top level: the height-of-cut module and its gauge photo are gone, and the image mirror follows', () => {
    expect(out.mowingHeight).toBeNull();
    expect(collectRenderedImageUrls(out)).toEqual(['https://img.example.test/p1.jpg']);
    expect(collectRenderedImageUrls(maximal())).toContain('https://img.example.test/gauge.jpg');
  });

  test('product watering-in notes are removed; the pet note is not', () => {
    expect(out.applications[0].product.irrigation_notes).toBeNull();
    expect(out.applications[0].product.irrigation_required).toBeNull();
    expect(out.applications[0].product.reentry_summary).toBe('Keep pets off until dry.');
  });

  test('lawnAssessment: the plan is the fixed one, the advice and its signals are removed', () => {
    const la = out.lawnAssessment;
    expect(la.waterContext.weekPlan).toEqual({ title: 'New sod: water lightly every day', detail: 'Keep the sod moist with a light watering each day until it has rooted.', action: 'new_sod', visitInPlanWeek: true, prescribesRun: false });
    expect(la.waterContext.irrigationAdvice).toBeNull();
    expect(la.waterContext.targetInchesPerWeek).toBeNull();
    expect(la.waterContext.rainfallInches7d).toBe(3.2); // measurements stay
    expect(la.overwateringSignal).toBe(false);
    expect(la.droughtStress).toBeNull();
  });

  test('banner: exactly the fixed lines, none of the forecast, rain or mow-hold keys', () => {
    expect(out.reportV2.banner).toEqual({
      state: 'new_sod', lines: ['Water your new sod lightly every day.', 'Please hold off on mowing until the sod has rooted.'],
      holdUntil: null, waterInBy: null, expiresAt: null, ruleSource: 'new_sod',
    });
  });

  test('water card: no target range, status or explanation; the schedule evidence is untouched; no credit or hold plan fields', () => {
    const w = out.reportV2.water;
    expect(w).toMatchObject({ status: 'unknown', explanation: null, coverageWatch: false, droughtSignal: null, targetInches: null, rainInches: 3.2, irrigationInches: 1.5, totalInches: 4.7 });
    // The schedule evidence stays exactly as built (the maximal fixture has no schedule on file).
    expect(w.scheduleOnFile).toBe(false);
    expect(w.scheduleUnconfirmed).toBe(true);
    expect(w.weekPlan).toEqual({ title: 'New sod: water lightly every day', detail: 'Keep the sod moist with a light watering each day until it has rooted.', action: 'new_sod', visitInPlanWeek: true, prescribesRun: false });
    for (const key of ['afterHold', 'afterTreatment', 'depthInches']) expect(w.weekPlan).not.toHaveProperty(key);
  });

  test('aftercare: the fixed lines, no hold / credit / review / evidence fields, the pet note kept', () => {
    expect(out.reportV2.aftercare).toEqual({
      watering: 'Water your new sod lightly every day. Please hold off on mowing until the sod has rooted.',
      reentry: 'Keep pets off until dry.', waterInRequired: false, neutral: true, ruleSource: null,
    });
  });

  test('mowing and the mowing / water-gap trends are removed; other trends stay', () => {
    expect(out.reportV2.mowing).toBeNull();
    expect(out.reportV2.trends).toEqual({ overall: [{ label: 'Aug', value: 60 }, { label: 'Sep', value: 70 }] });
  });

  test('water and mowing cards are removed; advice keys are scrubbed; observations and the record stay', () => {
    expect(out.reportV2.insights.map((c) => c.category)).toEqual(['weeds']);
    expect(out.reportV2.insights[0]).toMatchObject({ whatWeSaw: 'Weeds competing with the turf in places.', wavesAction: 'Spot-treated where appropriate.', customerAction: null, nextVisitPlan: 'Reassess weed pressure next visit.' });
    expect(out.reportV2.snapshot).toMatchObject({ customerAction: null, wavesNext: null, rootCause: null, statusHeadline: 'Stable — watching weed pressure', treatmentSummary: 'We applied a fertilizer to feed the lawn.' });
    expect(out.reportV2.followUp).toMatchObject({ reason: null, customerAction: null });
    expect(out.reportV2.smsSummary).toBeNull();
  });

  test('a customer-concern card keeps the customer\'s own words and its acknowledgement', () => {
    const payload = maximal();
    payload.reportV2.insights.push({ category: 'customer_concern', whatWeSaw: 'You mentioned: “my sprinklers skip the front”.', customerAction: 'Check sprinkler coverage.' });
    const kept = enforceNewSodPayload(payload).reportV2.insights.find((c) => c.category === 'customer_concern');
    expect(kept).toMatchObject({ whatWeSaw: 'You mentioned: “my sprinklers skip the front”.', customerAction: 'Check sprinkler coverage.' });
  });

  test('no forbidden wording survives anywhere outside the record and the customer\'s own words', () => {
    const printed = JSON.stringify({ ...out, applications: null, reportV2: { ...out.reportV2, snapshot: { ...out.reportV2.snapshot, treatmentSummary: null } } });
    expect(printed).not.toMatch(/extra run|no extra|skip|hold off on watering|ease back|easing back|too much water|mower/i);
  });

  test('idempotent, and a payload with no reportV2 is left alone', () => {
    expect(enforceNewSodPayload(JSON.parse(JSON.stringify(out)))).toEqual(JSON.parse(JSON.stringify(out)));
    expect(enforceNewSodPayload({ mowingHeight: { heightIn: 3 } })).toEqual({ mowingHeight: null });
    expect(enforceNewSodPayload(null)).toBeNull();
  });
});
