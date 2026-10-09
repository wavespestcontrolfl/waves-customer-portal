'use strict';

/**
 * Terminal writer (GATE_CONTENT_WRITER_TERMINAL, dark).
 *
 * Owner ruling 2026-10-08: content that can wait is written in the owner's
 * terminal on the Claude plan, not by a paid agent session. Only the DRAFT
 * step moves. The runner still claims the row, composes the brief, runs every
 * gate on the draft, publishes and hands the PR to the poller, exactly as it
 * does for an agent draft.
 *
 * With the gate on, runNext() asks this module for the draft where it would
 * dispatch the agent. The draft is one JSON file a terminal session pushed to
 * the Astro repo:
 *     branch  terminal-writer/<opportunity id>
 *     file    terminal-drafts/<opportunity id>.json
 *     shape   the writer agent's emit_draft input, plus opportunity_id and
 *             brief_id (the brief the portal handed out for the row)
 * No file yet → the run is recorded as `deferred_terminal_draft` and the claim
 * is deferred a few hours (a deferral refunds the attempt), so the 1:00 PM
 * catch-up and the next morning's batch look again. After the batch ONE admin
 * item lists the rows that wait for a draft.
 *
 * A row that waits keeps the brief it was handed: while its latest run ended
 * waiting, the runner loads that stored brief instead of composing a new one
 * (up to MAX_BRIEF_AGE_MS), for the whole run. A draft must name that brief,
 * so it is judged against the brief it was written from. The same binding
 * makes a draft read-once: the run that takes it becomes the latest
 * run, so the file's brief is no longer the one the row waits on. A gate
 * retry therefore asks for a fresh draft, written against the retry brief
 * the next run composes. Deleting the branch afterwards is cleanup.
 *
 * The branch lives in the Astro repo itself (ghFetch reads owner/repo from
 * the environment), so only an account with push access can supply a draft.
 * The file is still untrusted input: it is size-bounded, shape-checked and
 * then judged by the same gates as an agent draft.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');

const BRANCH_PREFIX = 'terminal-writer/';
const DRAFT_DIR = 'terminal-drafts';
const AWAITING_OUTCOME = 'deferred_terminal_draft';
// A consumed draft failed a gate. The row needs a NEW brief (with the retry
// directives) before the terminal can write again; the next run composes it.
const GATE_RETRY_OUTCOME = 'deferred_gate_retry';
const TERMINAL_AGENT_ID = 'terminal-writer';
// A publish-cap deferral that ended BEFORE the draft step (no agent on the
// run) decides nothing about a draft. It does not count as a row's "latest
// run" here: such a deferral between two looks must not stop the row waiting
// on its brief (and orphan a draft that is already pushed). The late cap
// backstop is different: that run took the draft (it carries the terminal
// writer as its agent), so it does count and the row gets a new brief.
const PRE_DRAFT_CAP_OUTCOME = 'deferred_publish_cap';
const MISSING = 'terminal_draft_missing';
const INVALID = 'terminal_draft_invalid';
// The branch could not be read at all (GitHub failed); the row keeps waiting.
const UNREADABLE = 'terminal_draft_unreadable';
const ALERT_KEY_PREFIX = 'content-terminal-due:';
// How long a claim waits before the runner looks for the draft again.
const RECHECK_MS = 3 * 60 * 60 * 1000;
// A post body is a few thousand words. Anything far past that is not a draft.
const MAX_DRAFT_BYTES = 400000;
const MIN_BODY_CHARS = 200;
const DRAFT_FIELDS = Object.freeze(['frontmatter', 'body', 'schema', 'claims_ledger', 'notes_for_reviewer']);
// How far back a waiting run still counts. A row nobody wrote for a week is
// re-briefed by the next batch anyway.
const AWAITING_WINDOW_DAYS = 7;
// A handed brief older than this is replaced by a fresh one (new search data).
const MAX_BRIEF_AGE_MS = AWAITING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function terminalWriterLive() {
  return process.env.GATE_CONTENT_WRITER_TERMINAL === 'true';
}

// Briefs the editorial-evidence gate covers (the same test as
// brief-driven-tools.js registerSessionEditorial). With that gate on, the
// agent session must get its answer plan approved and its headings are
// checked against the plan before a draft is captured. A terminal draft
// cannot carry that approval, so those briefs stay on the agent.
function needsEditorialPlan(brief) {
  if (!require('./editorial-evidence').enabled()) return false;
  const refresh = brief?.page_type === 'refresh' || brief?.action_type === 'refresh_existing_page';
  return refresh || ['supporting-blog', 'customer-question'].includes(brief?.page_type);
}

// A title/meta rewrite is a different, tiny draft shape with its own agent
// and its own handler; it stays on the agent. Everything else the dispatch
// step writes is a page body.
const writesInTerminal = (brief) => terminalWriterLive()
  && brief?.action_type !== 'rewrite_title_meta' && brief?.page_type !== 'metadata'
  && !needsEditorialPlan(brief);

const branchFor = (opportunityId) => `${BRANCH_PREFIX}${opportunityId}`;
const draftPathFor = (opportunityId) => `${DRAFT_DIR}/${opportunityId}.json`;
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Why a parsed file is not a usable draft for this row, or null. */
function draftProblem(parsed, opportunityId, expectedBriefId) {
  if (!isObject(parsed)) return 'the file is not a JSON object';
  if (parsed.opportunity_id !== opportunityId) return 'opportunity_id does not match the branch';
  // The draft is judged against the brief it was written from, so it must
  // name the brief the portal handed out for this row.
  if (String(parsed.brief_id ?? '') !== String(expectedBriefId)) return 'brief_id is not the brief this row waits on';
  if (!isObject(parsed.frontmatter)) return 'frontmatter must be an object';
  if (typeof parsed.body !== 'string' || parsed.body.trim().length < MIN_BODY_CHARS) return 'body is missing or too short';
  if (parsed.schema != null && !isObject(parsed.schema)) return 'schema must be an object';
  if (parsed.claims_ledger != null && !Array.isArray(parsed.claims_ledger)) return 'claims_ledger must be an array';
  if (parsed.notes_for_reviewer != null && typeof parsed.notes_for_reviewer !== 'string') return 'notes_for_reviewer must be text';
  return null;
}

/**
 * The brief the terminal was asked to write from: the brief on the row's
 * LATEST run (pre-draft deferrals aside), when that run ended waiting for a draft. Null when the latest
 * run is anything else (a gate retry, a publish): the row then needs a new
 * brief first, and any file still on its branch is stale.
 */
async function waitingBriefId(opportunityId, { conn = db } = {}) {
  const latest = await conn('autonomous_runs').where('opportunity_id', opportunityId)
    .whereRaw('NOT (outcome = ? AND agent_id IS NULL)', [PRE_DRAFT_CAP_OUTCOME])
    .orderBy('created_at', 'desc').first('outcome', 'brief_id');
  return latest?.outcome === AWAITING_OUTCOME ? latest.brief_id || null : null;
}

/**
 * The draft for one row, in the shape agent-dispatcher.runWithBrief returns,
 * so the runner's code after the dispatch does not change.
 *   { ok: true, draft, brief_id, revision }      a usable draft
 *   { ok: false, code: MISSING | INVALID, ... }  wait for the terminal
 * `revision` is the branch commit the file was read at (for the cleanup).
 * A GitHub failure other than "not found" throws; draftSourceFor turns it
 * into a wait with `terminal_draft_unreadable` (never "no draft yet").
 */
async function fetchTerminalDraft(opportunityId, { gh = require('../content-astro/github-client'), expectedBriefId } = {}) {
  const t0 = Date.now();
  const result = (patch) => ({ agent_id: TERMINAL_AGENT_ID, session_id: null, ...patch, duration_ms: Date.now() - t0 });
  const missing = (reason) => result({ ok: false, code: MISSING, reason });
  if (!expectedBriefId) return missing('no brief has been handed to the terminal for this row yet');
  let revision;
  let file;
  try {
    revision = await gh.getBranchSha(branchFor(opportunityId));
    file = revision ? await gh.getFile(draftPathFor(opportunityId), revision) : null;
  } catch (err) {
    if (Number(err?.status) !== 404) throw err;
    file = null;
  }
  if (!file) return missing('no draft on the terminal branch yet');
  const invalid = (why) => result({ ok: false, code: INVALID, reason: `terminal draft rejected: ${why}` });
  if (Buffer.byteLength(file.content || '', 'utf8') > MAX_DRAFT_BYTES) return invalid('the file is too large');
  let parsed;
  try { parsed = JSON.parse(file.content); } catch { return invalid('the file is not valid JSON'); }
  const problem = draftProblem(parsed, opportunityId, expectedBriefId);
  if (problem) return invalid(problem);
  const draft = Object.fromEntries(DRAFT_FIELDS.filter((f) => parsed[f] != null).map((f) => [f, parsed[f]]));
  return result({ ok: true, draft, brief_id: expectedBriefId, revision });
}

/**
 * Where runNext gets the draft for this brief when it is the terminal's to
 * write: an object with agent-dispatcher's own runWithBrief contract, so the
 * runner's dispatch code is the same for both. Null = the agent writes it
 * (gate off, a dry run, a title/meta rewrite).
 *
 * `handed` says the brief is the stored one the row already waits on; only
 * then can a draft exist for it. A result with `wait: true` means "no usable
 * draft yet" (missing, rejected, or GitHub could not be read): the runner
 * records the run as waiting and looks again later. A read failure waits too
 * and never fails the run: a failed run would stop the row waiting on its
 * brief and orphan a draft that is already pushed.
 */
function draftSourceFor(opportunityId, brief, { handed = false, dryRun = false, gh } = {}) {
  if (dryRun || !writesInTerminal(brief)) return null;
  return {
    async runWithBrief() {
      const fetched = await fetchTerminalDraft(opportunityId, { ...(gh ? { gh } : {}), expectedBriefId: handed ? brief.id : null })
        .catch((err) => ({ ok: false, code: UNREADABLE, reason: `terminal draft could not be read: ${err.message}`, agent_id: TERMINAL_AGENT_ID, session_id: null }));
      return fetched.ok ? fetched : { ...fetched, wait: true };
    },
  };
}

/**
 * Cleanup after the runner took a draft: delete its branch. Best effort and
 * never throws. Nothing depends on it: a file that stays behind names a brief
 * the row no longer waits on, so no run accepts it and the list shows it as
 * rejected until the next draft replaces it. The branch is left alone when it
 * no longer points at `revision` (something was pushed after the read).
 */
async function retireTerminalDraft(opportunityId, { gh = require('../content-astro/github-client'), revision } = {}) {
  const branch = branchFor(opportunityId);
  try {
    if ((await gh.getBranchSha(branch)) !== revision) return false;
    return (await gh.retireBranch(branch)) === true;
  } catch (err) {
    logger.warn(`[terminal-writer] could not delete ${branch}: ${err.message}`);
    return false;
  }
}

/**
 * Delete the branch of every draft these finished runs took. Called after the
 * batch, when each run (and the draft on it) is stored: a run that never
 * reached the database (`id` unset) keeps its branch, so its draft is not
 * lost with the process. Never throws.
 */
async function cleanupConsumedDrafts(runs, { gh } = {}) {
  for (const run of runs || []) {
    if (!run?.terminal_draft_revision || !run.id || !run.opportunity_id) continue;
    await retireTerminalDraft(run.opportunity_id, { ...(gh ? { gh } : {}), revision: run.terminal_draft_revision });
  }
}

/**
 * Pending rows by what their LATEST run says, best score first:
 *   due      it ended waiting and no usable draft for its brief is pushed
 *            (a file the run would reject counts as not pushed)
 *   written  a usable draft is on the branch; the next run takes it
 *   rebrief  the row needs a new brief before the terminal can write: its
 *            draft failed a gate (the next run writes the retry brief), or
 *            the brief it waits on is too old
 */
async function awaitingTerminalDrafts({ now = new Date(), deps = {} } = {}) {
  const conn = deps.db || db;
  const gh = deps.gh || require('../content-astro/github-client');
  const { rows } = await conn.raw(`
    SELECT * FROM (
      SELECT DISTINCT ON (r.opportunity_id)
             r.opportunity_id, r.brief_id, r.action_type, r.outcome, r.agent_id, r.skip_reason, r.reviewer_notes, r.created_at,
             q.query, q.page_url, q.service, q.city, q.score, b.created_at AS brief_created_at
        FROM autonomous_runs r
        JOIN opportunity_queue q ON q.id = r.opportunity_id
        LEFT JOIN content_briefs b ON b.id = r.brief_id
       WHERE q.status = 'pending'
         AND r.created_at >= now() - (?::int * interval '1 day')
         AND NOT (r.outcome = ? AND r.agent_id IS NULL)
       ORDER BY r.opportunity_id, r.created_at DESC
    ) latest
    WHERE outcome = ? OR (outcome = ? AND agent_id = ?)
    ORDER BY score DESC`, [AWAITING_WINDOW_DAYS, PRE_DRAFT_CAP_OUTCOME, AWAITING_OUTCOME, GATE_RETRY_OUTCOME, TERMINAL_AGENT_ID]);
  const due = [];
  const written = [];
  const rebrief = [];
  for (const row of rows) {
    const item = { ...row, branch: branchFor(row.opportunity_id), draft_path: draftPathFor(row.opportunity_id) };
    // Same rule as the runner (_briefHandedToTerminal): a brief that is gone
    // or too old is replaced at the next run, so it is not offered for writing.
    const briefAge = row.brief_created_at ? now.getTime() - new Date(row.brief_created_at).getTime() : Infinity;
    if (row.outcome !== AWAITING_OUTCOME || briefAge > MAX_BRIEF_AGE_MS) { rebrief.push(item); continue; }
    const fetched = await fetchTerminalDraft(row.opportunity_id, { gh, expectedBriefId: row.brief_id });
    if (fetched.ok) written.push(item);
    else due.push({ ...item, problem: fetched.code === INVALID ? fetched.reason : null });
  }
  return { due, written, rebrief };
}

/**
 * The gate is off (the kill switch): the agent drafts again and no terminal
 * work is asked for, so every open terminal item is closed. No GitHub read.
 */
async function closeTerminalItems({ now = new Date(), deps = {} } = {}) {
  const episodes = deps.episodes || require('../admin-alert-episodes');
  const conn = deps.db || db;
  const open = await episodes.openAdminAlertKeys(conn, ALERT_KEY_PREFIX);
  return episodes.closeAdminAlertKeys(conn, open, 'terminal_writer_off', { now, resolution: 'Cleared: the portal writes these drafts itself again' });
}

/**
 * True when a blog waits for its terminal draft AND today's item stands, so
 * the owner has been told. The blog drought alert reads this: "no blog today"
 * is false news then. False when the gate is off, when only other page types
 * wait, when the item was suppressed or closed, and on any read failure (the
 * drought alert is the fallback signal, so doubt keeps it).
 */
async function blogDraftRequested({ now = new Date(), deps = {} } = {}) {
  if (!terminalWriterLive()) return false;
  try {
    const conn = deps.db || db;
    const episodes = deps.episodes || require('../admin-alert-episodes');
    const open = await episodes.openAdminAlertKeys(conn, ALERT_KEY_PREFIX);
    if (!open.includes(`${ALERT_KEY_PREFIX}${etDateString(now)}`)) return false;
    const { rows } = await conn.raw(`
      SELECT 1 FROM (
        SELECT DISTINCT ON (r.opportunity_id) r.outcome, r.action_type
          FROM autonomous_runs r
          JOIN opportunity_queue q ON q.id = r.opportunity_id
         WHERE q.status = 'pending'
           AND r.created_at >= now() - (?::int * interval '1 day')
           AND NOT (r.outcome = ? AND r.agent_id IS NULL)
         ORDER BY r.opportunity_id, r.created_at DESC
      ) latest
      WHERE outcome = ? AND action_type = 'new_supporting_blog'
      LIMIT 1`, [AWAITING_WINDOW_DAYS, PRE_DRAFT_CAP_OUTCOME, AWAITING_OUTCOME]);
    return rows.length > 0;
  } catch (err) {
    logger.warn(`[terminal-writer] could not tell whether a blog waits for its draft: ${err.message}`);
    return false;
  }
}

const describe = (r) => `${String(r.action_type || 'post').replace(/_/g, ' ')}: ${r.query || r.page_url || [r.service, r.city].filter(Boolean).join(' in ') || 'untitled'}`;

/**
 * After a batch with the gate on: one admin item for the rows that wait for a
 * draft, keyed by ET date. Raised through the episode mechanism: a later pass
 * the same day rewrites the item quietly when the list changed, an item that
 * no longer holds is closed, and work that comes back after a close (a draft
 * that failed a gate) reopens the item and rings.
 */
async function raiseTerminalDue({ now = new Date(), deps = {} } = {}) {
  const { due, written, rebrief } = await awaitingTerminalDrafts({ now, deps });
  const n = due.length;
  const todayKey = `${ALERT_KEY_PREFIX}${etDateString(now)}`;
  const episodes = deps.episodes || require('../admin-alert-episodes');
  const conn = deps.db || db;
  const stale = (await episodes.openAdminAlertKeys(conn, ALERT_KEY_PREFIX)).filter((key) => n === 0 || key !== todayKey);
  await episodes.closeAdminAlertKeys(conn, stale, 'drafts_written', { now, resolution: 'Cleared: these website posts no longer wait for a draft' });
  logger.info(`[terminal-writer] ${n} waiting for a draft, ${written.length} written, ${rebrief.length} waiting for a retry brief`);
  const counts = { due: n, written: written.length, rebrief: rebrief.length };
  if (!n) return { ...counts, delivered: false };

  const composed = require('../admin-alert-compose').composeAdminAlert({
    area: 'Content',
    action: `write ${n} website post${n === 1 ? '' : 's'} in the terminal`,
    why: `The content queue has ${n} post${n === 1 ? '' : 's'} that wait for a draft from the terminal.`,
    severity: 'needs-you',
    link: '/admin/blog?tab=autopilot',
    subject: { type: 'check', id: 'content-terminal-writer' },
    doneWhen: 'drafts_written',
    who: 'claude',
  });
  const raised = await episodes.raiseAdminAlertWithReopen('content', composed.headline, composed.why, {
    link: composed.link,
    metadata: composed.metadata,
    // `content` is not on the bell policy's default list; this item asks the
    // owner for work, so it rings unless the owner turned the category off.
    bellDefault: true,
    dedupeKey: todayKey,
    // What is due, so the same list is a plain dedupe and a changed one is a rewrite.
    dedupeVersion: crypto.createHash('sha1').update(due.map((r) => `${r.opportunity_id}:${r.brief_id}`).sort().join('|')).digest('hex').slice(0, 16),
    refreshOnDedupe: true,
    ringOnRefresh: () => false,
    detail: [
      'Run blog-run in the terminal. Waiting for a draft:',
      ...due.map((r) => `- ${describe(r)}${r.problem ? ' (the last draft file was rejected)' : ''}`),
      ...(written.length ? ['', `Written and waiting for the next run: ${written.length}`] : []),
      ...(rebrief.length ? ['', `Waiting for a new brief at the next run: ${rebrief.length}`] : []),
    ].join('\n'),
  });
  // An item the bell policy (or the owner's own setting) suppressed was not
  // delivered: callers must not treat the owner as told.
  return { ...counts, delivered: raised?.suppressed !== true };
}

module.exports = {
  terminalWriterLive, writesInTerminal, waitingBriefId, fetchTerminalDraft, retireTerminalDraft, draftSourceFor, cleanupConsumedDrafts, awaitingTerminalDrafts, raiseTerminalDue, closeTerminalItems, blogDraftRequested,
  branchFor, draftPathFor, draftProblem,
  AWAITING_OUTCOME, GATE_RETRY_OUTCOME, TERMINAL_AGENT_ID, MISSING, INVALID, UNREADABLE, RECHECK_MS, MAX_BRIEF_AGE_MS, BRANCH_PREFIX, DRAFT_DIR, DRAFT_FIELDS,
};
