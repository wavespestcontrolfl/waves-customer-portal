/**
 * Backlink Manager v2 — the nightly `link-authority` bridge
 * (docs/design/backlink-manager-plan.md §6.3 "Bridge", §3.3b, §3.1; step 4 PR 2a).
 *
 * How an investigated domain becomes a stamped placement. Per run:
 *   (a) every `qualified` domain with a `best_path_id`, and
 *   (b) every domain owning an OPEN, UNSATISFIED authority row that is stale —
 *       decided before the policy / path / domain last changed, or whose
 *       placement still points at a superseded path —
 * each processed in ONE transaction under the shared per-domain lock
 * (prospect-domain-lock): choose the Waves page (homepage — see the note in
 * the plan), create the placement rows if missing (one per GBP location for a
 * signup lane, one unscoped row for an outreach lane), run the PURE §6.3
 * decision, write/refresh one authority row per required instance (a satisfied
 * instance is never re-decided; an approval whose frozen inputs no longer
 * match is invalidated), stamp the placement's display level, park an
 * owner-gated placement `awaiting_owner` (or release one a loosened policy no
 * longer gates), and recompute the domain's aggregate `agent_state`.
 *
 * Nothing here leases, sends or spends. The stamps are consumed by the claim
 * predicate re-check (PR 4); the Owner-queue cards (PR 2b) act on the parks.
 * The admin bell rings ONCE per run that parked anything (owner ruling
 * 2026-09-03), never per card.
 *
 * Gated by GATE_LINK_AUTHORITY inside the service: off ⇒ selection only, zero
 * writes (same convention as the investigator sweep). dryRun ⇒ the same.
 * Session lock 'link-authority-bridge' serializes runs.
 *
 * Inputs the later steps supply are pinned to their fail-closed values here:
 * monthSpendCents = 0 and d30Confidence = null (no purchases / D30 loop yet —
 * AUTO_PAID_WITHIN_POLICY cannot be granted), draftClean = false (the §6.4
 * classifier is PR 3 — AUTO_OUTREACH cannot be granted).
 */

const { isEnabled } = require('../../config/feature-gates');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { WAVES_LOCATIONS } = require('../../config/locations');
const { lockProspectDomain, findPlacementRow, targetPageOf } = require('./prospect-domain-lock');
const { OUTREACH_ACQUISITION_TYPES, LEVEL_SEVERITY } = require('./link-registry');
const { SIGNUP_LINK_TYPES } = require('./link-path-investigation-schema');
const P = require('./link-authority-policy');

const LOCK_KEY = 'link-authority-bridge';
const RUN_LIMIT_MAX = 500;
const DEFAULT_LIMIT = 50;
const AUTH = 'seo_link_placement_authorities';
const OWNER = 'link-authority';
// Every bridged placement targets the homepage: listing-style paths are the
// homepage by spec, and no topic is persisted on the registry domain yet for
// the scorer's topic → money-page mapping (deferred; noted in the plan).
const HOMEPAGE = targetPageOf('/');
// The aggregate states the bridge OWNS. `new`/`investigating`/`watching`/
// `not_reproducible`/`rejected` are set by intake, the investigator or the
// owner — the bridge re-decides their rows for honesty but never moves them.
const BRIDGE_STATES = Object.freeze(['qualified', 'ready_to_acquire', 'acquiring', 'acquired']);
// Placement statuses the bridge may move: prospect ⇄ awaiting_owner. Everything
// else (contacted/negotiating/placed/live/indexed/lost/rejected/watching) is
// Judge- or owner-owned history.
const PARKABLE = 'prospect';
const PARKED = 'awaiting_owner';

const isOwner = (l) => typeof l === 'string' && l.startsWith('OWNER_');
const isAuto = (l) => typeof l === 'string' && l.startsWith('AUTO_');
const severity = (l) => { const i = LEVEL_SEVERITY.indexOf(l); return i === -1 ? LEVEL_SEVERITY.length : i; };
const mostSevere = (levels) => levels.reduce((best, l) => (best === null || severity(l) < severity(best) ? l : best), null);
const ts = (v) => (v ? new Date(v).getTime() : 0);
const defaultExclusive = (key, fn) => require('../../utils/cron-lock').runExclusive(key, fn, { recordHealth: false });
const defaultNotify = (title, body, opts) => require('../notification-service').notifyAdmin('system', title, body, opts);

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
async function selectDomains(db, { domainIds, limit, policyUpdatedAt }) {
  // (a) freshly qualified
  let qa = db('seo_link_domains').where({ agent_state: 'qualified' }).whereNotNull('best_path_id');
  if (domainIds) qa = qa.whereIn('id', domainIds);
  const fresh = await qa.orderBy('updated_at', 'asc').limit(limit).select('id', 'domain');
  const picked = new Map(fresh.map((d) => [d.id, { id: d.id, domain: d.domain, why: 'qualified' }]));
  if (picked.size >= limit) return [...picked.values()].slice(0, limit);

  // (b) stale open rows — small tables, resolved in JS so the rule reads plainly
  const open = await db(AUTH).whereNull('ended_at').whereNull('satisfied_at').select('prospect_id', 'decided_at');
  if (!open.length) return [...picked.values()];
  const oldest = new Map();
  for (const r of open) oldest.set(r.prospect_id, Math.min(oldest.get(r.prospect_id) ?? Infinity, ts(r.decided_at)));
  const prospects = await db('seo_link_prospects').whereIn('id', [...oldest.keys()]).whereNotNull('domain_id').select('id', 'domain_id', 'path_id');
  const domIds = [...new Set(prospects.map((p) => p.domain_id))].filter((id) => !domainIds || domainIds.includes(id));
  if (!domIds.length) return [...picked.values()];
  const domains = await db('seo_link_domains').whereIn('id', domIds).whereNotNull('best_path_id').select('id', 'domain', 'best_path_id', 'updated_at');
  const paths = await db('seo_link_acquisition_paths').whereIn('id', [...new Set(prospects.map((p) => p.path_id).filter(Boolean))]).select('id', 'updated_at');
  const pathAt = new Map(paths.map((p) => [p.id, ts(p.updated_at)]));
  const byId = new Map(domains.map((d) => [d.id, d]));
  for (const p of prospects) {
    const d = byId.get(p.domain_id);
    if (!d || picked.has(d.id)) continue;
    const cutoff = Math.max(ts(policyUpdatedAt), ts(d.updated_at), pathAt.get(p.path_id) || 0);
    const stale = oldest.get(p.id) < cutoff || p.path_id !== d.best_path_id;
    if (stale) picked.set(d.id, { id: d.id, domain: d.domain, why: 'stale' });
    if (picked.size >= limit) break;
  }
  return [...picked.values()].slice(0, limit);
}

// ---------------------------------------------------------------------------
// One domain, one transaction
// ---------------------------------------------------------------------------
async function bridgeDomain(trx, { domainId, policy, policyUpdatedAt, now, out }) {
  const domain = await trx('seo_link_domains').where({ id: domainId }).forUpdate().first();
  if (!domain || !domain.best_path_id) return { skipped: 'no best path' };
  await lockProspectDomain(trx, domain.domain);
  const path = await trx('seo_link_acquisition_paths').where({ id: domain.best_path_id }).first();
  if (!path || path.superseded_by) return { skipped: 'best path superseded' };
  const ctx = { path, domain, policy, score: domain.score };
  const staleAfter = Math.max(ts(policyUpdatedAt), ts(domain.updated_at), ts(path.updated_at));

  // §6.3 1b — the latest waiver, honoured only for the exact floors the owner looked at
  let waiver = null;
  const waiverRow = await trx('seo_link_floor_waivers').where({ domain_id: domain.id, path_id: path.id }).whereNull('invalidated_at').orderBy('approved_at', 'desc').first();
  if (waiverRow) {
    if (waiverRow.decision_inputs_hash === P.floorInputsHash(ctx)) waiver = { id: waiverRow.id };
    else {
      await trx('seo_link_floor_waivers').where({ id: waiverRow.id }).update({ invalidated_at: now, invalidated_reason: 'floor inputs changed since the waiver', updated_at: now });
      out.invalidatedWaivers += 1;
    }
  }

  const decision = P.decideAuthority({ ...ctx, monthSpendCents: 0, d30Confidence: null, draftClean: false, waiver });
  const outreachPath = OUTREACH_ACQUISITION_TYPES.includes(path.acquisition_type);

  // placements: one per GBP location for a signup lane, one unscoped row otherwise
  const locations = SIGNUP_LINK_TYPES.includes(path.link_type) ? WAVES_LOCATIONS.map((l) => l.id) : ['-'];
  const placements = [];
  for (const location of locations) {
    let row = await findPlacementRow(trx, domain.domain, HOMEPAGE, { location, columns: ['*'] });
    if (!row) {
      const [created] = await trx('seo_link_prospects').insert({
        target_domain: domain.domain, target_page: HOMEPAGE, location_key: location,
        domain_id: domain.id, path_id: path.id, link_type: path.link_type,
        source: domain.source, source_detail: OWNER, owner: OWNER, status: PARKABLE,
        created_at: now, updated_at: now,
      }).returning('*');
      row = created;
      out.placementsCreated += 1;
    }
    placements.push(row);
  }

  // account_wide fee: every sibling shares one payment group anchored on the first placement
  if (path.payment_required && path.fee_scope === 'account_wide' && placements.length) {
    const groupId = (placements.find((p) => p.payment_group_id) || {}).payment_group_id || placements[0].id;
    for (const p of placements) {
      if (p.payment_group_id === groupId) continue;
      await trx('seo_link_prospects').where({ id: p.id }).update({ payment_group_id: groupId, updated_at: now });
      p.payment_group_id = groupId;
    }
  }

  const summaries = [];
  for (const placement of placements) {
    // supersession: the placement follows the domain's best path; its unsatisfied instances end
    if (placement.path_id !== path.id || placement.domain_id !== domain.id) {
      await trx('seo_link_prospects').where({ id: placement.id }).update({ path_id: path.id, domain_id: domain.id, updated_at: now });
      const ended = await trx(AUTH).where({ prospect_id: placement.id }).whereNull('ended_at').whereNull('satisfied_at').update({ ended_at: now, end_outcome: 'superseded', updated_at: now });
      out.ended += ended;
      placement.path_id = path.id;
    }
    // ALL rows, ended ones included: the full UNIQUE (prospect, dimension,
    // instance_key) keeps history, so a replacement instance takes the next
    // generation (`${kind}:${n+1}`, §3.3b) — never the ended row's key.
    const history = await trx(AUTH).where({ prospect_id: placement.id }).select('*');
    const open = history.filter((r) => !r.ended_at);
    const key = (r) => `${r.dimension}|${r.instance_kind}`;
    const nextGeneration = (inst) => 1 + history.filter((r) => key(r) === key(inst)).reduce((m, r) => Math.max(m, Number(String(r.instance_key).split(':').pop()) || 0), 0);
    const byKey = new Map(open.map((r) => [key(r), r]));
    const required = new Set(decision.instances.map(key));

    for (const inst of decision.instances) {
      const existing = byKey.get(key(inst));
      const hash = P.decisionInputsHash(inst.dimension, ctx);
      const pathRevision = path[`revision_${inst.dimension}`] ?? path.revision ?? 1;
      const floorWaiverId = waiver ? waiver.id : null;
      if (!existing) {
        const [row] = await trx(AUTH).insert({
          prospect_id: placement.id, dimension: inst.dimension, instance_kind: inst.instance_kind, instance_key: `${inst.instance_kind}:${nextGeneration(inst)}`,
          level: inst.level, reason: inst.reason, decision_inputs_hash: hash, path_revision: pathRevision,
          floor_waiver_id: floorWaiverId, decided_at: now, created_at: now, updated_at: now,
        }).returning('*');
        open.push(row);
        history.push(row);
        out.rowsWritten += 1;
        continue;
      }
      if (existing.satisfied_at) continue; // done — never re-decided
      const inputsMoved = existing.level !== inst.level || existing.decision_inputs_hash !== hash || Number(existing.path_revision) !== Number(pathRevision);
      const changed = inputsMoved || (existing.floor_waiver_id || null) !== floorWaiverId || existing.reason !== inst.reason;
      if (!changed && ts(existing.decided_at) >= staleAfter) continue;
      const patch = { level: inst.level, reason: inst.reason, decision_inputs_hash: hash, path_revision: pathRevision, floor_waiver_id: floorWaiverId, decided_at: now, updated_at: now };
      if (existing.approval_id && inputsMoved) {
        await trx('seo_link_approvals').where({ id: existing.approval_id }).whereNull('invalidated_at').update({ invalidated_at: now, invalidated_reason: `bridge: ${existing.level} → ${inst.level}, inputs re-decided`, updated_at: now });
        patch.approval_id = null;
        out.invalidatedApprovals += 1;
      }
      await trx(AUTH).where({ id: existing.id }).update(patch);
      Object.assign(existing, patch);
      if (changed) out.redecided += 1;
    }
    // instances the path no longer requires end (an unsatisfied one only)
    for (const r of open) {
      if (r.ended_at || r.satisfied_at || required.has(key(r))) continue;
      await trx(AUTH).where({ id: r.id }).update({ ended_at: now, end_outcome: 'superseded', updated_at: now });
      r.ended_at = now;
      out.ended += 1;
    }
    const live = open.filter((r) => !r.ended_at);

    // display stamp — the most restrictive open level
    const authority = mostSevere(live.map((r) => r.level));
    const patch = {};
    if (authority !== placement.authority) patch.authority = authority;

    // park / release — only the bridge's own statuses move
    const noDraft = !placement.outreach_status || placement.outreach_status === 'none';
    const gates = (r) => {
      if (r.satisfied_at || !isOwner(r.level)) return false;
      // an owner-gated send with no draft yet: the draft lease (mode=draft) must run first; the card binds the draft
      if (r.dimension === 'communication' && noDraft && (r.level === 'OWNER_OUTREACH' || r.level === 'OWNER_LEGAL')) return false;
      // payment on an outreach path is DEFERRED until the publisher exposes a checkout (ready_for_payment, §3.3b)
      if (r.dimension === 'payment' && outreachPath) return false;
      return true;
    };
    const ownerGated = live.some(gates);
    let status = placement.status;
    if (status === PARKABLE && ownerGated) {
      Object.assign(patch, { status: PARKED, parked_from_status: PARKABLE });
      status = PARKED;
      out.parked += 1;
      out.parkedDomains.add(domain.domain);
    } else if (status === PARKED && !ownerGated && placement.parked_from_status === PARKABLE) {
      Object.assign(patch, { status: PARKABLE, parked_from_status: null });
      status = PARKABLE;
      out.released += 1;
    }
    if (Object.keys(patch).length) await trx('seo_link_prospects').where({ id: placement.id }).update({ ...patch, updated_at: now });
    summaries.push({ id: placement.id, status, authority, rows: live });
  }

  // informational stamp on the path — that column only, never the revision or updated_at
  const pathLevel = mostSevere(summaries.map((s) => s.authority).filter(Boolean));
  if (pathLevel && pathLevel !== path.authority_last_decided) await trx('seo_link_acquisition_paths').where({ id: path.id }).update({ authority_last_decided: pathLevel });

  // §3.1 aggregate over ALL the domain's placements, not only the ones bridged now
  if (BRIDGE_STATES.includes(domain.agent_state)) {
    const all = await trx('seo_link_prospects').where({ domain_id: domain.id }).select('id', 'status');
    const seen = new Map(summaries.map((s) => [s.id, s]));
    const others = all.filter((p) => !seen.has(p.id));
    const otherRows = others.length ? await trx(AUTH).whereIn('prospect_id', others.map((p) => p.id)).whereNull('ended_at').select('*') : [];
    for (const p of others) seen.set(p.id, { id: p.id, status: p.status, rows: otherRows.filter((r) => r.prospect_id === p.id) });
    const next = aggregateState([...seen.values()]);
    if (next !== domain.agent_state) {
      const moved = await trx('seo_link_domains').where({ id: domain.id, agent_state: domain.agent_state }).update({ agent_state: next, updated_at: now });
      if (moved) out.aggregateChanges += 1;
    }
  }
  return { decided: true };
}

// §3.1 — ready_to_acquire while ANY authorized placement is pending; acquired
// once live with nothing pending; acquiring for the active intermediates;
// qualified while the owner (or a deferred owner decision) holds it; back to
// investigating when EVERY placement is INVALID; rejected ONLY when every
// placement is DENY (a single DENY beside a pending sibling never rejects).
function aggregateState(placements) {
  const rows = (p) => p.rows || [];
  const authorizedPending = (p) => p.status === PARKABLE && rows(p).length > 0 && rows(p).every((r) => r.satisfied_at || isAuto(r.level));
  const ownerPending = (p) => p.status === PARKABLE && rows(p).some((r) => !r.satisfied_at && isOwner(r.level));
  const every = (level) => placements.length > 0 && placements.every((p) => rows(p).length > 0 && rows(p).every((r) => r.level === level));
  if (placements.some(authorizedPending)) return 'ready_to_acquire';
  if (placements.some((p) => ['live', 'indexed'].includes(p.status))) return 'acquired';
  if (placements.some((p) => ['placed', 'contacted', 'negotiating'].includes(p.status))) return 'acquiring';
  if (placements.some((p) => p.status === PARKED || ownerPending(p))) return 'qualified';
  if (every('INVALID')) return 'investigating';
  if (every('DENY')) return 'rejected';
  return 'qualified';
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------
/**
 * runAuthorityBridge(db, { limit, dryRun, domainIds, now, exclusive, notify })
 *   → { dryRun, gated, selected, decided, placementsCreated, rowsWritten, redecided,
 *       ended, parked, released, invalidatedApprovals, invalidatedWaivers,
 *       aggregateChanges, errors, skipped? }
 * - gated / dryRun: selection only; zero writes, no bell.
 * - skipped: 'lease_held' when another run holds the session lock.
 */
async function runAuthorityBridge(db, {
  limit = DEFAULT_LIMIT, dryRun = false, domainIds = null, now: fixedNow = null,
  exclusive = defaultExclusive, notify = defaultNotify,
} = {}) {
  const now = fixedNow || new Date();
  const gated = !isEnabled('linkAuthority');
  limit = Math.max(1, Math.min(Math.floor(Number(limit) || 0) || DEFAULT_LIMIT, RUN_LIMIT_MAX));
  const { policy, updated_at: policyUpdatedAt } = await P.loadPolicy(db);
  const targets = await selectDomains(db, { domainIds, limit, policyUpdatedAt });
  const out = {
    dryRun, gated, selected: targets.length, decided: 0, placementsCreated: 0, rowsWritten: 0, redecided: 0, ended: 0,
    parked: 0, released: 0, invalidatedApprovals: 0, invalidatedWaivers: 0, aggregateChanges: 0, errors: [],
  };
  if (gated || dryRun || !targets.length) return out;

  const parkedDomains = new Set();
  const ran = await exclusive(LOCK_KEY, async () => {
    for (const t of targets) {
      try {
        const r = await db.transaction((trx) => bridgeDomain(trx, { domainId: t.id, policy, policyUpdatedAt, now, out: Object.assign(out, { parkedDomains }) }));
        if (r.decided) out.decided += 1;
        else if (r.skipped) out.errors.push({ domain: t.domain, skipped: r.skipped });
      } catch (err) {
        logger.error(`[link-authority] ${t.domain}: ${err.message}`);
        out.errors.push({ domain: t.domain, error: err.message });
      }
    }
    return true;
  });
  delete out.parkedDomains;
  if (ran && ran.skipped) { out.skipped = ran.reason || 'lease_held'; return out; }

  // ONE bell per run that parked something (never per card); keyed by ET day so a re-run refreshes it
  if (out.parked > 0) {
    const domains = [...parkedDomains];
    try {
      await notify('Link placements await your decision', `${out.parked} placement${out.parked === 1 ? '' : 's'} parked awaiting your approval: ${domains.slice(0, 8).join(', ')}${domains.length > 8 ? ` +${domains.length - 8} more` : ''}`, {
        link: '/admin/seo', bell: true, dedupeKey: `link-authority:${etDateString(now)}`, refreshOnDedupe: true,
        metadata: { lane: 'link_authority', parked: out.parked, domains },
      });
    } catch (err) { logger.error(`[link-authority] bell failed: ${err.message}`); }
  }
  return out;
}

module.exports = { runAuthorityBridge, selectDomains, aggregateState, LOCK_KEY, HOMEPAGE, BRIDGE_STATES, RUN_LIMIT_MAX, DEFAULT_LIMIT };
