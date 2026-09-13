const { buildLawnCompletionDefaults, lawnCompletionDefaultsEnabled, archivedLawnRecipeMatches, lawnPlanAttributesVisit } = require('../services/lawn-completion-defaults');

function fixture() {
  return {
    context: { isLawn: true, propertyId: 'property', propertyMatchesProfile: true, history: { rows: [] } },
    plan: {
      serviceId: 'visit', appointmentAssignment: {},
      propertyGate: { serviceTier: 'Silver', trackKey: 'st_augustine', blocks: [], propertyMatchesProfile: true },
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

test.each(['unknown-unit', 'missing-amount'])('%s keeps the area and withholds the derived quantity', (reason) => {
  const { plan, context } = fixture();
  if (reason === 'unknown-unit') plan.mixCalculator.items[0].mix.amountUnit = 'fl oz/acre';
  if (reason === 'missing-amount') plan.mixCalculator.items[0].mix.amount = null;
  const [item] = buildLawnCompletionDefaults(plan, context).items;
  expect(item.mix).toMatchObject({ amount: null, ratePer1000: null, treatedSqft: 4000 });
  expect(item.amountReason).toBeTruthy();
});

// Owner ruling 2026-09-11: the planned quantity is the tech's starting point
// even when the label stamp is missing or the plan carries a block — the
// block still surfaces in the plan banner; the amount is confirmed, not retyped.
test.each(['unverified', 'blocked'])('%s no longer withholds the planned quantity', (reason) => {
  const { plan, context } = fixture();
  if (reason === 'unverified') plan.mixCalculator.items[0].product.labelVerifiedAt = null;
  if (reason === 'blocked') plan.propertyGate.blocks.push({ code: 'inventory_depleted' });
  const [item] = buildLawnCompletionDefaults(plan, context).items;
  expect(item.mix).toEqual(plan.mixCalculator.items[0].mix);
  expect(item.amountReason).toBeNull();
});

test.each(['optional', 'conditional', 'inactive', 'unselected'])('%s products do not prefill applied work', (reason) => {
  const { plan, context } = fixture();
  if (reason === 'optional') plan.protocol.structured.products[0].defaultInPlan = false;
  if (reason === 'conditional') Object.assign(plan.protocol.structured.products[0], { defaultInPlan: false, gates: { soil_test: true } });
  if (reason === 'inactive') plan.mixCalculator.items[0].product.active = false;
  if (reason === 'unselected') plan.mixCalculator.items[0].selected = false;
  const result = buildLawnCompletionDefaults(plan, context);
  expect(result.items).toEqual([]);
  // A selected live recipe the window registers no default for is explained;
  // a recipe with nothing selected or active is legitimately empty.
  expect(result.message).toBe(['optional', 'conditional'].includes(reason)
    ? 'The assigned protocol window lists none of this recipe\'s products as defaults. Enter the actual work.' : null);
});

test('a live window whose defaults name none of the recipe products explains the empty prefill', () => {
  const { plan, context } = fixture();
  // Operating layer seeded with one product (e.g. Liquid SRN) while the field
  // recipe resolves different catalog rows (e.g. LESCO fertilizer + CarbonPro-L).
  plan.protocol.structured.products = [{ productId: 'liquid-srn', defaultInPlan: true, gates: {}, applicationMode: 'broadcast' }];
  plan.mixCalculator.items = [
    { selected: true, product: { id: 'lesco', name: 'LESCO 24-0-11', active: true, labelVerifiedAt: '2026-01-01' }, mix: { amount: 20, amountUnit: 'lb', treatedSqft: 4000 } },
    { selected: true, product: { id: 'carbonpro', name: 'CarbonPro-L', active: true, labelVerifiedAt: '2026-01-01' }, mix: { amount: 12, amountUnit: 'fl oz', treatedSqft: 4000 } },
  ];
  const result = buildLawnCompletionDefaults(plan, context);
  expect(result.items).toEqual([]);
  expect(result.options).toEqual([]);
  expect(result.message).toBe('The assigned protocol window lists none of this recipe\'s products as defaults. Enter the actual work.');
  // One registered default is enough: the prefill carries it and the message clears.
  plan.protocol.structured.products.push({ productId: 'carbonpro', defaultInPlan: true, gates: {}, applicationMode: 'broadcast' });
  const partial = buildLawnCompletionDefaults(plan, context);
  expect(partial.items.map(item => item.product.id)).toEqual(['carbonpro']);
  expect(partial.message).toBeNull();
});

test.each(['property', 'grass', 'window', 'version', 'archived', 'nonmember', 'nonmember_lane', 'nonlawn'])('%s mismatch cannot invent an eligible plan', (reason) => {
  const { plan, context } = fixture();
  if (reason === 'property') context.propertyMatchesProfile = false;
  if (reason === 'grass') plan.propertyGate.trackKey = 'zoysia';
  if (reason === 'window') plan.appointmentAssignment.windowKey = 'missing';
  if (reason === 'version') plan.appointmentAssignment.protocolVersion = 'missing';
  if (reason === 'archived') plan.protocol.structured.status = 'archived';
  if (reason === 'nonmember') plan.propertyGate.serviceTier = null;
  // A legacy tier lingering on an explicit per_visit / one_time customer is
  // not a program (Codex #4113 batch 12 follow-up); the assignment is also
  // withdrawn so the tier is the only claim.
  if (reason === 'nonmember_lane') { plan.propertyGate.billingMode = 'one_time'; plan.appointmentAssignment = {}; }
  if (reason === 'nonlawn') context.isLawn = false;
  expect(buildLawnCompletionDefaults(plan, context).items).toEqual([]);
});

test('every option carries the protocol row\'s application mode, so an added herbicide records the prescribed broadcast, not the catalog\'s spot default', () => {
  const { plan, context } = fixture();
  plan.protocol.structured.products.push(
    { productId: 'speedzone', defaultInPlan: false, gates: { weeds_present: true }, applicationMode: 'broadcast' },
    { productId: 'celsius', defaultInPlan: false, gates: {}, applicationMode: 'spot' },
  );
  plan.mixCalculator.conditionalOptions = [
    // The line parse tags every SpeedZone line SPOT_ALLOWANCE; the protocol row's explicit broadcast mode wins (Codex r13 P1).
    { role: 'conditional', selected: false, scope: 'SPOT_ALLOWANCE', product: { id: 'speedzone', name: 'SpeedZone', category: 'herbicide', active: true } },
    { role: 'conditional', selected: false, product: { id: 'celsius', name: 'Celsius WG', category: 'herbicide', formulation: 'Water-dispersible granule (WG)', active: true } },
    { role: 'conditional', selected: false, product: { id: 'unlisted', name: 'Not in this protocol', active: true } },
  ];
  expect(buildLawnCompletionDefaults(plan, context).options).toEqual([
    { product: { id: 'product', name: 'Fixture product' }, applicationMethod: 'broadcast_spray' },
    { product: { id: 'speedzone', name: 'SpeedZone' }, applicationMethod: 'broadcast_spray' },
    { product: { id: 'celsius', name: 'Celsius WG' }, applicationMethod: 'spot_treatment' },
  ]);
});

test('a protocol row without an explicit mode still lets the parsed spot scope decide', () => {
  const { plan, context } = fixture();
  plan.protocol.structured.products.push({ productId: 'celsius', defaultInPlan: false, gates: {} });
  plan.mixCalculator.conditionalOptions = [
    { role: 'conditional', selected: false, scope: 'SPOT_ALLOWANCE', product: { id: 'celsius', name: 'Celsius WG', active: true } },
  ];
  expect(buildLawnCompletionDefaults(plan, context).options.at(-1)).toEqual({ product: { id: 'celsius', name: 'Celsius WG' }, applicationMethod: 'spot_treatment' });
});

test('a deactivated catalog product is offered neither as a default nor under "Additional work"', () => {
  const { plan, context } = fixture();
  plan.protocol.structured.products.push({ productId: 'retired', defaultInPlan: false, gates: {}, applicationMode: 'broadcast' });
  plan.mixCalculator.items[0].product.active = false;
  plan.mixCalculator.conditionalOptions = [
    { role: 'conditional', selected: false, product: { id: 'retired', name: 'Retired herbicide', active: false } },
  ];
  const result = buildLawnCompletionDefaults(plan, context);
  // The completion writer rejects an inactive product row, so the option would
  // be an action that cannot be completed (Codex r12 P2).
  expect(result.items).toEqual([]);
  expect(result.options).toEqual([]);
});

test('a nonmember can use a complete explicit assignment; a spot default stays spot work', () => {
  const { plan, context } = fixture();
  plan.propertyGate.serviceTier = null;
  plan.appointmentAssignment = { protocolKey: 'protocol', protocolVersion: '1', windowKey: 'june' };
  plan.protocol.structured.products[0].applicationMode = 'spot';
  expect(buildLawnCompletionDefaults(plan, context).items[0].applicationMethod).toBe('spot_treatment');
});

test('a nonmember with a partial assignment (window only) has no program: the calendar-resolved protocol is not adopted', () => {
  const { plan, context } = fixture();
  plan.propertyGate.serviceTier = null;
  plan.appointmentAssignment = { windowKey: 'june' };
  const defaults = buildLawnCompletionDefaults(plan, context);
  expect(defaults.items).toEqual([]);
  expect(defaults.message).toBe('No assigned lawn plan for this visit. Add the products actually applied.');
});

test.each(['WDG', 'WG', 'WP', 'liquid', 'granular', 'G', 'Granule (G)', 'Granule (restricted-use)', 'Granular pre-emergent on fertilizer', 'Granular bait', 'Water-dispersible granule (WDG)', 'Water-soluble granule (WSG)', 'Water-dispersible granule (WG)', 'Suspension concentrate (SC)'])('formulation %s determines the default application method, not its weight unit', formulation => {
  const { plan, context } = fixture();
  plan.mixCalculator.items[0].product.formulation = formulation;
  plan.mixCalculator.items[0].mix.amountUnit = 'oz';
  expect(buildLawnCompletionDefaults(plan, context).items[0].applicationMethod)
    .toBe(['granular', 'G', 'Granule (G)', 'Granule (restricted-use)', 'Granular pre-emergent on fertilizer', 'Granular bait'].includes(formulation) ? 'granular_broadcast' : 'broadcast_spray');
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

test('selected defaults with counter or safety metadata remain defaults, with their amounts', () => {
  const { plan, context } = fixture();
  plan.protocol.structured.products[0].gates = { annualCounter: 'prodiamine_oz_per_1000', requiresZeroNP: true };
  expect(buildLawnCompletionDefaults(plan, context).items[0].mix.amount).toBe(12);
  plan.propertyGate.blocks.push({ code: 'nitrogen_restriction' });
  expect(buildLawnCompletionDefaults(plan, context).items[0].mix.amount).toBe(12);
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
  // The catalog spells the protocol row's 'fl oz' as 'fl_oz' — same unit, not drift; a different unit still is.
  expect(archivedLawnRecipeMatches(archived(stored), item({ ratePer1000: 3, rateUnit: 'fl_oz', rateSource: 'catalog_default_rate' }))).toBe(true);
  expect(archivedLawnRecipeMatches(archived(stored), item({ ratePer1000: 3, rateUnit: 'oz', rateSource: 'catalog_default_rate' }))).toBe(false);
  expect(archivedLawnRecipeMatches(archived({ ratePer1000: 0, rateUnit: 'fl oz', gates: {} }), item({ ratePer1000: null, rateUnit: 'fl oz', rateSource: 'missing_rate' }))).toBe(false);
  expect(archivedLawnRecipeMatches(archived({ ratePer1000: null, rateUnit: 'fl oz', gates: {} }), item({ ratePer1000: null, rateUnit: 'fl oz', rateSource: 'missing_rate' }))).toBe(false);
});

test.each([
  ['member without an assignment', {}, 'Silver', true],
  ['nonmember without a program', {}, null, false],
  ['nonmember whose assignment the plan resolved', { protocolKey: 'protocol', protocolVersion: '1', windowKey: 'june' }, null, true],
  ['nonmember with a partial assignment (window only, key/version wildcards)', { windowKey: 'june' }, null, false],
  ['nonmember with a partial assignment (key + window, no version)', { protocolKey: 'protocol', windowKey: 'june' }, null, false],
  ['member whose assignment the plan did NOT resolve (defaults gate off → calendar protocol)', { protocolKey: 'protocol', protocolVersion: '2', windowKey: 'september' }, 'Silver', false],
  ['assignment on a plan with no structured window', { protocolKey: 'protocol', protocolVersion: '1', windowKey: 'june' }, 'Silver', 'no-window'],
  ['member whose turf profile does NOT prove this property', {}, 'Silver', 'unproven'],
  ['member with the property proof never evaluated (defaults gates off)', {}, 'Silver', 'unevaluated'],
  ['legacy tier on an explicit one_time customer, no assignment', {}, 'Silver', 'one_time'],
  ['legacy tier on an explicit per_visit customer, no assignment', {}, 'Silver', 'per_visit'],
  ['legacy tier on an explicit per_application customer (membership lane)', {}, 'Silver', 'per_application'],
  ['legacy tier on an explicit annual_prepay customer (membership lane)', {}, 'Silver', 'annual_prepay'],
  ['explicit one_time customer whose appointment carries a COMPLETE assignment', { protocolKey: 'protocol', protocolVersion: '1', windowKey: 'june' }, 'Silver', 'one_time_assigned'],
])('ledger attribution — %s', (_label, assignment, tier, expected) => {
  const { plan } = fixture();
  plan.appointmentAssignment = assignment;
  plan.propertyGate.serviceTier = tier;
  if (expected === 'no-window') { plan.protocol.structured = null; expected = false; }
  if (expected === 'unproven') { plan.propertyGate.propertyMatchesProfile = false; expected = false; }
  if (expected === 'unevaluated') { plan.propertyGate.propertyMatchesProfile = null; expected = false; }
  if (['one_time', 'per_visit'].includes(expected)) { plan.propertyGate.billingMode = expected; expected = false; }
  if (['per_application', 'annual_prepay'].includes(expected)) { plan.propertyGate.billingMode = expected; expected = true; }
  if (expected === 'one_time_assigned') { plan.propertyGate.billingMode = 'one_time'; expected = true; }
  expect(lawnPlanAttributesVisit(plan)).toBe(expected);
  expect(lawnPlanAttributesVisit(null)).toBe(false);
});
