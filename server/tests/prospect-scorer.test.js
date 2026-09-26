// Keep the real ledgerCall (GATE_LLM_CALL_LEDGER is unset in tests, so it's
// already a real no-DB no-op) but spy on ledgerCallRejected so the malformed-
// relevance tests below can assert the ledger row gets flipped.
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const scorer = require('../services/seo/prospect-scorer');
const { ledgerCallRejected } = require('../services/llm-dispatch-metrics');

const KEY = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY; // force deterministic heuristic path
  ledgerCallRejected.mockClear();
});
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

  test('exact host match — phoenix.com is NOT social, x.com is', () => {
    expect(scorer.classifyLinkType('phoenix.com', '')).not.toBe('social');
    expect(scorer.classifyLinkType('matrix.com', '')).not.toBe('social');
    expect(scorer.classifyLinkType('x.com', '')).toBe('social');
    expect(scorer.classifyLinkType('m.facebook.com', '')).toBe('social'); // subdomain still matches
  });
});

describe('lead_value_tier handling', () => {
  const base = (o) => ({ intent_class: 'editorial', relevance_0_100: 30, ...o });
  test('explicit 0 stays at baseline tier 5 (not promoted to intent tier 2)', () => {
    expect(scorer.scoreProspect({ domain_rating: 50 }, base({ lead_value_tier: 0 }), { has_contact_path: true, contact_email: 'a@b.com' }).tier).toBe(5);
  });
  test('missing tier falls back to the intent-implied tier', () => {
    expect(scorer.scoreProspect({ domain_rating: 50 }, base({}), { has_contact_path: true }).tier).toBe(2);
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
  test('non-platform HARO opportunity goes down the outreach lane (not dropped)', () => {
    const g = scorer.contactGate({ intent_class: 'haro', is_haro_platform: false }, { has_contact_path: true });
    expect(g.ok).toBe(true);
    expect(g.lane).toBe('outreach');
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

// Codex r13 on #4884: the mapper coerced every field but the two the
// validator checked — `!!"false"` read as true and could put a prospect in the
// HARO lane, and Number(""/false/[]) made an explicit tier 0. Every consumed
// field now goes through parseClassifiedEntry: parseable forms are read
// correctly, an absent field keeps its designed default, and a present
// off-contract value keeps that default AND fails the ledger row.
describe('classifyBatch — every consumed field is parsed, not coerced (Codex r13 on #4884)', () => {
  const VALID = { i: 0, domain: 'x.com', intent_class: 'editorial', relevance_0_100: 80, is_local_swfl: true, lead_value_tier: 2, is_haro_platform: false, target_topic: 'pest', suggested_anchor: 'pest tips', reason: 'local blog' };
  const run = async (extra) => {
    const fake = { messages: { create: async () => ({ content: [{ text: JSON.stringify([{ ...VALID, ...extra }]) }] }) } };
    const [c] = await scorer.classifyBatch([{ domain: 'x.com' }], { anthropic: fake });
    return c;
  };

  test('a fully conforming entry is used as-is and not flagged', async () => {
    const c = await run({});
    expect(c).toMatchObject({ intent_class: 'editorial', relevance_0_100: 80, is_local_swfl: true, lead_value_tier: 2, is_haro_platform: false, target_topic: 'pest', suggested_anchor: 'pest tips', reason: 'local blog' });
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  test('"false" strings read as false (not true) — the prospect stays out of the HARO lane — and are not flagged', async () => {
    const c = await run({ is_haro_platform: 'false', is_local_swfl: 'false' });
    expect(c.is_haro_platform).toBe(false);
    expect(c.is_local_swfl).toBe(false);
    expect(scorer.contactGate(c, { has_contact_path: true }).lane).not.toBe('haro_platform');
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  test('"true" strings read as true; absent booleans default to false without a flag', async () => {
    expect((await run({ is_local_swfl: 'TRUE' })).is_local_swfl).toBe(true);
    const { is_local_swfl, is_haro_platform, ...noBools } = VALID;
    const fake = { messages: { create: async () => ({ content: [{ text: JSON.stringify([noBools]) }] }) } };
    const [c] = await scorer.classifyBatch([{ domain: 'x.com' }], { anthropic: fake });
    expect(c.is_local_swfl).toBe(false);
    expect(c.is_haro_platform).toBe(false);
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  test('an unparseable boolean defaults to false and fails the row', async () => {
    const c = await run({ is_haro_platform: 'maybe' });
    expect(c.is_haro_platform).toBe(false);
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });

  test('a null tier stays undefined (intent fallback) without a flag; a numeric-string tier is read', async () => {
    expect((await run({ lead_value_tier: null })).lead_value_tier).toBeUndefined();
    expect((await run({ lead_value_tier: '3' })).lead_value_tier).toBe(3);
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  test.each([['empty string', ''], ['false', false], ['an array', []], ['out of range', 7], ['fractional', 2.5], ['a word', 'high']])(
    'a %s tier is off-contract: undefined (never an explicit 0), and the row fails', async (_label, tier) => {
      const c = await run({ lead_value_tier: tier });
      expect(c.lead_value_tier).toBeUndefined();
      expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
    },
  );

  test('an out-of-range relevance is clamped and fails the row', async () => {
    expect((await run({ relevance_0_100: 150 })).relevance_0_100).toBe(100);
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });

  test('an off-enum intent takes the heuristic intent and fails the row; a near-valid one is canonicalized without a flag', async () => {
    const c = await run({ intent_class: 'blog post' });
    expect(c.intent_class).toBe(scorer.classifyLinkType('x.com', undefined));
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
    ledgerCallRejected.mockClear();
    expect((await run({ intent_class: 'Guest-Post' })).intent_class).toBe('guest_post');
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  test('an off-enum topic falls back to general and fails the row', async () => {
    expect((await run({ target_topic: 'bees' })).target_topic).toBe('general');
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });

  test('a non-string anchor or reason is dropped and fails the row; the word "null" is just no anchor', async () => {
    expect((await run({ suggested_anchor: 42 })).suggested_anchor).toBeNull();
    expect(ledgerCallRejected).toHaveBeenCalledTimes(1);
    ledgerCallRejected.mockClear();
    expect((await run({ reason: { why: 'x' } })).reason).toBe('llm');
    expect(ledgerCallRejected).toHaveBeenCalledTimes(1);
    ledgerCallRejected.mockClear();
    expect((await run({ suggested_anchor: 'null' })).suggested_anchor).toBeNull();
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  test('an anchor longer than anchor_planned (varchar 255) is dropped and fails the row', async () => {
    expect((await run({ suggested_anchor: 'x'.repeat(256) })).suggested_anchor).toBeNull();
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
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

  test('normalizes a near-valid model intent (Directory / guest-post) instead of misrouting it', async () => {
    const fake = {
      messages: {
        create: async () => ({ content: [{ text: '[{"i":0,"domain":"listingsite.com","intent_class":"Directory","relevance_0_100":30,"is_local_swfl":false,"lead_value_tier":4,"target_topic":"Bogus"},{"i":1,"domain":"guestblog.com","intent_class":"guest-post","relevance_0_100":60,"is_local_swfl":true,"lead_value_tier":2,"target_topic":"WDO"}]' }] }),
      },
    };
    const [a, b] = await scorer.classifyBatch([{ domain: 'listingsite.com' }, { domain: 'guestblog.com' }], { anthropic: fake });
    expect(a.intent_class).toBe('directory'); // not coerced to resource → stays signup lane
    expect(a.target_topic).toBe('general');    // unknown topic → general
    expect(b.intent_class).toBe('guest_post');
    expect(b.target_topic).toBe('wdo');        // 'WDO' canonicalized → matches /wdo money page
  });

  test('a model response omitting lead_value_tier stays undefined → intent fallback (not tier 5)', async () => {
    const fake = {
      messages: { create: async () => ({ content: [{ text: '[{"i":0,"domain":"localnews.com","intent_class":"editorial","relevance_0_100":65,"is_local_swfl":true}]' }] }) },
    };
    const [c] = await scorer.classifyBatch([{ domain: 'localnews.com' }], { anthropic: fake });
    expect(c.lead_value_tier).toBeUndefined();
    expect(scorer.scoreProspect({ domain_rating: 40 }, c, { has_contact_path: true }).tier).toBe(2); // editorial intent fallback, not 5
  });

  test('falls back to heuristic when the model errors', async () => {
    const boom = { messages: { create: async () => { throw new Error('500'); } } };
    const [c] = await scorer.classifyBatch([{ domain: 'helpareporter.com' }], { anthropic: boom });
    expect(c.reason).toBe('heuristic');
    expect(c.is_haro_platform).toBe(true);
  });

  // Codex r8 on #4884: isClassifiedEntry used Number.isFinite(Number(x)), and
  // Number() coerces false/''/'   '/[] all to 0 (finite) — so a non-answer
  // for relevance_0_100 read as a real classification and was never sent to
  // the heuristic fallback or counted against the ledger.
  describe('relevance_0_100 must be an actual number, not anything Number() coerces to one (Codex r8 on #4884)', () => {
    const respondWith = (relevance) => ({
      messages: {
        create: async () => ({
          content: [{ text: JSON.stringify([{ i: 0, domain: 'x.com', intent_class: 'resource', relevance_0_100: relevance }]) }],
        }),
      },
    });

    test.each([
      ['false', false],
      ['empty string', ''],
      ['whitespace string', '   '],
      ['an array', []],
      ['null', null],
      ['non-numeric string', 'high'],
    ])('%s is rejected as not-a-real-number → heuristic fallback', async (_label, relevance) => {
      const [c] = await scorer.classifyBatch([{ domain: 'x.com' }], { anthropic: respondWith(relevance) });
      expect(c.reason).toBe('heuristic');
    });

    test.each([
      ['a plain number', 85],
      ['zero (falsy but a real number)', 0],
      ['a numeric string', '42'],
      ['a numeric string with surrounding whitespace', '  42.5 '],
    ])('%s is accepted as a real classification', async (_label, relevance) => {
      const [c] = await scorer.classifyBatch([{ domain: 'x.com' }], { anthropic: respondWith(relevance) });
      expect(c.reason).not.toBe('heuristic');
      expect(c.relevance_0_100).toBe(Math.max(0, Math.min(100, Number(relevance))));
    });

    test('a chunk where every entry is a non-answer is recorded as a ledger failure', async () => {
      const [c] = await scorer.classifyBatch([{ domain: 'x.com' }], { anthropic: respondWith('') });
      expect(c.reason).toBe('heuristic');
      expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
    });

    test('a partially classified chunk (one real hit + junk) is flagged — the heuristic filled part of it', async () => {
      const fake = {
        messages: {
          create: async () => ({
            content: [{
              text: JSON.stringify([
                { i: 0, domain: 'x.com', intent_class: 'resource', relevance_0_100: '' },
                { i: 1, domain: 'y.com', intent_class: 'editorial', relevance_0_100: 70 },
              ]),
            }],
          }),
        },
      };
      const [a, b] = await scorer.classifyBatch([{ domain: 'x.com' }, { domain: 'y.com' }], { anthropic: fake });
      expect(a.reason).toBe('heuristic');
      expect(b.reason).not.toBe('heuristic');
      expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
    });

    test('a fully classified chunk is NOT flagged', async () => {
      const fake = {
        messages: {
          create: async () => ({
            content: [{
              text: JSON.stringify([
                { i: 0, domain: 'x.com', intent_class: 'resource', relevance_0_100: 40 },
                { i: 1, domain: 'y.com', intent_class: 'editorial', relevance_0_100: 70 },
              ]),
            }],
          }),
        },
      };
      const [a, b] = await scorer.classifyBatch([{ domain: 'x.com' }, { domain: 'y.com' }], { anthropic: fake });
      expect(a.reason).not.toBe('heuristic');
      expect(b.reason).not.toBe('heuristic');
      expect(ledgerCallRejected).not.toHaveBeenCalled();
    });
  });
});
