#!/usr/bin/env node
/**
 * test-image-generator.js — manual single-image generation for the
 * provider chain. Saves the resulting PNG to /tmp/ for visual review.
 *
 * COSTS REAL MONEY when --confirm is passed. Without --confirm the
 * script only runs capabilityCheck (free) and prints which providers
 * would be tried.
 *
 * Usage:
 *   node server/scripts/test-image-generator.js                       # capability check only
 *   node server/scripts/test-image-generator.js --confirm --title="Test image"
 *   node server/scripts/test-image-generator.js --confirm --mode=social-square --title="X"
 *   node server/scripts/test-image-generator.js --confirm --provider=gemini --title="X"
 *
 * For prod env (DataForSEO unrelated — only OPENAI/GEMINI keys needed):
 *   railway run -- bash -c '
 *     node server/scripts/test-image-generator.js --confirm --title="Pest control bradenton"
 *   '
 */

const fs = require('fs');
const path = require('path');
const { ImageGenerator } = require('../services/content/image-generator');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);

const CONFIRMED = !!ARGS.confirm;
const TITLE = ARGS.title || 'Pest control near Bradenton, FL';
const TOPIC = ARGS.topic || null;
const KEYWORD = ARGS.keyword || null;
const CITY = ARGS.city || null;
const MODE = ARGS.mode || 'blog-hero';
const PROVIDER_OVERRIDE = ARGS.provider || null;

const ESTIMATED_COSTS = {
  'gpt-image-2': '~$0.165 (high landscape)',
  'gpt-image-1.5': '~$0.20',
  'gpt-image-1': '~$0.25 (high landscape)',
  'gemini': 'included in Gemini quota (free tier varies)',
};

(async function main() {
  const envChain = PROVIDER_OVERRIDE || process.env.BLOG_IMAGE_PROVIDER;
  const gen = new ImageGenerator({ envChain });

  console.log('\n── image-generator dry-check ──\n');
  console.log(`Chain: ${gen.chain.join(' → ')}`);
  console.log(`Mode:  ${MODE}`);
  console.log(`Title: ${TITLE}`);
  console.log('');

  console.log('Capability check (free):');
  const check = await gen.capabilityCheck();
  for (const [provider, status] of Object.entries(check.providers)) {
    const cost = ESTIMATED_COSTS[provider] || '?';
    console.log(`  ${provider.padEnd(16)} ${status.padEnd(28)} (cost: ${cost})`);
  }
  console.log('');

  if (!CONFIRMED) {
    console.log('Pass --confirm to actually generate an image (will spend credits on the first available provider).');
    return;
  }

  console.log('Generating (spending credits)…');
  try {
    const t0 = Date.now();
    const result = await gen.generate({
      title: TITLE,
      topic: TOPIC,
      keyword: KEYWORD,
      city: CITY,
      mode: MODE,
    });
    const ms = Date.now() - t0;

    // Decode and write to /tmp
    const match = /^data:([^;]+);base64,(.+)$/.exec(result.dataUrl);
    if (!match) {
      console.error('Malformed dataUrl returned.');
      process.exit(1);
    }
    const ext = match[1].split('/')[1] || 'png';
    const outPath = path.join('/tmp', `image-gen-${result.model}-${Date.now()}.${ext}`);
    fs.writeFileSync(outPath, Buffer.from(match[2], 'base64'));

    console.log(`\nSuccess via ${result.model} (${ms}ms, ${match[2].length} chars b64)`);
    console.log(`Wrote: ${outPath}`);
    console.log('\nAttempts:');
    for (const a of result.attempts) {
      console.log(`  ${a.provider.padEnd(16)} ${a.result.dataUrl ? 'ok' : (a.result.status || a.result.reason || 'unknown')}`);
    }
  } catch (err) {
    console.error('\nGeneration failed:', err.message);
    if (err.attempts) {
      console.error('Attempts:');
      for (const a of err.attempts) {
        console.error(`  ${a.provider}: ${JSON.stringify(a.result)}`);
      }
    }
    process.exit(1);
  }
})();
