/**
 * Body privacy on every content lane (security audit run 3, fix E).
 *   1. supporting-blog and refresh drafts get the body privacy hard check
 *      (phones, emails, names, street addresses), like city-service and
 *      customer-question; a failure holds the draft via hard_failures.
 *   2. The brief's customer_signal and the get_customer_questions tool stop
 *      passing the customer's own (regex-redacted) words to the agents.
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
  test('a clean body with Waves contact lines passes the check', () => {
    expect(evalLane(brief, CLEAN).checks.redaction_passed).toMatchObject({ ok: true });
  });

  test.each(Object.entries(DIRTY))('%s holds the draft', (_label, body) => {
    const r = evalLane(brief, body);
    expect(r.checks.redaction_passed.ok).toBe(false);
    expect(r.hard_failures.map((f) => f.name)).toContain('redaction_passed');
    expect(r.ok).toBe(false);
  });

  test('the pass threshold does not move (weight 0)', () => {
    expect(gate.MIN_TOTAL_SCORES[brief.page_type]).toBe(brief.page_type === 'refresh' ? 47 : 51);
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

  test('no example, the topic and counts stay', () => {
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

  test('the example and confidence are never selected, topics still are', async () => {
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
    'an out-of-state extension citation': 'NC State Extension and Pennsylvania State University Extension both say not to cut a hammerhead worm found in a Sarasota yard.',
    'a federal agency citation': 'Homeowners in Venice can read what the Federal Trade Commission said about ultrasonic pest devices.',
  };

  test.each(Object.entries(PUBLIC))('%s passes the check', (_label, body) => {
    expect(evalLane(brief, body).checks.redaction_passed).toMatchObject({ ok: true });
  });

  test('a customer name beside a public body still holds the draft', () => {
    const r = evalLane(brief, 'John Smith at 4867 Maple Street called the Homeowners Association about the ants.');
    expect(r.checks.redaction_passed.ok).toBe(false);
  });

  test('a customer name in prose next to an approved competitor still holds the draft', () => {
    const r = evalLane(brief, 'My name is john smith and Truly Nolen never called me back.');
    expect(r.checks.redaction_passed.ok).toBe(false);
  });

  test('a customer name after "and" next to a public body still holds the draft', () => {
    const r = evalLane(brief, 'The Homeowners Association and John Smith reported ants in the kitchen.');
    expect(r.checks.redaction_passed.ok).toBe(false);
  });

  test('a customer name on the line after an approved public body still holds the draft', () => {
    const r = evalLane(brief, 'Data from the National Pest Management Association shows termite damage is common.\nJohn Smith called us about ants in Parrish.');
    expect(r.checks.redaction_passed.ok).toBe(false);
  });

  test.each([
    'Orkin John Smith reported ants in the kitchen last spring.',
    'Last spring John Smith Truly Nolen came out about the ants.',
    'The National Pest Management Association Mary Jones survey found termites in Parrish.',
  ])('a customer name touching an approved name still holds the draft: %s', (body) => {
    expect(evalLane(brief, body).checks.redaction_passed.ok).toBe(false);
  });

  test('a customer address in a sentence naming an approved competitor still holds the draft', () => {
    const r = evalLane(brief, 'Truly Nolen treated the home at 4867 Maple Street in Bradenton last spring.');
    expect(r.checks.redaction_passed.ok).toBe(false);
  });

  test('"The <surname> family" still holds the draft when the surname starts a competitor name', () => {
    const r = evalLane(brief, 'The Massey family in Parrish had ants in the kitchen again.');
    expect(r.checks.redaction_passed.ok).toBe(false);
  });

  test('"The Penn family" still holds the draft (Penn State is listed only by its full name)', () => {
    const r = evalLane(brief, 'The Penn family in Parrish had ants in the kitchen again.');
    expect(r.checks.redaction_passed.ok).toBe(false);
  });

  // Pre-push audits: a "the federal" pair would clear the first sentence and
  // a "carolina state" pair the second. Each names a person and no public
  // body; the agency and extension citations above pass.
  test.each([
    'The Federal family in Venice called about rats.',
    'A homeowner named Carolina State called our Sarasota office.',
  ])('a name that reads like part of a newly cited body still holds the draft: %s', (body) => {
    expect(evalLane(brief, body).checks.redaction_passed.ok).toBe(false);
  });

  test('a customer surname that matches a one-word competitor alias still holds the draft', () => {
    const r = evalLane(brief, 'John Massey reported ants in Parrish last spring.');
    expect(r.checks.redaction_passed.ok).toBe(false);
  });

  test('the exemption does not reach the city-service lane check', () => {
    const r = gate.evaluate({ body: 'Truly Nolen offers pest control in Bradenton.', frontmatter: {} }, { page_type: 'city-service', action_type: 'create_or_refresh_city_service_page' }, {});
    expect(r.checks.redaction_passed).toBeDefined();
  });
});

// Pre-push audit r3 (P1): briefs saved BEFORE the check shipped still hold the
// customer's words; every read that hands a saved brief to an agent drops them.
describe('saved briefs read back by agents', () => {
  const SAVED = {
    opportunity_id: 'opp-1',
    version: 2,
    customer_signal: JSON.stringify({
      topic: 'ants', normalized_question: 'How do I stop ants?', total_count: 4,
      example_phrasing_anonymized: 'my name is pat and the ants are back', redaction_confidence: 'high',
    }),
  };
  function mockBriefRow(row) {
    const q = { where: jest.fn(() => q), orderBy: jest.fn(() => q), first: jest.fn(async () => row) };
    db.mockImplementation(() => q);
  }

  test('get_content_brief drops the saved example and confidence, keeps the topic', async () => {
    mockBriefRow({ ...SAVED });
    const out = await executeBriefTool('get_content_brief', { opportunity_id: 'opp-1' });
    expect(out.customer_signal).not.toHaveProperty('example_phrasing_anonymized');
    expect(out.customer_signal).not.toHaveProperty('redaction_confidence');
    expect(out.customer_signal).toMatchObject({ topic: 'ants', normalized_question: 'How do I stop ants?', total_count: 4 });
  });

  test('the reviewed-run loader uses the same strip', () => {
    const src = require('fs').readFileSync(require.resolve('../services/content/autonomous-runner'), 'utf8');
    const loader = src.slice(src.indexOf('async _loadReviewedBrief(run) {'));
    expect(loader.slice(0, loader.indexOf('\n  }\n'))).toContain("require('./agents/brief-driven-tools').stripCustomerWords(out)");
  });
});

describe('pii-redactor allowPairs option', () => {
  const { redact } = require('../services/content/pii-redactor');
  test('without the option a two-word business name reads as a name, as before', () => {
    expect(redact('Truly Nolen came by last week.').findings.map((f) => f.type)).toContain('name');
  });
  test('with the option the listed pair is not a name, and other names still are', () => {
    const allowPairs = new Set(['truly nolen']);
    expect(redact('Truly Nolen came by last week.', { allowPairs }).findings.map((f) => f.type)).not.toContain('name');
    expect(redact('Truly Nolen and John Smith came by.', { allowPairs }).findings.map((f) => f.type)).toContain('name');
  });
});
