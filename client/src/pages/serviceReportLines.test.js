import { describe, expect, it } from 'vitest';
import {
  NOTHING_NEEDED, buildRecommendations, buildRecordFindings, buildReentryBullets, doThisLine, hasActualTreatmentFor, holdOffLine, sanitizeReentryCopy, termiteContext,
} from './serviceReportLines';

// The lines the document prints under "What we recommend" and "Re-entry & precautions", and the two the web top card
// picks from them. One copy of the logic: the document and the card read these same functions.

const RAIN = 'Rain since your visit has watered today’s treatment in. No extra sprinkler run is needed for it.';
const HOLD = 'Skip your turf watering until Sat 9 AM.';

const lawn = (over = {}) => ({
  serviceLine: 'lawn',
  applicationMade: true,
  reportV2: {
    snapshot: { overallScore: 72 },
    aftercare: { watering: 'Water in about ½ inch within 24 hours.' },
    banner: { state: 'water_in', lines: ['Water in about ½ inch within 24 hours.'] },
  },
  dynamicContext: { reentry: { customerSummary: 'Ready to walk on once the application has dried — your technician confirms timing.', targets: [] } },
  ...over,
});

describe('doThisLine: the first customer-owned recommendation', () => {
  it('lawn: the aftercare watering line the document prints first', () => {
    expect(buildRecommendations(lawn())[0]).toBe('Water in about ½ inch within 24 hours.');
    expect(doThisLine(lawn())).toBe('Water in about ½ inch within 24 hours.');
  });

  it('skips a Waves-owned follow-up ("We will", "We’ll", "Waves will") and takes the next customer task', () => {
    const data = { serviceLine: 'pest', typedReport: { todaysResult: { nextStep: 'We will re-check the stations next month.' } }, recommendations: ['We’ll be back in 30 days.', 'Waves will treat the eaves.', 'Keep the garage door closed at night.'] };
    expect(buildRecommendations(data)).toHaveLength(4);
    expect(doThisLine(data)).toBe('Keep the garage door closed at night.');
  });

  it('only Waves-owned lines, no lines, or a "no action" line: Nothing needed from you today.', () => {
    expect(doThisLine({ serviceLine: 'pest', typedReport: { todaysResult: { nextStep: 'We will re-check the stations.' } } })).toBe(NOTHING_NEEDED);
    expect(doThisLine({ serviceLine: 'pest' })).toBe(NOTHING_NEEDED);
    expect(doThisLine({ serviceLine: 'pest', typedReport: { todaysResult: { nextStep: 'No action needed.' } } })).toBe(NOTHING_NEEDED);
    // a "no action" line gives way to a real customer task after it
    expect(doThisLine({ serviceLine: 'pest', typedReport: { todaysResult: { nextStep: 'No further action needed.' } }, recommendations: ['Trim the shrubs.'] })).toBe('Trim the shrubs.');
  });

  it('rain that watered the treatment in: the kept sprinkler hold is the task, never the rain sentences', () => {
    const rained = lawn();
    rained.reportV2.banner = { state: 'water_in_by_rain', lines: [HOLD, ...RAIN.split(/(?<=\.)\s/)] };
    rained.reportV2.aftercare = { watering: `${HOLD} ${RAIN}`, holdTask: HOLD };
    expect(buildRecommendations(rained)[0]).toBe(`${HOLD} ${RAIN}`);
    expect(doThisLine(rained)).toBe(HOLD);
  });

  it('rain that watered the treatment in, no hold kept: the report’s other task, else nothing needed', () => {
    const rained = lawn();
    rained.reportV2.banner = { state: 'water_in_by_rain', lines: RAIN.split(/(?<=\.)\s/) };
    rained.reportV2.aftercare = { watering: RAIN };
    expect(doThisLine(rained)).toBe(NOTHING_NEEDED);
    rained.reportV2.mowing = { recommendation: 'Mow at 3.5 inches this week.' };
    expect(doThisLine(rained)).toBe('Mow at 3.5 inches this week.');
  });

  it('a primary termite dashboard’s step and primary move count; a suppressed re-service shows neither', () => {
    const move = { title: 'Recheck the bait stations.', dueLabel: 'next month' };
    const termiteReportV2 = { source: 'primary', primaryMove: move };
    expect(doThisLine({ serviceLine: 'termite', termiteReportV2 })).toBe('Recheck the bait stations. (next month)');
    // an escalated dashboard step beats a frozen "No action needed"
    expect(doThisLine({ serviceLine: 'termite', typedReport: { todaysResult: { nextStep: 'No action needed.' } }, termiteReportV2: { source: 'primary', nextStep: 'Keep the stations clear of mulch.' } })).toBe('Keep the stations clear of mulch.');
    expect(doThisLine({ serviceLine: 'termite', termiteReportV2, reserviceReport: { outcome: 'customer_declined' } })).toBe(NOTHING_NEEDED);
  });

  it('pest and mosquito primary moves and the tree & shrub customer action are read where the document reads them', () => {
    expect(doThisLine({ serviceLine: 'pest', pestReportV2: { primaryMove: { title: 'Clear the gutters.', why: 'Standing water breeds mosquitoes.' } } })).toBe('Clear the gutters. Standing water breeds mosquitoes.');
    expect(doThisLine({ serviceLine: 'mosquito', mosquitoReportV2: { primaryMove: { title: 'Empty the bird bath.' } } })).toBe('Empty the bird bath.');
    expect(doThisLine({ serviceLine: 'tree_shrub', reportV2: { snapshot: { customerAction: 'Water the new shrubs twice a week.' } } })).toBe('Water the new shrubs twice a week.');
  });
});

describe('doThisLine: only customer-owned sources', () => {
  it('snapshot.wavesNext (what Waves will do) is never "Do this", though the document lists it under What we recommend', () => {
    const data = { serviceLine: 'tree_shrub', reportV2: { snapshot: { wavesNext: 'Recheck the affected foliage next visit.' } } };
    expect(buildRecommendations(data)).toEqual(['Recheck the affected foliage next visit.']);
    expect(doThisLine(data)).toBe(NOTHING_NEEDED);
  });

  it('an insight\u2019s nextVisitPlan is Waves-owned too; the customerAction beside it is the task', () => {
    const data = {
      serviceLine: 'tree_shrub',
      reportV2: { insights: [{ nextVisitPlan: 'Recheck the affected foliage next visit.', customerAction: 'Water the new shrubs twice a week.' }] },
    };
    expect(buildRecommendations(data)).toContain('Recheck the affected foliage next visit.');
    expect(doThisLine(data)).toBe('Water the new shrubs twice a week.');
  });

  it('the customer-owned sources win in the document\u2019s order even when a Waves line is listed first', () => {
    const data = {
      serviceLine: 'tree_shrub',
      reportV2: { snapshot: { customerAction: 'Mulch the beds.', wavesNext: 'Recheck the affected foliage next visit.' }, mowing: { recommendation: 'Mow at 3.5 inches.' } },
    };
    expect(doThisLine(data)).toBe('Mulch the beds.');
  });
});

describe('doThisLine: a finding\u2019s own recommendation is a customer task the document asks for', () => {
  const finding = (over = {}) => ({ id: 'f1', title: 'Shrubs against the wall', detail: 'Branches touch the siding.', recommendation: 'Trim shrubs away from the house.', ...over });

  it('finding-only: the recommendation prints under "What we found", not in "What we recommend", and still is the task', () => {
    const data = { serviceLine: 'pest', findings: [finding()] };
    expect(buildRecommendations(data)).toEqual([]);
    expect(buildRecordFindings(data)).toHaveLength(1);
    expect(doThisLine(data)).toBe('Trim shrubs away from the house.');
  });

  it('the "What we recommend" list comes first; a Waves-owned or "no action" finding recommendation is skipped', () => {
    expect(doThisLine({ serviceLine: 'pest', recommendations: ['Keep the garage door closed.'], findings: [finding()] })).toBe('Keep the garage door closed.');
    expect(doThisLine({ serviceLine: 'pest', findings: [finding({ recommendation: 'We will treat the nest next visit.' }), finding({ id: 'f2', title: 'Gutters', recommendation: 'Clear the gutters.' })] })).toBe('Clear the gutters.');
    expect(doThisLine({ serviceLine: 'pest', findings: [finding({ recommendation: 'No action needed.' })] })).toBe(NOTHING_NEEDED);
  });

  it('only findings the document prints count: a bare title (raw-note provenance) and a dropped clean-visit row do not', () => {
    expect(doThisLine({ serviceLine: 'pest', findings: [{ id: 'f3', title: 'Gate code 1234' }] })).toBe(NOTHING_NEEDED);
    const lawnVisit = { serviceLine: 'lawn', findings: [finding({ id: 'n', category: 'no_activity', recommendation: 'Nothing to do here.' }), finding({ id: 'w', title: 'Weeds', recommendation: 'Mow high this week.' })] };
    expect(buildRecordFindings(lawnVisit).map((f) => f.id)).toEqual(['w']);
    expect(doThisLine(lawnVisit)).toBe('Mow high this week.');
  });

  it('nothing in the list and no finding task: Nothing needed', () => {
    expect(doThisLine({ serviceLine: 'pest', findings: [finding({ recommendation: '' })] })).toBe(NOTHING_NEEDED);
  });
});

describe('holdOffLine: the first bullet of the document’s re-entry section', () => {
  it('is the document’s first bullet, and the document prints the same list', () => {
    const data = lawn();
    expect(buildReentryBullets(data)).toEqual(['Ready to walk on once the application has dried — your technician confirms timing.']);
    expect(holdOffLine(data)).toBe(buildReentryBullets(data)[0]);
  });

  it('bait-only visit (nothing applied, default pet advisory on file, no re-entry context): no section, no hold', () => {
    const bait = { serviceLine: 'pest', applicationMade: false, advisory: { pet_advisory: 'Keep pets off treated zones until dry.' } };
    expect(buildReentryBullets(bait)).toBeNull();
    expect(holdOffLine(bait)).toBeNull();
    // the same default advisory on a visit that treated shows
    expect(holdOffLine({ ...bait, applicationMade: true })).toBe('Keep pets off treated zones until dry.');
  });

  it('a fixed re-entry figure never prints: it reads as the approved once-dry idiom', () => {
    const data = { serviceLine: 'pest', applicationMade: true, dynamicContext: { reentry: { customerSummary: 'Ready at 7:03 PM.', targets: [] } } };
    expect(holdOffLine(data)).not.toMatch(/7:03/);
    expect(holdOffLine(data)).toMatch(/technician confirms timing/);
    expect(sanitizeReentryCopy('Keep pets off for 2 hours.')).toMatch(/technician confirms timing/);
  });

  it('bullets in the document’s order: summary, targets, pet advisory, irrigation timer (not on a lawn V2 report), aftercare line', () => {
    const reentry = {
      customerSummary: 'Ready once dry.', targets: [{ label: 'Exterior' }], petAdvisory: 'Keep pets off until dry.', irrigationReadyAt: '2026-10-20T20:00:00Z',
    };
    const pest = buildReentryBullets({ serviceLine: 'pest', applicationMade: true, dynamicContext: { reentry } });
    expect(pest.slice(0, 3)).toEqual(['Ready once dry.', 'Exterior: ready once dry — your technician confirms timing', 'Keep pets off until dry.']);
    expect(pest[3]).toMatch(/^Hold irrigation until .* on \w+day\.$/);
    const lawnV2 = buildReentryBullets({ serviceLine: 'lawn', applicationMade: true, reportV2: { aftercare: { reentry: 'Stay off the lawn until dry.' } }, dynamicContext: { reentry } });
    expect(lawnV2.some((line) => /Hold irrigation/.test(line))).toBe(false);
    expect(lawnV2[lawnV2.length - 1]).toBe('Stay off the lawn until dry.');
  });
});

describe('the shared predicates', () => {
  it('applicationMade null (unknown evidence) counts as applied; undefined needs a product row', () => {
    expect(hasActualTreatmentFor({ applicationMade: null })).toBe(true);
    expect(hasActualTreatmentFor({ applicationMade: false })).toBe(false);
    expect(hasActualTreatmentFor({ treatmentPerformed: true, applicationMade: false })).toBe(true);
    expect(hasActualTreatmentFor({})).toBe(false);
  });

  it('termiteContext: primary and companion dashboards, suppressed by a re-service that applied nothing', () => {
    expect(termiteContext({ termiteReportV2: { source: 'primary' } })).toMatchObject({ primary: true, companion: false, suppress: false });
    expect(termiteContext({ termiteReportV2: { source: 'companion' } })).toMatchObject({ primary: false, companion: true });
    expect(termiteContext({ termiteReportV2: { source: 'primary' }, reserviceReport: { outcome: 'inspection_only' } })).toMatchObject({ primary: false, companion: false, suppress: true, dashboard: null });
  });
});
