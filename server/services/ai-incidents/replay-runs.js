/**
 * Replay runs for the correction loop (scope 2026-10-02 piece 3; owner ruling
 * 2026-10-02: no provider call). The lane exports a proposal's frozen cases,
 * Claude Code subagents re-draft and grade them against the candidate fix,
 * and the verdicts come back through recordReplayRun. Nothing here calls a
 * model, and nothing writes message_drafts.
 *
 *   exportCases       — the frozen evidence for one split of one proposal
 *                       (customer text: the caller writes it OUTSIDE the repo).
 *                       The holdout is exported only after the proposal's
 *                       current dev run passed on the same code and version.
 *   recordReplayRun   — validates the verdicts against the proposal's split,
 *                       computes the run status, stores run + results and
 *                       stamps the proposal's dev_run_id / holdout_run_id.
 *                       A fix's holdout run needs a PASSED dev run on the
 *                       same code and version; a recurrence check (dev
 *                       only) needs none and never stamps the proposal.
 *   carryForward      — after a prompt-version bump, a recurrence check on
 *                       the dev cases of the new version that still reproduces the mistake carries the
 *                       proposal (and its count) to the new version (owner
 *                       ruling Q2: count across bumps only when a replay still
 *                       reproduces).
 */

const { transitionProposal, TransitionError, OPEN_STATUSES } = require('./fix-proposals');
const { GRATITUDE_INTENT, buildGratitudeReply } = require('../sms-gratitude');

const SPLITS = Object.freeze(['dev', 'holdout']);
const METHODS = Object.freeze(['subagent', 'code']);
const PURPOSES = Object.freeze(['fix', 'recurrence']);
const RUN_STATUSES = Object.freeze(['passed', 'failed', 'inconclusive', 'underpowered']);
const VERDICTS = Object.freeze(['fixed', 'reproduces', 'inconclusive']);
// A single re-draft can reproduce only a failure that lives in the prompt
// wording itself. A facts-block gap is fixed by a NEW fact the frozen facts
// can never contain (a past draft's context is not stored, so the block
// cannot be rebuilt), a few-shot leak needs the exemplars the drafter was
// shown, and a verifier miss needs the verify/revise loop. Those cells are
// proven by their fix's fixture test and by new incidents after it ships.
const REPLAYABLE_SURFACES = Object.freeze(['prompt_discipline', 'other']);
// What every replay leaves out, printed on each exported case.
const REPLAY_OMITS = Object.freeze(['few_shot_exemplars', 'verify_revise_loop', 'thread_mixed_hint']);
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

// Exported cases leave the database for the lane's scratchpad, so they
// carry no customer identifiers (ops/agents artifact rule): the customer's
// own names, then the shared corpus redactors (emails, phones, addresses,
// cards, links, access codes), then invoice and order references.
function scrubCaseText(text, customer) {
  const { redactText } = require('../agent-decision-training');
  const { redact: redactPii } = require('../content/pii-redactor');
  const { redactAccessCodes } = require('../context-aggregator');
  let out = String(text || '');
  for (const value of [customer?.first_name, customer?.last_name]) {
    const name = String(value || '').trim();
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu'), '[name]');
  }
  out = redactAccessCodes(redactPii(redactText(out, { customer })).text);
  return out
    .replace(/\b(invoice|receipt|order|inv)\b(\s*(?:#|no\.?|number)?\s*:?\s*)[A-Z]*-?\d[A-Z0-9-]*/gi, '$1$2[ref]')
    .replace(/\b[A-Z]{2,5}-\d[\d-]*\b/g, '[ref]')
    .replace(/#\s?\d{3,}\b/g, '#[ref]');
}

/**
 * One case per incident in the split: the draft as produced, the facts it was
 * given, the customer's text, the person's reply and what the two readers
 * quoted. SMS only (the area whose incident_key is a message_drafts id).
 */
async function exportCases({ dbi, proposalId, split, codeRef = null, promptVersion = null }) {
  if (!SPLITS.includes(split)) throw new TransitionError('bad_split', `split must be ${SPLITS.join(' or ')}`);
  const proposal = await dbi('ai_fix_proposals').where({ id: proposalId }).first();
  if (!proposal) throw new TransitionError('not_found', `no proposal ${proposalId}`);
  if (proposal.area !== 'sms') throw new TransitionError('unsupported_area', `export supports sms only, not ${proposal.area}`);
  if (!REPLAYABLE_SURFACES.includes(proposal.surface)) {
    throw new TransitionError('unsupported_surface', `${proposal.surface} cannot be replayed from frozen inputs (a new fact, the exemplars or the verify loop are not in them): prove the fix with its fixture test and new incidents after it ships`);
  }
  // Held-out cases are revealed only to prove a candidate that already
  // passed its dev cases on this code and version; before that, seeing them
  // would let the fix be tuned against its own proof.
  if (split === 'holdout') await assertCurrentDevPassed(dbi, proposal, codeRef, promptVersion);
  const keys = splitKeys(proposal, split);
  if (!keys.length) return { proposal, cases: [], missing: [] };
  const rows = await dbi({ i: 'ai_incidents' })
    .join({ md: 'message_drafts' }, dbi.raw('md.id::text'), 'i.incident_key')
    .leftJoin({ c: 'customers' }, 'c.id', 'md.customer_id')
    .leftJoin({ j: 'shadow_draft_judgments' }, function judgmentJoin() {
      this.on(dbi.raw('j.id::text'), '=', 'i.evidence_id').andOn('i.evidence_type', '=', dbi.raw('?', ['judgment']));
    })
    .where({ 'i.area': 'sms', 'i.surface': proposal.surface, 'i.failure_mode': proposal.failure_mode, 'i.disposition': 'confirmed_mistake' })
    .whereIn('i.incident_key', keys)
    .orderBy('i.adjudicated_at', 'asc')
    .select(
      'i.incident_key', 'i.prompt_version', 'i.produced_at', 'i.summary', 'i.adjudication',
      'md.inbound_message', 'md.draft_response', 'md.facts_block', 'md.intent', 'md.scheduling_intent',
      'c.first_name', 'c.last_name',
      dbi.raw("md.intended_actions::jsonb ->> 'voice_profile_version' as voice_profile_version"),
      'j.human_reply_text', 'j.intent as judge_intent'
    );
  const seen = new Set();
  const cases = [];
  for (const r of rows) {
    if (seen.has(r.incident_key)) continue;
    seen.add(r.incident_key);
    const customer = { first_name: r.first_name, last_name: r.last_name };
    const scrub = (t) => (t == null ? null : scrubCaseText(t, customer));
    // The first reader's verified quote, as adjudication stores it.
    const quotes = [r.adjudication?.model?.quote].filter(Boolean).map(scrub);
    // A gratitude draft was prompted with the reply production approved for
    // this customer by name: rebuilt the same way, then scrubbed like the rest.
    const intentName = r.intent || r.judge_intent || null;
    const approvedReply = intentName === GRATITUDE_INTENT
      ? scrub(buildGratitudeReply(r.first_name)) : null;
    cases.push({
      incident_key: r.incident_key,
      split,
      cell: { surface: proposal.surface, failure_mode: proposal.failure_mode },
      prompt_version: r.prompt_version,
      produced_at: r.produced_at,
      // The drafter's own classification, as the production prompt saw it.
      intent: intentName,
      approved_reply: approvedReply,
      scheduling_intent: r.scheduling_intent === true,
      // The owner-approved voice profile that shaped the draft (null = base).
      voice_profile_version: r.voice_profile_version == null ? null : Number(r.voice_profile_version),
      replay_omits: [...REPLAY_OMITS],
      inbound_message: scrub(r.inbound_message),
      facts_block: scrub(r.facts_block),
      draft_as_produced: scrub(r.draft_response),
      human_reply: scrub(r.human_reply_text),
      unsupported_quotes: quotes,
      summary: scrub(r.summary),
    });
  }
  return { proposal, cases, missing: keys.filter((k) => !seen.has(k)) };
}

/**
 * The candidate must clear its dev cases before its holdout: the proposal's
 * CURRENT dev run (a later failed run, a new candidate, or a closed or
 * replaced PR replaces or clears it) must have passed on the same code AND
 * prompt version (gates change the prompt without a commit).
 */
async function assertCurrentDevPassed(trx, proposal, codeRef, promptVersion) {
  const dev = proposal.dev_run_id ? await trx('ai_replay_runs').where({ id: proposal.dev_run_id }).first() : null;
  const matches = dev
    && dev.proposal_id === proposal.id && dev.split === 'dev' && dev.purpose === 'fix'
    && dev.status === 'passed' && dev.code_ref === codeRef && (dev.prompt_version ?? null) === (promptVersion ?? null);
  if (!matches) throw new TransitionError('dev_not_passed', "a holdout run needs the proposal's current dev run passed on the same code_ref and prompt version");
}

/**
 * Store one replay run. `results` = [{ incident_key, verdict, reason?, evidence? }].
 * Every key must belong to the proposal's split; a key of the split with no
 * result is stored as inconclusive ('not_run'). Returns { run, results }.
 */
async function recordReplayRun({
  dbi, proposalId, split, method, purpose = 'fix', codeRef, promptVersion = null, drafterModel = null, notes = null, results, by, dryRun = false,
}) {
  if (!PURPOSES.includes(purpose)) throw new TransitionError('bad_purpose', `purpose must be ${PURPOSES.join(' or ')}`);
  if (!SPLITS.includes(split)) throw new TransitionError('bad_split', `split must be ${SPLITS.join(' or ')}`);
  if (!METHODS.includes(method)) throw new TransitionError('bad_method', `method must be ${METHODS.join(' or ')}`);
  if (!codeRef || !/^[0-9a-f]{7,64}$/i.test(codeRef)) throw new TransitionError('bad_code_ref', 'code_ref must be the git sha the replay ran');
  if (!by) throw new TransitionError('by_required', 'say who recorded the run (by)');
  if (!Array.isArray(results)) throw new TransitionError('bad_results', 'results must be a list');

  return dbi.transaction(async (trx) => {
    const proposal = await trx('ai_fix_proposals').where({ id: proposalId }).forUpdate().first();
    if (!proposal) throw new TransitionError('not_found', `no proposal ${proposalId}`);
    // A closed proposal's proof is history: a result exported while it was
    // open and recorded after it shipped, was dismissed or superseded never
    // rewrites it.
    if (!OPEN_STATUSES.includes(proposal.status)) {
      throw new TransitionError('proposal_closed', `the proposal is ${proposal.status}; replays are recorded only on an open proposal`);
    }
    if (!REPLAYABLE_SURFACES.includes(proposal.surface)) {
      throw new TransitionError('unsupported_surface', `${proposal.surface} cannot be replayed from frozen inputs`);
    }
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

    // The holdout stays sealed until a fix candidate has passed dev, so a
    // recurrence check (is the mistake still happening on a newer version?)
    // replays the dev cases.
    if (purpose === 'recurrence' && split !== 'dev') {
      throw new TransitionError('needs_dev', 'a recurrence check replays the dev cases; the holdout is sealed for fix proof');
    }
    if (purpose === 'fix' && split === 'holdout') {
      await assertCurrentDevPassed(trx, proposal, codeRef, promptVersion);
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
      purpose,
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
    // Only a fix run is the proposal's proof; a recurrence check is evidence
    // for carryForward and never replaces it.
    // A new dev run is a new candidate (or a re-check of it): the holdout
    // proof of whatever came before no longer applies.
    if (purpose === 'fix') {
      const fields = split === 'dev' ? { dev_run_id: stored.id, holdout_run_id: null } : { holdout_run_id: stored.id };
      await transitionProposal({ dbi: trx, id: proposalId, fields, by });
    }
    return { run: stored, results: rows };
  });
}

/**
 * Carry an open proposal to the live prompt version when a recurrence check
 * of its dev cases ON that version still reproduces the mistake: the old proposal is superseded
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
    if (run.purpose !== 'recurrence' || run.split !== 'dev') {
      throw new TransitionError('needs_recurrence_run', 'carrying forward needs a recurrence check (dev cases) on the new version');
    }
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
      proposal: `Carried from ${String(old.id).slice(0, 8)} (${old.prompt_version || 'unversioned'}): recurrence check ${String(run.id).slice(0, 8)} on ${promptVersion} still reproduced ${run.reproduces_count} of ${run.case_count}.\n\n${old.proposal}`,
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
  PURPOSES,
  RUN_STATUSES,
  VERDICTS,
  MIN_HOLDOUT_CASES,
  REPLAYABLE_SURFACES,
  REPLAY_OMITS,
  runStatus,
  scrubCaseText,
  exportCases,
  recordReplayRun,
  carryForward,
};
