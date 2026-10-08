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
    return this.groupFilters.some(({ column, value }) => String(valueForColumn(row, column) || '') === String(value));
  }
}

function valueForColumn(row, column) {
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

  describe('the repeat-group rule keeps two named exemptions: Group 3 pre-emergents and the take-all Artavia pair (owner 2026-10-06)', () => {
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
