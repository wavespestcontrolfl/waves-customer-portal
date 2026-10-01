// Owner ruling 2026-10-01: NO customer text or email about a live unconfirmed street-level
// address hold until the office confirms. Enforced at the shared send step (sendCustomerMessage,
// every visit-scoped customer SMS) and at the appointment email sender. Synthetic data only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn(() => false) };
});
jest.mock('../services/messaging/validators/consent', () => ({
  loadContactState: jest.fn(async () => ({})),
  checkConsentForPurpose: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(async (_input, contactState) => contactState),
  checkSuppression: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  checkLineType: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/identity', () => ({
  validateRequiredIds: jest.fn(() => ({ ok: true })),
  validateIdentityTrust: jest.fn(() => ({ ok: true })),
  resolveTrustLevel: jest.fn(() => 'phone_matches_customer'),
}));
jest.mock('../services/messaging/validators/voice', () => ({
  validateNoCustomerEmoji: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/compliance-contact-checks', () => ({
  checkContactCompliance: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/audit', () => ({
  persistAudit: jest.fn(async () => ({ id: 'audit-1' })),
}));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  sendViaTwilio: jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-real' })),
  mapPurposeToMessageType: jest.fn(() => 'manual'),
}));
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
  withheldLinkPolicyForSmsPurpose: jest.fn(() => 'refuse'),
}));
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
}));
jest.mock('../services/street-level-hold', () => ({
  ...jest.requireActual('../services/street-level-hold'),
  isStreetLevelHoldVisit: jest.fn(async () => false),
}));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');
const { isStreetLevelHoldVisit } = require('../services/street-level-hold');


const fs = require('fs');
const logger = require('../services/logger');

const GATE = 'GATE_CALL_LEAD_FORM_ADDRESS_STREET_LEVEL';
let saved;
beforeEach(() => {
  jest.clearAllMocks();
  saved = process.env[GATE];
  process.env[GATE] = 'true';
  sendViaTwilio.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-real' });
  persistAudit.mockResolvedValue({ id: 'audit-1' });
  isStreetLevelHoldVisit.mockResolvedValue(false);
});
afterEach(() => { if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved; });

const base = { to: '+19415550142', channel: 'sms', audience: 'customer', customerId: 'cust-1', appointmentId: 'visit-1' };
const notices = {
  'a reschedule notice': { purpose: 'appointment', body: 'Your visit moved to Tuesday.' },
  'a completion recap': { purpose: 'service_completion', body: 'Thanks for having us today.' },
  'a missed-visit notice': { purpose: 'appointment', body: 'We missed you at your visit.' },
};

describe('the SMS send step holds a live street-level hold', () => {
  for (const [label, msg] of Object.entries(notices)) {
    test(`${label} for a held visit: no provider call, audited, retryable; the log names ids only`, async () => {
      isStreetLevelHoldVisit.mockResolvedValue(true);
      const result = await sendCustomerMessage({ ...base, ...msg });
      expect(result).toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'STREET_LEVEL_HOLD', retryable: true });
      expect(isStreetLevelHoldVisit).toHaveBeenCalledWith('visit-1');
      expect(sendViaTwilio).not.toHaveBeenCalled();
      expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({ validatorsFailed: ['street_level_hold'] }));
      const logged = logger.info.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('visit-1');
      expect(logged).not.toContain(msg.body);
    });
  }

  test('a non-hold visit is unaffected: it sends', async () => {
    const result = await sendCustomerMessage({ ...base, ...notices['a reschedule notice'] });
    expect(result.sent).toBe(true);
    expect(sendViaTwilio).toHaveBeenCalledTimes(1);
  });

  test('a send with no visit, or to a lead / internal audience, never consults the hold', async () => {
    await sendCustomerMessage({ ...base, appointmentId: undefined, purpose: 'estimate_followup', estimateId: 'est-1', body: 'x' });
    expect(isStreetLevelHoldVisit).not.toHaveBeenCalled();
  });

  test('a lookup error fails CLOSED (the predicate answers held on an error)', async () => {
    const actual = jest.requireActual('../services/street-level-hold');
    const blip = () => { throw new Error('db down'); };
    expect(await actual.isStreetLevelHoldVisit('visit-1', blip)).toBe(true);
  });

  test('gate off is byte-identical: no lookup at all', async () => {
    delete process.env[GATE];
    isStreetLevelHoldVisit.mockResolvedValue(true);
    const result = await sendCustomerMessage({ ...base, ...notices['a reschedule notice'] });
    expect(isStreetLevelHoldVisit).not.toHaveBeenCalled();
    expect(result.sent).toBe(true);
  });
});

describe('the appointment email sender holds it too', () => {
  test('sendTemplate returns held before any customer load or provider call', () => {
    const s = fs.readFileSync(require.resolve('../services/appointment-email.js'), 'utf8');
    const at = s.indexOf('const holdVisitId = scheduledServiceId || moveHoldServiceId;');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(s.indexOf('const customer = await loadCustomer(customerId);', at));
    expect(s.slice(at, at + 520)).toContain("return { ok: false, held: true, reason: 'street_level_hold' };");
    expect(s.slice(at, at + 300)).toContain('callLeadFormAddressStreetLevelLive()');
  });
});
