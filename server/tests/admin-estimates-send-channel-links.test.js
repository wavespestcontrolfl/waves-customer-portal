/**
 * Per-channel short-link minting for the admin estimate send route
 * (routes/admin-estimates.js → sendEstimateNow — click-tracking round 7).
 *
 * Same class as round 6's estimate-follow-up.js fix, in the delivery route:
 * sendMethod='both' used to mint ONE short code tagged channel='sms' and
 * hand the same URL to both legs. The legs fail independently — the SMS
 * template can be missing/disabled, the SMS can be policy-blocked at send
 * time — and the click-followup candidate scan (services/click-followup.js)
 * admits sc.channel='sms' links only, so a click on an EMAIL-only delivery
 * would masquerade as an SMS click and queue a proactive SMS nudge. Pins:
 *   - sendMethod='both' with both handles → TWO mints, channel-tagged per
 *     leg, same purpose + linkage; the SMS template gets the sms-tagged URL
 *     and the email payload gets the email-tagged URL;
 *   - SMS leg fails (template missing) while email succeeds → the email
 *     that went out carries the EMAIL-tagged URL, never the sms-tagged one
 *     (the undelivered sms code is unclickable, so it can never seed the
 *     followup queue);
 *   - sendMethod='email' → NO sms-tagged mint exists at all;
 *   - sendMethod='sms' → no email-tagged mint.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  // Channel-distinguishable URLs so the wiring (which leg got which link)
  // is observable downstream.
  shortenOrPassthrough: jest.fn(async (url, opts = {}) => `https://short.test/${opts.channel}`),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async (_key, vars) => `SMS: ${vars.estimate_url}`),
}));
jest.mock('../services/estimate-lead-linkage', () => ({
  leadIdForEstimate: jest.fn(async () => 'lead-9'),
}));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn(() => false),
  estimateDataHasUnresolvedManagerApproval: jest.fn(() => false),
  commercialRiskTypeReviewNeeded: jest.fn(() => false),
  validateEstimateDeliveryOptions: jest.fn(),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(),
  buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(),
  saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({
  createOrReuseAdminEstimate: jest.fn(),
  estimateExpiresAt: jest.fn(() => new Date('2026-08-04T00:00:00.000Z')),
  estimateViewUrl: jest.fn((token) => `https://portal.wavespestcontrol.com/estimate/${token}`),
}));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(),
  buildPricingBundle: jest.fn(async () => ({})),
  bookingServiceFor: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true) }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn() }));

const db = require('../models/db');
const router = require('../routes/admin-estimates');
const EmailTemplateLibrary = require('../services/email-template-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { shortenOrPassthrough } = require('../services/short-url');
const smsTemplates = require('../routes/admin-sms-templates');

function estimateRow(overrides = {}) {
  return {
    id: 'est-1',
    token: 'tok-1',
    status: 'sending', // route claims the row before calling sendEstimateNow
    customer_id: 'cust-1',
    customer_name: 'Dana Reyes',
    customer_phone: '+19415550101',
    customer_email: 'dana@example.com',
    monthly_total: '89',
    annual_total: '1068',
    estimate_data: null,
    created_at: '2026-07-01T12:00:00.000Z',
    updated_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

// Minimal chainable builder: .first() resolves the estimate row (email leg
// fresh read + finalize snapshot/audit reads), .update() resolves 1 (the
// finalize claim write succeeds).
function makeBuilder(row) {
  const b = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'select', 'orderBy', 'limit']) {
    b[m] = jest.fn(() => b);
  }
  b.first = jest.fn(async () => row);
  b.update = jest.fn(async () => 1);
  return b;
}

function mintedChannels() {
  return shortenOrPassthrough.mock.calls.map(([, opts]) => opts.channel);
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => makeBuilder(estimateRow()));
  db.raw = jest.fn((expr) => expr);
  db.fn = { now: jest.fn(() => 'NOW()') };
  sendCustomerMessage.mockResolvedValue({ sent: true });
  smsTemplates.getTemplate.mockImplementation(async (_key, vars) => `SMS: ${vars.estimate_url}`);
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true, message: { provider_message_id: 'sg-1' } });
});

describe('sendEstimateNow — per-channel tracked links (round 7)', () => {
  test("sendMethod='both': two mints, sms leg texts the sms-tagged URL, email carries the email-tagged URL", async () => {
    const result = await router.sendEstimateNow(estimateRow(), 'both');

    expect(result.sent).toBe(true);
    expect(result.sentChannels.sort()).toEqual(['email', 'sms']);

    // One mint per leg, both with the same purpose + linkage.
    expect(shortenOrPassthrough).toHaveBeenCalledTimes(2);
    expect(mintedChannels().sort()).toEqual(['email', 'sms']);
    for (const [, opts] of shortenOrPassthrough.mock.calls) {
      expect(opts).toMatchObject({
        kind: 'estimate',
        entityType: 'estimates',
        entityId: 'est-1',
        customerId: 'cust-1',
        leadId: 'lead-9',
        purpose: 'estimate_send',
      });
    }

    // SMS body renders from the sms-tagged link…
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      body: 'SMS: https://short.test/sms',
    }));
    // …and the email payload carries the email-tagged link, never the sms one.
    const emailPayload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(emailPayload.estimate_url).toBe('https://short.test/email');
  });

  test('SMS template missing on both-send: email still goes out with the EMAIL-tagged URL only', async () => {
    smsTemplates.getTemplate.mockResolvedValue(null); // template disabled/missing

    const result = await router.sendEstimateNow(estimateRow(), 'both');

    expect(result.sent).toBe(true);
    expect(result.partialFailure).toBe(true);
    expect(result.sentChannels).toEqual(['email']);
    expect(result.failedChannels).toEqual(['sms']);
    expect(sendCustomerMessage).not.toHaveBeenCalled();

    // The delivered email carries its own email-tagged code — a click on it
    // can never masquerade as an SMS click (the sms code was never sent).
    const emailPayload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(emailPayload.estimate_url).toBe('https://short.test/email');
    expect(JSON.stringify(emailPayload)).not.toContain('https://short.test/sms');
  });

  test("sendMethod='email': no sms-tagged code is ever minted", async () => {
    const result = await router.sendEstimateNow(estimateRow(), 'email');

    expect(result.sent).toBe(true);
    expect(mintedChannels()).toEqual(['email']);
  });

  test("sendMethod='sms': no email-tagged code is ever minted", async () => {
    const result = await router.sendEstimateNow(estimateRow(), 'sms');

    expect(result.sent).toBe(true);
    expect(mintedChannels()).toEqual(['sms']);
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      body: 'SMS: https://short.test/sms',
    }));
  });
});
