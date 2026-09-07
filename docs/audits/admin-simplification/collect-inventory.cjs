#!/usr/bin/env node
'use strict';

// READ-ONLY repository inspection. Writes only the requested local evidence file.
// Does not import application modules, load credentials, query a DB, or use the network.
// This is a bounded audit snapshot collector, not a dead-code deletion authority.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parse } = require('@babel/parser');

const root = path.resolve(__dirname, '../../..');
const output = process.argv[2] || path.join(root, '.tmp/simplification/inventory.json');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const files = new Set(tracked);
const sources = tracked.filter((f) => /\.(?:js|jsx|cjs|mjs)$/.test(f)
  && /^(?:client\/src\/|server\/|shared\/|packages\/|scripts\/|ops\/)/.test(f)
  && !/(?:\.test\.|\/tests\/|\/migrations\/|\/contract-tests\/|\/dev-preview\/)/.test(f));
const modules = {};
const routes = [];
const serverMounts = [];
const parseErrors = [];

function walk(node, visit, parent) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'comments', 'tokens'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, node));
    else if (value && typeof value === 'object') walk(value, visit, node);
  }
}
function literal(node) {
  if (node?.type === 'StringLiteral' || node?.type === 'NumericLiteral' || node?.type === 'BooleanLiteral') return node.value;
  if (node?.type === 'TemplateLiteral') return node.quasis.map((q, i) => q.value.raw + (i < node.expressions.length ? '${…}' : '')).join('');
  return null;
}
function resolve(from, ref) {
  if (!ref?.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), ref));
  return [base, ...['.js', '.jsx', '.cjs', '.mjs', '.json', '/index.js', '/index.jsx'].map((ext) => base + ext)]
    .find((f) => files.has(f)) || null;
}
function jsxName(node) {
  return node?.name || (node?.type === 'JSXMemberExpression' ? `${jsxName(node.object)}.${jsxName(node.property)}` : null);
}

for (const file of sources) {
  if (!fs.existsSync(path.join(root, file))) continue;
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  let ast;
  try { ast = parse(source, { sourceType: 'unambiguous', plugins: ['jsx'], errorRecovery: false }); }
  catch (error) { parseErrors.push({ file, message: error.message }); continue; }
  const m = { imports: [], symbols: [], components: [], choices: [], apiCalls: [], links: [], flags: [], state: [], subscriptions: [], handlers: [], auth: [], tables: [] };
  const imports = {};
  walk(ast, (n, parent) => {
    const line = n.loc?.start.line;
    if (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') {
      const ref = literal(n.source);
      if (ref) {
        m.imports.push({ ref, file: resolve(file, ref), line });
        for (const s of n.specifiers || []) imports[s.local?.name] = resolve(file, ref);
      }
    }
    if (n.type === 'FunctionDeclaration' && n.id && /^[A-Z]/.test(n.id.name)) m.symbols.push({ name: n.id.name, line });
    if (n.type === 'JSXOpeningElement') {
      const name = jsxName(n.name);
      if (/^[A-Z]/.test(name || '')) m.components.push({ name, line });
      if (name === 'Route' && file === 'client/src/App.jsx') {
        const attrs = Object.fromEntries(n.attributes.filter((a) => a.type === 'JSXAttribute').map((a) => [a.name.name, a.value]));
        if (attrs.path) {
          const element = attrs.element;
          const components = [];
          const redirects = [];
          walk(element, (x) => {
            if (x.type === 'JSXOpeningElement') {
              components.push(jsxName(x.name));
              for (const a of x.attributes || []) if (['to', 'tab', 'queryKey'].includes(a.name?.name)) redirects.push({ key: a.name.name, value: literal(a.value) });
            }
          });
          routes.push({ path: literal(attrs.path), line, components, redirects });
        }
      }
    }
    if (n.type === 'ObjectExpression') {
      const props = Object.fromEntries(n.properties.filter((p) => p.type === 'ObjectProperty')
        .map((p) => [p.key.name || literal(p.key), literal(p.value)]));
      if (props.label && (props.key != null || props.id != null)) m.choices.push({ key: props.key ?? props.id, label: props.label, adminOnly: props.adminOnly ?? null, line });
    }
    if (n.type === 'StringLiteral' || n.type === 'TemplateLiteral') {
      const value = literal(n);
      if (typeof value === 'string' && /\/admin(?:\/|\?|$)/.test(value) && value.length < 260 && !/\s/.test(value.replaceAll('${…}', ''))) m.links.push({ value, line });
    }
    if (n.type !== 'CallExpression') return;
    const name = n.callee.name || n.callee.property?.name;
    const object = n.callee.object?.name;
    const first = literal(n.arguments[0]);
    if (file === 'server/index.js' && object === 'app' && name === 'use' && typeof first === 'string') {
      serverMounts.push({ path: first, line, bindings: n.arguments.slice(1).map((a) => a.name).filter(Boolean),
        modules: n.arguments.slice(1).map((a) => a.type === 'CallExpression' && a.callee.name === 'require' ? resolve(file, literal(a.arguments[0])) : imports[a.name]).filter(Boolean) });
    }
    if (n.callee.type === 'Import' || name === 'require') {
      m.imports.push({ ref: first ?? '<dynamic>', file: resolve(file, first), line });
      if (parent?.type === 'VariableDeclarator' && parent.id?.name) imports[parent.id.name] = resolve(file, first);
    }
    if (['fetch', 'adminFetch', 'apiFetch'].includes(name) || (['api', 'axios'].includes(object))) {
      const opts = n.arguments[1]?.properties || [];
      const method = opts.find((p) => p.key?.name === 'method');
      m.apiCalls.push({ method: literal(method?.value) || (name === 'fetch' || /Fetch$/.test(name) ? 'GET/default' : name), target: first ?? '<computed>', line });
    }
    if (/^useFeatureFlag/.test(name || '') || ['isUserFeatureEnabled', 'isGateEnabled'].includes(name)) m.flags.push({ name: first ?? '<computed>', line });
    if (n.callee.object?.name === 'localStorage' || n.callee.object?.name === 'sessionStorage' || ['useSearchParams', 'useParams', 'useBlocker'].includes(name)) m.state.push({ mechanism: object ? `${object}.${name}` : name, key: first, line });
    if (['setInterval', 'addEventListener', 'useSocket'].includes(name) || (object === 'socket' && name === 'on')) m.subscriptions.push({ name: object ? `${object}.${name}` : name, event: first, line });
    if (object === 'router' && ['get', 'post', 'put', 'patch', 'delete', 'use'].includes(name)) {
      const guards = n.arguments.filter((a) => a.type === 'Identifier').map((a) => a.name);
      if (name === 'use') m.auth.push({ guards, line });
      else m.handlers.push({ method: name.toUpperCase(), path: first ?? '<computed>', guards, line });
    }
    if (['db', 'trx', 'knex'].includes(name) && typeof first === 'string') m.tables.push({ table: first, line });
  });
  for (const c of m.components) if (imports[c.name]) c.file = imports[c.name];
  m.importBindings = imports;
  for (const key of Object.keys(m)) if (Array.isArray(m[key]) && m[key].length === 0) delete m[key];
  modules[file] = m;
}

const appBindings = modules['client/src/App.jsx'].importBindings;
// lazyWithRetry(() => import(...)) declarations need the binding to the page.
const app = fs.readFileSync(path.join(root, 'client/src/App.jsx'), 'utf8');
for (const match of app.matchAll(/const\s+(\w+)\s*=\s*lazyWithRetry\(\s*\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)/g)) {
  appBindings[match[1]] = resolve('client/src/App.jsx', match[2]);
}
for (const route of routes) route.modules = [...new Set(route.components.map((c) => appBindings[c]).filter(Boolean))];
const adminStart = routes.findIndex((r) => r.path === '/admin');
const adminRoutes = routes.slice(adminStart).filter((r, i) => i === 0 || !r.path.startsWith('/'));
function closure(roots) {
  const seen = new Set();
  function add(file) {
    if (!file || seen.has(file)) return;
    seen.add(file);
    for (const dep of modules[file]?.imports || []) if (dep.file) add(dep.file);
  }
  roots.forEach(add);
  return [...seen].sort();
}
for (const route of adminRoutes) route.sharedClosure = closure(route.modules);
const adminFiles = new Set(adminRoutes.flatMap((r) => r.sharedClosure));
const candidateLinks = Object.entries(modules).flatMap(([file, m]) => (m.links || []).map((link) => ({ file, ...link })));
const evidence = {
  baseline: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  method: 'Babel AST inspection of tracked source. No application imports, DB, network, or runtime usage inference.',
  limitations: ['Components are imports/JSX references, not proof of mounting.', 'Choices include tabs, sub-tabs and filters; consult enclosing symbols.', 'Relative import closures overapproximate named-export use; package imports and database-held strings need manual evidence.', 'Computed API URLs and dynamic requires are explicitly unresolved.', 'Server guard lists exclude in-handler authorization, which requires manual inspection.', 'No route, endpoint or dependency is declared dead by this collector.'],
  parseErrors,
  authEntryRoutes: routes.filter((r) => r.path?.startsWith('/admin/') && routes.indexOf(r) < adminStart),
  adminRoutes,
  serverMounts,
  modules: Object.fromEntries(Object.entries(modules).filter(([f, m]) => adminFiles.has(f) || f.startsWith('client/src/pages/admin/') || f.startsWith('client/src/components/admin/') || f.startsWith('server/routes/') || m.links)),
  entryPoints: candidateLinks,
};
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ output, adminRoutes: adminRoutes.length, modules: Object.keys(evidence.modules).length, entryPoints: candidateLinks.length, parseErrors }, null, 2));
