#!/usr/bin/env node
/**
 * Estimator Engine replay harness — the dev loop for composer/arbitration
 * changes. Replays a real call through the FULL pipeline (context → property
 * arbitration → composer → pricing → lanes) in dryRun mode: NO draft row,
 * NO notification, and NO property-lookup cache writes (dryRun threads
 * persist:false through performPropertyLookup). Run it on a couple of recent
 * quote calls before every engine change.
 *
 * Usage:
 *   node server/scripts/estimator-replay.js --call <call_log_id> [--json]
 *   node server/scripts/estimator-replay.js --recent [n]   # list recent quote-flavored calls
 *
 * Database: uses the process DATABASE_URL (dev/preview branch by default).
 * For a read-only prod replay from a local machine, pass the prod public URL
 * under a task-specific env name and name it explicitly:
 *   REPLAY_DATABASE_URL=... node server/scripts/estimator-replay.js --db-env REPLAY_DATABASE_URL --call <id>
 * (--db-env copies the named var onto DATABASE_URL for THIS process only —
 * never export DATABASE_URL in your shell.)
 *
 * Requires ANTHROPIC_API_KEY for the composer step.
 */

const args = process.argv.slice(2);

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const dbEnvName = argValue('--db-env');
if (dbEnvName) {
  if (!process.env[dbEnvName]) {
    console.error(`--db-env ${dbEnvName} named an empty env var`);
    process.exit(1);
  }
  process.env.DATABASE_URL = process.env[dbEnvName];
}

 
const db = require('../models/db');
const { syncConstantsFromDB } = require('../services/pricing-engine');
const { maybeDraftEstimateForCall } = require('../services/estimator-engine');

async function listRecent(limit) {
  const rows = await db('call_log')
    .select('id', 'created_at', 'lead_quality', 'disposition')
    .where('created_at', '>', db.raw("now() - interval '7 days'"))
    .where(function quoteFlavored() {
      this.where('disposition', 'estimate_send')
        .orWhereRaw("ai_extraction ILIKE '%\"quote_requested\": true%'")
        .orWhereRaw("ai_extraction ILIKE '%\"quote_promised\": true%'");
    })
    .orderBy('created_at', 'desc')
    .limit(limit);
  for (const r of rows) {
    console.log(`${r.id}  ${new Date(r.created_at).toISOString()}  ${r.disposition || '-'}  ${r.lead_quality || '-'}`);
  }
  if (!rows.length) console.log('No quote-flavored calls in the last 7 days.');
}

// PII redaction (AGENTS.md non-card PII logging rule): replays run against
// REAL production calls, and console output lands in captured logs. Contact
// fields and addresses are masked unless --reveal is passed explicitly.
const REVEAL = args.includes('--reveal');
function mask(value, keepStart = 0) {
  const s = String(value || '');
  if (!s) return '(none)';
  if (REVEAL) return s;
  return `${s.slice(0, keepStart)}…[${s.length} chars redacted]`;
}
function redactResult(result) {
  if (REVEAL) return result;
  const clone = JSON.parse(JSON.stringify(result));
  if (clone.addressUsed) clone.addressUsed = mask(clone.addressUsed, 4);
  if (clone.intent) {
    for (const field of ['customer_name', 'customer_phone', 'customer_email', 'address']) {
      if (clone.intent[field]) clone.intent[field] = mask(clone.intent[field], 2);
    }
    for (const e of clone.intent.evidence || []) {
      if (e.quote) e.quote = mask(e.quote, 6);
    }
  }
  if (clone.propertyFacts?.countyParcel) {
    const p = clone.propertyFacts.countyParcel;
    if (p.parcelId) p.parcelId = mask(p.parcelId, 0);
    if (p.subdivision) p.subdivision = mask(p.subdivision, 0);
  }
  if (clone.engineInput?.address) clone.engineInput.address = mask(clone.engineInput.address, 4);
  delete clone.engineResult;
  return clone;
}

function printSummary(result) {
  const facts = result.propertyFacts || {};
  console.log('\n══ ESTIMATOR REPLAY (dryRun — nothing written) ══');
  if (!REVEAL) console.log('(PII masked — pass --reveal for full values; unsuitable for captured logs)');
  console.log(`Lane: ${String(result.lane || 'unknown').toUpperCase()}`);
  if (result.reasons?.length) console.log(`Reasons:\n${result.reasons.map((r) => `  - ${r}`).join('\n')}`);
  console.log(`Address used: ${mask(result.addressUsed, 4)}`);
  if (facts.home) console.log(`Home/building sqft: ${facts.home.value ?? '(unresolved)'} [${facts.home.source}]${facts.home.sampleCount ? ` n=${facts.home.sampleCount}` : ''}`);
  if (facts.lot) console.log(`Lot sqft: ${facts.lot.value ?? '(unresolved)'} [${facts.lot.source}]`);
  if (facts.newConstruction) console.log('New construction: YES');
  if (facts.tenant) console.log('Tenant: YES');
  if (result.intent) {
    console.log(`Decision: ${result.intent.decision}${result.intent.skip_reason ? ` (${result.intent.skip_reason})` : ''}`);
    console.log(`Services: ${Object.entries(result.intent.services || {}).map(([k, v]) => `${k}${Object.keys(v || {}).length ? ` ${JSON.stringify(v)}` : ''}`).join(', ') || '(none)'}`);
    console.log(`Composer confidence: ${result.intent.confidence}`);
    if (result.intent.constraint_flags?.length) {
      console.log(`Constraints: ${result.intent.constraint_flags.map((f) => f.flag).join(', ')}`);
    }
  }
  if (result.totals) console.log(`Totals: $${result.totals.monthly}/mo · $${result.totals.annual}/yr · $${result.totals.oneTime} one-time`);
  if (result.comps && !result.comps.insufficient) {
    console.log(`Comps: median $${result.comps.median}/mo over ${result.comps.samples} (outlier: ${result.comps.outlier ? 'YES' : 'no'})`);
  }
  if (result.calibration?.length) {
    console.log(`Calibration drift: ${result.calibration.map((c) => c.serviceLine).join(', ')}`);
  }
}

(async () => {
  if (args.includes('--recent')) {
    const n = Number(argValue('--recent')) || 15;
    await listRecent(n);
    await db.destroy();
    return;
  }

  const callId = argValue('--call');
  if (!callId) {
    console.error('Usage: estimator-replay.js --call <call_log_id> [--json] | --recent [n]');
    process.exit(1);
  }

  await syncConstantsFromDB(db);
  const result = await maybeDraftEstimateForCall({
    callLogId: callId,
    dryRun: true,
    refreshLookup: args.includes('--refresh'),
  });

  if (args.includes('--json')) {
    console.log(JSON.stringify(redactResult(result), null, 2));
  } else {
    printSummary(result);
  }
  await db.destroy();
})().catch(async (err) => {
  console.error(`replay failed: ${err.stack || err.message}`);
  try { await db.destroy(); } catch { /* already closed */ }
  process.exit(1);
});
