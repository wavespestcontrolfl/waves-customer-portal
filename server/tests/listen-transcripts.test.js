/**
 * ops/agents/listen-transcripts.js — privacy + targeting contract.
 *
 * The script mines the operator's own session transcripts. Three things
 * must hold or the lane leaks: tool results / thinking never reach the LLM,
 * pii-redactor runs before dispatch, and the topic-targeting rulings drop
 * ideas the model should not have produced.
 */
const path = require('path');

const { _internals } = require('../../ops/agents/listen-transcripts');
const { redact } = require('../services/content/pii-redactor');

const FIX = (f) => path.join(__dirname, 'fixtures', f);

describe('transcript readers', () => {
  test('claude: keeps prose turns only — no tool_result, tool_use, thinking or system-reminder text', () => {
    const turns = _internals.readClaudeTranscript(FIX('listen-claude-session.jsonl'));
    const joined = turns.map((t) => t.text).join('\n');
    expect(turns).toHaveLength(2);
    expect(joined).toContain('brown patches');
    expect(joined).toContain('gray leaf spot');
    expect(joined).not.toContain('Bob Smith');        // tool_result row
    expect(joined).not.toContain('4111');             // thinking block
    expect(joined).not.toContain('select * from');    // tool_use input
    expect(joined).not.toContain('system-reminder');
  });

  test('codex: user + assistant + agent_message only, developer instructions skipped', () => {
    const turns = _internals.readCodexTranscript(FIX('listen-codex-session.jsonl'));
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns.map((t) => t.text).join(' ')).not.toContain('You are Codex');
  });
});

describe('redaction before dispatch', () => {
  test('a turn the redactor cannot tokenise with confidence is withheld whole', () => {
    const turns = [{ role: 'user', text: 'customer john smith at the palm ave house said the lawn browned after rain' }];
    const { chunks, stats } = _internals.redactedChunks([{ turns }], { redact });
    expect(redact(turns[0].text).confidence).toBe('low');
    expect(stats.withheld).toBe(1);
    expect(chunks.join('')).not.toContain('john smith');
  });

  test('a turn carrying a credential the redactor does not know is withheld whole', () => {
    const turns = [
      { role: 'user', text: 'Here is the env: STRIPE_SECRET_KEY=sk_live_51Habcdefghijklmnop and it still 500s' },
      { role: 'user', text: 'Auth header was Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefGHIJKL' },
      { role: 'assistant', text: 'Gray Leaf Spot on St. Augustine lawns in Sarasota after the fertilizer week.' },
    ];
    const { chunks, stats } = _internals.redactedChunks([{ turns }], { redact });
    expect(stats.withheld).toBe(2);
    expect(chunks.join('')).not.toMatch(/sk_live|eyJ/);
    expect(chunks.join('')).toContain('Gray Leaf Spot');
    expect(_internals.containsSecret('DATABASE_URL=postgres://u:p@host/db')).toBe(true);
    expect(_internals.containsSecret('the lawn needs 1 inch of water')).toBe(false);
  });

  test('the chunk cap keeps the newest chunks of the newest source', () => {
    const big = (tag, n) => Array.from({ length: n }, (_, i) => ({ role: 'user', text: `Turn ${tag}-${i} ` + 'Lawn note. '.repeat(1200) }));
    const { chunks, truncated } = _internals.redactedChunks([{ turns: big('new', 40) }, { turns: big('old', 40) }], { redact });
    expect(truncated).toBe(true);
    expect(chunks.length).toBe(20);
    expect(chunks[0]).toContain('Turn new-39');
    expect(chunks.every((c) => c.includes('Turn new-'))).toBe(true);
  });

  test('phone, email, address and name from the fixture never reach the LLM payload', async () => {
    const sources = [{ file: 'x', kind: 'claude', turns: _internals.readClaudeTranscript(FIX('listen-claude-session.jsonl')) }];
    const { chunks, stats } = _internals.redactedChunks(sources, { redact });
    const dispatch = jest.fn(async () => ({ ok: true, json: { ideas: [] } }));
    await _internals.extractIdeas(chunks, { dispatch, policy: { name: 'fastStructured' } });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const sent = dispatch.mock.calls[0][1].text;
    expect(sent).not.toMatch(/941-555-0142/);
    expect(sent).not.toMatch(/jane@example\.com/);
    expect(sent).not.toMatch(/123 Palm Ave/);
    expect(sent).not.toMatch(/Jane Doe/);
    expect(sent).toContain('[phone]');
    expect(sent).toContain('[email]');
    expect(stats.findings.phone).toBeGreaterThan(0);
    expect(stats.withheld).toBe(0);
    expect(stats.findings.email).toBeGreaterThan(0);
    // The business insight survives redaction.
    expect(sent).toContain('brown patches');
  });
});

describe('seed-time re-gating', () => {
  test('ideaFromBrief round-trips so an edited manifest is judged by the same predicate', () => {
    const good = _internals.briefFor({ working_title: 'Sarasota chinch bug season', slug: '/lawn-care/chinch-bugs-sarasota-fl/', city: 'Sarasota', primary_kw: 'chinch bugs sarasota', secondary_kws: [], thesis: 't', outline: ['a'], sources: ['https://edis.ifas.ufl.edu/x'], confidence: 0.6 }, { now: new Date('2026-09-03T12:00:00Z') });
    expect(_internals.targetingViolation(_internals.ideaFromBrief(good))).toBeNull();
    expect(_internals.targetingViolation(_internals.ideaFromBrief({ ...good, working_title: 'Chinch bugs in Tampa' }))).toBe('out_of_footprint_geo');
    expect(_internals.targetingViolation(_internals.ideaFromBrief({ ...good, sources: ['https://randomblog.example.com'] }))).toBe('no_allowed_source');
  });
});

describe('model output shaping', () => {
  test('malformed entries are dropped individually; list fields coerced', () => {
    expect(_internals.shapeIdea(null)).toBeNull();
    expect(_internals.shapeIdea({ working_title: 'x', slug: '/lawn-care/x/', thesis: 't', outline: 'not an array' })).toBeNull();
    const ok = _internals.shapeIdea({ working_title: ' T ', slug: '/lawn-care/x/', thesis: 't', outline: ['a', 3, null], secondary_kws: { a: 1 }, sources: 'nope', confidence: '0.7' });
    expect(ok).toMatchObject({ working_title: 'T', outline: ['a'], secondary_kws: [], sources: [], confidence: 0.7 });
  });

  test('a manifest window after 8pm ET still lands on the ET calendar day', () => {
    const b = _internals.briefFor({ working_title: 'Late idea', slug: '/lawn-care/late/', thesis: 't', outline: ['a'], sources: ['https://edis.ifas.ufl.edu/x'], confidence: 0.5 }, { now: new Date('2026-09-04T01:30:00Z') }); // 21:30 ET on the 3rd
    expect(b.window).toBe('2026-09-03');
  });
});

describe('targeting filters', () => {
  const base = {
    working_title: 'Why Sarasota Lawns Brown After Summer Rain',
    slug: '/lawn-care/brown-patches-after-rain-sarasota-fl/',
    city: 'Sarasota',
    primary_kw: 'brown patches after rain sarasota',
    secondary_kws: ['gray leaf spot st augustine'],
    thesis: 'Fresh nitrogen plus a wet week invites gray leaf spot on St. Augustine turf.',
    outline: ['What homeowners see', 'Rain timing vs fertilizer'],
    sources: ['https://edis.ifas.ufl.edu/publication/LH044'],
    why_now: 'seasonal',
    evidence: 'rain after fertilizing',
    confidence: 0.8,
  };

  test('a compliant idea passes', () => {
    expect(_internals.targetingViolation(base)).toBeNull();
  });

  test.each([
    ['near_me_phrasing', { working_title: 'Lawn care near me in Sarasota' }],
    ['out_of_footprint_geo', { working_title: 'Brown patches in Tampa lawns', slug: '/lawn-care/brown-patches-tampa/', city: null }],
    ['out_of_footprint_geo', { working_title: 'Brown patches in Lakeland lawns', slug: '/lawn-care/brown-patches-lakeland/', city: null }],
    ['statewide_only', { working_title: 'Brown patches in Florida lawns', slug: '/lawn-care/brown-patches-florida/', city: null, thesis: 'Nitrogen plus rain invites fungus.', outline: ['What you see'], primary_kw: 'brown patches florida', secondary_kws: [] }],
    ['banned_topic', { outline: ['Why our door-to-door reps say this'] }],
    ['banned_topic', { thesis: 'We offer structural fumigation for drywood termites.' }],
    ['reentry_safety_claim', { thesis: 'Our pet-safe fungicide fixes it.' }],
    ['reentry_safety_claim', { thesis: 'This pesticide is completely safe for the whole family.' }],
    ['reentry_safety_claim', { outline: ['Re-entry is fine after 30 minutes of drying'] }],
    ['slug_prefix', { slug: '/blog/brown-patches/' }],
    ['no_allowed_source', { sources: ['https://randomblog.example.com/lawns'] }],
    ['no_allowed_source', { sources: ['Pull the current Wikipedia article on lawn fungus'] }],
    ['city_slug_mismatch', { city: 'Bradenton' }],
  ])('drops %s', (reason, patch) => {
    expect(_internals.targetingViolation({ ...base, ...patch })).toBe(reason);
  });

  test('buildManifest produces a category-seed manifest loadManifest accepts, dedupes titles, and keeps only redacted evidence', () => {
    const fs = require('fs');
    const os = require('os');
    const seeder = require('../services/content/category-seed-seeder');
    const now = new Date('2026-09-03T12:00:00Z');
    const { manifest, dropped } = _internals.buildManifest([
      base,
      { ...base, confidence: 0.5 },                                  // duplicate title → collapsed
      { ...base, working_title: 'Pet-safe sprays', slug: '/pest-control/pet-safe/', city: null, thesis: 'pet-safe', outline: ['x'] },
    ], { now });
    expect(manifest.set).toBe('session-listen');
    expect(manifest.briefs).toHaveLength(1);
    expect(dropped).toEqual([{ title: 'Pet-safe sprays', reason: 'reentry_safety_claim' }]);
    const b = manifest.briefs[0];
    expect(b.id).toMatch(/^listen-[0-9a-f]{10}$/);
    expect(b.action).toBe('new_supporting_blog');
    expect(b.byline).toBe('adam');
    expect(b.verify_notes.length).toBeGreaterThanOrEqual(3);
    expect(b.listen.confidence).toBe(0.8);
    expect(b.window).toBe('2026-09-03'); // 12:00Z = 08:00 ET, same day

    const tmp = path.join(os.tmpdir(), `listen-test-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(manifest));
    try {
      expect(() => seeder.loadManifest(tmp)).not.toThrow();
    } finally { fs.unlinkSync(tmp); }
  });
});
