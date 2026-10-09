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
 * One writer at a time: with the gate on, runNext() refuses to draft, so the
 * admin Run now button and the --live script cannot work a row beside the
 * terminal. Caps are the engine's own and are counted across all writing
 * actions together: AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY bounds due + open
 * terminal PRs + what the engine counts as published today (which includes
 * rows settled here), AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK the same for
 * the ET week.
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
// opportunity_queue.skip_reason on a row this module completed. The engine's
// publish counter reads it (autonomous-runner.js _countPublishedSince).
const SETTLED_REASON = 'terminal_writer_merged';
const OPEN_PR_FENCE_DAYS = 3;
// A terminal PR owns its row in every status but 'done'. Other writers of the
// queue can move a fenced pending row (the janitor expires it, an ordinary
// page edit supersedes a citability backfill to 'skipped'); the PR is still
// open or its post still went live, so the row is still counted and settled.
const SETTLED_STATUS = 'done';
const ALERT_KEY_PREFIX = 'content-terminal-due:';
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
  // 0 is a real cap (publish nothing), as it is for the engine's own guard.
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
 * Only a PR into the site's default branch counts: a merge into any other
 * branch has `merged_at` too and never reached the live site.
 */
async function terminalPrs(gh) {
  const { owner, repo, defaultBranch } = gh.env();
  const base = `/repos/${owner}/${repo}/pulls`;
  const ours = (prs) => prs
    .filter((pr) => pr.base?.ref === defaultBranch)
    .map((pr) => [opportunityIdOf(pr), pr])
    .filter(([id]) => id);
  const open = new Map(ours(await gh.ghFetchPaginated(`${base}?state=open`)).map(([id, pr]) => [id, pr.html_url]));
  const closed = await gh.ghFetchPaginated(`${base}?state=closed&sort=updated&direction=desc`, { maxPages: CLOSED_PR_PAGES });
  const merged = new Map(ours(closed.filter((pr) => pr.merged_at)).map(([id, pr]) => [id, { url: pr.html_url, mergedAt: new Date(pr.merged_at) }]));
  return { open, merged };
}

/** Pending rows of every writing action, best score first. */
async function pendingWritingRows(queue) {
  const byId = new Map();
  for (const actionType of WRITER_ACTIONS) {
    const rows = await queue.peek({ limit: PEEK_LIMIT, minScore: THRESHOLDS.minScoreToAct, actionType });
    // peek matches on the queue's EFFECTIVE action (a row can be retargeted
    // by its metadata); carry that one, it is what the writer must do.
    for (const r of rows.filter((x) => x.status === 'pending')) byId.set(r.id, { ...r, action_type: actionType });
  }
  return [...byId.values()].sort((x, y) => y.score - x.score);
}

/**
 * Queue writes of the daily run, both by PR id and not by the rows read
 * above (a row can have dropped out of the claimable window since):
 *   merged PR → the row is done, at the PR's merge time, and carries
 *     SETTLED_REASON so the engine's own publish count includes it
 *   open PR   → the row stays pending but is pushed out of the claimable
 *     window (and its expiry moved) for OPEN_PR_FENCE_DAYS, renewed each day. claimNext honors
 *     available_at, so the API engine cannot claim a row a terminal PR is
 *     working, also in the days after the gate is turned off.
 */
async function settleAndFence(conn, prs, unsettled, now) {
  for (const id of unsettled) {
    const updated = await conn('opportunity_queue').where('id', id).whereNot('status', SETTLED_STATUS)
      .update({ status: 'done', skip_reason: SETTLED_REASON, completed_at: prs.merged.get(id).mergedAt, updated_at: now });
    if (updated) logger.info(`[terminal-writer] done ${id}: merged ${prs.merged.get(id).url}`);
  }
  const openIds = [...prs.open.keys()];
  if (openIds.length) {
    const until = new Date(now.getTime() + OPEN_PR_FENCE_DAYS * 86400000);
    // expires_at moves with the fence (never earlier, and a row with no
    // expiry keeps none): the janitor must not expire a row while its PR is open.
    await conn('opportunity_queue').whereIn('id', openIds).where('status', 'pending')
      .update({ available_at: until, expires_at: conn.raw('CASE WHEN expires_at IS NULL THEN NULL ELSE GREATEST(expires_at, ?) END', [until]), updated_at: now });
  }
}

/**
 * Published since `since`, all writing actions together. One counter for
 * both writers: the engine's own _countPublishedSince (API publishes and API
 * PRs in flight, plus rows this module settled).
 */
async function publishedSince(countPublishedSince, since) {
  let n = 0;
  for (const actionType of WRITER_ACTIONS) n += await countPublishedSince(actionType, since);
  return n;
}

/**
 * Sort the writing rows of the queue into due / in progress / merged.
 * `complete: true` also settles merged rows and fences open ones (the daily
 * run); the read-only list script passes false and writes nothing.
 */
async function terminalWriterWork({ complete = false, now = new Date(), deps = {} } = {}) {
  const queue = deps.queue || require('./opportunity-queue');
  const gh = deps.gh || require('../content-astro/github-client');
  const conn = deps.db || db;
  const countPublishedSince = deps.countPublishedSince || ((a, since) => require('./autonomous-runner')._countPublishedSince(a, since));

  const prs = await terminalPrs(gh);
  // Rows that have a PR are read by id, never through peek: a fenced or
  // low-scored row is outside the claimable window but its PR still counts.
  const prIds = [...prs.merged.keys(), ...prs.open.keys()];
  const prRows = prIds.length ? await conn('opportunity_queue').whereIn('id', prIds).select('*') : [];
  const open = (r) => r.status !== SETTLED_STATUS;
  const merged = prRows.filter((r) => prs.merged.has(r.id) && open(r)).map((r) => ({ ...r, pr_url: prs.merged.get(r.id).url }));
  const inProgress = prRows.filter((r) => !prs.merged.has(r.id) && open(r)).map((r) => ({ ...r, pr_url: prs.open.get(r.id) }));
  const candidates = (await pendingWritingRows(queue)).filter((r) => !prs.merged.has(r.id) && !prs.open.has(r.id));

  // Merged PRs whose row is not done yet.
  const unsettled = merged.map((r) => r.id);
  if (complete) await settleAndFence(conn, prs, unsettled, now);

  // A merge this pass did not settle (read-only) still used its slot, in
  // the day and week it merged.
  const stillUnsettled = complete ? [] : unsettled;
  const usedSince = async (since) => (await publishedSince(countPublishedSince, since))
    + stillUnsettled.filter((id) => prs.merged.get(id).mergedAt >= since).length;
  const perDay = capFromEnv('AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY', 3);
  const perWeek = capFromEnv('AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK', 10);
  const doneToday = await usedSince(parseETDateTime(`${etDateString(now)}T00:00`));
  const doneThisWeek = await usedSince(parseETDateTime(`${etWeekStart(now)}T00:00`));
  // Every open terminal PR holds a slot, whether or not its row was read above.
  const room = Math.max(0, Math.min(perDay - doneToday, perWeek - doneThisWeek) - prs.open.size);
  const due = candidates.slice(0, room).map((r) => ({ ...r, branch: branchFor(r.id) }));
  return { due, inProgress, merged, caps: { perDay, perWeek, doneThisWeek, doneToday, openPrs: prs.open.size } };
}

const describe = (r) => `${r.action_type.replace(/_/g, ' ')}: ${r.query || r.page_url || [r.service, r.city].filter(Boolean).join(' in ') || 'untitled'}`;

/**
 * The daily run with the gate on: settle merged rows, then raise one admin
 * item when posts are due. Never drafts and never claims a queue row.
 */
async function handOffToTerminal({ now = new Date(), deps = {} } = {}) {
  const work = await terminalWriterWork({ complete: true, now, deps });
  const { due, inProgress, merged } = work;
  const n = due.length;
  const todayKey = `${ALERT_KEY_PREFIX}${etDateString(now)}`;
  // Close what no longer holds: every earlier day's item, and today's too
  // once nothing is due (the posts were opened or merged since the 9am pass).
  const episodes = deps.episodes || require('../admin-alert-episodes');
  const conn = deps.db || db;
  const stale = (await episodes.openAdminAlertKeys(conn, ALERT_KEY_PREFIX)).filter((key) => n === 0 || key !== todayKey);
  await episodes.closeAdminAlertKeys(conn, stale, 'posts_written', { now, resolution: 'Cleared: these website posts are no longer due' });

  logger.info(`[terminal-writer] ${n} due, ${inProgress.length} in progress, ${merged.length} merged`);
  if (n) {
    const raise = deps.raiseAdminAlert || require('../admin-alert-compose').raiseAdminAlert;
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
      dedupeKey: todayKey,
      detail: [
        'Run blog-run in the terminal. Due today:',
        ...due.map((r) => `- ${describe(r)}`),
        ...(inProgress.length ? ['', `Open and waiting to merge: ${inProgress.length}`] : []),
      ].join('\n'),
    });
  }
  return { outcome: 'handed_to_terminal', count: 0, runs: [], due: n, inProgress: inProgress.length, merged: merged.length };
}

module.exports = { terminalWriterLive, terminalWriterWork, handOffToTerminal, branchFor, BRANCH_PREFIX, WRITER_ACTIONS, SETTLED_REASON };
