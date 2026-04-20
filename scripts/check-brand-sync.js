#!/usr/bin/env node
/**
 * Drift check for brand tokens.
 *
 * theme-brand.js is a hand-ported mirror of the Astro site's STYLE_GUIDE.md.
 * Authority flows upstream → downstream; this script nudges whoever runs it
 * to verify the mirror is still fresh.
 *
 * Reads the "Last sync:" date from the theme-brand.js header and warns if
 * it's more than 90 days old. Never fails the build — gentle reminder only.
 *
 * Usage:  npm run check-brand-sync
 */

const fs = require('fs');
const path = require('path');

const THEME_FILE = path.join(__dirname, '..', 'client', 'src', 'theme-brand.js');
const STALE_DAYS = 90;

function main() {
  const src = fs.readFileSync(THEME_FILE, 'utf8');
  const match = src.match(/Last sync:\s*(\d{4}-\d{2}-\d{2})/);

  if (!match) {
    console.warn('⚠️  Could not find "Last sync: YYYY-MM-DD" in theme-brand.js header.');
    process.exit(0);
  }

  const lastSync = new Date(match[1] + 'T00:00:00Z');
  const now = new Date();
  const ageDays = Math.floor((now - lastSync) / (1000 * 60 * 60 * 24));

  if (ageDays > STALE_DAYS) {
    console.warn(
      `⚠️  theme-brand.js hasn't been synced with Astro in ${ageDays} days. ` +
      `Verify brand tokens still match wavespestcontrol-astro/docs/STYLE_GUIDE.md.`
    );
  } else {
    console.log(`✓ theme-brand.js last synced ${ageDays} days ago (threshold: ${STALE_DAYS}).`);
  }

  process.exit(0);
}

main();
