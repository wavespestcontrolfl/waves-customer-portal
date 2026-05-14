const {
  resolveStandardCompletionDefaults,
  CUSTOMER_INTERACTION_CHOICES,
} = require('../services/completion-defaults-resolver');
const { hashResolvedSnapshot } = require('../services/completion-attempts');

const FIXED_NOW = new Date('2026-05-14T15:00:00Z');

// Mock-knex that returns canned ops in order. Each .where()/.leftJoin()/
// .select()/.orderBy() chain is terminal at .first() or as a thenable
// awaited array. The resolver makes these queries in order:
//   1. scheduled_services join customers — .first()
//   2. protocol_templates active — .first()
//   3. protocol_template_products / areas / actions — three Promise.all
//      lookups, each returning an array
function makeKnex(ops) {
  const calls = [];
  const knex = jest.fn((table) => {
    const op = ops.shift();
    if (!op) throw new Error(`Unexpected table call: ${table}`);
    calls.push({ table, op });
    const chain = {
      where: jest.fn(() => chain),
      leftJoin: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      select: jest.fn(() => chain),
      first: jest.fn(async () => op.first),
      // Make the chain itself awaitable. `await knex(...).where().select()`
      // resolves to op.select (the array case); chains that terminate
      // with .first() use the explicit method above.
      then: (resolve, reject) => Promise.resolve(op.select ?? []).then(resolve, reject),
    };
    op.chain = chain;
    return chain;
  });
  knex.calls = calls;
  return knex;
}

const VENICE_SERVICE = {
  service_id: 'svc-1',
  service_type: 'General Pest Control',
  customer_id: 'cust-1',
  customer_city: 'Venice',
  first_name: 'Kevin',
  last_name: 'Cukrowicz',
  has_left_google_review: false,
};

const GP_PERIM_TEMPLATE = {
  id: 'tpl-1',
  protocol_key: 'ext_gp_perim',
  version: 'v1',
  display_name: 'Exterior General Pest Perimeter',
  service_type: 'General Pest Control',
  is_deterministic: true,
  attestation_template: 'I performed the {protocol_name} protocol on this visit: {products} applied to {areas}.',
  attestation_template_version: '2026.05',
};

const GP_PERIM_PRODUCTS = [
  { product_id: 'p1', product_name_snapshot: 'Demand CS',           rate_basis: 'label_compliant_default', rate: null, rate_unit: null, application_method: 'exterior perimeter band', sort_order: 1 },
  { product_id: 'p2', product_name_snapshot: 'Alpine WSG',          rate_basis: 'label_compliant_default', rate: null, rate_unit: null, application_method: 'exterior perimeter band', sort_order: 2 },
  { product_id: 'p3', product_name_snapshot: 'Advion WDG Granular', rate_basis: 'label_compliant_default', rate: null, rate_unit: null, application_method: 'granular broadcast',        sort_order: 3 },
];

const GP_PERIM_AREAS = [
  { area_key: 'perimeter',    area_label: 'Perimeter',    sort_order: 1 },
  { area_key: 'garage',       area_label: 'Garage',       sort_order: 2 },
  { area_key: 'entry_points', area_label: 'Entry points', sort_order: 3 },
];

const GP_PERIM_ACTIONS = [
  { action_key: 'apply_demand_cs',     action_label: 'Applied insect control — Demand CS', required: true,  sort_order: 1 },
  { action_key: 'webster_sweep',       action_label: 'Webster sweep — eaves',              required: true,  sort_order: 4 },
  { action_key: 'glue_boards_utility', action_label: 'Glue boards in garage',              required: false, sort_order: 5 },
];

function happyPathKnex(overrides = {}) {
  return makeKnex([
    { first: overrides.service ?? VENICE_SERVICE },
    { first: overrides.template ?? GP_PERIM_TEMPLATE },
    { select: overrides.products ?? GP_PERIM_PRODUCTS },
    { select: overrides.areas ?? GP_PERIM_AREAS },
    { select: overrides.actions ?? GP_PERIM_ACTIONS },
  ]);
}

describe('resolveStandardCompletionDefaults', () => {
  test('returns snapshot + stable hash for a deterministic protocol + valid customer interaction', async () => {
    const knex = happyPathKnex();
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex,
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot).toMatchObject({
      snapshotVersion: 'complete_service_one_tap_v1',
      visitOutcome: 'completed',
      completionSource: 'one_tap_completion',
      protocolDefaultsUsed: true,
      protocolTemplateId: 'tpl-1',
      protocolTemplateVersion: 'v1',
      protocolKey: 'ext_gp_perim',
      protocolName: 'Exterior General Pest Perimeter',
      techAttestationVersion: '2026.05',
      customerInteraction: 'not_home_full_access',
      customerInteractionSource: 'tech_confirmed_at_completion',
      sendSms: true,
      recapMode: 'templated_sms_async_report',
    });
    // Attestation text composed from template + product/area names.
    expect(result.snapshot.techAttestationText)
      .toBe('I performed the Exterior General Pest Perimeter protocol on this visit: Demand CS, Alpine WSG, and Advion WDG Granular applied to Perimeter, Garage, and Entry points.');
    // Hash is computed via the same helper as storeResolvedSnapshot,
    // but on the snapshot MINUS resolvedAt — see the dedicated test
    // below for why volatile timestamps are excluded.
    const { resolvedAt: _omit, ...hashable } = result.snapshot;
    expect(result.snapshotHash).toBe(hashResolvedSnapshot(hashable));
  });

  test('Venice address → review_gbp_resolved = "venice", routingReason includes service city', async () => {
    const knex = happyPathKnex();
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.snapshot.review.gbpResolved).toBe('venice');
    expect(result.snapshot.review.routingReason).toBe('service_city_venice');
    expect(result.snapshot.review.eligible).toBe(true);
    expect(result.snapshot.review.requestReview).toBe(true);
  });

  test('Sarasota address → review_gbp_resolved = "sarasota"', async () => {
    const knex = happyPathKnex({ service: { ...VENICE_SERVICE, customer_city: 'Sarasota' } });
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.snapshot.review.gbpResolved).toBe('sarasota');
    expect(result.snapshot.review.routingReason).toBe('service_city_sarasota');
  });

  test('North Port address → review_gbp_resolved = "venice" (south county all routes to venice GBP)', async () => {
    const knex = happyPathKnex({ service: { ...VENICE_SERVICE, customer_city: 'North Port' } });
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.snapshot.review.gbpResolved).toBe('venice');
    expect(result.snapshot.review.routingReason).toBe('service_city_north_port');
  });

  test('Unknown city falls back to lakewood-ranch GBP with default_fallback reason', async () => {
    const knex = happyPathKnex({ service: { ...VENICE_SERVICE, customer_city: 'Naples' } });
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.snapshot.review.gbpResolved).toBe('lakewood-ranch');
    expect(result.snapshot.review.routingReason).toBe('default_fallback');
  });

  test('customer with has_left_google_review = true → review.eligible = false', async () => {
    const knex = happyPathKnex({ service: { ...VENICE_SERVICE, has_left_google_review: true } });
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.snapshot.review.eligible).toBe(false);
    expect(result.snapshot.review.requestReview).toBe(false);
  });

  test('service not found → reason: service_not_found', async () => {
    const knex = makeKnex([{ first: undefined }]);
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'missing',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result).toEqual({ ok: false, reason: 'service_not_found' });
  });

  test('no active template for service_type → reason: no_active_protocol_template', async () => {
    const knex = makeKnex([
      { first: { ...VENICE_SERVICE, service_type: 'WaveGuard Lawn' } },
      { first: undefined },
    ]);
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_active_protocol_template');
    expect(result.serviceType).toBe('WaveGuard Lawn');
  });

  test('non-deterministic template → reason: protocol_not_deterministic', async () => {
    const knex = makeKnex([
      { first: VENICE_SERVICE },
      { first: { ...GP_PERIM_TEMPLATE, is_deterministic: false } },
    ]);
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('protocol_not_deterministic');
    expect(result.protocolTemplateId).toBe('tpl-1');
    expect(result.protocolTemplateVersion).toBe('v1');
  });

  test('missing customerInteractionChoice → reason: customer_interaction_required (with valid choices)', async () => {
    const knex = makeKnex([
      { first: VENICE_SERVICE },
      { first: GP_PERIM_TEMPLATE },
    ]);
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: null,
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('customer_interaction_required');
    expect(result.requiredChoices).toEqual([
      'tech_home_spoke_with_them',
      'not_home_full_access',
      'not_home_partial_access',
    ]);
    expect(result.requiredChoices).not.toContain('customer_specific_concern');
  });

  test('invalid customerInteractionChoice → reason: customer_interaction_invalid', async () => {
    const knex = makeKnex([
      { first: VENICE_SERVICE },
      { first: GP_PERIM_TEMPLATE },
    ]);
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'something_invented',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('customer_interaction_invalid');
    expect(result.validChoices).toEqual(CUSTOMER_INTERACTION_CHOICES);
  });

  test('customer_specific_concern → reason: customer_concern_requires_detailed_form', async () => {
    // A specific concern is incompatible with the one-tap attestation
    // — the tech needs to record the concern, which lives in the
    // detailed-form flow.
    const knex = makeKnex([
      { first: VENICE_SERVICE },
      { first: GP_PERIM_TEMPLATE },
    ]);
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'customer_specific_concern',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('customer_concern_requires_detailed_form');
  });

  test('deterministic template with no products → reason: protocol_misconfigured', async () => {
    const knex = happyPathKnex({ products: [] });
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('protocol_misconfigured');
    expect(result.protocolTemplateId).toBe('tpl-1');
  });

  test('deterministic template with no areas → reason: protocol_misconfigured', async () => {
    const knex = happyPathKnex({ areas: [] });
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('protocol_misconfigured');
  });

  test('snapshot hash excludes resolvedAt — preview-stale check survives wall-clock drift (codex P1)', async () => {
    // resolvedAt is computed from `now` and differs between every
    // preview→submit pair. If it leaked into the hash, the planned
    // expectedSnapshotHash handshake (PR #3) would 409 on every
    // legitimate submit even when nothing changed.
    const knex1 = happyPathKnex();
    const knex2 = happyPathKnex();
    const r1 = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: new Date('2026-05-14T15:00:00Z'),
      trx: knex1,
    });
    const r2 = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: new Date('2026-05-14T15:00:30Z'),    // 30s later
      trx: knex2,
    });
    expect(r1.snapshot.resolvedAt).not.toBe(r2.snapshot.resolvedAt);  // resolvedAt differs
    expect(r1.snapshotHash).toBe(r2.snapshotHash);                    // but hash matches
  });

  test('snapshot hash is stable across calls with identical inputs', async () => {
    const knex1 = happyPathKnex();
    const knex2 = happyPathKnex();
    const r1 = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex1,
    });
    const r2 = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex2,
    });
    expect(r1.snapshotHash).toBe(r2.snapshotHash);
  });

  test('snapshot hash changes when products change (preview-stale handshake)', async () => {
    const baseProducts = GP_PERIM_PRODUCTS;
    const changedProducts = [
      ...baseProducts.slice(0, 2),
      { ...baseProducts[2], product_name_snapshot: 'Tempo Ultra' },  // protocol upgraded
    ];
    const knex1 = happyPathKnex({ products: baseProducts });
    const knex2 = happyPathKnex({ products: changedProducts });
    const r1 = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex1,
    });
    const r2 = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex2,
    });
    expect(r1.snapshotHash).not.toBe(r2.snapshotHash);
  });

  test('different customer interaction → different attestation context (currently text unchanged, but hash differs via customerInteraction field)', async () => {
    const knex1 = happyPathKnex();
    const knex2 = happyPathKnex();
    const r1 = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex1,
    });
    const r2 = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'tech_home_spoke_with_them',
      now: FIXED_NOW,
      trx: knex2,
    });
    expect(r1.snapshotHash).not.toBe(r2.snapshotHash);
    expect(r1.snapshot.customerInteraction).toBe('not_home_full_access');
    expect(r2.snapshot.customerInteraction).toBe('tech_home_spoke_with_them');
  });

  test('snapshot.products preserves sort order and exposes both id and name', async () => {
    const knex = happyPathKnex();
    const result = await resolveStandardCompletionDefaults({
      serviceId: 'svc-1',
      customerInteractionChoice: 'not_home_full_access',
      now: FIXED_NOW,
      trx: knex,
    });
    expect(result.snapshot.products).toEqual([
      expect.objectContaining({ productId: 'p1', productName: 'Demand CS',          sortOrder: 1 }),
      expect.objectContaining({ productId: 'p2', productName: 'Alpine WSG',         sortOrder: 2 }),
      expect.objectContaining({ productId: 'p3', productName: 'Advion WDG Granular', sortOrder: 3 }),
    ]);
  });
});
