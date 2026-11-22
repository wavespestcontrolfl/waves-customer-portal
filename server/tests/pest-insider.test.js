/**
 * The 'pest-insider-monthly' newsletter type at the send gates: the claim
 * rules every send of the type passes through, and the topics-only rule for
 * the flagship writer's seasonal context. The Waves Pest Insider itself is
 * built by services/pest-insider (pest-insider-*.test.js); the old
 * model-written monthly format was removed.
 */

const { FLAGSHIP_SEASONAL_CONTEXT } = require('../services/newsletter-draft');

describe('flagship seasonal context', () => {
  // A figure restated in a static prompt outlives the register fact it came
  // from (a withdrawn or flagged fact would still be prompted). The context
  // names topics; the figures come only from the register.
  test('the flagship seasonal context names topics only — no figure, duration, temperature or named-source number (codex round 14 P1)', () => {
    expect(FLAGSHIP_SEASONAL_CONTEXT.split('\n')).toHaveLength(12);
    expect(FLAGSHIP_SEASONAL_CONTEXT).not.toMatch(/\d+\s*(?:–|-|to)\s*\d+\s*days|\d+\s*days?\b|\d+\s*°|\bUF\b|\bCDC\b|IFAS|EPA|\d+\s*ft\b|\bJune\s+\d|\bSept\.?\s+\d/);
  });
});

describe('pest-insider claim validation at the send gates', () => {
  const { validateNewsletterDraft } = require('../services/newsletter-validator');
  const { requiresClaimValidation } = require('../config/newsletter-types');
  const baseSend = {
    subject: 'PSA: Mosquitoes Are Back',
    html_body: '<h2>What\'s Crawling</h2><p>Mosquito season is here. Call us.</p>',
    text_body: 'Mosquito season is here.',
    preview_text: 'Bite me? Nope.',
    newsletter_type: 'pest-insider-monthly',
  };

  test('AI-generated lanes require claim validation; manual types stay exempt', () => {
    expect(requiresClaimValidation('pest-insider-monthly')).toBe(true);
    expect(requiresClaimValidation('local-weekly-fresh-events')).toBe(true);
    expect(requiresClaimValidation('service-promo')).toBe(false);
    expect(requiresClaimValidation('free-form')).toBe(false);
  });

  test('a hallucinated efficacy or price claim hard-blocks a Pest Insider send', () => {
    const efficacy = { ...baseSend, html_body: baseSend.html_body + '<p>Our treatment is pet-safe and 100% effective!</p>' };
    expect(
      validateNewsletterDraft(efficacy, { recipientCount: 100 }).errors
        .some((e) => e.includes('Hallucinated claim')),
    ).toBe(true);
    const price = { ...baseSend, subject: 'Mosquito season special: $99' };
    expect(
      validateNewsletterDraft(price, { recipientCount: 100 }).errors
        .some((e) => e.includes('Hallucinated claim')),
    ).toBe(true);
  });

  test('a clean Pest Insider draft passes without flagship-only structure warnings blocking', () => {
    const { errors } = validateNewsletterDraft(baseSend, { recipientCount: 100 });
    expect(errors).toEqual([]);
  });

  test('a storm-triggered "second swarm" termite claim hard-blocks the send (email-division fact register)', () => {
    const draft = {
      ...baseSend,
      html_body: baseSend.html_body + '<p>Termites will throw a second swarm event after significant rain and storm activity.</p>',
    };
    const { errors } = validateNewsletterDraft(draft, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Unverified claim (termite_second_swarm)'))).toBe(true);
  });

  test.each([
    ['HTML entities', 'Termites will throw a &#115;econd swarm event after storms.'],
    ['fullwidth look-alike letters', 'Termites will throw a ｓecond swarm event after storms.'],
    ['a non-breaking space entity', 'Termites will throw a second&nbsp;swarm event after storms.'],
  ])('an encoded or homoglyph termite claim (%s) renders as the claim and still hard-blocks', (_label, sentence) => {
    const draft = { ...baseSend, html_body: `${baseSend.html_body}<p>${sentence}</p>` };
    const { errors } = validateNewsletterDraft(draft, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Unverified claim (termite_second_swarm)'))).toBe(true);
  });

  test('a "Myth-Buster" heading glued to the paragraph under it does NOT exempt a false claim in that paragraph', () => {
    const draft = {
      ...baseSend,
      html_body: `${baseSend.html_body}<h2>Myth-Buster: do termites swarm again after storms?</h2><p>Yes — termites swarm again after every big storm.</p><ul><li>Termites swarm again after storms</li><li>Vacuum daily for 14 days after ant treatment</li></ul>`,
    };
    const { errors } = validateNewsletterDraft(draft, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Unverified claim (termite_second_swarm)'))).toBe(true);
    expect(errors.some((e) => e.includes('Unverified claim (non_flea_vacuum_advice)'))).toBe(true);
  });

  test('UF\'s own Formosan April-to-June window (Pest Insider fact T02) does not block the send', () => {
    const { factById } = require('../services/pest-insider/facts');
    const t02 = factById('T02');
    const draft = { ...baseSend, html_body: `${baseSend.html_body}<p>${t02.statement}</p><p>${t02.quotes[0]}</p>` };
    const { errors } = validateNewsletterDraft(draft, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Unverified claim (termite_second_swarm)'))).toBe(false);
    const repeat = { ...baseSend, html_body: `${baseSend.html_body}<p>Formosan termites swarm again in June.</p>` };
    expect(validateNewsletterDraft(repeat, { recipientCount: 100 }).errors.some((e) => e.includes('Unverified claim (termite_second_swarm)'))).toBe(true);
  });

  test.each([
    ['a curly apostrophe', 'Termites don’t have a second swarm after storms.'],
    ['an &rsquo; entity', 'Termites don&rsquo;t have a second swarm after storms.'],
  ])('a denial written with %s is normalised before the scan and does not block', (_label, sentence) => {
    const draft = { ...baseSend, html_body: `${baseSend.html_body}<p>${sentence}</p>` };
    const { errors } = validateNewsletterDraft(draft, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Unverified claim (termite_second_swarm)'))).toBe(false);
  });

  test('the register rules cover every claim-validated type: the same claim in a weekly flagship body is scanned too (pre-push audit P1 on e0dd938596)', () => {
    const { validateNewsletterDraft: validate } = require('../services/newsletter-validator');
    // 'local-weekly-fresh-events' is the flagship key and a claim-validated type.
    const weekly = { ...baseSend, newsletter_type: 'local-weekly-fresh-events', html_body: `${baseSend.html_body}<p>Termites swarm again after storms.</p>` };
    const { errors } = validate(weekly, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Unverified claim (termite_second_swarm)'))).toBe(true);
    // an events line with no pest claim in it is untouched
    const clean = { ...baseSend, newsletter_type: 'local-weekly-fresh-events', html_body: `${baseSend.html_body}<p>Bring a foldable chair for the Saturday concert.</p>` };
    expect(validate(clean, { recipientCount: 100 }).errors.some((e) => e.includes('Unverified claim'))).toBe(false);
  });

  test('flagship copy: the safety and re-entry rules apply to sentences about a treatment, never to benign event phrasing (codex round 15 P1)', () => {
    const { validateNewsletterDraft: validate } = require('../services/newsletter-validator');
    const flagship = (line) => ({ ...baseSend, newsletter_type: 'local-weekly-fresh-events', html_body: `${baseSend.html_body}<p>${line}</p>` });
    const unsafe = validate(flagship('Our treatment is safe once dry.'), { recipientCount: 100 }).errors;
    expect(unsafe.some((e) => e.includes('Unverified claim (absolute_safety_claim)'))).toBe(true);
    const minutes = validate(flagship('Keep pets off the sprayed lawn for 30 minutes.'), { recipientCount: 100 }).errors;
    expect(minutes.some((e) => e.includes('Unverified claim (fixed_reentry_time)'))).toBe(true);
    // service / plan / program wording is treatment context too (codex round 16 P1)
    // …including brand-owned wording (codex round 17 P1)
    for (const service of ['Our pest-control service is safe.', 'The WaveGuard plan is safe for the whole family.', 'Our program is completely safe around kids.', "Waves' service is safe.", 'The Waves program is safe for pets.', "Waves Pest Control's treatment is safe once dry."]) {
      expect(validate(flagship(service), { recipientCount: 100 }).errors.some((e) => e.includes('Unverified claim (absolute_safety_claim)'))).toBe(true);
    }
    // …and every product noun the safety predicate itself reads, when Waves
    // owns it or a pest/lawn word qualifies it; product-only nouns on their
    // own; a pronoun subject after a treatment sentence (codex round 18 P1)
    for (const product of ['Our lawn solution is safe.', 'Our formula is safe for pets.', 'The Waves approach is safe around kids.', 'Our pest-control method is safe.', 'The lawn option is completely safe.', 'This solution is safe for the whole family.', 'Our new mosquito treatment starts Monday. It is safe for pets.']) {
      expect(validate(flagship(product), { recipientCount: 100 }).errors.some((e) => e.includes('Unverified claim (absolute_safety_claim)'))).toBe(true);
    }
    for (const benign of ['A family-safe fun run this Saturday.', 'Kid-safe bounce houses at the fall festival.', 'Gates open 30 minutes early for the boat parade.', 'A family-safe program of concerts all weekend.', 'The safest way to see the fireworks is by boat.', 'Parking options are safe and well lit.', 'Join the fun run Saturday. It is safe for the whole family.']) {
      expect(validate(flagship(benign), { recipientCount: 100 }).errors.some((e) => e.includes('Unverified claim'))).toBe(false);
    }
    // the Pest Insider is all treatment copy: the same phrase stays a claim there
    const insider = { ...baseSend, html_body: `${baseSend.html_body}<p>A family-safe fun run this Saturday.</p>` };
    expect(validate(insider, { recipientCount: 100 }).errors.some((e) => e.includes('Unverified claim (absolute_safety_claim)'))).toBe(true);
  });

  test('the A/B subject variant is scanned too — variant-B recipients see it', () => {
    const draft = { ...baseSend, subject_b: 'Termites swarm again after storms' };
    const { errors } = validateNewsletterDraft(draft, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Unverified claim (termite_second_swarm)'))).toBe(true);
    const priced = { ...baseSend, subject_b: 'Mosquito season special: $99' };
    expect(validateNewsletterDraft(priced, { recipientCount: 100 }).errors.some((e) => e.includes('Hallucinated claim'))).toBe(true);
  });

  test.each([
    ['an inline HTML tag', 'html_body', '<p>We are pet-<strong>safe</strong> certified.</p>', 'absolute_safety_claim'],
    ['an inline tag with attributes', 'html_body', '<p>Kid-<span style="color:#0a0">safe</span> fun.</p>', 'absolute_safety_claim'],
    ['an inline tag inside a word', 'html_body', '<p>Termites have a sec<b>ond</b> swarm.</p>', 'termite_second_swarm'],
    ['Markdown bold', 'text_body', 'We are pet-**safe** certified.', 'absolute_safety_claim'],
    ['Markdown italics', 'text_body', 'Kid-_safe_ fun.', 'absolute_safety_claim'],
    ['Markdown code', 'text_body', 'Pet-`safe`.', 'absolute_safety_claim'],
    ['Markdown bold inside a word', 'text_body', 'Termites have a sec**ond** swarm.', 'termite_second_swarm'],
    ['Markdown italics inside a word', 'text_body', 'Termites have a sec*ond* swarm.', 'termite_second_swarm'],
    ['Markdown strikethrough inside a word', 'text_body', 'Termites have a sec~~~~ond swarm.', 'termite_second_swarm'],
  ])('a claim split by %s renders as one word and still hard-blocks', (_label, field, body, ruleName) => {
    const draft = { ...baseSend, [field]: field === 'html_body' ? baseSend.html_body + body : body };
    const { errors } = validateNewsletterDraft(draft, { recipientCount: 100 });
    expect(errors.some((e) => e.includes(`Unverified claim (${ruleName})`))).toBe(true);
  });

  test('a heading still ends a sentence: a large-patch heading does not join the summer paragraph under it', () => {
    const draft = { ...baseSend, html_body: `${baseSend.html_body}<h2>Large <em>patch</em></h2><p>Summer lawns need deep watering.</p>` };
    const { errors } = validateNewsletterDraft(draft, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Unverified claim (large_patch_summer_disease)'))).toBe(false);
  });

  test('an entity-encoded DENIAL is decoded before the scan and does not block', () => {
    const draft = { ...baseSend, html_body: `${baseSend.html_body}<p>Termites don&#39;t have a second swarm after storms.</p>` };
    const { errors } = validateNewsletterDraft(draft, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Unverified claim (termite_second_swarm)'))).toBe(false);
  });
});
