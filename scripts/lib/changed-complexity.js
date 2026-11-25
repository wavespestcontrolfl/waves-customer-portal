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
 * Give every function a key that survives edits elsewhere in the file: the
 * named things around it (class, object literal, enclosing function), its own
 * name, and its ordinal among functions with the same owner and name:
 *   `Foo::run#1`, `callback of router.get('/x')#1`, `<anon>#2`.
 * Two classes that both define `run` therefore never share a key. Mutates and
 * returns fns (sorted by head position).
 */
function keyFunctions(fns) {
  const sorted = [...fns].sort((x, y) => x.headLine - y.headLine || x.headColumn - y.headColumn);
  const seen = new Map();
  for (const fn of sorted) {
    const base = `${fn.owner ? `${fn.owner}::` : ''}${fn.name || '<anon>'}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    fn.key = `${base}#${n}`;
    fn.baseKey = base;
  }
  for (const fn of sorted) fn.dup = seen.get(fn.baseKey) > 1;
  return sorted;
}

/** Throw, naming the file, when ESLint could not parse it: no messages is not "no findings". */
function assertParsed(result, label) {
  if (!result || !(result.fatalErrorCount > 0)) return;
  const fatal = (result.messages || []).find((m) => m.fatal) || {};
  throw new Error(`${label} does not parse (line ${fatal.line || '?'}: ${fatal.message || 'syntax error'})`);
}

/** Owner::name keys that more than one function in the file shares (keyFunctions must have run). */
function duplicateKeys(fns) {
  return new Set(fns.filter((f) => f.dup).map((f) => f.baseKey));
}

function countAnonymous(fns) {
  return fns.filter((f) => !f.name).length;
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const CALLEE_MAX = 48;

function propertyKeyName(key) {
  if (!key) return null;
  if (key.name) return key.name;
  return key.value !== undefined ? String(key.value) : null;
}

/** `router.get('/x', fn)` -> "callback of router.get('/x')": a route stays findable when others move. */
function callbackName(call, getText) {
  const callee = getText(call.callee).replace(/\s+/g, ' ').slice(0, CALLEE_MAX);
  const first = call.arguments[0];
  let literal = '';
  if (first && first.type === 'Literal' && typeof first.value === 'string') literal = `'${first.value}'`;
  else if (first && first.type === 'TemplateLiteral' && first.expressions.length === 0) literal = `'${first.quasis[0].value.cooked}'`;
  return `callback of ${callee}(${literal})`;
}

/** Name a function node from its own id or the way it is bound; null for a truly anonymous one. */
function functionName(node, getText) {
  if (node.id && node.id.name) return node.id.name;
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type === 'VariableDeclarator') return parent.id && parent.id.name ? parent.id.name : null;
  if (parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') return propertyKeyName(parent.key);
  if (parent.type === 'AssignmentExpression') return getText(parent.left);
  if (parent.type === 'CallExpression' && parent.arguments.includes(node)) return callbackName(parent, getText);
  return null;
}

/** What an object literal or class expression is bound to, from the node holding it. */
function bindingName(holder, getText) {
  if (!holder) return null;
  if (holder.type === 'VariableDeclarator') return holder.id && holder.id.name ? holder.id.name : null;
  if (holder.type === 'Property' || holder.type === 'PropertyDefinition') return propertyKeyName(holder.key);
  if (holder.type === 'AssignmentExpression') return getText(holder.left);
  return null;
}

function containerName(node, getText) {
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    return (node.id && node.id.name) || bindingName(node.parent, getText);
  }
  if (node.type === 'ObjectExpression') return bindingName(node.parent, getText);
  if (FUNCTION_TYPES.has(node.type)) return functionName(node, getText);
  return null;
}

/** Names of the classes, object literals and functions around a function, outermost first, joined by ">". */
function functionOwner(node, getText) {
  const names = [];
  for (let p = node.parent; p; p = p.parent) {
    const name = containerName(p, getText);
    if (name) names.push(name);
  }
  return names.reverse().join('>');
}

/**
 * Every complexity / max-depth finding of one file, tied to its function.
 * Items: { file, line, rule, name, score, max, key, anon, startLine, endLine }
 *   complexity: one item per over-limit function; line = its first line.
 *   max-depth:  ONE item per function, scored by its deepest block and
 *     reported at that block's line. Both rules count a change anywhere in the
 *     function (startLine..endLine is the function) as touching it, so
 *     wrapping four old blocks in a new fifth is seen. Code outside any
 *     function is judged on the too-deep block's own lines.
 */
function complexityItem(file, msg, fn) {
  const parsed = parseComplexityMessage(msg.message);
  const startLine = fn ? fn.startLine : msg.line;
  return {
    file, line: startLine, rule: 'complexity', key: fn ? fn.key : '(module)', anon: !!fn && !fn.name, dup: !!fn && !!fn.dup,
    score: parsed.score, max: parsed.max,
    name: parsed.name || (fn && fn.name) || '(anonymous function)',
    startLine, endLine: fn ? fn.endLine : (msg.endLine || msg.line),
  };
}

function depthItem(file, msg, fn) {
  const parsed = parseDepthMessage(msg.message);
  return {
    file, line: msg.line, rule: 'max-depth', key: fn ? fn.key : '(module)', anon: !!fn && !fn.name, dup: !!fn && !!fn.dup,
    score: parsed.score, max: parsed.max, name: (fn && fn.name) || null,
    startLine: fn ? fn.startLine : msg.line,
    endLine: fn ? fn.endLine : (msg.endLine || msg.line),
  };
}

function flaggedItems(file, messages, fns) {
  keyFunctions(fns);
  const out = [];
  const depth = new Map();
  for (const msg of messages) {
    if (!QUALITY_RULES.has(msg.ruleId)) continue;
    const fn = findFunctionForMessage(fns, msg.line, (msg.column || 1) - 1);
    if (msg.ruleId === 'complexity') { out.push(complexityItem(file, msg, fn)); continue; }
    const item = depthItem(file, msg, fn);
    const groupKey = fn ? item.key : `${item.key}@${msg.line}`;
    const prev = depth.get(groupKey);
    if (!prev || (item.score || 0) > (prev.score || 0)) depth.set(groupKey, item);
  }
  out.push(...depth.values());
  return out.sort((x, y) => x.line - y.line);
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

/** Is every line of startLine..endLine inside the added/changed lines of the diff? */
function fullyChanged(startLine, endLine, hunks) {
  const added = hunks.filter((h) => !h.deletion).sort((x, y) => x.start - y.start);
  let next = startLine;
  for (const h of added) {
    if (h.start > next) break;
    if (h.end >= next) next = h.end + 1;
    if (next > endLine) return true;
  }
  return next > endLine;
}

/**
 * Split violations into NEW/WORSE (fail) and WARN (warn).
 *   fail: a new or rewritten function (the file is new, or every line of the
 *         function is in the diff), one that was at or under the limit at
 *         base, or one whose score is higher than at base.
 *   warn: it was already over the limit at base with an equal or lower score,
 *         and the diff touches only part of it (a one-line fix in a legacy
 *         function is not a new problem).
 * baseInfo: null when the file has no base version (new file: all fail), else
 *   { scores: Map from baseScoreMap, dups: Set from duplicateKeys, anonMatches: boolean } where anonMatches
 *   says the file has as many unnamed functions at base as at head. A key shared
 *   by several functions (at head or base) is never matched by ordinal: it warns
 *   as an ambiguous match unless the whole function is in the diff. Unnamed
 *   functions match by ordinal only when it does; otherwise they warn.
 * hunks: the changed ranges of the file (see parseDiffRanges).
 */
function classifyViolations(violations, baseInfo, hunks = []) {
  const fail = [];
  const warn = [];
  for (const v of violations) {
    if (!baseInfo || fullyChanged(v.startLine, v.endLine, hunks)) { fail.push({ ...v, base: null }); continue; }
    const baseKey = v.key.replace(/#\d+$/, '');
    if (v.dup || (baseInfo.dups && baseInfo.dups.has(baseKey))) { warn.push({ ...v, base: null, ambiguous: true }); continue; }
    const anon = v.anon || /<anon>#\d+$/.test(v.key);
    if (anon && !baseInfo.anonMatches) { warn.push({ ...v, base: null }); continue; }
    const base = baseInfo.scores.get(`${v.rule}|${v.key}`);
    if (base === undefined) fail.push({ ...v, base: null });
    else if ((v.score || 0) > base) fail.push({ ...v, base });
    else warn.push({ ...v, base });
  }
  return { fail, warn };
}

function formatViolation(v) {
  const where = `${v.file}:${v.line}`;
  const tail = (typeof v.base === 'number' ? `  base ${v.base}` : '') + (v.ambiguous ? '  (ambiguous match)' : '');
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
  duplicateKeys,
  assertParsed,
  functionName,
  functionOwner,
  fullyChanged,
  countAnonymous,
  flaggedItems,
  violationsForFile,
  baseScoreMap,
  classifyViolations,
  formatViolation,
};
