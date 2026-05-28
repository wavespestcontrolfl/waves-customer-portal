#!/usr/bin/env node
/**
 * facts-bank-audit.js — manual invocation wrapper for facts-bank-auditor.
 *
 * Reads the structured v2 facts-bank from the Astro repo (filesystem in dev
 * via ASTRO_REPO_DIR, GitHub otherwise) and prints the readiness matrix:
 * which city × service pages have verified facts sufficient for AI-assisted
 * optimization, and exactly which facts are missing for the rest.
 *
 * Read-only. No DB writes, no content generation.
 *
 * Usage:
 *   ASTRO_REPO_DIR=/path/to/wavespestcontrol-astro \
 *     node server/scripts/facts-bank-audit.js
 *   node server/scripts/facts-bank-audit.js --json
 *   node server/scripts/facts-bank-audit.js --combo=sarasota:pest-control
 *
 * For GitHub source (no local Astro checkout):
 *   CONTENT_REGISTRY_ASTRO_SOURCE=github \
 *     node server/scripts/facts-bank-audit.js
 */

const auditor = require('../services/content-astro/facts-bank-auditor');

function parseArgs(argv) {
  const args = { json: false, combo: null };
  for (const a of argv.slice(2)) {
    if (a === '--json') args.json = true;
    else if (a.startsWith('--combo=')) args.combo = a.slice('--combo='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.combo) {
    const [city, service] = args.combo.split(':');
    const result = await auditor.auditCombination({ city, service });
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }
    console.log(`\nCombination: ${city} + ${service}`);
    console.log(`  sufficient: ${result.sufficient}  (disposition_hint: ${result.disposition_hint})`);
    console.log(`  files: ${JSON.stringify(result.files_status)}`);
    if (result.gap_codes.length) console.log(`  gap_codes:\n    - ${result.gap_codes.join('\n    - ')}`);
    return;
  }

  const all = await auditor.auditAll();

  if (args.json) {
    process.stdout.write(JSON.stringify(all, null, 2) + '\n');
    return;
  }

  const s = all.summary;
  console.log('\n=== Facts-Bank Readiness ===');
  console.log(`Cities:        ${s.cities_sufficient}/${s.cities_total} sufficient`);
  console.log(`Services:      ${s.services_sufficient}/${s.services_total} sufficient`);
  console.log(`Counties:      ${s.counties_generation_capable}/${s.counties_total} generation-capable`);
  console.log(`Combinations:  ${s.combinations_sufficient}/${s.combinations_total} sufficient for AI-assisted optimization`);

  console.log('\n--- Per-file status ---');
  for (const group of ['cities', 'services', 'counties']) {
    console.log(`\n${group}:`);
    for (const a of all.files[group]) {
      const mark = a.sufficient ? 'OK ' : (a.generation_allowed ? '~~ ' : 'XX ');
      const gaps = a.gap_codes.length ? `  [${a.gap_codes.slice(0, 3).join(', ')}${a.gap_codes.length > 3 ? ', …' : ''}]` : '';
      console.log(`  ${mark} ${a.entity_id} (${a.status})${gaps}`);
    }
  }

  console.log('\n--- Sufficient combinations (ready to optimize) ---');
  const ok = all.matrix.filter((m) => m.sufficient);
  if (ok.length === 0) console.log('  (none yet)');
  for (const m of ok) console.log(`  ${m.city} + ${m.service}  (county: ${m.county})`);

  console.log('\nLegend: OK = sufficient | ~~ = generation-capable but under-populated | XX = template/missing/invalid');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('facts-bank-audit failed:', err.message);
  process.exit(1);
});
