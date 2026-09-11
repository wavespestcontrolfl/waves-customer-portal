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
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') return `${named(node.object)}.${named(node.property)}`;
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
      if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
      // `import('../pages/admin/X')` loads a module; it is not a request.
      if (node.callee.type === 'Import') return;
      const callee = named(node.callee);
      const verbRequest = callee.match(/^(?:admin|api)(?:\.|_)?(get|post|put|patch|delete)(?:Strict)?$/i);
      const verbCall = verbRequest || callee.match(/(?:^|\.)(?:admin|api)?(get|post|put|patch|delete)(?:Strict)?$/i);
      // React state setters (`setLinkRequest`) share the suffix but perform no request.
      const requestCall = /(?:fetch|request|(?:^|\.)api)$/i.test(callee) && !/(?:^|\.)set[A-Z]\w*$/.test(callee);
      const localExport = callee === 'URL.createObjectURL' && relative.includes('/admin/');
      const endpoint = normalizedEndpoint(expressionText(node.arguments[0]));
      // Literal admin paths stay visible even through an unfamiliar wrapper.
      // Review distinguishes API adapters from navigation-only affordances.
      if (![verbCall, requestCall, localExport, endpoint].some(Boolean)) return;
      // Dynamic admin request sites must remain in the denominator. A verb
      // such as Map.get alone is not an HTTP request; require a request wrapper.
      const adminWrapper = /^admin(?:\.|_)?(?:fetch|request|get|post|put|patch|delete)(?:Strict)?$/i.test(callee);
      const unresolved = !endpoint && (adminWrapper || ((requestCall || verbRequest) && relative.includes('/admin/')));
      if (![endpoint, unresolved, localExport].some(Boolean)) return;
      const method = localExport ? 'LOCAL_EXPORT' : verbCall ? verbCall[1].toUpperCase()
        : (expressionText(property(node.arguments[1], 'method')) || 'GET').toUpperCase();
      const handler = handlerName(parents);
      const identity = `${relative}|${handler}|${method}|${endpoint || (localExport ? 'local export' : 'dynamic endpoint')}`;
      const occurrence = (occurrences.get(identity) || 0) + 1;
      occurrences.set(identity, occurrence);
      const fingerprint = crypto.createHash('sha256').update(source.slice(node.start, node.end).replace(/\s+/g, ' ')).digest('base64url');
      const id = crypto.createHash('sha256').update(`${identity}|${occurrence}`).digest('hex').slice(0, 24);
      out.push({ id, module: relative.split('/admin/')[1]?.split('/')[0] || 'shared admin',
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
  const out = {};
  for (const file of sourceFiles(path.join(ROOT, 'server/routes'), ref).filter(f => path.basename(f).startsWith('admin-'))) {
    const { source, ast } = parseFile(file, ref);
    const routes = [];
    walk(ast, (node) => {
      if (node.type !== 'CallExpression') return;
      const method = named(node.callee).match(/^router\.(get|post|put|patch|delete)$/)?.[1];
      const endpoint = expressionText(node.arguments[0]);
      if (!method || !endpoint) return;
      const routeGuards = node.arguments.slice(1).filter(a => a.type === 'Identifier').map(named);
      routes.push({ line: node.loc.start.line, method: method.toUpperCase(), path: endpoint, guards: routeGuards });
    });
    out[path.relative(ROOT, file)] = { routerGuard: source.includes('router.use(adminAuthenticate, requireAdmin)') ? 'admin'
      : source.includes('router.use(adminAuthenticate, requireTechOrAdmin)') ? 'technician_or_admin' : 'review_route_guards', routes };
  }
  return out;
}

function checkCoverage(current, manifest, policy, baselineProof = new Set()) {
  const stored = new Map(manifest.actions.map(a => [a.id, a]));
  const errors = [];
  for (const action of current) {
    const previous = stored.get(action.id);
    if (!previous) { errors.push(`New unmapped UI action: ${action.ui.file}:${action.ui.line}`); continue; }
    const tested = previous.tools?.length && previous.tools.every(name => policy[name])
      && Array.isArray(previous.evidence) && previous.evidence.length
      && previous.evidence.every(value => typeof value === 'string' && value.trim())
      && ['permission', 'approval', 'inputsAndEffects'].every(key => typeof previous[key] === 'string'
        && previous[key].trim() && previous[key].trim() !== 'requires_action_review');
    // Partial deliveries keep their unverified scopes in the denominator.
    // Both tested and remaining scopes need explicit reviewed evidence.
    const verifiedScopes = Array.isArray(previous.verifiedScopes) ? previous.verifiedScopes : [];
    const remainingScopes = Array.isArray(previous.remainingScopes) ? previous.remainingScopes : [];
    const partialText = [previous.review, ...verifiedScopes, ...remainingScopes.flatMap(scope => [scope?.scope, scope?.reason])];
    const partialReviewed = [verifiedScopes.length, remainingScopes.length,
      partialText.every(value => typeof value === 'string' && value.trim().length > 0)].every(Boolean);
    const implemented = tested && (previous.status === 'verified' || (previous.status === 'partially_verified' && partialReviewed));
    const exception = ['reviewed_exception', 'reviewed_unmapped'].includes(previous.status)
      && ['review', 'reason'].every(key => typeof previous.exception?.[key] === 'string' && previous.exception[key].trim());
    if ((implemented || exception) && previous.reviewedFingerprint === action.fingerprint) continue;
    if (previous.status !== 'unmapped' || previous.baselineFingerprint !== action.fingerprint || !baselineProof.has(`${action.id}:${action.fingerprint}`)) {
      errors.push(`Changed action needs IB mapping or reviewed exception: ${action.ui.file}:${action.ui.line}`);
    }
  }
  return errors;
}

function verifiedBaselineProof(current, manifest) {
  const stored = new Map(manifest.actions.map(action => [action.id, action]));
  const currentIds = new Set(current.map(action => action.id));
  const relocationCounts = new Map();
  for (const action of current) {
    const from = stored.get(action.id)?.relocatedFrom;
    if (from) relocationCounts.set(from, (relocationCounts.get(from) || 0) + 1);
  }
  const proof = new Set(), sources = new Map(), revisions = new Map();
  for (const action of current) {
    const previous = stored.get(action.id);
    if (previous?.baselineFingerprint !== action.fingerprint) continue;
    const original = stored.get(previous.relocatedFrom);
    // An explicitly reviewed move of an unchanged call retains its unsupported
    // status. It cannot cover a copy, a payload change, or source never on main.
    const relocated = original && !currentIds.has(original.id) && relocationCounts.get(original.id) === 1
      && original.status === 'unmapped' && original.baselineFingerprint === action.fingerprint
      && original.ui.file === action.ui.file
      && typeof previous.relocationReview === 'string' && previous.relocationReview.trim();
    if (previous.relocatedFrom && !relocated) continue;
    const ref = previous.baselineSource || manifest.baselineCommit;
    // Baseline allowances may only name source already merged on main.
    // A contributor's new call plus a matching JSON row is not a baseline.
    if (!revisions.has(ref)) {
      let valid = /^[a-f0-9]{7,40}$/i.test(ref || '');
      if (valid) {
        try { execFileSync('git', ['merge-base', '--is-ancestor', ref, 'origin/main'], { cwd: ROOT, stdio: 'ignore' }); }
        catch { valid = false; }
      }
      revisions.set(ref, valid);
    }
    if (!revisions.get(ref)) continue;
    const key = `${ref}:${action.ui.file}`;
    if (!sources.has(key)) {
      try {
        const source = execFileSync('git', ['show', key], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
        sources.set(key, new Set(frontendSourceCensus(source, action.ui.file).map(row => `${row.id}:${row.fingerprint}`)));
      } catch { sources.set(key, new Set()); }
    }
    const identity = `${action.id}:${action.fingerprint}`;
    const sourceIdentity = `${relocated ? original.id : action.id}:${action.fingerprint}`;
    if (sources.get(key).has(sourceIdentity)) proof.add(identity);
  }
  return proof;
}

function main() {
  const baselineRef = process.argv.includes('--snapshot') ? 'a2bb0bc49' : null;
  const current = frontendCensus(baselineRef);
  if (process.argv.includes('--snapshot')) {
    const backend = backendCensus(baselineRef);
    if (fs.existsSync(MANIFEST)) throw new Error('Baseline already exists. Map changes; do not erase uncovered actions.');
    const manifest = { version: 1, baselineCommit: 'a2bb0bc49', fingerprintEncoding: 'sha256-base64url',
      meaning: 'Source census awaiting capability review. Unmapped baseline rows remain unsupported/unverified, not reviewed exceptions.',
      unmappedDefaults: { tools: [], evidence: [],
        permission: 'requires_action_review', approval: 'requires_action_review', inputsAndEffects: 'requires_action_review',
      },
      actions: current.map(({ fingerprint, ...a }) => ({ ...a, baselineFingerprint: fingerprint, status: 'unmapped' })), backend };
    // Compact records keep this machine-maintained denominator reviewable.
    const encoded = compactManifest(manifest);
    fs.writeFileSync(MANIFEST, encoded + '\n');
    const routeCount = Object.values(backend).reduce((n, group) => n + group.routes.length, 0);
    console.log(`Initial census: ${current.length} UI request/export sites, ${routeCount} backend route registrations. Zero actions claimed verified.`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/services/intelligence-bar/action-policy.json'), 'utf8'));
  const errors = checkCoverage(current, manifest, policy, verifiedBaselineProof(current, manifest));
  const { recorded, unsupported } = coverageCounts(manifest.actions);
  console.log(`IB coverage: ${recorded} recorded UI sites; ${unsupported} unsupported/unverified. ${errors.length} new/changed unmapped sites.`);
  errors.forEach(error => console.error(error));
  process.exitCode = errors.length ? 1 : 0;
}

function coverageCounts(actions) {
  return {
    recorded: actions.length,
    unsupported: actions.filter(a => !['verified', 'reviewed_exception'].includes(a.status)).length,
  };
}

function compactManifest(manifest) {
  const { actions, backend, ...header } = manifest;
  return JSON.stringify(header, null, 2).replace(/\n}$/, ',\n')
    + `  "actions": [\n${actions.map(a => `    ${JSON.stringify(a)}`).join(',\n')}\n  ],\n`
    + `  "backend": {\n${Object.entries(backend).map(([file, group]) => `    ${JSON.stringify(file)}: ${JSON.stringify(group)}`).join(',\n')}\n  }\n}`;
}

if (require.main === module) main();
module.exports = { frontendCensus, frontendSourceCensus, backendCensus, checkCoverage, coverageCounts, verifiedBaselineProof, normalizedEndpoint, compactManifest };
