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

// GATE_REVIEW_DAY0_CONTEXT (owner rulings 2026-09-28): the Day-0 ask stays the
// general fixed text; a recurring customer who raised a topic gets ONE
// follow-up about four days on asking how that topic is doing. Code fills one
// fixed question with the concern; no model writes it.
describe('draftTopicFollowupBody — the recurring topic follow-up', () => {
  const draft = (over = {}) => Drafter.draftTopicFollowupBody({ customerId: 'cust-1', recipientFirstName: 'Aaron', concern: 'ants', ...over });
  const REAL_LINK = 'https://portal.wavespestcontrol.com/l/abcdefghjk';

  test('one fixed question naming the concern, framed by the greeting and the uniform ending, one segment at the real link length', async () => {
    const body = await draft();
    expect(body).toBe("Hi Aaron! How's it going with the ants? A Google review means a lot: {review_url} Reply if anything's off.");
    expect(body.replace('{review_url}', REAL_LINK).length).toBeLessThanOrEqual(160);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('pest, plant and condition concerns render as written', async () => {
    expect(await draft({ concern: 'Bermuda grass' })).toContain("How's it going with the Bermuda grass?");
    expect(await draft({ concern: 'roof rats' })).toContain("How's it going with the roof rats?");
    expect(await draft({ concern: 'grass dying' })).toContain("How's it going with the grass dying?");
    expect(await draft({ concern: 'wasp nest' })).toContain("How's it going with the wasp nest?");
  });

  test('a place or a service action as the concern gets the generic template (codex r6 on #5246)', async () => {
    for (const concern of ['kitchen', 'wasp nest treatment', 'the kitchen', 'ants gone', 'backyard', 'Main Street']) {
      expect([concern, await draft({ concern })]).toEqual([concern, null]);
    }
  });

  test('the drafter kill switch (GATE_REVIEW_ASK_PERSONALIZED) off, no first name, or no concern → null', async () => {
    expect(await draft({ recipientFirstName: '' })).toBeNull();
    expect(await draft({ concern: '' })).toBeNull();
    mockGates.reviewAskPersonalized = false;
    expect(await draft()).toBeNull();
  });

  test('a first name long enough to push the body past one segment → null', async () => {
    expect(await draft({ recipientFirstName: 'Maximilianus-Bartholomew', concern: 'St Augustine grass' })).toBeNull();
  });
});

// GATE_REVIEW_ASK_SERVICE_FACTS (owner 2026-09-29): the service report's
// treated areas, only on a completed visit. The caller passes serviceFacts
// only with the gate on; null keeps every draft exactly as before.
describe('service facts — treated areas from the service report', () => {
  const FACTS = { treated: true, areasTreated: ['Perimeter', 'Kitchen', 'Garage', 'Lanai / pool cage'] };
  const ask = (text, serviceFacts) => {
    mockDispatch.mockResolvedValue({ ok: true, text });
    return Drafter.draftAskBody({ customer: CUSTOMER, recipientFirstName: 'Aaron', serviceType: 'Quarterly Pest Control', sequenceStep: 1, serviceFacts });
  };

  test('the treated areas ride the history text and the rule rides the system prompt; nothing without facts', async () => {
    await ask(CLEAN_BODY, FACTS);
    let payload = mockDispatch.mock.calls[0][1];
    expect(payload.text).toContain('AREAS TREATED at this visit: Perimeter, Kitchen, Garage, Lanai / pool cage');
    expect(payload.system).toMatch(/ONLY if it is on the AREAS TREATED line/);

    mockDispatch.mockClear();
    await ask(CLEAN_BODY, null);
    payload = mockDispatch.mock.calls[0][1];
    expect(payload.text).not.toContain('AREAS TREATED');
    expect(payload.system).not.toMatch(/AREAS TREATED/);
  });

  test('a visit that is not a completed treatment says so, and gets no areas', async () => {
    await ask(CLEAN_BODY, { treated: false, areasTreated: ['Kitchen'] });
    const payload = mockDispatch.mock.calls[0][1];
    expect(payload.text).toContain('No treatment is on record for this visit.');
    expect(payload.text).not.toContain('AREAS TREATED');
  });

  test('a treatment claim on a treated area passes; on an untreated one it falls back to the template', async () => {
    expect(await ask('Hi Aaron, hope the ants are backing off since we treated the kitchen: {review_url}', FACTS)).not.toBeNull();
    expect(await ask('Hi Aaron, hope the ants are backing off since we treated the kitchen and garage: {review_url}', FACTS)).toBeNull();
    expect(await ask('Hi Aaron, hope the ants are backing off since we treated the attic: {review_url}', FACTS)).toBeNull();
  });

  test('verifyTreatmentClaims: only with facts; a draft that claims work stays in a closed vocabulary', () => {
    const v = (text, facts = FACTS) => Drafter.verifyTreatmentClaims(text, facts, { names: ['Aaron', 'Adam'] });
    expect(v('We sprayed the attic.', null)).toBeNull();
    expect(v('We treated the kitchen.')).toBeNull();
    expect(v('We treated the lanai and pool cage.')).toBeNull();
    expect(v('Hope the ants are backing off since Adam treated the kitchen, Aaron.')).toBeNull();
    expect(v('Hope the roaches are settling down since the treatment.')).toBeNull();
    // Any place not treated, however it is named, whichever sentence it sits in.
    for (const t of ['We sprayed the attic.', 'We treated the dining room.', 'We treated the house.', 'We treated the lawn, Aaron.',
      'We treated the trees and hedges.', 'We treated the roof.', 'We treated the drains.',
      'Thanks for having us out for the treatment, Aaron. The attic should be quiet now.',
      'The kitchen looked great. We treated the bedroom.']) {
      expect([t, v(t)]).toEqual([t, 'claim_word_outside_facts']);
    }
    // Other ways of claiming work are claims too (tree-reviewer + Codex r1 on #5317).
    for (const t of ['We baited the attic.', 'We dusted the attic today, Aaron.', 'We serviced the attic.', 'We took care of the attic.', 'We fogged the attic.']) {
      expect([t, v(t)]).toEqual([t, 'claim_word_outside_facts']);
    }
    expect(v('Thanks for letting us service the lanai today.', { treated: false, areasTreated: [] })).toBe('treatment_not_on_record');
    // At most ONE treated area, from one label (Codex r1 on #5317).
    expect(v('We treated the kitchen and garage.')).toBe('more_than_one_area');
    expect(v('We treated the pool garage.')).toBe('more_than_one_area');
    // Every draft is checked, so a verb nobody listed cannot claim work
    // (pre-push review on #5317 r2: removed, sealed, cleared...).
    for (const t of ['We removed the nest from the attic.', 'We sealed the garage.', 'We cleared out the attic, Aaron.', 'All gone now!']) {
      expect([t, v(t)]).toEqual([t, 'claim_word_outside_facts']);
    }
    expect(v('Hope the ants are backing off. Thanks for having us!')).toBeNull();
    expect(v("Hi Aaron, hope the ants are backing off since we treated the kitchen. If we earned it, a quick Google review would mean the world: {review_url} Reply if anything's off.")).toBeNull();
    expect(v('Hope things are better since the treatment.', { treated: false, areasTreated: [] })).toBe('treatment_not_on_record');
  });

  test('a visit with no work done never gets the "since the treatment" instruction (Codex r1 on #5317)', async () => {
    await ask(CLEAN_BODY, { treated: false, areasTreated: [] });
    expect(mockDispatch.mock.calls[0][1].system).toMatch(/no work was done at this visit/);
    expect(mockDispatch.mock.calls[0][1].system).not.toMatch(/since the treatment/);
    mockDispatch.mockClear();
    await ask(CLEAN_BODY, FACTS);
    expect(mockDispatch.mock.calls[0][1].system).toMatch(/since the treatment/);
  });

  test('the email intro gets the same facts and the same check', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'Hi Aaron, hope the ants are backing off since we treated the attic. If anything looks off, just reply. A quick review would mean a lot.' });
    expect(await Drafter.draftEmailIntro({ customer: CUSTOMER, recipientFirstName: 'Aaron', serviceFacts: FACTS })).toBeNull();
    expect(mockDispatch.mock.calls[0][1].text).toContain('AREAS TREATED at this visit');
  });

  describe('the topic follow-up adds the place when the customer named it and the tech treated it', () => {
    const follow = (over) => Drafter.draftTopicFollowupBody({ customerId: 'c', recipientFirstName: 'Aaron', concern: 'ants', topic: 'ants in the kitchen', ...over });

    test('named and treated → "the ants in the kitchen"', async () => {
      expect(await follow({ serviceFacts: FACTS })).toBe("Hi Aaron! How's it going with the ants in the kitchen? A Google review means a lot: {review_url} Reply if anything's off.");
      expect(await follow({ topic: 'bugs in my bathroom', concern: 'bugs', serviceFacts: { treated: true, areasTreated: ['Bathrooms'] } }))
        .toContain("How's it going with the bugs in the bathroom?");
    });

    test('not treated, not a completed visit, no facts, or a place not in the topic → no place', async () => {
      for (const serviceFacts of [{ treated: true, areasTreated: ['Garage'] }, { treated: false, areasTreated: ['Kitchen'] }, null]) {
        expect(await follow({ serviceFacts })).toContain("How's it going with the ants? ");
      }
      expect(await follow({ topic: 'ants', serviceFacts: FACTS })).toContain("How's it going with the ants? ");
    });

    test('a body the place would push past one segment drops the place, not the concern', async () => {
      const out = await follow({ recipientFirstName: 'Bartholomew', concern: 'Bermuda grass', topic: 'Bermuda grass in the yard', serviceFacts: { treated: true, areasTreated: ['Yard'] } });
      expect(out).toContain("How's it going with the Bermuda grass? ");
    });
  });
});
