/**
 * "Expiring in 1-3 days" stage (estimate-follow-up.js checkAll) must judge a
 * fixed-validity property on its OWN authored deadline (publicExpiresAt), not
 * the raw expires_at column — which a grouped fixed sibling can widen to a
 * LATER date on the anchor's row. Two failure modes fixed here (GH codex P1
 * r6 on #4309):
 *   - an anchor whose authored deadline already passed must never be
 *     nudged/emailed, even though the widened raw column is still future;
 *   - a nudge that DOES go out must quote the authored deadline, never the
 *     later widened one.
 *
 * Modeled on estimate-followup-channel-links.test.js's checkAll harness —
 * only the stage-4 "estimates" candidate slot is populated; stages 1-3 see
 * an empty queue and no-op.
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
jest.mock('../services/estimate-deposits', () => ({
  assessDepositFollowUpEligibility: jest.fn(async () => ({ eligible: false })),
  DEPOSIT_FOLLOWUP_WINDOW: { minAgeHours: 2, maxAgeHours: 72 },
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const smsTemplates = require('../routes/admin-sms-templates');
const EstimateFollowUp = require('../services/estimate-follow-up');

// Chainable knex-builder stub in the style of the other follow-up tests.
function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of [
    'join', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereNull', 'whereNot',
    'where', 'whereBetween', 'select', 'groupBy', 'max', 'as', 'orderBy',
    'orWhereNull', 'andWhere', 'whereNotExists', 'whereRaw', 'orWhereRaw',
  ]) {
    b[m] = jest.fn(() => b);
  }
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.update = jest.fn(() => { b._mode = 'update'; return b; });
  b.then = (resolve, reject) => {
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
// Stages 1-3 each issue one "estimates" select before stage 4 — push an
// empty result for each so stage 4's candidate lands in the right FIFO slot.
function skipStagesOneThroughThree() {
  enqueue('estimates', { rows: [] });
  enqueue('estimates', { rows: [] });
  enqueue('estimates', { rows: [] });
}

const NOW = new Date('2026-06-10T15:00:00Z'); // 11:00 ET — inside the send window
const H = 3600000;
const D = 86400000;

function expiringEstimate(overrides = {}) {
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
    ...overrides,
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

describe('expiring stage judges the AUTHORED deadline, not the group-widened raw column (GH codex P1 r6 on #4309)', () => {
  test('an anchor past its OWN authored deadline is never nudged, even though the widened expires_at is still 2 days out', async () => {
    skipStagesOneThroughThree();
    enqueue('estimates', {
      rows: [expiringEstimate({
        // Authored bid lapsed 2026-06-05 — days ago.
        estimate_data: { proposal: { enabled: true, validThrough: '2026-06-05' } },
        // Raw column widened to a grouped sibling's later fixed hold — still
        // sits inside the naive 1-3 day window the old code trusted.
        expires_at: new Date(NOW.getTime() + 2 * D),
      })],
    });

    await EstimateFollowUp.checkAll();

    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an anchor within its OWN authored window sends, quoting the AUTHORED date — not the later widened raw column', async () => {
    skipStagesOneThroughThree();
    enqueue('estimates', {
      rows: [expiringEstimate({
        // Authored bid ends 2026-06-12 (ET) — inside the 1-3 day window.
        estimate_data: { proposal: { enabled: true, validThrough: '2026-06-12' } },
        // Raw column widened far out by a grouped sibling's later hold —
        // outside the naive window, but the row is still eligible on its
        // own authored date.
        expires_at: new Date(NOW.getTime() + 20 * D),
      })],
    });

    await EstimateFollowUp.checkAll();

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    const payload = EmailTemplates.sendTemplate.mock.calls[0][0].payload;
    // The authored deadline (June 12 ET), never the widened raw column
    // (June 30).
    expect(payload.expires_at).toBe('June 12, 2026');
  });
});
