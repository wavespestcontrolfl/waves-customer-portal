/** Token identity and customer projection on isolated synthetic PostgreSQL. */
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../utils/scheduled-cron', () => ({ schedule: jest.fn(), scheduleTimeout: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID, createHash } = require('crypto');
const Summary = require('../services/visit-completion-summary');
const { etDateString } = require('../utils/datetime-et');
const { stopBaseKey } = require('../services/visit-groups');
const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
let mockPg;
let fixture;
jest.setTimeout(90000);

(connection ? describe : describe.skip)('visit summary identity', () => {
  beforeAll(() => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a task-private QA database or the isolated CI database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  beforeEach(async () => {
    fixture = { customerId: randomUUID(), techId: randomUUID(), visitId: randomUUID(), packetId: randomUUID(),
      serviceId: randomUUID(), recordId: randomUUID(), date: etDateString() };
    await mockPg.transaction(async (trx) => {
      await trx('customers').insert({ id: fixture.customerId, first_name: 'Fixture', email: 'identity@example.invalid', phone: '+12025550123' });
      await trx('technicians').insert({ id: fixture.techId, name: 'Fixture Technician', role: 'technician', active: true });
      await trx('service_visits').insert({ id: fixture.visitId, customer_id: fixture.customerId, technician_id: fixture.techId,
        scheduled_date: fixture.date, window_start: '09:00', window_end: '11:00', status: 'closing',
        stop_base_key: stopBaseKey({ customerId: fixture.customerId, scheduledDate: fixture.date }), created_by: 'test' });
      await trx('scheduled_services').insert({ id: fixture.serviceId, customer_id: fixture.customerId,
        technician_id: fixture.techId, visit_id: fixture.visitId, service_type: 'Fixture Pest Control',
        scheduled_date: fixture.date, window_start: '09:00', window_end: '10:00', status: 'completed' });
      await trx('service_records').insert({ id: fixture.recordId, customer_id: fixture.customerId,
        scheduled_service_id: fixture.serviceId, service_type: 'Fixture Pest Control', service_date: fixture.date,
        status: 'completed', report_view_token: 'a'.repeat(32),
        structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', privateNote: 'Synthetic internal note' }) });
      await trx('visit_completion_packets').insert({ id: fixture.packetId, visit_id: fixture.visitId,
        idempotency_key: randomUUID(), request_hash: 'a'.repeat(64),
        payload: JSON.stringify({ items: [{ serviceId: fixture.serviceId, body: {} }] }), status: 'processing' });
      await trx('visit_completion_packet_items').insert({ packet_id: fixture.packetId,
        scheduled_service_id: fixture.serviceId, service_record_id: fixture.recordId,
        derived_idempotency_key: randomUUID(), status: 'done' });
    });
  });
  afterEach(async () => {
    await mockPg('customers').where({ id: fixture.customerId }).del();
    await mockPg('technicians').where({ id: fixture.techId }).del();
  });

  test('concurrent issuance preserves one encrypted token and an explicit customer projection', async () => {
    const tokens = await Promise.all([Summary.ensureVisitSummaryToken(fixture.packetId), Summary.ensureVisitSummaryToken(fixture.packetId)]);
    expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(tokens[1]).toBe(tokens[0]);
    const visit = await mockPg('service_visits').where({ id: fixture.visitId }).first();
    expect(visit.summary_token_hash).toBe(createHash('sha256').update(tokens[0]).digest('hex'));
    expect(visit.summary_token_enc.toString()).not.toContain(tokens[0]);
    expect(await Summary.getVisitCompletionSummary(tokens[0])).toEqual({ serviceDate: fixture.date, services: [{
      id: fixture.recordId, serviceType: 'Fixture Pest Control', outcome: 'completed', reportUrl: `/report/${'a'.repeat(32)}`,
    }] });
  });

  test('malformed tokens are rejected before any database read', async () => {
    const queries = [];
    const collect = (query) => queries.push(query);
    mockPg.on('query', collect);
    try {
      for (const token of [null, '', 'a'.repeat(63), 'A'.repeat(64), 'z'.repeat(64)]) {
        expect(await Summary.getVisitCompletionSummary(token)).toBeNull();
      }
      expect(queries).toHaveLength(0);
    } finally { mockPg.removeListener('query', collect); }
  });

  test('revocation prevents reads and reissuance while preserving the original identity', async () => {
    const token = await Summary.ensureVisitSummaryToken(fixture.packetId);
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ summary_token_revoked_at: mockPg.fn.now() });
    expect(await Summary.getVisitCompletionSummary(token)).toBeNull();
    expect(await Summary.ensureVisitSummaryToken(fixture.packetId)).toBeNull();
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).summary_token_hash)
      .toBe(createHash('sha256').update(token).digest('hex'));
  });

  test('a revocation attempted while a read is projecting waits for that read, and the next read refuses', async () => {
    const token = await Summary.ensureVisitSummaryToken(fixture.packetId);
    const execute = mockPg.client.constructor.prototype._query;
    let blockedCode = null;
    let raced = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function revokeDuringProjection(connection, query) {
      if (!raced && query.sql.startsWith('select "id" from "visit_completion_packets"')) {
        raced = true;
        // The admin revoke: an UPDATE of the held visit row.
        await mockPg.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await trx('service_visits').where({ id: fixture.visitId }).whereNull('summary_token_revoked_at').update({ summary_token_revoked_at: trx.fn.now() });
        }).catch((err) => { blockedCode = err.code; });
      }
      return execute.call(this, connection, query);
    });
    try {
      expect(await Summary.getVisitCompletionSummary(token)).toMatchObject({ services: [expect.objectContaining({ outcome: 'completed' })] });
      expect(raced).toBe(true);
      expect(blockedCode).toBe('55P03');
    } finally {
      jest.restoreAllMocks();
    }
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ summary_token_revoked_at: mockPg.fn.now() });
    expect(await Summary.getVisitCompletionSummary(token)).toBeNull();
  });

  test('unfinished reports cannot mint a token and preparation errors stay generic', async () => {
    await mockPg('visit_completion_packet_items').where({ packet_id: fixture.packetId }).update({ status: 'processing' });
    await expect(Summary.ensureVisitSummaryToken(fixture.packetId)).rejects.toThrow('Visit summary link could not be prepared');
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).summary_token_hash).toBeNull();
  });

  test.each([{ backfill: true }, { typedReportDelivery: 'internal_only' }])('hidden reports never enter the customer projection: %j', async (notes) => {
    await mockPg('service_records').where({ id: fixture.recordId }).update({ structured_notes: JSON.stringify(notes) });
    expect(await Summary.packetHasPublishableSummary(fixture.packetId)).toBe(false);
    const token = await Summary.ensureVisitSummaryToken(fixture.packetId);
    expect(await Summary.getVisitCompletionSummary(token)).toBeNull();
  });
});
