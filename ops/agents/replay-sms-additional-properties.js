#!/usr/bin/env node
'use strict';
// MUTATES (dry-run default) — ONE explicitly selected inbound SMS, address
// proposals only. Never backdates shared gates or replays profile/owed writes.
// Both modes use the bounded SMS extractor. Execute requires the exact preview.
async function main() {
  const { values } = require('node:util').parseArgs({ options: {
    'sms-log-id': { type: 'string' }, 'preview-hash': { type: 'string' }, execute: { type: 'boolean', default: false },
  } });
  if (!require('uuid').validate(values['sms-log-id']) || !process.env.DATABASE_URL) throw new Error('arguments_required');
  const db = require('../../server/models/db');
  try {
    const result = await require('../../server/services/sms-additional-properties').replayAdditionalProperties({
      smsLogId: values['sms-log-id'], execute: values.execute, previewHash: values['preview-hash'],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.skipped) process.exitCode = 1;
  } finally { await db.destroy(); }
}
main().catch(() => { process.stderr.write('Address replay failed. Check gates, preview and source in the selected environment.\n'); process.exitCode = 1; });
