/**
 * Real-PostgreSQL coverage for call-estimate-link-shadow.js's raw SQL. A mocked knex cannot catch a
 * Postgres parser rejection or a jsonb operator that reads the wrong path, so this drives the
 * staging scan's jsonb filter, the metadata merge and the conditional decide write against a real
 * database. Sending is not in this module at all, so nothing here is mocked except logging.
 *
 * Self-skips without CALL_BOOKING_LINK_TEST_DATABASE_URL (the same variable, and the same CI step, as
 * call-booking-link-text-postgres.test.js), e.g.:
 *   CALL_BOOKING_LINK_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest server/tests/call-estimate-link-shadow-postgres.test.js --runInBand
 * Never a shared or prod database: this creates one throwaway schema, clones the migrated public
 * tables into it, and drops the whole schema in afterAll.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../models/marker-db', () => () => mockPg);

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const shadow = require('../services/call-estimate-link-shadow');

const connection = process.env.CALL_BOOKING_LINK_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `call_estimate_shadow_${randomUUID().replaceAll('-', '')}`;
const TABLES = ['customers', 'call_log', 'estimates'];
const KEY = shadow.METADATA_KEY;
let admin;
let mockPg;
jest.setTimeout(30000);

// 18:00Z in January is 13:00 ET: inside the send window.
const NOW = new Date('2027-01-15T18:00:00.000Z');
const CALL_AT = new Date('2027-01-15T15:55:00.000Z'); // 120 s long: send_at 17:57Z, 3 minutes before NOW

const extraction = (serviceRequest) => ({ meta: {}, service_request: serviceRequest });

async function insertCall(conn, overrides = {}) {
  const id = overrides.id || randomUUID();
  await conn('call_log').insert({
    id,
    direction: 'inbound',
    from_phone: '+15555550100',
    duration_seconds: 120,
    v2_extraction_status: 'valid',
    processing_token: null,
    ai_extraction_enriched: JSON.stringify(extraction({ estimate_response: 'accepted' })),
    metadata: JSON.stringify({}),
    created_at: CALL_AT,
    updated_at: CALL_AT,
    ...overrides,
    ...(overrides.ai_extraction_enriched !== undefined ? { ai_extraction_enriched: JSON.stringify(overrides.ai_extraction_enriched) } : {}),
    ...(overrides.metadata !== undefined ? { metadata: JSON.stringify(overrides.metadata) } : {}),
  });
  return id;
}

async function insertCustomer(conn, id = randomUUID()) {
  await conn('customers').insert({ id, first_name: 'Dana', last_name: 'Example', phone: '+15555550123', address_line1: '12 Example St', city: 'Bradenton', zip: '34205' });
  return id;
}

async function insertEstimate(conn, customerId, overrides = {}) {
  const id = randomUUID();
  await conn('estimates').insert({
    id, customer_id: customerId, status: 'sent', sent_at: new Date('2027-01-14T15:00:00.000Z'), created_at: new Date('2027-01-14T14:00:00.000Z'),
    estimate_data: {}, ...overrides,
  });
  return id;
}

const metadataOf = async (id) => (await mockPg('call_log').where({ id }).first('metadata')).metadata;

postgres('call-estimate-link-shadow against PostgreSQL', () => {
  beforeAll(async () => {
    if (!/^\/(waves_test|waves_qa_[a-f0-9]+)$/.test(new URL(connection).pathname)) {
      throw new Error('Use an explicitly selected synthetic Waves QA database');
    }
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 5 } });
    for (const table of TABLES) {
      await admin.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
  });

  afterAll(async () => {
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  beforeEach(async () => {
    for (const table of TABLES) await mockPg(table).delete();
  });

  test('the staging scan picks a yes-family call and leaves undecided, declined, null, an older schema row and a decided row alone', async () => {
    const customerId = await insertCustomer(mockPg);
    const estimateId = await insertEstimate(mockPg, customerId);
    const accepted = await insertCall(mockPg, { customer_id: customerId });
    const withCondition = await insertCall(mockPg, { customer_id: customerId, ai_extraction_enriched: extraction({ estimate_response: 'accepted_with_condition' }) });
    const undecided = await insertCall(mockPg, { customer_id: customerId, ai_extraction_enriched: extraction({ estimate_response: 'undecided' }) });
    const declined = await insertCall(mockPg, { customer_id: customerId, ai_extraction_enriched: extraction({ estimate_response: 'declined' }) });
    const nullAnswer = await insertCall(mockPg, { customer_id: customerId, ai_extraction_enriched: extraction({ estimate_response: null }) });
    const olderSchema = await insertCall(mockPg, { customer_id: customerId, ai_extraction_enriched: extraction({ service_intent: 'one_time' }) });
    const decidedAlready = await insertCall(mockPg, { customer_id: customerId, metadata: { [KEY]: { status: 'skipped', reason: 'booked' } } });
    const midReprocess = await insertCall(mockPg, { customer_id: customerId, processing_token: randomUUID() });
    const tooNew = await insertCall(mockPg, { customer_id: customerId, updated_at: new Date(NOW.getTime() - 60 * 1000) });
    const tooOld = await insertCall(mockPg, { customer_id: customerId, created_at: new Date('2027-01-01T10:00:00.000Z'), updated_at: new Date('2027-01-01T10:00:00.000Z') });

    expect(await shadow.stage(mockPg, { now: NOW })).toEqual({ staged: 2, ineligible: 0 });

    const sendAt = '2027-01-15T17:57:00.000Z';
    expect((await metadataOf(accepted))[KEY]).toEqual({ status: 'pending', estimate_id: estimateId, answer: 'accepted', send_at: sendAt, staged_at: NOW.toISOString() });
    expect((await metadataOf(withCondition))[KEY]).toMatchObject({ status: 'pending', answer: 'accepted_with_condition' });
    for (const id of [undecided, declined, nullAnswer, olderSchema, midReprocess, tooNew, tooOld]) expect((await metadataOf(id))[KEY]).toBeUndefined();
    expect((await metadataOf(decidedAlready))[KEY]).toEqual({ status: 'skipped', reason: 'booked' });
  });

  test('a second stage changes nothing', async () => {
    const customerId = await insertCustomer(mockPg);
    await insertEstimate(mockPg, customerId);
    const callId = await insertCall(mockPg, { customer_id: customerId });
    await shadow.stage(mockPg, { now: NOW });
    const first = await metadataOf(callId);
    expect(await shadow.stage(mockPg, { now: new Date(NOW.getTime() + 60 * 1000) })).toEqual({ staged: 0, ineligible: 0 });
    expect(await metadataOf(callId)).toEqual(first);
  });

  test('the estimate rule on real rows: archived, not yet sent, sent after the call, expired and another customer\'s do not count', async () => {
    const customerId = await insertCustomer(mockPg);
    const other = await insertCustomer(mockPg);
    const wanted = await insertEstimate(mockPg, customerId, { status: 'viewed' });
    await insertEstimate(mockPg, customerId, { archived_at: new Date('2027-01-14T16:00:00.000Z') });
    await insertEstimate(mockPg, customerId, { status: 'draft', sent_at: null });
    await insertEstimate(mockPg, customerId, { sent_at: new Date('2027-01-15T16:30:00.000Z') }); // sent after the call began
    await insertEstimate(mockPg, customerId, { expires_at: new Date('2027-01-15T12:00:00.000Z') }); // expired before the call
    await insertEstimate(mockPg, customerId, { status: 'declined', declined_at: new Date('2027-01-14T18:00:00.000Z') });
    await insertEstimate(mockPg, other);
    const callId = await insertCall(mockPg, { customer_id: customerId });
    await shadow.stage(mockPg, { now: NOW });
    expect((await metadataOf(callId))[KEY]).toMatchObject({ status: 'pending', estimate_id: wanted });
  });

  test('updated_at with microseconds: the claim still matches (a Date would have dropped them) and the call is staged', async () => {
    const customerId = await insertCustomer(mockPg);
    await insertEstimate(mockPg, customerId);
    const callId = await insertCall(mockPg, { customer_id: customerId, updated_at: '2027-01-15 15:55:00.123456+00' });
    const stored = await mockPg('call_log').where({ id: callId }).first(mockPg.raw('updated_at::text AS key'));
    expect(stored.key).toMatch(/\.123456/);
    expect(await shadow.stage(mockPg, { now: NOW })).toEqual({ staged: 1, ineligible: 0 });
    expect((await metadataOf(callId))[KEY].status).toBe('pending');
  });

  test('"open at the call" is historical: an estimate accepted AFTER the call began (before staging) still makes the call several', async () => {
    const customerId = await insertCustomer(mockPg);
    await insertEstimate(mockPg, customerId, { status: 'viewed' });
    await insertEstimate(mockPg, customerId, { status: 'accepted', accepted_at: new Date('2027-01-15T16:30:00.000Z') });
    const callId = await insertCall(mockPg, { customer_id: customerId });
    await shadow.stage(mockPg, { now: NOW });
    expect((await metadataOf(callId))[KEY].reason).toBe('several_open_estimates');
  });

  test('an estimate archived after the call began counts too; one closed BEFORE the call does not', async () => {
    const laterClosed = await insertCustomer(mockPg);
    await insertEstimate(mockPg, laterClosed);
    await insertEstimate(mockPg, laterClosed, { archived_at: new Date('2027-01-15T16:40:00.000Z') });
    const earlierClosed = await insertCustomer(mockPg);
    const kept = await insertEstimate(mockPg, earlierClosed);
    await insertEstimate(mockPg, earlierClosed, { status: 'accepted', accepted_at: new Date('2027-01-14T20:00:00.000Z') });
    const laterCall = await insertCall(mockPg, { customer_id: laterClosed });
    const earlierCall = await insertCall(mockPg, { customer_id: earlierClosed });
    await shadow.stage(mockPg, { now: NOW });
    expect((await metadataOf(laterCall))[KEY].reason).toBe('several_open_estimates');
    expect((await metadataOf(earlierCall))[KEY]).toMatchObject({ status: 'pending', estimate_id: kept });
  });

  test('"sent before the call" is the FIRST delivery: a resend after the call does not unpin it, and a held send is no delivery', async () => {
    const resent = await insertCustomer(mockPg);
    const resentEstimate = await insertEstimate(mockPg, resent, {
      sent_at: new Date('2027-01-15T16:30:00.000Z'),
      estimate_data: { deliveryState: { firstDeliveredAt: '2027-01-14T15:00:00.000Z', lastDeliveredAt: '2027-01-15T16:30:00.000Z' } },
    });
    const held = await insertCustomer(mockPg);
    await insertEstimate(mockPg, held, { sent_at: new Date('2027-01-14T15:00:00.000Z'), estimate_data: { deliveryState: {} } });
    const legacy = await insertCustomer(mockPg);
    const legacyEstimate = await insertEstimate(mockPg, legacy, { estimate_data: {} });
    const resentCall = await insertCall(mockPg, { customer_id: resent });
    const heldCall = await insertCall(mockPg, { customer_id: held });
    const legacyCall = await insertCall(mockPg, { customer_id: legacy });
    await shadow.stage(mockPg, { now: NOW });
    expect((await metadataOf(resentCall))[KEY]).toMatchObject({ status: 'pending', estimate_id: resentEstimate });
    expect((await metadataOf(heldCall))[KEY].reason).toBe('no_open_estimate');
    expect((await metadataOf(legacyCall))[KEY]).toMatchObject({ status: 'pending', estimate_id: legacyEstimate });
  });

  test('two open estimates, none, and no customer are recorded as skips with their reasons', async () => {
    const two = await insertCustomer(mockPg);
    await insertEstimate(mockPg, two);
    await insertEstimate(mockPg, two);
    const none = await insertCustomer(mockPg);
    const severalCall = await insertCall(mockPg, { customer_id: two });
    const noneCall = await insertCall(mockPg, { customer_id: none });
    const noCustomerCall = await insertCall(mockPg, { customer_id: null });
    expect(await shadow.stage(mockPg, { now: NOW })).toEqual({ staged: 0, ineligible: 3 });
    expect((await metadataOf(severalCall))[KEY].reason).toBe('several_open_estimates');
    expect((await metadataOf(noneCall))[KEY].reason).toBe('no_open_estimate');
    expect((await metadataOf(noCustomerCall))[KEY].reason).toBe('no_customer');
  });

  test('the metadata write keeps a sibling key (call_booking_link_text) and any other key intact', async () => {
    const customerId = await insertCustomer(mockPg);
    await insertEstimate(mockPg, customerId);
    const sibling = { status: 'skipped', reason: 'no_lead_linkage', staged_at: '2027-01-15T16:10:00.000Z' };
    const callId = await insertCall(mockPg, { customer_id: customerId, metadata: { call_booking_link_text: sibling, lead_id: 'lead-1' } });
    await shadow.stage(mockPg, { now: NOW });
    const metadata = await metadataOf(callId);
    expect(metadata.call_booking_link_text).toEqual(sibling);
    expect(metadata.lead_id).toBe('lead-1');
    expect(metadata[KEY].status).toBe('pending');
  });

  describe('decide', () => {
    const pendingEntry = (estimateId, sendAt) => ({ status: 'pending', estimate_id: estimateId, answer: 'accepted', send_at: sendAt, staged_at: '2027-01-15T16:10:00.000Z' });

    test('of two decides on the same pending row exactly one wins, and the row ends terminal', async () => {
      const customerId = await insertCustomer(mockPg);
      const estimateId = await insertEstimate(mockPg, customerId, { status: 'accepted' });
      const sendAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
      const callId = await insertCall(mockPg, { customer_id: customerId, metadata: { call_booking_link_text: { status: 'skipped' }, [KEY]: pendingEntry(estimateId, sendAt) } });

      const results = await Promise.all([shadow.decide(mockPg, { now: NOW }), shadow.decide(mockPg, { now: NOW })]);

      expect(results.reduce((sum, r) => sum + r.decided, 0)).toBe(1);
      const metadata = await metadataOf(callId);
      expect(metadata[KEY]).toEqual({
        status: 'skipped', reason: 'estimate_accepted', estimate_id: estimateId, answer: 'accepted', send_at: sendAt,
        staged_at: '2027-01-15T16:10:00.000Z', decided_at: NOW.toISOString(),
      });
      expect(metadata.call_booking_link_text).toEqual({ status: 'skipped' });
      // A third sweep finds nothing pending.
      expect(await shadow.decide(mockPg, { now: NOW })).toEqual({ decided: 0, wouldSend: 0 });
    });

    test('a write whose send_at no longer matches the row loses', async () => {
      const customerId = await insertCustomer(mockPg);
      const estimateId = await insertEstimate(mockPg, customerId, { status: 'accepted' });
      const sendAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
      const callId = await insertCall(mockPg, { customer_id: customerId, metadata: { [KEY]: pendingEntry(estimateId, sendAt) } });
      const staleCopy = pendingEntry(estimateId, new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString());
      expect(await shadow.decideOne(mockPg, callId, staleCopy, NOW)).toBeNull();
      expect((await metadataOf(callId))[KEY].status).toBe('pending');
    });

    test('a call read again while it waited: answer_changed (a no, or a read no longer valid) and customer_changed, written for real', async () => {
      const customerId = await insertCustomer(mockPg);
      const estimateId = await insertEstimate(mockPg, customerId);
      const sendAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
      const metadata = { [KEY]: pendingEntry(estimateId, sendAt) };
      const declined = await insertCall(mockPg, { customer_id: customerId, metadata, ai_extraction_enriched: extraction({ estimate_response: 'declined' }) });
      const invalid = await insertCall(mockPg, { customer_id: customerId, metadata, v2_extraction_status: 'pending' });
      const moved = await insertCall(mockPg, { customer_id: await insertCustomer(mockPg), metadata });
      const reprocessing = await insertCall(mockPg, { customer_id: customerId, metadata, processing_token: randomUUID() });

      expect(await shadow.decide(mockPg, { now: NOW })).toEqual({ decided: 3, wouldSend: 0 });

      expect((await metadataOf(declined))[KEY]).toMatchObject({ reason: 'answer_changed', answer_now: 'declined' });
      expect((await metadataOf(invalid))[KEY]).toMatchObject({ reason: 'answer_changed', answer_now: 'accepted' });
      expect((await metadataOf(moved))[KEY]).toMatchObject({ reason: 'customer_changed' });
      expect((await metadataOf(reprocessing))[KEY].status).toBe('pending');
    });

    test('a row whose send time is still ahead is not read or decided', async () => {
      const customerId = await insertCustomer(mockPg);
      const estimateId = await insertEstimate(mockPg, customerId, { status: 'accepted' });
      const sendAt = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
      const callId = await insertCall(mockPg, { customer_id: customerId, metadata: { [KEY]: pendingEntry(estimateId, sendAt) } });
      expect(await shadow.decide(mockPg, { now: NOW })).toEqual({ decided: 0, wouldSend: 0 });
      expect((await metadataOf(callId))[KEY].status).toBe('pending');
    });
  });
});
