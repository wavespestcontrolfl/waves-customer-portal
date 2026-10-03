// Guards 20261003130000: the St. Augustine October fungicide row becomes
// conditional Medallion SC. Runs up()/down() against a small in-memory knex
// (no DB), and pins that protocols.json names the same product for the window.
const mig = require('../models/migrations/20261003130000_st_augustine_october_fungicide_medallion');
const protocols = require('../config/protocols.json');

const CATALOG = [{ id: 'cat-medallion', name: 'Medallion SC' }, { id: 'cat-velista', name: 'Velista' }];
const SEEDED_VELISTA = {
  id: 'row-velista', lawn_protocol_window_id: 'win-oct', product_id: 'cat-velista', product_name: 'Velista',
  role: 'fungicide', rate_per_1000: '0.5000', rate_unit: 'oz', carrier_gal_per_1000: 2, default_in_plan: false,
  application_mode: 'broadcast', gates: { frac: '7', trigger: 'large_patch_history' },
  annual_counter: {}, mixing: {}, report_copy: { role: 'fungicide' },
};

function memoryKnex(rows, { activeProtocol = true, audits = [] } = {}) {
  const protocol = activeProtocol ? { id: 'proto-sa' } : undefined;
  let seq = 0;
  const matches = (row, cond) => Object.entries(cond).every(([k, v]) => row[k] === v);
  const knex = (name) => {
    const ctx = { cond: {}, raw: null };
    const api = {
      where(cond) { ctx.cond = { ...ctx.cond, ...cond }; return api; },
      whereRaw(_sql, [value]) { ctx.raw = value; return api; },
      orderBy() { return api; },
      async first() {
        if (name === 'lawn_protocols') {
          return ctx.cond.grass_track === 'st_augustine' && ctx.cond.status === 'active' ? protocol : undefined;
        }
        if (name === 'lawn_protocol_windows') {
          return ctx.cond.window_key === mig.WINDOW_KEY && ctx.cond.lawn_protocol_id === 'proto-sa' ? { id: 'win-oct' } : undefined;
        }
        if (name === 'products_catalog') return CATALOG.find((c) => c.name.toLowerCase() === ctx.raw);
        return rows.find((row) => matches(row, ctx.cond));
      },
      then(resolve, reject) { return Promise.resolve(rows.filter((row) => matches(row, ctx.cond))).then(resolve, reject); },
      async update(fields) {
        const hit = rows.filter((row) => matches(row, ctx.cond));
        hit.forEach((row) => Object.assign(row, fields));
        return hit.length;
      },
      insert(row) {
        if (name === 'lawn_protocol_audit_log') { audits.push(row); return Promise.resolve([1]); }
        seq += 1;
        const created = { id: `row-new-${seq}`, ...row };
        rows.push(created);
        return { returning: async () => [{ id: created.id }] };
      },
      async del() {
        const keep = rows.filter((row) => !matches(row, ctx.cond));
        const removed = rows.length - keep.length;
        rows.splice(0, rows.length, ...keep);
        return removed;
      },
    };
    return api;
  };
  knex.schema = { hasTable: async () => true };
  knex.fn = { now: () => 'NOW()' };
  return knex;
}

const gatesOf = (row) => (typeof row.gates === 'string' ? JSON.parse(row.gates) : row.gates);

describe('St. Augustine October fungicide → Medallion SC', () => {
  test('rewrites the seeded Velista row in place: conditional, catalog rate, large patch history', async () => {
    const rows = [{ ...SEEDED_VELISTA }];
    await mig.up(memoryKnex(rows));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'row-velista', product_id: 'cat-medallion', product_name: 'Medallion SC', role: 'fungicide',
      rate_per_1000: 1, rate_unit: 'fl_oz', default_in_plan: false,
    });
    // Every gate key is rendered to the technician, so the row carries the two
    // real field gates and no migration bookkeeping.
    expect(gatesOf(rows[0])).toEqual({ frac: '12', trigger: 'large_patch_history' });
  });

  test('each write appends a product entry to the protocol audit log', async () => {
    const audits = [];
    const rows = [{ ...SEEDED_VELISTA }];
    await mig.up(memoryKnex(rows, { audits }));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ lawn_protocol_id: 'proto-sa', entity_type: 'product', entity_id: 'row-velista', action: 'update', actor_name: 'migration' });
    expect(JSON.parse(audits[0].before_snapshot)).toMatchObject({ product_name: 'Velista', rate_per_1000: '0.5000' });
    expect(JSON.parse(audits[0].after_snapshot)).toMatchObject({ product_name: 'Medallion SC', rate_per_1000: 1 });
    expect(JSON.parse(audits[0].metadata).migration).toBe(mig.MIGRATION);

    const inserted = [];
    const created = [];
    await mig.up(memoryKnex(created, { audits: inserted }));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ action: 'create', entity_id: created[0].id });

    await mig.up(memoryKnex(rows, { audits })); // idempotent: no second entry
    expect(audits).toHaveLength(1);
  });

  test('a Velista row an administrator remapped to another catalog product is never overwritten', async () => {
    const rows = [{ ...SEEDED_VELISTA, product_id: 'cat-other-fungicide' }];
    await mig.up(memoryKnex(rows));
    expect(rows[0]).toMatchObject({ product_name: 'Velista', product_id: 'cat-other-fungicide' });
    expect(rows.map((r) => r.product_name)).toEqual(['Velista', 'Medallion SC']);
    // The seed's own empty mapping (before the catalog link) still counts as seeded.
    const unlinked = [{ ...SEEDED_VELISTA, product_id: null }];
    await mig.up(memoryKnex(unlinked));
    expect(unlinked.map((r) => r.product_name)).toEqual(['Medallion SC']);
  });

  test('is idempotent', async () => {
    const rows = [{ ...SEEDED_VELISTA }];
    await mig.up(memoryKnex(rows));
    const once = JSON.stringify(rows);
    await mig.up(memoryKnex(rows));
    expect(JSON.stringify(rows)).toBe(once);
  });

  test('an edited Velista row is left alone and Medallion is added beside it', async () => {
    const edited = { ...SEEDED_VELISTA, rate_per_1000: '0.7000' };
    const rows = [edited];
    await mig.up(memoryKnex(rows));
    expect(rows.map((r) => r.product_name)).toEqual(['Velista', 'Medallion SC']);
    expect(rows[0].rate_per_1000).toBe('0.7000');
    expect(rows[1]).toMatchObject({ lawn_protocol_window_id: 'win-oct', default_in_plan: false, rate_per_1000: 1 });
  });

  test.each([
    ['gates', { gates: { frac: '7', trigger: 'large_patch_history', maxTempF: 85 } }],
    ['carrier volume', { carrier_gal_per_1000: 3 }],
    ['application mode', { application_mode: 'spot' }],
    ['mixing', { mixing: { order: 'last' } }],
    ['annual counter', { annual_counter: { counter: 'velista_apps' } }],
    ['plan flag', { default_in_plan: true }],
    ['unit', { rate_unit: 'fl_oz' }],
  ])('a Velista row with a customized %s is never overwritten', async (_label, edit) => {
    const rows = [{ ...SEEDED_VELISTA, ...edit }];
    const before = JSON.stringify(rows[0]);
    await mig.up(memoryKnex(rows));
    expect(JSON.stringify(rows[0])).toBe(before);
    expect(rows.map((r) => r.product_name)).toEqual(['Velista', 'Medallion SC']);
  });

  test('with no Velista row it inserts Medallion; with no active protocol it does nothing', async () => {
    const rows = [];
    await mig.up(memoryKnex(rows));
    expect(rows.map((r) => r.product_name)).toEqual(['Medallion SC']);
    const untouched = [{ ...SEEDED_VELISTA }];
    await mig.up(memoryKnex(untouched, { activeProtocol: false }));
    expect(untouched[0].product_name).toBe('Velista');
  });

  test('down is a non-destructive no-op: it never touches a row', async () => {
    const rows = [{ ...SEEDED_VELISTA }];
    const audits = [];
    await mig.up(memoryKnex(rows, { audits }));
    const after = JSON.stringify(rows);
    await mig.down(memoryKnex(rows, { audits }));
    expect(JSON.stringify(rows)).toBe(after);
    expect(audits).toHaveLength(1);
  });
});

describe('protocols.json agrees with the structured October row', () => {
  const october = protocols.lawn.st_augustine.visits.find((v) => v.month === 'Oct');

  test('October lists conditional Medallion SC and no Torque anywhere in the St. Augustine program', () => {
    expect(october.secondary).toMatch(/Medallion SC \(FRAC 12\) if large patch history/);
    expect(october.primary).not.toMatch(/fungicide|Medallion|Velista|Headway/i);
    expect(JSON.stringify(protocols.lawn.st_augustine)).not.toMatch(/torque sc/i);
  });

  test('the cost figures follow the file convention for the new lines', () => {
    // material_cost: the scheduled lines at the 10,000 sq ft basis, less Torque's
    // $7.50 reference-lawn line (x 10000/4500). conditional_cost: a quarter of
    // each gated fungicide line ($8.90 Medallion, $26.13 Headway).
    expect(Number(october.material_cost)).toBeCloseTo(39.69 - 7.5 * (10000 / 4500), 2);
    expect(Number(october.conditional_cost)).toBeCloseTo((8.9 + 26.13) / 4, 2);
  });
});
