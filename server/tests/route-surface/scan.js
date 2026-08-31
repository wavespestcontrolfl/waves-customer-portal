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
 *     registered guard/passthrough, an inline or in-repo function, or a
 *     node_modules factory call. Anything opaque (an unresolved identifier, an
 *     in-repo factory call) is rejected as a scanner problem — a factory
 *     could return a router whose routes would bypass the allowlist.
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

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_FILE = 'server/index.js';
const GUARD_REGISTRY_FILE = 'server/config/route-auth-guards.json';
// Every HTTP method Express exposes as a router method (router.checkout,
// router.m-search, ... included) — a route registered under ANY of them is
// surface. `all` is Express's own addition.
const VERBS = new Set([...require('http').METHODS.map((m) => m.toLowerCase()), 'all']);
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
 * Walk the AST, invoking `visit(node, ctx)` for every node. ctx.topLevel is
 * true only while the current statement is a direct child of Program.
 */
function walk(node, visit, ctx) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ctx);
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
  if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
    return src.slice(node.test.start, node.test.end).replace(/\s+/g, ' ').slice(0, 80);
  }
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
    return `${this.file}:${node.loc ? node.loc.start.line : '?'}`;
  }

  collect() {
    this.enumScopes = []; // { name, values, start, end } — lexical loop scopes
    this.bindingWrites = new Map(); // name -> count of value-bearing writes
    this.reassignedNames = new Set(); // written more than once — ambiguous
    const callsWithIdentifierArgs = [];
    const optionalCalls = [];
    const objectLiterals = [];
    const memberAssignments = [];
    walk(this.ast.program, (node, ctx) => {
      if (node.type === 'CallExpression' && node.arguments.some((a) => a && a.type === 'Identifier')) {
        callsWithIdentifierArgs.push(node);
      }
      if (node.type === 'OptionalCallExpression'
        && (node.callee.type === 'OptionalMemberExpression' || node.callee.type === 'MemberExpression')) {
        optionalCalls.push(node);
      }
      if (node.type === 'ObjectExpression') objectLiterals.push(node);
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
        if (node.right.type === 'Identifier') this.exportCandidate = node.right.name;
        else if (node.right.type === 'ObjectExpression') this.exportObjectNode = node.right;
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
          if (method && (VERBS.has(method) || method === 'use' || method === 'route')) {
            this.registrations.push({ object: null, objectNode: node.callee.object, method, args: node.arguments, topLevel: ctx.topLevel, cond: ctx.conds.join(' && ') || null, node });
          }
          return;
        } else if (method && (VERBS.has(method) || method === 'use' || method === 'route')) {
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
        } else if (method && (VERBS.has(method) || method === 'use' || method === 'route')) {
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
    // assigned into a shape the scanner cannot model is rejected.
    for (const a of memberAssignments) {
      const base = this.resolveMemberChain(a.objectNode);
      const b = base ? this.bindings.get(base) : null;
      if (b && b.kind === 'object' && a.right.type === 'Identifier') {
        b.props.set(a.prop, a.right.name);
        continue;
      }
      if (a.right.type === 'Identifier' && this.routers.has(this.canonName(a.right.name))) {
        this.problems.push(`${this.loc(a.node)}: router ${a.right.name} assigned into an object shape the scanner cannot model — register routes via the router identifier, or a one-level object literal bound to a const`);
      }
    }
    for (const r of this.registrations) {
      if (r.objectNode) r.object = this.resolveMemberChain(r.objectNode) || '<member>';
      else r.object = this.canonName(r.object);
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
    if (this.exportCandidate) {
      const canon = this.canonName(this.exportCandidate);
      if (this.routers.has(canon)) this.exportedRouter = canon;
    }
    // Only registrations on real routers (or the app) matter.
    this.registrations = this.registrations.filter((r) => this.routers.has(r.object) || APP_IDENTIFIERS.has(r.object));
    // A router (or the app) passed as an ARGUMENT to a function the scanner
    // does not analyse could have routes registered on it inside that helper
    // (`installRoutes(app)`), invisibly to the walk. Reject it (fail closed).
    // Exempt: methods ON a known router/app (that IS the supported
    // registration path — app.use('/x', router), app.listen, ...) and
    // node_modules callees (http.createServer(app), Sentry error handler —
    // only in-repo code can register in-repo route surface).
    for (const call of callsWithIdentifierArgs) {
      const passed = call.arguments
        .filter((a) => a && a.type === 'Identifier')
        .map((a) => this.canonName(a.name))
        .filter((n) => this.routers.has(n) || APP_IDENTIFIERS.has(n));
      if (!passed.length) continue;
      const c = call.callee;
      if (c.type === 'MemberExpression' && c.object.type === 'Identifier') {
        const objCanon = this.canonName(c.object.name);
        if (this.routers.has(objCanon) || APP_IDENTIFIERS.has(objCanon)) continue;
        if (this.isNodeModulesRef(c.object)) continue;
      }
      if (c.type === 'Identifier' && this.isNodeModulesRef(c)) continue;
      this.problems.push(`${this.loc(call)}: ${passed.join(', ')} passed to an unanalysed function — the scanner cannot see routes the helper may register; register routes at module top level`);
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
      const b = this.bindings.get(c.name);
      return Boolean(b && b.kind === 'requireMember' && b.module === null
        && b.spec === 'express' && b.name === 'Router');
    }
    if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' && c.property.name === 'Router') {
      if (isRequireCall(c.object)) return c.object.arguments[0].value === 'express';
      if (c.object.type === 'Identifier') {
        const b = this.bindings.get(c.object.name);
        return Boolean(b && b.kind === 'require' && b.module === null && b.spec === 'express');
      }
    }
    return false;
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
        return values || null;
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
      if (b.kind === 'array') return stringLiteralArray({ type: 'ArrayExpression', elements: b.elements });
    }
    return null;
  }

  /** Could this first argument be a mount path rather than a handler? */
  couldBePath(node) {
    if (!node) return false;
    if (['StringLiteral', 'RegExpLiteral', 'TemplateLiteral', 'ArrayExpression'].includes(node.type)) {
      if (node.type === 'ArrayExpression') {
        // An array of handlers vs an array of paths: paths are strings/regexes.
        return node.elements.every((el) => el && ['StringLiteral', 'RegExpLiteral', 'TemplateLiteral'].includes(el.type));
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
      // A const bound to an all-string array is a path list, matching the
      // support in resolveStrings() (`const PATHS = ['/a', '/b']`).
      if (b && b.kind === 'array'
        && stringLiteralArray({ type: 'ArrayExpression', elements: b.elements })) return true;
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
   * True when `node` (an Identifier or require() call) resolves to a
   * node_modules import — i.e. code that cannot construct one of OUR routers.
   */
  isNodeModulesRef(node) {
    if (!node) return false;
    if (isRequireCall(node)) return resolveModulePath(this.file, node.arguments[0].value) === null;
    if (node.type === 'Identifier') {
      const b = this.bindings.get(node.name);
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
          if (b.module === null) return [{ type: 'middleware', desc: `${node.name} (node_modules)` }];
          return this.scanner.classifyModuleName(b.module, b.name, depth + 1, `${node.name} (from ${b.module})`);
        }
        if (b.kind === 'require') {
          if (b.module === null) return [{ type: 'middleware', desc: `${node.name} (node_modules)` }];
          return [this.scanner.moduleRef(b.module, node.name)];
        }
        if (b.kind === 'array') return b.elements.flatMap((el) => this.classify(el, depth + 1));
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
              && ((this.bindings.get(c.object.name) || {}).kind === 'require')
              && (this.bindings.get(c.object.name) || {}).spec === 'express'))) {
          // Provenance-checked like Router(): only require('express').static
          // counts — an in-repo helper.static() could return a router whose
          // routes would hide behind an existing STATIC allowlist key.
          const arg = node.arguments[0];
          const desc = arg ? this.src.slice(arg.start, arg.end) : '';
          return [{ type: 'static', desc }];
        }
        if (c.type === 'CallExpression' && this.isNodeModulesRef(c)) {
          // require('express-rate-limit')({...}) — node_modules factory call.
          const spec = c.arguments[0].value;
          if (registry.lookupPackagePassthrough(spec, null)) return [{ type: 'passthrough', name: spec }];
          return [{ type: 'middleware', desc: this.src.slice(c.start, c.end) + '(...)' }];
        }
        if (c.type === 'Identifier') {
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
            // A node_modules factory (rateLimit, cors, morgan, ...) cannot
            // return one of OUR routers — middleware, but never auth.
            if (registry.lookupPackagePassthrough(b.spec, b.kind === 'requireMember' ? b.name : null)) {
              return [{ type: 'passthrough', name: c.name }];
            }
            return [{ type: 'middleware', desc: `${c.name}(...)` }];
          }
          return [{ type: 'opaque', desc: `${c.name}(...)` }];
        }
        if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier'
          && (this.isNodeModulesRef(c.object)
            || (isRequireCall(c.object) && resolveModulePath(this.file, c.object.arguments[0].value) === null))) {
          // express.json(...), bodyParser.raw(...) — node_modules member call.
          const spec = isRequireCall(c.object) ? c.object.arguments[0].value : (this.bindings.get(c.object.name) || {}).spec;
          if (spec && registry.lookupPackagePassthrough(spec, c.property.name)) {
            return [{ type: 'passthrough', name: `${spec}.${c.property.name}` }];
          }
          return [{ type: 'middleware', desc: this.src.slice(c.start, c.end) + '(...)' }];
        }
        return [{ type: 'opaque', desc: this.src.slice(c.start, c.end) + '(...)' }];
      }
      case 'MemberExpression': {
        if (node.computed || node.property.type !== 'Identifier') return [{ type: 'opaque', desc: 'computed member' }];
        let mod = null;
        let modKnown = false;
        if (isRequireCall(node.object)) { mod = resolveModulePath(this.file, node.object.arguments[0].value); modKnown = true; }
        else if (node.object.type === 'Identifier') {
          const b = this.bindings.get(node.object.name);
          if (b && b.kind === 'require') { mod = b.module; modKnown = true; }
        }
        if (modKnown && mod === null) return [{ type: 'middleware', desc: this.src.slice(node.start, node.end) }];
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
  }

  lookup(module, name, { local = false } = {}) {
    return this.entries.find((g) => g.module === module && g.name === name && g.local === local) || null;
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
    return m.classify({ type: 'Identifier', name }, depth).map((h) => {
      if (h.type === 'localRouter') return { type: 'router', module: rel, name: h.name };
      if (h.type === 'opaque') return { type: 'opaque', desc: `${label} → ${h.desc}` };
      return h;
    });
  }

  scan() {
    const app = this.module(this.appFile);
    this.walkRouter(app, 'app', { prefix: '/', mountGuards: [], inEffect: [], mountLabel: '/', mountRouter: this.appFile });
    return this.result();
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
    for (const reg of m.registrations) {
      if (reg.object !== objectName) continue;
      if (reg.method === 'route' || reg.method === '<computed>') continue; // already a problem
      const args = [...reg.args];
      let paths = ['/'];
      let pathResolved = true;
      if (args.length && m.couldBePath(args[0])) {
        const resolved = m.resolvePaths(args[0]);
        if (resolved) paths = resolved;
        else { paths = [`<unresolved:${m.src.slice(args[0].start, args[0].end)}>`]; pathResolved = false; }
        args.shift();
      } else if (reg.method !== 'use' && args.length
        && !['ArrowFunctionExpression', 'FunctionExpression', 'ArrayExpression', 'SpreadElement'].includes(args[0].type)
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
              resolved: pathResolved, conditional: !reg.topLevel, cond: reg.cond, extra: middlewareDescs.join(' + '), loc: m.loc(reg.node),
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
              resolved: pathResolved, conditional: !reg.topLevel, cond: reg.cond, extra: s.desc, loc: m.loc(reg.node),
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
      const method = reg.method.toUpperCase();
      for (const p of paths) {
        const fullPath = joinPaths(ctx.prefix, p);
        this.routes.push(this.makeRoute({
          method, fullPath, routerFile: m.file, mountPrefix: ctx.mountLabel,
          guards: [
            ...ctx.mountGuards,
            ...ownGuards.map((g) => ({ ...g, baseScope: ctx.prefix })),
            ...(reg.topLevel ? inEffectGuards(inEffect, fullPath) : []),
          ],
          resolved: pathResolved, conditional: !reg.topLevel, cond: reg.cond, loc: m.loc(reg.node),
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
    return (m === '*' || m === method) && p === rel;
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
