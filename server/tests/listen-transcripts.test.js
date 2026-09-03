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
    expect(stats.findings.email).toBeGreaterThan(0);
    // The business insight survives redaction.
    expect(sent).toContain('brown patches');
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
    ['statewide_only', { working_title: 'Brown patches in Florida lawns', slug: '/lawn-care/brown-patches-florida/', city: null, thesis: 'Nitrogen plus rain invites fungus.', outline: ['What you see'], primary_kw: 'brown patches florida', secondary_kws: [] }],
    ['door_to_door', { outline: ['Why our door-to-door reps say this'] }],
    ['safe_claim', { thesis: 'Our pet-safe fungicide fixes it.' }],
    ['reentry_minutes', { outline: ['Re-entry is fine after 30 minutes of drying'] }],
    ['slug_prefix', { slug: '/blog/brown-patches/' }],
    ['no_allowed_source', { sources: ['https://randomblog.example.com/lawns'] }],
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
    expect(dropped).toEqual([{ title: 'Pet-safe sprays', reason: 'safe_claim' }]);
    const b = manifest.briefs[0];
    expect(b.id).toMatch(/^listen-[0-9a-f]{10}$/);
    expect(b.action).toBe('new_supporting_blog');
    expect(b.byline).toBe('adam');
    expect(b.verify_notes.length).toBeGreaterThanOrEqual(3);
    expect(b.listen.confidence).toBe(0.8);

    const tmp = path.join(os.tmpdir(), `listen-test-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(manifest));
    try {
      expect(() => seeder.loadManifest(tmp)).not.toThrow();
    } finally { fs.unlinkSync(tmp); }
  });
});
