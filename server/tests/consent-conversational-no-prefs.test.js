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
 * row from this phone, loaded only when the decision depends on it) is
 * required for non-lead audiences: purpose 'conversational' is reused by
 * flows that can START a thread, and a cold outbound to a no-row recipient
 * must not bypass consent. The exception also requires positively loaded
 * suppression state — a pre-customer STOP lives only in
 * messaging_suppression, so an unknown suppression lookup must return the
 * retryable code, never grant the send (Codex P1s on PR #3057).
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

  test('suppression lookup failed: exception refuses to fire — retryable CONSENT_LOOKUP_FAILED, never a send', async () => {
    const policy = resolvePolicy('customer', 'conversational');
    const res = await checkConsentForPurpose(
      smsInput(),
      policy,
      {
        prefs: null,
        customer: { id: 'c1' },
        lookupFailed: false,
        hasInboundHistory: true,
        suppressionLookupFailed: true,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CONSENT_LOOKUP_FAILED');
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

  let smsLogQueried;
  let smsLogPhones;

  const mockDb = ({ prefs = null, customer = null, inboundRow = null, inboundThrows = false }) => {
    smsLogQueried = false;
    smsLogPhones = null;
    db.mockImplementation((table) => {
      if (table === 'notification_prefs') {
        return { where: () => ({ first: async () => prefs }) };
      }
      if (table === 'customers') {
        return { where: () => ({ first: async () => customer }) };
      }
      if (table === 'sms_log') {
        smsLogQueried = true;
        return {
          where: () => ({
            whereIn: (_col, phones) => {
              smsLogPhones = phones;
              return {
                first: async () => {
                  if (inboundThrows) throw new Error('boom');
                  return inboundRow;
                },
              };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
  };

  const baseInput = { customerId: 'c1', to: '+19415550100', audience: 'customer', purpose: 'conversational' };

  test('prefs row missing + prior inbound sms_log row → hasInboundHistory true', async () => {
    mockDb({ customer: { id: 'c1', phone: '+19415550100' }, inboundRow: { id: 's1' } });
    const state = await loadContactState(baseInput);
    expect(state.hasInboundHistory).toBe(true);
    expect(state.lookupFailed).toBe(false);
  });

  test('prefs row missing + no inbound row → hasInboundHistory false', async () => {
    mockDb({ customer: { id: 'c1', phone: '+19415550100' }, inboundRow: null });
    const state = await loadContactState(baseInput);
    expect(state.hasInboundHistory).toBe(false);
    expect(state.lookupFailed).toBe(false);
  });

  test('prefs row present → the inbound-history query never runs', async () => {
    mockDb({ prefs: { sms_enabled: true }, customer: { id: 'c1', phone: '+19415550100' }, inboundThrows: true });
    const state = await loadContactState(baseInput);
    expect(smsLogQueried).toBe(false);
    expect(state.hasInboundHistory).toBe(false);
    expect(state.prefs).toEqual({ sms_enabled: true });
  });

  test('lead audience → the inbound-history query never runs (evidence not required)', async () => {
    mockDb({ customer: null, inboundThrows: true });
    const state = await loadContactState({ ...baseInput, customerId: undefined, audience: 'lead' });
    expect(smsLogQueried).toBe(false);
    expect(state.hasInboundHistory).toBe(false);
    expect(state.lookupFailed).toBe(false);
  });

  test('non-conversational purpose → the inbound-history query never runs', async () => {
    mockDb({ customer: { id: 'c1', phone: '+19415550100' }, inboundThrows: true });
    const state = await loadContactState({ ...baseInput, purpose: 'billing' });
    expect(smsLogQueried).toBe(false);
    expect(state.hasInboundHistory).toBe(false);
  });

  test('inbound-history query error → lookupFailed true (retryable, not a definitive denial)', async () => {
    mockDb({ customer: { id: 'c1', phone: '+19415550100' }, inboundThrows: true });
    const state = await loadContactState(baseInput);
    expect(state.hasInboundHistory).toBe(false);
    expect(state.lookupFailed).toBe(true);
  });

  test('formatted phones are queried in BOTH raw and canonical E.164 forms', async () => {
    mockDb({ customer: { id: 'c1', phone: '+44 20 7946 0958' }, inboundRow: { id: 's1' } });
    await loadContactState({ ...baseInput, to: '(941) 555-0100' });
    expect(smsLogPhones).toEqual(expect.arrayContaining([
      '(941) 555-0100', '+19415550100',
      '+44 20 7946 0958', '+442079460958',
    ]));
  });
});

describe('loadSuppressionState — transient failure is UNKNOWN state, not empty', () => {
  const db = require('../models/db');
  const { loadSuppressionState } = require('../services/messaging/validators/suppression');

  test('transient lookup error stamps suppressionLookupFailed on contactState', async () => {
    db.mockImplementation(() => ({
      where: () => ({ first: async () => { throw new Error('connection terminated'); } }),
    }));
    const state = await loadSuppressionState({ to: '+19415550100' }, { prefs: null });
    expect(state.suppressionLookupFailed).toBe(true);
    expect(state.suppression).toBeUndefined();
  });

  test('missing-table error keeps failing open without the flag (migration-not-applied path)', async () => {
    db.mockImplementation(() => ({
      where: () => ({ first: async () => { throw new Error('relation "messaging_suppression" does not exist'); } }),
    }));
    const state = await loadSuppressionState({ to: '+19415550100' }, { prefs: null });
    expect(state.suppressionLookupFailed).toBeUndefined();
  });

  test('42P01 error code fails open without the flag even with a nonstandard message', async () => {
    const err = new Error('some driver wording');
    err.code = '42P01';
    db.mockImplementation(() => ({
      where: () => ({ first: async () => { throw err; } }),
    }));
    const state = await loadSuppressionState({ to: '+19415550100' }, { prefs: null });
    expect(state.suppressionLookupFailed).toBeUndefined();
  });

  test('an error merely MENTIONING the table (permission denied) still stamps the flag', async () => {
    db.mockImplementation(() => ({
      where: () => ({ first: async () => { throw new Error('permission denied for table messaging_suppression'); } }),
    }));
    const state = await loadSuppressionState({ to: '+19415550100' }, { prefs: null });
    expect(state.suppressionLookupFailed).toBe(true);
  });

  test('successful lookup with an active row still lands on contactState.suppression', async () => {
    const row = { phone: '+19415550100', reason: 'opt_out_keyword', active: true };
    db.mockImplementation(() => ({
      where: () => ({ first: async () => row }),
    }));
    const state = await loadSuppressionState({ to: '+19415550100' }, { prefs: null });
    expect(state.suppression).toEqual(row);
    expect(state.suppressionLookupFailed).toBeUndefined();
  });
});
