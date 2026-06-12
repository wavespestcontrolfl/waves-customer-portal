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
    expect(prompt).toContain('LAWN CORNER BEAT: chinch bugs starting');
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
