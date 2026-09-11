/**
 * "Expiring in 1-3 days" stage (estimate-follow-up.js checkAll) after the
 * #4309 round-7 inversion (owner ruling 2026-09-11).
 *
 * `expires_at` is now ALWAYS the row's own offer deadline and is never widened
 * by a grouped fixed sibling, so this stage's ordinary window bound is correct
 * for fixed-validity rows too. Two things that must hold:
 *   - the window keeps its ONE-DAY LOWER BOUND for every row, with no
 *     fixed-validity escape hatch admitting rows outside it. The blanket
 *     `NOT (FIXED_BID_VALIDITY_ABSENT_SQL)` OR that used to admit any fixed row
 *     regardless of the column is gone; leaving it in place is what dropped the
 *     lower bound and let a bid be nudged inside its final day (GH codex P2 r7).
 *   - a nudge that goes out quotes that same deadline.
 *
 * The candidate bound lives inside a `where((q) => ...)` callback the knex
 * stub never invokes, so the bound itself is asserted against the source (the
 * same technique proposal-bid.test.js uses for the public renderers) and the
 * send path is asserted behaviourally.
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

describe('expiring stage after the #4309 r7 inversion: one window, one-day lower bound', () => {
  test('keeps the 1-3 day window and adds NO fixed-validity escape, so a bid inside its final day is not nudged (GH codex P2 r7)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/estimate-follow-up.js'), 'utf8');
    // The expiring candidate bound, with its one-day lower edge intact.
    expect(src).toMatch(/\.whereBetween\("expires_at", \[\s*new Date\(Date\.now\(\) \+ 1 \* 86400000\),\s*new Date\(Date\.now\(\) \+ 3 \* 86400000\),\s*\]\)/);
    // The copy quotes the same column the bound selected on.
    expect(src).toMatch(/const expDate = new Date\(est\.expires_at\)\.toLocaleDateString/);
    // No blanket fixed-validity OR may re-admit rows that bound excluded —
    // that escape is what dropped the lower bound.
    expect(src).not.toMatch(/FIXED_BID_VALIDITY_ABSENT_SQL/);
    // And no in-memory authored-deadline re-check replaces it.
    expect(src).not.toMatch(/authoredExpiryMs/);
  });

  test('a row inside the window sends, quoting its own expires_at', async () => {
    skipStagesOneThroughThree();
    enqueue('estimates', {
      rows: [expiringEstimate({
        // A fixed bid ending 2026-06-12 ET. expires_at IS that authored
        // deadline now — no sibling widens it, so there is nothing to narrow.
        estimate_data: { proposal: { enabled: true, validThrough: '2026-06-12' } },
        expires_at: new Date('2026-06-13T03:59:59.999Z'),
        // A far-future group-link viewability window must NOT influence the
        // offer: it is navigation state only.
        ...{},
      })],
    });

    await EstimateFollowUp.checkAll();

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    const payload = EmailTemplates.sendTemplate.mock.calls[0][0].payload;
    expect(payload.expires_at).toBe('June 12, 2026');
  });

  test('the stored group-link viewability window never reaches this stage', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/estimate-follow-up.js'), 'utf8');
    expect(src).not.toMatch(/groupLinkViewableThrough|groupLinkStillViewable|publicExpiresAt/);
  });
});
