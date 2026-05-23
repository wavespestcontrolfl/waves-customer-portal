#!/usr/bin/env node
/**
 * preview-internal-links.js — for a target URL, scan the local Astro
 * clone for anchor opportunities and print the proposed link
 * additions. NO PR opened — preview only.
 *
 * Use case: before running the autonomous-runner against a new page,
 * see what internal-link tasks it would generate. Catches over-linking
 * + bad anchor matches early.
 *
 * Usage:
 *   node server/scripts/preview-internal-links.js --target=/pest-control-bradenton-fl/ --keyword="pest control bradenton" --city=Bradenton --service="pest control"
 *   node server/scripts/preview-internal-links.js --target=/blog/new-post/ --keyword="termite vs flying ants" --cap=10
 *   node server/scripts/preview-internal-links.js --astro-dir=/path --target=/x/ --keyword="x"
 *
 * Runs locally; no DB or Railway env needed.
 */

const os = require('os');
const path = require('path');
const planner = require('../services/content/internal-link-planner');

function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(argv.map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const raw = a.slice(2);
    const eq = raw.indexOf('=');
    if (eq === -1) return [raw, true];
    const k = raw.slice(0, eq);
    const v = raw.slice(eq + 1);
    return [k, v === undefined ? true : v];
  }));
}

function parseCap(value, fallback = 5) {
  const n = Number.parseInt(value ?? fallback, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const astroDir = args['astro-dir'] || path.join(os.homedir(), 'Downloads', 'wavespestcontrol-astro');
  const targetUrl = args.target;
  const keyword = args.keyword || null;
  const city = args.city || null;
  const service = args.service || null;
  const title = args.title || null;
  const cap = parseCap(args.cap);

  if (!targetUrl) {
    console.error('Required: --target=<path or url>');
    console.error('Recommended: --keyword="<primary keyword>" [--city=X --service=Y]');
    process.exit(1);
  }

  const target = { url: targetUrl, keyword, city, service, title };

  console.log(`\nLoading Astro corpus from ${astroDir}…`);
  let corpus;
  try {
    corpus = planner.loadAstroCorpus(astroDir);
  } catch (err) {
    console.error(`Failed to load corpus: ${err.message}`);
    process.exit(1);
  }
  console.log(`Loaded ${corpus.length} page(s) across blog + services + locations.\n`);

  const tasks = planner.planForTarget(target, { corpus, cap });

  console.log(`Target:    ${target.url}`);
  console.log(`Keyword:   ${target.keyword || '—'}`);
  console.log(`City/svc:  ${target.city || '—'} / ${target.service || '—'}`);
  console.log(`Cap:       ${cap} new link(s) per planning run`);
  console.log('');

  if (!tasks.length) {
    console.log('No anchor opportunities found.');
    console.log('Possible reasons:');
    console.log('  - keyword/phrase not mentioned anywhere in the corpus');
    console.log('  - every occurrence is already inside an existing link');
    console.log('  - every candidate page already links to this target');
    return;
  }

  console.log(`Proposed ${tasks.length} link addition(s):\n`);
  tasks.forEach((t, i) => {
    console.log(`#${i + 1}`);
    console.log(`  file:     ${t.source_file}`);
    console.log(`  anchor:   "${t.anchor_text}"`);
    console.log(`  → links to: ${t.target_url}`);
    console.log(`  context:  ${t.context_snippet}`);
    console.log('');
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  parseCap,
  main,
};
