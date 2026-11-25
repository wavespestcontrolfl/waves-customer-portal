#!/usr/bin/env node
'use strict';
/**
 * Changed-function complexity gate.
 *
 * ESLint `complexity` (max 20) and `max-depth` (max 4) are warnings in
 * eslint.config.js (QUALITY_WARN), so lint never fails on them; Codex then
 * raises each as a P2 on a function the diff ADDS or REWRITES. This gate moves
 * that finding to the push, where it costs seconds instead of a review round.
 * Only functions with a changed line inside them are looked at.
 *
 *   FAIL (exit 1): a changed function that is NEW, was within the limit at
 *     base, or scores HIGHER than at base.
 *   WARN (exit 0): a changed function that was already over the limit at base
 *     with an equal or higher score. A one-line fix in a legacy function must
 *     not block a push; Codex may still flag it when the diff rewrites a big
 *     share of it.
 * Base scores come from the same ESLint pass on the file at the merge-base
 * (the old path when git paired a rename). Functions match by name and
 * ordinal in the file; unnamed ones match by ordinal only when the file has as
 * many at base as at head, otherwise they WARN.
 *
 *   node scripts/check-changed-complexity.js [--base origin/main] [--head HEAD]
 *
 * Reads file content at the refs (not the working tree), so a dirty tree cannot
 * move a line number. Exit codes: 0 clean or warnings only, 1 findings, 2 the
 * check itself could not run (git or ESLint failed): the pre-push hook warns
 * and lets the push through on 2, CI fails.
 *
 * Escape hatch in the pre-push hook: SKIP_CHANGED_COMPLEXITY=1 git push.
 * To fix a finding, remove decisions from the function; do not move them into
 * a one-use helper (the score moves, the complexity stays, and Codex flags the
 * helper as a pass-through).
 */
const path = require('path');
const { execFileSync } = require('child_process');
const {
  HINT, WARN_NOTE, isLintable, parseDiffRanges, parseDiffOldPaths, violationsForFile,
  baseScoreMap, classifyViolations, countAnonymous, formatViolation,
} = require('./lib/changed-complexity');

const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = { base: 'origin/main', head: 'HEAD' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') opts.base = argv[++i];
    else if (a.startsWith('--base=')) opts.base = a.slice(7);
    else if (a === '--head') opts.head = argv[++i];
    else if (a.startsWith('--head=')) opts.head = a.slice(7);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.base || !opts.head) throw new Error('--base and --head need a value');
  return opts;
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Records every function's full span, so a complexity message (reported at the
// function head only) can be tied to the lines of the whole function body.
function makeSpanRule(spansByFile) {
  const nameOf = (node, sourceCode) => {
    if (node.id && node.id.name) return node.id.name;
    const parent = node.parent;
    if (!parent) return null;
    if (parent.type === 'VariableDeclarator' && parent.id.name) return parent.id.name;
    if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key) {
      return parent.key.name || (parent.key.value !== undefined ? String(parent.key.value) : null);
    }
    if (parent.type === 'AssignmentExpression') return sourceCode.getText(parent.left);
    return null;
  };
  return {
    meta: { type: 'problem', schema: [] },
    create(context) {
      const spans = [];
      spansByFile.set(context.filename, spans);
      const record = (node) => {
        const p = node.parent;
        const headNode = p && (p.type === 'MethodDefinition' || p.type === 'PropertyDefinition' || p.type === 'Property') && p.value === node ? p : node;
        spans.push({
          name: nameOf(node, context.sourceCode),
          headLine: headNode.loc.start.line,
          headColumn: headNode.loc.start.column,
          startLine: node.loc.start.line,
          endLine: node.loc.end.line,
          endColumn: node.loc.end.column,
        });
      };
      return { FunctionDeclaration: record, FunctionExpression: record, ArrowFunctionExpression: record };
    },
  };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`[changed-complexity] ${e.message}`); return 2; }

  let diff;
  let mergeBase;
  try {
    mergeBase = git(['merge-base', opts.base, opts.head]).trim();
    // -M: a pure rename carries no hunks, so moving a file never re-flags its old functions.
    diff = git(['-c', 'core.quotepath=off', 'diff', '-U0', '-M', '--no-color', '--diff-filter=ACMR', mergeBase, opts.head, '--', '*.js', '*.jsx', '*.cjs', '*.mjs']);
  } catch (e) {
    console.error(`[changed-complexity] git diff ${opts.base}...${opts.head} failed: ${String(e.stderr || e.message).trim()}`);
    return 2;
  }
  const oldPaths = parseDiffOldPaths(diff);
  const changed = [...parseDiffRanges(diff)].filter(([file, hunks]) => isLintable(file) && hunks.length > 0);
  if (changed.length === 0) {
    console.log('[changed-complexity] no changed JS files.');
    return 0;
  }

  let ESLint;
  try { ({ ESLint } = require('eslint')); } catch (e) {
    console.error(`[changed-complexity] eslint is not installed (${e.message}). Run npm ci.`);
    return 2;
  }
  const spansByFile = new Map();
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    warnIgnored: false,
    overrideConfig: [{
      files: ['**/*.{js,jsx,cjs,mjs}'],
      plugins: { 'changed-complexity': { rules: { spans: makeSpanRule(spansByFile) } } },
      rules: { 'changed-complexity/spans': 'warn' },
    }],
  });

  const fails = [];
  const warns = [];
  let linted = 0;
  const lint = async (source, abs) => {
    const results = await eslint.lintText(source, { filePath: abs, warnIgnored: false });
    if (!results.length) return null;
    return { messages: results[0].messages, fns: spansByFile.get(abs) || [] };
  };
  for (const [file, hunks] of changed) {
    let source;
    try { source = git(['show', `${opts.head}:${file}`]); } catch { continue; }
    const abs = path.join(REPO_ROOT, file);
    try {
      const head = await lint(source, abs);
      if (!head) continue;
      linted += 1;
      const found = violationsForFile(file, head.messages, head.fns, hunks);
      if (found.length === 0) continue;
      let baseInfo = null;
      const oldPath = oldPaths.get(file);
      if (oldPath) {
        let baseSource = null;
        try { baseSource = git(['show', `${mergeBase}:${oldPath}`]); } catch { baseSource = null; }
        const base = baseSource === null ? null : await lint(baseSource, path.join(REPO_ROOT, oldPath));
        if (base) {
          baseInfo = {
            scores: baseScoreMap(oldPath, base.messages, base.fns),
            anonMatches: countAnonymous(base.fns) === countAnonymous(head.fns),
          };
        }
      }
      const { fail, warn } = classifyViolations(found, baseInfo);
      fails.push(...fail);
      warns.push(...warn);
    } catch (e) {
      console.error(`[changed-complexity] ESLint failed on ${file}: ${e.message}`);
      return 2;
    }
  }

  if (warns.length > 0) {
    for (const v of warns) console.log(`[changed-complexity] WARN: ${formatViolation(v)}`);
    console.log(`[changed-complexity] WARN: ${WARN_NOTE}.`);
  }
  const violations = fails;
  if (violations.length === 0) {
    console.log(`[changed-complexity] OK: ${linted} changed file(s), no changed function is new or worse over complexity 20 / nesting 4${warns.length ? ` (${warns.length} warning(s) above)` : ''}.`);
    return 0;
  }
  console.error(`[changed-complexity] FAIL: ${violations.length} function(s) this branch adds or changes are new or worse than at base and exceed the complexity/nesting limit:`);
  for (const v of violations) console.error(`  ${formatViolation(v)}`);
  console.error(`[changed-complexity] Hint: ${HINT}.`);
  console.error('[changed-complexity] Codex raises each of these as a P2. Pre-push escape hatch: SKIP_CHANGED_COMPLEXITY=1 git push');
  return 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => {
    console.error(`[changed-complexity] unexpected error: ${e && e.stack || e}`);
    process.exit(2);
  });
}

module.exports = { parseArgs, makeSpanRule };
