#!/usr/bin/env node
/**
 * Check for new Claude models via the Anthropic API.
 * Compares all available models against what we're currently using.
 *
 * Usage:  npm run models:check
 *
 * When a newer model looks good, upgrade by setting the env var in Railway:
 *   MODEL_FLAGSHIP=<new-model-id>
 * Then restart the service. No code deploy required.
 */

const https = require('https');
const path = require('path');

const MODELS = require(path.join(__dirname, '..', 'server', 'config', 'models'));

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY not set. Load it first:  export ANTHROPIC_API_KEY=...');
  process.exit(1);
}

function fetchModels() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/models?limit=50',
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Invalid JSON: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log('Checking available Claude models via Anthropic API...\n');

  let result;
  try { result = await fetchModels(); }
  catch (err) {
    console.error('Fetch failed:', err.message);
    process.exit(1);
  }

  const models = (result.data || []).sort((a, b) =>
    new Date(b.created_at || 0) - new Date(a.created_at || 0)
  );

  if (models.length === 0) {
    console.log('No models returned by API.');
    return;
  }

  console.log('Available models (newest first):\n');
  models.forEach((m) => {
    const date = m.created_at ? m.created_at.split('T')[0] : '?';
    const name = m.display_name || m.id;
    console.log(`  ${m.id.padEnd(38)} ${date}  ${name}`);
  });

  console.log('\n──────────────────────────────────────────────────────');
  console.log('Currently in use (server/config/models.js):');
  console.log(`  FLAGSHIP   = ${MODELS.FLAGSHIP}`);
  console.log(`  WORKHORSE  = ${MODELS.WORKHORSE}`);
  console.log(`  FAST       = ${MODELS.FAST}`);

  const inUse = new Set([MODELS.FLAGSHIP, MODELS.WORKHORSE, MODELS.FAST]);
  const missing = [...inUse].filter((id) => !models.some((m) => m.id === id));
  if (missing.length > 0) {
    console.log('\nWARNING — these IDs in config are NOT in the API list (typo or retired?):');
    missing.forEach((id) => console.log(`  ${id}`));
  }

  const newer = models.filter((m) => !inUse.has(m.id)).slice(0, 5);
  if (newer.length > 0) {
    console.log('\nNewer/alternative models you could try:');
    newer.forEach((m) => console.log(`  ${m.id}  (${m.display_name || m.id})`));
    console.log('\nTo swap:  set MODEL_FLAGSHIP / MODEL_WORKHORSE / MODEL_FAST in Railway, restart.');
  } else {
    console.log('\nYou are already on the latest.');
  }
})();
