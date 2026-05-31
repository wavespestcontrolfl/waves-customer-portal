#!/usr/bin/env node
/**
 * run-autonomous-next.js — one-shot manual trigger of the autonomous
 * runner. Defaults to dry-run (no agent dispatch, no publish, no
 * IndexNow). Pass --live to actually run through the chain.
 *
 * Even in --live mode, the per-action-type SHADOW_MODE_<ACTION>
 * env var controls whether publishing actually happens — set those
 * to "false" per action type to take it out of shadow.
 *
 * Usage:
 *   node server/scripts/run-autonomous-next.js               # dry-run (no API calls, no DB writes)
 *   node server/scripts/run-autonomous-next.js --live        # full chain but agent + publish gated by SHADOW_MODE_*
 *   node server/scripts/run-autonomous-next.js --min-score=60
 *   node server/scripts/run-autonomous-next.js --live --verify-internal-links
 *
 * For prod:
 *   railway run -- bash -c '
 *     node server/scripts/run-autonomous-next.js
 *   '
 */

const db = require('../models/db');
const runner = require('../services/content/autonomous-runner');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);

function parseBooleanFlag(value) {
  if (value === true) return true;
  const s = String(value || '').toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

const LIVE = parseBooleanFlag(ARGS.live);
const MIN_SCORE = ARGS['min-score'] ? parseInt(ARGS['min-score'], 10) : undefined;
if (parseBooleanFlag(ARGS['verify-internal-links'])) {
  process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = 'true';
}

function redactCli(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g, '[redacted-phone]');
}

(async function main() {
  try {
    console.log(`\n── Autonomous Runner: runNext (${LIVE ? 'LIVE' : 'DRY-RUN'}) ──\n`);
    // A live single run publishes, so serialize it behind the same engine lock
    // the daily cron uses — a manual --live run must not overlap the 9am batch
    // and race the per-day/week caps. Dry runs never publish, so they skip the lock.
    const runOnce = () => runner.runNext({ dryRun: !LIVE, minScore: MIN_SCORE });
    const result = LIVE ? await runner._withEngineLock('manual-runNext', runOnce) : await runOnce();

    console.log(`Outcome:           ${result.outcome}`);
    if (result.skip_reason) console.log(`Skip reason:       ${redactCli(result.skip_reason)}`);
    if (result.failure_message) console.log(`Failure:           ${redactCli(result.failure_message)}`);
    console.log(`Action type:       ${result.action_type || '—'}`);
    console.log(`Page type:         ${result.page_type || '—'}`);
    console.log(`Shadow mode:       ${result.shadow_mode ? 'YES' : 'no'}`);
    console.log(`Opportunity id:    ${result.opportunity_id || '—'}`);
    console.log(`Brief id:          ${result.brief_id || '—'}`);
    if (result.published_url) console.log(`Published URL:     ${result.published_url}`);
    if (result.astro_pr_url) console.log(`Astro PR:          ${result.astro_pr_url}`);
    if (result.indexnow_status) console.log(`IndexNow:          ${result.indexnow_status}`);
    if (typeof result.link_tasks_queued === 'number') console.log(`Link tasks queued: ${result.link_tasks_queued}`);
    if (typeof result.internal_link_verify_count === 'number') {
      console.log(`Link PR verify:    ${result.internal_link_verified_count || 0} verified / ${result.internal_link_verify_failed_count || 0} failed / ${result.internal_link_verify_count} checked`);
    }
    if (result.internal_link_verify_error) console.log(`Link PR verify:    skipped (${redactCli(result.internal_link_verify_error)})`);
    console.log(`Trust-build:       ${result.trust_build_count_after}`);

    console.log('');
    console.log('Stage timings (ms):');
    for (const k of ['claim_ms', 'brief_ms', 'agent_ms', 'uniqueness_gate_ms', 'quality_gate_ms', 'publish_ms', 'index_submit_ms', 'link_plan_ms', 'total_ms']) {
      if (result[k] != null) console.log(`  ${k.padEnd(22)} ${result[k]}`);
    }

    if (result.reviewer_notes) {
      console.log('');
      console.log(`Reviewer notes: ${redactCli(result.reviewer_notes)}`);
    }
    if (result.uniqueness_gate_result?.failed_count > 0) {
      console.log('');
      console.log(`Uniqueness failures (${result.uniqueness_gate_result.failed_count}):`);
      for (const r of (result.uniqueness_gate_result.failed_reasons || []).slice(0, 8)) console.log(`  ${redactCli(r)}`);
    }
    if (result.quality_gate_result?.hard_failures?.length) {
      console.log('');
      console.log(`Quality hard failures:`);
      for (const f of result.quality_gate_result.hard_failures) console.log(`  ${redactCli(f.name)}: ${redactCli(f.reason || '')}`);
    }
    console.log('');

    await db.destroy();
  } catch (err) {
    console.error('Runner failed:', err);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
