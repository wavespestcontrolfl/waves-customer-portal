// Owner ruling 2026-10-03: a caller recognised only through a customer's
// secondary contact slot gets ONE office bell tied to that customer. This
// pins the bell itself: who and what in the copy, the full callback number in
// the detail, one bell per call, and a failed write reading as "not raised".

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const db = require('../models/db');
const { notifyAdmin } = require('../services/notification-service');
const { alertOfficeContactFollowUp } = require('../services/voice-agent/relay-alert');

function primeCustomer(row) {
  db.mockImplementation(() => ({ where: () => ({ first: async () => row }) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  primeCustomer({ first_name: 'Pat', last_name: 'Example' });
  notifyAdmin.mockResolvedValue({ id: 'n-1' });
});

const call = (over = {}) => alertOfficeContactFollowUp({
  customerId: 'c-1111', callbackPhone: '+19415550133', callSid: 'CA-contact-1',
  summary: 'Asked what time the lawn tech is coming today. Wants a call back.', ...over,
});

test('rings one needs-you bell on the customer, naming them and quoting the request', async () => {
  await expect(call()).resolves.toBe(true);
  const [category, headline, why, opts] = notifyAdmin.mock.calls[0];
  expect(category).toBe('alert');
  expect(headline).toBe("Comms — call back a contact on Pat Example's account");
  expect(why).toBe('They called Sandy from a number on the account: “Asked what time the lawn tech is coming today”');
  expect(opts).toMatchObject({
    bell: true,
    dedupeKey: 'sandy-contact-followup:CA-contact-1',
    link: '/admin/customers?customerId=c-1111',
    metadata: { severity: 'needs-you', who: 'person', doneWhen: 'contact_called_back', subject: { type: 'customer', id: 'c-1111' }, callbackPhone: '+19415550133' },
  });
  // The number to call and the whole summary ride in the detail.
  expect(opts.detail).toBe('Call back +19415550133. Asked what time the lawn tech is coming today. Wants a call back.');
});

test('a long name still fits the headline, and a missing name or summary still rings', async () => {
  primeCustomer({ first_name: 'Maximiliana', last_name: 'Featherstonehaugh-Wellington' });
  await call();
  expect(notifyAdmin.mock.calls[0][1].length).toBeLessThanOrEqual(60);

  primeCustomer(undefined);
  await expect(call({ summary: '' })).resolves.toBe(true);
  expect(notifyAdmin.mock.calls[1][1]).toBe('Comms — call back a contact on a customer account');
  expect(notifyAdmin.mock.calls[1][2]).toMatch(/“asked for a follow-up”$/);
});

test('not raised (so the caller falls back to the lead path) when the write fails, is suppressed, or ids are missing', async () => {
  notifyAdmin.mockResolvedValueOnce(null);
  await expect(call()).resolves.toBe(false);
  notifyAdmin.mockResolvedValueOnce({ id: null, suppressed: true });
  await expect(call()).resolves.toBe(false);
  notifyAdmin.mockRejectedValueOnce(new Error('db down'));
  await expect(call()).resolves.toBe(false);
  notifyAdmin.mockClear();
  await expect(call({ customerId: null })).resolves.toBe(false);
  await expect(call({ callSid: null })).resolves.toBe(false);
  expect(notifyAdmin).not.toHaveBeenCalled();
});
