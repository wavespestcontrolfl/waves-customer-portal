'use strict';

/**
 * Terminal writer hand-off (GATE_CONTENT_WRITER_TERMINAL, dark).
 *
 * With the gate on, the daily content run does not draft: no brief, no agent
 * session, no gate calls. It reads the queue and raises ONE admin item that
 * names the posts that are due. A Claude Code session in the owner's terminal
 * writes each post in the Astro repo and opens its PR from the branch
 * `terminal-writer/<opportunity id>` (ops/agents/content-terminal-due.js
 * prints the list).
 *
 * That branch name is the only link between a queue row and its PR, so this
 * module asks GitHub once per candidate row:
 *   merged PR on the branch  → the row is completed here (status 'done')
 *   open PR on the branch    → in progress; not due, holds one daily slot
 *   no PR, or closed unmerged → due
 *
 * Caps are the engine's own: AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY bounds
 * due + in progress, AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK bounds due +
 * in progress + rows completed this ET week.
 *
 * Not done for a terminal-written post: the PR poller's post-merge chain
 * (IndexNow, post-merge link planning, the immediate social share). The 10:30
 * link sweep and the RSS share cron still reach the post.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, etWeekStart, parseETDateTime } = require('../../utils/datetime-et');
const { THRESHOLDS } = require('./scoring-config');

const BRANCH_PREFIX = 'terminal-writer/';
// The action types a writing session can do. Everything else the queue holds
// (link-only tasks, GBP posts) is left for its own lane.
const WRITER_ACTIONS = Object.freeze([
  'new_supporting_blog',
  'refresh_existing_page',
  'create_or_refresh_city_service_page',
  'create_customer_question_page',
  'rewrite_title_meta',
]);
// Rows read per pass: a small multiple of the daily cap, so a few in-progress
// or just-merged rows at the top of the queue do not hide the due ones.
const PEEK_LIMIT = 30;

function terminalWriterLive() {
  return process.env.GATE_CONTENT_WRITER_TERMINAL === 'true';
}

function capFromEnv(key, fallback) {
  const n = Number.parseInt(process.env[key], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const branchFor = (opportunityId) => `${BRANCH_PREFIX}${opportunityId}`;

/** 'merged' | 'open' | 'none' for the row's branch, with the PR that decided it. */
async function prStateFor(opportunityId, gh) {
  const { owner, repo } = gh.env();
  const head = encodeURIComponent(`${owner}:${branchFor(opportunityId)}`);
  const prs = await gh.ghFetchPaginated(`/repos/${owner}/${repo}/pulls?state=all&head=${head}`, { maxPages: 1 });
  const merged = prs.find((p) => p.merged_at);
  if (merged) return { state: 'merged', pr: merged };
  const open = prs.find((p) => p.state === 'open');
  return open ? { state: 'open', pr: open } : { state: 'none', pr: null };
}

/**
 * Sort the top of the queue into due / in progress / merged.
 * `complete: true` also marks merged rows done (the daily run); the read-only
 * list script passes false and writes nothing.
 */
async function terminalWriterWork({ complete = false, now = new Date(), deps = {} } = {}) {
  const queue = deps.queue || require('./opportunity-queue');
  const gh = deps.gh || require('../content-astro/github-client');
  const conn = deps.db || db;

  const perDay = capFromEnv('AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY', 3);
  const perWeek = capFromEnv('AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK', 10);
  const rows = (await queue.peek({ limit: PEEK_LIMIT, minScore: THRESHOLDS.minScoreToAct }))
    .filter((r) => r.status === 'pending' && WRITER_ACTIONS.includes(r.action_type));

  const candidates = [];
  const inProgress = [];
  const merged = [];
  for (const row of rows) {
    // Enough rows to fill the day even if every later one is in progress.
    if (candidates.length >= perDay) break;
    const { state, pr } = await prStateFor(row.id, gh);
    if (state === 'open') inProgress.push({ ...row, pr_url: pr.html_url });
    else if (state === 'merged') merged.push({ ...row, pr_url: pr.html_url });
    else candidates.push(row);
  }

  if (complete) {
    for (const row of merged) {
      const updated = await conn('opportunity_queue')
        .where('id', row.id)
        .where('status', 'pending')
        .update({ status: 'done', completed_at: now, updated_at: now });
      if (updated) logger.info(`[terminal-writer] done ${row.id}: merged ${row.pr_url}`);
    }
  }

  const weekStart = parseETDateTime(`${etWeekStart(now)}T00:00`);
  const doneRow = await conn('opportunity_queue')
    .where('status', 'done')
    .whereIn('action_type', WRITER_ACTIONS)
    .where('completed_at', '>=', weekStart)
    .count({ n: '*' })
    .first();
  // Merged rows this pass did not mark done (read-only) still used a slot.
  const doneThisWeek = Number(doneRow?.n || 0) + (complete ? 0 : merged.length);
  const room = Math.max(0, Math.min(perDay - inProgress.length, perWeek - doneThisWeek - inProgress.length));
  const due = candidates.slice(0, room).map((r) => ({ ...r, branch: branchFor(r.id) }));
  return { due, inProgress, merged, caps: { perDay, perWeek, doneThisWeek } };
}

const describe = (r) => `${r.action_type.replace(/_/g, ' ')}: ${r.query || r.page_url || [r.service, r.city].filter(Boolean).join(' in ') || 'untitled'}`;

/**
 * The daily run with the gate on: settle merged rows, then raise one admin
 * item when posts are due. Never drafts and never claims a queue row.
 */
async function handOffToTerminal({ now = new Date(), deps = {} } = {}) {
  const work = await terminalWriterWork({ complete: true, now, deps });
  const { due, inProgress, merged } = work;
  const result = { outcome: 'handed_to_terminal', count: 0, runs: [], due: due.length, inProgress: inProgress.length, merged: merged.length };
  if (!due.length) {
    logger.info(`[terminal-writer] nothing due (${inProgress.length} in progress, ${merged.length} merged)`);
    return result;
  }
  const raise = deps.raiseAdminAlert || require('../admin-alert-compose').raiseAdminAlert;
  const n = due.length;
  await raise('content', {
    area: 'Content',
    action: `write ${n} website post${n === 1 ? '' : 's'} in the terminal`,
    why: `The content queue has ${n} post${n === 1 ? '' : 's'} due today and the portal does not write them.`,
    severity: 'needs-you',
    link: '/admin/blog?tab=autopilot',
    subject: { type: 'check', id: 'content-terminal-writer' },
    doneWhen: 'posts_written',
    who: 'claude',
  }, {
    dedupeKey: `content-terminal-due:${etDateString(now)}`,
    detail: [
      'Run blog-run in the terminal. Due today:',
      ...due.map((r) => `- ${describe(r)}`),
      ...(inProgress.length ? ['', `Open and waiting to merge: ${inProgress.length}`] : []),
    ].join('\n'),
  });
  logger.info(`[terminal-writer] ${n} due, ${inProgress.length} in progress, ${merged.length} merged`);
  return result;
}

module.exports = { terminalWriterLive, terminalWriterWork, handOffToTerminal, branchFor, BRANCH_PREFIX, WRITER_ACTIONS };
