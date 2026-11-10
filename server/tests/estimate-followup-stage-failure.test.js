/**
 * checkAll ends the tick by throwing when a whole stage query failed, so
 * runExclusive records the job as failed in job_health (it records only a
 * throwing body). Every stage still runs first, one customer's send failure is
 * not a job failure, and a schema without a stage's columns stays quiet.
 * Harness copied from estimate-followup-expiring-authored-deadline.test.js.
 */
jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false), // keeps the gated deposit stage inert
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => 'SMS body'),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-service-lines', () => ({
  inferEstimateServiceInterest: jest.fn(() => ''),
}));
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
}));
jest.mock('../services/estimate-lead-linkage', () => ({
  leadIdForEstimate: jest.fn(async () => null),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const smsTemplates = require('../routes/admin-sms-templates');
const EstimateFollowUp = require('../services/estimate-follow-up');

function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of [
    'join', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereNull', 'whereNot',
    'where', 'whereBetween', 'select', 'groupBy', 'max', 'as', 'orderBy',
    'orWhereNull', 'andWhere', 'whereNotExists', 'whereRaw', 'orWhereRaw', 'distinctOn',
  ]) {
    b[m] = jest.fn(() => b);
  }
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.update = jest.fn(() => { b._mode = 'update'; return b; });
  b.then = (resolve, reject) => {
    if (cfg.error) return Promise.reject(cfg.error).then(resolve, reject);
    const value = b._mode === 'update' ? (cfg.update ?? 1)
      : b._mode === 'first' ? cfg.first
        : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  b.catch = (onRejected) => b.then(undefined, onRejected);
  return b;
}

let queues;
function enqueue(table, cfg) { (queues[table] = queues[table] || []).push(cfg); }

const NOW = new Date('2026-06-10T15:00:00Z'); // 11:00 ET, inside the send window
const H = 3600000;

function expiringEstimate() {
  return {
    id: 'est-1',
    status: 'sent',
    customer_id: 'cust-1',
    customer_name: 'Taylor Doe',
    customer_phone: null,
    customer_email: 'taylor@example.com',
    token: 'tok-xyz',
    sent_at: new Date(NOW.getTime() - 48 * H),
    viewed_at: null,
    created_at: new Date(NOW.getTime() - 49 * H),
    followup_expiring_sent: false,
    expires_at: new Date(NOW.getTime() + 2 * 24 * H),
  };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(NOW);
  jest.clearAllMocks();
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
  sendCustomerMessage.mockResolvedValue({ sent: true });
  EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
  smsTemplates.getTemplate.mockResolvedValue('SMS body');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('checkAll: a failed stage reaches job_health', () => {
  test('a stage query failure rejects only after the later stages ran and sent', async () => {
    enqueue('estimates', { rows: [] }); // stage 1: unviewed
    enqueue('estimates', { error: Object.assign(new Error('connection reset'), { code: '57P01' }) }); // stage 2: viewed
    enqueue('estimates', { rows: [] }); // stage 3: final nudge
    enqueue('estimates', { rows: [expiringEstimate()] }); // stage 4: expiring

    const failure = EstimateFollowUp.checkAll();
    await expect(failure).rejects.toThrow('estimate-follow-up: 1 stage(s) failed (viewed); 1 follow-up(s) sent');
    // Stage 4 still sent after stage 2 failed.
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
  });

  test('the thrown message and the log carry stage names and codes only, never row data', async () => {
    const logger = require('../services/logger');
    logger.error.mockClear();
    enqueue('estimates', { error: new Error('boom for taylor@example.com') });
    await expect(EstimateFollowUp.checkAll()).rejects.toThrow(/^estimate-follow-up: 1 stage\(s\) failed \(unviewed\); 0 follow-up\(s\) sent$/);
    const logged = logger.error.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toContain('[est-followup] unviewed stage failed (Error)');
    expect(logged).not.toContain('taylor@example.com');
  });

  test('a schema without the stage columns stays quiet (42703 and 42P01)', async () => {
    enqueue('estimates', { error: Object.assign(new Error('column does not exist'), { code: '42703' }) });
    enqueue('estimates', { error: Object.assign(new Error('relation does not exist'), { code: '42P01' }) });
    await expect(EstimateFollowUp.checkAll()).resolves.toEqual({ sent: 0 });
  });

  test("one customer's send failure is not a job failure", async () => {
    enqueue('estimates', { rows: [] });
    enqueue('estimates', { rows: [] });
    enqueue('estimates', { rows: [] });
    enqueue('estimates', { rows: [expiringEstimate()] });
    EmailTemplates.sendTemplate.mockRejectedValue(new Error('provider down'));

    await expect(EstimateFollowUp.checkAll()).resolves.toEqual({ sent: 0 });
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
  });
});
