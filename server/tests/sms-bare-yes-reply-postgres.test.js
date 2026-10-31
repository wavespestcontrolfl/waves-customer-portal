/**
 * GATE_SMS_BARE_YES_REPLY on a real database. The decision reads
 * messaging_suppression, notification_prefs, recipient_optin and sms_log;
 * the mocked suites (sms-bare-yes-reply, recipient-optin) answer any column
 * name, so the open-ask lookup shipped selecting recipient_optin.id, a column
 * the table does not have (its key is customer_id + phone_key). In production
 * every bare YES failed that lookup (42703) and was handled as START. These
 * run every query of the decision against the migrated schema.
 */
const path = require('path');
const { randomUUID } = require('crypto');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('bare YES decision on PostgreSQL', () => {
  let knex;
  let bareYesIsReply;
  let yesWouldConfirmAsk;
  let logger;
  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
    ({ bareYesIsReply } = require('../services/messaging/bare-yes-reply'));
    ({ yesWouldConfirmAsk } = require('../services/recipient-optin'));
    logger = require('../services/logger');
  });
  afterAll(async () => {
    if (knex) await knex.destroy();
    // Both services pull the shared app pool (models/db) at module scope.
    await require('../models/db').destroy();
  });

  // Each case runs in one transaction that is always rolled back. The
  // decision catches a failed lookup and answers false (an opt-in), so a
  // false answer only counts when no lookup failed.
  const ROLLBACK = new Error('rollback');
  async function inRollback(fn) {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await expect(knex.transaction(async (trx) => {
        await fn(trx);
        throw ROLLBACK;
      })).rejects.toBe(ROLLBACK);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('bare YES check failed'));
    } finally {
      warn.mockRestore();
    }
  }
  async function customer(trx) {
    const id = randomUUID();
    await trx('customers').insert({ id, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${id}@example.invalid`, phone: `fixture-${id.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
    return id;
  }

  test('nothing to restore: a reply', async () => {
    await inRollback(async (trx) => {
      const customerId = await customer(trx);
      await trx('notification_prefs').insert({ customer_id: customerId, sms_enabled: true });
      await expect(yesWouldConfirmAsk('+19415550181', { dbh: trx })).resolves.toBe(false);
      await expect(bareYesIsReply({ phone: '+19415550181', customerId, dbh: trx })).resolves.toBe(true);
    });
  });

  test('texts turned off on the customer: an opt-in', async () => {
    await inRollback(async (trx) => {
      const customerId = await customer(trx);
      await trx('notification_prefs').insert({ customer_id: customerId, sms_enabled: false });
      await expect(bareYesIsReply({ phone: '+19415550182', customerId, dbh: trx })).resolves.toBe(false);
    });
  });

  test('an active suppression row: an opt-in', async () => {
    await inRollback(async (trx) => {
      await trx('messaging_suppression').insert({ phone: '+19415550183', reason: 'opt_out_keyword', active: true });
      await expect(bareYesIsReply({ phone: '+19415550183', dbh: trx })).resolves.toBe(false);
    });
  });

  test('an ask that went out: an opt-in until it is confirmed', async () => {
    await inRollback(async (trx) => {
      const key = '9415550184';
      await trx('recipient_optin').insert({ customer_id: randomUUID(), phone_key: key, phone_e164: `+1${key}`,
        status: 'pending', dispatched_at: trx.fn.now() });
      await expect(yesWouldConfirmAsk(`+1${key}`, { dbh: trx })).resolves.toBe(true);
      await expect(bareYesIsReply({ phone: `+1${key}`, dbh: trx })).resolves.toBe(false);
      await trx('recipient_optin').where({ phone_key: key }).update({ status: 'confirmed' });
      await expect(bareYesIsReply({ phone: `+1${key}`, dbh: trx })).resolves.toBe(true);
    });
  });

  test('marker recovery: an undispatched pending row whose ask went out, until the ask fails', async () => {
    await inRollback(async (trx) => {
      const key = '9415550185';
      const customerId = await customer(trx);
      await trx('recipient_optin').insert({ customer_id: customerId, phone_key: key, phone_e164: `+1${key}`, status: 'pending' });
      const [ask] = await trx('sms_log').insert({ customer_id: customerId, direction: 'outbound', from_phone: '+19415550100',
        to_phone: `+1${key}`, message_type: 'recipient_optin_request', status: 'sent' }).returning('id');
      await expect(yesWouldConfirmAsk(`+1${key}`, { dbh: trx })).resolves.toBe(true);
      await trx('sms_log').where({ id: ask.id }).update({ status: 'undelivered' });
      await expect(yesWouldConfirmAsk(`+1${key}`, { dbh: trx })).resolves.toBe(false);
    });
  });
});
