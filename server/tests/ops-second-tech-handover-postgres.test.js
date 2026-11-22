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
  const zipRows = [];
  const START = '2099-07-06';
  const TODAY = '2099-06-30';
  // A run that leaves termite out: bait customers stay whole with the owner (the 2026-10-25 rule). A default run moves them (owner 2026-11-21).
  const NO_TERMITE = ['general', 'rodent', 'mosquito'];

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
    if (zipRows.length) await knex('territory_zips').whereIn('zip', zipRows).del();
    await knex('technicians').whereIn('id', [ownerId, hireId, ...extraTechIds]).del();
    await knex.destroy();
  });

  test('plans a pest series, skips lawn, a catalog tree & shrub row, a bait customer (a run that leaves termite out) and grouped rows; reads nothing it should not', async () => {
    // Pest series: Mon-Thu open, a Friday after the 13-week weekend-customer window (dates before 2099-10-05 are
    // inside it), a completed one, one before start, one grouped, one in a dissolved group.
    const pestCustomer = await customer();
    const pest = await series(pestCustomer);
    const open = [];
    for (const d of ['2099-07-06', '2099-07-07', '2099-07-08', '2099-07-09', '2099-10-09']) open.push(await child(pest, d));
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

    const plan = await handover.planHandover(knex, { from: ownerId, to: hireId, start: START, today: TODAY, lines: NO_TERMITE });

    expect(plan.target).toBe(hireId);
    expect(plan.target_work_days_source).toBe('technician_row');
    // Mon-Thu 07-06..09 move, plus the dissolved-group Thursday 07-16. Friday 10-09 stays with the owner as one visit: it is
    // after the window, so the customer is not kept whole (owner 2026-10-28, question 1 = C).
    expect(plan.would_change.series).toBe(1);
    expect(plan.would_change.visits).toBe(5);
    expect(plan.ids.series).toEqual([pest.id]);
    expect(new Set(plan.ids.visits)).toEqual(new Set([...open.slice(0, 4).map((r) => r.id), wasDissolved.id]));
    expect(plan.stays_off_day).toEqual({ visits: 1, by_weekday: { Fri: 1 } });
    expect(plan.skipped.off_day_customer).toBeUndefined();
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
    // A pest series later changed to lawn: the parent keeps "Quarterly Pest Control". Its visit ahead was created
    // before the change and keeps the old service (a visit is read by its OWN service, whatever the gate).
    const changed = await series(await customer(), on({ recurring_template_overrides: JSON.stringify({ service_type: 'Lawn Care Program' }) }));
    await child(changed, '2099-07-06', on());
    // A WDO inspection series later changed to a bait program: its customer's pest series stays.
    const baitCustomer = await customer();
    const wdo = await series(baitCustomer, on({
      service_type: 'WDO Inspection',
      recurring_template_overrides: JSON.stringify({ service_type: 'Quarterly Termite Active Bait Station Service' }),
    }));
    await child(wdo, '2099-07-07', on({ service_type: 'WDO Inspection' }));
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

    const current = await loadWith('true').planHandover(knex, { from: ownerB, start: START, today: TODAY, lines: NO_TERMITE });
    expect(current.template_overrides).toBe('applied');
    expect(current.would_change.visits).toBe(0);
    expect(current.skipped.other_line).toEqual({ series: 2, visits: 2 }); // the lawn change and the bait series
    expect(current.skipped.termite_bait_customer).toEqual({ series: 1, visits: 1, customers: 1 });

    // Gate off: the app ignores the overrides, and so does the plan.
    const historical = await loadWith('false').planHandover(knex, { from: ownerB, start: START, today: TODAY, lines: NO_TERMITE });
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

    const plan = await handover.planHandover(knex, { from: ownerC, start: START, today: TODAY, lines: NO_TERMITE });
    expect(plan.series.on_from).toBe(2); // the bait series counts as active only through its live row
    expect(plan.skipped.termite_bait_customer).toEqual({ series: 1, visits: 1, customers: 1 });
    expect(plan.would_change.visits).toBe(0);
  });

  test('a pest series whose visits carry a termite bait add-on marks its customer (how pest-plus-bait is sold)', async () => {
    const ownerD = randomUUID();
    await knex('technicians').insert(tech(ownerD));
    extraTechIds.push(ownerD);
    const on = (o) => ({ technician_id: ownerD, ...o });
    const baitCustomer = await customer();
    const pest = await series(baitCustomer, on());
    const visitWithBait = await child(pest, '2099-07-06', on());
    await knex('scheduled_service_addons').insert({ scheduled_service_id: visitWithBait.id, service_name: 'Termite Bait Station Service', service_key_snapshot: 'termite_bait' });
    const rodentCustomer = await customer();
    const rodentPest = await series(rodentCustomer, on());
    const visitWithRodentBait = await child(rodentPest, '2099-07-07', on());
    await knex('scheduled_service_addons').insert({ scheduled_service_id: visitWithRodentBait.id, service_name: 'Quarterly Rodent Bait Station Service', service_key_snapshot: 'rodent_bait_quarterly' });

    // A series whose first visit (the parent row) was cancelled keeps its live children.
    const cancelledFirst = await series(await customer(), on({ status: 'cancelled' }));
    const liveChild = await child(cancelledFirst, '2099-07-08', on());
    // The same, with a bait add-on on that cancelled PARENT row: the scheduler still copies the parent's add-ons onto
    // each new visit, so this is a bait customer. An add-on on a cancelled CHILD visit marks nobody.
    const cancelledParentBait = await series(await customer(), on({ status: 'cancelled' }));
    await child(cancelledParentBait, '2099-07-08', on());
    await knex('scheduled_service_addons').insert({ scheduled_service_id: cancelledParentBait.id, service_name: 'Termite Bait Station Service', service_key_snapshot: 'termite_bait' });
    const cancelledChild = await child(cancelledFirst, '2099-07-09', on({ status: 'cancelled' }));
    await knex('scheduled_service_addons').insert({ scheduled_service_id: cancelledChild.id, service_name: 'Termite Bait Station Service', service_key_snapshot: 'termite_bait' });

    const plan = await handover.planHandover(knex, { from: ownerD, start: START, today: TODAY, lines: NO_TERMITE });
    expect(plan.skipped.termite_bait_customer).toEqual({ series: 2, visits: 2, customers: 2 });
    expect(plan.bait_customers_kept).toBe(2);
    expect(new Set(plan.ids.series)).toEqual(new Set([rodentPest.id, cancelledFirst.id]));
    expect(plan.ids.visits).toContain(liveChild.id);

    // The default run moves that pest series, bait add-on and all, under the GENERAL line. No termite series exists
    // here, and the bait add-on is still termite work: a hire set to Off for termite refuses the run.
    const hireD = randomUUID();
    await knex('technicians').insert(tech(hireD));
    extraTechIds.push(hireD);
    const args = { from: ownerD, to: hireD, start: START, today: TODAY };
    const moving = await handover.planHandover(knex, args);
    expect(moving.ids.series).toContain(pest.id);
    expect(moving.retemplate_by_line.termite).toBeUndefined();
    // The other customer's pest visit carries a rodent bait add-on: rodent work the hire must be able to take.
    expect(moving.capability_lines).toEqual(['general', 'rodent', 'termite']);
    await knex('technician_capabilities').insert({ technician_id: hireD, service_category: 'termite', capability_level: 'review_required', active: false });
    await expect(handover.planHandover(knex, args)).rejects.toMatchObject({ code: 'TARGET_CAPABILITY_OFF' });
    // Leaving termite out keeps the bait customer whole, so nothing of the Off line moves: allowed.
    const without = await handover.planHandover(knex, { ...args, lines: NO_TERMITE });
    expect(without.capability_lines).toEqual(['general', 'rodent']);
    expect(without.ids.series).not.toContain(pest.id);
    // An add-on of a line the run does not move keeps its visit with the owner: a sealing add-on in every run, the
    // rodent bait add-on in a run that leaves rodent out. A sealing add-on on a parent row keeps that series whole.
    const sealedVisit = await child(rodentPest, '2099-07-08', on());
    await knex('scheduled_service_addons').insert({ scheduled_service_id: sealedVisit.id, service_name: 'Rodent Exclusion', service_key_snapshot: 'rodent_exclusion' });
    const sealedSeries = await series(await customer(), on());
    await child(sealedSeries, '2099-07-09', on());
    await knex('scheduled_service_addons').insert({ scheduled_service_id: sealedSeries.id, service_name: 'Rodent Exclusion', service_key_snapshot: 'rodent_exclusion' });
    const withAddons = await handover.planHandover(knex, { ...args, lines: NO_TERMITE });
    expect(withAddons.ids.visits).toContain(visitWithRodentBait.id);
    expect(withAddons.ids.visits).not.toContain(sealedVisit.id);
    expect(withAddons.skipped.visit_other_line).toEqual({ series: 1, visits: 1 });
    expect(withAddons.skipped.addon_other_line).toEqual({ series: 1, visits: 1 });
    expect(withAddons.ids.retemplate).not.toContain(sealedSeries.id);
    const noRodent = await handover.planHandover(knex, { ...args, lines: ['general', 'mosquito'] });
    expect(noRodent.ids.visits).not.toContain(visitWithRodentBait.id);
    expect(noRodent.capability_lines).toEqual(['general']);

    // The customer mark decides, for both rules. Another owner's customer whose only bait add-on sits on a COMPLETED
    // visit of last month is a bait customer: a run without termite keeps them whole, and a run with termite needs
    // the hire's termite switch. With the switch on, the pest visit ahead moves.
    const ownerPast = randomUUID();
    await knex('technicians').insert(tech(ownerPast));
    extraTechIds.push(ownerPast);
    const past = (o) => ({ technician_id: ownerPast, ...o });
    const pastPest = await series(await customer(), past());
    const doneVisit = await child(pastPest, '2099-06-01', past({ status: 'completed' }));
    await knex('scheduled_service_addons').insert({ scheduled_service_id: doneVisit.id, service_name: 'Termite Bait Station Service', service_key_snapshot: 'termite_bait' });
    const pestOnly = await child(pastPest, '2099-07-06', past());
    const pastArgs = { from: ownerPast, to: hireD, start: START, today: TODAY };
    const pastKept = await handover.planHandover(knex, { ...pastArgs, lines: NO_TERMITE });
    expect(pastKept.bait_customers_kept).toBe(1);
    expect(pastKept.ids.series).not.toContain(pastPest.id);
    await expect(handover.planHandover(knex, pastArgs)).rejects.toMatchObject({ code: 'TARGET_CAPABILITY_OFF' });
    await knex('technician_capabilities').where({ technician_id: hireD, service_category: 'termite' }).update({ active: true });
    const pastPlan = await handover.planHandover(knex, pastArgs);
    expect(pastPlan.ids.visits).toContain(pestOnly.id);
    expect(pastPlan.bait_customers_moving).toBe(1);
    expect(pastPlan.capability_lines).toEqual(['general', 'termite']);
  });

  test('one appointment changed to another service moves by its own line, not its series line', async () => {
    const ownerV = randomUUID();
    const hireV = randomUUID();
    await knex('technicians').insert([tech(ownerV), tech(hireV, { work_days: [1, 2, 3, 4] })]);
    extraTechIds.push(ownerV, hireV);
    const on = (o) => ({ technician_id: ownerV, ...o });
    // A termite series. Three of its appointments were changed to another service for that appointment only.
    const termite = await series(await customer(), on({ service_type: 'Termite Monitoring Service' }));
    const own = await child(termite, '2099-07-06', on());
    const sealing = await child(termite, '2099-07-07', on({ service_type: 'Rodent Exclusion' }));
    const lawn = await child(termite, '2099-07-08', on({ service_type: 'Lawn Care Program' }));
    const trapping = await child(termite, '2099-07-09', on({ service_type: 'Rodent Trapping Service' }));

    const args = { from: ownerV, to: hireV, start: START, today: TODAY };
    const plan = await handover.planHandover(knex, args);
    expect(plan.ids.retemplate).toEqual([termite.id]);
    expect(new Set(plan.ids.visits)).toEqual(new Set([own.id, trapping.id]));
    expect(plan.ids.visits).not.toContain(sealing.id);
    expect(plan.ids.visits).not.toContain(lawn.id);
    expect(plan.skipped.visit_other_line).toEqual({ series: 1, visits: 2 });
    expect(plan.capability_lines).toEqual(['rodent', 'termite']);
    // The dry run counts each visit under its own line.
    expect(plan.would_change.by_line).toEqual({ termite: { series: 1, visits: 1 }, rodent: { series: 0, visits: 1 } });

    // The trapping visit is rodent work: a hire set to Off for rodent refuses the run, and a run that leaves rodent
    // out keeps that visit with the owner.
    await knex('technician_capabilities').insert({ technician_id: hireV, service_category: 'rodent', capability_level: 'review_required', active: false });
    await expect(handover.planHandover(knex, args)).rejects.toMatchObject({ code: 'TARGET_CAPABILITY_OFF' });
    const noRodent = await handover.planHandover(knex, { ...args, lines: ['general', 'mosquito', 'termite'] });
    expect(noRodent.ids.visits).toEqual([own.id]);
    expect(noRodent.capability_lines).toEqual(['termite']);
  });

  test('termite and WDO series move in every run, bait customers too; lawn stays; --zips limits; --to Off refuses', async () => {
    const ownerE = randomUUID();
    const hireE = randomUUID();
    await knex('technicians').insert([tech(ownerE), tech(hireE, { work_days: [1, 2, 3, 4] })]);
    extraTechIds.push(ownerE, hireE);
    await knex('territory_zips').insert({ zip: '99901', area: 'synthetic' });
    zipRows.push('99901');
    const on = (o) => ({ technician_id: ownerE, service_address_zip: '99901', ...o });
    const wdo = await series(await customer(), on({ service_type: 'WDO Inspection' }));
    await child(wdo, '2099-07-07', on({ service_type: wdo.service_type }));
    const spot = await series(await customer(), on({ service_type: 'Termite Spot Treatment Service' }));
    const spotVisit = await child(spot, '2099-07-08', on({ service_type: spot.service_type }));
    const baitCustomer = await customer();
    const bait = await series(baitCustomer, on({ service_type: 'Quarterly Termite Active Bait Station Service' }));
    const baitVisit = await child(bait, '2099-07-07', on({ service_type: bait.service_type }));
    const lawn = await series(await customer(), on({ service_type: 'Lawn Care Program' }));
    await child(lawn, '2099-07-07', on({ service_type: 'Lawn Care Program' }));
    const args = { from: ownerE, to: hireE, start: START, today: TODAY };

    // Default lines with --zips: both termite series and the bait series move; lawn does not.
    const territoryPlan = await handover.planHandover(knex, { ...args, zips: ['99901'] });
    expect(new Set(territoryPlan.ids.series)).toEqual(new Set([wdo.id, spot.id, bait.id]));
    expect(territoryPlan.would_change.by_line).toEqual({ termite: { series: 3, visits: 3 } });
    expect(territoryPlan.skipped.termite_bait_customer).toBeUndefined();
    expect(territoryPlan.bait_customers_moving).toBe(1);
    expect(territoryPlan.skipped.other_line).toEqual({ series: 1, visits: 1 }); // lawn

    // The same rows without --zips: the same series move (owner 2026-11-21); naming termite alone is accepted.
    const plain = await handover.planHandover(knex, args);
    expect(new Set(plain.ids.series)).toEqual(new Set([wdo.id, spot.id, bait.id]));
    expect(plain.ids.visits).toContain(baitVisit.id);
    expect(plain.bait_customers_moving).toBe(1);
    const termiteOnly = await handover.planHandover(knex, { ...args, lines: ['termite'] });
    expect(new Set(termiteOnly.ids.series)).toEqual(new Set([wdo.id, spot.id, bait.id]));

    // A run that leaves termite out: all three termite series stay (other_line), and the plan id differs.
    const noTermite = await handover.planHandover(knex, { ...args, lines: NO_TERMITE });
    expect(noTermite.ids.series).toEqual([]);
    expect(noTermite.skipped.other_line.series).toBe(4); // wdo, spot, bait, lawn
    expect(noTermite.bait_customers_moving).toBe(0);
    expect(noTermite.planId).not.toBe(plain.planId);

    // --to set to Off for termite: refused with a clear code. Other states, and an Off line with nothing to move, are not.
    const cap = (category, o) => knex('technician_capabilities').insert({ technician_id: hireE, service_category: category, ...o });
    await cap('mosquito', { capability_level: 'review_required', active: false });
    await cap('rodent', { capability_level: 'qualified', active: true });
    const withMosquitoOff = await handover.planHandover(knex, { ...args, zips: ['99901'] });
    expect(withMosquitoOff.planId).toBe(territoryPlan.planId); // the Off mosquito line has no series to move: no refusal, same plan
    await cap('termite', { capability_level: 'review_required', active: false });
    await expect(handover.planHandover(knex, { ...args, zips: ['99901'] })).rejects.toMatchObject({ code: 'TARGET_CAPABILITY_OFF' });
    await expect(handover.planHandover(knex, args)).rejects.toMatchObject({ code: 'TARGET_CAPABILITY_OFF' });
    // Leaving the line out of --lines is the way past it.
    const generalOnly = await handover.planHandover(knex, { ...args, zips: ['99901'], lines: ['general'] });
    expect(generalOnly.ids.series).toEqual([]);
    // A termite line set to review_required (the new-hire default) is allowed.
    await knex('technician_capabilities').where({ technician_id: hireE, service_category: 'termite' }).update({ active: true });
    const allowed = await handover.planHandover(knex, { ...args, zips: ['99901'] });
    expect(allowed.ids.visits).toContain(spotVisit.id);
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
