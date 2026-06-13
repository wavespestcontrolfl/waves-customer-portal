#!/usr/bin/env node

/**
 * Import a Google Search Console Links CSV export into seo_backlinks.
 *
 * Usage:
 *   node server/scripts/import-gsc-links.js ~/Downloads/gsc-links.csv          # dry run
 *   node server/scripts/import-gsc-links.js ~/Downloads/gsc-links.csv --apply  # write rows
 */

const fs = require('fs');
const path = require('path');
const importer = require('../services/seo/gsc-links-importer');
const db = require('../models/db');

async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find((arg) => !arg.startsWith('--'));
  const apply = args.includes('--apply');
  const defaultTargetArg = args.find((arg) => arg.startsWith('--default-target='));
  const defaultTargetUrl = defaultTargetArg ? defaultTargetArg.split('=').slice(1).join('=').trim() : undefined;

  if (!csvPath) {
    console.error('Usage: node server/scripts/import-gsc-links.js <gsc-links.csv> [--apply] [--default-target=https://wavespestcontrol.com/]');
    process.exit(1);
  }

  const csvText = fs.readFileSync(path.resolve(csvPath), 'utf8');
  const result = await importer.importCsv(csvText, {
    apply,
    defaultTargetUrl,
    sourceLabel: `gsc_links_export:${path.basename(csvPath)}`,
  });

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
