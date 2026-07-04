const Studio = require('../services/social-content-studio');
const SocialMediaService = require('../services/social-media');

// Live failure 2026-07-03: a Venice-targeted Facebook post opened "around
// Venice" then said "Your Sarasota lawn" — a Sarasota blog post won the
// campaign content search and its copy leaked into the fact pack. These tests
// pin the grounding at every layer: fact selection, the AI-draft merge guard,
// and the row-level content filter.

const venueContext = (overrides = {}) => ({
  location: { city: 'Venice', id: 'venice', name: 'Venice' },
  services: [{
    name: 'Lawn Care',
    short_name: 'Lawn',
    description: 'St. Augustine lawns brown out fast when chinch bugs feed at the blade base.',
  }],
  content: [{
    title: 'Your Sarasota lawn after the rain',
    meta_description: 'Your Sarasota lawn is showing fungus pressure after this week of rain.',
  }],
  recentSocials: [],
  pestPressure: null,
  reviews: [],
  competitorPatterns: Studio.DEFAULT_COMPETITOR_PATTERNS,
  ...overrides,
});

const venueInput = {
  topic: 'lawn fungus after rain',
  city: 'Venice',
  service: 'lawn care',
  angle: 'what we are seeing',
  cta: 'book a lawn check',
  channels: ['facebook', 'gbp'],
};

describe('city grounding', () => {
  test('mentionsOtherCity flags cross-city text, passes same-city and cityless text', () => {
    expect(Studio.mentionsOtherCity('Your Sarasota lawn is under attack.', 'Venice')).toBe(true);
    expect(Studio.mentionsOtherCity('Venice homeowners: check the lanai first.', 'Venice')).toBe(false);
    expect(Studio.mentionsOtherCity('Chinch bugs feed at the blade base.', 'Venice')).toBe(false);
    // Same office (Venice) but a different city name still reads wrong-city.
    expect(Studio.mentionsOtherCity('North Port lawns are browning out.', 'Venice')).toBe(true);
    // Punctuation/possessives around the name still match.
    expect(Studio.mentionsOtherCity("Bradenton's rainy week is back.", 'Venice')).toBe(true);
  });

  test('nested city names resolve to the longest match ("Bradenton Beach" is not foreign "Bradenton")', () => {
    expect(Studio.mentionsOtherCity('Bradenton Beach homeowners: check under the dock lights.', 'Bradenton Beach')).toBe(false);
    expect(Studio.mentionsOtherCity('Bradenton Beach homeowners: check under the dock lights.', 'Venice')).toBe(true);
    // Both cities genuinely present still counts as a foreign mention.
    expect(Studio.mentionsOtherCity('From Bradenton out to Bradenton Beach, ants are moving in.', 'Bradenton Beach')).toBe(true);
  });

  test('hashtag city forms are city mentions (#sarasotafl, #lakewoodranch)', () => {
    expect(Studio.mentionsOtherCity('Storm week again. #sarasotafl #lawncare', 'Venice')).toBe(true);
    expect(Studio.mentionsOtherCity('Storm week again. #lakewoodranch', 'Venice')).toBe(true);
    expect(Studio.mentionsOtherCity('Storm week again. #venicefl #lawncare', 'Venice')).toBe(false);
    expect(Studio.mentionsOtherCity('Dump standing water. #northport', 'North Port')).toBe(false);
  });

  test('Florida vernacular is not a city mention', () => {
    expect(Studio.mentionsOtherCity('Palmetto bugs love a humid garage.', 'Venice')).toBe(false);
    expect(Studio.mentionsOtherCity('Saw palmetto and laurel oaks shade the beds.', 'Venice')).toBe(false);
    // The actual city of Palmetto still counts.
    expect(Studio.mentionsOtherCity('Palmetto homeowners: swarm season is here.', 'Venice')).toBe(true);
  });

  test('contentRowMatchesCity keeps same-city, untagged, and region rows; drops cross-city rows', () => {
    expect(Studio.contentRowMatchesCity({ city: 'Sarasota' }, 'Venice')).toBe(false);
    expect(Studio.contentRowMatchesCity({ city: 'venice' }, 'Venice')).toBe(true);
    expect(Studio.contentRowMatchesCity({ city: null }, 'Venice')).toBe(true);
    expect(Studio.contentRowMatchesCity({ city: 'Southwest Florida' }, 'Venice')).toBe(true);
    expect(Studio.contentRowMatchesCity({ city: 'Sarasota' }, '')).toBe(true);
  });

  test('untagged rows whose text names another city are dropped (suggestedLink reads the row, not the fact)', () => {
    expect(Studio.contentRowMatchesCity({ city: null, title: 'Your Sarasota lawn after the rain' }, 'Venice')).toBe(false);
    expect(Studio.contentRowMatchesCity({ city: null, title: 'Chinch bug basics', slug: 'sarasota-lawn-fungus' }, 'Venice')).toBe(false);
    expect(Studio.contentRowMatchesCity({ city: 'Southwest Florida', meta_description: 'Bradenton lawns brown out in July.' }, 'Venice')).toBe(false);
    expect(Studio.contentRowMatchesCity({ city: null, title: 'Chinch bug basics for Florida lawns', slug: 'chinch-bug-basics' }, 'Venice')).toBe(true);
    expect(Studio.contentRowMatchesCity({ city: null, title: 'Venice lawn fungus after the rain', slug: 'venice-lawn-fungus' }, 'Venice')).toBe(true);
  });

  test('campaign fact pack and template drafts drop cross-city facts (07-03 bug shape)', () => {
    const context = venueContext();
    const facts = Studio.campaignFactPack(context, venueInput);
    expect(facts).not.toMatch(/sarasota/i);
    expect(facts).toMatch(/chinch bugs/i);

    const drafts = Studio.buildCampaignDrafts(venueInput, context);
    expect(drafts.facebook).not.toMatch(/sarasota/i);
    expect(drafts.facebook).toMatch(/venice/i);
    expect(drafts.gbp).not.toMatch(/sarasota/i);
  });

  test('cross-city review text is dropped from facts even though reviews are location-filtered', () => {
    const context = venueContext({
      content: [],
      reviews: [{ review_text: 'They treated our Bradenton home the same week we called. Great crew.' }],
    });
    const facts = Studio.campaignFactPack(context, venueInput);
    expect(facts).not.toMatch(/bradenton/i);
  });

  test('a cross-city AI draft falls back to the template; clean AI drafts are kept', async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const spy = jest.spyOn(SocialMediaService, 'generateCampaignDrafts').mockResolvedValue({
      facebook: 'Around Venice, storms are back. Your Sarasota lawn is telling you something.',
      gbp: 'Venice homeowners: fungus moves fast after a wet week. Book a lawn check.',
    });
    try {
      const out = await Studio.buildCampaignDraftsAI(venueInput, venueContext());
      expect(out.facebook).not.toMatch(/sarasota/i); // template fallback
      expect(out.facebook).toMatch(/venice/i);
      expect(out.gbp).toBe('Venice homeowners: fungus moves fast after a wet week. Book a lawn check.');
    } finally {
      spy.mockRestore();
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });
});
