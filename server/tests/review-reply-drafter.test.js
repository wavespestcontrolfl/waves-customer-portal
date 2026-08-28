// Review reply drafter: mode classification, the deterministic verifier
// (every rule the model is told is re-checked here), and the fallback ladder.
// Replies are PUBLIC — the verifier is the last line between a bad draft and
// Google; each rule gets a test.
const mockDispatch = jest.fn();

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...a) => mockDispatch(...a) }));
jest.mock('../config/models', () => ({ TEXT_POLICIES: { customerCopy: { name: 'customerCopy' } } }));

const Drafter = require('../services/review-reply/drafter');

const LOCATION = 'Sarasota';
const SIGN_OFF = Drafter.signOffFor(LOCATION);

function grounding(over = {}) {
  const text = over.text ?? 'Marcus came out fast and the ants in the kitchen are gone. Great service.';
  return {
    version: 'grounding-v1',
    reviewId: 'rev-1',
    locationId: 'sarasota',
    locationName: LOCATION,
    review: {
      firstName: over.firstName ?? 'Dana',
      rating: over.rating ?? 5,
      text,
      hasText: text.length > 0,
      wordCount: text ? text.split(/\s+/).length : 0,
      mentionedTechNames: over.mentionedTechNames ?? ['Marcus'],
      topics: over.topics ?? ['technician', 'responsiveness', 'results', 'pest'],
    },
    account: over.account === undefined ? { relationship: 'recurring', tenure: 'established', serviceCategories: ['pest control'], city: 'Sarasota' } : over.account,
    provenance: {},
    allow: {
      names: ['Dana', 'Marcus'],
      forbiddenNames: over.forbiddenNames ?? ['Bob', 'Tyler'],
      cities: ['Sarasota', 'Southwest Florida', 'Florida'],
      digits: text.match(/\d+/g) || [],
    },
  };
}

const good = (body) => `${body}\n\n${SIGN_OFF}`;
const CLEAN = good('Hi Dana,\n\nGlad Marcus got out fast and the ants are staying out of your kitchen. We will pass that along to him.');

beforeEach(() => { mockDispatch.mockReset(); });

describe('classifyReplyMode', () => {
  test('low rating wins over everything', () => {
    expect(Drafter.classifyReplyMode(grounding({ rating: 2 }))).toBe('low_rating');
  });
  test('no text → no_text', () => {
    expect(Drafter.classifyReplyMode(grounding({ text: '', mentionedTechNames: [], topics: [] }))).toBe('no_text');
  });
  test('named technician → tech_praise', () => {
    expect(Drafter.classifyReplyMode(grounding())).toBe('tech_praise');
  });
  test('long review → detailed_testimonial', () => {
    const text = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ');
    expect(Drafter.classifyReplyMode(grounding({ text, mentionedTechNames: [], topics: [] }))).toBe('detailed_testimonial');
  });
  test('results / responsiveness / loyalty / default', () => {
    expect(Drafter.classifyReplyMode(grounding({ mentionedTechNames: [], topics: ['results'] }))).toBe('results');
    expect(Drafter.classifyReplyMode(grounding({ mentionedTechNames: [], topics: ['responsiveness'] }))).toBe('responsiveness');
    expect(Drafter.classifyReplyMode(grounding({ mentionedTechNames: [], topics: ['loyalty'] }))).toBe('loyalty');
    expect(Drafter.classifyReplyMode(grounding({ mentionedTechNames: [], topics: [] }))).toBe('service_quality');
  });
});

describe('verifyReplyText — public-surface safety net', () => {
  const verify = (text, g = grounding(), opts = {}) => Drafter.verifyReplyText(text, g, opts);

  test('a clean reply passes', () => {
    expect(verify(CLEAN)).toBeNull();
  });
  test('requires the exact sign-off as the last line', () => {
    expect(verify('Hi Dana, thanks for having us out to handle the ants.')).toBe('missing_sign_off');
    expect(verify(`Hi Dana, thanks for having us out.\n\nThe Waves Team`)).toBe('missing_sign_off');
    expect(verify(good(`Hi Dana, thanks. ${SIGN_OFF}`))).toBe('duplicate_sign_off');
  });
  test('length bounds per mode', () => {
    expect(verify(good('Hi Dana, thanks.'))).toBe('too_short');
    const long = Array.from({ length: 95 }, () => 'word').join(' ');
    expect(verify(good(`Hi Dana, ${long}`))).toBe('too_long');
    // no_text mode is tighter
    const g = grounding({ text: '', mentionedTechNames: [], topics: [] });
    const fortyFive = Array.from({ length: 45 }, () => 'word').join(' ');
    expect(verify(good(`Hello there, ${fortyFive}`), g)).toBe('too_long');
  });
  test('style rules: emoji, em dash, first person singular, stock phrases', () => {
    expect(verify(good('Hi Dana, thanks for the note about Marcus 🎉 we will tell him.'))).toBe('emoji');
    expect(verify(good('Hi Dana, Marcus was glad to help — the ants are gone for good now.'))).toBe('em_dash');
    expect(verify(good('Hi Dana, I am so glad Marcus could get the ants out of your kitchen.'))).toBe('first_person_singular');
    expect(verify(good('Hi Dana, thank you for your kind words about Marcus and the ants.'))).toBe('stock_phrase');
  });
  test('never a link, email, phone, money, or street address', () => {
    expect(verify(good('Hi Dana, see wavespestcontrol.com/ants for more on what Marcus did.'))).toBe('url');
    expect(verify(good('Hi Dana, email us at help@waves.com about the ants Marcus treated.'))).toBe('email');
    expect(verify(good('Hi Dana, call 941-555-1212 any time about the ants Marcus treated.'))).toBe('phone');
    expect(verify(good('Hi Dana, Marcus treated the ants and the $89 visit was worth it.'))).toBe('money');
    expect(verify(good('Hi Dana, Marcus treated the ants at 123 Palm Ave and they are gone.'))).toBe('address');
  });
  test('banned phrases: incentives, rating asks, safety claims, guarantees, rank, competitors', () => {
    expect(verify(good('Hi Dana, Marcus is glad the ants are gone. Enjoy a free visit on us.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus is glad the ants are gone. Please give us five stars.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus used a safe product and the ants are gone.'))).toBe('banned_phrase');
    expect(verify(good("Hi Dana, Marcus got the ants and our treatments won't harm your pets."))).toBe('banned_phrase');
    // The poison / toxic / danger / hazard families in every wrapper (codex r19).
    expect(verify(good("Hi Dana, Marcus got the ants and our treatments won't poison your pets."))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants with a non-poisonous product.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants and there is no danger to your dogs.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants with a product that poses no hazard to kids.'))).toBe('banned_phrase');
    expect(verify(good("Hi Dana, Marcus got the ants and the products won't make your pets sick."))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants and the toxicity is low.'))).toBe('banned_phrase');
    // codex r22: no-injury / no-threat assertions in ANY wrapper.
    expect(verify(good('Hi Dana, Marcus got the ants and our treatments cannot hurt your pets.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants and the product is not able to affect your dogs.'))).toBe('banned_phrase');
    expect(verify(good("Hi Dana, Marcus got the ants and it couldn't bother the kids."))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants without any risk to your family.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants and there is no threat to your cats.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants and nothing will injure your pets.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants with products that are fine around kids.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants and we guarantee they stay gone.'))).toBe('banned_phrase');
    expect(verify(good("Hi Dana, Marcus got the ants and we're guaranteeing they stay gone."))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants and our warranties cover this.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, we warrant the work Marcus did on the ants.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants. We are the best in Sarasota.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, unlike Orkin, Marcus actually got the ants out.'))).toBe('banned_phrase');
  });
  test('dispute vocabulary and private-channel references are rejected', () => {
    expect(verify(good('Hi Dana, Marcus got the ants. Sorry about the refund delay.'))).toBe('dispute_words');
    expect(verify(good('Hi Dana, when you called about the ants Marcus got right out.'))).toBe('private_channel');
    expect(verify(good('Hi Dana, our records show Marcus treated the ants on his visit.'))).toBe('private_channel');
  });
  test('private-channel phrasing is allowed when the reviewer wrote it themselves', () => {
    const g = grounding({ text: 'I called about ants and Marcus came out the same day. When you called back it was fast.', topics: ['technician'] });
    expect(verify(good('Hi Dana, glad Marcus got out the same day when you called about the ants.'), g)).toBeNull();
  });
  test('provenance: technician names the reviewer did not write are forbidden (case-insensitive)', () => {
    expect(verify(good('Hi Dana, Marcus and Tyler are glad the ants are gone from your kitchen.'))).toBe('forbidden_name');
    expect(verify(good('Hi Dana, Marcus and TYLER are glad the ants are gone from your kitchen.'))).toBe('forbidden_name');
  });
  test('provenance: a name greeted in a recent reply cannot be copied into this one', () => {
    const recent = [good('Hi Priya, glad the wasps by the pool cage are handled. Thanks for having us.')];
    expect(verify(good('Hi Priya, glad Marcus got the ants out of your kitchen so fast.'), grounding(), { recentReplies: recent })).toBe('forbidden_name');
    expect(verify(CLEAN, grounding(), { recentReplies: recent })).toBeNull();
    expect(Drafter.greetingName('Hello there, thanks')).toBeNull();
    expect(Drafter.greetingName('Hey Priya, thanks')).toBe('Priya');
  });
  test('provenance: an introduced name with no source in the review is rejected (hallucinated / former tech)', () => {
    expect(verify(good('Hi Dana, Kevin and Marcus are glad the ants are gone from your kitchen.'))).toBe('unlisted_name');
    expect(verify(good('Hi Dana, glad the ants are gone. Thanks from Marcus and the Waves Pest Control team.'))).toBeNull();
    // A capitalized word the reviewer wrote is fine mid-sentence.
    const g = grounding({ text: 'Marcus took care of the German roaches fast.' });
    expect(verify(good('Hi Dana, glad Marcus took care of the German roaches so fast.'), g)).toBeNull();
  });
  test('provenance: sentence-initial names need provenance too; common starters are exempt', () => {
    expect(verify(good('Hi Dana,\n\nKevin was glad to help with the ants. Marcus says thanks.'))).toBe('unlisted_name');
    expect(verify(good('Hi Dana,\n\nGlad the ants are handled. Marcus says thanks. Anytime you need us, reach out.'))).toBe('unlisted_name');
    expect(verify(good('Hi Dana,\n\nGlad the ants are gone. Marcus says thanks. Thanks for having us out.'))).toBeNull();
  });
  test('provenance: fragments of unrelated served cities do not launder a name', () => {
    expect(verify(good('Hi Dana, Charlotte was glad to help with the ants alongside Marcus.'))).toBe('unlisted_name');
  });
  test('addresses are caught case-insensitively and with numbered streets', () => {
    const g = grounding({ text: 'Marcus treated the ants at 123 main st and 123 4th St, great.' });
    expect(verify(good('Hi Dana, glad Marcus got the ants at 123 main st handled.'), g)).toBe('address');
    expect(verify(good('Hi Dana, glad Marcus got the ants at 123 4th St handled.'), g)).toBe('address');
  });
  test('date and relative-time claims are rejected unless the reviewer wrote them', () => {
    expect(verify(good('Hi Dana, glad Marcus got the ants handled last week.'))).toBe('date_claim');
    expect(verify(good('Hi Dana, glad Marcus got the ants handled on Tuesday.'))).toBe('date_claim');
    // codex r22: seasonal phrasing in every wrapper is a timing claim too.
    expect(verify(good('Hi Dana, glad Marcus got the ants handled over the summer.'))).toBe('date_claim');
    expect(verify(good('Hi Dana, glad Marcus got the ants handled this spring.'))).toBe('date_claim');
    expect(verify(good('Hi Dana, glad Marcus got the ants handled during the summer heat.'))).toBe('date_claim');
    expect(verify(good('Hi Dana, glad Marcus got the ants handled before winter.'))).toBe('date_claim');
    expect(verify(good('Hi Dana, glad Marcus got the ants handled in the rainy season.'))).toBe('date_claim');
    const gSeason = grounding({ text: 'Marcus came out this spring and the ants are gone.' });
    expect(verify(good('Hi Dana, glad Marcus got to the ants this spring.'), gSeason)).toBeNull();
    const g = grounding({ text: 'Marcus came out last week and the ants are gone.' });
    expect(verify(good('Hi Dana, glad Marcus got to the ants last week.'), g)).toBeNull();
  });
  test('Unicode names survive normalization and the name allowlist', () => {
    const g = grounding({ firstName: 'José' });
    g.allow.names = ['José', 'Marcus'];
    expect(verify(good('Hi José, glad Marcus got the ants out of your kitchen so fast.'), g)).toBeNull();
    expect(Drafter.greetingName('Hi José, thanks')).toBe('José');
  });
  test('name-like sentence starters (Will/May/Hope) are not exempt', () => {
    expect(verify(good('Hi Dana,\n\nWill handled the ants quickly and Marcus followed up.'))).toBe('unlisted_name');
    expect(verify(good('Hi Dana,\n\nWe will keep the ants out. Marcus says thanks.'))).toBeNull();
  });
  test('service / treatment claims need provenance from the review or the account categories', () => {
    const g = grounding({ text: 'Great service!', mentionedTechNames: [], topics: [], account: null });
    expect(verify(good("Hi Dana, glad our mosquito treatments delivered great service. We look forward to protecting your yard."), g)).toBe('unlisted_service_claim');
    expect(verify(good('Hi Dana, glad the service hit the mark. Thanks for having us out to the house.'), g)).toBeNull();
    // An account service category makes its words sourced.
    const g2 = grounding({ text: 'Great service!', mentionedTechNames: [], topics: [], account: { relationship: 'recurring', tenure: 'long_term', serviceCategories: ['mosquito control'], city: null } });
    expect(verify(good('Hi Dana, glad the mosquito control is doing its job. Thanks for sticking with us over the years.'), g2)).toBeNull();
    // Outcome vocabulary is a claim too.
    expect(verify(good('Hi Dana, glad we eliminated the infestation and protected your home.'), g)).toBe('unlisted_service_claim');
    const g3 = grounding({ text: 'They eliminated our ant infestation fast!', mentionedTechNames: [], topics: [], account: null });
    expect(verify(good('Hi Dana, glad the ants are eliminated and the infestation is behind you.'), g3)).toBeNull();
    // Relationship claims need provenance too.
    expect(verify(good('Hi Dana, thanks for years of trusting us with the service.'), g)).toBe('unlisted_relationship_claim');
  });
  test('visit-experience claims (timeliness, communication) need the reviewer\'s words', () => {
    const g = grounding({ text: 'Great service!', mentionedTechNames: [], topics: [], account: null });
    expect(verify(good('Hi Dana, glad the service hit the mark. Our team arrived on time and explained everything clearly.'), g)).toBe('unlisted_experience_claim');
    const g2 = grounding({ text: 'Marcus arrived on time and explained everything.', topics: ['technician'] });
    expect(verify(good('Hi Dana, glad Marcus was on time and the explanation landed. Thanks for having us.'), g2)).toBeNull();
  });
  test('outcome verbs and clock times need the reviewer\'s words', () => {
    const g = grounding({ text: '', mentionedTechNames: [], topics: [], account: null });
    expect(verify(good("Hello there, we're glad we solved it and got everything handled for you."), g)).toBe('unlisted_service_claim');
    expect(verify(good("Hello there, glad we could stop by at noon. Thanks for the rating."), g)).toBe('date_claim');
    expect(verify(good("Hello there, glad we could be there at 5 pm. Thanks for the rating."), g)).toBe('date_claim');
    const g2 = grounding({ text: 'They came at noon and handled the ants.', mentionedTechNames: [], topics: [], account: null });
    expect(verify(good('Hi Dana, glad we came at noon and handled the ants for you.'), g2)).toBeNull();
  });
  test('service-quality adjectives need the reviewer\'s words (rating-only reviews get none)', () => {
    const g = grounding({ text: '', mentionedTechNames: [], topics: [], account: null });
    expect(verify(good("Hello there, we're glad our team was helpful, honest, and efficient. Thanks for the rating."), g)).toBe('unlisted_experience_claim');
    expect(verify(good('Hello there, thanks for the rating. Glad to be your pest and lawn team locally.'), g)).toBeNull();
  });
  test('quantified tenure needs the whole phrase in the review', () => {
    const g = grounding({ text: '10/10 great service', mentionedTechNames: [], topics: [], account: { relationship: 'recurring', tenure: 'long_term', serviceCategories: ['pest control'], city: null } });
    expect(verify(good('Hi Dana, thank you for trusting us with the pest control for 10 years.'), g)).toBe('unlisted_relationship_claim');
    expect(verify(good('Hi Dana, thank you for sticking with us over the years for the pest control.'), g)).toBeNull();
    const g2 = grounding({ text: 'Ten years with them and still great.', mentionedTechNames: [], topics: [], account: null });
    expect(verify(good('Hi Dana, ten years is a long run and we are glad to still be the ones you call.'), g2)).toBeNull();
  });
  test('comparative/noun safety forms and rank language in any wrapper are rejected', () => {
    expect(verify(good('Hi Dana, glad Marcus offered a safer option for the ants in your kitchen.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus put safety first with the ants in your kitchen.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus is proud to be on the best pest control team for your ants.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, thanks for choosing the number one team for the ants Marcus handled.'))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus and a top pest control team got the ants out.'))).toBe('banned_phrase');
  });
  test('charge-waiver incentive forms are banned; respect / visit-condition claims need the reviewer\'s words', () => {
    expect(verify(good("Hi Dana, Marcus got the ants out and we'd like to waive the charge on your next service."))).toBe('banned_phrase');
    expect(verify(good('Hi Dana, Marcus got the ants out at no cost to you.'))).toBe('banned_phrase');
    const g = grounding({ text: '', mentionedTechNames: [], topics: [], account: null });
    expect(verify(good("Hello there, we're glad we respected your home and left everything exactly as we found it. Thanks for the rating."), g)).toBe('unlisted_experience_claim');
  });
  test('visit-occurrence claims need the reviewer\'s words; grounded multiword outcome phrases pass', () => {
    const g = grounding({ text: '', mentionedTechNames: [], topics: [], account: null });
    expect(verify(good("Hello there, we're glad we could stop by. Thanks for the rating."), g)).toBe('unlisted_experience_claim');
    const g2 = grounding({ text: 'They came out and took care of the wasps, everything is under control.', mentionedTechNames: [], topics: [], account: null });
    expect(verify(good('Hi Dana, glad we could come out and take care of the wasps. Good to hear everything is under control.'), g2)).toBeNull();
  });
  test('all-caps names need provenance too; common acronyms are fine', () => {
    expect(verify(good('Hi Dana, KEVIN and Marcus are glad the ants are gone from your kitchen.'))).toBe('unlisted_name');
    expect(verify(good('Hi Dana, glad the ants are gone before your HOA walk-through. Marcus says thanks.'))).toBeNull();
  });
  test('drying / curing / wait-before language is banned even when the number came from the review', () => {
    const g = grounding({ text: 'Marcus said it would be dry in 30 minutes and it was. Ants gone.' });
    expect(verify(good('Hi Dana, glad Marcus got the ants and the yard was dry in 30 minutes for you.'), g)).toBe('banned_phrase');
    expect(verify(good('Hi Dana, glad Marcus got the ants. Just wait a few hours before letting pets out.'), g)).toBe('banned_phrase');
  });
  test('recent replies shown to the model have their greeted names redacted', () => {
    const text = Drafter.buildUserText(grounding(), [good('Hi Priya, glad the wasps are handled.')], null);
    expect(text).toContain('Hi (name), glad the wasps');
    expect(text).not.toContain('Priya');
  });
  test('provenance: digits the reviewer did not type are rejected; the star rating is allowed', () => {
    expect(verify(good('Hi Dana, Marcus got the ants on his 2nd visit and they are gone.'))).toBe('unlisted_digits');
    expect(verify(good('Hi Dana, thanks for the 5 star note. Marcus is glad the ants are gone.'))).toBeNull();
    const g = grounding({ text: 'Marcus came out within 2 hours and the ants are gone.' });
    expect(verify(good('Hi Dana, glad Marcus got there within 2 hours and the ants are gone.'), g)).toBeNull();
  });
  test('provenance: served cities the reviewer did not mention are rejected unless they are the location/account city', () => {
    expect(verify(good('Hi Dana, Marcus is glad the ants are gone from your Venice kitchen.'))).toBe('unlisted_city');
    expect(verify(good('Hi Dana, Marcus is glad the ants are gone from your Sarasota kitchen.'))).toBeNull();
  });
  test('non-repetition against recent posted replies', () => {
    const recent = [good('Hi Dana, glad Marcus got out quickly and the ants are staying out of your kitchen. Thanks.')];
    expect(verify(CLEAN, grounding(), { recentReplies: recent })).toBe('repetitive_opening');
    const recent2 = [good('Hello there, glad Marcus got out fast and the ants are staying out of your kitchen. We will pass that along to him.')];
    expect(verify(CLEAN, grounding(), { recentReplies: recent2 })).toBe('repetitive_body');
  });
  test('the greeting is mandatory: "Hi <reviewer first name>," or "Hello there,"', () => {
    expect(verify(good('Thanks for trusting Marcus with the ants in your kitchen.'))).toBe('missing_greeting');
    expect(verify(good('Hey Dana, thanks for trusting Marcus with the ants in your kitchen.'))).toBe('missing_greeting');
    expect(verify(good('Hello there, thanks for trusting Marcus with the ants in your kitchen.'))).toBeNull();
    const g = grounding({ firstName: null, text: '', mentionedTechNames: [], topics: [], account: null });
    expect(verify(good('Hello there, thanks for the rating. Glad to be your pest and lawn team locally.'), g)).toBeNull();
  });
  test('placeholders are rejected', () => {
    expect(verify(good('Hi {first name}, Marcus is glad the ants are gone from your kitchen.'))).toBe('placeholder');
  });
});

describe('draftReviewReply — fallback ladder', () => {
  test('accepts a clean first draft and reports mode/version', async () => {
    mockDispatch.mockResolvedValueOnce({ ok: true, text: CLEAN });
    const r = await Drafter.draftReviewReply({ grounding: grounding(), recentReplies: [] });
    expect(r.ok).toBe(true);
    expect(r.text).toBe(CLEAN);
    expect(r.mode).toBe('tech_praise');
    expect(r.version).toBe(Drafter.REPLY_VERSION);
    expect(r.attempts).toBe(1);
    // Rules ride the system channel; the review rides the user channel.
    const payload = mockDispatch.mock.calls[0][1];
    expect(payload.system).toContain('HARD RULES');
    expect(payload.text).toContain('Review text:');
    expect(payload.system).not.toContain('ants in the kitchen');
  });
  test('retries with the violation named, then falls back to review-only, then gives up', async () => {
    mockDispatch
      .mockResolvedValueOnce({ ok: true, text: good('Hi Dana, Marcus and Tyler are glad the ants are gone from your kitchen.') })
      .mockResolvedValueOnce({ ok: true, text: good('Hi Dana, call 941-555-1212 about the ants Marcus treated.') })
      .mockResolvedValueOnce({ ok: true, text: good('Hi Dana, our records show Marcus treated the ants for you.') });
    const r = await Drafter.draftReviewReply({ grounding: grounding(), recentReplies: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('verifier_reject');
    expect(r.rejections).toEqual(['forbidden_name', 'phone', 'private_channel']);
    expect(r.attempts).toBe(3);
    expect(mockDispatch.mock.calls[1][1].text).toContain('PREVIOUS ATTEMPT WAS REJECTED');
    // third attempt is review-only: no account facts in the user text
    expect(mockDispatch.mock.calls[2][1].text).toContain('ACCOUNT FACTS: none available');
  });
  test('no review-only step when there were no account facts (2 attempts max)', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: good('Hi Dana, Marcus and Tyler are glad the ants are gone from your kitchen.') });
    const r = await Drafter.draftReviewReply({ grounding: grounding({ account: null }), recentReplies: [] });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
  });
  test('provider outage surfaces as provider_unavailable', async () => {
    mockDispatch.mockResolvedValueOnce({ ok: false, reason: 'all_failed' });
    const r = await Drafter.draftReviewReply({ grounding: grounding(), recentReplies: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('provider_unavailable');
  });
  test('a quoted draft is normalized before verification', async () => {
    mockDispatch.mockResolvedValueOnce({ ok: true, text: `"${CLEAN}"` });
    const r = await Drafter.draftReviewReply({ grounding: grounding(), recentReplies: [] });
    expect(r.ok).toBe(true);
    expect(r.text).toBe(CLEAN);
  });
});
