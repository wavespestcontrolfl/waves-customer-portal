#!/usr/bin/env node
/** READ-ONLY by default. --snapshot creates the initial census once; it never
 * converts later uncovered actions into baseline exceptions. No APIs or DB.
 *
 * A source census is the denominator for review, not proof of parity. Dynamic
 * endpoints and local exports stay explicitly unresolved until mapped by hand.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const parser = require('@babel/parser');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'docs/intelligence-bar-capabilities.json');

function walk(node, visit, parents = []) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node, parents);
  const next = node.type ? [...parents, node] : parents;
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, next));
    else if (value && typeof value === 'object') walk(value, visit, next);
  }
}

function expressionText(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral') return node.quasis.map(q => q.value.cooked || q.value.raw).join(':param');
  if (node.type === 'BinaryExpression' && node.operator === '+') return `${expressionText(node.left) || ':param'}${expressionText(node.right) || ':param'}`;
  return null;
}

function named(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return `${named(node.object)}.${named(node.property)}`;
  return '';
}

function property(node, key) {
  return node?.properties?.find(p => (p.key?.name || p.key?.value) === key)?.value;
}

function handlerName(parents) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i];
    if (p.type === 'FunctionDeclaration' && p.id) return p.id.name;
    if (p.type === 'VariableDeclarator' && /FunctionExpression$/.test(p.init?.type || '')) return named(p.id);
  }
  return 'inline action';
}

function filesBelow(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesBelow(full);
    return /\.(jsx?|tsx?)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [full] : [];
  });
}

function sourceFiles(dir, ref) {
  if (!ref) return filesBelow(dir);
  return execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', path.relative(ROOT, dir)], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(f => /\.(jsx?|tsx?)$/.test(f) && !/\.(test|spec)\./.test(f)).map(f => path.join(ROOT, f));
}

function parseFile(file, ref) {
  const source = ref ? execFileSync('git', ['show', `${ref}:${path.relative(ROOT, file)}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    : fs.readFileSync(file, 'utf8');
  return { source, ast: parser.parse(source, { sourceType: 'unambiguous', plugins: ['jsx', 'typescript'] }) };
}

function normalizedEndpoint(text) {
  if (!text || !text.includes('/admin/')) return null;
  return text.slice(text.indexOf('/admin/')).split('?')[0].replace(/:[a-zA-Z_$][\w$]*/g, ':param');
}

function frontendSourceCensus(source, relative) {
  const out = [];
  const occurrences = new Map();
  const ast = parser.parse(source, { sourceType: 'unambiguous', plugins: ['jsx', 'typescript'] });
    walk(ast, (node, parents) => {
      if (node.type !== 'CallExpression') return;
      const callee = named(node.callee);
      const verbCall = callee.match(/(?:^|\.)(?:admin|api)?(get|post|put|patch|delete)(?:Strict)?$/i);
      const requestCall = /(?:fetch|request|(?:^|\.)api)$/i.test(callee);
      const localExport = callee === 'URL.createObjectURL' && relative.includes('/admin/');
      const endpoint = normalizedEndpoint(expressionText(node.arguments[0]));
      // Literal admin paths stay visible even through an unfamiliar wrapper.
      // Review distinguishes API adapters from navigation-only affordances.
      if (![verbCall, requestCall, localExport, endpoint].some(Boolean)) return;
      // Dynamic admin request sites must remain in the denominator. A verb
      // such as Map.get alone is not an HTTP request; require a request wrapper.
      const unresolved = !endpoint && requestCall && relative.includes('/admin/');
      if (![endpoint, unresolved, localExport].some(Boolean)) return;
      const method = localExport ? 'LOCAL_EXPORT' : verbCall ? verbCall[1].toUpperCase()
        : (expressionText(property(node.arguments[1], 'method')) || 'GET').toUpperCase();
      const handler = handlerName(parents);
      const identity = `${relative}|${handler}|${method}|${endpoint || (localExport ? 'local export' : 'dynamic endpoint')}`;
      const occurrence = (occurrences.get(identity) || 0) + 1;
      occurrences.set(identity, occurrence);
      const fingerprint = crypto.createHash('sha256').update(source.slice(node.start, node.end).replace(/\s+/g, ' ')).digest('hex');
      out.push({ id: `${identity}|${occurrence}`, module: relative.split('/admin/')[1]?.split('/')[0] || 'shared admin',
        ui: { file: relative, line: node.loc.start.line, handler },
        operation: { method, endpoint, resolution: endpoint ? 'literal_or_template' : localExport ? 'local_export' : 'unresolved' },
        fingerprint,
      });
    });
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function frontendCensus(ref) {
  return sourceFiles(path.join(ROOT, 'client/src'), ref).flatMap(file => {
    const { source } = parseFile(file, ref);
    return frontendSourceCensus(source, path.relative(ROOT, file));
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function backendCensus(ref) {
  const out = [];
  for (const file of sourceFiles(path.join(ROOT, 'server/routes'), ref).filter(f => path.basename(f).startsWith('admin-'))) {
    const { source, ast } = parseFile(file, ref);
    walk(ast, (node) => {
      if (node.type !== 'CallExpression') return;
      const method = named(node.callee).match(/^router\.(get|post|put|patch|delete)$/)?.[1];
      const endpoint = expressionText(node.arguments[0]);
      if (!method || !endpoint) return;
      const routeGuards = node.arguments.slice(1).filter(a => a.type === 'Identifier').map(named);
      out.push({ file: path.relative(ROOT, file), line: node.loc.start.line, method: method.toUpperCase(), path: endpoint,
        guards: routeGuards, routerGuard: source.includes('router.use(adminAuthenticate, requireAdmin)') ? 'admin'
          : source.includes('router.use(adminAuthenticate, requireTechOrAdmin)') ? 'technician_or_admin' : 'review_route_guards',
      });
    });
  }
  return out;
}

function checkCoverage(current, manifest, policy) {
  const stored = new Map(manifest.actions.map(a => [a.id, a]));
  const errors = [];
  for (const action of current) {
    const previous = stored.get(action.id);
    if (!previous) { errors.push(`New unmapped UI action: ${action.ui.file}:${action.ui.line}`); continue; }
    const implemented = previous.tools?.length && previous.tools.every(name => policy[name])
      && previous.status === 'verified' && previous.evidence?.length;
    const exception = previous.status === 'reviewed_exception' && previous.exception?.review && previous.exception?.reason;
    if ((implemented || exception) && previous.reviewedFingerprint === action.fingerprint) continue;
    if (previous.baselineFingerprint !== action.fingerprint) errors.push(`Changed action needs IB mapping or reviewed exception: ${action.ui.file}:${action.ui.line}`);
  }
  return errors;
}

function main() {
  const baselineRef = process.argv.includes('--snapshot') ? 'a2bb0bc49' : null;
  const current = frontendCensus(baselineRef);
  const backend = backendCensus(baselineRef);
  if (process.argv.includes('--snapshot')) {
    if (fs.existsSync(MANIFEST)) throw new Error('Baseline already exists. Map changes; do not erase uncovered actions.');
    const manifest = { version: 1, baselineCommit: 'a2bb0bc49',
      meaning: 'Source census awaiting capability review. Unmapped baseline rows remain unsupported/unverified, not reviewed exceptions.',
      actions: current.map(a => ({ ...a, baselineFingerprint: a.fingerprint, status: 'unmapped', tools: [], evidence: [],
        permission: 'requires_action_review', approval: 'requires_action_review', inputsAndEffects: 'requires_action_review',
      })), backend };
    // Compact records keep this machine-maintained denominator reviewable.
    const encoded = compactManifest(manifest);
    fs.writeFileSync(MANIFEST, encoded + '\n');
    console.log(`Initial census: ${current.length} UI request/export sites, ${backend.length} backend route registrations. Zero actions claimed verified.`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/services/intelligence-bar/action-policy.json'), 'utf8'));
  const errors = checkCoverage(current, manifest, policy);
  const unsupported = manifest.actions.filter(a => !['verified', 'reviewed_exception'].includes(a.status)).length;
  console.log(`IB coverage: ${manifest.actions.length} recorded UI sites; ${unsupported} unsupported/unverified. ${errors.length} new/changed unmapped sites.`);
  errors.forEach(error => console.error(error));
  process.exitCode = errors.length ? 1 : 0;
}

function compactManifest(manifest) {
  const { actions, backend, ...header } = manifest;
  return JSON.stringify(header, null, 2).replace(/\n}$/, ',\n')
    + `  "actions": [\n${actions.map(a => `    ${JSON.stringify(a)}`).join(',\n')}\n  ],\n`
    + `  "backend": [\n${backend.map(a => `    ${JSON.stringify(a)}`).join(',\n')}\n  ]\n}`;
}

if (require.main === module) main();
module.exports = { frontendCensus, frontendSourceCensus, backendCensus, checkCoverage, normalizedEndpoint, compactManifest };
