#!/usr/bin/env node
// Copies schema.ts, schema.json, and checksum.txt from the Astro spoke repo
// into this admin vendor directory, renaming checksum.txt →
// upstream-checksum.txt. Run from the admin repo root:
//
//   npm run sync:blog-schema
//
// Astro repo location defaults to ../wavespestcontrol-astro relative to the
// admin repo root. Override with BLOG_SCHEMA_ASTRO_REPO=/abs/path.

'use strict';

const { copyFileSync, existsSync } = require('node:fs');
const { join, relative, resolve } = require('node:path');

const pkgDir = join(__dirname, '..');
const adminRoot = join(pkgDir, '..', '..');

const astroRoot = resolve(
  process.env.BLOG_SCHEMA_ASTRO_REPO ||
    join(adminRoot, '..', 'wavespestcontrol-astro'),
);
const srcDir = join(astroRoot, 'packages', 'blog-schema');

if (!existsSync(srcDir)) {
  console.error(`✗ Astro blog-schema source not found at ${srcDir}`);
  console.error(
    `  Set BLOG_SCHEMA_ASTRO_REPO to the absolute path of the Astro repo, ` +
    `or clone it as a sibling of this repo.`,
  );
  process.exit(1);
}

const copies = [
  { from: 'schema.ts', to: 'schema.ts' },
  { from: 'service-areas.ts', to: 'service-areas.ts' },
  { from: 'schema.json', to: 'schema.json' },
  { from: 'checksum.txt', to: 'upstream-checksum.txt' },
];

for (const { from, to } of copies) {
  const src = join(srcDir, from);
  const dst = join(pkgDir, to);
  if (!existsSync(src)) {
    console.error(`✗ missing upstream file: ${relative(astroRoot, src)}`);
    console.error(
      `  Run \`npm run generate:blog-schema\` in the Astro repo first.`,
    );
    process.exit(1);
  }
  copyFileSync(src, dst);
  console.log(`  ${from}  →  ${relative(adminRoot, dst)}`);
}

console.log('\n✓ blog-schema synced from Astro');
