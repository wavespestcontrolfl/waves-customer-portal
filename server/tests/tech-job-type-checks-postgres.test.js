/**
 * GATE_TECH_JOB_TYPE_CHECKS (owner 2026-10-25) against REAL Postgres: the real service
 * library (services.category), the real technician_capabilities table and CHECKs, the
 * savepoint reads, and the office assignment path. A mocked knex proves none of these.
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test database) or a
 * local scratch Postgres migrated with `knex migrate:latest`; it skips without one.
 * Fixtures are fictitious. Every row it makes is removed in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: (gate) => (gate === 'newCallerBooking' ? true : actual.isEnabled(gate)) };
});

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

// Each booking takes its own day so the same-slot overlap warning never mixes into the lines under test.
let dayCounter = 0;
const nextDate = () => `2031-04-${String(1 + (dayCounter++)).padStart(2, '0')}`;
const ADDRESS = { line1: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5 };

postgres('technician job type from the catalog (real Postgres)', () => {
  let db;
  let capabilities;
  let eligibility;
  let palm; // services row: category tree_shrub, whose NAME reads general pest
  let pest; // services row: category pest_control
  let hire; // Lawn = Off, Termite = review_required, everything else unset
  const made = { techIds: [], visitIds: [] };

  async function makeTech(name) {
    const [row] = await db('technicians')
      .insert({
        name: `${name} ${randomUUID().slice(0, 8)}`, role: 'technician', employment_status: 'active', field_dispatchable: true, active: true,
      })
      .returning(['id', 'name']);
    made.techIds.push(row.id);
    return row;
  }

  beforeAll(async () => {
    db = require('../models/db');
    capabilities = require('../services/technician-capabilities');
    eligibility = require('../services/technician-eligibility');
    palm = await db('services').where({ service_key: 'palm_treatment' }).first('id', 'service_key', 'name', 'category');
    pest = await db('services').where({ category: 'pest_control' }).whereNotNull('name').first('id', 'service_key', 'name', 'category');
    hire = await makeTech('Synthetic Hire');
    await db('technician_capabilities').insert([
      { technician_id: hire.id, service_category: 'lawn', capability_level: 'review_required', active: false, source: 'admin' },
      { technician_id: hire.id, service_category: 'termite', capability_level: 'review_required', active: true, source: 'admin' },
    ]);
  });

  afterEach(() => { delete process.env.GATE_TECH_JOB_TYPE_CHECKS; });

  afterAll(async () => {
    if (made.visitIds.length) {
      await db('activity_log').whereRaw("metadata->>'scheduled_service_id' = ANY(?)", [made.visitIds]).del().catch(() => {});
      await db('scheduled_services').whereIn('id', made.visitIds).del();
    }
    if (made.techIds.length) {
      await db('technician_capabilities').whereIn('technician_id', made.techIds).del();
      await db('technicians').whereIn('id', made.techIds).del();
    }
    await db.destroy();
  });

  test('the fixture is the census case: a tree & shrub catalog row whose name reads general pest', () => {
    expect(palm.category).toBe('tree_shrub');
    expect(pest.category).toBe('pest_control');
    expect(require('../services/auto-dispatch/service-category').classifyServiceCategory(palm.name)).toBe('general');
  });

  describe('categoriesForServices against the real library', () => {
    const rows = () => [
      { service_type: palm.name, service_id: palm.id },
      { service_type: 'Visit', service_key: pest.service_key },
      { service_type: 'Rodent Exclusion' },
    ];

    test('gate off: names only (palm reads general)', async () => {
      expect(await capabilities.categoriesForServices(db, rows())).toEqual(['general', 'general', 'rodent']);
    });

    test('gate on: palm by id reads lawn, a pest key reads general, a name-only row falls back to the regex', async () => {
      process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
      expect(await capabilities.categoriesForServices(db, rows())).toEqual(['lawn', 'general', 'rodent']);
    });

    test('gate on, inside a transaction: the read rides a savepoint and the transaction stays usable', async () => {
      process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
      await db.transaction(async (trx) => {
        expect(await capabilities.categoriesForServices(trx, [{ service_type: 'x', service_id: palm.id }])).toEqual(['lawn']);
        expect(await trx('technicians').where({ id: hire.id }).first('id')).toMatchObject({ id: hire.id });
      });
    });
  });

  describe('the capability fences', () => {
    test('inactiveCapabilitiesForServices: the Lawn = Off hire is unfit for palm only with the gate on', async () => {
      const row = { service_type: palm.name, service_id: palm.id };
      expect(await capabilities.inactiveCapabilitiesForServices(db, [hire.id], [row])).toEqual([]);
      process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
      expect(await capabilities.inactiveCapabilitiesForServices(db, [hire.id], [row]))
        .toEqual([expect.objectContaining({ technician_id: hire.id, service_category: 'lawn', active: false })]);
      // Pest is not lawn: the hire still takes it.
      expect(await capabilities.inactiveCapabilitiesForServices(db, [hire.id], [{ service_type: pest.name, service_id: pest.id }])).toEqual([]);
    });

    test('assertCapabilitiesActive on a real transaction: refuses the palm visit with the gate on, lets it through with it off', async () => {
      const refuse = (rowId, why) => Object.assign(new Error(why), { code: 'REFUSED', rowId });
      const row = { id: 'visit-x', service_type: palm.name, service_id: palm.id };
      await db.transaction(async (trx) => {
        await expect(capabilities.assertCapabilitiesActive(trx, hire.id, [row], refuse)).resolves.toBeUndefined();
        process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
        await expect(capabilities.assertCapabilitiesActive(trx, hire.id, [row], refuse))
          .rejects.toMatchObject({ code: 'REFUSED', rowId: 'visit-x', message: 'cannot be assigned to a technician deactivated for lawn' });
      });
    });

    test('auto-dispatch preferences carry the catalog category when the visit identity is passed', async () => {
      const { getCustomerSchedulingPreferences } = require('../services/auto-dispatch/preferences');
      const customerId = randomUUID(); // no property_preferences row: defaults apply
      expect((await getCustomerSchedulingPreferences(customerId, palm.name, db, { serviceId: palm.id })).service_category).toBe('general');
      process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
      expect((await getCustomerSchedulingPreferences(customerId, palm.name, db, { serviceId: palm.id })).service_category).toBe('lawn');
      expect((await getCustomerSchedulingPreferences(customerId, palm.name, db)).service_category).toBe('general');
    });
  });

  describe('office saves warn and never block', () => {
    test('capabilityOffWarningsFor: Off warns; review_required, unset and another category do not; gate off is silent', async () => {
      const palmRow = { service_type: palm.name, service_id: palm.id };
      expect(await eligibility.capabilityOffWarningsFor(hire.id, [palmRow], { conn: db })).toEqual([]);
      process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
      expect(await eligibility.capabilityOffWarningsFor(hire.id, [palmRow], { conn: db }))
        .toEqual([`${hire.name} is set to Off for Lawn, tree & shrub work.`]);
      expect(await eligibility.capabilityOffWarningsFor(hire.id, [{ service_type: pest.name, service_id: pest.id }], { conn: db })).toEqual([]);
      // Termite is review_required: allowed (owner 2026-09-05), so no line.
      expect(await eligibility.capabilityOffWarningsFor(hire.id, [{ service_type: 'WDO Inspection' }], { conn: db })).toEqual([]);
      await db.transaction(async (trx) => {
        expect(await eligibility.capabilityOffWarningsFor(hire.id, [palmRow], { conn: trx })).toHaveLength(1);
      });
    });

    describe('Dispatch New Appointment and the board assignment', () => {
      let service;
      beforeAll(() => { service = require('../services/booking/new-caller-visit'); });
      const book = (serviceRow, technicianId) => service.bookNewCallerVisit({
        input: { scheduledDate: nextDate(), windowStart: '10:00', serviceId: serviceRow.id, address: ADDRESS, technicianId },
      });

      test('gate on: booking the hire onto a palm visit saves it on the hire and carries the warning; a pest visit carries none', async () => {
        process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
        const booked = await book(palm, hire.id);
        made.visitIds.push(booked.visit.id);
        expect((await db('scheduled_services').where({ id: booked.visit.id }).first('technician_id')).technician_id).toBe(hire.id);
        expect(booked.warnings).toEqual([`${hire.name} is set to Off for Lawn, tree & shrub work.`]);
        const pestBooked = await book(pest, hire.id);
        made.visitIds.push(pestBooked.visit.id);
        expect(pestBooked.warnings).toEqual([]);
      });

      test('gate off: the same palm booking carries no warning', async () => {
        const booked = await book(palm, hire.id);
        made.visitIds.push(booked.visit.id);
        expect(booked.warnings).toEqual([]);
      });

      test('assignDispatchJob: the palm visit is assigned to the Lawn = Off hire with one warning line; gate off has no warnings key', async () => {
        const { assignDispatchJob } = require('../services/dispatch-assignment');
        process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
        const first = await book(palm, null);
        made.visitIds.push(first.visit.id);
        const out = await assignDispatchJob({ jobId: first.visit.id, technicianId: hire.id, actorId: null, emit: false });
        expect(out).toMatchObject({ changed: true, warnings: [`${hire.name} is set to Off for Lawn, tree & shrub work.`] });
        // The job-type lines alone, for the edit save's series siblings (Codex #6740 r2).
        expect(out.capabilityWarnings).toEqual([`${hire.name} is set to Off for Lawn, tree & shrub work.`]);
        expect((await db('scheduled_services').where({ id: first.visit.id }).first('technician_id')).technician_id).toBe(hire.id);

        delete process.env.GATE_TECH_JOB_TYPE_CHECKS;
        const second = await book(palm, null);
        made.visitIds.push(second.visit.id);
        const offOut = await assignDispatchJob({ jobId: second.visit.id, technicianId: hire.id, actorId: null, emit: false });
        expect(offOut).not.toHaveProperty('warnings');
        expect(offOut).not.toHaveProperty('capabilityWarnings');
      });
    });
  });
});
