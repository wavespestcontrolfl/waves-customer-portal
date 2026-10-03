// Voice fill's plan (lib/fast-complete-voice-plan.js): which taps a fill makes,
// which it leaves alone, and which become Checks. Pure, so each rule is pinned
// on its own; the sheet wiring is in FastCompleteSheet.voice-fill.test.jsx.
import { describe, expect, test } from 'vitest';
import { plainReason, planVoiceFill, unresolvedChecks } from './fast-complete-voice-plan';

const SPRAY = new Set(['spot_treatment', 'perimeter_spray']);
const row = (id, over = {}) => ({
  productId: id, name: `Product ${id}`, product: { id, name: `Product ${id}` }, dimension: 'liquid', catalogMethod: 'spot_treatment',
  totalAmount: '', amountUnit: 'fl_oz', active: true, added: true, methodInput: null, rateInput: null, ...over,
});
const houseRow = (id, over = {}) => row(id, { added: false, totalAmount: 4, amountUnit: 'fl_oz', ...over });
const rowMethod = (r, visitMethod) => r.methodInput || (SPRAY.has(r.catalogMethod) ? visitMethod : r.catalogMethod);

const OPS = {
  makeRow: (product, { common, visitMethod }) => row(product.id, { product, name: product.name, common, visitMethod }),
  rowMethod,
  followsVisitMethod: (r) => !r.methodInput && SPRAY.has(r.catalogMethod),
  sprayMethods: SPRAY,
  defaultMethod: 'spot_treatment',
  pests: ['Ants', 'Roaches', 'Fleas', 'Other'],
  areas: ['Inside', 'Outside', 'Garage'],
  activityValues: ['none', 'light', 'moderate', 'heavy'],
};
const FORM = { pests: new Set(), otherPest: '', areas: new Set(), method: 'spot_treatment', linearFt: '', activity: '', note: '' };
const CATALOG = [{ id: 'a', name: 'Product a' }, { id: 'b', name: 'Product b' }, { id: 'c', name: 'Product c' }];
const NO_VISIT = { pests: [], otherPest: '', areas: [], method: '', linearFt: null, activity: '', heard: '' };
const product = (productId, over = {}) => ({ productId, amount: null, unit: '', sameAsLast: false, method: '', heard: `heard ${productId}`, ...over });

function plan({ products = [], visit = NO_VISIT, rows = [houseRow('a')], form = FORM, ctx = {}, unclear = [], ...fill } = {}) {
  // ctx.rows are the rows as the sheet opened (the house mix at its starting amounts).
  const context = { rating: { allowed: true }, rows: [houseRow('a')], products: CATALOG, commonProducts: [], ...ctx };
  return planVoiceFill({ fill: { products, visit, unclear, customerNote: '', officeNote: '', ...fill }, rows, form, ctx: context, ops: OPS });
}
const texts = (result) => result.checks.map((c) => c.text);

describe('amounts', () => {
  test('a spoken amount in a unit the row offers sets the empty row', () => {
    const result = plan({ rows: [row('a')], products: [product('a', { amount: 6, unit: 'gal' })] });
    expect(result.patches.a).toEqual({ totalAmount: '6', amountUnit: 'gal' });
    expect(result.checks).toEqual([]);
  });

  test('the house mix\'s starting amount is not a tap: the spoken one replaces it', () => {
    const result = plan({ products: [product('a', { amount: 6, unit: 'fl_oz' })] });
    expect(result.patches.a).toEqual({ totalAmount: '6', amountUnit: 'fl_oz' });
    expect(result.checks).toEqual([]);
  });

  test('the same amount the sheet already has changes nothing', () => {
    const result = plan({ products: [product('a', { amount: 4, unit: 'fl_oz' })] });
    expect(result.patches).toEqual({});
    expect(result.checks).toEqual([]);
  });

  test('an amount the tech typed is kept; the difference is a Check', () => {
    const typed = [row('b', { totalAmount: '3', amountUnit: 'gal' })];
    const result = plan({ rows: typed, products: [product('b', { amount: 5, unit: 'gal' })] });
    expect(result.patches).toEqual({});
    expect(texts(result)).toEqual(['You entered 3 gal; heard 5 gal for Product b.']);
  });

  test('a house amount the tech edited is the tech\'s too', () => {
    const edited = [houseRow('a', { totalAmount: '8' })];
    const result = plan({ rows: edited, products: [product('a', { amount: 6, unit: 'fl_oz' })] });
    expect(result.patches).toEqual({});
    expect(texts(result)).toEqual(['You entered 8 fl oz; heard 6 fl oz for Product a.']);
  });

  test('a unit the row does not offer: no amount, a Check that says to enter it', () => {
    const result = plan({ rows: [row('a')], products: [product('a', { amount: 6, unit: 'lb', heard: 'six pounds of a' })] });
    expect(result.patches).toEqual({});
    expect(texts(result)).toEqual(['Heard “six pounds of a” — enter the amount for Product a.']);
    expect(result.checks[0].watch).toBe('amount:a');
  });

  test('a product the sheet does not have is added with its spoken amount', () => {
    const result = plan({ rows: [houseRow('a')], products: [product('b', { amount: 2, unit: 'gal' })] });
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ productId: 'b', totalAmount: '2', amountUnit: 'gal', active: true });
  });

  test('a product that is not in the catalog is a Check, never a row', () => {
    const result = plan({ products: [product('zzz', { amount: 2, unit: 'gal', heard: 'the zed' })] });
    expect(result.added).toEqual([]);
    expect(texts(result)).toEqual(['Heard “the zed” — that product is not on this list.']);
  });

  test('a house row the tech turned off stays off: a Check, no amount', () => {
    const off = [houseRow('a', { active: false })];
    const result = plan({ rows: off, products: [product('a', { amount: 6, unit: 'fl_oz' })] });
    expect(result.patches).toEqual({});
    expect(texts(result)).toEqual(['You turned off Product a; heard “heard a”.']);
  });
});

describe('"same as last time"', () => {
  test('a house row already at its starting amount: nothing to change, no Check', () => {
    const result = plan({ products: [product('a', { sameAsLast: true })] });
    expect(result.patches).toEqual({});
    expect(result.checks).toEqual([]);
  });

  test('a house row the tech changed: kept, with a Check', () => {
    const result = plan({ rows: [houseRow('a', { totalAmount: '8' })], products: [product('a', { sameAsLast: true })] });
    expect(result.patches).toEqual({});
    expect(texts(result)).toEqual(['You entered 8 fl oz; heard 4 fl oz for Product a.']);
  });

  test('a picked product with a usual amount takes it', () => {
    const ctx = { commonProducts: [{ productId: 'b', usualAmount: 2, usualUnit: 'gal' }] };
    const result = plan({ rows: [row('b')], products: [product('b', { sameAsLast: true })], ctx });
    expect(result.patches.b).toEqual({ totalAmount: '2', amountUnit: 'gal' });
    expect(result.checks).toEqual([]);
  });

  test('a picked product the sheet has no last-time amount for: a Check, blank stays blank', () => {
    const result = plan({ rows: [row('b')], products: [product('b', { sameAsLast: true, heard: 'same as last time' })] });
    expect(result.patches).toEqual({});
    expect(texts(result)).toEqual(['Heard “same as last time” — enter the amount for Product b.']);
  });

  test('a usual amount in a unit the row does not offer is no last-time amount', () => {
    const ctx = { commonProducts: [{ productId: 'b', usualAmount: 2, usualUnit: 'lb' }] };
    const result = plan({ rows: [row('b')], products: [product('b', { sameAsLast: true })], ctx });
    expect(result.patches).toEqual({});
    expect(result.checks).toHaveLength(1);
  });
});

describe('the visit', () => {
  const visit = (over) => ({ ...NO_VISIT, heard: 'what was said', ...over });

  test('pests and where are added to what is there, never removed', () => {
    const form = { ...FORM, pests: new Set(['Fleas']), areas: new Set(['Inside']) };
    const result = plan({ form, visit: visit({ pests: ['Ants'], areas: ['Outside'] }) });
    expect([...result.formPatch.pests].sort()).toEqual(['Ants', 'Fleas']);
    expect([...result.formPatch.areas].sort()).toEqual(['Inside', 'Outside']);
    expect(result.checks).toEqual([]);
    expect(result.heard.visit).toBe('what was said');
  });

  test('a choice that is not on the sheet is a Check, not a tap', () => {
    const result = plan({ visit: visit({ pests: ['Dragons'] }) });
    expect(result.formPatch.pests).toBeUndefined();
    expect(texts(result)).toEqual(['Heard “what was said” — Dragons is not a choice on this sheet.']);
  });

  test('activity: set when empty, kept (with a Check) when the tech tapped another, ignored when the sheet has none', () => {
    expect(plan({ visit: visit({ activity: 'light' }) }).formPatch.activity).toBe('light');
    const tapped = plan({ form: { ...FORM, activity: 'heavy' }, visit: visit({ activity: 'light' }) });
    expect(tapped.formPatch.activity).toBeUndefined();
    expect(texts(tapped)).toEqual(['You tapped Heavy; heard Light.']);
    const same = plan({ form: { ...FORM, activity: 'light' }, visit: visit({ activity: 'light' }) });
    expect(same.checks).toEqual([]);
    const none = plan({ ctx: { rating: { allowed: false } }, visit: visit({ activity: 'light' }) });
    expect(none.formPatch.activity).toBeUndefined();
    expect(none.checks).toEqual([]);
  });

  test('the other pest and the linear feet: set when empty, a Check when the tech has a different value', () => {
    const empty = plan({ visit: visit({ pests: ['Other'], otherPest: 'palmetto bugs', linearFt: 120 }) });
    expect(empty.formPatch).toMatchObject({ otherPest: 'palmetto bugs', linearFt: '120' });
    const typed = plan({
      form: { ...FORM, pests: new Set(['Other']), otherPest: 'crickets', linearFt: '90' },
      visit: visit({ pests: ['Other'], otherPest: 'palmetto bugs', linearFt: 120 }),
    });
    expect(typed.formPatch.otherPest).toBeUndefined();
    expect(typed.formPatch.linearFt).toBeUndefined();
    expect(texts(typed)).toEqual(['You named “crickets”; heard “palmetto bugs”.', 'You entered 90 ft; heard 120 ft.']);
    const same = plan({ form: { ...FORM, linearFt: '120.0' }, visit: visit({ linearFt: 120 }) });
    expect(same.checks).toEqual([]);
  });

  test('the How row: set while it is still the sheet\'s starting pick, kept with a Check once the tech chose', () => {
    expect(plan({ visit: visit({ method: 'perimeter_spray' }) }).formPatch.method).toBe('perimeter_spray');
    const chosen = plan({ form: { ...FORM, method: 'perimeter_spray' }, visit: visit({ method: 'spot_treatment' }) });
    expect(chosen.formPatch.method).toBeUndefined();
    expect(texts(chosen)).toEqual(['You tapped Perimeter spray; heard Spot treatment.']);
  });
});

describe('a product\'s method', () => {
  test('a spray on a row that follows the How row stands in for the How row when none was said', () => {
    const result = plan({ products: [product('a', { amount: 4, unit: 'fl_oz', method: 'perimeter_spray' })] });
    expect(result.formPatch.method).toBe('perimeter_spray');
    expect(result.patches).toEqual({});
  });

  test('a way the added product goes down is set on that row, and its rate is cleared', () => {
    const baitRow = row('b', { catalogMethod: 'bait_placement' });
    const result = plan({ rows: [baitRow], products: [product('b', { method: 'granular_broadcast' })] });
    expect(result.patches.b).toEqual({ methodInput: 'granular_broadcast', rateInput: null });
  });

  test('a way the tech picked for the row is kept, with a Check', () => {
    const picked = row('b', { catalogMethod: 'bait_placement', methodInput: 'granular_broadcast' });
    const result = plan({ rows: [picked], products: [product('b', { method: 'bait_placement' })] });
    expect(result.patches).toEqual({});
    expect(texts(result)).toEqual(['You picked granular broadcast; heard bait placement for Product b.']);
  });

  test('a way a house row cannot be set to is a Check', () => {
    const result = plan({ products: [product('a', { method: 'bait_placement' })] });
    expect(result.patches).toEqual({});
    expect(result.checks).toHaveLength(1);
  });
});

describe('server unclear items, notes and Heard', () => {
  test('each unclear item is a Check in plain English', () => {
    const result = plan({ unclear: [{ heard: 'the fuzzy one', reason: 'ambiguous_product' }] });
    expect(texts(result)).toEqual(['Heard “the fuzzy one” — it could be more than one product.']);
    expect(result.checks[0].watch).toBeUndefined();
  });

  test('plainReason: a code is worded, free words stay, anything else has a fallback', () => {
    expect(plainReason('carrier_volume')).toMatch(/size of the mix/);
    expect(plainReason('Needs a closer look')).toBe('Needs a closer look');
    expect(plainReason('weird_new_code')).toBe('I could not match it to a choice');
  });

  test('both notes and the Heard lines come back for the sheet to place', () => {
    const result = plan({ customerNote: ' Treated the garage. ', officeNote: ' Gate is stuck. ', products: [product('a', { amount: 4, unit: 'fl_oz' })] });
    expect(result.customerNote).toBe('Treated the garage.');
    expect(result.officeNote).toBe('Gate is stuck.');
    expect(result.heard.products).toEqual({ a: 'heard a' });
  });

  test('no fill at all plans nothing', () => {
    const result = planVoiceFill({ fill: null, rows: [], form: FORM, ctx: { rows: [], products: [], commonProducts: [] }, ops: OPS });
    expect(result).toMatchObject({ added: [], patches: {}, formPatch: {}, checks: [], customerNote: '', officeNote: '' });
  });
});

describe('Checks that watch a field', () => {
  test('fixing the field clears the Check; other changes and unwatched Checks stay', () => {
    const result = plan({ rows: [row('b')], products: [product('b', { sameAsLast: true })], unclear: [{ heard: 'x', reason: 'unclear_other' }] });
    const checks = result.checks.map((check, index) => ({ ...check, id: index }));
    expect(checks).toHaveLength(2);

    expect(unresolvedChecks(checks, [row('b')], FORM)).toBe(checks);
    // The amount Check (second) clears; the unclear item (first) stays.
    expect(unresolvedChecks(checks, [row('b', { totalAmount: '2' })], FORM).map((c) => c.id)).toEqual([0]);
  });

  test('a Check about a tap clears when the tap changes, whichever way', () => {
    const tapped = plan({ form: { ...FORM, activity: 'heavy' }, visit: { ...NO_VISIT, activity: 'light', heard: 'light' } });
    const checks = tapped.checks.map((check, index) => ({ ...check, id: index }));
    expect(unresolvedChecks(checks, [], { ...FORM, activity: 'heavy' })).toBe(checks);
    expect(unresolvedChecks(checks, [], { ...FORM, activity: 'light' })).toEqual([]);
  });
});

describe('confirm taps (owner 2026-10-02: one tap per product, visit taps too)', () => {
  test('every row the fill changed or added and every visit field it set waits on a confirm', () => {
    const result = plan({
      rows: [row('a')],
      products: [product('a', { amount: 6, unit: 'gal', heard: 'six gallons of a' }), product('b', { amount: 2, unit: 'gal' })],
      visit: { ...NO_VISIT, pests: ['Ants'], areas: ['Outside'], activity: 'light', heard: 'ants outside light' },
    });
    const byWatch = Object.fromEntries(result.confirms.map((c) => [c.watch, c]));
    expect(byWatch['row:a']).toMatchObject({ text: 'Product a — 6 gal', heard: 'six gallons of a' });
    expect(byWatch['row:b']).toMatchObject({ text: 'Product b — 2 gal' });
    expect(byWatch['form:pests']).toMatchObject({ text: 'Pests: Ants', heard: 'ants outside light' });
    expect(byWatch['form:areas']).toMatchObject({ text: 'Where: Outside' });
    expect(byWatch['form:activity']).toMatchObject({ text: 'Activity: Light' });
  });

  test('a value the sheet already had and the fill left alone needs no confirm', () => {
    const result = plan({ products: [product('a', { amount: 4, unit: 'fl_oz' })] });
    expect(result.confirms).toEqual([]);
  });

  test('a confirm clears when the tech changes what it points at', () => {
    const result = plan({ rows: [row('a')], products: [product('a', { amount: 6, unit: 'gal' })] });
    const filled = [row('a', { totalAmount: '6', amountUnit: 'gal' })];
    expect(unresolvedChecks(result.confirms, filled, FORM)).toHaveLength(1);
    expect(unresolvedChecks(result.confirms, [row('a', { totalAmount: '5', amountUnit: 'gal' })], FORM)).toHaveLength(0);
    expect(unresolvedChecks(result.confirms, [row('a', { totalAmount: '6', amountUnit: 'gal', active: false })], FORM)).toHaveLength(0);
  });
});

describe('a How the tech tapped themselves', () => {
  test('is never replaced, even when it is the default way: the difference is a Check', () => {
    const result = plan({ form: { ...FORM, methodPicked: true }, visit: { ...NO_VISIT, method: 'perimeter_spray', heard: 'perimeter' } });
    expect(result.formPatch.method).toBeUndefined();
    expect(texts(result)).toContain('You tapped Spot treatment; heard Perimeter spray.');
  });

  test('the untouched default is still filled', () => {
    const result = plan({ visit: { ...NO_VISIT, method: 'perimeter_spray', heard: 'perimeter' } });
    expect(result.formPatch.method).toBe('perimeter_spray');
  });
});

test.each([
  'product_said_not_filled', 'amount_said_not_filled', 'visit_said_not_filled', 'office_said_not_filled', 'note_not_heard',
  'note_audience_unclear', 'note_safety_claim', 'note_company_name', 'note_over_cap',
])('the server reason %s reads as plain words', (code) => {
  expect(plainReason(code)).not.toBe('I could not match it to a choice');
  expect(plainReason(code)).not.toContain('_');
});

test('a product said as the current How still holds when the fill changes How', () => {
  const result = plan({
    rows: [row('a')],
    products: [product('a', { method: 'spot_treatment', heard: 'spot treated with a' })],
    visit: { ...NO_VISIT, method: 'perimeter_spray', heard: 'perimeter' },
  });
  expect(result.formPatch.method).toBe('perimeter_spray');
  expect(texts(result)).toContain('Heard “spot treated with a” — Product a went down a different way from the How row.');
});

test('a product\'s standard way the tech picked themselves is kept; the difference is a Check', () => {
  const picked = [row('b', { catalogMethod: 'bait_placement', methodInput: null, methodPicked: true })];
  const result = plan({ rows: picked, products: [product('b', { method: 'granular_broadcast' })] });
  expect(result.patches).toEqual({});
  expect(texts(result)).toEqual(['You picked bait placement; heard granular broadcast for Product b.']);
  // untouched, the same fill sets it
  const untouched = plan({ rows: [row('b', { catalogMethod: 'bait_placement' })], products: [product('b', { method: 'granular_broadcast' })] });
  expect(untouched.patches.b).toMatchObject({ methodInput: 'granular_broadcast' });
});

test('a spray row whose way the tech picked (stored, sticky) is not moved by a dictated How', () => {
  const picked = [row('b', { catalogMethod: 'spot_treatment', methodInput: 'spot_treatment', methodPicked: true })];
  const result = plan({ rows: picked, products: [product('b', { method: 'perimeter_spray', heard: 'b around the perimeter' })], visit: { ...NO_VISIT, method: 'perimeter_spray', heard: 'perimeter' } });
  expect(result.patches).toEqual({});
  expect(texts(result)).toContain('You picked spot treatment; heard perimeter spray for Product b.');
});
