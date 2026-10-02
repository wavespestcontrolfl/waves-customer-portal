/**
 * Fix tracking for the correction loop (scope 2026-10-02, piece 2).
 *
 * A proposal names one recurring mistake (a cell: area × surface × failure
 * mode, on one prompt version) and the confirmed incidents behind it, then
 * follows the fix: the PR that carries it, the commit Codex reviewed clean,
 * the replay runs that proved it, the version it shipped in, and a revert.
 *
 *   proposeFromIncidents — weekly. Counts DISTINCT confirmed incidents per
 *     cell (ai_incidents, two-model rule) adjudicated since the cell's last
 *     proposal on the same version; a cell at the threshold gets one pending
 *     proposal with its dev/holdout split. No model call and no bell: the
 *     thinking step is the Monday correction-loop lane (terminal cockpit
 *     ruling 10-02), which reads these rows.
 *   transitionProposal — the only writer of status and stamps after insert.
 *     Legal moves are TRANSITIONS; each status requires its stamps (also a
 *     CHECK in the migration); every change appends to `history`; the update
 *     is a compare-and-set on the status read, so two lanes cannot both move
 *     a proposal.
 */

const crypto = require('crypto');
const logger = require('../logger');

// Closed lists; the migration's CHECKs and one-open index carry the same
// values (a test pins them equal).
const STATUSES = Object.freeze(['pending', 'accepted', 'pr_open', 'shipped', 'reverted', 'dismissed', 'superseded', 'insufficient_evidence']);
const FIX_KINDS = Object.freeze(['facts', 'prompt', 'tool', 'verifier']);
const OPEN_STATUSES = Object.freeze(['pending', 'accepted', 'pr_open']);

const SCHEMA_VERSION = 'ai-fix-proposals.v1';

// Where each SMS surface's fix lives. The surface says which harness piece
// failed, which is also where the change goes and which proof it needs.
const SMS_FIX_KIND_BY_SURFACE = Object.freeze({
  facts_block_gap: 'facts',
  prompt_discipline: 'prompt',
  verifier_miss: 'verifier',
  few_shot_leak: 'prompt',
  other: 'prompt',
});

function fixKindFor(area, surface) {
  if (area === 'sms') return SMS_FIX_KIND_BY_SURFACE[surface] || 'prompt';
  return 'prompt';
}

// to-status → the from-statuses it can be reached from.
const TRANSITIONS = Object.freeze({
  accepted: ['pending', 'pr_open'], // pr_open → accepted: the PR closed unmerged, the lane starts over
  pr_open: ['pending', 'accepted'],
  shipped: ['pr_open'],
  reverted: ['shipped'],
  dismissed: ['pending', 'accepted', 'pr_open'],
  superseded: ['pending', 'accepted'],
  insufficient_evidence: ['pending', 'accepted'],
});

// Stamps a status requires once it is set (the migration's CHECK holds the
// same rule for the row; this names the missing field before the write).
const REQUIRED_STAMPS = Object.freeze({
  pr_open: ['pr_number'],
  shipped: ['pr_number', 'reviewed_commit', 'shipped_version'],
  reverted: ['revert_pr_number'],
});

// Evidence tied to one PR: cleared when that PR is closed or replaced.
const PR_EVIDENCE = Object.freeze(['pr_url', 'reviewed_commit', 'dev_run_id', 'holdout_run_id']);

// Fields a caller may stamp, with or without a status change.
const STAMPABLE = Object.freeze(['pr_number', 'pr_url', 'reviewed_commit', 'dev_run_id', 'holdout_run_id', 'shipped_version', 'revert_pr_number']);

/**
 * Dev / holdout, fixed per incident: about one incident in three is held
 * out, chosen by a hash of (area, incident_key). Stable on purpose — a
 * carried-forward or re-proposed cell puts each incident on the same side it
 * was on before, so a case once used to build a fix never becomes its proof.
 */
function splitDevHoldout(area, incidentKeys) {
  const dev = [];
  const holdout = [];
  for (const key of incidentKeys) {
    const h = crypto.createHash('sha256').update(`${area}|${key}`).digest();
    (h.readUInt32BE(0) % 3 === 0 ? holdout : dev).push(key);
  }
  return { dev, holdout };
}

// One confirmed summary per dev incident key, read from the ledger row IN
// THIS CELL and version (one draft can be confirmed in several cells; a
// billing summary must never describe a schedule proposal).
async function devSummaries(dbi, { area, surface, failureMode, promptVersion }, devKeys) {
  if (!devKeys.length) return [];
  const rows = await dbi('ai_incidents')
    .where({ area, surface, failure_mode: failureMode, disposition: 'confirmed_mistake' })
    .modify((q) => (promptVersion == null ? q.whereNull('prompt_version') : q.where('prompt_version', promptVersion)))
    .whereIn('incident_key', devKeys)
    .orderBy('adjudicated_at', 'asc')
    .select('incident_key', 'summary');
  const byKey = new Map();
  for (const r of rows) if (!byKey.has(r.incident_key)) byKey.set(r.incident_key, r);
  return devKeys.map((k) => byKey.get(k) || { incident_key: k, summary: null });
}

/**
 * The text the fix lane reads. Only DEV incidents are described: a held-out
 * incident is counted, never summarized, so the fix is built without seeing
 * the cases that will judge it.
 */
function buildProposalText({ area, surface, failureMode, fixKind, promptVersion, total, carried = 0, holdoutCount, devIncidents }) {
  const lines = [
    `${total} confirmed ${area} incidents in ${surface} / ${failureMode} on ${promptVersion || 'an unversioned prompt'}`
      + (carried ? ` (${carried} carried from the proposal this supersedes, ${total - carried} new).` : '.'),
    `Fix kind: ${fixKind}. Confirmed by two models on different providers. ${holdoutCount} held out for proof and not described here.`,
    'Dev incidents (model-written summaries, no names):',
    ...devIncidents.slice(0, 10).map((i) => `- ${String(i.incident_key).slice(0, 8)}: ${String(i.summary || '(no summary)').replace(/\s+/g, ' ').slice(0, 240)}`),
  ];
  if (devIncidents.length > 10) lines.push(`- … and ${devIncidents.length - 10} more`);
  return lines.join('\n');
}

/**
 * Weekly proposer. `promptVersion` is the version the fix is FOR: evidence on
 * any other version neither counts nor moves this cell's watermark (counting
 * across a version bump needs a replay showing the failure still reproduces;
 * that carry-forward arrives with the replay runner).
 *
 * A cell whose open proposal is pending is refreshed: the new row
 * `supersedes` the old one in one transaction and, when both are on the same
 * version, carries the old incidents beside the fresh ones. A cell whose fix is accepted or has a PR open is left alone —
 * a lane is working on it, and its fresh incidents stay counted for after.
 */
async function proposeFromIncidents({ dbi, area, promptVersion, minEvidence = 5, maxCells = 3, now = new Date() } = {}) {
  if (!dbi) throw new Error('proposeFromIncidents: dbi required');
  if (!area) throw new Error('proposeFromIncidents: area required');
  const startedAt = Date.now();
  if (!(maxCells > 0)) return { proposed: 0, skippedOpen: 0, eligibleCells: 0, skipped: 'max_cells_zero', ms: 0 };
  // The evidence window closes before anything is read; it is stored as the
  // watermark the next run counts from, so an incident adjudicated mid-run
  // lands in the next window, never in neither.
  const cutoff = now;

  const cells = await dbi({ i: 'ai_incidents' })
    .leftJoin(
      dbi('ai_fix_proposals')
        .where({ area })
        .modify((q) => (promptVersion == null ? q.whereNull('prompt_version') : q.where('prompt_version', promptVersion)))
        .groupBy('surface', 'failure_mode')
        .select('surface', 'failure_mode')
        .max('evidence_cutoff_at as last_cutoff')
        .as('p'),
      function cellJoin() {
        this.on('p.surface', 'i.surface').andOn('p.failure_mode', 'i.failure_mode');
      }
    )
    .where('i.area', area)
    .where('i.disposition', 'confirmed_mistake')
    .modify((q) => (promptVersion == null ? q.whereNull('i.prompt_version') : q.where('i.prompt_version', promptVersion)))
    .where('i.adjudicated_at', '<=', cutoff)
    .whereRaw('(p.last_cutoff IS NULL OR i.adjudicated_at > p.last_cutoff)')
    .groupBy('i.surface', 'i.failure_mode')
    .select('i.surface', 'i.failure_mode')
    .countDistinct('i.incident_key as fresh')
    .select(dbi.raw('MAX(p.last_cutoff) as last_cutoff'))
    .orderBy('fresh', 'desc');

  // Cells whose fix is already accepted or in a PR are dropped BEFORE the
  // weekly cap, so busy cells never take every slot from the rest.
  const inProgress = new Set((await dbi('ai_fix_proposals')
    .where({ area })
    .whereIn('status', OPEN_STATUSES.filter((st) => st !== 'pending'))
    .select('surface', 'failure_mode'))
    .map((r) => `${r.surface}|${r.failure_mode}`));
  const ready = cells.filter((c) => Number(c.fresh) >= minEvidence);
  const skippedOpen = ready.filter((c) => inProgress.has(`${c.surface}|${c.failure_mode}`)).length;
  const eligible = ready.filter((c) => !inProgress.has(`${c.surface}|${c.failure_mode}`)).slice(0, maxCells);
  let proposed = 0;
  let lostRace = 0;
  for (const cell of eligible) {
    try {
      const incidents = await dbi('ai_incidents')
        .where({ area, surface: cell.surface, failure_mode: cell.failure_mode, disposition: 'confirmed_mistake' })
        .modify((q) => (promptVersion == null ? q.whereNull('prompt_version') : q.where('prompt_version', promptVersion)))
        .where('adjudicated_at', '<=', cutoff)
        .modify((q) => { if (cell.last_cutoff) q.where('adjudicated_at', '>', cell.last_cutoff); })
        .orderBy('adjudicated_at', 'asc')
        .select('incident_key');

      const inserted = await dbi.transaction(async (trx) => {
        const open = await trx('ai_fix_proposals')
          .where({ area, surface: cell.surface, failure_mode: cell.failure_mode })
          .whereIn('status', OPEN_STATUSES)
          .forUpdate()
          .first();
        if (open && open.status !== 'pending') return null;

        // Carry the open proposal's incidents only on the SAME version: an
        // older version's pending proposal is closed, never counted forward
        // (that needs a replay showing the failure still reproduces).
        const sameVersion = open && (open.prompt_version ?? null) === (promptVersion ?? null);
        const carried = sameVersion ? (open.incident_keys || []) : [];
        const seen = new Set(carried);
        const all = [...carried];
        const fresh = [];
        for (const i of incidents) {
          if (seen.has(i.incident_key)) continue;
          seen.add(i.incident_key);
          all.push(i.incident_key);
          fresh.push(i);
        }
        const { dev, holdout } = splitDevHoldout(area, all);
        const fixKind = fixKindFor(area, cell.surface);
        const at = new Date();
        if (open) {
          await trx('ai_fix_proposals').where({ id: open.id, status: 'pending' }).update({
            status: 'superseded',
            updated_at: at,
            history: trx.raw('history || ?::jsonb', [JSON.stringify([{ at, by: 'auto:proposer', from: 'pending', to: 'superseded' }])]),
          });
        }
        const [row] = await trx('ai_fix_proposals').insert({
          area,
          surface: cell.surface,
          failure_mode: cell.failure_mode,
          fix_kind: fixKind,
          prompt_version: promptVersion ?? null,
          status: 'pending',
          evidence_count: all.length,
          incident_keys: JSON.stringify(all),
          dev_incident_keys: JSON.stringify(dev),
          holdout_incident_keys: JSON.stringify(holdout),
          evidence_cutoff_at: cutoff,
          proposal: buildProposalText({
            area,
            surface: cell.surface,
            failureMode: cell.failure_mode,
            fixKind,
            promptVersion,
            total: all.length,
            carried: carried.length,
            holdoutCount: holdout.length,
            devIncidents: await devSummaries(trx, { area, surface: cell.surface, failureMode: cell.failure_mode, promptVersion }, dev),
          }),
          supersedes: open ? open.id : null,
          history: JSON.stringify([{ at, by: 'auto:proposer', from: null, to: 'pending', fields: { evidence_count: all.length, fresh: fresh.length } }]),
          schema_version: SCHEMA_VERSION,
        }).returning(['id']);
        return row.id;
      });
      if (inserted) {
        proposed += 1;
        logger.info(`[fix-proposals] ${area} proposal ${String(inserted).slice(0, 8)} for ${cell.surface}/${cell.failure_mode} (${cell.fresh} fresh)`);
      } else {
        // A lane accepted the cell's proposal between the read above and
        // this transaction.
        lostRace += 1;
        logger.info(`[fix-proposals] ${area} ${cell.surface}/${cell.failure_mode} has a fix in progress; ${cell.fresh} fresh incidents wait`);
      }
    } catch (err) {
      logger.error(`[fix-proposals] ${area} proposer failed for ${cell.surface}/${cell.failure_mode}: ${err.message}`);
    }
  }
  if (skippedOpen) logger.info(`[fix-proposals] ${area}: ${skippedOpen} ready cell(s) have a fix in progress; their fresh incidents wait`);
  const summary = { proposed, skippedOpen: skippedOpen + lostRace, eligibleCells: eligible.length, ms: Date.now() - startedAt };
  logger.info(`[fix-proposals] ${area} propose run complete: ${JSON.stringify(summary)}`);
  return summary;
}

class TransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Review and replay evidence belongs to ONE PR. Closing the PR (pr_open →
 * accepted) or naming a different PR clears it, so a later PR can never ship
 * on an abandoned PR's clean review or replay runs. Returns the columns to
 * null out.
 */
function prEvidenceCleared(row, to, fields) {
  const closingPr = to === 'accepted' && row.status === 'pr_open';
  const replacingPr = fields.pr_number != null && row.pr_number != null && Number(fields.pr_number) !== Number(row.pr_number);
  if (closingPr && Object.keys(fields).some((k) => PR_EVIDENCE.includes(k) || k === 'pr_number')) {
    throw new TransitionError('illegal_transition', 'closing the PR (back to accepted) takes no PR stamps');
  }
  if (!closingPr && !replacingPr) return {};
  const cleared = {};
  for (const k of PR_EVIDENCE) if (!(k in fields)) cleared[k] = null;
  if (closingPr) cleared.pr_number = null;
  return cleared;
}

/**
 * Move a proposal and/or stamp it. `to` may be omitted to stamp only (a run
 * id, a PR URL). Refuses an illegal move, a missing required stamp, an
 * unknown field, and a lost race (the status changed since it was read).
 * Returns the updated row; `dryRun` runs every check and returns the row as
 * it would be, writing nothing.
 */
async function transitionProposal({ dbi, id, to, fields = {}, by, now = new Date(), dryRun = false }) {
  if (!dbi) throw new Error('transitionProposal: dbi required');
  if (!by) throw new TransitionError('by_required', 'say who is making the change (by)');
  const unknown = Object.keys(fields).filter((k) => !STAMPABLE.includes(k));
  if (unknown.length) throw new TransitionError('unknown_field', `not stampable: ${unknown.join(', ')}`);
  if (to != null && !STATUSES.includes(to)) throw new TransitionError('unknown_status', `unknown status: ${to}`);
  if (to === 'pending') throw new TransitionError('illegal_transition', 'only the proposer creates pending proposals');

  return dbi.transaction(async (trx) => {
    const row = await trx('ai_fix_proposals').where({ id }).forUpdate().first();
    if (!row) throw new TransitionError('not_found', `no proposal ${id}`);
    if (to != null && to !== row.status && !(TRANSITIONS[to] || []).includes(row.status)) {
      throw new TransitionError('illegal_transition', `${row.status} → ${to} is not allowed`);
    }
    const cleared = prEvidenceCleared(row, to, fields);
    const next = { ...row, ...cleared, ...fields };
    const target = to ?? row.status;
    const missing = (REQUIRED_STAMPS[target] || []).filter((k) => next[k] == null || next[k] === '');
    if (missing.length) throw new TransitionError('missing_stamp', `${target} needs ${missing.join(', ')}`);

    const patch = { ...cleared, ...fields, updated_at: now };
    if (to != null && to !== row.status) {
      patch.status = to;
      if (to === 'shipped') patch.shipped_at = now;
      if (to === 'reverted') patch.reverted_at = now;
    }
    const entry = { at: now, by, from: row.status, to: target, fields, ...(Object.keys(cleared).length ? { cleared: Object.keys(cleared) } : {}) };
    // Every check above has run; a dry run stops here and reports the change.
    if (dryRun) return { ...row, ...patch, history: [...(row.history || []), entry], dryRun: true };
    patch.history = trx.raw('history || ?::jsonb', [JSON.stringify([entry])]);
    const [updated] = await trx('ai_fix_proposals')
      .where({ id, status: row.status })
      .update(patch)
      .returning('*');
    if (!updated) throw new TransitionError('conflict', `proposal ${id} changed while it was being updated`);
    return updated;
  });
}

module.exports = {
  SCHEMA_VERSION,
  STATUSES,
  FIX_KINDS,
  OPEN_STATUSES,
  TRANSITIONS,
  REQUIRED_STAMPS,
  STAMPABLE,
  TransitionError,
  fixKindFor,
  splitDevHoldout,
  buildProposalText,
  proposeFromIncidents,
  transitionProposal,
};
