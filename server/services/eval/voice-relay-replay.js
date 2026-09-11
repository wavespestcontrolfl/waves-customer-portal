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
 * Grades the deterministic `expect` checks in this file. A critical miss or
 * an adjudicated major fails the run; other misses lower its quality score.
 * Scenario specs also drive optional pinned-model judging. Fallback verdicts
 * are advisory; pinned forbidden claims are critical.
 *
 * SAFETY BY CONSTRUCTION
 *   - end() is never called: no call_log reconcile, no capture floor, no
 *     transcript write — no relay row exists, so the self-training guard holds.
 *   - executeTool is replaced wholesale (no lead, ticket, booking or handoff
 *     packet can be written), the capture-floor / callback writers are stubbed
 *     to throw, and the db module is proxied to REFUSE any query while a
 *     scenario's conversation runs. The optional judge runs afterwards through
 *     its normal ledgered lane, labelled as replay traffic. Under ledger gates
 *     those judge calls may write ledger and trace rows; the conversation cannot.
 *   - This module must load BEFORE voice-agent/relay-conversation, which
 *     destructures resolveCallerContext / createLeadFromExtraction at load.
 *     The manual script guarantees that; jest isolates
 *     the module registry. It throws on the wrong order rather than running
 *     against the live resolvers.
 *   - Per-scenario gates mutate process.env. Run this only in its dedicated
 *     CLI process. The scheduled entry point spawns that process; its relay
 *     environment and module patches never touch the application server.
 *   - Notifications run after the conversation guard is disarmed and reuse
 *     the call-extraction eval notification and ops-digest mechanisms.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const Joi = require('joi');
const Ajv = require('ajv');
const logger = require('../logger');
const { attemptReplay, emailFailure, defaultNotify, defaultSendEmail } = require('./call-extraction-replay');
const { SPOKEN_CHECK_RUNNERS, SPOKEN_CHECK_VALUE_RULES } = require('./voice-relay-spoken-checks');

const SCHEMA_VERSION = 'voice-relay-scenarios.v1';
const DEFAULT_FIXTURE_PATH = path.join(__dirname, '..', '..', 'fixtures', 'voice-relay-eval', 'scenarios.json');
// The number the synthetic caller "dialled" (555 = fictional). Only a label
// on the tool ctx: the fixture tools never resolve it.
const EVAL_CALLER_TO = '+19415550100';
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'run-voice-relay-eval.js');
const MANUAL_RERUN = 'node server/scripts/run-voice-relay-eval.js --json --judge';
const OPS_KEY = 'voice-relay-eval';
const OPS_HEADING = 'Voice relay conversation eval';
// Operational ceiling for the shipped fixture plus one retry, sized for a
// fixture of up to ninety caller turns and thirty-four scenarios (today's is
// smaller: 28 scenarios, 77 turns). Every caller turn may use all six
// 20-second streams (relay-conversation MAX_TOOL_ROUNDS / STREAM_TIMEOUT_MS),
// not merely one, so ninety turns can spend three hours on Sandy per attempt.
// Thirty-four judge chains, four-wide at the dispatcher's four-minute budget,
// add 36 minutes. Twice that is 7h12m; eight hours leaves 48 minutes for
// fixture-tool timeouts and other overhead. Re-derive this ceiling if the
// live bounds change or the fixture grows past those counts.
const CHILD_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const JUDGE_CONCURRENCY = 4;
// scenario.gates key → the env var the relay reads at call time. Every one of
// these is read per call (no module-top reads), so a scenario may flip them
// without re-requiring the relay modules.
const GATE_ENV = Object.freeze({
  context: 'VOICE_RELAY_CONTEXT_ENABLED',
  booking: 'GATE_VOICE_AI_BOOKING',
  transfer: 'GATE_VOICE_RELAY_TRANSFER',
  recovery: 'GATE_VOICE_RELAY_RECOVERY',
  interrupt: 'GATE_VOICE_RELAY_INTERRUPT_CONTEXT',
  // Whether a looked-up or contact-slot caller may receive a booking or
  // re-service write (relay-booking allowsThirdPartyWrites). Off unless the
  // scenario says so — never inherited from the invoking shell.
  thirdPartyWrites: 'VOICE_RELAY_ALLOW_THIRD_PARTY_WRITES',
});

const SEVERITIES = Object.freeze(['critical', 'major', 'quality']);
const SEVERITY_WEIGHT = Object.freeze({ critical: 3, major: 2, quality: 1 });
const CHECKS = Object.freeze([
  'tools_called_include', 'tools_never_called', 'tools_called_subset_of',
  'spoken_never_matches', 'spoken_matches_any', 'capture_lead_input_includes',
  'end_session_called', 'no_model_text_before_tool',
  'commitment_requires_receipt', 'tools_performed_include', 'tools_performed_any_of', 'tools_called_at_most',
  // The named spoken-content checks (voice-relay-spoken-checks): one
  // implementation per prohibition, shared by every scenario that carries it.
  ...Object.keys(SPOKEN_CHECK_RUNNERS),
]);
// The registered write tools and the ONE ctx effect each performs live
// (relay-tools / relay-booking / relay-reservice / relay-transfer). A fixture
// answer may carry only its own tool's effect — `request_booking: { capture }`
// would latch a capture the live booking tool never performs.
const TOOL_EFFECT = Object.freeze({ capture_lead: 'capture', request_booking: 'booking', request_reservice: 'reservice', transfer_to_office: 'transfer' });
// The tools whose PERFORMED write is a receipt for a spoken promise, and the
// default set no model text may precede — the registered write tools only.
const WRITE_TOOLS = Object.freeze(Object.keys(TOOL_EFFECT));
// Follow-up promises, EN + ES, over what Sandy actually said. Every form
// names the follow-up itself (a call, a text, an email, a reach-out, a
// delivery) AND who owes it — Sandy, the office, a team member: "a team
// member will confirm timing", "you will get a receipt" or "the portal will
// send you a receipt" is service guidance, not a commitment the office must
// have on file. A definite progressive ("the office is calling you shortly",
// "someone is emailing the estimate") presents the follow-up as already
// under way, which commits the office just as "will" does — and so does a
// FUTURE progressive ("we will be calling you", "the office is going to be
// reaching out"): PROMISE_VERB_ING is the same -ing vocabulary
// PROMISE_PROGRESSIVE already names, shared here so "will be calling"
// promises exactly what "will call" and "is calling" already do.
const PROMISE_SUBJECT = "(?:i|we|they|the office|the team|someone|(?:a |the )?(?:waves )?team member)";
const PROMISE_MODAL = "(?:['’]ll| will|(?:['’](?:m|re)| is| are| am)? (?:going to|gonna))";
const PROMISE_VERB_ING = "(?:calling|texting|emailing|reaching out|following up|sending|getting back|contacting|giving you a (?:call|ring|shout)(?: back)?)";
const PROMISE_PROGRESSIVE = `(?:['’](?:m|re)| is| are| am) ${PROMISE_VERB_ING}`;
// An adverb may sit between the modal and "be" (and between "be" and the
// -ing verb) in a future-progressive promise — "will definitely be calling
// you", "will shortly be reaching out" — without opening the door to a
// filler WORD standing in for "be": only an -ly adverb, and only ahead of
// the literal "be", counts.
const PROMISE_ADVERB = '(?:\\w+ly\\s+)?';
const PROMISE_RE = new RegExp(`\\b(?:${PROMISE_SUBJECT}(?:${PROMISE_MODAL} (?:${PROMISE_ADVERB}be ${PROMISE_ADVERB}${PROMISE_VERB_ING}|call|text|email|reach out|follow up|send|get back|contact|be in touch|give you a (?:call|ring|shout)(?: back)?)|${PROMISE_PROGRESSIVE})|` + String.raw`(?:i|we)(?:['’]ll| will) (?:(?:ask|get|arrange for) (?:the office|someone|(?:a |the )?(?:waves )?team member|the team) to (?:call|text|email|reach out|follow up|get back|give you a (?:call|ring|shout)(?: back)?)|have (?:the office|someone|(?:a |the )?(?:waves )?team member|the team) (?:call|text|email|reach out|follow up|get back|give you a (?:call|ring|shout)(?: back)?)|make sure (?:the office|someone|(?:a |the )?(?:waves )?team member|the team) (?:calls?|texts?|emails?|reaches? out|follows? up|gets? back|gives? you a (?:call|ring|shout)(?: back)?)|note (?:your|the|a) (?:callback|call-back|follow-up) request|let (?:the office|(?:a |the )?(?:waves )?team member|the team) know|pass (?:this|that|it|your (?:message|request)) (?:on|along) to (?:the office|(?:a |the )?(?:waves )?team member|the team))|(?:you'?ll|you will) (?:hear (?:from|back)|(?:get|receive) (?:a |an |the |your )?(?:call|callback|call-back|text|email|message|written estimate|estimate|quote|details))|(?:le|te|les) (?:llamar(?:é|emos|á|án)?|devolver(?:é|emos|á|án)?|enviar(?:é|emos|á|án)?|contactar(?:é|emos|á|án)?|dar(?:é|emos|á|án)?)|se comunicar)\b`, 'i');
// Commitments are graded per clause: a negation or condition governs only the
// promise in ITS clause ("I cannot access your schedule, so we will call you
// back" and "I can't access that, the office will call you" still commit),
// and an offer condition — trailing ("… if you would like") or leading before
// a comma ("If you'd like, …") — makes the clause an offer, not a commitment.
// A comma before a coordinator is the coordinator (", and get back to you").
const COMMITMENT_CLAUSE_SPLIT_RE = /([.!?;]|,\s*\b(?:and|then)\b|\b(?:but|however|though|although|so|because|since|and|then)\b|,)/i;
const OFFER_CONDITION_LEAD_RE = /^\s*(?:if (?:you|that|it)(?:['’]d| would| want| prefer| like|['’]s| is| works| helps)|should you (?:want|wish|prefer|like)|would you like|si (?:quiere|desea|gusta|prefiere|le parece))\b/i;
// The subject + modal a coordinated fragment inherits: "I'll check with the
// office and get back to you" promises the callback even though the second
// fragment has no subject of its own.
const SUBJECT_MODAL_RE = new RegExp(`\\b(${PROMISE_SUBJECT}(?:${PROMISE_MODAL}|['’](?:m|re)| is| are| am))\\b`, 'i');
const COORDINATOR_RE = /^,?\s*(?:and|then)$/i;
// A Spanish bare "no" negates only the verb it precedes ("No le llamaremos"),
// so it counts at the end of the prefix alone — "No worries, we will call
// you" keeps its promise.
const NON_COMMITMENT_PREFIX_RE = /\b(?:cannot|can['’]?t|won['’]?t|not|never|unable|if|whether|would you like|si|no puedo|no podemos|nunca|jamás|no(?=\s*$))\b/i;
const CONDITIONAL_OFFER_SUFFIX_RE = /\b(?:if (?:you|that|it)(?:['’]d| would| want| prefer| like|['’]s| is| works| helps)|should you (?:want|wish|prefer|like)|si (?:quiere|desea|gusta|prefiere|le parece))\b/i;
// The follow-up the live timeout and already-on-file answers direct: a team
// member (or the office) will follow up / confirm / call — not a delivery
// of anything.
const DIRECTED_FOLLOW_UP_RE = /\b(?:(?:a |the )?(?:waves )?team member|the office|someone|the team)(?:(?:['’]ll| will|(?:['’](?:m|re)| is| are)? (?:going to|gonna)) (?:follow up|confirm|reach out|be in touch|get back|call)|(?:['’]re| is| are) (?:following up|confirming|reaching out|getting back|calling))\b/i;
function isCommitment(text) {
  const parts = String(text).split(COMMITMENT_CLAUSE_SPLIT_RE); // clause, separator, clause, …
  const commits = (clause) => {
    const match = PROMISE_RE.exec(clause);
    if (!match) return false;
    return !NON_COMMITMENT_PREFIX_RE.test(clause.slice(0, match.index))
      && !CONDITIONAL_OFFER_SUFFIX_RE.test(clause.slice(match.index + match[0].length));
  };
  let carried = null; // the previous clause's affirmative subject + modal
  let offered = false; // the previous fragment was a leading offer condition
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i];
    const separator = i > 0 ? parts[i - 1] : '';
    const own = SUBJECT_MODAL_RE.exec(clause);
    const coordinated = COORDINATOR_RE.test(separator.trim());
    if (!offered && commits(clause)) return true;
    if (!offered && !own && carried && coordinated && commits(`${carried} ${clause.trim()}`)) return true;
    // A fragment with its own subject resets the carry; a coordinated fragment
    // without one ("… and then reach out") keeps it; any other break drops it.
    // A negation or condition before the subject, or a negation right after
    // its modal ("I will not call you and get back later"), governs the carry;
    // a condition inside the complement ("I'll check if the office has
    // availability and get back to you") does not.
    if (own) {
      const negated = offered || NON_COMMITMENT_PREFIX_RE.test(clause.slice(0, own.index))
        || /^\s*(?:not|never)\b/i.test(clause.slice(own.index + own[0].length));
      carried = negated ? null : own[1];
    }
    else if (!coordinated) carried = null;
    // "If you'd like, we'll call you back": the offer condition before the
    // comma governs the fragment after it.
    offered = OFFER_CONDITION_LEAD_RE.test(clause) && /^\s*,/.test(parts[i + 1] || '');
  }
  return false;
}
const DEFAULT_TOOL_TEXT = 'That information is not available on this call. Tell the caller a Waves team member will follow up with the details.';
const LOOKUP_BUDGET_TEXT = 'No more account lookups are available on this call. Do NOT try again and do not confirm or deny '
  + 'anything about any account. Offer to have a Waves team member call them back, and capture the lead.';
const TRANSFER_TEXT = 'Transferring the caller to the office now. Your part of the call is over — do not say anything else and do not call any more tools.';
const TRANSFER_IN_PROGRESS_TEXT = 'The transfer is already in progress. Say nothing further.';
const MISMATCH_TEXT = 'Nothing matches those arguments on this call — nothing was done. Check what the caller actually asked for and the values earlier results gave you.';
const OFFICE_HOURS_SCHEMA = Joi.alternatives().allow(null).try(
  Joi.string().valid('open', 'closed', 'unknown'),
  Joi.object({
    startMin: Joi.number().integer().min(0).max(1439).required(),
    endMin: Joi.number().integer().min(1).max(1440).greater(Joi.ref('startMin')).required(),
    closedToday: Joi.boolean(), closedTomorrow: Joi.boolean(), closedUnknown: Joi.boolean(),
    closedForDate: Joi.string().isoDate().pattern(/^\d{4}-\d{2}-\d{2}$/),
  }),
);
const END_SESSION_SCHEMA = Joi.alternatives().try(Joi.boolean(), Joi.object({ reason: Joi.string().pattern(/\S/).required() }));
const RESUME_SCHEMA = Joi.object({
  segmentsText: Joi.string().allow('').required(),
  reconnects: Joi.number().integer().min(1),
  priorCallerTurns: Joi.number().integer().min(0),
}).allow(null);
const MATCHER_SCALAR = Joi.alternatives().try(Joi.string().pattern(/\S/), Joi.number(), Joi.boolean());
const INPUT_MATCHER_SCHEMA = Joi.object().min(1).pattern(/\S/, Joi.alternatives().try(
  MATCHER_SCALAR, Joi.array().min(1).items(MATCHER_SCALAR.required()),
));
const TOOL_RESPONSES_SCHEMA = Joi.array().min(1).items(Joi.alternatives().try(
  Joi.string().pattern(/\S/),
  Joi.object({
    text: Joi.string().pattern(/\S/),
    when: INPUT_MATCHER_SCHEMA,
    once: Joi.boolean(),
    ok: Joi.boolean(),
    hang: Joi.boolean(),
    transfer: Joi.boolean(),
    booking: Joi.boolean(),
    // `true` files a ticket; 'existing' is the live already-open answer — a
    // durable ticket the office holds, which backs the follow-up it directs
    // without claiming a new write.
    reservice: Joi.alternatives().try(Joi.boolean(), Joi.valid('existing')),
    capture: Joi.alternatives().try(Joi.boolean(), Joi.object().min(1).unknown(true)),
    // lookup_customer only: the account each customer_ref in this answer
    // names, as the live relay registers it — so a ref to the caller's OWN
    // account is graded as their own write, not a third party's.
    refs: Joi.object().min(1).pattern(/^C\d+(?:-\d+)?$/, Joi.string().pattern(/\S/)),
  }).custom((entry, helpers) => {
    const hasEffect = ['hang', 'transfer', 'booking', 'reservice', 'capture'].some((key) => entry[key] === true) || entry.reservice === 'existing';
    if (entry.text || hasEffect || (entry.capture && typeof entry.capture === 'object')) return entry;
    return helpers.message('response needs non-empty text, a side effect, or hang: true');
  }),
).required());
// One scripted turn: the caller's words, optionally preceded by a barge-in
// over the last agent utterance — `true` (cut at the halfway word),
// `{ words: n }` or `{ heard: '…' }` (exactly the forms injectInterrupt
// reads). Exact keys only: a misspelled `interupt` would otherwise be
// ignored and grade a barge-in scenario that never barged in.
const TURN_SCHEMA = Joi.object({
  caller: Joi.string().pattern(/\S/).required(),
  interrupt: Joi.alternatives().try(
    Joi.boolean(),
    Joi.object({ words: Joi.number().integer().min(1) }).length(1),
    Joi.object({ heard: Joi.string().pattern(/\S/) }).length(1),
  ),
});

// ── Fixture ───────────────────────────────────────────────────────────────

function loadFixture(fixturePath = DEFAULT_FIXTURE_PATH) {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

// Run-relative dates. The live relay renders the REAL clock into every turn,
// so a fixture that says "Wednesday September 16" stops being "next week"
// the moment the calendar moves — and a booking scenario would then grade
// Sandy on a stale calendar. Fixture strings carry tokens instead, rendered
// once per run from the ET date the run started on:
//   {{day+N}}      Wednesday September 16   (speakSlot form, no year)
//   {{dow+N}}      Wednesday
//   {{monthday+N}} September 16
//   {{iso+N}}      2026-09-16
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DATE_TOKEN_RE = /\{\{(day|dow|monthday|iso)([+-]\d+)\}\}/g;

function etCalendarDate(runDate) {
  const { etParts } = require('../../utils/datetime-et');
  const et = etParts(runDate);
  return new Date(Date.UTC(et.year, et.month - 1, et.day));
}

function renderDateToken(kind, offsetDays, base) {
  const d = new Date(base.getTime() + offsetDays * 86400000);
  const dow = WEEKDAYS[d.getUTCDay()];
  const monthday = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (kind === 'dow') return dow;
  if (kind === 'monthday') return monthday;
  if (kind === 'iso') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${dow} ${monthday}`;
}

/** Deep-render every date token in a scenario (or any JSON value) for one run date. */
function renderDateTokens(value, runDate = new Date()) {
  const base = etCalendarDate(runDate);
  const walk = (v) => {
    if (typeof v === 'string') return v.replace(DATE_TOKEN_RE, (m, kind, offset) => renderDateToken(kind, Number(offset), base));
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
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
const writeToolList = () => (v) => (!Array.isArray(v) || !v.length ? 'value must be a non-empty write-tool list'
  : (v.find((n) => !WRITE_TOOLS.includes(n)) ? `"${v.find((n) => !WRITE_TOOLS.includes(n))}" is not a write tool (${WRITE_TOOLS.join(', ')})` : null));
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const regexPatterns = (v) => (!Array.isArray(v) || !v.length ? 'value must be a non-empty regex list'
  : (v.find((re) => !compileRegex(re)) !== undefined ? `invalid regex ${JSON.stringify(v.find((re) => !compileRegex(re)))}` : null));
// A regex list, or the same list graded from a caller turn onward —
// { patterns: [...], fromTurn: 2 } skips what Sandy said before the caller's
// second turn: a barge-in correction supersedes the read-back it cut.
const regexList = (v) => {
  if (Array.isArray(v)) return regexPatterns(v);
  if (!isPlainObject(v)) return 'value must be a non-empty regex list or { patterns: [...], fromTurn: <caller turn> }';
  const unknown = Object.keys(v).find((k) => k !== 'patterns' && k !== 'fromTurn');
  if (unknown) return `unknown key "${unknown}" (patterns, fromTurn)`;
  if (!Number.isInteger(v.fromTurn) || v.fromTurn < 1) return 'fromTurn must be a caller turn number (1 is the first)';
  return regexPatterns(v.patterns);
};
const CHECK_VALUE_RULES = Object.freeze({
  tools_called_include: toolList,
  tools_performed_include: writeToolList,
  tools_performed_any_of: writeToolList,
  tools_never_called: toolList,
  tools_called_subset_of: toolList,
  spoken_never_matches: () => regexList,
  spoken_matches_any: () => regexList,
  capture_lead_input_includes: () => (v) => (!v || typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).length ? 'value must be an object of capture_lead fields' : null),
  end_session_called: () => (v) => (END_SESSION_SCHEMA.validate(v, { convert: false }).error ? 'value must be boolean or exactly { reason: "<non-empty>" }' : null),
  no_model_text_before_tool: (knownTools) => (v) => (v === true || (Array.isArray(v) && v.length && v.every((n) => WRITE_TOOLS.includes(n) || knownTools.has(n))) ? null : 'value must be true or a tool list'),
  commitment_requires_receipt: () => (v) => (v === true ? null : 'value must be true'),
  tools_called_at_most: (knownTools) => (v) => {
    if (!isPlainObject(v) || !Object.keys(v).length) return 'value must be { <tool>: <max calls> }';
    const unknown = Object.keys(v).find((n) => !knownTools.has(n));
    if (unknown) return `unknown tool "${unknown}"`;
    const bad = Object.entries(v).find(([, n]) => !Number.isInteger(n) || n < 0);
    return bad ? `${bad[0]}: max calls must be a non-negative integer` : null;
  },
  ...SPOKEN_CHECK_VALUE_RULES,
});

const EXPECT_KEYS = Object.freeze(['check', 'value', 'severity', 'adjudicated']);

function lintExpectation(e, i, knownTools) {
  const label = `expect[${i}]`;
  if (!e || !CHECKS.includes(e.check)) return [`${label}: unknown check "${e && e.check}"`];
  const problems = [];
  // A misspelt key (`adjudciated`) would silently demote a blocking major.
  for (const key of Object.keys(e).filter((k) => !EXPECT_KEYS.includes(k))) problems.push(`${label} (${e.check}): unknown key "${key}"`);
  if (!SEVERITIES.includes(e.severity)) problems.push(`${label} (${e.check}): severity must be critical | major | quality`);
  if (e.adjudicated != null && typeof e.adjudicated !== 'boolean') problems.push(`${label} (${e.check}): adjudicated must be boolean`);
  const problem = CHECK_VALUE_RULES[e.check](knownTools)(e.value);
  if (problem) problems.push(`${label} (${e.check}): ${problem}`);
  return problems;
}

// Scenario-level rules, each [problem-when-true, message], in two tables:
// the scenario's shape, and its fixtures.
// Every key a scenario may carry — a misspelled optional key (`allowedToolInput`)
// would otherwise be ignored and grade a replay without the restriction the
// author wrote.
const SCENARIO_KEYS = new Set(['id', 'description', 'language', 'gates', 'allowedTools', 'allowedToolInputs', 'caller', 'fixtures', 'turns', 'spec', 'expect', 'judge']);
// The judge block and the spec are executable contracts, not notes: the judge
// grades against exactly these fields, so a misspelt or mistyped one would
// silently grade a weaker contract than the author wrote (a misspelt
// `adjudicated` makes majors non-blocking; `required_fact` renders as no
// required facts). Every key is validated, unknown keys are refused.
const JUDGE_BLOCK_SCHEMA = Joi.object({ severity: Joi.valid(...SEVERITIES), adjudicated: Joi.boolean() });
const FACT_LIST_SCHEMA = Joi.array().items(Joi.string().pattern(/\S/));
const SPEC_SCHEMA = Joi.object({
  fixture_facts: FACT_LIST_SCHEMA,
  required_facts: FACT_LIST_SCHEMA,
  prohibited_facts: FACT_LIST_SCHEMA,
  acceptable_actions: FACT_LIST_SCHEMA,
  required_action: Joi.string().pattern(/\S/),
  ideal_move: Joi.string().pattern(/\S/),
  transfer_required: Joi.boolean(),
  response_range: Joi.object({ min: Joi.number().integer().min(1).required(), max: Joi.number().integer().min(Joi.ref('min')).required() }),
  max_words_per_agent_turn: Joi.number().integer().min(1),
});
const FIXTURE_KEYS = new Set(['officeHours', 'toolResponses', 'resume', 'modelFailures']);
const CALLER_KEYS = new Set(['from', 'verified', 'context']);
const CALLER_CONTEXT_KEYS = new Set(['customer', 'tier', 'attested', 'block', 'dataTurn']);

// The exact key sets, and the live release condition for an earlier segment:
// recovery releases it only behind the recovery gate on a verified session, so
// a resume outside both is a call that never happens.
function scenarioKeyRules(s) {
  const fx = s.fixtures && typeof s.fixtures === 'object' ? s.fixtures : {};
  const resumeAllowed = !!(s.gates && s.gates.recovery === true && s.caller && s.caller.verified === true);
  return [
    ...Object.keys(s).filter((k) => !SCENARIO_KEYS.has(k)).map((k) => [true, `unknown scenario key "${k}"`]),
    ...Object.keys(fx).filter((k) => !FIXTURE_KEYS.has(k)).map((k) => [true, `fixtures: unknown key "${k}"`]),
    [fx.resume != null && !resumeAllowed, 'fixtures.resume requires gates.recovery: true and caller.verified: true'],
  ];
}

function scenarioShapeRules(s) {
  const turns = Array.isArray(s.turns) ? s.turns : [];
  const spec = isPlainObject(s.spec) ? s.spec : null;
  const specError = spec ? SPEC_SCHEMA.validate(spec, { convert: false }).error : null;
  const judgeError = s.judge !== undefined ? JUDGE_BLOCK_SCHEMA.validate(s.judge, { convert: false }).error : null;
  return [
    ...scenarioKeyRules(s),
    [!['en', 'es'].includes(s.language), 'language must be en or es'],
    [!s.caller || typeof s.caller.from !== 'string' || !/^\+1\d{10}$/.test(s.caller.from), 'caller.from must be an E.164 US number'],
    ...Object.keys(s.caller || {}).filter((k) => !CALLER_KEYS.has(k)).map((k) => [true, `caller: unknown key "${k}"`]),
    [!s.caller || typeof s.caller.verified !== 'boolean', 'caller.verified must be boolean'],
    [s.caller && s.caller.context != null && (typeof s.caller.context !== 'object' || !s.caller.context.customer || !s.caller.context.tier), 'caller.context needs customer + tier'],
    // Every live resolved context carries the matched customer's id — it is
    // what the conversation exposes as ctx.customerId, and without it a
    // "matched" fixture caller would be graded in the unmatched posture.
    [s.caller && s.caller.context != null && s.caller.context.customer != null && !(isPlainObject(s.caller.context.customer) && typeof s.caller.context.customer.id === 'string' && s.caller.context.customer.id.trim()), 'caller.context.customer needs a non-empty id (the matched account, as live resolution returns it)'],
    // The tier and attestation decide which reads and writes production
    // allows; a misspelt value would silently grade the redacted, unattested
    // posture instead of the one the author wrote.
    ...Object.keys((s.caller && s.caller.context) || {}).filter((k) => !CALLER_CONTEXT_KEYS.has(k)).map((k) => [true, `caller.context: unknown key "${k}"`]),
    [s.caller && s.caller.context != null && !['full', 'redacted'].includes(s.caller.context.tier), 'caller.context.tier must be full or redacted'],
    [s.caller && s.caller.context != null && s.caller.context.attested !== undefined && typeof s.caller.context.attested !== 'boolean', 'caller.context.attested must be boolean'],
    // Live resolveCallerContext returns null whenever verification fails, so a
    // context on an unverified caller is a call production can never produce.
    [s.caller && s.caller.context != null && s.caller.verified !== true, 'caller.context requires caller.verified: true (an unverified live caller gets no context)'],
    ...Object.entries(s.gates || {}).map(([key, v]) => [!GATE_ENV[key] || typeof v !== 'boolean', GATE_ENV[key] ? `gate "${key}" must be boolean` : `unknown gate "${key}"`]),
    [!turns.length, 'needs at least one caller turn'],
    ...turns.map((t, i) => { const { error } = TURN_SCHEMA.validate(t, { convert: false }); return [!!error, `turns[${i}]: ${error ? error.message : ''}`]; }),
    [!spec, 'spec is required'],
    [!!specError, `spec: ${specError ? specError.message : ''}`],
    [!!judgeError, `judge: ${judgeError ? judgeError.message : ''}`],
    [!Array.isArray(s.expect), 'expect must be an array'],
  ];
}

function toolResponseEntryRules(name, raw) {
  const entries = Array.isArray(raw) ? raw : [raw];
  const { error } = TOOL_RESPONSES_SCHEMA.validate(entries, { convert: false });
  // An effect belongs to the tool that performs it live — never to another.
  const foreign = [...new Set(entries.flatMap((e) => (e && typeof e === 'object' ? Object.values(TOOL_EFFECT).filter((key) => e[key] !== undefined && TOOL_EFFECT[name] !== key) : [])))];
  const withRefs = entries.filter((e) => e && typeof e === 'object' && e.refs && typeof e.refs === 'object');
  // A ref mapping belongs to the answer that hands the ref out.
  const unissued = withRefs.flatMap((e) => Object.keys(e.refs).filter((ref) => !String(e.text || '').includes(`customer_ref: ${ref}`)));
  return [
    [!!error, `toolResponses.${name}: ${error ? error.message : ''}`],
    ...foreign.map((key) => [true, `toolResponses.${name}: "${key}" is the effect of ${Object.keys(TOOL_EFFECT).find((t) => TOOL_EFFECT[t] === key)}, not ${name}`]),
    [name !== 'lookup_customer' && withRefs.length > 0, `toolResponses.${name}: "refs" belongs to lookup_customer answers only`],
    ...unissued.map((ref) => [true, `toolResponses.${name}: refs names "${ref}", which the answer text does not hand out (customer_ref: ${ref})`]),
  ];
}

function fixtureRules(s, knownTools) {
  const fx = s.fixtures || {};
  const hoursError = OFFICE_HOURS_SCHEMA.validate(fx.officeHours, { convert: false }).error;
  const resumeError = RESUME_SCHEMA.validate(fx.resume, { convert: false }).error;
  return [
    [!!hoursError, `fixtures.officeHours: ${hoursError ? hoursError.message : ''}`],
    [fx.modelFailures != null && !(Number.isInteger(fx.modelFailures) && fx.modelFailures >= 0), 'fixtures.modelFailures must be a non-negative integer'],
    ...Object.keys(fx.toolResponses || {}).map((name) => [!knownTools.has(name), `toolResponses names unknown tool "${name}"`]),
    ...Object.entries(fx.toolResponses || {}).flatMap(([name, raw]) => toolResponseEntryRules(name, raw)),
    [!Array.isArray(s.allowedTools) || !s.allowedTools.length, 'allowedTools must be a non-empty list of the tools this scenario may call'],
    ...(Array.isArray(s.allowedTools) ? s.allowedTools : []).map((name) => [!knownTools.has(name), `allowedTools names unknown tool "${name}"`]),
    [!!resumeError, `fixtures.resume: ${resumeError ? resumeError.message : ''}`],
  ];
}

function lintScenario(s, knownTools) {
  const problems = [...scenarioShapeRules(s), ...fixtureRules(s, knownTools)].filter(([bad]) => bad).map(([, msg]) => msg);
  const expects = Array.isArray(s.expect) ? s.expect : [];
  expects.forEach((e, i) => problems.push(...lintExpectation(e, i, knownTools)));
  // A tool an expectation wants called must be one the scenario allows —
  // otherwise the allowlist and the expectation contradict each other.
  const allowed = new Set(Array.isArray(s.allowedTools) ? s.allowedTools : []);
  if (s.allowedToolInputs != null) {
    const { error } = Joi.object().pattern(Joi.string().valid(...allowed), INPUT_MATCHER_SCHEMA).validate(s.allowedToolInputs, { convert: false });
    if (error) problems.push(`allowedToolInputs: ${error.message}`);
  }
  for (const e of expects) {
    if (e && ['tools_called_include', 'tools_performed_include', 'tools_performed_any_of'].includes(e.check) && Array.isArray(e.value)) {
      for (const name of e.value) if (!allowed.has(name)) problems.push(`expect ${e.check} names "${name}", which allowedTools does not allow`);
    }
  }
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

// Compile the live tool schemas once; validation never coerces model arguments.
let toolValidators = null;
function toolValidator(name) {
  if (!toolValidators) {
    const { TOOLS, CONTEXT_TOOLS, BOOKING_TOOLS } = require('../voice-agent/relay-tools');
    const { TRANSFER_TOOLS } = require('../voice-agent/relay-transfer');
    const ajv = new Ajv();
    toolValidators = new Map([...TOOLS, ...CONTEXT_TOOLS, ...BOOKING_TOOLS, ...TRANSFER_TOOLS].map((t) => [t.name, ajv.compile(t.input_schema || {})]));
  }
  return toolValidators.get(name) || null;
}

const SLOT_REF_RE = /\(slot_ref: (S\d+(?:-\d+)?)\)/g;
const CUSTOMER_REF_RE = /customer_ref: (C\d+(?:-\d+)?)(?![\w-])/g;

// The tools that ISSUE each handle live: the relay registers a slot_ref from
// an availability result and a customer_ref from a lookup result, and only
// from a call that succeeded — a ref quoted in a refusal, a failed answer or
// an unrelated tool's text was never handed out.
const REF_ISSUERS = Object.freeze({ slot_ref: ['find_slots', 'get_availability'], customer_ref: ['lookup_customer'] });
/** The opaque refs earlier fixture results handed the model on THIS call. */
function offeredRefs(record, key) {
  const re = key === 'slot_ref' ? SLOT_REF_RE : CUSTOMER_REF_RE;
  const refs = new Set();
  for (const e of record.events) {
    if (e.kind !== 'tool' || e.ok !== true || !REF_ISSUERS[key].includes(e.name) || !e.text) continue;
    for (const m of String(e.text).matchAll(re)) refs.add(m[1]);
  }
  return refs;
}

// The live lookupCustomersText gate: a criterion counts only when it would
// reach the SQL, and a reference needs two independent ones — so a custom
// fixture cannot hand out a customer_ref for a single-criterion call
// production refuses. Same refusal copy, no oracle.
function lookupCriteriaRefusal(input) {
  const { aniDigitKey, promptSafe, LOOKUP_MIN_CRITERIA_FOR_REF, LOOKUP_MIN_NAME_LEN, LOOKUP_MIN_STREET_LEN } = require('../voice-agent/relay-context');
  const criteria = [];
  if (promptSafe(input.name, 80).split(/\s+/).some((t) => t.length >= LOOKUP_MIN_NAME_LEN)) criteria.push('name');
  if (promptSafe(input.street, 80).length >= LOOKUP_MIN_STREET_LEN) criteria.push('street');
  if (aniDigitKey(input.phone)) criteria.push('phone');
  if (!criteria.length) {
    return 'Not enough to search on yet — ask the caller for the account holder\'s name, the street address of the property, or the phone number on the account, then call lookup_customer again.';
  }
  if (criteria.length < LOOKUP_MIN_CRITERIA_FOR_REF) {
    return 'I need two details to pull up an account — the account holder\'s name AND the street address '
      + 'of the property (the phone number that is on the account works as one of them). Ask the caller for '
      + 'the second detail, then call lookup_customer again with both. Do NOT tell the caller whether '
      + 'anything matched, and do not confirm or deny that an account exists.';
  }
  return null;
}

/**
 * What the real tool would refuse before doing anything: a missing required
 * argument, an invalid schema type or enum, a slot_ref the availability tools never
 * offered on this call, a customer_ref no lookup returned. Returns the refusal
 * text or null. A fixture answer is only ever handed to a VALID call — the
 * point of the fixed world is that an invented ref cannot "succeed".
 */
function validateToolInput(name, input = {}, record) {
  const validate = toolValidator(name);
  if (!validate) return null;
  if (!validate(input)) {
    const error = validate.errors[0];
    if (error.keyword === 'required') return `Missing required argument "${error.params.missingProperty}" — nothing was done. Ask the caller for it and call ${name} again.`;
    return `Invalid argument "${error.instancePath.slice(1) || 'input'}" for ${name}: ${error.message} — nothing was done.`;
  }
  for (const field of validate.schema.required || []) {
    if (String(input[field]).trim() === '') {
      return `Missing required argument "${field}" — nothing was done. Ask the caller for it and call ${name} again.`;
    }
  }
  // The live resolvers (relay-conversation resolveSlotRef / resolveLookupRef)
  // trim and upper-case a handle before the lookup, so "s2" books S2 there —
  // the same call must not read as an invented ref here.
  for (const key of ['slot_ref', 'customer_ref']) {
    if (typeof input[key] === 'string') input[key] = input[key].trim().toUpperCase();
  }
  if (name === 'lookup_customer') {
    const refusal = lookupCriteriaRefusal(input);
    if (refusal) return refusal;
  }
  if (name === 'request_booking' && !offeredRefs(record, 'slot_ref').has(String(input.slot_ref))) {
    return `slot_ref "${input.slot_ref}" was not offered on this call — NOTHING was booked. Call find_slots and pass back a slot_ref it printed.`;
  }
  if (input.customer_ref !== undefined && input.customer_ref !== null && String(input.customer_ref) !== '' && !offeredRefs(record, 'customer_ref').has(String(input.customer_ref))) {
    return `customer_ref "${input.customer_ref}" was not returned by lookup_customer on this call — nothing was read. Look the account up first.`;
  }
  return null;
}

// The live executeTool authorization boundaries (relay-tools), mirrored
// BEFORE any fixture answer so a custom fixture cannot hand sensitive data to
// a call production refuses: the four carrier-vouched reads need attestation
// from a caller the session recognised, and history, invoices and reports
// are the ANI-matched caller's own account only — never a looked-up ref,
// never a stranger. Same refusal copy as relay-tools, no oracle.
const ATTESTATION_WITHHELD_TEXT = 'That detail is not available on this call. Tell the caller you can see their account but cannot go '
  + 'through invoice amounts, past messages, call notes or report details over the phone, and that a Waves '
  + 'team member will follow up — they can also see all of it signed in to their portal. Do not explain why.';
const HISTORY_REFUSALS = Object.freeze({
  lookedUp: 'Call and text history are only available for the account the caller\'s own phone number '
    + 'matches — never for a looked-up account. Do not share, summarize, or hint at any past call '
    + 'or text on this account.',
  unmatched: 'No customer account matches the number this call is coming from, so there is no call or '
    + 'text history to read. Do NOT guess at past calls or texts. Offer to have the office follow up, '
    + 'and capture the lead.',
});
const MATCHED_ONLY_REFUSALS = Object.freeze({
  get_call_history: HISTORY_REFUSALS,
  get_message_history: HISTORY_REFUSALS,
  get_invoice_history: {
    lookedUp: 'Invoice detail is only available for the account the caller\'s own phone number matches. '
      + 'For a looked-up account you can say only whether a balance is open, never amounts.',
    unmatched: 'No customer account matches the number this call is coming from, so there are no invoices '
      + 'to read. Do NOT guess at amounts owed. Offer to have the office follow up, and capture the lead.',
  },
  get_service_report: {
    lookedUp: 'Visit reports are only available for the account the caller\'s own phone number matches. '
      + 'For a looked-up account you can confirm visit dates and service names, nothing further.',
    unmatched: 'No customer account matches the number this call is coming from, so there is no visit report '
      + 'to read. Do NOT describe any visit. Offer to have the office follow up, and capture the lead.',
  },
});
const LOOKUP_UNVERIFIED_TEXT = 'I cannot pull up an account on this call. Ask the caller for their name, the service address and '
  + 'what they need, capture the lead, and tell them a Waves team member will call them back. Do NOT tell '
  + 'the caller whether anything matched, and do not confirm or deny that an account exists.';
// The live write refusals (relay-booking / relay-reservice): both writes
// need a customer account, and without VOICE_RELAY_ALLOW_THIRD_PARTY_WRITES
// only a FULL ANI match may write — a looked-up ref or a contact-slot match
// is captured as a lead instead.
const WRITE_REFUSALS = Object.freeze({
  request_booking: {
    noCustomer: 'Booking requests need a customer account: the caller\'s own matched account, or a '
      + 'customer_ref from lookup_customer. For a brand-new caller, capture the lead with their '
      + 'preferred time — a team member will call to book them. Do NOT tell the caller anything is booked.',
    thirdParty: 'Booking requests are only placed for the account the caller\'s own phone number matches. '
      + 'Capture the lead with the caller\'s name, the account they are calling about and their preferred '
      + 'time, and tell them a Waves team member will call to confirm. Do NOT tell the caller anything is booked.',
  },
  request_reservice: {
    noCustomer: 'This tool only works for the account the caller\'s own phone number matches. For anyone else, '
      + 'use capture_lead with what is going on and tell them a Waves team member will follow up. '
      + 'Do NOT promise a free re-service.',
    thirdParty: 'Re-service requests are only filed for the account the caller\'s own phone number matches. '
      + 'Capture the lead with what they are seeing and where, and tell them a Waves team member will call '
      + 'them back about it. Do NOT tell the caller a re-service has been scheduled or filed.',
  },
});
// The account a customer_ref names, as the fixture lookup answer that
// issued it declared (`refs`). Undeclared: some other account — the live
// default for a looked-up ref is a third party's, never the caller's own.
function refCustomerId(scenario, ref) {
  const raw = scenario?.fixtures?.toolResponses?.lookup_customer;
  for (const entry of (Array.isArray(raw) ? raw : [raw]).map(normalizeToolResponse).filter(Boolean)) {
    if (entry.refs && typeof entry.refs[ref] === 'string') return entry.refs[ref];
  }
  return null;
}
function writeRefusal(name, input, ctx, scenario) {
  const refusals = WRITE_REFUSALS[name];
  if (!refusals) return null;
  const { matchedCallerTier } = require('../voice-agent/relay-tools');
  const { allowsThirdPartyWrites } = require('../voice-agent/relay-booking');
  const ref = String(input.customer_ref || '').trim();
  // A re-service is the matched caller's own account only; a booking may
  // name a looked-up account, which is a third-party write unless the ref
  // resolves to the caller's own account (relay-booking compares the ids).
  if (name === 'request_reservice' && ref) return refusals.noCustomer;
  if (!ref && !ctx.customerId) return refusals.noCustomer;
  const lookedUpAccount = !!ref && refCustomerId(scenario, ref) !== (ctx.customerId || null);
  const thirdParty = lookedUpAccount || matchedCallerTier(ctx) !== 'full';
  return thirdParty && !allowsThirdPartyWrites() ? refusals.thirdParty : null;
}
function liveAuthorizationRefusal(name, input = {}, ctx = {}, scenario = null) {
  const { ATTESTATION_ONLY_TOOLS, matchedCallerTier } = require('../voice-agent/relay-tools');
  const write = writeRefusal(name, input, ctx, scenario);
  if (write) return write;
  // lookup_customer is reachable by an unmatched caller, so it proves the
  // call itself (relay-context lookupCustomersText) before anything else.
  if (name === 'lookup_customer' && ctx.callerVerified !== true) return LOOKUP_UNVERIFIED_TEXT;
  const scope = ATTESTATION_ONLY_TOOLS[name];
  const recognised = !!ctx.customerId && (scope === 'any-tier' || matchedCallerTier(ctx) === 'full');
  if (scope && recognised && ctx.callerAttested !== true) return ATTESTATION_WITHHELD_TEXT;
  const refusals = MATCHED_ONLY_REFUSALS[name];
  if (!refusals) return null;
  if (String(input.customer_ref || '').trim()) return refusals.lookedUp;
  if (!ctx.customerId) return refusals.unmatched;
  return null;
}

// The live capture_lead's phone gate (relay-tools): a spam capture is
// suppressed before any number is read; otherwise the number the caller gave
// (callback_phone) is preferred over the caller ID WITHOUT falling back to it,
// and a non-E.164 result saves nothing.
const NO_CALLBACK_NUMBER_TEXT = 'I could not save the lead yet — we do not have a valid phone number to reach the caller. '
  + 'Ask the caller for the best 10-digit number and call capture_lead again with callback_phone.';
function noCallbackNumber(name, input, scenario) {
  if (name !== 'capture_lead' || input.lead_quality === 'spam') return null;
  const { toE164, isLikelyE164 } = require('../../utils/phone');
  return isLikelyE164(toE164(input.callback_phone || scenario.caller?.from || '')) ? null : NO_CALLBACK_NUMBER_TEXT;
}

/** Does `input` satisfy a `when` matcher? Strings match case-insensitively as substrings, arrays as any-of, everything else strictly. */
function inputMatches(input = {}, when = {}) {
  return Object.entries(when).every(([field, want]) => {
    const have = input[field];
    if (Array.isArray(want)) return want.some((w) => (typeof w === 'string' ? String(have ?? '').toLowerCase().includes(w.toLowerCase()) : have === w));
    if (typeof want === 'string') return String(have ?? '').toLowerCase().includes(want.toLowerCase());
    return have === want;
  });
}

/**
 * The fixture's answer for a call. An entry may carry `when` (argument
 * matchers — the answer belongs to THOSE arguments, so a schema-valid but
 * scenario-wrong call never receives it) and `once` (consumed by its first
 * match). Conditioned entries are tried first, in order; unconditioned
 * entries require all one-shot matches to have been consumed, then step by
 * invocation count, the last one repeating — unless it is `once`, which
 * stops the repeat (a second success would award a write receipt the
 * fixture never set up). Returns
 * `{ response }`, `{ mismatch: true }` when no response is eligible, or null
 * when the fixture has no entry for the tool at all.
 */
function pickToolResponse(scenario, name, n, input = {}, used = {}) {
  const raw = scenario?.fixtures?.toolResponses?.[name];
  if (raw === undefined) return null;
  const entries = (Array.isArray(raw) ? raw : [raw]).map(normalizeToolResponse).filter(Boolean);
  const conditioned = entries.filter((e) => e.when);
  const unconditioned = entries.filter((e) => !e.when);
  for (const entry of conditioned) {
    const key = `${name}:${entries.indexOf(entry)}`;
    if (entry.once && used[key]) continue;
    if (inputMatches(input, entry.when)) {
      if (entry.once) used[key] = true;
      return { response: entry };
    }
  }
  if (!unconditioned.length || conditioned.some((entry) => entry.once && !used[`${name}:${entries.indexOf(entry)}`])) return { mismatch: true };
  const entry = unconditioned[Math.min(Math.max(n, 1), unconditioned.length) - 1];
  const key = `${name}:${entries.indexOf(entry)}`;
  if (entry.once && used[key]) return { mismatch: true };
  if (entry.once) used[key] = true;
  return { response: entry };
}

// The live capture_lead accumulates the estimate fields across one call's
// captures (relay-tools `priorEstimateFields`): a retry that supplies only the
// missing piece completes the request. The fixture matcher sees that same
// view — this call's non-empty fields, then the latest earlier answered
// capture's, and so on back; a call the tool refused never accumulated.
const ESTIMATE_FIELDS = Object.freeze(['first_name', 'last_name', 'email', 'address_line1', 'city', 'zip', 'requested_service', 'pain_points']); // relay-tools' estimateFields, every key
function matcherInput(record, event, name, input) {
  if (name !== 'capture_lead') return input;
  const { isValidEmail } = require('../../utils/internal-email-recipients');
  // The live tool drops an undeliverable email before it accumulates ("priya
  // dot raman at example dot com" is reported as missing, never queued).
  const nz = (v) => v != null && String(v).trim() !== '';
  const usable = (field, v) => nz(v) && (field !== 'email' || isValidEmail(String(v).trim()));
  const view = { ...input };
  if (!usable('email', view.email)) delete view.email;
  for (const prior of [...record.toolCalls].reverse()) {
    if (prior === event || prior.name !== 'capture_lead' || prior.ok !== true) continue;
    for (const field of ESTIMATE_FIELDS) if (!nz(view[field]) && usable(field, prior.input[field])) view[field] = prior.input[field];
  }
  return view;
}

/**
 * The ctx side effects the real write tools perform — capture latch, booking /
 * re-service / transfer marks. Never a write. Returns the answer text and
 * whether a RECEIPT was produced: only a fixture answer that performed one of
 * these effects is a receipt — there is no bare receipt marker, since a write
 * the live tool never latched cannot back a promise; a dedupe answer is
 * `reservice: 'existing'` (evidence, not a receipt), and a refusal ("that
 * time is gone", "transfer not available") is an answer, never a receipt.
 */
function applyToolSideEffects(response, { input, ctx, scenario }) {
  const text = response.text || '';
  if (response.ok === false) return { text, receipt: false };
  const ctxCall = (fn, ...args) => (typeof ctx[fn] === 'function' ? ctx[fn](...args) : undefined);
  let receipt = false;
  if (response.capture) {
    ctxCall('markCaptured', response.capture === true ? {} : response.capture);
    if (input.call_summary) ctxCall('noteCallSummary', input.call_summary);
    receipt = input.lead_quality !== 'spam'; // the live spam branch suppresses capture without writing a lead or callback
  }
  if (response.booking) { ctxCall('markBookingRequested', null); receipt = true; }
  if (response.reservice === true) {
    // The live tool latches capture too (relay-reservice: the call's artifact
    // is a ticket, no lead) — so the session ends after the goodbye as in
    // production instead of taking turns production would ignore.
    ctxCall('markCaptured', { leadCreated: false });
    ctxCall('markReserviceFiled');
    receipt = true;
  }
  // Already open: nothing filed, nothing latched (the live path returns
  // before either mark) and nothing performed — but the ticket on file is
  // the office's record, evidence for the ONE follow-up the answer directs.
  const existing = response.reservice === 'existing';
  if (!response.transfer) return { text, receipt, existing };
  if (ctxCall('transferRequested') === true) return { text: TRANSFER_IN_PROGRESS_TEXT, receipt: false };
  ctxCall('markTransferRequested');
  const { copy } = require('../voice-agent/relay-language');
  ctxCall('say', copy('transferring', scenario.language === 'es' ? 'es-US' : null));
  ctxCall('endForTransfer');
  return { text: text || TRANSFER_TEXT, receipt: true };
}

function recordToolCall(record, name, input) {
  const event = { kind: 'tool', name, input: safeInput(input), text: '', turn: record.turn, modelRound: record.modelCalls, ok: false, receipt: false, existing: false, unexpected: false, invalid: false, mismatch: false, index: record.events.length };
  record.events.push(event);
  record.toolCalls.push(event);
  return event;
}

/**
 * executeTool, fixture edition. Records the call and answers from the fixture
 * and performs the SAME ctx side effects the real tool would (capture latch,
 * booking / re-service / transfer marks, the lookup budget) — never a write.
 */
async function runFixtureTool(state, name, input = {}, ctx = {}) {
  const { scenario, record } = state;
  if (!scenario || !record) throw new Error('voice-relay eval: tool called outside a scenario');
  const event = recordToolCall(record, name, input);
  const answer = (text, ok) => { event.ok = ok; event.text = text; return text; };
  // The live resolvers (relay-conversation resolveSlotRef / resolveLookupRef)
  // trim and upper-case a handle before anything — the authorization check
  // included — looks at it, so "c1" is the caller's own C1 here as it is
  // there; the call is graded by the handle the tool actually saw.
  for (const key of ['slot_ref', 'customer_ref']) {
    if (typeof input[key] === 'string') { input[key] = input[key].trim().toUpperCase(); event.input[key] = input[key]; }
  }
  // The real tool's own refusals come first — a missing argument, a bad
  // enum, an invented ref — before any fixture answer, hanging or not.
  const refused = liveAuthorizationRefusal(name, input, ctx, scenario);
  if (refused) { event.invalid = true; event.refused = true; return answer(refused, false); }
  const invalid = validateToolInput(name, input, record) || noCallbackNumber(name, input, scenario);
  if (invalid) { event.invalid = true; return answer(invalid, false); }
  // The live lookup spends its budget on every DB-eligible call BEFORE the
  // query, whether or not anything matches.
  if (name === 'lookup_customer' && typeof ctx.consumeLookup === 'function' && ctx.consumeLookup() !== true) return answer(LOOKUP_BUDGET_TEXT, false);
  // Only a call the real tool would have run advances the staged answers: a
  // rejected attempt never invoked the tool, so it cannot consume a result.
  record.toolUse[name] = (record.toolUse[name] || 0) + 1;
  // The view the tool acted on: for capture_lead, this call's fields over
  // the earlier accepted captures' (the live accumulation) — graded as such.
  event.accumulated = matcherInput(record, event, name, input);
  const picked = pickToolResponse(scenario, name, record.toolUse[name], event.accumulated, record.toolResponseUse);
  if (!picked) {
    event.unexpected = true;
    record.warnings.push(`tool ${name} called with no fixture response`);
    return answer(DEFAULT_TOOL_TEXT, false);
  }
  if (picked.mismatch) {
    // Schema-valid arguments the scenario did not set up: the answer for
    // THOSE arguments does not exist, so the call gets a refusal — never a
    // success meant for different arguments.
    event.invalid = true;
    event.mismatch = true;
    return answer(MISMATCH_TEXT, false);
  }
  const { response } = picked;
  if (response.hang === true) {
    event.hang = true;
    return new Promise(() => {}); // the live bound (_executeToolBounded) degrades it
  }
  const { text, receipt, existing } = applyToolSideEffects(response, { input, ctx, scenario });
  event.receipt = receipt === true;
  event.existing = existing === true;
  // A fixture `ok: false` stands in for the live tool THROWING: relay-tools'
  // catch answers with a string and raises ctx.toolFailed so the session
  // counts the failure (two in a row hand the call off) and the handoff
  // record never reports it as ok. The refusals above (invalid arguments, a
  // spent lookup budget, nothing matching) are answered live without a
  // throw and stay ok, as they do here.
  if (response.ok === false && ctx && typeof ctx === 'object') ctx.toolFailed = true;
  return answer(String(text), response.ok !== false);
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
  const renderClockBlock = relayContext.renderClockBlock;
  relayContext.renderClockBlock = (...args) => {
    const text = renderClockBlock(...args);
    const record = state.record;
    if (text && record) record.events.push({ kind: 'clock', text, turn: record.turn, index: record.events.length });
    return text;
  };
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
        if (state.record) state.record.modelCalls += 1;
        if (state.modelFailuresLeft > 0) {
          state.modelFailuresLeft -= 1;
          if (state.record) state.record.injected.push('model_failure');
          throw new Error('voice-relay eval: injected model failure');
        }
        // Model telemetry per scenario: a completed round vs a REAL provider
        // error. Without it a keyless or outage run would read green — Sandy's
        // "could you say that again?" fallback speaks nothing forbidden.
        const record = state.record;
        let stream;
        try {
          stream = realStream.apply(this, args);
        } catch (err) {
          // A throw during request construction never reaches the
          // finalMessage wrapper below; the relay speaks its fallback and the
          // round would otherwise grade as completed.
          if (record) record.modelErrors.push(err && err.message ? err.message : String(err));
          throw err;
        }
        if (record && stream && typeof stream.finalMessage === 'function') {
          const finalMessage = stream.finalMessage.bind(stream);
          stream.finalMessage = () => finalMessage().then(
            (msg) => { record.modelRounds += 1; return msg; },
            (err) => {
              // The relay aborts the same controller for a caller barge-in AND
              // for its 20 s stream timeout. Only an abort that lands while the
              // harness itself is interrupting is deliberate; any other abort
              // is a stalled provider and a real failure.
              const message = err && err.message ? err.message : String(err);
              const aborted = (err && err.name === 'AbortError') || /abort/i.test(message);
              if (aborted && record.interruptInFlight) record.modelAborts += 1;
              else record.modelErrors.push(aborted ? `stream aborted by the relay's own bound: ${message}` : message);
              throw err;
            },
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
  if (segmentsText) record.events.push({ kind: 'resume', text: segmentsText, turn: 0, index: record.events.length });
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
  if (spec && typeof spec === 'object' && typeof spec.heard === 'string') {
    // An explicit `heard` must be what actually played: a prefix of the
    // utterance being cut (the live matcher's normalisation). Anything else
    // would rewrite the record to speech the model never produced — or hide
    // speech it did — so the replay stops rather than grading a fiction.
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    heard = spec.heard;
    if (!norm(heard) || !norm(last.text).startsWith(norm(heard))) {
      throw Object.assign(new Error(`interrupt "heard" is not a prefix of the agent utterance it cuts: ${JSON.stringify(clip(heard, 80))} vs ${JSON.stringify(clip(last.text, 80))}`), { code: 'EVAL_INTERRUPT_MISMATCH' });
    }
  } else {
    const n = spec && typeof spec === 'object' && Number.isInteger(spec.words) ? spec.words : Math.max(1, Math.floor(words.length / 2));
    heard = words.slice(0, n).join(' ');
  }
  record.interruptInFlight = true;
  try {
    convo.interrupt({ utteranceUntilInterrupt: heard, durationUntilInterruptMs: 1200 });
  } finally {
    record.interruptInFlight = false;
  }
  // The conversation rewrote its own record to what was played ("<heard>
  // [interrupted]"); the harness grades that, never the words the caller
  // did not hear. The full model text survives on the event as `planned`.
  const played = [...(convo._transcript || [])].reverse().find((e) => e.role === 'agent');
  last.planned = last.text;
  last.text = played && played.text ? played.text : `${heard} [interrupted]`;
  last.interrupted = true;
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

/**
 * The labelled dialogue. Tool lines carry name, input and result — clipped
 * for the reviewable record, complete (`full`) for the judge, which must see
 * every fact Sandy saw or an accurate readback of a late fact grades as
 * invented.
 */
function renderTranscript(events = [], { full = false } = {}) {
  const lines = [];
  const evidence = (value, n) => (full ? String(value || '').replace(/\s+/g, ' ').trim() : clip(value, n));
  for (const e of events) {
    if (e.kind === 'caller') lines.push(`Caller: ${e.text}${e.ignored ? ' (not heard — the session was already ending)' : ''}`);
    else if (e.kind === 'agent') lines.push(`Agent: ${e.text}`);
    else if (e.kind === 'clock') lines.push(`[clock] ${e.text}`);
    else if (e.kind === 'resume') lines.push(`[earlier call segment]\n${e.text}\n[end earlier call segment]`);
    else if (e.kind === 'interrupt') lines.push(`[caller interrupted the agent after: "${e.text}"]`);
    else if (e.kind === 'tool') lines.push(`[tool] ${e.name}(${evidence(JSON.stringify(e.input || {}), 240)}) → ${evidence(e.text, 600)}`);
  }
  return lines.join('\n');
}

/**
 * What Sandy was told to be and do on this call — the system prompt frozen
 * for the session, minus the per-caller block the judge receives separately.
 * Null until the first model round composes the prompt.
 */
function standingInstructionsOf(convo, scenario) {
  const frozen = convo._systemBlocks && convo._systemBlocks[0] ? String(convo._systemBlocks[0].text || '') : '';
  if (!frozen.trim()) return null;
  const block = scenario.caller && scenario.caller.context ? scenario.caller.context.block : null;
  return (block ? frozen.replace(block, '') : frozen).replace(/\n{3,}/g, '\n\n').trim();
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
  tools_called_include(value, record, { validNames, calledNames }) {
    const missing = value.filter((n) => !validNames.includes(n));
    if (!missing.length) return ['pass', `called: ${value.join(', ')}`];
    const rejected = missing.filter((n) => calledNames.includes(n));
    return ['fail', `never validly called: ${missing.join(', ')}${rejected.length ? ` (${rejected.join(', ')} called with arguments the tool rejected)` : ''}`];
  },
  tools_never_called(value, record, { calledNames }) {
    const hit = value.filter((n) => calledNames.includes(n));
    return hit.length ? ['fail', `called: ${hit.join(', ')}`] : ['pass', 'none called'];
  },
  tools_called_subset_of(value, record, { calledNames }) {
    const extra = [...new Set(calledNames.filter((n) => !value.includes(n)))];
    return extra.length ? ['fail', `outside the allowed set: ${extra.join(', ')}`] : ['pass', `called ⊆ {${value.join(', ')}}`];
  },
  // Every invocation counts — a refused retry (the live in-flight latch, a
  // mismatch) is still the model calling the tool again.
  tools_called_at_most(value, record, { calledNames }) {
    const over = Object.entries(value).map(([n, max]) => [n, calledNames.filter((c) => c === n).length, max]).filter(([, count, max]) => count > max);
    return over.length ? ['fail', over.map(([n, count, max]) => `${n} called ${count}× (max ${max})`).join(', ')] : ['pass', Object.entries(value).map(([n, max]) => `${n} ≤ ${max}`).join(', ')];
  },
  // A write the fixture PERFORMED (a receipt) — a refusal answer ("that time
  // is gone") is a valid call, but the tool did not do the scenario's job.
  tools_performed_include(value, record, { performedNames }) {
    const missing = value.filter((n) => !performedNames.includes(n));
    return missing.length ? ['fail', `never performed: ${missing.join(', ')}`] : ['pass', `performed: ${value.join(', ')}`];
  },
  // The scenario's artifact may take either form (a re-service ticket OR a
  // captured lead) — but one of them must have been performed.
  tools_performed_any_of(value, record, { performedNames }) {
    const hit = value.filter((n) => performedNames.includes(n));
    return hit.length ? ['pass', `performed: ${hit.join(', ')}`] : ['fail', `none of ${value.join(', ')} was performed`];
  },
  spoken_never_matches(value, record, view) {
    const { sources, spoken, scope } = spokenScope(value, view);
    const hit = firstRegexHit(sources, spoken);
    return hit ? ['fail', `/${hit.source}/i matched${scope}: "${clip(hit.text, 160)}"`] : ['pass', `no forbidden phrase spoken${scope}`];
  },
  spoken_matches_any(value, record, view) {
    const { sources, spoken, scope } = spokenScope(value, view);
    const hit = firstRegexHit(sources, spoken);
    return hit ? ['pass', `/${hit.source}/i matched${scope}: "${clip(hit.text, 160)}"`] : ['fail', `none of ${sources.map((v) => `/${v}/i`).join(', ')} was spoken${scope}`];
  },
  capture_lead_input_includes(value, record) {
    // Only a capture the fixture ACCEPTED and answered ok counts — a rejected
    // call (missing call_summary, bad enum) or a failed one (`ok: false`, no
    // side effects) recorded nothing, whatever fields it carried.
    const captures = record.toolCalls.filter((t) => t.name === 'capture_lead' && t.ok === true && !t.invalid && !t.unexpected);
    if (!captures.length) return ['fail', record.toolCalls.some((t) => t.name === 'capture_lead') ? 'capture_lead never succeeded (every call was rejected for its arguments or failed)' : 'capture_lead was never called'];
    // Graded on the accumulated view the tool acted on: a retry that supplied
    // only the missing field completed the request live, and does here.
    const best = captures.map((c) => inputIncludes(c.accumulated || c.input, value)).reduce((a, b) => (b.length < a.length ? b : a));
    return best.length ? ['fail', `no capture_lead input satisfied: ${best.join('; ')}`] : ['pass', 'capture_lead input includes every expected field'];
  },
  end_session_called(value, record) {
    const want = typeof value === 'boolean' ? value : true;
    const called = record.endSession != null;
    if (called !== want) return ['fail', want ? 'the session was never ended by the agent' : `the agent ended the session (${record.endSession.reason})`];
    if (typeof value === 'object' && record.endSession.reason !== value.reason) return ['fail', `ended for "${record.endSession.reason}", wanted "${value.reason}"`];
    return ['pass', called ? `ended (${record.endSession.reason})` : 'session left open'];
  },
  no_model_text_before_tool(value, record, { utterances }) {
    const tools = value === true ? WRITE_TOOLS : value;
    for (const call of record.toolCalls.filter((t) => tools.includes(t.name))) {
      const before = utterances.find((u) => u.turn === call.turn && u.modelRound === call.modelRound && u.index < call.index && !u.system);
      if (before) return ['fail', `"${clip(before.text, 120)}" was spoken before ${call.name} ran`];
    }
    return ['pass', 'no model text preceded a write'];
  },
  // Every spoken promise needs a receipt that PRECEDES it: a write the
  // fixture actually performed (capture / booking / re-service / transfer),
  // never a refusal, and never one that only landed after the promise.
  commitment_requires_receipt(value, record, { utterances }) {
    const promises = utterances.filter((u) => isCommitment(u.text));
    if (!promises.length) return ['pass', 'no follow-up was promised'];
    // A write that timed out, or a ticket already on file, backs the ONE
    // promise the live answer itself directs ("tell the caller a Waves team
    // member will follow up"): the call is on the record for the office,
    // nothing is claimed done and nothing was performed. Any other
    // commitment — an emailed estimate, a text — still needs a performed write.
    const receipts = record.toolCalls.filter((t) => WRITE_TOOLS.includes(t.name) && (t.receipt === true || t.hang === true || t.existing === true));
    const backs = (r, p) => r.index < p.index && (r.receipt === true || DIRECTED_FOLLOW_UP_RE.test(p.text));
    const unbacked = promises.find((p) => !receipts.some((r) => backs(r, p)));
    if (unbacked) return ['fail', `promised "${clip(unbacked.text, 120)}" with no write receipt before it`];
    return ['pass', `every promise followed a receipt (${[...new Set(receipts.map((r) => `${r.name}${r.hang ? ' (timed out)' : r.existing ? ' (already on file)' : ''}`))].join(', ')})`];
  },
  ...SPOKEN_CHECK_RUNNERS,
});

// The patterns and the speech they grade: every utterance, or — for
// { patterns, fromTurn } — only what Sandy said from that caller turn on.
function spokenScope(value, { spoken, utterances }) {
  if (Array.isArray(value)) return { sources: value, spoken, scope: '' };
  return { sources: value.patterns, spoken: utterances.filter((u) => u.turn >= value.fromTurn).map((u) => u.text), scope: ` from caller turn ${value.fromTurn}` };
}

function firstRegexHit(sources, spoken) {
  for (const source of sources) {
    const re = compileRegex(source);
    const text = spoken.find((t) => re && re.test(t));
    if (text) return { source, text };
  }
  return null;
}

// A call the fixture REJECTED (missing argument, bad enum, invented ref) is
// not the tool being called: it did nothing, so it cannot satisfy a
// tools_called_include expectation. It still counts against never/subset.
function validCallNames(record) {
  return record.toolCalls.filter((t) => !t.invalid && !t.unexpected).map((t) => t.name);
}

function runCheck(expectation, record) {
  const utterances = agentUtterances(record);
  const view = {
    calledNames: record.toolCalls.map((t) => t.name),
    validNames: validCallNames(record),
    performedNames: record.toolCalls.filter((t) => t.receipt === true).map((t) => t.name),
    utterances,
    spoken: utterances.map((u) => u.text),
  };
  const runner = CHECK_RUNNERS[expectation.check];
  const [status, detail] = runner ? runner(expectation.value, record, view) : ['skip', `unknown check ${expectation.check}`];
  const severity = expectation.check === 'commitment_requires_receipt' ? 'critical' : expectation.severity;
  return { check: expectation.check, severity, adjudicated: expectation.adjudicated === true, status, detail };
}

// The scenario's allowlist, graded as an implicit CRITICAL check on every
// scenario: a tool outside `allowedTools` — a stray write above all — is a
// blocking miss, whatever the fixture happens to answer for it.
// An allowlisted value is exact, like the live enum check (capture_lead
// compares lead_quality === 'spam'): "spam " or "not_spam" is outside it.
function inputAllowed(input = {}, allowed = {}) {
  return Object.entries(allowed).every(([field, want]) => (Array.isArray(want) ? want.some((w) => input[field] === w) : input[field] === want));
}
function allowedToolsCheck(scenario, record) {
  const allowed = new Set(scenario.allowedTools || []);
  const outside = [...new Set(record.toolCalls.filter((t) => !allowed.has(t.name) || !inputAllowed(t.input, scenario.allowedToolInputs?.[t.name] || {})).map((t) => t.name))];
  return {
    check: 'allowed_tools', severity: 'critical', adjudicated: true,
    status: outside.length ? 'fail' : 'pass',
    detail: outside.length ? `called outside allowedTools or allowedToolInputs: ${outside.join(', ')}` : `every call inside {${[...allowed].join(', ')}} with permitted inputs`,
  };
}

function evaluateChecks(scenario, record) {
  // Receipt evidence is mandatory for every scenario, including custom fixtures.
  // Ignore explicit copies so they cannot weaken or double-count the invariant.
  return [
    allowedToolsCheck(scenario, record),
    runCheck({ check: 'commitment_requires_receipt', value: true, severity: 'critical', adjudicated: true }, record),
    ...(scenario.expect || []).filter((e) => e.check !== 'commitment_requires_receipt').map((e) => runCheck(e, record)),
  ];
}

// The major-tier lines of a verdict: [check, failed, detail]. The verdict
// line grades ONLY a holistic "fail" with clean detail fields (the judge's
// own call); a fail explained by a detail finding is counted once, on that
// finding's line.
function judgeMajorLines(v, scenario) {
  // transfer_ok is graded only where the spec requires a transfer; elsewhere a
  // verdict that fails on it alone is a holistic fail, reported on the verdict line.
  const transferRequired = !!(scenario.spec && scenario.spec.transfer_required === true);
  const detailFailed = v.forbidden_claims.length > 0 || v.required_facts_missing.length > 0 || v.prohibited_facts_stated.length > 0 || !v.action_ok || (transferRequired && !v.transfer_ok);
  const verdictDetail = v.pass ? 'pass' : (detailFailed ? 'failed on the findings below' : (v.rationale ? clip(v.rationale, 200) : 'the judge failed the call'));
  return [
    ['judge:verdict', !v.pass && !detailFailed, verdictDetail],
    ['judge:required_facts', v.required_facts_missing.length > 0, v.required_facts_missing.length ? `missing: ${v.required_facts_missing.join('; ')}` : 'all required facts conveyed'],
    ['judge:prohibited_facts', v.prohibited_facts_stated.length > 0, v.prohibited_facts_stated.length ? `stated: ${v.prohibited_facts_stated.join('; ')}` : 'none stated'],
    ['judge:action', !v.action_ok, v.action_taken || (v.action_ok ? 'acceptable' : 'not an acceptable action')],
    ...(transferRequired ? [['judge:transfer', !v.transfer_ok, v.transfer_ok ? 'transferred' : 'the caller was not handed to a person']] : []),
  ];
}

// The quality-tier lines of a verdict: [check, failed, detail].
const judgeQualityLines = (v) => [
  ['judge:empathy', !v.empathy_ok, v.empathy_ok ? 'ok' : 'concern not acknowledged specifically'],
  ['judge:brevity', !v.brevity_ok, v.brevity_ok ? 'ok' : 'a turn ran past the spec\'s range'],
  ['judge:tone', v.tone != null && v.tone < 3, `tone ${v.tone == null ? 'n/a' : `${v.tone}/5`}`],
];

/** The judge's verdict as checks. Fallback-leg verdicts are advisory: never pass/fail. */
function judgeChecks(scenario, judge) {
  if (!judge) return [];
  const severity = (scenario.judge && scenario.judge.severity) || 'major';
  const adjudicated = !!(scenario.judge && scenario.judge.adjudicated === true);
  if (!judge.ok) return [{ check: 'judge:verdict', severity, adjudicated, status: 'skip', detail: `judge unavailable (${judge.reason})` }];
  const advisory = judge.judge_fallback === true;
  const mk = ([check, failed, detail], sev) => ({
    check, severity: sev, adjudicated, status: advisory ? 'advisory' : (failed ? 'fail' : 'pass'), detail: advisory ? `(fallback-leg verdict, advisory) ${detail}` : detail,
  });
  return [
    ...judgeMajorLines(judge.verdict, scenario).map((line) => mk(line, severity)),
    ...judge.verdict.forbidden_claims.map((c) => mk([`judge:forbidden_claim:${c.category}`, true, c.quote ? `"${clip(c.quote, 160)}"` : 'no quote'], 'critical')),
    ...judgeQualityLines(judge.verdict).map((line) => mk(line, 'quality')),
  ];
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
    id: scenario.id, language: scenario.language || 'en', from: (scenario.caller && scenario.caller.from) || null, turn: 0, events: [], spoken: [], toolCalls: [], toolUse: {},
    endSession: null, injected: [], dbAttempts: [], warnings: [], toolsAvailable: [], promptSha: null, model: h.MODEL,
    modelRounds: 0, modelErrors: [], modelCalls: 0, modelAborts: 0, interruptInFlight: false, toolResponseUse: {},
  };
}

/** The live conversation, wired to the record instead of a socket. */
function newConversation(h, scenario, record) {
  const caller = scenario.caller || {};
  const convo = new h.RelayConversation({
    callSid: null,
    sessionKey: null,
    callTokenVerified: caller.verified === true,
    from: caller.from || null,
    to: EVAL_CALLER_TO,
    language: scenario.language === 'es' ? 'es-US' : null,
    send: (text) => {
      const t = String(text || '');
      record.events.push({ kind: 'agent', text: t, turn: record.turn, modelRound: record.modelCalls, index: record.events.length });
      record.spoken.push(t);
    },
    endSession: (frame) => { record.endSession = { ...(frame || {}), turn: record.turn }; return true; },
  });
  // Record the result the live bound hands to Sandy, including timeouts and
  // in-flight refusals that never invoke the fixture tool a second time.
  const executeBounded = convo._executeToolBounded.bind(convo);
  convo._executeToolBounded = async (name, input = {}, ctx = {}) => {
    const firstEvent = record.toolCalls.length;
    const out = await executeBounded(name, input, ctx);
    const event = record.toolCalls[firstEvent] || recordToolCall(record, name, input);
    event.text = String(out);
    return out;
  };
  return convo;
}

function errorRecord(err) {
  return { name: (err && err.name) || 'Error', message: err && err.message ? err.message : String(err), code: (err && err.code) || null };
}

/** The judged layer for one finished record (run in a pool after the conversations). */
async function judgeRecord(scenario, record, judgeFn) {
  const run = judgeFn || require('./voice-relay-judge').judgeTranscript;
  const context = (scenario.caller && scenario.caller.context) || {};
  const callerBlock = context.block || null;
  // The recent-text data turn the conversation seeds into Sandy's context is
  // agent-visible: a fact repeated from it is grounded, not invented.
  const dataTurn = typeof context.dataTurn === 'string' && context.dataTurn.trim() ? context.dataTurn : null;
  const { runAsReplay } = require('../llm-dispatch-metrics');
  const transcript = renderTranscript(record.events, { full: true });
  record.judge = await runAsReplay(() => run({ spec: scenario.spec || {}, transcript, language: record.language, toolsAvailable: record.toolsAvailable, callerBlock, dataTurn, standingInstructions: record.standingInstructions || null }), 'voice_relay_judge')
    .catch((err) => ({ ok: false, reason: `judge_error:${err && err.message ? err.message : err}` }));
  record.checks.push(...judgeChecks(scenario, record.judge));
  record.qualityScore = qualityScore(record.checks);
  record.status = scenarioStatus(record);
  return record;
}

/** Run `fn` over `items` at most `width` at a time, preserving order. */
async function mapPool(items, width, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return out;
}

async function runScenario(scenario, { judge = false, judgeFn = null } = {}) {
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
    // No usable SDK in this process is a missing model, not a malformed replay.
    if (h.state.modelFailuresLeft > 0 && !h.modelFaultInjection) {
      throw Object.assign(new Error('model unavailable: fixtures.modelFailures needs model fault injection, which this process could not install (no usable SDK)'), { code: 'EVAL_MODEL_UNAVAILABLE' });
    }
    const convo = newConversation(h, scenario, record);
    applyResumeFixture(convo, scenario, record);
    await driveTurns(convo, scenario, record);
    record.toolsAvailable = (convo._tools || []).map((t) => t.name);
    record.promptSha = convo._promptSha || null;
    // Judge grounding, not a result: non-enumerable so the run's JSON does
    // not repeat the prompt per scenario (promptSha fingerprints it).
    Object.defineProperty(record, 'standingInstructions', { value: standingInstructionsOf(convo, scenario), enumerable: false, writable: true });
    // Any REAL provider error (an injected failure is expected and excluded,
    // a barge-in abort is deliberate) means the conversation did not run as
    // scripted — before the first round or after ten, the checks would be
    // grading the relay's fallback copy. A replay error, never a pass.
    if (record.modelErrors.length) {
      throw Object.assign(new Error(`model unavailable: ${record.modelErrors[0]}`), { code: 'EVAL_MODEL_UNAVAILABLE' });
    }
    // The relay never reached the model at all: with no SDK client (no
    // ANTHROPIC_API_KEY at load) relay-conversation speaks its "unavailable"
    // copy and calls nothing — no round, no error, and a green-looking call.
    if (record.modelCalls === 0 && record.turn > 0) {
      throw Object.assign(new Error('model unavailable: the relay never called the model (no SDK client — is ANTHROPIC_API_KEY set?)'), { code: 'EVAL_MODEL_UNAVAILABLE' });
    }
    // Every injected failure must have been consumed, or the handoff the
    // fixture asked for (a second failure) was never exercised. Judged after
    // the model checks: with no model at all, that is the finding.
    if (h.state.modelFailuresLeft > 0) {
      throw Object.assign(new Error(`fixtures.modelFailures: ${h.state.modelFailuresLeft} injected failure(s) never reached the model — the turns ended first`), { code: 'EVAL_MODEL_FAILURES_UNUSED' });
    }
    // The world was not fixed: the conversation reached for a tool the
    // fixture does not answer (a generic answer graded nothing real) or for
    // the database (refused, but the relay may have degraded silently).
    // Either is a replay error, never a green scenario.
    const unfixtured = [...new Set(record.toolCalls.filter((t) => t.unexpected).map((t) => t.name))];
    if (unfixtured.length) throw Object.assign(new Error(`unfixtured tool call: ${unfixtured.join(', ')} — add toolResponses for it`), { code: 'EVAL_UNFIXTURED_TOOL' });
    if (h.guard.attempts.length) throw Object.assign(new Error(`database reached during the conversation: ${[...new Set(h.guard.attempts)].join(', ')}`), { code: 'EVAL_DB_REFUSED' });
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
  record.qualityScore = qualityScore(record.checks);
  record.status = scenarioStatus(record);
  // Conversation database access is refused above; the optional judge uses
  // its normal replay-labelled ledger lane after that guard is disarmed.
  if (!record.error && judge) await judgeRecord(scenario, record, judgeFn);
  return record;
}

// ── The run ───────────────────────────────────────────────────────────────

// One record's contribution to the run summary (misses per tier and telemetry).
function tallyRecord(summary, r, all) {
  summary.durationMs += r.durationMs || 0;
  summary.dbRefusals += (r.dbAttempts || []).length;
  summary.unexpectedTools += (r.toolCalls || []).filter((t) => t.unexpected).length;
  summary.invalidInputs += (r.toolCalls || []).filter((t) => t.invalid).length;
  summary.warnings += (r.warnings || []).length;
  summary.modelRounds += r.modelRounds || 0;
  summary.modelErrors += (r.modelErrors || []).length;
  if (r.error && r.error.code === 'EVAL_MODEL_UNAVAILABLE') summary.modelUnavailable += 1;
  if (r.status === 'error') { summary.replayErrors += 1; summary.replayErrorIds.push(r.id); return; }
  if (r.status === 'fail') { summary.failed += 1; summary.failedIds.push(r.id); } else summary.passed += 1;
  if (r.judge) {
    if (r.judge.ok) { summary.judged += 1; if (r.judge.judge_fallback) summary.judgeFallbacks += 1; } else summary.judgeErrors += 1;
  }
  tallyMisses(summary, r.checks || [], all);
}

// Misses per tier; every pass/fail check also feeds the run's quality score.
const MISS_COUNTER = Object.freeze({ critical: 'criticalMisses', major: 'majorMisses', quality: 'qualityMisses' });
function tallyMisses(summary, checks, all) {
  for (const c of checks) {
    all.push(c);
    if (c.status !== 'fail') continue;
    summary[MISS_COUNTER[c.severity] || 'qualityMisses'] += 1;
    if (c.severity === 'major' && c.adjudicated) summary.adjudicatedMajorMisses += 1;
  }
}

function summarize(results, { judge = false } = {}) {
  const summary = {
    scenarios: results.length, passed: 0, failed: 0, replayErrors: 0, replayErrorIds: [], failedIds: [],
    criticalMisses: 0, adjudicatedMajorMisses: 0, majorMisses: 0, qualityMisses: 0,
    judge, judged: 0, judgeFallbacks: 0, judgeErrors: 0, dbRefusals: 0, unexpectedTools: 0, invalidInputs: 0, warnings: 0,
    modelRounds: 0, modelErrors: 0, modelUnavailable: 0, qualityScore: null, durationMs: 0,
  };
  const all = [];
  for (const r of results) tallyRecord(summary, r, all);
  summary.qualityScore = qualityScore(all);
  return summary;
}

function summaryLine(summary = {}) {
  const n = (k) => summary[k] || 0;
  const pct = summary.qualityScore == null ? 'n/a' : `${(summary.qualityScore * 100).toFixed(1)}%`;
  const segments = [
    `scenarios=${n('scenarios')} passed=${n('passed')} failed=${n('failed')} replayErrors=${n('replayErrors')}`,
    `critical=${n('criticalMisses')} adjudicatedMajor=${n('adjudicatedMajorMisses')} major=${n('majorMisses')} quality=${n('qualityMisses')}`,
    `judged=${n('judged')}${summary.judge === false ? ' (judge off)' : ''} judgeFallbacks=${n('judgeFallbacks')} judgeErrors=${n('judgeErrors')}`,
    `qualityScore=${pct} modelRounds=${n('modelRounds')}`,
    n('modelErrors') && `modelErrors=${n('modelErrors')}`,
    n('dbRefusals') && `dbRefusals=${n('dbRefusals')}`,
    (summary.failedIds || []).length && `failed=[${summary.failedIds.join(', ')}]`,
    (summary.replayErrorIds || []).length && `errors=[${summary.replayErrorIds.join(', ')}]`,
  ];
  return segments.filter(Boolean).join(' ');
}

// Failed checks and replay errors both make the run fail.
function isFailedVoiceRun(run) {
  if (run && run.failed === true) return true;
  const s = (run && run.summary) || {};
  return (s.replayErrors || 0) > 0 || (s.failed || 0) > 0 || (s.judgeErrors || 0) > 0;
}

/** The rendered, linted fixture's scenarios, narrowed to `only` when given. Throws on a malformed fixture or an unknown id. */
function selectScenarios(fixture, only) {
  const lint = lintFixture(fixture);
  if (lint.length) throw new Error(`fixture lint failed: ${lint.slice(0, 5).join(' | ')}${lint.length > 5 ? ` (+${lint.length - 5} more)` : ''}`);
  if (!Array.isArray(only) || !only.length) return fixture.scenarios;
  const unknown = only.filter((id) => !fixture.scenarios.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown scenario id(s): ${unknown.join(', ')}`);
  return fixture.scenarios.filter((s) => only.includes(s.id));
}

/**
 * A run that could not evaluate anything is inconclusive, not green: no
 * scenario completed a model round while at least one lost its model (a
 * model-outage scenario completes zero rounds by design, so the rule is not
 * "every scenario errored").
 */
function assertRunConclusive(summary, results, judge = false) {
  if (summary.modelRounds === 0 && summary.modelUnavailable > 0) {
    const first = results.find((r) => r.error && r.error.code === 'EVAL_MODEL_UNAVAILABLE');
    throw new Error(`no scenario completed a model round — ${first.error.message}`);
  }
  if (judge && summary.judged === 0 && summary.judgeErrors > 0) {
    const first = results.find((r) => r.judge && !r.judge.ok);
    throw new Error(`the judge graded no scenario — ${first.judge.reason}`);
  }
}

async function runVoiceRelayReplay({ fixturePath = DEFAULT_FIXTURE_PATH, only = null, judge = false, judgeFn = null, runDate = new Date() } = {}) {
  // One clock per run: every scenario's dated fixture is rendered against
  // the same ET date, and the lint sees the rendered strings.
  const fixture = renderDateTokens(loadFixture(fixturePath), runDate);
  const scenarios = selectScenarios(fixture, only);
  installHarness();
  // In production the WebSocket keeps the process alive; here nothing does.
  // The relay's own time bounds are unref'd timers, so a hanging fixture tool
  // ({ hang: true }) would otherwise let Node exit mid-scenario, silently.
  const keepAlive = setInterval(() => {}, 1000);
  const results = [];
  try {
    // Conversations run sequentially because they share the patched world.
    for (const scenario of scenarios) {
      const record = await runScenario(scenario);
      results.push(record);
    }
    if (judge) {
      await mapPool(scenarios, JUDGE_CONCURRENCY, (scenario, i) => (results[i].error ? results[i] : judgeRecord(scenario, results[i], judgeFn)));
    }
    for (const record of results) {
      logger.info(`[voice-relay-eval] ${record.id}: ${record.status}${record.error ? ` (${record.error.message})` : ''} checks=${record.checks.length} tools=${record.toolCalls.length} ${record.durationMs}ms`);
    }
  } finally {
    clearInterval(keepAlive);
  }
  const summary = summarize(results, { judge });
  assertRunConclusive(summary, results, judge);
  return { failed: isFailedVoiceRun({ summary }), fixturePath, schemaVersion: fixture.schemaVersion, runDate: runDate.toISOString(), judge, summary, results };
}

// ── Retry-once / notify wrapper (the call-replay shape) ───────────────────

function failureLines(run) {
  const lines = [];
  for (const r of (run && run.results) || []) {
    if (r.status === 'error') lines.push(`${r.id}: replay error (${r.error && r.error.message ? r.error.message : 'unknown error'})`);
    if (r.judge && !r.judge.ok) lines.push(`${r.id}: unjudged — judge unavailable (${r.judge.reason || 'unknown'})`);
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
  const failing = (summary.failed || 0) + (summary.replayErrors || 0);
  const unjudged = summary.judgeErrors || 0;
  const title = failing
    ? `Voice relay eval: ${failing} failing scenario(s)${unjudged ? `, ${unjudged} unjudged` : ''}`
    : `Voice relay eval: ${unjudged} scenario(s) unjudged — judge unavailable`;
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
  return notifyError;
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
  return notifyError;
}

/** The wrapper's retry-once shape: a second attempt only after a failed first one; pass-on-retry is flaky. */
async function attemptWithRetry(runReplay, replayOptions, attemptOptions) {
  const first = await attemptReplay(runReplay, replayOptions, attemptOptions);
  if (first.status !== 'fail') return { finalAttempt: first, attempts: [first], flaky: false };
  const retry = await attemptReplay(runReplay, replayOptions, attemptOptions);
  const flaky = retry.status === 'pass';
  if (flaky) logger.warn('[voice-relay-eval] pass-on-retry; treating as flaky, not failing');
  return { finalAttempt: retry.status === 'inconclusive' ? first : retry, attempts: [first, retry], flaky };
}

/** The outcome's notification, if any. Returns the bell's insert error (the email channel has already fired) or null. */
async function notifyOutcome({ notifyOnFailure, notify, sendEmail, finalAttempt, attempts, fixturePath }) {
  if (!notifyOnFailure) {
    logger.info(`[voice-relay-eval] manual run — ${finalAttempt.status}, no notification`);
    return null;
  }
  if (finalAttempt.status === 'fail') return notifyFailure({ notify, sendEmail, finalAttempt, attempts, fixturePath });
  if (finalAttempt.status === 'inconclusive') return notifyInconclusive({ notify, sendEmail, attempt: finalAttempt, fixturePath });
  return null;
}

/**
 * The scheduled shape: one attempt, retry once on failure (pass-on-retry is
 * flaky, not a failure), one admin bell + ops email on repeated failure or
 * when the eval could not run. Never throws for a failed eval, and never for
 * a bell that failed to insert either: the email channel has fired
 * independently, and a FINISHED evaluation must still return its result
 * (with `notificationError`) rather than read as a crash to the cron.
 */
async function runVoiceRelayEval(opts = {}) {
  const runReplay = opts.runReplay || runVoiceRelayReplay;
  const notify = opts.notify || defaultNotify;
  const sendEmail = opts.sendEmail || defaultSendEmail;
  // notifyOnFailure: false = a manual run — no bell, no email AND no ops
  // digest (emailFailure's deliverOpsDigest writes an in-app notification
  // under GATE_OPS_DIGESTS_IN_APP even with the email sender stubbed).
  const notifyOnFailure = opts.notifyOnFailure !== false;
  const fixturePath = opts.fixturePath || DEFAULT_FIXTURE_PATH;
  const replayOptions = { fixturePath, only: opts.only || null, judge: opts.judge !== false, judgeFn: opts.judgeFn || null };
  const { finalAttempt, attempts, flaky } = await attemptWithRetry(runReplay, replayOptions, { isFailed: isFailedVoiceRun, lane: 'voice_relay' });
  const notificationError = await notifyOutcome({ notifyOnFailure, notify, sendEmail, finalAttempt, attempts, fixturePath });
  if (notificationError) logger.error(`[voice-relay-eval] notification insert failed (email channel already attempted): ${notificationError.message}`);
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
    notificationError: notificationError ? notificationError.message : null,
  };
  logger.info(`[voice-relay-eval] done: status=${result.status}${flaky ? ' flaky=true' : ''} | ${summaryLine(result.summary || {})}`);
  return result;
}

/**
 * The cron's crash path: the child died (timeout, signal, startup failure,
 * no JSON) before it could send its own notification, so the parent sends
 * the inconclusive alert — a dead weekly monitor must never be silent.
 */
async function notifyEvalCrash(err, { notify = defaultNotify, sendEmail = defaultSendEmail, fixturePath = DEFAULT_FIXTURE_PATH } = {}) {
  const notifyError = await notifyInconclusive({ notify, sendEmail, fixturePath, attempt: { status: 'inconclusive', error: { name: (err && err.name) || 'Error', message: err && err.message ? err.message : String(err) } } });
  if (notifyError) throw notifyError;
}

/**
 * The cron entry point: the whole eval in a child process (its per-scenario
 * gate env and its patched relay modules never touch the server). Resolves
 * with the child's JSON result; rejects when the child crashed or produced
 * nothing parseable. The child notifies on its own (--notify).
 */
function runVoiceRelayEvalProcess({ timeoutMs = CHILD_TIMEOUT_MS, scriptPath = SCRIPT_PATH, execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(process.execPath, [scriptPath, '--json', '--judge', '--notify'], {
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
  renderDateTokens,
  lintFixture,
  knownToolNames,
  installHarness,
  runScenario,
  runVoiceRelayReplay,
  runVoiceRelayEval,
  runVoiceRelayEvalProcess,
  notifyEvalCrash,
  summaryLine,
  isFailedVoiceRun,
  _internals: {
    CHILD_TIMEOUT_MS, attemptWithRetry, notifyOutcome, failureLines, notifyFailure, notifyInconclusive,
    JUDGE_CONCURRENCY, judgeChecks, judgeRecord, mapPool, PROMISE_RE, DEFAULT_TOOL_TEXT, LOOKUP_BUDGET_TEXT, EVAL_CALLER_TO, ESTIMATE_FIELDS, allowedToolsCheck, validCallNames,
    makeDbGuard, officeHoursFixture, pickToolResponse, inputMatches, MISMATCH_TEXT, runFixtureTool, applyToolSideEffects, validateToolInput, offeredRefs, applyGates, applyResumeFixture, injectInterrupt, driveTurns, selectScenarios, assertRunConclusive,
    renderTranscript, evaluateChecks, runCheck, CHECK_RUNNERS, lintScenario, scenarioStatus, qualityScore, summarize,
  },
};
