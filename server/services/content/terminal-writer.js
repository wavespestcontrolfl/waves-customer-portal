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
 *     shape   the writer agent's emit_draft input, plus opportunity_id
 * No file yet → the run is recorded as `deferred_terminal_draft` and the claim
 * is deferred a few hours (a deferral refunds the attempt), so the 1:00 PM
 * catch-up and the next morning's batch look again. After the batch ONE admin
 * item lists the rows that wait for a draft.
 *
 * A draft is read once: the branch is deleted when the runner takes it. A
 * gate-retry therefore asks for a fresh draft, written against the retry
 * directives the next brief carries.
 *
 * The branch lives in the Astro repo itself (ghFetch reads owner/repo from
 * the environment), so only an account with push access can supply a draft.
 * The file is still untrusted input: it is size-bounded, shape-checked and
 * then judged by the same gates as an agent draft.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');

const BRANCH_PREFIX = 'terminal-writer/';
const DRAFT_DIR = 'terminal-drafts';
const AWAITING_OUTCOME = 'deferred_terminal_draft';
const MISSING = 'terminal_draft_missing';
const INVALID = 'terminal_draft_invalid';
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
function draftProblem(parsed, opportunityId) {
  if (!isObject(parsed)) return 'the file is not a JSON object';
  if (parsed.opportunity_id !== opportunityId) return 'opportunity_id does not match the branch';
  if (!isObject(parsed.frontmatter)) return 'frontmatter must be an object';
  if (typeof parsed.body !== 'string' || parsed.body.trim().length < MIN_BODY_CHARS) return 'body is missing or too short';
  if (parsed.schema != null && !isObject(parsed.schema)) return 'schema must be an object';
  if (parsed.claims_ledger != null && !Array.isArray(parsed.claims_ledger)) return 'claims_ledger must be an array';
  if (parsed.notes_for_reviewer != null && typeof parsed.notes_for_reviewer !== 'string') return 'notes_for_reviewer must be text';
  return null;
}

/**
 * The draft for one claimed row, in the shape agent-dispatcher.runWithBrief
 * returns, so the runner's code after the dispatch does not change.
 *   { ok: true, draft, ... }                     a usable draft
 *   { ok: false, code: MISSING | INVALID, ... }  wait for the terminal
 * A GitHub failure other than "not found" throws: the run fails and retries,
 * it must not be recorded as "no draft yet".
 */
async function fetchTerminalDraft(opportunityId, { gh = require('../content-astro/github-client') } = {}) {
  const t0 = Date.now();
  const base = { agent_id: 'terminal-writer', session_id: null };
  let file;
  try {
    file = await gh.getFile(draftPathFor(opportunityId), branchFor(opportunityId));
  } catch (err) {
    if (Number(err?.status) !== 404) throw err;
    file = null;
  }
  const result = (patch) => ({ ...base, ...patch, duration_ms: Date.now() - t0 });
  if (!file) return result({ ok: false, code: MISSING, reason: 'no draft on the terminal branch yet' });
  const invalid = (why) => result({ ok: false, code: INVALID, reason: `terminal draft rejected: ${why}` });
  if (Buffer.byteLength(file.content || '', 'utf8') > MAX_DRAFT_BYTES) return invalid('the file is too large');
  let parsed;
  try { parsed = JSON.parse(file.content); } catch { return invalid('the file is not valid JSON'); }
  const problem = draftProblem(parsed, opportunityId);
  if (problem) return invalid(problem);
  const draft = Object.fromEntries(DRAFT_FIELDS.filter((f) => parsed[f] != null).map((f) => [f, parsed[f]]));
  return result({ ok: true, draft });
}

/**
 * Delete the draft branch once the runner holds the draft. Returns true only
 * when the branch is confirmed gone; never throws. The runner uses a draft
 * only after a confirmed delete: a file that survives would be read again by
 * a gate retry, which must get a new draft.
 */
async function retireTerminalDraft(opportunityId, { gh = require('../content-astro/github-client') } = {}) {
  try {
    return (await gh.retireBranch(branchFor(opportunityId))) === true;
  } catch (err) {
    logger.warn(`[terminal-writer] could not delete ${branchFor(opportunityId)}: ${err.message}`);
    return false;
  }
}

/**
 * Rows that wait for a terminal draft: pending rows whose LATEST run ended
 * `deferred_terminal_draft`, best score first. `written` = a usable draft
 * file is on the branch (the next run takes it); `due` = nothing usable is
 * there, which includes a file the run would reject.
 */
async function awaitingTerminalDrafts({ deps = {} } = {}) {
  const conn = deps.db || db;
  const gh = deps.gh || require('../content-astro/github-client');
  const { rows } = await conn.raw(`
    SELECT * FROM (
      SELECT DISTINCT ON (r.opportunity_id)
             r.opportunity_id, r.brief_id, r.action_type, r.outcome, r.skip_reason, r.reviewer_notes, r.created_at,
             q.query, q.page_url, q.service, q.city, q.score
        FROM autonomous_runs r
        JOIN opportunity_queue q ON q.id = r.opportunity_id
       WHERE q.status = 'pending'
         AND r.created_at >= now() - (?::int * interval '1 day')
       ORDER BY r.opportunity_id, r.created_at DESC
    ) latest
    WHERE outcome = ?
    ORDER BY score DESC`, [AWAITING_WINDOW_DAYS, AWAITING_OUTCOME]);
  const due = [];
  const written = [];
  for (const row of rows) {
    const item = { ...row, branch: branchFor(row.opportunity_id), draft_path: draftPathFor(row.opportunity_id) };
    // Written = the file the next run will read is usable now. A branch with
    // no file, or with a file the run would reject, is still due.
    const usable = (await fetchTerminalDraft(row.opportunity_id, { gh })).ok;
    (usable ? written : due).push(item);
  }
  return { due, written };
}

const describe = (r) => `${String(r.action_type || 'post').replace(/_/g, ' ')}: ${r.query || r.page_url || [r.service, r.city].filter(Boolean).join(' in ') || 'untitled'}`;

/**
 * After a batch with the gate on: one admin item for the rows that wait for a
 * draft, keyed by ET date. A later pass the same day rewrites it quietly when
 * the list changed; items that no longer hold are closed.
 */
async function raiseTerminalDue({ now = new Date(), deps = {} } = {}) {
  const { due, written } = await awaitingTerminalDrafts({ deps });
  const n = due.length;
  const todayKey = `${ALERT_KEY_PREFIX}${etDateString(now)}`;
  const episodes = deps.episodes || require('../admin-alert-episodes');
  const conn = deps.db || db;
  const stale = (await episodes.openAdminAlertKeys(conn, ALERT_KEY_PREFIX)).filter((key) => n === 0 || key !== todayKey);
  await episodes.closeAdminAlertKeys(conn, stale, 'drafts_written', { now, resolution: 'Cleared: these website posts no longer wait for a draft' });
  logger.info(`[terminal-writer] ${n} waiting for a draft, ${written.length} written and waiting for the next run`);
  if (!n) return { due: 0, written: written.length };

  const raise = deps.raiseAdminAlert || require('../admin-alert-compose').raiseAdminAlert;
  await raise('content', {
    area: 'Content',
    action: `write ${n} website post${n === 1 ? '' : 's'} in the terminal`,
    why: `The content queue has ${n} post${n === 1 ? '' : 's'} that wait for a draft from the terminal.`,
    severity: 'needs-you',
    link: '/admin/blog?tab=autopilot',
    subject: { type: 'check', id: 'content-terminal-writer' },
    doneWhen: 'drafts_written',
    who: 'claude',
  }, {
    dedupeKey: todayKey,
    refreshOnDedupe: true,
    ringOnRefresh: () => false,
    detail: [
      'Run blog-run in the terminal. Waiting for a draft:',
      ...due.map((r) => `- ${describe(r)}${r.skip_reason === INVALID ? ' (the last draft file was rejected)' : ''}`),
      ...(written.length ? ['', `Written and waiting for the next run: ${written.length}`] : []),
    ].join('\n'),
  });
  return { due: n, written: written.length };
}

module.exports = {
  terminalWriterLive, writesInTerminal, fetchTerminalDraft, retireTerminalDraft, awaitingTerminalDrafts, raiseTerminalDue,
  branchFor, draftPathFor, draftProblem,
  AWAITING_OUTCOME, MISSING, INVALID, RECHECK_MS, BRANCH_PREFIX, DRAFT_DIR, DRAFT_FIELDS,
};
