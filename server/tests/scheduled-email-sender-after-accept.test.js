// Once Gmail accepts a scheduled email, nothing may requeue it: a failed
// 'sent' write leaves the claim for settleStaleClaims (outcome_unknown, alert),
// never 'scheduled'. Fake connection; no network or DB.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { sendOne } = require('../services/email/scheduled-email-sender');

test('a database error after Gmail accepted never requeues the email', async () => {
  const updates = [];
  const conn = Object.assign(() => ({
    where: () => ({
      update: async (fields) => {
        updates.push(fields.status);
        if (fields.status === 'sent') throw Object.assign(new Error('insert into ... values (fixture@example.invalid)'), { code: '57P01' });
        return 1;
      },
    }),
  }), { fn: { now: () => 'now()' } });
  const gmail = { sendMessage: jest.fn(async () => ({ id: 'gmail-fixture' })) };
  const row = { id: 'row-fixture', to_address: 'fixture@example.invalid', subject: 'S', body_html: 'B', thread_id: null, attempts: 1 };
  await expect(sendOne(row, { conn, gmail })).resolves.toBe('sent_unrecorded');
  expect(updates).toEqual(['sent']);
  expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
  const { error } = require('../services/logger');
  expect(error.mock.calls.flat().join(' ')).not.toContain('fixture@example.invalid');
});
