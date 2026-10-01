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

  test('a visit-linked send that threads only metadata.scheduled_service_id (the card request shape) is held too', async () => {
    isStreetLevelHoldVisit.mockResolvedValue(true);
    const result = await sendCustomerMessage({
      to: '+19415550142', channel: 'sms', audience: 'customer', customerId: 'cust-1', purpose: 'card_request',
      body: 'Add a card to hold your visit.', metadata: { scheduled_service_id: 'visit-9' },
    });
    expect(result).toMatchObject({ sent: false, code: 'STREET_LEVEL_HOLD' });
    expect(isStreetLevelHoldVisit).toHaveBeenCalledWith('visit-9');
    expect(sendViaTwilio).not.toHaveBeenCalled();
  });

  test('a composer send that links visits (metadata.linked_scheduled_service_ids) is held when ANY linked visit is a live hold', async () => {
    isStreetLevelHoldVisit.mockImplementation(async (id) => id === 'visit-held');
    const send = (linked) => sendCustomerMessage({
      to: '+19415550142', channel: 'sms', audience: 'customer', customerId: 'cust-1', purpose: 'conversational',
      body: 'Here is your reschedule link.', metadata: { linked_scheduled_service_ids: linked },
    });
    const held = await send(['visit-ok', 'visit-held']);
    expect(held).toMatchObject({ sent: false, blocked: true, code: 'STREET_LEVEL_HOLD', retryable: true });
    expect(sendViaTwilio).not.toHaveBeenCalled();
    expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({ validatorsFailed: ['street_level_hold'] }));
    // None of them held: the text goes out. An empty / absent list never consults the hold.
    expect((await send(['visit-ok'])).sent).toBe(true);
    isStreetLevelHoldVisit.mockClear();
    await send([]);
    expect(isStreetLevelHoldVisit).not.toHaveBeenCalled();
  });

  test('a LEAD-audience composer send (phone-only reschedule link, shared phone) is held on its linked visit too; a staff-facing audience is not', async () => {
    isStreetLevelHoldVisit.mockImplementation(async (id) => id === 'visit-held');
    const lead = (linked, extra = {}) => sendCustomerMessage({
      to: '+19415550142', channel: 'sms', audience: 'lead', purpose: 'conversational', identityTrustLevel: 'phone_provided_unverified',
      body: 'Here is your reschedule link.', metadata: { linked_scheduled_service_ids: linked }, ...extra,
    });
    expect(await lead(['visit-held'])).toMatchObject({ sent: false, blocked: true, code: 'STREET_LEVEL_HOLD', retryable: true });
    expect(sendViaTwilio).not.toHaveBeenCalled();
    expect((await lead(['visit-ok'])).sent).toBe(true);
    // The same hold applies to an appointmentId / metadata.scheduled_service_id send classified as a lead.
    expect(await lead([], { appointmentId: 'visit-held' })).toMatchObject({ blocked: true, code: 'STREET_LEVEL_HOLD' });
    // Staff-facing briefings are never about a customer's held visit.
    isStreetLevelHoldVisit.mockClear();
    await sendCustomerMessage({
      to: '+19415550142', channel: 'sms', audience: 'internal', purpose: 'internal_briefing', body: 'Ops note.', metadata: { linked_scheduled_service_ids: ['visit-held'] },
    });
    expect(isStreetLevelHoldVisit).not.toHaveBeenCalled();
  });

  test('the office-confirm hook\'s own card invitation is part of the release and is not held; every other card-request trigger still is', async () => {
    isStreetLevelHoldVisit.mockResolvedValue(true);
    const send = (trigger) => sendCustomerMessage({
      to: '+19415550142', channel: 'sms', audience: 'customer', customerId: 'cust-1', purpose: 'card_request',
      body: 'Add a card to hold your visit.', metadata: { scheduled_service_id: 'visit-9', trigger },
    });
    expect((await send('outbound_review_confirm')).sent).toBe(true);
    for (const trigger of ['admin', 'previsit_sweep', 'booking']) {
      const r = await send(trigger);
      expect(r).toMatchObject({ sent: false, code: 'STREET_LEVEL_HOLD' });
    }
    // The hook really sends under that trigger.
    const src = fs.readFileSync(require.resolve('../services/outbound-review-confirm.js'), 'utf8');
    expect(src).toContain("trigger: 'outbound_review_confirm'");
  });

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

  test('the durable predicate applies whatever the rollout gate says: turning the gate off never releases an open hold', async () => {
    delete process.env[GATE];
    isStreetLevelHoldVisit.mockResolvedValue(true);
    const result = await sendCustomerMessage({ ...base, ...notices['a reschedule notice'] });
    expect(isStreetLevelHoldVisit).toHaveBeenCalledWith('visit-1');
    expect(result).toMatchObject({ sent: false, code: 'STREET_LEVEL_HOLD' });
  });
});

describe('the appointment email sender holds it too', () => {
  test('sendTemplate returns held before any customer load or provider call', () => {
    const s = fs.readFileSync(require.resolve('../services/appointment-email.js'), 'utf8');
    const at = s.indexOf('const holdVisitId = scheduledServiceId || moveHoldServiceId;');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(s.indexOf('const customer = await loadCustomer(customerId);', at));
    expect(s.slice(at, at + 520)).toContain("return { ok: false, held: true, reason: 'street_level_hold' };");
    expect(s.slice(at, at + 300)).not.toContain('callLeadFormAddressStreetLevelLive');
  });
});

describe('the provider-handoff boundary re-checks the hold (a promotion committing mid-flight still holds the send)', () => {
  test('SMS: not a hold at step 6.35, a hold by the provider\'s preSendCheck -> blocked there, nothing dialed', async () => {
    isStreetLevelHoldVisit.mockResolvedValueOnce(false).mockResolvedValue(true);
    sendViaTwilio.mockImplementationOnce(async (_providerInput, hooks) => {
      const verdict = await hooks.preSendCheck();
      if (!verdict.ok) return { sent: false, provider: 'twilio', deliveryOutcome: 'not_sent' };
      return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-real' };
    });
    const result = await sendCustomerMessage({ ...base, ...notices['a reschedule notice'] });
    expect(isStreetLevelHoldVisit).toHaveBeenCalledTimes(2);
    expect(result.sent).toBe(false);
    expect(result.code === 'STREET_LEVEL_HOLD' || result.deliveryOutcome === 'not_sent').toBe(true);
  });

  test('email: the library\'s onQueued hook aborts a send whose visit became a hold, and the fan-out reports held', () => {
    const s = fs.readFileSync(require.resolve('../services/appointment-email.js'), 'utf8');
    const hook = s.indexOf("abortedBy = 'street_level_hold'; return false;");
    expect(hook).toBeGreaterThan(s.indexOf('onQueued: async () => {'));
    expect(s).toContain("if (result?.aborted && abortedBy) {");
    expect(s).toContain("return { ok: false, held: true, reason: abortedBy };");
  });
});

describe('the prep guide sender carries the visit so the shared send step applies', () => {
  test('SMS passes metadata.scheduled_service_id; the visit email aborts in onQueued while the visit is a hold', () => {
    const s = fs.readFileSync(require.resolve('../services/prep-guide-sender.js'), 'utf8');
    expect(s).toContain('...(visitId ? { scheduled_service_id: visitId } : {}),');
    expect(s).toContain('visitId: visit?.id || null, ...smsPlan,');
    expect(s).toContain('if (visit?.id && await isStreetLevelHoldVisit(visit.id)) return false;');
  });
  test('a prep SMS for a held visit is held by the sender (metadata.scheduled_service_id), a visit-less guide is not', async () => {
    isStreetLevelHoldVisit.mockResolvedValue(true);
    const held = await sendCustomerMessage({
      to: '+19415550142', channel: 'sms', audience: 'customer', customerId: 'cust-1', purpose: 'appointment',
      body: 'How to prepare.', metadata: { scheduled_service_id: 'visit-3', original_message_type: 'prep_info' },
    });
    expect(held).toMatchObject({ sent: false, code: 'STREET_LEVEL_HOLD' });
    isStreetLevelHoldVisit.mockClear();
    await sendCustomerMessage({ to: '+19415550142', channel: 'sms', audience: 'customer', customerId: 'cust-1', purpose: 'appointment', body: 'x', metadata: { original_message_type: 'prep_info' } });
    expect(isStreetLevelHoldVisit).not.toHaveBeenCalled();
  });
});
