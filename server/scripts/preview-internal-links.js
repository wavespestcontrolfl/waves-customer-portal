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

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);

const ASTRO_DIR = ARGS['astro-dir'] || path.join(os.homedir(), 'Downloads', 'wavespestcontrol-astro');
const TARGET = ARGS.target;
const KEYWORD = ARGS.keyword || null;
const CITY = ARGS.city || null;
const SERVICE = ARGS.service || null;
const TITLE = ARGS.title || null;
const CAP = parseInt(ARGS.cap || 5, 10);

if (!TARGET) {
  console.error('Required: --target=<path or url>');
  console.error('Recommended: --keyword="<primary keyword>" [--city=X --service=Y]');
  process.exit(1);
}

(function main() {
  const target = { url: TARGET, keyword: KEYWORD, city: CITY, service: SERVICE, title: TITLE };

  console.log(`\nLoading Astro corpus from ${ASTRO_DIR}…`);
  let corpus;
  try {
    corpus = planner.loadAstroCorpus(ASTRO_DIR);
  } catch (err) {
    console.error(`Failed to load corpus: ${err.message}`);
    process.exit(1);
  }
  console.log(`Loaded ${corpus.length} page(s) across blog + services + locations.\n`);

  const tasks = planner.planForTarget(target, { corpus, cap: CAP });

  console.log(`Target:    ${target.url}`);
  console.log(`Keyword:   ${target.keyword || '—'}`);
  console.log(`City/svc:  ${target.city || '—'} / ${target.service || '—'}`);
  console.log(`Cap:       ${CAP} new link(s) per planning run`);
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
})();
