'use strict';

/**
 * Controlled-model harness for the Intelligence Bar ten-workflow baseline (PR 1).
 *
 * Real bearer auth + the real /api/admin/intelligence-bar router + real tools and
 * domain executors against an isolated PostgreSQL. ONLY the model adapter is
 * scripted (the same mock the platform suites use) and outbound providers are
 * the stubs the test file installs. A scripted model measures the EXECUTION
 * layer: given the tool calls a correct model would make, do target resolution,
 * proposal, confirmation, domain rules, receipts and recovery behave as the
 * workflow contract says? It says nothing about language understanding.
 *
 * Every case verifies with its own database queries, independent of the tool
 * result, and records failures as { point, code, detail } instead of throwing,
 * so one case reports every divergence it finds.
 */

const crypto = require('crypto');

// Where in the request path a divergence was observed.
const POINTS = Object.freeze([
  'target_resolution', // the wrong record, or no record, was selected
  'proposal',          // the card / preview / clarification stage
  'confirm',           // the confirm step or its guards
  'domain_rule',       // a domain operation accepted or refused against the rule
  'receipt',           // the durable receipt or its status
  'read_back',         // the independent database read disagrees
  'recovery',          // lost response, double submit, resume
  'side_effect',       // an unintended send or mutation
  'tool_result',       // a read returned facts that disagree with the seeded rows
  'capability',        // the tool path the workflow needs does not exist on this branch
  'contract',          // the scripted call and the manifest's call disagree: the case data is wrong, not the product
  'harness',           // the harness itself could not drive the case
]);

// A capability gap that changes what a tool requires, by gap key then tool: the inputs it no longer needs. A reschedule
// notice is rendered by the server from the move, so send_sms carries no freeform message.

const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
const answer = (text) => ({ content: [{ type: 'text', text }], usage: {} });

function parseContent(content) {
  if (typeof content !== 'string') return content;
  try { return JSON.parse(content); } catch { return content; }
}

// Tool results the model just received, matched to the calls that produced them.
function lastToolResults(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !Array.isArray(last.content)) return [];
  const calls = new Map();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) if (block.type === 'tool_use') calls.set(block.id, block);
    }
  }
  return last.content.filter((block) => block.type === 'tool_result').map((block) => {
    const call = calls.get(block.tool_use_id) || {};
    return { id: block.tool_use_id, name: call.name, input: call.input, raw: block.content, result: parseContent(block.content) };
  });
}

class CaseContext {
  constructor(harness, spec) {
    this.h = harness;
    this.spec = spec;
    this.failures = [];
    this.timings = { first_tool_result_ms: null, verified_completion_ms: null };
    this.startedAt = nowMs();
    this.mutatingStrength = false; // true once a write tool path was actually exercised
    this.notes = [];
    this.probe = false;
    this.cast = null;   // set by the runner: the case's seeded rows, which resolve manifest fixture keys
    this.issued = [];   // every tool call the scripted model made, in order, without discovery
    this.contract = null;
    this.confirms = []; // every card the case confirmed through the route
    this.sendBaseline = null; // outbound/email row counts at the first turn (see ib-workflow-state)
    this.rowBaseline = null;  // every seeded row, table by table, at the first turn: the runner's "unchanged" guard compares with it
    this.refusalAsserted = false; // set by expectRefusal / expectNoAttempt; the runner requires it of a negative case
  }

  /** Seed rows exist and nothing has been asked yet: remember what "unchanged" and "nothing sent" are measured against. */
  async takeBaselines() {
    const state = require('./ib-workflow-state');
    this.sendBaseline = await state.sendState(this.h, this.cast);
    this.rowBaseline = await state.rowTables(this.h, this.cast);
  }

  /**
   * A scripted fixture event (a text that arrives, a measurement that is edited, another booking taking a slot) is not a write by
   * the tool under test: call this right after it so the runner's guards measure from the new state.
   */
  async fixtureChanged() {
    if (this.cast && this.rowBaseline) {
      const state = require('./ib-workflow-state');
      this.rowBaseline = await state.rowTables(this.h, this.cast, { notifications: !!this.rowBaseline.notifications });
    }
  }

  /**
   * A negative case (blocked_by_rule, unsupported, or a clarification with no card) must name HOW the bar refused: the tool's own
   * answer, by code and/or message, from a call the script actually issued. A turn with no card and no row change is not evidence of
   * the rule (an unavailable tool, an unrelated error and the real refusal all look the same). `code` is compared exactly, `error` is
   * a RegExp on the tool's error or message text; at least one is required. Records `failCode` (point tool_result) otherwise.
   */
  expectRefusal(turn, tool, { code, error } = {}, failCode = 'refusal_not_specific') {
    this.refusalAsserted = true;
    if (!code && !error) throw new Error('expectRefusal needs a code or an error pattern');
    const call = turn.toolCalls.filter((t) => t.name === tool).pop();
    const result = call && call.result;
    const text = result && typeof result === 'object' ? String(result.error || result.message || '') : '';
    const ok = !!result && typeof result === 'object' && !result.executed && !result.proposal && (!code || result.code === code) && (!error || error.test(text));
    return this.check(ok, 'tool_result', failCode, () => `${tool} ${call ? `answered ${JSON.stringify(result).slice(0, 220)}` : 'was never called, so no refusal was observed'}; expected ${code ? `code ${code}` : ''}${code && error ? ' and ' : ''}${error ? `message ${error}` : ''}`);
  }

  /**
   * The refusal here is the model's, not a tool's: the correct model asks or declines and issues no write, so the scripted case
   * never attempts one. Declares that, with the reason, and asserts none of `tools` was issued. A case that can drive the
   * layer with the naive call should use expectRefusal instead.
   */
  expectNoAttempt(reason, { tools = null } = {}) {
    this.refusalAsserted = true;
    const registry = require('../../services/intelligence-bar/action-registry');
    // No tools named: any issued tool the registry does not classify as a read counts as an attempt.
    const isWrite = (name) => (tools ? tools.includes(name) : !!registry.actions.get(name) && registry.actions.get(name).kind !== 'read');
    const attempted = this.issued.filter((c) => isWrite(c.name)).map((c) => c.name);
    this.note(`no attempt by design: ${reason}`);
    return this.check(attempted.length === 0, 'side_effect', 'write_attempted_for_an_unsupported_request', `the script issued ${attempted.join(', ')} for a request the contract refuses (${reason})`);
  }

  /**
   * The refusal comes after the operator confirms (a send to a STOP number is blocked at the send, not at the card): the confirm
   * answer must say it was blocked and must not report success. `failCode` names the failure.
   */
  expectConfirmRefusal(confirmed, failCode = 'blocked_reason_not_reported') {
    this.refusalAsserted = true;
    const body = confirmed && confirmed.body;
    const blocked = !!body && body.success !== true && !!(body.blocked || (body.result && body.result.blocked) || body.outcome === 'blocked');
    return this.check(blocked, 'receipt', failCode, () => `confirm ${confirmed ? `${confirmed.status} ${JSON.stringify(body).slice(0, 220)}` : 'was never made'}`);
  }

  /** Record a divergence. `code` is stable and machine-comparable; `detail` is human evidence. */
  fail(point, code, detail) {
    if (!POINTS.includes(point)) throw new Error(`unknown failure point ${point}`);
    this.failures.push({ point, code, detail: String(detail || '').slice(0, 600) });
  }

  /** Assert-like: records a failure instead of throwing. Returns ok. */
  check(ok, point, code, detail) {
    if (!ok) this.fail(point, code, typeof detail === 'function' ? detail() : detail);
    return !!ok;
  }

  /** A check that only applies when the case is scored (not a probe of an owner-direct path). */
  checkScored(ok, point, code, detail) {
    if (this.probe) return true;
    return this.check(ok, point, code, detail);
  }

  note(text) { this.notes.push(String(text).slice(0, 300)); }

  markCompleted() {
    if (this.timings.verified_completion_ms === null) this.timings.verified_completion_ms = nowMs() - this.startedAt;
  }

  /**
   * Does the operator's own wording establish the customer as the task target (the
   * route's TaskContext, the same function /query calls)? When it does not, the case
   * records a target_resolution failure and continues with a CONTROL wording that
   * names the customer in full, so every later stage of the path is still measured.
   * Returns the prompt to run.
   */
  async establish({ prompt, page = {}, customer, lead }) {
    // Owner-direct (#5563, merged): for the owner login the record the bar picks IS the target and no request wording is
    // refused for lacking one. The case then measures what the route does with the operator's own words.
    if (this.spec.actor === 'owner' && this.spec.mode === 'owner_direct_on') return { prompt, page, established: true };
    const TaskContext = require('../../services/intelligence-bar/task-context');
    const pageData = { route: page.route || '/admin/customers', ...(page.customerId ? { customerId: page.customerId } : {}), ...(page.leadId ? { leadId: page.leadId } : {}), ...(page.appointmentId ? { appointmentId: page.appointmentId } : {}) };
    const resolved = await TaskContext.resolve({ prompt, pageData });
    if (lead) {
      if (resolved && resolved.requestedRecords && resolved.requestedRecords.lead_id === lead.id) return { prompt, page, established: true };
      this.fail('target_resolution', 'lead_target_not_established', `"${prompt}" with ${page.leadId ? 'the lead page open' : 'no page'}: no lead target${resolved && resolved.error ? ` (${resolved.code})` : ''}`);
      // CONTROL wording: "this lead" with that lead open, so the later stages are still measured.
      return { prompt: `This lead: ${prompt}`, page: { ...page, leadId: lead.id, route: '/admin/pipeline' }, established: false };
    }
    if (resolved && resolved.target && resolved.target.customer_id === customer.id) return { prompt, page, established: true };
    const why = resolved && resolved.error ? `${resolved.code || 'error'}` : (resolved && resolved.target ? `resolved a different record (${resolved.target.provenance || 'target'})` : 'no target');
    this.fail('target_resolution', 'customer_target_not_established', `"${prompt}" with ${page.customerId ? 'the customer page open' : 'no page'}: ${why}`);
    // CONTROL wording: the explicit "for <full name>:" selector the route does recognise, followed by the
    // operator's own request, so the later stages (reads, proposals, confirms, receipts) are still measured.
    const full = `${customer.first_name} ${customer.last_name}`;
    return { prompt: `For ${full}: ${prompt}`, page, established: false };
  }

  /**
   * The harness is the judge of the manifest's calls. Every call a step declares must have been issued by the case
   * script: same tool, and every input key the manifest names present with the same value once fixture keys are
   * replaced by the seeded ids and dates are moved onto the test clock (the script may pass more keys). A manifest
   * call that omits an input the tool requires is a manifest defect too. Gap-added tools, keys and relaxed
   * requirements (CAPABILITY_GAPS) are exempt: they are what the gap would build. Failures are 'contract'.
   */
  verifyContract() {
    const { CAPABILITY_GAPS, asList } = require('../fixtures/ib-workflows/execution-matrix');
    const registry = require('../../services/intelligence-bar/action-registry');
    const spec = this.spec;
    const gaps = asList(spec.requires).map((k) => CAPABILITY_GAPS[k]).filter(Boolean);
    const addsTool = (tool) => gaps.some((g) => g.adds && g.adds.tools && g.adds.tools[tool]);
    const addedProps = (tool) => new Set(gaps.flatMap((g) => Object.keys((g.adds && g.adds.properties && g.adds.properties[tool]) || {})));
    const relaxed = (tool) => new Set(gaps.flatMap((g) => (g.relaxes_required && g.relaxes_required[tool]) || []));
    const subset = (actual, want) => {
      if (want && typeof want === 'object' && !Array.isArray(want)) return actual && typeof actual === 'object' && Object.entries(want).every(([k, v]) => subset(actual[k], v));
      return JSON.stringify(actual) === JSON.stringify(want);
    };
    const pool = this.issued.map((c) => ({ ...c, used: false }));
    let compared = 0;
    let spentConfirms = 0;
    const seen = [];
    [spec, ...spec.corrections].forEach((step, index) => {
      for (const call of asList(step.call)) {
        const label = index === 0 ? 'the case' : `correction ${index}`;
        if (addsTool(call.tool)) continue;
        compared += 1;
        const action = registry.actions.get(call.tool);
        const omitted = ((action && action.schema.required) || []).filter((k) => !(k in (call.input || {})) && !addedProps(call.tool).has(k) && !relaxed(call.tool).has(k));
        if (omitted.length) this.fail('contract', 'manifest_call_missing_required_input', `${label}: ${call.tool} omits required ${omitted.join(', ')}`);
        const strip = addedProps(call.tool);
        const want = this.cast.resolve(Object.fromEntries(Object.entries(call.input || {}).filter(([k]) => !strip.has(k))));
        const hit = pool.find((c) => !c.used && c.name === call.tool && subset(c.input, want));
        if (hit) { hit.used = true; seen.push(JSON.stringify([call.tool, want])); continue; }
        // The same call named again by a later step is the operator confirming the card the earlier step proposed: a click, not
        // another model call. It counts when the case confirmed a card it has not already spent on such a step.
        if (seen.includes(JSON.stringify([call.tool, want])) && spentConfirms < this.confirms.length) { spentConfirms += 1; continue; }
        const near = pool.filter((c) => c.name === call.tool).map((c) => JSON.stringify(c.input)).join(' | ');
        this.fail('contract', 'manifest_call_not_issued', `${label}: ${call.tool} ${JSON.stringify(want)}; the script issued ${near || `no ${call.tool} call`}`);
      }
    });
    this.contract = { compared };
    return compared;
  }

  /**
   * Take a write step to its commit the way the contract says. `card: true` means a card must be shown (and nothing written
   * yet) and is then confirmed; `card: false` means the write executed in the turn itself (owner-direct) with no card. Either
   * way the commit's receipt is read back. `tool` names the write the turn made; `label` names it in the failure codes.
   * Returns { direct, confirmed, result } where result is the write tool's own result.
   */
  async commit(turn, { card, tool, label, actor, partial = false }) {
    const h = this.h;
    const who = actor || h.actors.owner;
    if (card) {
      this.check(turn.cards.length === 1, 'proposal', `no_card_for_${label}`, () => `cards ${turn.cards.length}; ${JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 240)}`);
      if (!turn.card) return { direct: false, confirmed: null, result: null };
      const confirmed = await h.confirm(who, turn.card);
      this.check(confirmed.status === 200 && confirmed.body && confirmed.body.success === true && confirmed.body.outcome === 'completed', 'confirm', 'confirm_not_completed', `confirm ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 240)}`);
      const receipt = await h.receipt(who, turn.card);
      this.check(receipt.status === 200 && receipt.body && receipt.body.success === true, 'receipt', 'receipt_missing', `receipt status ${receipt.status}`);
      return { direct: false, confirmed, result: confirmed.body && confirmed.body.result };
    }
    this.check(turn.cards.length === 0, 'proposal', 'carded_where_contract_expects_direct', `${turn.cards.length} card(s) for a write the contract commits without one`);
    const call = turn.toolCalls.filter((t) => t.name === tool).pop();
    const result = call && call.result;
    const executed = !!result && result.executed === true && (!result.outcome || result.outcome === 'completed' || (partial && result.outcome === 'partially_completed'));
    this.check(executed, 'domain_rule', 'direct_commit_not_executed', () => `${tool} ${call ? `${result.outcome || ''} ${(result.result && (result.result.warning || result.result.error)) || result.error || ''} ${JSON.stringify(result).slice(0, 200)}` : 'was not called'}`);
    if (executed && turn.body && turn.body.taskId) {
      const task = await h.task(who, turn.body.taskId, turn.sessionId);
      this.check(task.status === 200 && Array.isArray(task.body && task.body.receipts) && task.body.receipts.length >= 1, 'receipt', 'direct_commit_without_receipt', `task ${task.status}; receipts ${(task.body && task.body.receipts || []).length}`);
    }
    return { direct: true, confirmed: null, result: result && result.result };
  }

  /** One scripted conversation turn through the real /query route. */
  turn(actor, options) { return this.h.turn(actor, options, this); }
}

async function bootHarness({ databaseUrl, mockModel, providers = {} }) {
  const originalEnv = { ...process.env };
  const STRIPE_STUB_BASE = 'https://stripe-stub.example.invalid';
  const ownerEmail = `owner.${crypto.randomBytes(4).toString('hex')}@example.invalid`;
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    ANTHROPIC_API_KEY: 'scripted-model-only',
    GATE_IB_PLATFORM: 'true',
    GATE_IB_THREADS: 'false',
    GATE_IB_TOOL_ACTIVITY: 'true',
    GATE_IB_WRITES_DISABLED: 'false',
    GATE_EDIT_APPT_ADDRESS: 'true',
    IB_FULL_ACCESS_EMAILS: ownerEmail,
    STRIPE_API_BASE: STRIPE_STUB_BASE,
    STRIPE_SECRET_KEY: 'sk_test_scripted_only',
  });
  // No real network: any outbound HTTP(S) request other than the loopback route under test fails at once and is
  // recorded, so a provider that is not explicitly stubbed can never be reached (and a missing stub is visible).
  const blockedNetwork = [];
  const realFetch = global.fetch;
  // The one outbound host a case may answer: Stripe's read API, pointed at a name that can never resolve. A case installs
  // harness.setStripe((url) => json); without a handler the request is blocked and recorded like any other.
  let stripeHandler = null;
  global.fetch = async (input, init) => {
    const target = String(input && input.url ? input.url : input);
    if (target.startsWith(STRIPE_STUB_BASE) && stripeHandler) {
      return new Response(JSON.stringify(stripeHandler(new URL(target))), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(target)) return realFetch(input, init);
    blockedNetwork.push(`fetch ${target.split('?')[0]}`);
    throw new Error('network disabled in the controlled baseline');
  };
  const netGuards = ['http', 'https'].map((mod) => {
    const lib = require(mod);
    const original = lib.request;
    lib.request = function guarded(...args) {
      const first = args[0];
      const host = typeof first === 'string' ? first : (first && (first.hostname || first.host || first.href)) || '';
      if (/^(https?:\/\/)?(127\.0\.0\.1|localhost)/.test(String(host))) return original.apply(this, args);
      blockedNetwork.push(`${mod} ${String(host)}`);
      throw new Error('network disabled in the controlled baseline');
    };
    return { lib, original };
  });
  const db = require('../../models/db');
  if (!(await db.schema.hasTable('ib_tasks'))) throw new Error('Apply the migrations to the isolated database first');
  const jwt = require('jsonwebtoken');

  async function makeActor(kind) {
    const id = crypto.randomUUID();
    const row = { id, name: `Synthetic ${kind} ${id.slice(0, 4)}`, role: kind === 'tech' ? 'technician' : 'admin', active: true, auth_token_version: 1 };
    if (kind === 'owner') row.email = ownerEmail;
    if (kind === 'admin') row.email = `admin.${id.slice(0, 6)}@example.invalid`;
    if (kind === 'tech') row.email = `tech.${id.slice(0, 6)}@example.invalid`;
    await db('technicians').insert(row);
    const token = jwt.sign({ type: 'access', tokenVersion: 1, technicianId: id }, process.env.JWT_SECRET, { expiresIn: '2h' });
    return { kind, id, token };
  }
  const actors = { owner: await makeActor('owner'), admin: await makeActor('admin'), tech: await makeActor('tech') };

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/intelligence-bar', require('../../routes/admin-intelligence-bar'));
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }));  
  const server = await new Promise((resolve) => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const harness = {
    db, actors, origin, ownerEmail, providers,
    sessions: new Map(),

    async api(actor, method, path, body) {
      const response = await fetch(`${origin}/api/admin/intelligence-bar${path}`, {
        method,
        headers: { Authorization: `Bearer ${actor.token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let parsed = null;
      try { parsed = await response.json(); } catch { parsed = null; }
      return { status: response.status, body: parsed };
    },

    /**
     * Drive one /query turn with a scripted model.
     *   rounds: array; each item is { tools: [[name, input], ...] } | { text } |
     *           (previousToolResults, state) => one of those. A final text round is
     *           appended when the script does not end with one.
     *   discover: when true (default) a discover_capabilities round precedes the
     *           first tool round, as a real model loading a deferred tool does.
     */
    async turn(actor, options, ctx) {
      const { prompt, rounds = [], page = {}, sessionKey = 'default', requestKey, context = 'estimates', discover = true, conversationHistory } = options;
      // The row baseline noSends compares against: taken at the case's first turn, after its seed rows exist.
      if (ctx && ctx.cast && !ctx.sendBaseline) await ctx.takeBaselines();
      const key = `${actor.id}:${sessionKey}`;
      if (!harness.sessions.has(key)) harness.sessions.set(key, crypto.randomUUID());
      const sessionId = options.sessionId || harness.sessions.get(key);
      const script = rounds.slice();
      const state = { index: 0, calls: [], modelCalls: 0, firstToolAt: null, toolRoundSeen: false, discovered: new Set(), pending: null };
      const started = nowMs();
      mockModel.mockReset();
      mockModel.mockImplementation(async (params) => {
        state.modelCalls += 1;
        const previous = lastToolResults(params.messages);
        state.calls.push(...previous);
        if (state.toolRoundSeen && state.firstToolAt === null && previous.some((p) => p.name && p.name !== 'discover_capabilities')) state.firstToolAt = nowMs();
        let round = state.pending;
        state.pending = null;
        if (!round) {
          round = script[state.index];
          state.index += 1;
          if (typeof round === 'function') round = round(previous, state);
        }
        if (!round) return answer('Done.');
        if (round.text !== undefined) return answer(round.text);
        // A model loads a deferred capability by discovering it first; do that once per tool.
        const missing = discover ? round.tools.map(([name]) => name).filter((name) => name !== 'discover_capabilities' && !state.discovered.has(name)) : [];
        if (missing.length) {
          missing.forEach((name) => state.discovered.add(name));
          state.pending = round;
          return { content: [{ type: 'tool_use', name: 'discover_capabilities', input: { query: missing.map((name) => name.replaceAll('_', ' ')).join(' ') }, id: `discover-${state.modelCalls}` }], usage: {} };
        }
        if (round.tools.some(([name]) => name !== 'discover_capabilities')) state.toolRoundSeen = true;
        if (ctx) for (const [name, input] of round.tools) if (name !== 'discover_capabilities') ctx.issued.push({ name, input });
        return { content: round.tools.map(([name, input], i) => ({ type: 'tool_use', name, input, id: `${name}-${state.modelCalls}-${i}` })), usage: {} };
      });
      const body = {
        prompt, context, session_id: sessionId, request_key: requestKey || crypto.randomUUID(),
        ...(Array.isArray(conversationHistory) ? { conversationHistory } : {}),
        pageData: { route: page.route || '/admin/customers', ...(page.customerId ? { customerId: page.customerId } : {}), ...(page.leadId ? { leadId: page.leadId } : {}), ...(page.appointmentId ? { appointmentId: page.appointmentId } : {}) },
      };
      const response = options.resumeTaskId
        ? await harness.api(actor, 'POST', `/tasks/${options.resumeTaskId}/resume`, { session_id: sessionId })
        : await harness.api(actor, 'POST', '/query', body);
      // The last model call's tool results are only seen on the call after them; the final
      // call already returned text, so collect results from the last request too.
      const lastRequest = mockModel.mock.calls.length ? mockModel.mock.calls[mockModel.mock.calls.length - 1][0] : null;
      const trailing = lastRequest ? lastToolResults(lastRequest.messages) : [];
      for (const t of trailing) if (!state.calls.some((c) => c.id === t.id)) state.calls.push(t);
      const total = nowMs() - started;
      const toolCalls = state.calls.filter((c) => c.name && c.name !== 'discover_capabilities');
      if (ctx && ctx.timings.first_tool_result_ms === null && toolCalls.length) {
        ctx.timings.first_tool_result_ms = (state.firstToolAt || nowMs()) - started + (ctx.startedAt ? 0 : 0);
      }
      if (ctx) for (const t of toolCalls) if (t.result && typeof t.result === 'object' && t.result.error) ctx.note(`${t.name}: ${t.result.code || 'error'}: ${String(t.result.error).slice(0, 140)}`);
      if (ctx && (response.status !== 200 || !toolCalls.length)) ctx.note(`turn status ${response.status}${response.body && (response.body.error || response.body.code) ? ` ${response.body.code || ''} ${String(response.body.error || '').slice(0, 120)}` : ''}${toolCalls.length ? '' : `; no tool call reached; answer: ${String((response.body && (response.body.response || response.body.answer || response.body.message || response.body.text)) || '').slice(0, 160)}`}`);
      const cards = (response.body && response.body.pendingActions) || [];
      return { ...response, sessionId, requestBody: body, toolCalls, cards, card: cards[0] || null, modelCalls: state.modelCalls, ms: total, prompt, requests: mockModel.mock.calls.map((c) => c[0]) };
    },

    confirm(actor, card) {
      if (harness.current) harness.current.confirms.push(card.id);
      return harness.api(actor, 'POST', '/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
    },
    cancel(actor, card) { return harness.api(actor, 'POST', '/cancel-action', { pending_action_id: card.id }); },
    receipt(actor, card) { return harness.api(actor, 'GET', `/actions/${card.id}`); },
    task(actor, taskId, sessionId) { return harness.api(actor, 'GET', `/tasks/${taskId}?session_id=${sessionId}`); },

    blockedNetwork,
    setStripe(handler) { stripeHandler = handler; },

    /**
     * Deferred work (the booking confirmation text runs on setImmediate after the result, behind a slow
     * landline lookup): wait until the provider stub has seen `expect` submissions and then stays quiet, or
     * (when none is expected) for a short fixed quiet period.
     */
    async settle({ expect = 0, quietMs = 800, maxMs = 12000 } = {}) {
      const count = () => (providers.sms ? providers.sms.mock.calls.length : 0);
      const started = nowMs();
      let since = nowMs();
      let last = count();
      while (nowMs() - started < maxMs) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const now = count();
        if (now !== last) { last = now; since = nowMs(); }
        if (now >= expect && nowMs() - since >= (expect ? quietMs : 1500)) break;
      }
      return last;
    },

    async close() {
      global.fetch = realFetch;
      for (const g of netGuards) g.lib.request = g.original;
      if (server) await new Promise((resolve) => server.close(resolve));
      await db.destroy();
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    },

    // The case's own mode decides the owner-direct gate; the route reads it at call time on every request.
    newContext(spec, cast) {
      process.env.GATE_IB_OWNER_DIRECT = spec.mode === 'owner_direct_on' ? 'true' : 'false';
      const ctx = new CaseContext(harness, spec);
      ctx.cast = cast || null;
      harness.current = ctx;
      return ctx;
    },
  };
  return harness;
}

module.exports = { bootHarness, POINTS, answer, lastToolResults };
