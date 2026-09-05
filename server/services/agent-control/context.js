/**
 * Agent-control context — the ambient "which lane / run / step is this?"
 * carrier for every LLM call, tool call and ledger row.
 *
 * Why AsyncLocalStorage (same idiom as scheduled-cron's tickContext,
 * cron-lock's lockSlotContext and the dispatch-metrics replay lane it
 * replaces): the recorders sit many layers below the code that knows the
 * lane — a replay harness wraps a whole run, a cron tick wraps a sweep, a
 * route wraps one request — and threading ids through every shared entry
 * point would touch every call site. A module-level variable would leak
 * between concurrent requests; ALS is scoped to the async tree.
 *
 * Scoping rules:
 *   - every withX(fn) returns fn()'s value unchanged (promise-transparent)
 *     and runs it in a CLONE of the parent store — a nested scope never
 *     mutates its parent, and the parent is intact when fn returns;
 *   - innermost wins for laneId / runId / workload; withChain keeps the
 *     OUTER chain (every leg of a fallback or fan-out shares one chainId);
 *   - withPromptVersion is a scope like the others (a clone), never a
 *     mutation: sibling calls fanned out under one run share the parent's
 *     store object, so a setter would let call B's version overwrite call
 *     A's before A recorded its ledger row.
 *
 * Precedence with explicit arguments: an id a caller passes as a function
 * argument BEATS the ambient scope. That is the CALLER's job — this module
 * only answers current(); a recorder that accepts an explicit laneId should
 * prefer it and fall back to current().laneId.
 *
 * current() never throws and is all-null outside any scope.
 */

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const logger = require('../logger');
const { WORKLOAD } = require('./taxonomy');

const store = new AsyncLocalStorage();

const EMPTY = Object.freeze({
  laneId: null,
  runId: null,
  workItemId: null,
  attemptId: null,
  stepId: null,
  chainId: null,
  traceId: null,
  spanId: null,
  parentSpanId: null,
  workload: null,
  promptVersion: null,
  agentVersionId: null,
  workflowId: null,
});

// Lazily required so this module stays loadable from anything the
// switchboard itself imports (config/models is a plain-const module, but the
// dependency direction is context → switchboard, never the reverse).
let knownLaneIds = null;
function isKnownLane(laneId) {
  if (!knownLaneIds) {
    knownLaneIds = new Set(require('../model-switchboard').LANES.map((l) => l.id));
  }
  return knownLaneIds.has(laneId);
}
const warnedLanes = new Set();

function newTraceId() {
  return crypto.randomBytes(16).toString('hex');
}
function newSpanId() {
  return crypto.randomBytes(8).toString('hex');
}

function enter(patch, fn) {
  const parent = store.getStore() || EMPTY;
  return store.run({ ...parent, ...patch }, fn);
}

function runInLane(laneId, fn) {
  const id = laneId == null ? null : String(laneId);
  if (id && !isKnownLane(id) && !warnedLanes.has(id)) {
    warnedLanes.add(id);
    logger.warn(`[agent-control] runInLane: "${id}" is not a model-switchboard lane id`);
  }
  return enter({ laneId: id }, fn);
}

// A run whose trace differs from the ambient one — no traceId (fresh) or an
// explicit one that is not the parent's — drops the outer step / span / chain
// ids: they belong to another trace and must not become the first step's
// parent or the chain its calls attach to (withChain keeps any outer chain).
// Joining the ambient trace keeps them.
function runInRun({ runId = null, workItemId = null, attemptId = null, traceId = null, agentVersionId = null, workflowId = null } = {}, fn) {
  const parent = store.getStore() || EMPTY;
  const trace = traceId || newTraceId();
  return enter({
    runId,
    workItemId,
    attemptId,
    traceId: trace,
    ...(parent.traceId && trace === parent.traceId ? {} : { stepId: null, spanId: null, parentSpanId: null, chainId: null }),
    agentVersionId,
    workflowId,
  }, fn);
}

function withStep(stepId, fn) {
  const parent = store.getStore() || EMPTY;
  return enter({ stepId, parentSpanId: parent.spanId, spanId: newSpanId() }, fn);
}

function withChain(fn) {
  const parent = store.getStore() || EMPTY;
  return enter({ chainId: parent.chainId || crypto.randomUUID() }, fn);
}

function withWorkload(workload, fn) {
  if (!WORKLOAD.includes(workload)) throw new Error(`unknown workload: ${workload}`);
  return enter({ workload }, fn);
}

function current() {
  const s = store.getStore();
  return s ? { ...s } : { ...EMPTY };
}

function withPromptVersion(promptVersion, fn) {
  return enter({ promptVersion: promptVersion == null ? null : String(promptVersion) }, fn);
}

module.exports = {
  runInLane,
  runInRun,
  withStep,
  withChain,
  withWorkload,
  current,
  withPromptVersion,
  newTraceId,
  newSpanId,
  isKnownLane,
};
