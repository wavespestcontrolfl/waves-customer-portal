// The triage list refreshes a street-level hold card from its visit's LIVE row: address, slot and the
// "Open visit" link's schedule day all follow a move (SmartRebooker / an admin) made after the card was
// filed. Real route handler, SQL compiled by knex with the runner stubbed. Synthetic data only.
jest.mock('../models/db', () => require('knex')({ client: 'pg' }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));

const db = require('../models/db');
const router = require('../routes/admin-triage');
const list = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;

const VISIT = '3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c';
const holdItem = (extra = {}) => ({
  id: 'card-1', reason_code: 'outbound_booking_review', status: 'open',
  payload: {
    street_level_address: true, scheduled_service_id: VISIT, address_on_file: '1234 Sample Newbuild Trl, Parrish, FL, 34219',
    visit_when: '2026-10-05 13:00', visit_link: `/admin/dispatch?tab=schedule&date=2026-10-05&appointment=${VISIT}`,
  },
  ...extra,
});
const visitRow = (extra = {}) => ({
  id: VISIT, scheduled_date: '2026-10-12', window_start: '14:00:00',
  service_address_line1: '1240 Sample Newbuild Trl', service_address_line2: '', service_address_city: 'Parrish', service_address_state: 'FL', service_address_zip: '34219',
  ...extra,
});

async function run(items, visits) {
  const runner = jest.spyOn(db.client, 'runner').mockImplementation((builder) => ({
    run: async () => {
      const { sql } = builder.toSQL();
      if (sql.includes('from "scheduled_services"')) return visits;
      if (sql.includes('"triage_items"') && sql.includes('count(')) return [];
      return items;
    },
  }));
  const response = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  try {
    await list({ query: { status: 'open' }, techRole: 'admin' }, response);
    expect(response.status).not.toHaveBeenCalled();
    return response.json.mock.calls[0][0].items;
  } finally {
    runner.mockRestore();
  }
}

test('a moved hold: address, visit_when and the Open visit link all carry the visit\'s live date', async () => {
  const [item] = await run([holdItem()], [visitRow()]);
  expect(item.visit_address).toBe('1240 Sample Newbuild Trl, Parrish, FL, 34219');
  expect(item.payload.visit_when).toBe('2026-10-12 14:00');
  expect(item.payload.visit_link).toBe(`/admin/dispatch?tab=schedule&date=2026-10-12&appointment=${VISIT}`);
  // The rest of the card's payload is untouched.
  expect(item.payload.address_on_file).toBe('1234 Sample Newbuild Trl, Parrish, FL, 34219');
});

test('a JSON-string payload is refreshed the same way; a Date scheduled_date works too', async () => {
  const [item] = await run([holdItem({ payload: JSON.stringify(holdItem().payload) })], [visitRow({ scheduled_date: new Date('2026-10-12T00:00:00Z') })]);
  expect(item.payload.visit_link).toContain('&date=2026-10-12&');
  expect(item.payload.visit_when).toBe('2026-10-12 14:00');
});

test('no live visit row, or a non-hold card: the payload is left exactly as filed', async () => {
  const filed = holdItem();
  const [noVisit] = await run([filed], []);
  expect(noVisit.payload).toEqual(holdItem().payload);
  const plain = { id: 'card-2', reason_code: 'address_unverified', status: 'open', payload: { foo: 1 } };
  const [other] = await run([plain], [visitRow()]);
  expect(other.payload).toEqual({ foo: 1 });
});
