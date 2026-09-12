'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkFile, commentLineSet } = require('../../check-portal-brand.js');

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

test('commentLineSet reports only whole-comment lines', () => {
  const text = [
    'const a = 1; // trailing',
    '/* whole */',
    'const b = { fontSize: 12 };',
  ].join('\n');
  assert.deepEqual([...commentLineSet(text, false)], [2]);
});
