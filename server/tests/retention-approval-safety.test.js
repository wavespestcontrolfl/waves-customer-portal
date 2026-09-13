const express = require('express');

// Default CI uses a deterministic store. The identical route tests also run
// against an explicitly named local scratch database to verify the actual CAS.
jest.mock('../models/db', () => {
  const connection = process.env.RETENTION_TEST_DATABASE_URL;
  if (connection) {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)
      || url.pathname !== '/waves_retention_safety_20260913') throw new Error('Use the dedicated local retention test database');
  }
  const real = connection ? require('knex')({ client: 'pg', connection, pool: { min: 0, max: 5 } }) : null;
  const rows = { customers: [], retention_outreach: [] };
  const db = jest.fn((table) => {
    if (real) {
      const query = real(table);
      const update = query.update.bind(query);
      query.update = (value) => {
        if (db.failFinish && value.status === 'sent') throw new Error('Synthetic final status failure');
        return update(value);
      };
      return query;
    }
    let filters = []; let updates;
    const query = {
      where(key, value) { filters.push(typeof key === 'object' ? key : { [key]: value }); return this; },
      whereNull(key) { filters.push({ [key]: null }); return this; },
      update(value) { updates = value; return this; },
      first() { return Promise.resolve(rows[table].find(row => filters.every(f => Object.entries(f).every(([k, v]) => row[k] === v)))).then(row => row && { ...row }); },
      returning() {
        if (db.failFinish && updates.status === 'sent') return Promise.reject(new Error('Synthetic final status failure'));
        const matches = rows[table].filter(row => filters.every(f => Object.entries(f).every(([k, v]) => row[k] === v)));
        matches.forEach(row => Object.assign(row, updates));
        return Promise.resolve(matches.map(row => ({ ...row })));
      },
    };
    return query;
  });
  db.real = real; db.rows = rows;
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate(req, res, next) { req.techRole = req.headers['x-fixture-role'] || 'admin'; req.technicianId = 'fixture-admin'; next(); },
}));
jest.mock('../services/customer-intelligence/signal-detector', () => ({}));
jest.mock('../services/customer-intelligence/health-scorer', () => ({}));
jest.mock('../services/customer-intelligence/retention-engine', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const app = express();
app.use(express.json());
app.use('/intel', require('../routes/admin-customer-intel'));
app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
const customerId = '10000000-0000-0000-0000-000000000001';
const outreachId = '20000000-0000-0000-0000-000000000001';
let listener; let origin;
async function request(action, role = 'admin') {
  const response = await fetch(`${origin}/intel/retention/${outreachId}/${action}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-fixture-role': role },
    body: JSON.stringify({ approvedBy: 'untrusted-label' }),
  });
  return { status: response.status, body: await response.json() };
}
const approve = () => request('approve');
const skip = () => request('skip');
const read = () => db('retention_outreach').where('id', outreachId).first();
async function seed(overrides = {}, customerOverrides = {}) {
  const customer = { id: customerId, phone: '+12025550123', deleted_at: null, created_at: new Date(), ...customerOverrides };
  const outreach = { id: outreachId, customer_id: customerId, outreach_type: 'sms', message_content: 'Synthetic retention fixture', status: 'pending_approval', ...overrides };
  if (db.real) {
    await db.real('retention_outreach').del(); await db.real('customers').del();
    await db.real('customers').insert(customer); await db.real('retention_outreach').insert(outreach);
  } else { db.rows.customers = [customer]; db.rows.retention_outreach = [outreach]; }
}
beforeAll(async () => {
  listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  origin = `http://127.0.0.1:${listener.address().port}`;
  if (!db.real) return;
  await db.real.schema.createTable('customers', t => { t.uuid('id').primary(); t.text('phone'); t.timestamp('deleted_at'); t.timestamp('created_at'); });
  await db.real.schema.createTable('retention_outreach', t => {
    t.uuid('id').primary(); t.uuid('customer_id'); t.text('outreach_type'); t.text('message_content');
    t.text('status'); t.text('approved_by'); t.timestamp('updated_at'); t.timestamp('sent_at');
  });
});
beforeEach(async () => { db.failFinish = false; sendCustomerMessage.mockReset().mockResolvedValue({ sent: true }); await seed(); });
afterAll(async () => {
  if (listener) await new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); });
  if (db.real) { await db.real.schema.dropTable('retention_outreach'); await db.real.schema.dropTable('customers'); await db.real.destroy(); }
});

test('concurrent approvals claim once; skip and later approval cannot resend or overwrite delivery', async () => {
  let finish; let started;
  const reachedProvider = new Promise(resolve => { started = resolve; });
  sendCustomerMessage.mockImplementation(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const first = approve().then(res => res);
  await reachedProvider;
  const replays = await Promise.all([approve(), approve()]);
  expect(replays.map(res => res.body.outreach.status)).toEqual(['approved', 'approved']);
  expect((await skip()).status).toBe(409);
  finish({ sent: true });
  expect((await first).body.outreach.status).toBe('sent');
  expect((await approve()).body.outreach.status).toBe('sent');
  expect((await skip()).status).toBe(409);
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(await read()).toMatchObject({ status: 'sent', approved_by: 'fixture-admin' });
});

test('two requests that both read a pending draft still claim and send only once', async () => {
  const original = db.getMockImplementation();
  let reads = 0; let release;
  const bothRead = new Promise(resolve => { release = resolve; });
  db.mockImplementation(table => {
    const query = original(table);
    const first = query.first.bind(query);
    query.first = async () => {
      const row = await first();
      if (table === 'retention_outreach' && row?.status === 'pending_approval' && reads < 2) {
        reads += 1;
        if (reads === 2) release();
        await bothRead;
      }
      return row;
    };
    return query;
  });
  try {
    const responses = await Promise.all([approve(), approve()]);
    expect(reads).toBe(2);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect((await read()).status).toBe('sent');
  } finally { db.mockImplementation(original); }
});

test('skip after a stale approval read wins without a send', async () => {
  const original = db.getMockImplementation();
  let reached; let release;
  const pendingRead = new Promise(resolve => { reached = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  db.mockImplementationOnce(table => {
    const query = original(table);
    const first = query.first.bind(query);
    query.first = async () => { const row = await first(); reached(); await resume; return row; };
    return query;
  });
  const approval = approve();
  await pendingRead;
  expect((await skip()).body.outreach.status).toBe('skipped');
  release();
  expect((await approval).body.outreach.status).toBe('skipped');
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('a failed final database update retains the claim and retry never sends twice', async () => {
  db.failFinish = true;
  expect((await approve()).status).toBe(500);
  expect((await read()).status).toBe('approved');
  expect((await approve()).body.outreach.status).toBe('approved');
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});

test.each([
  [undefined, 'approved'], [{ sent: true }, 'sent'], [{ sent: false }, 'blocked'],
  [{ sent: false, deliveryOutcome: 'uncertain' }, 'approved'],
])('gateway exception retains truthful outcome %j', async (providerOutcome, status) => {
  sendCustomerMessage.mockRejectedValue(Object.assign(new Error('Synthetic gateway failure'), { providerOutcome }));
  expect((await approve()).body.outreach.status).toBe(status);
  expect((await approve()).body.outreach.status).toBe(status);
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});

test('an uncertain provider response preserves the claim without claiming non-delivery', async () => {
  sendCustomerMessage.mockResolvedValue({ sent: false, deliveryOutcome: 'uncertain' });
  expect((await approve()).body.outreach.status).toBe('approved');
  await approve(); expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});

test('a definite blocked send is recorded without claiming delivery', async () => {
  sendCustomerMessage.mockResolvedValue({ sent: false, code: 'SUPPRESSED' });
  const result = await approve();
  expect(result.body.outreach.status).toBe('blocked');
  expect(result.body.outreach.sent_at).toBeFalsy();
  await approve(); expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});

test('skip wins before approval and replay does not send', async () => {
  expect((await skip()).body.outreach.status).toBe('skipped');
  expect((await skip()).body.outreach.status).toBe('skipped');
  expect((await approve()).body.outreach.status).toBe('skipped');
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('calls remain manual and archived customers remain unsendable', async () => {
  await seed({ outreach_type: 'call' });
  expect((await approve()).body.outreach.status).toBe('approved');
  await seed({}, { deleted_at: new Date() });
  expect((await approve()).status).toBe(409);
  expect((await read()).status).toBe('pending_approval');
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test.each(['approve', 'skip'])('technicians cannot %s outreach', async action => {
  const res = await request(action, 'technician');
  expect(res.status).toBe(403);
  expect((await read()).status).toBe('pending_approval');
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});
