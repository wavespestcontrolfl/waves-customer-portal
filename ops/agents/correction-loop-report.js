#!/usr/bin/env node
// READ-ONLY
//
// correction-loop-report.js — the correction loop's Monday brief, in the
// terminal (owner 2026-10-02: the terminal is the cockpit; no Agents UI).
//
//   railway run --service Postgres -- railway run --service waves-customer-portal \
//     node ops/agents/correction-loop-report.js [--days=60] [--json]
//   (`~/.claude/bin/correction-loop` is that command.)
//
// Sections: the live prompt version; the last 7 days of adjudicated
// incidents by disposition and cell; open and recent fix proposals with their
// PR and replay runs; recurrence per cell per prompt version over --days.
//
// Recurrence is attributed to the version and time the DRAFT was produced,
// never when it was judged. Opportunities are every house-voice inbound
// reply draft on that version (campaign, backfill and unversioned drafts
// from other producers excluded), with the reviewed
// share beside the rate: judged / drafts and human-replied / drafts. A
// version is "inconclusive" under 20 drafts, or when its judged share fell by
// more than a third against the version before it. Prints ids, cells and
// counts only — never message text.
if (require.main === module) {
  if (!process.env.DATABASE_PUBLIC_URL) {
    console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres -- railway run --service waves-customer-portal node ops/agents/correction-loop-report.js');
    process.exit(2);
  }
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
  process.env.LOG_LEVEL = 'error';
}

const path = require('path');

const MIN_OPPORTUNITIES = 20;
const SHARE_DROP = 1 / 3;
const AREA = 'sms';

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');

async function buildReport({ dbi, now = new Date(), days = 60, liveVersion = null }) {
  const since = new Date(now.getTime() - days * 86400 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 86400 * 1000);

  const week = await dbi('ai_incidents')
    .where({ area: AREA })
    .where('adjudicated_at', '>=', weekAgo)
    .groupBy('disposition', 'surface', 'failure_mode')
    .select('disposition', 'surface', 'failure_mode')
    .countDistinct('incident_key as n')
    .orderBy([{ column: 'disposition' }, { column: 'n', order: 'desc' }]);

  // Every open proposal, always (active work is never cut by a cap), then
  // up to 20 recently closed ones for history.
  const OPEN = ['pending', 'accepted', 'pr_open'];
  const open = await dbi('ai_fix_proposals').where({ area: AREA }).whereIn('status', OPEN).orderBy('created_at', 'desc');
  const recentClosed = await dbi('ai_fix_proposals')
    .where({ area: AREA })
    .whereNotIn('status', OPEN)
    .where('updated_at', '>=', since)
    .orderBy('updated_at', 'desc')
    .limit(20);
  const proposals = [...open, ...recentClosed];
  const runIds = proposals.flatMap((p) => [p.dev_run_id, p.holdout_run_id]).filter(Boolean);
  const runs = runIds.length
    ? await dbi('ai_replay_runs').whereIn('id', runIds).select('id', 'split', 'status', 'case_count', 'reproduces_count', 'method')
    : [];
  const runById = new Map(runs.map((r) => [r.id, r]));

  const drafts = await dbi({ md: 'message_drafts' })
    .leftJoin({ j: 'shadow_draft_judgments' }, 'j.draft_id', 'md.id')
    .where('md.created_at', '>=', since)
    // House-voice inbound replies only: the drafts the shadow judge grades
    // (other producers, e.g. estimate clarify asks, write unversioned rows).
    .whereNull('md.campaign_type')
    .where('md.prompt_version', 'like', 'house_voice%')
    .whereRaw("md.prompt_version NOT LIKE '%backfill'")
    .groupBy('md.prompt_version')
    .select('md.prompt_version')
    .count('md.id as drafts')
    .count('j.id as judged')
    .select(dbi.raw('COUNT(*) FILTER (WHERE j.human_replied) as human_replied'))
    .select(dbi.raw('MIN(md.created_at) as first_at'))
    .orderBy('first_at', 'asc');

  const confirmed = await dbi('ai_incidents')
    .where({ area: AREA, disposition: 'confirmed_mistake' })
    .where('produced_at', '>=', since)
    .groupBy('prompt_version', 'surface', 'failure_mode')
    .select('prompt_version', 'surface', 'failure_mode')
    .countDistinct('incident_key as n');

  const versions = [];
  let prior = null;
  for (const v of drafts) {
    const n = Number(v.drafts) || 0;
    const judged = Number(v.judged) || 0;
    const replied = Number(v.human_replied) || 0;
    const share = n ? judged / n : 0;
    const shareDropped = prior != null && prior.share > 0 && share < prior.share * (1 - SHARE_DROP);
    const cells = confirmed
      .filter((c) => (c.prompt_version ?? null) === (v.prompt_version ?? null))
      .map((c) => ({ cell: `${c.surface}/${c.failure_mode}`, confirmed: Number(c.n) || 0 }))
      .sort((a, b) => b.confirmed - a.confirmed);
    const entry = {
      version: v.prompt_version || '(none)',
      drafts: n,
      judgedShare: pct(judged, n),
      humanRepliedShare: pct(replied, n),
      verdict: n < MIN_OPPORTUNITIES ? `inconclusive (under ${MIN_OPPORTUNITIES} drafts)`
        : shareDropped ? 'inconclusive (judged share fell by over a third)' : 'readable',
      cells: cells.map((c) => ({ ...c, per100: n ? Math.round((1000 * c.confirmed) / n) / 10 : null })),
    };
    versions.push(entry);
    prior = { share };
  }

  return {
    generatedAt: now.toISOString(),
    liveVersion,
    windowDays: days,
    week: week.map((r) => ({ disposition: r.disposition, cell: `${r.surface}/${r.failure_mode}`, n: Number(r.n) || 0 })),
    proposals: proposals.map((p) => ({
      id: String(p.id).slice(0, 8),
      status: p.status,
      cell: `${p.surface}/${p.failure_mode}`,
      fixKind: p.fix_kind,
      version: p.prompt_version,
      incidents: p.evidence_count,
      dev: p.dev_incident_keys?.length || 0,
      holdout: p.holdout_incident_keys?.length || 0,
      pr: p.pr_number || null,
      shipped: p.shipped_version || null,
      devRun: runById.get(p.dev_run_id) || null,
      holdoutRun: runById.get(p.holdout_run_id) || null,
    })),
    versions,
  };
}

function formatRun(r) {
  return r ? `${r.status} (${r.reproduces_count}/${r.case_count} reproduce, ${r.method})` : '-';
}

function formatReport(report) {
  const out = [];
  out.push(`Correction loop (sms) — ${report.generatedAt.slice(0, 16)}Z; live prompt version ${report.liveVersion || 'unknown'}`);
  out.push('', 'Last 7 days, adjudicated (distinct drafts):');
  if (!report.week.length) out.push('  nothing adjudicated');
  for (const w of report.week) out.push(`  ${w.disposition.padEnd(18)} ${w.cell.padEnd(44)} ${w.n}`);
  out.push('', 'Fix proposals (open, or changed in the window):');
  if (!report.proposals.length) out.push('  none — no cell has reached the threshold');
  for (const p of report.proposals) {
    out.push(`  ${p.id} ${p.status.padEnd(12)} ${p.cell} fix=${p.fixKind} v=${p.version || '-'} n=${p.incidents} (${p.dev} dev / ${p.holdout} holdout)`
      + `${p.pr ? ` PR #${p.pr}` : ''}${p.shipped ? ` shipped ${p.shipped}` : ''}`);
    if (p.devRun || p.holdoutRun) out.push(`           dev run: ${formatRun(p.devRun)}; holdout run: ${formatRun(p.holdoutRun)}`);
  }
  out.push('', `Recurrence by prompt version (drafts produced in the last ${report.windowDays} days; replays are subagent-judged, never the exact production model):`);
  if (!report.versions.length) out.push('  no drafts in the window');
  for (const v of report.versions) {
    out.push(`  ${v.version}: ${v.drafts} drafts, judged ${v.judgedShare}, human replied ${v.humanRepliedShare} — ${v.verdict}`);
    if (!v.cells.length) out.push('      no confirmed mistakes');
    for (const c of v.cells) out.push(`      ${c.cell.padEnd(44)} ${c.confirmed} confirmed (${c.per100} per 100 drafts)`);
  }
  return out.join('\n');
}

module.exports = { buildReport, formatReport, MIN_OPPORTUNITIES };

if (require.main === module) {
  const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
  const argv = process.argv.slice(2);
  const daysArg = argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? Number(daysArg.slice(7)) : 60;
  if (!(days > 0 && days <= 365)) {
    console.error('--days must be between 1 and 365');
    process.exit(2);
  }
  let liveVersion = null;
  try {
    liveVersion = require(path.join(__dirname, '..', '..', 'server', 'services', 'sms-shadow-drafter')).currentPromptVersion();
  } catch { /* printed as unknown */ }
  buildReport({ dbi: db, days, liveVersion })
    .then((r) => console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : formatReport(r)))
    .then(() => db.destroy())
    .catch(async (err) => {
      console.error(`correction-loop report failed: ${err.message}`);
      try { await db.destroy(); } catch { /* already closed */ }
      process.exit(1);
    });
}
