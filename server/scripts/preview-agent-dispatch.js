#!/usr/bin/env node
/**
 * preview-agent-dispatch.js — dry-run the agent dispatcher for top-N
 * briefs. Shows which agent would handle each, what the input payload
 * looks like, and whether the relevant agent ID env var is set.
 *
 * Spends ZERO API credits. Read-only against the DB. Use to validate
 * routing logic before deploy-time agent registration.
 *
 * Usage:
 *   node server/scripts/preview-agent-dispatch.js
 *   node server/scripts/preview-agent-dispatch.js --limit=10 --json
 *
 * For prod:
 *   railway run -s Postgres -- bash -c '
 *     DATABASE_URL=$DATABASE_PUBLIC_URL \
 *       node server/scripts/preview-agent-dispatch.js
 *   '
 */

const db = require('../models/db');
const builder = require('../services/content/content-brief-builder');
const dispatcher = require('../services/content/agents/agent-dispatcher');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);

const LIMIT = parseInt(ARGS.limit || 5, 10);
const JSON_OUT = !!ARGS.json;

(async function main() {
  try {
    const previews = await builder.previewTop({ limit: LIMIT, persist: false, skipSerp: true });
    const out = [];

    for (const p of previews) {
      const opp = p._opportunity;
      if (!opp) { out.push({ error: 'no opportunity context' }); continue; }
      const brief = p.error
        ? null
        : { ...p, opportunity_id: opp.id };
      if (!brief) {
        out.push({ opportunity_id: opp.id, error: p.error });
        continue;
      }
      const decision = await dispatcher.runWithBrief(brief, { dryRun: true });
      out.push({
        opportunity_id: opp.id,
        action_type: brief.action_type,
        bucket: opp.bucket,
        page_type: brief.page_type,
        city: brief.city,
        service: brief.service,
        final_score: brief.final_score,
        human_review: brief.human_review_required,
        dispatch: decision,
      });
    }

    if (JSON_OUT) {
      process.stdout.write(JSON.stringify(out, null, 2));
      await db.destroy();
      return;
    }

    console.log(`\n── Agent Dispatch Preview (top ${LIMIT}) ──\n`);
    if (!out.length) {
      console.log('No pending opportunities to preview.');
      await db.destroy();
      return;
    }
    out.forEach((row, i) => {
      console.log('────────────────────────────────────────────────────────');
      console.log(`#${i + 1}  ${row.action_type || '?'}  →  bucket=${row.bucket || '?'}`);
      console.log(`  target:        ${row.city || '—'} / ${row.service || '—'}  (page_type=${row.page_type || '?'})`);
      console.log(`  score:         ${row.final_score || '—'}    human_review=${row.human_review ? 'YES' : 'no'}`);
      if (row.error) { console.log(`  ERROR:         ${row.error}`); console.log(''); return; }
      const d = row.dispatch;
      if (d.role === 'none') {
        console.log(`  dispatch:      NO-OP  (${d.reason})`);
      } else if (d.reason === 'agent_not_registered') {
        console.log(`  dispatch:      ${d.role} (${d.config_name})  ⚠ env ${d.env_var_missing} not set`);
      } else if (d.reason === 'dry_run') {
        console.log(`  dispatch:      ${d.role}  agent_id=${d.agent_id}`);
        console.log(`  payload start: "${d.input_payload?.instruction?.slice(0, 90)}..."`);
      } else {
        console.log(`  dispatch:      ${d.reason}`);
      }
      console.log('');
    });

    // Registration hint summary.
    const missing = new Set();
    for (const row of out) {
      if (row.dispatch?.env_var_missing) missing.add(row.dispatch.env_var_missing);
    }
    if (missing.size) {
      console.log('────────────────────────────────────────────────────────');
      console.log('Missing agent registrations — set these env vars after registering each agent with Anthropic:');
      for (const v of missing) console.log(`  ${v}`);
      console.log('');
    }
    await db.destroy();
  } catch (err) {
    console.error('Dispatch preview failed:', err);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
