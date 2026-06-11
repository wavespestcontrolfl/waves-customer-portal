/**
 * Pest Insider (monthly) — humor-sandwich newsletter type.
 * Pure pieces: prompt construction, sanitization, assembly, and the
 * first-Tuesday/month-bounds cron guards.
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

  test('encodes the humor-sandwich structure and this month\'s featured service', () => {
    expect(prompt).toContain('humor-sandwich');
    expect(prompt).toContain('THIS MONTH\'S FEATURED SERVICE: mosquito treatment');
    expect(prompt).toContain('The pitch section is SINCERE');
    expect(prompt).toContain('Edutainment facts');
  });

  test('carries the hard rules: no prices, no invented tech, no efficacy claims, biological urgency', () => {
    expect(prompt).toContain('NO dollar amounts');
    expect(prompt).toContain('NO invented technology names');
    expect(prompt).toContain('never "pet-safe"');
    expect(prompt).toContain('seasonal/biological only');
  });

  test('rotation covers all 12 months and unknown months fall back', () => {
    expect(Object.keys(PEST_INSIDER_ROTATION)).toHaveLength(12);
    expect(buildPestInsiderSystemPrompt(voice, 'Smarch')).toContain('general home pest defense');
  });
});

describe('pest-insider sanitizePestInsiderDraft', () => {
  test('strips URLs from prose and structured items; drops emptied items', () => {
    const draft = sanitizePestInsiderDraft({
      introText: 'Read more at https://evil.example now',
      facts: [
        { title: 'Only Females Bite', text: 'See https://spam.example for proof' },
        { title: '', text: '' },
        'not-an-object',
      ],
      pitchBullets: [{ title: 'Stops the Cycle', text: 'IGR prevents larvae.' }],
    });
    expect(draft.introText).not.toContain('evil.example');
    expect(draft.facts).toHaveLength(1);
    expect(draft.facts[0].text).not.toContain('spam.example');
    expect(draft.pitchBullets).toEqual([{ title: 'Stops the Cycle', text: 'IGR prevents larvae.' }]);
  });

  test('non-array facts/pitchBullets normalize to empty arrays', () => {
    const draft = sanitizePestInsiderDraft({ facts: 'nope', pitchBullets: null });
    expect(draft.facts).toEqual([]);
    expect(draft.pitchBullets).toEqual([]);
  });
});

describe('pest-insider assemblePestInsiderNewsletter', () => {
  const baseDraft = {
    greeting: 'Hey there!',
    introText: 'Mosquito season is **coming**.',
    factsHeading: '🦟 Alright, Let\'s Talk About Mosquitoes',
    factsIntro: 'Buckle up.',
    facts: [{ title: 'Only Females Bite', text: 'That mosquito? _Probably a mom-to-be._' }],
    pitchHeading: '✈️ Turn Your Yard Into a No-Fly Zone',
    pitchIntro: 'Here\'s what we do about it.',
    pitchBullets: [{ title: 'Stops the Cycle', text: 'Growth regulation prevents the next generation.' }],
    closingHeading: '😎 Want Your Backyard Back?',
    closingText: 'Backyards are for BBQs.',
    ctaLine: 'Let\'s make mosquitoes a problem of the past —',
    ps: 'Forward this to the friend who attracts every mosquito at the bonfire.',
  };

  test('renders the full sandwich: TOC, ✔ facts, 🔹 pitch, tel CTA, Team sign-off, P.S.', async () => {
    const html = await assemblePestInsiderNewsletter({ ...baseDraft });
    expect(html).toContain('In this email:');
    expect(html).toContain('#pi-facts');
    expect(html).toContain('✔ <strong>Only Females Bite</strong>');
    expect(html).toContain('🔹 <strong>Stops the Cycle</strong>');
    expect(html).toContain('href="tel:');
    expect(html).toContain('(941) 297-5749');
    expect(html).toContain('— The Waves Pest Control Team');
    expect(html).toContain('<strong>P.S.</strong>');
  });

  test('escapes injected markup in fact content', async () => {
    const html = await assemblePestInsiderNewsletter({
      ...baseDraft,
      facts: [{ title: 'Bad <script>x</script>', text: '<img src=x onerror="steal()">' }],
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('onerror="steal()"');
    expect(html).toContain('&lt;script&gt;');
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
