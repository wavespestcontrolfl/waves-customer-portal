// #4963 x #5001: an invoice's whole-notice retry re-fans every selected leg,
// including a Text leg that was already accepted. Against a real migrated
// sms_log, repeated fan-outs of the same invoice notice must make exactly
// ONE Twilio handoff: the real provider wrapper (providers/twilio-sms.js)
// and the real billing-text-leg-dedupe guard, with only TwilioService.sendSMS
// mocked. The mock writes its accepted row the way services/twilio.js does
// (notificationEventKey + billingDeliveryLeg from the options it is handed),
// so this also proves the provider forwards both.
const { randomUUID } = require('node:crypto');

let mockPg;
const mockSendSMS = jest.fn();
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  database.raw = (...args) => mockPg.raw(...args);
  database.transaction = (...args) => mockPg.transaction(...args);
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: (...args) => mockSendSMS(...args) }));

const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `invoice_text_single_handoff_${randomUUID().replaceAll('-', '')}`;
let admin;

jest.setTimeout(30000);

postgres('invoice whole-notice retry: one Twilio handoff per notice (private PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && target.hostname === 'localhost' && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = require('knex')({
      client: 'pg', connection, searchPath: [schema, 'public'], pool: { min: 0, max: 4 },
    });
    await mockPg.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', ['sms_log', 'public.sms_log']);
  });

  afterAll(async () => {
    await mockPg?.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    mockSendSMS.mockReset();
    await mockPg('sms_log').del();
  });

  function invoiceTextLeg(customerId, invoiceId) {
    return {
      to: '+19415550100',
      body: 'Your invoice is ready: https://example.test/pay/abc',
      channel: 'sms',
      customerId,
      invoiceId,
      purpose: 'payment_link',
      metadata: {
        billingDeliveryLeg: 'sms',
        billingDeliveryCategory: 'invoice',
        notificationEventKey: `invoice:${invoiceId}:sent`,
      },
    };
  }

  function acceptLikeTwilio(customerId) {
    mockSendSMS.mockImplementation(async (to, body, options) => {
      const sid = `SM${randomUUID().replaceAll('-', '')}`;
      await mockPg('sms_log').insert({
        id: randomUUID(), customer_id: customerId, direction: 'outbound',
        from_phone: '+19415550199', to_phone: to, message_body: body, message_type: 'invoice',
        status: 'sent', twilio_sid: sid, created_at: new Date(),
        metadata: JSON.stringify({
          notificationEventKey: options.notificationEventKey,
          billingDeliveryLeg: options.billingDeliveryLeg,
        }),
      });
      return { success: true, sid, deliveryOutcome: 'accepted' };
    });
  }

  test('three fan-outs of the same invoice notice make exactly one Twilio handoff', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    acceptLikeTwilio(customerId);

    const first = await sendViaTwilio(invoiceTextLeg(customerId, invoiceId));
    const second = await sendViaTwilio(invoiceTextLeg(customerId, invoiceId));
    const third = await sendViaTwilio(invoiceTextLeg(customerId, invoiceId));

    expect(mockSendSMS).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
    for (const retry of [second, third]) {
      expect(retry).toMatchObject({ sent: true, deliveryOutcome: 'accepted', deduped: true, providerMessageId: first.providerMessageId });
    }
    // Only the provider's own accepted row remains: no claim left behind.
    expect(await mockPg('sms_log').count('* as n').first()).toEqual({ n: '1' });
  });

  test('a different invoice for the same customer still sends: dedupe is per notice', async () => {
    const customerId = randomUUID();
    acceptLikeTwilio(customerId);

    await sendViaTwilio(invoiceTextLeg(customerId, randomUUID()));
    await sendViaTwilio(invoiceTextLeg(customerId, randomUUID()));

    expect(mockSendSMS).toHaveBeenCalledTimes(2);
  });
});
