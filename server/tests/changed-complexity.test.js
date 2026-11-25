// Pure-function tests for the changed-function complexity gate
// (scripts/check-changed-complexity.js). No git, no ESLint run.
const {
  parseDiffRanges, isLintable, rangesTouch, findFunctionForMessage,
  parseComplexityMessage, parseDepthMessage, violationsForFile, formatViolation, HINT, WARN_NOTE,
  parseDiffOldPaths, keyFunctions, countAnonymous, baseScoreMap, classifyViolations, flaggedItems,
  fullyChanged, functionName, functionOwner,
} = require('../../scripts/lib/changed-complexity');
const { report, parseArgs } = require('../../scripts/check-changed-complexity');

const DIFF = [
  'diff --git a/server/a.js b/server/a.js',
  'index 111..222 100644',
  '--- a/server/a.js',
  '+++ b/server/a.js',
  '@@ -3,0 +4,2 @@ function x() {',
  '+  one();',
  '+  two();',
  '@@ -10 +12 @@',
  '-  old();',
  '+  new();',
  '@@ -20,3 +22,0 @@',
  '-  gone();',
  'diff --git a/server/gone.js b/server/gone.js',
  'deleted file mode 100644',
  '--- a/server/gone.js',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-x',
  'diff --git a/client/src/B.jsx b/client/src/B.jsx',
  '--- /dev/null',
  '+++ b/client/src/B.jsx',
  '@@ -0,0 +1,30 @@',
  '+line',
].join('\n');

describe('parseDiffRanges', () => {
  const ranges = parseDiffRanges(DIFF);

  test('reads added, single-line and new-file hunks on the new side', () => {
    expect(ranges.get('server/a.js').slice(0, 2)).toEqual([
      { start: 4, end: 5, deletion: false },
      { start: 12, end: 12, deletion: false },
    ]);
    expect(ranges.get('client/src/B.jsx')).toEqual([{ start: 1, end: 30, deletion: false }]);
  });

  test('records a pure deletion as the two lines around the cut', () => {
    expect(ranges.get('server/a.js')[2]).toEqual({ start: 22, end: 23, deletion: true });
  });

  test('skips a deleted file', () => {
    expect(ranges.has('server/gone.js')).toBe(false);
  });

  test('empty input gives an empty map', () => {
    expect(parseDiffRanges('').size).toBe(0);
    expect(parseDiffRanges(undefined).size).toBe(0);
  });
});

describe('isLintable', () => {
  test.each(['a.js', 'a.jsx', 'a.cjs', 'a.mjs', 'x/y/z.js'])('%s is lintable', (f) => {
    expect(isLintable(f)).toBe(true);
  });
  test.each(['a.json', 'a.md', 'a.ts', 'a.js.map', 'jsx'])('%s is not lintable', (f) => {
    expect(isLintable(f)).toBe(false);
  });
});

describe('rangesTouch', () => {
  const add = { start: 10, end: 12, deletion: false };
  test('an added hunk touches a function that shares any line', () => {
    expect(rangesTouch(1, 10, add)).toBe(true);
    expect(rangesTouch(12, 40, add)).toBe(true);
    expect(rangesTouch(11, 11, add)).toBe(true);
    expect(rangesTouch(1, 9, add)).toBe(false);
    expect(rangesTouch(13, 40, add)).toBe(false);
  });
  test('a pure deletion touches only a function that spans both sides of the cut', () => {
    const del = { start: 22, end: 23, deletion: true };
    expect(rangesTouch(20, 30, del)).toBe(true);
    expect(rangesTouch(23, 30, del)).toBe(false); // starts right after the cut
    expect(rangesTouch(10, 22, del)).toBe(false); // ends right before the cut
  });
});

describe('message parsing', () => {
  test('complexity message with a quoted name', () => {
    expect(parseComplexityMessage("Function 'decide' has a complexity of 25. Maximum allowed is 20."))
      .toEqual({ name: 'decide', score: 25, max: 20 });
    expect(parseComplexityMessage("Async method 'run' has a complexity of 21. Maximum allowed is 20."))
      .toEqual({ name: 'run', score: 21, max: 20 });
  });
  test('complexity message with no name', () => {
    expect(parseComplexityMessage('Arrow function has a complexity of 22. Maximum allowed is 20.'))
      .toEqual({ name: null, score: 22, max: 20 });
  });
  test('unparseable message', () => {
    expect(parseComplexityMessage('something else')).toEqual({ name: null, score: null, max: null });
  });
  test('depth message', () => {
    expect(parseDepthMessage('Blocks are nested too deeply (5). Maximum allowed is 4.')).toEqual({ score: 5, max: 4 });
    expect(parseDepthMessage('nope')).toEqual({ score: null, max: null });
  });
});

describe('findFunctionForMessage', () => {
  const outer = { name: 'outer', headLine: 5, headColumn: 0, startLine: 5, endLine: 60, endColumn: 1 };
  const inner = { name: 'inner', headLine: 20, headColumn: 4, startLine: 20, endLine: 30, endColumn: 5 };
  // A class method: the head starts at the method (column 2), the function node after the key.
  const method = { name: 'm', headLine: 70, headColumn: 2, startLine: 70, endLine: 90, endColumn: 3 };

  test('picks the innermost function containing the report position', () => {
    expect(findFunctionForMessage([outer, inner, method], 20, 4)).toBe(inner);
    expect(findFunctionForMessage([outer, inner, method], 5, 0)).toBe(outer);
    expect(findFunctionForMessage([outer, inner, method], 70, 2)).toBe(method);
  });
  test('returns null outside every function', () => {
    expect(findFunctionForMessage([outer, inner], 100, 0)).toBeNull();
  });
});

describe('violationsForFile', () => {
  const fns = [
    { name: 'decide', headLine: 10, headColumn: 0, startLine: 10, endLine: 50, endColumn: 1 },
    { name: 'legacy', headLine: 60, headColumn: 0, startLine: 60, endLine: 120, endColumn: 1 },
  ];
  const messages = [
    { ruleId: 'complexity', message: "Function 'decide' has a complexity of 25. Maximum allowed is 20.", line: 10, column: 1, endLine: 10 },
    { ruleId: 'complexity', message: "Function 'legacy' has a complexity of 40. Maximum allowed is 20.", line: 60, column: 1, endLine: 60 },
    { ruleId: 'max-depth', message: 'Blocks are nested too deeply (5). Maximum allowed is 4.', line: 100, column: 5, endLine: 104 },
    { ruleId: 'no-unused-vars', message: 'x is defined but never used.', line: 11, column: 1 },
    { ruleId: null, message: 'Parsing error', line: 1, column: 1 },
  ];

  test('flags a function whose BODY (not its head) holds a changed line', () => {
    const v = violationsForFile('server/a.js', messages, fns, [{ start: 40, end: 40, deletion: false }]);
    expect(v).toMatchObject([{ file: 'server/a.js', line: 10, rule: 'complexity', name: 'decide', score: 25, max: 20, key: 'decide#1' }]);
  });

  test('an untouched old function passes', () => {
    expect(violationsForFile('server/a.js', messages, fns, [{ start: 1, end: 5, deletion: false }])).toEqual([]);
  });

  test('max-depth is judged on its enclosing function (deepest block reported)', () => {
    // line 102 is inside the old `legacy` function (60-120): both its findings count
    const inBlock = violationsForFile('server/a.js', messages, fns, [{ start: 102, end: 102, deletion: false }]);
    expect(inBlock.map((x) => x.rule).sort()).toEqual(['complexity', 'max-depth']);
    expect(inBlock.find((x) => x.rule === 'max-depth')).toMatchObject({ line: 100, score: 5, max: 4 });
    // a change in `decide` (10-50) trips only decide's complexity: legacy is untouched
    const elsewhere = violationsForFile('server/a.js', messages, fns, [{ start: 15, end: 15, deletion: false }]);
    expect(elsewhere.map((x) => x.rule)).toEqual(['complexity']);
  });

  test('other rules and parse errors are ignored', () => {
    expect(violationsForFile('server/a.js', messages, fns, [{ start: 11, end: 11, deletion: false }])
      .map((x) => x.rule)).toEqual(['complexity']);
  });

  test('a complexity message with no recorded span falls back to its own lines', () => {
    const v = violationsForFile('a.js', [messages[0]], [], [{ start: 10, end: 10, deletion: false }]);
    expect(v).toHaveLength(1);
    expect(violationsForFile('a.js', [messages[0]], [], [{ start: 30, end: 30, deletion: false }])).toEqual([]);
  });

  test('an unnamed function takes its name from the recorded span', () => {
    const msg = { ruleId: 'complexity', message: 'Arrow function has a complexity of 22. Maximum allowed is 20.', line: 10, column: 1 };
    const v = violationsForFile('a.js', [msg], [{ name: 'handler', headLine: 10, headColumn: 0, startLine: 10, endLine: 30, endColumn: 1 }], [{ start: 12, end: 12, deletion: false }]);
    expect(v[0].name).toBe('handler');
  });
});

describe('parseDiffOldPaths', () => {
  test('same path, a paired rename, and a new file', () => {
    const d = [
      'diff --git a/s/a.js b/s/a.js', '--- a/s/a.js', '+++ b/s/a.js', '@@ -1 +1 @@',
      'diff --git a/s/old.js b/s/new.js', '--- a/s/old.js', '+++ b/s/new.js', '@@ -1 +1 @@',
      'diff --git a/s/n.js b/s/n.js', '--- /dev/null', '+++ b/s/n.js', '@@ -0,0 +1 @@',
    ].join('\n');
    const m = parseDiffOldPaths(d);
    expect(m.get('s/a.js')).toBe('s/a.js');
    expect(m.get('s/new.js')).toBe('s/old.js');
    expect(m.get('s/n.js')).toBeNull();
  });
});

describe('keyFunctions', () => {
  test('numbers same-named and unnamed functions by position', () => {
    const fns = [
      { name: 'run', headLine: 30, headColumn: 0 },
      { name: null, headLine: 20, headColumn: 2 },
      { name: 'run', headLine: 5, headColumn: 0 },
      { name: null, headLine: 40, headColumn: 2 },
    ];
    keyFunctions(fns);
    expect(fns.map((f) => f.key)).toEqual(['run#2', '<anon>#1', 'run#1', '<anon>#2']);
    expect(countAnonymous(fns)).toBe(2);
  });
});

describe('classifyViolations (FAIL vs WARN against the base)', () => {
  const v = (over) => ({ file: 'a.js', line: 10, rule: 'complexity', name: 'decide', score: 25, max: 20, key: 'decide#1', ...over });
  const baseInfo = (entries, anonMatches = true) => ({ scores: new Map(entries), anonMatches });

  test('a new function (no base file) fails', () => {
    expect(classifyViolations([v()], null).fail).toHaveLength(1);
  });
  test('a function that is not over the limit at base fails (new, or it rose past the limit)', () => {
    const r = classifyViolations([v()], baseInfo([['complexity|other#1', 40]]));
    expect(r.fail).toHaveLength(1);
    expect(r.warn).toHaveLength(0);
  });
  test('an old function over the limit with the same score only warns', () => {
    const r = classifyViolations([v()], baseInfo([['complexity|decide#1', 25]]));
    expect(r.fail).toHaveLength(0);
    expect(r.warn).toMatchObject([{ base: 25 }]);
  });
  test('an old function whose score dropped but is still over the limit only warns', () => {
    const r = classifyViolations([v({ score: 22 })], baseInfo([['complexity|decide#1', 25]]));
    expect(r.warn).toHaveLength(1);
  });
  test('an old function whose score rose fails', () => {
    const r = classifyViolations([v({ score: 27 })], baseInfo([['complexity|decide#1', 25]]));
    expect(r.fail).toMatchObject([{ base: 25, score: 27 }]);
  });
  test('nesting is compared on its own rule', () => {
    const d = v({ rule: 'max-depth', score: 6, max: 4, name: null });
    expect(classifyViolations([d], baseInfo([['max-depth|decide#1', 5]])).fail).toHaveLength(1);
    expect(classifyViolations([{ ...d, score: 5 }], baseInfo([['max-depth|decide#1', 5]])).warn).toHaveLength(1);
    // complexity at base does not excuse a nesting finding
    expect(classifyViolations([d], baseInfo([['complexity|decide#1', 30]])).fail).toHaveLength(1);
  });
  test('an unnamed function matches by ordinal when the counts agree, else warns', () => {
    const anon = v({ name: '(anonymous function)', key: '<anon>#1', score: 23 });
    expect(classifyViolations([anon], baseInfo([['complexity|<anon>#1', 23]], true)).warn).toHaveLength(1);
    expect(classifyViolations([anon], baseInfo([], true)).fail).toHaveLength(1);
    const unmatched = classifyViolations([anon], baseInfo([], false));
    expect(unmatched.fail).toHaveLength(0);
    expect(unmatched.warn).toMatchObject([{ base: null }]);
  });
});

describe('baseScoreMap', () => {
  test('keeps the highest score per rule and function', () => {
    const fns = [{ name: 'f', headLine: 1, headColumn: 0, startLine: 1, endLine: 50, endColumn: 1 }];
    const msgs = [
      { ruleId: 'complexity', message: "Function 'f' has a complexity of 30. Maximum allowed is 20.", line: 1, column: 1 },
      { ruleId: 'max-depth', message: 'Blocks are nested too deeply (5). Maximum allowed is 4.', line: 10, column: 3, endLine: 12 },
      { ruleId: 'max-depth', message: 'Blocks are nested too deeply (6). Maximum allowed is 4.', line: 20, column: 5, endLine: 22 },
    ];
    const m = baseScoreMap('a.js', msgs, fns);
    expect(m.get('complexity|f#1')).toBe(30);
    expect(m.get('max-depth|f#1')).toBe(6);
  });
});

describe('formatViolation', () => {
  test('prints file:line, name and score, plus the base score when known', () => {
    expect(formatViolation({ file: 'server/a.js', line: 10, rule: 'complexity', name: 'decide', score: 25, max: 20 }))
      .toBe('server/a.js:10  decide  complexity 25 (max 20)');
    expect(formatViolation({ file: 'server/a.js', line: 10, rule: 'complexity', name: 'decide', score: 27, max: 20, base: 25 }))
      .toBe('server/a.js:10  decide  complexity 27 (max 20)  base 25');
    expect(formatViolation({ file: 'server/a.js', line: 100, rule: 'max-depth', name: null, score: 5, max: 4, base: 5 }))
      .toBe('server/a.js:100  blocks nested 5 deep (max 4)  base 5');
    expect(HINT).toBe('remove decisions; do not move them into a one-use helper');
    expect(WARN_NOTE).toBe('Codex flags a rewritten function still over 20; lower it if this diff rewrites it');
  });
});

// ── Fix 1: advisory, never blocks ───────────────────────────────────────────
describe('report (advisory output and exit code)', () => {
  const failing = [{ file: 'a.js', line: 4, rule: 'complexity', name: 'decide', score: 27, max: 20, base: 25 }];
  const capture = (fn) => {
    const lines = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((l) => lines.push(l));
    try { return { code: fn(), lines }; } finally { spy.mockRestore(); }
  };

  test('new or worse findings print a loud NEW/WORSE section and still exit 0', () => {
    const { code, lines } = capture(() => report(failing, [], 1, false));
    expect(code).toBe(0);
    expect(lines.filter((l) => l.startsWith('[changed-complexity] NEW/WORSE:')).length).toBeGreaterThanOrEqual(3);
    expect(lines.join('\n')).toContain('a.js:4  decide  complexity 27 (max 20)  base 25');
    expect(lines.join('\n')).toContain(HINT);
    expect(lines.join('\n')).toContain('does not block the push');
  });

  test('touched legacy functions only print WARN and exit 0', () => {
    const { code, lines } = capture(() => report([], [{ ...failing[0], score: 25 }], 1, false));
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('[changed-complexity] WARN: a.js:4');
    expect(lines.join('\n')).not.toContain('NEW/WORSE');
  });

  test('--strict is the only way to get exit 1', () => {
    expect(capture(() => report(failing, [], 1, true)).code).toBe(1);
    expect(capture(() => report([], [], 1, true)).code).toBe(0);
    expect(parseArgs(['--strict']).strict).toBe(true);
    expect(parseArgs([]).strict).toBe(false);
  });
});

// ── Fix 2: nesting is judged on the enclosing function ──────────────────────
describe('max-depth is selected by the enclosing function and compared with its base depth', () => {
  const fns = () => [{ name: 'run', headLine: 10, headColumn: 0, startLine: 10, endLine: 60, endColumn: 1 }];
  const deep = (line, n) => ({ ruleId: 'max-depth', message: `Blocks are nested too deeply (${n}). Maximum allowed is 4.`, line, column: 9, endLine: line + 2 });

  test('a change anywhere in the function counts, not just inside the deep block', () => {
    // 4 old blocks wrapped in a new 5th: the deep block (lines 30-32) was not itself edited; line 12 was
    const v = violationsForFile('a.js', [deep(30, 5)], fns(), [{ start: 12, end: 12, deletion: false }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: 'max-depth', line: 30, score: 5, key: 'run#1' });
    // base had depth 4 (no message): the function was within the limit, so it is NEW/WORSE
    const r = classifyViolations(v, { scores: new Map(), anonMatches: true }, [{ start: 12, end: 12, deletion: false }]);
    expect(r.fail).toHaveLength(1);
  });

  test('one item per function, scored by its deepest block, reported at that block', () => {
    const items = flaggedItems('a.js', [deep(20, 5), deep(40, 6), deep(45, 5)], fns());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ line: 40, score: 6, startLine: 10, endLine: 60 });
  });

  test('an old function with the same depth at base only warns, a deeper one fails', () => {
    const base = { scores: baseScoreMap('a.js', [deep(20, 5)], fns()), anonMatches: true };
    const hunk = [{ start: 12, end: 12, deletion: false }];
    expect(classifyViolations(violationsForFile('a.js', [deep(30, 5)], fns(), hunk), base, hunk).warn).toHaveLength(1);
    expect(classifyViolations(violationsForFile('a.js', [deep(30, 6)], fns(), hunk), base, hunk).fail).toHaveLength(1);
  });

  test('code outside any function is judged on the block lines', () => {
    expect(violationsForFile('a.js', [deep(100, 5)], [], [{ start: 5, end: 5, deletion: false }])).toEqual([]);
    expect(violationsForFile('a.js', [deep(100, 5)], [], [{ start: 101, end: 101, deletion: false }])).toHaveLength(1);
  });
});

// ── Fix 3: a function wholly inside the added lines is new ──────────────────
describe('fullyChanged and new anonymous callbacks', () => {
  test('fullyChanged needs every line covered by added or changed hunks', () => {
    const h = (start, end, deletion = false) => ({ start, end, deletion });
    expect(fullyChanged(10, 20, [h(5, 25)])).toBe(true);
    expect(fullyChanged(10, 20, [h(10, 14), h(15, 20)])).toBe(true); // adjacent hunks join
    expect(fullyChanged(10, 20, [h(10, 14), h(16, 20)])).toBe(false); // a gap at line 15
    expect(fullyChanged(10, 20, [h(11, 20)])).toBe(false);
    expect(fullyChanged(10, 20, [h(9, 12, false), h(12, 13, true)])).toBe(false);
    expect(fullyChanged(10, 20, [])).toBe(false);
  });

  test('a callback wholly in added lines is NEW even when an unnamed one with that ordinal existed at base', () => {
    const v = { file: 'a.js', line: 30, rule: 'complexity', name: '(anonymous function)', score: 22, max: 20, key: '<anon>#1', anon: true, startLine: 30, endLine: 70 };
    const base = { scores: new Map([['complexity|<anon>#1', 22]]), anonMatches: true };
    expect(classifyViolations([v], base, [{ start: 30, end: 70, deletion: false }]).fail).toHaveLength(1);
    // the same callback with only one line edited is still matched by ordinal and warns
    expect(classifyViolations([v], base, [{ start: 40, end: 40, deletion: false }]).warn).toHaveLength(1);
  });

  test('a fully added callback fails even when the unnamed counts differ (no ambiguous WARN)', () => {
    const v = { file: 'a.js', line: 30, rule: 'complexity', name: '(anonymous function)', score: 22, max: 20, key: '<anon>#2', anon: true, startLine: 30, endLine: 70 };
    const base = { scores: new Map(), anonMatches: false };
    expect(classifyViolations([v], base, [{ start: 30, end: 70, deletion: false }]).fail).toHaveLength(1);
    expect(classifyViolations([v], base, [{ start: 40, end: 40, deletion: false }]).warn).toHaveLength(1);
  });
});

// ── Fix 4: keys carry the owner (class / object / enclosing function) ───────
describe('function names and owners', () => {
  const text = (n) => n.text;
  const id = (name) => ({ type: 'Identifier', name, text: name });
  const link = (child, parent) => { child.parent = parent; return child; };
  const fn = (parent, extra = {}) => link({ type: 'FunctionExpression', ...extra }, parent);

  test('two classes with a same-named method get different keys', () => {
    const mk = (cls) => {
      const klass = { type: 'ClassDeclaration', id: id(cls) };
      const body = link({ type: 'ClassBody' }, klass);
      const method = link({ type: 'MethodDefinition', key: id('run') }, body);
      const f = fn(method);
      method.value = f;
      return { name: functionName(f, text), owner: functionOwner(f, text) };
    };
    const a = { ...mk('Alpha'), headLine: 3, headColumn: 2 };
    const b = { ...mk('Beta'), headLine: 30, headColumn: 2 };
    expect(a).toMatchObject({ name: 'run', owner: 'Alpha' });
    keyFunctions([a, b]);
    expect([a.key, b.key]).toEqual(['Alpha::run#1', 'Beta::run#1']);
  });

  test('methods of an exported object literal carry the binding as owner', () => {
    const assign = { type: 'AssignmentExpression', left: { text: 'module.exports' } };
    const obj = link({ type: 'ObjectExpression' }, assign);
    const prop = link({ type: 'Property', key: id('save') }, obj);
    const f = fn(prop);
    prop.value = f;
    expect(functionOwner(f, text)).toBe('module.exports');
    const inner = fn(link({ type: 'VariableDeclarator', id: id('helper') }, f));
    expect(functionOwner(inner, text)).toBe('module.exports>save');
    expect(functionName(inner, text)).toBe('helper');
  });

  test('a route callback is named after its route, so it survives routes moving around', () => {
    const call = { type: 'CallExpression', callee: { text: "router.post" }, arguments: [{ type: 'Literal', value: '/pay' }] };
    const f = { type: 'ArrowFunctionExpression', parent: call };
    call.arguments.push(f);
    expect(functionName(f, text)).toBe("callback of router.post('/pay')");
    const other = { type: 'CallExpression', callee: { text: 'items.map' }, arguments: [] };
    const g = { type: 'ArrowFunctionExpression', parent: other };
    other.arguments.push(g);
    expect(functionName(g, text)).toBe('callback of items.map()');
  });

  test('a truly anonymous function has no name and is counted as anonymous', () => {
    const f = { type: 'FunctionExpression', parent: { type: 'ExpressionStatement' } };
    expect(functionName(f, text)).toBeNull();
    expect(countAnonymous([{ name: functionName(f, text) }])).toBe(1);
  });

  test('same-named methods of one class are told apart by ordinal', () => {
    const x = { name: 'run', owner: 'A', headLine: 3, headColumn: 0 };
    const y = { name: 'run', owner: 'A', headLine: 9, headColumn: 0 };
    keyFunctions([y, x]);
    expect([x.key, y.key]).toEqual(['A::run#1', 'A::run#2']);
  });
});
