/**
 * Backlink Manager v2 — which domains the nightly `link-authority` bridge
 * visits (plan §6.3 "Bridge"), and the ONE rotation rule the bridge shares
 * with it (so selection can never disagree with the bridge about what is
 * stale). Read-only; the bridge (link-authority-bridge.js) does the writes.
 *
 * Resolved in JS over a few whereIn reads (hundreds of rows at most today) so
 * the rule reads plainly and can never starve: a bridged domain that stays
 * `qualified` (owner-routed policy) is only re-selected when something it
 * depends on moved, so the batch always advances to the next unbridged one.
 */

const { WAVES_LOCATIONS } = require('../../config/locations');
const { SIGNUP_LINK_TYPES } = require('./link-path-investigation-schema');
const { isOutreachLocked } = require('./link-registry');
const { requiredInstances } = require('./link-authority-policy');

const AUTH = 'seo_link_placement_authorities';
// The aggregate states the bridge OWNS. `new`/`investigating`/`watching`/
// `not_reproducible`/`rejected` are set by intake, the investigator or the
// owner — the bridge re-decides their rows for honesty but never moves them.
const BRIDGE_STATES = Object.freeze(['qualified', 'ready_to_acquire', 'acquiring', 'acquired']);
// §3.1 status classes the aggregate is built from (shared with the bridge)
const LIVE_STATUSES = Object.freeze(['live', 'indexed']);
const ACQUIRING_STATUSES = Object.freeze(['placed', 'contacted', 'negotiating', 'ready_for_credentials', 'ready_for_payment']);
// The Judge, the worker's reports and the verifier move PLACEMENT statuses in place (placed → live, live → lost,
// contacted → rejected) and never touch the domain; a satisfied row is never re-decided, so no timestamp carries
// those moves either — and the verifier bumps updated_at on every live check. The aggregate is therefore re-run
// exactly when the STORED state contradicts what the statuses imply: `acquired` needs a live link (off-shape links
// count — they win the aggregate too); `acquiring` needs an in-shape placement that is leased or in an active
// intermediate. Anything else the aggregate would say is held / pending — states the rows already re-select on.
const CONTRADICTED = Object.freeze({
  acquired: ({ all }) => !all.some((p) => LIVE_STATUSES.includes(p.status)),
  acquiring: ({ mine }) => !mine.some((p) => p.claimed_at || ACQUIRING_STATUSES.includes(p.status)),
});

const ts = (v) => (v ? new Date(v).getTime() : 0);
// placements per lane: one per GBP location for a signup lane, one unscoped row otherwise
const expectedLocations = (path) => (path && SIGNUP_LINK_TYPES.includes(path.link_type) ? WAVES_LOCATIONS.map((l) => l.id) : ['-']);
// a SATISFIED accept_terms instance is bound to the hash it accepted: an
// agreement the path no longer carries reopens it (§3.3b — acceptance of an old
// agreement never satisfies a newly discovered one)
const termsChanged = (r, path) => r.instance_kind === 'terms' && (r.accepted_terms_hash || null) !== ((path && path.legal_terms_hash) || null);
// Which open instance outlived its path or agreement (§3.2 supersession rule):
// an UNSATISFIED instance decided on another path ends `superseded`; a satisfied
// accept_terms instance ends `terms_changed` when its hash moved (an equal hash
// carries across); a satisfied ACQUISITION execution instance proves only the
// path it ran on and ends `superseded` when the placement moved; a satisfied
// payment proof carries EXCEPT a zero-total one (`no_payment_required`) when
// the CURRENT path charges under payment inputs the proof did not see (another
// path, or the same path revised in place — its revision_payment moved) —
// nothing was paid, so nothing covers the fee; a satisfied communication
// instance is path-independent (the pitch went out) and is carried. Null =
// keep. `path` needs id, legal_terms_hash, payment_required, revision_payment.
const rotationOutcome = (r, path) => {
  if (r.ended_at) return null;
  if (!r.satisfied_at) return r.path_id !== path.id ? 'superseded' : null;
  if (r.instance_kind === 'terms') return termsChanged(r, path) ? 'terms_changed' : null;
  if (r.dimension === 'execution') return r.path_id !== path.id ? 'superseded' : null;
  if (r.dimension === 'payment' && r.satisfied_reason === 'no_payment_required') {
    const feeMoved = r.path_id !== path.id || Number(r.path_revision) !== Number(path.revision_payment ?? path.revision ?? 1);
    return path.payment_required === true && feeMoved ? 'superseded' : null;
  }
  return null;
};

/**
 * selectDomains(db, { domainIds, limit, policyUpdatedAt }) → [{ id, domain, why }]
 * why: 'forced' (domainIds) | 'unbridged' (a bridge-owned state missing a
 * placement, with open rows, for an expected location on the best path) |
 * 'stale' (a placement with open rows on a non-best path, an open row the
 * shared rotation rule would end, an unsatisfied row decided before the
 * policy / domain / path / waiver / the placement itself last changed, or a
 * waiver on a rejected domain whose rows were all ended). Sorted forced →
 * unbridged → stale, oldest domain first, then sliced to `limit`.
 */
async function selectDomains(db, { domainIds, limit, policyUpdatedAt }) {
  const forced = new Set(domainIds || []);
  // candidates: bridge-owned state, or owning an open row (satisfied or not), or carrying an active waiver, or explicitly requested
  const owned = await db('seo_link_domains').whereIn('agent_state', [...BRIDGE_STATES]).whereNotNull('best_path_id').orderBy('updated_at', 'asc').select('id');
  const open = await db(AUTH).whereNull('ended_at').select('prospect_id', 'path_id', 'path_revision', 'dimension', 'instance_kind', 'decided_at', 'satisfied_at', 'satisfied_reason', 'accepted_terms_hash');
  const owners = open.length ? await db('seo_link_prospects').whereIn('id', [...new Set(open.map((r) => r.prospect_id))]).whereNotNull('domain_id').select('id', 'domain_id') : [];
  const waivers = await db('seo_link_floor_waivers').whereNull('invalidated_at').select('domain_id', 'path_id', 'approved_at');
  const candidateIds = [...new Set([...owned.map((d) => d.id), ...owners.map((p) => p.domain_id), ...waivers.map((w) => w.domain_id), ...forced])]
    .filter((id) => !forced.size || forced.has(id));
  if (!candidateIds.length) return [];
  const domains = await db('seo_link_domains').whereIn('id', candidateIds).whereNotNull('best_path_id').select('id', 'domain', 'agent_state', 'best_path_id', 'updated_at');
  const paths = await db('seo_link_acquisition_paths').whereIn('id', [...new Set(domains.map((d) => d.best_path_id))]).select('id', 'updated_at', 'link_type', 'acquisition_type', 'account_required', 'legal_attestation', 'legal_terms_hash', 'payment_required', 'revision_payment', 'revision', 'baseline');
  const pathById = new Map(paths.map((p) => [p.id, p]));
  // every placement the candidates own: "bridged" = one on the best path, carrying open rows, per expected location
  const placements = await db('seo_link_prospects').whereIn('domain_id', candidateIds).select('id', 'domain_id', 'path_id', 'location_key', 'status', 'claimed_at', 'updated_at', 'outreach_status', 'outreach_sent_at');
  const byDomain = new Map();
  for (const p of placements) byDomain.set(p.domain_id, [...(byDomain.get(p.domain_id) || []), p]);
  const rowsByProspect = new Map();
  for (const r of open) rowsByProspect.set(r.prospect_id, [...(rowsByProspect.get(r.prospect_id) || []), r]);
  const waiverAt = new Map();
  for (const w of waivers) waiverAt.set(`${w.domain_id}|${w.path_id}`, Math.max(waiverAt.get(`${w.domain_id}|${w.path_id}`) || 0, ts(w.approved_at)));

  const picked = [];
  const rank = { forced: 0, unbridged: 1, stale: 2 };
  for (const d of domains) {
    const best = pathById.get(d.best_path_id) || null;
    // a baseline placeholder (an imported existing backlink, never investigated) is not an executable path: nothing to bridge
    if (best && best.baseline === true && !forced.has(d.id)) continue;
    const expected = expectedLocations(best);
    // only placements INSIDE the lane's shape are bridged or a staleness source — an off-shape row (the other lane's
    // keys after a re-rank, or a location removed from WAVES_LOCATIONS) keeps its history and is never moved or
    // re-decided; while it still carries an OPEN UNSATISFIED instance it is stale once, so the bridge can retire it
    const all = byDomain.get(d.id) || [];
    const mine = all.filter((p) => expected.includes(p.location_key));
    const offShapeOpen = all.some((p) => !expected.includes(p.location_key) && (rowsByProspect.get(p.id) || []).some((r) => !r.satisfied_at));
    // a PINNED conversation (locked send state / sent stamp — the mover refuses it) is this domain's placement for its
    // location wherever it sits: bridged in place and never a path-mismatch source until the lock releases. On the
    // best path it is decided like any other row (a policy / path / domain change still re-decides its open
    // execution / payment instances before the post-send action); on another path it is frozen.
    const pinned = (p) => isOutreachLocked(p);
    const frozen = (p) => pinned(p) && p.path_id !== d.best_path_id;
    const onBest = mine.filter((p) => p.path_id === d.best_path_id || pinned(p));
    const cutoff = Math.max(ts(policyUpdatedAt), ts(d.updated_at), best ? ts(best.updated_at) : 0, waiverAt.get(`${d.id}|${d.best_path_id}`) || 0);
    const staleRow = (r, p) => (best && rotationOutcome(r, best) !== null)
      || (!r.satisfied_at && (ts(r.decided_at) < cutoff || ts(r.decided_at) < ts(p.updated_at)));
    // the OPEN instance set must cover what the path REQUIRES now (policy requiredInstances): an in-place
    // re-investigation that adds a fee or legal terms needs a new row even when every existing row is satisfied;
    // an UNSATISFIED instance the path no longer requires must be ended (the bridge keeps a satisfied surplus row —
    // it is history — so it is never a reason to re-select)
    const required = best ? new Set(requiredInstances(best).map((i) => `${i.dimension}|${i.instance_kind}`)) : null;
    const instanceSetMoved = (p) => {
      if (!required) return false;
      const open = rowsByProspect.get(p.id) || [];
      const openKeys = new Set(open.map((r) => `${r.dimension}|${r.instance_kind}`));
      const unsatisfiedKeys = open.filter((r) => !r.satisfied_at).map((r) => `${r.dimension}|${r.instance_kind}`);
      return [...required].some((k) => !openKeys.has(k)) || unsatisfiedKeys.some((k) => !required.has(k));
    };
    // a stored aggregate the placement statuses contradict (CONTRADICTED) is stale ONCE: the bridge re-aggregates and
    // the next selection sees a state the statuses support
    const contradicted = Boolean(CONTRADICTED[d.agent_state]) && CONTRADICTED[d.agent_state]({ all, mine });
    const withRows = mine.filter((p) => rowsByProspect.has(p.id) && !frozen(p));
    let why = null;
    if (forced.has(d.id)) why = 'forced';
    else if (BRIDGE_STATES.includes(d.agent_state) && expected.some((l) => !onBest.some((p) => p.location_key === l && rowsByProspect.has(p.id)))) why = 'unbridged';
    else if (contradicted || offShapeOpen || withRows.some((p) => p.path_id !== d.best_path_id || instanceSetMoved(p) || rowsByProspect.get(p.id).some((r) => staleRow(r, p)))) why = 'stale';
    else if (waiverAt.has(`${d.id}|${d.best_path_id}`) && !withRows.length && !BRIDGE_STATES.includes(d.agent_state)) why = 'stale'; // a waiver on a rejected domain whose rows were all ended
    if (why) picked.push({ id: d.id, domain: d.domain, why, at: ts(d.updated_at) });
  }
  picked.sort((a, b) => rank[a.why] - rank[b.why] || a.at - b.at);
  return picked.slice(0, limit).map(({ id, domain, why }) => ({ id, domain, why }));
}

module.exports = { selectDomains, expectedLocations, termsChanged, rotationOutcome, ts, BRIDGE_STATES, LIVE_STATUSES, ACQUIRING_STATUSES };
