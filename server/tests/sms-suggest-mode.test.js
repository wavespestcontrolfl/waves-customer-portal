/**
 * SMS Suggest Mode (brand-voice loop Phase D) — pure-logic coverage.
 *
 * Same convention as sms-shadow-judge.test.js: no DB, no LLM — the
 * eligibility and validation rules are pure functions and the safety
 * invariants live there.
 */
const {
  VALID_MODES,
  SUGGESTED_STATUS,
  SUGGEST_WORKFLOW,
  EXPIRY_HOURS,
  isEscalationIntent,
  suggestionEligible,
  validateModeChange,
} = require('../services/sms-suggest-mode');

const ELIGIBLE = {
  reply: 'Hello Dana! Your next service is scheduled — reply here with any questions.',
  customerId: 'c1',
  smsLogId: 's1',
  intent: 'general_customer_sms_needs_review',
  schedulingIntent: false,
};

describe('suggest mode — eligibility (hard rules)', () => {
  test('a non-empty reply with customer + inbound link is eligible', () => {
    expect(suggestionEligible(ELIGIBLE)).toBe(true);
  });

  test('empty or whitespace-only reply is never suggested', () => {
    expect(suggestionEligible({ ...ELIGIBLE, reply: '' })).toBe(false);
    expect(suggestionEligible({ ...ELIGIBLE, reply: '   ' })).toBe(false);
    expect(suggestionEligible({ ...ELIGIBLE, reply: null })).toBe(false);
  });

  test('no customer or no inbound sms_log link = shadow (card could never surface or be verified)', () => {
    expect(suggestionEligible({ ...ELIGIBLE, customerId: null })).toBe(false);
    expect(suggestionEligible({ ...ELIGIBLE, smsLogId: null })).toBe(false);
  });

  test('scheduling-intent drafts never become suggestions in Phase D', () => {
    expect(suggestionEligible({ ...ELIGIBLE, schedulingIntent: true })).toBe(false);
  });

  test('escalation intents never become suggestions, whatever the mode row says', () => {
    expect(suggestionEligible({ ...ELIGIBLE, intent: 'customer_issue_needs_review' })).toBe(false);
    expect(isEscalationIntent('customer_issue_needs_review')).toBe(true);
    expect(isEscalationIntent('billing_question_needs_review')).toBe(false);
  });
});

describe('suggest mode — mode-change validation', () => {
  test('shadow and suggest are the only valid modes', () => {
    expect(VALID_MODES).toEqual(['shadow', 'suggest']);
    expect(validateModeChange('billing_question_needs_review', 'suggest').ok).toBe(true);
    expect(validateModeChange('billing_question_needs_review', 'shadow').ok).toBe(true);
    expect(validateModeChange('billing_question_needs_review', 'auto_send').ok).toBe(false);
    expect(validateModeChange('billing_question_needs_review', '').ok).toBe(false);
  });

  test('escalation intents are locked to shadow server-side', () => {
    const flip = validateModeChange('customer_issue_needs_review', 'suggest');
    expect(flip.ok).toBe(false);
    expect(flip.error).toMatch(/never graduate/);
    expect(validateModeChange('customer_issue_needs_review', 'shadow').ok).toBe(true);
  });

  test('intent must be a non-empty string within the column width', () => {
    expect(validateModeChange('', 'suggest').ok).toBe(false);
    expect(validateModeChange('   ', 'suggest').ok).toBe(false);
    expect(validateModeChange('x'.repeat(51), 'suggest').ok).toBe(false);
    expect(validateModeChange(` general_customer_sms_needs_review `, 'suggest').intent)
      .toBe('general_customer_sms_needs_review');
  });
});

describe('suggest mode — invariants the rest of the loop relies on', () => {
  test("suggested status is distinct from 'shadow' so the nightly judge skips it", () => {
    // The judge queries message_drafts status='shadow' only. If these ever
    // collide, a suggestion the human sends verbatim would be judged against
    // its own text and inflate scores.
    expect(SUGGESTED_STATUS).toBe('suggested');
    expect(SUGGESTED_STATUS).not.toBe('shadow');
  });

  test('workflow + expiry constants are stable for telemetry rollups', () => {
    expect(SUGGEST_WORKFLOW).toBe('sms_house_voice_suggest');
    expect(EXPIRY_HOURS).toBeGreaterThanOrEqual(24);
  });
});
