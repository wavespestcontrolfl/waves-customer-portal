// Exercise the actual inbound handler and SID ledger against synthetic
// PostgreSQL records. Consumer actions, providers and notifications are mocked.
jest.mock('../models/db', () => {
  const conn = (...args) => mockPg(...args);
  return conn;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn((gate) => gate === 'webhooks') }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({ recordSuppression: jest.fn(), clearSuppression: jest.fn() }));
jest.mock('../services/messaging/opt-out-detector', () => ({
  detectSmsOptCommand: jest.fn(() => ({ action: null })), detectHelp: jest.fn(() => ({ help: false })),
}));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(async () => ({})), updateByTwilioSid: jest.fn() }));
jest.mock('../services/sms-media', () => ({ uploadTwilioMedia: jest.fn(async () => []) }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}), isFailureStatus: jest.fn() }));
jest.mock('../services/sms-intent', () => ({
  hasSchedulingIntent: jest.fn(() => false), isSmsReaction: jest.fn(() => false),
  isQuietSmsReaction: jest.fn(() => false), isCourtesyOnly: jest.fn(() => false),
  hasRescheduleOrAwayIntent: jest.fn(() => false),
}));
jest.mock('../middleware/spam-block', () => ({ checkInboundBlock: jest.fn(async () => ({ blocked: false })) }));
jest.mock('../services/contact-correction', () => ({ detectContactCorrectionIntent: jest.fn(() => false) }));
jest.mock('../services/contact-correction-queue', () => ({}));
jest.mock('../services/reschedule-sms', () => ({ handleRescheduleReply: jest.fn() }));
jest.mock('../services/lead-intake', () => ({ handleIntakeReply: jest.fn() }));
jest.mock('../services/estimator-engine/context-builder', () => ({ loadCustomerByPhone: jest.fn(async () => null) }));
jest.mock('../services/sms-operational-actions', () => ({ runSmsOperationalActions: jest.fn(async () => ({})) }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const RescheduleSMS = require('../services/reschedule-sms');
const LeadIntake = require('../services/lead-intake');
const { runSmsOperationalActions } = require('../services/sms-operational-actions');
const TwilioService = require('../services/twilio');
const router = require('../routes/twilio-webhook');
const handler = router.stack.find((layer) => layer.route?.path === '/sms').route.stack[0].handle;
const numbers = require('../config/twilio-numbers');
const connection = process.env.SMS_OPERATIONS_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `sms_consumers_${randomUUID().replaceAll('-', '')}`;
const tables = ['customers', 'messages', 'sms_log', 'inbound_webhook_events'];
let admin;
let mockPg;
let request;
let beforeConsumer;

function response() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (body) => { res.body = body; return res; };
  return res;
}

postgres('consumed inbound replies on PostgreSQL', () => {
  beforeAll(async () => {
    if (!/^\/(waves_test|waves_qa_[a-f0-9]+)$/.test(new URL(connection).pathname)) {
      throw new Error('Use an explicitly selected synthetic Waves QA database');
    }
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });
    for (const table of tables) {
      await admin.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
  });
  afterAll(async () => {
    await mockPg?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    for (const table of tables) await mockPg(table).delete();
    await mockPg('customers').insert({ id: randomUUID(), first_name: 'Synthetic', last_name: 'Fixture',
      phone: '+12025550101', address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236',
      lead_intake_status: 'awaiting_service' });
    request = { body: { From: '+12025550101', To: numbers.locations.parrish.number,
      Body: '1. The irrigation controller is beside the garage.', MessageSid: `SM${randomUUID().replaceAll('-', '')}` } };
    beforeConsumer = [];
    RescheduleSMS.handleRescheduleReply.mockImplementation(async () => ({ handled: false }));
    LeadIntake.handleIntakeReply.mockImplementation(async () => {
      beforeConsumer = await mockPg('sms_log');
      return { handled: true, next: 'awaiting_address' };
    });
    runSmsOperationalActions.mockResolvedValue({});
  });

  test.each(['reschedule_reply', 'lead_intake'])('%s keeps its source before handling and captures only after acknowledgment', async (type) => {
    if (type === 'reschedule_reply') {
      RescheduleSMS.handleRescheduleReply.mockImplementation(async () => {
        beforeConsumer = await mockPg('sms_log');
        return { handled: true, action: 'confirmed' };
      });
    }
    const res = response();
    await handler(request, res);
    expect(require('../services/logger').error.mock.calls).toEqual([]);
    expect(beforeConsumer).toHaveLength(1);
    expect(beforeConsumer[0]).toMatchObject({ message_body: request.body.Body, twilio_sid: request.body.MessageSid });
    expect(await mockPg('sms_log')).toHaveLength(1);
    expect(await mockPg('sms_log').first()).toMatchObject({ message_type: type, message_body: request.body.Body });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<Response></Response>');
    expect(runSmsOperationalActions).not.toHaveBeenCalled();
    res.emit('finish');
    expect(runSmsOperationalActions).toHaveBeenCalledTimes(1);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('persisted intake trigger leaves all five prior messages in estimator context', async () => {
    const now = Date.now();
    const olderBodies = ['Earlier service details', 'Earlier note two', 'Earlier note three', 'Earlier note four', 'How much?'];
    await mockPg('sms_log').insert(olderBodies.map((message_body, index) => ({
      id: randomUUID(), direction: 'inbound', from_phone: request.body.From, to_phone: request.body.To,
      message_body, status: 'received', message_type: 'inbound', created_at: new Date(now - (6 - index) * 1000),
    })));
    request.body.Body = 'How much?';
    let triage;
    LeadIntake.handleIntakeReply.mockImplementation(async (_customer, triggerBody, { triggerSmsLogId }) => {
      triage = await require('../services/estimator-engine/scope-guards').loadThreadTriageContext({
        phone: request.body.From, triggerBody, triggerSmsLogId,
      });
      return { handled: true, next: 'awaiting_address' };
    });
    await handler(request, response());
    expect(triage.recentTexts).toEqual(olderBodies.reverse().map((body) => `[sender] ${body}`));
    expect(await mockPg('sms_log')).toHaveLength(6);
  });

  test('a failed source insert prevents consumers, releases its claim, and permits one later delivery', async () => {
    const failed = response();
    await mockPg.schema.renameTable('sms_log', 'sms_log_unavailable');
    try {
      await handler(request, failed);
    } finally {
      await mockPg.schema.renameTable('sms_log_unavailable', 'sms_log');
    }
    expect(failed.statusCode).toBe(503);
    expect(RescheduleSMS.handleRescheduleReply).not.toHaveBeenCalled();
    expect(LeadIntake.handleIntakeReply).not.toHaveBeenCalled();
    expect(await mockPg('inbound_webhook_events')).toHaveLength(0);
    failed.emit('finish');
    expect(runSmsOperationalActions).not.toHaveBeenCalled();

    const retried = response();
    await handler(request, retried);
    expect(retried.statusCode).toBe(200);
    expect(LeadIntake.handleIntakeReply).toHaveBeenCalledTimes(1);
    expect(await mockPg('sms_log')).toHaveLength(1);
    expect(await mockPg('inbound_webhook_events')).toHaveLength(1);

    await handler(request, response());
    expect(LeadIntake.handleIntakeReply).toHaveBeenCalledTimes(1);
    expect(await mockPg('sms_log')).toHaveLength(1);
  });

  test('concurrent redeliveries cannot consume or persist the reply twice', async () => {
    await Promise.all([handler(request, response()), handler(request, response())]);
    expect(LeadIntake.handleIntakeReply).toHaveBeenCalledTimes(1);
    expect(await mockPg('sms_log')).toHaveLength(1);
    expect(await mockPg('inbound_webhook_events')).toHaveLength(1);
  });

  test('classification failure after consumption leaves a usable inbound source', async () => {
    await mockPg.raw("ALTER TABLE sms_log ADD CONSTRAINT synthetic_type_failure CHECK (message_type <> 'lead_intake')");
    const res = response();
    try {
      await handler(request, res);
    } finally {
      await mockPg.raw('ALTER TABLE sms_log DROP CONSTRAINT synthetic_type_failure');
    }
    expect(LeadIntake.handleIntakeReply).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(await mockPg('sms_log').first()).toMatchObject({ message_type: 'inbound', message_body: request.body.Body });
    res.emit('finish');
    expect(runSmsOperationalActions).toHaveBeenCalledTimes(1);
  });

  test('a failed post-ack kick keeps the recorded source for the recovery sweep', async () => {
    runSmsOperationalActions.mockRejectedValueOnce(new Error('synthetic worker failure'));
    const res = response();
    await handler(request, res);
    res.emit('finish');
    await new Promise(setImmediate);
    expect(res.statusCode).toBe(200);
    expect(await mockPg('sms_log').first()).toMatchObject({ operational_analysis: null, message_type: 'lead_intake' });
    expect(await mockPg('inbound_webhook_events')).toHaveLength(1);
  });
});
