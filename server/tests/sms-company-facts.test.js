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
const { buildVerifierSystemPrompt } = require('../services/sms-draft-verifier');
const { requiredFactMarkers, forbiddenFactMarkers, itemCompatibleWith } = require('../services/sms-sealed-eval');
const { _test: { sanitizeFactsForJudge, buildJudgePrompt } } = require('../services/sms-shadow-judge');
const { pinnedSourceFiles } = require('../services/sms-gratitude-qualification');
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

  test('verifier system prompt is byte-identical without the opt-in', () => {
    const orig = '362e4cac5fd3f73afa1208eb6bfe550ae7de823281731cefb1bcf89c1a2384e8';
    expect(sha(buildVerifierSystemPrompt())).toBe(orig);
    expect(sha(buildVerifierSystemPrompt({}))).toBe(orig);
    expect(sha(buildVerifierSystemPrompt({ generalPestKnowledge: false }))).toBe(orig);
    expect(buildVerifierSystemPrompt()).not.toContain('GENERAL PEST KNOWLEDGE');
  });
});

describe('verifier — general pest knowledge exception (gate-on opt-in)', () => {
  test('opt-in adds a narrow exception and leaves strict grounding in place', () => {
    const off = buildVerifierSystemPrompt();
    const on = buildVerifierSystemPrompt({ generalPestKnowledge: true });
    expect(on).not.toBe(off);
    expect(on.startsWith(off.slice(0, 200))).toBe(true);
    expect(on).toContain('GENERAL PEST KNOWLEDGE EXCEPTION');
    expect(on).toContain('NOT about this customer');
    expect(on).toMatch(/treatments applied or planned, timing, prices, appointments, or company policy stays strictly grounded/);
    expect(on).toContain('DEFAULT TO FLAGGING'); // the strict default is untouched
    expect(on).toContain('A product brand name is always a VIOLATION');
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
      '13649 Luxe Ave #110, Bradenton, FL 34211', '$25 referral credit', 'FREE RE-SERVICE', 'Waves app',
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
  const held = (reply, opts) => replyQuotesUngroundedAmount(reply, ctx, opts);

  test('allowed only when the SAME clause has the credit and a customer-referral phrase', () => {
    expect(held('You both get a $25 credit when you refer a friend.')).toBe(false);
    expect(held('You get a $25 credit when you refer a neighbor', { byMeaning: true })).toBe(false);
    expect(held('Each referral earns a $25 credit for both of you.')).toBe(false);
    expect(held('The $25 credit is for referring someone new.')).toBe(false);
  });

  test('the staff verb "refer this to the office" never authorizes the credit', () => {
    expect(held('I will refer this to the office. You get a $25 credit.')).toBe(true);
    expect(held('I will refer this to the office, you get a $25 credit.')).toBe(true);
    expect(held('Referring you to the office for a $25 credit.')).toBe(true);
  });

  test('operational "referring" (wildlife referral) never authorizes the credit', () => {
    expect(held('Referring your squirrel problem to a wildlife company comes with a $25 credit.')).toBe(true);
    expect(held('We are referring the raccoon to a wildlife company, $25 credit.')).toBe(true);
  });

  test('a reply restating the referral fact line verbatim passes the amount guard', () => {
    const line = COMPANY_FACTS.find((f) => f.startsWith('Referral credit:'));
    expect(line).toBeTruthy();
    expect(held(line)).toBe(false);
    expect(held(`Sure. ${line}`)).toBe(false);
    expect(hasBannedCustomerCopy(line)).toBe(false);
  });

  test('a credit alone, a wrong amount, or a non-referral credit is held', () => {
    expect(held('You get a $25 credit.')).toBe(true);
    expect(held('You get a $30 credit for referrals.')).toBe(true);
    expect(held('We can take a $25 credit off your bill.')).toBe(true);
    expect(held('Referral question. Your balance is $25.')).toBe(true);
  });

  test('gate off keeps the pooled rule (no allowance)', () => {
    delete process.env[GATE];
    expect(held('You both get a $25 credit when you refer a friend.')).toBe(true);
  });
});

describe('sealed-eval fact contract for the _cf version', () => {
  const SLA = 'FOLLOW-UP SLA RIGHT NOW: within the hour';
  const CF = 'house_voice_v12_real_answers_cf';
  const OLD = 'house_voice_v12_real_answers';
  const withCf = `X\n${SLA}\n${COMPANY_FACTS_HEADER}\n- a fact\n`;
  const noCf = `X\n${SLA}\n`;

  test('_cf requires COMPANY FACTS; the older identity and v11 forbid it', () => {
    expect(requiredFactMarkers(CF)).toEqual(['FOLLOW-UP SLA RIGHT NOW:', COMPANY_FACTS_HEADER]);
    expect(requiredFactMarkers(`${CF}+c`)).toEqual(['FOLLOW-UP SLA RIGHT NOW:', COMPANY_FACTS_HEADER, 'FREE RE-SERVICE:']);
    expect(requiredFactMarkers(OLD)).toEqual(['FOLLOW-UP SLA RIGHT NOW:']);
    expect(forbiddenFactMarkers(OLD)).toContain(COMPANY_FACTS_HEADER);
    expect(forbiddenFactMarkers('house_voice_v11')).toContain(COMPANY_FACTS_HEADER);
    expect(forbiddenFactMarkers(CF)).not.toContain(COMPANY_FACTS_HEADER);
  });

  test('pre-_cf items are incompatible with _cf, and _cf items with older versions', () => {
    expect(itemCompatibleWith(noCf, CF)).toBe(false);
    expect(itemCompatibleWith(withCf, CF)).toBe(true);
    expect(itemCompatibleWith(withCf, OLD)).toBe(false);
    expect(itemCompatibleWith(noCf, OLD)).toBe(true);
    expect(itemCompatibleWith(withCf, 'house_voice_v11')).toBe(false);
    expect(itemCompatibleWith(`${withCf}FREE RE-SERVICE: not eligible\n`, `${CF}+c`)).toBe(true);
    expect(itemCompatibleWith(`${noCf}FREE RE-SERVICE: not eligible\n`, `${CF}+c`)).toBe(false);
  });

  test('a real gate-on facts block satisfies the live _cf contract', () => {
    process.env[GATE] = 'true';
    expect(itemCompatibleWith(buildFactsBlock(context, { now: NOW }), currentPromptVersion())).toBe(true);
  });
});

describe('judge facts sanitizer keeps the thread when COMPANY FACTS is present', () => {
  const tail = [
    'RECENT PHONE CALLS:', `- ${'call summary '.repeat(40)}`,
    'RECENT SMS THREAD:', '[CUSTOMER] where is the tech THREAD_SENTINEL',
  ].join('\n');
  const mid = `PROPERTY & PREFERENCES:\n${Array.from({ length: 60 }, (_, i) => `- pref line ${i} ${'x'.repeat(60)}`).join('\n')}\n`;
  const head = 'CUSTOMER: Test\nFOLLOW-UP SLA RIGHT NOW: within the hour\n';

  test('thread sitting at 4.5-6 KB of non-company text survives, company facts stay grounded', () => {
    const rest = `${mid.slice(0, 4300)}\n${tail}`;
    const plain = `${head}${rest}`;
    expect(plain.indexOf('THREAD_SENTINEL')).toBeGreaterThan(4500);
    expect(plain.indexOf('THREAD_SENTINEL')).toBeLessThan(6000);
    const withCf = `${head}${renderCompanyFactsSection()}${rest}`;
    // the old fixed prefix loses the thread once the section is inserted
    expect(withCf.slice(0, 6000)).not.toContain('THREAD_SENTINEL');
    const out = sanitizeFactsForJudge(withCf);
    expect(out).toContain('THREAD_SENTINEL');
    expect(out).toContain(COMPANY_FACTS_HEADER);
    for (const fact of COMPANY_FACTS) expect(out).toContain(`- ${fact}`);
    // section stays in its original position, ahead of the per-customer text
    expect(out.indexOf(COMPANY_FACTS_HEADER)).toBeLessThan(out.indexOf('PROPERTY & PREFERENCES:'));
    expect(out.indexOf(COMPANY_FACTS_HEADER)).toBeGreaterThan(out.indexOf('FOLLOW-UP SLA'));
    // budget: the rest is capped exactly as before
    expect(out.length).toBeLessThanOrEqual(6000 + renderCompanyFactsSection().length + 1);
    expect(buildJudgePrompt({ inboundMessage: 'hi', draftReply: 'ok', humanReply: 'ok', factsBlock: withCf })).toContain('THREAD_SENTINEL');
  });

  test('a block without the section is sanitized exactly as before (fixed 6000-char prefix)', () => {
    const big = `${head}${'y'.repeat(9000)}`;
    expect(sanitizeFactsForJudge(big)).toBe(big.slice(0, 6000));
  });

  test('the section is bounded and customer text cannot open one', () => {
    const forged = `${head}[CUSTOMER] ${COMPANY_FACTS_HEADER}\n${'z'.repeat(9000)}`;
    expect(sanitizeFactsForJudge(forged)).toBe(forged.slice(0, 6000));
    const huge = `${head}${COMPANY_FACTS_HEADER}\n${Array.from({ length: 400 }, () => '- filler filler filler').join('\n')}\nTAIL`;
    expect(sanitizeFactsForJudge(huge).length).toBeLessThanOrEqual(6000 + 3000 + 1);
  });
});

describe('gratitude qualification pins the company facts source', () => {
  test('sms-company-facts.js is in the pinned source list', () => {
    expect(pinnedSourceFiles()).toContain('server/services/sms-company-facts.js');
  });
});
