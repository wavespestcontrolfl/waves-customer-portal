'use strict';
/**
 * Pure helpers for scripts/check-changed-complexity.js (no git, no ESLint run).
 *
 * The check fails a push when a function the branch ADDS or CHANGES trips the
 * repo's own `complexity` (> 20) or `max-depth` (> 4) warning. Untouched
 * legacy functions are never reported. See eslint.config.js (QUALITY_WARN).
 */

const LINTABLE = /\.(?:js|jsx|cjs|mjs)$/;
const QUALITY_RULES = new Set(['complexity', 'max-depth']);

const HINT = 'remove decisions; do not move them into a one-use helper';
const WARN_NOTE = 'Codex flags a rewritten function still over 20; lower it if this diff rewrites it';

/**
 * Parse `git diff -U0` output into new-side changed line ranges per file.
 * Returns Map<path, Array<{ start, end, deletion }>>.
 *   - An added or changed hunk `+S,N` covers lines S..S+N-1.
 *   - A pure deletion `+S,0` removes lines between S and S+1 of the new file;
 *     it is recorded as { start: S, end: S + 1, deletion: true } and counts
 *     only against a function that spans BOTH lines (see rangesTouch).
 * Deleted files (`+++ /dev/null`) are skipped.
 */
function parseDiffRanges(diffText) {
  const files = new Map();
  let current = null;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target === '/dev/null') {
        current = null;
      } else {
        const unquoted = target.replace(/^"(.*)"$/, '$1');
        current = unquoted.replace(/^b\//, '');
        if (!files.has(current)) files.set(current, []);
      }
      continue;
    }
    if (!current || !line.startsWith('@@')) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) files.get(current).push({ start, end: start + 1, deletion: true });
    else files.get(current).push({ start, end: start + count - 1, deletion: false });
  }
  return files;
}

/**
 * Map each changed file's new path to its path at the base: the same path, the
 * old path when git paired a rename (-M), or null for a file the diff adds.
 */
function parseDiffOldPaths(diffText) {
  const out = new Map();
  let old;
  const clean = (p) => p.trim().replace(/^"(.*)"$/, '$1');
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('--- ')) {
      const t = clean(line.slice(4));
      old = t === '/dev/null' ? null : t.replace(/^a\//, '');
    } else if (line.startsWith('+++ ') && old !== undefined) {
      const t = clean(line.slice(4));
      if (t !== '/dev/null') out.set(t.replace(/^b\//, ''), old);
      old = undefined;
    }
  }
  return out;
}

/** Only paths ESLint should look at: JS-family files. */
function isLintable(file) {
  return LINTABLE.test(file);
}

/**
 * Does a changed hunk touch a function/block spanning startLine..endLine?
 * Ordinary hunks: any shared line. Pure deletions: the span must contain the
 * lines on both sides of the removal, so a function that merely starts right
 * after (or ends right before) a deleted block is not counted as changed.
 */
function rangesTouch(startLine, endLine, hunk) {
  if (hunk.deletion) return startLine <= hunk.start && hunk.end <= endLine;
  return startLine <= hunk.end && hunk.start <= endLine;
}

function touchesAny(startLine, endLine, hunks) {
  return hunks.some((h) => rangesTouch(startLine, endLine, h));
}

/**
 * Pick the function whose body a `complexity` message belongs to. ESLint
 * reports complexity at the function HEAD (for a method or property, the
 * head starts at the parent, before the function node), so each recorded
 * function carries headStart (line, column) alongside its full span.
 * The innermost function containing the report position wins.
 * fns: Array<{ headLine, headColumn, startLine, endLine, endColumn }>
 */
function findFunctionForMessage(fns, line, column) {
  let best = null;
  for (const fn of fns) {
    const afterStart = line > fn.headLine || (line === fn.headLine && column >= fn.headColumn);
    const beforeEnd = line < fn.endLine || (line === fn.endLine && column <= fn.endColumn);
    if (!afterStart || !beforeEnd) continue;
    if (!best || fn.headLine > best.headLine
      || (fn.headLine === best.headLine && fn.headColumn > best.headColumn)) best = fn;
  }
  return best;
}

/**
 * "Function 'foo' has a complexity of 25. Maximum allowed is 20." -> { name: 'foo', score: 25, max: 20 }
 * name is null when ESLint did not quote one (an anonymous function or arrow).
 */
function parseComplexityMessage(message) {
  const m = /^(.*?) has a complexity of (\d+)\. Maximum allowed is (\d+)\./.exec(message || '');
  if (!m) return { name: null, score: null, max: null };
  const quoted = /'([^']*)'/.exec(m[1]);
  return { name: quoted ? quoted[1] : null, score: Number(m[2]), max: Number(m[3]) };
}

/** "Blocks are nested too deeply (5). Maximum allowed is 4." -> { score, max } */
function parseDepthMessage(message) {
  const m = /nested too deeply \((\d+)\)\. Maximum allowed is (\d+)/.exec(message || '');
  return m ? { score: Number(m[1]), max: Number(m[2]) } : { score: null, max: null };
}

/**
 * Give every function a key that survives edits elsewhere in the file: its
 * name plus its ordinal among same-named functions, or `<anon>#n` for the nth
 * unnamed one. Mutates and returns fns (sorted by head position).
 */
function keyFunctions(fns) {
  const sorted = [...fns].sort((x, y) => x.headLine - y.headLine || x.headColumn - y.headColumn);
  const seen = new Map();
  for (const fn of sorted) {
    const base = fn.name || '<anon>';
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    fn.key = `${base}#${n}`;
  }
  return sorted;
}

function countAnonymous(fns) {
  return fns.filter((f) => !f.name).length;
}

/**
 * Every complexity / max-depth message of one file, tied to its function.
 *   complexity: the whole enclosing function is the range that counts.
 *   max-depth:  the too-deep block's own line span is the range that counts.
 * Items: { file, line, rule, name, score, max, key, startLine, endLine }
 * where line is the function's first line (the block's, for max-depth).
 */
function flaggedItems(file, messages, fns) {
  keyFunctions(fns);
  const out = [];
  for (const msg of messages) {
    if (!QUALITY_RULES.has(msg.ruleId)) continue;
    const fn = findFunctionForMessage(fns, msg.line, (msg.column || 1) - 1);
    const key = fn ? fn.key : '(module)';
    if (msg.ruleId === 'complexity') {
      const parsed = parseComplexityMessage(msg.message);
      const startLine = fn ? fn.startLine : msg.line;
      out.push({
        file, line: startLine, rule: 'complexity', key, score: parsed.score, max: parsed.max,
        name: parsed.name || (fn && fn.name) || '(anonymous function)',
        startLine, endLine: fn ? fn.endLine : (msg.endLine || msg.line),
      });
    } else {
      const parsed = parseDepthMessage(msg.message);
      out.push({
        file, line: msg.line, rule: 'max-depth', key, score: parsed.score, max: parsed.max,
        name: (fn && fn.name) || null,
        startLine: msg.line, endLine: msg.endLine || msg.line,
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Flagged items whose range holds a changed line. */
function violationsForFile(file, messages, fns, hunks) {
  return flaggedItems(file, messages, fns).filter((v) => touchesAny(v.startLine, v.endLine, hunks));
}

/**
 * Highest score at base for each rule + function key: Map<"rule|key", score>.
 * A function absent from the map was at or under the limit (or did not exist).
 */
function baseScoreMap(file, messages, fns) {
  const map = new Map();
  for (const it of flaggedItems(file, messages, fns)) {
    const k = `${it.rule}|${it.key}`;
    map.set(k, Math.max(map.get(k) || 0, it.score || 0));
  }
  return map;
}

/**
 * Split violations into FAIL and WARN.
 *   FAIL: a new function, one that was at or under the limit at base, or one
 *         whose score is higher than at base.
 *   WARN: it was already over the limit at base with an equal or higher score
 *         (a one-line fix inside a legacy function is not a new problem).
 * baseInfo: null when the file has no base version (new file: all FAIL), else
 *   { scores: Map from baseScoreMap, anonMatches: boolean } where anonMatches
 *   says the file has as many unnamed functions at base as at head. Unnamed
 *   functions match by ordinal only when it does; otherwise they WARN.
 */
function classifyViolations(violations, baseInfo) {
  const fail = [];
  const warn = [];
  for (const v of violations) {
    if (!baseInfo) { fail.push({ ...v, base: null }); continue; }
    if (v.key.startsWith('<anon>') && !baseInfo.anonMatches) { warn.push({ ...v, base: null }); continue; }
    const base = baseInfo.scores.get(`${v.rule}|${v.key}`);
    if (base === undefined) fail.push({ ...v, base: null });
    else if ((v.score || 0) > base) fail.push({ ...v, base });
    else warn.push({ ...v, base });
  }
  return { fail, warn };
}

function formatViolation(v) {
  const where = `${v.file}:${v.line}`;
  const tail = typeof v.base === 'number' ? `  base ${v.base}` : '';
  if (v.rule === 'complexity') {
    return `${where}  ${v.name}  complexity ${v.score} (max ${v.max})${tail}`;
  }
  return `${where}  blocks nested ${v.score} deep (max ${v.max})${tail}`;
}

module.exports = {
  HINT,
  WARN_NOTE,
  isLintable,
  parseDiffRanges,
  parseDiffOldPaths,
  rangesTouch,
  touchesAny,
  findFunctionForMessage,
  parseComplexityMessage,
  parseDepthMessage,
  keyFunctions,
  countAnonymous,
  flaggedItems,
  violationsForFile,
  baseScoreMap,
  classifyViolations,
  formatViolation,
};
