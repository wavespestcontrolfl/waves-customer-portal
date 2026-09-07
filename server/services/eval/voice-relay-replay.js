/**
 * Voice relay conversation eval — replays synthetic-caller scenarios through
 * the LIVE RelayConversation loop (Sandy's real prompt, tool list, model and
 * turn machinery) with the world around it fixed by the fixture:
 *
 *   caller identity / KNOWN CALLER context  → scenario.caller
 *   office hours (open / closed / unknown)  → scenario.fixtures.officeHours
 *   every tool result                       → scenario.fixtures.toolResponses
 *   the relay gates                         → scenario.gates (env, per scenario)
 *   a dropped-line resume, a model outage   → scenario.fixtures.resume / modelFailures
 *
 * and grades the result two ways: the deterministic `expect` checks in this
 * file, and the pinned judge (voice-relay-judge.js) against the scenario
 * `spec`. Severity decides the run: a `critical` miss or an `adjudicated`
 * major fails the run; unadjudicated majors and `quality` misses only lower
 * the quality score. A verdict from the judge's FALLBACK leg is advisory and
 * never flips pass/fail.
 *
 * SAFETY BY CONSTRUCTION
 *   - end() is never called: no call_log reconcile, no capture floor, no
 *     transcript write — no relay row exists, so the self-training guard holds.
 *   - executeTool is replaced wholesale (no lead, ticket, booking or handoff
 *     packet can be written), the capture-floor / callback writers are stubbed
 *     to throw, and the db module is proxied to REFUSE any query while a
 *     scenario runs (disarmed again for the eval's own notification).
 *   - This module must load BEFORE voice-agent/relay-conversation, which
 *     destructures resolveCallerContext / createLeadFromExtraction at load.
 *     The script and the cron's child process guarantee that; jest isolates
 *     the module registry. It throws on the wrong order rather than running
 *     against the live resolvers.
 *   - Per-scenario gates mutate process.env — which is why the cron runs this
 *     in a CHILD PROCESS (runVoiceRelayEvalProcess), never inside the server.
 *
 * Mirrors services/eval/call-extraction-replay.js and reuses its retry-once /
 * flaky / notify helpers by export.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('../logger');
const {
  attemptReplay, emailFailure, defaultNotify, defaultSendEmail,
} = require('./call-extraction-replay');

const SCHEMA_VERSION = 'voice-relay-scenarios.v1';
const DEFAULT_FIXTURE_PATH = path.join(__dirname, '..', '..', 'fixtures', 'voice-relay-eval', 'scenarios.json');
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'run-voice-relay-eval.js');
const MANUAL_RERUN = 'node server/scripts/run-voice-relay-eval.js --json';
const OPS_KEY = 'voice-relay-eval';
const OPS_HEADING = 'Voice relay conversation eval';
// The number the synthetic caller "dialled" (555 = fictional). Only a label
// on the tool ctx: the fixture tools never resolve it.
const EVAL_CALLER_TO = '+19415550100';
// A whole eval in the cron's child process: 34 scenarios × a few live turns
// plus the judge. Generous — the point is that a wedged run cannot hold the
// runExclusive lock forever.
const CHILD_TIMEOUT_MS = 40 * 60 * 1000;

// scenario.gates key → the env var the relay reads at call time. Every one of
// these is read per call (no module-top reads), so a scenario may flip them
// without re-requiring the relay modules.
const GATE_ENV = Object.freeze({
  context: 'VOICE_RELAY_CONTEXT_ENABLED',
  booking: 'GATE_VOICE_AI_BOOKING',
  transfer: 'GATE_VOICE_RELAY_TRANSFER',
  recovery: 'GATE_VOICE_RELAY_RECOVERY',
  interrupt: 'GATE_VOICE_RELAY_INTERRUPT_CONTEXT',
  streaming: 'GATE_VOICE_RELAY_STREAMING',
  commitments: 'GATE_VOICE_RELAY_COMMITMENTS',
});

const SEVERITIES = Object.freeze(['critical', 'major', 'quality']);
const SEVERITY_WEIGHT = Object.freeze({ critical: 3, major: 2, quality: 1 });
const CHECKS = Object.freeze([
  'tools_called_include', 'tools_never_called', 'tools_called_subset_of',
  'spoken_never_matches', 'spoken_matches_any', 'capture_lead_input_includes',
  'end_session_called', 'no_model_text_before_tool', 'preamble_category',
  'commitment_requires_receipt',
]);
// The tools whose successful result is a RECEIPT for a spoken promise, and
// the default set no model text may precede. commit_follow_up is the PR 6
// commitments tool — listed so the check is ready for it, never registered
// as a known tool until it ships.
const WRITE_TOOLS = Object.freeze(['capture_lead', 'request_booking', 'request_reservice', 'transfer_to_office', 'commit_follow_up']);
// Follow-up promises, EN + ES, over what Sandy actually said.
const PROMISE_RE = /\b(?:(?:will|going to|gonna) (?:call|text|email|reach out|follow up|send|get back)|someone (?:will|is going to)|(?:i'?ll|i will) (?:have|make sure|note|let|pass)|(?:you'?ll|you will) (?:hear|get|receive)|(?:a |the )?(?:waves )?team member will|le (?:llamar|devolver|enviar|contactar|dar)|se comunicar|(?:un|una) (?:miembro|persona) del equipo)\b/i;
const DEFAULT_TOOL_TEXT = 'That information is not available on this call. Tell the caller a Waves team member will follow up with the details.';
const LOOKUP_BUDGET_TEXT = 'No more account lookups are available on this call. Do NOT try again and do not confirm or deny '
  + 'anything about any account. Offer to have a Waves team member call them back, and capture the lead.';
const TRANSFER_TEXT = 'Transferring the caller to the office now. Your part of the call is over — do not say anything else and do not call any more tools.';
const TRANSFER_IN_PROGRESS_TEXT = 'The transfer is already in progress. Say nothing further.';

// ── Fixture ───────────────────────────────────────────────────────────────

function loadFixture(fixturePath = DEFAULT_FIXTURE_PATH) {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

/** The tool names Sandy can be given today (registered sets, not prose). */
function knownToolNames() {
  const { TOOLS, CONTEXT_TOOLS, BOOKING_TOOLS } = require('../voice-agent/relay-tools');
  const { TRANSFER_TOOLS } = require('../voice-agent/relay-transfer');
  return new Set([...TOOLS, ...CONTEXT_TOOLS, ...BOOKING_TOOLS, ...TRANSFER_TOOLS].map((t) => t.name));
}

function compileRegex(source) {
  try { return new RegExp(source, 'i'); } catch { return null; }
}

// One validator per expect key: returns a problem string or null. Adding a
// check means adding a runner in CHECK_RUNNERS and a rule here.
const toolList = (knownTools) => (v) => (!Array.isArray(v) || !v.length ? 'value must be a non-empty tool list'
  : (v.find((n) => !knownTools.has(n)) ? `unknown tool "${v.find((n) => !knownTools.has(n))}"` : null));
const regexList = (v) => (!Array.isArray(v) || !v.length ? 'value must be a non-empty regex list'
  : (v.find((re) => !compileRegex(re)) !== undefined ? `invalid regex ${JSON.stringify(v.find((re) => !compileRegex(re)))}` : null));
const CHECK_VALUE_RULES = Object.freeze({
  tools_called_include: toolList,
  tools_never_called: toolList,
  tools_called_subset_of: toolList,
  spoken_never_matches: () => regexList,
  spoken_matches_any: () => regexList,
  capture_lead_input_includes: () => (v) => (!v || typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).length ? 'value must be an object of capture_lead fields' : null),
  end_session_called: () => (v) => (typeof v === 'boolean' || (v && typeof v === 'object') ? null : 'value must be boolean or { reason }'),
  no_model_text_before_tool: (knownTools) => (v) => (v === true || (Array.isArray(v) && v.length && v.every((n) => WRITE_TOOLS.includes(n) || knownTools.has(n))) ? null : 'value must be true or a tool list'),
  preamble_category: () => (v) => (v && typeof v.tool === 'string' && typeof v.category === 'string' ? null : 'value must be { tool, category }'),
  commitment_requires_receipt: () => (v) => (v === true ? null : 'value must be true'),
});

function lintExpectation(e, i, knownTools) {
  const label = `expect[${i}]`;
  if (!e || !CHECKS.includes(e.check)) return [`${label}: unknown check "${e && e.check}"`];
  const problems = [];
  if (!SEVERITIES.includes(e.severity)) problems.push(`${label} (${e.check}): severity must be critical | major | quality`);
  if (e.adjudicated != null && typeof e.adjudicated !== 'boolean') problems.push(`${label} (${e.check}): adjudicated must be boolean`);
  const problem = CHECK_VALUE_RULES[e.check](knownTools)(e.value);
  if (problem) problems.push(`${label} (${e.check}): ${problem}`);
  return problems;
}

// Scenario-level rules: [problem-when-true, message].
function lintScenario(s, knownTools) {
  const fx = s.fixtures || {};
  const turns = Array.isArray(s.turns) ? s.turns : [];
  const spec = s.spec && typeof s.spec === 'object' ? s.spec : null;
  const rules = [
    [!['en', 'es'].includes(s.language), 'language must be en or es'],
    [!s.caller || typeof s.caller.from !== 'string' || !/^\+1\d{10}$/.test(s.caller.from), 'caller.from must be an E.164 US number'],
    [s.caller && s.caller.context != null && (typeof s.caller.context !== 'object' || !s.caller.context.customer || !s.caller.context.tier), 'caller.context needs customer + tier'],
    ...Object.keys(s.gates || {}).map((key) => [!GATE_ENV[key], `unknown gate "${key}"`]),
    [!turns.some((t) => t && typeof t.caller === 'string' && t.caller.trim()), 'needs at least one caller turn'],
    [!spec, 'spec is required'],
    ...['required_facts', 'prohibited_facts', 'acceptable_actions'].map((k) => [spec && spec[k] != null && !Array.isArray(spec[k]), `spec.${k} must be an array`]),
    [spec && spec.required_action != null && typeof spec.required_action !== 'string', 'spec.required_action must be a string'],
    [s.judge && (!SEVERITIES.includes(s.judge.severity || 'major') || (s.judge.adjudicated != null && typeof s.judge.adjudicated !== 'boolean')), 'judge block invalid'],
    [fx.officeHours != null && !['open', 'closed', 'unknown'].includes(fx.officeHours) && typeof fx.officeHours !== 'object', 'fixtures.officeHours must be open | closed | unknown | hours object'],
    [fx.modelFailures != null && !(Number.isInteger(fx.modelFailures) && fx.modelFailures >= 0), 'fixtures.modelFailures must be a non-negative integer'],
    ...Object.keys(fx.toolResponses || {}).map((name) => [!knownTools.has(name), `toolResponses names unknown tool "${name}"`]),
    [fx.resume != null && typeof fx.resume.segmentsText !== 'string', 'fixtures.resume.segmentsText must be a string'],
    [!Array.isArray(s.expect), 'expect must be an array'],
  ];
  const problems = rules.filter(([bad]) => bad).map(([, msg]) => msg);
  if (Array.isArray(s.expect)) s.expect.forEach((e, i) => problems.push(...lintExpectation(e, i, knownTools)));
  return problems;
}

/**
 * Fixture lint — every problem, not the first. Runs before any scenario so a
 * malformed fixture reads as "could not run", never as a pass.
 */
function lintFixture(fixture, { knownTools = knownToolNames() } = {}) {
  const errors = [];
  if (!fixture || fixture.schemaVersion !== SCHEMA_VERSION) errors.push(`fixture: schemaVersion must be ${SCHEMA_VERSION}`);
  const scenarios = Array.isArray(fixture?.scenarios) ? fixture.scenarios : [];
  if (!scenarios.length) errors.push('fixture: no scenarios');
  const ids = new Set();
  for (const s of scenarios) {
    const id = s && s.id;
    if (!id || typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) { errors.push(`scenario ${JSON.stringify(id)}: id must be kebab-case`); continue; }
    if (ids.has(id)) errors.push(`${id}: duplicate id`);
    ids.add(id);
    errors.push(...lintScenario(s, knownTools).map((msg) => `${id}: ${msg}`));
  }
  return errors;
}

// ── The harness (patched world around the live conversation loop) ─────────

// Members of the knex instance that reach the database. Anything else
// (fn.now(), client config, destroy) passes through.
const DB_QUERY_MEMBERS = new Set([
  'raw', 'transaction', 'select', 'insert', 'update', 'delete', 'del', 'from', 'table', 'batchInsert',
  'schema', 'with', 'withRecursive', 'first', 'count', 'where', 'whereIn', 'whereRaw', 'queryBuilder',
  'truncate', 'pluck', 'sum', 'avg', 'max', 'min', 'into', 'returning',
]);

function makeDbGuard(realDb) {
  const guard = { armed: false, attempts: [] };
  const refuse = (what) => {
    guard.attempts.push(what);
    const e = new Error(`voice-relay eval: database access refused while a scenario runs (${what})`);
    e.code = 'EVAL_DB_REFUSED';
    return e;
  };
  guard.db = new Proxy(realDb, {
    apply(target, thisArg, args) {
      if (guard.armed) throw refuse(`db(${typeof args[0] === 'string' ? args[0] : '…'})`);
      return Reflect.apply(target, target, args);
    },
    get(target, prop) {
      if (guard.armed && DB_QUERY_MEMBERS.has(prop)) throw refuse(`db.${String(prop)}`);
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return guard;
}

function cloneContext(context) {
  return {
    customer: { ...(context.customer || {}) },
    tier: context.tier === 'full' ? 'full' : 'redacted',
    attested: context.attested === true,
    matchedColumn: context.matchedColumn || null,
    block: typeof context.block === 'string' ? context.block : '',
    dataTurn: typeof context.dataTurn === 'string' ? context.dataTurn : null,
  };
}

/**
 * Office hours as loadOfficeHours() would return them. 'open' always reads
 * as open NOW (hours widened around the current ET minute so the clock block
 * stays plausible), 'closed' is a scheduled day off, 'unknown' is a failed
 * read. An object passes through untouched.
 */
function officeHoursFixture(scenario, now = new Date()) {
  const v = scenario?.fixtures?.officeHours ?? 'unknown';
  if (v && typeof v === 'object') return { ...v };
  if (v === 'closed') return { startMin: 8 * 60, endMin: 17 * 60, closedToday: true };
  if (v === 'open') {
    const { etParts } = require('../../utils/datetime-et');
    const et = etParts(now);
    const nowMin = et.hour * 60 + et.minute;
    return { startMin: Math.min(8 * 60, Math.max(0, nowMin - 30)), endMin: Math.max(17 * 60, Math.min(24 * 60, nowMin + 30)) };
  }
  return null;
}

function normalizeToolResponse(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return { text: raw };
  if (typeof raw === 'object') return { ...raw };
  return null;
}

/** The fixture's answer for the n-th call of `name` (arrays step, the last entry repeats). */
function pickToolResponse(scenario, name, n) {
  const raw = scenario?.fixtures?.toolResponses?.[name];
  if (raw === undefined) return null;
  if (Array.isArray(raw)) return normalizeToolResponse(raw[Math.min(Math.max(n, 1), raw.length) - 1]);
  return normalizeToolResponse(raw);
}

/** The ctx side effects the real write tools perform — capture latch, booking / re-service / transfer marks. Never a write. */
function applyToolSideEffects(response, { input, ctx, scenario }) {
  if (response.capture) {
    if (typeof ctx.markCaptured === 'function') ctx.markCaptured(response.capture === true ? {} : response.capture);
    if (input && input.call_summary && typeof ctx.noteCallSummary === 'function') ctx.noteCallSummary(input.call_summary);
  }
  if (response.booking && typeof ctx.markBookingRequested === 'function') ctx.markBookingRequested(null);
  if (response.reservice && typeof ctx.markReserviceFiled === 'function') ctx.markReserviceFiled();
  if (!response.transfer) return response.text || '';
  if (typeof ctx.transferRequested === 'function' && ctx.transferRequested() === true) return TRANSFER_IN_PROGRESS_TEXT;
  if (typeof ctx.markTransferRequested === 'function') ctx.markTransferRequested();
  const { copy } = require('../voice-agent/relay-language');
  if (typeof ctx.say === 'function') ctx.say(copy('transferring', scenario.language === 'es' ? 'es-US' : null));
  if (typeof ctx.endForTransfer === 'function') ctx.endForTransfer();
  return response.text || TRANSFER_TEXT;
}

/**
 * executeTool, fixture edition. Records the call, answers from the fixture
 * and performs the SAME ctx side effects the real tool would (capture latch,
 * booking / re-service / transfer marks, the lookup budget) — never a write.
 */
async function runFixtureTool(state, name, input = {}, ctx = {}) {
  const { scenario, record } = state;
  if (!scenario || !record) throw new Error('voice-relay eval: tool called outside a scenario');
  record.toolUse[name] = (record.toolUse[name] || 0) + 1;
  const event = { kind: 'tool', name, input: safeInput(input), text: '', turn: record.turn, ok: null, unexpected: false, index: record.events.length };
  record.events.push(event);
  record.toolCalls.push(event);
  const response = pickToolResponse(scenario, name, record.toolUse[name]);
  const answer = (text, ok) => { event.ok = ok; event.text = text; return text; };
  if (!response) {
    event.unexpected = true;
    record.warnings.push(`tool ${name} called with no fixture response`);
    return answer(DEFAULT_TOOL_TEXT, false);
  }
  if (response.hang === true) {
    answer('(no result — the tool hung until the relay\'s time bound)', false);
    return new Promise(() => {}); // the live bound (_executeToolBounded) degrades it
  }
  if (name === 'lookup_customer' && typeof ctx.consumeLookup === 'function' && ctx.consumeLookup() !== true) return answer(LOOKUP_BUDGET_TEXT, false);
  return answer(String(applyToolSideEffects(response, { input, ctx, scenario })), response.ok !== false);
}

function safeInput(input) {
  try { return JSON.parse(JSON.stringify(input == null ? {} : input)); } catch { return {}; }
}

let harness = null;

/**
 * Install the patched world ONCE per process and load the live conversation
 * module behind it. Throws when relay-conversation is already loaded — its
 * load-time bindings would then point at the real resolvers.
 */
function installHarness() {
  if (harness) return harness;
  const convPath = require.resolve('../voice-agent/relay-conversation');
  if (require.cache[convPath]) {
    throw new Error('voice-relay-replay must load before voice-agent/relay-conversation — run the eval in its own process (npm run eval:voice-relay)');
  }
  const dbPath = require.resolve('../../models/db');
  const realDb = require('../../models/db');
  const guard = makeDbGuard(realDb);
  // Node keeps the module entry in require.cache, so every later require of
  // models/db (relay-conversation's included) receives the guard. jest keeps
  // its own registry (require.cache is empty there): the suites mock the db
  // module outright and assert it is never called.
  const dbEntry = require.cache[dbPath];
  if (dbEntry) dbEntry.exports = guard.db;
  guard.installed = !!dbEntry;

  const relayContext = require('../voice-agent/relay-context');
  const relayTools = require('../voice-agent/relay-tools');
  const profile = require('../voice-profile-distiller');
  const leadWriter = require('../lead-from-extraction');
  const conversations = require('../conversations');
  const state = { scenario: null, record: null, modelFailuresLeft: 0 };
  const refuse = (what) => { throw new Error(`voice-relay eval: ${what} must never run in the harness`); };

  relayContext.resolveCallerContext = async (from, { onVerified } = {}) => {
    const caller = (state.scenario && state.scenario.caller) || {};
    if (typeof onVerified === 'function') onVerified(caller.verified === true);
    return caller.context ? cloneContext(caller.context) : null;
  };
  relayContext.verifyRelaySession = async ({ onVerified } = {}) => {
    const caller = (state.scenario && state.scenario.caller) || {};
    if (typeof onVerified === 'function') onVerified(caller.verified === true);
    return { verified: caller.verified === true, attested: !!(caller.context && caller.context.attested) };
  };
  relayContext.loadOfficeHours = async () => officeHoursFixture(state.scenario);
  relayTools.executeTool = (name, input, ctx) => runFixtureTool(state, name, input, ctx);
  // The DB-approved voice profile is style-only state, not code under test:
  // frozen out so every run grades the code-versioned prompt and needs no DB.
  profile.getApprovedVoiceProfile = async () => null;
  leadWriter.createLeadFromExtraction = async () => refuse('the capture floor (createLeadFromExtraction)');
  leadWriter.stampCustomerPreferredLanguage = async () => false;
  conversations.syncVoiceMessageForCall = async () => refuse('syncVoiceMessageForCall');

  // Model fault injection (fixtures.modelFailures): the SDK's Messages
  // prototype is shared by every client instance, including the one
  // relay-conversation built at load — a throw from stream() lands in the
  // same catch a real provider error does.
  let modelFaultInjection = false;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'voice-relay-eval' }).messages);
    if (proto && proto !== Object.prototype && typeof proto.stream === 'function') {
      const realStream = proto.stream;
      proto.stream = function evalStream(...args) {
        if (state.modelFailuresLeft > 0) {
          state.modelFailuresLeft -= 1;
          if (state.record) state.record.injected.push('model_failure');
          throw new Error('voice-relay eval: injected model failure');
        }
        // Model telemetry per scenario: a completed round vs a REAL provider
        // error. Without it a keyless or outage run would read green — Sandy's
        // "could you say that again?" fallback speaks nothing forbidden.
        const stream = realStream.apply(this, args);
        const record = state.record;
        if (record && stream && typeof stream.finalMessage === 'function') {
          const finalMessage = stream.finalMessage.bind(stream);
          stream.finalMessage = () => finalMessage().then(
            (msg) => { record.modelRounds += 1; return msg; },
            (err) => { record.modelErrors.push(err && err.message ? err.message : String(err)); throw err; },
          );
        }
        return stream;
      };
      modelFaultInjection = true;
    }
  } catch (err) {
    logger.warn(`[voice-relay-eval] model fault injection unavailable: ${err.message}`);
  }

  const conversation = require('../voice-agent/relay-conversation');
  harness = { RelayConversation: conversation.RelayConversation, MODEL: conversation.MODEL, state, guard, modelFaultInjection };
  return harness;
}

/** Set the scenario's gates in process.env; returns the restore function. */
function applyGates(gates = {}) {
  const prior = {};
  for (const [key, envName] of Object.entries(GATE_ENV)) {
    prior[envName] = process.env[envName];
    if (gates[key] === true) process.env[envName] = 'true';
    else delete process.env[envName];
  }
  return () => {
    for (const [envName, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  };
}

/** A proven dropped-line resume, seeded the way loadResumeState's proof would land it. */
function applyResumeFixture(convo, scenario, record) {
  const resume = scenario?.fixtures?.resume;
  if (!resume) return;
  const segmentsText = String(resume.segmentsText || '');
  convo._resumedHint = true;
  convo._resume = { predecessorsComplete: true, segmentsText, reconnects: Number(resume.reconnects) || 1, relayLeadId: null };
  convo._resumeReady = Promise.resolve();
  convo._priorCallerTurns = Number.isInteger(resume.priorCallerTurns) ? resume.priorCallerTurns : (segmentsText.match(/^Caller:/gm) || []).length;
  // The reconnect line the relay server speaks before the first prompt.
  const { copy } = require('../voice-agent/relay-language');
  const line = copy('resumed', scenario.language === 'es' ? 'es-US' : null);
  record.events.push({ kind: 'agent', text: line, turn: 0, system: true, index: record.events.length });
  record.spoken.push(line);
}

/**
 * A barge-in over the last agent utterance: `true` cuts it at the halfway
 * word, `{ words: n }` after n words, `{ heard: '…' }` at an exact prefix.
 */
function injectInterrupt(convo, record, spec) {
  const last = [...record.events].reverse().find((e) => e.kind === 'agent' && !e.system);
  if (!last) { record.warnings.push('interrupt requested before any agent utterance'); return; }
  const words = String(last.text).split(/\s+/).filter(Boolean);
  let heard;
  if (spec && typeof spec === 'object' && typeof spec.heard === 'string') heard = spec.heard;
  else {
    const n = spec && typeof spec === 'object' && Number.isInteger(spec.words) ? spec.words : Math.max(1, Math.floor(words.length / 2));
    heard = words.slice(0, n).join(' ');
  }
  convo.interrupt({ utteranceUntilInterrupt: heard, durationUntilInterruptMs: 1200 });
  record.events.push({ kind: 'interrupt', text: heard, turn: record.turn, index: record.events.length });
}

/** Feed the scripted caller turns (and barge-ins) through the live loop, in order. */
async function driveTurns(convo, scenario, record) {
  for (const turn of scenario.turns || []) {
    if (turn.interrupt) injectInterrupt(convo, record, turn.interrupt);
    const text = typeof turn.caller === 'string' ? turn.caller.trim() : '';
    if (!text) continue;
    record.turn += 1;
    record.events.push({ kind: 'caller', text, turn: record.turn, ignored: !!(convo._ending || convo.ended), index: record.events.length });
    await convo.handlePrompt(text);
  }
  await convo._chain.catch(() => {});
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The labelled dialogue the judge (and a reviewer) reads. Tool lines carry name, input and result. */
function renderTranscript(events = []) {
  const lines = [];
  for (const e of events) {
    if (e.kind === 'caller') lines.push(`Caller: ${e.text}${e.ignored ? ' (not heard — the session was already ending)' : ''}`);
    else if (e.kind === 'agent') lines.push(`Agent: ${e.text}`);
    else if (e.kind === 'interrupt') lines.push(`[caller interrupted the agent after: "${e.text}"]`);
    else if (e.kind === 'tool') lines.push(`[tool] ${e.name}(${clip(JSON.stringify(e.input || {}), 240)}) → ${clip(e.text, 600)}`);
  }
  return lines.join('\n');
}

// ── Deterministic checks ──────────────────────────────────────────────────

function agentUtterances(record) {
  return record.events.filter((e) => e.kind === 'agent');
}

function inputIncludes(input = {}, expected = {}) {
  const misses = [];
  for (const [key, want] of Object.entries(expected)) {
    const have = input[key];
    let ok;
    if (Array.isArray(want)) ok = want.some((w) => (typeof w === 'string' ? String(have ?? '').toLowerCase().includes(w.toLowerCase()) : have === w));
    else if (typeof want === 'string') ok = String(have ?? '').toLowerCase().includes(want.toLowerCase());
    else ok = have === want;
    if (!ok) misses.push(`${key}=${JSON.stringify(have === undefined ? null : have)} (wanted ${JSON.stringify(want)})`);
  }
  return misses;
}

// One runner per expect key: (value, record, view) → { status, detail }.
// `view` is the record read the way the checks need it.
const CHECK_RUNNERS = Object.freeze({
  tools_called_include(value, record, { calledNames }) {
    const missing = value.filter((n) => !calledNames.includes(n));
    return missing.length ? ['fail', `never called: ${missing.join(', ')}`] : ['pass', `called: ${value.join(', ')}`];
  },
  tools_never_called(value, record, { calledNames }) {
    const hit = value.filter((n) => calledNames.includes(n));
    return hit.length ? ['fail', `called: ${hit.join(', ')}`] : ['pass', 'none called'];
  },
  tools_called_subset_of(value, record, { calledNames }) {
    const extra = [...new Set(calledNames.filter((n) => !value.includes(n)))];
    return extra.length ? ['fail', `outside the allowed set: ${extra.join(', ')}`] : ['pass', `called ⊆ {${value.join(', ')}}`];
  },
  spoken_never_matches(value, record, { spoken }) {
    const hit = firstRegexHit(value, spoken);
    return hit ? ['fail', `/${hit.source}/i matched: "${clip(hit.text, 160)}"`] : ['pass', 'no forbidden phrase spoken'];
  },
  spoken_matches_any(value, record, { spoken }) {
    const hit = firstRegexHit(value, spoken);
    return hit ? ['pass', `/${hit.source}/i matched: "${clip(hit.text, 160)}"`] : ['fail', `none of ${value.map((v) => `/${v}/i`).join(', ')} was spoken`];
  },
  capture_lead_input_includes(value, record) {
    const captures = record.toolCalls.filter((t) => t.name === 'capture_lead');
    if (!captures.length) return ['fail', 'capture_lead was never called'];
    const best = captures.map((c) => inputIncludes(c.input, value)).reduce((a, b) => (b.length < a.length ? b : a));
    return best.length ? ['fail', `no capture_lead input satisfied: ${best.join('; ')}`] : ['pass', 'capture_lead input includes every expected field'];
  },
  end_session_called(value, record) {
    const want = typeof value === 'boolean' ? value : true;
    const called = record.endSession != null;
    if (called !== want) return ['fail', want ? 'the session was never ended by the agent' : `the agent ended the session (${record.endSession.reason})`];
    if (value && typeof value === 'object' && value.reason && record.endSession.reason !== value.reason) return ['fail', `ended for "${record.endSession.reason}", wanted "${value.reason}"`];
    return ['pass', called ? `ended (${record.endSession.reason})` : 'session left open'];
  },
  no_model_text_before_tool(value, record, { utterances }) {
    const tools = value === true ? WRITE_TOOLS : value;
    for (const call of record.toolCalls.filter((t) => tools.includes(t.name))) {
      const before = utterances.find((u) => u.turn === call.turn && u.index < call.index && !u.system);
      if (before) return ['fail', `"${clip(before.text, 120)}" was spoken before ${call.name} ran`];
    }
    return ['pass', 'no model text preceded a write'];
  },
  preamble_category(value, record, { utterances }) {
    const table = require('../voice-agent/relay-language').SAFE_PREAMBLES;
    if (!table) return ['skip', 'deterministic preambles are not shipped yet (PR 5)'];
    const call = record.toolCalls.find((t) => t.name === value.tool);
    if (!call) return ['fail', `${value.tool} was never called`];
    const before = [...utterances].reverse().find((u) => u.turn === call.turn && u.index < call.index);
    if (!before) return ['fail', `nothing was spoken before ${value.tool}`];
    const allowed = (table[record.language] || table.en || {})[value.category] || [];
    return allowed.includes(before.text) ? ['pass', `preamble "${clip(before.text, 80)}" is a ${value.category} preamble`] : ['fail', `"${clip(before.text, 120)}" is not a ${value.category} preamble`];
  },
  commitment_requires_receipt(value, record, { utterances }) {
    const promises = utterances.filter((u) => PROMISE_RE.test(u.text));
    if (!promises.length) return ['pass', 'no follow-up was promised'];
    const receipt = record.toolCalls.find((t) => WRITE_TOOLS.includes(t.name) && t.ok === true);
    return receipt ? ['pass', `promise backed by ${receipt.name}`] : ['fail', `promised "${clip(promises[0].text, 120)}" with no successful write behind it`];
  },
});

function firstRegexHit(sources, spoken) {
  for (const source of sources) {
    const re = compileRegex(source);
    const text = spoken.find((t) => re && re.test(t));
    if (text) return { source, text };
  }
  return null;
}

function runCheck(expectation, record) {
  const utterances = agentUtterances(record);
  const view = { calledNames: record.toolCalls.map((t) => t.name), utterances, spoken: utterances.map((u) => u.text) };
  const runner = CHECK_RUNNERS[expectation.check];
  const [status, detail] = runner ? runner(expectation.value, record, view) : ['skip', `unknown check ${expectation.check}`];
  return { check: expectation.check, severity: expectation.severity, adjudicated: expectation.adjudicated === true, status, detail };
}

function evaluateChecks(scenario, record) {
  return (scenario.expect || []).map((e) => runCheck(e, record));
}

/** The judge's verdict as checks. Fallback-leg verdicts are advisory: never pass/fail. */
function judgeChecks(scenario, judge) {
  if (!judge) return [];
  const severity = (scenario.judge && scenario.judge.severity) || 'major';
  const adjudicated = !!(scenario.judge && scenario.judge.adjudicated === true);
  if (!judge.ok) return [{ check: 'judge:verdict', severity, adjudicated, status: 'skip', detail: `judge unavailable (${judge.reason})` }];
  const advisory = judge.judge_fallback === true;
  const v = judge.verdict;
  const mk = (check, failed, detail, sev = severity) => ({
    check, severity: sev, adjudicated, status: advisory ? 'advisory' : (failed ? 'fail' : 'pass'), detail: advisory ? `(fallback-leg verdict, advisory) ${detail}` : detail,
  });
  const out = [];
  for (const c of v.forbidden_claims) out.push(mk(`judge:forbidden_claim:${c.category}`, true, c.quote ? `"${clip(c.quote, 160)}"` : 'no quote'));
  out.push(mk('judge:required_facts', v.required_facts_missing.length > 0, v.required_facts_missing.length ? `missing: ${v.required_facts_missing.join('; ')}` : 'all required facts conveyed'));
  out.push(mk('judge:prohibited_facts', v.prohibited_facts_stated.length > 0, v.prohibited_facts_stated.length ? `stated: ${v.prohibited_facts_stated.join('; ')}` : 'none stated'));
  out.push(mk('judge:action', !v.action_ok, v.action_taken || (v.action_ok ? 'acceptable' : 'not an acceptable action')));
  if (scenario.spec && scenario.spec.transfer_required === true) out.push(mk('judge:transfer', !v.transfer_ok, v.transfer_ok ? 'transferred' : 'the caller was not handed to a person'));
  out.push(mk('judge:empathy', !v.empathy_ok, v.empathy_ok ? 'ok' : 'concern not acknowledged specifically', 'quality'));
  out.push(mk('judge:brevity', !v.brevity_ok, v.brevity_ok ? 'ok' : 'a turn ran past the spec\'s range', 'quality'));
  out.push(mk('judge:tone', v.tone != null && v.tone < 3, `tone ${v.tone == null ? 'n/a' : `${v.tone}/5`}`, 'quality'));
  return out;
}

const blocking = (c) => c.status === 'fail' && (c.severity === 'critical' || (c.severity === 'major' && c.adjudicated));

function scenarioStatus(record) {
  if (record.error) return 'error';
  return record.checks.some(blocking) ? 'fail' : 'pass';
}

function qualityScore(checks) {
  let total = 0;
  let passed = 0;
  for (const c of checks) {
    if (c.status !== 'pass' && c.status !== 'fail') continue;
    const w = SEVERITY_WEIGHT[c.severity] || 1;
    total += w;
    if (c.status === 'pass') passed += w;
  }
  return total ? Math.round((passed / total) * 1000) / 1000 : null;
}

// ── One scenario ──────────────────────────────────────────────────────────

function newRecord(scenario, h) {
  return {
    id: scenario.id, language: scenario.language || 'en', turn: 0, events: [], spoken: [], toolCalls: [], toolUse: {},
    endSession: null, injected: [], dbAttempts: [], warnings: [], toolsAvailable: [], promptSha: null, model: h.MODEL,
    modelRounds: 0, modelErrors: [],
  };
}

/** The live conversation, wired to the record instead of a socket. */
function newConversation(h, scenario, record) {
  const caller = scenario.caller || {};
  return new h.RelayConversation({
    callSid: null,
    sessionKey: null,
    callTokenVerified: caller.verified === true,
    from: caller.from || null,
    to: EVAL_CALLER_TO,
    language: scenario.language === 'es' ? 'es-US' : null,
    send: (text) => {
      const t = String(text || '');
      record.events.push({ kind: 'agent', text: t, turn: record.turn, index: record.events.length });
      record.spoken.push(t);
    },
    endSession: (frame) => { record.endSession = { ...(frame || {}), turn: record.turn }; return true; },
  });
}

function errorRecord(err) {
  return { name: (err && err.name) || 'Error', message: err && err.message ? err.message : String(err), code: (err && err.code) || null };
}

async function runScenario(scenario, { judge = true, judgeFn = null } = {}) {
  const h = installHarness();
  const record = newRecord(scenario, h);
  const restoreEnv = applyGates(scenario.gates);
  const startedAt = Date.now();
  h.state.scenario = scenario;
  h.state.record = record;
  h.state.modelFailuresLeft = Number(scenario.fixtures && scenario.fixtures.modelFailures) || 0;
  h.guard.attempts.length = 0;
  h.guard.armed = true;
  try {
    if (h.state.modelFailuresLeft > 0 && !h.modelFaultInjection) throw new Error('fixtures.modelFailures needs model fault injection, which this process could not install');
    const convo = newConversation(h, scenario, record);
    applyResumeFixture(convo, scenario, record);
    await driveTurns(convo, scenario, record);
    record.toolsAvailable = (convo._tools || []).map((t) => t.name);
    record.promptSha = convo._promptSha || null;
    // No completed model round and a real provider error (an injected
    // failure is expected and excluded): the conversation never happened, so
    // the checks would grade the fallback copy. That is a replay error, not
    // a pass.
    if (record.modelRounds === 0 && record.modelErrors.length) {
      throw Object.assign(new Error(`model unavailable: ${record.modelErrors[0]}`), { code: 'EVAL_MODEL_UNAVAILABLE' });
    }
  } catch (err) {
    record.error = errorRecord(err);
  } finally {
    h.guard.armed = false;
    record.dbAttempts = h.guard.attempts.splice(0);
    h.state.scenario = null;
    h.state.record = null;
    h.state.modelFailuresLeft = 0;
    restoreEnv();
  }
  record.durationMs = Date.now() - startedAt;
  record.transcript = renderTranscript(record.events);
  record.checks = record.error ? [] : evaluateChecks(scenario, record);
  record.judge = null;
  if (!record.error && judge) {
    const run = judgeFn || require('./voice-relay-judge').judgeTranscript;
    record.judge = await run({ spec: scenario.spec || {}, transcript: record.transcript, language: record.language, toolsAvailable: record.toolsAvailable })
      .catch((err) => ({ ok: false, reason: `judge_error:${err && err.message ? err.message : err}` }));
    record.checks.push(...judgeChecks(scenario, record.judge));
  }
  record.qualityScore = qualityScore(record.checks);
  record.status = scenarioStatus(record);
  return record;
}

// ── The run ───────────────────────────────────────────────────────────────

function summarize(results, { judge }) {
  const summary = {
    scenarios: results.length, passed: 0, failed: 0, replayErrors: 0, replayErrorIds: [], failedIds: [],
    criticalMisses: 0, adjudicatedMajorMisses: 0, majorMisses: 0, qualityMisses: 0,
    judge: !!judge, judged: 0, judgeFallbacks: 0, judgeErrors: 0, dbRefusals: 0, unexpectedTools: 0, warnings: 0,
    modelRounds: 0, modelErrors: 0, modelUnavailable: 0, qualityScore: null, durationMs: 0,
  };
  const all = [];
  for (const r of results) {
    summary.durationMs += r.durationMs || 0;
    summary.dbRefusals += (r.dbAttempts || []).length;
    summary.unexpectedTools += (r.toolCalls || []).filter((t) => t.unexpected).length;
    summary.warnings += (r.warnings || []).length;
    summary.modelRounds += r.modelRounds || 0;
    summary.modelErrors += (r.modelErrors || []).length;
    if (r.error && r.error.code === 'EVAL_MODEL_UNAVAILABLE') summary.modelUnavailable += 1;
    if (r.status === 'error') { summary.replayErrors += 1; summary.replayErrorIds.push(r.id); continue; }
    if (r.status === 'fail') { summary.failed += 1; summary.failedIds.push(r.id); } else summary.passed += 1;
    if (r.judge) {
      if (r.judge.ok) { summary.judged += 1; if (r.judge.judge_fallback) summary.judgeFallbacks += 1; } else summary.judgeErrors += 1;
    }
    for (const c of r.checks || []) {
      all.push(c);
      if (c.status !== 'fail') continue;
      if (c.severity === 'critical') summary.criticalMisses += 1;
      else if (c.severity === 'major') { summary.majorMisses += 1; if (c.adjudicated) summary.adjudicatedMajorMisses += 1; } else summary.qualityMisses += 1;
    }
  }
  summary.qualityScore = qualityScore(all);
  return summary;
}

function summaryLine(summary = {}) {
  const pct = summary.qualityScore == null ? 'n/a' : `${(summary.qualityScore * 100).toFixed(1)}%`;
  return `scenarios=${summary.scenarios || 0} passed=${summary.passed || 0} failed=${summary.failed || 0} replayErrors=${summary.replayErrors || 0}`
    + ` critical=${summary.criticalMisses || 0} adjudicatedMajor=${summary.adjudicatedMajorMisses || 0} major=${summary.majorMisses || 0} quality=${summary.qualityMisses || 0}`
    + ` judged=${summary.judged || 0}${summary.judge === false ? ' (judge off)' : ''} judgeFallbacks=${summary.judgeFallbacks || 0} judgeErrors=${summary.judgeErrors || 0}`
    + ` qualityScore=${pct} modelRounds=${summary.modelRounds || 0}${summary.modelErrors ? ` modelErrors=${summary.modelErrors}` : ''}${summary.dbRefusals ? ` dbRefusals=${summary.dbRefusals}` : ''}${summary.failedIds && summary.failedIds.length ? ` failed=[${summary.failedIds.join(', ')}]` : ''}${summary.replayErrorIds && summary.replayErrorIds.length ? ` errors=[${summary.replayErrorIds.join(', ')}]` : ''}`;
}

function isFailedVoiceRun(run) {
  if (run && run.failed === true) return true;
  const s = (run && run.summary) || {};
  return (s.replayErrors || 0) > 0 || (s.failed || 0) > 0;
}

/**
 * One attempt over the fixture. `only` restricts to scenario ids; `judge`
 * false skips the judged layer (deterministic checks only). Throws on a
 * malformed fixture — the caller records that as "could not run".
 */
async function runVoiceRelayReplay({ fixturePath = DEFAULT_FIXTURE_PATH, only = null, judge = true, judgeFn = null } = {}) {
  const fixture = loadFixture(fixturePath);
  const lint = lintFixture(fixture);
  if (lint.length) throw new Error(`fixture lint failed: ${lint.slice(0, 5).join(' | ')}${lint.length > 5 ? ` (+${lint.length - 5} more)` : ''}`);
  let scenarios = fixture.scenarios;
  if (Array.isArray(only) && only.length) {
    const unknown = only.filter((id) => !scenarios.some((s) => s.id === id));
    if (unknown.length) throw new Error(`unknown scenario id(s): ${unknown.join(', ')}`);
    scenarios = scenarios.filter((s) => only.includes(s.id));
  }
  installHarness();
  // In production the WebSocket keeps the process alive; here nothing does.
  // The relay's own time bounds are unref'd timers, so a hanging fixture tool
  // ({ hang: true }) would otherwise let Node exit mid-scenario, silently.
  const keepAlive = setInterval(() => {}, 1000);
  const results = [];
  try {
    for (const scenario of scenarios) {
      const record = await runScenario(scenario, { judge, judgeFn });
      logger.info(`[voice-relay-eval] ${scenario.id}: ${record.status}${record.error ? ` (${record.error.message})` : ''} checks=${record.checks.length} tools=${record.toolCalls.length}${record.judge && record.judge.ok ? ` judge=${record.judge.verdict.pass ? 'pass' : 'fail'}${record.judge.judge_fallback ? '(fallback)' : ''}` : ''} ${record.durationMs}ms`);
      results.push(record);
    }
  } finally {
    clearInterval(keepAlive);
  }
  const summary = summarize(results, { judge });
  // No scenario completed a single model round and at least one lost its
  // model: the eval could not run (inconclusive), which pages differently
  // from "Sandy failed N scenarios". (A model-outage scenario completes zero
  // rounds by design, so the rule is not "every scenario errored".)
  if (summary.modelRounds === 0 && summary.modelUnavailable > 0) {
    const first = results.find((r) => r.error && r.error.code === 'EVAL_MODEL_UNAVAILABLE');
    throw new Error(`no scenario completed a model round — ${first.error.message}`);
  }
  return { failed: isFailedVoiceRun({ summary }), fixturePath, schemaVersion: fixture.schemaVersion, judge, summary, results };
}

// ── Retry-once / notify wrapper (the call-replay shape) ───────────────────

function failureLines(run) {
  const lines = [];
  for (const r of (run && run.results) || []) {
    if (r.status === 'error') lines.push(`${r.id}: replay error (${r.error && r.error.message ? r.error.message : 'unknown error'})`);
    for (const c of r.checks || []) {
      if (c.status === 'fail' && blocking(c)) lines.push(`${r.id}: ${c.severity}${c.adjudicated ? '*' : ''} ${c.check} — ${c.detail}`);
    }
  }
  if (!lines.length && run && run.summary) lines.push(`summary: ${summaryLine(run.summary)}`);
  return lines;
}

function compactAttempt(attempt) {
  return { status: attempt.status, summary: attempt.run ? attempt.run.summary : null, error: attempt.error || null };
}

async function notifyFailure({ notify, sendEmail, finalAttempt, attempts, fixturePath }) {
  const run = finalAttempt.run || null;
  const lines = failureLines(run).slice(0, 20);
  const summary = (run && run.summary) || {};
  const retry = attempts[1] || null;
  const retryNote = retry
    ? (retry.status === 'inconclusive'
        ? `\n\nRetry was inconclusive: ${retry.error && retry.error.message ? retry.error.message : 'unknown error'}. Keeping the first observed failure.`
        : '\n\nThe retry did not clear the failure.')
    : '';
  const title = `Voice relay eval: ${(summary.failed || 0) + (summary.replayErrors || 0)} failing scenario(s)`;
  const body = `${lines.join('\n').slice(0, 1400)}\n\n${summaryLine(summary)}${retryNote}\n\nRe-run manually: ${MANUAL_RERUN}`;
  let notifyError = null;
  try {
    await notify({
      recipient_type: 'admin',
      category: 'eval_regression',
      title,
      body,
      icon: '\u{1F9EA}',
      link: '/admin/dashboard',
      metadata: JSON.stringify({ fixturePath, summary, failures: lines, attempts: attempts.map(compactAttempt) }),
    });
  } catch (err) {
    notifyError = err;
  }
  await emailFailure({ sendEmail, subject: `FIX: ${title}`, textBody: body, key: OPS_KEY, heading: OPS_HEADING });
  logger.warn(`[voice-relay-eval] failed: ${summaryLine(summary)}`);
  if (notifyError) throw notifyError;
}

async function notifyInconclusive({ notify, sendEmail, attempt, fixturePath }) {
  const title = 'Voice relay eval could not run';
  const body = `${attempt.error && attempt.error.message ? attempt.error.message : 'Unknown replay error'}\n\nThe voice relay scenario fixture was NOT verified.\n\nRe-run manually: ${MANUAL_RERUN}`;
  let notifyError = null;
  try {
    await notify({
      recipient_type: 'admin',
      category: 'eval_regression',
      title,
      body,
      icon: '\u{1F9EA}',
      link: '/admin/dashboard',
      metadata: JSON.stringify({ fixturePath, error: attempt.error || null }),
    });
  } catch (err) {
    notifyError = err;
  }
  await emailFailure({ sendEmail, subject: `FIX: ${title}`, textBody: body, key: OPS_KEY, heading: OPS_HEADING });
  logger.warn(`[voice-relay-eval] inconclusive: ${attempt.error && attempt.error.message ? attempt.error.message : 'unknown error'}`);
  if (notifyError) throw notifyError;
}

/**
 * The scheduled shape: one attempt, retry once on failure (pass-on-retry is
 * flaky, not a failure), one admin bell + ops email on repeated failure or
 * when the eval could not run. Never throws for a failed eval — only for a
 * notification insert that failed (the email channel has already fired).
 */
async function runVoiceRelayEval(opts = {}) {
  const runReplay = opts.runReplay || runVoiceRelayReplay;
  const notify = opts.notify || defaultNotify;
  const sendEmail = opts.sendEmail || defaultSendEmail;
  const fixturePath = opts.fixturePath || DEFAULT_FIXTURE_PATH;
  const replayOptions = { fixturePath, only: opts.only || null, judge: opts.judge !== false, judgeFn: opts.judgeFn || null };
  const attemptOptions = { isFailed: isFailedVoiceRun, lane: 'voice_relay' };

  const firstAttempt = await attemptReplay(runReplay, replayOptions, attemptOptions);
  let finalAttempt = firstAttempt;
  let flaky = false;
  const attempts = [firstAttempt];
  if (firstAttempt.status === 'fail') {
    const retryAttempt = await attemptReplay(runReplay, replayOptions, attemptOptions);
    attempts.push(retryAttempt);
    finalAttempt = retryAttempt.status === 'inconclusive' ? firstAttempt : retryAttempt;
    flaky = retryAttempt.status === 'pass';
    if (flaky) logger.warn('[voice-relay-eval] pass-on-retry; treating as flaky, not failing');
  }
  if (finalAttempt.status === 'fail') await notifyFailure({ notify, sendEmail, finalAttempt, attempts, fixturePath });
  else if (finalAttempt.status === 'inconclusive') await notifyInconclusive({ notify, sendEmail, attempt: finalAttempt, fixturePath });

  const run = finalAttempt.run || null;
  const result = {
    status: finalAttempt.status,
    flaky,
    fixturePath,
    judge: run ? run.judge : replayOptions.judge,
    summary: run ? run.summary : null,
    attempts: attempts.map(compactAttempt),
    results: run ? run.results : [],
    error: finalAttempt.error || null,
  };
  logger.info(`[voice-relay-eval] done: status=${result.status}${flaky ? ' flaky=true' : ''} | ${summaryLine(result.summary || {})}`);
  return result;
}

/**
 * The cron entry point: the whole eval in a child process (its per-scenario
 * gate env and its patched relay modules never touch the server). Resolves
 * with the child's JSON result; rejects when the child crashed or produced
 * nothing parseable. The child notifies on its own (--notify).
 */
function runVoiceRelayEvalProcess({ timeoutMs = CHILD_TIMEOUT_MS, scriptPath = SCRIPT_PATH, execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(process.execPath, [scriptPath, '--json', '--notify'], {
      env: process.env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : (err ? null : 0);
      let parsed = null;
      try { parsed = JSON.parse(String(stdout || '').trim()); } catch { parsed = null; }
      // Exit 1 (failed) / 3 (inconclusive) still carry a JSON result — the
      // child has already notified; only a crash (2, a signal, no JSON) throws.
      if (parsed && parsed.status && (code === 0 || code === 1 || code === 3)) { resolve({ ...parsed, exitCode: code }); return; }
      const tail = String(stderr || '').trim().slice(-400);
      reject(new Error(`voice relay eval child ${err && err.killed ? 'timed out' : `exited ${code === null ? 'abnormally' : code}`}${tail ? `: ${tail}` : ''}`));
    });
  });
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_FIXTURE_PATH,
  MANUAL_RERUN,
  GATE_ENV,
  CHECKS,
  SEVERITIES,
  WRITE_TOOLS,
  loadFixture,
  lintFixture,
  knownToolNames,
  installHarness,
  runScenario,
  runVoiceRelayReplay,
  runVoiceRelayEval,
  runVoiceRelayEvalProcess,
  summaryLine,
  isFailedVoiceRun,
  _internals: {
    PROMISE_RE, DEFAULT_TOOL_TEXT, LOOKUP_BUDGET_TEXT, EVAL_CALLER_TO, CHILD_TIMEOUT_MS,
    makeDbGuard, officeHoursFixture, pickToolResponse, runFixtureTool, applyToolSideEffects, applyGates, applyResumeFixture, injectInterrupt, driveTurns,
    renderTranscript, evaluateChecks, runCheck, CHECK_RUNNERS, lintScenario, judgeChecks, scenarioStatus, qualityScore, summarize, failureLines,
    notifyFailure, notifyInconclusive,
  },
};
