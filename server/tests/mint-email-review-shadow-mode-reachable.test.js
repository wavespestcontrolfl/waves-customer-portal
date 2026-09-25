/**
 * Codex round-3 P1 (finding #3): call-recording-processor.js's shadow-mode
 * email/identity bridge (CALL_EXTRACTION_V2_ENABLED && !DRIVES_ROUTING) used
 * to call mintEmailReviewCardsFenced only INSIDE `if (needsConfirmation.length)`
 * — a full-agreement reprocess (e.g. after an enforce→shadow demotion) has
 * an empty needsConfirmation list and never reached the mint at all, so a
 * stale open V1/V2 disagreement card from an earlier cycle was never
 * superseded.
 *
 * processRecording (the function this bridge lives in) is not practically
 * unit-testable in isolation — it is the pipeline's single giant entry
 * point with dozens of external dependencies. This is instead a structural
 * regression guard, in the same spirit as legacy-service-status-log-guard
 * .test.js: it parses the REAL source with the same parser ESLint uses
 * (espree) and asserts, by AST shape rather than a fragile string/brace
 * scan (the surrounding code has `${...}` template interpolations that
 * would defeat naive brace counting), that the mint call sits OUTSIDE the
 * `if (needsConfirmation.length)` block as a sibling statement in the same
 * try block — i.e. it always runs once per pass, regardless of whether
 * this cycle found anything to confirm.
 */
const fs = require('fs');
const path = require('path');
const espree = require('espree');

const FILE = path.join(__dirname, '../services/call-recording-processor.js');

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return; }
  if (node.type) visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (value && typeof value === 'object') walk(value, visit);
  }
}

function isMintCall(node) {
  return node.type === 'CallExpression' && node.callee?.name === 'mintEmailReviewCardsFenced';
}

describe('shadow-mode bridge always reaches mintEmailReviewCardsFenced (codex round-3 P1, finding #3)', () => {
  let ast;
  beforeAll(() => {
    const source = fs.readFileSync(FILE, 'utf8');
    ast = espree.parse(source, { ecmaVersion: 2022, sourceType: 'script', loc: true });
  });

  test('the mint call is not nested inside `if (needsConfirmation.length)`, and runs as a sibling instead', () => {
    let targetIf = null;
    walk(ast, (node) => {
      if (targetIf) return;
      if (node.type === 'IfStatement'
        && node.test?.type === 'MemberExpression'
        && node.test.object?.name === 'needsConfirmation'
        && node.test.property?.name === 'length') {
        targetIf = node;
      }
    });
    // If this fails, the shadow bridge's shape changed enough that this
    // guard needs re-anchoring — not a silent pass.
    expect(targetIf).toBeTruthy();

    let mintInsideIf = false;
    walk(targetIf.consequent, (node) => { if (isMintCall(node)) mintInsideIf = true; });
    expect(mintInsideIf).toBe(false);

    let enclosingBlock = null;
    walk(ast, (node) => {
      if (enclosingBlock) return;
      if (node.type === 'BlockStatement' && Array.isArray(node.body) && node.body.includes(targetIf)) {
        enclosingBlock = node;
      }
    });
    expect(enclosingBlock).toBeTruthy();

    let mintAsSibling = false;
    for (const stmt of enclosingBlock.body) {
      if (stmt === targetIf) continue;
      walk(stmt, (node) => { if (isMintCall(node)) mintAsSibling = true; });
    }
    expect(mintAsSibling).toBe(true);
  });

  // Codex round-6 P1: this call site was hoisted (above) to always run,
  // but it never set `invalidateClaims` — silently falling back to the
  // function's `true` default. A full-agreement reconcile pass (cards: [],
  // nothing live minted) then still ran repenHoldsForFreshEmailReview,
  // converting an unmarked 'releasing' row and letting a provider call
  // that ALREADY succeeded this pass be force-sent again. Both branches
  // (the shadow-mode bridge and the enforce-mode fallback right after it)
  // must explicitly compute invalidateClaims from their own pass's email
  // reasons, never leave it absent.
  test('every branch call site explicitly sets invalidateClaims (never left at the implicit true default)', () => {
    const mintCalls = [];
    walk(ast, (node) => { if (isMintCall(node)) mintCalls.push(node); });
    // Only calls that pass a `cards` argument COMPUTED from a per-pass
    // reason list (a call-expression chain, e.g. `x.slice(...).map(...)`)
    // are in scope — the end-of-run recovery-marker call site always mints
    // one fixed literal card (`cards: [buildTriageItem({...})]`), so its
    // implicit default is correct there and it is not one of the two
    // branches this guards.
    const branchCalls = mintCalls.filter((node) => {
      const argsObj = node.arguments[0];
      const cardsProp = argsObj?.type === 'ObjectExpression'
        && argsObj.properties.find((p) => p.key?.name === 'cards');
      return cardsProp && cardsProp.value.type !== 'ArrayExpression';
    });
    expect(branchCalls.length).toBe(2);
    for (const call of branchCalls) {
      const argsObj = call.arguments[0];
      const invalidateProp = argsObj.properties.find((p) => p.key?.name === 'invalidateClaims');
      expect(invalidateProp).toBeTruthy();
      // Must be computed from the pass's own evidence, not a bare literal
      // (which would just re-hardcode true/false instead of reflecting
      // whether this pass actually minted a live card).
      expect(invalidateProp.value.type).not.toBe('BooleanLiteral');
    }
  });
});
