#!/usr/bin/env node
/**
 * Export the production "Waves Inbound — All Numbers" Studio Flow
 * definition to ops/twilio/studio/waves-inbound-all-numbers.snapshot.json
 * with personal cell numbers redacted.
 *
 * Usage:
 *   npm run twilio:flow:export
 *
 * Reads TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN from env (Railway
 * `railway run` injects these; for local use export them or pull
 * via `railway run -s waves-customer-portal node scripts/twilio/export-studio-flow.js`).
 *
 * Sanitization rules:
 *   - forward_call.to (CSV of personal cells) → "<<FORWARD_NUMBERS>>"
 *     The contract verifier asserts structure (count, format), not
 *     literal digits, so personal cells stay out of git history.
 *   - Everything else copied as-is. MP3 asset URLs are public Twilio
 *     CDN URLs; portal callback URLs are the standard production URL.
 *
 * The snapshot exists for git-diff visibility on Studio Console
 * changes — it is NOT deployed back to Twilio. Manual change-mgmt
 * runbook in docs/twilio-studio-flow-contract.md.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const FLOW_SID = 'FW5fdc2e44700c6e786ed27de94e0cbace';
const SNAPSHOT_PATH = path.join(
  __dirname,
  '..',
  '..',
  'ops',
  'twilio',
  'studio',
  'waves-inbound-all-numbers.snapshot.json'
);
const REDACT_PLACEHOLDER = '<<FORWARD_NUMBERS>>';

function redact(definition) {
  // Deep-clone so we don't mutate the live response.
  const clone = JSON.parse(JSON.stringify(definition));
  if (Array.isArray(clone.states)) {
    for (const state of clone.states) {
      if (state.type === 'connect-call-to' && state.properties?.to) {
        state.properties.to = REDACT_PLACEHOLDER;
      }
    }
  }
  return clone;
}

async function main() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN.');
    console.error('Run via: railway run -s waves-customer-portal node scripts/twilio/export-studio-flow.js');
    process.exit(1);
  }

  const client = twilio(sid, token);
  const flow = await client.studio.v2.flows(FLOW_SID).fetch();

  const sanitized = redact(flow.definition);
  const out = {
    _comment:
      'Sanitized snapshot of the Waves Inbound Studio Flow. Personal cell numbers in connect-call-to.to are replaced with "<<FORWARD_NUMBERS>>". Updated via: npm run twilio:flow:export. Verified via: npm run twilio:flow:verify. See docs/twilio-studio-flow-contract.md.',
    flow_sid: flow.sid,
    friendly_name: flow.friendlyName,
    status: flow.status,
    revision: flow.revision,
    date_updated: flow.dateUpdated && flow.dateUpdated.toISOString(),
    definition: sanitized,
  };

  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(out, null, 2) + '\n');

  console.log(`Wrote ${path.relative(process.cwd(), SNAPSHOT_PATH)}`);
  console.log(`  flow_sid:      ${flow.sid}`);
  console.log(`  friendly_name: ${flow.friendlyName}`);
  console.log(`  revision:      ${flow.revision}`);
  console.log(`  status:        ${flow.status}`);
}

main().catch((e) => {
  console.error('export-studio-flow failed:', e.message);
  process.exit(1);
});
