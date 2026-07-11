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
  hasRedactionPlaceholder,
  hasPriceQuote,
  suggestionEligible,
  validateModeChange,
  splitPendingSuggestions,
  classifySendVerdict,
} = require('../services/sms-suggest-mode');

describe('hasRedactionPlaceholder — never deliver a copied corpus placeholder', () => {
  test('detects every redaction token the corpus redactors emit', () => {
    for (const tok of ['name', 'phone', 'email', 'ssn', 'card', 'address', 'url', 'zip']) {
      expect(hasRedactionPlaceholder(`Hello [${tok}]! Thanks for reaching out.`)).toBe(true);
    }
    expect(hasRedactionPlaceholder('Hi [Name], welcome')).toBe(true); // case-insensitive
  });

  test('a clean reply (no placeholder) passes', () => {
    expect(hasRedactionPlaceholder('Hello Dana! Your next service is Tuesday.')).toBe(false);
    expect(hasRedactionPlaceholder('')).toBe(false);
    expect(hasRedactionPlaceholder(null)).toBe(false);
    expect(hasRedactionPlaceholder('See item [1] on your invoice')).toBe(false); // unrelated brackets
  });
});

describe('hasPriceQuote — house rule: no prices in customer SMS', () => {
  test('detects dollar-sign amounts in every shape the drafter has invented', () => {
    expect(hasPriceQuote('Your total is $415.75.')).toBe(true); // the live judge catch
    expect(hasPriceQuote('That service runs $99')).toBe(true);
    expect(hasPriceQuote('roughly $ 1,200.50 for the year')).toBe(true);
    expect(hasPriceQuote('USD 50 per visit')).toBe(true);
  });

  test('detects spelled-out and singular amounts (Codex P2 ×2: word-form + singular)', () => {
    expect(hasPriceQuote('about 50 dollars per month')).toBe(true);
    expect(hasPriceQuote('should be 2 bucks')).toBe(true);
    expect(hasPriceQuote('that is four hundred dollars')).toBe(true);
    expect(hasPriceQuote('roughly a hundred bucks per visit')).toBe(true);
    expect(hasPriceQuote('we can apply a 50 dollar credit')).toBe(true);
    expect(hasPriceQuote('there is a 1 dollar fee')).toBe(true);
    expect(hasPriceQuote('forty-five dollars even')).toBe(true);
  });

  test('detects per-cadence rates and Spanish currency (ask-waves parity)', () => {
    expect(hasPriceQuote('the plan runs 45/mo')).toBe(true);
    expect(hasPriceQuote('forty five per visit')).toBe(true);
    expect(hasPriceQuote('cuesta 45 dólares')).toBe(true);
    expect(hasPriceQuote('son 45 al mes')).toBe(true);
  });

  test('detects reversed USD, hyphenated, contextual bare, and Spanish-hundreds forms (Codex P1)', () => {
    expect(hasPriceQuote('that will be 45 USD')).toBe(true);
    expect(hasPriceQuote('we can apply a 50-dollar credit')).toBe(true);
    expect(hasPriceQuote('The total comes to 415.75')).toBe(true);
    expect(hasPriceQuote('serían doscientos dólares')).toBe(true);
  });

  test('detects whole-dollar amounts around strong price words, both directions (Codex P1 r3)', () => {
    expect(hasPriceQuote('The price is 415')).toBe(true);
    expect(hasPriceQuote('The estimate is 415.75')).toBe(true);
    expect(hasPriceQuote('415.75 is the total')).toBe(true);
  });

  test('price-free replies pass, including numbers that are not money', () => {
    expect(hasPriceQuote('Your next service is Tuesday between 1:00 PM and 3:00 PM.')).toBe(false);
    expect(hasPriceQuote('We treated 2 ant mounds near the lanai.')).toBe(false);
    expect(hasPriceQuote('Invoice #04395 was emailed to you.')).toBe(false);
    expect(hasPriceQuote('')).toBe(false);
    expect(hasPriceQuote(null)).toBe(false);
  });
});

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
  test('the ladder is shadow → suggest → auto_send (Phase E adds the top rung)', () => {
    expect(VALID_MODES).toEqual(['shadow', 'suggest', 'auto_send']);
    expect(validateModeChange('billing_question_needs_review', 'suggest').ok).toBe(true);
    expect(validateModeChange('billing_question_needs_review', 'shadow').ok).toBe(true);
    // auto_send is now a syntactically valid flip for a normal intent — the
    // DATA-earned gate lives in graduation.evaluateAutoSendEligibility (the
    // PUT /intent-modes route + the executor enforce it), not in this pure
    // shape validator.
    expect(validateModeChange('billing_question_needs_review', 'auto_send').ok).toBe(true);
    expect(validateModeChange('billing_question_needs_review', 'unknown_mode').ok).toBe(false);
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

describe('suggest mode — out-of-order publish protection (Codex P1)', () => {
  // Drafting is fire-and-forget from the webhook: an OLDER inbound's draft
  // can finish AFTER a newer one already published its card.
  const at = (mins) => new Date(Date.UTC(2026, 5, 12, 9, mins)).toISOString();

  test('a pending suggestion for a newer inbound blocks the publish entirely', () => {
    const pending = [{ id: 'newer', entity_id: 'd2', inbound_at: at(5) }];
    const { newerExists, supersede } = splitPendingSuggestions(pending, at(0));
    expect(newerExists).toBe(true);
    expect(supersede).toEqual([]);
  });

  test('older pending suggestions are superseded — newest inbound wins', () => {
    const pending = [
      { id: 'old1', entity_id: 'd1', inbound_at: at(0) },
      { id: 'old2', entity_id: 'd2', inbound_at: at(2) },
    ];
    const { newerExists, supersede } = splitPendingSuggestions(pending, at(5));
    expect(newerExists).toBe(false);
    expect(supersede.map((r) => r.id)).toEqual(['old1', 'old2']);
  });

  test('one newer row poisons the batch — nothing is superseded out from under it', () => {
    const pending = [
      { id: 'old', entity_id: 'd1', inbound_at: at(0) },
      { id: 'newer', entity_id: 'd2', inbound_at: at(9) },
    ];
    const { newerExists, supersede } = splitPendingSuggestions(pending, at(5));
    expect(newerExists).toBe(true);
    expect(supersede).toEqual([]);
  });

  test('unparseable anchor timestamp fails closed (no publish)', () => {
    expect(splitPendingSuggestions([], 'not-a-date').newerExists).toBe(true);
    expect(splitPendingSuggestions([], null).newerExists).toBe(true);
  });

  test('pending rows with no inbound link count as older, not newer', () => {
    const pending = [{ id: 'orphan', entity_id: 'd1', inbound_at: null }];
    const { newerExists, supersede } = splitPendingSuggestions(pending, at(5));
    expect(newerExists).toBe(false);
    expect(supersede.map((r) => r.id)).toEqual(['orphan']);
  });
});

describe('suggest mode — scheduled-send verdict (Codex P1)', () => {
  test('verbatim send = accepted; whitespace differences do not count as edits', () => {
    expect(classifySendVerdict('Hello Dana! See you Tuesday.', 'Hello Dana! See you Tuesday.')).toBe('accepted');
    expect(classifySendVerdict('  Hello Dana!\n See  you Tuesday. ', 'Hello Dana! See you Tuesday.')).toBe('accepted');
  });

  test('any wording change = corrected', () => {
    expect(classifySendVerdict('Hello Dana! See you Wednesday.', 'Hello Dana! See you Tuesday.')).toBe('corrected');
    expect(classifySendVerdict('', 'Hello Dana!')).toBe('corrected');
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
