/**
 * Per-channel short-link minting for the estimate follow-up stages
 * (click-tracking round 6).
 *
 * The four dual-channel stages used to mint ONE short code tagged
 * channel='sms' and hand the same URL to both legs. sendDualChannel can send
 * the EMAIL leg alone (missing/disabled SMS template, policy-blocked SMS, no
 * phone on the estimate), and the click-followup candidate scan admits
 * sc.channel='sms' links only — so a click on an email-only follow-up would
 * masquerade as an SMS click and queue a proactive SMS draft. Pins:
 *   - both handles → TWO mints, channel-tagged per leg, same purpose +
 *     linkage; the SMS template gets the sms-tagged URL and the email
 *     payload gets the email-tagged URL;
 *   - SMS template missing → the email that still goes out carries the
 *     EMAIL-tagged URL (the undelivered sms code is unclickable, so it can
 *     never seed the followup queue);
 *   - email-only estimate → NO sms-tagged mint exists at all;
 *   - phone-only estimate → no email mint.
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
  // Channel-distinguishable URLs so the wiring (which leg got which link)
  // is observable downstream.
  shortenOrPassthrough: jest.fn(async (url, opts = {}) => `https://short.test/${opts.channel}`),
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
  leadIdForEstimate: jest.fn(async () => 'lead-9'),
}));
jest.mock('../services/estimate-deposits', () => ({
  assessDepositFollowUpEligibility: jest.fn(async () => ({ eligible: false })),
  DEPOSIT_FOLLOWUP_WINDOW: { minAgeHours: 2, maxAgeHours: 72 },
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { shortenOrPassthrough } = require('../services/short-url');
const smsTemplates = require('../routes/admin-sms-templates');
const EstimateFollowUp = require('../services/estimate-follow-up');
const { _private } = EstimateFollowUp;

// Chainable knex-builder stub in the style of the other follow-up tests.
function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of [
    'join', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereNull', 'whereNot',
    'where', 'whereBetween', 'select', 'groupBy', 'max', 'as', 'orderBy',
    'orWhereNull', 'andWhere',
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

// 11:00 ET — inside the 9a-5p send window (checkAll gates on the real clock).
const NOW = new Date('2026-06-10T15:00:00Z');
const H = 3600000;

function unviewedEstimate(overrides = {}) {
  return {
    id: 'est-1',
    status: 'sent',
    customer_id: 'cust-1',
    customer_name: 'Taylor Doe',
    customer_phone: '+19415550100',
    customer_email: 'taylor@example.com',
    token: 'tok-xyz',
    sent_at: new Date(NOW.getTime() - 30 * H),
    viewed_at: null,
    created_at: new Date(NOW.getTime() - 31 * H),
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
  shortenOrPassthrough.mockImplementation(async (url, opts = {}) => `https://short.test/${opts.channel}`);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('checkAll stage wiring — one tracked code per channel leg', () => {
  test('both handles: sms-tagged link rides the SMS template, email-tagged link rides the email payload', async () => {
    enqueue('estimates', { rows: [unviewedEstimate()] }); // stage-1 candidates

    await EstimateFollowUp.checkAll();

    // Two mints, channel-tagged per leg, identical purpose + linkage.
    const mintOpts = shortenOrPassthrough.mock.calls.map((c) => c[1]);
    expect(mintOpts).toHaveLength(2);
    for (const channel of ['sms', 'email']) {
      expect(mintOpts).toContainEqual(expect.objectContaining({
        channel,
        kind: 'estimate',
        purpose: 'estimate_followup_unviewed',
        entityType: 'estimates',
        entityId: 'est-1',
        customerId: 'cust-1',
        leadId: 'lead-9',
      }));
    }
    // SMS leg carries the sms-tagged URL...
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'estimate_followup_unviewed',
      expect.objectContaining({ estimate_url: 'https://short.test/sms' }),
      expect.any(Object),
    );
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    // ...and the email leg carries the email-tagged URL, never the sms one.
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ estimate_url: 'https://short.test/email' }),
    }));
  });

  test('SMS template missing → the email that still goes out is EMAIL-tagged (the sms code is never delivered)', async () => {
    // The round-6 finding: sendDualChannel sends ONLY the email here. With a
    // single sms-tagged code, a click on that email would be admitted by the
    // followup scan (sc.channel='sms') and queue a proactive SMS draft.
    smsTemplates.getTemplate.mockResolvedValue(null);
    enqueue('estimates', { rows: [unviewedEstimate()] });

    await EstimateFollowUp.checkAll();

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ estimate_url: 'https://short.test/email' }),
    }));
  });
});

describe('mintStageLinks — legs the estimate cannot receive are never minted', () => {
  test('email-only estimate: NO sms-tagged code exists; sms slot falls back to the long URL', async () => {
    const { smsUrl, emailUrl } = await _private.mintStageLinks(
      unviewedEstimate({ customer_phone: null }),
      'estimate_followup_unviewed',
    );

    expect(shortenOrPassthrough).toHaveBeenCalledTimes(1);
    expect(shortenOrPassthrough).toHaveBeenCalledWith(
      'https://portal.wavespestcontrol.com/estimate/tok-xyz',
      expect.objectContaining({ channel: 'email' }),
    );
    expect(shortenOrPassthrough).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channel: 'sms' }),
    );
    expect(emailUrl).toBe('https://short.test/email');
    expect(smsUrl).toBe('https://portal.wavespestcontrol.com/estimate/tok-xyz');
  });

  test('phone-only estimate: no email mint; email slot falls back to the long URL', async () => {
    const { smsUrl, emailUrl } = await _private.mintStageLinks(
      unviewedEstimate({ customer_email: null }),
      'estimate_followup_viewed',
    );

    expect(shortenOrPassthrough).toHaveBeenCalledTimes(1);
    expect(shortenOrPassthrough).toHaveBeenCalledWith(
      'https://portal.wavespestcontrol.com/estimate/tok-xyz',
      expect.objectContaining({ channel: 'sms', purpose: 'estimate_followup_viewed' }),
    );
    expect(smsUrl).toBe('https://short.test/sms');
    expect(emailUrl).toBe('https://portal.wavespestcontrol.com/estimate/tok-xyz');
  });
});
