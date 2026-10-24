// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// messaging_suppression is keyed by phone and has no id column. Readers that
// selected id failed on every real query and fell through their fail-open
// catch: the SMS webhook treated every first-contact sender as
// compliance-eligible (so the solicitation screen never saw one), and the
// cancellation card kept offering SMS to an opted-out customer. Mocked-table
// suites cannot show this, because their fake rows carry whatever columns the
// query asks for.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Same inert services as twilio-compliance-history-postgres.test.js; only
// the outbound-history reader is exercised.
jest.mock('../services/twilio', () => ({ isKnownOwnerPhone: () => false }));
jest.mock('../services/messaging/validators/suppression', () => ({}));
jest.mock('../services/conversations', () => ({}));
jest.mock('../services/sms-media', () => ({}));
jest.mock('../services/twilio-failure-alerts', () => ({}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendCancellationReceived: jest.fn() }));
jest.mock('../services/messaging/compliance-contact-checks', () => ({
  latestContactCheck: jest.fn(async () => null),
  isSmsMobileLineType: () => true,
}));
const { randomUUID } = require('node:crypto');

postgres('messaging_suppression readers against migrated PostgreSQL', () => {
  let database;
  let trx;
  let hasOutboundHistory;
  let confirmationChannelAvailability;
  const logger = require('../services/logger');

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    // Loaded here so the route module's cold transform is outside a test's timer.
    ({ hasOutboundHistory } = require('../routes/twilio-webhook')._internals);
    ({ confirmationChannelAvailability } = require('../services/cancellation-confirmations'));
  }, 60000);

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    jest.clearAllMocks();
  });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const suppress = (phone, active = true) => trx('messaging_suppression')
    .insert({ phone, reason: 'opt_out_keyword', active, source: 'synthetic_fixture' });

  test('a first-contact sender with no history is not eligible, and the lookup does not fail open', async () => {
    expect(await hasOutboundHistory('+19415550142')).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('an active suppression still counts as history so a START can clear it; an inactive one does not', async () => {
    await suppress('+19415550143');
    await suppress('+19415550144', false);
    expect(await hasOutboundHistory('+19415550143')).toBe(true);
    expect(await hasOutboundHistory('+19415550144')).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('an active STOP makes SMS unavailable on the cancellation card', async () => {
    const customer = { id: randomUUID(), phone: '+19415550145', email: null };
    expect(await confirmationChannelAvailability(customer)).toEqual({ sms: true, email: false });
    await suppress('+19415550145');
    expect(await confirmationChannelAvailability(customer)).toEqual({ sms: false, email: false });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
