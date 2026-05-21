#!/usr/bin/env node
/**
 * generate-indexnow-key.js — one-time operator helper.
 *
 * IndexNow requires a key file at /{key}.txt on the site root that
 * contains the key itself. This generates a fresh 32-char hex key,
 * writes the key file to /tmp/, and prints the env var + commit
 * instructions.
 *
 * Workflow:
 *   1. Run: node server/scripts/generate-indexnow-key.js
 *   2. Copy the printed key file into wavespestcontrol-astro/public/
 *   3. Commit + deploy that change to wavespestcontrol-astro
 *   4. Verify the file is live at https://www.wavespestcontrol.com/{key}.txt
 *   5. Set INDEXNOW_KEY in Railway env
 *   6. (Recommended) Enable Cloudflare Pages' auto-IndexNow toggle
 *      in the Pages dashboard for the wavespestcontrol-astro project
 *
 * Runs locally only; no Railway / DB required.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const key = crypto.randomBytes(16).toString('hex'); // 32-char hex, per IndexNow spec
const keyFilePath = path.join('/tmp', `${key}.txt`);
fs.writeFileSync(keyFilePath, key, 'utf8');

console.log('\n── IndexNow key generated ──\n');
console.log(`Key:           ${key}`);
console.log(`Key file:      ${keyFilePath}`);
console.log('');
console.log('Next steps:');
console.log(`  1. Copy ${keyFilePath} into wavespestcontrol-astro/public/`);
console.log(`  2. Commit + deploy. Verify at https://www.wavespestcontrol.com/${key}.txt`);
console.log(`  3. Set Railway env:`);
console.log(`         INDEXNOW_KEY=${key}`);
console.log('  4. (Recommended) Enable Cloudflare Pages auto-IndexNow toggle for wavespestcontrol-astro');
console.log('');
console.log('Once the key file is live, indexnow-submit.js submissions will start being accepted.');
console.log('');
