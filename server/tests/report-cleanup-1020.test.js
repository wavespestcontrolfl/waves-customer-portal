// GATE_REPORT_CLEANUP_1020 (owner 2026-10-20): the service report cleanup that every future report gets.
// Synthetic data only. Gate off = today's payload, stored method and PDF key part, byte for byte.

const featureGates = require('../config/feature-gates');
const cleanup = require('../services/service-report/report-cleanup-1020');
const { buildLawnReportV2, buildAftercare } = require('../services/service-report/lawn-report-v2');
const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');
const { aftercareCustomerTask, aftercareVerdict, wateringPlanCondition } = require('../services/service-report/lawn-aftercare');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { inferServiceReportApplicationMethod } = require('../services/complete-scheduled-service');
const { completionMethod } = require('../services/lawn-completion-defaults');

const GATE = 'GATE_REPORT_CLEANUP_1020';
const saved = process.env[GATE];
const gateOn = () => { process.env[GATE] = 'true'; };
const gateOff = () => { delete process.env[GATE]; };
afterEach(() => { if (saved === undefined) gateOff(); else process.env[GATE] = saved; });

const WATER_IN_ROW = { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24, source: 'owner' };
const DERIVED_ROW = { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'default' };
const product = (name, wateringRule, extra = {}) => ({ product_name: name, approved_report_product_facts: { wateringRule, ...extra } });
// Synthetic visit: a pre-emergent fertilizer, a granular insecticide and a fungicide spray with no stored rule.
const VISIT_PRODUCTS = [product('Granular Fertilizer', WATER_IN_ROW), product('Test Granular Insecticide', DERIVED_ROW), product('Test Fungicide', null)];

describe('the gate reader', () => {
  test('strict opt-in: only the exact string true', () => {
    gateOff();
    expect(featureGates.reportCleanup1020Live()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'yes', '']) {
      process.env[GATE] = v;
      expect(featureGates.reportCleanup1020Live()).toBe(false);
    }
    gateOn();
    expect(featureGates.reportCleanup1020Live()).toBe(true);
  });

  test('the PDF cache key part exists only while live', () => {
    gateOff();
    expect(cleanup.reportCleanup1020PdfSignature()).toBe('');
    gateOn();
    expect(cleanup.reportCleanup1020PdfSignature()).toBe(':cleanup1020=1');
  });

  test('every renderer path appends the key part (route lookup, route store, queue store, queue lookup)', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const part = 'publicOriginPdfSignature() + reportCleanup1020PdfSignature()';
    expect(read('../routes/reports-public.js').split(part).length - 1).toBe(2);
    expect(read('../services/service-report/pdf-queue.js').split(part).length - 1).toBe(2);
  });
});

describe('item 1: a visit with a water-in product never says "No special watering"', () => {
  test('the rule is the deepest amount and the shortest window across the products', () => {
    gateOn();
    expect(cleanup.waterInRuleOf(VISIT_PRODUCTS)).toEqual({ inches: 0.5, hours: 24, sameDay: false });
    expect(cleanup.waterInRuleOf([product('Test Spray', null)])).toBeNull();
    expect(cleanup.waterInRuleOf([product('A', { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 48 }), product('B', { mode: 'water_in', water_in_inches: 0.75, water_in_by_hours: 24 })]))
      .toEqual({ inches: 0.75, hours: 24, sameDay: false });
    gateOff();
    expect(cleanup.waterInRuleOf(VISIT_PRODUCTS)).toBeNull();
  });

  test('a hold on any product keeps hold semantics: no water-in fallback, and no watering line at all', () => {
    gateOn();
    const HOLD = { mode: 'hold', hold_hours: 24, source: 'label' };
    for (const mix of [
      [product('Test Herbicide', HOLD), product('Granular Fertilizer', WATER_IN_ROW), product('Test Fungicide', null)],
      [product('Test Herbicide', HOLD), product('Test Fungicide', null)],
    ]) {
      expect(cleanup.waterInRuleOf(mix)).toEqual({ hold: true });
      const aftercare = buildAftercare([{ product: { name: 'x' } }], { instruction: null, waterInRule: cleanup.waterInRuleOf(mix) });
      expect(aftercare.watering).toBe('');
      expect(aftercare.neutral).toBe(false);
      expect(aftercare.watering).not.toMatch(/No special watering|Water in about/);
      expect(aftercareCustomerTask(aftercare, null)).toBeNull();
    }
    // Through the whole report, with a weekly plan on the card: the plan swap never prints the neutral line either.
    const v2 = buildLawnReportV2({
      lawnAssessment: { scores: { turfDensity: 88, weedSuppression: 92, colorHealth: 86, stressDamage: 90, fungusControl: 95, overallScore: 89 }, turfProfile: { grassType: 'st_augustine' }, waterContext: { weekPlan: { title: 'Plan', visitInPlanWeek: true } }, photos: [] },
      applications: [{ product: { name: 'x' } }],
      waterInRule: { hold: true },
    });
    expect(v2.aftercare.watering).toBe('');
    gateOff();
    expect(cleanup.waterInRuleOf([product('Test Herbicide', HOLD)])).toBeNull();
  });

  test('a recorded "Do not irrigate" note keeps its note, its review verdict and its plan warning beside a hold', () => {
    gateOn();
    const apps = [{ product: { name: 'Test Herbicide', irrigation_notes: 'Do not irrigate for 24 hours' } }];
    const plan = { title: 'Weekly plan', visitInPlanWeek: true };
    const withHold = buildAftercare(apps, { instruction: null, weekPlan: plan, waterInRule: { hold: true } });
    const before = buildAftercare(apps, { instruction: null, weekPlan: plan });
    expect(withHold).toEqual(before);
    expect(withHold.watering).toMatch(/Do not irrigate for 24 hours/);
    expect(aftercareVerdict(withHold)).toBe('review');
    expect(wateringPlanCondition(withHold, plan)).toMatch(/Confirm the product watering directions/);
    expect(aftercareCustomerTask(withHold, plan)).toMatch(/Confirm the product watering directions/);
    // Only the neutral copy is suppressed: no notes and a hold = no line; no hold = the neutral line.
    expect(buildAftercare([], { instruction: null, waterInRule: { hold: true } }).watering).toBe('');
    expect(buildAftercare([], { instruction: null, waterInRule: null }).watering).toMatch(/^No special watering/);
  });

  test('one eligibility rule: water-in beside a product with a recorded note or flag and no structured rule keeps the normal aftercare', () => {
    gateOn();
    const NOTE = 'Do not irrigate for 24 hours';
    const mixes = [
      [product('Granular Fertilizer', WATER_IN_ROW), product('Test Herbicide', null, { irrigationNotes: NOTE })],
      [product('Granular Fertilizer', WATER_IN_ROW), product('Test Herbicide', null, { irrigationRequired: false })],
      [product('Granular Fertilizer', WATER_IN_ROW), product('Test Herbicide', null, { irrigationRequired: true })],
    ];
    for (const mix of mixes) expect(cleanup.waterInRuleOf(mix)).toBeNull();
    // The normal path then keeps the recorded note and the review verdict, exactly as with the gate off.
    const apps = [{ product: { name: 'Test Herbicide', irrigation_notes: NOTE } }];
    const plan = { title: 'Weekly plan', visitInPlanWeek: true };
    const kept = buildAftercare(apps, { instruction: null, weekPlan: plan, waterInRule: cleanup.waterInRuleOf(mixes[0]) });
    expect(kept).toEqual(buildAftercare(apps, { instruction: null, weekPlan: plan }));
    expect(kept.watering).toMatch(/Do not irrigate for 24 hours/);
    expect(aftercareVerdict(kept)).toBe('review');
    // A truly unknown product (no rule, no text, or an unapproved product with no facts) still takes the water-in line.
    expect(cleanup.waterInRuleOf([product('Granular Fertilizer', WATER_IN_ROW), product('Test Fungicide', null, { irrigationNotes: '  ' })]))
      .toEqual({ inches: 0.5, hours: 24, sameDay: false });
    expect(cleanup.waterInRuleOf([product('Granular Fertilizer', WATER_IN_ROW), { product_name: 'Unapproved', approved_report_product_facts: null }]))
      .toEqual({ inches: 0.5, hours: 24, sameDay: false });
    // A structured "none" rule asserts nothing against a water-in.
    expect(cleanup.waterInRuleOf([product('Granular Fertilizer', WATER_IN_ROW), product('Test Liquid Feed', { mode: 'none', source: 'label' })]))
      .toEqual({ inches: 0.5, hours: 24, sameDay: false });
    // A structured water_in product's own note does not block it.
    expect(cleanup.waterInRuleOf([product('Granular Fertilizer', WATER_IN_ROW, { irrigationNotes: 'Water in after application' })]))
      .toEqual({ inches: 0.5, hours: 24, sameDay: false });
  });

  test('water-in beside a product with no rule (no hold) gives the water-in line', () => {
    gateOn();
    const rule = cleanup.waterInRuleOf([product('Granular Fertilizer', WATER_IN_ROW), product('Test Fungicide', null)]);
    expect(rule).toEqual({ inches: 0.5, hours: 24, sameDay: false });
    expect(buildAftercare([], { instruction: null, waterInRule: rule }).watering).toBe('Water in about ½ inch within 24 hours.');
  });

  test('the instruction makes no claim (a product with no stored rule), the legacy reading said "No special watering" (root cause)', () => {
    const instruction = buildWateringInstruction({
      rules: VISIT_PRODUCTS.map((p) => ({ name: p.product_name, rule: p.approved_report_product_facts.wateringRule })),
      completedAt: '2026-10-20T19:00:00.000Z',
    });
    expect(instruction.state).toBeNull();
    const legacy = buildAftercare([{ product: { name: 'Test Granular Insecticide' } }], { instruction });
    expect(legacy.watering).toMatch(/^No special watering is needed/);
    expect(legacy.neutral).toBe(true);
  });

  test('with the visit rule, the aftercare is the one line and is also the customer task', () => {
    const rule = { inches: 0.5, hours: 24, sameDay: false };
    const aftercare = buildAftercare([{ product: { name: 'Test Granular Insecticide' } }], { instruction: null, waterInRule: rule });
    expect(aftercare.watering).toBe('Water in about ½ inch within 24 hours.');
    expect(aftercare.neutral).toBe(false);
    expect(aftercare.waterInRequired).toBe(true);
    expect(aftercare.creditableWaterIn).toBe(false);
    expect(aftercareVerdict(aftercare)).toBe('none');
    expect(aftercareCustomerTask(aftercare, null)).toBe('Water in about ½ inch within 24 hours.');
  });

  test('wording: a quarter inch, a longer window, a same-day label', () => {
    expect(cleanup.waterInAftercare({ inches: 0.25, hours: 24, sameDay: false }, null).watering).toBe('Water in about ¼ inch within 24 hours.');
    expect(cleanup.waterInAftercare({ inches: 0.5, hours: 336, sameDay: false }, null).watering).toBe('Water in about ½ inch within 14 days.');
    expect(cleanup.waterInAftercare({ inches: 0.5, hours: 60, sameDay: false }, null).watering).toBe('Water in about ½ inch within 60 hours.');
    expect(cleanup.waterInAftercare({ inches: 0.25, hours: 24, sameDay: true }, null).watering).toBe('Water in about ¼ inch today.');
    expect(cleanup.waterInAftercare(null, null)).toBeNull();
  });

  test('a full instruction (every rule known) still wins; a visit with no water-in rule keeps the neutral line', () => {
    const known = buildWateringInstruction({
      rules: [{ name: 'Granular Fertilizer', rule: WATER_IN_ROW }],
      completedAt: '2026-10-20T19:00:00.000Z',
    });
    const withInstruction = buildAftercare([], { instruction: known, waterInRule: { inches: 0.5, hours: 24, sameDay: false } });
    expect(withInstruction.watering).toMatch(/^Water in today’s treatment by /);
    const neutral = buildAftercare([], { instruction: null, waterInRule: null });
    expect(neutral.watering).toMatch(/^No special watering is needed/);
  });

  test('through buildLawnReportV2: the report aftercare carries the line only when the rule is passed (gate off passes none)', () => {
    const args = { lawnAssessment: { scores: { turfDensity: 88, weedSuppression: 92, colorHealth: 86, stressDamage: 90, fungusControl: 95, overallScore: 89 }, turfProfile: { grassType: 'st_augustine' }, waterContext: {}, photos: [] }, applications: [{ product: { name: 'Test Granular Insecticide' } }] };
    expect(buildLawnReportV2(args).aftercare.watering).toMatch(/^No special watering/);
    gateOn();
    const v2 = buildLawnReportV2({ ...args, waterInRule: cleanup.waterInRuleOf(VISIT_PRODUCTS) });
    expect(v2.aftercare.watering).toBe('Water in about ½ inch within 24 hours.');
    expect(v2.aftercare.watering).not.toMatch(/No special watering/);
  });
});

describe('item 2: a granular product never keeps a broadcast spray method', () => {
  const ARENA = { name: 'Test Insecticide 0.25G Systemic Granular Insecticide', formulation: null };

  test('classifier: granular by formulation or name; water-dispersible granules are sprayed', () => {
    expect(cleanup.isGranularProduct(ARENA)).toBe(true);
    // Name only (a historical report row carries no formulation): a standalone G word is granular.
    expect(cleanup.isGranularProduct({ name: 'Headway G' })).toBe(true);
    expect(cleanup.isGranularProduct({ name: 'Test G Insecticide' })).toBe(true);
    expect(cleanup.isGranularProduct({ name: 'Test Spray 16.6 g' })).toBe(false);
    expect(cleanup.isGranularProduct({ name: 'Test Product', formulation: 'Granule (G)' })).toBe(true);
    expect(cleanup.isGranularProduct({ name: 'Test Product', formulation: 'Granular pre-emergent on fertilizer' })).toBe(true);
    expect(cleanup.isGranularProduct({ name: 'Test 50 WDG Insecticide', formulation: 'Water-dispersible granule (WDG)' })).toBe(false);
    expect(cleanup.isGranularProduct({ name: 'Test 50 WDG Insecticide', formulation: null })).toBe(false);
    expect(cleanup.isGranularProduct({ name: 'Test Fungicide', formulation: 'SC' })).toBe(false);
    expect(cleanup.isGranularProduct({ name: 'Test Fungicide' })).toBe(false);
    expect(cleanup.isGranularProduct(null)).toBe(false);
  });

  test('only a broadcast spray is corrected, and only while live', () => {
    gateOn();
    expect(cleanup.correctedMethod('broadcast_spray', ARENA)).toBe('granular_broadcast');
    expect(cleanup.correctedMethod('broadcast_spray', { name: 'Test Fungicide' })).toBe('broadcast_spray');
    // A granular catalog formulation counts when the name carries no mark (a report row passes catalog_formulation).
    expect(cleanup.correctedMethod('broadcast_spray', { name: 'Test Fire Ant Bait', formulation: 'granular' })).toBe('granular_broadcast');
    expect(cleanup.correctedMethod('bait_placement', ARENA)).toBe('bait_placement');
    expect(cleanup.correctedMethod('spot_treatment', ARENA)).toBe('spot_treatment');
    expect(cleanup.correctedMethod('perimeter_spray', ARENA)).toBe('perimeter_spray');
    gateOff();
    expect(cleanup.correctedMethod('broadcast_spray', ARENA)).toBe('broadcast_spray');
  });

  test('the completion stores the corrected method whatever the sheet sent (root cause: the sheet default is a spray for a non-fertilizer lawn product)', () => {
    const catalog = { name: ARENA.name, category: 'insecticide', formulation: 'Granular', application_method: null };
    gateOff();
    expect(inferServiceReportApplicationMethod(catalog, { applicationMethod: 'broadcast_spray' }, 'lawn')).toBe('broadcast_spray');
    gateOn();
    expect(inferServiceReportApplicationMethod(catalog, { applicationMethod: 'broadcast_spray' }, 'lawn')).toBe('granular_broadcast');
    // A catalog row stored with the wrong method is corrected the same way.
    expect(inferServiceReportApplicationMethod({ ...catalog, application_method: 'broadcast_spray' }, {}, 'lawn')).toBe('granular_broadcast');
    // A spray product keeps its spray method.
    expect(inferServiceReportApplicationMethod({ name: 'Test Fungicide', category: 'fungicide', formulation: 'SC' }, { applicationMethod: 'broadcast_spray' }, 'lawn')).toBe('broadcast_spray');
  });

  test('the plan default (lawn completion defaults) uses the same correction', () => {
    const item = (applicationMethod, name = ARENA.name) => ({ product: { name, formulation: 'Granular', applicationMethod }, scope: '' });
    gateOff();
    expect(completionMethod(item('broadcast_spray'), null)).toBe('broadcast_spray');
    gateOn();
    expect(completionMethod(item('broadcast_spray'), null)).toBe('granular_broadcast');
    expect(completionMethod({ product: { name: 'Test Fungicide', formulation: 'SC', applicationMethod: 'broadcast_spray' }, scope: '' }, null)).toBe('broadcast_spray');
    // A spot row stays a spot row.
    expect(completionMethod(item('broadcast_spray'), { applicationMode: 'spot' })).toBe('spot_treatment');
  });
});

describe('item 3: the follow-up reason is a whole customer sentence', () => {
  const withReason = (reason) => ({ reportV2: { followUp: { scheduled: true, headline: 'Follow-up already planned', reason } } });

  test('the cut-off, percent-of-area technician note becomes the fixed sentence (root cause: the free-text next-visit focus, cut at 170 characters)', () => {
    const note = 'Recheck the 75% stress/damage area, confirm continued response to today’s fungicide and insecticide application, and inspect for any localized drought, mechanical, or…';
    gateOn();
    expect(cleanup.cleanFollowUp(withReason(note)).reportV2.followUp.reason).toBe(cleanup.FOLLOW_UP_FALLBACK);
    gateOff();
    expect(cleanup.cleanFollowUp(withReason(note)).reportV2.followUp.reason).toBe(note);
  });

  test('a score as a percent, a fraction of 100, a bare bracketed score, no full stop, or an empty reason are replaced; a clean sentence stays', () => {
    gateOn();
    for (const bad of ['Recheck the stress (75) next visit.', 'Stress reads 75/100 so we will recheck it.', 'Recheck the area covering 20% of the lawn.', 'Recheck the thin area', 'We will look at it...', '']) {
      expect(cleanup.cleanFollowUp(withReason(bad)).reportV2.followUp.reason).toBe(cleanup.FOLLOW_UP_FALLBACK);
    }
    const good = 'Recheck the thin area near the fence and confirm how the turf is responding.';
    expect(cleanup.cleanFollowUp(withReason(good)).reportV2.followUp.reason).toBe(good);
  });

  test('no follow-up card, no change', () => {
    gateOn();
    const data = { reportV2: { followUp: null } };
    expect(cleanup.cleanFollowUp(data)).toBe(data);
    expect(cleanup.cleanFollowUp({ reportV2: null }).reportV2).toBeNull();
  });
});

describe('items 7, 8, 9: the repeated stock lines', () => {
  const lawnData = () => ({
    serviceLine: 'lawn',
    reportV2: { insights: [{ category: 'overall', status: 'healthy', headline: 'Your lawn is in good shape', whatWeSaw: 'Coverage, color, and weed control all look healthy today.', nextVisitPlan: 'Keep the program steady and keep tracking each visit.' }, { category: 'weeds', status: 'watch', headline: 'Weeds' }] },
    findings: [{ category: 'no_activity', title: cleanup.NO_CORRECTIVE_TITLE, detail: cleanup.NO_CORRECTIVE_DETAIL }, { category: 'no_activity', title: 'No lawn issues observed', detail: 'Nothing to report.' }],
  });

  test('lawn: the all-clear card and the "No corrective findings" finding are left out; other cards and findings stay', () => {
    gateOn();
    const data = cleanup.dropStockLines(lawnData());
    expect(data.reportV2.insights.map((c) => c.category)).toEqual(['weeds']);
    expect(data.findings.map((f) => f.title)).toEqual(['No lawn issues observed']);
  });

  test('tree & shrub: the card stays, the "keep monitoring" plan line goes', () => {
    gateOn();
    const data = cleanup.dropStockLines({ serviceLine: 'tree_shrub', reportV2: { insights: [{ category: 'overall', status: 'good', headline: 'Your landscape plants are in good shape', nextVisitPlan: 'Keep the program steady and keep monitoring each visit.' }] }, findings: [] });
    expect(data.reportV2.insights).toHaveLength(1);
    expect(data.reportV2.insights[0].nextVisitPlan).toBeNull();
    expect(data.reportV2.insights[0].headline).toBe('Your landscape plants are in good shape');
  });

  test('gate off: nothing changes', () => {
    gateOff();
    const before = JSON.stringify(lawnData());
    expect(JSON.stringify(cleanup.dropStockLines(lawnData()))).toBe(before);
  });

  test('the report-data softened-finding strings are the ones this module drops', () => {
    const fs = require('fs');
    const source = fs.readFileSync(require.resolve('../services/service-report/report-data.js'), 'utf8');
    expect(source).toMatch(/finding\.title = reportCleanup1020\.NO_CORRECTIVE_TITLE/);
    expect(source).toMatch(/finding\.detail = reportCleanup1020\.NO_CORRECTIVE_DETAIL/);
  });
});

describe('item 4: the trouble-spot note', () => {
  const troubleVisit = (extra = {}) => ({
    serviceLine: 'lawn',
    reportV2: { photoSet: [{ url: 'https://example/a.jpg', shot: 'front', label: 'Front yard' }, { url: 'https://example/b.jpg', shot: 'trouble', label: 'Trouble spot' }], insights: [], followUp: null, ...extra },
    findings: [],
  });

  test('gate off: no flag and no note on the payload', () => {
    gateOff();
    const data = cleanup.attachCleanupFields(troubleVisit());
    expect(data).not.toHaveProperty('reportCleanup');
    expect(data).not.toHaveProperty('troubleSpotNote');
  });

  test('gate on: the flag, and one fixed sentence naming a next step', () => {
    gateOn();
    expect(cleanup.attachCleanupFields(troubleVisit())).toMatchObject({
      reportCleanup: true,
      troubleSpotNote: 'The trouble spot photo shows an area your technician flagged. We will check it again at your next visit.',
    });
    expect(cleanup.attachCleanupFields(troubleVisit({ followUp: { scheduled: true } })).troubleSpotNote)
      .toBe('The trouble spot photo shows an area your technician flagged. We will check it again at the follow-up we already planned.');
  });

  test('the note never names the spot from a visit-wide finding (nothing ties it to the photo)', () => {
    gateOn();
    const note = (category) => cleanup.attachCleanupFields(troubleVisit({ insights: [{ category, status: 'watch' }] })).troubleSpotNote;
    for (const category of ['weeds', 'damage', 'coverage', 'mowing']) {
      expect(note(category)).toBe('The trouble spot photo shows an area your technician flagged. We will check it again at your next visit.');
    }
  });

  test('a failed watering-rule or catalog read gives no water-in fallback', () => {
    gateOn();
    const waterIn = { approved_report_product_facts: { wateringRule: { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24 } } };
    const unknown = { approved_report_product_facts: {} };
    expect(cleanup.waterInRuleOf([waterIn, unknown])).toMatchObject({ inches: 0.5, hours: 24 });
    for (const marker of ['wateringRuleLookupFailed', 'catalogEnrichmentFailed']) {
      const products = [waterIn, unknown];
      products[marker] = true;
      expect(cleanup.waterInRuleOf(products)).toBeNull();
    }
  });

  test('the photo strip (no shot list) is read for a Trouble spot label too', () => {
    gateOn();
    const data = cleanup.attachCleanupFields({ serviceLine: 'lawn', reportV2: { photos: [{ url: 'https://example/a.jpg', label: 'Front yard' }, { url: 'https://example/b.jpg', label: 'Trouble spot' }], followUp: null }, findings: [] });
    expect(data.troubleSpotNote).toBe('The trouble spot photo shows an area your technician flagged. We will check it again at your next visit.');
  });

  test('no trouble-spot photo: the flag is set and the note is null', () => {
    gateOn();
    const data = cleanup.attachCleanupFields({ serviceLine: 'lawn', reportV2: { photoSet: [{ url: 'https://example/a.jpg', shot: 'front' }] }, findings: [] });
    expect(data.reportCleanup).toBe(true);
    expect(data.troubleSpotNote).toBeNull();
    expect(cleanup.attachCleanupFields({ serviceLine: 'pest' }).troubleSpotNote).toBeNull();
  });
});

describe('the reconciliation entry point (route and PDF queue) runs the cleanup', () => {
  const payload = () => ({
    serviceLine: 'lawn',
    summary: 'Today we applied a feeding.',
    lawnAssessment: { recommendations: { nextVisitFocus: 'Recheck the 75% stress/damage area, confirm continued response to today’s fungicide and insecticide application, and inspect for any localized drought, mechanical, or other conditions in the area.' } },
    reportV2: {
      snapshot: {}, aftercare: { watering: 'x' }, water: {},
      photoSet: [{ url: 'https://example/b.jpg', shot: 'trouble', label: 'Trouble spot' }],
      insights: [{ category: 'overall', status: 'healthy', headline: 'Your lawn is in good shape', nextVisitPlan: 'Keep the program steady and keep tracking each visit.' }],
    },
    findings: [{ category: 'no_activity', title: cleanup.NO_CORRECTIVE_TITLE, detail: cleanup.NO_CORRECTIVE_DETAIL }],
  });

  test('gate on: a clean follow-up, no stock lines, the flag and the note', () => {
    gateOn();
    const data = applyLawnReportReconciliation(payload(), { reentry: null });
    expect(data.reportCleanup).toBe(true);
    expect(data.reportV2.followUp.reason).toBe(cleanup.FOLLOW_UP_FALLBACK);
    expect(data.reportV2.insights).toEqual([]);
    expect(data.findings).toEqual([]);
    expect(data.troubleSpotNote).toBe('The trouble spot photo shows an area your technician flagged. We will check it again at the follow-up we already planned.');
    expect(JSON.stringify(data.reportV2.lead || {})).not.toMatch(/…|75%/);
  });

  test('gate off: the payload is the one it was', () => {
    gateOff();
    const data = applyLawnReportReconciliation(payload(), { reentry: null });
    expect(data).not.toHaveProperty('reportCleanup');
    expect(data).not.toHaveProperty('troubleSpotNote');
    expect(data.reportV2.followUp.reason).toMatch(/75%/);
    expect(data.reportV2.insights).toHaveLength(1);
    expect(data.findings).toHaveLength(1);
  });
});
