#!/usr/bin/env node
/**
 * Un-hide knowledge-base entries the weekly AI audit flagged under its old rules.
 *
 * Forward-fix context: runAIAudit used to mark any flagged entry
 * status='flagged', which drops it from KB search, Intelligence Bar recall and
 * the estimate AI context — and nothing ever re-reviewed it. It also never told
 * the model today's date, so most flags complained about "future" verified
 * dates. Generated (source='auto-sync') entries are now never hidden: their
 * findings route to the source data (products catalog, protocols, pricing).
 *
 * Step 1 (always): generated entries whose current flag came from the AI audit
 * go back to status='active'. Their audit rows are kept.
 * Step 2 (--reaudit N): re-run the fixed audit on up to N entries still
 * flagged (hand-written entries); a pass restores them. Costs one DEEP model
 * call per entry.
 *
 * Usage:
 *   node server/scripts/repair-kb-audit-flags.js                      # DRY-RUN (default — no writes)
 *   node server/scripts/repair-kb-audit-flags.js --apply              # step 1
 *   node server/scripts/repair-kb-audit-flags.js --apply --reaudit 20 # step 1 + step 2
 *
 * Safe to re-run: restored rows no longer match the flagged filter.
 */
const db = require('../models/db');

const APPLY = process.argv.includes('--apply');
const reauditIdx = process.argv.indexOf('--reaudit');
const REAUDIT = reauditIdx >= 0 ? Math.max(0, parseInt(process.argv[reauditIdx + 1], 10) || 0) : 0;

async function generatedAiFlagged() {
  return db('knowledge_base as k')
    .select('k.id', 'k.slug')
    .where({ 'k.status': 'flagged', 'k.source': 'auto-sync' })
    .whereRaw(`(
      SELECT a.audit_type FROM knowledge_base_audits a
      WHERE a.kb_entry_id = k.id AND a.audit_type IN ('ai-review', 'manual-flag')
      ORDER BY a.created_at DESC LIMIT 1
    ) = 'ai-review'`)
    .orderBy('k.slug');
}

async function main() {
  const rows = await generatedAiFlagged();
  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'}: ${rows.length} generated entries flagged by the AI audit`);
  for (const r of rows.slice(0, 20)) console.log(`  ${r.slug}`);
  if (rows.length > 20) console.log(`  … ${rows.length - 20} more`);

  if (APPLY && rows.length) {
    const n = await db('knowledge_base')
      .whereIn('id', rows.map((r) => r.id))
      .where({ status: 'flagged' })
      .update({ status: 'active', updated_at: new Date() });
    console.log(`restored ${n}`);
  }

  const remaining = await db('knowledge_base').where({ status: 'flagged' }).count('* as c').first();
  console.log(`still flagged after step 1${APPLY ? '' : ' (projected)'}: ${Number(remaining.c) - (APPLY ? 0 : rows.length)}`);

  if (REAUDIT > 0) {
    if (!APPLY) {
      console.log(`--reaudit ${REAUDIT} skipped in dry-run (it calls the model and writes)`);
    } else {
      const KBService = require('../services/knowledge-base');
      const result = await KBService.runAIAudit({ flaggedOnly: true, maxEntries: REAUDIT });
      console.log(`re-audited ${result.audited}: ${result.audited - result.flagged} passed (restored), ${result.flagged} still flagged`);
      for (const r of result.results) console.log(`  ${r.status}\t${r.title}\t${String(r.summary || '').slice(0, 140)}`);
    }
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.destroy());
