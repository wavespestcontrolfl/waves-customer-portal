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
  if (!row || row.satisfied_at) return null;
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
async function beginSubmission(db, { prospectId, leaseToken, citation }) {
  if (!citation || typeof citation.website !== 'string' || !citation.website || typeof citation.location !== 'string' || !citation.location) return false;
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
      .update({ outcome: 'submitting', slot_day: etDateString(now), detail: { ...slot.detail, execution_revision: Number(path.revision_execution), submitted_at: now.toISOString(), citation: { website: citation.website, location: citation.location } }, updated_at: now }));
  });
}

async function releaseSlots(trx, ids, now = new Date()) {
  if (!ids.length) return;
  await trx(ATTEMPTS).whereIn('prospect_id', ids).where({ outcome: 'slot_reserved' }).update({ outcome: 'slot_released', updated_at: now });
  // A worker disappeared after crossing the mutation boundary. Preserve the slot and prohibit a retry.
  await trx(ATTEMPTS).whereIn('prospect_id', ids).where({ outcome: 'submitting' }).update({ outcome: 'submit_ambiguous', updated_at: now });
}

// The existing owner board status edit confirms placement truth and settles its held execution in the same transaction.
async function reconcileOwnerPlacement(trx, { prospectId, status, attemptId = null, liveUrl = null, targetPage = null, notSubmitted = false, actorId = null, now = new Date() }) {
  if (!notSubmitted && !['placed', 'live', 'indexed'].includes(status)) return { ok: false, error: 'A confirmed placement status is required' };
  const prospect = await trx('seo_link_prospects').where({ id: prospectId }).forUpdate().first();
  if (!prospect || prospect.claimed_at) return { ok: false, error: 'Submission is still leased; retry after it settles' };
  const held = await trx(ATTEMPTS).where({ prospect_id: prospectId, action: 'submit', outcome: 'submit_ambiguous' }).forUpdate();
  if ((held.length || attemptId) && (held.length !== 1 || held[0].id !== attemptId)) return { ok: false, error: 'Held submission changed; reload before recording a verdict' };
  if (!held.length) return { ok: true };
  if (status === 'placed' && ['live', 'indexed'].includes(prospect.status)) status = prospect.status;
  const attempt = held[0];
  const detail = attempt.detail || {};
  const authorities = await trx(AUTH).where({ prospect_id: prospectId, dimension: 'execution', instance_kind: '-' }).forUpdate();
  if (attempt.path_id !== prospect.path_id || !authorities.some((r) => r.id === detail.authority_id && r.path_id === attempt.path_id)) {
    return { ok: false, error: 'Held submission no longer matches this acquisition path; review its original authority' };
  }
  if (notSubmitted) {
    await trx(ATTEMPTS).where({ id: attempt.id }).update({ outcome: 'slot_released', idempotency_key: null, detail: { ...detail, owner_verdict: 'not_submitted', owner_confirmed_at: now.toISOString() }, updated_at: now });
    await trx('seo_link_prospects').where({ id: prospectId }).update({
      ...(prospect.automation_policy === 'skip' && ['submit_rejected', 'submit_blocked'].includes(detail.error_code)
        ? { automation_policy: null, last_classified_at: null } : {}), updated_at: now });
    await require('../audit-log').recordAuditEvent({ actor_type: 'technician', actor_id: actorId, action: 'backlink.submission.not_submitted', resource_type: 'seo_link_prospect', resource_id: prospectId, metadata: { attempt_id: attempt.id }, critical: true, trx });
    return { ok: true };
  }
  const { canonicalProspectDomain, locationKeyOf, findPlacementRow } = require('./prospect-domain-lock');
  if (!URL.canParse(liveUrl)) return { ok: false, error: 'A confirmed publisher URL is required' };
  const publisher = new URL(liveUrl);
  if (!['http:', 'https:'].includes(publisher.protocol) || publisher.username || publisher.password
    || canonicalProspectDomain(publisher.hostname) !== canonicalProspectDomain(prospect.target_domain)) {
    return { ok: false, error: 'Confirmed URL must belong to this publisher' };
  }
  if (['live', 'indexed'].includes(prospect.status) && liveUrl !== prospect.live_url) {
    return { ok: false, error: 'This placement has a verified publisher URL; use that existing URL to confirm the held submission' };
  }
  // Only the attempt snapshot establishes what reached the publisher; board fields can change during a hold.
  const citation = detail.citation;
  if (!citation?.website || !citation?.location) return { ok: false, error: 'Submission identity is unavailable; verify the original citation before confirming placement' };
  const path = await trx('seo_link_acquisition_paths').where({ id: attempt.path_id }).forUpdate().first();
  const revision = detail.execution_revision;
  const settled = authorities.filter((r) => r.path_id === attempt.path_id && (r.id === detail.authority_id || !r.ended_at));
  // The bridge can rewrite the same authority id in place; check the attempt against both the live path and its rows.
  if (!Number.isSafeInteger(revision) || revision < 1 || Number(path?.revision_execution) !== revision
    || settled.some((r) => Number(r.path_revision) !== revision)) {
    return { ok: false, error: 'Submission execution revision is unavailable or changed; review the original attempt before confirming placement' };
  }
  const taken = await findPlacementRow(trx, prospect.target_domain, targetPage ?? prospect.target_page, { excludeId: prospectId, location: citation.location });
  if (taken) return { ok: false, error: 'Another placement already represents this publisher, target page and submission location; reconcile that placement before confirming' };
  // Old holds predate the boundary timestamp; their lease still bounds submission freshness.
  const submittedAt = new Date(detail.submitted_at || attempt.lease_token || attempt.created_at);
  if (!Number.isFinite(submittedAt.getTime())) return { ok: false, error: 'Submission time is unavailable; verify the original attempt before confirming placement' };
  const quality = typeof prospect.quality_signals === 'string' ? JSON.parse(prospect.quality_signals) : (prospect.quality_signals || {});
  await trx('seo_link_prospects').where({ id: prospectId }).update({ target_page: targetPage ?? prospect.target_page, quality_signals: { ...quality, cited_homepage: true, submitted_at: submittedAt.toISOString(), submitted_website: citation.website, location: citation.location }, location_key: locationKeyOf(citation.location), updated_at: now });
  await trx(ATTEMPTS).where({ id: attempt.id }).update({ outcome: 'placed', detail: { ...detail, citation, submitted_at: submittedAt.toISOString(), owner_confirmed_at: now.toISOString() }, updated_at: now });
  // Only decisions for the submitted execution revision can be satisfied by this attempt.
  await trx(AUTH).whereIn('id', settled.map((r) => r.id)).whereNull('satisfied_at').update({ satisfied_at: now, satisfied_reason: 'placed', updated_at: now });
  if (detail.approval_id) await trx('seo_link_approvals').where({ id: detail.approval_id, prospect_id: prospectId, dimension: 'execution', action: 'acquire' }).whereNull('consumed_at').update({ consumed_at: now, updated_at: now });
  await require('../audit-log').recordAuditEvent({ actor_type: 'technician', actor_id: actorId, action: 'backlink.submission.confirm', resource_type: 'seo_link_prospect', resource_id: prospectId, metadata: { attempt_ids: [attempt.id], status }, critical: true, trx });
  return { ok: true, status };
}

module.exports = { authorize, reserveSlot, beginSubmission, releaseSlots, freePath, reconcileOwnerPlacement };
