/**
 * Real PostgreSQL proof for the lead-detail outcome scope. All records live in
 * a disposable schema and use synthetic UUIDs. Opt in with a loopback
 * LEAD_OUTCOMES_TEST_DATABASE_URL.
 */
const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');
const { randomUUID } = require('crypto');
const { _relatedVisits: { loadLeadRelatedVisits, RELATED_VISITS_LIMIT } } = require('../routes/admin-leads');

const connection = process.env.LEAD_OUTCOMES_TEST_DATABASE_URL;
const describePg = connection ? describe : describe.skip;

jest.setTimeout(30000);

describe('admin lead detail outcome wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin-leads.js'), 'utf8');

  test('outcomes are opt-in and expose bounded availability at the top level', () => {
    expect(source).toContain("req.query.include_outcomes === '1'");
    expect(source).toContain('response.related_visits = related.items');
    expect(source).toContain("response.related_visits_status = 'available'");
    expect(source).toContain('response.related_visits_has_more = related.hasMore');
    expect(source).toContain("response.related_visits_status = 'unavailable'");
    expect(source).toContain('response.related_visits_has_more = null');
  });
});

describePg('admin lead related visits SQL (PostgreSQL 16)', () => {
  const schema = `lead_outcomes_${process.pid}_${Date.now()}`;
  let setup; let db;

  beforeAll(async () => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      throw new Error('LEAD_OUTCOMES_TEST_DATABASE_URL must point to loopback PostgreSQL');
    }
    setup = knexFactory({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    const version = Number((await setup.raw("SELECT current_setting('server_version_num')::int AS version")).rows[0].version);
    if (version < 160000 || version >= 170000) throw new Error(`Expected PostgreSQL 16, got ${version}`);
    await setup.raw('CREATE SCHEMA ??', [schema]);
    db = knexFactory({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 3 } });

    await db.schema.createTable('scheduled_services', (t) => {
      t.uuid('id').primary(); t.string('status'); t.date('scheduled_date');
      t.uuid('customer_id'); t.uuid('self_booking_id'); t.uuid('source_estimate_id');
    });
    await db.schema.createTable('lead_activities', (t) => {
      t.increments('id'); t.uuid('lead_id'); t.string('activity_type'); t.jsonb('metadata'); t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
    });
    await db.schema.createTable('ad_service_attribution', (t) => {
      t.uuid('id').primary(); t.uuid('lead_id'); t.uuid('self_booked_appointment_id');
    });
    await db.schema.createTable('estimates', (t) => {
      t.uuid('id').primary(); t.uuid('customer_id'); t.jsonb('estimate_data');
    });
    await db.schema.createTable('service_records', (t) => {
      t.uuid('id').primary(); t.uuid('scheduled_service_id');
    });
    await db.schema.createTable('invoices', (t) => {
      t.uuid('id').primary(); t.string('status'); t.uuid('scheduled_service_id'); t.uuid('service_record_id');
    });
  });

  afterAll(async () => {
    if (db) await db.destroy();
    if (setup) {
      await setup.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
      await setup.destroy();
    }
  });

  test('includes only exact activity, self-booking attribution, or agreeing estimate ownership', async () => {
    const leadId = randomUUID();
    const otherLeadId = randomUUID();
    const customerId = randomUUID();
    const otherCustomerId = randomUUID();
    const leadEstimateId = randomUUID();
    const mirrorEstimateId = randomUUID();
    const activityVisitId = randomUUID();
    const unknownOwnerActivityVisitId = randomUUID();
    const conflictingOwnerActivityVisitId = randomUUID();
    const selfVisitId = randomUUID();
    const unknownOwnerSelfVisitId = randomUUID();
    const conflictingOwnerSelfVisitId = randomUUID();
    const estimateVisitId = randomUUID();
    const fkEstimateVisitId = randomUUID();
    const customerOnlyVisitId = randomUUID();
    const wrongActivityVisitId = randomUUID();
    const wrongSelfVisitId = randomUUID();
    const conflictingCustomerVisitId = randomUUID();
    const selfBookingId = randomUUID();
    const unknownOwnerSelfBookingId = randomUUID();
    const conflictingOwnerSelfBookingId = randomUUID();
    const wrongSelfBookingId = randomUUID();

    await db('estimates').insert([
      { id: leadEstimateId, customer_id: customerId, estimate_data: {} },
      { id: mirrorEstimateId, customer_id: customerId, estimate_data: { lead_id: leadId } },
    ]);
    await db('scheduled_services').insert([
      { id: activityVisitId, status: 'confirmed', scheduled_date: '2026-11-25', customer_id: customerId },
      { id: unknownOwnerActivityVisitId, status: 'confirmed', scheduled_date: '2026-11-24', customer_id: null },
      { id: conflictingOwnerActivityVisitId, status: 'confirmed', scheduled_date: '2026-11-23', customer_id: otherCustomerId },
      { id: selfVisitId, status: 'pending', scheduled_date: '2026-11-22', customer_id: customerId, self_booking_id: selfBookingId },
      { id: unknownOwnerSelfVisitId, status: 'pending', scheduled_date: '2026-11-21', customer_id: null, self_booking_id: unknownOwnerSelfBookingId },
      { id: conflictingOwnerSelfVisitId, status: 'pending', scheduled_date: '2026-11-20', customer_id: otherCustomerId, self_booking_id: conflictingOwnerSelfBookingId },
      { id: estimateVisitId, status: 'completed', scheduled_date: '2026-11-19', customer_id: customerId, source_estimate_id: mirrorEstimateId },
      { id: fkEstimateVisitId, status: 'confirmed', scheduled_date: '2026-11-18', customer_id: customerId, source_estimate_id: leadEstimateId },
      { id: customerOnlyVisitId, status: 'confirmed', scheduled_date: '2026-11-17', customer_id: customerId },
      { id: wrongActivityVisitId, status: 'confirmed', scheduled_date: '2026-11-16', customer_id: customerId },
      { id: wrongSelfVisitId, status: 'confirmed', scheduled_date: '2026-11-15', customer_id: customerId, self_booking_id: wrongSelfBookingId },
      { id: conflictingCustomerVisitId, status: 'confirmed', scheduled_date: '2026-11-14', customer_id: otherCustomerId, source_estimate_id: mirrorEstimateId },
    ]);
    await db('lead_activities').insert([
      { lead_id: leadId, activity_type: 'appointment_scheduled', metadata: { appointmentId: activityVisitId } },
      { lead_id: leadId, activity_type: 'appointment_scheduled', metadata: { appointmentId: unknownOwnerActivityVisitId } },
      { lead_id: leadId, activity_type: 'appointment_scheduled', metadata: { appointmentId: conflictingOwnerActivityVisitId } },
      { lead_id: otherLeadId, activity_type: 'appointment_scheduled', metadata: { appointmentId: wrongActivityVisitId } },
    ]);
    await db('ad_service_attribution').insert([
      { id: randomUUID(), lead_id: leadId, self_booked_appointment_id: selfBookingId },
      { id: randomUUID(), lead_id: leadId, self_booked_appointment_id: unknownOwnerSelfBookingId },
      { id: randomUUID(), lead_id: leadId, self_booked_appointment_id: conflictingOwnerSelfBookingId },
      { id: randomUUID(), lead_id: otherLeadId, self_booked_appointment_id: wrongSelfBookingId },
    ]);

    const serviceRecordId = randomUUID();
    const directInvoiceId = randomUUID();
    const fallbackInvoiceId = randomUUID();
    await db('service_records').insert({ id: serviceRecordId, scheduled_service_id: estimateVisitId });
    await db('invoices').insert([
      { id: directInvoiceId, status: 'paid', scheduled_service_id: estimateVisitId },
      { id: fallbackInvoiceId, status: 'sent', service_record_id: serviceRecordId },
    ]);

    const result = await loadLeadRelatedVisits(db, {
      id: leadId, customer_id: customerId, estimate_id: leadEstimateId,
    });
    expect(result.hasMore).toBe(false);
    expect(result.items.map((visit) => visit.id)).toEqual([
      activityVisitId, unknownOwnerActivityVisitId, selfVisitId, unknownOwnerSelfVisitId,
      estimateVisitId, fkEstimateVisitId,
    ]);
    expect(result.items.find((visit) => visit.id === estimateVisitId).invoices).toEqual(expect.arrayContaining([
      { id: directInvoiceId, status: 'paid' },
      { id: fallbackInvoiceId, status: 'sent' },
    ]));
    expect(result.items.map((visit) => visit.id)).not.toEqual(expect.arrayContaining([
      conflictingOwnerActivityVisitId, conflictingOwnerSelfVisitId,
      customerOnlyVisitId, wrongActivityVisitId, wrongSelfVisitId, conflictingCustomerVisitId,
    ]));
  });

  test('a dissenting estimate lead mirror vetoes a stale leads.estimate_id', async () => {
    const leadId = randomUUID();
    const otherLeadId = randomUUID();
    const estimateId = randomUUID();
    const visitId = randomUUID();
    await db('estimates').insert({ id: estimateId, estimate_data: { lead_id: otherLeadId } });
    await db('scheduled_services').insert({ id: visitId, status: 'pending', scheduled_date: '2026-10-01', source_estimate_id: estimateId });

    const result = await loadLeadRelatedVisits(db, { id: leadId, customer_id: null, estimate_id: estimateId });
    expect(result).toEqual({ items: [], hasMore: false });
  });

  test('caps recurring visits and reports has_more without projecting the extra row', async () => {
    const leadId = randomUUID();
    const customerId = randomUUID();
    const estimateId = randomUUID();
    await db('estimates').insert({ id: estimateId, customer_id: customerId, estimate_data: { lead_id: leadId } });
    const visits = Array.from({ length: RELATED_VISITS_LIMIT + 2 }, (_, index) => ({
      id: randomUUID(),
      status: 'confirmed',
      scheduled_date: `2026-10-${String(index + 1).padStart(2, '0')}`,
      customer_id: customerId,
      source_estimate_id: estimateId,
    }));
    await db('scheduled_services').insert(visits);

    const result = await loadLeadRelatedVisits(db, { id: leadId, customer_id: customerId, estimate_id: null });
    expect(result.hasMore).toBe(true);
    expect(result.items).toHaveLength(RELATED_VISITS_LIMIT);
    const dateOnly = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
    expect(dateOnly(result.items[0].scheduled_date)).toBe('2026-10-27');
    expect(dateOnly(result.items.at(-1).scheduled_date)).toBe('2026-10-03');
  });
});
