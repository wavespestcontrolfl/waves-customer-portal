// Real PostgreSQL transaction (rolled back): technician and vehicle cost cards (L11a,
// GATE_TECH_COST_RATES) on the migrated schema. Cards, a completed visit, calculateJobCost with
// the gate off and on, with and without a visit_gps_legs row, the in-effect rule in SQL, the
// no-update trigger and CHECKs, and the admin routes with their audit rows. All names are
// synthetic. DATABASE_URL-gated like the other *-postgres suites.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
let mockRole = 'admin';
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/ad-attribution-sync', () => ({
  syncCustomerAdAttribution: jest.fn().mockResolvedValue({}),
}));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: '11111111-1111-4111-8111-111111111111', role: mockRole };
      req.technicianId = '11111111-1111-4111-8111-111111111111';
      req.techRole = mockRole;
      return next();
    },
  };
});

const { randomUUID } = require('node:crypto');
const express = require('express');
const jobCosting = require('../services/job-costing');

jest.setTimeout(60000);
const GATE = 'GATE_TECH_COST_RATES';
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

postgres('technician and vehicle cost cards on the migrated schema', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  const OLD_GATE = process.env[GATE];

  // ---- fixtures: a W-2 technician paid $21.00 an hour with a vehicle, one hour on site ----
  let techId;
  let vehicleId;
  let visitId;
  let customerId;

  const addTechCard = (over = {}) => trx('technician_cost_cards').insert({
    technician_id: techId,
    effective_date: '2026-01-01',
    kind: 'w2',
    paid_hours_per_week: 40,
    paid_hours_per_day: 10,
    health_money_monthly: 200,
    retirement_pct: 2,
    workers_comp_pct: 4,
    paid_days_off_per_year: 15,
    vehicle_equipment_id: vehicleId,
    ...over,
  }).returning('*').then((r) => r[0]);
  const addVehicleCard = (over = {}) => trx('vehicle_cost_cards').insert({
    equipment_id: vehicleId,
    effective_date: '2026-01-01',
    loss_of_value_per_year: 6000,
    insurance_per_year: 2400,
    loan_interest_per_year: 1200,
    other_fixed_per_year: 600,
    fuel_per_mile: 0.15,
    upkeep_per_mile: 0.08,
    ...over,
  }).returning('*').then((r) => r[0]);
  const addVisit = async (over = {}) => {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id,
      customer_id: customerId,
      technician_id: techId,
      scheduled_date: '2026-10-26',
      service_type: 'Quarterly Pest Control Service',
      status: 'completed',
      estimated_price: 129,
      actual_start_time: '2026-10-26T14:00:00Z',
      actual_end_time: '2026-10-26T15:00:00Z',
      ...over,
    });
    return id;
  };
  const legsTableExists = async () => (await trx.raw("select to_regclass('visit_gps_legs') as t")).rows[0].t !== null;
  // The trip-link migration creates this table; on a branch without it, make a minimal one in the
  // rolled-back transaction, with the columns job costing reads.
  const ensureLegsTable = async () => {
    if (await legsTableExists()) return;
    await trx.raw(`create table visit_gps_legs (
      scheduled_service_id uuid primary key references scheduled_services(id) on delete cascade,
      leg_group_key text not null,
      status text not null,
      shared_stop_count integer not null default 1,
      drive_minutes numeric(8,2),
      drive_miles numeric(8,2)
    )`);
  };
  const addLeg = async (over = {}) => {
    await ensureLegsTable();
    const row = {
      scheduled_service_id: visitId, leg_group_key: visitId, status: 'matched', drive_minutes: 20, drive_miles: 8, ...over,
    };
    if (await trx.schema.hasColumn('visit_gps_legs', 'service_date')) row.service_date = row.service_date || '2026-10-26';
    if (await trx.schema.hasColumn('visit_gps_legs', 'algorithm_version')) row.algorithm_version = row.algorithm_version || 1;
    await trx('visit_gps_legs').insert(row);
  };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/api/admin/cost-cards', require('../routes/admin-cost-cards'));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
    });
  });
  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
    mockRole = 'admin';
    delete process.env[GATE];
    jobCosting._resetVisitGpsLegsCache();
    techId = randomUUID();
    vehicleId = randomUUID();
    customerId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Sample Tech', employment_type: 'w2', employment_status: 'active', pay_rate: '21.00' });
    await trx('equipment').insert({ id: vehicleId, name: 'Sample Truck', category: 'vehicle', status: 'active' });
    await trx('customers').insert({ id: customerId, first_name: 'Sample', last_name: 'Customer', phone: '+15555550100' });
    // The company rate in effect on the visit: $35 an hour and $6 a stop (what prod has).
    await trx('company_financials').insert({ effective_date: '2026-10-01', loaded_labor_rate: 35, drive_cost_per_stop: 6 });
    visitId = await addVisit();
  });
  afterEach(async () => {
    await trx.rollback();
    jobCosting._resetVisitGpsLegsCache();
    if (OLD_GATE === undefined) delete process.env[GATE]; else process.env[GATE] = OLD_GATE;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  // ---------------- schema ----------------

  describe('schema', () => {
    it('a card is never updated in place: a trigger refuses it', async () => {
      const card = await addTechCard();
      await expect(trx.transaction((sp) => sp('technician_cost_cards').where({ id: card.id }).update({ health_money_monthly: 1 })))
        .rejects.toThrow(/never changed in place/);
      const vehicle = await addVehicleCard();
      await expect(trx.transaction((sp) => sp('vehicle_cost_cards').where({ id: vehicle.id }).update({ fuel_per_mile: 1 })))
        .rejects.toThrow(/never changed in place/);
    });

    it.each([
      ['an unknown kind', { kind: 'contractor' }],
      ['an imputed card with no rate', { kind: 'imputed', imputed_hourly_rate: null }],
      ['an imputed card with a zero rate', { kind: 'imputed', imputed_hourly_rate: 0 }],
      ['retirement over 100%', { retirement_pct: 101 }],
      ['workers comp below 0%', { workers_comp_pct: -1 }],
      ['zero paid hours a week', { paid_hours_per_week: 0 }],
      ['zero paid hours a day', { paid_hours_per_day: 0 }],
      ['more than 120 paid days off', { paid_days_off_per_year: 121 }],
      ['a note over 500 characters', { note: 'x'.repeat(501) }],
    ])('a technician card with %s is refused', async (_label, over) => {
      await expect(trx.transaction(() => addTechCard(over))).rejects.toThrow(/check constraint/);
    });

    it('a vehicle card with a negative amount is refused', async () => {
      await expect(trx.transaction(() => addVehicleCard({ insurance_per_year: -1 }))).rejects.toThrow(/check constraint/);
    });

    it('a technician and a vehicle with cards cannot be deleted', async () => {
      await addTechCard();
      await addVehicleCard();
      await expect(trx.transaction((sp) => sp('technicians').where({ id: techId }).del())).rejects.toThrow(/foreign key/);
      await expect(trx.transaction((sp) => sp('equipment').where({ id: vehicleId }).del())).rejects.toThrow(/foreign key/);
    });

    it('the card in effect (SQL): greatest effective date on or before the day; tie newest created_at, then id', async () => {
      const { cardInEffect } = require('../services/tech-cost-rates');
      const a = await addTechCard({ effective_date: '2026-03-01', created_at: '2026-03-01T10:00:00Z' });
      await addTechCard({ effective_date: '2026-06-01', created_at: '2026-06-01T10:00:00Z' });
      const c = await addTechCard({ effective_date: '2026-06-01', created_at: '2026-06-02T10:00:00Z' });
      const pick = async (date) => (await cardInEffect(trx, 'technician_cost_cards', 'technician_id', techId, date))?.id || null;
      expect(await pick('2026-02-28')).toBeNull();
      expect(await pick('2026-03-01')).toBe(a.id);
      expect(await pick('2026-05-31')).toBe(a.id);
      expect(await pick('2026-06-01')).toBe(c.id);
      expect(await pick('2026-12-31')).toBe(c.id);
    });
  });

  // ---------------- job costing ----------------

  describe('calculateJobCost on a completed visit', () => {
    const costRow = async (id = visitId) => trx('job_costs').where({ scheduled_service_id: id }).first();
    const num = (v) => Number(v);

    it('gate off: $35 x 1 h labor and the $6 stop cost, even with cards on file', async () => {
      await addTechCard();
      await addVehicleCard();
      const res = await jobCosting.calculateJobCost(visitId, trx);
      expect(res.labor_cost).toBe(35);
      expect(res.drive_cost).toBe(6);
      expect(res.costRates).toBeUndefined();
      expect(num((await costRow()).labor_cost)).toBe(35);
      expect(num((await costRow()).drive_cost)).toBe(6);
    });

    it('gate on, no card: the same rows as gate off', async () => {
      const off = await jobCosting.calculateJobCost(visitId, trx);
      const offRow = await costRow();
      process.env[GATE] = 'true';
      const on = await jobCosting.calculateJobCost(visitId, trx);
      const onRow = await costRow();
      expect(on).toEqual(off);
      expect(num(onRow.labor_cost)).toBe(num(offRow.labor_cost));
      expect(num(onRow.drive_cost)).toBe(num(offRow.drive_cost));
      expect(num(onRow.total_cost)).toBe(num(offRow.total_cost));
    });

    it('gate on, a card, no visit_gps_legs table: 24 minutes and 11 miles', async () => {
      // Skip when the trip-link migration is already on this branch: then the table exists.
      if (await legsTableExists()) return;
      await addTechCard();
      await addVehicleCard();
      process.env[GATE] = 'true';
      const res = await jobCosting.calculateJobCost(visitId, trx);
      expect(res.costRates).toMatchObject({ driveMinutes: 24, driveMiles: 11, driveSource: 'default' });
      expect(res.labor_cost).toBe(38.15); // $27.25 x 84 minutes
      expect(res.drive_cost).toBe(9.92); // 11 miles x $0.23, plus $5.28 x 84 minutes
      const row = await costRow();
      expect(num(row.labor_cost)).toBe(38.15);
      expect(num(row.drive_cost)).toBe(9.92);
      expect(num(row.total_cost)).toBe(48.07);
    });

    it('gate on, the table exists but this visit has no row: the same defaults', async () => {
      await ensureLegsTable();
      await addTechCard();
      await addVehicleCard();
      process.env[GATE] = 'true';
      const res = await jobCosting.calculateJobCost(visitId, trx);
      expect(res.costRates).toMatchObject({ driveMinutes: 24, driveMiles: 11, driveSource: 'default' });
      expect(res.labor_cost).toBe(38.15);
    });

    it('gate on, a matched leg row: its drive minutes and miles', async () => {
      await addTechCard();
      await addVehicleCard();
      await addLeg();
      process.env[GATE] = 'true';
      const res = await jobCosting.calculateJobCost(visitId, trx);
      expect(res.costRates).toMatchObject({ driveMinutes: 20, driveMiles: 8, driveSource: 'gps_leg' });
      expect(res.labor_cost).toBe(36.33); // $27.25 x 80 minutes
      expect(res.drive_cost).toBe(8.88); // 8 miles x $0.23 = 1.84, plus $5.28 x 80 minutes = 7.04
      const row = await costRow();
      expect(num(row.labor_cost)).toBe(36.33);
      expect(num(row.drive_cost)).toBe(8.88);
    });

    it('a leg that did not match is ignored', async () => {
      await addTechCard();
      await addVehicleCard();
      await addLeg({ status: 'no_stop', drive_minutes: null, drive_miles: null });
      process.env[GATE] = 'true';
      const res = await jobCosting.calculateJobCost(visitId, trx);
      expect(res.costRates).toMatchObject({ driveMinutes: 24, driveMiles: 11, driveSource: 'default' });
    });

    it('the service record carries the new costs and labor_hours stays the on-job hours', async () => {
      const recordId = randomUUID();
      await trx('service_records').insert({
        id: recordId, customer_id: customerId, scheduled_service_id: visitId, technician_id: techId,
        service_date: '2026-10-26', service_type: 'Quarterly Pest Control Service', status: 'completed',
      });
      await addTechCard();
      await addVehicleCard();
      await addLeg();
      process.env[GATE] = 'true';
      await jobCosting.calculateJobCost(visitId, trx);
      const record = await trx('service_records').where({ id: recordId }).first();
      expect(num(record.labor_cost)).toBe(36.33);
      expect(num(record.drive_cost)).toBe(8.88);
      expect(num(record.labor_hours)).toBe(1);
    });

    it('cards are dated: a visit before the first card falls back to the company rate', async () => {
      await addTechCard({ effective_date: '2026-11-01' });
      await addVehicleCard({ effective_date: '2026-11-01' });
      process.env[GATE] = 'true';
      const res = await jobCosting.calculateJobCost(visitId, trx);
      expect(res.labor_cost).toBe(35);
      expect(res.drive_cost).toBe(6);
    });

    it('cards are dated: the visit date picks the card, a later card does not re-price an earlier visit', async () => {
      await addTechCard({ kind: 'imputed', imputed_hourly_rate: 30, vehicle_equipment_id: null, effective_date: '2026-01-01' });
      await addTechCard({ kind: 'imputed', imputed_hourly_rate: 40, vehicle_equipment_id: null, effective_date: '2026-10-27' });
      process.env[GATE] = 'true';
      const res = await jobCosting.calculateJobCost(visitId, trx);
      expect(res.labor_cost).toBe(42); // $30.00 x 84 minutes
      const later = await addVisit({ scheduled_date: '2026-10-28', actual_start_time: '2026-10-28T14:00:00Z', actual_end_time: '2026-10-28T15:00:00Z' });
      expect((await jobCosting.calculateJobCost(later, trx)).labor_cost).toBe(56);
    });

    it('a raise after the card does not re-cost a visit the card covers (the card keeps its wage)', async () => {
      await addTechCard({ hourly_wage: 21 });
      await addVehicleCard();
      process.env[GATE] = 'true';
      const before = await jobCosting.calculateJobCost(visitId, trx);
      await trx('technicians').where({ id: techId }).update({ pay_rate: '25.00' });
      const after = await jobCosting.calculateJobCost(visitId, trx);
      expect(after.labor_cost).toBe(before.labor_cost);
      expect(after.labor_cost).toBe(38.15); // $27.25 x 84 minutes
    });

    it('two technicians who drive one vehicle share its yearly fixed cost', async () => {
      await addTechCard();
      await addVehicleCard();
      const second = randomUUID();
      await trx('technicians').insert({ id: second, name: 'Second Sample', employment_type: 'w2', employment_status: 'active', pay_rate: '21.00' });
      await addTechCard({ technician_id: second });
      process.env[GATE] = 'true';
      // $10,200 a year over 1,930 + 1,930 worked hours = $2.64 an hour (alone it is $5.28).
      const res = await jobCosting.calculateJobCost(visitId, trx);
      expect(res.drive_cost).toBe(6.23); // 0.23 x 11 = 2.53, plus 2.64 x 1.4 h = 3.696
      // The rates screen spreads it the same way.
      const rates = await require('../services/tech-cost-rates').loadRatesForDate(trx, '2026-10-26');
      expect(rates.vehicles.find((v) => v.equipmentId === vehicleId))
        .toMatchObject({ fixedPerWorkedHourCents: 264, spreadOverHoursPerYear: 3860 });
    });

    it('a combined closeout charges the drive once per stop, to the marked owner', async () => {
      const other = await addVisit();
      const mark = (allocatedMinutes) => JSON.stringify({
        visitOutcome: 'completed',
        visitDriveCostAllocation: { version: 1, packetId: 'packet-1', ownerServiceId: visitId },
        visitDurationAllocation: { version: 1, allocatedMinutes },
      });
      for (const [id, minutes] of [[visitId, 36], [other, 24]]) {
        await trx('service_records').insert({
          id: randomUUID(), customer_id: customerId, scheduled_service_id: id, technician_id: techId,
          service_date: '2026-10-26', service_type: 'Quarterly Pest Control Service', status: 'completed',
          structured_notes: mark(minutes),
        });
      }
      await addTechCard();
      await addVehicleCard();
      process.env[GATE] = 'true';
      const owner = await jobCosting.calculateJobCost(visitId, trx);
      const member = await jobCosting.calculateJobCost(other, trx);
      expect(owner.costRates).toMatchObject({ onJobMinutes: 36, driveMinutes: 24, driveMiles: 11 });
      expect(member.costRates).toMatchObject({ onJobMinutes: 24, driveMinutes: 0, driveMiles: 0 });
      expect(owner.labor_cost).toBe(27.25);
      expect(member.labor_cost).toBe(10.9);
      expect(owner.drive_cost).toBe(7.81);
      expect(member.drive_cost).toBe(2.11);
    });
  });

  // ---------------- admin routes ----------------

  describe('admin routes', () => {
    const call = async (method, path, body) => {
      const res = await fetch(`${baseUrl}/api/admin/cost-cards${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json = null;
      try { json = await res.json(); } catch { /* no body */ }
      return { status: res.status, body: json || {} };
    };

    it('gate off: the list says so, everything else answers 404', async () => {
      expect(await call('GET', '/')).toEqual({ status: 200, body: { enabled: false } });
      expect((await call('GET', '/rates')).status).toBe(404);
      expect((await call('POST', `/technicians/${techId}`, { kind: 'imputed', imputedHourlyRate: 30 })).status).toBe(404);
      expect((await call('POST', `/vehicles/${vehicleId}`, {})).status).toBe(404);
      expect(await trx('technician_cost_cards').count('* as n').first()).toMatchObject({ n: '0' });
    });

    it('a technician-role login is refused on every route, gate on or off', async () => {
      mockRole = 'technician';
      for (const gate of [undefined, 'true']) {
        if (gate) process.env[GATE] = gate;
        expect((await call('GET', '/')).status).toBe(403);
        expect((await call('GET', '/rates')).status).toBe(403);
        expect((await call('POST', `/technicians/${techId}`, { kind: 'imputed', imputedHourlyRate: 30 })).status).toBe(403);
        expect((await call('POST', `/vehicles/${vehicleId}`, {})).status).toBe(403);
      }
    });

    it('adds a technician card and a vehicle card, audits each with ids only, and shows the rates', async () => {
      process.env[GATE] = 'true';
      const veh = await call('POST', `/vehicles/${vehicleId}`, {
        effectiveDate: '2026-01-01',
        lossOfValuePerYear: 6000, insurancePerYear: 2400, loanInterestPerYear: 1200, otherFixedPerYear: 600,
        fuelPerMile: 0.15, upkeepPerMile: 0.08, note: 'secret note',
      });
      expect(veh.status).toBe(201);
      const tech = await call('POST', `/technicians/${techId}`, {
        effectiveDate: '2026-01-01', kind: 'w2', paidHoursPerWeek: 40, paidHoursPerDay: 10,
        healthMoneyMonthly: 200, retirementPct: 2, workersCompPct: 4, paidDaysOffPerYear: 15, vehicleEquipmentId: vehicleId,
      });
      expect(tech.status).toBe(201);
      expect(tech.body.card).toMatchObject({ technicianId: techId, kind: 'w2', effectiveDate: '2026-01-01', vehicleEquipmentId: vehicleId });

      const audits = await trx('audit_log').whereIn('action', ['cost_cards.technician_card_added', 'cost_cards.vehicle_card_added']).orderBy('action');
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({ action: 'cost_cards.technician_card_added', actor_type: 'admin', actor_id: ADMIN_ID, resource_id: tech.body.card.id });
      expect(audits[0].metadata).toEqual({ technician_id: techId, card_id: tech.body.card.id });
      expect(audits[1]).toMatchObject({ action: 'cost_cards.vehicle_card_added', resource_id: veh.body.card.id });
      expect(JSON.stringify(audits.map((a) => a.metadata))).not.toMatch(/secret note|6000/);

      const list = await call('GET', '/');
      expect(list.body.enabled).toBe(true);
      const listedTech = list.body.technicians.find((t) => t.id === techId);
      expect(listedTech.cards).toHaveLength(1);
      expect(list.body.vehicles.find((v) => v.id === vehicleId).cards).toHaveLength(1);

      const rates = await call('GET', '/rates?date=2026-10-26');
      const mine = rates.body.technicians.find((t) => t.technicianId === techId);
      expect(mine).toMatchObject({ ok: true, laborPerPaidHourCents: 2529, laborPerWorkedHourCents: 2725, totalPerYearCents: 5260092 });
      expect(mine.lines.map((l) => l.key)).toEqual(['wages', 'health', 'social_medicare', 'futa', 'reemployment', 'workers_comp', 'retirement']);
      const myVehicle = rates.body.vehicles.find((v) => v.equipmentId === vehicleId);
      expect(myVehicle).toMatchObject({ fixedPerYearCents: 1020000, fixedPerWorkedHourCents: 528, perMileTenThousandths: 2300 });
      // Before the first card there is nothing.
      expect((await call('GET', '/rates?date=2025-12-31')).body.technicians.find((t) => t.technicianId === techId)).toBeUndefined();
    });

    it('a change is a new card: the second card sits beside the first', async () => {
      process.env[GATE] = 'true';
      const first = await call('POST', `/technicians/${techId}`, { effectiveDate: '2026-01-01', kind: 'imputed', imputedHourlyRate: 30 });
      const second = await call('POST', `/technicians/${techId}`, { effectiveDate: '2026-06-01', kind: 'imputed', imputedHourlyRate: 40 });
      expect([first.status, second.status]).toEqual([201, 201]);
      const cards = (await call('GET', '/')).body.technicians.find((t) => t.id === techId).cards;
      expect(cards.map((c) => c.effectiveDate)).toEqual(['2026-06-01', '2026-01-01']);
      expect(cards.map((c) => c.imputedHourlyRate)).toEqual([40, 30]);
    });

    it.each([
      ['a bad kind', { kind: 'contractor' }],
      ['an imputed card with no rate', { kind: 'imputed' }],
      ['an imputed card with a zero rate', { kind: 'imputed', imputedHourlyRate: 0 }],
      ['retirement over 100', { kind: 'w2', retirementPct: 101 }],
      ['a negative health amount', { kind: 'w2', healthMoneyMonthly: -5 }],
      ['too many decimals', { kind: 'w2', workersCompPct: 4.123 }],
      ['an unknown field', { kind: 'w2', payRate: 21 }],
      ['a wage of zero', { kind: 'w2', hourlyWage: 0 }],
      ['a note over 500 characters', { kind: 'w2', note: 'x'.repeat(501) }],
      ['a date that is not a date', { kind: 'w2', effectiveDate: '2026-02-30' }],
      ['a vehicle that is not a vehicle', { kind: 'w2', vehicleEquipmentId: randomUUID() }],
    ])('refuses a technician card with %s (400, nothing written, nothing audited)', async (_label, body) => {
      process.env[GATE] = 'true';
      const res = await call('POST', `/technicians/${techId}`, body);
      expect(res.status).toBe(400);
      expect(await trx('technician_cost_cards').count('* as n').first()).toMatchObject({ n: '0' });
      expect(await trx('audit_log').where({ action: 'cost_cards.technician_card_added' }).count('* as n').first()).toMatchObject({ n: '0' });
    });

    it('refuses a W-2 card for a technician with no pay rate, and an unknown technician or vehicle', async () => {
      process.env[GATE] = 'true';
      await trx('technicians').where({ id: techId }).update({ pay_rate: null });
      expect((await call('POST', `/technicians/${techId}`, { kind: 'w2' })).status).toBe(400);
      expect((await call('POST', `/technicians/${randomUUID()}`, { kind: 'imputed', imputedHourlyRate: 30 })).status).toBe(404);
      expect((await call('POST', '/technicians/not-an-id', { kind: 'imputed', imputedHourlyRate: 30 })).status).toBe(404);
      expect((await call('POST', `/vehicles/${randomUUID()}`, {})).status).toBe(404);
      // A technician (not a vehicle) id is not a vehicle.
      expect((await call('POST', `/vehicles/${techId}`, {})).status).toBe(404);
      expect((await call('POST', `/vehicles/${vehicleId}`, { fuelPerMile: -1 })).status).toBe(400);
    });

    it('a W-2 card keeps the wage it was made with: the pay rate by default, a typed wage when given', async () => {
      process.env[GATE] = 'true';
      const byDefault = await call('POST', `/technicians/${techId}`, { effectiveDate: '2026-01-01', kind: 'w2' });
      expect(byDefault.status).toBe(201);
      expect(byDefault.body.card.hourlyWage).toBe(21);
      const typed = await call('POST', `/technicians/${techId}`, { effectiveDate: '2026-06-01', kind: 'w2', hourlyWage: 23.5 });
      expect(typed.body.card.hourlyWage).toBe(23.5);
      await trx('technicians').where({ id: techId }).update({ pay_rate: null });
      const noPayRate = await call('POST', `/technicians/${techId}`, { effectiveDate: '2026-07-01', kind: 'w2', hourlyWage: 24 });
      expect(noPayRate.status).toBe(201);
      const imputed = await call('POST', `/technicians/${techId}`, { kind: 'imputed', imputedHourlyRate: 30 });
      expect(imputed.body.card.hourlyWage).toBeNull();
    });

    it('a bad date on /rates is a 400', async () => {
      process.env[GATE] = 'true';
      expect((await call('GET', '/rates?date=tomorrow')).status).toBe(400);
    });
  });
});
