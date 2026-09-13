'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkFile } = require('../../check-portal-brand.js');

function scan(name, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-gate-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  try {
    return checkFile(file).map((v) => `${v.rule}:${v.line}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a whole-line // comment renders nothing, so it is not scanned', () => {
  // Icon.jsx's own note about the sweep this gate asks for.
  const hits = scan('Sample.jsx', [
    "// sweep could migrate `{'\u{1F3E0}'}` -> <Icon name=\"home\" /> deterministically.",
    'const MAP = {};',
  ].join('\n'));
  assert.deepEqual(hits, []);
});

test('a whole-line block comment is not scanned, across its whole span', () => {
  const hits = scan('Sample.jsx', [
    '/**',
    ' * continuous scroll, pause on hover. 5★ reviews only.',
    ' * fontSize: 11 in prose should not count either.',
    ' */',
    'export function X() { return null; }',
  ].join('\n'));
  assert.deepEqual(hits, []);
});

test('a code line with a trailing comment is still scanned in full', () => {
  const hits = scan('Sample.jsx', [
    'const a = { fontSize: 12 }; // deliberately undersized',
  ].join('\n'));
  assert.deepEqual(hits, ['banned-font-size:1']);
});

test('code after a closed block comment on its own line is still scanned', () => {
  const hits = scan('Sample.jsx', [
    '/* a note */',
    'const a = { fontWeight: 850 };',
  ].join('\n'));
  assert.deepEqual(hits, ['heavy-weight:2']);
});

test('a lone * line outside a block comment is CSS, not a comment', () => {
  // `* { font-size: 12px }` is the universal selector; skipping it by shape
  // would wave a real stylesheet violation through.
  const hits = scan('sample.css', ['* {', '  font-size: 12px;', '}'].join('\n'));
  assert.deepEqual(hits, ['banned-font-size:2']);
});

test('emoji in live JSX is still a violation', () => {
  const hits = scan('Sample.jsx', ["const label = '\u{1F512}';"]. join('\n'));
  assert.deepEqual(hits, ['emoji:1']);
});

test('code trailing a block-comment close is still scanned', () => {
  // The masking bug the first cut of this shipped with: inBlock + a closing
  // `*/` returned unconditionally, so live code after the close vanished.
  const hits = scan('Sample.jsx', [
    '/**',
    ' * a note',
    " */ const label = '\u{1F512}';",
  ].join('\n'));
  assert.deepEqual(hits, ['emoji:3']);
});

test('an unterminated block comment does NOT swallow the rest of the file', () => {
  // The prefix version let an unclosed `/*` hide every line after it. The
  // parser rejects the file instead, and a rejected file is scanned in full.
  const hits = scan('Sample.jsx', [
    '/* opened and never closed',
    'const a = { fontSize: 12 };',
  ].join('\n'));
  assert.deepEqual(hits, ['banned-font-size:2']);
});

test('JSX text that merely starts with // is NOT a comment', () => {
  // The masking hole a prefix test cannot see: this line is rendered, so a
  // raw emoji on it has to be reported.
  const hits = scan('Sample.jsx', [
    'export default function S() {',
    '  return (',
    '    <pre>',
    "      // looks like a comment, renders as text \u{1F512}",
    '    </pre>',
    '  );',
    '}',
  ].join('\n'));
  assert.deepEqual(hits, ['emoji:4']);
});

test('a real // comment in the same file is still skipped', () => {
  const hits = scan('Sample.jsx', [
    "// a genuine note about \u{1F512}",
    'export default function S() { return null; }',
  ].join('\n'));
  assert.deepEqual(hits, []);
});

test('an unparseable file is scanned in full rather than skipped', () => {
  // Never mask: a parse failure must not turn into a free pass.
  const hits = scan('Broken.jsx', [
    '// a note',
    'function ( { this is not javascript',
    'const a = { fontSize: 12 };',
  ].join('\n'));
  assert.ok(hits.includes('banned-font-size:3'));
});

test('a trailing comment after code does not make the line a comment', () => {
  const hits = scan('Sample.jsx', [
    'const a = 1; // trailing',
    '/* whole */',
    'const b = { fontSize: 12 };',
  ].join('\n'));
  assert.deepEqual(hits, ['banned-font-size:3']);
});

test('a `/*` inside a CSS string does not open a comment', () => {
  // Regression: the regex version blanked every rule between content: "/*"
  // and the next "*/", hiding real violations in between.
  const hits = scan('sample.css', [
    '.a::before { content: "/*"; }',
    '.b { font-size: 12px; }',
    '.c::after { content: "*/"; }',
  ].join('\n'));
  assert.deepEqual(hits, ['banned-font-size:2']);
});

test('a real CSS comment is still skipped', () => {
  const hits = scan('sample.css', [
    '/* font-size: 12px in prose */',
    '.a { color: red; }',
  ].join('\n'));
  assert.deepEqual(hits, []);
});

test('a standalone {/* ... */} JSX comment is not scanned', () => {
  // The standard JSX comment form: the parser's range covers only the
  // `/* ... */`, leaving the braces as non-whitespace on the line.
  const hits = scan('Sample.jsx', [
    'export default function S() {',
    '  return (',
    '    <div>',
    '      {/* fontSize: 12 and \u{1F512} in a note, nothing rendered */}',
    '      <span>hi</span>',
    '    </div>',
    '  );',
    '}',
  ].join('\n'));
  assert.deepEqual(hits, []);
});

test('braces holding more than the comment are not treated as a wrapper', () => {
  // `{/* note */ x}` is an expression with a comment in it, not a comment.
  // Only the comment itself is blanked, so the line keeps its code and is
  // scanned like any other.
  const hits = scan('Sample.jsx', [
    'const a = <div>{/* note */ x}</div>;',
    'const b = { fontSize: 12 };',
  ].join('\n'));
  assert.deepEqual(hits, ['banned-font-size:2']);
});

test('TypeScript parses, so its comments are classified too', () => {
  // walk() accepts .ts/.tsx; a parser that cannot read them would send every
  // such file down the failure path and report its comment prose as debt.
  const hits = scan('Sample.tsx', [
    'interface P { size: number }',
    '// a note about \u{1F512} and fontSize: 12',
    'export const S = (p: P): number => p.size;',
  ].join('\n'));
  assert.deepEqual(hits, []);
});

test('TypeScript still reports real violations', () => {
  const hits = scan('Sample.tsx', [
    'interface P { size: number }',
    'export const S = (p: P) => ({ fontSize: 12 });',
  ].join('\n'));
  assert.deepEqual(hits, ['banned-font-size:2']);
});

test('a `/*` inside an unquoted url() does not open a comment', () => {
  // URL data, not CSS syntax — the previous cut swallowed every rule until
  // the next `*/`.
  const hits = scan('sample.css', [
    '.a { background: url(data:image/svg+xml,/*); }',
    '.b { font-size: 12px; }',
  ].join('\n'));
  assert.deepEqual(hits, ['banned-font-size:2']);
});

test('a quoted url() still goes through the string path', () => {
  const hits = scan('sample.css', [
    '.a { background: url("data:image/svg+xml,/*"); }',
    '.b { font-size: 12px; }',
  ].join('\n'));
  assert.deepEqual(hits, ['banned-font-size:2']);
});

test('an escaped paren inside url() does not end the token', () => {
  // postcss knows url() escapes; the hand-written scanner did not.
  const hits = scan('sample.css', [
    '.a { background: url(foo\\)/*); }',
    '.b { font-size: 12px; }',
  ].join('\n'));
  assert.deepEqual(hits, ['banned-font-size:2']);
});

test('a CSS file postcss rejects is scanned in full, never skipped', () => {
  const hits = scan('sample.css', [
    '.a { --token: \\/*; }',
    '.b { font-size: 12px; }',
  ].join('\n'));
  assert.deepEqual(hits, ['banned-font-size:2']);
});

test('comments inside a <style> template are classified as comments', () => {
  // Babel sees the CSS as template-string data, so its comments never reach
  // ast.comments; the style-template pass is what finds them.
  const hits = scan('Sample.jsx', [
    'export default function S() {',
    '  return (',
    '    <style>{`',
    '      /* font-size: 12px was retired here */',
    '      .a { color: red; }',
    '    `}</style>',
    '  );',
    '}',
  ].join('\n'));
  assert.deepEqual(hits, []);
});

test('live CSS inside a <style> template is still scanned', () => {
  const hits = scan('Sample.jsx', [
    'export default function S() {',
    '  return <style>{`.a { font-size: 12px; }`}</style>;',
    '}',
  ].join('\n'));
  assert.deepEqual(hits, ['banned-font-size:2']);
});

test('.ts parses with the TypeScript grammar, not JSX', () => {
  // `<number>1` is a valid TS assertion and invalid JSX; with both plugins on
  // the file was rejected and its comments scanned.
  const hits = scan('Sample.ts', [
    '// a note about \u{1F512}',
    'const n = <number>1;',
    'export default n;',
  ].join('\n'));
  assert.deepEqual(hits, []);
});

test('an interpolated <style> template keeps every line scanned', () => {
  // A quasi is not independently valid CSS. With prefix = 'url(foo', the `/*`
  // below is URL data once combined, but the quasi after the interpolation
  // starts at `/*` and would read as a comment running to the next `*/`,
  // masking the live rule between them.
  const hits = scan('Sample.jsx', [
    'const prefix = "url(foo";',
    'export default function S() {',
    '  return (',
    '    <style>{`',
    '      .a { background: ${prefix}/*); }',
    '      .b { font-size: 12px; }',
    '      /* real comment */',
    '    `}</style>',
    '  );',
    '}',
  ].join('\n'));
  assert.ok(hits.includes('banned-font-size:6'), `expected the live 12px rule, got ${JSON.stringify(hits)}`);
});

test('sibling style expressions cannot hide live CSS as a template comment', () => {
  const hits = scan('Sample.jsx', [
    'const prefix = ".a { background: url(foo";',
    'export default function S() {',
    '  return <style>{prefix}{`/*); }',
    '    .b { font-size: 12px; }',
    '    /* real comment */',
    '  `}</style>;',
    '}',
  ].join('\n'));
  assert.ok(hits.includes('banned-font-size:4'), `expected the live 12px rule, got ${JSON.stringify(hits)}`);
});
