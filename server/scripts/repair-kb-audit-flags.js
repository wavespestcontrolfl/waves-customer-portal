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
 * Step 2 (--reaudit N): re-run the fixed audit on up to N entries the AI
 * audit still hides (hand-written entries); an explicit pass restores them.
 * Entries a person flagged are never touched. Costs one DEEP model
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

// Generated rows whose latest flag came from the AI audit.
function generatedAiFlaggedQuery() {
  return db('knowledge_base')
    .where({ status: 'flagged', source: 'auto-sync' })
    .whereRaw(`(
      SELECT a.audit_type FROM knowledge_base_audits a
      WHERE a.kb_entry_id = knowledge_base.id AND a.audit_type IN ('ai-review', 'manual-flag')
        AND a.result = 'flagged'
      ORDER BY a.created_at DESC LIMIT 1
    ) = 'ai-review'`);
}

async function main() {
  const rows = await generatedAiFlaggedQuery().select('id', 'slug').orderBy('slug');
  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'}: ${rows.length} generated entries flagged by the AI audit`);
  for (const r of rows.slice(0, 20)) console.log(`  ${r.slug}`);
  if (rows.length > 20) console.log(`  … ${rows.length - 20} more`);

  if (APPLY && rows.length) {
    // Same row lock every flag write takes, so a person's flag landing after
    // the list above is seen and kept.
    const { _internals: { flagIsFromAIAudit } } = require('../services/knowledge-base');
    let n = 0;
    for (const { id } of rows) {
      n += await db.transaction(async (trx) => {
        const row = await trx('knowledge_base').where({ id }).forUpdate().first();
        if (!row || row.status !== 'flagged' || !(await flagIsFromAIAudit(row, trx))) return 0;
        await trx('knowledge_base').where({ id }).update({ status: 'active', updated_at: new Date() });
        return 1;
      });
    }
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
      console.log(`re-audited ${result.audited}: ${result.passed} passed (restored), ${result.flagged} still flagged, ${result.audited - result.passed - result.flagged} no verdict (unchanged)`);
      for (const r of result.results) console.log(`  ${r.status}\t${r.title}\t${String(r.summary || '').slice(0, 140)}`);
    }
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.destroy());
