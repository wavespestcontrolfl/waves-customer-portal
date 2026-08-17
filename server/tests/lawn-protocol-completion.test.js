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
  function fakeTrx(insertedCompletions) {
    return (table) => ({
      where: () => ({
        first: () => Promise.resolve(null),
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
      where: () => ({ first: () => Promise.resolve(null) }),
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
