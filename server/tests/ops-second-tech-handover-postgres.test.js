/**
 * ops/agents/second-tech-handover.js on real PostgreSQL: the readers (series,
 * visits, visit-group join, catalog line) feeding the planner, and the proof that
 * the script's own connection refuses a write. Synthetic rows only, keyed to a
 * technician this suite creates, removed afterwards. 2099-07-06 is a Monday.
 *
 * DB-gated: skips without DATABASE_URL, runs in CI against the migrated database.
 */
const path = require('path');
const { randomUUID } = require('node:crypto');

const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

describeDb('second-tech-handover readers on PostgreSQL', () => {
  let knex;
  let handover;
  const run = randomUUID().slice(0, 8);
  const ownerId = randomUUID();
  const hireId = randomUUID();
  const customerIds = [];
  const extraTechIds = [];
  const visitGroupIds = [];
  const START = '2099-07-06';
  const TODAY = '2099-06-30';

  const tech = (id, extra = {}) => ({
    id, name: `Synthetic ${run} ${id.slice(0, 4)}`, email: `${id}@example.invalid`, password_hash: 'synthetic-not-a-login-hash',
    role: 'technician', active: true, employment_status: 'active', field_dispatchable: true, ...extra,
  });
  const customer = async () => {
    const id = randomUUID();
    await knex('customers').insert({ id, first_name: `Syn${run}`, last_name: 'Test', phone: `+1999${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` });
    customerIds.push(id);
    return id;
  };
  const row = (customerId, date, o = {}) => ({
    id: randomUUID(), customer_id: customerId, technician_id: ownerId, scheduled_date: date, service_type: 'Quarterly Pest Control',
    status: 'confirmed', ...o,
  });
  const series = async (customerId, o = {}) => {
    const parent = row(customerId, '2099-06-01', { is_recurring: true, recurring_ongoing: true, status: 'completed', ...o });
    await knex('scheduled_services').insert(parent);
    return parent;
  };
  const child = async (parent, date, o = {}) => {
    const r = row(parent.customer_id, date, { is_recurring: true, recurring_parent_id: parent.id, service_type: parent.service_type, ...o });
    await knex('scheduled_services').insert(r);
    return r;
  };

  beforeAll(async () => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
    handover = require(path.join(__dirname, '..', '..', 'ops', 'agents', 'second-tech-handover.js'));
    await knex('technicians').insert([tech(ownerId), tech(hireId, { work_days: [1, 2, 3, 4] })]);
  });

  afterAll(async () => {
    if (!knex) return;
    if (customerIds.length) {
      await knex('scheduled_services').whereIn('customer_id', customerIds).update({ visit_id: null });
      if (visitGroupIds.length) await knex('service_visits').whereIn('id', visitGroupIds).del();
      await knex('scheduled_services').whereIn('customer_id', customerIds).del();
      await knex('customers').whereIn('id', customerIds).del();
    }
    await knex('technicians').whereIn('id', [ownerId, hireId, ...extraTechIds]).del();
    await knex.destroy();
  });

  test('plans a pest series, skips lawn, a catalog tree & shrub row, a bait customer and grouped rows; reads nothing it should not', async () => {
    // Pest series: Mon-Fri open, a completed one, one before start, one grouped, one in a dissolved group.
    const pestCustomer = await customer();
    const pest = await series(pestCustomer);
    const open = [];
    for (const d of ['2099-07-06', '2099-07-07', '2099-07-08', '2099-07-09', '2099-07-10']) open.push(await child(pest, d));
    await child(pest, '2099-07-13', { status: 'completed' });
    await child(pest, '2099-07-14', { status: 'cancelled' });
    await child(pest, '2099-07-03');
    const openGroup = randomUUID();
    const dissolvedGroup = randomUUID();
    await knex('service_visits').insert([
      { id: openGroup, customer_id: pestCustomer, scheduled_date: '2099-07-15', stop_base_key: `syn-${run}:a`, created_by: 'test', status: 'open' },
      { id: dissolvedGroup, customer_id: pestCustomer, scheduled_date: '2099-07-16', stop_base_key: `syn-${run}:b`, created_by: 'test', status: 'dissolved' },
    ]);
    visitGroupIds.push(openGroup, dissolvedGroup);
    await child(pest, '2099-07-15', { visit_id: openGroup });
    const wasDissolved = await child(pest, '2099-07-16', { visit_id: dissolvedGroup }); // Thursday

    // Lawn series on the owner: skipped by name.
    const lawn = await series(await customer(), { service_type: 'Lawn Care Program' });
    await child(lawn, '2099-07-07', { service_type: 'Lawn Care Program' });

    // Pest-sounding label, but the catalog row says tree & shrub: the catalog wins (line-technician).
    const ts = await knex('services').where({ category: 'tree_shrub' }).first('id', 'service_key');
    const catalogLawn = await series(await customer(), { service_id: ts.id, service_key_snapshot: ts.service_key });
    await child(catalogLawn, '2099-07-07', { service_id: ts.id, service_key_snapshot: ts.service_key });

    // Termite-bait customer: the bait series and the customer's pest series both stay.
    const baitCustomer = await customer();
    const bait = await series(baitCustomer, { service_type: 'Quarterly Termite Active Bait Station Service' });
    await child(bait, '2099-07-08', { service_type: bait.service_type });
    const baitPest = await series(baitCustomer);
    await child(baitPest, '2099-07-08');

    const plan = await handover.planHandover(knex, { from: ownerId, to: hireId, start: START, today: TODAY });

    expect(plan.target).toBe(hireId);
    expect(plan.target_work_days_source).toBe('technician_row');
    // Mon-Thu 07-06..09 move, plus the dissolved-group Thursday 07-16; Friday 07-10 stays with the owner.
    expect(plan.would_change.series).toBe(1);
    expect(plan.would_change.visits).toBe(5);
    expect(plan.ids.series).toEqual([pest.id]);
    expect(new Set(plan.ids.visits)).toEqual(new Set([...open.slice(0, 4).map((r) => r.id), wasDissolved.id]));
    expect(plan.stays_off_day).toEqual({ visits: 1, by_weekday: { Fri: 1 } });
    expect(plan.skipped.grouped).toEqual({ series: 1, visits: 1 });
    expect(plan.skipped.before_start).toEqual({ series: 1, visits: 1 });
    // other_line: the lawn series, the catalog tree & shrub series, and the bait series itself (termite).
    expect(plan.skipped.other_line).toEqual({ series: 3, visits: 3 });
    // The bait customer's pest series stays with the owner.
    expect(plan.skipped.termite_bait_customer).toEqual({ series: 1, visits: 1, customers: 1 });
    // The completed 07-13 and cancelled 07-14 children are read as not open and never planned.
    expect(plan.skipped.not_open.visits).toBe(2);
    expect(plan.notices_to_suppress).toBe(5);
    expect(JSON.stringify(plan)).not.toMatch(/Syn|example\.invalid|\+1999/);
  });

  test("a series is classified by its CURRENT template (recurring_template_overrides), under the app's own gate", async () => {
    // Its own owner, so this plan holds only these rows.
    const ownerB = randomUUID();
    await knex('technicians').insert(tech(ownerB));
    extraTechIds.push(ownerB);
    const on = (o) => ({ technician_id: ownerB, ...o });
    // A pest series later changed to lawn: the parent keeps "Quarterly Pest Control".
    const changed = await series(await customer(), on({ recurring_template_overrides: JSON.stringify({ service_type: 'Lawn Care Program' }) }));
    await child(changed, '2099-07-06', on({ service_type: 'Lawn Care Program' }));
    // A WDO inspection series later changed to a bait program: its customer's pest series stays.
    const baitCustomer = await customer();
    const wdo = await series(baitCustomer, on({
      service_type: 'WDO Inspection',
      recurring_template_overrides: JSON.stringify({ service_type: 'Quarterly Termite Active Bait Station Service' }),
    }));
    await child(wdo, '2099-07-07', on({ service_type: 'Quarterly Termite Active Bait Station Service' }));
    const pest = await series(baitCustomer, on());
    await child(pest, '2099-07-08', on());

    const loadWith = (value) => {
      const prior = process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE;
      let mod;
      jest.isolateModules(() => {
        process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = value;
        mod = require(path.join(__dirname, '..', '..', 'ops', 'agents', 'second-tech-handover.js'));
      });
      if (prior === undefined) delete process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE; else process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = prior;
      return mod;
    };

    const current = await loadWith('true').planHandover(knex, { from: ownerB, start: START, today: TODAY });
    expect(current.template_overrides).toBe('applied');
    expect(current.would_change.visits).toBe(0);
    expect(current.skipped.other_line).toEqual({ series: 2, visits: 2 }); // the lawn change and the bait series
    expect(current.skipped.termite_bait_customer).toEqual({ series: 1, visits: 1, customers: 1 });

    // Gate off: the app ignores the overrides, and so does the plan.
    const historical = await loadWith('false').planHandover(knex, { from: ownerB, start: START, today: TODAY });
    expect(historical.template_overrides).toBe('not_applied_gate_off');
    expect(new Set(historical.ids.series)).toEqual(new Set([changed.id, pest.id]));
    expect(historical.skipped.other_line).toEqual({ series: 1, visits: 1 }); // the WDO inspection (termite line)
    expect(historical.skipped.termite_bait_customer).toBeUndefined();
  });

  test("series activity is the seeder's live-row test: an in-progress visit keeps a non-ongoing bait series live", async () => {
    const ownerC = randomUUID();
    await knex('technicians').insert(tech(ownerC));
    extraTechIds.push(ownerC);
    const on = (o) => ({ technician_id: ownerC, ...o });
    const baitCustomer = await customer();
    const bait = await series(baitCustomer, on({ service_type: 'Termite Bait Station Service', recurring_ongoing: false }));
    await child(bait, '2099-06-29', on({ service_type: bait.service_type, status: 'en_route' })); // yesterday, in progress
    const pest = await series(baitCustomer, on());
    await child(pest, '2099-07-06', on());

    const plan = await handover.planHandover(knex, { from: ownerC, start: START, today: TODAY });
    expect(plan.series.on_from).toBe(2); // the bait series counts as active only through its live row
    expect(plan.skipped.termite_bait_customer).toEqual({ series: 1, visits: 1, customers: 1 });
    expect(plan.would_change.visits).toBe(0);
  });

  test('without --to the plan says the target is not set and assumes Mon-Thu', async () => {
    const plan = await handover.planHandover(knex, { from: ownerId, start: START, today: TODAY });
    expect(plan.target).toBe('not set');
    expect(plan.target_work_days).toEqual(['Mon', 'Tue', 'Wed', 'Thu']);
    expect(plan.target_work_days_source).toBe('assumed_mon_thu');
  });

  test('an unknown technician id is refused, not planned', async () => {
    await expect(handover.planHandover(knex, { from: randomUUID(), start: START, today: TODAY })).rejects.toThrow('--from');
    await expect(handover.planHandover(knex, { from: ownerId, to: randomUUID(), start: START, today: TODAY })).rejects.toThrow('--to');
  });

  test("the script's own connection refuses a write", async () => {
    const conn = handover.readOnlyConn(process.env.DATABASE_URL);
    try {
      await conn.transaction(async (trx) => {
        await trx.raw('SET TRANSACTION READ ONLY');
        await expect(trx('technicians').where({ id: ownerId }).update({ name: 'changed' })).rejects.toThrow(/read-only/i);
      });
    } finally {
      await conn.destroy();
    }
    expect((await knex('technicians').where({ id: ownerId }).first('name')).name).toMatch(/^Synthetic/);
  });
});
