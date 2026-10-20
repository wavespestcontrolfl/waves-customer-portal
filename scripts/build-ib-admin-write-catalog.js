#!/usr/bin/env node
/**
 * Builds server/services/intelligence-bar/admin-write-catalog.json: the
 * allow-list behind the Intelligence Bar's general admin edit tools
 * (`find_admin_edits`, `propose_admin_edit`; owner ruling 2026-10-12: a general
 * EDIT tool is allowed for a reviewed allow-list of small internal edits only,
 * owner login only, always a confirm card, its own gate).
 *
 * ADMISSION IS BY REVIEWED ROW ONLY, exactly like the read catalog
 * (scripts/build-ib-admin-read-catalog.js, whose handler-chain scan this file
 * reuses). A PUT or PATCH endpoint is in the catalog when
 * admin-write-reviewed.json holds a row for it that a person wrote after
 * reading the handler chain end to end, and that row still matches the code:
 * the same scan signals, the same unresolved callees, the same tables written,
 * and the same content hash of the handler and of every function the scan
 * followed. Any edit to that chain drops the endpoint until someone reviews it
 * again (the byte-for-byte catalog test fails in the PR that edits it).
 *
 * The scan is a second lock, and for a WRITE it is stricter than a person's
 * word on four counts (server/utils/admin-write-rules.js):
 *   - the path: no delete, bulk, send, money, settings, user or credential
 *     word, and the read catalog's own path rules;
 *   - the signals: an outside call, a messaging / payment / alerting module,
 *     a signed or customer-facing link, a file response, a delete, DDL, a raw
 *     SQL write or a bulk insert keeps the route out, with no waiver. A call
 *     whose name reaches a sender, a charge or a delete, and a credential
 *     field, stay out unless the row names it in `waive` with a reason;
 *   - the tables the chain writes (derived from the code and compared with the
 *     row): none may be a money, message or queue table;
 *   - the body: the row lists every field an edit may carry, with a type and a
 *     size; the tool refuses any other field.
 *
 * Run: `npm run ib:write-catalog`. `--fingerprint <METHOD> <endpoint>...`
 * prints the fingerprint for a new row; `--report` prints counts and every
 * candidate left out with the reason; `--check` fails when the file differs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const read = require('./build-ib-admin-read-catalog');
const readRules = require('../server/utils/admin-read-rules');
const writeRules = require('../server/utils/admin-write-rules');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'server/services/intelligence-bar/admin-write-catalog.json');
const REVIEWED_FILE = path.join(ROOT, 'server/services/intelligence-bar/admin-write-reviewed.json');
const CATALOG_VERSION = 1;
const SCOPES = ['broad', 'customer', 'visit'];
const TABLE_RE = /^[a-z][a-z0-9_]*$/;

// ── keys ─────────────────────────────────────────────────────────────────

const methodOf = row => String(row.method || '').toUpperCase();
const keyOf = (method, endpoint) => `${method} /${readRules.splitPath(endpoint).map(s => (readRules.isParam(s) ? ':param' : s)).join('/')}`;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha = value => crypto.createHash('sha256').update(stable(value)).digest('hex').slice(0, 32);

// ── reviewed rows ────────────────────────────────────────────────────────

// Each check returns a message, or null when the row is consistent.
function pathProblem(row) {
  if (!writeRules.EDIT_METHODS.includes(methodOf(row))) return 'method must be PUT or PATCH';
  const denied = writeRules.editDenyReason(methodOf(row), row.endpoint);
  return denied ? `path is not editable from the bar (${denied})` : null;
}

function scopeProblem(row) {
  if (!SCOPES.includes(row.scope)) return `scope must be one of ${SCOPES.join(', ')}`;
  const names = readRules.patternParams(row.endpoint);
  if (row.scope === 'broad') return row.scopeParam === undefined ? null : 'a broad row has no scopeParam';
  if (!names.includes(row.scopeParam)) return 'scopeParam must name a path parameter';
  return (row.params || {})[row.scopeParam] === 'uuid' ? null : 'the scope parameter must be declared "uuid"';
}

function paramKindProblem(row) {
  const names = readRules.patternParams(row.endpoint);
  const kinds = row.params || {};
  const bad = Object.entries(kinds).find(([name, kind]) => !['uuid', 'int', 'text'].includes(kind) || !names.includes(name));
  if (bad) return `params.${bad[0]} must be "uuid", "int" or "text" and name a parameter of the pattern`;
  const missing = names.find(name => !kinds[name]);
  return missing ? `params.${missing} is missing: declare every path parameter` : null;
}

function textProblem(row) {
  const long = (value, min) => typeof value !== 'string' || value.trim().length < min;
  if (long(row.reason, 40)) return 'reason must explain why this edit is safe (at least 40 characters)';
  if (long(row.reviewed, 40)) return 'reviewed must say what was read';
  return long(row.noSend, 20) ? 'noSend must say, in words, what the edit does NOT do (no message, no charge ...)' : null;
}

function writesProblem(row) {
  if (!Array.isArray(row.writes) || !row.writes.length || row.writes.some(t => !TABLE_RE.test(t))) return 'writes must list the tables the chain writes';
  return row.writes.some(t => writeRules.DENIED_TABLE_RE.test(t)) ? 'writes names a money, message or queue table' : null;
}

function waiveProblem(row) {
  const waive = row.waive;
  if (waive !== undefined && (typeof waive !== 'object' || Array.isArray(waive) || Object.values(waive).some(r => typeof r !== 'string' || r.trim().length < 20))) {
    return 'waive maps a signal to a reason of at least 20 characters';
  }
  return null;
}

function beforeReadProblem(row) {
  const b = row.beforeRead;
  if (b === undefined) return null;
  if (!b || typeof b.endpoint !== 'string' || !b.params || typeof b.params !== 'object') return 'beforeRead needs an endpoint and a params map (read param -> edit param)';
  return b.pick !== undefined && !/^[A-Za-z0-9_.]{1,80}$/.test(b.pick) ? 'beforeRead.pick must be a dotted path' : null;
}

function addressProblem(row) {
  const key = Object.keys(row.body || {}).find(writeRules.bodyKeyLooksLikeAddress);
  return key ? `body.${key} looks like address text: addresses are not on the batch 1 list` : null;
}

function validateReviewedRow(row) {
  const problem = pathProblem(row) || scopeProblem(row) || paramKindProblem(row) || writeRules.bodySpecProblem(row)
    || textProblem(row) || writesProblem(row) || waiveProblem(row) || beforeReadProblem(row) || addressProblem(row);
  if (problem) throw new Error(`admin-write-reviewed.json ${methodOf(row)} ${row.endpoint}: ${problem}`);
}

function loadReviewed() {
  const raw = JSON.parse(fs.readFileSync(REVIEWED_FILE, 'utf8'));
  (raw.reviewed || []).forEach(validateReviewedRow);
  const seen = new Set();
  for (const row of raw.reviewed || []) {
    const key = keyOf(methodOf(row), row.endpoint);
    if (seen.has(key)) throw new Error(`admin-write-reviewed.json lists ${key} twice`);
    seen.add(key);
  }
  return { reviewed: new Map((raw.reviewed || []).map(row => [keyOf(methodOf(row), row.endpoint), row])), rejected: raw.rejected || [] };
}

// ── the scan ─────────────────────────────────────────────────────────────

const WRITE_CALL_RE = /\.(update|insert|del|delete|increment|decrement|onConflict)\(/;
const TABLE_CALL_RE = /(?:\b(?:db|trx|tx|knex|dbc|dbh|conn|database)|\(\s*[A-Za-z_]+\s*\|\|\s*db\s*\))\(\s*['"`]([A-Za-z0-9_.]+)['"`]\s*\)/g;

// The tables a followed source writes: a `db('table')` root whose chain (the
// next 600 characters, up to the end of the statement) holds a write call.
// Heuristic, and one more lock: the row must state the same list.
function writtenTables(sources) {
  const tables = new Set();
  for (const entry of sources) {
    const text = entry.slice(entry.indexOf('\n') + 1);
    for (const match of text.matchAll(TABLE_CALL_RE)) {
      const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 600);
      const statement = tail.split(/;|\n\s*\n/)[0];
      if (WRITE_CALL_RE.test(statement)) tables.add(match[1].replace(/\s+as\s+\w+$/i, ''));
    }
  }
  return [...tables].sort();
}

// The route's scan with write signals allowed through. The read generator's
// judgeRoute stops at any write signal ("scan: write:update"); a route that
// stopped for any other reason (a path rule, a catch-all mount, a handler it
// could not find) is out for good. Every route in `entries` is judged.
function judgeEdit(entry, opaqueMounts) {
  const verdict = read.judgeRoute(entry, { exclude: new Map(), reviewed: new Map() }, opaqueMounts);
  if (verdict.safe) return { ...verdict, safe: false, kind: 'review', reason: 'no write found in the handler chain: not a column update the scan can see' };
  if (verdict.kind === 'review' && /^scan: /.test(verdict.reason || '') && Array.isArray(verdict.signals)) {
    return { ...verdict, safe: true, writes: writtenTables(read.followedSources) };
  }
  return verdict;
}

// Why a judged endpoint (all of its routes) cannot be admitted under this row.
function chainProblem(row, fingerprint, writes) {
  const waive = row.waive || {};
  // The hard signals first: they name the reason that can never be waived.
  const problems = fingerprint.signals.map(signal => writeRules.signalProblem(signal, waive)).filter(Boolean);
  if (problems.length) return problems.find(problem => problem.startsWith('hard signal')) || problems[0];
  const unused = Object.keys(waive).filter(signal => !fingerprint.signals.includes(signal));
  if (unused.length) return `waive names a signal the scan does not see: ${unused.join(', ')}`;
  const stated = [...(row.writes || [])].sort();
  if (stated.join(',') !== writes.join(',')) return `writes is stale: the code writes ${writes.join(', ') || 'no table'}, the row says ${stated.join(', ')}`;
  const deniedTable = writes.find(t => writeRules.DENIED_TABLE_RE.test(t));
  return deniedTable ? `writes a money, message or queue table (${deniedTable})` : null;
}

// ── census → catalog ─────────────────────────────────────────────────────

function censusEdits(census) {
  const groups = new Map();
  for (const action of census.actions) {
    const method = action.operation.method;
    if (!writeRules.EDIT_METHODS.includes(method)) continue;
    if (action.operation.resolution !== 'literal_or_template' || !action.operation.endpoint) continue;
    const endpoint = action.operation.endpoint;
    if (readRules.splitPath(endpoint).some(s => s.includes(':param') && s !== ':param')) continue;
    const key = keyOf(method, endpoint);
    if (!groups.has(key)) groups.set(key, { method, endpoint, screens: new Set(), handlers: new Set() });
    const group = groups.get(key);
    group.screens.add(String(action.module).replace(/\.[jt]sx?$/, ''));
    if (action.ui.handler && action.ui.handler !== 'inline action') group.handlers.add(action.ui.handler);
  }
  return groups;
}

function buildCatalog({ census, reviewed = loadReviewed(), routes } = {}) {
  const source = census || JSON.parse(fs.readFileSync(read.CENSUS_FILE, 'utf8'));
  const { table, opaqueMounts } = routes || read.routeTable(['put', 'patch', 'all']);
  const judged = new Map();
  const judgeOnce = (entry) => {
    if (!judged.has(entry)) judged.set(entry, judgeEdit(entry, opaqueMounts));
    return judged.get(entry);
  };
  const groups = censusEdits(source);
  const entries = [];
  const excluded = { rule: [], review: [] };
  const admittedRoutes = [];
  for (const [key, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { method, endpoint } = group;
    const label = `${method} ${endpoint}`;
    const ruled = writeRules.editDenyReason(method, endpoint);
    if (ruled) { excluded.rule.push({ endpoint: label, reason: ruled }); continue; }
    const row = reviewed.reviewed.get(key);
    // Judge only what a person has put a row on: the other edit endpoints are
    // counted, not scanned.
    if (!row) { excluded.review.push({ endpoint: label, reason: 'not reviewed' }); continue; }
    const segments = readRules.splitPath(endpoint);
    const candidates = table.filter(entry => entry.route.method === method.toLowerCase() || entry.route.all);
    const matches = read.matchRoutes(segments, candidates);
    if (!matches.length) { excluded.review.push({ endpoint: label, reason: 'no_backend_route' }); continue; }
    const verdicts = matches.map(match => ({ match, verdict: judgeOnce(match) }));
    const bad = verdicts.find(({ verdict }) => !verdict.safe);
    if (bad) { excluded[bad.verdict.kind === 'rule' ? 'rule' : 'review'].push({ endpoint: label, reason: bad.verdict.reason }); continue; }
    const fingerprint = read.endpointFingerprint(verdicts.map(({ verdict }) => verdict));
    const writes = [...new Set(verdicts.flatMap(({ verdict }) => verdict.writes))].sort();
    const notAdmitted = read.checkReview(fingerprint, row) || chainProblem(row, fingerprint, writes);
    if (notAdmitted) { excluded.review.push({ endpoint: label, reason: notAdmitted, fingerprint, writes }); continue; }
    admittedRoutes.push(...matches);
    const pattern = `/${read.uniqueParamNames(read.nameParams(segments, matches[0].match || matches[0])).join('/')}`;
    if (writeRules.editDenyReason(method, pattern)) { excluded.rule.push({ endpoint: label, reason: writeRules.editDenyReason(method, pattern) }); continue; }
    if (row.endpoint !== pattern) throw new Error(`admin-write-reviewed.json ${label}: the row must use the catalog pattern ${pattern}`);
    const base = {
      method,
      endpoint: pattern,
      params: readRules.patternParams(pattern),
      paramKinds: row.params,
      screens: [...group.screens].sort(),
      handlers: [...group.handlers].sort(),
      label: row.label || read.labelFor(pattern, [...group.handlers].sort()),
      scope: row.scope,
      ...(row.scope === 'broad' ? {} : { scopeParam: row.scopeParam }),
      body: row.body,
      required: [...(row.required || [])],
      writes,
      reason: row.reason,
      noSend: row.noSend,
      ...(row.beforeRead ? { beforeRead: row.beforeRead } : {}),
    };
    // One digest over everything the card relies on, the handler chain
    // included, so a changed row, body list or handler changes the digest.
    entries.push({ ...base, chain: fingerprint.hash, digest: sha({ ...base, chain: fingerprint.hash }) });
  }
  entries.sort((a, b) => (a.endpoint + a.method).localeCompare(b.endpoint + b.method));
  const admitted = new Set(admittedRoutes);
  const blockedRoutes = read.blockedFor(table, entries, entry => admitted.has(entry));
  return {
    output: { version: CATALOG_VERSION, source: 'docs/intelligence-bar-capabilities.json', entries, blockedRoutes },
    counts: {
      census_edit_endpoints: groups.size,
      reviewed_rows: reviewed.reviewed.size,
      excluded_by_rule: excluded.rule.length,
      not_reviewed: excluded.review.filter(item => item.reason === 'not reviewed').length,
      stale_or_blocked: excluded.review.filter(item => item.reason !== 'not reviewed').length,
      in_catalog: entries.length,
    },
    excluded,
  };
}

function serialize(output) {
  const { entries, blockedRoutes, ...head } = output;
  return `${JSON.stringify(head, null, 2).replace(/\n}$/, ',\n')}  "entries": [\n${entries.map(e => `    ${JSON.stringify(e)}`).join(',\n')}\n  ],\n`
    + (blockedRoutes.length
      ? `  "blockedRoutes": [\n${blockedRoutes.map(r => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]\n}\n`
      : '  "blockedRoutes": []\n}\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--fingerprint')) {
    const { table, opaqueMounts } = read.routeTable(['put', 'patch', 'all']);
    const rest = args.slice(args.indexOf('--fingerprint') + 1);
    for (let i = 0; i + 1 < rest.length; i += 2) {
      const method = rest[i].toUpperCase();
      const normalized = `/${readRules.splitPath(rest[i + 1]).map(seg => (readRules.isParam(seg) ? ':param' : seg)).join('/')}`;
      const candidates = table.filter(entry => entry.route.method === method.toLowerCase() || entry.route.all);
      const verdicts = read.matchRoutes(readRules.splitPath(normalized), candidates).map(match => ({ verdict: judgeEdit(match, opaqueMounts), match }));
      const problems = verdicts.filter(({ verdict }) => !verdict.safe).map(({ verdict }) => verdict.reason);
      const all = verdicts.map(({ verdict }) => verdict);
      console.log(JSON.stringify({
        endpoint: rest[i + 1], method, routes: verdicts.length, scanBlocked: problems,
        files: [...new Set(verdicts.map(({ match }) => match.file))],
        writes: [...new Set(all.flatMap(v => v.writes || []))].sort(),
        ...read.endpointFingerprint(all),
        signalProblems: [...new Set(all.flatMap(v => v.signals || []))].map(s => [s, writeRules.signalProblem(s, {})]).filter(([, p]) => p),
      }, null, 1));
    }
    return;
  }
  const { output, counts, excluded } = buildCatalog();
  const text = serialize(output);
  if (args.includes('--report')) {
    console.log(JSON.stringify({ counts, excluded }, null, 1));
    return;
  }
  if (args.includes('--check')) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    console.log(`counts: ${JSON.stringify(counts)}`);
    excluded.review.filter(item => item.reason !== 'not reviewed').forEach(item => console.log(`out: ${item.endpoint} (${item.reason})`));
    if (current !== text) { console.error('admin-write-catalog.json is stale. Run: npm run ib:write-catalog'); process.exitCode = 1; return; }
    console.log('admin-write-catalog.json is current.');
    return;
  }
  fs.writeFileSync(OUT_FILE, text);
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)}: ${JSON.stringify(counts)}`);
}

if (require.main === module) main();
module.exports = { validateReviewedRow, loadReviewed, buildCatalog, serialize, censusEdits, judgeEdit, chainProblem, writtenTables, keyOf, OUT_FILE, REVIEWED_FILE };
