/**
 * Source guard (address-match PR 7): every production call of
 * performPropertyLookup in server/ passes through lookupOptionsFor(), so the
 * commercial-suite scope decision (opt-in or not) is declared ONCE, in
 * lookup-callers.js, and a new caller cannot slip in with an undeclared
 * decision. Direct callers of lookupPropertyFromAITrio are held to the same
 * registry (TRIO_CALLERS).
 *
 * The scan walks each file's syntax tree (acorn, already a dependency), not
 * its source lines: a call is a CallExpression whose callee resolves to the
 * lookup by any route (a local alias, a destructured rename, a module object
 * member in dot or bracket form, an optional call, a `(0, m.fn)()` sequence,
 * `.call/.apply/.bind`), wherever its parenthesis falls. Passing the lookup
 * around as a value is refused outright (it could be called anywhere), as is
 * a file acorn cannot parse. Filesystem only, no DB.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const { CALLERS, TRIO_CALLERS, lookupOptionsFor } = require('../services/property-lookup/lookup-callers');

const SERVER_ROOT = path.join(__dirname, '..');
// The whole production tree under server/ (not an allow-list of folders): a
// caller added under middleware/, utils/, models/ or anywhere else is held
// to the registry too.
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'migrations', 'coverage', 'dist', 'fixtures']);

function walkDir(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walkDir(path.join(dir, entry.name), out); continue; }
    if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out;
}
const rel = (f) => path.relative(SERVER_ROOT, f).split(path.sep).join('/');

const LOOKUP = 'performPropertyLookup';
const TRIO = 'lookupPropertyFromAITrio';
const HELPER = 'lookupOptionsFor';
const OPTION = 'commercialSuiteSizing';
// Where each function is defined — the only module allowed to export it.
const DEFINING = { [LOOKUP]: 'routes/property-lookup-v2.js', [TRIO]: 'services/property-lookup/ai-property-lookup.js' };
// The one module whose lookupOptionsFor is the policy helper. A call to any
// other function of that name (a local, a member of some other object) is
// refused: the id it carries proves nothing.
const REGISTRY = 'services/property-lookup/lookup-callers.js';
const REGISTRY_ABS = path.join(SERVER_ROOT, REGISTRY).replace(/\.js$/, '');
const requiredPath = (node, fromFile) => { // the module a require('<literal>') / import '<literal>' names, resolved
  const lit = node && node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require'
    && node.arguments[0] && node.arguments[0].type === 'Literal' ? node.arguments[0].value
    : node && node.type === 'Literal' ? node.value : null;
  if (typeof lit !== 'string' || !lit.startsWith('.')) return null;
  return path.resolve(path.dirname(fromFile), lit).replace(/\.(js|cjs|mjs)$/, '');
};

// Only a file that spells one of the names can call, alias, import,
// re-export or override anything this guard tracks (a computed member built
// from string pieces is not resolvable by any static scan). So the parse
// is limited to those files: the whole tree is read, ~1% of it is parsed.
const NAMES = new RegExp([LOOKUP, TRIO, HELPER, OPTION, 'CALLERS'].join('|'));
const files = walkDir(SERVER_ROOT).filter((f) => NAMES.test(fs.readFileSync(f, 'utf8')));

// The one sanctioned place the scope decision is changed after the registry
// answered: the admin route turning the leg OFF for a whole-property job.
const SANCTIONED_OVERRIDE = { file: 'routes/property-lookup-v2.js', object: 'callerOptions', guard: 'wholeProperty' };

// The modules that define or read `commercialSuiteSizing`. A new file under
// services/property-lookup/ is NOT one of them until it is listed here.
const OPTION_OWNERS = new Set([
  'routes/property-lookup-v2.js', // defines the lookup; the sanctioned switch-off (checked node by node below)
  'services/property-lookup/lookup-callers.js', // the registry sets it
  'services/property-lookup/ai-property-lookup.js', // the lookup reads it
  'config/feature-gates.js', // the gate reader's doc comment
]);

// ---------------------------------------------------------------------------
// Parsing

function parse(src, file) {
  const comments = [];
  const base = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true, onComment: comments };
  const order = file.endsWith('.mjs') ? ['module', 'script'] : ['script', 'module'];
  let lastErr;
  for (const sourceType of order) {
    comments.length = 0;
    try { return { ast: acorn.parse(src, { ...base, sourceType }), comments }; } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Source text with every comment blanked (same length, so line numbers
// hold), built in one pass over the comment ranges.
function withoutComments(src, comments) {
  const parts = [];
  let at = 0;
  for (const c of [...comments].sort((a, b) => a.start - b.start)) {
    parts.push(src.slice(at, c.start), src.slice(c.start, c.end).replace(/[^\n]/g, ' '));
    at = c.end;
  }
  parts.push(src.slice(at));
  return parts.join('');
}

// The static name a member access reads: `.name`, `['name']`, `[`name`]`.
function memberName(node) {
  if (node.type !== 'MemberExpression') return null;
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const p = node.property;
  if (p.type === 'Literal' && typeof p.value === 'string') return p.value;
  if (p.type === 'TemplateLiteral' && p.expressions.length === 0) return p.quasis[0].value.cooked;
  return null;
}

// Does this expression evaluate to `target` (by name) — directly, through a
// local alias, a member read, `a || b`, `c ? a : b`, `(0, a)`, `a?.b`?
function refersTo(node, target, aliases) {
  if (!node) return false;
  switch (node.type) {
    case 'Identifier': return aliases.has(node.name);
    case 'MemberExpression': return memberName(node) === target;
    case 'ChainExpression': return refersTo(node.expression, target, aliases);
    case 'LogicalExpression': return refersTo(node.left, target, aliases) || refersTo(node.right, target, aliases);
    case 'ConditionalExpression': return refersTo(node.consequent, target, aliases) || refersTo(node.alternate, target, aliases);
    case 'SequenceExpression': return refersTo(node.expressions[node.expressions.length - 1], target, aliases);
    case 'AwaitExpression': return refersTo(node.argument, target, aliases);
    default: return false;
  }
}

// Every local binding that may hold `target`: the name itself, `const x =
// <expr that refers to it>`, `const { target: x } = ...`, `import { target as x }`.
// Iterated to a fixpoint so an alias of an alias is found too.
function aliasesOf(ast, target) {
  const aliases = new Set([target]);
  for (let pass = 0; pass < 4; pass++) {
    const before = aliases.size;
    walk.simple(ast, {
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && refersTo(node.init, target, aliases)) aliases.add(node.id.name);
        if (node.id.type === 'ObjectPattern') {
          for (const prop of node.id.properties) {
            if (prop.type !== 'Property') continue;
            const key = prop.computed ? (prop.key.type === 'Literal' ? prop.key.value : null) : prop.key.name;
            if (key !== target) continue;
            const v = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
            if (v.type === 'Identifier') aliases.add(v.name);
          }
        }
      },
      AssignmentExpression(node) {
        if (node.left.type === 'Identifier' && refersTo(node.right, target, aliases)) aliases.add(node.left.name);
        // `({ performPropertyLookup: lookup } = require(...))`
        if (node.left.type === 'ObjectPattern') {
          for (const prop of node.left.properties) {
            if (prop.type !== 'Property') continue;
            const key = prop.computed ? (prop.key.type === 'Literal' ? prop.key.value : null) : prop.key.name;
            if (key !== target) continue;
            const v = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
            if (v.type === 'Identifier') aliases.add(v.name);
          }
        }
      },
      ImportDeclaration(node) {
        for (const s of node.specifiers) {
          if (s.type === 'ImportSpecifier' && (s.imported.name || s.imported.value) === target) aliases.add(s.local.name);
        }
      },
    });
    if (aliases.size === before) break;
  }
  return aliases;
}

const isExportContext = (ancestors) => ancestors.some((a) => a.type === 'AssignmentExpression'
  && /^(module\.)?exports\b/.test(sourceOf(a.left)));
// Is this reference the function exported UNDER ITS OWN NAME:
// `module.exports = { performPropertyLookup }` / `{ performPropertyLookup: x }`
// or `module.exports.performPropertyLookup = x` / `exports.performPropertyLookup = x`?
// Any other export shape (`module.exports.lookup = performPropertyLookup`,
// `module.exports = performPropertyLookup`) is an alias a consumer could
// require under a name this guard never sees.
function exportedUnderOwnName(node, ancestors, target) {
  const parent = ancestors[ancestors.length - 2];
  const grand = ancestors[ancestors.length - 3];
  const great = ancestors[ancestors.length - 4];
  const isExportsTarget = (left) => left && left.type === 'MemberExpression' && /^(module\.)?exports$/.test(sourceOf(left.object)) && memberName(left) === target;
  const isModuleExports = (left) => left && /^(module\.exports|exports)$/.test(sourceOf(left));
  if (parent && parent.type === 'Property' && parent.value === node && !parent.computed && parent.key.type === 'Identifier' && parent.key.name === target
    && grand && grand.type === 'ObjectExpression' && great && great.type === 'AssignmentExpression' && great.right === grand && isModuleExports(great.left)) return true;
  if (parent && parent.type === 'AssignmentExpression' && parent.right === node && isExportsTarget(parent.left)) return true;
  return false;
}
let currentSrc = '';
const sourceOf = (node) => currentSrc.slice(node.start, node.end);

/**
 * Everything the guards need from one file, from its syntax tree:
 *   calls[target]   every invocation of the lookup / trio: line, how it was
 *                   invoked, and (for the lookup) its options argument node
 *   valueRefs       the lookup / trio used as a value (not called, not an
 *                   alias binding, not exported) — refused outright
 *   helperCalls     every lookupOptionsFor(...) call with its first argument
 *   helperRefs      lookupOptionsFor used as a value (aliased / passed)
 *   optionVars      identifiers bound to a lookupOptionsFor(...) call
 *   overrides       assignments to a member named commercialSuiteSizing
 *   mentions        lines (comments blanked) that spell commercialSuiteSizing
 *   policyWrites    assignments to a registry policy field
 */
function analyze(file) {
  const r = rel(file);
  const src = fs.readFileSync(file, 'utf8');
  const { ast, comments } = parse(src, r);
  currentSrc = src;
  const aliases = { [LOOKUP]: aliasesOf(ast, LOOKUP), [TRIO]: aliasesOf(ast, TRIO) };
  const out = { file: r, calls: { [LOOKUP]: [], [TRIO]: [] }, valueRefs: [], helperCalls: [], helperRefs: [], badHelper: [], optionVars: new Map(), optionVarMisuse: [], overrides: [], mentions: [], policyWrites: [] };

  // Pass 1: identifiers bound to lookupOptionsFor(...), and every binding
  // (declaration, parameter, pattern, import, catch, class, function) each
  // name has in the file, so a trusted options variable can be required to
  // be a `const` declared exactly once and never assigned: then the one
  // lexical binding that can reach any call is the helper's result.
  const bindings = {};
  const assigned = new Set();
  const bind = (name) => { bindings[name] = (bindings[name] || 0) + 1; };
  const bindPattern = (pat) => {
    if (!pat) return;
    switch (pat.type) {
      case 'Identifier': bind(pat.name); break;
      case 'AssignmentPattern': bindPattern(pat.left); break;
      case 'RestElement': bindPattern(pat.argument); break;
      case 'ArrayPattern': pat.elements.forEach(bindPattern); break;
      case 'ObjectPattern': pat.properties.forEach((pr) => bindPattern(pr.type === 'Property' ? pr.value : pr.argument)); break;
      default: break;
    }
  };
  walk.full(ast, (node) => {
    switch (node.type) {
      case 'VariableDeclaration': node.declarations.forEach((d) => bindPattern(d.id)); break;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        if (node.id) bind(node.id.name); node.params.forEach(bindPattern); break;
      case 'ClassDeclaration': case 'ClassExpression': if (node.id) bind(node.id.name); break;
      case 'CatchClause': bindPattern(node.param); break;
      case 'ImportDeclaration': node.specifiers.forEach((sp) => bind(sp.local.name)); break;
      case 'AssignmentExpression': if (node.left.type === 'Identifier') assigned.add(node.left.name); else bindPatternAssigned(node.left); break;
      case 'UpdateExpression': if (node.argument.type === 'Identifier') assigned.add(node.argument.name); break;
      default: break;
    }
  });
  function bindPatternAssigned(pat) { // `[opts] = ...`, `({ opts } = ...)`
    const names = [];
    const collect = (q) => {
      if (!q) return;
      if (q.type === 'Identifier') names.push(q.name);
      else if (q.type === 'AssignmentPattern') collect(q.left);
      else if (q.type === 'RestElement') collect(q.argument);
      else if (q.type === 'ArrayPattern') q.elements.forEach(collect);
      else if (q.type === 'ObjectPattern') q.properties.forEach((pr) => collect(pr.type === 'Property' ? pr.value : pr.argument));
    };
    collect(pat);
    names.forEach((n) => assigned.add(n));
  }
  // The canonical helper bindings in this file: `const { lookupOptionsFor
  // [: x] } = require('<registry>')`, `import { lookupOptionsFor } from
  // '<registry>'`, or a module object `const m = require('<registry>')`
  // used as `m.lookupOptionsFor(...)`. Each must be a binding declared
  // once and never assigned.
  const helperLocals = new Set();
  const helperModules = new Set();
  walk.simple(ast, {
    VariableDeclaration(node) {
      for (const d of node.declarations) {
        if (!d.init || requiredPath(d.init, file) !== REGISTRY_ABS || node.kind !== 'const') continue;
        if (d.id.type === 'Identifier' && bindings[d.id.name] === 1 && !assigned.has(d.id.name)) helperModules.add(d.id.name);
        if (d.id.type === 'ObjectPattern') {
          for (const prop of d.id.properties) {
            if (prop.type !== 'Property') continue;
            const key = prop.computed ? (prop.key.type === 'Literal' ? prop.key.value : null) : prop.key.name;
            const v = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
            if (key === HELPER && v.type === 'Identifier' && bindings[v.name] === 1 && !assigned.has(v.name)) helperLocals.add(v.name);
          }
        }
      }
    },
    ImportDeclaration(node) {
      if (requiredPath(node.source, file) !== REGISTRY_ABS) return;
      for (const sp of node.specifiers) {
        if (sp.type === 'ImportSpecifier' && (sp.imported.name || sp.imported.value) === HELPER && bindings[sp.local.name] === 1 && !assigned.has(sp.local.name)) helperLocals.add(sp.local.name);
        if (sp.type === 'ImportNamespaceSpecifier' && bindings[sp.local.name] === 1 && !assigned.has(sp.local.name)) helperModules.add(sp.local.name);
      }
    },
  });
  // Is this callee the canonical helper? (Anything else NAMED like it is
  // recorded as a bad helper and refused by the id test.)
  function isHelperCallee(callee) {
    if (callee.type === 'Identifier') return helperLocals.has(callee.name);
    if (callee.type === 'MemberExpression' && memberName(callee) === HELPER) {
      if (callee.object.type === 'Identifier') return helperModules.has(callee.object.name);
      return requiredPath(callee.object, file) === REGISTRY_ABS; // require('<registry>').lookupOptionsFor(...)
    }
    return false;
  }
  const looksLikeHelper = (callee) => (callee.type === 'Identifier' && callee.name === HELPER) || memberName(callee) === HELPER;
  // Trusted options variables: `const x = <canonical helper call>`, declared
  // once, never assigned. Mapped to the helper call that produced them.
  walk.simple(ast, {
    VariableDeclaration(node) {
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier' && d.init && d.init.type === 'CallExpression' && isHelperCallee(d.init.callee)
          && node.kind === 'const' && bindings[d.id.name] === 1 && !assigned.has(d.id.name)) out.optionVars.set(d.id.name, d.init);
      }
    },
  });
  // The registry id a helper call carries: its first argument, which must
  // be a single-quoted literal (anything else cannot be bound to a file).
  function helperId(callNode) {
    const arg = callNode.arguments[0];
    const raw = arg ? src.slice(arg.start, arg.end) : '';
    return arg && arg.type === 'Literal' && typeof arg.value === 'string' && /^'[a-z_]+'$/.test(raw) ? arg.value : null;
  }
  function targetOfCallee(callee) {
    for (const t of [LOOKUP, TRIO]) {
      if (refersTo(callee, t, aliases[t])) return { target: t, via: 'direct' };
      // fn.call(thisArg, ...) / fn.apply(...) / fn.bind(...)
      if (callee.type === 'MemberExpression' && ['call', 'apply', 'bind'].includes(memberName(callee)) && refersTo(callee.object, t, aliases[t])) return { target: t, via: memberName(callee) };
    }
    return null;
  }

  // Pass 2: calls, value references, helper uses, overrides.
  walk.ancestor(ast, {
    CallExpression(node, _st, ancestors) {
      const hit = targetOfCallee(node.callee);
      if (hit) {
        const args = node.arguments;
        const optionsArg = hit.via === 'direct' ? args[1] : hit.via === 'call' ? args[2] : null;
        // The helper call that supplies this invocation's options (inline, or
        // through a trusted const), and the registry id it carries.
        const helperCall = optionsArg && optionsArg.type === 'CallExpression' && isHelperCallee(optionsArg.callee) ? optionsArg
          : optionsArg && optionsArg.type === 'Identifier' ? out.optionVars.get(optionsArg.name) : null;
        out.calls[hit.target].push({
          line: node.loc.start.line, via: hit.via, optionsArg, helperCall, id: helperCall ? helperId(helperCall) : null,
          spreadBeforeOptions: args.slice(0, 2).some((a) => a.type === 'SpreadElement'),
        });
      }
      if (isHelperCallee(node.callee)) out.helperCalls.push({ line: node.loc.start.line, node, id: helperId(node), raw: node.arguments[0] ? src.slice(node.arguments[0].start, node.arguments[0].end) : '' });
      else if (looksLikeHelper(node.callee)) out.badHelper.push({ line: node.loc.start.line, text: sourceOf(node).split('\n')[0].trim() });
      void ancestors;
    },
    Identifier(node, _st, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;
      const inCalleePosition = parent.type === 'CallExpression' && parent.callee === node;
      const memberCallee = parent.type === 'MemberExpression' && parent.object === node && ancestors[ancestors.length - 3]
        && ancestors[ancestors.length - 3].type === 'CallExpression' && ancestors[ancestors.length - 3].callee === parent;
      const aliasBinding = (parent.type === 'VariableDeclarator' && parent.init && parent.id.type === 'Identifier')
        || (parent.type === 'AssignmentExpression' && parent.left.type === 'Identifier' && parent.right === node);
      for (const t of [LOOKUP, TRIO]) {
        if (!aliases[t].has(node.name)) continue;
        if (inCalleePosition || memberCallee) continue; // the call itself (counted above)
        if (aliasBinding && refersTo(parent.init || parent.right, t, aliases[t])) continue; // an alias binding
        // Only the defining module may export it, and only under its own
        // name. A re-export anywhere else, or under another name even there
        // (`module.exports.lookup = performPropertyLookup`), is a wrapper a
        // consumer could require under a name this guard never sees.
        if (isExportContext(ancestors) && r === DEFINING[t] && exportedUnderOwnName(node, ancestors, t)) continue;
        out.valueRefs.push({ target: t, line: node.loc.start.line, text: sourceOf(parent).split('\n')[0].trim() });
      }
      if ((node.name === HELPER || helperLocals.has(node.name)) && !inCalleePosition && !isExportContext(ancestors) && !(parent.type === 'Property' && parent.key === node && !parent.computed)) {
        out.helperRefs.push({ line: node.loc.start.line, text: sourceOf(parent).split('\n')[0].trim() });
      }
      // A trusted options variable may appear in exactly two places: as the
      // options argument of a lookup call, and (in the admin route only) as
      // the object of the sanctioned switch-off. Any other use — a mutation
      // (`Object.assign(opts, ...)`, `opts.x = ...`, `delete opts.x`), a
      // copy, a pass to another function — is refused: the object that
      // reaches the lookup must be exactly what the registry returned.
      if (out.optionVars.has(node.name)) {
        const asLookupOptions = parent.type === 'CallExpression' && parent.arguments[1] === node && !!targetOfCallee(parent.callee);
        const grand = ancestors[ancestors.length - 3];
        const asSanctionedObject = r === SANCTIONED_OVERRIDE.file && parent.type === 'MemberExpression' && parent.object === node
          && memberName(parent) === OPTION && grand && grand.type === 'AssignmentExpression' && grand.left === parent;
        if (!asLookupOptions && !asSanctionedObject) out.optionVarMisuse.push({ line: node.loc.start.line, text: sourceOf(parent).split('\n')[0].trim() });
      }
    },
    AssignmentExpression(node, _st, ancestors) {
      if (node.left.type !== 'MemberExpression') return;
      const name = memberName(node.left);
      if (name === OPTION) {
        const stmt = ancestors[ancestors.length - 2];
        const ifNode = ancestors[ancestors.length - 3];
        out.overrides.push({
          line: node.loc.start.line,
          object: node.left.object.type === 'Identifier' ? node.left.object.name : sourceOf(node.left.object),
          operator: node.operator,
          right: node.right.type === 'Literal' ? node.right.value : sourceOf(node.right),
          guardedBy: stmt && stmt.type === 'ExpressionStatement' && ifNode && ifNode.type === 'IfStatement' && ifNode.consequent === stmt ? sourceOf(ifNode.test) : null,
        });
      }
      if (['suiteSizing', 'surface', 'file', 'why', 'calls'].includes(name) && (name === 'suiteSizing' || /\bCALLERS\b/.test(sourceOf(node.left.object)))) {
        out.policyWrites.push({ line: node.loc.start.line, text: sourceOf(node).split('\n')[0].trim() });
      }
    },
  }, undefined, {});

  // Any spelling of the option outside a comment, in whatever syntactic form
  // (dot or bracket write, string key, Object.assign / defineProperty, a
  // spread of an object that names it). The gate reader
  // commercialSuiteSizingLive() is a different name and is allowed.
  withoutComments(src, comments).split('\n').forEach((line, i) => {
    if (new RegExp(`${OPTION}(?!Live\\b)`).test(line)) out.mentions.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

const analyses = new Map();
const parseErrors = [];
for (const file of files) {
  try { analyses.set(file, analyze(file)); } catch (e) { parseErrors.push(`${rel(file)}: ${e.message}`); }
}
const all = [...analyses.values()];

// The options argument of a lookup call: lookupOptionsFor(...) inline, or a
// `const` identifier bound to lookupOptionsFor(...) in the same file that is
// declared exactly once (no shadowing parameter, pattern or redeclaration)
// and never assigned or updated afterwards, so the binding that reaches the
// call is the helper's result. Nothing else — no `let`, no spread, no object
// literal around it, no missing argument.
function optionsDeclared(call) {
  const arg = call.optionsArg;
  if (!arg || call.spreadBeforeOptions || call.via !== 'direct') return false;
  return !!call.helperCall;
}

// ---------------------------------------------------------------------------

describe('property-lookup callers declare their scope decision', () => {
  test('every production file parses (a file the guard cannot read cannot hide a caller)', () => {
    expect(parseErrors).toEqual([]);
    // The prefilter keeps every file that spells a tracked name; the real
    // callers are among them, so the set is never trivially empty.
    expect(all.length).toBeGreaterThan(10);
    for (const c of Object.values(CALLERS)) expect(all.some((a) => a.file === c.file)).toBe(true);
  });

  test('the registry and every entry are frozen; no file reassigns a policy field', () => {
    expect(Object.isFrozen(CALLERS)).toBe(true);
    expect(Object.isFrozen(TRIO_CALLERS)).toBe(true);
    for (const [id, entry] of Object.entries(CALLERS)) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(() => { 'use strict'; entry.suiteSizing = !entry.suiteSizing; }).toThrow();
      expect(id).toMatch(/^[a-z_]+$/);
    }
    // ...and no production statement even tries: an assignment to a policy
    // field on a CALLERS entry (or to any `.suiteSizing`) outside the
    // registry file is an offender regardless of the freeze.
    const offenders = all.filter((a) => a.file !== 'services/property-lookup/lookup-callers.js')
      .flatMap((a) => a.policyWrites.map((w) => `${a.file}:${w.line}: ${w.text}`));
    expect(offenders).toEqual([]);
  });

  test('every performPropertyLookup call site passes lookupOptionsFor(...), and the lookup is never passed around as a value', () => {
    const offenders = [];
    const invocations = {};
    for (const a of all) {
      for (const call of a.calls[LOOKUP]) {
        invocations[a.file] = (invocations[a.file] || 0) + 1;
        if (call.via !== 'direct') offenders.push(`${a.file}:${call.line}: invoked through .${call.via}()`);
        else if (!optionsDeclared(call)) offenders.push(`${a.file}:${call.line}: options are not the canonical lookupOptionsFor(...) / a const bound to it`);
      }
      for (const m of a.optionVarMisuse) offenders.push(`${a.file}:${m.line}: trusted options variable used outside the lookup call: ${m.text}`);
      for (const v of a.valueRefs.filter((v) => v.target === LOOKUP)) offenders.push(`${a.file}:${v.line}: performPropertyLookup used as a value: ${v.text}`);
      // A caller never spells the option, anywhere in its file, in any form.
      // Only the modules that define or read it are exempt, named one by one.
      if (!OPTION_OWNERS.has(a.file)) {
        for (const m of a.mentions) offenders.push(`${a.file}:${m.line}: names ${OPTION} outside the registry: ${m.text}`);
      }
    }
    // The one sanctioned override, checked as syntax: in the admin route,
    // exactly one assignment to a member named commercialSuiteSizing, on
    // `callerOptions`, operator `=`, value `false`, as the consequent of an
    // `if` whose test is the whole-property switch.
    const route = all.find((a) => a.file === SANCTIONED_OVERRIDE.file);
    expect(route.overrides).toHaveLength(1);
    const [ov] = route.overrides;
    expect(ov).toMatchObject({ object: SANCTIONED_OVERRIDE.object, operator: '=', right: false });
    expect(ov.guardedBy).toMatch(new RegExp(`^${SANCTIONED_OVERRIDE.guard} === true$`));
    for (const a of all) {
      if (a.file === SANCTIONED_OVERRIDE.file) continue;
      for (const o of a.overrides) offenders.push(`${a.file}:${o.line}: assigns ${OPTION}`);
    }
    expect(offenders).toEqual([]);
    // Each file's lookup invocations equal the `calls` its registry entries
    // declare for it, so a second performPropertyLookup in a declared file
    // fails here even when it reuses the first call's options variable.
    const declaredByFile = {};
    for (const c of Object.values(CALLERS)) declaredByFile[c.file] = (declaredByFile[c.file] || 0) + c.calls;
    expect(invocations).toEqual(declaredByFile);
  });

  test('every direct lookupPropertyFromAITrio caller (by any alias or member form) is a declared bypass', () => {
    // The lookup's own internal use is pinned, not exempted: the defining
    // module makes no call (its declaration and export are not calls), and
    // the lookup route composes the trio into a profile exactly once. A
    // second call in either file is a second purpose and fails here like an
    // undeclared caller does.
    const INTERNAL = { 'routes/property-lookup-v2.js': 1 };
    const found = {};
    const offenders = [];
    for (const a of all) {
      if (a.calls[TRIO].length) found[a.file] = a.calls[TRIO].length;
      for (const call of a.calls[TRIO]) if (call.via !== 'direct') offenders.push(`${a.file}:${call.line}: trio invoked through .${call.via}()`);
      for (const v of a.valueRefs.filter((v) => v.target === TRIO)) offenders.push(`${a.file}:${v.line}: lookupPropertyFromAITrio used as a value: ${v.text}`);
    }
    expect(offenders).toEqual([]);
    // Both directions, with the call count: a direct caller the registry
    // does not name is a new, unreviewed bypass; a registry entry with no
    // direct call left is stale; and a second call in a declared file is a
    // second purpose the one-line declaration does not cover.
    const declared = { ...INTERNAL, ...Object.fromEntries(Object.entries(TRIO_CALLERS).map(([f, d]) => [f, d.calls])) };
    expect(found).toEqual(declared);
  });

  test('every caller id is used in exactly the one file the registry binds it to, exactly `calls` times, always as a single-quoted literal', () => {
    const uses = {};
    const nonCanonical = [];
    for (const a of all) {
      if (a.file === REGISTRY) continue;
      // Only the canonical helper (imported from the registry module) may be
      // called, only with a single-quoted literal id, and only to feed a
      // lookup call: a call of anything else named lookupOptionsFor, a
      // non-literal id, the helper passed around as a value, or a helper
      // call no lookup consumes is refused.
      for (const h of a.helperCalls) if (!h.id) nonCanonical.push(`${a.file}:${h.line}: lookupOptionsFor(${h.raw}`);
      for (const b of a.badHelper) nonCanonical.push(`${a.file}:${b.line}: not the registry's lookupOptionsFor: ${b.text}`);
      for (const ref of a.helperRefs) nonCanonical.push(`${a.file}:${ref.line}: lookupOptionsFor used as a value: ${ref.text}`);
      const consumed = new Set(a.calls[LOOKUP].map((c) => c.helperCall).filter(Boolean));
      for (const h of a.helperCalls) if (!consumed.has(h.node)) nonCanonical.push(`${a.file}:${h.line}: lookupOptionsFor('${h.id}') feeds no lookup call`);
      // The id is read from the INVOCATION's own options expression, so each
      // lookup call is bound to the one registry entry it runs under.
      for (const c of a.calls[LOOKUP]) if (c.id) (uses[c.id] ||= []).push(a.file);
    }
    expect(nonCanonical).toEqual([]);
    const expected = Object.fromEntries(Object.entries(CALLERS).map(([id, c]) => [id, { files: [c.file], calls: c.calls }]));
    const actual = Object.fromEntries(Object.entries(uses).map(([id, fs_]) => [id, { files: [...new Set(fs_)], calls: fs_.length }]));
    expect(actual).toEqual(expected);
    // One caller id per file. A file with two lookup purposes gets a second
    // file or a reviewed edit here; it cannot pick, per call, which of two
    // entries' policies it runs under.
    const registryFiles = Object.values(CALLERS).map((c) => c.file);
    expect(new Set(registryFiles).size).toBe(registryFiles.length);
  });

  test('lookupOptionsFor: opt-in only for declared callers, never from the call site', () => {
    expect(lookupOptionsFor('admin_estimate_tool', { refresh: true })).toEqual({ refresh: true, commercialSuiteSizing: true });
    expect(lookupOptionsFor('estimator_engine', { persist: false })).toEqual({ persist: false, commercialSuiteSizing: true });
    expect(lookupOptionsFor('public_quote', { cacheOnly: true, commercialSuiteSizing: true })).toEqual({ cacheOnly: true });
    expect(lookupOptionsFor('report_cross_sell')).toEqual({});
    expect(() => lookupOptionsFor('nope')).toThrow(/unknown property-lookup caller/);
    // Pinned INDEPENDENTLY of the registry (which this test otherwise reads):
    // the only two ids that may opt in, each bound to its one approved file,
    // and the files that are customer- or public-facing no matter how their
    // entry is labelled. Reclassifying a public route as staff, adding a
    // third opt-in, or moving an opt-in to another module fails here.
    const MAY_OPT_IN = { admin_estimate_tool: 'routes/property-lookup-v2.js', estimator_engine: 'services/estimator-engine/index.js' };
    const PROTECTED_FILES = [
      'routes/public-property-lookup.js', 'routes/public-quote.js',
      'services/customer-pricing-ai.js', 'services/service-report/cross-sell.js',
    ];
    expect(Object.fromEntries(Object.entries(CALLERS).filter(([, c]) => c.suiteSizing).map(([id, c]) => [id, c.file]))).toEqual(MAY_OPT_IN);
    for (const f of PROTECTED_FILES) {
      const entry = Object.values(CALLERS).find((c) => c.file === f);
      expect(entry && ['public', 'customer'].includes(entry.surface) && entry.suiteSizing === false).toBe(true);
    }
    for (const c of Object.values(CALLERS)) {
      if (/^routes\/public-|\/customer-|\/portal|\/service-report\//.test(c.file) && !/prewarm/.test(c.file)) {
        expect(['public', 'customer']).toContain(c.surface);
      }
    }
    for (const [id, c] of Object.entries(CALLERS)) {
      expect(['staff', 'automation', 'public', 'customer']).toContain(c.surface);
      expect(typeof c.suiteSizing).toBe('boolean');
      expect(Number.isInteger(c.calls) && c.calls >= 1).toBe(true);
      expect(c.why.length).toBeGreaterThan(8);
      expect(fs.existsSync(path.join(SERVER_ROOT, c.file))).toBe(true);
      if (c.surface === 'public' || c.surface === 'customer') expect(c.suiteSizing).toBe(false);
      expect(id).toMatch(/^[a-z_]+$/);
    }
  });
});
