const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { computeCustomerPickerConversion } = require('../services/ops-scoreboard');

(SKIP ? describe.skip : describe)('customer picker conversion on PostgreSQL', () => {
  let db;
  const schema = `picker_conversion_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !ownedQA) {
      throw new Error('Use the disposable CI database or this managed worktree\'s private QA database');
    }
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'] });
    await db.raw('CREATE SCHEMA ??', [schema]);
    await db.schema.createTable('audit_log', (table) => {
      table.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      table.text('actor_type');
      table.text('action');
      table.text('resource_type');
      table.uuid('resource_id');
      table.jsonb('metadata');
      table.timestamp('created_at', { useTz: true }).notNullable();
    });
    await db.schema.createTable('scheduled_services', (table) => {
      table.uuid('id').primary();
      table.uuid('source_estimate_id');
      table.uuid('customer_id');
      table.text('status');
      table.timestamp('reservation_expires_at', { useTz: true });
    });
  });

  afterAll(async () => {
    if (db) {
      await db.raw('DROP SCHEMA ?? CASCADE', [schema]);
      await db.destroy();
    }
  });

  test('deduplicates selections and counts only same-estimate customer-linked rows', async () => {
    const [bookedEstimate, wrongEstimate, pendingEstimate, outsideEstimate] = Array.from({ length: 4 }, randomUUID);
    const [booked, wrong, pending, outside] = Array.from({ length: 4 }, randomUUID);
    const customerId = randomUUID();
    const event = (resourceId, serviceId, patch = {}) => ({
      actor_type: 'customer', action: 'estimate_hold_started', resource_type: 'estimate',
      resource_id: resourceId, metadata: { scheduled_service_id: serviceId },
      created_at: new Date('2026-11-17T12:00:00Z'), ...patch,
    });
    await db('audit_log').insert([
      event(bookedEstimate, booked),
      event(bookedEstimate, booked),
      event(wrongEstimate, wrong),
      event(pendingEstimate, pending),
      event(outsideEstimate, outside, { created_at: new Date('2026-11-17T04:59:59Z') }),
      event(randomUUID(), randomUUID(), { actor_type: 'staff' }),
    ]);
    await db('scheduled_services').insert([
      { id: booked, source_estimate_id: bookedEstimate, customer_id: customerId,
        status: 'cancelled', reservation_expires_at: new Date('2026-11-17T13:00:00Z') },
      { id: wrong, source_estimate_id: randomUUID(), customer_id: customerId, status: 'confirmed' },
      { id: pending, source_estimate_id: pendingEstimate, customer_id: null, status: 'pending' },
      { id: outside, source_estimate_id: outsideEstimate, customer_id: customerId, status: 'confirmed' },
    ]);

    await expect(computeCustomerPickerConversion({ from: '2026-11-17', to: '2026-11-17' }, db)).resolves.toEqual({
      numerator: 1, denominator: 3, share: 1 / 3,
      selectedAppointments: 3, bookedAppointments: 1, appointmentShare: 1 / 3,
    });
  });
});
