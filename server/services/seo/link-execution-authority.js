/** Free submission authority, shared by the worker lease and browser mutation boundary. */
const P = require('./link-authority-policy');
const { isEnabled } = require('../../config/feature-gates');
const { etDateString } = require('../../utils/datetime-et');
const { OUTREACH_ACQUISITION_TYPES } = require('./link-registry');

const AUTH = 'seo_link_placement_authorities';
const ATTEMPTS = 'seo_link_attempts';
const COUNTED = ['slot_reserved', 'submitting', 'submit_ambiguous', 'placed', 'pending'];

function freePath(path) {
  return path && path.account_required === false && path.email_verification === false
    && path.payment_required === false && path.legal_attestation === false
    && path.agent_completable === true && !path.baseline && !path.superseded_by;
}

async function authorize(trx, placement, path, provider, { lock = true } = {}) {
  if (['skip', 'needs_account', 'pay_and_submit'].includes(placement.automation_policy)) return null;
  if (['sending', 'send_error'].includes(placement.follow_up_status)) return null;
  if (![provider === 'deterministic_runner', isEnabled('linkAuthority'), isEnabled('signupRunner'), freePath(path)].every(Boolean)) return null;
  const domain = await trx('seo_link_domains').where({ id: placement.domain_id }).first();
  if (!domain) return null;
  if (![['ready_to_acquire', 'acquiring', 'acquired'].includes(domain.agent_state), domain.best_path_id === path.id].every(Boolean)) return null;
  const outreach = OUTREACH_ACQUISITION_TYPES.includes(path.acquisition_type);
  const sendFirst = outreach && !P.submitFirst(path);
  if (!(sendFirst ? ['contacted', 'negotiating'] : ['prospect']).includes(placement.status)) return null;
  const query = trx(AUTH).where({ prospect_id: placement.id, path_id: path.id }).whereNull('ended_at');
  const rows = await (lock ? query.forUpdate() : query);
  const row = rows.find((r) => r.dimension === 'execution' && r.instance_kind === '-');
  if (!row) return null;
  if (row.satisfied_at) return null;
  if (sendFirst && !rows.some((r) => [r.dimension === 'communication', r.instance_kind === '-', r.satisfied_at, r.satisfied_reason === 'sent'].every(Boolean))) return null;
  const { policy } = await P.loadPolicy(trx, { lock });
  if ((path.provider_override || policy.preferred_provider) !== provider) return null;
  const ctx = { path, domain, policy, score: domain.score, instanceKey: row.instance_key };
  if (row.decision_inputs_hash !== P.decisionInputsHash('execution', ctx) || Number(row.path_revision) !== Number(path.revision_execution)) return null;
  let waiver = null;
  if (row.floor_waiver_id) {
    const w = await trx('seo_link_floor_waivers').where({ id: row.floor_waiver_id, domain_id: domain.id, path_id: path.id }).whereNull('invalidated_at').first();
    if (!w || w.decision_inputs_hash !== P.floorInputsHash(ctx)) return null;
    waiver = { id: w.id };
  }
  const decided = P.decideAuthority({ ...ctx, waiver }).instances.find((r) => r.dimension === 'execution' && r.instance_kind === '-');
  if (!decided) return null;
  if (![decided.level === row.level, ['AUTO_FREE', 'OWNER_FREE', 'OWNER_MEMBERSHIP'].includes(row.level)].every(Boolean)) return null;
  let approval = null;
  if (row.level !== 'AUTO_FREE') {
    if (!row.approval_id) return null;
    approval = await trx('seo_link_approvals').where({ id: row.approval_id, prospect_id: placement.id, path_id: path.id,
      dimension: 'execution', action: 'acquire', instance_key: row.instance_key, authority: row.level,
      decision: 'approved', decision_inputs_hash: row.decision_inputs_hash, path_revision: row.path_revision })
      .whereNull('invalidated_at').whereNull('consumed_at').first();
    if (!approval) return null;
  }
  return { row, policy, approval };
}

async function slotAvailable(trx, policy, now, excludeId = null) {
  const day = etDateString(now);
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`link_submission_cap:${day}`]);
  let q = trx(ATTEMPTS).where({ slot_day: day, action: 'submit', sandbox: false }).whereIn('outcome', COUNTED);
  if (excludeId) q = q.whereNot('id', excludeId);
  const count = await q.count('* as n').first();
  return Number(policy.auto_submission_daily_cap) > Number(count.n);
}

async function reserveSlot(trx, placement, path, authority, leaseToken, now, preview = false, previewCount = 0) {
  // Uncertainty follows the placement even when investigation rotates its path/authority.
  if (await trx(ATTEMPTS).where({ prospect_id: placement.id, action: 'submit', outcome: 'submit_ambiguous' }).first()) return null;
  const key = `${placement.id}:submit:${authority.row.instance_key}`;
  const old = await trx(ATTEMPTS).where({ idempotency_key: key }).first();
  if (old && old.outcome !== 'slot_released') return null;
  if (!(await slotAvailable(trx, { ...authority.policy, auto_submission_daily_cap: authority.policy.auto_submission_daily_cap - previewCount }, now))) return null;
  if (preview) return { id: null };
  const patch = { outcome: 'slot_reserved', slot_day: etDateString(now), lease_token: leaseToken, path_id: path.id,
    detail: { authority_id: authority.row.id, approval_id: authority.approval?.id || null, instance_key: authority.row.instance_key }, updated_at: now };
  if (old) {
    await trx(ATTEMPTS).where({ id: old.id, outcome: 'slot_released' }).update(patch);
    return { ...old, ...patch };
  }
  const [slot] = await trx(ATTEMPTS).insert({ ...patch, prospect_id: placement.id,
    provider: 'deterministic_runner', action: 'submit', idempotency_key: key, sandbox: false,
    created_at: now }).returning('*');
  return slot;
}

// Runs immediately before the browser enables mutating requests. A replay cannot cross it twice.
async function beginSubmission(db, { prospectId, leaseToken }) {
  const { lockProspectDomain } = require('./prospect-domain-lock');
  const initial = await db('seo_link_prospects').where({ id: prospectId }).first();
  if (!initial) return false;
  return db.transaction(async (trx) => {
    await lockProspectDomain(trx, initial.target_domain);
    const placement = await trx('seo_link_prospects').where({ id: prospectId }).forUpdate().first();
    if (!placement || !placement.claimed_at || new Date(placement.claimed_at).toISOString() !== leaseToken || placement.lease_mode !== 'acquire') return false;
    if (Date.now() - new Date(placement.claimed_at).getTime() >= 6 * 3600 * 1000) return false;
    const path = await trx('seo_link_acquisition_paths').where({ id: placement.path_id }).forUpdate().first();
    const authority = await authorize(trx, placement, path, placement.leased_provider);
    if (!authority || Number(placement.leased_path_revision) !== Number(path.revision)) return false;
    const slot = await trx(ATTEMPTS).where({ prospect_id: prospectId, lease_token: leaseToken, outcome: 'slot_reserved', action: 'submit' }).first();
    if (!slot || !slot.detail || slot.detail.authority_id !== authority.row.id) return false;
    const now = new Date();
    if (!(await slotAvailable(trx, authority.policy, now, slot.id))) return false;
    return Boolean(await trx(ATTEMPTS).where({ id: slot.id, outcome: 'slot_reserved', lease_token: leaseToken })
      .update({ outcome: 'submitting', slot_day: etDateString(now), updated_at: now }));
  });
}

async function releaseSlots(trx, ids, now = new Date()) {
  if (!ids.length) return;
  await trx(ATTEMPTS).whereIn('prospect_id', ids).where({ outcome: 'slot_reserved' }).update({ outcome: 'slot_released', updated_at: now });
  // A worker disappeared after crossing the mutation boundary. Preserve the slot and prohibit a retry.
  await trx(ATTEMPTS).whereIn('prospect_id', ids).where({ outcome: 'submitting' }).update({ outcome: 'submit_ambiguous', updated_at: now });
}

module.exports = { authorize, reserveSlot, beginSubmission, releaseSlots, freePath };
