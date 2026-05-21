#!/usr/bin/env node
/**
 * preview-briefs.js — composes briefs for the top-N pending
 * opportunities without claiming them or persisting. Use this to
 * validate the full chain end-to-end:
 *   opportunity_queue → SERP profiler → customer cluster lookup →
 *   conversion lookup → decision-router → brief composer
 *
 * Read-only by default (no-persist + skip-serp keep cost zero and
 * data immutable).
 *
 * Usage:
 *   node server/scripts/preview-briefs.js
 *   node server/scripts/preview-briefs.js --limit=10 --min-score=50 --with-serp
 *   node server/scripts/preview-briefs.js --json
 *
 * For prod:
 *   railway run -s Postgres -- bash -c '
 *     DATABASE_URL=$DATABASE_PUBLIC_URL \
 *       node server/scripts/preview-briefs.js
 *   '
 */

const db = require('../models/db');
const builder = require('../services/content/content-brief-builder');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);

const LIMIT = parseInt(ARGS.limit || 5, 10);
const MIN_SCORE = ARGS['min-score'] ? parseInt(ARGS['min-score'], 10) : null;
const WITH_SERP = !!ARGS['with-serp'];
const JSON_OUT = !!ARGS.json;

(async function main() {
  try {
    const t0 = Date.now();
    const briefs = await builder.previewTop({
      limit: LIMIT,
      minScore: MIN_SCORE,
      persist: false,
      skipSerp: !WITH_SERP,
    });
    const ms = Date.now() - t0;

    if (JSON_OUT) {
      process.stdout.write(JSON.stringify(briefs, null, 2));
      await db.destroy();
      return;
    }

    console.log(`\n── Brief Preview (top ${LIMIT}, ${ms}ms) ──`);
    if (!WITH_SERP) console.log('(SERP profiling skipped — pass --with-serp to enable)');
    console.log('');

    if (!briefs.length) {
      console.log('No pending opportunities matched the filter.');
      await db.destroy();
      return;
    }

    briefs.forEach((b, i) => {
      console.log('────────────────────────────────────────────────────────');
      const opp = b._opportunity;
      console.log(`#${i + 1}  ${opp.bucket} → ${b.action_type || '?'}`);
      console.log(`  target:        ${opp.query || opp.page_url || '—'}`);
      console.log(`  city/service:  ${b.city || '—'} / ${b.service || '—'}`);
      if (b.error) { console.log(`  ERROR:         ${b.error}`); console.log(''); return; }
      console.log(`  page_type:     ${b.page_type}`);
      console.log(`  miner score:   ${opp.score}  →  final ${b.final_score}`);
      console.log(`  human review:  ${b.human_review_required ? 'YES' : 'no'}${b.human_review_reason ? ` (${b.human_review_reason})` : ''}`);
      console.log(`  word target:   ${b.word_count_target}`);
      console.log(`  publish at:    ${b.publish_window?.slice(0, 16) || '—'}`);

      if (Object.keys(b.score_breakdown).length > 0) {
        const parts = Object.entries(b.score_breakdown).map(([k, v]) => `${k}:${v}`);
        console.log(`  scoring:       ${parts.join(' ')}`);
      }
      if (b.customer_signal) {
        console.log(`  customer:      ${b.customer_signal.normalized_question} (${b.customer_signal.total_count} mentions, ${b.customer_signal.funnel_stage})`);
      }
      if (b.conversion_signal) {
        const cs = b.conversion_signal;
        console.log(`  conversion:    ${cs.leads_total} leads, close=${cs.close_rate != null ? Math.round(cs.close_rate * 100) + '%' : '—'}, $${Math.round(cs.estimated_revenue || 0).toLocaleString()}`);
      }
      if (b.serp_signal && b.serp_signal.dominant_intent) {
        const s = b.serp_signal;
        console.log(`  SERP:          intent=${s.dominant_intent} page=${s.dominant_page_type} local_pack=${s.local_pack_present ? 'y' : 'n'} ai_overview=${s.ai_overview_present ? 'y' : 'n'}`);
      }
      if (b.required_sections?.length) {
        console.log(`  sections:      ${b.required_sections.slice(0, 4).join(' | ')}${b.required_sections.length > 4 ? ' …' : ''}`);
      }
      if (b.internal_links_to_add?.length) {
        console.log(`  internal links: ${b.internal_links_to_add.join('  ')}`);
      }
      if (b.router_notes) console.log(`  notes:         ${b.router_notes}`);
      console.log('');
    });
    await db.destroy();
  } catch (err) {
    console.error('Brief preview failed:', err);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
