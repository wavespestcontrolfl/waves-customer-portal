jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockRows = {};
const mockFailures = new Set();
const mockQueries = [];
jest.mock('../models/db', () => {
  const db = jest.fn(table => {
    const query = { table, where: [], select: [] };
    mockQueries.push(query);
    const builder = {};
    for (const method of ['where', 'whereNull', 'whereIn', 'leftJoin', 'select']) {
      builder[method] = (...args) => { if (method === 'where' || method === 'select') query[method].push(args); return builder; };
    }
    const result = () => mockFailures.has(table) ? Promise.reject(new Error('Source unavailable')) : Promise.resolve(mockRows[table] || []);
    builder.first = async () => (await result())[0];
    builder.then = (resolve, reject) => result().then(resolve, reject);
    builder.catch = reject => result().catch(reject);
    return builder;
  });
  db.raw = jest.fn(sql => sql);
  return db;
});
const router = require('../routes/admin-customers');
async function timeline() {
  const layer = router.stack.find(layer => layer.route?.path === '/:id/timeline');
  const handler = layer.route.stack.at(-1).handle;
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await handler({ params: { id: 'customer-test' } }, res, next);
  return { data: res.json.mock.calls[0]?.[0], next, res };
}
beforeEach(() => {
  for (const key of Object.keys(mockRows)) delete mockRows[key];
  mockRows.customers = [{ id: 'customer-test' }];
  mockFailures.clear(); mockQueries.length = 0;
});

test('merges recorded invoice/estimate timestamps, full text, and one copy of each call', async () => {
  mockRows.invoices = [{ id: 'invoice-test', invoice_number: 'TEST-1', status: 'paid', created_at: '2024-07-01T16:00:00Z', paid_at: '2024-07-04T16:00:00Z', token: 'not-for-timeline' }];
  mockRows.estimates = [{ id: 'estimate-test', status: 'accepted', created_at: '2024-07-01T15:00:00Z', accepted_at: '2024-07-03T16:00:00Z', token: 'not-for-timeline' }];
  mockRows.messages = [{ channel: 'voice', twilio_sid: 'CA-test', created_at: '2024-07-02T16:00:00Z' }, { channel: 'sms', direction: 'inbound', body: 'x'.repeat(300) + ' gate note', created_at: '2024-07-05T16:00:00Z' }];
  mockRows.call_log = [{ id: 'call-test', twilio_call_sid: 'CA-test', call_summary: 'Scheduling question', disposition: 'follow_up', created_at: '2024-07-02T16:00:00Z' }, { id: 'older-call', created_at: '2024-06-01T16:00:00Z' }];
  const { data, next } = await timeline();
  expect(next).not.toHaveBeenCalled();
  expect(data.timeline.filter(row => row.type === 'invoice').map(row => row.title)).toEqual(['Invoice TEST-1 paid', 'Invoice TEST-1 created']);
  expect(data.timeline.filter(row => row.type === 'estimate').map(row => row.title)).toEqual(['Estimate accepted', 'Estimate created']);
  expect(data.timeline.filter(row => row.type === 'call')).toHaveLength(2);
  expect(data.timeline.find(row => row.metadata.callId === 'call-test').description).toContain('follow_up');
  expect(data.timeline[0].description).toContain('gate note');
  expect(JSON.stringify(data)).not.toContain('not-for-timeline');
  for (const table of ['call_log', 'invoices', 'estimates', 'payments']) expect(mockQueries.find(query => query.table === table).where).toContainEqual([{ customer_id: 'customer-test' }]);
});

test('does not describe failed payments as received money', async () => {
  mockRows.payments = [{ id: 'payment-test', status: 'failed', amount: '1130.00', payment_date: '2024-07-01' }];
  const { data } = await timeline();
  expect(data.timeline[0].title).toBe('Payment · failed: $1,130.00');
  expect(data.timeline[0].description).not.toContain('received');
});

test('reports optional omissions and rejects a missing core history source', async () => {
  mockFailures.add('google_reviews');
  expect((await timeline()).data.missingSources).toEqual(['Reviews']);
  mockFailures.add('invoices');
  const { data, next } = await timeline();
  expect(data).toBeUndefined();
  expect(next).toHaveBeenCalledWith(expect.any(Error));
});

test('never reads related records for a missing customer', async () => {
  mockRows.customers = [];
  const { res } = await timeline();
  expect(res.status).toHaveBeenCalledWith(404);
  expect(mockQueries.map(query => query.table)).toEqual(['customers']);
});
