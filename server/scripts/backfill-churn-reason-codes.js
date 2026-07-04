#!/usr/bin/env node
/**
 * One-off, idempotent backfill: AI-classify HISTORICAL churned customers into
 * churn_reason_code (Growth Command Center Phase 7).
 *
 * SAFETY MODEL
 * - DRY-RUN BY DEFAULT: prints what it would classify. Nothing is written
 *   unless --apply is passed. Run the dry-run first and eyeball it — this is
 *   the owner-authorized two-step the dashboard lane uses for prod scripts.
 * - Idempotent: only rows with churn_reason_code IS NULL or 'unclassified'
 *   are candidates; a re-run skips everything already classified. Backfilled
 *   rows get ' [ai-backfill]' appended to churn_reason_detail so they're
 *   distinguishable from live-classified rows forever.
 * - Fail-closed per row: a classification miss leaves that row unclassified
 *   and moves on; the script never dies mid-run on one bad row.
 * - INTERNAL_TEST_CUSTOMERS are skipped entirely.
 *
 * SOURCE TEXT, in preference order: the customer's newest cancellation-type
 * service_requests.description, else churn_reason_detail, else the legacy
 * 30-char churn_reason (weak, but sometimes enough for e.g. "moving").
 * Rows with no usable text stay unclassified — no text, no guess.
 *
 * Usage:
 *   node server/scripts/backfill-churn-reason-codes.js            # dry-run
 *   node server/scripts/backfill-churn-reason-codes.js --apply    # write
 *   node server/scripts/backfill-churn-reason-codes.js --limit=25 # cap batch
 */

const db = require('../models/db');
const { classifyChurnReason } = require('../services/churn-classifier');
const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 200) : 200;

async function main() {
  const qb = db('customers')
    .whereNotNull('churned_at')
    .where((w) => w.whereNull('churn_reason_code').orWhere('churn_reason_code', 'unclassified'))
    .orderBy('churned_at', 'desc')
    .limit(LIMIT);
  if (INTERNAL_TEST_CUSTOMERS.length) {
    qb.whereNotIn(
      db.raw("LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))"),
      INTERNAL_TEST_CUSTOMERS,
    );
  }
  const rows = await qb.select('id', 'first_name', 'last_name', 'churned_at', 'churn_reason', 'churn_reason_detail', 'churn_reason_code');

  console.log(`[backfill-churn] ${rows.length} candidate(s) (limit ${LIMIT}) — mode: ${APPLY ? 'APPLY' : 'DRY-RUN (pass --apply to write)'}`);
  let classified = 0;
  let skippedNoText = 0;

  for (const c of rows) {
    // Newest cancellation-type request text for this customer, if any —
    // service_requests discriminates on category/subject, not a request_type
    // column (verified against the live schema).
    let requestText = null;
    try {
      const req = await db('service_requests')
        .where({ customer_id: c.id })
        .whereRaw("(LOWER(COALESCE(category, '')) LIKE '%cancel%' OR LOWER(COALESCE(subject, '')) LIKE '%cancel%')")
        .orderBy('created_at', 'desc')
        .first('description');
      requestText = req?.description || null;
    } catch { /* service_requests shape differs — fall through */ }

    let text = String(requestText || c.churn_reason_detail || c.churn_reason || '').trim();
    // The legacy churn_reason is often just the processor's own boilerplate
    // constant — zero signal; classifying it wastes a model call per row and
    // risks a junk guess.
    if (/^customer cancellation request\.?$/i.test(text)) text = '';
    if (!text) {
      skippedNoText += 1;
      continue; // no text, no guess — stays unclassified
    }

    let code = 'unclassified';
    try {
      ({ code } = await classifyChurnReason(text));
    } catch { /* fail-closed per row */ }
    if (code === 'unclassified') {
      console.log(`  ~ ${c.id} (${c.churned_at}) — text present but unclassifiable: "${text.slice(0, 60)}"`);
      continue;
    }

    classified += 1;
    console.log(`  ${APPLY ? '✓' : '→'} ${c.id} (${c.churned_at}) ${code}  "${text.slice(0, 60)}"`);
    if (APPLY) {
      const detail = (c.churn_reason_detail || text).slice(0, 4000);
      await db('customers').where({ id: c.id }).update({
        churn_reason_code: code,
        churn_reason_detail: detail.includes('[ai-backfill]') ? detail : `${detail} [ai-backfill]`,
      });
    }
  }

  console.log(`[backfill-churn] done — ${classified} classified, ${skippedNoText} skipped (no text), ${rows.length - classified - skippedNoText} left unclassified.`);
  if (!APPLY && classified > 0) console.log('[backfill-churn] dry-run only — re-run with --apply to write.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`[backfill-churn] fatal: ${err.message}`);
  process.exit(1);
});
