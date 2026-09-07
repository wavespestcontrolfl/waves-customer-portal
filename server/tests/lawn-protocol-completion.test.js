const {
  normalizeChecklist,
  missingRequiredTasks,
  recordLawnProtocolCompletion,
} = require('../services/lawn-protocol-completion');

describe('lawn protocol completion', () => {
  test('normalizes required checklist tasks and reports missing required items', () => {
    const checklist = normalizeChecklist({
      checklist: {
        chinch_float_test: true,
        irrigation_audit: { completed: false, note: 'Dry edge near driveway' },
      },
    }, ['chinch_float_test', 'irrigation_audit', 'problem_photos']);

    expect(checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'chinch_float_test', completed: true }),
      expect.objectContaining({ key: 'irrigation_audit', completed: false, note: 'Dry edge near driveway' }),
      expect.objectContaining({ key: 'problem_photos', completed: false }),
    ]));

    expect(missingRequiredTasks(checklist, ['chinch_float_test', 'irrigation_audit', 'problem_photos']))
      .toEqual([
        { key: 'irrigation_audit', label: 'irrigation audit' },
        { key: 'problem_photos', label: 'problem photos' },
      ]);
  });
});

describe('recordLawnProtocolCompletion checklist semantics', () => {
  // Fake trx: lookups resolve to nothing (protocol/window rows are optional)
  // and the completion upsert records its row so checklist fields can be
  // asserted. Table name keeps its "as" alias, hence startsWith.
  function fakeTrx(insertedCompletions, insertedActuals = [], deletes = []) {
    return (table) => ({
      whereIn: () => ({ select: () => Promise.resolve([]) }),
      where: (criteria) => ({
        first: () => Promise.resolve(null),
        del: () => { deletes.push({ table, criteria }); return Promise.resolve(0); },
      }),
      leftJoin: () => ({
        where: () => ({
          select: () => Promise.resolve([]),
        }),
      }),
      insert: (row) => {
        if (String(table).startsWith('lawn_protocol_service_completions')) {
          insertedCompletions.push(row);
          return {
            onConflict: () => ({
              merge: () => ({
                returning: () => Promise.resolve([{ id: 'completion-1', ...row }]),
              }),
            }),
          };
        }
        if (String(table).startsWith('lawn_protocol_product_actuals')) insertedActuals.push(row);
        return Promise.resolve([row]);
      },
    });
  }

  function basePlan() {
    return {
      protocol: {
        structured: {
          protocolKey: 'st_augustine',
          version: 1,
          window: {
            key: 'summer_insect',
            title: 'Summer insect pressure',
            requiredTasks: ['chinch_float_test', 'irrigation_audit'],
          },
        },
      },
      mixCalculator: { lawnSqft: 5000, carrierGalPer1000: 1, items: [] },
    };
  }

  const baseArgs = {
    service: { id: 'svc-1', customer_id: 'cust-1' },
    serviceRecord: { id: 'record-1' },
    serviceProducts: [],
  };

  test('per-basis recorded rates never land verbatim in actual_rate_per_1000 (codex PR #3419 r15)', async () => {
    const completions = [];
    const actuals = [];
    const trx = (table) => ({
      whereIn: () => ({ select: () => Promise.resolve([]) }),
      where: () => ({ first: () => Promise.resolve(null), del: () => Promise.resolve(0) }),
      leftJoin: () => ({ where: () => ({ select: () => Promise.resolve([]) }) }),
      insert: (row) => {
        if (String(table).startsWith('lawn_protocol_service_completions')) {
          completions.push(row);
          return {
            onConflict: () => ({
              merge: () => ({
                returning: () => Promise.resolve([{ id: 'completion-1', ...row }]),
              }),
            }),
          };
        }
        if (String(table).startsWith('lawn_protocol_product_actuals')) actuals.push(row);
        return Promise.resolve([row]);
      },
    });

    await recordLawnProtocolCompletion(trx, {
      ...baseArgs,
      plan: basePlan(),
      completionInput: { inventoryDeductions: [] },
      serviceProducts: [
        { id: 'sp-acre', product_name: 'Manor', application_rate: 0.25, rate_unit: 'oz/acre' },
        { id: 'sp-spot', product_name: 'Advion Ant Bait Gel', application_rate: 0.5, rate_unit: 'g/spot' },
        { id: 'sp-1k', product_name: 'LESCO T-Storm 2G Fungicide', application_rate: 1.5, rate_unit: 'lb/1000sf' },
        { id: 'sp-bare', product_name: 'Talstar', application_rate: 2, rate_unit: 'oz' },
      ],
    });

    expect(actuals).toHaveLength(4);
    const byId = new Map(actuals.map((a) => [a.service_product_id, a]));
    // /acre converts exactly (1 acre = 43.56 k sq ft), unit rebased.
    expect(byId.get('sp-acre').actual_rate_per_1000).toBeCloseTo(0.25 / 43.56, 4);
    expect(byId.get('sp-acre').actual_rate_unit).toBe('oz');
    // Other per-basis units have no honest per-1,000 representation.
    expect(byId.get('sp-spot').actual_rate_per_1000).toBeNull();
    expect(byId.get('sp-spot').actual_rate_unit).toBeNull();
    expect(JSON.parse(byId.get('sp-spot').metadata).recordedRateUnit).toBe('g/spot');
    // Per-1,000 and bare units pass through unchanged.
    expect(byId.get('sp-1k').actual_rate_per_1000).toBe(1.5);
    expect(byId.get('sp-1k').actual_rate_unit).toBe('lb/1000sf');
    expect(byId.get('sp-bare').actual_rate_per_1000).toBe(2);
    expect(byId.get('sp-bare').actual_rate_unit).toBe('oz');
  });

  test('no submitted checklist records empty checklist with zero missing tasks', async () => {
    const inserted = [];
    const completion = await recordLawnProtocolCompletion(fakeTrx(inserted), {
      ...baseArgs,
      plan: basePlan(),
      // The read-only completion flow posts lawnProtocolCompletion: null; the
      // route still passes inventoryDeductions through.
      completionInput: { inventoryDeductions: [] },
    });

    expect(completion).toBeTruthy();
    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(JSON.parse(row.checklist)).toEqual([]);
    expect(JSON.parse(row.missing_required_tasks)).toEqual([]);
    // Required tasks stay recorded for reference; the flow just didn't collect
    // a checklist against them.
    expect(JSON.parse(row.required_tasks)).toEqual(['chinch_float_test', 'irrigation_audit']);
    expect(JSON.parse(row.metadata).checklistCollected).toBe(false);
  });

  test('submitted checklist still evaluates missing required tasks', async () => {
    const inserted = [];
    await recordLawnProtocolCompletion(fakeTrx(inserted), {
      ...baseArgs,
      plan: basePlan(),
      completionInput: {
        checklist: { chinch_float_test: true },
        inventoryDeductions: [],
      },
    });

    const row = inserted[0];
    expect(JSON.parse(row.missing_required_tasks)).toEqual([
      { key: 'irrigation_audit', label: 'irrigation audit' },
    ]);
    expect(JSON.parse(row.metadata).checklistCollected).toBe(true);
  });
});

describe('recordLawnProtocolCompletion under GATE_LAWN_ACTUALS_LEDGER', () => {
  const { lawnActualsLedgerEnabled } = require('../services/lawn-protocol-completion');
  afterEach(() => { delete process.env.GATE_LAWN_ACTUALS_LEDGER; });

  function fakeTrx(completions, actuals, deletes) {
    return (table) => ({
      whereIn: () => ({ select: () => Promise.resolve([]) }),
      where: (criteria) => ({
        first: () => Promise.resolve(null),
        del: () => { deletes.push({ table, criteria }); return Promise.resolve(0); },
      }),
      leftJoin: () => ({ where: () => ({ select: () => Promise.resolve([]) }) }),
      insert: (row) => {
        if (String(table).startsWith('lawn_protocol_service_completions')) {
          completions.push(row);
          return { onConflict: () => ({ merge: () => ({ returning: () => Promise.resolve([{ id: 'completion-9', ...row }]) }) }) };
        }
        actuals.push(row);
        return Promise.resolve([row]);
      },
    });
  }
  const oneTimeVisit = { id: 'svc-2', customer_id: 'cust-2', property_id: 'prop-2' };
  const appliedProduct = {
    id: 'sp-1', product_id: 'prod-1', product_name: 'Fixture iron', application_rate: 3, rate_unit: 'fl oz',
    total_amount: 7.5, amount_unit: 'fl oz', application_method: 'spot_spray', area_value: '2500', area_unit: 'sqft',
    application_area: 'Front yard, Side yards', zone_ids: ['zone-a'],
  };

  test.each(['1', 'on', 'TRUE', 'yes'])('only the exact string true opens the dark gate — %s stays off', (value) => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = value;
    expect(lawnActualsLedgerEnabled()).toBe(false);
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    expect(lawnActualsLedgerEnabled()).toBe(true);
  });

  test('gate off: a visit without a structured protocol window leaves no row (legacy WaveGuard-only writer)', async () => {
    expect(lawnActualsLedgerEnabled()).toBe(false);
    const completions = [];
    const result = await recordLawnProtocolCompletion(fakeTrx(completions, [], []), {
      service: oneTimeVisit, serviceRecord: { id: 'record-2' }, plan: null, serviceProducts: [appliedProduct], completionInput: { treatedSqft: 2500 },
    });
    expect(result).toBeNull();
    expect(completions).toEqual([]);
  });

  test('gate on: a one-time lawn visit records actuals with no invented protocol, the frozen property, and each product\'s own area', async () => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const completions = []; const actuals = []; const deletes = [];
    const result = await recordLawnProtocolCompletion(fakeTrx(completions, actuals, deletes), {
      service: oneTimeVisit, serviceRecord: { id: 'record-2' }, plan: null, serviceProducts: [appliedProduct],
      completionInput: { treatedSqft: 2500, incompleteVisit: true, skippedProducts: [{ productId: 'prod-2', productName: 'Fixture pre-emergent' }] },
    });
    expect(result.id).toBe('completion-9');
    const row = completions[0];
    expect(row).toMatchObject({
      service_record_id: 'record-2', scheduled_service_id: 'svc-2', customer_id: 'cust-2', property_id: 'prop-2',
      lawn_protocol_id: null, protocol_key: null, protocol_version: null, window_key: null, window_title: null,
      treated_sqft: 2500, recheck_due_date: null,
    });
    expect(JSON.parse(row.expected_response)).toEqual({});
    expect(JSON.parse(row.watch_items)).toEqual([]);
    expect(JSON.parse(row.metadata)).toMatchObject({ attribution: 'none', treatedSqftSource: 'visit', incompleteVisit: true });
    // Idempotent: the completion's earlier actual rows are cleared in the same trx before re-insert.
    expect(deletes).toEqual([{ table: 'lawn_protocol_product_actuals', criteria: { lawn_protocol_service_completion_id: 'completion-9' } }]);
    expect(actuals).toHaveLength(2);
    expect(actuals[0]).toMatchObject({ service_product_id: 'sp-1', status: 'applied', protocol_product_id: null, actual_amount: 7.5 });
    expect(JSON.parse(actuals[0].metadata)).toMatchObject({
      applicationMethod: 'spot_spray', areaValue: 2500, areaUnit: 'sqft', applicationArea: 'Front yard, Side yards', zoneIds: ['zone-a'],
    });
    // 'prod-2' resolves to nothing (no catalog row, no substitution, no protocol product) → name kept, uuid FK left NULL.
    expect(actuals[1]).toMatchObject({ status: 'skipped', product_id: null, product_name: 'Fixture pre-emergent', skip_reason: 'Not applied' });
    expect(JSON.parse(actuals[1].metadata)).toEqual({ source: 'tech_closeout', reasonSupplied: false, substitution: null, unresolvedProductId: 'prod-2' });
  });

  test('gate on: a removed substitute resolves to its original protocol product', async () => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const protocolRow = { id: 'pp-1', product_id: 'orig-1', catalog_product_name: 'Original iron', role: 'micronutrient', rate_per_1000: 3, rate_unit: 'fl oz' };
    const trx = (table) => ({
      whereIn: () => ({ select: () => Promise.resolve([]) }),
      where: () => ({ first: () => Promise.resolve({ id: 'row-1' }), del: () => Promise.resolve(0) }),
      leftJoin: () => ({ where: () => ({ select: () => Promise.resolve([protocolRow]) }) }),
      insert: (row) => {
        if (String(table).startsWith('lawn_protocol_service_completions')) {
          return { onConflict: () => ({ merge: () => ({ returning: () => Promise.resolve([{ id: 'completion-10', ...row }]) }) }) };
        }
        actualsOut.push(row);
        return Promise.resolve([row]);
      },
    });
    const actualsOut = [];
    await recordLawnProtocolCompletion(trx, {
      service: oneTimeVisit, serviceRecord: { id: 'record-5' }, serviceProducts: [],
      plan: {
        protocol: { structured: { protocolKey: 'st_augustine', version: 1, window: { key: 'summer_insect', title: 'Summer', requiredTasks: [] } } },
        mixCalculator: { lawnSqft: 5000, carrierGalPer1000: 1, items: [{ substitution: { originalProductId: 'orig-1', substituteProductId: 'sub-1', reason: 'out of stock' } }] },
      },
      completionInput: { skippedProducts: [{ productId: 'sub-1', productName: 'Substitute iron' }] },
    });
    expect(actualsOut).toHaveLength(1);
    expect(actualsOut[0]).toMatchObject({ status: 'skipped', product_id: 'sub-1', protocol_product_id: 'pp-1', role: 'micronutrient', planned_rate_per_1000: 3 });
    expect(JSON.parse(actualsOut[0].metadata).substitution).toEqual({ originalProductId: 'orig-1', substituteProductId: 'sub-1', reason: 'out of stock' });
  });

  test('gate on: a missing visit area stays NULL instead of the planned turf area, and a plan-attributed visit keeps its protocol', async () => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const completions = [];
    await recordLawnProtocolCompletion(fakeTrx(completions, [], []), {
      service: oneTimeVisit, serviceRecord: { id: 'record-3' }, serviceProducts: [],
      plan: { protocol: { structured: { protocolKey: 'st_augustine', version: 1, window: { key: 'summer_insect', title: 'Summer insect pressure', requiredTasks: [] } } }, mixCalculator: { lawnSqft: 5000, carrierGalPer1000: 1, items: [] } },
      completionInput: { treatedSqft: null },
    });
    expect(completions[0]).toMatchObject({ protocol_key: 'st_augustine', window_key: 'summer_insect', treated_sqft: null, total_carrier_gal: null });
    expect(JSON.parse(completions[0].metadata)).toMatchObject({ attribution: 'protocol', treatedSqftSource: 'missing' });
  });

  test('gate off: the WaveGuard writer still substitutes the planned area and writes no skipped rows (unchanged while dark)', async () => {
    const completions = []; const actuals = [];
    await recordLawnProtocolCompletion(fakeTrx(completions, actuals, []), {
      service: oneTimeVisit, serviceRecord: { id: 'record-4' }, serviceProducts: [],
      plan: { protocol: { structured: { protocolKey: 'st_augustine', version: 1, window: { key: 'summer_insect', title: 'Summer', requiredTasks: [] } } }, mixCalculator: { lawnSqft: 5000, carrierGalPer1000: 1, items: [] } },
      completionInput: { skippedProducts: [{ productId: 'prod-2', productName: 'Removed default (defaults gates on, ledger gate off)' }] },
    });
    expect(actuals).toEqual([]);
    expect(completions[0]).toMatchObject({ treated_sqft: 5000, total_carrier_gal: 5 });
    expect(JSON.parse(completions[0].metadata)).toMatchObject({ attribution: 'protocol', treatedSqftSource: 'plan' });
  });
});
