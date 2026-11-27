/**
 * visit-customer-asked.js through the REAL gatherReserviceAsks (nothing about the gather is mocked): a link or a stored
 * access code after character 280 of a customer's text never reaches the technician, because the body screen runs on the
 * ORIGINAL text before the gather scrubs and caps it. A fake knex serves each table's rows; synthetic data only.
 */
jest.mock('../models/db', () => {
  const fn = () => { throw new Error('global db must not be used: dbh is passed explicitly'); };
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/reservice-property-scope', () => ({ accountProvesSinglePremises: async () => true }));

const { customerAskedFacts } = require('../services/visit-customer-asked');

const NOW = new Date();
const BOOKED = new Date(NOW.getTime() - 4 * 86400000);
const VISIT = {
  id: 'visit-1', customer_id: 'cust-1', service_type: 'Pest Control Re-Service', is_callback: true, service_key: 'pest_re_service',
  created_at: BOOKED, notes: null, customer_request: null, customer_request_source: null, customer_request_pests: null,
  scheduled_date: '2026-12-01', property_id: null, self_booking_id: null,
};
const sms = (id, body) => ({ id, message_body: body, message_type: 'sms_inbound', created_at: new Date(NOW.getTime() - 86400000) });

function fakeKnex({ visit = VISIT, smsRows = [], prefs = [] } = {}) {
  const rows = { sms_log: smsRows, property_preferences: prefs };
  return (table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNotNull', 'whereRaw', 'leftJoin', 'select', 'orderBy', 'limit', 'modify']) {
      q[m] = (...args) => { if (m === 'modify' && typeof args[0] === 'function') args[0](q); return q; };
    }
    q.first = async () => (table.startsWith('scheduled_services') ? visit : undefined);
    q.then = (resolve, reject) => Promise.resolve(rows[table] || []).then(resolve, reject);
    return q;
  };
}

const filler = 'The ants keep coming in by the back door. '.repeat(8); // well past 280 characters
beforeEach(() => { process.env.GATE_RESERVICE_ASKS = 'true'; });
afterAll(() => { delete process.env.GATE_RESERVICE_ASKS; });

test('a link past character 280 holds the whole text; an ordinary text still shows', async () => {
  const late = `Ants are back in the kitchen. ${filler}Photos are at photos.example.dev/yard`;
  const facts = await customerAskedFacts(VISIT, fakeKnex({ smsRows: [sms('s1', late), sms('s2', 'Ants are back in the garage.')] }));
  expect(facts.items.map((i) => i.text)).toEqual(['Ants are back in the garage.']);
});

test('a stored access code past character 280 holds the whole text', async () => {
  const late = `Ants are back in the kitchen. ${filler}The lockbox code is blue42`;
  const prefs = [{ neighborhood_gate_code: null, property_gate_code: null, garage_code: null, lockbox_code: 'blue42' }];
  expect(await customerAskedFacts(VISIT, fakeKnex({ smsRows: [sms('s1', late)], prefs }))).toBeNull();
});

test('a booking-request text held in its original form never shows its scrubbed rest', async () => {
  const late = `Ants in the kitchen. ${filler}Call me at 555 0100`;
  const visit = { ...VISIT, customer_request: late, customer_request_source: 'text' };
  expect(await customerAskedFacts(visit, fakeKnex({ visit }))).toBeNull();
});
