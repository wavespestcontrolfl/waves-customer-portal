/**
 * Resumable backfill for the 2026-07 call-mining artifacts.
 *
 * Usage:
 *   node server/scripts/backfill-call-audit-findings.js findings <path/to/call-audit-findings-backfill.jsonl>
 *   node server/scripts/backfill-call-audit-findings.js verdicts <path/to/spam-verdicts-backfill.json>
 *
 * Idempotent: findings upsert on (call_log_id, audit_source, category, field);
 * verdicts upsert on (call_log_id, classifier_version). Re-running after a
 * partial failure completes the remainder. Read-only against every table
 * except the two audit tables created by migration 20260710000003.
 */

const fs = require('fs');
const path = require('path');
const db = require('../models/db');

const BATCH = 100;

async function backfillFindings(file) {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  console.log(`findings artifact: ${rows.length} rows`);
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((r) => ({
      call_log_id: r.call_log_id,
      twilio_call_sid: r.twilio_call_sid || null,
      call_created_at: r.call_created_at || null,
      audit_source: r.audit_source,
      category: r.category,
      severity: r.severity,
      field: r.field || '', // '' sentinel (see migration) — nullable field would break onConflict idempotency
      old_value: r.old_value ?? null,
      new_value: r.new_value ?? null,
      transcript_excerpt: r.transcript_excerpt || null,
      detail: JSON.stringify(r.detail || {}),
    }));
    await db('call_audit_findings')
      .insert(batch)
      .onConflict(['call_log_id', 'audit_source', 'category', 'field'])
      .merge(['severity', 'old_value', 'new_value', 'transcript_excerpt', 'detail']);
    written += batch.length;
    console.log(`  ${written}/${rows.length}`);
  }
}

async function backfillVerdicts(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`verdicts artifact: ${rows.length} rows`);
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((r) => ({
      call_log_id: r.call_log_id,
      verdict: r.verdict,
      signals: JSON.stringify(r.signals || {}),
      classifier_version: r.classifier_version,
    }));
    await db('call_spam_verdicts')
      .insert(batch)
      .onConflict(['call_log_id', 'classifier_version'])
      .merge(['verdict', 'signals']);
    written += batch.length;
    console.log(`  ${written}/${rows.length}`);
  }
}

(async () => {
  const [mode, file] = process.argv.slice(2);
  if (!['findings', 'verdicts'].includes(mode) || !file || !fs.existsSync(path.resolve(file))) {
    console.error('usage: node server/scripts/backfill-call-audit-findings.js <findings|verdicts> <artifact-path>');
    process.exit(1);
  }
  const hasTable = await db.schema.hasTable(mode === 'findings' ? 'call_audit_findings' : 'call_spam_verdicts');
  if (!hasTable) {
    console.error('audit tables missing — run migration 20260710000003 first');
    process.exit(1);
  }
  if (mode === 'findings') await backfillFindings(path.resolve(file));
  else await backfillVerdicts(path.resolve(file));
  await db.destroy();
  console.log('done');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
