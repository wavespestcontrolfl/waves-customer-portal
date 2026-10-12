#!/usr/bin/env node
/**
 * Builds server/services/intelligence-bar/admin-read-catalog.json: the
 * allow-list behind the Intelligence Bar's general admin read tools
 * (`find_admin_reads`, `read_admin_data`; owner ruling 2026-10-12: the bar may
 * read what any admin screen reads, on the owner login, behind a gate).
 *
 * Source: docs/intelligence-bar-capabilities.json, the census of every admin
 * UI request site. Only a GET endpoint the census resolved to a literal path
 * can join. For each one this script:
 *   1. applies the path deny rules (server/utils/admin-read-rules.js, also re-checked at
 *      call time): credentials, identity flows, files, streams, action verbs;
 *   2. finds the backend route (server/index.js mounts + server/routes/*.js)
 *      and its handler; a route or handler it cannot find is excluded;
 *   3. scans the handler (and the local functions it calls, two levels deep)
 *      for a database write, an outside-service call, a file or stream
 *      response, or an effect verb. A flagged handler is excluded unless a
 *      reviewer cleared that exact signal set in admin-read-exclusions.json;
 *   4. applies the reviewed exclusions in admin-read-exclusions.json.
 * It also lists the unreviewed GET routes a parameter value could spell its
 * way into (`blockedRoutes`); the reader refuses a path that lands on one.
 *
 * Run: `npm run ib:read-catalog`. A test regenerates the catalog and compares
 * it byte for byte, so the catalog cannot drift from the census silently.
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const rules = require('../server/utils/admin-read-rules');

const ROOT = path.resolve(__dirname, '..');
const CENSUS_FILE = path.join(ROOT, 'docs/intelligence-bar-capabilities.json');
const OUT_FILE = path.join(ROOT, 'server/services/intelligence-bar/admin-read-catalog.json');
const EXCLUSIONS_FILE = path.join(ROOT, 'server/services/intelligence-bar/admin-read-exclusions.json');
const CATALOG_VERSION = 1;
const ANALYSIS_DEPTH = 5;

// ── source parsing ───────────────────────────────────────────────────────

const parsed = new Map();
function parseFile(file) {
  if (!parsed.has(file)) {
    const source = fs.readFileSync(file, 'utf8');
    const ast = parser.parse(source, { sourceType: 'unambiguous', plugins: ['jsx'], errorRecovery: true });
    parsed.set(file, { source, ast, file, ...topLevel(ast, file) });
  }
  return parsed.get(file);
}

function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit, parent)); return; }
  if (node.type && visit(node, parent) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'comments', 'tokens', 'leadingComments', 'trailingComments', 'innerComments', 'extra'].includes(key)) continue;
    if (value && typeof value === 'object') walk(value, visit, node.type ? node : parent);
  }
}

function isFunction(node) {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod'].includes(node?.type);
}

function stringOf(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map(q => q.value.cooked).join('');
  return null;
}

function requireTarget(node, fromFile) {
  if (node?.type === 'AwaitExpression') return requireTarget(node.argument, fromFile);
  if (node?.type !== 'CallExpression' || node.callee.name !== 'require') return null;
  const spec = stringOf(node.arguments[0]);
  if (!spec) return null;
  if (!spec.startsWith('.')) return { external: spec };
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (candidate.endsWith('.json')) return { external: spec };
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { file: candidate, spec };
  }
  return { missing: spec };
}

// Top-level bindings: functions by name, require() bindings, module exports.
function topLevel(ast, file) {
  const functions = new Map();
  const requires = new Map(); // local name -> { file | external | missing, member? }
  const exportsMap = new Map(); // exported name -> function node | local name
  const routers = new Map(); // local router variable -> true
  const objects = new Map(); // top-level object literal / class instance name -> node
  const collections = new Set(); // top-level in-memory Map / Set names
  for (const stmt of ast.program.body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) functions.set(stmt.id.name, stmt);
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) bindDeclarator(decl, file, { functions, requires, routers, objects, collections });
    }
    if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'AssignmentExpression') {
      bindExport(stmt.expression, exportsMap);
    }
    if (stmt.type === 'ClassDeclaration' && stmt.id) {
      objects.set(stmt.id.name, stmt);
      for (const member of stmt.body.body) {
        if (member.type === 'ClassMethod' && member.key?.name) functions.set(`${stmt.id.name}.${member.key.name}`, member);
      }
    }
  }
  return { functions, requires, exportsMap, routers, objects, collections };
}

const COLLECTION_CLASSES = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

function bindDeclarator(decl, file, tables) {
  if (!decl.init) return;
  if (decl.id.type === 'Identifier') bindIdentifier(decl.id.name, decl.init, file, tables);
  else if (decl.id.type === 'ObjectPattern') bindPattern(decl, file, tables.requires);
}

// `const fn = require('./x').member`.
function memberRequire(init, file) {
  if (init.type !== 'MemberExpression' || init.object.type !== 'CallExpression') return null;
  const target = requireTarget(init.object, file);
  return target ? { ...target, member: init.property.name } : null;
}

function bindIdentifier(name, init, file, { functions, requires, routers, objects, collections }) {
  if (isFunction(init)) functions.set(name, init);
  if (init.type === 'ObjectExpression' || init.type === 'NewExpression') objects.set(name, init);
  if (init.type === 'NewExpression' && COLLECTION_CLASSES.has(init.callee.name)) collections.add(name);
  const target = requireTarget(init, file) || memberRequire(init, file);
  if (target) requires.set(name, target);
  if (init.type === 'CallExpression' && (init.callee.property?.name === 'Router' || init.callee.name === 'Router')) routers.set(name, true);
}

// `const { a, b } = require('./x')`.
function bindPattern(decl, file, requires) {
  const target = requireTarget(decl.init, file);
  if (!target) return;
  for (const prop of decl.id.properties) {
    if (prop.type === 'ObjectProperty' && prop.value.type === 'Identifier') {
      requires.set(prop.value.name, { ...target, member: prop.key.name || prop.key.value });
    }
  }
}

function exportName(left) {
  if (left.type !== 'MemberExpression') return null;
  const obj = left.object;
  if (obj.type === 'Identifier' && obj.name === 'exports') return left.property.name;
  if (obj.type === 'MemberExpression' && obj.object.name === 'module' && obj.property.name === 'exports') return left.property.name;
  return null;
}

function bindExport(expression, exportsMap) {
  const { left, right } = expression;
  if (left.type === 'MemberExpression' && left.object.name === 'module' && left.property.name === 'exports') {
    if (right.type === 'ObjectExpression') {
      for (const prop of right.properties) {
        const key = prop.key?.name || prop.key?.value;
        if (!key) continue;
        exportsMap.set(key, prop.type === 'ObjectProperty' ? prop.value : prop);
      }
    } else exportsMap.set('default', right);
    return;
  }
  const name = exportName(left);
  if (name) exportsMap.set(name, right);
}

// A method on an object literal, a class, or `new Class()` in the file.
function methodOf(node, member, info) {
  let target = node;
  if (target?.type === 'NewExpression' && target.callee.type === 'Identifier') target = info.objects.get(target.callee.name);
  if (target?.type === 'ObjectExpression') {
    const prop = target.properties.find(p => (p.key?.name || p.key?.value) === member);
    if (prop?.type === 'ObjectMethod') return prop;
    if (prop?.type === 'ObjectProperty' && isFunction(prop.value)) return prop.value;
    if (prop?.type === 'ObjectProperty' && prop.value.type === 'Identifier' && info.functions.has(prop.value.name)) return info.functions.get(prop.value.name);
  }
  if (target?.type === 'ClassDeclaration') {
    return target.body.body.find(m => m.type === 'ClassMethod' && m.key?.name === member) || null;
  }
  return null;
}

// A function node for an exported name (or a top-level name) in a file.
function exportedFunction(file, member) {
  const info = parseFile(file);
  const value = info.exportsMap.get(member);
  if (value && isFunction(value)) return { fn: value, info };
  if (value?.type === 'Identifier' && info.functions.has(value.name)) return { fn: info.functions.get(value.name), info };
  if (info.functions.has(member)) return { fn: info.functions.get(member), info };
  const whole = info.exportsMap.get('default');
  const holder = whole?.type === 'Identifier' ? info.objects.get(whole.name) : whole;
  const method = methodOf(holder, member, info);
  if (method) return { fn: method, info };
  return null;
}

// ── mounts and routes ────────────────────────────────────────────────────

function mountedRouters() {
  const indexFile = path.join(ROOT, 'server/index.js');
  const info = parseFile(indexFile);
  const mounts = [];
  const inline = [];
  walk(info.ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.object.name !== 'app') return;
    const method = node.callee.property.name;
    const prefix = stringOf(node.arguments[0]);
    if (!prefix || !prefix.startsWith('/api/admin')) return;
    if (method === 'get') {
      inline.push({ path: prefix.replace(/^\/api/, ''), args: node.arguments.slice(1), info, line: node.loc.start.line });
    }
    if (method !== 'use') return;
    for (const arg of node.arguments.slice(1)) {
      const mount = mountTarget(arg, info);
      if (mount) mounts.push({ prefix: prefix.replace(/^\/api/, ''), line: node.loc.start.line, ...mount });
    }
  });
  return { mounts, inline };
}

function mountTarget(arg, info) {
  let node = arg;
  let member = null;
  if (node.type === 'MemberExpression') { member = node.property.name; node = node.object; }
  const target = node.type === 'Identifier' ? info.requires.get(node.name) : requireTarget(node, info.file);
  if (!target?.file || !target.file.includes(`${path.sep}routes${path.sep}`)) return null;
  return { file: target.file, member: member || target.member || null };
}

function routePaths(arg) {
  const text = stringOf(arg);
  if (text !== null) return [text];
  if (arg?.type === 'ArrayExpression') {
    const items = arg.elements.map(stringOf);
    return items.every(item => item !== null) ? items : null;
  }
  return null;
}

// Every GET (or catch-all) registration in a router file, by receiver.
function routerRoutes(file) {
  const info = parseFile(file);
  const routes = [];
  const opaque = [];
  walk(info.ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
    const callee = node.callee;
    const method = callee.property.name;
    if (callee.object.type === 'Identifier' && info.routers.has(callee.object.name) && ['get', 'all'].includes(method)) {
      const paths = routePaths(node.arguments[0]);
      if (!paths) { opaque.push({ line: node.loc.start.line, why: 'dynamic route path' }); return; }
      for (const p of paths) routes.push({ recv: callee.object.name, path: p, args: node.arguments.slice(1), all: method === 'all', line: node.loc.start.line, info });
    }
    if (method === 'get' && callee.object.type === 'CallExpression' && callee.object.callee.property?.name === 'route' && info.routers.has(callee.object.callee.object.name)) {
      const paths = routePaths(callee.object.arguments[0]);
      if (!paths) { opaque.push({ line: node.loc.start.line, why: 'dynamic route path' }); return; }
      for (const p of paths) routes.push({ recv: callee.object.callee.object.name, path: p, args: node.arguments, all: false, line: node.loc.start.line, info });
    }
  });
  return { routes, opaque };
}

function joinPath(prefix, routePath) {
  const parts = [...rules.splitPath(prefix), ...rules.splitPath(routePath)];
  return `/${parts.map(part => part.replace(/\(.*\)$/, '')).join('/')}`;
}

function routeTable() {
  const { mounts, inline } = mountedRouters();
  const table = [];
  const opaqueMounts = [];
  for (const mount of mounts) {
    const { routes, opaque } = routerRoutes(mount.file);
    const info = parseFile(mount.file);
    const receivers = mount.member ? receiversFor(info, mount.member) : null;
    for (const route of routes) {
      if (receivers && !receivers.has(route.recv)) continue;
      if (route.all || /[*]/.test(route.path)) opaqueMounts.push(mount.prefix);
      table.push({ full: joinPath(mount.prefix, route.path), file: path.relative(ROOT, mount.file), line: route.line, route });
    }
    if (opaque.length) opaqueMounts.push(mount.prefix);
  }
  for (const route of inline) {
    table.push({ full: joinPath(route.path, ''), file: 'server/index.js', line: route.line, route: { args: route.args, info: route.info, path: '' } });
  }
  return { table, opaqueMounts };
}

function receiversFor(info, member) {
  const value = info.exportsMap.get(member);
  return new Set(value?.type === 'Identifier' ? [value.name] : [...info.routers.keys()]);
}

// ── handler analysis ─────────────────────────────────────────────────────

const WRITE_METHODS = new Set(['insert', 'update', 'del', 'delete', 'increment', 'decrement', 'truncate', 'upsert',
  'onConflict', 'batchInsert', 'transaction', 'destroy', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'mkdir', 'createTable', 'createTableIfNotExists', 'alterTable', 'dropTable', 'dropTableIfExists', 'renameTable', 'createSchema', 'unlink', 'unlinkSync', 'rmSync', 'rename', 'copyFile', 'createWriteStream']);
const OUTSIDE_IDENTIFIERS = new Set(['axios', 'fetch', 'got', 'stripe', 'twilio', 'sgMail', 'sendgrid', 'anthropic', 'openai',
  'plaid', 'nodemailer', 'http', 'https', 'exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'child_process', 'XMLHttpRequest', 'WebSocket']);
const OUTSIDE_PATH_RE = /(twilio|stripe|sendgrid|anthropic|openai|plaid|googleapis|google-|gbp|ga4|gsc|search-console|meta-ads|facebook|dataforseo|bouncie|apify|cloudflare|railway|github|sentry|growthbook|nodemailer|mailer|webpush|web-push|firebase|apns|aws|mapbox|open-meteo|geocod|serpapi|siteone|puppeteer|playwright|sms-service|sms\.js|send-|llm|claude|gemini|elevenlabs|resend|transcri|speech|vision|ocr|notify|bell|admin-alert|web-search|dataforseo|serp)/i;
// First word of a camelCase name. A call is judged by the verb it starts with:
// `sendReceipt` and `syncFromStripe` act, `startsWith` and `getSent` do not.
const EFFECT_WORDS = new Set(['send', 'sync', 'refresh', 'trigger', 'generate', 'recompute', 'recalc', 'recalculate', 'mark', 'enqueue',
  'queue', 'notify', 'create', 'update', 'save', 'record', 'log', 'track', 'import', 'reset', 'retry', 'start', 'stop', 'run', 'process',
  'execute', 'submit', 'publish', 'approve', 'dispatch', 'delete', 'remove', 'insert', 'write', 'upsert', 'ensure', 'touch', 'increment',
  'decrement', 'archive', 'cancel', 'claim', 'lock', 'persist', 'store', 'invalidate', 'bump', 'stamp', 'seed', 'backfill', 'rebuild',
  'merge', 'post', 'put', 'patch', 'charge', 'refund', 'void', 'reconcile', 'email', 'alert', 'bell', 'ring', 'emit', 'fire', 'schedule',
  'flush', 'release', 'acquire', 'enroll', 'register', 'activate', 'deactivate', 'enable', 'disable', 'toggle', 'upload', 'download',
  'fetch', 'pull', 'poll', 'scrape', 'crawl', 'ping', 'probe', 'warm', 'prime', 'hydrate', 'settle', 'sweep', 'purge', 'drain']);
// A write hiding behind a read-sounding name: getOrCreateX, loadAndMarkY.
const EFFECT_ANYWHERE_RE = /(OrCreate|OrInsert|OrInit|OrUpdate|AndMark|AndSave|AndUpdate|AndSend|AndCreate|Upsert|Persist|Enqueue|Notify|SendSms|SendEmail)/;
function firstWord(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/)[0].toLowerCase();
}
const NEUTRAL_RECEIVERS = new Set(['res', 'req', 'logger', 'console', 'Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Date', 'Promise',
  'Set', 'Map', 'path', 'moment', 'dayjs', 'DateTime', 'crypto', 'Buffer', 'Intl', 'process', 'db', 'trx', 'knex']);
const NEUTRAL_CALLS = new Set(['next', 'require', 'Number', 'String', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'Date', 'Array', 'Object', 'Set', 'Map', 'Promise', 'Error',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'encodeURIComponent', 'decodeURIComponent', 'BigInt', 'Symbol', 'db', 'trx', 'knex', 'transaction']);
const SQL_WRITE_RE = /\b(insert\s+into|update\s+\w|delete\s+from|truncate|alter\s+table|drop\s+table|create\s+table|create\s+index|nextval|setval|pg_advisory|for\s+update|on\s+conflict|refresh\s+materialized)\b/i;
const RESPONSE_BINARY = new Set(['sendFile', 'download', 'redirect', 'write', 'pipe', 'attachment', 'cookie', 'clearCookie', 'sendStatus', 'type', 'format']);
const JSON_RESPONSE = new Set(['json', 'send', 'jsonp']);

// Files whose functions the scan read (review aid).
const touchedFiles = new Set();

// Where each signal was first seen (review aid for --explain).
const origins = new Map();
function flag(signals, signal, info, node) {
  signals.add(signal);
  if (!origins.has(signal)) origins.set(signal, `${path.relative(ROOT, info.file)}:${node.loc?.start.line}`);
}

// Service calls the scan could not follow into source (review aid only).
const unresolvedCalls = new Set();

function calleeName(callee) {
  if (callee.type === 'Identifier') return { name: callee.name, receiver: null };
  if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
    let object = callee.object;
    while (object.type === 'MemberExpression' || object.type === 'OptionalMemberExpression' || object.type === 'CallExpression' || object.type === 'AwaitExpression') {
      object = object.object || object.callee || object.argument;
    }
    const prop = callee.property?.name || callee.property?.value || '';
    return { name: prop, receiver: object?.type === 'Identifier' ? object.name : (object?.type === 'ThisExpression' ? 'this' : null) };
  }
  return { name: '', receiver: null };
}

function sourceOf(info, node) {
  return info.source.slice(node.start, node.end);
}

function analyze(fn, info, depth, seen = new Set()) {
  const signals = new Set();
  if (!fn || seen.has(fn)) return signals;
  seen.add(fn);
  touchedFiles.add(path.relative(ROOT, info.file));
  const ctx = { info, depth, seen, signals, sawResponse: false };
  walk(fn.body || fn, (node, parent) => visitNode(node, parent, ctx));
  if (!ctx.sawResponse && depth === 0) flag(signals, 'no_json_response', info, fn);
  return signals;
}

function visitNode(node, parent, ctx) {
  const { info, signals } = ctx;
  if (node.type === 'Identifier' && OUTSIDE_IDENTIFIERS.has(node.name) && !isPropertyName(node, parent)) flag(signals, `outside:${node.name}`, info, node);
  if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && node.left.object.name === 'process') flag(signals, 'writes_process_state', info, node);
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
  const { name, receiver } = calleeName(node.callee);
  if (name === 'require') return;
  if (isResponseCall(node, receiver)) { inspectResponseCall(node, name, ctx); return; }
  inspectWriteCall(node, name, receiver, info, signals);
  inspectCallee(node, name, receiver, info, ctx.depth, ctx.seen, signals);
}

function isResponseCall(node, receiver) {
  if (receiver === 'res') return true;
  const inner = node.callee.type === 'MemberExpression' ? node.callee.object : null;
  return inner?.type === 'CallExpression' && calleeName(inner.callee).receiver === 'res';
}

function inspectResponseCall(node, name, ctx) {
  const { info, signals } = ctx;
  if (JSON_RESPONSE.has(name)) ctx.sawResponse = true;
  if (RESPONSE_BINARY.has(name)) flag(signals, `response:${name}`, info, node);
  if (['set', 'setHeader', 'header', 'append'].includes(name)) {
    const text = sourceOf(info, node);
    if (/content-type|set-cookie|content-disposition/i.test(text) && !/application\/json/i.test(text)) flag(signals, 'response:header', info, node);
  }
}

const RAW_QUERY_METHODS = new Set(['raw', 'whereRaw', 'havingRaw', 'orderByRaw', 'joinRaw']);
function inspectWriteCall(node, name, receiver, info, signals) {
  const hashing = /createHash|createHmac|\bhash\b/i.test(sourceOf(info, node).slice(0, 200));
  if (WRITE_METHODS.has(name) && !info.collections.has(receiver) && !hashing) flag(signals, `write:${name}`, info, node);
  if (RAW_QUERY_METHODS.has(name) && node.arguments[0] && SQL_WRITE_RE.test(sourceOf(info, node.arguments[0]))) flag(signals, 'write:raw_sql', info, node);
}

// `re.exec(x)` and `{ fetch: 1 }` name a property, not the global.
function isPropertyName(node, parent) {
  if (!parent) return false;
  if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.property === node && !parent.computed) return true;
  return (parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod') && parent.key === node && !parent.computed;
}

function outsideTargetSignals(targets, info, node, signals) {
  for (const target of targets) {
    if (target?.external && OUTSIDE_IDENTIFIERS.has(target.external.replace(/^node:/, ''))) flag(signals, `outside:${target.external}`, info, node);
    if (target?.file && OUTSIDE_PATH_RE.test(path.relative(ROOT, target.file))) {
      flag(signals, `outside_service:${path.relative(ROOT, target.file).replace(/^server\/(services\/)?/, '').replace(/\.js$/, '')}`, info, node);
    }
  }
}

function isNeutralCall(name, receiver) {
  return NEUTRAL_RECEIVERS.has(receiver) || NEUTRAL_CALLS.has(name);
}

// Only a bare function or a call on a required module can be a service
// action; `arr.push`, `str.startsWith` and `map.set` are language calls.
function isServiceEffect(node, name, receiver, required) {
  const serviceCall = node.callee.type === 'Identifier' || Boolean(required) || receiver === 'this';
  return serviceCall && !isNeutralCall(name, receiver) && (EFFECT_WORDS.has(firstWord(name)) || EFFECT_ANYWHERE_RE.test(name));
}

function noteUnresolved(node, name, receiver, required, direct) {
  if (!(node.callee.type === 'Identifier' || required) || isNeutralCall(name, receiver)) return;
  const source = (required || direct)?.file;
  unresolvedCalls.add(`${receiver ? `${receiver}.` : ''}${name}${source ? `@${path.relative(ROOT, source).replace('server/', '')}` : ''}`);
}

function inspectCallee(node, name, receiver, info, depth, seen, signals) {
  const local = node.callee.type === 'Identifier' ? info.functions.get(name) : null;
  const required = receiver && info.requires.get(receiver);
  const direct = node.callee.type === 'Identifier' ? info.requires.get(name) : null;
  outsideTargetSignals([required, direct], info, node, signals);
  const next = local ? { fn: local, info } : resolveRequired(required, direct, name);
  if (next && depth < ANALYSIS_DEPTH) { mergeSignals(signals, analyze(next.fn, next.info, depth + 1, seen)); return; }
  if (!next) noteUnresolved(node, name, receiver, required, direct);
  if (!local && isServiceEffect(node, name, receiver, required)) flag(signals, `effect_call:${name}`, info, node);
}

function mergeSignals(into, from) {
  for (const signal of from) if (signal !== 'no_json_response') into.add(signal);
}

function resolveRequired(required, direct, name) {
  if (required?.file) {
    const found = exportedFunction(required.file, name);
    if (found) return found;
  }
  if (direct?.file) {
    const found = exportedFunction(direct.file, direct.member || 'default') || (direct.member ? null : exportedFunction(direct.file, name));
    if (found) return found;
  }
  return null;
}

// The function nodes that run for one route: inline middleware and handler.
function routeFunctions(route) {
  const info = route.info;
  const out = [];
  const args = route.args;
  let handlerFound = false;
  args.forEach((arg, index) => {
    const last = index === args.length - 1;
    const resolved = resolveArg(arg, info);
    if (resolved) { out.push(resolved); if (last) handlerFound = true; }
  });
  return { functions: out, handlerFound };
}

function resolveArg(arg, info) {
  if (isFunction(arg)) return { fn: arg, info };
  if (arg.type === 'Identifier') return info.functions.has(arg.name) ? { fn: info.functions.get(arg.name), info } : resolveImported(arg.name, null, info);
  if (arg.type === 'MemberExpression') return resolveImported(arg.property.name, arg.object.name, info);
  if (arg.type === 'CallExpression') {
    const inner = arg.arguments.map(a => resolveArg(a, info)).find(Boolean);
    if (inner) return inner;
    if (arg.callee.type === 'Identifier' && info.functions.has(arg.callee.name)) return { fn: info.functions.get(arg.callee.name), info };
    if (arg.callee.type === 'MemberExpression') return resolveImported(arg.callee.property.name, arg.callee.object.name, info);
  }
  return null;
}

function resolveImported(name, receiver, info) {
  const target = receiver ? info.requires.get(receiver) : info.requires.get(name);
  if (!target?.file) return null;
  const found = exportedFunction(target.file, receiver ? name : (target.member || 'default'));
  return found ? { fn: found.fn, info: found.info } : null;
}

// ── route safety ─────────────────────────────────────────────────────────

function routeKey(full) {
  return `GET ${rules.splitPath(full).map(s => (rules.isParam(s) ? ':param' : s)).map(s => `/${s}`).join('')}`;
}

function loadExclusions() {
  const raw = JSON.parse(fs.readFileSync(EXCLUSIONS_FILE, 'utf8'));
  return {
    exclude: new Map(raw.exclude.map(row => [row.route, row.reason])),
    allow: new Map(raw.allow.map(row => [row.route, row])),
  };
}

function judgeRoute(entry, exclusions, opaqueMounts) {
  const key = routeKey(entry.full);
  const ruled = rules.denyReason(entry.full);
  if (ruled) return { safe: false, kind: 'rule', reason: ruled };
  if (exclusions.exclude.has(key)) return { safe: false, kind: 'review', reason: exclusions.exclude.get(key) };
  if (opaqueMounts.some(prefix => entry.full === prefix || entry.full.startsWith(`${prefix}/`))) {
    return { safe: false, kind: 'review', reason: 'router has a catch-all or dynamic route' };
  }
  const { functions, handlerFound } = routeFunctions(entry.route);
  if (!functions.length || !handlerFound) return { safe: false, kind: 'review', reason: 'handler_not_found' };
  const signals = new Set();
  unresolvedCalls.clear();
  touchedFiles.clear();
  functions.forEach(({ fn, info }) => analyze(fn, info, 0).forEach(signal => signals.add(signal)));
  const unresolved = [...unresolvedCalls].sort();
  const touched = [...touchedFiles].sort();
  // The final handler must answer with JSON; middleware need not.
  if (functions.length > 1) signals.delete('no_json_response');
  const list = [...signals].sort();
  if (!list.length) return { safe: true, signals: list, unresolved, touched };
  const allowed = exclusions.allow.get(key);
  if (allowed && allowed.signals.join(',') === list.join(',')) return { safe: true, signals: list, cleared: allowed.reason };
  return { safe: false, kind: 'review', reason: `scan: ${list.join(', ')}`, signals: list };
}

// ── census → catalog ─────────────────────────────────────────────────────

function humanize(text) {
  return String(text).replace(/\.[jt]sx?$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim().toLowerCase();
}

function matchRoutes(endpointSegments, table) {
  const compatible = table.filter(({ full }) => {
    const segments = rules.splitPath(full);
    if (segments.length !== endpointSegments.length) return false;
    return segments.every((segment, i) => {
      const wild = rules.routeSegmentIsWild(segment);
      if (rules.isParam(endpointSegments[i])) return wild;
      return wild || segment.toLowerCase() === endpointSegments[i].toLowerCase();
    });
  });
  const aligned = compatible.filter(({ full }) => rules.splitPath(full).every((segment, i) => (
    rules.isParam(endpointSegments[i]) === rules.routeSegmentIsWild(segment))));
  return aligned.length ? aligned : compatible;
}

function nameParams(endpointSegments, route) {
  const routeSegments = rules.splitPath(route.full);
  return endpointSegments.map((segment, i) => (rules.isParam(segment) ? routeSegments[i] : segment));
}

function uniqueParamNames(segments) {
  const seen = new Map();
  return segments.map((segment) => {
    if (!rules.isParam(segment)) return segment;
    const base = /^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment) && segment !== ':param' ? segment.slice(1) : 'id';
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return `:${count === 1 ? base : `${base}${count}`}`;
  });
}

function censusGets(census) {
  const groups = new Map();
  const skipped = { partial_template: new Set(), not_literal: 0 };
  for (const action of census.actions) {
    if (action.operation.method !== 'GET') continue;
    if (action.operation.resolution !== 'literal_or_template' || !action.operation.endpoint) { skipped.not_literal++; continue; }
    const endpoint = action.operation.endpoint;
    if (rules.splitPath(endpoint).some(s => s.includes(':param') && s !== ':param')) { skipped.partial_template.add(endpoint); continue; }
    if (!groups.has(endpoint)) groups.set(endpoint, { screens: new Set(), handlers: new Set() });
    const group = groups.get(endpoint);
    group.screens.add(String(action.module).replace(/\.[jt]sx?$/, ''));
    if (action.ui.handler && action.ui.handler !== 'inline action') group.handlers.add(action.ui.handler);
  }
  return { groups, skipped };
}

function labelFor(pattern, handlers) {
  const words = rules.splitPath(pattern).filter(s => !rules.isParam(s)).slice(1).map(humanize).filter(Boolean);
  const where = words.join(' ') || 'admin';
  const how = [...handlers].map(humanize).filter(h => h && h.length > 2).slice(0, 2).join(' / ');
  return how ? `${where} (${how})` : where;
}

function buildCatalog({ census, exclusions = loadExclusions() } = {}) {
  const source = census || JSON.parse(fs.readFileSync(CENSUS_FILE, 'utf8'));
  const { table, opaqueMounts } = routeTable();
  const judged = new Map();
  const judgeOnce = (entry) => {
    if (!judged.has(entry)) judged.set(entry, judgeRoute(entry, exclusions, opaqueMounts));
    return judged.get(entry);
  };
  const { groups, skipped } = censusGets(source);
  const entries = [];
  const excluded = { rule: [], review: [], unresolvable: [...skipped.partial_template].sort() };
  const reviewAid = [];
  for (const [endpoint, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ruled = rules.denyReason(endpoint);
    if (ruled) { excluded.rule.push({ endpoint, reason: ruled }); continue; }
    const segments = rules.splitPath(endpoint);
    const matches = matchRoutes(segments, table);
    if (!matches.length) { excluded.review.push({ endpoint, reason: 'no_backend_route' }); continue; }
    const verdicts = matches.map(match => ({ match, verdict: judgeOnce(match) }));
    const bad = verdicts.find(({ verdict }) => !verdict.safe);
    if (bad) { excluded[bad.verdict.kind === 'rule' ? 'rule' : 'review'].push({ endpoint, reason: bad.verdict.reason }); continue; }
    const pattern = `/${uniqueParamNames(nameParams(segments, matches[0].match || matches[0])).join('/')}`;
    if (rules.denyReason(pattern)) { excluded.rule.push({ endpoint, reason: rules.denyReason(pattern) }); continue; }
    reviewAid.push({ endpoint, unresolved: [...new Set(verdicts.flatMap(({ verdict }) => verdict.unresolved || []))],
      touched: [...new Set(verdicts.flatMap(({ verdict }) => verdict.touched || []))] });
    entries.push({
      endpoint: pattern,
      params: rules.patternParams(pattern),
      screens: [...group.screens].sort(),
      handlers: [...group.handlers].sort(),
      label: labelFor(pattern, [...group.handlers].sort()),
    });
  }
  const unique = new Map();
  for (const entry of entries) {
    const known = unique.get(entry.endpoint);
    if (!known) { unique.set(entry.endpoint, entry); continue; }
    known.screens = [...new Set([...known.screens, ...entry.screens])].sort();
    known.handlers = [...new Set([...known.handlers, ...entry.handlers])].sort();
    known.label = labelFor(entry.endpoint, known.handlers);
  }
  const catalog = [...unique.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  const blockedRoutes = blockedFor(table, catalog, judgeOnce);
  return {
    output: {
      version: CATALOG_VERSION,
      source: 'docs/intelligence-bar-capabilities.json',
      counts: {
        census_get_endpoints: groups.size + skipped.partial_template.size,
        excluded_by_rule: excluded.rule.length,
        excluded_by_review: excluded.review.length,
        unresolvable_template: excluded.unresolvable.length,
        in_catalog: catalog.length,
      },
      entries: catalog,
      blockedRoutes,
    },
    excluded,
    reviewAid,
  };
}

// Unreviewed GET routes that a parameter value could reach: same shape as a
// catalog pattern, with a literal where the pattern takes a parameter.
function blockedFor(table, catalog, judgeOnce) {
  const blocked = new Set();
  for (const entry of table) {
    if (judgeOnce(entry).safe) continue;
    const segments = rules.splitPath(entry.full);
    const reachable = catalog.some((item) => {
      const pattern = rules.splitPath(item.endpoint);
      if (pattern.length !== segments.length) return false;
      let usesParam = false;
      for (let i = 0; i < segments.length; i++) {
        if (rules.routeSegmentIsWild(segments[i]) || rules.isParam(pattern[i])) {
          if (rules.isParam(pattern[i]) && !rules.routeSegmentIsWild(segments[i])) usesParam = true;
          continue;
        }
        if (segments[i].toLowerCase() !== pattern[i].toLowerCase()) return false;
      }
      return usesParam;
    });
    if (reachable) blocked.add(`/${segments.map(s => (rules.routeSegmentIsWild(s) ? ':param' : s)).join('/')}`);
  }
  return [...blocked].sort();
}

function serialize(output) {
  const { entries, blockedRoutes, ...head } = output;
  return `${JSON.stringify(head, null, 2).replace(/\n}$/, ',\n')}  "entries": [\n${entries.map(e => `    ${JSON.stringify(e)}`).join(',\n')}\n  ],\n`
    + `  "blockedRoutes": [\n${blockedRoutes.map(r => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]\n}\n`;
}

function main() {
  const { output, excluded, reviewAid } = buildCatalog();
  const text = serialize(output);
  if (process.argv.includes('--report')) {
    console.log(JSON.stringify({ counts: output.counts, excluded, reviewAid }, null, 1));
    return;
  }
  if (process.argv.includes('--explain')) {
    const wanted = process.argv[process.argv.indexOf('--explain') + 1];
    const { table, opaqueMounts } = routeTable();
    const exclusions = loadExclusions();
    for (const entry of table.filter(e => routeKey(e.full) === `GET ${wanted}`)) {
      origins.clear();
      const verdict = judgeRoute(entry, exclusions, opaqueMounts);
      console.log(entry.file, entry.line, JSON.stringify(verdict), JSON.stringify([...origins]));
    }
    return;
  }
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    if (current !== text) { console.error('admin-read-catalog.json is stale. Run: npm run ib:read-catalog'); process.exitCode = 1; return; }
    console.log('admin-read-catalog.json is current.');
    return;
  }
  fs.writeFileSync(OUT_FILE, text);
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)}: ${JSON.stringify(output.counts)}`);
}

if (require.main === module) main();
module.exports = { origins, touchedFiles, buildCatalog, serialize, routeTable, judgeRoute, routeKey, loadExclusions, CENSUS_FILE, OUT_FILE, EXCLUSIONS_FILE };
