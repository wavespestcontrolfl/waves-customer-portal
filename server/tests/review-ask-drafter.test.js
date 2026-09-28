// Personalized review-ask drafter: verification rules + fallback contract.
// The lane AUTO-SENDS (owner ruling 2026-07-30), so the deterministic verifier
// is the last line between a bad draft and a customer — every rule gets a test.
const mockDispatch = jest.fn();
const mockGates = { reviewAskPersonalized: false };
const mockGetRecentCalls = jest.fn(async () => []);

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...a) => mockDispatch(...a) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: (g) => !!mockGates[g], gates: mockGates }));
jest.mock('../services/context-aggregator', () => {
  const mod = { getRecentCalls: (...a) => mockGetRecentCalls(...a) };
  mod.redactAccessCodes = (s) => s;
  return mod;
});

const db = require('../models/db');
const Drafter = require('../services/review-ask-drafter');

const CUSTOMER = { id: 'cust-1', first_name: 'Aaron', last_name: 'Boss' };
// One-segment budget (owner spec 2026-08-06): pre-render ≤145 chars, and the
// rendered preview (43-char link) must fit a single GSM segment.
const CLEAN_BODY = 'Hi Aaron, Adam here - centipedes backing off? Quick review: {review_url} Reply if anything is off.';

function mockDb(smsRows = []) {
  db.mockImplementation(() => ({
    where() { return this; },
    orderBy() { return this; },
    limit() { return this; },
    async select() { return smsRows; },
  }));
}

beforeEach(() => {
  mockDispatch.mockReset();
  mockGetRecentCalls.mockReset().mockResolvedValue([]);
  mockGates.reviewAskPersonalized = true;
  mockDb();
});

describe('verifyDraftBody — the auto-send safety net', () => {
  const verify = (body) => Drafter.verifyDraftBody(body, { firstName: 'Aaron' });

  test('a clean grounded draft passes', () => {
    expect(verify(CLEAN_BODY)).toBeNull();
  });

  test('rejects empty and over-length bodies', () => {
    expect(verify('')).toBe('empty');
    expect(verify(`Aaron {review_url} ${'x'.repeat(430)}`)).toBe('too_long');
  });

  test('requires the {review_url} placeholder exactly once', () => {
    expect(verify('Hi Aaron, thanks for having us out! Reply here anytime.')).toBe('missing_link');
    expect(verify('Hi Aaron {review_url} and also {review_url}')).toBe('duplicate_link');
  });

  test('rejects emojis', () => {
    expect(verify('Hi Aaron 🎉 review us: {review_url}')).toBe('emoji');
  });

  test('rejects dollar amounts, incentives, and rating coaching', () => {
    expect(verify('Hi Aaron, your $209 service: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, leave a review for a free treatment: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, give us 5 stars: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, we guarantee results: {review_url}')).toBe('banned_phrase');
  });

  test('rejects every incentive flavor, not just "free" (Google policy)', () => {
    expect(verify("Hi Aaron, leave a review and we'll send a gift card: {review_url}")).toBe('banned_phrase');
    expect(verify('Hi Aaron, review us for a reward: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, a review earns account credit: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, complimentary treatment for a review: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, review us in exchange for goodies: {review_url}')).toBe('banned_phrase');
  });

  test('rejects fixed drying / re-entry time claims (site-compliance)', () => {
    expect(verify('Hi Aaron, hope everything dried well: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, you can re-enter anytime: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, all set after 30 minutes: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, wait 2 hours then enjoy the yard: {review_url}')).toBe('banned_phrase');
  });

  test('rejects any raw URL beyond the {review_url} placeholder', () => {
    expect(verify('Hi Aaron, see https://example.com and {review_url}')).toBe('raw_url');
    expect(verify('Hi Aaron, visit www.wavespest.com or {review_url}')).toBe('raw_url');
    expect(verify('Hi Aaron, check wavespestcontrol.com then {review_url}')).toBe('raw_url');
  });

  test('rejects a rendered body over the 1-segment cadence cap (owner spec 2026-08-06)', () => {
    // 130 chars pre-render passes the char ceiling, but with the ~43-char
    // rendered link it exceeds one GSM segment (160 chars) — reject.
    const filler = 'We really appreciate you welcoming our crew and trusting the process. '.repeat(2);
    const body = `Hi Aaron, ${filler.slice(0, 107)} {review_url}`;
    expect(body.length).toBeLessThanOrEqual(145);
    expect(verify(body)).toBe('too_many_segments');
  });

  test('rejects site-compliance language (safe / non-toxic / EPA)', () => {
    expect(verify('Hi Aaron, our safe treatments: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, non-toxic barrier: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, EPA approved: {review_url}')).toBe('banned_phrase');
  });

  test('"feel free to reply" is NOT an incentive', () => {
    expect(verify('Hi Aaron, feel free to reply here - {review_url}')).toBeNull();
  });

  test('rejects unrendered placeholders other than the link', () => {
    expect(verify('Hi Aaron ({first}), review us: {review_url}')).toBe('stray_placeholder');
  });

  test('requires the customer first name', () => {
    expect(verify('Hey there, quick review? {review_url}')).toBe('missing_name');
  });
});

describe('etCalendarDayOf — pg date-only values stay on their ET calendar day', () => {
  const { etCalendarDayOf, etCalendarDaysBetween } = Drafter.__private;

  test('a YYYY-MM-DD string is taken literally, not shifted through UTC', () => {
    expect(etCalendarDayOf('2026-07-27')).toBe('2026-07-27');
    // Same-day step-0: service date 07-27, drafting at 2 PM ET on 07-27 → 0 days.
    expect(etCalendarDaysBetween('2026-07-27', new Date('2026-07-27T14:00:00-04:00'))).toBe(0);
  });

  test('a pg DATE deserialized as UTC-midnight Date is taken literally', () => {
    const pgDate = new Date('2026-07-27T00:00:00.000Z'); // 8 PM ET on 07-26 as a timestamp
    expect(etCalendarDayOf(pgDate)).toBe('2026-07-27');
    expect(etCalendarDaysBetween(pgDate, new Date('2026-07-27T14:00:00-04:00'))).toBe(0);
  });

  test('a real timestamp still converts through the ET wall clock', () => {
    // 11 PM ET on 07-26 (03:00Z on 07-27) is ET calendar day 07-26.
    expect(etCalendarDayOf(new Date('2026-07-27T03:00:00.000Z'))).toBe('2026-07-26');
  });
});

describe('draftAskBody — gating + fallback contract', () => {
  test('gate off → null, and no model call is made', async () => {
    mockGates.reviewAskPersonalized = false;
    expect(await Drafter.draftAskBody({ customer: CUSTOMER })).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('gate on → grounded draft comes back verified; rules in SYSTEM, history in text, bounded timeout', async () => {
    mockGetRecentCalls.mockResolvedValue([
      { direction: 'inbound', call_summary: 'Aaron called about centipedes and millipedes swarming the front entry.', transcript: 'Caller: they are all over the driveway…' },
    ]);
    mockDb([{ direction: 'outbound', message_body: 'Your estimate is ready', created_at: new Date() }]);
    mockDispatch.mockResolvedValue({ ok: true, text: CLEAN_BODY });

    const body = await Drafter.draftAskBody({
      customer: CUSTOMER,
      recipientFirstName: 'Aaron',
      serviceType: 'Quarterly Pest Control',
      techName: 'Adam',
      sequenceStep: 1,
      serviceDate: new Date(Date.now() - 3 * 86400000),
    });

    expect(body).toBe(CLEAN_BODY);
    const payload = mockDispatch.mock.calls[0][1];
    // Untrusted history rides ONLY the user text; the fixed rules ride system.
    expect(payload.text).toContain('centipedes and millipedes swarming');
    expect(payload.text).toContain('NEWEST CALL TRANSCRIPT');
    expect(payload.text).not.toContain('RULES (all mandatory)');
    expect(payload.system).toContain('follow-up text a few days after service');
    expect(payload.system).toContain('RULES (all mandatory)');
    expect(payload.timeoutMs).toBe(45000);
    // The policy is the two-provider customerCopy lane.
    expect(mockDispatch.mock.calls[0][0]).toBe(require('../config/models').TEXT_POLICIES.customerCopy);
  });

  test('no technician on the visit → the facts block carries no Technician line and never invents a name', async () => {
    mockGetRecentCalls.mockResolvedValue([]);
    mockDb([]);
    mockDispatch.mockResolvedValue({ ok: true, text: CLEAN_BODY });
    await Drafter.draftAskBody({
      customer: CUSTOMER,
      recipientFirstName: 'Aaron',
      serviceType: 'Quarterly Pest Control',
      techName: null,
      sequenceStep: 1,
    });
    const payload = mockDispatch.mock.calls[0][1];
    expect(payload.text).not.toMatch(/Technician:/);
    expect(payload.text).not.toMatch(/\bAdam\b/);
  });

  test('smart punctuation is normalized to GSM before verification', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'Hi Aaron — hope the ants are gone… If so: {review_url}. Anything off, just reply here.' });
    const body = await Drafter.draftAskBody({ customer: CUSTOMER, recipientFirstName: 'Aaron' });
    expect(body).toBe('Hi Aaron - hope the ants are gone... If so: {review_url}. Anything off, just reply here.');
  });

  test('a draft that fails verification falls back to null (template sends instead)', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'Hi Aaron! 🎉 {review_url}' });
    expect(await Drafter.draftAskBody({ customer: CUSTOMER })).toBeNull();
  });

  test('both providers down → null, never a throw', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'unavailable' });
    expect(await Drafter.draftAskBody({ customer: CUSTOMER })).toBeNull();
  });

  test('an unexpected error inside drafting → null, never a throw', async () => {
    mockGetRecentCalls.mockRejectedValue(new Error('pg down'));
    expect(await Drafter.draftAskBody({ customer: CUSTOMER })).toBeNull();
  });
});

describe('verifyEmailIntro — the email opener safety net', () => {
  const verify = (body) => Drafter.verifyEmailIntro(body, { firstName: 'Aaron' });
  const CLEAN_INTRO = 'Hi Aaron, hope the centipedes are finally backing off at the entryway since our visit. If anything still looks off, just reply to this email. Otherwise a quick review would mean a lot to our small crew.';

  test('a clean grounded intro passes', () => {
    expect(verify(CLEAN_INTRO)).toBeNull();
  });

  test('rejects empty and over-length intros', () => {
    expect(verify('')).toBe('empty');
    expect(verify(`Aaron ${'x'.repeat(460)}`)).toBe('too_long');
  });

  test('rejects ANY link or placeholder — the CTA button owns the review link', () => {
    expect(verify('Aaron, review us at https://g.page/waves')).toBe('raw_url');
    expect(verify('Aaron, review us at waves.com')).toBe('raw_url');
    expect(verify('Aaron, click {review_url} below')).toBe('stray_placeholder');
    expect(verify('Aaron, click {{intro_paragraph}} below')).toBe('stray_placeholder');
  });

  test('shares the SMS banned list (incentives, compliance words, star coaching)', () => {
    expect(verify('Aaron, leave a review for a free treatment')).toBe('banned_phrase');
    expect(verify('Aaron, our products are safe for pets')).toBe('banned_phrase');
    expect(verify('Aaron, give us 5 stars')).toBe('banned_phrase');
  });

  test('requires the customer first name and rejects emoji', () => {
    expect(verify('Hope the ants are gone, quick review below?')).toBe('missing_name');
    expect(verify('Aaron, thanks! \u{1F41C}')).toBe('emoji');
  });
});

describe('draftEmailIntro — gating + fallback contract', () => {
  const CLEAN_INTRO = 'Hi Aaron, hope the centipedes are finally backing off at the entryway since our visit. If anything looks off, just reply to this email. Otherwise a quick review would mean a lot to our small crew.';

  test('gate off → null, and no model call is made', async () => {
    mockGates.reviewAskPersonalized = false;
    expect(await Drafter.draftEmailIntro({ customer: CUSTOMER })).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('gate on → verified intro comes back; rules ride SYSTEM, history rides text', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: CLEAN_INTRO });
    const out = await Drafter.draftEmailIntro({ customer: CUSTOMER, recipientFirstName: 'Aaron', serviceType: 'Pest Control', techName: 'Adam' });
    expect(out).toBe(CLEAN_INTRO);
    const args = mockDispatch.mock.calls[0][1];
    expect(args.system).toMatch(/do NOT include any link/i);
    expect(args.text).toMatch(/^CUSTOMER HISTORY/);
    expect(args.timeoutMs).toBeGreaterThan(0);
  });

  test('line breaks in the model output collapse to one paragraph', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'Hi Aaron, thanks for having us out.\n\nA quick review below would mean a lot. Reply here if anything is off.' });
    const out = await Drafter.draftEmailIntro({ customer: CUSTOMER, recipientFirstName: 'Aaron' });
    expect(out).not.toMatch(/\n/);
  });

  test('an intro that fails verification falls back to null (template copy sends)', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'Aaron, here is a free re-treat if you review us' });
    expect(await Drafter.draftEmailIntro({ customer: CUSTOMER, recipientFirstName: 'Aaron' })).toBeNull();
  });

  test('both providers down → null, never a throw', async () => {
    mockDispatch.mockResolvedValue({ ok: false });
    expect(await Drafter.draftEmailIntro({ customer: CUSTOMER })).toBeNull();
  });
});

describe('draftEmailIntro — step-aware instruction (codex #3235 r1)', () => {
  const CLEAN_INTRO = 'Hi Aaron, thanks for having us out. If anything looks off, just reply to this email. Otherwise a quick review would mean a lot to our small crew.';

  test('a Day-0 step (email fallback) is prompted as a right-after-the-visit email, not a follow-up', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: CLEAN_INTRO });
    const today = new Date().toISOString().slice(0, 10);
    await Drafter.draftEmailIntro({ customer: CUSTOMER, recipientFirstName: 'Aaron', sequenceStep: 0, serviceDate: today });
    const system = mockDispatch.mock.calls[0][1].system;
    expect(system).toMatch(/right after the visit/);
    expect(system).not.toMatch(/final follow-up/);
  });

  test('a later step keeps the final-follow-up instruction', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: CLEAN_INTRO });
    await Drafter.draftEmailIntro({ customer: CUSTOMER, recipientFirstName: 'Aaron', sequenceStep: 2 });
    expect(mockDispatch.mock.calls[0][1].system).toMatch(/final follow-up email/);
  });
});

describe('name matching is word-bounded (codex #3235 r7)', () => {
  test('a short name inside another word does not satisfy the name check', () => {
    expect(Drafter.verifyDraftBody('Hi there, all the ants are gone: {review_url}', { firstName: 'Al' })).toBe('missing_name');
    expect(Drafter.verifyEmailIntro('We always appreciate you. Reply if anything is off.', { firstName: 'Al' })).toBe('missing_name');
  });

  test('the name as its own word passes', () => {
    expect(Drafter.verifyDraftBody('Hi Al, ants gone? Quick review: {review_url} Reply if off.', { firstName: 'Al' })).toBeNull();
    expect(Drafter.verifyEmailIntro('Hi Al, thanks for having us out. Reply if anything is off.', { firstName: 'Al' })).toBeNull();
  });
});

describe('hyphenated fixed-time expressions are rejected (codex #3235 r14)', () => {
  test('digit and word-number hyphen forms are banned in both verifiers', () => {
    expect(Drafter.verifyEmailIntro('Hi Aaron, keep pets out for a 30-minute wait. Reply if anything is off.', { firstName: 'Aaron' })).toBe('banned_phrase');
    expect(Drafter.verifyEmailIntro('Hi Aaron, after thirty-minutes you are all set. Reply anytime.', { firstName: 'Aaron' })).toBe('banned_phrase');
    expect(Drafter.verifyDraftBody('Hi Aaron, 30-minute wait then enjoy: {review_url}', { firstName: 'Aaron' })).toBe('banned_phrase');
  });
});

describe('time-unit words are banned outright (codex #3235 r15 — closes the interval enumeration class)', () => {
  test('quarter-hour and any other unit mention rejects', () => {
    expect(Drafter.verifyEmailIntro('Hi Aaron, keep pets inside for a quarter-hour. Reply if anything is off.', { firstName: 'Aaron' })).toBe('banned_phrase');
    expect(Drafter.verifyEmailIntro('Hi Aaron, give it a few hours. Reply anytime.', { firstName: 'Aaron' })).toBe('banned_phrase');
    expect(Drafter.verifyDraftBody('Hi Aaron, back in an hour: {review_url}', { firstName: 'Aaron' })).toBe('banned_phrase');
  });
});

describe('scheme-less URLs detected generically (codex #3235 r16 — closes the TLD enumeration class)', () => {
  test('any dotted host with a path rejects, regardless of TLD', () => {
    expect(Drafter.verifyEmailIntro('Hi Aaron, see example.ai/review for details. Reply anytime.', { firstName: 'Aaron' })).toBe('raw_url');
    expect(Drafter.verifyEmailIntro('Hi Aaron, feedback.xyz/r/123 has it. Reply anytime.', { firstName: 'Aaron' })).toBe('raw_url');
    expect(Drafter.verifyDraftBody('Hi Aaron, maps.app.goo.gl/abc then {review_url}', { firstName: 'Aaron' })).toBe('raw_url');
  });

  test('ordinary prose with abbreviations still passes', () => {
    expect(Drafter.verifyEmailIntro('Hi Aaron, thanks for having us out, e.g. the lanai work. If anything looks off, just reply to this email and we will make it right.', { firstName: 'Aaron' })).toBeNull();
  });
});

describe('deadline and access-instruction frames are banned (codex #3235 r17 — closes the timing-instruction class)', () => {
  test('clock times, until-deadlines, and pet-exclusion frames all reject', () => {
    expect(Drafter.verifyEmailIntro('Hi Aaron, keep pets inside until 3 PM. Reply anytime.', { firstName: 'Aaron' })).toBe('banned_phrase');
    expect(Drafter.verifyEmailIntro('Hi Aaron, wait until tomorrow then all set. Reply anytime.', { firstName: 'Aaron' })).toBe('banned_phrase');
    expect(Drafter.verifyDraftBody('Hi Aaron, stay off the lawn today: {review_url}', { firstName: 'Aaron' })).toBe('banned_phrase');
    expect(Drafter.verifyDraftBody('Hi Aaron, before letting the dogs out check with us: {review_url}', { firstName: 'Aaron' })).toBe('banned_phrase');
  });

  test('mentioning pets warmly (no instruction frame) still passes', () => {
    expect(Drafter.verifyEmailIntro('Hi Aaron, hope the pups are enjoying the yard again. If anything looks off, just reply to this email.', { firstName: 'Aaron' })).toBeNull();
  });
});

describe('till/til variants reject (codex #3235 r18)', () => {
  test('each deadline connective form is banned in both verifiers', () => {
    expect(Drafter.verifyEmailIntro('Hi Aaron, avoid the lawn till tomorrow. Reply anytime.', { firstName: 'Aaron' })).toBe('banned_phrase');
    expect(Drafter.verifyEmailIntro('Hi Aaron, wait til tomorrow. Reply anytime.', { firstName: 'Aaron' })).toBe('banned_phrase');
    expect(Drafter.verifyDraftBody('Hi Aaron, wait until tomorrow: {review_url}', { firstName: 'Aaron' })).toBe('banned_phrase');
  });
});

// GATE_REVIEW_DAY0_CONTEXT: the recurring Day-0 text naming the customer's
// pre-visit topic. The model writes one sentence; code frames it, decides
// whether it may claim the work, and verifies every word that reaches the
// customer.
describe('draftDay0ContextBody — the recurring Day-0 text naming the customer\'s topic', () => {
  const TOPIC = 'ants in the kitchen';
  const today = () => new Date();
  const daysAgo = (n) => new Date(Date.now() - n * 86400000);
  const draft = (sentence, over = {}) => {
    mockDispatch.mockResolvedValue({ ok: true, text: sentence });
    return Drafter.draftDay0ContextBody({ customerId: 'cust-1', recipientFirstName: 'Aaron', topic: TOPIC, completionNotes: null, serviceDate: today(), ...over });
  };

  test('frames the model\'s one sentence with the greeting and the uniform ending, inside one segment', async () => {
    const out = await draft('How are the ants looking since the visit?');
    expect(out).toEqual({
      body: "Hi Aaron! How are the ants looking since the visit? A Google review means a lot: {review_url} Reply if anything's off.",
      mode: 'ask',
    });
    expect(Drafter.verifyDraftBody(out.body, { firstName: 'Aaron' })).toBeNull();
  });

  test('the drafter kill switch (GATE_REVIEW_ASK_PERSONALIZED) off → null, no model call', async () => {
    mockGates.reviewAskPersonalized = false;
    expect(await draft('How are the ants looking?')).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('no first name or no topic → null, no model call', async () => {
    expect(await draft('How are the ants looking?', { recipientFirstName: '' })).toBeNull();
    expect(await draft('How are the ants looking?', { topic: '' })).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('code, not the model, decides whether the work may be claimed: only when the tech\'s notes name the topic', async () => {
    await draft('How are the ants looking?');
    expect(mockDispatch.mock.calls[0][1].system).toMatch(/MODE ask/);
    mockDispatch.mockReset();
    const out = await draft('We treated for the ants today.', { completionNotes: { areasTreated: ['kitchen baseboards'], observations: ['ant trail under the sink'] } });
    expect(mockDispatch.mock.calls[0][1].system).toMatch(/MODE claim/);
    expect(out).toMatchObject({ mode: 'claim' });
  });

  test('the model sees only the topic — never the notes, the history, or the name', async () => {
    await draft('How are the ants looking?', { completionNotes: { observations: ['gate code 4821, ant trail'] } });
    const payload = mockDispatch.mock.calls[0][1];
    expect(payload.text).toContain('ants in the kitchen');
    expect(payload.text).not.toMatch(/4821|trail|Aaron/);
    expect(payload.system).toMatch(/at most \d+ characters/);
  });

  test('a claim of work without the tech\'s notes behind it falls back to the template', async () => {
    expect(await draft('We treated the ants in the kitchen today.')).toBeNull();
  });

  test('"today" only for a same-day send; the next morning allows "yesterday"; later, no day word', async () => {
    expect(await draft('How are the ants looking after today?')).not.toBeNull();
    expect(await draft('How are the ants looking after today?', { serviceDate: daysAgo(1) })).toBeNull();
    expect(await draft('How are the ants since yesterday?', { serviceDate: daysAgo(1) })).not.toBeNull();
    expect(await draft('How are the ants since yesterday?', { serviceDate: daysAgo(3) })).toBeNull();
    expect(mockDispatch.mock.calls[3][1].system).toMatch(/Use NO day word/);
  });

  test('both providers down, or a throw, → null (the template sends)', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    expect(await Drafter.draftDay0ContextBody({ customerId: 'c', recipientFirstName: 'Aaron', topic: TOPIC, serviceDate: today() })).toBeNull();
    mockDispatch.mockRejectedValue(new Error('boom'));
    expect(await Drafter.draftDay0ContextBody({ customerId: 'c', recipientFirstName: 'Aaron', topic: TOPIC, serviceDate: today() })).toBeNull();
  });
});

describe('verifyDay0ContextSentence — every rule on the model\'s sentence', () => {
  const v = (text, over = {}) => Drafter.verifyDay0ContextSentence(text, { topic: 'ants in the kitchen', mode: 'ask', dayWord: 'today', budget: 50, ...over });

  test('a clean question about the topic passes', () => {
    expect(v('How are the ants looking since the visit?')).toBeNull();
  });

  test('ask mode must be a question and must not claim the work', () => {
    expect(v('The ants should settle down.')).toBe('ask_not_question');
    expect(v('How are the ants now that we treated them?')).toBe('unconfirmed_work_claim');
    expect(v('We treated the ants today.', { mode: 'claim' })).toBeNull();
  });

  test('no sentence says the problem is gone, even in claim mode — the notes confirm the work, not the result', () => {
    expect(v('We knocked out those ants today.', { mode: 'claim' })).toBe('outcome_claim');
    expect(v('The ants should be gone now.', { mode: 'claim' })).toBe('outcome_claim');
    expect(v('We got rid of the ants today.', { mode: 'claim' })).toBe('outcome_claim');
    expect(v('We treated for the ants today.', { mode: 'claim' })).toBeNull();
  });

  test('it must name the customer\'s own topic', () => {
    expect(v('How is everything looking?')).toBe('topic_missing');
  });

  test('no names or places: a capitalized word must be the customer\'s own topic word', () => {
    expect(v('How are the ants on Main Street?')).toBe('proper_noun');
    expect(v('How are the ants, Aaron?')).toBe('proper_noun');
    expect(v('How is the Bermuda grass holding up?', { topic: 'Bermuda grass' })).toBeNull();
  });

  test('no second pest, in any plural', () => {
    expect(v('How are the ants and roaches?')).toBe('other_pest');
    expect(v('Any more mosquitoes or ants?')).toBe('other_pest');
    expect(v('How are the ants and mice?')).toBe('other_pest');
  });

  test('no weather, no wrong day word, one sentence, within budget', () => {
    expect(v('How are the ants after the rain?')).toBe('weather');
    expect(v('How are the ants since yesterday?')).toBe('day_word');
    expect(v('How are the ants since this morning?')).toBe('day_word');
    // Weekday names are capitalized, so the proper-noun rule refuses them first.
    expect(v('How are the ants on Monday?')).toBe('proper_noun');
    expect(v('Ants gone? Hope so!')).toBe('not_one_sentence');
    expect(v('How are the ants looking since the visit to the house?', { budget: 30 })).toBe('too_long');
  });
});
