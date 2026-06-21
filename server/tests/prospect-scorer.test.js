const scorer = require('../services/seo/prospect-scorer');

const KEY = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; }); // force deterministic heuristic path
afterEach(() => { if (KEY === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = KEY; });

describe('heuristicClassify', () => {
  test('local realtor → Tier 1, local, trade-relevant', () => {
    const c = scorer.heuristicClassify({ domain: 'sarasotarealty.com', source_url: 'https://sarasotarealty.com/preferred-vendors' });
    expect(c.lead_value_tier).toBe(1);
    expect(c.is_local_swfl).toBe(true);
    expect(c.relevance_0_100).toBeGreaterThanOrEqual(70);
  });

  test('HARO platform flagged', () => {
    const c = scorer.heuristicClassify({ domain: 'helpareporter.com' });
    expect(c.is_haro_platform).toBe(true);
  });

  test('national directory → low tier', () => {
    const c = scorer.heuristicClassify({ domain: 'clutch.co' });
    expect(c.intent_class).toBe('directory');
    expect(c.lead_value_tier).toBe(4);
  });
});

describe('contactGate', () => {
  test('outreach intent with no contact path is gated out', () => {
    const g = scorer.contactGate({ intent_class: 'editorial', is_haro_platform: false }, { has_contact_path: false });
    expect(g.ok).toBe(false);
  });
  test('outreach intent WITH contact passes', () => {
    const g = scorer.contactGate({ intent_class: 'resource', is_haro_platform: false }, { has_contact_path: true });
    expect(g.ok).toBe(true);
    expect(g.lane).toBe('outreach');
  });
  test('signup intents are exempt (no contact needed)', () => {
    const g = scorer.contactGate({ intent_class: 'directory', is_haro_platform: false }, null);
    expect(g.ok).toBe(true);
    expect(g.lane).toBe('signup');
  });
  test('HARO platform → flagged lane, not email', () => {
    const g = scorer.contactGate({ intent_class: 'haro', is_haro_platform: true }, null);
    expect(g.lane).toBe('haro_platform');
  });
});

describe('scoreProspect composite', () => {
  const cls = (o) => ({ intent_class: 'resource', relevance_0_100: 80, is_local_swfl: true, lead_value_tier: 1, is_haro_platform: false, target_topic: 'wdo', ...o });
  test('local + contactable + relevant scores high', () => {
    const s = scorer.scoreProspect({ domain_rating: 35 }, cls(), { has_contact_path: true, contact_email: 'a@b.com' });
    expect(s.score).toBeGreaterThanOrEqual(68);
    expect(s.priority).toBe('high');
    expect(s.tier).toBe(1);
  });
  test('coerces a non-claimable intent (unknown) to a worker-claimable type', () => {
    const s = scorer.scoreProspect({ domain_rating: 30 }, cls({ intent_class: 'unknown' }), { has_contact_path: true, contact_email: 'a@b.com' });
    expect(['editorial', 'resource', 'guest_post', 'haro', 'directory', 'citation', 'social']).toContain(s.intent_class);
    expect(s.intent_class).toBe('resource'); // contactable outreach default
    expect(s.raw_intent_class).toBe('unknown');
  });

  test('high-DR national directory scores BELOW a relevant local partner', () => {
    const local = scorer.scoreProspect({ domain_rating: 25 }, cls(), { has_contact_path: true, contact_email: 'a@b.com' });
    const natl = scorer.scoreProspect({ domain_rating: 90 }, cls({ intent_class: 'directory', relevance_0_100: 25, is_local_swfl: false, lead_value_tier: 4 }), null);
    expect(local.score).toBeGreaterThan(natl.score); // relevance beats raw DR — the whole point
  });
});

describe('scoreCandidates (end-to-end, heuristic + injected contact)', () => {
  test('classifies, contact-finds non-exempt, gates, and scores', async () => {
    const findContactFn = async (domain) => ({
      domain, has_contact_path: domain === 'localpartner.com',
      contact_email: domain === 'localpartner.com' ? 'editor@localpartner.com' : null, contact_url: null,
    });
    const out = await scorer.scoreCandidates([
      { domain: 'sarasota-realty.com', domain_rating: 30, source_url: 'https://sarasota-realty.com/partners' },
      { domain: 'clutch.co', domain_rating: 88 },
    ], { anthropic: null, findContactFn });
    expect(out).toHaveLength(2);
    expect(out[1].intent_class).toBe('directory');
    expect(out[1].gate.lane).toBe('signup'); // directory exempt, no contact fetch needed
  });
});

describe('classifyBatch LLM path', () => {
  test('parses a JSON array from the model and maps by index', async () => {
    const fakeAnthropic = {
      messages: {
        create: async () => ({
          content: [{ text: '[{"i":0,"domain":"realtorx.com","intent_class":"resource","relevance_0_100":85,"is_local_swfl":true,"lead_value_tier":1,"is_haro_platform":false,"target_topic":"wdo","suggested_anchor":"WDO inspection","reason":"local realtor"}]' }],
        }),
      },
    };
    const [c] = await scorer.classifyBatch([{ domain: 'realtorx.com' }], { anthropic: fakeAnthropic });
    expect(c.intent_class).toBe('resource');
    expect(c.lead_value_tier).toBe(1);
    expect(c.target_topic).toBe('wdo');
  });

  test('falls back to heuristic when the model errors', async () => {
    const boom = { messages: { create: async () => { throw new Error('500'); } } };
    const [c] = await scorer.classifyBatch([{ domain: 'helpareporter.com' }], { anthropic: boom });
    expect(c.reason).toBe('heuristic');
    expect(c.is_haro_platform).toBe(true);
  });
});
