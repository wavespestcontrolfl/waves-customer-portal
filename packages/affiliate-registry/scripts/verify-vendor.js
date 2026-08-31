#!/usr/bin/env node
// Drift check for the vendored affiliate registry (blog-schema pattern).
//
// Source of truth lives in the Astro repo at
// wavespestcontrol-astro/packages/affiliate-registry/registry.json — the
// owner approves product rows by merging PRs THERE. This copy is vendored;
// editing it directly is not allowed (a hand-edit could introduce an
// unapproved tracking URL that the publish gate would then honor). The
// workflow is: astro PR merged → `npm run sync:affiliate-registry` here,
// which copies registry.json + the upstream checksum.
//
// Computes sha256("\0registry.json\0" + bytes) and compares it to
// upstream-checksum.txt (the Astro repo records the same recipe in its
// checksum.txt). Also validates the vendored registry's structure so a
// malformed copy can never boot the server into a fail-open state. Any
// drift or invalidity fails the build/start.

'use strict';

const { readFileSync, existsSync } = require('node:fs');
const { join, relative } = require('node:path');

const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');
const registryPath = join(pkgDir, 'registry.json');
const checksumPath = join(pkgDir, 'upstream-checksum.txt');

function fail(message) {
  console.error(`\n✗ affiliate-registry vendor check failed\n  ${message}\n`);
  console.error(
    `  If the registry legitimately changed upstream (an owner-merged astro PR), run:\n` +
    `    npm run sync:affiliate-registry\n` +
    `  to pull the new registry.json and refresh the recorded checksum.\n`,
  );
  process.exit(1);
}

const { validateRegistry, registryChecksum } = require(join(pkgDir, 'index.js'));

if (!existsSync(registryPath)) fail(`missing ${relative(repoRoot, registryPath)}`);
if (!existsSync(checksumPath)) fail(`missing ${relative(repoRoot, checksumPath)}`);

const bytes = readFileSync(registryPath);
const expected = readFileSync(checksumPath, 'utf8').trim();
const actual = registryChecksum(bytes);
if (expected !== actual) {
  fail(`sha256(registry.json) does not match upstream-checksum.txt\n  expected: ${expected}\n  actual:   ${actual}`);
}

let parsed;
try { parsed = JSON.parse(bytes.toString('utf8')); } catch (err) { fail(`registry.json is not valid JSON: ${err.message}`); }
const problems = validateRegistry(parsed);
if (problems.length) {
  fail(`registry.json fails validation:\n${problems.map((p) => p.errors.map((e) => `    - ${p.product_id || '(registry)'}: ${e}`).join('\n')).join('\n')}`);
}

console.log(`✓ affiliate-registry vendor check passed (${actual.slice(0, 12)}…, ${parsed.products.length} product row(s))`);
