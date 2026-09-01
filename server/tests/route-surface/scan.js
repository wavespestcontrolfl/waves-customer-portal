'use strict';

/**
 * Static route-surface scanner for the public-route allowlist test.
 *
 * Walks server/index.js (the Express app composition) and every router
 * module it mounts, WITHOUT requiring any of them, and computes the set of
 * HTTP routes whose middleware chain contains no recognised auth guard.
 * "Recognised" is decided by the checked-in registry at
 * server/config/route-auth-guards.json — an unknown middleware NEVER counts
 * as auth (fail closed), so wrapping a guard in an anonymous function, or
 * adding a new auth middleware without registering it, surfaces as a public
 * route and fails server/tests/public-route-allowlist.test.js.
 *
 * Why static (AST via @babel/parser) instead of walking the live
 * `app._router.stack`: requiring server/index.js pulls in ~1,400 modules,
 * attempts DB connections, starts timers/retry loops and binds a listener,
 * and its production-only branches (the SPA fallback, /report SPA routes,
 * the second express.static) never register under NODE_ENV=test — so a live
 * walk would be slow, leak handles into jest, and miss real prod routes.
 * The static model is deterministic and sees every branch.
 *
 * Model (mirrors Express semantics closely enough to be conservative):
 *   - `app.use(prefix?, ...mw, router)` mounts a router; guards passed in the
 *     same call protect every route under it.
 *   - `app.use(prefix, guard)` / `router.use(prefix?, guard)` declared at the
 *     TOP LEVEL of a module protect routes registered AFTER it (source order)
 *     whose path starts with `prefix`. Guards inside if/for/function bodies
 *     are conditional and are NOT counted.
 *   - `router.<verb>(path, ...mw, handler)` is a route; a guard in its
 *     argument list counts only while everything BEFORE it is itself a guard
 *     or a registered reject-or-next passthrough (route-auth-guards.json
 *     `passthroughs`) — any other handler could terminate the request first,
 *     so it voids every later guard in the call. Arrays / spreads of
 *     top-level const arrays are flattened.
 *   - A use() handler must be provably NOT a router: a router/static mount, a
 *     registered guard/passthrough (package factories like express-rate-limit
 *     need a reviewed `package` passthrough entry — a package CAN export a
 *     router factory), or an inline / in-repo function. Anything opaque (an
 *     unresolved identifier, an unreviewed factory call) is rejected as a
 *     scanner problem — its routes would bypass the allowlist.
 *   - Router aliases (`const api = router`) resolve to the canonical router.
 *   - Nested routers (`router.use('/sub', subRouter)` or a require()) recurse.
 *   - Paths: string literals, arrays of them, RegExp literals, template
 *     literals and `for (const x of [...])` / `[...].forEach(x => ...)`
 *     enumerations over string literals are expanded (each loop variable is
 *     scoped to its own loop body). Anything else is an
 *     UNRESOLVED path — tolerated only when the route is guarded.
 *   - `express.static(...)` mounts are reported as `STATIC <prefix>`.
 *
 * CLI: `node server/tests/route-surface/scan.js` prints the current public
 * surface as allowlist-shaped JSON (reasons left blank) so a reviewer can
 * diff it against server/config/public-route-allowlist.json.
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_FILE = 'server/index.js';
const GUARD_REGISTRY_FILE = 'server/config/route-auth-guards.json';
// Every HTTP method Express exposes as a router method (router.checkout,
// router.m-search, ... included) — a route registered under ANY of them is
// surface.
// `all` is Express's own addition; `del` is Express 4's deprecated (but
// still live) alias of `delete`.
const VERBS = new Set([...require('http').METHODS.map((m) => m.toLowerCase()), 'all', 'del']);
const APP_IDENTIFIERS = new Set(['app']);

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseSource(src, file) {
  try {
    return parser.parse(src, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      errorRecovery: false,
    });
  } catch (err) {
    throw new Error(`route-surface: cannot parse ${file}: ${err.message}`);
  }
}

function isRequireCall(node) {
  return node
    && node.type === 'CallExpression'
    && node.callee.type === 'Identifier'
    && node.callee.name === 'require'
    && node.arguments.length === 1
    && node.arguments[0].type === 'StringLiteral';
}

// NOTE: Router-factory detection is provenance-checked per module — see
// ModuleAnalysis.isRouterFactory(). A call merely NAMED Router() from an
// in-repo helper is NOT a router (it could be terminal middleware wearing
// the name), so there is deliberately no context-free syntactic version.

function stringLiteralArray(node) {
  if (!node || node.type !== 'ArrayExpression') return null;
  const out = [];
  for (const el of node.elements) {
    if (!el || el.type !== 'StringLiteral') return null;
    out.push(el.value);
  }
  return out;
}

/** Resolve a module specifier relative to the file that requires it. */
function resolveModulePath(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // node_modules
  let target = path.normalize(path.join(path.dirname(fromFile), spec));
  if (!target.endsWith('.js')) target += '.js';
  return target.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Module analysis
// ---------------------------------------------------------------------------

/**
 * Normalize a predicate for use in a route identity. A long predicate keeps
 * a truncated head PLUS a content digest, so an edit anywhere in it — past
 * character 80 included — still changes the identity.
 */
function predicateLabel(text) {
  const norm = text.replace(/\s+/g, ' ');
  if (norm.length <= 80) return norm;
  return `${norm.slice(0, 80)}…#${crypto.createHash('sha256').update(norm).digest('hex').slice(0, 8)}`;
}

/**
 * Walk the AST, invoking `visit(node, ctx)` for every node. ctx.topLevel is
 * true only while the current statement is a direct child of Program.
 */
function walk(node, visit, ctx) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ctx);
  if (node.type === 'LogicalExpression' && ['&&', '||', '??'].includes(node.operator)) {
    // `cond && app.get('/debug', h)` registers only when cond is truthy —
    // the right operand carries the operator's polarity in its identity.
    const t = predicateLabel(ctx.src ? ctx.src.slice(node.left.start, node.left.end) : '?');
    const label = node.operator === '&&' ? t : (node.operator === '||' ? `!(${t})` : `nullish(${t})`);
    walk(node.left, visit, ctx); // the left operand evaluates unconditionally
    walk(node.right, visit, { ...ctx, topLevel: false, conds: [...(ctx.conds || []), label] });
    return;
  }
  if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
    // Branch POLARITY is part of a conditional route's identity: the
    // alternate branch is labelled with the negated test, so moving a route
    // from `if (dev)` into its else changes the allowlist key.
    const t = predicateLabel(ctx.src ? ctx.src.slice(node.test.start, node.test.end) : '?');
    const branch = (label) => ({ ...ctx, topLevel: false, conds: [...(ctx.conds || []), label] });
    walk(node.test, visit, ctx); // the test itself evaluates unconditionally
    walk(node.consequent, visit, branch(t));
    if (node.alternate) walk(node.alternate, visit, branch(`!(${t})`));
    return;
  }
  const nextCtx = node.type === 'Program' ? ctx : nestedCtx(node, ctx);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'comments'
      || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, visit, nextCtx);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit, nextCtx);
    }
  }
}

const TOP_LEVEL_TRANSPARENT = new Set([
  'ExpressionStatement', 'CallExpression', 'MemberExpression', 'Identifier', 'StringLiteral',
  'VariableDeclaration', 'VariableDeclarator', 'ArrayExpression', 'SpreadElement', 'ObjectExpression',
  'ObjectProperty', 'TemplateLiteral', 'TemplateElement', 'RegExpLiteral', 'AssignmentExpression',
  'AwaitExpression', 'SequenceExpression',
]);

/**
 * Human-readable label for the construct that makes descendants conditional;
 * null for plain blocks. The label becomes part of a conditional route's
 * allowlist IDENTITY, so flipping a predicate (!== to ===) changes the key.
 */
function condLabel(node, src) {
  // If/ternary branches are labelled directly in walk() (polarity-aware);
  // this covers the remaining constructs.
  if (node.type === 'ForOfStatement' || node.type === 'ForInStatement'
    || node.type === 'ForStatement' || node.type === 'WhileStatement' || node.type === 'DoWhileStatement') {
    return 'loop';
  }
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    return node.id && node.id.name ? `function ${node.id.name}` : 'function';
  }
  return null;
}

function nestedCtx(node, ctx) {
  if (TOP_LEVEL_TRANSPARENT.has(node.type)) return ctx;
  // Entering a function body, block, loop, conditional, etc. — anything
  // registered below here is conditional / deferred. Every predicate level
  // is recorded so it can be encoded into the route identity.
  const label = condLabel(node, ctx.src);
  if (ctx.topLevel === false && !label) return ctx;
  return { ...ctx, topLevel: false, conds: label ? [...ctx.conds, label] : ctx.conds };
}

class ModuleAnalysis {
  constructor(file, src, scanner) {
    this.file = file;
    this.src = src;
    this.scanner = scanner;
    this.ast = parseSource(src, file);
    this.bindings = new Map(); // name -> descriptor
    this.shadowedNames = new Set(); // bound at top level AND inside a block
    this.routers = new Set(); // identifiers bound to express.Router()
    this.exportedRouter = null;
    this.registrations = []; // ordered { object, method, args, topLevel, loc }
    this.problems = [];
    this.collect();
  }

  loc(node) {
    // Line AND column: two anonymous responders on one line must never
    // collapse to a single location (the duplicate-identity check keys on it).
    return `${this.file}:${node.loc ? `${node.loc.start.line}:${node.loc.start.column}` : '?'}`;
  }

  collect() {
    this.enumScopes = []; // { name, values, start, end } — lexical loop scopes
    this.exportProps = new Map(); // module.exports.<name> = <ident|false>
    this.directExternalRegs = []; // require('./x').<verb>() registrations
    this.bindingWrites = new Map(); // name -> count of value-bearing writes
    this.reassignedNames = new Set(); // written more than once — ambiguous
    const callsWithIdentifierArgs = [];
    const optionalCalls = [];
    const objectLiterals = [];
    const arrayLiterals = [];
    const mutatedNames = new Set(); // .push()/.unshift()/[i]= targets
    const callArgArrays = []; // { arr, call } — exemption decided post-walk
    const memberAssignments = [];
    walk(this.ast.program, (node, ctx) => {
      if ((node.type === 'CallExpression' || node.type === 'NewExpression')
        && node.arguments.some((a) => a && (a.type === 'Identifier' || a.type === 'ArrayExpression'))) {
        callsWithIdentifierArgs.push(node);
      }
      if (node.type === 'OptionalCallExpression'
        && (node.callee.type === 'OptionalMemberExpression' || node.callee.type === 'MemberExpression')) {
        optionalCalls.push(node);
      }
      if (node.type === 'ObjectExpression') objectLiterals.push(node);
      if (node.type === 'CallExpression'
        && node.callee.type === 'MemberExpression' && !node.callee.computed
        && node.callee.object.type === 'Identifier' && node.callee.property.type === 'Identifier'
        && ['push', 'unshift', 'splice', 'pop', 'shift', 'reverse', 'sort', 'fill', 'copyWithin'].includes(node.callee.property.name)) {
        mutatedNames.add(node.callee.object.name);
      }
      if (node.type === 'AssignmentExpression'
        && node.left.type === 'MemberExpression' && node.left.computed
        && node.left.object.type === 'Identifier') {
        mutatedNames.add(node.left.object.name); // chain[0] = x
      }
      if (node.type === 'ArrayExpression') arrayLiterals.push(node);
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        for (const a of node.arguments) if (a && a.type === 'ArrayExpression') callArgArrays.push({ arr: a, call: node });
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        this.recordBinding(node.id.name, node.init, ctx.topLevel);
      } else if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && isRequireCall(node.init)) {
        const mod = resolveModulePath(this.file, node.init.arguments[0].value);
        for (const prop of node.id.properties) {
          if (prop.type !== 'ObjectProperty' || prop.key.type !== 'Identifier') continue;
          const local = prop.value.type === 'Identifier' ? prop.value.name : null;
          if (!local) continue;
          this.countWrite(local);
          this.setBinding(local, { kind: 'requireMember', module: mod, spec: node.init.arguments[0].value, name: prop.key.name, topLevel: ctx.topLevel });
        }
      } else if (node.type === 'FunctionDeclaration' && node.id) {
        this.countWrite(node.id.name);
        this.setBinding(node.id.name, { kind: 'function', topLevel: ctx.topLevel });
      } else if (node.type === 'ForOfStatement'
        && node.left.type === 'VariableDeclaration'
        && node.left.declarations.length === 1
        && node.left.declarations[0].id.type === 'Identifier') {
        const values = this.resolveStringList(node.right);
        if (values) {
          this.enumScopes.push({
            name: node.left.declarations[0].id.name, values,
            start: node.body.start, end: node.body.end,
          });
        }
      } else if (node.type === 'CallExpression'
        && node.callee.type === 'MemberExpression' && !node.callee.computed
        && node.callee.property.name === 'forEach'
        && node.arguments[0]
        && (node.arguments[0].type === 'ArrowFunctionExpression' || node.arguments[0].type === 'FunctionExpression')
        && node.arguments[0].params[0] && node.arguments[0].params[0].type === 'Identifier') {
        const values = this.resolveStringList(node.callee.object);
        if (values) {
          const fn = node.arguments[0];
          this.enumScopes.push({
            name: fn.params[0].name, values,
            start: fn.body.start, end: fn.body.end,
          });
        }
      } else if (node.type === 'AssignmentExpression'
        && node.left.type === 'MemberExpression' && !node.left.computed
        && node.left.object.type === 'Identifier' && node.left.object.name === 'module'
        && node.left.property.name === 'exports') {
        // The LAST top-level assignment wins (execution order); a later
        // rewrite to inline middleware clears the stale router candidate. A
        // conditional export can never be trusted at all.
        if (!ctx.topLevel) this.exportUnstable = true;
        this.exportCandidate = node.right.type === 'Identifier' ? node.right.name : null;
        this.exportObjectNode = node.right.type === 'ObjectExpression' ? node.right : null;
        this.exportProps.clear(); // a wholesale assignment replaces prior props
      } else if (node.type === 'AssignmentExpression' && node.operator === '='
        && node.left.type === 'MemberExpression' && !node.left.computed
        && node.left.property.type === 'Identifier'
        && node.left.object.type === 'MemberExpression' && !node.left.object.computed
        && node.left.object.object.type === 'Identifier' && node.left.object.object.name === 'module'
        && node.left.object.property.type === 'Identifier' && node.left.object.property.name === 'exports') {
        // `module.exports.name = value` — the export MAPPING is what a
        // requiring module actually receives; recorded per name.
        if (!ctx.topLevel) this.exportUnstable = true;
        this.exportProps.set(node.left.property.name,
          node.right.type === 'Identifier' ? node.right.name : false);
      } else if (node.type === 'AssignmentExpression' && node.operator === '='
        && node.left.type === 'MemberExpression' && !node.left.computed
        && node.left.property.type === 'Identifier') {
        // `holder.api = router` — modeled post-walk (props may involve
        // bindings declared later in the file).
        memberAssignments.push({ objectNode: node.left.object, prop: node.left.property.name, right: node.right, node });
      } else if (node.type === 'AssignmentExpression' && node.operator === '='
        && node.left.type === 'Identifier') {
        // `let api; api = router;` — an assignment binds exactly like a
        // declarator (alias, router factory, require, ...); without this a
        // registration through the assigned name would be silently dropped.
        this.recordBinding(node.left.name, node.right, ctx.topLevel);
      } else if (node.type === 'CallExpression'
        && node.callee.type === 'MemberExpression'
        && (node.callee.object.type === 'Identifier' || node.callee.object.type === 'CallExpression'
          || node.callee.object.type === 'MemberExpression')) {
        // Computed string-literal calls (router['get'](...)) register like the
        // plain form; a computed NON-literal method (router[verb](...)) cannot
        // be resolved, so it is recorded and reported as a problem when the
        // object turns out to be a router/app — silence there would be a
        // fail-open hole in the allowlist.
        let method = null;
        let unresolvedMethod = false;
        if (!node.callee.computed && node.callee.property.type === 'Identifier') {
          method = node.callee.property.name;
        } else if (node.callee.computed && node.callee.property.type === 'StringLiteral') {
          method = node.callee.property.value;
        } else if (node.callee.computed) {
          unresolvedMethod = true;
        }
        // Fluent chains (`router.get('/a', h).post('/b', h)`) register on the
        // chain's ROOT identifier — Express verbs return the router, so every
        // link is a real registration. A chain rooted in an inline Router()
        // call has no name to attribute routes to: reject it (fail closed).
        let objName = null;
        if (node.callee.object.type === 'Identifier') {
          objName = node.callee.object.name;
        } else if (node.callee.object.type === 'MemberExpression') {
          // `holder.router.get(...)` — resolvable only after every binding is
          // known; record the node and resolve post-walk. Unresolvable member
          // objects (res.app, this.modules, ...) are dropped there like any
          // non-router object.
          if (method && (VERBS.has(method) || method === 'use' || method === 'route' || method === 'param')) {
            const inner = node.callee.object;
            if (!inner.computed && inner.property.type === 'Identifier' && isRequireCall(inner.object)) {
              // require('./routers').api.get('/leak', h) — an inline named
              // export mutation; recorded for the external-mutation sweep.
              const mod = resolveModulePath(this.file, inner.object.arguments[0].value);
              if (mod) this.directExternalRegs.push({ module: mod, name: inner.property.name, method, loc: this.loc(node) });
            }
            this.registrations.push({ object: null, objectNode: node.callee.object, method, args: node.arguments, topLevel: ctx.topLevel, cond: ctx.conds.join(' && ') || null, node });
          }
          return;
        } else if (method && (VERBS.has(method) || method === 'use' || method === 'route' || method === 'param')
          && isRequireCall(node.callee.object)) {
          // require('./shared-router').get('/leak', h) — a registration on
          // another module's export; resolved and rejected in the sweep.
          const mod = resolveModulePath(this.file, node.callee.object.arguments[0].value);
          if (mod) this.directExternalRegs.push({ module: mod, name: null, method, loc: this.loc(node) });
        } else if (method && (VERBS.has(method) || method === 'use' || method === 'route' || method === 'param')) {
          let base = node.callee.object;
          while (base && base.type === 'CallExpression' && !this.isRouterFactory(base)) {
            base = base.callee && base.callee.type === 'MemberExpression' ? base.callee.object : null;
          }
          if (base && base.type === 'Identifier') objName = base.name;
          else if (base && base.type === 'MemberExpression') {
            this.registrations.push({ object: null, objectNode: base, method, args: node.arguments, topLevel: ctx.topLevel, cond: ctx.conds.join(' && ') || null, node });
            return;
          } else if (base && this.isRouterFactory(base)) {
            this.problems.push(`${this.loc(node)}: ${method}() chained on an inline Router() call — bind the router to a const so its routes can be attributed`);
          }
        }
        if (objName === null) {
          // not a chain we can attribute (or not a registration shape at all)
        } else if (unresolvedMethod) {
          this.registrations.push({ object: objName, method: '<computed>', args: node.arguments, topLevel: ctx.topLevel, cond: ctx.conds.join(' && ') || null, node });
        } else if (method && (VERBS.has(method) || method === 'use' || method === 'route' || method === 'param')) {
          this.registrations.push({ object: objName, method, args: node.arguments, topLevel: ctx.topLevel, cond: ctx.conds.join(' && ') || null, node });
        }
      }
    }, { topLevel: true, conds: [], src: this.src });
    // Resolve identifier aliases (`const api = router`) to their canonical
    // binding so registrations made through the alias are still attributed to
    // the router (or the app) — a plain alias mounts routes just as well as
    // the original name, so dropping them would be a fail-open hole.
    for (const [name, b] of this.bindings) {
      if (b.kind === 'alias' && this.routers.has(this.canonName(name))) this.routers.add(name);
    }
    // `holder.api = router` — extend the modeled object's props; a router
    // assigned into a shape the scanner cannot model is rejected. A property
    // written MORE THAN ONCE is ambiguous (which value a later reference
    // sees depends on execution order): it resolves to nothing, and if a
    // router was ever involved that is a problem, not silence.
    this.reassignedProps = new Set();
    const propWrites = new Map(); // `${base}.${prop}` -> count
    const bumpProp = (key) => {
      const w = (propWrites.get(key) || 0) + 1;
      propWrites.set(key, w);
      if (w > 1) this.reassignedProps.add(key);
    };
    for (const [bn, b] of this.bindings) {
      if (b.kind === 'object') for (const k of b.props.keys()) bumpProp(`${bn}.${k}`);
    }
    for (const a of memberAssignments) {
      const base = this.resolveMemberChain(a.objectNode);
      const b = base ? this.bindings.get(base) : null;
      if (b && b.kind === 'object' && a.right.type === 'Identifier') {
        bumpProp(`${base}.${a.prop}`);
        if (!this.reassignedProps.has(`${base}.${a.prop}`)) b.props.set(a.prop, a.right.name);
        else if (this.routers.has(this.canonName(b.props.get(a.prop) || '')) || this.routers.has(this.canonName(a.right.name))) {
          this.problems.push(`${this.loc(a.node)}: property ${base}.${a.prop} holding a router is reassigned — which router a later reference sees depends on execution order; use distinct names`);
        }
        continue;
      }
      if (a.right.type === 'Identifier' && this.routers.has(this.canonName(a.right.name))) {
        this.problems.push(`${this.loc(a.node)}: router ${a.right.name} assigned into an object shape the scanner cannot model — register routes via the router identifier, or a one-level object literal bound to a const`);
      }
    }
    this.externalRouterRegs = [...this.directExternalRegs]; // registrations on OTHER modules' routers
    for (const r of this.registrations) {
      if (r.objectNode) r.object = this.resolveMemberChain(r.objectNode) || '<member>';
      else r.object = this.canonName(r.object);
      const ob = this.cleanBinding(r.object);
      if (ob && (ob.kind === 'require' || ob.kind === 'requireMember') && ob.module !== null) {
        // `const shared = require('./shared-router'); shared.get('/leak', h)`
        // mutates a router OWNED BY ANOTHER MODULE — recorded so the scanner
        // can reject the pattern wherever the target is mounted surface.
        this.externalRouterRegs.push({
          module: ob.module,
          name: ob.kind === 'requireMember' ? ob.name : null,
          method: r.method,
          loc: this.loc(r.node),
        });
      }
    }
    // Optional-call registrations (`app?.get('/leak', h)`) still register at
    // runtime (the app exists) but ride node types the collector does not
    // model — reject them on a known router/app (fail closed).
    for (const call of optionalCalls) {
      const base = this.resolveMemberChain(call.callee.object);
      if (base && (this.routers.has(base) || APP_IDENTIFIERS.has(base))) {
        this.problems.push(`${this.loc(call)}: optional-call registration on ${base} (?. syntax) is not supported by the scanner — use a plain ${base}.<verb>()/use()`);
      }
    }
    // A router tucked into an object literal the scanner did NOT model (a
    // nested object, a computed key) could carry registrations invisibly —
    // reject unless it is a modeled one-level binding or the module.exports
    // object (whose members resolve via classifyModuleName).
    // A router in an ARRAY literal can be registered on through a computed
    // member the scanner cannot resolve (`holders[0].get('/leak', h)`).
    // Allowed only as a direct call argument (`app.use('/x', [g, router])`,
    // which classify() flattens); anywhere else it is rejected.
    // A middleware ARRAY mutated after its initializer (chain.unshift(mw),
    // chain[0] = mw) no longer matches what the scanner sees — refuse it.
    this.mutatedArrays = new Set();
    for (const n of mutatedNames) {
      const b = this.bindings.get(n);
      if (b && b.kind === 'array') this.mutatedArrays.add(n);
    }
    // Only an argument of a REGISTRATION call on a known router/app is a
    // handler array classify() will flatten; an array passed to any other
    // function (`install([router])`) hides the router from the walk.
    const exemptArrays = new Set();
    for (const { arr, call } of callArgArrays) {
      const c = call.callee;
      if (!c || c.type !== 'MemberExpression' || c.computed || c.property.type !== 'Identifier') continue;
      const base = this.resolveMemberChain(c.object);
      if (!base || !(this.routers.has(base) || APP_IDENTIFIERS.has(base))) continue;
      if (VERBS.has(c.property.name) || c.property.name === 'use') exemptArrays.add(arr);
    }
    for (const arr of arrayLiterals) {
      if (exemptArrays.has(arr)) continue;
      for (const el of arr.elements) {
        if (el && el.type === 'Identifier' && this.routers.has(this.canonName(el.name))) {
          this.problems.push(`${this.loc(el)}: router ${el.name} stored in an array — the scanner cannot attribute registrations made through array access; mount/register via the router identifier`);
        }
      }
    }
    for (const obj of objectLiterals) {
      if (obj === this.exportObjectNode) continue;
      const modeled = [...this.bindings.values()].some((b) => b.kind === 'object' && b.node === obj);
      for (const p of obj.properties) {
        const v = p.type === 'ObjectProperty' ? p.value : null;
        if (!v || v.type !== 'Identifier' || !this.routers.has(this.canonName(v.name))) continue;
        if (modeled && !p.computed && p.key.type === 'Identifier') continue;
        this.problems.push(`${this.loc(v)}: router ${v.name} stored in an object shape the scanner cannot model — register routes via the router identifier, or a one-level object literal bound to a const`);
      }
    }
    if (this.exportUnstable) {
      // module.exports assigned inside a block/function — what the module
      // exports depends on execution the scanner cannot see. Fail closed.
      this.exportCandidate = null;
      this.exportObjectNode = null;
    }
    if (this.exportCandidate) {
      const canon = this.canonName(this.exportCandidate);
      if (this.routers.has(canon)) this.exportedRouter = canon;
    }
    // Only registrations on real routers (or the app) matter.
    this.registrations = this.registrations.filter((r) => this.routers.has(r.object) || APP_IDENTIFIERS.has(r.object));
    // A router (or the app) passed as an ARGUMENT to a function the scanner
    // does not analyse could have routes registered on it inside that helper
    // (`installRoutes(app)`) — package code included: node_modules can call
    // app.get() just as well as in-repo code. Reject it (fail closed).
    // Exempt: methods ON a known router/app (that IS the supported
    // registration path — app.use('/x', router), app.listen, ...) and
    // callees with a reviewed `routerConsumers` registry entry
    // (http.createServer, the Sentry error handler).
    for (const call of callsWithIdentifierArgs) {
      const argNames = [];
      for (const a of call.arguments) {
        if (a && a.type === 'Identifier') argNames.push(a.name);
        else if (a && a.type === 'ArrayExpression') {
          for (const el of a.elements) if (el && el.type === 'Identifier') argNames.push(el.name);
        }
      }
      const passed = argNames
        .map((n) => this.canonName(n))
        .filter((n) => this.routers.has(n) || APP_IDENTIFIERS.has(n));
      if (!passed.length) continue;
      const c = call.callee;
      const consumerOk = (entry) => {
        if (!entry) return false;
        if (entry.appOnly && passed.some((n) => !APP_IDENTIFIERS.has(n))) {
          // The listener/error-handler must keep receiving THE APP — handing
          // it a different router would silently swap the served surface
          // away from what scan() walks.
          this.problems.push(`${this.loc(call)}: ${entry.name} is reviewed to receive only the app, but got ${passed.join(', ')} — the scanner walks the app, so the process must serve it`);
        }
        return true;
      };
      if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier'
        && c.property.type === 'Identifier') {
        const objCanon = this.canonName(c.object.name);
        if (this.routers.has(objCanon) || APP_IDENTIFIERS.has(objCanon)) continue;
        const ob = this.bindings.get(c.object.name);
        if (ob && ob.kind === 'require'
          && consumerOk(this.scanner.registry.lookupRouterConsumer(ob.module === null ? ob.spec : ob.module, c.property.name))) continue;
      }
      if (c.type === 'Identifier') {
        const b = this.bindings.get(c.name);
        if (b && b.kind === 'requireMember'
          && consumerOk(this.scanner.registry.lookupRouterConsumer(b.module === null ? b.spec : b.module, b.name))) continue;
      }
      this.problems.push(`${this.loc(call)}: ${passed.join(', ')} passed to an unanalysed function — the scanner cannot see routes the helper may register; register routes at module top level (or add a reviewed routerConsumers entry for a helper proven not to register routes)`);
    }
    // EXECUTION order, not AST pre-order: in a fluent chain the outer call's
    // node encloses the inner one (`router.get('/x', h).use(guard)` runs the
    // get FIRST), so ordering by node END position restores the order Express
    // actually sees; separate statements keep their source order unchanged.
    this.registrations.sort((a, b) => a.node.end - b.node.end);
    for (const r of this.registrations) {
      if (r.method === 'route') {
        this.problems.push(`${this.loc(r.node)}: ${r.object}.route(...) chains are not supported by the scanner — register with ${r.object}.<verb>() instead`);
      } else if (r.method === '<computed>') {
        this.problems.push(`${this.loc(r.node)}: computed method call ${r.object}[...](...) on a router — the scanner cannot tell what it registers; use a literal ${r.object}.<verb>()/use()`);
      }
    }
  }

  /**
   * True only for a call PROVEN to construct an Express router: the callee
   * must resolve to require('express').Router (whole-module or destructured
   * import). A call merely named Router() from any other source is not
   * trusted — it could return terminal middleware wearing the name.
   */
  isRouterFactory(node) {
    if (!node || node.type !== 'CallExpression') return false;
    const c = node.callee;
    if (c.type === 'Identifier') {
      const b = this.cleanBinding(c.name);
      return Boolean(b && b.kind === 'requireMember' && b.module === null
        && b.spec === 'express' && b.name === 'Router');
    }
    if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' && c.property.name === 'Router') {
      if (isRequireCall(c.object)) return c.object.arguments[0].value === 'express';
      if (c.object.type === 'Identifier') {
        const b = this.cleanBinding(c.object.name);
        return Boolean(b && b.kind === 'require' && b.module === null && b.spec === 'express');
      }
    }
    return false;
  }

  /**
   * What this module actually EXPORTS under `name` — the mapping a requiring
   * module receives, not an internal binding that happens to share the name
   * (`module.exports = { api: leak }` exports leak under api).
   * Returns { kind: 'ident', name } | { kind: 'opaque' } | { kind: 'none' }.
   */
  exportLookup(name) {
    if (this.exportUnstable) return { kind: 'opaque' };
    if (this.exportProps.has(name)) {
      const v = this.exportProps.get(name);
      return v ? { kind: 'ident', name: v } : { kind: 'opaque' };
    }
    if (this.exportObjectNode) {
      for (const prop of this.exportObjectNode.properties) {
        if (prop.type === 'ObjectProperty' && !prop.computed
          && prop.key.type === 'Identifier' && prop.key.name === name) {
          return prop.value.type === 'Identifier' ? { kind: 'ident', name: prop.value.name } : { kind: 'opaque' };
        }
      }
      return { kind: 'none' };
    }
    return { kind: 'none' };
  }

  /**
   * Root identifier of a fluent REGISTRATION chain
   * (`router.get(...).use(...)`), or null when the call is not one.
   */
  registrationChainRoot(node) {
    let cur = node;
    while (cur && cur.type === 'CallExpression'
      && cur.callee.type === 'MemberExpression' && !cur.callee.computed
      && cur.callee.property.type === 'Identifier'
      && (VERBS.has(cur.callee.property.name) || cur.callee.property.name === 'use')) {
      cur = cur.callee.object;
    }
    return cur && cur.type === 'Identifier' ? cur.name : null;
  }

  /** Follow `const a = b` alias chains to the canonical name. */
  canonName(name) {
    const seen = new Set();
    let n = name;
    for (;;) {
      const b = this.bindings.get(n);
      if (!b || b.kind !== 'alias' || seen.has(n)) return n;
      seen.add(n);
      n = b.target;
    }
  }

  /**
   * Resolve `holder.router`-style member chains through modeled object
   * bindings to a canonical identifier name; null when unresolvable.
   */
  resolveMemberChain(node) {
    if (!node) return null;
    if (node.type === 'Identifier') return this.canonName(node.name);
    if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression')
      && !node.computed && node.property.type === 'Identifier') {
      const base = this.resolveMemberChain(node.object);
      if (!base) return null;
      const b = this.bindings.get(base);
      if (this.reassignedProps && this.reassignedProps.has(`${base}.${node.property.name}`)) return null;
      if (b && b.kind === 'object' && b.props.has(node.property.name)) {
        return this.canonName(b.props.get(node.property.name));
      }
    }
    return null;
  }

  setBinding(name, desc) {
    // Top-level bindings win over nested shadows so a route file's imports
    // stay authoritative; nested-only names are still recorded. A name bound
    // at BOTH levels is remembered as shadowed: the flat model cannot tell
    // which binding a handler reference resolves to, so classify() must
    // refuse to credit it (a block-local no-op could shadow a real guard).
    const existing = this.bindings.get(name);
    if (existing && existing.topLevel !== desc.topLevel) this.shadowedNames.add(name);
    if (existing && existing.topLevel && !desc.topLevel) return;
    this.bindings.set(name, desc);
  }

  /** A value-bearing write; two or more make the name ambiguous to resolve. */
  countWrite(name) {
    const w = (this.bindingWrites.get(name) || 0) + 1;
    this.bindingWrites.set(name, w);
    if (w > 1) this.reassignedNames.add(name);
  }

  recordBinding(name, init, topLevel) {
    if (init) this.countWrite(name);
    if (this.isRouterFactory(init)) {
      this.routers.add(name);
      this.setBinding(name, { kind: 'router', topLevel });
    } else if (isRequireCall(init)) {
      this.setBinding(name, { kind: 'require', module: resolveModulePath(this.file, init.arguments[0].value), spec: init.arguments[0].value, topLevel });
    } else if (init && init.type === 'StringLiteral') {
      this.setBinding(name, { kind: 'string', value: init.value, topLevel });
    } else if (init && init.type === 'ArrayExpression') {
      this.setBinding(name, { kind: 'array', elements: init.elements, topLevel });
    } else if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
      this.setBinding(name, { kind: 'function', topLevel });
    } else if (init && init.type === 'CallExpression') {
      // Express registration calls RETURN the router, so
      // `const api = router.get('/x', h)` aliases the router — later
      // registrations through `api` must not be lost.
      const regRoot = this.registrationChainRoot(init);
      if (regRoot && (this.routers.has(this.canonName(regRoot)) || APP_IDENTIFIERS.has(this.canonName(regRoot)))) {
        this.setBinding(name, { kind: 'alias', target: regRoot, topLevel });
        return;
      }
      // e.g. `const payLimiter = rateLimit({...})` — a produced handler. The
      // call node is kept so classify() can judge the callee's provenance.
      this.setBinding(name, { kind: 'call', node: init, topLevel });
    } else if (init && init.type === 'Identifier') {
      // `const api = router` — a plain alias; resolved after the walk.
      this.setBinding(name, { kind: 'alias', target: init.name, topLevel });
    } else if (init && init.type === 'ObjectExpression') {
      // `const holder = { router }` — model identifier-valued properties so
      // holder.router.get(...) can be attributed to the router.
      const props = new Map();
      for (const p of init.properties) {
        if (p.type === 'ObjectProperty' && !p.computed
          && p.key.type === 'Identifier' && p.value.type === 'Identifier') {
          props.set(p.key.name, p.value.name);
        }
      }
      this.setBinding(name, { kind: 'object', props, node: init, topLevel });
    } else if (init && init.type === 'MemberExpression' && !init.computed && isRequireCall(init.object)) {
      this.setBinding(name, {
        kind: 'requireMember',
        module: resolveModulePath(this.file, init.object.arguments[0].value),
        spec: init.object.arguments[0].value,
        name: init.property.name,
        topLevel,
      });
    } else {
      this.setBinding(name, { kind: 'other', topLevel });
    }
  }

  resolveStringList(node) {
    if (!node) return null;
    const direct = stringLiteralArray(node);
    if (direct) return direct;
    if (node.type === 'Identifier') {
      const b = this.bindings.get(node.name);
      if (b && b.kind === 'array') return stringLiteralArray({ type: 'ArrayExpression', elements: b.elements });
    }
    return null;
  }

  /**
   * Resolve a path argument to a list of path tokens (strings, or
   * `{ regex }` objects). Returns null when the node cannot be a path or
   * cannot be resolved; callers distinguish via `couldBePath`.
   */
  resolvePaths(node) {
    if (!node) return null;
    switch (node.type) {
      case 'StringLiteral':
        return [node.value];
      case 'RegExpLiteral':
        return [{ regex: node.pattern, flags: node.flags }];
      case 'ArrayExpression': {
        const out = [];
        for (const el of node.elements) {
          if (el && el.type === 'SpreadElement') {
            const spread = this.resolveStrings(el.argument);
            if (!spread) return null;
            out.push(...spread);
            continue;
          }
          const sub = this.resolvePaths(el);
          if (!sub) return null;
          out.push(...sub);
        }
        return out;
      }
      case 'TemplateLiteral': {
        let combos = [''];
        for (let i = 0; i < node.quasis.length; i += 1) {
          const text = node.quasis[i].value.cooked;
          combos = combos.map((c) => c + text);
          if (i < node.expressions.length) {
            const values = this.resolveStrings(node.expressions[i]);
            if (!values) return null;
            const next = [];
            for (const c of combos) for (const v of values) next.push(c + v);
            combos = next;
          }
        }
        return combos;
      }
      case 'Identifier': {
        const values = this.resolveStrings(node);
        if (values) return values;
        // An identifier bound to a MIXED path array ([/^\/secret$/, '/x'])
        // resolves element-by-element like an inline array literal.
        if (this.shadowedNames.has(node.name) || this.reassignedNames.has(node.name)) return null;
        if (this.mutatedArrays && this.mutatedArrays.has(node.name)) return null;
        const b = this.bindings.get(node.name);
        if (b && b.kind === 'array') {
          return this.resolvePaths({ type: 'ArrayExpression', elements: b.elements });
        }
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * Values of an enumeration loop variable, valid only INSIDE that loop's own
   * body (innermost scope wins). Keyed by source position so two loops that
   * reuse a variable name never bleed into each other.
   */
  enumValuesAt(name, pos) {
    if (typeof pos !== 'number') return null;
    let best = null;
    for (const s of this.enumScopes) {
      if (s.name !== name || pos < s.start || pos > s.end) continue;
      if (!best || s.start > best.start) best = s;
    }
    return best ? best.values : null;
  }

  resolveStrings(node) {
    if (node.type === 'StringLiteral') return [node.value];
    if (node.type === 'Identifier') {
      const enumValues = this.enumValuesAt(node.name, node.start);
      if (enumValues) return enumValues;
      // A shadowed or reassigned name could resolve to a DIFFERENT value at
      // this position than the binding we kept — refuse, so the path
      // surfaces as unresolved instead of mis-scanned.
      if (this.shadowedNames.has(node.name) || this.reassignedNames.has(node.name)) return null;
      const b = this.bindings.get(node.name);
      if (!b) return null;
      if (b.kind === 'string') return [b.value];
      if (b.kind === 'array') {
        if (this.mutatedArrays && this.mutatedArrays.has(node.name)) return null;
        return stringLiteralArray({ type: 'ArrayExpression', elements: b.elements });
      }
    }
    return null;
  }

  /** Could this first argument be a mount path rather than a handler? */
  couldBePath(node) {
    if (!node) return false;
    if (['StringLiteral', 'RegExpLiteral', 'TemplateLiteral', 'ArrayExpression'].includes(node.type)) {
      if (node.type === 'ArrayExpression') {
        // An array of handlers vs an array of paths: paths are strings /
        // regexes / spreads of them ([...PATHS] resolves via resolveStrings,
        // or fails to an UNRESOLVED path — never a handler at the mount root).
        return node.elements.every((el) => el
          && (['StringLiteral', 'RegExpLiteral', 'TemplateLiteral'].includes(el.type)
            || (el.type === 'SpreadElement' && el.argument.type === 'Identifier')));
      }
      return true;
    }
    if (node.type === 'Identifier') {
      if (this.enumValuesAt(node.name, node.start)) return true;
      // Still path-SHAPED when shadowed: couldBePath stays true so the verb
      // branch shifts it as a path; resolveStrings then refuses, leaving an
      // UNRESOLVED path (a problem when public) rather than a wrong one.
      const b = this.bindings.get(node.name);
      if (b && b.kind === 'string') return true;
      // A const bound to a path-shaped array (strings/regexes/templates/
      // spreads) is a path list — resolvePaths() expands it, or refuses to
      // an UNRESOLVED path, never a handler at the mount root.
      if (b && b.kind === 'array'
        && b.elements.every((el) => el
          && (['StringLiteral', 'RegExpLiteral', 'TemplateLiteral'].includes(el.type)
            || (el.type === 'SpreadElement' && el.argument.type === 'Identifier')))) return true;
      return false;
    }
    return false;
  }

  /**
   * True when a first argument is an Identifier that could plausibly be a
   * path constant rather than a handler: unbound, bound to a non-string
   * value we cannot see, or a member of a non-middleware/non-route module.
   */
  ambiguousFirstArg(node) {
    if (!node || node.type !== 'Identifier') return false;
    if (this.routers.has(node.name)) return false;
    const b = this.bindings.get(node.name);
    if (!b) return true;
    if (b.kind === 'function' || b.kind === 'array' || b.kind === 'router' || b.kind === 'call') return false;
    if (b.kind === 'requireMember' || b.kind === 'require') {
      const mod = b.module || '';
      if (mod.startsWith('server/middleware/') || mod.startsWith('server/routes/')) return false;
      if (this.scanner.registry.lookup(mod, b.name)) return false;
      return true;
    }
    return true; // 'other', 'alias', 'string' (handled by couldBePath)
  }

  /**
   * The binding for `name`, or null when the name is shadowed/reassigned —
   * every PROVENANCE decision must refuse an ambiguous name (a block-local
   * `express` could make a fake .json()/.Router() look package-trusted).
   */
  cleanBinding(name) {
    if (this.shadowedNames.has(name) || this.reassignedNames.has(name)) return null;
    return this.bindings.get(name) || null;
  }

  /**
   * True when `node` (an Identifier or require() call) resolves to a
   * node_modules import — i.e. code that cannot construct one of OUR routers.
   */
  isNodeModulesRef(node) {
    if (!node) return false;
    if (isRequireCall(node)) return resolveModulePath(this.file, node.arguments[0].value) === null;
    if (node.type === 'Identifier') {
      const b = this.cleanBinding(node.name);
      return Boolean(b && (b.kind === 'require' || b.kind === 'requireMember') && b.module === null);
    }
    return false;
  }

  /**
   * Classify a handler argument. Returns a flat list of
   *   { type: 'guard', name, exempts }      recognised auth guard
   *   { type: 'passthrough', name }         registered reject-or-next middleware
   *   { type: 'router', module, name? }     router exported by another module
   *   { type: 'localRouter', name }         Router() declared in this file
   *   { type: 'static', desc }              express.static(...)
   *   { type: 'middleware', desc }          provably NOT a router (inline
   *                                         function, in-repo function, or a
   *                                         node_modules factory call) — but
   *                                         still NOT auth and may terminate
   *   { type: 'opaque', desc }              could be anything, a router
   *                                         included (NOT auth; rejected in
   *                                         use() calls — fail closed)
   */
  classify(node, depth = 0) {
    if (!node) return [{ type: 'opaque', desc: 'hole' }];
    if (depth > 8) return [{ type: 'opaque', desc: 'too-deep' }];
    const registry = this.scanner.registry;
    switch (node.type) {
      case 'SpreadElement':
        return this.classify(node.argument, depth + 1);
      case 'ArrayExpression':
        return node.elements.flatMap((el) => this.classify(el, depth + 1));
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        // An inline function is definitionally not a Router instance.
        return [{ type: 'middleware', desc: 'inline function' }];
      case 'Identifier': {
        const canon = this.canonName(node.name);
        if (this.shadowedNames.has(node.name) || (canon !== node.name && this.shadowedNames.has(canon))) {
          // Which binding this reference resolves to depends on lexical scope
          // the flat model doesn't track — never credit a shadowed name.
          return [{ type: 'opaque', desc: `${node.name} (shadowed by a nested redeclaration)` }];
        }
        if (this.reassignedNames.has(node.name) || this.reassignedNames.has(canon)) {
          // Written more than once — which value this reference sees depends
          // on execution order (`let gate = noop; router.get('/x', gate, h);
          // gate = realGuard;`). Never credit it.
          return [{ type: 'opaque', desc: `${node.name} (reassigned — value depends on execution order)` }];
        }
        if (this.routers.has(canon)) return [{ type: 'localRouter', name: canon }];
        const b = this.bindings.get(canon);
        if (!b) return [{ type: 'opaque', desc: `unbound identifier ${node.name}` }];
        if (b.kind === 'requireMember') {
          const g = registry.lookup(b.module, b.name);
          if (g && !g.factory) return [{ type: 'guard', name: g.name, exempts: g.exempts }];
          if (registry.lookupPassthrough(b.module, b.name)) return [{ type: 'passthrough', name: b.name }];
          if (b.module === null) {
            // A package export can BE a router — trust only reviewed entries.
            if (registry.lookupPackagePassthrough(b.spec, b.name)) return [{ type: 'passthrough', name: b.name }];
            return [{ type: 'opaque', desc: `${node.name} (unreviewed package export from ${b.spec})` }];
          }
          return this.scanner.classifyModuleName(b.module, b.name, depth + 1, `${node.name} (from ${b.module})`);
        }
        if (b.kind === 'require') {
          if (b.module === null) {
            if (registry.lookupPackagePassthrough(b.spec, '*')) return [{ type: 'passthrough', name: node.name }];
            return [{ type: 'opaque', desc: `${node.name} (unreviewed package export from ${b.spec})` }];
          }
          return [this.scanner.moduleRef(b.module, node.name)];
        }
        if (b.kind === 'array') {
          if (this.mutatedArrays && this.mutatedArrays.has(canon)) {
            return [{ type: 'opaque', desc: `${node.name} (array mutated after its initializer)` }];
          }
          return b.elements.flatMap((el) => this.classify(el, depth + 1));
        }
        if (b.kind === 'function') {
          const g = registry.lookup(this.file, canon, { local: true });
          if (g && !g.factory) return [{ type: 'guard', name: g.name, exempts: g.exempts }];
          if (registry.lookupPassthrough(this.file, canon, { local: true })) return [{ type: 'passthrough', name: canon }];
          // A function declared in this file cannot be a Router instance.
          return [{ type: 'middleware', desc: node.name }];
        }
        if (b.kind === 'call') {
          if (registry.lookupPassthrough(this.file, canon, { local: true })) return [{ type: 'passthrough', name: canon }];
          return this.classify(b.node, depth + 1);
        }
        return [{ type: 'opaque', desc: node.name }];
      }
      case 'CallExpression': {
        if (isRequireCall(node)) {
          return [this.scanner.moduleRef(resolveModulePath(this.file, node.arguments[0].value), node.arguments[0].value)];
        }
        if (this.isRouterFactory(node)) return [{ type: 'opaque', desc: 'inline Router() call' }];
        const c = node.callee;
        if (c.type === 'MemberExpression' && !c.computed && c.property.name === 'static'
          && ((isRequireCall(c.object) && c.object.arguments[0].value === 'express')
            || (c.object.type === 'Identifier'
              && ((this.cleanBinding(c.object.name) || {}).kind === 'require')
              && (this.cleanBinding(c.object.name) || {}).spec === 'express'))) {
          // Provenance-checked like Router(): only require('express').static
          // counts — an in-repo helper.static() could return a router whose
          // routes would hide behind an existing STATIC allowlist key. The
          // identity binds the RESOLVED root (an identifier's initializer),
          // so re-pointing the directory constant forces re-review.
          const arg = node.arguments[0];
          let desc = arg ? this.src.slice(arg.start, arg.end) : '';
          if (arg && arg.type === 'Identifier') {
            const b = this.cleanBinding(arg.name);
            if (b && b.kind === 'string') desc = `${arg.name} = '${b.value}'`;
            else if (b && b.kind === 'call' && b.node) {
              desc = `${arg.name} = ${this.src.slice(b.node.start, b.node.end).replace(/\s+/g, ' ').slice(0, 120)}`;
            } else desc = `${arg.name} = <unresolved>`;
          }
          return [{ type: 'static', desc }];
        }
        if (c.type === 'CallExpression' && this.isNodeModulesRef(c)) {
          // require('express-rate-limit')({...}) — node_modules factory call.
          // A package factory CAN return a router — only reviewed entries pass.
          const spec = c.arguments[0].value;
          if (registry.lookupPackagePassthrough(spec, null)) return [{ type: 'passthrough', name: spec }];
          return [{ type: 'opaque', desc: `${this.src.slice(c.start, c.end)}(...) — unreviewed package factory` }];
        }
        if (c.type === 'Identifier') {
          if (this.shadowedNames.has(c.name) || this.reassignedNames.has(c.name)) {
            // The callee itself may be a block-local no-op shadowing a real
            // registered factory — never credit it.
            return [{ type: 'opaque', desc: `${c.name}(...) (shadowed or reassigned callee)` }];
          }
          const b = this.bindings.get(c.name);
          if (b && b.kind === 'requireMember') {
            const g = registry.lookup(b.module, b.name);
            if (g && g.factory) return [{ type: 'guard', name: g.name, exempts: g.exempts }];
            if (registry.lookupPassthrough(b.module, b.name)) return [{ type: 'passthrough', name: b.name }];
          }
          if (b && b.kind === 'function') {
            const g = registry.lookup(this.file, c.name, { local: true });
            if (g && g.factory) return [{ type: 'guard', name: g.name, exempts: g.exempts }];
            if (registry.lookupPassthrough(this.file, c.name, { local: true })) return [{ type: 'passthrough', name: c.name }];
          }
          if (this.isNodeModulesRef(c)) {
            // A package factory CAN return a router (some packages export
            // router factories) — only registry-reviewed entries count.
            if (registry.lookupPackagePassthrough(b.spec, b.kind === 'requireMember' ? b.name : null)) {
              return [{ type: 'passthrough', name: c.name }];
            }
            return [{ type: 'opaque', desc: `${c.name}(...) — unreviewed package factory (${b.spec})` }];
          }
          return [{ type: 'opaque', desc: `${c.name}(...)` }];
        }
        if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier'
          && (this.isNodeModulesRef(c.object)
            || (isRequireCall(c.object) && resolveModulePath(this.file, c.object.arguments[0].value) === null))) {
          // express.json(...), bodyParser.raw(...) — node_modules member call.
          const spec = isRequireCall(c.object) ? c.object.arguments[0].value : (this.cleanBinding(c.object.name) || {}).spec;
          if (spec && registry.lookupPackagePassthrough(spec, c.property.name)) {
            return [{ type: 'passthrough', name: `${spec}.${c.property.name}` }];
          }
          return [{ type: 'opaque', desc: `${this.src.slice(c.start, c.end)}(...) — unreviewed package factory` }];
        }
        return [{ type: 'opaque', desc: this.src.slice(c.start, c.end) + '(...)' }];
      }
      case 'MemberExpression': {
        if (node.computed || node.property.type !== 'Identifier') return [{ type: 'opaque', desc: 'computed member' }];
        let mod = null;
        let modKnown = false;
        let spec = null;
        if (isRequireCall(node.object)) { spec = node.object.arguments[0].value; mod = resolveModulePath(this.file, spec); modKnown = true; }
        else if (node.object.type === 'Identifier') {
          const b = this.cleanBinding(node.object.name);
          if (b && b.kind === 'require') { mod = b.module; spec = b.spec; modKnown = true; }
        }
        if (modKnown && mod === null) {
          // A package member can BE a router — trust only reviewed entries.
          if (registry.lookupPackagePassthrough(spec, node.property.name)) {
            return [{ type: 'passthrough', name: `${spec}.${node.property.name}` }];
          }
          return [{ type: 'opaque', desc: `${this.src.slice(node.start, node.end)} — unreviewed package export` }];
        }
        if (mod) {
          const g = registry.lookup(mod, node.property.name);
          if (g && !g.factory) return [{ type: 'guard', name: g.name, exempts: g.exempts }];
          if (registry.lookupPassthrough(mod, node.property.name)) return [{ type: 'passthrough', name: node.property.name }];
          return this.scanner.classifyModuleName(mod, node.property.name, depth + 1, this.src.slice(node.start, node.end));
        }
        return [{ type: 'opaque', desc: this.src.slice(node.start, node.end) }];
      }
      default:
        return [{ type: 'opaque', desc: node.type }];
    }
  }
}

// ---------------------------------------------------------------------------
// Guard registry
// ---------------------------------------------------------------------------

class GuardRegistry {
  constructor(json) {
    if (!json || !Array.isArray(json.guards)) throw new Error('route-auth-guards.json must have a "guards" array');
    this.entries = json.guards.map((g) => {
      if (!g.name || !g.module) throw new Error(`guard entry missing name/module: ${JSON.stringify(g)}`);
      return {
        name: g.name,
        module: g.module,
        local: Boolean(g.local),
        factory: Boolean(g.factory),
        exempts: Array.isArray(g.exempts) ? g.exempts : [],
      };
    });
    // Reviewed reject-or-next middleware (never serves protected data): a
    // guard placed AFTER one of these still counts. Any UNregistered
    // middleware before a guard voids the guard — fail closed.
    this.passthroughs = (Array.isArray(json.passthroughs) ? json.passthroughs : []).map((p) => {
      if (!p.name || !p.module) throw new Error(`passthrough entry missing name/module: ${JSON.stringify(p)}`);
      return { name: p.name, module: p.module, local: Boolean(p.local), package: Boolean(p.package) };
    });
    // Functions reviewed as safe to RECEIVE the app/a router without
    // registering routes on it (http.createServer, Sentry's error handler).
    this.routerConsumers = (Array.isArray(json.routerConsumers) ? json.routerConsumers : []).map((r) => {
      if (!r.name || !r.module) throw new Error(`routerConsumers entry missing name/module: ${JSON.stringify(r)}`);
      return { name: r.name, module: r.module, appOnly: Boolean(r.appOnly) };
    });
  }

  lookup(module, name, { local = false } = {}) {
    return this.entries.find((g) => g.module === module && g.name === name && g.local === local) || null;
  }

  lookupRouterConsumer(moduleOrSpec, name) {
    return this.routerConsumers.find((r) => r.module === moduleOrSpec && r.name === name) || null;
  }

  lookupPassthrough(module, name, { local = false } = {}) {
    return this.passthroughs.find((p) => !p.package && p.module === module && p.name === name && p.local === local) || null;
  }

  /**
   * Package passthroughs: a factory CALL whose callee is require('<module>')
   * (member === null) or require('<module>').<member>. The reviewed claim is
   * that the package's produced middleware only rejects or next()s.
   */
  lookupPackagePassthrough(spec, member) {
    return this.passthroughs.find((p) => p.package && p.module === spec
      && (member === null ? (p.name === '*') : p.name === member)) || null;
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function pathToken(p) {
  if (typeof p === 'string') return p;
  return `<re:${p.regex}${p.flags ? `/${p.flags}` : ''}>`;
}

function joinPaths(prefix, sub) {
  const a = prefix === '/' ? '' : prefix.replace(/\/+$/, '');
  let b = pathToken(sub);
  if (b === '/' || b === '') return a || '/';
  if (!b.startsWith('/') && !b.startsWith('<re:')) b = `/${b}`;
  const joined = `${a}${b}`;
  return joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
}

/** Express `use(prefix)` matches when the path equals the prefix or continues at a segment boundary. */
function prefixMatches(prefix, fullPath) {
  if (prefix === '/' || prefix === '') return true;
  if (prefix.startsWith('<re:')) return false; // conservative: regex scopes never count
  const p = prefix.replace(/\/+$/, '');
  return fullPath === p || fullPath.startsWith(`${p}/`);
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

class Scanner {
  /**
   * @param {object} opts
   * @param {string} [opts.root] repo root
   * @param {object} [opts.files] virtual files { relPath: source } (tests)
   * @param {object} [opts.registry] parsed route-auth-guards.json
   * @param {string} [opts.appFile]
   */
  constructor(opts = {}) {
    this.root = opts.root || REPO_ROOT;
    this.virtual = opts.files || null;
    this.appFile = opts.appFile || APP_FILE;
    const registryJson = opts.registry || JSON.parse(this.read(GUARD_REGISTRY_FILE));
    this.registry = new GuardRegistry(registryJson);
    this.modules = new Map();
    this.routes = [];
    this.problems = [];
  }

  exists(rel) {
    if (this.virtual) return Object.prototype.hasOwnProperty.call(this.virtual, rel);
    return fs.existsSync(path.join(this.root, rel));
  }

  read(rel) {
    if (this.virtual) {
      if (!this.exists(rel)) throw new Error(`route-surface: virtual file missing: ${rel}`);
      return this.virtual[rel];
    }
    return fs.readFileSync(path.join(this.root, rel), 'utf8');
  }

  module(rel) {
    if (!this.modules.has(rel)) {
      const m = new ModuleAnalysis(rel, this.read(rel), this);
      this.modules.set(rel, m);
      this.problems.push(...m.problems);
    }
    return this.modules.get(rel);
  }

  /** A reference to another module used as a handler: router or opaque. */
  moduleRef(rel, label) {
    if (!rel || !this.exists(rel)) return { type: 'opaque', desc: `module ${label}` };
    const m = this.module(rel);
    if (m.exportedRouter) return { type: 'router', module: rel };
    return { type: 'opaque', desc: `module ${rel} (no exported Router)` };
  }

  /**
   * Classify a NAMED export/member of another module by resolving the name in
   * that module's own bindings (guard, passthrough, function → middleware,
   * Router → mountable router, ...). Fail closed to opaque when unresolvable.
   */
  classifyModuleName(rel, name, depth, label) {
    if (!rel || !this.exists(rel)) return [{ type: 'opaque', desc: label }];
    const m = this.module(rel);
    // Resolve the FINAL export mapping, never an internal binding that
    // merely shares the requested name (`module.exports = { api: leak }`).
    const exp = m.exportLookup(name);
    if (exp.kind !== 'ident') {
      return [{ type: 'opaque', desc: `${label} → export not statically resolvable` }];
    }
    return m.classify({ type: 'Identifier', name: exp.name }, depth).map((h) => {
      if (h.type === 'localRouter') return { type: 'router', module: rel, name: h.name };
      if (h.type === 'opaque') return { type: 'opaque', desc: `${label} → ${h.desc}` };
      return h;
    });
  }

  scan() {
    const app = this.module(this.appFile);
    this.walkRouter(app, 'app', {
      prefix: '/', mountGuards: [], inEffect: [], mountLabel: '/', mountRouter: this.appFile,
      mountConditional: false, mountCond: null,
    });
    this.checkExternalRouterMutations();
    return this.result();
  }

  /**
   * A module can require another module's router and register routes on it
   * (`require('./shared-router').get('/leak', h)`, or via a binding) — a
   * side-effect installer the mount-graph walk never opens. Sweep EVERY
   * server file (mounted or not) and reject registrations that target a
   * router owned by a module in the mounted surface: routes registered
   * outside the owning module are invisible to its guard ordering.
   */
  checkExternalRouterMutations() {
    const flag = (m) => {
      for (const x of m.externalRouterRegs || []) {
        if (!this.modules.has(x.module)) continue; // target is not mounted surface
        const t = this.modules.get(x.module);
        const targetsRouter = x.name ? t.routers.has(t.canonName(x.name)) : Boolean(t.exportedRouter);
        if (targetsRouter) {
          this.problems.push(`${x.loc}: ${x.method}() on the router exported by ${x.module} — routes registered outside the owning module bypass its guard ordering; register them in ${x.module}`);
        }
      }
    };
    for (const m of [...this.modules.values()]) flag(m);
    for (const rel of this.listServerFiles()) {
      if (this.modules.has(rel)) continue;
      let m;
      try { m = new ModuleAnalysis(rel, this.read(rel), this); } catch (err) {
        // The sweep exists to catch side-effect installers — a file it
        // cannot analyze could hide one. Fail closed.
        this.problems.push(`${rel}: side-effect sweep cannot analyze this file (${err.message}) — fix its shape or move it out of server/`);
        continue;
      }
      flag(m); // its OTHER problems are ignored — the file is not mounted surface
    }
  }

  listServerFiles() {
    if (this.virtual) return Object.keys(this.virtual);
    const out = [];
    const walkDir = (dir) => {
      for (const e of fs.readdirSync(path.join(this.root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || rel === 'server/tests') continue;
          walkDir(rel);
        } else if (e.name.endsWith('.js')) out.push(rel);
      }
    };
    walkDir('server');
    return out;
  }

  /**
   * Process the ordered registrations of one router object in one module.
   * @param {ModuleAnalysis} m
   * @param {string} objectName  'app' or a Router() identifier
   * @param {object} ctx { prefix, mountGuards, inEffect, mountLabel, mountRouter }
   */
  walkRouter(m, objectName, ctx, depth = 0) {
    if (depth > 8) {
      this.problems.push(`${m.file}: router nesting deeper than 8 — refusing to continue`);
      return;
    }
    const inEffect = [...ctx.inEffect];
    // router.param() callbacks run BEFORE a matched route's own middleware
    // stack, so an unproven callback can answer the request ahead of any
    // per-route guard. Collect the params whose callback is not provably a
    // guard/passthrough; routes whose path uses one of them get their
    // per-route guards voided (mount-level guards still count — they run
    // before the router entirely).
    const unsafeParams = new Set();
    for (const reg of m.registrations) {
      if (reg.object !== objectName || reg.method !== 'param') continue;
      const nameArg = reg.args[0];
      const handlers = reg.args.slice(1).flatMap((a) => m.classify(a));
      const proven = handlers.length > 0 && handlers.every((h) => h.type === 'guard' || h.type === 'passthrough');
      if (proven) continue;
      if (nameArg && nameArg.type === 'StringLiteral') unsafeParams.add(nameArg.value);
      else unsafeParams.add('*'); // unresolvable param name covers every param
    }
    const pathUsesUnsafeParam = (p) => {
      if (unsafeParams.size === 0 || typeof p !== 'string') return false;
      if (unsafeParams.has('*') && p.includes(':')) return true;
      return [...p.matchAll(/:([A-Za-z0-9_]+)/g)].some((mm) => unsafeParams.has(mm[1]));
    };
    for (const reg of m.registrations) {
      if (reg.object !== objectName) continue;
      if (reg.method === 'route' || reg.method === '<computed>' || reg.method === 'param') continue; // route/<computed>: already a problem
      const args = [...reg.args];
      let paths = ['/'];
      let pathResolved = true;
      let pathHandled = false;
      if (args.length && args[0].type === 'SpreadElement') {
        // router.get(...['/leak', h]) — expand an inline array spread so the
        // real path is seen; any other spread is an UNRESOLVED path, never a
        // handler list at the mount root.
        if (args[0].argument.type === 'ArrayExpression') {
          args.splice(0, 1, ...args[0].argument.elements.filter(Boolean));
        } else {
          paths = [`<unresolved:${m.src.slice(args[0].start, args[0].end)}>`];
          pathResolved = false;
          args.shift();
          pathHandled = true;
        }
      }
      if (pathHandled) {
        // path settled above
      } else if (args.length && m.couldBePath(args[0])) {
        const resolved = m.resolvePaths(args[0]);
        if (resolved) paths = resolved;
        else { paths = [`<unresolved:${m.src.slice(args[0].start, args[0].end)}>`]; pathResolved = false; }
        args.shift();
      } else if (reg.method !== 'use' && args.length
        && !['ArrowFunctionExpression', 'FunctionExpression', 'ArrayExpression'].includes(args[0].type)
        && !(args[0].type === 'Identifier' && !m.ambiguousFirstArg(args[0]))) {
        // Express verbs take a leading path. An expression we cannot resolve
        // ('/api/' + x, PATHS.leak) must be treated as an UNRESOLVED path —
        // reading it as a handler would silently file the route under the
        // mount root, where an existing allowlist entry could mask it.
        paths = [`<unresolved:${m.src.slice(args[0].start, args[0].end)}>`];
        pathResolved = false;
        args.shift();
      } else if (args.length && m.ambiguousFirstArg(args[0])) {
        // An identifier that is neither a resolvable string nor a known
        // handler shape could be a path constant — refuse to guess, because
        // mis-reading a path as a handler would hide the real route.
        this.problems.push(`${m.loc(reg.node)}: cannot classify first argument "${args[0].name}" (path or handler?) — use a literal path or a top-level string/array binding`);
        continue;
      }
      // Order-preserving AND fail closed: Express runs middleware
      // left-to-right, and ANY unrecognised handler may terminate the request
      // before a later guard ever runs (`router.get('/x', publicHandler,
      // guardA, realHandler)` serves from publicHandler unauthenticated). So
      // a guard only counts while everything BEFORE it in the argument list
      // is itself a guard or a registered reject-or-next passthrough; the
      // first anything-else voids every later guard in the call.
      const handlers = args.flatMap((a) => m.classify(a));
      const ownGuards = [];
      const routerRefs = [];
      const statics = [];
      {
        let chainIntact = true;
        for (const h of handlers) {
          if (h.type === 'guard') { if (chainIntact) ownGuards.push(h); continue; }
          if (h.type === 'passthrough') continue;
          if (h.type === 'router' || h.type === 'localRouter') routerRefs.push({ ...h, precedingGuards: [...ownGuards] });
          else if (h.type === 'static') statics.push({ ...h, precedingGuards: [...ownGuards] });
          chainIntact = false;
        }
      }

      if (reg.method === 'use') {
        // An OPAQUE handler in use() could itself be a router built by a
        // factory or re-exported in a shape the scanner cannot see — its
        // routes would silently bypass the allowlist. Reject it (fail
        // closed); provable non-routers ('middleware') stay silent.
        for (const h of handlers) {
          if (h.type === 'opaque') {
            this.problems.push(`${m.loc(reg.node)}: cannot prove use() handler "${h.desc}" is not a router — mount routers directly, or use an inline/in-repo function or a registered guard/passthrough`);
          }
        }
        const middlewareDescs = handlers.filter((h) => h.type === 'middleware').map((h) => h.desc);
        for (const p of paths) {
          const scope = joinPaths(ctx.prefix, p);
          const inEffectFor = (p2) => (reg.topLevel ? inEffectGuards(inEffect, p2) : []);
          if (middlewareDescs.length) {
            // Terminal-capable middleware is real surface: Express runs it
            // for every request under the scope (scope '/' = EVERY request)
            // and it may answer without calling next() (`app.use('/api/leak',
            // (req, res) => res.json(data))`), so it is inventoried as a USE
            // entry and must be allowlisted when unguarded. Registered
            // passthroughs are exempt.
            this.routes.push(this.makeRoute({
              method: 'USE', fullPath: scope, routerFile: m.file, mountPrefix: ctx.mountLabel,
              guards: [...ctx.mountGuards, ...ownGuards.map((g) => ({ ...g, baseScope: scope })), ...inEffectFor(scope)],
              resolved: pathResolved, conditional: ctx.mountConditional || !reg.topLevel, cond: [ctx.mountCond, reg.cond].filter(Boolean).join(' && ') || null, extra: middlewareDescs.join(' + '), loc: m.loc(reg.node),
            }));
          }
          if (routerRefs.length === 0 && statics.length === 0) {
            // Pure middleware. Only guards matter for the model.
            const useGuards = ownGuards.map((g) => ({ ...g, baseScope: scope }));
            if (useGuards.length === 0) continue;
            if (!pathResolved) {
              this.problems.push(`${m.loc(reg.node)}: guard ${useGuards.map((g) => g.name).join(',')} mounted on an unresolvable path — make the path a literal`);
              continue;
            }
            if (!reg.topLevel) {
              this.problems.push(`${m.loc(reg.node)}: guard ${useGuards.map((g) => g.name).join(',')} is registered inside a block/function (conditional) — it is NOT counted; move it to module top level`);
              continue;
            }
            inEffect.push({ scope, guards: useGuards });
            continue;
          }
          for (const s of statics) {
            this.routes.push(this.makeRoute({
              method: 'STATIC', fullPath: scope, routerFile: m.file, mountPrefix: ctx.mountLabel,
              guards: [...ctx.mountGuards, ...s.precedingGuards.map((g) => ({ ...g, baseScope: scope })), ...inEffectFor(scope)],
              resolved: pathResolved, conditional: ctx.mountConditional || !reg.topLevel, cond: [ctx.mountCond, reg.cond].filter(Boolean).join(' && ') || null, extra: s.desc, loc: m.loc(reg.node),
            }));
          }
          for (const ref of routerRefs) {
            const childCtx = {
              prefix: scope,
              mountGuards: [...ctx.mountGuards, ...ref.precedingGuards.map((g) => ({ ...g, baseScope: scope }))],
              // A mount inside a function/block executes at an unknowable
              // time relative to the module's top-level use() guards — give
              // it NO source-order guard credit (fail closed).
              inEffect: reg.topLevel ? [...inEffect] : [],
              // A conditional MOUNT makes every descendant route conditional;
              // the predicate chain rides into their identities so moving or
              // re-predicating the mount forces re-review.
              mountConditional: ctx.mountConditional || !reg.topLevel,
              mountCond: [ctx.mountCond, reg.cond].filter(Boolean).join(' && ') || null,
              mountLabel: scope,
              mountRouter: ref.type === 'router' ? ref.module : m.file,
            };
            if (!pathResolved) {
              this.problems.push(`${m.loc(reg.node)}: router mounted on an unresolvable path`);
              continue;
            }
            if (ref.type === 'router') {
              const child = this.module(ref.module);
              this.walkRouter(child, ref.name || child.exportedRouter, childCtx, depth + 1);
            } else {
              this.walkRouter(m, ref.name, { ...childCtx, mountLabel: ctx.mountLabel, mountRouter: ctx.mountRouter }, depth + 1);
            }
          }
        }
        continue;
      }

      // A verb registration = one route per expanded path. A registration
      // inside a function/block may execute at any time relative to the
      // module's top-level use() guards, so it gets no source-order credit.
      const method = (reg.method === 'del' ? 'delete' : reg.method).toUpperCase();
      for (const p of paths) {
        const fullPath = joinPaths(ctx.prefix, p);
        const paramVoided = pathUsesUnsafeParam(pathToken(p));
        this.routes.push(this.makeRoute({
          method, fullPath, routerFile: m.file, mountPrefix: ctx.mountLabel,
          guards: [
            ...ctx.mountGuards,
            ...(paramVoided ? [] : ownGuards).map((g) => ({ ...g, baseScope: ctx.prefix })),
            ...(reg.topLevel ? inEffectGuards(inEffect, fullPath) : []),
          ],
          resolved: pathResolved, conditional: ctx.mountConditional || !reg.topLevel, cond: [ctx.mountCond, reg.cond].filter(Boolean).join(' && ') || null, loc: m.loc(reg.node),
        }));
      }
    }
  }

  makeRoute({ method, fullPath, routerFile, mountPrefix, guards, resolved, conditional, cond, extra, loc }) {
    const effective = guards.filter((g) => !isExempt(g, method, fullPath));
    const names = [...new Set(effective.map((g) => g.name))];
    return {
      method,
      path: fullPath,
      router: routerFile,
      mount: mountPrefix,
      conditional: Boolean(conditional),
      cond: conditional ? (cond || null) : null,
      guards: names,
      public: names.length === 0,
      resolved,
      extra: extra || null,
      loc,
    };
  }

  result() {
    const problems = [...this.problems];
    for (const r of this.routes) {
      if (!r.resolved && r.public) {
        problems.push(`${r.loc}: unguarded route with an unresolvable path (${r.method} ${r.path}) — the scanner cannot prove what it exposes`);
      }
    }
    // A PUBLIC route registered inside a FUNCTION is deferred: whether and
    // under what condition the function runs is invisible to the identity
    // (`if (dev) install()` and bare `install()` key identically), so a
    // conditionally-invoked debug route could lose its guard without
    // re-review. Public surface must be registered at module level.
    for (const r of this.routes) {
      if (r.public && r.conditional && /(^|( && ))function( [A-Za-z0-9_$]+)?(( && )|$)/.test(r.cond || '')) {
        problems.push(`${r.loc}: public route ${r.method} ${r.path} is registered inside a function — its invocation conditions are unknowable; register it at module top level (or guard it)`);
      }
    }
    // Two PUBLIC routes from different source locations must never share one
    // allowlist identity — the second would silently reuse the first's
    // approval (e.g. a new anonymous pathless middleware landing on the
    // already-approved `USE / (inline function)` key). Identical keys from
    // ONE registration (path normalization of '/estimate' + '/estimate/')
    // are a single responder and stay legal.
    const byKey = new Map();
    for (const r of this.routes) {
      if (!r.public) continue;
      const key = routeKey(r);
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(r.loc);
    }
    for (const [key, locs] of byKey) {
      if (locs.size > 1) {
        problems.push(`${[...locs].join(', ')}: ${locs.size} public routes share the allowlist identity "${key}" — give each a distinct shape (a named middleware function, a distinct scope) so approvals cannot be reused`);
      }
    }
    return {
      routes: this.routes,
      publicRoutes: this.routes.filter((r) => r.public),
      problems,
      modules: [...this.modules.keys()],
    };
  }
}

function inEffectGuards(inEffect, fullPath) {
  const out = [];
  for (const e of inEffect) if (prefixMatches(e.scope, fullPath)) out.push(...e.guards);
  return out;
}

/**
 * A guard's exempts are paths relative to WHERE THE GUARD EXECUTES (its
 * baseScope — Express strips the mount prefix from req.path inside mounted
 * middleware), so a guard mounted above a nested router still matches the
 * path shape its own code sees at runtime.
 */
function isExempt(guard, method, fullPath) {
  if (!guard.exempts || !guard.exempts.length || typeof fullPath !== 'string') return false;
  const base = guard.baseScope || '/';
  let rel;
  if (base === '/' || base === '') rel = fullPath;
  else if (fullPath === base) rel = '/';
  else if (fullPath.startsWith(`${base}/`)) rel = fullPath.slice(base.length);
  else return false;
  return guard.exempts.some((e) => {
    const [m, p] = e.split(/\s+/);
    // ALL covers every concrete method, so ANY method-specific exemption on
    // the path applies (fail closed: exempting widens the PUBLIC surface).
    return (m === '*' || m === method || method === 'ALL') && p === rel;
  });
}

// ---------------------------------------------------------------------------
// Allowlist shaping
// ---------------------------------------------------------------------------

// The `[conditional]` marker is part of a route's IDENTITY: a registration
// inside an if/function (e.g. the non-production /debug-sentry) approved
// conditionally must re-enter review if it ever moves to unconditional
// top-level registration — the key changes and the allowlist match breaks.
function routeKey(r) {
  return `${r.router} @ ${r.mount} :: ${r.method} ${r.path}${r.extra ? ` (${r.extra})` : ''}${r.conditional ? ` [conditional${r.cond ? `: ${r.cond}` : ''}]` : ''}`;
}

/** Group public routes into allowlist-shaped mounts (reasons blank). */
function toAllowlistShape(publicRoutes) {
  const groups = new Map();
  for (const r of publicRoutes) {
    const k = `${r.router} @ ${r.mount}`;
    if (!groups.has(k)) groups.set(k, { router: r.router, mount: r.mount, reason: '', routes: new Set() });
    groups.get(k).routes.add(`${r.method} ${r.path}${r.extra ? ` (${r.extra})` : ''}${r.conditional ? ` [conditional${r.cond ? `: ${r.cond}` : ''}]` : ''}`);
  }
  return {
    mounts: [...groups.values()].map((g) => ({ ...g, routes: [...g.routes].sort() })),
  };
}

/** Flatten an allowlist document into the same key space as routeKey(). */
function allowlistKeys(doc) {
  const keys = new Map(); // key -> mount entry
  if (!doc || !Array.isArray(doc.mounts)) throw new Error('public-route-allowlist.json must have a "mounts" array');
  for (const m of doc.mounts) {
    if (!m.router || typeof m.mount !== 'string' || !Array.isArray(m.routes)) {
      throw new Error(`allowlist mount entry needs router, mount, routes: ${JSON.stringify(m)}`);
    }
    if (!m.reason || !String(m.reason).trim()) {
      throw new Error(`allowlist mount ${m.router} @ ${m.mount} has no reason — every public mount needs one`);
    }
    for (const route of m.routes) {
      const key = `${m.router} @ ${m.mount} :: ${route}`;
      if (keys.has(key)) throw new Error(`allowlist lists ${key} twice`);
      keys.set(key, m);
    }
  }
  return keys;
}

module.exports = {
  Scanner,
  GuardRegistry,
  ModuleAnalysis,
  routeKey,
  toAllowlistShape,
  allowlistKeys,
  joinPaths,
  prefixMatches,
  REPO_ROOT,
  APP_FILE,
  GUARD_REGISTRY_FILE,
};

if (require.main === module) {
  const result = new Scanner().scan();
  const shaped = toAllowlistShape(result.publicRoutes);
  process.stdout.write(`${JSON.stringify(shaped, null, 2)}\n`);
  if (result.problems.length) {
    process.stderr.write(`\n${result.problems.length} problem(s):\n${result.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exitCode = 1;
  }
  process.stderr.write(`\n${result.routes.length} routes scanned, ${result.publicRoutes.length} public, ${result.modules.length} modules\n`);
}
