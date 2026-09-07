const { buildLawnCompletionDefaults, lawnCompletionDefaultsEnabled, archivedLawnRecipeMatches, lawnPlanAttributesVisit } = require('../services/lawn-completion-defaults');

function fixture() {
  return {
    context: { isLawn: true, propertyId: 'property', propertyMatchesProfile: true, history: { rows: [] } },
    plan: {
      serviceId: 'visit', appointmentAssignment: {},
      propertyGate: { serviceTier: 'Silver', trackKey: 'st_augustine', blocks: [] },
      protocol: { structured: {
        status: 'active', grassTrack: 'st_augustine', protocolKey: 'protocol', version: '1', window: { key: 'june' },
        products: [{ productId: 'product', defaultInPlan: true, gates: {}, applicationMode: 'broadcast' }],
      } },
      mixCalculator: { lawnSqft: 4000, conditionalOptions: [], items: [{
        selected: true, product: { id: 'product', name: 'Fixture product', active: true, labelVerifiedAt: '2026-01-01' },
        mix: { amount: 12, amountUnit: 'fl oz', ratePer1000: 3, rateUnit: 'fl oz', treatedSqft: 4000 },
      }] },
    },
  };
}

test('completion defaults require both owner gates', () => {
  const keys = ['GATE_LAWN_COMPLETION_DEFAULTS', 'GATE_LAWN_PROPERTY_HISTORY'];
  const saved = keys.map(key => process.env[key]);
  try {
    for (const values of [['false', 'true'], ['true', 'false'], ['true', 'true']]) {
      keys.forEach((key, i) => { process.env[key] = values[i]; });
      expect(lawnCompletionDefaultsEnabled()).toBe(values.every(value => value === 'true'));
    }
  } finally { keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); }
});

test('verified plan math is projected unchanged with an editable method', () => {
  const { plan, context } = fixture();
  const result = buildLawnCompletionDefaults(plan, context);
  expect(result.items[0].mix).toEqual(plan.mixCalculator.items[0].mix);
  expect(result.items[0].applicationMethod).toBe('broadcast_spray');
  expect(result.history).toBe(context.history);
});

test.each(['unverified', 'blocked', 'unknown-unit'])('%s keeps the area and withholds the derived quantity', (reason) => {
  const { plan, context } = fixture();
  if (reason === 'unverified') plan.mixCalculator.items[0].product.labelVerifiedAt = null;
  if (reason === 'blocked') plan.propertyGate.blocks.push({ code: 'current_restriction' });
  if (reason === 'unknown-unit') plan.mixCalculator.items[0].mix.amountUnit = 'fl oz/acre';
  const [item] = buildLawnCompletionDefaults(plan, context).items;
  expect(item.mix).toMatchObject({ amount: null, ratePer1000: null, treatedSqft: 4000 });
  expect(item.amountReason).toBeTruthy();
});

test.each(['optional', 'conditional', 'inactive', 'unselected'])('%s products do not prefill applied work', (reason) => {
  const { plan, context } = fixture();
  if (reason === 'optional') plan.protocol.structured.products[0].defaultInPlan = false;
  if (reason === 'conditional') Object.assign(plan.protocol.structured.products[0], { defaultInPlan: false, gates: { soil_test: true } });
  if (reason === 'inactive') plan.mixCalculator.items[0].product.active = false;
  if (reason === 'unselected') plan.mixCalculator.items[0].selected = false;
  expect(buildLawnCompletionDefaults(plan, context).items).toEqual([]);
});

test.each(['property', 'grass', 'window', 'version', 'archived', 'nonmember', 'nonlawn'])('%s mismatch cannot invent an eligible plan', (reason) => {
  const { plan, context } = fixture();
  if (reason === 'property') context.propertyMatchesProfile = false;
  if (reason === 'grass') plan.propertyGate.trackKey = 'zoysia';
  if (reason === 'window') plan.appointmentAssignment.windowKey = 'missing';
  if (reason === 'version') plan.appointmentAssignment.protocolVersion = 'missing';
  if (reason === 'archived') plan.protocol.structured.status = 'archived';
  if (reason === 'nonmember') plan.propertyGate.serviceTier = null;
  if (reason === 'nonlawn') context.isLawn = false;
  expect(buildLawnCompletionDefaults(plan, context).items).toEqual([]);
});

test('a nonmember can use an explicitly assigned window; a spot default stays spot work', () => {
  const { plan, context } = fixture();
  plan.propertyGate.serviceTier = null;
  plan.appointmentAssignment.windowKey = 'june';
  plan.protocol.structured.products[0].applicationMode = 'spot';
  expect(buildLawnCompletionDefaults(plan, context).items[0].applicationMethod).toBe('spot_treatment');
});

test.each(['WDG', 'WG', 'WP', 'liquid', 'granular', 'G'])('formulation %s determines the default application method, not its weight unit', formulation => {
  const { plan, context } = fixture();
  plan.mixCalculator.items[0].product.formulation = formulation;
  plan.mixCalculator.items[0].mix.amountUnit = 'oz';
  expect(buildLawnCompletionDefaults(plan, context).items[0].applicationMethod)
    .toBe(['granular', 'G'].includes(formulation) ? 'granular_broadcast' : 'broadcast_spray');
});

test('an exact assigned archived version remains eligible, but drafts and partial assignments do not', () => {
  const { plan, context } = fixture();
  plan.appointmentAssignment = { protocolKey: 'protocol', protocolVersion: '1', windowKey: 'june' };
  plan.protocol.structured.status = 'archived';
  expect(buildLawnCompletionDefaults(plan, context).items).toHaveLength(1);
  plan.protocol.structured.status = 'draft';
  expect(buildLawnCompletionDefaults(plan, context).items).toHaveLength(0);
  plan.protocol.structured.status = 'archived';
  delete plan.appointmentAssignment.protocolVersion;
  expect(buildLawnCompletionDefaults(plan, context).items).toHaveLength(0);
});

test('selected defaults with counter or safety metadata remain defaults; plan blocks still withhold amounts', () => {
  const { plan, context } = fixture();
  plan.protocol.structured.products[0].gates = { annualCounter: 'prodiamine_oz_per_1000', requiresZeroNP: true };
  expect(buildLawnCompletionDefaults(plan, context).items[0].mix.amount).toBe(12);
  plan.propertyGate.blocks.push({ code: 'nitrogen_restriction' });
  expect(buildLawnCompletionDefaults(plan, context).items[0].mix.amount).toBeNull();
  plan.protocol.structured.products[0].defaultInPlan = false;
  expect(buildLawnCompletionDefaults(plan, context).items).toHaveLength(0);
});

test('an archived recipe accepts derived-rate defaults only inside the archived target, and still pins stored rates', () => {
  const archived = (product) => ({ status: 'archived', products: [{ productId: 'srn', defaultInPlan: true, applicationMode: 'broadcast', ...product }] });
  const item = (mix) => [{ selected: true, product: { id: 'srn' }, mix }];
  const derivedN = { ratePer1000: null, rateUnit: 'lb_n', gates: { targetN: '0.35-0.50 lb N/1000' } };
  const nMix = (targetNPer1000) => ({ ratePer1000: 3.3, rateUnit: 'lb', rateSource: 'target_n_analysis', targetNPer1000 });
  expect(archivedLawnRecipeMatches(archived(derivedN), item(nMix(0.5)))).toBe(true);
  expect(archivedLawnRecipeMatches(archived(derivedN), item(nMix(0.35)))).toBe(true);
  expect(archivedLawnRecipeMatches(archived(derivedN), item(nMix(1)))).toBe(false);
  expect(archivedLawnRecipeMatches(archived(derivedN), item(nMix(undefined)))).toBe(false);
  expect(archivedLawnRecipeMatches(archived(derivedN), item({ ratePer1000: null, rateUnit: 'lb_n', rateSource: 'missing_rate' }))).toBe(true);
  expect(archivedLawnRecipeMatches(archived(derivedN), item({ ratePer1000: 3, rateUnit: 'fl_oz', rateSource: 'catalog_default_rate' }))).toBe(false);
  expect(archivedLawnRecipeMatches(archived(derivedN), item({ ratePer1000: 2, rateUnit: 'lb', rateSource: 'target_k_analysis', targetKPer1000: 0.5 }))).toBe(false);
  expect(archivedLawnRecipeMatches(archived({ ...derivedN, gates: {} }), item(nMix(0.5)))).toBe(false);
  const derivedK = { ratePer1000: null, rateUnit: 'lb_k2o', gates: { soilKGatePpmBelow: 80 } };
  expect(archivedLawnRecipeMatches(archived(derivedK), item({ ratePer1000: 2, rateUnit: 'lb', rateSource: 'target_k_analysis', targetKPer1000: 0.5 }))).toBe(false);
  expect(archivedLawnRecipeMatches(archived({ ...derivedK, gates: { targetK: '0.50 lb K2O/1000' } }), item({ ratePer1000: 2, rateUnit: 'lb', rateSource: 'target_k_analysis', targetKPer1000: 0.5 }))).toBe(true);
  for (const target of [1, 2]) expect(archivedLawnRecipeMatches(archived({ ...derivedK, gates: { targetK: '0.50 lb K2O/1000' } }), item({ ratePer1000: 2, rateUnit: 'lb', rateSource: 'target_k_analysis', targetKPer1000: target }))).toBe(false);
  expect(archivedLawnRecipeMatches(archived({ ...derivedK, gates: { targetK: 'per 1K, 2 apps' } }), item({ ratePer1000: 2, rateUnit: 'lb', rateSource: 'target_k_analysis', targetKPer1000: 2 }))).toBe(false);
  expect(archivedLawnRecipeMatches(archived(derivedK), item({ ratePer1000: null, rateUnit: 'lb_k2o', rateSource: 'missing_rate' }))).toBe(true);
  const stored = { ratePer1000: 3, rateUnit: 'fl oz', gates: {} };
  expect(archivedLawnRecipeMatches(archived(stored), item({ ratePer1000: 3, rateUnit: 'fl oz', rateSource: 'catalog_default_rate' }))).toBe(true);
  expect(archivedLawnRecipeMatches(archived(stored), item({ ratePer1000: 2.5, rateUnit: 'fl oz', rateSource: 'catalog_default_rate' }))).toBe(false);
  expect(archivedLawnRecipeMatches(archived({ ratePer1000: 0, rateUnit: 'fl oz', gates: {} }), item({ ratePer1000: null, rateUnit: 'fl oz', rateSource: 'missing_rate' }))).toBe(false);
  expect(archivedLawnRecipeMatches(archived({ ratePer1000: null, rateUnit: 'fl oz', gates: {} }), item({ ratePer1000: null, rateUnit: 'fl oz', rateSource: 'missing_rate' }))).toBe(false);
});

test.each([
  ['member without an assignment', {}, 'Silver', true],
  ['nonmember without a program', {}, null, false],
  ['nonmember whose assignment the plan resolved', { protocolKey: 'protocol', protocolVersion: '1', windowKey: 'june' }, null, true],
  ['member whose assignment the plan did NOT resolve (defaults gate off → calendar protocol)', { protocolKey: 'protocol', protocolVersion: '2', windowKey: 'september' }, 'Silver', false],
  ['assignment on a plan with no structured window', { protocolKey: 'protocol', protocolVersion: '1', windowKey: 'june' }, 'Silver', 'no-window'],
])('ledger attribution — %s', (_label, assignment, tier, expected) => {
  const { plan } = fixture();
  plan.appointmentAssignment = assignment;
  plan.propertyGate.serviceTier = tier;
  if (expected === 'no-window') { plan.protocol.structured = null; expected = false; }
  expect(lawnPlanAttributesVisit(plan)).toBe(expected);
  expect(lawnPlanAttributesVisit(null)).toBe(false);
});
