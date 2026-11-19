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
 * is deferred a few hours (a deferral refunds the attempt). The next morning's
 * batch claims the rows whose draft is written by then before it claims by
 * score (autonomous-runner _runDailyInner). The 1:00 PM catch-up claims blog
 * rows only (written blog drafts first, then by score), so it never looks
 * again at a refresh. After the batch ONE admin item lists the rows that wait
 * for a draft.
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
 * Owner 2026-11-02 ("A"): instead of a draft the file can be a HOLD, when the
 * row cannot be written as briefed (a live post already covers the topic, a
 * site rule bars it, the brief cannot pass the portal's own checks, or it needs
 * the owner's decision):
 *     { opportunity_id, brief_id, hold: { reason, detail, question? } }
 * The run that reads it records `deferred_terminal_hold` and keeps the row out
 * of the queue for HOLD_MS (the next claim after that composes a new brief);
 * a `needs_owner` hold also asks the owner its question in one admin item
 * (syncHoldQuestions, at the end of each batch).
 *
 * The branch lives in the Astro repo itself (ghFetch reads owner/repo from
 * the environment), so only an account with push access can supply a draft.
 * The file is still untrusted input: it is size-bounded, shape-checked and
 * then judged by the same gates as an agent draft.
 *
 * Blog fact check on the Mac (CONTENT_EDITORIAL_REVIEW_HOST=mac, owner
 * 2026-11-19). With GATE_EDITORIAL_EVIDENCE on, an agent session must get its
 * answer plan approved (validate_answer_plan) before it can emit a draft, and a
 * draft file used to be unable to carry that approval, so supporting-blog,
 * customer-question and refresh briefs stayed on the paid agent. In Mac mode
 * the file carries the plan as `answer_plan: { sections: [...] }` (the
 * validate_answer_plan input) and those briefs stay in the terminal. The
 * server leaves EVERY terminal draft and hold to the Mac job (it reads no
 * GitHub branch and consumes nothing: draftSourceFor waits with
 * terminal_draft_awaits_mac). The Mac job runs this module with
 * CONTENT_EDITORIAL_REVIEW_RUNNER=mac, where its model calls ride the Claude
 * plan: fetchTerminalDraft only shape-checks the plan (it never calls a
 * model; the listing reads every waiting row), and draftSourceFor reviews it
 * (editorial-review reviewPlan) and binds it to the body headings, as emit_draft
 * does for an agent. Both variables are strict `=== 'mac'`; unset = no change.
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
// The file is a hold (the row cannot be written as briefed), not a draft.
const HELD = 'terminal_draft_held';
const HOLD_OUTCOME = 'deferred_terminal_hold';
// How long a held row stays out of the queue (owner 2026-11-02: 30 days).
const HOLD_MS = 30 * 24 * 60 * 60 * 1000;
const HOLD_REASONS = Object.freeze(['duplicate', 'blocked_by_rule', 'brief_unusable', 'needs_owner']);
const MAX_HOLD_DETAIL_CHARS = 500;
const MAX_HOLD_QUESTION_CHARS = 300;
// One owner item per held row that needs the owner (raiseHoldQuestion).
const HOLD_KEY_PREFIX = 'content-terminal-hold:';
const ALERT_KEY_PREFIX = 'content-terminal-due:';
// The owner's item when the terminal stops handling the list (raiseTerminalStalled).
const STALL_KEY_PREFIX = 'content-terminal-stalled:';
const STALL_MS = 44 * 60 * 60 * 1000;
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

// Config, not gates (owner 2026-11-19). Read at call time, strict.
// HOST: Railway sets it; the Mac job takes the drafts that need the fact check.
const editorialReviewOnMac = () => process.env.CONTENT_EDITORIAL_REVIEW_HOST === 'mac';
// RUNNER: only the Mac job sets it ("this process is the Mac job").
const runningOnMac = () => process.env.CONTENT_EDITORIAL_REVIEW_RUNNER === 'mac';
const AWAITS_MAC = 'terminal_draft_awaits_mac';
const PLAN_UNAVAILABLE = 'terminal_plan_review_unavailable';
const MAX_PLAN_REASON_CHARS = 700;
// In Mac mode a wait is rechecked soon, not after RECHECK_MS: the Mac job takes a
// draft the terminal wrote after the server's look at the row, and its claim
// cannot take a row still deferred. Other queue deferrals are not touched.
const MAC_RECHECK_MS = 30 * 60 * 1000;
const recheckMs = () => (editorialReviewOnMac() ? MAC_RECHECK_MS : RECHECK_MS);
// A rejected plan stays on its run so the listing does not offer the same commit again.
const REJECTED_AT_RE = /\s*\[terminal revision ([^\]\s]+)\]$/;

// The model lanes of the review the Mac job runs (editorial-review.js). The owner's spend line
// (2026-11-19, "A"): each must be answered by the Max plan.
const MAC_MODEL_LANES = Object.freeze(['editorial_review', 'editorial_repair', 'editorial_plan_review']);

/**
 * True when the Max-plan adapter (~/max-runner/claude-code-fetch.js) is the live fetch and answers
 * every lane in MAC_MODEL_LANES: in lane mode it lists them and reads the lane from this very
 * agent-control context module (a different copy of the portal reads another context, so its calls
 * would pass through to the paid API). The adapter marks itself on the global when it wraps fetch.
 */
function maxPlanAdapterCovers({ target = globalThis, lanes = MAC_MODEL_LANES } = {}) {
  const adapter = target.__maxRunnerAdapter;
  if (!adapter || typeof target.fetch !== 'function' || adapter.fetch !== target.fetch) return false;
  if (adapter.answers === 'all') return true;
  if (!Array.isArray(adapter.answers) || !lanes.every((lane) => adapter.answers.includes(lane))) return false;
  try {
    const fs = require('fs');
    return fs.realpathSync(require.resolve('../agent-control/context')) === fs.realpathSync(String(adapter.contextModule || ''));
  } catch {
    return false;
  }
}

// Briefs the editorial-evidence gate covers (the same test as
// brief-driven-tools.js registerSessionEditorial). With that gate on, the
// agent session must get its answer plan approved and its headings are
// checked against the plan before a draft is captured.
function editorialPlanRequired(brief) {
  if (!require('./editorial-evidence').enabled()) return false;
  const refresh = brief?.page_type === 'refresh' || brief?.action_type === 'refresh_existing_page';
  return refresh || ['supporting-blog', 'customer-question'].includes(brief?.page_type);
}

// A terminal draft file normally cannot carry that approval, so those briefs
// stay on the agent. In Mac mode the file carries the plan and the Mac job
// reviews it, so the terminal keeps them.
const needsEditorialPlan = (brief) => !editorialReviewOnMac() && editorialPlanRequired(brief);

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
  return answerPlanProblem(parsed.answer_plan);
}

// Shape only (no model): the validate_answer_plan input, when the file has one,
// with the same per-section rules reviewPlan applies before it calls a model.
function answerPlanProblem(plan) {
  if (plan == null) return null;
  if (!isObject(plan)) return 'answer_plan must be an object with a sections list';
  return require('./editorial-plan-shape').planSectionsProblem(plan.sections);
}

const holdText = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '');

/** Why a parsed hold file is not a usable hold for this row, or null. */
function holdProblem(parsed, opportunityId, expectedBriefId) {
  if (parsed.opportunity_id !== opportunityId) return 'opportunity_id does not match the branch';
  if (String(parsed.brief_id ?? '') !== String(expectedBriefId)) return 'brief_id is not the brief this row waits on';
  if (parsed.body != null || parsed.frontmatter != null) return 'a file is a draft or a hold, not both';
  const { hold } = parsed;
  if (!isObject(hold)) return 'hold must be an object';
  if (!HOLD_REASONS.includes(hold.reason)) return `hold.reason must be one of ${HOLD_REASONS.join(', ')}`;
  const detail = holdText(hold.detail);
  if (!detail || detail.length > MAX_HOLD_DETAIL_CHARS) return `hold.detail must be 1 to ${MAX_HOLD_DETAIL_CHARS} characters`;
  const question = holdText(hold.question);
  if (hold.reason === 'needs_owner' && (!question || question.length > MAX_HOLD_QUESTION_CHARS)) return `a needs_owner hold needs a question of 1 to ${MAX_HOLD_QUESTION_CHARS} characters`;
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
 *   { ok: false, code: HELD, hold, revision }    a usable hold (no draft)
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
  if (isObject(parsed) && parsed.hold !== undefined) {
    const holdIssue = holdProblem(parsed, opportunityId, expectedBriefId);
    if (holdIssue) return invalid(holdIssue);
    const hold = { reason: parsed.hold.reason, detail: holdText(parsed.hold.detail), ...(parsed.hold.reason === 'needs_owner' ? { question: holdText(parsed.hold.question) } : {}) };
    return result({ ok: false, code: HELD, hold, brief_id: expectedBriefId, revision });
  }
  const problem = draftProblem(parsed, opportunityId, expectedBriefId);
  if (problem) return invalid(problem);
  // `type: 'draft'` is what the agent's emit_draft handler stamps on a captured
  // draft (brief-driven-tools.js) and what the publisher's canPublishRefresh /
  // canPublishDraftBrief require. Set here, never read from the file.
  const draft = { type: 'draft', ...Object.fromEntries(DRAFT_FIELDS.filter((f) => parsed[f] != null).map((f) => [f, parsed[f]])) };
  return result({ ok: true, draft, brief_id: expectedBriefId, revision, ...(parsed.answer_plan != null ? { answer_plan: parsed.answer_plan } : {}) });
}

const waitResult = (code, reason) => ({ ok: false, wait: true, code, reason, agent_id: TERMINAL_AGENT_ID, session_id: null });
// `revision` (the commit that was read) rides on the reason so awaitingTerminalDrafts can tell this file from a rewrite.
const invalidPlan = (why, revision) => waitResult(INVALID, `${`terminal draft rejected: ${why}`.slice(0, MAX_PLAN_REASON_CHARS + 60)}${revision ? ` [terminal revision ${revision}]` : ''}`);

// The reviewer's own findings, in a bounded sentence.
function planFindingsText(findings) {
  const text = (Array.isArray(findings) ? findings : []).map((f) => `section ${Number(f?.sectionIndex) + 1}: ${f?.detail || ''} ${f?.action || ''}`.trim()).join(' | ');
  return text.slice(0, MAX_PLAN_REASON_CHARS);
}

/**
 * Mac mode, a brief the fact check covers: the plan the draft file carries must
 * pass the reviewer and match the body (the same two steps an agent's
 * validate_answer_plan + emit_draft make). Takes a fetched ok result; returns
 * it, or a wait: INVALID when the draft is wrong (the terminal rewrites it),
 * PLAN_UNAVAILABLE when the check could not run (the row retries and the draft
 * stays). Runs only where a model call is free (the Mac job).
 */
async function checkAnswerPlan(brief, fetched) {
  const tools = require('./agents/brief-driven-tools');
  let context;
  let review;
  try {
    context = await tools.editorialPlanContextForBrief(brief);
    if (context.applicable === false) return fetched; // a refresh of a page outside the blog contract
    if (context.unresolved) return waitResult(PLAN_UNAVAILABLE, 'the title for the answer-plan review could not be resolved; the row looks again later');
    if (!fetched.answer_plan) return invalidPlan('answer_plan is missing: this brief needs the answer plan the blog fact check reviews (see answer_plan_shape in the writing pack)', fetched.revision);
    review = await require('./editorial-review').reviewPlan({ title: context.title, sections: fetched.answer_plan.sections });
  } catch (err) {
    return waitResult(PLAN_UNAVAILABLE, `the answer-plan review could not run: ${err.message}`);
  }
  // reviewPlan fails closed with no model when it could not reach one.
  if (review?.pass !== true && !review?.model) return waitResult(PLAN_UNAVAILABLE, 'the answer-plan reviewer was unavailable; the row looks again later');
  if (review?.pass !== true) return invalidPlan(`the answer plan failed review: ${planFindingsText(review?.findings)}`, fetched.revision);
  const mismatch = tools.planSectionMismatch(fetched.answer_plan.sections, fetched.draft.body, { partial: context.partial });
  if (mismatch) return invalidPlan(`the body does not match the answer plan. ${tools.planMismatchDirectives(mismatch).join(' ')}`, fetched.revision);
  return fetched;
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
 * records the run as waiting and looks again later. `held: true` means the
 * terminal held the row: the runner records the hold and parks the row. A read failure waits too
 * and never fails the run: a failed run would stop the row waiting on its
 * brief and orphan a draft that is already pushed.
 */
function draftSourceFor(opportunityId, brief, { handed = false, dryRun = false, gh } = {}) {
  if (dryRun || !writesInTerminal(brief)) return null;
  return {
    async runWithBrief() {
      // Mac mode: the Mac job takes every terminal draft and hold. The server
      // reads no branch and takes nothing, so nothing is consumed here.
      if (editorialReviewOnMac() && !runningOnMac()) {
        return waitResult(AWAITS_MAC, 'the Mac job takes terminal drafts; this row waits for it');
      }
      const fetched = await fetchTerminalDraft(opportunityId, { ...(gh ? { gh } : {}), expectedBriefId: handed ? brief.id : null })
        .catch((err) => ({ ok: false, code: UNREADABLE, reason: `terminal draft could not be read: ${err.message}`, agent_id: TERMINAL_AGENT_ID, session_id: null }));
      if (fetched.ok) return editorialPlanRequired(brief) ? checkAnswerPlan(brief, fetched) : fetched;
      return fetched.code === HELD ? { ...fetched, held: true } : { ...fetched, wait: true };
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

// The reason a run on this brief rejected this commit's answer plan, or null.
function rejectedPlanProblem(row, revision) {
  if (typeof row.rejected_notes !== 'string') return null;
  const match = REJECTED_AT_RE.exec(row.rejected_notes);
  return match && match[1] === revision ? row.rejected_notes.replace(REJECTED_AT_RE, '') : null;
}

/**
 * Pending rows by what their LATEST run says, best score first:
 *   due      it ended waiting and no usable draft for its brief is pushed
 *            (a file the run would reject counts as not pushed)
 *   written  a usable draft is on the branch; the next run takes it (not one
            whose answer plan the last run rejected at this commit: that is due)
 *   held     a usable hold is on the branch; the next run parks the row
 *   rebrief  the row needs a new brief before the terminal can write: its
 *            draft failed a gate (the next run writes the retry brief), or
 *            the brief it waits on is too old
 */
async function awaitingTerminalDrafts({ now = new Date(), deps = {} } = {}) {
  const conn = deps.db || db;
  const gh = deps.gh || require('../content-astro/github-client');
  // rejected_notes: the newest rejection on the same brief, so a wait recorded after it (a server
  // pass in Mac mode) does not hide it and offer the same commit again.
  const { rows } = await conn.raw(`
    SELECT latest.*,
           (SELECT x.reviewer_notes FROM autonomous_runs x
             WHERE x.opportunity_id = latest.opportunity_id AND x.brief_id = latest.brief_id AND x.skip_reason = ?
             ORDER BY x.created_at DESC LIMIT 1) AS rejected_notes
      FROM (
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
    ORDER BY score DESC`, [INVALID, AWAITING_WINDOW_DAYS, PRE_DRAFT_CAP_OUTCOME, AWAITING_OUTCOME, GATE_RETRY_OUTCOME, TERMINAL_AGENT_ID]);
  const due = [];
  const written = [];
  const held = [];
  const rebrief = [];
  // Rejections come from the answer-plan review, which runs only while the blog fact check is on.
  const plansReviewed = require('./editorial-evidence').enabled();
  for (const row of rows) {
    const item = { ...row, branch: branchFor(row.opportunity_id), draft_path: draftPathFor(row.opportunity_id) };
    // Same rule as the runner (_briefHandedToTerminal): a brief that is gone
    // or too old is replaced at the next run, so it is not offered for writing.
    const briefAge = row.brief_created_at ? now.getTime() - new Date(row.brief_created_at).getTime() : Infinity;
    if (row.outcome !== AWAITING_OUTCOME || briefAge > MAX_BRIEF_AGE_MS) { rebrief.push(item); continue; }
    const fetched = await fetchTerminalDraft(row.opportunity_id, { gh, expectedBriefId: row.brief_id });
    // A plan the last run rejected at this very commit is not offered again: it is due,
    // with the reviewer's reason, until the branch tip changes.
    const rejected = fetched.ok && plansReviewed ? rejectedPlanProblem(row, fetched.revision) : null;
    if (rejected) due.push({ ...item, problem: rejected });
    else if (fetched.ok) written.push(item);
    else if (fetched.code === HELD) held.push({ ...item, hold: fetched.hold });
    else due.push({ ...item, problem: fetched.code === INVALID ? fetched.reason : null });
  }
  return { due, written, held, rebrief };
}

/**
 * The gate is off (the kill switch): the agent drafts again and no terminal
 * work is asked for, so every open terminal item is closed. No GitHub read.
 */
async function closeTerminalItems({ now = new Date(), deps = {} } = {}) {
  const episodes = deps.episodes || require('../admin-alert-episodes');
  const conn = deps.db || db;
  const open = new Set();
  for (const prefix of [ALERT_KEY_PREFIX, STALL_KEY_PREFIX]) {
    for (const key of await episodes.openAdminAlertKeys(conn, prefix)) open.add(key);
  }
  return episodes.closeAdminAlertKeys(conn, [...open], 'terminal_writer_off', { now, resolution: 'Cleared: the portal writes these drafts itself again' });
}

/**
 * Mac mode: a blog whose draft or hold is pushed waits for the Mac job, not for a
 * writer, so the terminal item may be closed while it waits; "no blog today" is
 * false news then too. False outside Mac mode and on any read failure (the
 * drought alert is the fallback signal, so doubt keeps it).
 */
async function macHoldsBlogDraft({ deps = {} } = {}) {
  if (!terminalWriterLive() || !editorialReviewOnMac()) return false;
  try {
    const { written, held } = await awaitingTerminalDrafts({ deps });
    return [...written, ...held].some((row) => row.action_type === 'new_supporting_blog');
  } catch (err) {
    logger.warn(`[terminal-writer] could not tell whether a blog waits for the Mac job: ${err.message}`);
    return false;
  }
}

/**
 * True when a blog waits for its terminal draft AND today's item stands, so
 * the wait is on record (in the owner's bell, or in Claude's queue while the
 * Mac job writes the drafts and raiseTerminalStalled watches it). The blog
 * drought alert reads this: "no blog today" is false news then. False when the gate is off, when only other page types
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
// What is due, so the same list is a plain dedupe and a changed one is a rewrite.
const listVersion = (rows) => crypto.createHash('sha1').update(rows.map((r) => `${r.opportunity_id}:${r.brief_id}`).sort().join('|')).digest('hex').slice(0, 16);

/**
 * Owner 2026-11-02 ("A"): the 9:15 AM blog-run job on the owner's Mac writes
 * the drafts on this list, so the daily item is Claude's work. While this
 * switch is on (the default), the item is stamped
 * for that queue (admin-alert-routing.js class content-terminal-due: Activity
 * only, fyi) and the owner's bell rings only for a list the terminal stopped
 * handling (raiseTerminalStalled). AUTONOMOUS_CONTENT_TERMINAL_DUE_QUIET=false
 * rings the daily item for the owner again, as before.
 */
function dueItemQuiet() {
  return !/^(0|false|no|off)$/i.test(String(process.env.AUTONOMOUS_CONTENT_TERMINAL_DUE_QUIET ?? '').trim());
}

/**
 * The owner's bell for a list the terminal stopped handling: rows that waited
 * STALL_MS on the same brief with no usable draft (two 9:15 AM runs went by,
 * so the Mac job is down or passes the rows over). One item keyed by ET date,
 * raised and closed like the daily item. An empty `stalled` only closes.
 * Returns how many rows stalled.
 */
async function raiseTerminalStalled({ due, now, conn, episodes }) {
  const stalled = due.filter((r) => now.getTime() - new Date(r.brief_created_at).getTime() >= STALL_MS);
  const n = stalled.length;
  const todayKey = `${STALL_KEY_PREFIX}${etDateString(now)}`;
  const stale = (await episodes.openAdminAlertKeys(conn, STALL_KEY_PREFIX)).filter((key) => n === 0 || key !== todayKey);
  await episodes.closeAdminAlertKeys(conn, stale, 'terminal_caught_up', { now, resolution: 'Cleared: no website post has waited 2 days for the terminal' });
  if (!n) return 0;
  const composed = require('../admin-alert-compose').composeAdminAlert({
    area: 'Content',
    action: `blog-run left ${n} website post${n === 1 ? '' : 's'} for 2 days`,
    why: 'The terminal has not handled them in 2 days, so the 9:15 AM blog-run job on the Mac may be down.',
    severity: 'needs-you',
    link: '/admin/blog?tab=autopilot',
    subject: { type: 'check', id: 'content-terminal-stalled' },
    doneWhen: 'terminal_caught_up',
    who: 'person',
  });
  await episodes.raiseAdminAlertWithReopen('content', composed.headline, composed.why, {
    link: composed.link,
    metadata: composed.metadata,
    // `content` is off the bell policy's default list; this item is the owner's.
    bellDefault: true,
    dedupeKey: todayKey,
    dedupeVersion: listVersion(stalled),
    refreshOnDedupe: true,
    ringOnRefresh: () => false,
    detail: [
      'Ask Claude to check the blog-run job on the Mac (its log: ~/.claude/logs/blog-run-daily.log).',
      'Waiting 2 days for a draft:',
      ...stalled.map((r) => `- ${describe(r)}${r.problem ? ' (the last draft file was rejected)' : ''}`),
    ].join('\n'),
  });
  return n;
}

/**
 * After a batch with the gate on: one admin item for the rows that wait for a
 * draft, keyed by ET date. Raised through the episode mechanism: a later pass
 * the same day rewrites the item quietly when the list changed, an item that
 * no longer holds is closed, and work that comes back after a close (a draft
 * that failed a gate) reopens the item and rings. While dueItemQuiet() the
 * item goes to Claude's queue and the owner's bell is raiseTerminalStalled.
 */
async function raiseTerminalDue({ now = new Date(), deps = {} } = {}) {
  const { due, written, rebrief } = await awaitingTerminalDrafts({ now, deps });
  const n = due.length;
  const quiet = dueItemQuiet();
  const todayKey = `${ALERT_KEY_PREFIX}${etDateString(now)}`;
  const episodes = deps.episodes || require('../admin-alert-episodes');
  const conn = deps.db || db;
  const stale = (await episodes.openAdminAlertKeys(conn, ALERT_KEY_PREFIX)).filter((key) => n === 0 || key !== todayKey);
  await episodes.closeAdminAlertKeys(conn, stale, 'drafts_written', { now, resolution: 'Cleared: these website posts no longer wait for a draft' });
  // Not quiet: the daily item rings the owner itself, so a standing stalled item is only closed.
  const stalled = await raiseTerminalStalled({ due: quiet ? due : [], now, conn, episodes });
  logger.info(`[terminal-writer] ${n} waiting for a draft (${stalled} for 2 days), ${written.length} written, ${rebrief.length} waiting for a retry brief`);
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
    // terminalDue routes the item to Claude's queue (admin-alert-routing.js).
    metadata: quiet ? { ...composed.metadata, terminalDue: 'claude' } : composed.metadata,
    // `content` is not on the bell policy's default list. Unrouted, this item
    // asks the owner for work, so it rings unless the owner turned the
    // category off; a routed item never rings.
    bellDefault: true,
    dedupeKey: todayKey,
    dedupeVersion: listVersion(due),
    refreshOnDedupe: true,
    ringOnRefresh: () => false,
    detail: [
      quiet ? 'The 9:15 AM blog-run job on the Mac writes these. Waiting for a draft:' : 'Run blog-run in the terminal. Waiting for a draft:',
      ...due.map((r) => `- ${describe(r)}${r.problem ? ' (the last draft file was rejected)' : ''}`),
      ...(written.length ? ['', `Written and waiting for the next run: ${written.length}`] : []),
      ...(rebrief.length ? ['', `Waiting for a new brief at the next run: ${rebrief.length}`] : []),
    ].join('\n'),
  });
  // An item the bell policy (or the owner's own setting) suppressed was not
  // delivered: callers must not treat the owner as told.
  return { ...counts, delivered: raised?.suppressed !== true };
}

const holdSkipReason = (reason) => `terminal_hold:${reason}`;

/**
 * A needs_owner hold asks the owner its question (owner 2026-11-02: the bell
 * rings when a post needs the owner's decision). One admin item per held row,
 * `content-terminal-hold:<opportunity id>`. It rings once: a raise onto the
 * standing item is a silent dedupe, and a hold that comes back after the item
 * closed rings again. syncHoldQuestions decides when to raise and close.
 */
async function raiseHoldQuestion({ opportunityId, row = {}, hold, deps = {} }) {
  const episodes = deps.episodes || require('../admin-alert-episodes');
  const { composeAdminAlert, breaksAlertRules, MAX_WHY_CHARS } = require('../admin-alert-compose');
  const question = hold.question;
  // The question itself when it fits a why; else a fixed one, with the question in the detail.
  const why = question.length <= MAX_WHY_CHARS && !breaksAlertRules(question)
    ? question
    : 'The terminal held this website post until you decide; the question is in the details.';
  const composed = composeAdminAlert({
    area: 'Content',
    action: 'a website post needs your decision',
    why,
    severity: 'needs-you',
    link: '/admin/blog?tab=autopilot',
    subject: { type: 'check', id: `content-terminal-hold-${opportunityId}` },
    doneWhen: 'owner_decided',
    who: 'person',
  });
  return episodes.raiseAdminAlertWithReopen('content', composed.headline, composed.why, {
    link: composed.link,
    metadata: { ...composed.metadata, opportunityId },
    // `content` is off the bell policy's default list; this item is the owner's.
    bellDefault: true,
    dedupeKey: `${HOLD_KEY_PREFIX}${opportunityId}`,
    detail: [
      `Post: ${describe(row)}`,
      `Question: ${question}`,
      `Why the terminal held it: ${hold.detail}`,
      'Tell Claude your answer. Until then the post stays out of the queue for 30 days.',
    ].join('\n'),
  });
}

// Pending rows whose latest run (pre-draft cap deferrals aside) is a
// needs_owner hold still inside its hold window, with the hold it stored.
async function rowsWaitingOnOwner(conn) {
  const { rows } = await conn.raw(`
    SELECT * FROM (
      SELECT DISTINCT ON (r.opportunity_id)
             r.opportunity_id::text AS opportunity_id, r.outcome, r.skip_reason, r.draft_payload, r.action_type,
             q.query, q.page_url, q.service, q.city
        FROM autonomous_runs r
        JOIN opportunity_queue q ON q.id = r.opportunity_id
       WHERE q.status = 'pending'
         AND r.created_at >= now() - (?::int * interval '1 day')
         AND NOT (r.outcome = ? AND r.agent_id IS NULL)
       ORDER BY r.opportunity_id, r.created_at DESC
    ) latest
    WHERE outcome = ? AND skip_reason = ?`, [Math.ceil(HOLD_MS / 86400000) + 1, PRE_DRAFT_CAP_OUTCOME, HOLD_OUTCOME, holdSkipReason('needs_owner')]);
  return rows;
}

const storedHold = (payload) => {
  let p = payload;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
  const hold = isObject(p) ? p.hold : null;
  return isObject(hold) && hold.question ? hold : null;
};

/**
 * The owner questions of needs_owner holds, brought up to date after each
 * batch (settleTerminalWork): an item is raised for each row that waits on
 * the owner and has no item yet (so a raise that failed is made again at the
 * next batch end), and each item whose row no longer waits on the owner (it
 * was requeued, briefed again, taken, or left the queue) is closed. A
 * person's own Done stands: an item that is still open by key, read or not,
 * is never raised again. With the gate off every item closes and none is
 * raised. One failed raise never stops the others. Returns the counts.
 */
async function syncHoldQuestions({ now = new Date(), deps = {} } = {}) {
  const episodes = deps.episodes || require('../admin-alert-episodes');
  const conn = deps.db || db;
  const open = await episodes.openAdminAlertKeys(conn, HOLD_KEY_PREFIX);
  const waiting = terminalWriterLive() ? await rowsWaitingOnOwner(conn) : [];
  const keyOf = (id) => `${HOLD_KEY_PREFIX}${String(id).toLowerCase()}`;
  const waitingKeys = new Set(waiting.map((r) => keyOf(r.opportunity_id)));
  const answered = open.filter((key) => !waitingKeys.has(key.toLowerCase()));
  const closed = await episodes.closeAdminAlertKeys(conn, answered, 'owner_decided', { now, resolution: 'Cleared: this website post no longer waits on your decision' });
  const openKeys = new Set(open.map((key) => key.toLowerCase()));
  let raised = 0;
  for (const row of waiting) {
    const hold = storedHold(row.draft_payload);
    if (!hold || openKeys.has(keyOf(row.opportunity_id))) continue;
    try {
      await raiseHoldQuestion({ opportunityId: row.opportunity_id, row, hold, deps });
      raised += 1;
    } catch (err) {
      logger.warn(`[terminal-writer] the owner question for held row ${row.opportunity_id} was not raised: ${err.message}`);
    }
  }
  return { raised, closed };
}

module.exports = {
  terminalWriterLive, editorialReviewOnMac, runningOnMac, editorialPlanRequired, needsEditorialPlan, writesInTerminal, waitingBriefId, fetchTerminalDraft, retireTerminalDraft, draftSourceFor, cleanupConsumedDrafts, awaitingTerminalDrafts, raiseTerminalDue, closeTerminalItems, blogDraftRequested, macHoldsBlogDraft,
  raiseHoldQuestion, syncHoldQuestions, holdSkipReason,
  branchFor, draftPathFor, draftProblem, holdProblem,
  AWAITS_MAC, PLAN_UNAVAILABLE, MAC_RECHECK_MS, recheckMs, MAC_MODEL_LANES, maxPlanAdapterCovers,
  AWAITING_OUTCOME, GATE_RETRY_OUTCOME, TERMINAL_AGENT_ID, MISSING, INVALID, UNREADABLE, RECHECK_MS, MAX_BRIEF_AGE_MS, BRANCH_PREFIX, DRAFT_DIR, DRAFT_FIELDS,
  HELD, HOLD_OUTCOME, HOLD_MS, HOLD_REASONS,
};
