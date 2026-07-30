/**
 * Consent validator — missing notification_prefs row vs conversational replies.
 *
 * Pins the rule that a missing prefs row never blocks a transactional
 * conversational REPLY: STOP handling upserts a prefs row with
 * sms_enabled=false, so a real opt-out is always caught by the sms_enabled
 * gate, never by row absence. Customers created through paths that don't
 * seed notification_prefs were previously stranded as NO_CONSENT_RECORD on
 * manual replies from Communications / tech Messages.
 *
 * Reply evidence (contactState.hasInboundHistory — a prior inbound sms_log
 * row from this phone) is required for non-lead audiences: purpose
 * 'conversational' is reused by flows that can START a thread, and a cold
 * outbound to a no-row recipient must not bypass consent (Codex P1 on
 * PR #3057).
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
  test('customer who has texted in (inbound history): allowed — a missing row is not an opt-out', async () => {
    const policy = resolvePolicy('customer', 'conversational');
    const res = await checkConsentForPurpose(
      smsInput(),
      policy,
      { prefs: null, customer: { id: 'c1' }, lookupFailed: false, hasInboundHistory: true },
    );
    expect(res).toEqual({ ok: true });
  });

  test('customer with NO inbound history: cold-start still blocks as NO_CONSENT_RECORD', async () => {
    const policy = resolvePolicy('customer', 'conversational');
    const res = await checkConsentForPurpose(
      smsInput(),
      policy,
      { prefs: null, customer: { id: 'c1' }, lookupFailed: false, hasInboundHistory: false },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NO_CONSENT_RECORD');
  });

  test('lead audience: allowed without inbound evidence (pre-existing behavior preserved)', async () => {
    const policy = resolvePolicy('lead', 'conversational');
    const res = await checkConsentForPurpose(
      smsInput({ audience: 'lead', customerId: undefined }),
      policy,
      { prefs: null, customer: null, lookupFailed: false, hasInboundHistory: false },
    );
    expect(res).toEqual({ ok: true });
  });

  test('non-conversational purposes still require a prefs row even with inbound history', async () => {
    const policy = resolvePolicy('customer', 'billing');
    const res = await checkConsentForPurpose(
      smsInput({ purpose: 'billing' }),
      policy,
      { prefs: null, customer: { id: 'c1' }, lookupFailed: false, hasInboundHistory: true },
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
      { prefs: null, customer: null, lookupFailed: true, hasInboundHistory: true },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CONSENT_LOOKUP_FAILED');
  });
});

describe('loadContactState — inbound-history evidence', () => {
  const db = require('../models/db');
  const { loadContactState } = require('../services/messaging/validators/consent');

  const mockDb = ({ prefs = null, customer = null, inboundRow = null, inboundThrows = false }) => {
    db.mockImplementation((table) => {
      if (table === 'notification_prefs') {
        return { where: () => ({ first: async () => prefs }) };
      }
      if (table === 'customers') {
        return { where: () => ({ first: async () => customer }) };
      }
      if (table === 'sms_log') {
        return {
          where: () => ({
            whereIn: () => ({
              first: async () => {
                if (inboundThrows) throw new Error('boom');
                return inboundRow;
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
  };

  test('prefs row missing + prior inbound sms_log row → hasInboundHistory true', async () => {
    mockDb({ customer: { id: 'c1', phone: '+19415550100' }, inboundRow: { id: 's1' } });
    const state = await loadContactState({ customerId: 'c1', to: '+19415550100' });
    expect(state.hasInboundHistory).toBe(true);
  });

  test('prefs row missing + no inbound row → hasInboundHistory false', async () => {
    mockDb({ customer: { id: 'c1', phone: '+19415550100' }, inboundRow: null });
    const state = await loadContactState({ customerId: 'c1', to: '+19415550100' });
    expect(state.hasInboundHistory).toBe(false);
  });

  test('prefs row present → the inbound-history query never runs', async () => {
    mockDb({ prefs: { sms_enabled: true }, customer: { id: 'c1', phone: '+19415550100' }, inboundThrows: true });
    const state = await loadContactState({ customerId: 'c1', to: '+19415550100' });
    expect(state.hasInboundHistory).toBe(false);
    expect(state.prefs).toEqual({ sms_enabled: true });
  });

  test('inbound-history query error stays false (fails closed, not lookupFailed)', async () => {
    mockDb({ customer: { id: 'c1', phone: '+19415550100' }, inboundThrows: true });
    const state = await loadContactState({ customerId: 'c1', to: '+19415550100' });
    expect(state.hasInboundHistory).toBe(false);
    expect(state.lookupFailed).toBe(false);
  });
});
