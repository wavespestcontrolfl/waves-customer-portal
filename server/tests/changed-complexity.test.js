// Pure-function tests for the changed-function complexity gate
// (scripts/check-changed-complexity.js). No git, no ESLint run.
const {
  parseDiffRanges, isLintable, rangesTouch, findFunctionForMessage,
  parseComplexityMessage, parseDepthMessage, violationsForFile, formatViolation, HINT, WARN_NOTE,
  parseDiffOldPaths, keyFunctions, countAnonymous, baseScoreMap, classifyViolations,
} = require('../../scripts/lib/changed-complexity');

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

  test('max-depth is judged on the too-deep block itself', () => {
    const inBlock = violationsForFile('server/a.js', messages, fns, [{ start: 102, end: 102, deletion: false }]);
    // line 102 is also inside the old `legacy` function (60-120), so that function is changed too
    expect(inBlock.map((x) => x.rule).sort()).toEqual(['complexity', 'max-depth']);
    expect(inBlock.find((x) => x.rule === 'max-depth')).toMatchObject({ line: 100, score: 5, max: 4 });
    // a change elsewhere in the same old function, outside the deep block, does not trip it
    const elsewhere = violationsForFile('server/a.js', messages, fns, [{ start: 70, end: 70, deletion: false }]);
    expect(elsewhere.map((x) => x.rule)).toEqual(['complexity']); // the function changed, the deep block did not
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
