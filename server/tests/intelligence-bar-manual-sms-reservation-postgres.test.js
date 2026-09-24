'use strict';

// The real Intelligence Bar send_sms entrypoint and manual-send reservation
// lifecycle, with only the external provider boundary replaced.
const connection = process.env.MANUAL_SMS_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;

const mockSendCustomerMessage = jest.fn();
const mockDeriveOutboundNumber = jest.fn();

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  db.raw = (...args) => db.connection.raw(...args);
  return db;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => name === 'smsGratitudeReplies'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...args) => mockSendCustomerMessage(...args),
  classifyDeliveryCertainty: (outcome) => outcome?.deliveryOutcome === 'accepted' ? 'sent'
    : outcome?.deliveryOutcome === 'not_sent' ? 'not_sent' : 'unknown',
}));
jest.mock('../services/twilio', () => ({
  deriveOutboundNumber: (...args) => mockDeriveOutboundNumber(...args),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const { executeCommsTool } = require('../services/intelligence-bar/comms-tools');

jest.setTimeout(30000);

postgres('Intelligence Bar manual SMS reservation attribution on PostgreSQL', () => {
  let database;
  let trx;

  beforeAll(() => {
    const url = new URL(connection);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!local && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    const schema = `ib_manual_sms_${randomUUID().replaceAll('-', '')}`;
    await trx.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['customers', 'sms_log', 'agent_decisions', 'message_drafts']) {
      await trx.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
    await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
    db.connection = trx;
    mockDeriveOutboundNumber.mockResolvedValue('+19413529161');
    mockSendCustomerMessage.mockResolvedValue({
      sent: true,
      deliveryOutcome: 'accepted',
      providerMessageId: `SM${'a'.repeat(32)}`,
    });
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await trx?.rollback();
  });
  afterAll(async () => { await database?.destroy(); });

  test('symbolic IB provenance cannot enter the UUID reservation column', async () => {
    const customerId = randomUUID();
    await trx('customers').insert({
      id: customerId,
      first_name: 'Synthetic',
      last_name: 'Customer',
      phone: '+19415550100',
      email: `${customerId}@example.invalid`,
      active: true,
    });

    const result = await executeCommsTool('send_sms', {
      customer_id: customerId,
      phone: '+19415550100',
      message: 'Thanks for checking in.',
    });

    expect(result).toMatchObject({ success: true, state: 'provider_accepted' });
    const reservation = await trx('sms_log')
      .whereRaw("metadata->>'manual_wrapper_reservation' = 'true'")
      .first('admin_user_id', 'status', 'metadata');
    expect(reservation).toMatchObject({ admin_user_id: null, status: 'sent' });
    expect(reservation.metadata).toMatchObject({
      manual_send_reservation: true,
      manual_wrapper_reservation: true,
      provider_outcome: 'accepted',
    });

    // The wrapper normalizes only its UUID-backed reservation field. The
    // canonical sender still receives IB's established provenance and uses
    // it for its existing manual/audit classification.
    expect(mockSendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      entryPoint: 'intelligence_bar_comms_send_sms',
      metadata: expect.objectContaining({ adminUserId: 'intelligence_bar' }),
    }));
  });
});
