#!/usr/bin/env node
// Drift check for the vendored blog schema.
//
// Source of truth lives in the Astro spoke repo at
// wavespestcontrol-astro/packages/blog-schema/schema.ts.
//
// This admin copy is vendored. Editing it directly is not allowed — the
// workflow is: edit upstream → run `npm run generate:blog-schema` in the
// Astro repo → run `npm run sync:blog-schema` here to pull the updated
// files and record the new upstream checksum.
//
// This script computes sha256 of the local schema.ts and compares it to
// upstream-checksum.txt. Any drift fails the build.

'use strict';

const { readFileSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join, relative } = require('node:path');

const pkgDir = join(__dirname, '..');
const checksumPath = join(pkgDir, 'upstream-checksum.txt');
const repoRoot = join(pkgDir, '..', '..');

// Must match the set hashed by the Astro repo's generate.mjs.
const SOURCE_FILES = ['schema.ts', 'service-areas.ts'].sort();

function fail(message) {
  console.error(`\n✗ blog-schema drift check failed\n  ${message}\n`);
  console.error(
    `  If you intentionally updated the schema in the Astro repo, run:\n` +
    `    npm run sync:blog-schema\n` +
    `  to pull the new files and refresh the recorded checksum.\n`,
  );
  process.exit(1);
}

for (const name of SOURCE_FILES) {
  const p = join(pkgDir, name);
  if (!existsSync(p)) fail(`missing ${relative(repoRoot, p)}`);
}
if (!existsSync(checksumPath)) {
  fail(`missing ${relative(repoRoot, checksumPath)}`);
}

const expected = readFileSync(checksumPath, 'utf8').trim();
const hash = createHash('sha256');
for (const name of SOURCE_FILES) {
  hash.update(`\0${name}\0`);
  hash.update(readFileSync(join(pkgDir, name)));
}
const actual = hash.digest('hex');

if (expected !== actual) {
  fail(
    `sha256(${SOURCE_FILES.join(' + ')}) does not match upstream-checksum.txt\n` +
    `  expected: ${expected}\n` +
    `  actual:   ${actual}`,
  );
}

console.log(
  `✓ blog-schema vendor check passed (${actual.slice(0, 12)}…, ` +
    `hashed: ${SOURCE_FILES.join(', ')})`,
);
