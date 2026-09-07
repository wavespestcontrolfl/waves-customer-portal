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
 * Scenario specs remain available as notes for manual review.
 *
 * SAFETY BY CONSTRUCTION
 *   - end() is never called: no call_log reconcile, no capture floor, no
 *     transcript write — no relay row exists, so the self-training guard holds.
 *   - executeTool is replaced wholesale (no lead, ticket, booking or handoff
 *     packet can be written), the capture-floor / callback writers are stubbed
 *     to throw, and the db module is proxied to REFUSE any query while a
 *     scenario's conversation runs. No database read or write is permitted.
 *   - This module must load BEFORE voice-agent/relay-conversation, which
 *     destructures resolveCallerContext / createLeadFromExtraction at load.
 *     The manual script guarantees that; jest isolates
 *     the module registry. It throws on the wrong order rather than running
 *     against the live resolvers.
 *   - Per-scenario gates mutate process.env. Run this only in its dedicated
 *     CLI process, never inside a running application server.
 */

const fs = require('fs');
const path = require('path');
const Joi = require('joi');
const Ajv = require('ajv');
const logger = require('../logger');

const SCHEMA_VERSION = 'voice-relay-scenarios.v1';
const DEFAULT_FIXTURE_PATH = path.join(__dirname, '..', '..', 'fixtures', 'voice-relay-eval', 'scenarios.json');
// The number the synthetic caller "dialled" (555 = fictional). Only a label
// on the tool ctx: the fixture tools never resolve it.
const EVAL_CALLER_TO = '+19415550100';
// scenario.gates key → the env var the relay reads at call time. Every one of
// these is read per call (no module-top reads), so a scenario may flip them
// without re-requiring the relay modules.
const GATE_ENV = Object.freeze({
  context: 'VOICE_RELAY_CONTEXT_ENABLED',
  booking: 'GATE_VOICE_AI_BOOKING',
  transfer: 'GATE_VOICE_RELAY_TRANSFER',
  recovery: 'GATE_VOICE_RELAY_RECOVERY',
  interrupt: 'GATE_VOICE_RELAY_INTERRUPT_CONTEXT',
});

const SEVERITIES = Object.freeze(['critical', 'major', 'quality']);
const SEVERITY_WEIGHT = Object.freeze({ critical: 3, major: 2, quality: 1 });
const CHECKS = Object.freeze([
  'tools_called_include', 'tools_never_called', 'tools_called_subset_of',
  'spoken_never_matches', 'spoken_matches_any', 'capture_lead_input_includes',
  'end_session_called', 'no_model_text_before_tool',
  'commitment_requires_receipt', 'tools_performed_include',
]);
// The registered write tools and the ONE ctx effect each performs live
// (relay-tools / relay-booking / relay-reservice / relay-transfer). A fixture
// answer may carry only its own tool's effect — `request_booking: { capture }`
// would latch a capture the live booking tool never performs.
const TOOL_EFFECT = Object.freeze({ capture_lead: 'capture', request_booking: 'booking', request_reservice: 'reservice', transfer_to_office: 'transfer' });
// The tools whose PERFORMED write is a receipt for a spoken promise, and the
// default set no model text may precede — the registered write tools only.
const WRITE_TOOLS = Object.freeze(Object.keys(TOOL_EFFECT));
// Follow-up promises, EN + ES, over what Sandy actually said.
const PROMISE_RE = /\b(?:(?:will|going to|gonna) (?:call|text|email|reach out|follow up|send|get back)|(?:i|we)['’]?ll (?:call|text|email|reach out|follow up|send|get back)|someone (?:will|is going to)|(?:i['’]?ll|i will) (?:(?:ask|get|arrange for) (?:the office|someone|(?:a |the )?(?:waves )?team member|the team) to (?:call|text|email|reach out|follow up|get back)|have (?:the office|someone|(?:a |the )?(?:waves )?team member|the team) (?:call|text|email|reach out|follow up|get back)|make sure (?:the office|someone|(?:a |the )?(?:waves )?team member|the team) (?:calls?|texts?|emails?|reaches? out|follows? up|gets? back)|note (?:your|the|a) (?:callback|call-back|follow-up) request|let (?:the office|(?:a |the )?(?:waves )?team member|the team) know|pass (?:this|that|it|your (?:message|request)) (?:on|along) to (?:the office|(?:a |the )?(?:waves )?team member|the team))|(?:you'?ll|you will) (?:hear|get|receive)|(?:a |the )?(?:waves )?team member will|(?:le|te|les) (?:llamar(?:é|emos|á|án)?|devolver(?:é|emos|á|án)?|enviar(?:é|emos|á|án)?|contactar(?:é|emos|á|án)?|dar(?:é|emos|á|án)?)|se comunicar)\b/i;
// A promise quoted inside a refusal or conditional offer is not a commitment.
const NON_COMMITMENT_PREFIX_RE = /\b(?:cannot|can['’]?t|won['’]?t|not|never|unable|if|whether|would you like|si|no puedo|no podemos)\b/i;
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
    reservice: Joi.boolean(),
    capture: Joi.alternatives().try(Joi.boolean(), Joi.object().min(1).unknown(true)),
  }).custom((entry, helpers) => {
    const hasEffect = ['hang', 'transfer', 'booking', 'reservice', 'capture'].some((key) => entry[key] === true);
    if (entry.text || hasEffect || (entry.capture && typeof entry.capture === 'object')) return entry;
    return helpers.message('response needs non-empty text, a side effect, or hang: true');
  }),
).required());

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
const regexList = (v) => (!Array.isArray(v) || !v.length ? 'value must be a non-empty regex list'
  : (v.find((re) => !compileRegex(re)) !== undefined ? `invalid regex ${JSON.stringify(v.find((re) => !compileRegex(re)))}` : null));
const writeToolList = () => (v) => (!Array.isArray(v) || !v.length ? 'value must be a non-empty write-tool list'
  : (v.find((n) => !WRITE_TOOLS.includes(n)) ? `"${v.find((n) => !WRITE_TOOLS.includes(n))}" is not a write tool (${WRITE_TOOLS.join(', ')})` : null));
const CHECK_VALUE_RULES = Object.freeze({
  tools_called_include: toolList,
  tools_performed_include: writeToolList,
  tools_never_called: toolList,
  tools_called_subset_of: toolList,
  spoken_never_matches: () => regexList,
  spoken_matches_any: () => regexList,
  capture_lead_input_includes: () => (v) => (!v || typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).length ? 'value must be an object of capture_lead fields' : null),
  end_session_called: () => (v) => (END_SESSION_SCHEMA.validate(v, { convert: false }).error ? 'value must be boolean or exactly { reason: "<non-empty>" }' : null),
  no_model_text_before_tool: (knownTools) => (v) => (v === true || (Array.isArray(v) && v.length && v.every((n) => WRITE_TOOLS.includes(n) || knownTools.has(n))) ? null : 'value must be true or a tool list'),
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

// Scenario-level rules, each [problem-when-true, message], in two tables:
// the scenario's shape, and its fixtures.
function scenarioShapeRules(s) {
  const turns = Array.isArray(s.turns) ? s.turns : [];
  const spec = s.spec && typeof s.spec === 'object' ? s.spec : null;
  return [
    [!['en', 'es'].includes(s.language), 'language must be en or es'],
    [!s.caller || typeof s.caller.from !== 'string' || !/^\+1\d{10}$/.test(s.caller.from), 'caller.from must be an E.164 US number'],
    [s.caller && s.caller.context != null && (typeof s.caller.context !== 'object' || !s.caller.context.customer || !s.caller.context.tier), 'caller.context needs customer + tier'],
    ...Object.entries(s.gates || {}).map(([key, v]) => [!GATE_ENV[key] || typeof v !== 'boolean', GATE_ENV[key] ? `gate "${key}" must be boolean` : `unknown gate "${key}"`]),
    [!turns.some((t) => t && typeof t.caller === 'string' && t.caller.trim()), 'needs at least one caller turn'],
    [!spec, 'spec is required'],
    ...['required_facts', 'prohibited_facts', 'acceptable_actions'].map((k) => [spec && spec[k] != null && !Array.isArray(spec[k]), `spec.${k} must be an array`]),
    [spec && spec.required_action != null && typeof spec.required_action !== 'string', 'spec.required_action must be a string'],
    [!Array.isArray(s.expect), 'expect must be an array'],
  ];
}

function toolResponseEntryRules(name, raw) {
  const entries = Array.isArray(raw) ? raw : [raw];
  const { error } = TOOL_RESPONSES_SCHEMA.validate(entries, { convert: false });
  // An effect belongs to the tool that performs it live — never to another.
  const foreign = [...new Set(entries.flatMap((e) => (e && typeof e === 'object' ? Object.values(TOOL_EFFECT).filter((key) => e[key] !== undefined && TOOL_EFFECT[name] !== key) : [])))];
  return [
    [!!error, `toolResponses.${name}: ${error ? error.message : ''}`],
    ...foreign.map((key) => [true, `toolResponses.${name}: "${key}" is the effect of ${Object.keys(TOOL_EFFECT).find((t) => TOOL_EFFECT[t] === key)}, not ${name}`]),
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
    if (e && ['tools_called_include', 'tools_performed_include'].includes(e.check) && Array.isArray(e.value)) {
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

/** The opaque refs earlier fixture results handed the model on THIS call. */
function offeredRefs(record, re) {
  const refs = new Set();
  for (const e of record.events) {
    if (e.kind !== 'tool' || !e.text) continue;
    for (const m of String(e.text).matchAll(re)) refs.add(m[1]);
  }
  return refs;
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
  if (name === 'request_booking' && !offeredRefs(record, SLOT_REF_RE).has(String(input.slot_ref))) {
    return `slot_ref "${input.slot_ref}" was not offered on this call — NOTHING was booked. Call find_slots and pass back a slot_ref it printed.`;
  }
  if (input.customer_ref !== undefined && input.customer_ref !== null && String(input.customer_ref) !== '' && !offeredRefs(record, CUSTOMER_REF_RE).has(String(input.customer_ref))) {
    return `customer_ref "${input.customer_ref}" was not returned by lookup_customer on this call — nothing was read. Look the account up first.`;
  }
  return null;
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
 * invocation count, the last one repeating. Returns
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
  return { response: unconditioned[Math.min(Math.max(n, 1), unconditioned.length) - 1] };
}

/**
 * The ctx side effects the real write tools perform — capture latch, booking /
 * re-service / transfer marks. Never a write. Returns the answer text and
 * whether a RECEIPT was produced: only a fixture answer that performed one of
 * these effects is a receipt — a refusal ("that time is gone", "already on
 * file", "transfer not available") is an answer, never a receipt.
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
  if (response.reservice) {
    // The live tool latches capture too (relay-reservice: the call's artifact
    // is a ticket, no lead) — so the session ends after the goodbye as in
    // production instead of taking turns production would ignore.
    ctxCall('markCaptured', { leadCreated: false });
    ctxCall('markReserviceFiled');
    receipt = true;
  }
  if (!response.transfer) return { text, receipt };
  if (ctxCall('transferRequested') === true) return { text: TRANSFER_IN_PROGRESS_TEXT, receipt: false };
  ctxCall('markTransferRequested');
  const { copy } = require('../voice-agent/relay-language');
  ctxCall('say', copy('transferring', scenario.language === 'es' ? 'es-US' : null));
  ctxCall('endForTransfer');
  return { text: text || TRANSFER_TEXT, receipt: true };
}

function recordToolCall(record, name, input) {
  const event = { kind: 'tool', name, input: safeInput(input), text: '', turn: record.turn, modelRound: record.modelCalls, ok: false, receipt: false, unexpected: false, invalid: false, mismatch: false, index: record.events.length };
  record.toolUse[name] = (record.toolUse[name] || 0) + 1;
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
  // The real tool's own refusals come first — a missing argument, a bad
  // enum, an invented ref — before any fixture answer, hanging or not.
  const invalid = validateToolInput(name, input, record);
  if (invalid) { event.invalid = true; return answer(invalid, false); }
  const picked = pickToolResponse(scenario, name, record.toolUse[name], input, record.toolResponseUse);
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
    return new Promise(() => {}); // the live bound (_executeToolBounded) degrades it
  }
  if (name === 'lookup_customer' && typeof ctx.consumeLookup === 'function' && ctx.consumeLookup() !== true) return answer(LOOKUP_BUDGET_TEXT, false);
  const { text, receipt } = applyToolSideEffects(response, { input, ctx, scenario });
  event.receipt = receipt === true;
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
        const stream = realStream.apply(this, args);
        const record = state.record;
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

/** The labelled dialogue for manual review. Tool lines carry name, input and result. */
function renderTranscript(events = []) {
  const lines = [];
  for (const e of events) {
    if (e.kind === 'caller') lines.push(`Caller: ${e.text}${e.ignored ? ' (not heard — the session was already ending)' : ''}`);
    else if (e.kind === 'agent') lines.push(`Agent: ${e.text}`);
    else if (e.kind === 'clock') lines.push(`[clock] ${e.text}`);
    else if (e.kind === 'resume') lines.push(`[earlier call segment]\n${e.text}\n[end earlier call segment]`);
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
  // A write the fixture PERFORMED (a receipt) — a refusal answer ("that time
  // is gone") is a valid call, but the tool did not do the scenario's job.
  tools_performed_include(value, record) {
    const performed = record.toolCalls.filter((t) => t.receipt === true).map((t) => t.name);
    const missing = value.filter((n) => !performed.includes(n));
    return missing.length ? ['fail', `never performed: ${missing.join(', ')}`] : ['pass', `performed: ${value.join(', ')}`];
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
    // Only a capture the fixture ACCEPTED and answered ok counts — a rejected
    // call (missing call_summary, bad enum) or a failed one (`ok: false`, no
    // side effects) recorded nothing, whatever fields it carried.
    const captures = record.toolCalls.filter((t) => t.name === 'capture_lead' && t.ok === true && !t.invalid && !t.unexpected);
    if (!captures.length) return ['fail', record.toolCalls.some((t) => t.name === 'capture_lead') ? 'capture_lead never succeeded (every call was rejected for its arguments or failed)' : 'capture_lead was never called'];
    const best = captures.map((c) => inputIncludes(c.input, value)).reduce((a, b) => (b.length < a.length ? b : a));
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
    const promises = utterances.filter((u) => String(u.text).split(/[.!?;]|\b(?:but|however|though|although)\b/i).some((clause) => {
      const match = PROMISE_RE.exec(clause);
      return match && !NON_COMMITMENT_PREFIX_RE.test(clause.slice(0, match.index));
    }));
    if (!promises.length) return ['pass', 'no follow-up was promised'];
    const receipts = record.toolCalls.filter((t) => WRITE_TOOLS.includes(t.name) && t.receipt === true);
    const unbacked = promises.find((p) => !receipts.some((r) => r.index < p.index));
    if (unbacked) return ['fail', `promised "${clip(unbacked.text, 120)}" with no write receipt before it`];
    return ['pass', `every promise followed a receipt (${[...new Set(receipts.map((r) => r.name))].join(', ')})`];
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

// A call the fixture REJECTED (missing argument, bad enum, invented ref) is
// not the tool being called: it did nothing, so it cannot satisfy a
// tools_called_include expectation. It still counts against never/subset.
function validCallNames(record) {
  return record.toolCalls.filter((t) => !t.invalid && !t.unexpected).map((t) => t.name);
}

function runCheck(expectation, record) {
  const utterances = agentUtterances(record);
  const view = { calledNames: record.toolCalls.map((t) => t.name), validNames: validCallNames(record), utterances, spoken: utterances.map((u) => u.text) };
  const runner = CHECK_RUNNERS[expectation.check];
  const [status, detail] = runner ? runner(expectation.value, record, view) : ['skip', `unknown check ${expectation.check}`];
  const severity = expectation.check === 'commitment_requires_receipt' ? 'critical' : expectation.severity;
  return { check: expectation.check, severity, adjudicated: expectation.adjudicated === true, status, detail };
}

// The scenario's allowlist, graded as an implicit CRITICAL check on every
// scenario: a tool outside `allowedTools` — a stray write above all — is a
// blocking miss, whatever the fixture happens to answer for it.
function allowedToolsCheck(scenario, record) {
  const allowed = new Set(scenario.allowedTools || []);
  const outside = [...new Set(record.toolCalls.filter((t) => !allowed.has(t.name) || !inputMatches(t.input, scenario.allowedToolInputs?.[t.name] || {})).map((t) => t.name))];
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

async function runScenario(scenario) {
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
  record.qualityScore = qualityScore(record.checks);
  record.status = scenarioStatus(record);
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

function summarize(results) {
  const summary = {
    scenarios: results.length, passed: 0, failed: 0, replayErrors: 0, replayErrorIds: [], failedIds: [],
    criticalMisses: 0, adjudicatedMajorMisses: 0, majorMisses: 0, qualityMisses: 0,
    dbRefusals: 0, unexpectedTools: 0, invalidInputs: 0, warnings: 0,
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
  return (s.replayErrors || 0) > 0 || (s.failed || 0) > 0;
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
function assertRunConclusive(summary, results) {
  if (summary.modelRounds === 0 && summary.modelUnavailable > 0) {
    const first = results.find((r) => r.error && r.error.code === 'EVAL_MODEL_UNAVAILABLE');
    throw new Error(`no scenario completed a model round — ${first.error.message}`);
  }
}

async function runVoiceRelayReplay({ fixturePath = DEFAULT_FIXTURE_PATH, only = null, runDate = new Date() } = {}) {
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
    for (const record of results) {
      logger.info(`[voice-relay-eval] ${record.id}: ${record.status}${record.error ? ` (${record.error.message})` : ''} checks=${record.checks.length} tools=${record.toolCalls.length} ${record.durationMs}ms`);
    }
  } finally {
    clearInterval(keepAlive);
  }
  const summary = summarize(results);
  assertRunConclusive(summary, results);
  return { failed: isFailedVoiceRun({ summary }), fixturePath, schemaVersion: fixture.schemaVersion, runDate: runDate.toISOString(), summary, results };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_FIXTURE_PATH,
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
  summaryLine,
  isFailedVoiceRun,
  _internals: {
    PROMISE_RE, DEFAULT_TOOL_TEXT, LOOKUP_BUDGET_TEXT, EVAL_CALLER_TO, allowedToolsCheck, validCallNames,
    makeDbGuard, officeHoursFixture, pickToolResponse, inputMatches, MISMATCH_TEXT, runFixtureTool, applyToolSideEffects, validateToolInput, offeredRefs, applyGates, applyResumeFixture, injectInterrupt, driveTurns, selectScenarios, assertRunConclusive,
    renderTranscript, evaluateChecks, runCheck, CHECK_RUNNERS, lintScenario, scenarioStatus, qualityScore, summarize,
  },
};
