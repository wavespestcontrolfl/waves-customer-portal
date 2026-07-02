/**
 * Estimate follow-up stage 5: deposit started but never completed.
 *
 * Pins the contract for the deposit-abandonment stage: gate-off shadow mode
 * (count, never claim, never send), the satisfied-deposit re-check, the
 * skip-without-claim rule when the SMS template is missing (SMS is this
 * stage's only channel), claim/release on send failure, and the rendered
 * template vars (flat dollar amount, never percentage language).
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => 'Hello Taylor! Finish your $49 deposit: url'),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-service-lines', () => ({
  inferEstimateServiceInterest: jest.fn(() => ''),
}));
jest.mock('../services/estimate-deposits', () => ({
  assessDepositFollowUpEligibility: jest.fn(async () => ({
    eligible: true,
    outstandingAmount: 49,
  })),
  DEPOSIT_FOLLOWUP_WINDOW: { minAgeHours: 2, maxAgeHours: 72 },
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { assessDepositFollowUpEligibility } = require('../services/estimate-deposits');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const smsTemplates = require('../routes/admin-sms-templates');
const logger = require('../services/logger');
const { _private } = require('../services/estimate-follow-up');

// Chainable knex-builder stub. Chain methods return the builder; awaiting it
// resolves to cfg.update (if .update was called), cfg.first (if .first was
// called), else cfg.rows. Update payloads are recorded for assertions.
const updates = [];
function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of [
    'join', 'whereIn', 'whereNotNull', 'where', 'select', 'groupBy', 'max',
    'as', 'orderBy', 'orWhereNull', 'andWhere', 'whereNull', 'orWhere',
    'whereNotExists',
  ]) {
    b[m] = jest.fn(() => b);
  }
  b.first = jest.fn(() => {
    b._mode = 'first';
    return b;
  });
  b.update = jest.fn((payload) => {
    b._mode = 'update';
    updates.push({ table, payload });
    return b;
  });
  b.then = (resolve, reject) => {
    const value =
      b._mode === 'update' ? (cfg.update ?? 1)
        : b._mode === 'first' ? cfg.first
          : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  return b;
}

let queues;
function enqueue(table, cfg) {
  (queues[table] = queues[table] || []).push(cfg);
}

// 11:00 ET on a Wednesday — inside the 9a-5p send window.
const NOW = new Date('2026-06-10T15:00:00Z');
// 19:30 ET — outside the window.
const QUIET_NOW = new Date('2026-06-10T23:30:00Z');

function baseEstimate(overrides = {}) {
  return {
    id: 'est-1',
    status: 'viewed',
    customer_id: 'cust-1',
    customer_name: 'Taylor Doe',
    customer_phone: '+19415550100',
    customer_email: null,
    token: 'tok-xyz',
    viewed_at: new Date('2026-06-09T15:00:00Z'),
    last_viewed_at: new Date('2026-06-09T15:00:00Z'),
    created_at: new Date('2026-06-08T15:00:00Z'),
    ...overrides,
  };
}

// Standard happy-path queue: subquery builder (never awaited), candidate
// list, reply-pause lookup defaults empty, claim update, success update.
// Eligibility + outstanding amount are mocked on the estimate-deposits
// service, not the db.
function enqueueHappyPath(est) {
  enqueue('estimate_deposits', {}); // latest-pending-by-estimate subquery
  enqueue('estimates', { rows: [est] });
  enqueue('estimates', { update: 1 }); // claim
  enqueue('estimates', { update: 1 }); // follow_up_count bump
}

beforeEach(() => {
  jest.clearAllMocks();
  updates.length = 0;
  queues = {};
  db.mockImplementation((table) =>
    makeBuilder(table, (queues[table] || []).shift() || {}),
  );
  isEnabled.mockReturnValue(true);
  assessDepositFollowUpEligibility.mockResolvedValue({
    eligible: true,
    outstandingAmount: 49,
  });
  sendCustomerMessage.mockResolvedValue({ sent: true });
  smsTemplates.getTemplate.mockResolvedValue(
    'Hello Taylor! Finish your $49 deposit: url',
  );
});

describe('checkDepositAbandoned', () => {
  test('sends the deposit SMS with flat dollar amount and claims the stage', async () => {
    const est = baseEstimate();
    enqueueHappyPath(est);

    const sent = await _private.checkDepositAbandoned(NOW);

    expect(sent).toBe(1);
    expect(isEnabled).toHaveBeenCalledWith('estimateDepositAbandonmentSms');
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'estimate_followup_deposit',
      {
        first_name: 'Taylor',
        deposit_amount: '49',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/tok-xyz',
      },
      { workflow: 'estimate_follow_up', entity_type: 'estimate', entity_id: 'est-1' },
    );
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '+19415550100',
        channel: 'sms',
        purpose: 'estimate_followup',
        entryPoint: 'estimate_follow_up_cron',
        estimateId: 'est-1',
      }),
    );
    // Claim stamps the stage timestamp; success bumps the follow-up counters
    // and the stamp stays set (it doubles as the attribution record).
    expect(updates).toEqual([
      { table: 'estimates', payload: { followup_deposit_abandoned_sent_at: NOW } },
      {
        table: 'estimates',
        payload: expect.objectContaining({ last_follow_up_at: 'NOW()' }),
      },
    ]);
  });

  test('renders whole-dollar one-time amounts bare ($99)', async () => {
    assessDepositFollowUpEligibility.mockResolvedValue({
      eligible: true,
      outstandingAmount: 99,
    });
    enqueueHappyPath(baseEstimate());

    await _private.checkDepositAbandoned(NOW);

    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'estimate_followup_deposit',
      expect.objectContaining({ deposit_amount: '99' }),
      expect.any(Object),
    );
  });

  test('renders a cents remainder exactly instead of rounding ($29.50)', async () => {
    assessDepositFollowUpEligibility.mockResolvedValue({
      eligible: true,
      outstandingAmount: 29.5,
    });
    enqueueHappyPath(baseEstimate());

    await _private.checkDepositAbandoned(NOW);

    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'estimate_followup_deposit',
      expect.objectContaining({ deposit_amount: '29.50' }),
      expect.any(Object),
    );
  });

  test('gate off: logs candidate count in shadow, never claims or sends', async () => {
    isEnabled.mockReturnValue(false);
    enqueue('estimate_deposits', {});
    enqueue('estimates', { rows: [baseEstimate()] });

    const sent = await _private.checkDepositAbandoned(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Deposit-abandoned shadow: 1 candidate(s)'),
    );
  });

  test('skips when the resolved policy is already satisfied or exempt', async () => {
    assessDepositFollowUpEligibility.mockResolvedValue({
      eligible: false,
      reason: 'deposit_satisfied',
    });
    enqueue('estimate_deposits', {});
    enqueue('estimates', { rows: [baseEstimate()] });

    const sent = await _private.checkDepositAbandoned(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('partial payment does NOT suppress the nudge — quotes the top-up remainder', async () => {
    assessDepositFollowUpEligibility.mockResolvedValue({
      eligible: true,
      outstandingAmount: 50, // $99 one-time policy minus $49 received
    });
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkDepositAbandoned(NOW);

    expect(sent).toBe(1);
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'estimate_followup_deposit',
      expect.objectContaining({ deposit_amount: '50' }),
      expect.any(Object),
    );
  });

  test('skips when the estimate is no longer accept-active (accepted race, expired)', async () => {
    assessDepositFollowUpEligibility.mockResolvedValue({
      eligible: false,
      reason: 'estimate_inactive',
    });
    enqueue('estimate_deposits', {});
    enqueue('estimates', { rows: [baseEstimate()] });

    const sent = await _private.checkDepositAbandoned(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('fails CLOSED: unverified eligibility never sends', async () => {
    assessDepositFollowUpEligibility.mockResolvedValue({
      eligible: false,
      reason: 'eligibility_unverified',
    });
    enqueue('estimate_deposits', {});
    enqueue('estimates', { rows: [baseEstimate()] });

    const sent = await _private.checkDepositAbandoned(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('missing SMS template skips WITHOUT claiming the stage', async () => {
    smsTemplates.getTemplate.mockResolvedValue(null);
    enqueue('estimate_deposits', {});
    enqueue('estimates', { rows: [baseEstimate()] });

    const sent = await _private.checkDepositAbandoned(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]); // no claim, so the next tick retries
  });

  test('blocked send releases the claim so the next tick can retry', async () => {
    sendCustomerMessage.mockResolvedValue({ blocked: true, code: 'SMS_OPTED_OUT' });
    const est = baseEstimate();
    enqueueHappyPath(est);
    enqueue('estimates', { update: 1 }); // release

    const sent = await _private.checkDepositAbandoned(NOW);

    expect(sent).toBe(0);
    expect(updates).toEqual([
      { table: 'estimates', payload: { followup_deposit_abandoned_sent_at: NOW } },
      { table: 'estimates', payload: { followup_deposit_abandoned_sent_at: null } },
    ]);
  });

  test('lost claim race skips the send', async () => {
    enqueue('estimate_deposits', {});
    enqueue('estimates', { rows: [baseEstimate()] });
    enqueue('estimates', { update: 0 }); // another cron won the claim

    const sent = await _private.checkDepositAbandoned(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('active-customer guard: a converted customer never gets the deposit nudge', async () => {
    enqueue('estimate_deposits', {});
    enqueue('estimates', { rows: [baseEstimate()] });
    enqueue('customers', { first: { id: 'cust-1' } }); // live per whereLiveCustomer predicate

    const sent = await _private.checkDepositAbandoned(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('quiet hours skip: never texts outside 9a-5p ET', async () => {
    enqueue('estimate_deposits', {});
    enqueue('estimates', { rows: [baseEstimate()] });

    const sent = await _private.checkDepositAbandoned(QUIET_NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('recently-opened skip: customer may be mid-payment right now', async () => {
    const est = baseEstimate({
      last_viewed_at: new Date('2026-06-10T14:30:00Z'), // 30 min before NOW
    });
    enqueue('estimate_deposits', {});
    enqueue('estimates', { rows: [est] });

    const sent = await _private.checkDepositAbandoned(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});
