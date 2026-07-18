/**
 * DEEP token-floor pin (Codex #2814 round 2).
 *
 * The deepAnalysis policy's primary is the DEEP tier, and MODEL_DEEP may
 * point at a thinking model (fable line) where thinking spends from the same
 * max-tokens budget — a sub-4096 cap lets thinking starve the visible JSON.
 * CLAUDE.md documents the floor: "DEEP sites need max_tokens >= 4096".
 * createDeepMessage sites are already gated by check:domain-rules; this test
 * pins the same floor for direct TEXT_POLICIES.deepAnalysis dispatches
 * (blog-writer optimizeExistingPost and appointment-tagger WDO brief were
 * shipped below it).
 */
const fs = require('fs');
const path = require('path');

const DEEP_FLOOR = 4096;
const SERVICES_DIR = path.join(__dirname, '..', 'services');
const MARKER = 'TEXT_POLICIES.deepAnalysis';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

test(`every ${MARKER} dispatch budgets maxTokens >= ${DEEP_FLOOR}`, () => {
  const violations = [];
  for (const file of walk(SERVICES_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    let idx = src.indexOf(MARKER);
    while (idx !== -1) {
      // Numeric caps only — dynamic expressions (e.g. deep.js's
      // `params.max_tokens || 4096`) are covered by their own call sites.
      const cap = src.slice(idx, idx + 400).match(/maxTokens:\s*(\d+)/);
      if (cap && Number(cap[1]) < DEEP_FLOOR) {
        violations.push(`${path.relative(SERVICES_DIR, file)} — maxTokens ${cap[1]} < ${DEEP_FLOOR}`);
      }
      idx = src.indexOf(MARKER, idx + MARKER.length);
    }
  }
  expect(violations).toEqual([]);
});
