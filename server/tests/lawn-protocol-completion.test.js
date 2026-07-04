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
