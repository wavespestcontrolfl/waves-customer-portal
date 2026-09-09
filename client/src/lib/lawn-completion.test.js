import { describe, expect, it } from 'vitest';
import { lawnPlanActionOptions, lawnPlanSelections, previousLawnAssessment, reconcileLawnPlanSelections, withdrawLawnPlanSuggestions, LAWN_FIELD_ACTIONS, LAWN_PLAN_UNAVAILABLE_REASON } from './lawn-completion';

it('uses the engine mix instead of catalog defaults and skips unselected optional rows', () => {
  const build = (product) => ({ productId: product.id, rate: 99, areaValue: 5000, totalAmount: 999 });
  const rows = lawnPlanSelections([
    { product: { id: 'potassium' }, mix: { ratePer1000: 3, rateUnit: 'fl_oz', amount: 15, amountUnit: 'fl_oz', treatedSqft: 5000 } },
    { product: { id: 'potassium' }, mix: {} },
    { product: { id: 'optional' }, selected: false },
  ], build, [{ id: 'potassium' }, { id: 'optional' }]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ productId: 'potassium', rate: 3, totalAmount: 15, areaValue: 5000, areaUnit: 'sqft', applicationArea: 'Front yard, Back yard, Side yards' });
});

it('does not manufacture a quantity when the plan cannot derive one', () => {
  expect(lawnPlanSelections([{ product: { id: 'unknown' }, mix: {} }], () => ({ rate: 99, totalAmount: 999 }), [{ id: 'unknown' }])[0]).toMatchObject({ rate: '', totalAmount: '' });
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

it('orders linked visits by appointment date and excludes the current service', () => {
  const rows = [
    { id: 'current', service_id: 'current', appointment_date: '2026-08-01', service_date: '2026-08-01', confirmed_by_tech: true },
    { id: 'backfilled', service_id: 'previous', appointment_date: '2026-08-15', service_date: '2026-10-01', confirmed_by_tech: true },
    { id: 'future', service_id: 'future', appointment_date: '2026-10-01', service_date: '2026-08-20', confirmed_by_tech: true },
    { id: 'missing-appointment', service_id: 'missing', service_date: '2026-08-31', confirmed_by_tech: true },
  ];
  expect(previousLawnAssessment(rows, { id: 'current', scheduledDate: '2026-09-05' }).id).toBe('backfilled');
  expect(previousLawnAssessment([rows[0]], { id: 'current', scheduledDate: '2026-09-05' })).toBeNull();
});

it('uses catalog application metadata and ignores unavailable catalog products', () => {
  const build = (product) => ({ method: product.application_method, ceiling: product.max_rate });
  const items = [{ product: { id: 'known' }, mix: { ratePer1000: 3 } }, { product: { id: 'missing' } }];
  expect(lawnPlanSelections(items, build, [{ id: 'known', application_method: 'granular_broadcast', max_rate: 4 }]))
    .toEqual([expect.objectContaining({ method: 'granular_broadcast', ceiling: 4, rate: 3 })]);
});


it('selects the newest confirmed retake when appointment dates tie', () => {
  const original = { id: 'original', service_id: 'prior', appointment_date: '2026-08-01', confirmed_by_tech: true, created_at: '2026-08-01T14:00:00Z' };
  const retake = { ...original, id: 'retake', created_at: '2026-08-01T14:10:00Z' };
  for (const rows of [[original, retake], [retake, original]]) {
    expect(previousLawnAssessment(rows, { id: 'today', date: '2026-09-05' }).id).toBe('retake');
  }
});

it('refresh cannot relabel a recalculated quantity with a manually chosen amount unit: the derived number is withdrawn, not kept under the new unit', () => {
  const row = { productId: 'product', amountUnit: 'gal', totalAmount: 2, lawnPlanDefaults: {}, lawnPlanManualFields: ['amountUnit'] };
  const fresh = { ...row, amountUnit: 'fl_oz', totalAmount: 12 };
  // The 2 was derived in the plan's unit (r8): under the tech's gallons it is
  // withdrawn; the plan's 12 fl oz is never relabeled as 12 gal either.
  expect(reconcileLawnPlanSelections([row], [fresh])[0]).toMatchObject({ amountUnit: 'gal', totalAmount: '' });
});

it('a new restriction clears derived quantity and rate even after a product-area override', () => {
  const row = { productId: 'product', rate: 3, areaValue: 1000, totalAmount: 3, lawnPlanDefaults: {}, lawnPlanManualFields: ['areaValue'] };
  const fresh = { ...row, rate: '', totalAmount: '', areaValue: 5000 };
  expect(reconcileLawnPlanSelections([row], [fresh])[0]).toMatchObject({ rate: '', areaValue: 1000, totalAmount: '' });
  expect(reconcileLawnPlanSelections([{ ...row, totalAmountManual: true }], [fresh])[0].totalAmount).toBe(3);
});

it('a withdrawn default clears suggested fields while retaining a measured area with its unit', () => {
  const row = { productId: 'product', rate: 3, rateUnit: 'fl_oz', totalAmount: 3, amountUnit: 'fl_oz', areaValue: 1000, areaUnit: 'sqft', applicationMethod: 'broadcast_spray', lawnPlanDefaults: {}, lawnPlanManualFields: ['areaValue'] };
  expect(reconcileLawnPlanSelections([row], [])[0]).toMatchObject({
    rate: '', rateUnit: '', totalAmount: '', amountUnit: '', applicationMethod: '', areaValue: 1000, areaUnit: 'sqft',
  });
  expect(reconcileLawnPlanSelections([{ ...row, lawnPlanManualFields: ['applicationMethod'] }], [])[0])
    .toMatchObject({ rate: '', rateUnit: '', totalAmount: '', areaValue: '', areaUnit: '', applicationMethod: 'broadcast_spray' });
});

it('a withdrawn default preserves hand-entered amounts and rates in their recorded units', () => {
  const row = { productId: 'product', rate: 2, rateUnit: 'lb', totalAmount: 7, amountUnit: 'lb', areaValue: 1000, areaUnit: 'sqft', applicationMethod: 'granular_broadcast', totalAmountManual: true, lawnPlanDefaults: {}, lawnPlanManualFields: ['rate', 'totalAmount'] };
  expect(reconcileLawnPlanSelections([row], [])[0]).toMatchObject({
    rate: 2, rateUnit: 'lb', totalAmount: 7, amountUnit: 'lb', areaValue: '', areaUnit: '', applicationMethod: '',
  });
});


it('refresh preserves an entered amount in its original unit while updating untouched area', () => {
  const row = { productId: 'product', totalAmount: 7, amountUnit: 'lb', areaValue: 1000, lawnPlanDefaults: {}, lawnPlanManualFields: ['totalAmount'], totalAmountManual: true };
  const fresh = { ...row, totalAmount: 80, amountUnit: 'oz', areaValue: 2000 };
  expect(reconcileLawnPlanSelections([row], [fresh])[0]).toMatchObject({ totalAmount: 7, amountUnit: 'lb', areaValue: 2000 });
});

it('a chosen amount unit alone keeps the row on the plan: untouched rate and area refresh, the unit stays, a still-derived total stays withdrawn until the units agree', () => {
  const row = { productId: 'product', rate: 3, rateUnit: 'fl_oz', totalAmount: '', amountUnit: 'gal', areaValue: 5000, areaUnit: 'sqft', lawnPlanDefaults: {}, lawnPlanManualFields: ['amountUnit'] };
  const fresh = { ...row, totalAmount: 12, amountUnit: 'fl_oz', areaValue: 4000, rate: 3, lawnPlanManualFields: [] };
  expect(reconcileLawnPlanSelections([row], [fresh])[0]).toMatchObject({ rate: 3, areaValue: 4000, amountUnit: 'gal', totalAmount: '' });
  expect(reconcileLawnPlanSelections([{ ...row, amountUnit: 'fl_oz' }], [fresh])[0]).toMatchObject({ areaValue: 4000, amountUnit: 'fl_oz', totalAmount: 12 });
  // An entered total under the chosen unit is the tech's actual either way.
  expect(reconcileLawnPlanSelections([{ ...row, totalAmount: 2, totalAmountManual: true }], [fresh])[0]).toMatchObject({ totalAmount: 2, amountUnit: 'gal', areaValue: 4000 });
});

it('an "Additional work" option keeps the protocol row\'s application mode on its product', () => {
  const options = lawnPlanActionOptions([
    { product: { id: 'speedzone', name: 'SpeedZone' }, applicationMethod: 'broadcast_spray' },
    { product: { id: 'legacy', name: 'No mode' } },
    { product: {} },
  ]);
  expect(options.map((option) => option.product)).toEqual([
    { id: 'speedzone', name: 'SpeedZone', applicationMethod: 'broadcast_spray' },
    { id: 'legacy', name: 'No mode' },
  ]);
  expect(options[0]).toMatchObject({ id: 'lawn-plan-speedzone', label: 'SpeedZone', scope: 'exterior', treatmentApplied: true });
});

it('a plan outage withdraws every still-derived suggestion and keeps entered values with their units', () => {
  const governed = { productId: 'k', lawnPlanDefaults: { rate: 3 }, rate: 3, rateUnit: 'fl_oz', totalAmount: 15, amountUnit: 'fl_oz', areaValue: 5000, areaUnit: 'sqft', lawnPlanManualFields: [] };
  const entered = { ...governed, productId: 'micro', totalAmount: '9', amountUnit: 'gal', totalAmountManual: true, rate: '2', areaValue: '1000', lawnPlanManualFields: ['rate', 'areaValue', 'amountUnit'] };
  const manual = { productId: 'legacy', totalAmount: 4, amountUnit: 'oz' };
  expect(withdrawLawnPlanSuggestions([governed, entered, manual])).toEqual([
    { ...governed, totalAmount: '', rate: '', areaValue: '', lawnAmountReason: LAWN_PLAN_UNAVAILABLE_REASON },
    { ...entered, lawnAmountReason: LAWN_PLAN_UNAVAILABLE_REASON },
    manual,
  ]);
});
