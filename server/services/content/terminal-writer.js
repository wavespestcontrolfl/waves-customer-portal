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

// A title/meta rewrite is a different, tiny draft shape with its own agent
// and its own handler; it stays on the agent. Everything else the dispatch
// step writes is a page body.
const writesInTerminal = (brief) => terminalWriterLive()
  && brief?.action_type !== 'rewrite_title_meta' && brief?.page_type !== 'metadata';

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
 * LATEST run, when that run ended waiting for a draft. Null when the latest
 * run is anything else (a gate retry, a publish): the row then needs a new
 * brief first, and any file still on its branch is stale.
 */
async function waitingBriefId(opportunityId, { conn = db } = {}) {
  const latest = await conn('autonomous_runs').where('opportunity_id', opportunityId)
    .orderBy('created_at', 'desc').first('outcome', 'brief_id');
  return latest?.outcome === AWAITING_OUTCOME ? latest.brief_id || null : null;
}

/**
 * The draft for one row, in the shape agent-dispatcher.runWithBrief returns,
 * so the runner's code after the dispatch does not change.
 *   { ok: true, draft, brief_id, revision }      a usable draft
 *   { ok: false, code: MISSING | INVALID, ... }  wait for the terminal
 * `revision` is the branch commit the file was read at (for the cleanup).
 * A GitHub failure other than "not found" throws; the runner records it as
 * `terminal_draft_unreadable` (never as "no draft yet") and the row keeps
 * waiting on the same brief.
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
 * Pending rows by what their LATEST run says, best score first:
 *   due      it ended waiting and no usable draft for its brief is pushed
 *            (a file the run would reject counts as not pushed)
 *   written  a usable draft is on the branch; the next run takes it
 *   rebrief  a terminal draft failed a gate; the next run writes the retry
 *            brief, and only then can the terminal write again
 */
async function awaitingTerminalDrafts({ deps = {} } = {}) {
  const conn = deps.db || db;
  const gh = deps.gh || require('../content-astro/github-client');
  const { rows } = await conn.raw(`
    SELECT * FROM (
      SELECT DISTINCT ON (r.opportunity_id)
             r.opportunity_id, r.brief_id, r.action_type, r.outcome, r.agent_id, r.skip_reason, r.reviewer_notes, r.created_at,
             q.query, q.page_url, q.service, q.city, q.score
        FROM autonomous_runs r
        JOIN opportunity_queue q ON q.id = r.opportunity_id
       WHERE q.status = 'pending'
         AND r.created_at >= now() - (?::int * interval '1 day')
       ORDER BY r.opportunity_id, r.created_at DESC
    ) latest
    WHERE outcome = ? OR (outcome = ? AND agent_id = ?)
    ORDER BY score DESC`, [AWAITING_WINDOW_DAYS, AWAITING_OUTCOME, GATE_RETRY_OUTCOME, TERMINAL_AGENT_ID]);
  const due = [];
  const written = [];
  const rebrief = [];
  for (const row of rows) {
    const item = { ...row, branch: branchFor(row.opportunity_id), draft_path: draftPathFor(row.opportunity_id) };
    if (row.outcome !== AWAITING_OUTCOME) { rebrief.push(item); continue; }
    const fetched = await fetchTerminalDraft(row.opportunity_id, { gh, expectedBriefId: row.brief_id });
    if (fetched.ok) written.push(item);
    else due.push({ ...item, problem: fetched.code === INVALID ? fetched.reason : null });
  }
  return { due, written, rebrief };
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
  const { due, written, rebrief } = await awaitingTerminalDrafts({ deps });
  const n = due.length;
  const todayKey = `${ALERT_KEY_PREFIX}${etDateString(now)}`;
  const episodes = deps.episodes || require('../admin-alert-episodes');
  const conn = deps.db || db;
  const stale = (await episodes.openAdminAlertKeys(conn, ALERT_KEY_PREFIX)).filter((key) => n === 0 || key !== todayKey);
  await episodes.closeAdminAlertKeys(conn, stale, 'drafts_written', { now, resolution: 'Cleared: these website posts no longer wait for a draft' });
  logger.info(`[terminal-writer] ${n} waiting for a draft, ${written.length} written, ${rebrief.length} waiting for a retry brief`);
  const counts = { due: n, written: written.length, rebrief: rebrief.length };
  if (!n) return counts;

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
  await episodes.raiseAdminAlertWithReopen('content', composed.headline, composed.why, {
    link: composed.link,
    metadata: composed.metadata,
    dedupeKey: todayKey,
    // What is due, so the same list is a plain dedupe and a changed one is a rewrite.
    dedupeVersion: crypto.createHash('sha1').update(due.map((r) => `${r.opportunity_id}:${r.brief_id}`).sort().join('|')).digest('hex').slice(0, 16),
    refreshOnDedupe: true,
    ringOnRefresh: () => false,
    detail: [
      'Run blog-run in the terminal. Waiting for a draft:',
      ...due.map((r) => `- ${describe(r)}${r.problem ? ' (the last draft file was rejected)' : ''}`),
      ...(written.length ? ['', `Written and waiting for the next run: ${written.length}`] : []),
      ...(rebrief.length ? ['', `Failed a check and waiting for a new brief at the next run: ${rebrief.length}`] : []),
    ].join('\n'),
  });
  return counts;
}

module.exports = {
  terminalWriterLive, writesInTerminal, waitingBriefId, fetchTerminalDraft, retireTerminalDraft, awaitingTerminalDrafts, raiseTerminalDue,
  branchFor, draftPathFor, draftProblem,
  AWAITING_OUTCOME, GATE_RETRY_OUTCOME, TERMINAL_AGENT_ID, MISSING, INVALID, UNREADABLE, RECHECK_MS, MAX_BRIEF_AGE_MS, BRANCH_PREFIX, DRAFT_DIR, DRAFT_FIELDS,
};
