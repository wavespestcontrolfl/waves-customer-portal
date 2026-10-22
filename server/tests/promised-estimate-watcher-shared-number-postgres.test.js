// The promised-estimate digest's SQL on a real Postgres: which estimates
// clear an UNLINKED call's quote promise (owner 2026-10-21, narrowing codex
// #3738 P1). Runs only with DATABASE_URL (CI's DB-gated step). Fixtures use
// synthetic names and 555-01xx numbers and clean up after themselves.
const SKIP = !process.env.DATABASE_URL;
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const { randomUUID } = require('crypto');

const PHONE = '+15555550166';
const HOUR = 3600000;

(SKIP ? describe.skip : describe)('promised-estimate digest: unlinked call cleared by a linked estimate (live Postgres)', () => {
  let db;
  let loadUnkeptPromises;
  const made = { customers: [], estimates: [], calls: [] };
  let callId;

  beforeAll(async () => {
    db = require('../models/db');
    ({ _private: { loadUnkeptPromises } } = require('../services/promised-estimate-watcher'));
    callId = randomUUID();
    const created = new Date(Date.now() - 48 * HOUR);
    await db('call_log').insert({
      id: callId, twilio_call_sid: `CA${randomUUID().replaceAll('-', '')}`, direction: 'inbound', from_phone: PHONE, to_phone: '+15555550100',
      status: 'completed', duration_seconds: 60, customer_id: null, processing_status: 'processed',
      v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ service_request: { quote_promised: 'true' } }),
      metadata: JSON.stringify({ fixture: 'digest-shared-number' }), created_at: created, updated_at: created,
    });
    made.calls.push(callId);
  });
  afterEach(async () => {
    if (made.estimates.length) await db('estimates').whereIn('id', made.estimates).del();
    if (made.customers.length) await db('customers').whereIn('id', made.customers).del();
    made.estimates.length = 0;
    made.customers.length = 0;
  });
  afterAll(async () => {
    if (made.calls.length) await db('call_log').whereIn('id', made.calls).del();
    await db.destroy();
  });

  const customer = async (first, last, extra = {}) => {
    const id = randomUUID();
    await db('customers').insert({ id, first_name: first, last_name: last, phone: PHONE, ...extra });
    made.customers.push(id);
    return id;
  };
  const estimateTo = async (customerId, phone = PHONE) => {
    const id = randomUUID();
    const at = new Date(Date.now() - 24 * HOUR);
    await db('estimates').insert({
      id, customer_id: customerId, customer_phone: phone, status: 'sent', sent_at: at,
      estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: at.toISOString(), lastDeliveredAt: at.toISOString() } }),
    });
    made.estimates.push(id);
    return id;
  };
  const stillListed = async () => (await loadUnkeptPromises()).some((r) => r.id === callId);

  test('no estimate: the promise is listed', async () => {
    expect(await stillListed()).toBe(true);
  });

  test('an UNLINKED estimate on the number clears it', async () => {
    await estimateTo(null);
    expect(await stillListed()).toBe(false);
  });

  test('a linked estimate owned by a same-name duplicate record clears it', async () => {
    await customer('Martin', 'Fixtureson');
    const owner = await customer(' martin', 'FIXTURESON');
    await estimateTo(owner);
    expect(await stillListed()).toBe(false);
  });

  test('a linked estimate on a number shared by DIFFERENT names does not clear it', async () => {
    const alpha = await customer('Alpha', 'Fixtureson');
    await customer('Bravo', 'Samplewood');
    await estimateTo(alpha);
    expect(await stillListed()).toBe(true);
  });

  test('a deleted different-name record does not make the number shared; an owner on another number clears nothing', async () => {
    const owner = await customer('Martin', 'Fixtureson');
    await customer('Someone', 'Else', { deleted_at: new Date() });
    await estimateTo(owner);
    expect(await stillListed()).toBe(false);
    await db('estimates').whereIn('id', made.estimates).del();
    made.estimates.length = 0;
    await db('customers').where({ id: owner }).update({ phone: '+15555550177' });
    await estimateTo(owner, '+15555550177');
    expect(await stillListed()).toBe(true);
  });
});
