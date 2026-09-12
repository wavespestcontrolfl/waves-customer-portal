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
      whereIn: (_column, ids) => ({ forShare() { return this; }, select: () => Promise.resolve(String(table).startsWith('products_catalog') ? ids.map((id) => ({ id })) : []) }),
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
      whereIn: (_column, ids) => ({ forShare() { return this; }, select: () => Promise.resolve(String(table).startsWith('products_catalog') ? ids.map((id) => ({ id })) : []) }),
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

  test('an inferred rig is mix math only — never recorded as equipment used (Codex #4124 r2 P1)', async () => {
    const rig = { mixCalculator: { lawnSqft: 5000, carrierGalPer1000: 2, equipmentSystemId: 'tank-1', items: [] }, equipmentCalibration: { selected: { id: 'cal-1' } } };
    const run = async (plan) => {
      const inserted = [];
      await recordLawnProtocolCompletion(fakeTrx(inserted), { ...baseArgs, plan: { ...basePlan(), ...plan }, completionInput: { inventoryDeductions: [] } });
      return inserted[0];
    };
    const inferred = await run({ ...rig, equipmentCalibration: { ...rig.equipmentCalibration, inferred: true } });
    expect(inferred).toMatchObject({ equipment_system_id: null, calibration_id: null, carrier_gal_per_1000: 2 });
    const named = await run({ ...rig, equipmentCalibration: { ...rig.equipmentCalibration, inferred: false } });
    expect(named).toMatchObject({ equipment_system_id: 'tank-1', calibration_id: 'cal-1', carrier_gal_per_1000: 2 });
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
      whereIn: (_column, ids) => ({ forShare() { return this; }, select: () => Promise.resolve(String(table).startsWith('products_catalog') ? ids.map((id) => ({ id })) : []) }),
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
    // No attributed plan → no plan default to skip: 'prod-2' is kept on the
    // completion's metadata, never as a `skipped` actual Command Center counts.
    expect(actuals).toHaveLength(1);
    expect(actuals[0]).toMatchObject({ service_product_id: 'sp-1', status: 'applied', protocol_product_id: null, actual_amount: 7.5 });
    expect(JSON.parse(actuals[0].metadata)).toMatchObject({
      applicationMethod: 'spot_spray', areaValue: 2500, areaUnit: 'sqft', applicationArea: 'Front yard, Side yards', zoneIds: ['zone-a'],
    });
    expect(JSON.parse(row.metadata).unlistedSkippedProducts).toEqual([{ productId: 'prod-2', productName: 'Fixture pre-emergent' }]);
  });

  test('gate on: an unstamped visit freezes the property the plan proved, never null (codex #4113 P2)', async () => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const completions = [];
    await recordLawnProtocolCompletion(fakeTrx(completions, [], []), {
      service: { id: 'svc-7', customer_id: 'cust-7', property_id: null }, serviceRecord: { id: 'record-7' }, serviceProducts: [appliedProduct],
      plan: { protocol: null, propertyGate: { propertyMatchesProfile: true, addressProof: { propertyId: 'prop-9', propertyAddressKey: 'k', visitAddressKey: 'k', stamped: false } } },
      completionInput: { treatedSqft: 2500 },
    });
    expect(completions[0]).toMatchObject({ scheduled_service_id: 'svc-7', property_id: 'prop-9', protocol_key: null });
    // An explicit visit stamp still wins over the plan's resolution.
    completions.length = 0;
    await recordLawnProtocolCompletion(fakeTrx(completions, [], []), {
      service: oneTimeVisit, serviceRecord: { id: 'record-2' }, serviceProducts: [appliedProduct],
      plan: { protocol: null, propertyGate: { addressProof: { propertyId: 'prop-9' } } }, completionInput: { treatedSqft: 2500 },
    });
    expect(completions[0].property_id).toBe('prop-2');
  });

  test('protocol row lookups inside a transaction fail soft under their own savepoint, leaving the transaction usable (codex #4113 P2)', async () => {
    const { loadProtocolRows } = require('../services/lawn-protocol-completion');
    const raw = jest.fn(async () => {});
    const trx = Object.assign((_table) => ({ where: () => ({ first: () => Promise.reject(new Error('relation missing')) }) }), { isTransaction: true, raw });
    const rows = await loadProtocolRows(trx, { attributed: true, structured: { protocolKey: 'st_augustine', version: 1 }, window: { key: 'summer' } });
    expect(rows).toEqual({ protocolRow: null, windowRow: null, protocolProducts: [] });
    const statements = raw.mock.calls.map(([sql]) => sql.replace(/fail_soft_[0-9a-f]+/, 'sp'));
    expect(statements).toEqual(['SAVEPOINT sp', 'ROLLBACK TO SAVEPOINT sp', 'RELEASE SAVEPOINT sp']);
  });

  test('gate on: a removed substitute resolves to its original protocol product; a default from a plan that changed before submit is not this protocol\'s skip', async () => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const protocolRow = { id: 'pp-1', product_id: 'orig-1', catalog_product_name: 'Original iron', role: 'micronutrient', rate_per_1000: 3, rate_unit: 'fl oz' };
    const trx = (table) => ({
      whereIn: (_column, ids) => ({ forShare() { return this; }, select: () => Promise.resolve(String(table).startsWith('products_catalog') ? ids.map((id) => ({ id })) : []) }),
      where: () => ({ first: () => Promise.resolve({ id: 'row-1' }), del: () => Promise.resolve(0) }),
      leftJoin: () => ({ where: () => ({ select: () => Promise.resolve([protocolRow]) }) }),
      insert: (row) => {
        if (String(table).startsWith('lawn_protocol_service_completions')) {
          completionOut = row;
          return { onConflict: () => ({ merge: () => ({ returning: () => Promise.resolve([{ id: 'completion-10', ...row }]) }) }) };
        }
        actualsOut.push(row);
        return Promise.resolve([row]);
      },
    });
    const actualsOut = [];
    let completionOut = null;
    await recordLawnProtocolCompletion(trx, {
      service: oneTimeVisit, serviceRecord: { id: 'record-5' }, serviceProducts: [],
      plan: {
        protocol: { structured: {
          protocolKey: 'st_augustine', version: 1, window: { key: 'summer_insect', title: 'Summer', requiredTasks: [] },
          products: [{ productId: 'orig-1', defaultInPlan: true }, { productId: 'premium-1', defaultInPlan: false }, { productId: 'cond-1', defaultInPlan: true }],
        } },
        mixCalculator: { lawnSqft: 5000, carrierGalPer1000: 1, items: [
          { selected: true, product: { id: 'sub-1' }, substitution: { originalProductId: 'orig-1', substituteProductId: 'sub-1', reason: 'out of stock' } },
          { selected: true, product: { id: 'premium-1' } },
          { selected: false, product: { id: 'cond-1' } },
        ] },
      },
      completionInput: { skippedProducts: [
        { productId: 'sub-1', productName: 'Substitute iron' },
        // On the window but never a default of this visit: premium opt-in, unselected conditional.
        { productId: 'premium-1', productName: 'Premium add-on' },
        { productId: 'cond-1', productName: 'Conditional not selected' },
        // Shown by the form from the protocol active at load time, replaced before submit.
        { productId: 'stale-1', productName: 'Yesterday\'s default' },
      ] },
    });
    expect(actualsOut).toHaveLength(1);
    expect(actualsOut[0]).toMatchObject({ status: 'skipped', product_id: 'sub-1', protocol_product_id: 'pp-1', role: 'micronutrient', planned_rate_per_1000: 3 });
    expect(JSON.parse(actualsOut[0].metadata)).toEqual({ source: 'tech_closeout', reasonSupplied: false, substitution: { originalProductId: 'orig-1', substituteProductId: 'sub-1', reason: 'out of stock' } });
    expect(JSON.parse(completionOut.metadata).unlistedSkippedProducts).toEqual([
      { productId: 'premium-1', productName: 'Premium add-on' },
      { productId: 'cond-1', productName: 'Conditional not selected' },
      { productId: 'stale-1', productName: 'Yesterday\'s default' },
    ]);
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

  test('gate off: a legacy payload\'s snake-case treated_sqft is still the visit area (never the planned whole lawn)', async () => {
    const completions = [];
    await recordLawnProtocolCompletion(fakeTrx(completions, [], []), {
      service: oneTimeVisit, serviceRecord: { id: 'record-5' }, serviceProducts: [],
      plan: { protocol: { structured: { protocolKey: 'st_augustine', version: 1, window: { key: 'summer_insect', title: 'Summer', requiredTasks: [] } } }, mixCalculator: { lawnSqft: 5000, carrierGalPer1000: 1, items: [] } },
      completionInput: { treated_sqft: 1500 },
    });
    expect(completions[0]).toMatchObject({ treated_sqft: 1500, total_carrier_gal: 1.5 });
    expect(JSON.parse(completions[0].metadata)).toMatchObject({ treatedSqftSource: 'visit' });
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

describe('recordLawnProtocolCompletion — Codex #4113 round fixes', () => {
  afterEach(() => { delete process.env.GATE_LAWN_ACTUALS_LEDGER; });
  function fakeTrx(completions, actuals, catalogIds = null) {
    return (table) => ({
      whereIn: (_column, ids) => ({ forShare() { return this; }, select: () => Promise.resolve(String(table).startsWith('products_catalog')
        ? ids.filter((id) => (catalogIds || ids).includes(id)).map((id) => ({ id })) : []) }),
      where: () => ({ first: () => Promise.resolve(null), del: () => Promise.resolve(0) }),
      leftJoin: () => ({ where: () => ({ select: () => Promise.resolve([]) }) }),
      insert: (row) => {
        if (String(table).startsWith('lawn_protocol_service_completions')) {
          completions.push(row);
          return { onConflict: () => ({ merge: () => ({ returning: () => Promise.resolve([{ id: 'completion-x', ...row }]) }) }) };
        }
        actuals.push(row);
        return Promise.resolve([row]);
      },
    });
  }
  const visit = { id: 'svc-3', customer_id: 'cust-3', property_id: 'prop-3' };
  const insectPlan = {
    protocol: { structured: { protocolKey: 'st_augustine', version: 1, window: { key: 'summer_insect', title: 'Summer insect pressure', requiredTasks: [] },
      products: [{ productId: 'prod-2', defaultInPlan: true }] } },
    mixCalculator: { lawnSqft: 5000, carrierGalPer1000: 1, items: [{ selected: true, product: { id: 'prod-2', name: 'Fixture bifenthrin' } }] },
  };

  test('the structured window key drives the follow-up: an insect window records its scouting response and a seven-day recheck', async () => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const completions = [];
    await recordLawnProtocolCompletion(fakeTrx(completions, []), {
      service: visit, serviceRecord: { id: 'record-3' }, plan: insectPlan, completionInput: { treatedSqft: 2500 }, serviceDate: new Date('2026-06-15T16:00:00Z'),
    });
    expect(JSON.parse(completions[0].expected_response)).toMatchObject({ metric: 'active_insects_and_spreading_damage' });
    expect(completions[0].recheck_due_date).toBe('2026-06-22');
  });

  test('a skipped default whose catalog row was deleted after the plan build stays unlisted instead of a foreign-keyed insert', async () => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const completions = []; const actuals = [];
    await recordLawnProtocolCompletion(fakeTrx(completions, actuals, []), {
      service: visit, serviceRecord: { id: 'record-3' }, plan: insectPlan,
      completionInput: { treatedSqft: 2500, skippedProducts: [{ productId: 'prod-2', productName: 'Fixture bifenthrin' }] },
    });
    expect(actuals.filter((row) => row.status === 'skipped')).toEqual([]);
    expect(JSON.parse(completions[0].metadata).unlistedSkippedProducts).toEqual([{ productId: 'prod-2', productName: 'Fixture bifenthrin' }]);
    const kept = []; const keptActuals = [];
    await recordLawnProtocolCompletion(fakeTrx(kept, keptActuals, ['prod-2']), {
      service: visit, serviceRecord: { id: 'record-3' }, plan: insectPlan,
      completionInput: { treatedSqft: 2500, skippedProducts: [{ productId: 'prod-2', productName: 'Fixture bifenthrin' }] },
    });
    expect(keptActuals.filter((row) => row.status === 'skipped')).toHaveLength(1);
  });

  test.each([
    [1000, null, null], [-1, null, null], ['abc', null, null], [1.5, 1.5, 3.75],
  ])('a submitted carrier of %p is stored as %p per 1,000 (total %p): only finite positives the column can hold are forwarded', async (carrierGalPer1000, carrier, total) => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const completions = [];
    await recordLawnProtocolCompletion(fakeTrx(completions, []), {
      service: visit, serviceRecord: { id: 'record-3' }, plan: null, completionInput: { treatedSqft: 2500, carrierGalPer1000 },
    });
    expect(completions[0]).toMatchObject({ carrier_gal_per_1000: carrier, total_carrier_gal: total });
  });

  test('a plan whose protocol attribution is withheld still supplies the carrier of the visit\'s own verified rig', async () => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const completions = [];
    await recordLawnProtocolCompletion(fakeTrx(completions, []), {
      service: visit, serviceRecord: { id: 'record-3' },
      plan: { ...insectPlan, protocol: null, mixCalculator: { ...insectPlan.mixCalculator, carrierGalPer1000: 1.5, equipmentSystemId: 'rig-1' }, equipmentCalibration: { inferred: false, selected: { id: 'cal-1' } } },
      completionInput: { treatedSqft: 4000 },
    });
    expect(completions[0]).toMatchObject({ protocol_key: null, carrier_gal_per_1000: 1.5, total_carrier_gal: 6, equipment_system_id: 'rig-1' });
    expect(JSON.parse(completions[0].metadata).attribution).toBe('none');
  });

  test.each([
    ['an inferred rig', { equipmentSystemId: 'rig-1' }, { inferred: true }, false],
    ['no rig at all (protocol-window default carrier)', {}, {}, false],
    ['a cleared calibration', { equipmentSystemId: 'rig-1' }, { inferred: false }, true],
  ])('under the gate the plan carrier from %s is not recorded as a visit actual', async (_label, mix, calibration, calibrationCleared) => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const completions = [];
    await recordLawnProtocolCompletion(fakeTrx(completions, []), {
      service: visit, serviceRecord: { id: 'record-3' }, calibrationCleared,
      plan: { ...insectPlan, protocol: null, mixCalculator: { ...insectPlan.mixCalculator, carrierGalPer1000: 1.5, ...mix }, equipmentCalibration: calibration },
      completionInput: { treatedSqft: 4000 },
    });
    expect(completions[0]).toMatchObject({ carrier_gal_per_1000: null, total_carrier_gal: null });
    // A carrier the technician submitted is still the visit's actual.
    const submitted = [];
    await recordLawnProtocolCompletion(fakeTrx(submitted, []), {
      service: visit, serviceRecord: { id: 'record-3' }, calibrationCleared,
      plan: { ...insectPlan, protocol: null, mixCalculator: { ...insectPlan.mixCalculator, carrierGalPer1000: 1.5, ...mix }, equipmentCalibration: calibration },
      completionInput: { treatedSqft: 4000, carrierGalPer1000: 2 },
    });
    expect(submitted[0]).toMatchObject({ carrier_gal_per_1000: 2, total_carrier_gal: 8 });
  });

  test('a skipped default is named from the locked catalog row, never the request; the submitted name survives in the audit metadata', async () => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const actuals = []; const completions = [];
    const trx = fakeTrx(completions, actuals);
    const named = (table) => {
      const base = trx(table);
      if (!String(table).startsWith('products_catalog')) return base;
      return { ...base, whereIn: (_column, ids) => ({ forShare() { return this; }, select: () => Promise.resolve(ids.map((id) => ({ id, name: 'Fixture bifenthrin' }))) }) };
    };
    await recordLawnProtocolCompletion(named, {
      service: visit, serviceRecord: { id: 'record-3' }, plan: insectPlan,
      completionInput: { treatedSqft: 4000, skippedProducts: [{ productId: 'prod-2', productName: 'Unrelated herbicide' }] },
    });
    expect(actuals).toHaveLength(1);
    expect(actuals[0]).toMatchObject({ status: 'skipped', product_id: 'prod-2', product_name: 'Fixture bifenthrin' });
    expect(JSON.parse(actuals[0].metadata)).toMatchObject({ submittedProductName: 'Unrelated herbicide' });
  });

  test('an applied default is never also skipped through its approved substitute: the pair is one protocol product', async () => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const plan = {
      protocol: { structured: { protocolKey: 'st_augustine', version: 1, window: { key: 'summer_insect', title: 'Summer', requiredTasks: [] },
        products: [{ productId: 'orig-1', defaultInPlan: true }] } },
      mixCalculator: { lawnSqft: 5000, carrierGalPer1000: 1, items: [
        { selected: true, product: { id: 'sub-1' }, substitution: { originalProductId: 'orig-1', substituteProductId: 'sub-1', reason: 'out of stock' } },
      ] },
    };
    const applied = { id: 'sp-1', product_id: 'orig-1', product_name: 'Original iron', application_rate: 3, rate_unit: 'fl oz', total_amount: 7.5, amount_unit: 'fl oz', application_method: 'broadcast_spray', area_value: '4000', area_unit: 'sqft' };
    for (const [appliedRow, skippedId] of [[applied, 'sub-1'], [{ ...applied, product_id: 'sub-1', product_name: 'Substitute iron' }, 'orig-1']]) {
      const actuals = []; const completions = [];
      await recordLawnProtocolCompletion(fakeTrx(completions, actuals), {
        service: visit, serviceRecord: { id: 'record-3' }, plan, serviceProducts: [appliedRow],
        completionInput: { treatedSqft: 4000, skippedProducts: [{ productId: skippedId, productName: 'Iron' }] },
      });
      expect(actuals).toHaveLength(1);
      expect(actuals[0].status).not.toBe('skipped');
      expect(JSON.parse(completions[0].metadata).unlistedSkippedProducts).toEqual([]);
    }
  });

  test('a product the visit applied is never also a skipped default, whatever the client submitted', async () => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const actuals = []; const completions = [];
    const applied = { id: 'sp-2', product_id: 'prod-2', product_name: 'Fixture bifenthrin', application_rate: 3, rate_unit: 'fl oz', total_amount: 7.5, amount_unit: 'fl oz', application_method: 'broadcast_spray', area_value: '4000', area_unit: 'sqft' };
    await recordLawnProtocolCompletion(fakeTrx(completions, actuals), {
      service: visit, serviceRecord: { id: 'record-3' }, plan: insectPlan, serviceProducts: [applied],
      completionInput: { treatedSqft: 4000, skippedProducts: [{ productId: 'prod-2', productName: 'Fixture bifenthrin' }] },
    });
    expect(actuals).toHaveLength(1);
    expect(actuals[0].status).not.toBe('skipped');
    expect(JSON.parse(completions[0].metadata).unlistedSkippedProducts).toEqual([]);
  });

  test('withheld attribution also withholds the plan\'s substitution labels: the applied substitute is a plain application', async () => {
    process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
    const actuals = []; const completions = [];
    const applied = { id: 'sp-9', product_id: 'sub-1', product_name: 'Substitute iron', application_rate: 3, rate_unit: 'fl oz', total_amount: 7.5, amount_unit: 'fl oz', application_method: 'broadcast_spray', area_value: '4000', area_unit: 'sqft' };
    const plan = { ...insectPlan, protocol: null, mixCalculator: { ...insectPlan.mixCalculator, items: [{ selected: true, product: { id: 'sub-1' }, substitution: { originalProductId: 'prod-2', substituteProductId: 'sub-1', approvedBy: 'office' } }] } };
    await recordLawnProtocolCompletion(fakeTrx(completions, actuals), {
      service: visit, serviceRecord: { id: 'record-3' }, plan, serviceProducts: [applied], completionInput: { treatedSqft: 4000 },
    });
    expect(actuals[0]).toMatchObject({ status: 'applied', product_id: 'sub-1' });
    expect(JSON.parse(actuals[0].metadata).substitution ?? null).toBeNull();
    expect(JSON.parse(completions[0].metadata)).toMatchObject({ attribution: 'none', substitutions: [] });
  });
});
