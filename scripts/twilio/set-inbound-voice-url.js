#!/usr/bin/env node
/**
 * Dry-run/apply helper for switching Waves Twilio numbers between the current
 * Studio Flow and the app-owned inbound voice webhook.
 *
 * Dry-run one number:
 *   npm run twilio:inbound:set-url -- --mode=app --number=+19413187612
 *
 * Apply one number:
 *   npm run twilio:inbound:set-url -- --mode=app --number=+19413187612 --apply
 *
 * Apply all configured Waves numbers:
 *   npm run twilio:inbound:set-url -- --mode=app --apply
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const twilio = require('twilio');
const TWILIO_NUMBERS = require('../../server/config/twilio-numbers');

const FLOW_SID = process.env.TWILIO_INBOUND_FLOW_SID || 'FW5fdc2e44700c6e786ed27de94e0cbace';
const APP_VOICE_URL =
  process.env.TWILIO_EXPECTED_APP_VOICE_URL ||
  'https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/voice';

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function maskPhone(value) {
  return String(value || '').replace(/\+1(\d{3})(\d{3})(\d{4})/g, '+1$1***$3');
}

function targetVoiceUrl(mode, accountSid) {
  if (mode === 'app') return APP_VOICE_URL;
  if (mode === 'studio') return `https://webhooks.twilio.com/v1/Accounts/${accountSid}/Flows/${FLOW_SID}`;
  throw new Error(`Unsupported --mode=${mode}. Expected "app" or "studio".`);
}

async function main() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');

  const mode = argValue('mode', 'app');
  const onlyNumber = argValue('number', null);
  const apply = hasFlag('apply');
  const target = targetVoiceUrl(mode, accountSid);
  const expectedNumbers = new Set(TWILIO_NUMBERS.allNumbers.map((item) => item.number));

  if (onlyNumber && !expectedNumbers.has(onlyNumber)) {
    throw new Error(`--number ${maskPhone(onlyNumber)} is not in server/config/twilio-numbers.js`);
  }

  const client = twilio(accountSid, authToken);
  const incomingNumbers = await client.incomingPhoneNumbers.list({ limit: 1000 });
  const selected = incomingNumbers
    .filter((item) => expectedNumbers.has(item.phoneNumber))
    .filter((item) => !onlyNumber || item.phoneNumber === onlyNumber)
    .sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber));

  const missing = [...expectedNumbers]
    .filter((number) => !incomingNumbers.some((item) => item.phoneNumber === number))
    .map(maskPhone);

  const changes = [];
  for (const number of selected) {
    const before = number.voiceUrl || '';
    const changed = before !== target;
    const row = {
      number: maskPhone(number.phoneNumber),
      changed,
      before,
      after: target,
      applied: false,
    };

    if (changed && apply) {
      await client.incomingPhoneNumbers(number.sid).update({
        voiceUrl: target,
        voiceMethod: 'POST',
      });
      row.applied = true;
    }

    changes.push(row);
  }

  console.log(JSON.stringify({
    mode,
    apply,
    selected: selected.length,
    missing,
    changesNeeded: changes.filter((row) => row.changed).length,
    changes,
  }, null, 2));

  if (missing.length) process.exit(1);
}

main().catch((err) => {
  console.error(`set-inbound-voice-url failed: ${err.message}`);
  process.exit(1);
});
