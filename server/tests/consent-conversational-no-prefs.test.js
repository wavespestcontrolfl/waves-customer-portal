/**
 * Consent validator — missing notification_prefs row vs conversational replies.
 *
 * Pins the rule that a missing prefs row never blocks a transactional
 * conversational reply (for customers AND leads): STOP handling upserts a
 * prefs row with sms_enabled=false, so a real opt-out is always caught by
 * the sms_enabled gate, never by row absence. Customers created through
 * paths that don't seed notification_prefs were previously stranded as
 * NO_CONSENT_RECORD on manual replies from Communications / tech Messages.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { resolvePolicy } = require('../services/messaging/policy');
const { checkConsentForPurpose } = require('../services/messaging/validators/consent');

const smsInput = (overrides = {}) => ({
  to: '+19415550100',
  body: 'x',
  channel: 'sms',
  audience: 'customer',
  purpose: 'conversational',
  customerId: 'c1',
  ...overrides,
});

describe('conversational sends with NO notification_prefs row', () => {
  test('customer audience: allowed — a missing row is not an opt-out', async () => {
    const policy = resolvePolicy('customer', 'conversational');
    const res = await checkConsentForPurpose(
      smsInput(),
      policy,
      { prefs: null, customer: { id: 'c1' }, lookupFailed: false },
    );
    expect(res).toEqual({ ok: true });
  });

  test('lead audience: still allowed (pre-existing behavior preserved)', async () => {
    const policy = resolvePolicy('lead', 'conversational');
    const res = await checkConsentForPurpose(
      smsInput({ audience: 'lead', customerId: undefined }),
      policy,
      { prefs: null, customer: null, lookupFailed: false },
    );
    expect(res).toEqual({ ok: true });
  });

  test('non-conversational purposes still require a prefs row (NO_CONSENT_RECORD)', async () => {
    const policy = resolvePolicy('customer', 'billing');
    const res = await checkConsentForPurpose(
      smsInput({ purpose: 'billing' }),
      policy,
      { prefs: null, customer: { id: 'c1' }, lookupFailed: false },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NO_CONSENT_RECORD');
  });

  test('a real opt-out (sms_enabled=false on the prefs row) still blocks conversational', async () => {
    const policy = resolvePolicy('customer', 'conversational');
    const res = await checkConsentForPurpose(
      smsInput(),
      policy,
      { prefs: { sms_enabled: false }, customer: { id: 'c1' }, lookupFailed: false },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('SMS_OPTED_OUT');
  });

  test('a failed consent lookup still fails closed (CONSENT_LOOKUP_FAILED outranks the exception)', async () => {
    const policy = resolvePolicy('customer', 'conversational');
    const res = await checkConsentForPurpose(
      smsInput(),
      policy,
      { prefs: null, customer: null, lookupFailed: true },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CONSENT_LOOKUP_FAILED');
  });
});
