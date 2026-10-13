#!/usr/bin/env node
/**
 * Builds server/services/intelligence-bar/admin-read-catalog.json: the
 * allow-list behind the Intelligence Bar's general admin read tools
 * (`find_admin_reads`, `read_admin_data`; owner ruling 2026-10-12: the bar may
 * read what any admin screen reads, on the owner login, behind a gate).
 *
 * ADMISSION IS BY REVIEWED ROW ONLY. An endpoint is in the catalog when
 * admin-read-reviewed.json holds a row for it that a person wrote after
 * reading the handler chain end to end, and that row still matches the code:
 * the same scan signals, the same unresolved callees and the same content hash
 * of the handler and of every function the scan followed for it. Any edit to
 * that chain drops the endpoint until someone reviews it again.
 *
 * The static scan is only a second lock. A reviewed endpoint is still left out
 * when the scan finds a write, an outside call, DDL, a signed-URL or credential
 * signal, a file response, or middleware that does any of that. The scan works
 * on the GET endpoints in docs/intelligence-bar-capabilities.json (the census)
 * that pass the path deny rules (server/utils/admin-read-rules.js), whose
 * backend handler it can find, following calls across modules, named callbacks
 * and the middleware that runs before the route.
 *
 * Run: `npm run ib:read-catalog`. A test regenerates the catalog and compares
 * it byte for byte, so the catalog cannot drift from the reviewed list silently.
 * `--fingerprint <endpoint>...` prints the fingerprint to put in a new row;
 * `--report` prints counts and every endpoint left out, with the reason.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const parser = require('@babel/parser');
const rules = require('../server/utils/admin-read-rules');
const { isCredentialName, isStrongCredentialName } = require('../server/utils/credential-fields');

const ROOT = path.resolve(__dirname, '..');
const CENSUS_FILE = path.join(ROOT, 'docs/intelligence-bar-capabilities.json');
const OUT_FILE = path.join(ROOT, 'server/services/intelligence-bar/admin-read-catalog.json');
const REVIEWED_FILE = path.join(ROOT, 'server/services/intelligence-bar/admin-read-reviewed.json');
const CATALOG_VERSION = 1;
const ANALYSIS_DEPTH = 8;

// ── source parsing ───────────────────────────────────────────────────────

const parsed = new Map();
function parseFile(file) {
  if (!parsed.has(file)) {
    const source = fs.readFileSync(file, 'utf8');
    const ast = parser.parse(source, { sourceType: 'unambiguous', plugins: ['jsx'], errorRecovery: true });
    parsed.set(file, { source, ast, file, ...topLevel(ast, file), nestedRequires: nestedRequireBindings(ast, file) });
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

// The require() bindings one declarator makes: `const a = require(x)`,
// `const a = require(x).b`, `const { a, b } = require(x)`.
function declaratorRequires(decl, file) {
  if (!decl.init) return [];
  if (decl.id.type === 'Identifier') {
    const target = requireTarget(decl.init, file) || memberRequire(decl.init, file);
    return target ? [[decl.id.name, target]] : [];
  }
  const target = decl.id.type === 'ObjectPattern' ? requireTarget(decl.init, file) : null;
  if (!target) return [];
  return decl.id.properties.filter(p => p.type === 'ObjectProperty' && p.value.type === 'Identifier')
    .map(p => [p.value.name, { ...target, member: p.key.name || p.key.value }]);
}

// Every require() binding anywhere in the file, including the ones a function
// makes inside its own body (`const { fn } = require('../services/x')`).
function nestedRequireBindings(ast, file) {
  const out = new Map();
  walk(ast.program.body, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    for (const [name, target] of declaratorRequires(node, file)) {
      if (!out.has(name)) out.set(name, []);
      out.get(name).push(target);
    }
  });
  return out;
}

// The module a name is bound to: a top-level binding, else a nested one when
// every nested binding of that name agrees. An ambiguous name is unresolved.
function lookupRequire(info, name) {
  if (!name) return null;
  if (info.requires.has(name)) return info.requires.get(name);
  const targets = info.nestedRequires.get(name) || [];
  const first = targets[0];
  const agree = first && targets.every(t => t.file === first.file && t.member === first.member && t.external === first.external);
  return agree ? first : null;
}

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

// A function node for an exported name (or a top-level name) in a file. A
// name the file re-exports from another module is followed there.
function exportedFunction(file, member, hops = 0) {
  const info = parseFile(file);
  const value = info.exportsMap.get(member);
  if (value && isFunction(value)) return { fn: value, info };
  if (value?.type === 'Identifier' && info.functions.has(value.name)) return { fn: info.functions.get(value.name), info };
  if (info.functions.has(member)) return { fn: info.functions.get(member), info };
  const whole = info.exportsMap.get('default');
  const holder = whole?.type === 'Identifier' ? info.objects.get(whole.name) : whole;
  const method = methodOf(holder, member, info);
  if (method) return { fn: method, info };
  const reexport = value?.type === 'Identifier' && hops < 4 ? info.requires.get(value.name) : null;
  return reexport?.file && reexport.member ? exportedFunction(reexport.file, reexport.member, hops + 1) : null;
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
    const args = node.arguments.slice(1);
    const targets = args.map(arg => mountTarget(arg, info));
    // Whatever else is in the same app.use(...) runs before the router.
    const mw = args.filter((arg, i) => !targets[i]).map(arg => ({ arg, info }));
    targets.forEach((mount) => {
      if (mount) mounts.push({ prefix: prefix.replace(/^\/api/, ''), line: node.loc.start.line, mw, ...mount });
    });
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

// `router.use([path], mw...)` and `router.param(name, fn)` in a router file.
function collectRouterMiddleware(node, info, uses) {
  const callee = node.callee;
  if (callee.object.type !== 'Identifier' || !info.routers.has(callee.object.name)) return;
  const base = { recv: callee.object.name, line: node.loc.start.line, info };
  if (callee.property.name === 'param') uses.push({ ...base, param: stringOf(node.arguments[0]), mws: node.arguments.slice(1) });
  if (callee.property.name !== 'use') return;
  const first = node.arguments[0];
  const paths = first && !isFunction(first) && first.type !== 'Identifier' ? routePaths(first) || ['*'] : null;
  uses.push({ ...base, paths, mws: paths ? node.arguments.slice(1) : node.arguments });
}

// Does `router.use(paths, ...)` run for a request to `routePath`? A prefix
// match, with parameters and wildcards matching anything.
function usePathApplies(paths, routePath) {
  if (!paths) return true;
  const target = rules.splitPath(routePath);
  return paths.some((p) => {
    const prefix = rules.splitPath(p);
    return p.includes('*') || (prefix.length <= target.length
      && prefix.every((seg, i) => rules.routeSegmentIsWild(seg) || rules.routeSegmentIsWild(target[i]) || seg.toLowerCase() === target[i].toLowerCase()));
  });
}

// The router-level middleware that runs before a route: `use` entries
// declared above it whose path matches, and `param` callbacks for its params.
function middlewareFor(route, uses) {
  const out = [];
  for (const use of uses.filter(u => u.recv === route.recv)) {
    const applies = use.param ? route.path.includes(`:${use.param}`) : use.line < route.line && usePathApplies(use.paths, route.path);
    if (applies) use.mws.forEach(arg => out.push({ arg, info: use.info }));
  }
  return out;
}

// Every GET (or catch-all) registration in a router file, by receiver.
function routerRoutes(file) {
  const info = parseFile(file);
  const routes = [];
  const opaque = [];
  const uses = [];
  walk(info.ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
    const callee = node.callee;
    const method = callee.property.name;
    if (['use', 'param'].includes(method)) collectRouterMiddleware(node, info, uses);
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
  routes.forEach((route) => { route.middleware = middlewareFor(route, uses); });
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
      table.push({ full: joinPath(mount.prefix, route.path), file: path.relative(ROOT, mount.file), line: route.line, route, mountMw: mount.mw, mountLine: mount.line });
    }
    if (opaque.length) opaqueMounts.push(mount.prefix);
  }
  for (const route of inline) {
    table.push({ full: joinPath(route.path, ''), file: 'server/index.js', line: route.line, mountLine: route.line, route: { args: route.args, info: route.info, path: '' } });
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
// What counts as safe WITHOUT following the call into source. Anything else
// that the scan cannot resolve to a function body it has scanned is
// "unresolved", and a route with an unresolved call is excluded unless a
// reviewer's row names that exact callee list (admin-read-reviewed.json).
//   1. Objects whose methods are response, logging or language built-ins.
const SAFE_ROOTS = new Set(['res', 'req', 'logger', 'console', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Object', 'Array',
  'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Buffer', 'Intl', 'RegExp', 'URL', 'URLSearchParams', 'Symbol', 'BigInt', 'path', 'crypto',
  'moment', 'dayjs', 'DateTime', 'luxon', 'uuid']);
//   2. Bare calls: built-in functions, Express next, and the knex handle every
//      service passes around (db, trx and the names it is conventionally given).
const SAFE_BARE = new Set(['next', 'require', 'Number', 'String', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Date', 'Array',
  'Object', 'Set', 'Map', 'Promise', 'Error', 'BigInt', 'Symbol', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'structuredClone', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'moment', 'dayjs', 'uuid',
  'db', 'trx', 'tx', 'knex', 'conn', 'connection', 'database', 'dbh', 'dbOrTrx']);
//   3. Pure data methods on a value (never on a required module or `this`).
const PURE_METHODS = new Set(['map', 'filter', 'reduce', 'reduceRight', 'find', 'findIndex', 'findLast', 'some', 'every', 'forEach', 'flatMap',
  'flat', 'slice', 'concat', 'join', 'includes', 'indexOf', 'lastIndexOf', 'sort', 'toSorted', 'reverse', 'push', 'pop', 'shift', 'unshift',
  'splice', 'fill', 'keys', 'values', 'entries', 'get', 'set', 'has', 'add', 'clear', 'toString', 'toISOString', 'toJSON', 'toFixed',
  'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'toUpperCase', 'toLowerCase', 'localeCompare', 'split', 'trim', 'trimStart',
  'trimEnd', 'replace', 'replaceAll', 'startsWith', 'endsWith', 'match', 'matchAll', 'test', 'exec', 'padStart', 'padEnd', 'charAt',
  'charCodeAt', 'substring', 'substr', 'at', 'repeat', 'normalize', 'then', 'catch', 'finally', 'assign', 'freeze', 'isArray', 'isInteger',
  'from', 'of', 'parse', 'stringify', 'getTime', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
  'getUTCFullYear', 'getUTCMonth', 'getUTCDate', 'getUTCDay', 'getUTCHours', 'getUTCMinutes', 'setDate', 'setHours', 'setMonth', 'setUTCDate',
  'setUTCHours', 'valueOf', 'hasOwnProperty', 'floor', 'ceil', 'round', 'abs', 'max', 'min', 'pow', 'sqrt', 'trunc', 'sign', 'random', 'now',
  'all', 'allSettled', 'race', 'resolve', 'reject', 'fromEntries', 'format', 'subtract', 'startOf', 'endOf', 'diff', 'isBefore', 'isAfter',
  'isSame', 'isValid', 'utc', 'tz', 'unix', 'toDate', 'formatToParts', 'resolvedOptions', 'getTimezoneOffset', 'toLocaleLowerCase',
  'toLocaleUpperCase']);
//   4. Knex query-builder READ methods (writes are flagged on their own).
const DB_READ_METHODS = new Set(['select', 'where', 'whereIn', 'whereNotIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereBetween',
  'whereNotBetween', 'whereExists', 'whereNotExists', 'whereRaw', 'whereLike', 'whereILike', 'orWhere', 'orWhereIn', 'orWhereNotIn',
  'orWhereNull', 'orWhereNotNull', 'orWhereRaw', 'orWhereNot', 'andWhere', 'andWhereRaw', 'andWhereNot', 'having', 'havingRaw', 'join',
  'leftJoin', 'rightJoin', 'innerJoin', 'crossJoin', 'leftOuterJoin', 'fullOuterJoin', 'joinRaw', 'groupBy', 'groupByRaw', 'orderBy',
  'orderByRaw', 'limit', 'offset', 'first', 'count', 'countDistinct', 'sum', 'avg', 'min', 'max', 'pluck', 'distinct', 'as', 'from', 'table',
  'column', 'columns', 'columnInfo', 'hasTable', 'hasColumn', 'schema', 'withSchema', 'modify', 'clone', 'with', 'withRecursive', 'union',
  'unionAll', 'clearSelect', 'clearOrder', 'clearWhere', 'clearGroup', 'clearHaving', 'raw', 'fn', 'toSQL']);
const DB_WHERE_RE = /^(or|and)?[Ww]here(Not)?[A-Z][A-Za-z]*$/; // whereLike, orWhereExists, andWhereNotNull ...
//   5. Constructors of language built-ins.
const SAFE_NEW = new Set(['Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'RegExp', 'URL',
  'URLSearchParams', 'Array', 'Object', 'Promise', 'Intl', 'Buffer', 'AbortController', 'Number', 'String']);
//   6. The knex handle itself, named as services conventionally name it. A READ
//      method on it is safe; `this` inside a knex `.where(function () {...})`
//      callback is the builder, so READ methods on `this` are too.
const KNEX_HANDLES = new Set(['db', 'trx', 'tx', 'knex', 'conn', 'connection', 'database', 'dbh', 'dbOrTrx', 'this']);
// Auth guards: the loopback read must pass them exactly as the screen does,
// so they cannot be left out of a route. Each was read:
//   adminAuthenticate  server/middleware/admin-auth.js:40  (JWT check, technician row read, MFA and scope checks)
//   requireAdmin       server/middleware/admin-auth.js:89  (role check)
//   requireTechOrAdmin server/middleware/admin-auth.js:121 (role check)
//   requireFullAccess  server/services/intelligence-bar/ib-access.js:59 (owner-login check)
const TRUSTED_MIDDLEWARE = new Set(['adminAuthenticate', 'requireAdmin', 'requireTechOrAdmin', 'requireFullAccess']);
// App-level middleware (server/index.js) that runs before an admin router.
// A new entry in index.js that is not listed here makes every route unresolved.
// Read, with file:line:
//   inline helmet selector     server/index.js:216  (picks a helmet header set by path)
//   staffMaintenance           server/middleware/staff-maintenance.js:135 (env flag check, answers 503 or next)
//   requireStaffTokenForLargeBody server/middleware/large-body-auth.js:54 (header and JWT checks only)
//   express.json() verify hook server/middleware/link-worker-auth.js:75 rawBodyVerify (copies bytes onto req)
// npm library middleware (no application writes): cors() index.js:307, limiter (express-rate-limit, index.js:328),
//   express.json() / express.urlencoded() / express.static() (index.js:637,677,678,683), morgan() (index.js:697, logs to logger).
const TRUSTED_APP_MIDDLEWARE = new Set(['inline:helmet-selector', 'staffMaintenance', 'requireStaffTokenForLargeBody', 'cors()',
  'limiter', 'express.json()', 'express.urlencoded()', 'express.static()', 'morgan()']);
// A helper that mints a link carrying its own credential (an S3 presigned
// URL and friends). Found in getSignedUrl (@aws-sdk/s3-request-presigner),
// signedViewUrl, signedUrl, presignUpload, stopPhotoViewUrls, getViewUrl,
// getEvidenceUrl. A route that reaches one is never in the catalog.
// A helper that builds a customer-facing link carrying an access token (pay,
// estimate, portal, report, review, unsubscribe, booking, statement, tracking
// and share links; see payUrl, portalUrl, reviewUrl, reportUrl, unsubscribeUrl,
// trackUrl, receiptUrl, mintEstimateLink, createTrackedShortLink, ...), or one
// that mints a token. A route that calls one is never in the catalog.
const LINK_BUILDER_RE = /(pay|portal|estimate|unsubscribe|review|report|invoice|booking|receipt|statement|proposal|reset|magic|short|track|tracking|share|public|capture|consultation|accept|handoff)[A-Za-z]*(url|link|token)s?$/i;
const MINT_RE = /^(mint|generate|create|issue|sign|make)[A-Za-z]*(token|link)s?$/i;
const COLUMN_TEXT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_*][A-Za-z0-9_]*)*(\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?$/i;
const SIGNING_RE = /(signed(url|link|view|photo|read|get)|presign|view_?urls?$|evidence_?url|sign_?(url|link)|temporary_?url|download_?url)/i;
const SQL_WRITE_RE = /\b(insert\s+into|update\s+\w|delete\s+from|truncate|alter\s+table|drop\s+table|create\s+table|create\s+index|nextval|setval|pg_advisory|for\s+update|on\s+conflict|refresh\s+materialized)\b/i;
const RESPONSE_BINARY = new Set(['sendFile', 'download', 'redirect', 'write', 'pipe', 'attachment', 'cookie', 'clearCookie', 'sendStatus', 'type', 'format']);
const JSON_RESPONSE = new Set(['json', 'send', 'jsonp']);

// Files whose functions the scan read (review aid).
const touchedFiles = new Set();
// The text of every function body the scan followed for the current route
// (the handler, its middleware, every callee and named callback). A reviewed
// row stores a hash of these, so any edit to the chain drops the row.
const followedSources = new Set();

// Where each signal was first seen (review aid for --explain).
const origins = new Map();
function flag(signals, signal, info, node) {
  signals.add(signal);
  if (!origins.has(signal)) origins.set(signal, `${path.relative(ROOT, info.file)}:${node.loc?.start.line}`);
}

// Service calls the scan could not follow into source. Fail closed: a route
// with any of these is excluded unless a reviewer allowed exactly this list.
const unresolvedCalls = new Set();
function noteUnresolved(info, label) {
  unresolvedCalls.add(`${path.relative(ROOT, info.file).replace(/^server\//, '')}#${label}`);
}

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

// Names a function declares inside its own body: calls to them run code the
// walk below already reads in place.
function nestedFunctionNames(fn) {
  const names = new Set();
  walk(fn.body || fn, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) names.add(node.id.name);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && isFunction(node.init)) names.add(node.id.name);
  });
  return names;
}

function analyze(fn, info, depth, seen = new Set()) {
  const signals = new Set();
  if (!fn || seen.has(fn)) return signals;
  seen.add(fn);
  touchedFiles.add(path.relative(ROOT, info.file));
  followedSources.add(`${path.relative(ROOT, info.file)}\n${info.source.slice(fn.start, fn.end)}`);
  const ctx = { info, depth, seen, signals, sawResponse: false, nested: nestedFunctionNames(fn) };
  walk(fn.body || fn, (node, parent) => visitNode(node, parent, ctx));
  if (!ctx.sawResponse && depth === 0) flag(signals, 'no_json_response', info, fn);
  return signals;
}

function visitNode(node, parent, ctx) {
  const { info, signals } = ctx;
  if (node.type === 'Identifier' && OUTSIDE_IDENTIFIERS.has(node.name) && !isPropertyName(node, parent)) flag(signals, `outside:${node.name}`, info, node);
  if (node.type === 'Identifier' && node.name === 'GetObjectCommand') flag(signals, 'signed_url:GetObjectCommand', info, node);
  if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && node.left.object.name === 'process') flag(signals, 'writes_process_state', info, node);
  inspectCredentialName(node, parent, ctx);
  inspectTableChain(node, parent, ctx);
  if (node.type === 'NewExpression') { inspectNew(node, ctx); return; }
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
  if (node.callee.type === 'Import') { noteUnresolved(info, 'import()'); return; }
  const { name, receiver } = calleeName(node.callee);
  if (name === 'require') return;
  if (isResponseCall(node, receiver)) { inspectResponseCall(node, name, ctx); return; }
  inspectWriteCall(node, name, receiver, info, signals);
  if (SIGNING_RE.test(name)) flag(signals, `signed_url:${name}`, info, node);
  if (name && (LINK_BUILDER_RE.test(name) || MINT_RE.test(name) || isCredentialName(name))) flag(signals, `credential_link:${name}`, info, node);
  inspectCallbacks(node, name, ctx);
  inspectCallee(node, name, receiver, ctx);
}

// A credential column or property named in the code: a select list entry
// ('estimates.token', 'token as t'), an object key or shorthand in what is
// built for the response, a `.token` read, or a word in a raw SQL string.
// Reads of the request itself (req.headers.authorization) are not response data.
function inspectCredentialName(node, parent, ctx) {
  const { info, signals } = ctx;
  let text = null;
  if (node.type === 'StringLiteral' && COLUMN_TEXT_RE.test(node.value)) text = node.value;
  if ((node.type === 'ObjectProperty' || node.type === 'ObjectMethod') && !node.computed) text = node.key?.name || node.key?.value || null;
  if (node.type === 'MemberExpression' && !node.computed && node.object.name !== 'req' && node.property.name) text = node.property.name;
  if (text && isCredentialName(text)) flag(signals, `credential_field:${String(text).slice(0, 40)}`, info, node);
  if (node.type === 'CallExpression' && RAW_QUERY_METHODS.has(calleeName(node.callee).name) && node.arguments[0]
    && sourceOf(info, node.arguments[0]).split(/[^A-Za-z0-9_]+/).some(word => word && isCredentialName(word))) {
    flag(signals, 'credential_field:raw_sql', info, node);
  }
  inspectSqlText(node, info, signals);
}

const SQL_TEXT_RE = /\b(insert\s+into|delete\s+from|truncate\s+table|alter\s+table|drop\s+(table|index|column)|create\s+(or\s+replace\s+)?(unique\s+)?(table|index|view|function|extension|trigger)|update\s+[a-z_."]+\s+set\b|on\s+conflict|refresh\s+materialized)/i;
const SQL_WHOLE_ROW_RE = /select\s+(distinct\s+)?([a-z_]+\.)?\*|,\s*[a-z_]+\.\*/i;

// Any SQL written out in a string (even one passed through a variable): a
// write statement, or a whole-row select from a table with a credential column.
function inspectSqlText(node, info, signals) {
  if (node.type !== 'StringLiteral' && node.type !== 'TemplateLiteral') return;
  const text = node.type === 'StringLiteral' ? node.value : node.quasis.map(q => q.value.cooked).join(' ');
  if (text.length < 12) return;
  if (SQL_TEXT_RE.test(text)) flag(signals, 'write:sql_text', info, node);
  if (!SQL_WHOLE_ROW_RE.test(text)) return;
  const table = [...text.matchAll(/\b(?:from|join)\s+"?([a-z_][a-z0-9_]*)"?/gi)].map(m => m[1]).find(name => credentialTables().has(name));
  if (table) flag(signals, `credential_table:${table}`, info, node);
}

// ── tables that hold a credential column ────────────────────────────────

const MIGRATIONS_DIR = path.join(ROOT, 'server/models/migrations');
let credentialTableCache = null;

// table -> credential column names, from the migrations: knex column
// definitions after a createTable/alterTable/table call, and
// `ALTER TABLE x ADD COLUMN y` in raw SQL.
function credentialTables() {
  if (credentialTableCache) return credentialTableCache;
  credentialTableCache = new Map();
  const add = (table, column) => {
    if (!isStrongCredentialName(column)) return;
    if (!credentialTableCache.has(table)) credentialTableCache.set(table, new Set());
    credentialTableCache.get(table).add(column);
  };
  const tableRe = /\b(?:createTable(?:IfNotExists)?|alterTable|table)\(\s*['"`]([a-z0-9_]+)['"`]/g;
  const columnRe = /\.(?:string|text|uuid|binary|specificType|jsonb?)\(\s*['"`]([a-z0-9_]+)['"`]/g;
  const sqlRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi;
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const tables = [...text.matchAll(tableRe)].map(m => ({ at: m.index, name: m[1] }));
    for (const m of text.matchAll(columnRe)) {
      const owner = [...tables].reverse().find(t => t.at < m.index);
      if (owner) add(owner.name, m[1]);
    }
    for (const m of text.matchAll(sqlRe)) add(m[1], m[2]);
  }
  return credentialTableCache;
}

const JOIN_METHODS = new Set(['join', 'leftJoin', 'rightJoin', 'innerJoin', 'crossJoin', 'fullOuterJoin', 'leftOuterJoin', 'from', 'table']);
const AGGREGATES = new Set(['count', 'countDistinct', 'sum', 'avg', 'min', 'max']);
const PROJECTIONS = new Set(['select', 'first', 'pluck', 'column', 'columns', 'distinct']);
const WRITES_IN_CHAIN = new Set(['insert', 'update', 'del', 'delete']);

function tableOf(arg) {
  const text = stringOf(arg);
  return text ? text.trim().split(/\s+/)[0].replace(/^"|"$/g, '') : null;
}

// The calls of a query-builder chain from its outermost call down to the
// `db('table')` root, or null when the chain does not start at a knex handle.
function queryChain(node) {
  const calls = [];
  let cur = node;
  while (cur?.type === 'CallExpression' && cur.callee.type === 'MemberExpression') {
    calls.push({ method: cur.callee.property.name, args: cur.arguments });
    cur = cur.callee.object;
  }
  const rooted = cur?.type === 'CallExpression' && cur.callee.type === 'Identifier' && KNEX_HANDLES.has(cur.callee.name);
  return rooted ? { calls, root: tableOf(cur.arguments[0]) } : null;
}

// Does the chain name its columns? An aggregate does; so does a select list
// with no `*` or `alias.*` in it. `.first()` or no select returns whole rows.
function chainProjectsColumns(calls) {
  if (calls.some(call => AGGREGATES.has(call.method))) return true;
  const picks = calls.filter(call => PROJECTIONS.has(call.method) && call.args.length);
  const wild = arg => /(^|\.)\*$/.test(stringOf(arg) || '');
  return picks.length > 0 && picks.every(call => !call.args.some(wild));
}

// A read of whole rows from a table that has a credential column.
function inspectTableChain(node, parent, ctx) {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
  if (parent?.type === 'MemberExpression' && parent.object === node) return; // not the top of the chain
  const chain = queryChain(node);
  if (!chain || chain.calls.some(call => WRITES_IN_CHAIN.has(call.method)) || chainProjectsColumns(chain.calls)) return;
  const tables = [chain.root, ...chain.calls.filter(call => JOIN_METHODS.has(call.method)).map(call => tableOf(call.args[0]))].filter(Boolean);
  const hit = tables.find(table => credentialTables().has(table));
  if (hit) flag(ctx.signals, `credential_table:${hit}`, ctx.info, node);
}

function inspectNew(node, ctx) {
  const callee = node.callee;
  const name = callee.type === 'Identifier' ? callee.name : callee.object?.name;
  if (!SAFE_NEW.has(name) && !/Error$/.test(name || '')) noteUnresolved(ctx.info, `new ${name || '<dynamic>'}`);
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
    if (target?.external && /presigner/.test(target.external)) flag(signals, `signed_url:${target.external}`, info, node);
    if (target?.file && OUTSIDE_PATH_RE.test(path.relative(ROOT, target.file))) {
      flag(signals, `outside_service:${path.relative(ROOT, target.file).replace(/^server\/(services\/)?/, '').replace(/\.js$/, '')}`, info, node);
    }
  }
}

// Safe without source: see the SAFE_* sets above. A method on a required
// module or on `this` is a service call and must resolve to scanned source.
function triviallySafe(node, name, receiver, ctx) {
  const callee = node.callee;
  if (isFunction(callee)) return true;
  if (callee.type === 'Identifier') return SAFE_BARE.has(name) || ctx.nested.has(name);
  if (!name) return false;
  if (SAFE_ROOTS.has(receiver)) return true;
  const direct = callee.object?.type === 'Identifier' ? callee.object.name : null;
  if (KNEX_HANDLES.has(direct) && (DB_READ_METHODS.has(name) || DB_WHERE_RE.test(name))) return true;
  if (direct === 'this' || (direct && lookupRequire(ctx.info, direct))) return false;
  return PURE_METHODS.has(name) || DB_READ_METHODS.has(name) || DB_WHERE_RE.test(name);
}

// Only a bare function or a method called directly on a required module (or
// `this`) can be a service action; the verb it starts with says whether it acts.
function isServiceEffect(node, name, receiver, required) {
  const bare = node.callee.type === 'Identifier';
  const service = bare ? !SAFE_BARE.has(name) : (Boolean(required) || receiver === 'this') && !SAFE_ROOTS.has(receiver);
  return service && (EFFECT_WORDS.has(firstWord(name)) || EFFECT_ANYWHERE_RE.test(name));
}

// `require('./x').fn(...)`: the module is named on the call itself.
function inlineRequire(callee, info) {
  if (callee.type !== 'MemberExpression' || callee.object.type !== 'CallExpression') return null;
  return requireTarget(callee.object, info.file);
}

// A named function passed as an argument runs as part of the call
// (rows.map(markSeen), p.then(save), modify(scopeFn), withRetry(load)). Resolve
// it and scan it. For the array/promise/builder methods that always call their
// argument, one that cannot be resolved is an unresolved callee.
const CALLBACK_METHODS = new Set(['map', 'forEach', 'filter', 'reduce', 'reduceRight', 'find', 'findIndex', 'findLast', 'findLastIndex',
  'some', 'every', 'flatMap', 'sort', 'toSorted', 'then', 'catch', 'finally', 'modify', 'tap', 'each']);
const SAFE_CALLBACKS = new Set(['Boolean', 'Number', 'String', 'parseInt', 'parseFloat', 'Object', 'Array', 'BigInt', 'Symbol', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'Date', 'next', 'undefined']);

function callbackTarget(arg, info) {
  if (arg.type === 'Identifier') {
    return { label: arg.name, builtin: SAFE_CALLBACKS.has(arg.name), next: info.functions.has(arg.name) ? { fn: info.functions.get(arg.name), info } : resolveImported(arg.name, null, info) };
  }
  if (arg.type === 'MemberExpression' && !arg.computed && arg.object.type === 'Identifier' && arg.property.type === 'Identifier') {
    return { label: `${arg.object.name}.${arg.property.name}`, builtin: SAFE_ROOTS.has(arg.object.name), next: resolveImported(arg.property.name, arg.object.name, info) };
  }
  return null;
}

function inspectCallbacks(node, name, ctx) {
  const { info, depth, seen, signals } = ctx;
  const always = CALLBACK_METHODS.has(name);
  for (const arg of node.arguments) {
    const target = callbackTarget(arg, info);
    if (!target || target.builtin || ctx.nested.has(target.label)) continue;
    if (target.next && depth < ANALYSIS_DEPTH) mergeSignals(signals, analyze(target.next.fn, target.next.info, depth + 1, seen));
    else if (target.next || (always && arg === node.arguments[0])) noteUnresolved(info, `callback ${target.label}${target.next ? ' (depth limit)' : ''}`);
  }
}

function inspectCallee(node, name, receiver, ctx) {
  const { info, depth, seen, signals } = ctx;
  const callee = node.callee;
  const local = callee.type === 'Identifier' ? info.functions.get(name) : null;
  const direct = callee.type === 'Identifier' ? lookupRequire(info, name) : null;
  const required = callee.object?.type === 'Identifier' ? lookupRequire(info, callee.object.name) : inlineRequire(callee, info);
  outsideTargetSignals([required, direct], info, node, signals);
  const next = local ? { fn: local, info } : resolveRequired(required, direct, name);
  if (next && depth < ANALYSIS_DEPTH) mergeSignals(signals, analyze(next.fn, next.info, depth + 1, seen));
  else if (next || !triviallySafe(node, name, receiver, ctx)) noteUnresolved(info, `${receiver && callee.type !== 'Identifier' ? `${receiver}.` : ''}${name || '<dynamic>'}${next ? ' (depth limit)' : ''}`);
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
function argLabel(arg) {
  if (arg.type === 'Identifier') return arg.name;
  if (arg.type === 'MemberExpression') return `${arg.object.name || '<expr>'}.${arg.property.name || '<expr>'}`;
  if (arg.type === 'CallExpression') return `${argLabel(arg.callee)}()`;
  return '<inline>';
}

// Route-level middleware either resolves to scanned source, is a trusted auth
// guard, or counts as an unresolved call.
function routeFunctions(route) {
  const info = route.info;
  const out = [];
  let handlerFound = false;
  route.args.forEach((arg, index) => {
    const last = index === route.args.length - 1;
    const label = argLabel(arg);
    if (!last && TRUSTED_MIDDLEWARE.has(label)) return;
    const resolved = resolveArg(arg, info);
    if (resolved) { out.push(resolved); if (last) handlerFound = true; } else if (!last) noteUnresolved(info, `middleware ${label}`);
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
  const target = lookupRequire(info, receiver || name);
  if (!target?.file) return null;
  const found = exportedFunction(target.file, receiver ? name : (target.member || 'default'));
  return found ? { fn: found.fn, info: found.info } : null;
}

// ── route safety ─────────────────────────────────────────────────────────

function routeKey(full) {
  return `GET ${rules.splitPath(full).map(s => (rules.isParam(s) ? ':param' : s)).map(s => `/${s}`).join('')}`;
}

function loadReviewed() {
  const raw = JSON.parse(fs.readFileSync(REVIEWED_FILE, 'utf8'));
  return {
    exclude: new Map((raw.exclude || []).map(row => [row.route, row.reason])),
    reviewed: new Map((raw.reviewed || []).map(row => [routeKey(row.endpoint), row])),
  };
}

// ── middleware that runs before a route ──────────────────────────────────

function middlewareLabel(arg) {
  if (isFunction(arg)) return 'inline';
  return argLabel(arg);
}

// The functions of every middleware that applies to the route, in the order it
// runs: app-level (index.js, above the mount), the mount's own, and the router's
// `use` / `param` entries. A middleware that does not resolve to scanned
// source, and is not a trusted auth guard, counts as an unresolved call.
function middlewareFunctions(entry) {
  const list = [...appLevelMiddleware(entry.mountLine ?? 0), ...(entry.mountMw || []), ...(entry.route.middleware || [])];
  const out = [];
  for (const { arg, info } of list) {
    const label = middlewareLabel(arg);
    if (TRUSTED_MIDDLEWARE.has(label)) continue;
    const resolved = resolveArg(arg, info);
    if (resolved) out.push(resolved); else noteUnresolved(info, `middleware ${label}`);
  }
  return out;
}

// Forget parsed files (a test rewrites a fixture and judges it again).
function resetCaches() {
  parsed.clear();
}

let appLevelCache = null;
// app.use(...) entries in server/index.js above `beforeLine` that run for
// /api/admin requests and are not routers. Trusted ones are filtered out here;
// the rest come back to be scanned (and fail closed when they do not resolve).
function appLevelMiddleware(beforeLine = Infinity, all = false) {
  if (!appLevelCache) {
    const info = parseFile(path.join(ROOT, 'server/index.js'));
    appLevelCache = [];
    walk(info.ast, (node) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.object.name !== 'app' || node.callee.property.name !== 'use') return;
      const first = node.arguments[0];
      const prefix = stringOf(first);
      const everywhere = !first || prefix === null || ['/api', '/api/', '/api/admin'].includes(prefix);
      if (!everywhere || (prefix === null && first?.type === 'ArrayExpression')) return;
      node.arguments.slice(prefix === null && !isFunction(first) && first?.type === 'Identifier' && /Prefix$/.test(first.name) ? 1 : (prefix ? 1 : 0))
        .filter(arg => !mountTarget(arg, info)).forEach(arg => appLevelCache.push({ arg, info, line: node.loc.start.line }));
    });
  }
  return appLevelCache.filter(item => item.line < beforeLine && (all || !TRUSTED_APP_MIDDLEWARE.has(appLabel(item))));
}

function appLabel({ arg, info }) {
  if (isFunction(arg)) return sourceOf(info, arg).includes('embedHelmet') && sourceOf(info, arg).includes('strictHelmet') ? 'inline:helmet-selector' : 'inline';
  return argLabel(arg);
}

// The scan is a second lock: whatever a reviewer wrote, a route whose chain
// writes, calls out, runs DDL, mints a link or token, touches a credential or
// answers with a file stays out.
const HARD_SIGNAL_RE = /^(write:|outside|signed_url|credential_|response:|writes_process_state|no_json_response)/;

function chainHash() {
  return crypto.createHash('sha256').update([...followedSources].sort().join('\n=====\n')).digest('hex').slice(0, 32);
}

function judgeRoute(entry, reviewed, opaqueMounts) {
  const key = routeKey(entry.full);
  const ruled = rules.denyReason(entry.full);
  if (ruled) return { safe: false, kind: 'rule', reason: ruled };
  if (reviewed.exclude.has(key)) return { safe: false, kind: 'review', reason: reviewed.exclude.get(key) };
  if (opaqueMounts.some(prefix => entry.full === prefix || entry.full.startsWith(`${prefix}/`))) {
    return { safe: false, kind: 'review', reason: 'router has a catch-all or dynamic route' };
  }
  unresolvedCalls.clear();
  touchedFiles.clear();
  followedSources.clear();
  const { functions, handlerFound } = routeFunctions(entry.route);
  if (!functions.length || !handlerFound) return { safe: false, kind: 'review', reason: 'handler_not_found' };
  const middleware = middlewareFunctions(entry);
  const signals = new Set();
  // Only the handler must answer with JSON; middleware may call next().
  const handler = functions[functions.length - 1];
  [...functions, ...middleware].forEach((item) => {
    analyze(item.fn, item.info, 0).forEach((signal) => { if (item === handler || signal !== 'no_json_response') signals.add(signal); });
  });
  const scan = { signals: [...signals].sort(), unresolved: [...unresolvedCalls].sort(), touched: [...touchedFiles].sort(), hash: chainHash() };
  const hard = scan.signals.filter(signal => HARD_SIGNAL_RE.test(signal));
  if (hard.length) return { safe: false, kind: 'review', reason: `scan: ${hard.join(', ')}`, ...scan };
  return { safe: true, ...scan };
}

// What a reviewer signs off on, for one endpoint: the union of its routes'
// signals and unresolved callees, and one hash over every route's chain.
function endpointFingerprint(verdicts) {
  const union = key => [...new Set(verdicts.flatMap(verdict => verdict[key] || []))].sort();
  const hashes = verdicts.map(verdict => verdict.hash).filter(Boolean).sort();
  return { signals: union('signals'), unresolved: union('unresolved'), hash: crypto.createHash('sha256').update(hashes.join('\n')).digest('hex').slice(0, 32) };
}

// null when the row covers exactly this fingerprint, else why not.
function checkReview(fingerprint, row) {
  if (!row) return 'not reviewed';
  const same = (a, b) => Array.isArray(a) && a.join('\n') === b.join('\n');
  if (row.hash !== fingerprint.hash) return 'review is stale: the handler chain changed';
  if (!same(row.signals, fingerprint.signals)) return 'review is stale: scan signals changed';
  if (!same(row.unresolved, fingerprint.unresolved)) return 'review is stale: unresolved callees changed';
  return null;
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

function buildCatalog({ census, reviewed = loadReviewed() } = {}) {
  const source = census || JSON.parse(fs.readFileSync(CENSUS_FILE, 'utf8'));
  const { table, opaqueMounts } = routeTable();
  const judged = new Map();
  const judgeOnce = (entry) => {
    if (!judged.has(entry)) judged.set(entry, judgeRoute(entry, reviewed, opaqueMounts));
    return judged.get(entry);
  };
  const { groups, skipped } = censusGets(source);
  const entries = [];
  const excluded = { rule: [], review: [], unresolvable: [...skipped.partial_template].sort() };
  const reviewAid = [];
  const admittedRoutes = [];
  for (const [endpoint, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ruled = rules.denyReason(endpoint);
    if (ruled) { excluded.rule.push({ endpoint, reason: ruled }); continue; }
    const segments = rules.splitPath(endpoint);
    const matches = matchRoutes(segments, table);
    if (!matches.length) { excluded.review.push({ endpoint, reason: 'no_backend_route' }); continue; }
    const verdicts = matches.map(match => ({ match, verdict: judgeOnce(match) }));
    const bad = verdicts.find(({ verdict }) => !verdict.safe);
    if (bad) { excluded[bad.verdict.kind === 'rule' ? 'rule' : 'review'].push({ endpoint, reason: bad.verdict.reason }); continue; }
    // Admission is by reviewed row only: the scan above is a second lock.
    const fingerprint = endpointFingerprint(verdicts.map(({ verdict }) => verdict));
    const notAdmitted = checkReview(fingerprint, reviewed.reviewed.get(routeKey(endpoint)));
    if (notAdmitted) { excluded.review.push({ endpoint, reason: notAdmitted, fingerprint }); continue; }
    admittedRoutes.push(...matches);
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
  const admitted = new Set(admittedRoutes);
  const blockedRoutes = blockedFor(table, catalog, entry => admitted.has(entry));
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
function blockedFor(table, catalog, isAdmitted) {
  const blocked = new Set();
  for (const entry of table) {
    if (isAdmitted(entry)) continue;
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
  if (process.argv.includes('--fingerprint')) {
    const { table, opaqueMounts } = routeTable();
    const reviewed = loadReviewed();
    for (const endpoint of process.argv.slice(process.argv.indexOf('--fingerprint') + 1)) {
      const normalized = `/${rules.splitPath(endpoint).map(seg => (rules.isParam(seg) ? ':param' : seg)).join('/')}`;
      const verdicts = matchRoutes(rules.splitPath(normalized), table).map(match => judgeRoute(match, reviewed, opaqueMounts));
      const hard = verdicts.filter(v => !v.safe).map(v => v.reason);
      console.log(JSON.stringify({ endpoint, routes: verdicts.length, scanBlocked: hard, ...endpointFingerprint(verdicts) }));
    }
    return;
  }
  if (process.argv.includes('--explain')) {
    const wanted = process.argv[process.argv.indexOf('--explain') + 1];
    const { table, opaqueMounts } = routeTable();
    const exclusions = loadReviewed();
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
module.exports = { resetCaches, appLevelMiddleware, appLabel, origins, touchedFiles, buildCatalog, serialize, routeTable, routerRoutes, judgeRoute, endpointFingerprint, checkReview, routeKey, loadReviewed, CENSUS_FILE, OUT_FILE, REVIEWED_FILE };
