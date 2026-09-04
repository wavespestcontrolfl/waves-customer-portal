/**
 * Call-ledger coverage drift guard (agent-control S2a). Static, no DB.
 *
 * Every model-switchboard lane must be one of:
 *   - unrecordable   (policy says so — audio / embedding / image / video / search)
 *   - session        (its Managed Agents runner calls recordSessionUsage with
 *                     the lane id — the literal must appear in the runner)
 *   - a labelled call lane: the string '<id>' appears as the argument of
 *     runInLane( or as laneId: in at least one file the lane names
 *   - listed in UNLABELLED_LANES below — the KNOWN gap, shrunk by S2b / S2c
 *
 * The set is two-sided: a lane in it that IS labelled fails (stale entry —
 * delete it), and an unlabelled lane missing from it fails (a new lane, or a
 * lost label, cannot become a silent gap). Labelling a lane means moving it
 * out of the set in the same PR.
 */
const fs = require('fs');
const path = require('path');
const { LANES } = require('../services/model-switchboard');
const { policyFor } = require('../services/agent-control/lane-policies');

const SERVICES_DIR = path.join(__dirname, '..', 'services');
const SERVER_DIR = path.join(__dirname, '..');

// Lane id -> the runner that records its sessions (the switchboard's `file`
// for these lanes is the agent CONFIG, not the runner).
const SESSION_RUNNERS = {
  agent_bi: 'bi-agent.js',
  agent_lead: 'lead-response-agent.js',
  agent_content: 'content/content-agent.js',
  agent_meta: 'content/agents/agent-dispatcher.js',
  agent_backlink: 'seo/backlink-strategy-agent.js',
  agent_assistant: 'ai-assistant/managed-assistant.js',
};

// Call-ledger lanes with NO lane label at their call site — 66 after S2a
// (the plumbing: payload.laneId on dispatchWithFallback / createDeepMessage,
// ledgerCall, the six session lanes), 37 after S2b (SMS, calls, voice,
// photos, estimates); S2c labels the rest by product area. Their calls ARE
// recorded — labelled by provider/model or policy name — but carry lane_id
// NULL until then.
const UNLABELLED_LANES = new Set([
  'churn_classify', 'email_classify', 'social_judge', 'job_screen',
  'contact_correction', 'bounce_rescue', 'events_editorial',
  'expense_categorize', 'completion_recap', 'lawn_visit_narratives', 'social_copy', 'review_ask', 'review_reply', 'review_gate_text', 'email_reply', 'invoice_summary', 'blog_draft', 'newsletter',
  'content_misc', 'previsit_brief', 'report_copy', 'treatment_narrative', 'rodent_narrative', 'project_report',
  'ask_waves', 'link_investigator', 'chart_builder_image', 'chart_builder_sql', 'codex_remediation',
  'signup_worker', 'fact_check_gate', 'compliance_gate',
  'blog_optimize', 'kb_audit', 'wiki_compiler', 'quarantine_arbiter', 'extreme_tier',
]);

function resolveLaneFile(file) {
  for (const candidate of [path.join(SERVICES_DIR, file), path.join(SERVER_DIR, file)]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const sourceCache = new Map();
function read(file) {
  if (!sourceCache.has(file)) sourceCache.set(file, fs.readFileSync(file, 'utf8'));
  return sourceCache.get(file);
}

// '<id>' as the argument of runInLane( or the value of laneId:
// The lane literal may sit inside the expression a site labels with (a
// route- or flag-chosen ternary — response-drafter, the shadow drafter) as
// long as it is the runInLane argument or the `laneId:` payload value on
// that line. A bare `laneId = …` assignment does not count: nothing ties it
// to a call (pre-push audit on #3860).
function labelPattern(id) {
  const q = `['"\`]${id}['"\`]`;
  return new RegExp(`(?:runInLane\\(|laneId:)[^\\n;]*?${q}`);
}

function isLabelled(lane) {
  const files = String(lane.file || '').split(', ').map(resolveLaneFile).filter(Boolean);
  return files.some((f) => labelPattern(lane.id).test(read(f)));
}

describe('llm call-ledger coverage', () => {
  const byLedger = { call: [], session: [], unrecordable: [], other: [] };
  for (const lane of LANES) {
    const ledger = policyFor(lane.id).ledger;
    (byLedger[ledger] || byLedger.other).push(lane);
  }

  test('every lane has a ledger kind', () => {
    expect(byLedger.other.map((l) => l.id)).toEqual([]);
  });

  test('every lane file the switchboard names exists', () => {
    const missing = LANES.flatMap((l) => String(l.file).split(', ').filter((f) => !resolveLaneFile(f)).map((f) => `${l.id}: ${f}`));
    expect(missing).toEqual([]);
  });

  describe('session lanes: the runner records the session under the lane id', () => {
    test.each(byLedger.session.map((l) => [l.id]))('%s', (id) => {
      const runner = SESSION_RUNNERS[id];
      expect(runner).toBeDefined();
      const source = read(path.join(SERVICES_DIR, runner));
      expect(source).toMatch(/recordSessionUsage\(/);
      expect(source).toMatch(new RegExp(`['"]${id}['"]`));
    });

    test('SESSION_RUNNERS names exactly the session lanes', () => {
      expect(Object.keys(SESSION_RUNNERS).sort()).toEqual(byLedger.session.map((l) => l.id).sort());
    });
  });

  describe('call lanes: labelled at a call site, or listed as a known gap', () => {
    const labelled = new Set(byLedger.call.filter(isLabelled).map((l) => l.id));

    test('UNLABELLED_LANES lists only call-ledger lanes', () => {
      const callIds = new Set(byLedger.call.map((l) => l.id));
      expect([...UNLABELLED_LANES].filter((id) => !callIds.has(id))).toEqual([]);
    });

    test('no stale entries: a labelled lane must leave UNLABELLED_LANES', () => {
      expect([...UNLABELLED_LANES].filter((id) => labelled.has(id))).toEqual([]);
    });

    test('no silent gaps: every unlabelled call lane is listed', () => {
      const gaps = byLedger.call.map((l) => l.id).filter((id) => !labelled.has(id) && !UNLABELLED_LANES.has(id));
      expect(gaps).toEqual([]);
    });
  });
});
