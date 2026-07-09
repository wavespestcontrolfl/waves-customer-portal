/**
 * Estimate follow-up cadence: three touches while the quote is live.
 *
 * Pins the collapsed ladder's per-touch contract: the questions opener's
 * viewed / not-yet-viewed copy variants (SMS + the matching email template),
 * the SMS-only day-5 check-in (the offer slot — skip WITHOUT claiming when
 * the template is missing), the last-day notice payload, timestamp claims
 * (stamp on claim, null on release), and the active-customer guard — the
 * pipeline-audit bug where paying customers kept getting quote nudges.
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
  getTemplate: jest.fn(async () => 'SMS body'),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
// The conversion guard (#2261) runs inside safetyGate; it has its own
// suite (estimate-conversion-guard.test.js) — here it must not consume
// the query queue.
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
}));
jest.mock('../services/estimate-service-lines', () => ({
  inferEstimateServiceInterest: jest.fn(() => ''),
  // Deterministic pest lane so the per-category copy vars are assertable.
  inferEstimateServiceLines: jest.fn(() => [{ key: 'pest' }]),
}));
jest.mock('../services/estimate-deposits', () => ({
  assessDepositFollowUpEligibility: jest.fn(async () => ({
    eligible: true,
    outstandingAmount: 49,
  })),
  DEPOSIT_FOLLOWUP_WINDOW: { minAgeHours: 2, maxAgeHours: 72 },
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const smsTemplates = require('../routes/admin-sms-templates');
const logger = require('../services/logger');
const { _private } = require('../services/estimate-follow-up');

// Chainable knex-builder stub (same shape as the deposit-abandoned suite).
// Chain methods return the builder; awaiting it resolves to cfg.update (if
// .update was called), cfg.first (if .first was called), else cfg.rows.
// cfg.error makes the await reject. Update payloads recorded for assertions.
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
    if (cfg.error) return Promise.reject(cfg.error).then(resolve, reject);
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

// 11:00 ET on a Wednesday. (The global quiet-hours send guard was removed
// on main — sends fire whenever the cron ticks.)
const NOW = new Date('2026-06-10T15:00:00Z');

function baseEstimate(overrides = {}) {
  return {
    id: 'est-1',
    status: 'viewed',
    customer_id: 'cust-1',
    customer_name: 'Taylor Doe',
    customer_phone: '+19415550100',
    customer_email: 'lead@example.com',
    token: 'tok-xyz',
    address: '123 Palm Ave, Venice, FL 34285',
    sent_at: new Date('2026-06-07T15:00:00Z'), // 3 days before NOW
    viewed_at: new Date('2026-06-08T15:00:00Z'),
    last_viewed_at: new Date('2026-06-08T15:00:00Z'),
    expires_at: new Date('2026-06-17T15:00:00Z'),
    created_at: new Date('2026-06-07T15:00:00Z'),
    ...overrides,
  };
}

// Happy-path queue for a single-stage run: candidate list, claim update,
// counters bump. The customers (live-customer guard) and messages
// (reply-pause) lookups fall through to empty default builders.
function enqueueHappyPath(est) {
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
  sendCustomerMessage.mockResolvedValue({ sent: true });
  smsTemplates.getTemplate.mockResolvedValue('SMS body');
  EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
});

describe('questions touch (touch 1)', () => {
  test('viewed estimate gets the viewed copy variant + viewed email, claims the timestamp', async () => {
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkQuestionsTouch(NOW);

    expect(sent).toBe(1);
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'estimate_followup_questions',
      {
        first_name: 'Taylor',
        service_hook: 'pest-free home plan',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/tok-xyz',
      },
      { workflow: 'estimate_follow_up', entity_type: 'estimate', entity_id: 'est-1' },
    );
    const email = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(email.templateKey).toBe('estimate.viewed_followup');
    expect(email.idempotencyKey).toBe('estimate_followup_questions:est-1');
    expect(updates).toEqual([
      { table: 'estimates', payload: { followup_questions_sent_at: NOW } },
      { table: 'estimates', payload: expect.objectContaining({ last_follow_up_at: 'NOW()' }) },
    ]);
  });

  test('not-yet-viewed estimate gets the unviewed variant with address + expires_at vars', async () => {
    enqueueHappyPath(baseEstimate({ status: 'sent', viewed_at: null, last_viewed_at: null }));

    const sent = await _private.checkQuestionsTouch(NOW);

    expect(sent).toBe(1);
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'estimate_followup_questions_unviewed',
      {
        first_name: 'Taylor',
        service_hook: 'pest-free home plan',
        address: '123 Palm Ave, Venice, FL 34285',
        expires_at: 'June 17, 2026',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/tok-xyz',
      },
      expect.any(Object),
    );
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe(
      'estimate.unviewed_followup',
    );
  });

  test('unviewed copy falls back to "your home" when the estimate has no address', async () => {
    enqueueHappyPath(baseEstimate({ status: 'sent', viewed_at: null, last_viewed_at: null, address: null }));

    await _private.checkQuestionsTouch(NOW);

    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'estimate_followup_questions_unviewed',
      expect.objectContaining({ address: 'your home' }),
      expect.any(Object),
    );
  });

  test('unviewed without expires_at: SMS skipped (broken price-lock copy), email still goes', async () => {
    enqueueHappyPath(baseEstimate({ status: 'sent', viewed_at: null, last_viewed_at: null, expires_at: null }));

    const sent = await _private.checkQuestionsTouch(NOW);

    expect(sent).toBe(1);
    expect(smsTemplates.getTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
  });

  test('active-customer guard: a converted customer is skipped without a claim', async () => {
    enqueue('estimates', { rows: [baseEstimate()] });
    enqueue('customers', { first: { id: 'cust-1' } }); // live customer

    const sent = await _private.checkQuestionsTouch(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('live-customer check failure fails CLOSED (skip, retry next tick)', async () => {
    enqueue('estimates', { rows: [baseEstimate()] });
    enqueue('customers', { error: new Error('connection reset') });

    const sent = await _private.checkQuestionsTouch(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failing closed'),
    );
  });

  test('blocked on every channel releases the claim for the next tick', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'opted_out' });
    const est = baseEstimate({ customer_email: null });
    enqueue('estimates', { rows: [est] });
    enqueue('estimates', { update: 1 }); // claim
    enqueue('estimates', { update: 1 }); // release

    const sent = await _private.checkQuestionsTouch(NOW);

    expect(sent).toBe(0);
    expect(updates).toEqual([
      { table: 'estimates', payload: { followup_questions_sent_at: NOW } },
      { table: 'estimates', payload: { followup_questions_sent_at: null } },
    ]);
  });

});

describe('day-5 check-in (touch 2 — the offer slot)', () => {
  test('sends SMS only and claims followup_credit_sent_at', async () => {
    enqueueHappyPath(baseEstimate({ sent_at: new Date('2026-06-04T15:00:00Z') }));

    const sent = await _private.checkCheckInTouch(NOW);

    expect(sent).toBe(1);
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'estimate_followup_credit',
      {
        first_name: 'Taylor',
        service_hook: 'pest-free home plan',
        expires_at: 'June 17, 2026',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/tok-xyz',
      },
      expect.any(Object),
    );
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(updates).toEqual([
      { table: 'estimates', payload: { followup_credit_sent_at: NOW } },
      { table: 'estimates', payload: expect.objectContaining({ last_follow_up_at: 'NOW()' }) },
    ]);
  });

  test('missing SMS template skips WITHOUT claiming (SMS is the only channel)', async () => {
    smsTemplates.getTemplate.mockResolvedValue(null);
    enqueue('estimates', { rows: [baseEstimate({ sent_at: new Date('2026-06-04T15:00:00Z') })] });

    const sent = await _private.checkCheckInTouch(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]); // no claim, so the next tick retries
  });
});

describe('last-day notice (touch 3)', () => {
  test('renders the formatted expiry on SMS and email and claims followup_expiring_sent_at', async () => {
    const est = baseEstimate({ expires_at: new Date('2026-06-11T15:00:00Z') });
    enqueueHappyPath(est);

    const sent = await _private.checkExpiringTouch(NOW);

    expect(sent).toBe(1);
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'estimate_followup_expiring',
      expect.objectContaining({ expires_at: 'June 11, 2026' }),
      expect.any(Object),
    );
    const email = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(email.templateKey).toBe('estimate.expiring_notice');
    expect(email.payload).toEqual(
      expect.objectContaining({ first_name: 'Taylor', expires_at: 'June 11, 2026' }),
    );
    expect(email.idempotencyKey).toBe('estimate_followup_expiring:est-1');
    expect(updates).toEqual([
      { table: 'estimates', payload: { followup_expiring_sent_at: NOW } },
      { table: 'estimates', payload: expect.objectContaining({ last_follow_up_at: 'NOW()' }) },
    ]);
  });

  test('recently-opened skip: customer is looking at the quote right now', async () => {
    const est = baseEstimate({
      expires_at: new Date('2026-06-11T15:00:00Z'),
      last_viewed_at: new Date('2026-06-10T14:30:00Z'), // 30 min before NOW
    });
    enqueue('estimates', { rows: [est] });

    const sent = await _private.checkExpiringTouch(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});

// ── PR-bot round 1 ───────────────────────────────────────────────────────

describe('live-customer contact fallback (Codex P1: ID-less estimates)', () => {
  test('estimate with no customer_id but a live customer on the same phone is skipped', async () => {
    enqueue('estimates', { rows: [baseEstimate({ customer_id: null })] });
    enqueue('customers', { first: { id: 'cust-converted-elsewhere' } }); // contact match

    const sent = await _private.checkQuestionsTouch(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('linked customer not live → contact fallback still catches a live duplicate record', async () => {
    enqueue('estimates', { rows: [baseEstimate()] });
    enqueue('customers', { first: undefined }); // linked record: CRM lead row, not live
    enqueue('customers', { first: { id: 'cust-dup-live' } }); // same phone, live

    const sent = await _private.checkQuestionsTouch(NOW);

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('no customer_id and no contact match → touch proceeds', async () => {
    const est = baseEstimate({ customer_id: null });
    enqueue('estimates', { rows: [est] });
    enqueue('customers', { first: undefined }); // no live contact match
    enqueue('estimates', { update: 1 }); // claim
    enqueue('estimates', { update: 1 }); // counters

    const sent = await _private.checkQuestionsTouch(NOW);

    expect(sent).toBe(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('no customer_id and no phone/email at all → not treated as live', async () => {
    expect(
      await _private.isLiveCustomer({
        id: 'est-bare',
        customer_id: null,
        customer_phone: null,
        customer_email: null,
      }),
    ).toBe(false);
    // No contactable identity → no customers query should even run.
    expect(db).not.toHaveBeenCalled();
  });
});

describe('per-stage SMS kill-switch keys (Codex P2: shared messageType)', () => {
  test('questions touch (viewed) sends original_message_type estimate_followup_questions', async () => {
    enqueueHappyPath(baseEstimate());
    await _private.checkQuestionsTouch(NOW);
    expect(sendCustomerMessage.mock.calls[0][0].metadata.original_message_type)
      .toBe('estimate_followup_questions');
  });

  test('questions touch (unviewed) sends the unviewed variant key', async () => {
    enqueueHappyPath(baseEstimate({ viewed_at: null, last_viewed_at: null }));
    await _private.checkQuestionsTouch(NOW);
    expect(sendCustomerMessage.mock.calls[0][0].metadata.original_message_type)
      .toBe('estimate_followup_questions_unviewed');
  });

  test('day-5 check-in sends estimate_followup_credit', async () => {
    enqueueHappyPath(baseEstimate({
      sent_at: new Date('2026-06-04T15:00:00Z'), // 6 days before NOW
    }));
    await _private.checkCheckInTouch(NOW);
    expect(sendCustomerMessage.mock.calls[0][0].metadata.original_message_type)
      .toBe('estimate_followup_credit');
  });

  test('last-day notice sends estimate_followup_expiring', async () => {
    enqueueHappyPath(baseEstimate({
      expires_at: new Date('2026-06-11T10:00:00Z'), // inside the 30h horizon
    }));
    await _private.checkExpiringTouch(NOW);
    expect(sendCustomerMessage.mock.calls[0][0].metadata.original_message_type)
      .toBe('estimate_followup_expiring');
  });
});
