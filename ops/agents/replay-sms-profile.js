#!/usr/bin/env node
'use strict';

// MUTATES (dry-run default) — explicitly re-extract ONE analyzed inbound SMS
// into the existing staff-review proposal queue. Preserves prior profile
// writes, original analysis and receipts. No customer communications.
// Dry run makes no LLM calls; --execute uses the existing gated extractor.
// Usage: node ops/agents/replay-sms-profile.js --sms-log-id=<uuid> [--execute]
// Supply the intended DATABASE_URL through the execution environment. Local
// verification must use a verified dev/preview database and synthetic rows.

async function main() {
  const { parseArgs } = require('node:util');
  const { values } = parseArgs({ options: {
    'sms-log-id': { type: 'string' }, execute: { type: 'boolean', default: false },
  } });
  if (!require('uuid').validate(values['sms-log-id'])) throw new Error('--sms-log-id=<uuid> is required');
  if (!process.env.DATABASE_URL) throw new Error('Supply the intended DATABASE_URL through the execution environment');
  const db = require('../../server/models/db');
  try {
    const { replaySmsProfile } = require('../../server/services/sms-operational-actions');
    const result = await replaySmsProfile({ smsLogId: values['sms-log-id'], execute: values.execute });
    // Identifiers, field names and disposition only; no source text, private
    // values or provider response objects reach operator output.
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.failed || result.skipped) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

main().catch(() => {
  process.stderr.write('SMS replay failed. Check arguments, gates and the selected execution environment.\n');
  process.exitCode = 1;
});
