// Real migrated PostgreSQL, synthetic grouped stop. Auto-dispatch must reject
// a v2 allocation member during the locked group plan, before the first
// rebooker write, leaving membership and route placement untouched.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');
const { etCalendarDayOf } = require('../utils/datetime-et');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.setTimeout(60000);

postgres('auto-dispatch grouped move preflight', () => {
  let db;
  let moveVisitAsUnit;
  let stopBaseKey;
  const fixtures = [];

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!localCI && !privateQa) throw new Error('Use disposable CI or this worktree\'s private QA database');
    db = require('../models/db');
    ({ moveVisitAsUnit, stopBaseKey } = require('../services/visit-groups'));
  });

  afterEach(async () => {
    for (const f of fixtures.splice(0)) {
      await db('scheduled_services').whereIn('id', f.serviceIds).del();
      await db('service_visits').where({ id: f.visitId }).del();
      await db('technicians').where({ id: f.techId }).del();
      await db('customers').where({ id: f.customerId }).del();
    }
  });

  afterAll(async () => {
    await db?.destroy();
  });

  async function buildGroup({ allocation = true } = {}) {
    const customerId = randomUUID();
    const techId = randomUUID();
    const visitId = randomUUID();
    const serviceIds = [randomUUID(), randomUUID()];
    const date = '2098-11-18';
    fixtures.push({ customerId, techId, visitId, serviceIds });
    await db('technicians').insert({
      id: techId, name: 'Synthetic grouped preflight tech', employment_status: 'active', field_dispatchable: true,
    });
    await db('customers').insert({
      id: customerId, first_name: 'Groupedzq', last_name: 'Preflightzq',
      email: `${customerId}@example.invalid`,
      phone: `+1941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true,
      pipeline_stage: 'active_customer',
    });
    const [catalog] = await db('services').whereIn('service_key', ['pest_general_quarterly', 'lawn_care_6week']).limit(1);
    await db('service_visits').insert({
      id: visitId, customer_id: customerId, scheduled_date: date,
      window_start: '09:00', window_end: '11:00',
      stop_base_key: stopBaseKey({ customerId, scheduledDate: date }), stop_seq: 1,
      technician_id: techId, group_family: 'recurring_property_service', status: 'open', created_by: 'test',
    });
    const base = {
      customer_id: customerId, technician_id: techId, service_id: catalog.id,
      service_type: 'Quarterly Pest Control', status: 'confirmed', scheduled_date: date,
      window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60,
      visit_id: visitId,
    };
    await db('scheduled_services').insert([
      { id: serviceIds[0], ...base },
      {
        id: serviceIds[1], ...base,
        window_start: '10:00', window_end: '11:00',
        ...(allocation ? { reservation_service_mix: {
          version: 2, allocatedServiceIds: serviceIds, durations: [60, 60], durationMinutes: 120,
        } } : {}),
      },
    ]);
    return { customerId, techId, visitId, serviceIds, date, catalogId: catalog.id };
  }

  test('a later v2 sibling rejects before any member write and preserves pin/membership invariants', async () => {
    const f = await buildGroup();
    const rebooker = { reschedule: jest.fn() };

    await expect(moveVisitAsUnit({
      rebooker,
      serviceId: f.serviceIds[0],
      service: { id: f.serviceIds[0], visit_id: f.visitId },
      newDate: '2098-11-19',
      newWindow: '13:00-14:00',
      initiatedBy: 'auto_dispatch',
      reason: 'auto_dispatch',
      options: { seriesPolicy: 'single', keepStatus: true },
    })).rejects.toMatchObject({
      statusCode: 409, code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: f.serviceIds[1],
    });

    expect(rebooker.reschedule).not.toHaveBeenCalled();
    const rows = await db('scheduled_services').whereIn('id', f.serviceIds).orderBy('window_start');
    expect(rows.map((row) => String(row.visit_id))).toEqual([f.visitId, f.visitId]);
    expect(rows.map((row) => String(row.technician_id))).toEqual([f.techId, f.techId]);
    expect(rows.map((row) => row.scheduled_date instanceof Date ? etCalendarDayOf(row.scheduled_date) : String(row.scheduled_date).slice(0, 10))).toEqual([f.date, f.date]);
    expect(rows.map((row) => String(row.window_start).slice(0, 5))).toEqual(['09:00', '10:00']);
    const visit = await db('service_visits').where({ id: f.visitId }).first();
    expect(visit.scheduled_date instanceof Date ? etCalendarDayOf(visit.scheduled_date) : String(visit.scheduled_date).slice(0, 10)).toBe(f.date);
    expect(String(visit.technician_id)).toBe(f.techId);
  });

  test('a destination clash unique to the later sibling rejects the whole group before its primary moves', async () => {
    const f = await buildGroup({ allocation: false });
    const groupIds = [...f.serviceIds];
    const outsideId = randomUUID();
    fixtures[fixtures.length - 1].serviceIds.push(outsideId);
    await db('scheduled_services').insert({
      id: outsideId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
      service_type: 'Quarterly Pest Control', status: 'confirmed', scheduled_date: '2098-11-19',
      window_start: '14:00', window_end: '15:00', estimated_duration_minutes: 60,
    });
    const rebooker = { reschedule: jest.fn() };

    await expect(moveVisitAsUnit({
      rebooker,
      serviceId: groupIds[0],
      service: { id: groupIds[0], visit_id: f.visitId },
      newDate: '2098-11-19',
      newWindow: '13:00-14:00',
      initiatedBy: 'auto_dispatch',
      reason: 'auto_dispatch',
      options: { seriesPolicy: 'single', keepStatus: true },
    })).rejects.toMatchObject({
      statusCode: 409, code: 'SLOT_TAKEN', memberId: groupIds[1], conflictId: outsideId,
    });

    expect(rebooker.reschedule).not.toHaveBeenCalled();
    const rows = await db('scheduled_services').whereIn('id', groupIds).orderBy('window_start');
    expect(rows.map((row) => String(row.visit_id))).toEqual([f.visitId, f.visitId]);
    expect(rows.map((row) => String(row.technician_id))).toEqual([f.techId, f.techId]);
    expect(rows.map((row) => String(row.window_start).slice(0, 5))).toEqual(['09:00', '10:00']);
  });
});
