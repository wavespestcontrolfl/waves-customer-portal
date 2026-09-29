/**
 * Pest Insider (monthly) — humor-sandwich newsletter type with the
 * repeatable issue skeleton (What's Crawling / Pest of the Month /
 * Lawn Corner / Myth-Buster / one pitch / close). Pure pieces only.
 */

const {
  buildPestInsiderSystemPrompt,
  sanitizePestInsiderDraft,
  assemblePestInsiderNewsletter,
  PEST_INSIDER_ROTATION,
  FLAGSHIP_SEASONAL_CONTEXT,
} = require('../services/newsletter-draft');
const { getVoiceProfile } = require('../config/voice-profiles');
const {
  isFirstTuesdayET,
  etMonthBounds,
} = require('../services/pest-insider-autopilot');

const voice = getVoiceProfile('waves_phase_3_local');

describe('pest-insider buildPestInsiderSystemPrompt', () => {
  const prompt = buildPestInsiderSystemPrompt(voice, 'June');

  test('encodes the issue skeleton, four jobs, and this month\'s editorial slate', () => {
    expect(prompt).toContain('ISSUE SKELETON');
    expect(prompt).toContain("What's Crawling This Month");
    expect(prompt).toContain('Pest of the Month');
    expect(prompt).toContain('The Lawn Corner');
    expect(prompt).toContain('Myth-Buster');
    expect(prompt).toContain('FEATURED SERVICE (the one pitch): mosquito treatment');
    expect(prompt).toContain('LAWN CORNER BEAT: chinch bugs on St. Augustine (their season, from the verified facts)');
    expect(prompt).toContain('retention');
    expect(prompt).toContain('exactly ONE pitch and ONE CTA');
  });

  test('carries the hard rules: no prices, no invented tech/stories, no efficacy claims, biological urgency', () => {
    expect(prompt).toContain('NO dollar amounts');
    expect(prompt).toContain('NO invented technology names');
    expect(prompt).toContain('NO invented customer stories');
    expect(prompt).toContain('never "pet-safe"');
    expect(prompt).toContain('seasonal/biological only');
    expect(prompt).toContain('The pitch section is SINCERE');
  });

  test('subject guidance is specific-and-local; sign-off is a real person', () => {
    expect(prompt).toContain('SPECIFIC AND LOCAL BEATS CLEVER');
    expect(prompt).toContain('Termites are swarming in Sarasota this week');
    expect(prompt).toContain('— Adam, Waves Pest Control');
  });

  test('rotation covers all 12 months with service+lawn+beats; unknown months fall back', () => {
    expect(Object.keys(PEST_INSIDER_ROTATION)).toHaveLength(12);
    for (const slate of Object.values(PEST_INSIDER_ROTATION)) {
      expect(slate.service).toBeTruthy();
      expect(slate.lawn).toBeTruthy();
      expect(slate.beats).toBeTruthy();
    }
    expect(buildPestInsiderSystemPrompt(voice, 'Smarch')).toContain('general home pest defense');
  });

  // Codex PR #5187 r11: a figure restated in the rotation outlives the
  // register fact it came from (a withdrawn or flagged fact would still be
  // prompted). Slates name topics; the figures come only from the register.
  test('the flagship seasonal context names topics only — no figure, duration, temperature or named-source number (codex round 14 P1)', () => {
    expect(FLAGSHIP_SEASONAL_CONTEXT.split('\n')).toHaveLength(12);
    expect(FLAGSHIP_SEASONAL_CONTEXT).not.toMatch(/\d+\s*(?:–|-|to)\s*\d+\s*days|\d+\s*days?\b|\d+\s*°|\bUF\b|\bCDC\b|IFAS|EPA|\d+\s*ft\b|\bJune\s+\d|\bSept\.?\s+\d/);
  });

  test('no rotation entry states a storm-to-pest causal claim the register does not carry (codex round 19 P2)', () => {
    const STORM_CLAIM = /storm-damaged|wet wood|displaced\s+rodents?|storms?\s+(?:drive|push|displace|bring)\w*/i;
    for (const [month, slate] of Object.entries(PEST_INSIDER_ROTATION)) {
      for (const [field, text] of Object.entries(slate)) {
        expect({ month, field, claim: STORM_CLAIM.test(text) }).toEqual({ month, field, claim: false });
      }
    }
  });

  test('no rotation entry carries a figure, a duration, a temperature or a named-source number', () => {
    const FIGURE = /\d+\s*(?:–|-|to)\s*\d+\s*days|\d+\s*°|\d+\s*days?\b|[½¼¾]|\d/;
    const SOURCE_CITATION = /\b(?:UF|CDC|IFAS|EPA)\b|\bper\s+UF\b/;
    for (const [month, slate] of Object.entries(PEST_INSIDER_ROTATION)) {
      for (const [field, text] of Object.entries(slate)) {
        expect({ month, field, figure: FIGURE.test(text) }).toEqual({ month, field, figure: false });
        expect({ month, field, citation: SOURCE_CITATION.test(text) }).toEqual({ month, field, citation: false });
      }
    }
  });
});

describe('pest-insider sanitizePestInsiderDraft', () => {
  test('strips URLs from prose, the ID card, and pitch bullets; drops emptied items', () => {
    const draft = sanitizePestInsiderDraft({
      crawlText: 'Read more at https://evil.example now',
      pestOfMonth: {
        name: 'Ghost Ant',
        whereYoullSeeIt: 'Kitchens — see https://spam.example',
        threatLevel: 'Annoying, not dangerous',
      },
      pitchBullets: [
        { title: 'Stops the Cycle', text: 'Growth regulation prevents the next generation.' },
        { title: '', text: '' },
        'not-an-object',
      ],
    });
    expect(draft.crawlText).not.toContain('evil.example');
    expect(draft.pestOfMonth.whereYoullSeeIt).not.toContain('spam.example');
    expect(draft.pitchBullets).toEqual([
      { title: 'Stops the Cycle', text: 'Growth regulation prevents the next generation.' },
    ]);
  });

  test('a nameless ID card nulls out; non-array pitchBullets normalize', () => {
    const draft = sanitizePestInsiderDraft({ pestOfMonth: { whereYoullSeeIt: 'x' }, pitchBullets: null });
    expect(draft.pestOfMonth).toBeNull();
    expect(draft.pitchBullets).toEqual([]);
  });
});

describe('pest-insider assemblePestInsiderNewsletter', () => {
  const baseDraft = {
    greeting: 'Hey there!',
    introText: 'Mosquito season is **coming**.',
    crawlHeading: "🦟 What's Crawling This Month",
    crawlText: 'Salt-marsh mosquitoes are about to peak.',
    pestOfMonth: {
      name: 'Salt-Marsh Mosquito',
      emoji: '🦟',
      whereYoullSeeIt: 'Dusk, anywhere near standing water.',
      threatLevel: 'Annoying, occasionally disease-carrying.',
      diyTip: 'Walk your yard and dump anything holding water.',
      whenToCall: 'When dumping water stops making a dent.',
    },
    lawnHeading: '🌱 The Lawn Corner',
    lawnText: 'Chinch bugs are waking up on St. Augustine.',
    mythQuestion: 'Do dryer sheets repel mosquitoes?',
    mythVerdict: 'Short answer: _no_. Long answer: **still no**, but your trunk smells great.',
    pitchHeading: '✈️ Turn Your Yard Into a No-Fly Zone',
    pitchIntro: "Here's what we do about it.",
    pitchBullets: [{ title: 'Stops the Cycle', text: 'Growth regulation prevents the next generation.' }],
    closingHeading: '😎 Want Your Backyard Back?',
    closingText: 'Your quarterly visit is already on mosquito duty this month.',
    ctaLine: "Let's make mosquitoes a problem of the past —",
    ps: 'Forward this to the friend who attracts every mosquito at the bonfire.',
  };

  test('renders the full skeleton: TOC, lead story, ID card, Lawn Corner, Myth-Buster, pitch, tel CTA, referral, Adam sign-off', async () => {
    const html = await assemblePestInsiderNewsletter({ ...baseDraft });
    expect(html).toContain('In this email:');
    expect(html).toContain('#pi-crawl');
    expect(html).toContain('Pest of the Month: Salt-Marsh Mosquito');
    expect(html).toContain("Where you'll see it:");
    expect(html).toContain('How worried to be:');
    expect(html).toContain('The Lawn Corner');
    expect(html).toContain('Myth-Buster: Do dryer sheets repel mosquitoes?');
    expect(html).toContain('🔹 <strong>Stops the Cycle</strong>');
    expect(html).toContain('href="tel:');
    expect(html).toContain('(941) 297-5749');
    expect(html).toContain('https://www.wavespestcontrol.com/referral/');
    expect(html).toContain('— Adam, Waves Pest Control');
    expect(html).toContain('<strong>P.S.</strong>');
  });

  test('renders the generated issue hero instead of paying for unused artwork', async () => {
    const html = await assemblePestInsiderNewsletter({
      ...baseDraft,
      selectedSubject: 'Mosquitoes Are Back',
      heroImageUrl: 'https://cdn.example.com/pest-insider.jpg',
    });
    expect(html).toContain('src="https://cdn.example.com/pest-insider.jpg"');
    expect(html).toContain('alt="Mosquitoes Are Back"');
  });

  test('rejects unsafe hero URLs', async () => {
    const html = await assemblePestInsiderNewsletter({
      ...baseDraft,
      heroImageUrl: 'javascript:alert(1)',
    });
    expect(html).not.toContain('javascript:');
  });

  test('P.S. label never doubles when the model writes the prefix itself', async () => {
    const html = await assemblePestInsiderNewsletter({
      ...baseDraft,
      ps: 'P.S. Forward this to the friend who attracts every mosquito.',
    });
    expect(html).toContain('<strong>P.S.</strong>');
    expect(html.match(/P\.S\./g)).toHaveLength(1);
  });

  test('escapes injected markup in ID-card content', async () => {
    const html = await assemblePestInsiderNewsletter({
      ...baseDraft,
      pestOfMonth: {
        ...baseDraft.pestOfMonth,
        name: 'Bad <script>x</script>',
        diyTip: '<img src=x onerror="steal()">',
      },
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('onerror="steal()"');
    expect(html).toContain('&lt;script&gt;');
  });

  test('exactly one referral link and one tel CTA — the single-CTA discipline', async () => {
    const html = await assemblePestInsiderNewsletter({ ...baseDraft });
    expect(html.match(/referral\//g)).toHaveLength(1);
    expect(html.match(/href="tel:/g)).toHaveLength(1);
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

describe('pest-insider cron guards', () => {
  test('isFirstTuesdayET: first Tuesday yes; second Tuesday and other weekdays no', () => {
    expect(isFirstTuesdayET(new Date('2026-06-02T11:05:00Z'))).toBe(true);  // Tue Jun 2, 7:05am ET
    expect(isFirstTuesdayET(new Date('2026-06-09T11:05:00Z'))).toBe(false); // Tue Jun 9 (second)
    expect(isFirstTuesdayET(new Date('2026-06-03T11:05:00Z'))).toBe(false); // Wed Jun 3
    expect(isFirstTuesdayET(new Date('2026-12-01T12:00:00Z'))).toBe(true);  // Tue Dec 1
  });

  test('etMonthBounds spans the ET month, including the December rollover', () => {
    const june = etMonthBounds(new Date('2026-06-15T12:00:00Z'));
    expect(june.start.getTime()).toBeLessThan(new Date('2026-06-15T12:00:00Z').getTime());
    expect(june.end.getTime()).toBeGreaterThan(new Date('2026-06-30T12:00:00Z').getTime());
    const dec = etMonthBounds(new Date('2026-12-15T12:00:00Z'));
    expect(dec.end.toISOString()).toBe(new Date('2027-01-01T05:00:00Z').toISOString()); // ET midnight Jan 1 = 05:00Z
  });
});
