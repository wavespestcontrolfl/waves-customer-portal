/**
 * 20261025153000: Cyper TC prints its label's two safety lines on the report card (owner 2026-10-25, "safety A").
 * up() fills only the row as it stood that day (not approved, no lines) and writes one audit event; a row filled
 * in since keeps its words. down() is a documented no-op. The report reads the lines through
 * approvedReportProductFacts.
 */
const migration = require('../models/migrations/20261025153000_cyper_tc_report_safety_lines');
const { approvedReportProductFacts } = require('../services/service-report/report-data');
const { customerCopyViolations } = require('../services/service-report/technician-report-copy');

function fakeKnex(db) {
  const knex = (table) => {
    let cond = {};
    const nulls = [];
    const match = (r) => Object.entries(cond).every(([k, v]) => r[k] === v) && nulls.every((k) => r[k] == null);
    const q = {
      where(c) { cond = { ...cond, ...c }; return q; },
      whereNull(col) { nulls.push(col); return q; },
      first: async () => { const hit = (db[table] || []).find(match); return hit ? { ...hit } : undefined; },
      update: async (patch) => {
        let n = 0;
        db[table] = db[table].map((r) => (match(r) ? (n += 1, { ...r, ...patch }) : r));
        return n;
      },
      insert(row) {
        db[table].push({ id: db[table].length + 1, ...row });
        return { returning: async () => [{ id: db[table].length }] };
      },
    };
    return q;
  };
  knex.fn = { now: () => 'now()' };
  knex.schema = { hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t) };
  return knex;
}

// The production row on 2026-10-25 (read-only check): added 09-26, never approved for the report.
const cyperRow = (over = {}) => ({
  id: 'cyper-1',
  name: 'Cyper TC',
  epa_reg_number: '53883-92',
  category: 'insecticide',
  product_type: null,
  active_ingredient: 'Cypermethrin 25.4%',
  customer_visibility: 'internal_only',
  content_status: 'draft',
  approved_for_service_report: false,
  approved_at: null,
  customer_precaution_summary: null,
  reentry_summary: null,
  ...over,
});
const TAURUS = Object.freeze({ id: 'taurus-1', name: 'Taurus SC', epa_reg_number: '53883-279', approved_for_service_report: true });
const world = (row = cyperRow()) => ({ products_catalog: [row, { ...TAURUS }], audit_log: [] });
const cyperOf = (db) => db.products_catalog.find((r) => r.id === 'cyper-1');

describe('Cyper TC report safety lines migration', () => {
  test('the two lines are the label words and pass the full customer copy screen', () => {
    expect(migration.LINES).toEqual({
      customer_precaution_summary: 'Per the product label: keep children and pets off treated areas until completely dry.',
      reentry_summary: 'Do not allow people or pets on treated surfaces until the spray has completely dried.',
    });
    for (const line of Object.values(migration.LINES)) expect(customerCopyViolations(line)).toEqual([]);
  });

  test('fills both lines and approves the row for the report once, with one audit event; the rest stays', async () => {
    const db = world();
    const knex = fakeKnex(db);
    await migration.up(knex);
    const first = { ...cyperOf(db) };
    await migration.up(knex);

    expect(cyperOf(db)).toEqual(first);
    expect(first).toMatchObject({ ...migration.LINES, approved_for_service_report: true, approved_at: 'now()', customer_visibility: 'internal_only', content_status: 'draft' });
    expect(db.products_catalog.find((r) => r.id === 'taurus-1')).toEqual(TAURUS);
    expect(db.audit_log).toHaveLength(1);
    expect(db.audit_log[0]).toMatchObject({
      actor_type: 'system',
      action: 'migration:20261025153000_cyper_tc_report_safety_lines:seeded',
      resource_type: 'products_catalog',
      resource_id: 'cyper-1',
      metadata: {
        before: { approved_for_service_report: false, customer_precaution_summary: null, reentry_summary: null },
        after: { approved_for_service_report: true, ...migration.LINES },
      },
    });

    // What a visit completed after the migration freezes: the card's two safety lines.
    const facts = approvedReportProductFacts(first);
    expect(facts).toMatchObject({ productType: 'pesticide', epaRegNumber: '53883-92' });
    expect(facts.precautionSummary).toBe(migration.LINES.customer_precaution_summary);
    expect(facts.reentrySummary).toBe(migration.LINES.reentry_summary);
    expect(approvedReportProductFacts(cyperRow())).toBeNull();
  });

  test('leaves a row someone already approved or filled in, and a database without the row', async () => {
    for (const over of [{ approved_for_service_report: true }, { customer_precaution_summary: 'Their own line.' }, { reentry_summary: 'Their own line.' }]) {
      const db = world(cyperRow(over));
      await migration.up(fakeKnex(db));
      expect(cyperOf(db)).toEqual(cyperRow(over));
      expect(db.audit_log).toEqual([]);
    }
    const empty = { products_catalog: [], audit_log: [] };
    await migration.up(fakeKnex(empty));
    expect(empty).toEqual({ products_catalog: [], audit_log: [] });
  });

  test('down() is a documented no-op', async () => {
    const db = world();
    await migration.up(fakeKnex(db));
    const after = JSON.parse(JSON.stringify(db));
    await migration.down(fakeKnex(db));
    expect(db).toEqual(after);
  });
});
