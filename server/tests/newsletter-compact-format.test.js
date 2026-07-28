/**
 * Compact flagship format (owner spec 2026-07-28): one hero + compact
 * cards, official names lead, DB-locked facts, Community Notes cap,
 * reaction footer, and the listwise re-rank pure pieces.
 */

const {
  assembleWavesNewsletter,
  deriveEventLabels,
} = require('../services/newsletter-draft');
const {
  parseListwiseRanking,
  applyListwiseNudges,
  listwiseRerankEnabled,
} = require('../services/newsletter-autopilot');
const { validateNewsletterDraft } = require('../services/newsletter-validator');

const HERO = {
  isHero: true,
  eventId: '11111111-1111-4111-8111-111111111111',
  sourceTitle: 'Inaugural Racer and Creator Expo',
  hook: 'The first-ever RACE expo lands in Palmetto with creator meet-and-greets and sponsor builds.',
  heroWhy: 'First-year event with national-name creators.',
  dateStr: 'Friday, July 31',
  timeStr: '11:00 AM',
  location: 'Bradenton Area Convention Center, Palmetto',
  eventUrl: 'https://tickets.example/race',
  imageUrl: 'https://img.example/race.jpg',
  labels: ['Family'],
};

const CARD = {
  eventId: '22222222-2222-4222-8222-222222222222',
  sourceTitle: 'Forgotten Broadway',
  hook: 'Improvisers invent an entire fake Broadway legend from your suggestions — two nights only.',
  dateStr: 'Friday, July 31',
  timeStr: '7:30 PM',
  location: 'Bowne’s Lab Theatre, Sarasota',
  eventUrl: 'https://tickets.example/broadway',
  labels: ["Parents' night"],
};

function draftFixture(overrides = {}) {
  return {
    greeting: 'Hey there!',
    introText: 'An inaugural racer expo and improvised Broadway lead the week.',
    events: [HERO, CARD],
    communityNotes: ['Back-to-School Fair — Sat, Aug 1, Citrus Park Town Center.'],
    homeownerMinute: 'Back-to-school season is also big-ant season — rinse recycling and wipe counters.',
    closingText: 'Heavy on Saturday, light on excuses.',
    signoff: '— The Waves Team',
    ...overrides,
  };
}

describe('assembleWavesNewsletter (compact format)', () => {
  test('official names lead, hero box + why-line render, facts are DB-locked fields', async () => {
    const html = await assembleWavesNewsletter(draftFixture());
    expect(html).toContain("This week's top pick");
    expect(html).toContain('Inaugural Racer and Creator Expo');
    expect(html).toContain('Why it made the cut:');
    expect(html).toContain('Forgotten Broadway');
    expect(html).toContain('Friday, July 31');
    expect(html).toContain('Community notes');
    expect(html).toContain('Homeowner Minute');
    expect(html).toContain('— The Waves Team');
    expect(html).toContain('{{feedback}}');
    // The retired devices are gone.
    expect(html).not.toContain('In this email');
    expect(html).not.toContain('Mood:');
    expect(html).not.toContain('Pro tip');
    expect(html).not.toContain('giphy');
  });

  test('community notes cap at two and empty notes render no box', async () => {
    const three = await assembleWavesNewsletter(draftFixture({
      communityNotes: ['one', 'two', 'three'],
    }));
    expect((three.match(/•/g) || []).length).toBe(2);
    const none = await assembleWavesNewsletter(draftFixture({ communityNotes: null }));
    expect(none).not.toContain('Community notes');
  });

  test('the compact body passes the flagship claim validator with no dollar amounts', async () => {
    const html = await assembleWavesNewsletter(draftFixture());
    const { errors } = validateNewsletterDraft({
      subject: '🏁 Race Cars & Improvised Broadway',
      html_body: html,
      text_body: html.replace(/<[^>]+>/g, ' '),
      newsletter_type: 'local-weekly-fresh-events',
      preview_text: 'x',
    }, { recipientCount: 100 });
    expect(errors).toEqual([]);
  });
});

describe('deriveEventLabels (DB-derived, never model prose)', () => {
  test('derives Family / Parents-night / Free / Worth the drive from row fields', () => {
    expect(deriveEventLabels({ family_friendly: true })).toContain('Family');
    expect(deriveEventLabels({ score_breakdown: { family_status: 'confirmed' } })).toContain('Family');
    expect(deriveEventLabels({ audience_tags: ['parents_night'] })).toContain("Parents' night");
    expect(deriveEventLabels({ is_free: true })).toContain('Free');
    expect(deriveEventLabels({ audience_tags: ['worth_the_drive'] })).toContain('Worth the drive');
    expect(deriveEventLabels({ audience_tags: '["free"]' })).toContain('Free');
    expect(deriveEventLabels({})).toEqual([]);
  });
});

describe('listwise re-rank pure pieces', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const scored = [
    { id: 'a', editorial_score: 90, admin_status: 'approved' },
    { id: 'b', editorial_score: 85, admin_status: 'approved' },
    { id: 'c', editorial_score: 80, admin_status: 'approved' },
    { id: 'd', editorial_score: 76, admin_status: 'approved' },
  ];

  afterEach(() => { delete process.env.NEWSLETTER_LISTWISE_RERANK; });

  test('parse drops unknown/duplicate ids and tolerates prose', () => {
    const text = `Here: {"ranking": ["c", "zz", "a", "a", "b"]}`;
    expect(parseListwiseRanking(text, ids)).toEqual(['c', 'a', 'b']);
    expect(parseListwiseRanking('no json', ids)).toEqual([]);
  });

  test('nudges are bounded ±3, never cross the floor, and stars are untouched', () => {
    // Model says d is MOST disappointing (rank 0), a least (rank 3).
    const out = applyListwiseNudges(scored, ['d', 'c', 'b', 'a']);
    const byId = Object.fromEntries(out.map((e) => [e.id, e]));
    expect(byId.d.editorial_score).toBeGreaterThan(76);
    expect(byId.a.editorial_score).toBeLessThan(90);
    expect(byId.a.editorial_score).toBeGreaterThanOrEqual(75);
    for (const e of out) {
      expect(Math.abs((e.listwiseNudge || 0))).toBeLessThanOrEqual(3);
    }
    const starred = applyListwiseNudges(
      [{ id: 'a', editorial_score: 90, admin_status: 'featured' }],
      ['a'],
    );
    expect(starred[0].editorial_score).toBe(90);
    expect(starred[0].listwiseNudge).toBeUndefined();
  });

  test('kill switch: only the literal string false disables', () => {
    expect(listwiseRerankEnabled()).toBe(true);
    process.env.NEWSLETTER_LISTWISE_RERANK = 'false';
    expect(listwiseRerankEnabled()).toBe(false);
  });
});

describe('free-label parity with the portfolio classifier', () => {
  test('price_text free/$0 forms earn the Free label like the selector', () => {
    expect(deriveEventLabels({ price_text: 'Free with registration' })).toContain('Free');
    expect(deriveEventLabels({ price_text: '$0.00' })).toContain('Free');
    expect(deriveEventLabels({ price_text: 'Kids $0, adults $25' })).not.toContain('Free');
    expect(deriveEventLabels({ price_text: '$25' })).not.toContain('Free');
  });
});

describe('owner v2 polish (2026-07-28 evening)', () => {
  test('standard cards render the DB-locked event thumbnail when present', async () => {
    const withThumb = await assembleWavesNewsletter(draftFixture({
      events: [HERO, { ...CARD, imageUrl: 'https://img.example/broadway.jpg' }],
    }));
    expect(withThumb).toContain('https://img.example/broadway.jpg');
    const withoutThumb = await assembleWavesNewsletter(draftFixture());
    expect(withoutThumb).not.toContain('img.example/broadway');
  });
});
