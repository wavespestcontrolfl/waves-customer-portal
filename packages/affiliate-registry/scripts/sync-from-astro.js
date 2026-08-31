#!/usr/bin/env node
// Copies registry.json (and checksum.txt → upstream-checksum.txt) from the
// Astro repo's packages/affiliate-registry into this vendor directory —
// the blog-schema sync pattern. Run from the admin repo root:
//
//   npm run sync:affiliate-registry
//
// Astro repo location defaults to ../wavespestcontrol-astro relative to the
// admin repo root. Override with AFFILIATE_REGISTRY_ASTRO_REPO=/abs/path.
//
// The copy is validated before it lands: a structurally-invalid upstream
// registry aborts the sync so the vendored copy can never regress from
// valid to broken silently. (Rows may still be paused/stale — that's
// classification, not structure.)

'use strict';

const { copyFileSync, existsSync, readFileSync } = require('node:fs');
const { join, relative, resolve } = require('node:path');

const pkgDir = join(__dirname, '..');
const adminRoot = join(pkgDir, '..', '..');

const astroRoot = resolve(
  process.env.AFFILIATE_REGISTRY_ASTRO_REPO ||
    join(adminRoot, '..', 'wavespestcontrol-astro'),
);
const srcDir = join(astroRoot, 'packages', 'affiliate-registry');

if (!existsSync(srcDir)) {
  console.error(`✗ Astro affiliate-registry source not found at ${srcDir}`);
  console.error(
    `  Set AFFILIATE_REGISTRY_ASTRO_REPO to the absolute path of the Astro ` +
    `repo, or clone it as a sibling of this repo.`,
  );
  process.exit(1);
}

const srcRegistry = join(srcDir, 'registry.json');
let parsed;
try {
  parsed = JSON.parse(readFileSync(srcRegistry, 'utf8'));
} catch (err) {
  console.error(`✗ Upstream registry.json is unreadable/malformed: ${err.message}`);
  process.exit(1);
}
const { validateRegistry } = require(join(pkgDir, 'index.js'));
const problems = validateRegistry(parsed);
if (problems.length) {
  console.error(`✗ Upstream registry.json fails validation — sync aborted:`);
  for (const p of problems) {
    for (const e of p.errors) console.error(`  - ${p.product_id || '(no id)'}: ${e}`);
  }
  process.exit(1);
}

const copies = [
  { from: 'registry.json', to: 'registry.json' },
  { from: 'checksum.txt', to: 'upstream-checksum.txt', optional: true },
];

for (const { from, to, optional } of copies) {
  const src = join(srcDir, from);
  if (!existsSync(src)) {
    if (optional) { console.warn(`~ upstream has no ${from} yet — skipped`); continue; }
    console.error(`✗ Missing upstream file: ${src}`);
    process.exit(1);
  }
  const dest = join(pkgDir, to);
  copyFileSync(src, dest);
  console.log(`✓ ${relative(adminRoot, dest)} ← ${src}`);
}

console.log('Done. Commit the vendored changes with the feature that needs them.');
