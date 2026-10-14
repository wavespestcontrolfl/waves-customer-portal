/** The suggested outreach SMS for a customer with no first name on file reads "Hi there," — never "Hi ,". Synthetic data. */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const MissedAppointment = require('../services/workflows/missed-appointment');

function fakeConn(customer) {
  const inserts = [];
  const conn = (table) => ({
    where: () => ({
      first: async () => (table === 'customers' ? customer : null),
      where() { return this; },
      select() { return this; },
    }),
    insert: async (row) => { inserts.push({ table, row }); },
  });
  conn.raw = (sql) => sql;
  // reschedule_log count query chain
  const base = conn;
  const wrapped = (table) => {
    if (table !== 'reschedule_log') return base(table);
    const chain = { where() { return chain; }, select() { return chain; }, first: async () => ({ count: '2' }) };
    return chain;
  };
  wrapped.raw = (sql) => sql;
  wrapped.isTransaction = true; // the caller's transaction: the count and the task write share it
  return { conn: wrapped, inserts };
}

test.each([[''], [null], ['  ']])('blank first name %p reads "Hi there,"', async (first_name) => {
  const { conn, inserts } = fakeConn({ id: 'c1', first_name });
  const out = await MissedAppointment.evaluateThreshold('c1', 'no_show', conn);
  expect(out).toMatchObject({ action: 'recommendation_created' });
  const body = inserts.find((i) => i.table === 'customer_interactions').row.body;
  expect(body).toContain('Hi there, we\'ve noticed');
  expect(body).not.toMatch(/Hi ,|null|undefined/);
});

test('a real first name is used', async () => {
  const { conn, inserts } = fakeConn({ id: 'c1', first_name: 'Sam' });
  await MissedAppointment.evaluateThreshold('c1', 'no_show', conn);
  expect(inserts.find((i) => i.table === 'customer_interactions').row.body).toContain('Hi Sam, we\'ve noticed');
});
