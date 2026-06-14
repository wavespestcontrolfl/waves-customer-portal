/**
 * SMS Auto-Send Executor (brand-voice loop Phase E) — pure-logic coverage.
 *
 * Same convention as sms-suggest-mode.test.js / sms-graduation.test.js: no DB,
 * no LLM, no provider. The send path is DB/Twilio-bound and covered by the
 * guard-gauntlet it shares with the (already-tested) suggest publish; what
 * lives HERE are the safety invariants that gate an autonomous customer send —
 * the precondition ordering, the escalation lock, and the message_type /
 * status separations the recovery + guard logic depend on.
 */
const autoSend = require('../services/sms-auto-send');
const {
  VALID_MODES,
  AUTO_SEND_MODE,
  HUMAN_REPLY_TYPES,
  validateModeChange,
} = require('../services/sms-suggest-mode');
const graduation = require('../services/sms-graduation');

const { autoSendPreflight, AUTOSEND_MODE, AUTOSEND_MESSAGE_TYPE, CLAIM_STATUS, SENT_STATUS, FAILED_STATUS } = autoSend;

const CLEAR = { gateOn: true, baseEligible: true, mode: AUTOSEND_MODE, eligible: true };

describe('autoSendPreflight — precondition ordering (the gate to an autonomous send)', () => {
  test('all preconditions clear → no stop reason', () => {
    expect(autoSendPreflight(CLEAR)).toBeNull();
  });

  test('gate off stops first, before anything else is even consulted', () => {
    expect(autoSendPreflight({ ...CLEAR, gateOn: false })).toBe('gate_off');
    // gate wins even when every other signal is also bad
    expect(autoSendPreflight({ gateOn: false, baseEligible: false, mode: 'shadow', eligible: false })).toBe('gate_off');
  });

  test('base ineligibility stops before mode + eligibility', () => {
    expect(autoSendPreflight({ ...CLEAR, baseEligible: false })).toBe('ineligible_base');
    expect(autoSendPreflight({ gateOn: true, baseEligible: false, mode: 'shadow', eligible: false })).toBe('ineligible_base');
  });

  test('mode must be auto_send', () => {
    expect(autoSendPreflight({ ...CLEAR, mode: 'shadow' })).toBe('mode_not_autosend');
    expect(autoSendPreflight({ ...CLEAR, mode: 'suggest' })).toBe('mode_not_autosend');
  });

  test('graduation eligibility is the last gate', () => {
    expect(autoSendPreflight({ ...CLEAR, eligible: false })).toBe('not_eligible');
  });

  test('the contract is fail-closed: a missing field never reads as "proceed"', () => {
    expect(autoSendPreflight({})).toBe('gate_off');
    expect(autoSendPreflight({ gateOn: true })).toBe('ineligible_base');
    expect(autoSendPreflight({ gateOn: true, baseEligible: true })).toBe('mode_not_autosend');
    expect(autoSendPreflight({ gateOn: true, baseEligible: true, mode: AUTOSEND_MODE })).toBe('not_eligible');
  });
});

describe('ladder + mode invariants', () => {
  test('auto_send is a valid mode and the executor constant agrees', () => {
    expect(VALID_MODES).toContain('auto_send');
    expect(AUTO_SEND_MODE).toBe('auto_send');
    expect(AUTOSEND_MODE).toBe('auto_send');
  });

  test('a normal intent may be flipped to auto_send', () => {
    const r = validateModeChange('general_customer_sms_needs_review', 'auto_send');
    expect(r.ok).toBe(true);
    expect(r.intent).toBe('general_customer_sms_needs_review');
  });

  test('escalation intents are locked out of auto_send (never graduate)', () => {
    const r = validateModeChange('customer_issue_needs_review', 'auto_send');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/escalation/i);
  });
});

describe('message_type + status separations the safety logic relies on', () => {
  test('an auto-sent outbound is NOT a human reply type', () => {
    // The thread guard-gauntlet asks "did a HUMAN answer?" — if ai_autosent
    // leaked into HUMAN_REPLY_TYPES, an auto-send would suppress the next one.
    expect(HUMAN_REPLY_TYPES).not.toContain(AUTOSEND_MESSAGE_TYPE);
    expect(AUTOSEND_MESSAGE_TYPE).toBe('ai_autosent');
  });

  test('claim / sent / failed are three distinct states', () => {
    expect(new Set([CLAIM_STATUS, SENT_STATUS, FAILED_STATUS]).size).toBe(3);
    expect(CLAIM_STATUS).toBe('sending');
    expect(SENT_STATUS).toBe('auto_sent');
  });
});

describe('server-enforced eligibility — escalation short-circuit (no DB)', () => {
  test('an escalation intent is never auto-send eligible, without touching the DB', async () => {
    const r = await graduation.evaluateAutoSendEligibility({ intent: 'customer_issue_needs_review' });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/escalation/i);
  });
});
