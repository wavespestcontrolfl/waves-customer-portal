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
// photos, estimates), 0 after S2c (reports, email, content, IB, portal,
// office). Keep the set: a new call lane that ships without a label lands
// here deliberately, with a reason, or fails the drift test below.
const UNLABELLED_LANES = new Set([]);

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
// that line — and only that expression: the scan stops at a comma or
// semicolon, so a literal in the NEXT argument or property (`runInLane(x,
// () => log('id'))`, `{ laneId: x, note: 'id' }`) never counts (Codex r2).
// A bare `laneId = …` assignment does not count either: nothing ties it to
// a call (pre-push audit on #3860).
function labelPattern(id) {
  const q = `['"\`]${id}['"\`]`;
  return new RegExp(`(?:runInLane\\(|laneId:)[^\\n;,]*?${q}`);
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

    test('labelPattern: the literal must be the runInLane argument / laneId value, not a later argument or property', () => {
      const re = labelPattern('sms_intent');
      for (const yes of ["laneId: 'sms_intent',", "runInLane('sms_intent', fn)", "laneId: highStakes ? 'other' : 'sms_intent',", "laneId: preset || (route === X ? 'sms_intent' : 'y') };"]) expect(re.test(yes)).toBe(true);
      for (const no of ["runInLane(activeLane, () => log('sms_intent'))", "{ laneId: activeLane, note: 'sms_intent' }", "const laneId = 'sms_intent';"]) expect(re.test(no)).toBe(false);
    });

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

// Every direct Anthropic SDK call (a file that loads @anthropic-ai/sdk and
// calls `.messages.create(` / `.messages.stream(`) runs inside ledgerCall, or
// is listed here with the count and the reason its lane stays `unrecordable`.
// Two-sided like UNLABELLED_LANES: a file whose unwrapped count drops below
// its entry fails (shrink the entry), and a new unwrapped call fails (wrap it:
// `await ledgerCall('anthropic', model, () => client.messages.create({...}),
// { laneId: '<lane>' })`, then set the lane's policy to ledger: 'call').
const KNOWN_UNWRAPPED = {
  'services/llm/call.js': [2, 'the adapter itself — records each leg through recordCall'],
  'services/voice-agent/relay-conversation.js': [1, 'voice_relay streams; ledgerCall takes a resolved Message'],
  'services/collections/outbound-voice/collections-conversation.js': [1, 'voice_relay_collections streams'],
  'services/lawn-assessment.js': [1, 'lawn_assess: its Gemini primary is a raw fetch, unrecorded'],
  'services/pest-identification.js': [1, 'pest_id: Gemini primary is a raw fetch'],
  'services/tree-shrub-assessment.js': [1, 'tree_shrub: Gemini primary is a raw fetch'],
  'services/treatment-zone-suggest.js': [1, 'treatment_zone: Gemini primary is a raw fetch'],
  'services/turf-height-ocr.js': [1, 'turf_ocr: Gemini primary is a raw fetch'],
  'services/lawn-diagnostic-prompt.js': [2, 'lawn_diag_vision / lawn_diag_writer: Gemini and OpenAI legs are raw fetches'],
  'services/property-lookup/ai-property-lookup.js': [2, 'property_trio: OpenAI and Gemini legs are raw fetches'],
  'services/seo/llm-mention-prober.js': [1, 'mentions_prober: a measurement probe (search), recorded by design as unrecordable'],
};

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' || entry.name === 'node_modules' ? [] : jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('direct Anthropic SDK calls are on the call ledger', () => {
  const counts = {};
  for (const file of jsFiles(SERVER_DIR)) {
    const src = read(file);
    if (!src.includes('@anthropic-ai/sdk')) continue;
    const unwrapped = src.split('\n').filter((line) => /\.messages\.(create|stream)\(/.test(line)
      && !/ledgerCall\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)).length;
    if (unwrapped) counts[path.relative(SERVER_DIR, file)] = unwrapped;
  }

  test('no unlisted file makes an unwrapped call', () => {
    const unlisted = Object.keys(counts).filter((file) => !KNOWN_UNWRAPPED[file]);
    expect(unlisted).toEqual([]);
  });

  test('each listed file has exactly its recorded number of unwrapped calls', () => {
    const drift = Object.entries(KNOWN_UNWRAPPED)
      .filter(([file, [expected]]) => (counts[file] || 0) !== expected)
      .map(([file, [expected]]) => `${file}: expected ${expected}, found ${counts[file] || 0}`);
    expect(drift).toEqual([]);
  });
});
