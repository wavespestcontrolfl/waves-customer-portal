const {
  evaluateWaveGuardManagerApprovals,
  managerApprovalSummary,
} = require('../services/waveguard-approval-engine');

class FakeQuery {
  constructor(table, data) {
    this.table = table;
    this.data = data;
    this.filters = [];
    this.groupFilters = [];
    this.limitCount = null;
    this.firstOnly = false;
  }

  join() { return this; }
  leftJoin() { return this; }
  orderBy() { return this; }
  select() { return this; }

  where(...args) {
    if (typeof args[0] === 'function') {
      const grouped = {
        where: (column, value) => {
          this.groupFilters.push({ column, value });
          return grouped;
        },
        orWhere: (column, value) => {
          this.groupFilters.push({ column, value });
          return grouped;
        },
        // The mixed-group token match: orWhereRaw('?? ~* ?', [column, regex]).
        orWhereRaw: (_sql, [column, regex]) => {
          this.groupFilters.push({ column, regex });
          return grouped;
        },
      };
      args[0].call(grouped);
      return this;
    }
    if (typeof args[0] === 'object') {
      Object.entries(args[0]).forEach(([column, value]) => this.filters.push({ column, op: '=', value }));
      return this;
    }
    const [column, opOrValue, maybeValue] = args;
    this.filters.push({
      column,
      op: maybeValue === undefined ? '=' : opOrValue,
      value: maybeValue === undefined ? opOrValue : maybeValue,
    });
    return this;
  }

  // The frozen-property scope: COALESCE(pah_scope.property_id, ss.property_id) = ? / IS NULL. A fake row carries the
  // visit's property_id and, for a ledgered row, the property frozen at completion (frozen_property_id).
  whereRaw(sql, bindings) {
    this.filters.push({ column: '__treated_property', op: /IS NULL/i.test(sql) ? 'null' : '=', value: Array.isArray(bindings) ? bindings[0] : undefined });
    return this;
  }

  whereNull(column) {
    this.filters.push({ column, op: 'null' });
    return this;
  }

  whereIn(column, values) {
    this.filters.push({ column, op: 'in', value: values });
    return this;
  }

  modify(fn) {
    fn(this);
    return this;
  }

  limit(n) {
    this.limitCount = n;
    return this;
  }

  first() {
    this.firstOnly = true;
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve(this.materialize()).then(resolve, reject);
  }

  catch(reject) {
    return Promise.resolve(this.materialize()).catch(reject);
  }

  materialize() {
    let rows = [];
    if (this.table === 'products_catalog') {
      rows = [...(this.data.productsCatalog || [])];
    } else if (this.table === 'customer_turf_profiles') {
      rows = [...(this.data.turfProfiles || [])];
    } else if (this.table === 'service_products as sp') {
      rows = [...(this.data.priorApplications || [])]
        .filter((row) => this.matchesGroupedResistanceFilter(row))
        .sort((a, b) => String(b.service_date).localeCompare(String(a.service_date)));
    }

    rows = rows.filter((row) => this.matchesFilters(row));
    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);
    return this.firstOnly ? rows[0] || null : rows;
  }

  matchesFilters(row) {
    return this.filters.every(({ column, op, value }) => {
      const rowValue = valueForColumn(row, column);
      if (op === 'null') return rowValue == null;
      if (op === 'in') return value.map(String).includes(String(rowValue));
      if (op === '<') return String(rowValue) < String(value);
      return String(rowValue) === String(value);
    });
  }

  matchesGroupedResistanceFilter(row) {
    if (!this.groupFilters.length) return true;
    return this.groupFilters.some(({ column, value, regex }) => (regex
      ? new RegExp(regex, 'i').test(String(valueForColumn(row, column) || ''))
      : String(valueForColumn(row, column) || '') === String(value)));
  }
}

function valueForColumn(row, column) {
  if (column === '__treated_property') return row.frozen_property_id ?? row.property_id;
  const key = String(column).replace(/^(pc|sp|sr|ss)\./, '');
  const aliases = {
    customer_id: row.customer_id,
    status: row.status,
    service_date: row.service_date,
    product_category: row.product_category,
    id: row.id,
    active: row.active,
  };
  return aliases[key] !== undefined ? aliases[key] : row[key];
}

function fakeKnex(data = {}) {
  return (table) => new FakeQuery(table, data);
}

function basePlan(overrides = {}) {
  return {
    protocol: {
      base: [{ product: { id: 'base' } }],
      conditional: [{ product: { id: 'conditional' } }],
    },
    mixCalculator: {
      items: [{ productId: 'base' }],
    },
    propertyGate: {
      trackName: 'St. Augustine',
      latestAssessment: { stressFlags: {} },
    },
    ...overrides,
  };
}

describe('waveguard approval engine', () => {
  test('requires approval for conditional, off-protocol, high-rate, and mismatched label-rate units', async () => {
    const result = await evaluateWaveGuardManagerApprovals(fakeKnex({
      productsCatalog: [
        { id: 'conditional', name: 'Celsius WG', category: 'herbicide', max_label_rate_per_1000: 0.17, rate_unit: 'oz' },
        { id: 'off', name: 'Unplanned Product', category: 'herbicide' },
        { id: 'high', name: 'Acelepryn Xtra', category: 'insecticide', max_label_rate_per_1000: 0.46, rate_unit: 'fl_oz' },
        { id: 'unit', name: 'Dismiss NXT', category: 'herbicide', max_label_rate_per_1000: 0.275, rate_unit: 'fl_oz' },
      ],
    }), {
      customerId: 'customer-1',
      service: { service_type: 'Lawn Care' },
      plan: basePlan(),
      serviceDate: '2026-05-04',
      products: [
        { productId: 'conditional', rate: 0.1, rateUnit: 'oz' },
        { productId: 'off' },
        { productId: 'high', rate: 0.6, rateUnit: 'fl oz' },
        { productId: 'unit', rate: 0.1, rateUnit: 'lb' },
      ],
    });

    expect(result.approvalRequired).toBe(true);
    expect(result.blocks.map((block) => block.code)).toEqual(expect.arrayContaining([
      'conditional_protocol_product_review',
      'off_protocol_product',
      'high_rate_application',
      'label_rate_unit_review',
    ]));
  });

  test('requires approval for PGR on stressed turf and St. Augustine dethatching', async () => {
    const result = await evaluateWaveGuardManagerApprovals(fakeKnex({
      productsCatalog: [
        { id: 'base', name: 'Primo Maxx', category: 'plant growth regulator' },
      ],
      turfProfiles: [
        { customer_id: 'customer-1', active: true, grass_type: 'St. Augustine', cultivar: 'Floratam' },
      ],
    }), {
      customerId: 'customer-1',
      service: { service_type: 'Lawn Care - dethatching' },
      plan: basePlan({
        propertyGate: {
          latestAssessment: { stressFlags: { drought_stress: true } },
        },
      }),
      serviceDate: '2026-05-04',
      products: [{ productId: 'base', name: 'Primo Maxx' }],
    });

    expect(result.blocks.map((block) => block.code)).toEqual(expect.arrayContaining([
      'pgr_on_stressed_turf',
      'st_augustine_dethatching',
    ]));
  });

  test('repeat resistance lookup finds the latest matching group, not just the latest product in the category', async () => {
    const result = await evaluateWaveGuardManagerApprovals(fakeKnex({
      productsCatalog: [
        { id: 'base', name: 'Celsius WG', category: 'herbicide', hrac_group: '2', hrac_group_secondary: '4' },
      ],
      priorApplications: [
        {
          customer_id: 'customer-1',
          status: 'completed',
          service_date: '2026-04-20',
          product_name: 'Dismiss NXT',
          product_category: 'herbicide',
          catalog_group: '14',
          catalog_group_secondary: null,
          hrac_group: '14',
        },
        {
          customer_id: 'customer-1',
          status: 'completed',
          service_date: '2026-03-10',
          product_name: 'Older Celsius WG',
          product_category: 'herbicide',
          catalog_group: '2',
          catalog_group_secondary: '4',
          hrac_group: '2',
          hrac_group_secondary: '4',
        },
      ],
    }), {
      customerId: 'customer-1',
      service: { service_type: 'Lawn Care' },
      plan: basePlan(),
      serviceDate: '2026-05-04',
      products: [{ productId: 'base' }],
    });

    expect(result.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'repeat_hrac_group',
        productName: 'Celsius WG',
      }),
    ]));
    expect(result.blocks.find((block) => block.code === 'repeat_hrac_group').message)
      .toContain('Older Celsius WG');
  });

  describe('GATE_LAWN_V13 off: composite groups, the Headway pair and protocol-row evidence are not in play (the engine as before)', () => {
    const savedGate = process.env.GATE_LAWN_V13;
    beforeEach(() => { delete process.env.GATE_LAWN_V13; });
    afterEach(() => { if (savedGate === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = savedGate; });
    const run = (productsCatalog, priorApplications, input, plan = basePlan()) => evaluateWaveGuardManagerApprovals(fakeKnex({ productsCatalog, priorApplications }), {
      customerId: 'customer-1', service: { service_type: 'Lawn Care' }, plan, serviceDate: input.serviceDate || '2026-06-10', products: [input],
    });
    const prior = (changes) => ({ customer_id: 'customer-1', status: 'completed', product_category: 'fungicide', catalog_group: '11', frac_group: '11', ...changes });
    const repeats = (result) => result.blocks.filter((block) => /^repeat_|rotation_approval$/.test(block.code)).map((block) => block.code);
    const ARTAVIA = { id: 'base', name: 'Artavia 2 SC (Azoxy)', category: 'fungicide', frac_group: '11' };
    const HEADWAY = { id: 'base', name: 'Headway Fungicide', category: 'fungicide', frac_group: '3 + 11' };
    const artavia = (date, extra = {}) => prior({ service_date: date, product_name: 'Artavia 2 SC (Azoxy)', ...extra });

    test('a composite group is one string: Headway (3 + 11) after Artavia (11) is not read as a group 11 repeat, and the group list is the single field', () => {
      const { productGroups } = require('../services/waveguard-approval-engine');
      expect(productGroups(HEADWAY)).toEqual([['frac', '3 + 11']]);
    });

    test('Artavia then Headway raises no composite finding with the gate off, however the take-all evidence reads', async () => {
      expect(repeats(await run([HEADWAY], [artavia('2026-05-11', { targets: ['Take-all'] })], { productId: 'base', targets: ['Take-all'] }))).toEqual([]);
    });

    test('Artavia twice keeps the recorded-target rule only: exempt on recorded take-all targets 28 days apart, a review when Fast Complete records none even on a take-all row', async () => {
      const now = { productId: 'base', serviceDate: '2026-06-10', targets: ['Take-all'] };
      expect(repeats(await run([ARTAVIA], [artavia('2026-05-13', { targets: ['Take-all'] })], now))).toEqual([]);
      // The protocol-row evidence fallback is the v13 program's: no recorded targets, no exemption.
      const row = { protocol: { structured: { products: [{ productId: 'base', role: 'fungicide_spot', gates: { trigger: 'mapped_take_all_spring_2' } }] } } };
      expect(repeats(await run([ARTAVIA], [artavia('2026-05-13', { targets: ['Take-all'] })], { productId: 'base', targets: [] }, row))).toEqual(['fungicide_frac_rotation_approval']);
      expect(repeats(await run([ARTAVIA], [artavia('2026-05-13')], now))).toEqual(['fungicide_frac_rotation_approval']);
    });
  });

  describe('the repeat-group rule keeps two named exemptions: Group 3 pre-emergents and the take-all Artavia pair (owner 2026-10-06)', () => {
    // The composite groups, the Artavia-then-Headway pair and the property scoping are the v13 program's: gate on.
    const savedGate = process.env.GATE_LAWN_V13;
    beforeEach(() => { process.env.GATE_LAWN_V13 = 'true'; });
    afterEach(() => { if (savedGate === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = savedGate; });

    const run = (productsCatalog, priorApplications, input, plan = basePlan(), service = { service_type: 'Lawn Care' }) => evaluateWaveGuardManagerApprovals(fakeKnex({ productsCatalog, priorApplications }), {
      customerId: 'customer-1', service, plan, serviceDate: input.serviceDate || '2026-06-10', products: [input],
    });
    const prior = (changes) => ({ customer_id: 'customer-1', status: 'completed', product_category: 'herbicide', ...changes });
    const repeats = (result) => result.blocks.filter((block) => /^repeat_|rotation_approval$/.test(block.code));
    const DIMENSION = { id: 'base', name: 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide', category: 'herbicide', hrac_group: '3' };
    const ARTAVIA = { id: 'base', name: 'Artavia 2 SC (Azoxy)', category: 'fungicide', frac_group: '11' };
    const FUNGICIDE = { id: 'base', name: 'Gravex 20 EW', category: 'fungicide', frac_group: '7' };

    test('a Group 3 pre-emergent after a Group 3 pre-emergent is no approval block, by product text or by the protocol row role', async () => {
      const last = prior({ service_date: '2026-03-10', product_name: 'LESCO Stonewall 4FL Prodiamine', catalog_group: '3', hrac_group: '3' });
      expect(repeats(await run([DIMENSION], [last], { productId: 'base' }))).toEqual([]);
      const plain = { id: 'base', name: 'Mystery Granule', category: 'herbicide', hrac_group: '3' };
      expect(repeats(await run([plain], [last], { productId: 'base' })).map((b) => b.code)).toEqual(['repeat_hrac_group']);
      const plan = basePlan({ protocol: { ...basePlan().protocol, structured: { products: [{ productId: 'base', role: 'fall_pre_emergent_nutrition' }] } } });
      expect(repeats(await run([plain], [last], { productId: 'base' }, plan))).toEqual([]);
    });

    test('a non-pre-emergent Group 3 product still blocks', async () => {
      const last = prior({ service_date: '2026-03-10', product_name: 'Older post-emergent', catalog_group: '3', hrac_group: '3' });
      const post = { id: 'base', name: 'Some Post-Emergent', category: 'herbicide', hrac_group: '3' };
      expect(repeats(await run([post], [last], { productId: 'base' })).map((b) => b.code)).toEqual(['repeat_hrac_group']);
    });

    test('the second Artavia is exempt only when both applications carry take-all evidence, 28 to 45 days apart', async () => {
      const lastArtavia = (date, targets) => prior({ service_date: date, product_name: 'Artavia 2 SC (Azoxy)', product_category: 'fungicide', catalog_group: '11', frac_group: '11', targets });
      const pair = (date, last, now) => run([ARTAVIA], [lastArtavia(date, last)], { productId: 'base', serviceDate: '2026-06-10', targets: now });
      expect(repeats(await pair('2026-05-13', ['Take-all root rot'], ['take-all']))).toEqual([]);
      // Label spacing: 28 to 45 days between the two applications; 27 or 46 days is a normal repeat.
      for (const [date, exempt] of [['2026-05-14', false], ['2026-05-13', true], ['2026-04-26', true], ['2026-04-25', false]]) {
        const found = repeats(await pair(date, ['Take-all'], ['Take-all']));
        expect({ date, codes: found.map((b) => b.code) }).toEqual({ date, codes: exempt ? [] : ['fungicide_frac_rotation_approval'] });
      }
      // No evidence on either side, or on one side only: no exemption (the rule as before).
      for (const [last, now] of [[undefined, undefined], [['Take-all'], undefined], [undefined, ['Take-all']], [['Large patch'], ['Take-all']], [['Take-all'], ['Gray leaf spot']]]) {
        expect(repeats(await pair('2026-05-13', last, now)).map((b) => b.code)).toEqual(['fungicide_frac_rotation_approval']);
      }
      // Outside the window, or a different product of the same group, still blocks.
      expect(repeats(await pair('2026-03-10', ['Take-all'], ['Take-all'])).map((b) => b.code)).toEqual(['fungicide_frac_rotation_approval']);
      const other = prior({ service_date: '2026-05-13', product_name: 'Another Group 11 Fungicide', product_category: 'fungicide', catalog_group: '11', frac_group: '11', targets: ['Take-all'] });
      expect(repeats(await run([ARTAVIA], [other], { productId: 'base', targets: ['Take-all'] })).map((b) => b.code)).toEqual(['fungicide_frac_rotation_approval']);
    });

    test('the Headway catalog row (frac_group "3 + 11") reads as groups 3 and 11', () => {
      const { productGroups } = require('../services/waveguard-approval-engine');
      expect(productGroups({ name: 'Headway Fungicide', frac_group: '3 + 11' })).toEqual([['frac', '3'], ['frac', '11']]);
      expect(productGroups({ name: 'Artavia', frac_group: '11' })).toEqual([['frac', '11']]);
      expect(productGroups({ name: 'Headway Fungicide', frac_group: null })).toEqual([]);
    });

    test('a mixed-group field is a set: "3 + 11", "3/11", "11, 3" and "28+3A" compare by intersection', async () => {
      const groups = (frac) => ({ id: 'base', name: 'Mixed', category: 'fungicide', frac_group: frac });
      const last = prior({ service_date: '2026-05-13', product_name: 'Artavia 2 SC (Azoxy)', product_category: 'fungicide', catalog_group: '11', frac_group: '11' });
      for (const frac of ['3 + 11', '3/11', '11, 3', '11', '3 and 11']) {
        expect({ frac, codes: repeats(await run([groups(frac)], [last], { productId: 'base' })).map((b) => b.code) }).toEqual({ frac, codes: ['fungicide_frac_rotation_approval'] });
      }
      // No shared member: no repeat. "13" is not "3", "3A" is not "3".
      for (const frac of ['3', '3 + 7', '13', '3A + 7']) {
        expect({ frac, codes: repeats(await run([groups(frac)], [prior({ ...last, catalog_group: '11', frac_group: '11' })], { productId: 'base' })).map((b) => b.code) }).toEqual({ frac, codes: [] });
      }
      // The earlier application can be the mixed one: Headway (3 + 11) before Artavia (11).
      const mixedLast = prior({ service_date: '2026-05-13', product_name: 'Headway Fungicide', product_category: 'fungicide', catalog_group: '3 + 11', frac_group: '3 + 11' });
      expect(repeats(await run([ARTAVIA], [mixedLast], { productId: 'base' })).map((b) => b.code)).toEqual(['fungicide_frac_rotation_approval']);
    });

    test('Artavia (11) then Headway (3 + 11) is a repeat, and the take-all pair exemption applies on the same evidence and spacing; Headway first, a third pass or other targets are not exempt', async () => {
      const HEADWAY = { id: 'base', name: 'Headway Fungicide', category: 'fungicide', frac_group: '3 + 11' };
      const GROUPS = { 'Artavia 2 SC (Azoxy)': '11', 'Headway Fungicide': '3 + 11' };
      const first = (date, name = 'Artavia 2 SC (Azoxy)', targets = ['Take-all']) => prior({ service_date: date, product_name: name, product_category: 'fungicide', catalog_group: GROUPS[name], frac_group: GROUPS[name], targets });
      const now = { productId: 'base', serviceDate: '2026-06-10', targets: ['Take-all'] };
      const codes = async (history, input = now, product = HEADWAY) => repeats(await run([product], history, input)).map((b) => b.code);
      // Not a pair (no take-all evidence on the Headway pass): the group 11 repeat is found, once.
      expect(await codes([first('2026-05-13')], { ...now, targets: ['Gray leaf spot'] })).toEqual(['fungicide_frac_rotation_approval']);
      // Artavia 30 days before, both for take-all: the second pass of the pair, exempt.
      expect(await codes([first('2026-05-11')])).toEqual([]);
      // Artavia then HEADWAY is 30 to 45 days on every grass (the Headway label limits bermudagrass to one 3 fl oz
      // pass every 30 days): 28 and 29 days (and 27) are a normal review, 30 and 45 are exempt, 46 is a review.
      for (const date of ['2026-05-13', '2026-05-12', '2026-05-14']) expect(await codes([first(date)])).toEqual(['fungicide_frac_rotation_approval']);
      expect(await codes([first('2026-04-26')])).toEqual([]);
      expect(await codes([first('2026-04-25')])).toEqual(['fungicide_frac_rotation_approval']);
      // Artavia twice keeps its own label spacing, 28 days.
      expect(repeats(await run([ARTAVIA], [first('2026-05-13')], now))).toEqual([]);
      expect(await codes([first('2026-05-13', 'Artavia 2 SC (Azoxy)', ['Large patch'])])).toEqual(['fungicide_frac_rotation_approval']);
      // A third pass (Artavia, Headway, then Headway again) or Headway as the first pass: review.
      // (Headway after Headway repeats both of its groups, 3 and 11: two findings.)
      expect(await codes([first('2026-05-13', 'Headway Fungicide'), first('2026-04-15')])).toEqual(['fungicide_frac_rotation_approval', 'fungicide_frac_rotation_approval']);
      expect(await codes([first('2026-05-13', 'Headway Fungicide')])).toEqual(['fungicide_frac_rotation_approval', 'fungicide_frac_rotation_approval']);
      // Artavia after Headway is not the planned order; Artavia, Headway, Artavia is a third pass.
      expect(await codes([first('2026-05-13', 'Headway Fungicide')], now, ARTAVIA)).toEqual(['fungicide_frac_rotation_approval']);
      expect(await codes([first('2026-05-13', 'Headway Fungicide'), first('2026-04-15')], now, ARTAVIA)).toEqual(['fungicide_frac_rotation_approval']);
    });

    test('only the SECOND application of the seasonal pair is exempt: a third is a normal review', async () => {
      const artavia = (date, targets = ['Take-all']) => prior({ service_date: date, product_name: 'Artavia 2 SC (Azoxy)', product_category: 'fungicide', catalog_group: '11', frac_group: '11', targets });
      const now = { productId: 'base', serviceDate: '2026-06-10', targets: ['Take-all'] };
      // 2nd: one earlier take-all Artavia, 28 days back.
      expect(repeats(await run([ARTAVIA], [artavia('2026-05-13')], now))).toEqual([]);
      // 3rd: the 2nd is 30 days back and the 1st 60 days back, inside the season window: review.
      expect((repeats(await run([ARTAVIA], [artavia('2026-05-11'), artavia('2026-04-11')], now))).map((b) => b.code)).toEqual(['fungicide_frac_rotation_approval']);
      // 3rd at the far end of the spacing (45 days after the 2nd, 90 after the 1st): still a review.
      expect((repeats(await run([ARTAVIA], [artavia('2026-04-26'), artavia('2026-03-12')], now))).map((b) => b.code)).toEqual(['fungicide_frac_rotation_approval']);
      // An earlier pair from another season (outside the window) does not make this one a third.
      expect(repeats(await run([ARTAVIA], [artavia('2026-05-13'), artavia('2025-10-01')], now))).toEqual([]);
      // An earlier Artavia with no take-all target is not a take-all application.
      expect(repeats(await run([ARTAVIA], [artavia('2026-05-13'), artavia('2026-04-11', ['Large patch'])], now))).toEqual([]);
    });

    test('the pair is counted at the visit\'s own property: another property\'s spray never satisfies it', async () => {
      const artavia = (date, property_id) => prior({ service_date: date, product_name: 'Artavia 2 SC (Azoxy)', product_category: 'fungicide', catalog_group: '11', frac_group: '11', targets: ['Take-all'], property_id });
      const now = { productId: 'base', serviceDate: '2026-06-10', targets: ['Take-all'] };
      const at = (property) => ({ service_type: 'Lawn Care', property_id: property });
      const codes = async (history, service) => repeats(await run([ARTAVIA], history, now, basePlan(), service)).map((b) => b.code);
      // Property A's first spray makes property A's second the pair, and property B's first spray is a normal review.
      expect(await codes([artavia('2026-05-13', 'A')], at('A'))).toEqual([]);
      expect(await codes([artavia('2026-05-13', 'A')], at('B'))).toEqual(['fungicide_frac_rotation_approval']);
      // Another property's spray does not turn this property's second into a "third".
      expect(await codes([artavia('2026-05-13', 'A'), artavia('2026-04-11', 'B')], at('A'))).toEqual([]);
      // A history row that names no property satisfies a visit with a property no more than a visit with none does the reverse.
      expect(await codes([artavia('2026-05-13', undefined)], at('A'))).toEqual(['fungicide_frac_rotation_approval']);
      expect(await codes([artavia('2026-05-13', undefined)], { service_type: 'Lawn Care' })).toEqual([]);
      expect(await codes([artavia('2026-05-13', 'A')], { service_type: 'Lawn Care' })).toEqual(['fungicide_frac_rotation_approval']);
    });

    test('every other same-group repeat behaves as on main, whatever targets were recorded; the finding keeps what was read', async () => {
      const last = prior({ service_date: '2026-05-13', product_name: 'Older Gravex', product_category: 'fungicide', catalog_group: '7', frac_group: '7', targets: ['Large patch'] });
      for (const targets of [undefined, ['Gray leaf spot'], ['Large patch']]) {
        const result = await run([FUNGICIDE], [last], { productId: 'base', targets });
        expect(repeats(result).map((b) => b.code)).toEqual(['fungicide_frac_rotation_approval']);
      }
      const result = await run([FUNGICIDE], [last], { productId: 'base', targets: ['gray leaf spot'] });
      expect(repeats(result)[0].evidence).toEqual({ groupType: 'frac', groupValue: '7', lastProduct: 'Older Gravex', lastDate: '2026-05-13', targets: ['gray leaf spot'], lastTargets: ['large patch'] });
      const summary = managerApprovalSummary({ reasonCode: 'x' }, result.blocks, { technicianId: 't', role: 'admin' });
      expect(summary.blocks[0].evidence).toMatchObject({ groupType: 'frac', lastProduct: 'Older Gravex' });
    });
  });

  test('strict mode throws on a failed read instead of reading it as "nothing to block" (job-card hook P1)', async () => {
    const failing = () => Promise.reject(new Error('db down'));
    const knex = (table) => {
      if (table === 'products_catalog') return { whereIn: () => failing() };
      return { where: () => ({ first: () => failing() }) };
    };
    const input = { customerId: 'c1', service: {}, plan: {}, products: [{ productId: 'p1', rate: 1, rateUnit: 'oz' }], serviceDate: '2026-09-04' };
    await expect(evaluateWaveGuardManagerApprovals(knex, { ...input, strict: true })).rejects.toThrow('db down');
    // The lenient default (closeout, plan engine) is unchanged.
    await expect(evaluateWaveGuardManagerApprovals(knex, input)).resolves.toMatchObject({ blocks: [] });
  });

  test('manager approval summary stores actor and block metadata only', () => {
    const summary = managerApprovalSummary(
      { reasonCode: 'label_review_completed', note: 'Reviewed by manager' },
      [{ code: 'high_rate_application', message: 'Rate too high', productId: 'p1', productName: 'Acelepryn Xtra' }],
      { technicianId: 'tech-1', role: 'admin' }
    );

    expect(summary).toMatchObject({
      reasonCode: 'label_review_completed',
      note: 'Reviewed by manager',
      approvedByTechnicianId: 'tech-1',
      approvedByRole: 'admin',
      blocks: [{ code: 'high_rate_application', message: 'Rate too high', productId: 'p1', productName: 'Acelepryn Xtra' }],
    });
    expect(summary.approvedAt).toEqual(expect.any(String));
  });
});
