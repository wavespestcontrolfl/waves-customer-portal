/**
 * Service-line map shadow (GATE_SERVICE_LINE_MAP=shadow, owner 2026-10-25) on real
 * PostgreSQL: the table CHECKs and SET NULL keys, the resolver against real rows, the
 * recorder (gate off = no row, commit/rollback of a caller transaction), the Team-tab
 * editor routes, the shadow summary, and one estimate accept that logs after commit.
 *
 * DB-gated: skips without DATABASE_URL, runs in CI against the migrated database. All
 * rows are synthetic, keyed to technicians this suite creates, and removed afterwards.
 */
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

jest.setTimeout(60000);
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
// The estimate-accept case below runs the real converter; only its side-effect modules are stubbed.
jest.mock('../services/new-recurring-welcome-sms', () => ({
  isNewRecurringSignupCandidate: async () => false, sendNewRecurringWelcome: jest.fn(),
}));
jest.mock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn() }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: async () => {} }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: async () => {} }));
jest.mock('../services/inspection-credit', () => ({ markBookingForInspectionCredit: async () => {} }));
jest.mock('../services/scheduling/line-technician', () => {
  const actual = jest.requireActual('../services/scheduling/line-technician');
  return { ...actual, recordLinePickShadow: jest.fn(actual.recordLinePickShadow) };
});

const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const lineTech = require('../services/scheduling/line-technician');

const router = SKIP ? null : require('../routes/admin-timetracking');

function routeHandler(method, routePath) {
  const layer = router.stack.find((candidate) => (
    candidate.route?.path === routePath && candidate.route.methods[method]
  ));
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(method, routePath, { query = {}, body = {}, technicianId = null } = {}) {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  let error;
  await routeHandler(method, routePath)({ params: {}, query, body, technicianId }, res, (err) => { error = err; });
  if (error) throw error;
  return res;
}

// The deferred write is several round trips after the commit: poll instead of counting ticks.
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
// 2099-07-06 is a Monday and 2099-07-10 a Friday.
const MONDAY = '2099-07-06';
const FRIDAY = '2099-07-10';

describeDb('service-line map shadow on PostgreSQL', () => {
  const run = `slm-${randomUUID().slice(0, 8)}`;
  const ownerId = randomUUID(); // active, works every day
  const hireId = randomUUID(); // active, Monday to Thursday
  const futureId = randomUUID(); // prospective: not assignable yet
  const goneId = randomUUID(); // inactive
  const techIds = [ownerId, hireId, futureId, goneId];
  const priorGates = { shadow: process.env.GATE_SERVICE_LINE_MAP, days: process.env.GATE_TECH_WORK_DAYS };

  const tech = (id, name, status, extra = {}) => ({
    id, name, email: `${id}@example.invalid`, password_hash: 'synthetic-not-a-login-hash', role: 'technician',
    active: status === 'active', employment_status: status, field_dispatchable: true, ...extra,
  });
  const lineRow = (line, home, gap) => ({ service_category: line, home_technician_id: home, gap_technician_id: gap });
  const shadowRows = () => db('service_line_pick_shadow').where({ run_id: run });
  const pick = (extra = {}) => ({
    source: 'book', runId: run, scheduledServiceId: randomUUID(), customerId: randomUUID(), date: MONDAY,
    windowStart: '09:00', serviceType: 'General Pest Control', actualTechnicianId: ownerId, ...extra,
  });

  // Each test starts from an empty service_line_techs. A database that already holds a
  // map (a developer's) gets it back row for row in afterAll.
  let priorLineTechs = [];
  beforeAll(async () => {
    priorLineTechs = await db('service_line_techs').select('*');
    await db('technicians').insert([
      tech(ownerId, `Owner ${run}`, 'active'),
      tech(hireId, `Hire ${run}`, 'active', { work_days: [1, 2, 3, 4] }),
      tech(futureId, `Future ${run}`, 'prospective'),
      tech(goneId, `Gone ${run}`, 'inactive'),
    ]);
  });
  beforeEach(async () => {
    delete process.env.GATE_SERVICE_LINE_MAP;
    delete process.env.GATE_TECH_WORK_DAYS;
    await db('service_line_techs').del();
    await db('service_line_pick_shadow').where({ run_id: run }).del();
    lineTech.recordLinePickShadow.mockClear();
  });
  afterAll(async () => {
    if (priorGates.shadow === undefined) delete process.env.GATE_SERVICE_LINE_MAP; else process.env.GATE_SERVICE_LINE_MAP = priorGates.shadow;
    if (priorGates.days === undefined) delete process.env.GATE_TECH_WORK_DAYS; else process.env.GATE_TECH_WORK_DAYS = priorGates.days;
    await db('service_line_techs').del();
    if (priorLineTechs.length) await db('service_line_techs').insert(priorLineTechs);
    await db('service_line_pick_shadow').where({ run_id: run }).del();
    await db('technician_absences').whereIn('technician_id', techIds).del();
    await db('technicians').whereIn('id', techIds).del();
    await db.destroy();
  });

  describe('table constraints', () => {
    test('service_line_techs: only the five lines; a deleted technician clears the pointer instead of blocking', async () => {
      await expect(db('service_line_techs').insert(lineRow('bogus', null, null))).rejects.toThrow(/service_line_techs_category_check/);
      const tempId = randomUUID();
      await db('technicians').insert(tech(tempId, `Temp ${run}`, 'active'));
      await db('service_line_techs').insert(lineRow('rodent', tempId, tempId));
      await db('technicians').where({ id: tempId }).del();
      expect(await db('service_line_techs').where({ service_category: 'rodent' }).first())
        .toMatchObject({ home_technician_id: null, gap_technician_id: null });
      await expect(db('service_line_techs').insert(lineRow('rodent', null, null))).rejects.toThrow(/duplicate key/);
    });

    test('service_line_pick_shadow: the six sources and the two line_from values only; ids carry no foreign keys', async () => {
      for (const source of ['book', 'phone_live', 'after_call', 'estimate_accept', 'office_auto', 'night_run']) {
        await db('service_line_pick_shadow').insert({ source, run_id: run });
      }
      await expect(db('service_line_pick_shadow').insert({ source: 'elsewhere', run_id: run })).rejects.toThrow(/service_line_pick_shadow_source_check/);
      await expect(db('service_line_pick_shadow').insert({ source: 'book', line_from: 'guess', run_id: run })).rejects.toThrow(/service_line_pick_shadow_line_from_check/);
      await db('service_line_pick_shadow').insert({
        source: 'book', run_id: run, line_from: 'catalog', scheduled_service_id: randomUUID(), customer_id: randomUUID(),
        actual_technician_id: randomUUID(), would_technician_id: randomUUID(), home_technician_id: randomUUID(),
      });
      expect(await shadowRows()).toHaveLength(7);
    });
  });

  describe('resolver on real rows', () => {
    test('catalog first: a palm row reads lawn; the pest line goes to its home tech, then the gap tech on an off day or an absence', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      await db('service_line_techs').insert([lineRow('general', hireId, ownerId), lineRow('lawn', ownerId, null)]);
      const palm = await db('services').where({ service_key: 'palm_injection_semiannual' }).first('id');
      expect(await lineTech.resolveLineTechnician(db, { serviceId: palm.id, serviceType: 'Palm Injection', date: MONDAY }))
        .toMatchObject({ line: 'lawn', lineFrom: 'catalog', technicianId: ownerId, reason: 'home' });
      const pest = { serviceType: 'General Pest Control' };
      expect(await lineTech.resolveLineTechnician(db, { ...pest, date: MONDAY })).toMatchObject({ technicianId: hireId, reason: 'home' });
      expect(await lineTech.resolveLineTechnician(db, { ...pest, date: FRIDAY })).toMatchObject({ technicianId: ownerId, reason: 'gap_off_day' });
      await db('technician_absences').insert({ technician_id: hireId, absence_date: MONDAY, reason: 'sick' });
      expect(await lineTech.resolveLineTechnician(db, { ...pest, date: MONDAY })).toMatchObject({ technicianId: ownerId, reason: 'gap_absent' });
      await db('technician_absences').where({ technician_id: hireId }).del();
    });

    test('a prospective home tech is not assignable; capability Off reads gap_capability_off; an empty map reads no_map', async () => {
      await db('service_line_techs').insert([lineRow('mosquito', futureId, ownerId), lineRow('rodent', hireId, ownerId)]);
      expect(await lineTech.resolveLineTechnician(db, { serviceType: 'Mosquito Control', date: MONDAY }))
        .toMatchObject({ technicianId: ownerId, reason: 'gap_not_assignable' });
      await db('technician_capabilities').insert({ technician_id: hireId, service_category: 'rodent', active: false, capability_level: 'qualified' });
      expect(await lineTech.resolveLineTechnician(db, { serviceType: 'Rodent Control', date: MONDAY }))
        .toMatchObject({ technicianId: ownerId, reason: 'gap_capability_off' });
      await db('technician_capabilities').where({ technician_id: hireId }).del();
      expect(await lineTech.resolveLineTechnician(db, { serviceType: 'Termite Inspection', date: MONDAY }))
        .toMatchObject({ line: 'termite', technicianId: null, reason: 'no_map' });
    });
  });

  describe('live pickers on real rows (GATE_SERVICE_LINE_MAP=live)', () => {
    beforeEach(() => { process.env.GATE_SERVICE_LINE_MAP = 'live'; });
    const pest = { serviceType: 'General Pest Control' };

    test('lineOfferRanking: home 0, gap 1, anyone else dropped; null when the gate is not live or no line has a technician set', async () => {
      await db('service_line_techs').insert([lineRow('general', hireId, ownerId), lineRow('lawn', ownerId, null)]);
      const general = await lineTech.lineOfferRanking(db, { lines: ['general'] });
      expect(general.lines).toEqual(['general']);
      expect([hireId, ownerId, futureId, null].map((id) => general.rankOf(id))).toEqual([0, 1, null, null]);
      // Two lines: the owner is the gap of one and the home of the other; the hire is not on the lawn line.
      const both = await lineTech.lineOfferRanking(db, { lines: ['general', 'lawn'] });
      expect([ownerId, hireId].map((id) => both.rankOf(id))).toEqual([1, null]);
      // A line with nobody set adds no rule; the other line still does.
      const withTermite = await lineTech.lineOfferRanking(db, { lines: ['termite', 'lawn'] });
      expect(withTermite.lines).toEqual(['lawn']);
      expect(await lineTech.lineOfferRanking(db, { lines: ['termite'] })).toBeNull();
      process.env.GATE_SERVICE_LINE_MAP = 'shadow';
      expect(await lineTech.lineOfferRanking(db, { lines: ['general'] })).toBeNull();
    });

    test('lineOfferRanking: a technician switched Off for the line is dropped', async () => {
      await db('service_line_techs').insert(lineRow('rodent', hireId, ownerId));
      await db('technician_capabilities').insert({ technician_id: hireId, service_category: 'rodent', active: false, capability_level: 'qualified' });
      const ranking = await lineTech.lineOfferRanking(db, { lines: ['rodent'] });
      expect([hireId, ownerId].map((id) => ranking.rankOf(id))).toEqual([null, 1]);
      await db('technician_capabilities').where({ technician_id: hireId }).del();
    });

    test('pickLineTechnician: home, then gap on an off day or an absence, then nobody; the caller\'s list bounds it', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      await db('service_line_techs').insert([lineRow('general', hireId, ownerId), lineRow('mosquito', futureId, null)]);
      expect(await lineTech.pickLineTechnician(db, { ...pest, date: MONDAY })).toEqual({ mapped: true, line: 'general', technicianId: hireId, reason: 'home' });
      expect(await lineTech.pickLineTechnician(db, { ...pest, date: FRIDAY })).toMatchObject({ technicianId: ownerId, reason: 'gap_off_day' });
      await db('technician_absences').insert({ technician_id: hireId, absence_date: MONDAY, reason: 'sick' });
      expect(await lineTech.pickLineTechnician(db, { ...pest, date: MONDAY })).toMatchObject({ technicianId: ownerId, reason: 'gap_absent' });
      await db('technician_absences').where({ technician_id: hireId }).del();
      // The caller's own eligible list: the home tech is not on it, so the gap tech takes it.
      expect(await lineTech.pickLineTechnician(db, { ...pest, date: MONDAY, candidateIds: [ownerId] })).toMatchObject({ technicianId: ownerId, reason: 'gap_not_listed' });
      expect(await lineTech.pickLineTechnician(db, { ...pest, date: MONDAY, candidateIds: [futureId] })).toMatchObject({ technicianId: null, reason: 'none' });
      // A not-yet-started home tech with no gap: nobody (the caller saves the visit unassigned).
      expect(await lineTech.pickLineTechnician(db, { serviceType: 'Mosquito Control', date: MONDAY })).toEqual({ mapped: true, line: 'mosquito', technicianId: null, reason: 'none' });
    });

    test('pickLineTechnician: an unmapped line and a gate that is not live both tell the caller to keep today\'s choice', async () => {
      await db('service_line_techs').insert(lineRow('general', hireId, ownerId));
      expect(await lineTech.pickLineTechnician(db, { serviceType: 'Termite Inspection', date: MONDAY })).toMatchObject({ mapped: false, line: 'termite', reason: 'no_map' });
      process.env.GATE_SERVICE_LINE_MAP = 'shadow';
      expect(await lineTech.pickLineTechnician(db, { ...pest, date: MONDAY })).toMatchObject({ mapped: false, technicianId: null, reason: 'off' });
    });

    test('the Team-tab card works in live: GET and PUT answer with mode live, and the roster marks the response', async () => {
      const got = await call('get', '/service-lines');
      expect(got.statusCode).toBe(200);
      expect(got.body.mode).toBe('live');
      const saved = await call('put', '/service-lines', { technicianId: ownerId, body: { lines: [
        { service_category: 'termite', home_technician_id: ownerId, gap_technician_id: null },
      ] } });
      expect(saved.statusCode).toBe(200);
      expect(saved.body.mode).toBe('live');
      expect((await call('get', '/technicians')).body.serviceLinesEnabled).toBe(true);
      expect((await call('get', '/service-lines/shadow-summary')).statusCode).toBe(200);
    });
  });

  describe('recorder', () => {
    test('gate off: no row and the log table is never queried', async () => {
      await db('service_line_techs').insert(lineRow('general', hireId, ownerId));
      await lineTech.recordLinePickShadow(pick());
      expect(await shadowRows()).toHaveLength(0);
      process.env.GATE_SERVICE_LINE_MAP = 'true'; // not a value yet
      await lineTech.recordLinePickShadow(pick());
      expect(await shadowRows()).toHaveLength(0);
    });

    test('gate shadow: one row with the actual technician, the would-be technician and why', async () => {
      process.env.GATE_SERVICE_LINE_MAP = 'shadow';
      await db('service_line_techs').insert(lineRow('general', hireId, ownerId));
      const input = pick({ actualTechnicianId: ownerId });
      await lineTech.recordLinePickShadow(input);
      const rows = await shadowRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: 'book', scheduled_service_id: input.scheduledServiceId, customer_id: input.customerId,
        window_start: '09:00', service_type: 'General Pest Control', service_line: 'general', line_from: 'name',
        actual_technician_id: ownerId, would_technician_id: hireId, would_reason: 'home', home_technician_id: hireId,
      });
      expect(String(rows[0].visit_date.toISOString?.().slice(0, 10) || rows[0].visit_date)).toBe(MONDAY);
    });

    test('inside a caller transaction: written after the commit, never when the transaction throws or rolls back', async () => {
      process.env.GATE_SERVICE_LINE_MAP = 'shadow';
      await db('service_line_techs').insert(lineRow('general', hireId, ownerId));
      const customerId = randomUUID();
      const visitIds = [];
      const addVisit = async (trx) => {
        const id = randomUUID();
        visitIds.push(id);
        await trx('scheduled_services').insert({
          id, customer_id: customerId, technician_id: ownerId, scheduled_date: MONDAY, service_type: 'General Pest Control', status: 'pending',
        });
        return id;
      };
      try {
        await db('customers').insert({
          id: customerId, first_name: 'Synthetic', last_name: 'Fixture', email: `${customerId}@example.invalid`,
          phone: '+19415550100', address_line1: '100 Example Court', city: 'Parrish', state: 'FL', zip: '34219',
        });
        // Committed: nothing while the transaction is open, one row after it commits.
        await db.transaction(async (trx) => {
          await lineTech.recordLinePickShadow(pick({ trx, scheduledServiceId: await addVisit(trx) }));
          await settle();
          expect(await shadowRows()).toHaveLength(0);
        });
        await until(async () => (await shadowRows()).length === 1);
        expect(await shadowRows()).toHaveLength(1);

        await db('service_line_pick_shadow').where({ run_id: run }).del();
        // The transaction throws (how the estimate accept runs): nothing.
        await expect(db.transaction(async (trx) => {
          await lineTech.recordLinePickShadow(pick({ trx, scheduledServiceId: await addVisit(trx) }));
          throw new Error('accept failed');
        })).rejects.toThrow('accept failed');
        // A bare rollback resolves knex's commit promise, so the unreadable visit is what stops the row.
        const manual = await db.transaction();
        await lineTech.recordLinePickShadow(pick({ trx: manual, scheduledServiceId: await addVisit(manual) }));
        await manual.rollback();
        await settle();
        await new Promise((r) => setTimeout(r, 400));
        expect(await shadowRows()).toHaveLength(0);
      } finally {
        await db('scheduled_services').whereIn('id', visitIds).del();
        await db('customers').where({ id: customerId }).del();
      }
    });
  });

  describe('estimate accept', () => {
    test('the converter hands the recorder each reserved line with the accept transaction; a failed accept records nothing', async () => {
      process.env.GATE_SERVICE_LINE_MAP = 'shadow';
      await db('service_line_techs').insert(lineRow('general', hireId, ownerId));
      const converter = require('../services/estimate-converter');
      const customerId = randomUUID();
      const estimateId = randomUUID();
      const service = await db('services').where({ service_key: 'pest_general_quarterly' }).first('id', 'name', 'service_key');
      const trx = await db.transaction();
      let visitId;
      try {
        await trx('customers').insert({
          id: customerId, first_name: 'Synthetic', last_name: 'Fixture', email: `${customerId}@example.invalid`,
          phone: '+19415550100', active: true, property_type: 'residential', address_line1: '100 Example Court',
          city: 'Parrish', state: 'FL', zip: '34219', pipeline_stage: 'active_customer', autopay_enabled: false,
        });
        await trx('estimates').insert({
          id: estimateId, customer_id: customerId, status: 'accepted', token: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
          category: 'RESIDENTIAL', monthly_total: 50, annual_total: 600,
          estimate_data: { result: { recurring: { services: [{
            service: 'pest_control', name: 'Quarterly Pest Control', visitsPerYear: 4, frequency: 'quarterly', annual: 600, mo: 50, perTreatment: 150,
          }] } } },
        });
        [{ id: visitId }] = await trx('scheduled_services').insert({
          customer_id: customerId, technician_id: ownerId, source_estimate_id: estimateId, service_id: service.id,
          service_key_snapshot: service.service_key, service_type: service.name, scheduled_date: '2099-07-06',
          window_start: '09:00', window_end: '10:00', status: 'pending', estimated_duration_minutes: 60,
        }).returning('id');
        await converter.convertEstimate(estimateId, {
          database: trx, skipSetupInvoice: true, autoSendInvoice: false, skipMembershipEmail: true,
          deferFollowUpReminderRegistration: true, deferCommercialScheduleNotification: true,
        });
        expect(lineTech.recordLinePickShadow).toHaveBeenCalledWith(expect.objectContaining({
          source: 'estimate_accept', trx, scheduledServiceId: visitId, customerId, actualTechnicianId: ownerId,
          serviceId: service.id, serviceType: service.name,
        }));
      } finally {
        await trx.rollback();
      }
      await settle();
      await new Promise((r) => setTimeout(r, 400));
      // The accept's transaction never committed (this suite rolls it back): no row, and no stray fixture.
      expect(await db('service_line_pick_shadow').where({ scheduled_service_id: visitId })).toHaveLength(0);
      expect(await db('customers').where({ id: customerId }).first()).toBeUndefined();
    });
  });

  describe('estimate accept, live (build 4 part B)', () => {
    // A pest + lawn estimate accepted on the pest slot of the pest home tech: live books the
    // lawn program the same day with no time on the lawn technician; shadow copies the slot.
    const acceptPestLawn = async (mode) => {
      process.env.GATE_SERVICE_LINE_MAP = mode;
      await db('service_line_techs').insert([lineRow('general', hireId, ownerId), lineRow('lawn', ownerId, null)]);
      const converter = require('../services/estimate-converter');
      const customerId = randomUUID();
      const estimateId = randomUUID();
      const service = await db('services').where({ service_key: 'pest_general_quarterly' }).first('id', 'name', 'service_key');
      const trx = await db.transaction();
      try {
        await trx('customers').insert({
          id: customerId, first_name: 'Synthetic', last_name: 'Fixture', email: `${customerId}@example.invalid`,
          phone: '+19415550101', active: true, property_type: 'residential', address_line1: '101 Example Court',
          city: 'Parrish', state: 'FL', zip: '34219', pipeline_stage: 'active_customer', autopay_enabled: false,
        });
        await trx('estimates').insert({
          id: estimateId, customer_id: customerId, status: 'accepted', token: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
          category: 'RESIDENTIAL', monthly_total: 95, annual_total: 1140,
          estimate_data: { result: { recurring: { services: [
            { service: 'pest_control', name: 'Quarterly Pest Control', visitsPerYear: 4, frequency: 'quarterly', annual: 600, mo: 50, perTreatment: 150 },
            { service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9, frequency: 'every_6_weeks', annual: 540, mo: 45, perTreatment: 60 },
          ] } } },
        });
        await trx('scheduled_services').insert({
          customer_id: customerId, technician_id: hireId, source_estimate_id: estimateId, service_id: service.id,
          service_key_snapshot: service.service_key, service_type: service.name, scheduled_date: MONDAY,
          window_start: '09:00', window_end: '10:00', status: 'pending', estimated_duration_minutes: 60, estimated_price: 150,
        });
        await converter.convertEstimate(estimateId, {
          database: trx, skipSetupInvoice: true, autoSendInvoice: false, skipMembershipEmail: true,
          deferFollowUpReminderRegistration: true, deferCommercialScheduleNotification: true,
        });
        const rows = await trx('scheduled_services').where({ source_estimate_id: estimateId })
          .whereNull('recurring_parent_id')
          .select('service_type', 'scheduled_date', 'window_start', 'technician_id', 'notes');
        return rows.find((r) => /lawn/i.test(r.service_type)) || null;
      } finally {
        await trx.rollback();
      }
    };

    test('live: the lawn program is booked the same day with no time on the lawn technician', async () => {
      const lawn = await acceptPestLawn('live');
      expect(lawn).not.toBeNull();
      expect(lawn.window_start).toBeNull();
      expect(lawn.technician_id).toBe(ownerId);
      expect(String(lawn.scheduled_date instanceof Date ? lawn.scheduled_date.toISOString() : lawn.scheduled_date)).toContain(MONDAY);
      expect(lawn.notes).toContain('This program has its own technician, so we will set its time separately.');
    });

    test('live: a database error inside the map lookup stays in its savepoint; the accept completes with today\'s copy', async () => {
      const spy = jest.spyOn(lineTech, 'pickLineTechnician').mockImplementation(async (conn) => {
        await conn.raw('select 1/0'); // a real PostgreSQL error on the accept's connection
        return null;
      });
      try {
        const lawn = await acceptPestLawn('live');
        expect(spy).toHaveBeenCalled();
        expect(lawn).not.toBeNull();
        expect(String(lawn.window_start).slice(0, 5)).toBe('09:00');
        expect(lawn.technician_id).toBe(hireId);
      } finally {
        spy.mockRestore();
      }
    });

    test('shadow: the lawn program copies the picked slot and technician, as today', async () => {
      const lawn = await acceptPestLawn('shadow');
      expect(lawn).not.toBeNull();
      expect(String(lawn.window_start).slice(0, 5)).toBe('09:00');
      expect(lawn.technician_id).toBe(hireId);
      expect(lawn.notes).not.toContain('its own technician');
    });
  });

  describe('Team-tab editor routes', () => {
    test('gate off: all three routes answer 404', async () => {
      for (const [method, path] of [['get', '/service-lines'], ['put', '/service-lines'], ['get', '/service-lines/shadow-summary']]) {
        const res = await call(method, path, { body: { lines: [] } });
        expect(res.statusCode).toBe(404);
      }
    });

    test('GET lists all five lines, empty until saved', async () => {
      process.env.GATE_SERVICE_LINE_MAP = 'shadow';
      const res = await call('get', '/service-lines');
      expect(res.body.lines.map((l) => l.service_category)).toEqual(['general', 'mosquito', 'lawn', 'rodent', 'termite']);
      expect(res.body.lines.every((l) => l.home_technician_id === null && l.gap_technician_id === null)).toBe(true);
    });

    test('PUT saves, reads back, upserts, clears with null, and leaves lines not sent alone', async () => {
      process.env.GATE_SERVICE_LINE_MAP = 'shadow';
      const saved = await call('put', '/service-lines', { technicianId: ownerId, body: { lines: [
        { service_category: 'general', home_technician_id: futureId, gap_technician_id: ownerId },
        { service_category: 'lawn', home_technician_id: ownerId, gap_technician_id: null },
      ] } });
      expect(saved.statusCode).toBe(200);
      expect(saved.body.lines.find((l) => l.service_category === 'general')).toMatchObject({ home_technician_id: futureId, gap_technician_id: ownerId });
      const again = await call('put', '/service-lines', { technicianId: ownerId, body: { lines: [
        { service_category: 'general', home_technician_id: null, gap_technician_id: ownerId.toUpperCase() },
      ] } });
      expect(again.body.lines.find((l) => l.service_category === 'general')).toMatchObject({ home_technician_id: null, gap_technician_id: ownerId });
      expect(again.body.lines.find((l) => l.service_category === 'lawn')).toMatchObject({ home_technician_id: ownerId });
      expect(await db('service_line_techs').where({ service_category: 'general' }).first()).toMatchObject({ updated_by: ownerId });
    });

    test('PUT refuses a bad body: unknown line, repeats, missing fields, malformed or unknown ids, a newly picked inactive tech', async () => {
      process.env.GATE_SERVICE_LINE_MAP = 'shadow';
      const bad = async (lines) => (await call('put', '/service-lines', { body: { lines } })).statusCode;
      expect(await bad(undefined)).toBe(400);
      expect(await bad([])).toBe(400);
      expect(await bad([{ service_category: 'bogus', home_technician_id: null, gap_technician_id: null }])).toBe(400);
      expect(await bad([
        { service_category: 'lawn', home_technician_id: null, gap_technician_id: null },
        { service_category: 'lawn', home_technician_id: null, gap_technician_id: null },
      ])).toBe(400);
      expect(await bad([{ service_category: 'lawn', home_technician_id: ownerId }])).toBe(400);
      expect(await bad([{ service_category: 'lawn', home_technician_id: 'not-a-uuid', gap_technician_id: null }])).toBe(400);
      expect(await bad([{ service_category: 'lawn', home_technician_id: randomUUID(), gap_technician_id: null }])).toBe(400);
      expect(await bad([{ service_category: 'lawn', home_technician_id: goneId, gap_technician_id: null }])).toBe(400);
      expect(await db('service_line_techs')).toHaveLength(0);
      // A technician who has since left may stay where already saved.
      await db('service_line_techs').insert(lineRow('lawn', goneId, null));
      expect(await bad([{ service_category: 'lawn', home_technician_id: goneId, gap_technician_id: ownerId }])).toBe(200);
    });

    test('shadow summary: counts by source and by line and reason, and how many differ', async () => {
      process.env.GATE_SERVICE_LINE_MAP = 'shadow';
      const old = new Date(Date.now() - 40 * 86400000);
      const rows = [
        { source: 'book', service_line: 'general', would_reason: 'home', actual_technician_id: ownerId, would_technician_id: hireId, would_free: true },
        { source: 'book', service_line: 'general', would_reason: 'home', actual_technician_id: hireId, would_technician_id: hireId, would_free: false },
        { source: 'night_run', service_line: 'lawn', would_reason: 'gap_off_day', actual_technician_id: ownerId, would_technician_id: ownerId },
        { source: 'office_auto', service_line: 'lawn', would_reason: 'no_map', actual_technician_id: null, would_technician_id: null },
        { source: 'book', service_line: 'general', would_reason: 'home', actual_technician_id: ownerId, would_technician_id: hireId, created_at: old },
      ].map((r) => ({ run_id: run, ...r }));
      await db('service_line_pick_shadow').insert(rows);
      // The summary reads the whole table; count only this run by diffing against the other rows.
      const others = await db('service_line_pick_shadow').whereNot({ run_id: run }).count('* as n').first();
      const res = await call('get', '/service-lines/shadow-summary', { query: {} });
      expect(res.body.days).toBe(14);
      expect(res.body.total - Number(others.n)).toBe(4);
      const source = (name) => res.body.bySource.find((r) => r.source === name)?.count || 0;
      expect(source('night_run')).toBeGreaterThanOrEqual(1);
      expect(res.body.differs).toBeGreaterThanOrEqual(1);
      expect(res.body.byLineReason).toEqual(expect.arrayContaining([
        expect.objectContaining({ service_line: 'general', would_reason: 'home', count: expect.any(Number) }),
        expect.objectContaining({ service_line: 'lawn', would_reason: 'gap_off_day' }),
      ]));
      const wide = await call('get', '/service-lines/shadow-summary', { query: { days: '90' } });
      expect(wide.body.days).toBe(90);
      expect(wide.body.total - Number(others.n)).toBe(5);
      const capped = await call('get', '/service-lines/shadow-summary', { query: { days: '9999' } });
      expect(capped.body.days).toBe(90);
    });

    test('the roster marks the response only while the gate is shadow', async () => {
      const off = await call('get', '/technicians');
      expect(off.body.serviceLinesEnabled).toBeUndefined();
      process.env.GATE_SERVICE_LINE_MAP = 'shadow';
      const on = await call('get', '/technicians');
      expect(on.body.serviceLinesEnabled).toBe(true);
    });
  });
});
