// eventExistsRecently details filter (codex #4803 r5 P2): the expiry cooldown
// is keyed by reminder stage and the no-phone pre-charge cooldown by delivery
// leg. Rows written before the key existed still match, so a legacy row keeps
// its cooldown instead of re-sending the notice it already covered.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { eventExistsRecently } = require('../services/autopay-log');

function query(first = null) {
  const q = {};
  ['where', 'whereRaw'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  return q;
}

beforeEach(() => jest.clearAllMocks());

test('a details filter matches rows that recorded the same value OR predate the key', async () => {
  const q = query({ id: 'row' });
  db.mockReturnValueOnce(q);
  await expect(eventExistsRecently('c1', 'card_expiring_soon', 30, 'pm-1', { reminder_stage: '30_day' })).resolves.toBe(true);
  expect(q.where).toHaveBeenCalledWith({ customer_id: 'c1', event_type: 'card_expiring_soon' });
  expect(q.where).toHaveBeenCalledWith({ payment_method_id: 'pm-1' });
  expect(q.whereRaw).toHaveBeenCalledTimes(1);
  expect(q.whereRaw).toHaveBeenCalledWith('(details->>? IS NULL OR details->>? = ?)', ['reminder_stage', 'reminder_stage', '30_day']);
});

test('one predicate per details key; no details keeps the legacy query shape', async () => {
  const keyed = query(null);
  db.mockReturnValueOnce(keyed);
  await expect(eventExistsRecently('c1', 'pre_charge_reminder_sent', 25, null, { channel: 'push', charge_date: '2026-10-01' })).resolves.toBe(false);
  expect(keyed.whereRaw.mock.calls.map(([, bindings]) => bindings[0])).toEqual(['channel', 'charge_date']);

  const plain = query(null);
  db.mockReturnValueOnce(plain);
  await eventExistsRecently('c1', 'pre_charge_reminder_sent', 25);
  expect(plain.whereRaw).not.toHaveBeenCalled();
  expect(plain.where).not.toHaveBeenCalledWith({ payment_method_id: expect.anything() });
});
