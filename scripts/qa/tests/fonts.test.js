'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { waitForFonts } = require('../browser');
const root = path.resolve(__dirname, '../../..');
const directory = path.join(root, 'client/public/fonts');
const sources = require('../../../client/public/fonts/sources.json');

test('vendored font assets match their source hashes and local CSS references', () => {
  const css = fs.readFileSync(path.join(directory, 'fonts.css'), 'utf8');
  assert.ok(!css.includes('https://'), 'font CSS must work with external requests blocked');
  const references = new Set([...css.matchAll(/url\(\/fonts\/([^)]+)\)/g)].map((match) => match[1]));
  assert.equal(references.size, sources.fonts.length);
  for (const font of sources.fonts) {
    assert.ok(references.has(font.file));
    const data = fs.readFileSync(path.join(directory, font.file));
    assert.equal(data.subarray(0, 4).toString(), 'wOF2');
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), font.sha256);
    assert.equal(new URL(font.url).hostname, 'fonts.gstatic.com');
  }
  for (const family of Object.keys(sources.licenses)) {
    const license = fs.readFileSync(path.join(directory, family.toLowerCase().replaceAll(' ', '') + '-LICENSE.txt'), 'utf8');
    assert.match(license, /SIL OPEN FONT LICENSE|Apache License/);
    assert.ok(css.includes(`font-family: '${family}'`));
  }
  for (const file of fs.readdirSync(path.join(root, 'client')).filter((name) => name.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, 'client', file), 'utf8');
    assert.doesNotMatch(html, /fonts\.googleapis\.com/, `${file}: use the shared local fonts`);
    const entry = html.match(/<script[^>]+src="(\/src\/[^"]+)"/);
    assert.ok(entry, `${file}: expected a client entry point`);
    const source = fs.readFileSync(path.join(root, 'client', entry[1]), 'utf8');
    assert.match(source, /import ['"][^'"]*\/(?:index|fonts)\.css['"]/, `${file}: entry must import shared fonts`);
  }
});

test('font readiness rejects an unregistered family instead of accepting browser fallback', async () => {
  // Browser FontFaceSet.load resolves [] for an unknown family; ready alone
  // succeeds in that case, even though the screenshot uses a fallback.
  const vm = require('node:vm');
  const page = { evaluate: (callback, families) => vm.runInNewContext(`(${callback})(families)`, {
    families, document: { fonts: { ready: Promise.resolve(), load: async () => [] } },
  }) };
  await assert.rejects(waitForFonts(page), /QA font unavailable: Inter/);
});
