// GATE_CALL_EMAIL_CHECKS (owner 2026-10-29): the triage list flags every email
// read-back card for an admin (email_typed_confirm), so the card shows the
// in-place Confirm email form. Real route handler, SQL compiled by knex with
// the runner stubbed (same harness as admin-triage-hold-live-visit). Synthetic data.
jest.mock('../models/db', () => require('knex')({ client: 'pg' }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const db = require('../models/db');
const router = require('../routes/admin-triage');
const list = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;

const cards = () => [
  { id: 'card-1', reason_code: 'email_unverified', status: 'open', payload: { email_release_target: 'heard@example.com' } },
  { id: 'card-2', reason_code: 'email_invalid', status: 'open', payload: {} },
  { id: 'card-3', reason_code: 'address_unverified', status: 'open', payload: {} },
];

async function run(techRole) {
  const runner = jest.spyOn(db.client, 'runner').mockImplementation((builder) => ({
    run: async () => {
      const { sql } = builder.toSQL();
      if (sql.includes('"triage_items"') && sql.includes('count(')) return [];
      return cards();
    },
  }));
  const response = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  try {
    await list({ query: { status: 'open' }, techRole }, response);
    expect(response.status).not.toHaveBeenCalled();
    return response.json.mock.calls[0][0].items;
  } finally {
    runner.mockRestore();
  }
}

afterEach(() => { delete process.env.GATE_CALL_EMAIL_CHECKS; });

test('gate on, admin: both email card kinds are flagged, other cards are not', async () => {
  process.env.GATE_CALL_EMAIL_CHECKS = 'true';
  const items = await run('admin');
  expect(items.map((i) => i.email_typed_confirm === true)).toEqual([true, true, false]);
});

test('gate off: no card is flagged', async () => {
  const items = await run('admin');
  expect(items.some((i) => 'email_typed_confirm' in i)).toBe(false);
});

test('gate on, a technician: no card is flagged (the confirm route is admin-only)', async () => {
  process.env.GATE_CALL_EMAIL_CHECKS = 'true';
  const items = await run('technician');
  expect(items.some((i) => 'email_typed_confirm' in i)).toBe(false);
});
