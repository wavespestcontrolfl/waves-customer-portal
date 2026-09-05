import { describe, expect, it } from 'vitest';
import { lawnPlanSelections, previousLawnAssessment, LAWN_FIELD_ACTIONS } from './lawn-completion';

it('uses the engine mix instead of catalog defaults and skips unselected optional rows', () => {
  const build = (product) => ({ productId: product.id, rate: 99, areaValue: 5000, totalAmount: 999 });
  const rows = lawnPlanSelections([
    { product: { id: 'potassium' }, mix: { ratePer1000: 3, rateUnit: 'fl_oz', amount: 15, amountUnit: 'fl_oz', treatedSqft: 5000 } },
    { product: { id: 'potassium' }, mix: {} },
    { product: { id: 'optional' }, selected: false },
  ], build);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ productId: 'potassium', rate: 3, totalAmount: 15, areaValue: 5000, areaUnit: 'sqft', applicationArea: 'Front yard, Back yard, Side yards' });
});

it('does not manufacture a quantity when the plan cannot derive one', () => {
  expect(lawnPlanSelections([{ product: { id: 'unknown' }, mix: {} }], () => ({ rate: 99, totalAmount: 999 }))[0]).toMatchObject({ rate: '', totalAmount: '' });
});

it('field inspection actions cannot imply a pesticide application', () => {
  expect(LAWN_FIELD_ACTIONS.every((action) => action.treatmentApplied === false && !action.product)).toBe(true);
});

describe('previous visit scorecard', () => {
  const history = [
    { id: 'future', service_date: '2026-10-01', confirmed_by_tech: true },
    { id: 'draft', service_date: '2026-08-30', confirmed_by_tech: false },
    { id: 'current', service_date: '2026-09-05', confirmed_by_tech: true },
    { id: 'previous', service_date: '2026-08-01', confirmed_by_tech: true, overall_score: 83 },
    { id: 'baseline', service_date: '2026-07-01', confirmed_by_tech: true, overall_score: 60 },
  ];
  it('selects the latest earlier confirmed visit regardless of response ordering', () => {
    expect(previousLawnAssessment(history, { date: '2026-09-05' }).id).toBe('previous');
  });
  it('uses the visit date when completing a backdated visit', () => {
    expect(previousLawnAssessment(history, { scheduledDate: '2026-07-20' }).id).toBe('baseline');
  });
  it('keeps missing history or an unknown visit date explicitly unavailable', () => {
    expect(previousLawnAssessment([], { date: '2026-09-05' })).toBeNull();
    expect(previousLawnAssessment(history, {})).toBeNull();
  });
});
