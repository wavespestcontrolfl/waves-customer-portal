'use strict';

/**
 * Pure helpers for the Intelligence Bar replay test: ib-replay-export.js
 * turns saved bar requests into cases, ib-replay.js replays them. No
 * database, no network, no server modules (server/tests/ib-replay-lib.test.js).
 */

const fs = require('fs');
const path = require('path');

// USD per million tokens. A cache write costs 1.25x input (5 minutes) or 2x
// input (1 hour). A model missing here prices as null: the run reports tokens.
const PRICES = Object.freeze({
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
});

function costUsd(model, usage = {}) {
  const price = PRICES[model];
  if (!price) return null;
  const split = usage.cache_creation || {};
  const write5m = split.ephemeral_5m_input_tokens || 0;
  // A write count without the 5 min / 1 h split is priced as the dearer 1 h write.
  const write1h = split.ephemeral_1h_input_tokens ?? Math.max(0, (usage.cache_creation_input_tokens || 0) - write5m);
  return ((usage.input_tokens || 0) * price.input
    + (usage.output_tokens || 0) * price.output
    + (usage.cache_read_input_tokens || 0) * price.cacheRead
    + write5m * price.input * 1.25
    + write1h * price.input * 2) / 1e6;
}

// The recorded tool calls of one saved request, in order: each tool_use the
// model made, with the tool_result the bar answered it with.
function buildTape(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const blocks = (role, type) => list
    .filter((m) => m && m.role === role && Array.isArray(m.content))
    .flatMap((m) => m.content.filter((b) => b && b.type === type));
  const results = new Map(blocks('user', 'tool_result').map((b) => [b.tool_use_id, b]));
  return blocks('assistant', 'tool_use').map((call) => {
    const result = results.get(call.id);
    return { name: call.name, input: call.input || {}, result: result ? result.content : null, isError: result ? result.is_error === true : null };
  });
}

// Server-only card fields start with "_" (private evidence, pins).
const publicParams = (params) => Object.fromEntries(Object.entries(params || {}).filter(([key]) => !key.startsWith('_')));

// One saved request (an ib_tasks row with its cards) as a replay case, or
// null. A request that ran no tool has no first tool to compare. kind 'card':
// the operator confirmed a card it made. kind 'read': it made no card. A
// request whose cards were all cancelled or expired is left out, because its
// right outcome is unknown.
function caseFromTask(row) {
  const tape = buildTape(row.checkpoint);
  if (!tape.length) return null;
  const cards = Array.isArray(row.cards) ? row.cards : [];
  const confirmed = cards.filter((card) => card.status === 'confirmed');
  if (cards.length && !confirmed.length) return null;
  const request = row.request || {};
  return {
    id: row.id,
    createdAt: row.created_at,
    kind: confirmed.length ? 'card' : 'read',
    context: request.context || null,
    prompt: request.prompt,
    pageData: request.pageData || row.page_context || {},
    conversationHistory: Array.isArray(request.conversationHistory) ? request.conversationHistory : [],
    selectedTarget: request.selectedTarget || null,
    // The bar's rules change for dictated money amounts and pasted text.
    dictationUsed: request.dictation_used === true,
    pastedText: request.pasted_text === true,
    target: row.target || null,
    firstTool: { name: tape[0].name, input: tape[0].input },
    tape,
    cards: confirmed.map((card) => ({ tool: card.tool_name, params: publicParams(card.params) })),
    answer: row.response?.response ?? null,
  };
}

// Newest first (the caller's order), half card cases and half read cases;
// when one kind runs short the other fills its places.
function pickCases(cases, limit) {
  const cards = cases.filter((c) => c.kind === 'card');
  const reads = cases.filter((c) => c.kind === 'read');
  const takeCards = Math.min(cards.length, Math.max(Math.ceil(limit / 2), limit - reads.length));
  return [...cards.slice(0, takeCards), ...reads.slice(0, limit - takeCards)];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// pass: the replay's first tool call names the recorded first tool.
// sameInput: it also sent the same arguments (key order ignored).
function scoreFirstTool(expected, actual) {
  if (!actual) return { verdict: 'no_tool', sameInput: false };
  const pass = Boolean(expected) && actual.name === expected.name;
  return { verdict: pass ? 'pass' : 'fail', sameInput: pass && stableJson(actual.input) === stableJson(expected.input) };
}

// The variables a replay keeps from the caller's environment. Everything else
// (provider keys, Railway settings, the production DATABASE_URL) is dropped
// before any server module loads, so replayed code cannot reach a real
// service. Profile keys bring the bar's gates and model settings.
// USER: the local Postgres login when the URL names none.
const KEEP_ENV = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TZ', 'LANG'];
const PROFILE_KEY_RE = /^(GATE_|MODEL_|INTELLIGENCE_BAR_|IB_)/;
const SECRET_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD/;
// Forced off whatever the profile says: owner-direct commits a write with no
// card; the OpenAI backup and the credit-key pool switch provider or key.
const FORCED_OFF = ['GATE_IB_OWNER_DIRECT', 'GATE_IB_OPENAI_BACKUP', 'GATE_AI_CREDIT_KEYS'];

// The gate profile to save with an export: the bar's settings, never a credential.
function profileFrom(env) {
  return Object.fromEntries(Object.entries(env)
    .filter(([key]) => PROFILE_KEY_RE.test(key) && !SECRET_KEY_RE.test(key))
    .sort(([a], [b]) => a.localeCompare(b)));
}

// The replay writes its own task, thread and ledger rows, so it runs only on
// a dedicated local database: localhost, named ib_replay*. A query string is
// refused outright: pg reads ?host= (and other settings) from it, over the host.
function localDatabaseUrl(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { parsed = null; }
  const name = parsed ? parsed.pathname.replace(/^\//, '') : '';
  if (!parsed || !['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.search
      || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !/^ib_replay[a-z0-9_]{0,54}$/.test(name)) {
    throw new Error('IB_REPLAY_DATABASE_URL must be postgresql://localhost/ib_replay* (lower-case letters, digits, _) with no query string');
  }
  return parsed.toString();
}

// The throwaway copy one run works on (CREATE DATABASE ... TEMPLATE), named
// from the validated template name, so it is a safe identifier. Never cut to
// fit: a cut name could equal the template, and the run drops its copy.
function scratchDatabaseName(template, pid, now) {
  const name = `${template}_run_${pid}_${now}`;
  if (name.length > 63) throw new Error(`the database name ${template} is too long for a run copy; use 30 characters or fewer`);
  return name;
}

function replayEnv(callerEnv, profile, { databaseUrl, apiKey = null }) {
  const env = {};
  for (const key of KEEP_ENV) if (callerEnv[key] !== undefined) env[key] = callerEnv[key];
  for (const [key, value] of Object.entries(profileFrom(profile || {}))) env[key] = String(value);
  for (const key of FORCED_OFF) env[key] = 'false';
  return {
    ...env,
    NODE_ENV: 'development',
    // server/config/load-env.js: never refill a dropped variable from the checkout's .env.
    WAVES_LOCAL_DEV: '1',
    JWT_SECRET: 'ib-replay-local',
    DATABASE_URL: localDatabaseUrl(databaseUrl),
    // The bar refuses to start without a key; a dry run's key is never sent.
    ANTHROPIC_API_KEY: apiKey || 'ib-replay-dry-run',
  };
}

// The real location of a path that may not exist yet: its nearest existing
// ancestor with symlinks resolved, plus the parts still to be created.
function realLocation(abs) {
  let dir = abs;
  const rest = [];
  while (!fs.existsSync(dir)) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  return path.join(fs.realpathSync(dir), ...rest);
}

// The case file holds customer text, so case and result files live outside
// the checkout, also when a symlinked folder points back into it.
function assertOutsideRepo(file, repoRoot) {
  const abs = path.resolve(String(file || ''));
  const real = file ? realLocation(abs) : '';
  const root = fs.realpathSync(path.resolve(repoRoot));
  if (!file || real === root || real.startsWith(root + path.sep)) {
    throw new Error(`${file || '(no path)'}: case and result files must be outside the checkout`);
  }
  return abs;
}

// Owner-only (0600) even over an existing file: a new file is created
// exclusively with that mode, then renamed over the target.
function writePrivateFile(file, text) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

// Two runs of the same cases side by side, and the cases whose verdict changed.
function compareRuns(before, after) {
  const afterById = new Map(after.results.map((r) => [r.id, r]));
  const rows = before.results.filter((r) => afterById.has(r.id))
    .map((r) => ({ id: r.id, kind: r.kind, expected: r.expected, before: r.verdict, after: afterById.get(r.id).verdict, afterTool: afterById.get(r.id).actual }));
  const passes = (key) => rows.filter((r) => r[key] === 'pass').length;
  return { rows, changed: rows.filter((r) => r.before !== r.after), passBefore: passes('before'), passAfter: passes('after') };
}

module.exports = {
  PRICES, costUsd, buildTape, caseFromTask, pickCases, scoreFirstTool, stableJson,
  profileFrom, localDatabaseUrl, scratchDatabaseName, replayEnv, assertOutsideRepo, writePrivateFile, compareRuns, FORCED_OFF,
};
