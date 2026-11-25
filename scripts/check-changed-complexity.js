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
 *   NEW/WORSE: a changed function that is new or rewritten (every line of it
 *     is in the diff), was within the limit at base, or scores HIGHER than at
 *     base. Printed loudly, ahead of the Codex audit.
 *   WARN: a changed function that was already over the limit at base with an
 *     equal or higher score and is only partly touched. A one-line fix in a
 *     legacy function must not read as new debt; Codex may still flag it when
 *     the diff rewrites a big share of it.
 * Advisory (AGENTS.md: structural lint is advice): both exit 0. `--strict`
 * exits 1 on NEW/WORSE, for a manual check.
 *
 * Base scores come from the same ESLint pass on the file at the merge-base
 * (the old path when git paired a rename). Functions match by owner (class,
 * object, enclosing function), name and ordinal in the file; unnamed ones match by ordinal only when the file has as
 * many at base as at head, otherwise they WARN.
 *
 *   node scripts/check-changed-complexity.js [--base origin/main] [--head HEAD]
 *
 * Reads file content at the refs (not the working tree), so a dirty tree cannot
 * move a line number. Exit codes: 0 done (findings are printed, not enforced),
 * 1 NEW/WORSE with --strict, 2 the check itself could not run (git or ESLint
 * failed): the pre-push hook warns and carries on.
 *
 * Escape hatch in the pre-push hook: SKIP_CHANGED_COMPLEXITY=1 git push.
 * To fix a finding, remove decisions from the function; do not move them into
 * a one-use helper (the score moves, the complexity stays, and Codex flags the
 * helper as a pass-through).
 */
const path = require('path');
const { execFileSync } = require('child_process');
const {
  HINT, WARN_NOTE, functionName, functionOwner, isLintable, parseDiffRanges, parseDiffOldPaths, violationsForFile,
  baseScoreMap, classifyViolations, countAnonymous, formatViolation,
} = require('./lib/changed-complexity');

const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = { base: 'origin/main', head: 'HEAD', strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') opts.base = argv[++i];
    else if (a.startsWith('--base=')) opts.base = a.slice(7);
    else if (a === '--head') opts.head = argv[++i];
    else if (a.startsWith('--head=')) opts.head = a.slice(7);
    else if (a === '--strict') opts.strict = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.base || !opts.head) throw new Error('--base and --head need a value');
  return opts;
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Records every function's full span, name and owner, so a complexity message
// (reported at the function head only) can be tied to the lines of the whole
// function body and to the same function at the base.
function makeSpanRule(spansByFile) {
  return {
    meta: { type: 'problem', schema: [] },
    create(context) {
      const spans = [];
      spansByFile.set(context.filename, spans);
      const getText = (n) => context.sourceCode.getText(n);
      const record = (node) => {
        const p = node.parent;
        const headNode = p && (p.type === 'MethodDefinition' || p.type === 'PropertyDefinition' || p.type === 'Property') && p.value === node ? p : node;
        spans.push({
          name: functionName(node, getText),
          owner: functionOwner(node, getText),
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
      const { fail, warn } = classifyViolations(found, baseInfo, hunks);
      fails.push(...fail);
      warns.push(...warn);
    } catch (e) {
      console.error(`[changed-complexity] ESLint failed on ${file}: ${e.message}`);
      return 2;
    }
  }

  return report(fails, warns, linted, opts.strict);
}

// Advisory output: AGENTS.md treats structural lint as advice, so findings
// print loudly but the exit code stays 0 unless --strict is passed.
function report(fails, warns, linted, strict) {
  for (const v of warns) console.log(`[changed-complexity] WARN: ${formatViolation(v)}`);
  if (warns.length > 0) console.log(`[changed-complexity] WARN: ${WARN_NOTE}.`);
  if (fails.length === 0) {
    console.log(`[changed-complexity] OK: ${linted} changed file(s), no changed function is new or worse over complexity 20 / nesting 4${warns.length ? ` (${warns.length} warning(s) above)` : ''}.`);
    return 0;
  }
  const bar = '[changed-complexity] NEW/WORSE:';
  console.log(`${bar} ${fails.length} function(s) this branch adds, rewrites or makes worse are over the complexity (20) / nesting (4) limit:`);
  for (const v of fails) {
    const why = typeof v.base === 'number' ? '' : '  (new, rewritten, or not over the limit at base)';
    console.log(`${bar}   ${formatViolation(v)}${why}`);
  }
  console.log(`${bar} Fix these before the first push: Codex raises each as a P2. ${HINT}.`);
  console.log('[changed-complexity] Advisory only: this does not block the push. Skip with SKIP_CHANGED_COMPLEXITY=1.');
  return strict ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => {
    console.error(`[changed-complexity] unexpected error: ${e && e.stack || e}`);
    process.exit(2);
  });
}

module.exports = { parseArgs, makeSpanRule, report };
