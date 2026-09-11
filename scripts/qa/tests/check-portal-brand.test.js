'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkFile, commentSkipper } = require('../../check-portal-brand.js');

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

test('an unterminated block comment swallows the rest of the file', () => {
  const hits = scan('Sample.jsx', [
    '/* opened and never closed',
    'const a = { fontSize: 12 };',
  ].join('\n'));
  assert.deepEqual(hits, []);
});

test('commentSkipper keeps block state per instance', () => {
  const a = commentSkipper();
  assert.equal(a('/* open'), true);
  assert.equal(a('still inside'), true);
  assert.equal(a(' */'), true);
  assert.equal(a('const x = 1;'), false);
  // A fresh file must not inherit the previous one's block state.
  const b = commentSkipper();
  assert.equal(b('const y = 2;'), false);
});
