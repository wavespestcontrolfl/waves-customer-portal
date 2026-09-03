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
const { claimProspectDomain, findPlacementRow, targetPageOf } = require('./prospect-domain-lock');
const { OUTREACH_ACQUISITION_TYPES, LEVEL_SEVERITY, settleRetiredPlacements } = require('./link-registry');
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
// Selection — resolved in JS over a few whereIn reads (hundreds of rows at
// most) so the rule reads plainly and can never starve: a bridged domain that
// stays `qualified` (owner-routed policy) is only re-selected when something it
// depends on moved, so the batch always advances to the next unbridged one.
// ---------------------------------------------------------------------------
async function selectDomains(db, { domainIds, limit, policyUpdatedAt }) {
  const forced = new Set(domainIds || []);
  // candidates: qualified, or owning an open unsatisfied row, or carrying an active waiver, or explicitly requested
  const qualified = await db('seo_link_domains').where({ agent_state: 'qualified' }).whereNotNull('best_path_id').orderBy('updated_at', 'asc').select('id');
  const open = await db(AUTH).whereNull('ended_at').whereNull('satisfied_at').select('prospect_id', 'decided_at');
  const openProspects = open.length ? await db('seo_link_prospects').whereIn('id', [...new Set(open.map((r) => r.prospect_id))]).whereNotNull('domain_id').select('id', 'domain_id', 'path_id') : [];
  const waivers = await db('seo_link_floor_waivers').whereNull('invalidated_at').select('domain_id', 'path_id', 'approved_at');
  const candidateIds = [...new Set([...qualified.map((d) => d.id), ...openProspects.map((p) => p.domain_id), ...waivers.map((w) => w.domain_id), ...forced])]
    .filter((id) => !forced.size || forced.has(id));
  if (!candidateIds.length) return [];
  const domains = await db('seo_link_domains').whereIn('id', candidateIds).whereNotNull('best_path_id').select('id', 'domain', 'agent_state', 'best_path_id', 'updated_at');
  const paths = await db('seo_link_acquisition_paths').whereIn('id', [...new Set(domains.map((d) => d.best_path_id))]).select('id', 'updated_at');
  const pathAt = new Map(paths.map((p) => [p.id, ts(p.updated_at)]));
  const oldestByProspect = new Map();
  for (const r of open) oldestByProspect.set(r.prospect_id, Math.min(oldestByProspect.get(r.prospect_id) ?? Infinity, ts(r.decided_at)));
  const byDomain = new Map();
  for (const p of openProspects) byDomain.set(p.domain_id, [...(byDomain.get(p.domain_id) || []), p]);
  const waiverAt = new Map();
  for (const w of waivers) waiverAt.set(`${w.domain_id}|${w.path_id}`, Math.max(waiverAt.get(`${w.domain_id}|${w.path_id}`) || 0, ts(w.approved_at)));

  const picked = [];
  const rank = { forced: 0, unbridged: 1, stale: 2 };
  for (const d of domains) {
    const rows = byDomain.get(d.id) || [];
    const onBest = rows.filter((p) => p.path_id === d.best_path_id);
    const cutoff = Math.max(ts(policyUpdatedAt), ts(d.updated_at), pathAt.get(d.best_path_id) || 0, waiverAt.get(`${d.id}|${d.best_path_id}`) || 0);
    let why = null;
    if (forced.has(d.id)) why = 'forced';
    else if (d.agent_state === 'qualified' && !onBest.length) why = 'unbridged';
    else if (rows.some((p) => p.path_id !== d.best_path_id || oldestByProspect.get(p.id) < cutoff)) why = 'stale';
    else if (waiverAt.has(`${d.id}|${d.best_path_id}`) && !rows.length && !BRIDGE_STATES.includes(d.agent_state)) why = 'stale'; // a waiver on a rejected domain whose rows were all ended
    if (why) picked.push({ id: d.id, domain: d.domain, why, at: ts(d.updated_at) });
  }
  picked.sort((a, b) => rank[a.why] - rank[b.why] || a.at - b.at);
  return picked.slice(0, limit).map(({ id, domain, why }) => ({ id, domain, why }));
}

// A row is AUTHORIZED when it is satisfied, AUTO_*, or OWNER_* with a valid
// (approved, not invalidated) approval attached — PR 2b writes those; the
// bridge honours them so an approved placement is never re-parked.
async function annotateApprovals(trx, rows) {
  const ids = [...new Set(rows.filter((r) => r.approval_id).map((r) => r.approval_id))];
  const approvals = ids.length ? await trx('seo_link_approvals').whereIn('id', ids).select('id', 'decision', 'invalidated_at') : [];
  const valid = new Set(approvals.filter((a) => a.decision === 'approved' && !a.invalidated_at).map((a) => a.id));
  for (const r of rows) r.approved = Boolean(r.approval_id && valid.has(r.approval_id));
  return rows;
}
const authorized = (r) => Boolean(r.satisfied_at) || isAuto(r.level) || (isOwner(r.level) && r.approved === true);

const freshCounters = () => ({ placementsCreated: 0, rowsWritten: 0, redecided: 0, ended: 0, parked: 0, released: 0, invalidatedApprovals: 0, invalidatedWaivers: 0, aggregateChanges: 0, skippedLeased: 0, parkedDomains: [] });

// ---------------------------------------------------------------------------
// One domain, one transaction. Counters are LOCAL to the transaction and
// merged by the caller only after it commits — a rollback reports nothing.
// ---------------------------------------------------------------------------
async function bridgeDomain(trx, { domainId, policy, policyUpdatedAt, now }) {
  const out = freshCounters();
  const domain = await trx('seo_link_domains').where({ id: domainId }).forUpdate().first();
  if (!domain || !domain.best_path_id) return { skipped: 'no best path', out };
  // the shared board guard: the per-domain lock + "one conversation per inbox" —
  // an outreach-lane placement is never opened beside an active outreach row
  const { inFlight } = await claimProspectDomain(trx, domain.domain);
  const path = await trx('seo_link_acquisition_paths').where({ id: domain.best_path_id }).first();
  if (!path || path.superseded_by) return { skipped: 'best path superseded', out };
  const ctx = { path, domain, policy, score: domain.score };

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
  const staleAfter = Math.max(ts(policyUpdatedAt), ts(domain.updated_at), ts(path.updated_at), waiver ? ts(waiverRow.approved_at) : 0);

  const decision = P.decideAuthority({ ...ctx, monthSpendCents: 0, d30Confidence: null, draftClean: false, waiver });
  const outreachPath = OUTREACH_ACQUISITION_TYPES.includes(path.acquisition_type);

  // placements: one per GBP location for a signup lane, one unscoped row otherwise
  const locations = SIGNUP_LINK_TYPES.includes(path.link_type) ? WAVES_LOCATIONS.map((l) => l.id) : ['-'];
  let placements = [];
  for (const location of locations) {
    let row = await findPlacementRow(trx, domain.domain, HOMEPAGE, { location, columns: ['*'] });
    if (!row && location === '-' && inFlight) {
      // an outreach conversation already exists for this inbox (a manual or
      // strategy-agent row on another page): ADOPT it as the placement rather
      // than open a second one. A row already bound to a different live path
      // is that path's placement — nothing is created this run.
      const existing = await trx('seo_link_prospects').where({ id: inFlight.id }).first();
      if (!existing || (existing.path_id && existing.path_id !== path.id)) return { skipped: `outreach conversation in flight on another path (${inFlight.status})`, out };
      if (!existing.path_id) {
        const adopt = { domain_id: domain.id, path_id: path.id, updated_at: now, ...(existing.link_type ? {} : { link_type: path.link_type }) };
        await trx('seo_link_prospects').where({ id: existing.id }).update(adopt);
        Object.assign(existing, adopt);
      }
      row = existing;
    }
    if (!row) {
      const [created] = await trx('seo_link_prospects').insert({
        target_domain: domain.domain, target_page: HOMEPAGE, target_url: path.submission_url || null, location_key: location,
        domain_id: domain.id, path_id: path.id, link_type: path.link_type,
        source: domain.source, source_detail: OWNER, owner: OWNER, status: PARKABLE,
        created_at: now, updated_at: now,
      }).returning('*');
      row = created;
      out.placementsCreated += 1;
    }
    placements.push(row);
  }

  // Supersession goes through the ONE placement mover (link-registry
  // settleRetiredPlacements: waits for an unleased row, follows the chain,
  // syncs lane/URL, clears a stale draft + classification). A placement still
  // leased on its old path, or on a live path that is not the domain's best,
  // is left alone this run.
  const behind = placements.filter((p) => p.path_id !== path.id);
  if (behind.length) {
    await settleRetiredPlacements(trx, { prospectIds: behind.map((p) => p.id), now });
    const moved = await trx('seo_link_prospects').whereIn('id', behind.map((p) => p.id)).select('*');
    const byId = new Map(moved.map((p) => [p.id, p]));
    placements = placements.map((p) => byId.get(p.id) || p);
    for (const p of placements) {
      if (p.path_id === path.id && behind.some((b) => b.id === p.id)) {
        // the rows were decided on the old path: the unsatisfied instances end, fresh generations are decided below
        out.ended += await trx(AUTH).where({ prospect_id: p.id }).whereNull('ended_at').whereNull('satisfied_at').update({ ended_at: now, end_outcome: 'superseded', updated_at: now });
      }
    }
    const stuck = placements.filter((p) => p.path_id !== path.id);
    out.skippedLeased += stuck.length;
    placements = placements.filter((p) => p.path_id === path.id);
  }

  // payment group (§3.3 / bridge): the purchase contract keys every reservation,
  // duplicate guard and renewal by it — account_wide siblings share the first
  // placement's id; a per_location fee is its own group (re-investigation from
  // account_wide to per_location splits the group; the reverse re-joins it)
  if (path.payment_required && placements.length) {
    const anchor = path.fee_scope === 'account_wide' ? ((placements.find((p) => p.payment_group_id) || {}).payment_group_id || placements[0].id) : null;
    for (const p of placements) {
      const groupId = anchor || p.id;
      if (p.payment_group_id === groupId) continue;
      await trx('seo_link_prospects').where({ id: p.id }).update({ payment_group_id: groupId, updated_at: now });
      p.payment_group_id = groupId;
    }
  }

  const summaries = [];
  for (const placement of placements) {
    // ALL rows, ended ones included: the full UNIQUE (prospect, dimension,
    // instance_key) keeps history, so a replacement instance takes the next
    // generation (`${kind}:${n+1}`, §3.3b) — never the ended row's key.
    const history = await annotateApprovals(trx, await trx(AUTH).where({ prospect_id: placement.id }).select('*'));
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
        existing.approved = false;
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
      if (authorized(r)) return false;
      if (!isOwner(r.level)) return false;
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
      if (!out.parkedDomains.includes(domain.domain)) out.parkedDomains.push(domain.domain);
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

  // §3.1 aggregate over ALL the domain's placements, not only the ones bridged
  // now. `rejected` is left only on the owner's explicit "Acquire anyway" (a
  // valid waiver) — the bridge cannot tell its own rejection from the owner's.
  if (BRIDGE_STATES.includes(domain.agent_state) || (domain.agent_state === 'rejected' && waiver)) {
    const all = await trx('seo_link_prospects').where({ domain_id: domain.id }).select('id', 'status');
    const seen = new Map(summaries.map((s) => [s.id, s]));
    const others = all.filter((p) => !seen.has(p.id));
    const otherRows = others.length ? await annotateApprovals(trx, await trx(AUTH).whereIn('prospect_id', others.map((p) => p.id)).whereNull('ended_at').select('*')) : [];
    for (const p of others) seen.set(p.id, { id: p.id, status: p.status, rows: otherRows.filter((r) => r.prospect_id === p.id) });
    const next = aggregateState([...seen.values()]);
    if (next !== domain.agent_state) {
      const moved = await trx('seo_link_domains').where({ id: domain.id, agent_state: domain.agent_state }).update({ agent_state: next, updated_at: now });
      if (moved) out.aggregateChanges += 1;
    }
  }
  return { decided: true, out };
}

// §3.1 — ready_to_acquire while ANY authorized placement is pending; acquired
// once live with nothing pending; acquiring for the active intermediates;
// qualified while the owner (or a deferred owner decision) holds it; back to
// investigating when EVERY placement is INVALID; rejected ONLY when every
// placement is DENY (a single DENY beside a pending sibling never rejects).
// "authorized" = satisfied, AUTO_*, or OWNER_* with a valid approval.
function aggregateState(placements) {
  const rows = (p) => p.rows || [];
  const authorizedPending = (p) => p.status === PARKABLE && rows(p).length > 0 && rows(p).every(authorized);
  const ownerPending = (p) => p.status === PARKABLE && rows(p).some((r) => !authorized(r) && isOwner(r.level));
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
 *       aggregateChanges, skippedLeased, errors, skipped? }
 * - gated / dryRun: selection only; zero writes, no bell.
 * - domainIds: force-select those domains (a waiver click, an admin retry) whatever their state.
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
  const out = { dryRun, gated, selected: targets.length, decided: 0, ...freshCounters(), errors: [] };
  delete out.parkedDomains;
  if (gated || dryRun || !targets.length) return out;

  const parkedDomains = [];
  const ran = await exclusive(LOCK_KEY, async () => {
    for (const t of targets) {
      try {
        const r = await db.transaction((trx) => bridgeDomain(trx, { domainId: t.id, policy, policyUpdatedAt, now }));
        // merge only what COMMITTED
        for (const [k, v] of Object.entries(r.out)) {
          if (k === 'parkedDomains') { for (const d of v) if (!parkedDomains.includes(d)) parkedDomains.push(d); } else out[k] += v;
        }
        if (r.decided) out.decided += 1;
        else if (r.skipped) out.errors.push({ domain: t.domain, skipped: r.skipped });
      } catch (err) {
        logger.error(`[link-authority] ${t.domain}: ${err.message}`);
        out.errors.push({ domain: t.domain, error: err.message });
      }
    }
    return true;
  });
  if (ran && ran.skipped) { out.skipped = ran.reason || 'lease_held'; return out; }

  // ONE bell per run that parked something (never per card); keyed by ET day so a re-run refreshes it
  if (out.parked > 0) {
    try {
      await notify('Link placements await your decision', `${out.parked} placement${out.parked === 1 ? '' : 's'} parked awaiting your approval: ${parkedDomains.slice(0, 8).join(', ')}${parkedDomains.length > 8 ? ` +${parkedDomains.length - 8} more` : ''}`, {
        link: '/admin/seo', bell: true, dedupeKey: `link-authority:${etDateString(now)}`, refreshOnDedupe: true,
        metadata: { lane: 'link_authority', parked: out.parked, domains: parkedDomains },
      });
    } catch (err) { logger.error(`[link-authority] bell failed: ${err.message}`); }
  }
  return out;
}

module.exports = { runAuthorityBridge, selectDomains, aggregateState, annotateApprovals, LOCK_KEY, HOMEPAGE, BRIDGE_STATES, RUN_LIMIT_MAX, DEFAULT_LIMIT };
