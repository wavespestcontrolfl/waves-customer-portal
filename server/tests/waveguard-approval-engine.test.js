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
  const key = String(column).replace(/^(pc|sp|sr)\./, '');
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
      trackName: 'Track A - St. Augustine Full Sun',
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
