/**
 * Replay runs for the correction loop (scope 2026-10-02 piece 3; owner ruling
 * 2026-10-02: no provider call). The lane exports a proposal's frozen cases,
 * Claude Code subagents re-draft and grade them against the candidate fix,
 * and the verdicts come back through recordReplayRun. Nothing here calls a
 * model, and nothing writes message_drafts.
 *
 *   exportCases       — the frozen evidence for one split of one proposal
 *                       (customer text: the caller writes it OUTSIDE the repo).
 *   recordReplayRun   — validates the verdicts against the proposal's split,
 *                       computes the run status, stores run + results and
 *                       stamps the proposal's dev_run_id / holdout_run_id.
 *                       A holdout run needs a PASSED dev run on the same code.
 *   carryForward      — after a prompt-version bump, a holdout run on the new
 *                       version that still reproduces the mistake carries the
 *                       proposal (and its count) to the new version (owner
 *                       ruling Q2: count across bumps only when a replay still
 *                       reproduces).
 */

const { transitionProposal, TransitionError } = require('./fix-proposals');

const SPLITS = Object.freeze(['dev', 'holdout']);
const METHODS = Object.freeze(['subagent', 'code']);
const RUN_STATUSES = Object.freeze(['passed', 'failed', 'inconclusive', 'underpowered']);
const VERDICTS = Object.freeze(['fixed', 'reproduces', 'inconclusive']);
// A holdout run on fewer cases than this is labelled underpowered, never passed.
const MIN_HOLDOUT_CASES = 5;

/**
 * Any reproduction fails the run. Otherwise a run with an inconclusive case
 * (a timeout, a case that could not be judged, one not run) or no fixed case
 * at all is inconclusive, and a clean holdout under MIN_HOLDOUT_CASES is
 * underpowered. Inconclusive is never a pass.
 */
function runStatus({ split, fixed, reproduces, inconclusive }) {
  if (reproduces > 0) return 'failed';
  if (inconclusive > 0 || fixed === 0) return 'inconclusive';
  if (split === 'holdout' && fixed < MIN_HOLDOUT_CASES) return 'underpowered';
  return 'passed';
}

function splitKeys(proposal, split) {
  return split === 'dev' ? (proposal.dev_incident_keys || []) : (proposal.holdout_incident_keys || []);
}

/**
 * One case per incident in the split: the draft as produced, the facts it was
 * given, the customer's text, the person's reply and what the two readers
 * quoted. SMS only (the area whose incident_key is a message_drafts id).
 */
async function exportCases({ dbi, proposalId, split }) {
  if (!SPLITS.includes(split)) throw new TransitionError('bad_split', `split must be ${SPLITS.join(' or ')}`);
  const proposal = await dbi('ai_fix_proposals').where({ id: proposalId }).first();
  if (!proposal) throw new TransitionError('not_found', `no proposal ${proposalId}`);
  if (proposal.area !== 'sms') throw new TransitionError('unsupported_area', `export supports sms only, not ${proposal.area}`);
  const keys = splitKeys(proposal, split);
  if (!keys.length) return { proposal, cases: [] };
  const rows = await dbi({ i: 'ai_incidents' })
    .join({ md: 'message_drafts' }, dbi.raw('md.id::text'), 'i.incident_key')
    .leftJoin({ j: 'shadow_draft_judgments' }, function judgmentJoin() {
      this.on(dbi.raw('j.id::text'), '=', 'i.evidence_id').andOn('i.evidence_type', '=', dbi.raw('?', ['judgment']));
    })
    .where({ 'i.area': 'sms', 'i.surface': proposal.surface, 'i.failure_mode': proposal.failure_mode, 'i.disposition': 'confirmed_mistake' })
    .whereIn('i.incident_key', keys)
    .orderBy('i.adjudicated_at', 'asc')
    .select(
      'i.incident_key', 'i.prompt_version', 'i.produced_at', 'i.summary', 'i.adjudication',
      'md.inbound_message', 'md.draft_response', 'md.facts_block', 'j.human_reply_text', 'j.intent'
    );
  const seen = new Set();
  const cases = [];
  for (const r of rows) {
    if (seen.has(r.incident_key)) continue;
    seen.add(r.incident_key);
    const quotes = (r.adjudication?.readers || []).map((rd) => rd?.answer?.quote).filter(Boolean);
    cases.push({
      incident_key: r.incident_key,
      split,
      cell: { surface: proposal.surface, failure_mode: proposal.failure_mode },
      prompt_version: r.prompt_version,
      produced_at: r.produced_at,
      intent: r.intent || null,
      inbound_message: r.inbound_message,
      facts_block: r.facts_block,
      draft_as_produced: r.draft_response,
      human_reply: r.human_reply_text || null,
      unsupported_quotes: quotes,
      summary: r.summary,
    });
  }
  return { proposal, cases, missing: keys.filter((k) => !seen.has(k)) };
}

/**
 * Store one replay run. `results` = [{ incident_key, verdict, reason?, evidence? }].
 * Every key must belong to the proposal's split; a key of the split with no
 * result is stored as inconclusive ('not_run'). Returns { run, results }.
 */
async function recordReplayRun({
  dbi, proposalId, split, method, codeRef, promptVersion = null, drafterModel = null, notes = null, results, by, dryRun = false,
}) {
  if (!SPLITS.includes(split)) throw new TransitionError('bad_split', `split must be ${SPLITS.join(' or ')}`);
  if (!METHODS.includes(method)) throw new TransitionError('bad_method', `method must be ${METHODS.join(' or ')}`);
  if (!codeRef || !/^[0-9a-f]{7,64}$/i.test(codeRef)) throw new TransitionError('bad_code_ref', 'code_ref must be the git sha the replay ran');
  if (!by) throw new TransitionError('by_required', 'say who recorded the run (by)');
  if (!Array.isArray(results)) throw new TransitionError('bad_results', 'results must be a list');

  return dbi.transaction(async (trx) => {
    const proposal = await trx('ai_fix_proposals').where({ id: proposalId }).forUpdate().first();
    if (!proposal) throw new TransitionError('not_found', `no proposal ${proposalId}`);
    const keys = splitKeys(proposal, split);
    const inSplit = new Set(keys);
    const byKey = new Map();
    for (const r of results) {
      if (!inSplit.has(r.incident_key)) throw new TransitionError('not_in_split', `${String(r.incident_key).slice(0, 8)} is not a ${split} incident of this proposal`);
      if (byKey.has(r.incident_key)) throw new TransitionError('duplicate_result', `${String(r.incident_key).slice(0, 8)} has two results`);
      if (!VERDICTS.includes(r.verdict)) throw new TransitionError('bad_verdict', `verdict must be ${VERDICTS.join(', ')}`);
      byKey.set(r.incident_key, r);
    }
    if (!keys.length) throw new TransitionError('empty_split', `the proposal has no ${split} incidents`);

    if (split === 'holdout') {
      // The candidate must clear its dev cases first, on the same code.
      const dev = await trx('ai_replay_runs')
        .where({ proposal_id: proposalId, split: 'dev', status: 'passed', code_ref: codeRef })
        .first();
      if (!dev) throw new TransitionError('dev_not_passed', 'a holdout run needs a passed dev run on the same code_ref');
    }

    const rows = keys.map((k) => {
      const r = byKey.get(k);
      return r
        ? { incident_key: k, verdict: r.verdict, reason: r.reason ? String(r.reason).slice(0, 300) : null, evidence: JSON.stringify(r.evidence || {}) }
        : { incident_key: k, verdict: 'inconclusive', reason: 'not_run', evidence: '{}' };
    });
    const count = (v) => rows.filter((r) => r.verdict === v).length;
    const counts = { fixed: count('fixed'), reproduces: count('reproduces'), inconclusive: count('inconclusive') };
    const run = {
      area: proposal.area,
      proposal_id: proposalId,
      split,
      method,
      prompt_version: promptVersion,
      code_ref: codeRef,
      drafter_model: drafterModel,
      // Subagents are not the production drafter; a code check runs no model.
      exact_production_model: false,
      status: runStatus({ split, ...counts }),
      case_count: rows.length,
      fixed_count: counts.fixed,
      reproduces_count: counts.reproduces,
      inconclusive_count: counts.inconclusive,
      notes,
      created_by: by,
    };
    if (dryRun) return { run: { ...run, dryRun: true }, results: rows };

    const [stored] = await trx('ai_replay_runs').insert(run).returning('*');
    await trx('ai_replay_results').insert(rows.map((r) => ({ ...r, run_id: stored.id })));
    await transitionProposal({
      dbi: trx, id: proposalId, fields: { [split === 'dev' ? 'dev_run_id' : 'holdout_run_id']: stored.id }, by,
    });
    return { run: stored, results: rows };
  });
}

/**
 * Carry an open proposal to the live prompt version when a holdout replay ON
 * that version still reproduces the mistake: the old proposal is superseded
 * and a new pending one carries its incidents and split. A replay that no
 * longer reproduces is refused here — that fix shipped, and the lane closes
 * the proposal as shipped with the PR that fixed it.
 */
async function carryForward({ dbi, proposalId, runId, promptVersion, by, now = new Date(), dryRun = false }) {
  if (!promptVersion) throw new TransitionError('version_required', 'name the live prompt version to carry to');
  if (!by) throw new TransitionError('by_required', 'say who is carrying it (by)');
  return dbi.transaction(async (trx) => {
    const old = await trx('ai_fix_proposals').where({ id: proposalId }).forUpdate().first();
    if (!old) throw new TransitionError('not_found', `no proposal ${proposalId}`);
    if (!['pending', 'accepted'].includes(old.status)) throw new TransitionError('illegal_transition', `a ${old.status} proposal is not carried forward`);
    if ((old.prompt_version ?? null) === promptVersion) throw new TransitionError('same_version', 'the proposal is already on that version');
    const run = await trx('ai_replay_runs').where({ id: runId, proposal_id: proposalId }).first();
    if (!run) throw new TransitionError('not_found', `run ${runId} is not a run of this proposal`);
    if (run.split !== 'holdout') throw new TransitionError('needs_holdout', 'carrying forward needs a holdout run');
    if (run.prompt_version !== promptVersion) throw new TransitionError('wrong_version', `the run replayed ${run.prompt_version || 'no version'}, not ${promptVersion}`);
    if (run.reproduces_count === 0) {
      throw new TransitionError('no_longer_reproduces', 'the mistake no longer reproduces on this version: close the proposal as shipped with the PR that fixed it');
    }
    const next = {
      area: old.area,
      surface: old.surface,
      failure_mode: old.failure_mode,
      fix_kind: old.fix_kind,
      prompt_version: promptVersion,
      status: 'pending',
      evidence_count: old.evidence_count,
      incident_keys: JSON.stringify(old.incident_keys || []),
      dev_incident_keys: JSON.stringify(old.dev_incident_keys || []),
      holdout_incident_keys: JSON.stringify(old.holdout_incident_keys || []),
      // The watermark stays where the old proposal's evidence ended, so
      // incidents adjudicated since are still counted as fresh next week.
      evidence_cutoff_at: old.evidence_cutoff_at,
      proposal: `Carried from ${String(old.id).slice(0, 8)} (${old.prompt_version || 'unversioned'}): holdout replay ${String(run.id).slice(0, 8)} on ${promptVersion} still reproduced ${run.reproduces_count} of ${run.case_count}.\n\n${old.proposal}`,
      supersedes: old.id,
      history: JSON.stringify([{ at: now, by, from: null, to: 'pending', fields: { carried_from: old.id, run_id: run.id } }]),
    };
    if (dryRun) return { superseded: { ...old, status: 'superseded' }, carried: { ...next, dryRun: true } };
    const superseded = await transitionProposal({ dbi: trx, id: old.id, to: 'superseded', by, now });
    const [carried] = await trx('ai_fix_proposals').insert(next).returning('*');
    return { superseded, carried };
  });
}

module.exports = {
  SPLITS,
  METHODS,
  RUN_STATUSES,
  VERDICTS,
  MIN_HOLDOUT_CASES,
  runStatus,
  exportCases,
  recordReplayRun,
  carryForward,
};
