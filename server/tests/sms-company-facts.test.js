/**
 * COMPANY FACTS (owner rulings 2026-09-29/30) — GATE_SMS_REAL_ANSWERS only.
 * Gate off: facts block + prompts byte-identical to before (hashes captured
 * from origin/main 8781b3f1c5). Gate on: COMPANY FACTS section, prompt rules,
 * new prompt version, and the referral-credit amount allowance.
 */
const crypto = require('crypto');
const {
  buildSystemPrompt,
  buildSystemPromptWithProfile,
  buildFactsBlock,
  currentPromptVersion,
  hasBannedCustomerCopy,
  replyQuotesUngroundedAmount,
  PROMPT_VERSION,
  REAL_ANSWERS_PROMPT_VERSION,
  REAL_ANSWERS_HANDOFF_CATEGORIES,
} = require('../services/sms-shadow-drafter');
const {
  COMPANY_FACTS,
  COMPANY_FACTS_HEADER,
  renderCompanyFactsSection,
} = require('../services/sms-company-facts');

const GATE = 'GATE_SMS_REAL_ANSWERS';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const context = { summary: 'Test customer', upcomingServices: [{ type: 'Quarterly Pest', date: '2026-06-19', window: '8-10am' }] };
const NOW = new Date('2026-06-10T15:00:00Z');

afterEach(() => {
  delete process.env[GATE];
  for (const c of REAL_ANSWERS_HANDOFF_CATEGORIES) delete process.env[c.gate];
});

describe('gate off — byte-identical to before COMPANY FACTS', () => {
  test('facts block and both prompts match the pre-change output', () => {
    delete process.env[GATE];
    const facts = buildFactsBlock(context, { now: NOW });
    expect(facts).not.toContain('COMPANY FACTS');
    expect(sha(facts)).toBe('22a25c57a1ad7b96988e31271d69857da001734822b6cceb7f03097f12709034');
    expect(sha(buildSystemPrompt())).toBe('8fc58d9bcd7cdf437f7f6d49290a01c375c696f31f346a2db121ed59e98da0f3');
    expect(sha(buildSystemPromptWithProfile('Warm and brief.').system)).toBe('7e35da9035dd011a3f0b6ab8596b9876926956fbaf1ca05139d59f4ef8248a9b');
    expect(buildSystemPrompt()).not.toContain('COMPANY FACTS');
    expect(currentPromptVersion()).toBe(PROMPT_VERSION);
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('facts block carries the COMPANY FACTS section with every fact', () => {
    const facts = buildFactsBlock(context, { now: NOW });
    expect(facts).toContain(COMPANY_FACTS_HEADER);
    expect(facts).toContain(renderCompanyFactsSection());
    for (const fact of COMPANY_FACTS) expect(facts).toContain(`- ${fact}`);
    expect(facts.indexOf(COMPANY_FACTS_HEADER)).toBeLessThan(facts.indexOf('BILLING:'));
    expect(facts.indexOf('FOLLOW-UP SLA RIGHT NOW:')).toBeLessThan(facts.indexOf(COMPANY_FACTS_HEADER));
  });

  test('each owner ruling is present', () => {
    const all = COMPANY_FACTS.join('\n');
    for (const needle of [
      'interior spray', 'lanai and the pool cage', 'mud daubers', 'honeybees', 'rodent trapping only',
      'Sundays and holidays', 'dry and bond', 'No mowing', 'watering days', 'never cash',
      '13649 Luxe Ave #110, Bradenton, FL 34211', '$25 credit', 'FREE RE-SERVICE', 'Waves app',
    ]) expect(all).toContain(needle);
  });

  test('system prompt allows general pest knowledge and makes COMPANY FACTS authoritative', () => {
    const { system, realAnswersApplied } = buildSystemPromptWithProfile();
    expect(realAnswersApplied).toBe(true);
    expect(system).toContain('GENERAL PEST KNOWLEDGE & COMPANY FACTS:');
    expect(system).toContain('you MAY answer from general pest knowledge');
    expect(system).toContain('Never name a product brand');
    expect(system).toContain('COMPANY FACTS section in the context block is owner-approved and authoritative');
    expect(system).toContain('LATEST CALL TRANSCRIPT, COMPANY FACTS, the thread');
  });

  test('prompt version is bumped, distinguishable, and fits the column', () => {
    expect(REAL_ANSWERS_PROMPT_VERSION).toBe('house_voice_v12_real_answers_cf');
    expect(currentPromptVersion()).toBe('house_voice_v12_real_answers_cf');
    expect(currentPromptVersion()).not.toBe('house_voice_v12_real_answers');
    for (const c of REAL_ANSWERS_HANDOFF_CATEGORIES) process.env[c.gate] = 'true';
    const all = currentPromptVersion();
    expect(all.startsWith('house_voice_v12')).toBe(true);
    expect(all.startsWith(`${REAL_ANSWERS_PROMPT_VERSION}+`)).toBe(true);
    expect(all.length).toBeLessThanOrEqual(40);
  });
});

describe('fact lines pass the drafter\'s own compliance screens', () => {
  test.each(COMPANY_FACTS.map((f) => [f]))('%s', (fact) => {
    expect(hasBannedCustomerCopy(fact)).toBe(false);
  });
  test('the whole rendered section too', () => {
    expect(hasBannedCustomerCopy(renderCompanyFactsSection())).toBe(false);
  });
  test('plain restatements of the facts are not banned copy', () => {
    for (const reply of [
      'Yes, we work Sundays and holidays, same as any other day.',
      'Rain is fine once the treatment has dried and bonded to surfaces; after that it holds up to weather.',
      'Techs take cards at the visit, never cash. You can mail a check to Waves Pest Control, 13649 Luxe Ave #110, Bradenton, FL 34211.',
      'You and the friend you refer each get a $25 credit.',
    ]) expect(hasBannedCustomerCopy(reply)).toBe(false);
  });
});

describe('referral credit amount', () => {
  const ctx = { billing: { outstandingBalance: 0, recentPayments: [] } };
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('the $25 referral credit is not held as an ungrounded amount', () => {
    expect(replyQuotesUngroundedAmount('Refer a friend and you both get a $25 credit!', ctx)).toBe(false);
    expect(replyQuotesUngroundedAmount('Referrals earn you and the new customer a $25 credit each.', ctx, { byMeaning: true })).toBe(false);
  });

  test('other figures and non-referral credits are still held', () => {
    expect(replyQuotesUngroundedAmount('Refer a friend and you both get a $30 credit!', ctx)).toBe(true);
    expect(replyQuotesUngroundedAmount('We can take a $25 credit off your bill.', ctx)).toBe(true);
    expect(replyQuotesUngroundedAmount('Refer a friend. Your balance is $25.', ctx)).toBe(true);
  });

  test('gate off keeps the pooled rule (no allowance)', () => {
    delete process.env[GATE];
    expect(replyQuotesUngroundedAmount('Refer a friend and you both get a $25 credit!', ctx)).toBe(true);
  });
});
