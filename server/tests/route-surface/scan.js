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

function isRouterFactoryCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const c = node.callee;
  if (c.type === 'Identifier' && c.name === 'Router') return true;
  if (c.type === 'MemberExpression' && !c.computed && c.property.name === 'Router') {
    if (c.object.type === 'Identifier') return true; // express.Router()
    if (isRequireCall(c.object) && c.object.arguments[0].value === 'express') return true;
  }
  return false;
}

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

function nestedCtx(node, ctx) {
  if (!ctx.topLevel) return ctx;
  if (TOP_LEVEL_TRANSPARENT.has(node.type)) return ctx;
  // Entering a function body, block, loop, conditional, etc. — anything
  // registered below here is conditional / deferred.
  return { ...ctx, topLevel: false };
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
    const callsWithIdentifierArgs = [];
    walk(this.ast.program, (node, ctx) => {
      if (node.type === 'CallExpression' && node.arguments.some((a) => a && a.type === 'Identifier')) {
        callsWithIdentifierArgs.push(node);
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        this.recordBinding(node.id.name, node.init, ctx.topLevel);
      } else if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && isRequireCall(node.init)) {
        const mod = resolveModulePath(this.file, node.init.arguments[0].value);
        for (const prop of node.id.properties) {
          if (prop.type !== 'ObjectProperty' || prop.key.type !== 'Identifier') continue;
          const local = prop.value.type === 'Identifier' ? prop.value.name : null;
          if (!local) continue;
          this.setBinding(local, { kind: 'requireMember', module: mod, spec: node.init.arguments[0].value, name: prop.key.name, topLevel: ctx.topLevel });
        }
      } else if (node.type === 'FunctionDeclaration' && node.id) {
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
        && node.left.property.name === 'exports'
        && node.right.type === 'Identifier') {
        this.exportCandidate = node.right.name;
      } else if (node.type === 'CallExpression'
        && node.callee.type === 'MemberExpression'
        && (node.callee.object.type === 'Identifier' || node.callee.object.type === 'CallExpression')) {
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
        } else if (method && (VERBS.has(method) || method === 'use' || method === 'route')) {
          let base = node.callee.object;
          while (base && base.type === 'CallExpression' && !isRouterFactoryCall(base)) {
            base = base.callee && base.callee.type === 'MemberExpression' ? base.callee.object : null;
          }
          if (base && base.type === 'Identifier') objName = base.name;
          else if (base && isRouterFactoryCall(base)) {
            this.problems.push(`${this.loc(node)}: ${method}() chained on an inline Router() call — bind the router to a const so its routes can be attributed`);
          }
        }
        if (objName === null) {
          // not a chain we can attribute (or not a registration shape at all)
        } else if (unresolvedMethod) {
          this.registrations.push({ object: objName, method: '<computed>', args: node.arguments, topLevel: ctx.topLevel, node });
        } else if (method && (VERBS.has(method) || method === 'use' || method === 'route')) {
          this.registrations.push({ object: objName, method, args: node.arguments, topLevel: ctx.topLevel, node });
        }
      }
    }, { topLevel: true });
    // Resolve identifier aliases (`const api = router`) to their canonical
    // binding so registrations made through the alias are still attributed to
    // the router (or the app) — a plain alias mounts routes just as well as
    // the original name, so dropping them would be a fail-open hole.
    for (const [name, b] of this.bindings) {
      if (b.kind === 'alias' && this.routers.has(this.canonName(name))) this.routers.add(name);
    }
    for (const r of this.registrations) r.object = this.canonName(r.object);
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

  recordBinding(name, init, topLevel) {
    if (isRouterFactoryCall(init)) {
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
        if (isRouterFactoryCall(node)) return [{ type: 'opaque', desc: 'inline Router() call' }];
        const c = node.callee;
        if (c.type === 'MemberExpression' && !c.computed && c.property.name === 'static'
          && (c.object.type === 'Identifier' || isRequireCall(c.object))) {
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
          if (middlewareDescs.length) {
            // Terminal-capable middleware is real surface: Express runs it
            // for every request under the scope (scope '/' = EVERY request)
            // and it may answer without calling next() (`app.use('/api/leak',
            // (req, res) => res.json(data))`), so it is inventoried as a USE
            // entry and must be allowlisted when unguarded. Registered
            // passthroughs are exempt.
            this.routes.push(this.makeRoute({
              method: 'USE', fullPath: scope, routerFile: m.file, mountPrefix: ctx.mountLabel,
              guards: [...ctx.mountGuards, ...ownGuards, ...inEffectGuards(inEffect, scope)],
              resolved: pathResolved, extra: middlewareDescs.join(' + '), loc: m.loc(reg.node),
            }));
          }
          if (routerRefs.length === 0 && statics.length === 0) {
            // Pure middleware. Only guards matter for the model.
            const useGuards = ownGuards;
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
              guards: [...ctx.mountGuards, ...s.precedingGuards, ...inEffectGuards(inEffect, scope)],
              resolved: pathResolved, extra: s.desc, loc: m.loc(reg.node),
            }));
          }
          for (const ref of routerRefs) {
            const childCtx = {
              prefix: scope,
              mountGuards: [...ctx.mountGuards, ...ref.precedingGuards],
              inEffect: [...inEffect],
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

      // A verb registration = one route per expanded path.
      const method = reg.method.toUpperCase();
      for (const p of paths) {
        const fullPath = joinPaths(ctx.prefix, p);
        this.routes.push(this.makeRoute({
          method, fullPath, routerFile: m.file, mountPrefix: ctx.mountLabel,
          guards: [...ctx.mountGuards, ...ownGuards, ...inEffectGuards(inEffect, fullPath)],
          resolved: pathResolved, routerRelativePath: pathToken(p), loc: m.loc(reg.node),
        }));
      }
    }
  }

  makeRoute({ method, fullPath, routerFile, mountPrefix, guards, resolved, routerRelativePath, extra, loc }) {
    const effective = guards.filter((g) => !isExempt(g, method, routerRelativePath));
    const names = [...new Set(effective.map((g) => g.name))];
    return {
      method,
      path: fullPath,
      router: routerFile,
      mount: mountPrefix,
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

function isExempt(guard, method, routerRelativePath) {
  if (!guard.exempts || !guard.exempts.length || !routerRelativePath) return false;
  return guard.exempts.some((e) => {
    const [m, p] = e.split(/\s+/);
    return (m === '*' || m === method) && p === routerRelativePath;
  });
}

// ---------------------------------------------------------------------------
// Allowlist shaping
// ---------------------------------------------------------------------------

function routeKey(r) {
  return `${r.router} @ ${r.mount} :: ${r.method} ${r.path}${r.extra ? ` (${r.extra})` : ''}`;
}

/** Group public routes into allowlist-shaped mounts (reasons blank). */
function toAllowlistShape(publicRoutes) {
  const groups = new Map();
  for (const r of publicRoutes) {
    const k = `${r.router} @ ${r.mount}`;
    if (!groups.has(k)) groups.set(k, { router: r.router, mount: r.mount, reason: '', routes: new Set() });
    groups.get(k).routes.add(`${r.method} ${r.path}${r.extra ? ` (${r.extra})` : ''}`);
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
