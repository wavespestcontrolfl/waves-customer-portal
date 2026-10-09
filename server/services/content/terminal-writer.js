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
 * module reads the repo's PR list and matches branches to pending rows:
 *   merged PR on the branch  → the row is completed here (status 'done')
 *   open PR on the branch    → in progress; not due, holds one daily slot
 *   no PR, or closed unmerged → due
 *
 * Caps are the engine's own: AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY bounds
 * due + in progress + posts merged today (ET), AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK bounds due +
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
// Rows read per action type. peek() limits before this module can filter, so
// each writing action is read on its own: link tasks and parked review rows
// cannot crowd the writing rows out of the window.
const PEEK_LIMIT = 100;
// Closed PRs read newest-first to find merges. The daily run settles a merge
// the next morning, so two pages cover far more than a day of site PRs.
const CLOSED_PR_PAGES = 2;

function terminalWriterLive() {
  return process.env.GATE_CONTENT_WRITER_TERMINAL === 'true';
}

function capFromEnv(key, fallback) {
  const n = Number.parseInt(process.env[key], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const branchFor = (opportunityId) => `${BRANCH_PREFIX}${opportunityId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A branch name is free text: only a well-formed id reaches a query.
const opportunityIdOf = (pr) => {
  const ref = pr?.head?.ref || '';
  const id = ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : '';
  return UUID.test(id) ? id.toLowerCase() : null;
};

/**
 * Every terminal-writer PR GitHub knows about, by opportunity id: all open
 * ones, and the merged ones among the most recently closed. Read from the PR
 * list, not per queue row, so a PR counts whatever its row's score is now.
 */
async function terminalPrs(gh) {
  const { owner, repo } = gh.env();
  const base = `/repos/${owner}/${repo}/pulls`;
  const open = new Map();
  const merged = new Map();
  for (const pr of await gh.ghFetchPaginated(`${base}?state=open`)) {
    const id = opportunityIdOf(pr);
    if (id) open.set(id, pr.html_url);
  }
  for (const pr of await gh.ghFetchPaginated(`${base}?state=closed&sort=updated&direction=desc`, { maxPages: CLOSED_PR_PAGES })) {
    const id = opportunityIdOf(pr);
    if (id && pr.merged_at) merged.set(id, { url: pr.html_url, mergedAt: new Date(pr.merged_at) });
  }
  return { open, merged };
}

/**
 * Sort the writing rows of the queue into due / in progress / merged.
 * `complete: true` also marks merged rows done (the daily run); the read-only
 * list script passes false and writes nothing.
 */
async function terminalWriterWork({ complete = false, now = new Date(), deps = {} } = {}) {
  const queue = deps.queue || require('./opportunity-queue');
  const gh = deps.gh || require('../content-astro/github-client');
  const conn = deps.db || db;

  const perDay = capFromEnv('AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY', 3);
  const perWeek = capFromEnv('AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK', 10);
  const prs = await terminalPrs(gh);

  const byId = new Map();
  for (const actionType of WRITER_ACTIONS) {
    const rows = await queue.peek({ limit: PEEK_LIMIT, minScore: THRESHOLDS.minScoreToAct, actionType });
    for (const r of rows) if (r.status === 'pending') byId.set(r.id, r);
  }
  const pending = [...byId.values()].sort((x, y) => y.score - x.score);

  // A merged PR whose row is still pending has not been settled yet.
  const merged = pending.filter((r) => prs.merged.has(r.id)).map((r) => ({ ...r, pr_url: prs.merged.get(r.id).url }));
  const inProgress = pending.filter((r) => !prs.merged.has(r.id) && prs.open.has(r.id)).map((r) => ({ ...r, pr_url: prs.open.get(r.id) }));
  const candidates = pending.filter((r) => !prs.merged.has(r.id) && !prs.open.has(r.id));

  // Merged PRs whose row is still pending, read by id and not from the rows
  // above: a merged post uses a weekly slot even when its row has since
  // dropped out of the claimable window.
  const mergedIds = [...prs.merged.keys()];
  const unsettled = mergedIds.length
    ? (await conn('opportunity_queue').whereIn('id', mergedIds).where('status', 'pending').select('id')).map((r) => r.id)
    : [];
  if (complete) {
    for (const id of unsettled) {
      const updated = await conn('opportunity_queue')
        .where('id', id)
        .where('status', 'pending')
        // the merge time, so a post merged yesterday counts in yesterday's week
        .update({ status: 'done', completed_at: prs.merged.get(id).mergedAt, updated_at: now });
      if (updated) logger.info(`[terminal-writer] done ${id}: merged ${prs.merged.get(id).url}`);
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
  const doneThisWeek = Number(doneRow?.n || 0) + (complete ? 0 : unsettled.length);
  // Every open terminal PR holds a slot, whether or not its row was read above,
  // and so does every post merged today: a second pass on the same day must
  // not hand out the day's slots again.
  const openCount = prs.open.size;
  const dayStart = parseETDateTime(`${etDateString(now)}T00:00`);
  const mergedToday = [...prs.merged.values()].filter((m) => m.mergedAt >= dayStart).length;
  const room = Math.max(0, Math.min(perDay - openCount - mergedToday, perWeek - doneThisWeek - openCount));
  const due = candidates.slice(0, room).map((r) => ({ ...r, branch: branchFor(r.id) }));
  return { due, inProgress, merged, caps: { perDay, perWeek, doneThisWeek, mergedToday } };
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
