/**
 * GATE_CONTENT_PII_ALL_LANES (security audit run 3, fix E).
 *   1. supporting-blog and refresh drafts get the body privacy hard check
 *      (phones, emails, names, street addresses), like city-service and
 *      customer-question; a failure holds the draft via hard_failures.
 *   2. The brief's customer_signal and the get_customer_questions tool stop
 *      passing the customer's own (regex-redacted) words to the agents.
 * Dark = byte-identical to before.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/serp-profiler', () => ({ profile: jest.fn() }));

const db = require('../models/db');
const gate = require('../services/content/content-quality-gate');
const { ContentBriefBuilder } = require('../services/content/content-brief-builder');
const { executeBriefTool } = require('../services/content/agents/brief-driven-tools');
const { WRITER_AGENT_CONFIG } = require('../services/content/agents/writer-agent-config');
const { REFRESH_AGENT_CONFIG } = require('../services/content/agents/refresh-agent-config');

const GATE = 'GATE_CONTENT_PII_ALL_LANES';
const ORIGINAL = process.env[GATE];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[GATE];
  else process.env[GATE] = ORIGINAL;
});

const CLEAN = 'Termite swarmers show up after spring rain in Bradenton. Call Waves at (941) 318-7612 or email info@wavespestcontrol.com for a free inspection.';
const LANES = [
  ['supporting-blog', { page_type: 'supporting-blog', action_type: 'new_supporting_blog' }],
  ['refresh', { page_type: 'refresh', action_type: 'refresh_existing_page' }],
];
const DIRTY = {
  'a customer street address': 'John Smith at 4867 Maple Street told us the ants were back within a week.',
  'a customer name in prose': 'My name is john smith and i want a quote for the ants.',
  'a non-Waves phone number': 'Reach the homeowner at 212-555-1234 to reschedule.',
  'a non-Waves email': 'Email karen@gmail.com about the visit.',
};

const evalLane = (brief, body) => gate.evaluate({ body, frontmatter: {} }, brief, {});

describe.each(LANES)('%s body privacy check', (_lane, brief) => {
  test('dark: the check is a no-op, even on a dirty body', () => {
    delete process.env[GATE];
    const r = evalLane(brief, DIRTY['a customer street address']);
    expect(r.checks.redaction_passed).toMatchObject({ ok: true, reason: 'content_pii_all_lanes_gate_dark' });
    expect(r.hard_failures.map((f) => f.name)).not.toContain('redaction_passed');
  });

  test('live: a clean body with Waves contact lines passes the check', () => {
    process.env[GATE] = 'true';
    expect(evalLane(brief, CLEAN).checks.redaction_passed).toMatchObject({ ok: true });
  });

  test.each(Object.entries(DIRTY))('live: %s holds the draft', (_label, body) => {
    process.env[GATE] = 'true';
    const r = evalLane(brief, body);
    expect(r.checks.redaction_passed.ok).toBe(false);
    expect(r.hard_failures.map((f) => f.name)).toContain('redaction_passed');
    expect(r.ok).toBe(false);
  });

  test('the pass threshold does not move (weight 0)', () => {
    expect(gate.MIN_TOTAL_SCORES[brief.page_type]).toBe(brief.page_type === 'refresh' ? 47 : 51);
  });

  test('only the exact string "true" turns it on', () => {
    process.env[GATE] = '1';
    expect(evalLane(brief, DIRTY['a non-Waves email']).checks.redaction_passed.ok).toBe(true);
  });
});

describe('brief customer_signal keeps the customer topic, not the customer words', () => {
  const compose = () => new ContentBriefBuilder()._composeBrief({
    opportunity: { id: 'opp-1', page_url: null, query: 'ants', city: 'Bradenton', service: 'pest', bucket: 'customer_need', signal_metadata: {} },
    signals: {
      customer_signal: {
        topic: 'ants in kitchen',
        normalized_question: 'How do I stop ants in the kitchen?',
        total_count: 12,
        source_counts: { calls: 7, sms: 5 },
        example_phrasing_anonymized: 'this is jane, is the spray safe for dogs',
      },
      serp_profile: null,
      conversion_feedback: null,
    },
    decision: { page_type: 'supporting-blog', action_type: 'new_supporting_blog', final_score: 80, score_breakdown: {}, human_review_required: false, human_review_reason: null, router_notes: null },
    existingBriefVersions: 0,
  });

  test('dark: unchanged, the example still rides along', () => {
    delete process.env[GATE];
    expect(compose().customer_signal.example_phrasing_anonymized).toBe('this is jane, is the spray safe for dogs');
  });

  test('live: no example, the topic and counts stay', () => {
    process.env[GATE] = 'true';
    const cs = compose().customer_signal;
    expect(cs).not.toHaveProperty('example_phrasing_anonymized');
    expect(JSON.stringify(cs)).not.toMatch(/jane/);
    expect(cs).toMatchObject({ topic: 'ants in kitchen', normalized_question: 'How do I stop ants in the kitchen?', total_count: 12, city: 'Bradenton', service: 'pest' });
  });
});

describe('get_customer_questions tool', () => {
  function mockClusters(rows) {
    const q = { orderBy: jest.fn(() => q), limit: jest.fn(() => q), where: jest.fn(() => q), select: jest.fn(async () => rows) };
    db.mockImplementation(() => q);
    return q;
  }

  test('dark: still selects the example and confidence', async () => {
    delete process.env[GATE];
    const q = mockClusters([]);
    await executeBriefTool('get_customer_questions', { city: 'Bradenton' });
    expect(q.select.mock.calls[0][0]).toEqual(expect.arrayContaining(['example_phrasing_anonymized', 'redaction_confidence']));
  });

  test('live: the example and confidence are never selected, topics still are', async () => {
    process.env[GATE] = 'true';
    const q = mockClusters([{ topic: 'ants', normalized_question: 'How do I stop ants?', source_counts: '{"sms":2}' }]);
    const out = await executeBriefTool('get_customer_questions', { city: 'Bradenton', service: 'pest' });
    const cols = q.select.mock.calls[0][0];
    expect(cols).toEqual(expect.arrayContaining(['topic', 'normalized_question', 'total_count', 'source_counts']));
    expect(cols).not.toContain('example_phrasing_anonymized');
    expect(cols).not.toContain('redaction_confidence');
    expect(out.clusters).toHaveLength(1);
  });
});

describe('agent text no longer calls regex-redacted customer text "paraphrased"', () => {
  test('writer and refresher prompts and tool descriptions', () => {
    const toolDescriptions = [WRITER_AGENT_CONFIG, REFRESH_AGENT_CONFIG]
      .flatMap((cfg) => cfg.tools.filter((t) => t.name === 'get_customer_questions').map((t) => t.description));
    const text = [WRITER_AGENT_CONFIG.system, REFRESH_AGENT_CONFIG.system, ...toolDescriptions].join('\n');
    expect(text).not.toMatch(/paraphrased (customer|questions)/i);
    expect(toolDescriptions).toHaveLength(2);
  });
});

// Codex #7646 r1: the customer-text name heuristic read owner-approved
// competitors and cited public bodies as people, so the new editorial-lane
// check held drafts that were eligible before. Those spans are exempt; a
// customer's name next to them still holds the draft.
describe.each(LANES)('%s public-entity exemptions', (_lane, brief) => {
  const PUBLIC = {
    'an owner-approved competitor': 'Truly Nolen offers pest control in Bradenton.',
    'an approved competitor alias': 'Massey Services and Orkin Pest Control both treat lawns in Sarasota.',
    'a cited trade association': 'Data from the National Pest Management Association shows termites cost homeowners billions each year.',
    'a university extension citation': 'The University of Florida IFAS Extension recommends inspecting mulch beds near the slab.',
    'a state agency citation': 'The Florida Department of Agriculture and Consumer Services licenses every pest control operator.',
  };

  test.each(Object.entries(PUBLIC))('live: %s passes the check', (_label, body) => {
    process.env[GATE] = 'true';
    expect(evalLane(brief, body).checks.redaction_passed).toMatchObject({ ok: true });
  });

  test('live: a customer name beside a public body still holds the draft', () => {
    process.env[GATE] = 'true';
    const r = evalLane(brief, 'John Smith at 4867 Maple Street called the Homeowners Association about the ants.');
    expect(r.checks.redaction_passed.ok).toBe(false);
  });

  test('live: a customer name in prose next to an approved competitor still holds the draft', () => {
    process.env[GATE] = 'true';
    const r = evalLane(brief, 'My name is john smith and Truly Nolen never called me back.');
    expect(r.checks.redaction_passed.ok).toBe(false);
  });

  test('live: a customer surname that matches a one-word competitor alias still holds the draft', () => {
    process.env[GATE] = 'true';
    const r = evalLane(brief, 'John Massey reported ants in Parrish last spring.');
    expect(r.checks.redaction_passed.ok).toBe(false);
  });

  test('live: the exemption does not reach the city-service lane check', () => {
    process.env[GATE] = 'true';
    const r = gate.evaluate({ body: 'Truly Nolen offers pest control in Bradenton.', frontmatter: {} }, { page_type: 'city-service', action_type: 'create_or_refresh_city_service_page' }, {});
    expect(r.checks.redaction_passed).toBeDefined();
  });
});
