/**
 * Backlink Manager v2 step 4 — the OWNER'S side of the authority loop
 * (plan §11 items 2–3, §3.6b, §6.3 1b; step 4 PR 2b).
 *
 * The nightly bridge (link-authority-bridge.js) parks an owner-gated placement
 * `awaiting_owner` with one authority row per dimension instance. This module
 * is the ONLY writer of the two tables the owner answers with:
 *
 *  - `seo_link_approvals` — one immutable row per click. `approved` freezes
 *    exactly the dimension inputs the owner looked at (`terms_snapshot` = the
 *    §3.6b hash set) and is attached to the authority row (`approval_id`); the
 *    bridge then reads the row as AUTHORIZED, releases the park and the domain
 *    reads `ready_to_acquire`. `rejected` / `watch` are audit rows with no
 *    approved terms (the money CHECKs forbid amounts on them).
 *  - `seo_link_floor_waivers` — "Acquire anyway": NEVER an approval and never
 *    a dimension level. It records the exact floors waived at their values,
 *    bound to the floors-inputs hash; the bridge honours it only while that
 *    hash still matches (§6.3 1b) and then decides every dimension normally.
 *
 * Reject / Watch are DOMAIN actions (the same writer as the Registry table's
 * buttons, link-registry.applyRegistryAction): no authority row is ended and
 * no placement status moves — `rejected` / `watching` are not bridge-owned
 * states, so the nightly selection leaves the domain alone; Reopen →
 * investigating → qualified re-decides the SAME rows in place and the cards
 * reappear. Ending the rows instead would make the location read `unbridged`
 * after Reopen and spawn a new generation on a placement the bridge can no
 * longer park (it only moves prospect ⇄ awaiting_owner).
 *
 * Every click also bumps the affected placements' `updated_at`: the inline
 * bridge run after a click is best-effort (the cron lock may be held by the
 * 03:35 ET run, or GATE_LINK_AUTHORITY may be off — selection only), and the
 * bump is what makes the nightly `stale` rule revisit the domain so the
 * release / aggregate happens then. Owner-initiated runs ring no bell.
 *
 * Nothing here leases, sends, or moves money.
 */

const P = require('./link-authority-policy');
const R = require('./link-registry');
const { lockProspectDomain } = require('./prospect-domain-lock');
const { BRIDGE_STATES } = require('./link-authority-selection');

const AUTH = 'seo_link_placement_authorities';
const PARKED = 'awaiting_owner';
const PARKABLE = 'prospect';
const noop = () => {};

class OwnerQueueError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const refuse = (status, message) => { throw new OwnerQueueError(status, message); };

// The levels this PR's Approve button covers (plan §6.1; the rest of
// APPROVABLE_LEVELS is deliberately excluded — see whyNotApprovable).
const APPROVE_HERE = Object.freeze({
  OWNER_FREE: ['execution'], OWNER_ACCOUNT: ['execution'], OWNER_MEMBERSHIP: ['execution'],
  OWNER_LEGAL: ['execution'], // the accept_terms instance; the OWNER_LEGAL SEND is the outreach click (PR 3)
  OWNER_PAYMENT: ['payment'],
});

// §3.6b action per (dimension, instance kind)
function actionFor(row) {
  if (row.dimension === 'execution') return row.instance_kind === 'terms' ? 'accept_terms' : 'acquire';
  if (row.dimension === 'payment') return row.instance_kind === '-' ? 'purchase' : 'renewal';
  return row.instance_kind === 'followup' ? 'outreach_followup' : 'outreach_send';
}

// null = Approve applies; otherwise the reason the card shows instead of a button
function whyNotApprovable(row, path = null) {
  if (row.ended_at) return 'instance ended';
  if (row.satisfied_at) return `already satisfied (${row.satisfied_reason})`;
  if (row.approved === true) return 'approved';
  if (typeof row.level !== 'string') return 'undecided';
  if (row.level.startsWith('AUTO_')) return 'automatic under the current policy — no approval needed';
  if (row.level === P.LEVELS.DENY) return 'fails a quality floor — use Acquire anyway on the registry row';
  if (row.level === P.LEVELS.INVALID) return 'not actionable until re-investigated';
  if (row.dimension === 'communication') return 'approved by the authenticated send from the outreach queue';
  if (row.level === P.LEVELS.OWNER_HUMAN_STEP) return 'a human performs this step; the runner checkpoint records it';
  if (row.level === P.LEVELS.OWNER_INPUT_REQUIRED) return 'price entry required — re-investigate with a USD quote';
  if (row.level === P.LEVELS.OWNER_MANUAL_PAYMENT) return 'settled outside the system at checkout';
  if (!(APPROVE_HERE[row.level] || []).includes(row.dimension)) return `${row.level} is not approvable from the queue`;
  // an attested path whose agreement the owner cannot open (no terms url in the evidence) authorizes nothing —
  // neither the acceptance nor the payment it accompanies — until re-investigation restores the url
  if (path && path.legal_attestation === true && !legalTermsUrlOf(path)) return 'the agreement is not viewable (no terms url in the evidence) — re-investigate before approving';
  return null;
}

// The card's frozen inputs vs the live ones (§3.6b) — ONE test for the listing and the click: the hash, the
// per-dimension path revision and the level the policy yields now must all still match, else the row waits
// for the nightly bridge to re-decide it. A renewal instance (`2027:1`, `annual:1`) is opened by the renewal
// claim, not by the decision function — it takes the payment dimension's current `-` verdict.
function stalenessOf(row, ctx, waiver) {
  const hash = P.decisionInputsHash(row.dimension, { ...ctx, instanceKey: row.instance_key });
  const pathRevision = pathRevisionFor(ctx.path, row.dimension);
  if (hash !== row.decision_inputs_hash || Number(row.path_revision) !== pathRevision) return { reason: 'inputs changed since the card — the nightly bridge re-decides it; refresh the queue', hash, pathRevision };
  const decided = P.decideAuthority({ ...ctx, monthSpendCents: 0, d30Confidence: null, draftClean: false, waiver });
  const renewal = row.dimension === 'payment' && R.RENEWAL_KIND_RE.test(String(row.instance_kind));
  const inst = decided.instances.find((i) => i.dimension === row.dimension && i.instance_kind === (renewal ? '-' : row.instance_kind));
  if (!inst || inst.level !== row.level) return { reason: `the policy now yields ${inst ? inst.level : 'no instance'} for this step, not ${row.level} — the nightly bridge re-decides it`, hash, pathRevision };
  return { reason: null, hash, pathRevision };
}

// the valid (approved, not invalidated) approval per authority row + the audit trail for display
async function loadApprovals(q, rows) {
  const ids = [...new Set(rows.filter((r) => r.approval_id).map((r) => r.approval_id))];
  const approvals = ids.length ? await q('seo_link_approvals').whereIn('id', ids)
    .select('id', 'decision', 'authority', 'approved_by', 'approved_at', 'approved_amount_cents', 'max_payable_cents', 'invalidated_at', 'invalidated_reason', 'consumed_at') : [];
  const byId = new Map(approvals.map((a) => [a.id, a]));
  for (const r of rows) {
    const a = r.approval_id ? byId.get(r.approval_id) : null;
    r.approval = a || null;
    r.approved = Boolean(a && a.decision === 'approved' && !a.invalidated_at);
  }
  return rows;
}

async function activeWaiver(q, domainId, pathId, ctx) {
  const w = await q('seo_link_floor_waivers').where({ domain_id: domainId, path_id: pathId }).whereNull('invalidated_at').orderBy('approved_at', 'desc').first();
  if (!w) return { waiver: null, row: null };
  return { waiver: w.decision_inputs_hash === P.floorInputsHash(ctx) ? { id: w.id } : null, row: w };
}

// The bridge run after a click is BEST-EFFORT and runs after the click's transaction committed: a failure here
// (policy load, selection, the cron lock, a DB blip) must not turn a recorded decision into a 500 — the bumped
// updated_at already guarantees the nightly run picks the domain up. Reported as skipped: 'failed'.
async function bestEffortBridge(run, db, opts) {
  try { return await run(db, opts); } catch (err) {
    require('../logger').error(`[backlink-owner-queue] post-commit bridge run failed for ${(opts.domainIds || []).join(',')}: ${err.message}`);
    return { skipped: 'failed', error: err.message, gated: false, selected: 0, decided: 0, parked: 0, released: 0, aggregateChanges: 0, errors: [err.message] };
  }
}

// the investigator's evidence JSON (string or object) and the agreement URL the owner reads (§3.6b: frozen
// with every approval whose path carries a legal attestation, payment included)
function investigationOf(path) {
  try { return typeof path?.investigation === 'string' ? JSON.parse(path.investigation) : path?.investigation || null; } catch { return null; }
}
const legalTermsUrlOf = (path) => { const inv = investigationOf(path); return inv && inv.legal_terms_url ? inv.legal_terms_url : null; };

function pathRevisionFor(path, dimension) { return Number(path[`revision_${dimension}`] ?? path.revision ?? 1); }
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

// ---------------------------------------------------------------------------
// The queue — one card per parked placement whose domain still awaits the owner
// ---------------------------------------------------------------------------
async function listOwnerQueue(db) {
  const { policy } = await P.loadPolicy(db);
  const parked = await db('seo_link_prospects').where({ status: PARKED, parked_from_status: PARKABLE }).whereNotNull('domain_id')
    .select('id', 'domain_id', 'path_id', 'target_page', 'location_key', 'link_type', 'payment_group_id', 'outreach_status', 'claimed_at', 'updated_at');
  if (!parked.length) return { cards: [] };
  const domains = await db('seo_link_domains').whereIn('id', [...new Set(parked.map((p) => p.domain_id))]).whereIn('agent_state', [...BRIDGE_STATES])
    .select('id', 'domain', 'agent_state', 'score', 'score_reasons', 'spam_score', 'domain_rating', 'organic_traffic', 'referring_domains', 'competitors_linked', 'best_path_id', 'source', 'discovery_priority');
  const domainById = new Map(domains.map((d) => [d.id, d]));
  const cardsFor = parked.filter((p) => domainById.has(p.domain_id));
  if (!cardsFor.length) return { cards: [] };
  const pathIds = [...new Set([...domains.map((d) => d.best_path_id), ...cardsFor.map((p) => p.path_id)].filter(Boolean))];
  const paths = pathIds.length ? await db('seo_link_acquisition_paths').whereIn('id', pathIds) : [];
  const pathById = new Map(paths.map((p) => [p.id, p]));
  const rows = await loadApprovals(db, await db(AUTH).whereIn('prospect_id', cardsFor.map((p) => p.id)).whereNull('ended_at'));
  const waivers = await db('seo_link_floor_waivers').whereIn('domain_id', domains.map((d) => d.id)).whereNull('invalidated_at').orderBy('approved_at', 'desc')
    .select('id', 'domain_id', 'path_id', 'overridden_floors', 'decision_inputs_hash', 'note', 'approved_by', 'approved_at');
  const activeWaiverFor = new Map(); // (domain|path) → { id } when the floors hash still holds
  const waiverFor = new Map();
  for (const w of waivers) {
    if (typeof w.overridden_floors === 'string') { try { w.overridden_floors = JSON.parse(w.overridden_floors); } catch { /* shown raw */ } }
    if (!waiverFor.has(`${w.domain_id}|${w.path_id}`)) waiverFor.set(`${w.domain_id}|${w.path_id}`, w);
  }
  for (const d of domains) {
    const path = pathById.get(d.best_path_id);
    const w = path ? waiverFor.get(`${d.id}|${path.id}`) : null;
    if (path && w && w.decision_inputs_hash === P.floorInputsHash({ path, domain: d, policy, score: d.score })) activeWaiverFor.set(`${d.id}|${path.id}`, { id: w.id });
  }

  // account-wide fee: ONE payment approval covers the group — the lowest-id parked sibling carries the button
  const groupPrimary = new Map();
  for (const p of [...cardsFor].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (p.payment_group_id && !groupPrimary.has(p.payment_group_id)) groupPrimary.set(p.payment_group_id, p.id);
  }
  const groupSize = new Map();
  for (const p of cardsFor) if (p.payment_group_id) groupSize.set(p.payment_group_id, (groupSize.get(p.payment_group_id) || 0) + 1);

  const cards = cardsFor.map((p) => {
    const d = domainById.get(p.domain_id);
    const path = pathById.get(p.path_id) || pathById.get(d.best_path_id) || null;
    const onBestPath = Boolean(path && path.id === d.best_path_id);
    const shared = Boolean(path && path.fee_scope === 'account_wide' && p.payment_group_id);
    const ctx = onBestPath ? { path, domain: d, policy, score: d.score } : null;
    const mine = rows.filter((r) => r.prospect_id === p.id).map((r) => {
      let whyNot = onBestPath ? whyNotApprovable(r, path) : 'placement is not on the domain\'s current best path — the nightly bridge rotates it';
      // the same freshness test the click applies — a stale stamp never shows a button that can only 409
      if (!whyNot) whyNot = stalenessOf(r, ctx, activeWaiverFor.get(`${d.id}|${path.id}`) || null).reason;
      const sharedFee = shared && r.dimension === 'payment';
      const primary = !sharedFee || groupPrimary.get(p.payment_group_id) === p.id;
      return {
        id: r.id, dimension: r.dimension, instance_kind: r.instance_kind, instance_key: r.instance_key, level: r.level, reason: r.reason,
        decided_at: r.decided_at, satisfied_at: r.satisfied_at, satisfied_reason: r.satisfied_reason,
        action: actionFor(r), approved: r.approved, approval: r.approval,
        // the quote THIS row authorizes: a renewal instance is the renewal price, never the initial fee; null fails closed
        quote_cents: r.dimension === 'payment' && path ? (actionFor(r) === 'renewal' ? (Number.isSafeInteger(path.renewal_cost_cents) && path.renewal_cost_cents > 0 ? path.renewal_cost_cents : null) : (Number.isSafeInteger(path.estimated_cost_cents) && path.estimated_cost_cents > 0 ? path.estimated_cost_cents : null)) : null,
        approvable: whyNot === null && primary,
        why_not: whyNot || (primary ? null : `one approval covers the ${groupSize.get(p.payment_group_id)} locations sharing this fee — approve it on the first card`),
        shared_fee: sharedFee ? { group_id: p.payment_group_id, placements: groupSize.get(p.payment_group_id) } : null,
      };
    });
    return {
      placement: { id: p.id, target_page: p.target_page, location_key: p.location_key, link_type: p.link_type, outreach_status: p.outreach_status, claimed_at: p.claimed_at, updated_at: p.updated_at, payment_group_id: p.payment_group_id },
      domain: { id: d.id, domain: d.domain, agent_state: d.agent_state, score: d.score, score_reasons: d.score_reasons, spam_score: d.spam_score, domain_rating: d.domain_rating, organic_traffic: d.organic_traffic, referring_domains: d.referring_domains, competitors_linked: d.competitors_linked, source: d.source, discovery_priority: d.discovery_priority },
      path: path ? {
        id: path.id, on_best_path: onBestPath, acquisition_type: path.acquisition_type, link_type: path.link_type, submission_url: path.submission_url,
        expected_rel: path.expected_rel, confidence: path.confidence, payment_required: path.payment_required, estimated_cost_cents: path.estimated_cost_cents,
        renewal_cost_cents: path.renewal_cost_cents, renewal_period: path.renewal_period, currency: path.currency, fee_scope: path.fee_scope,
        account_required: path.account_required, legal_attestation: path.legal_attestation, legal_terms_hash: path.legal_terms_hash,
        legal_terms_url: legalTermsUrlOf(path),
        // the recipient a payment approval freezes (§3.6b: the COMPLETE canonical binding) — the owner must see it
        merchant_binding: path.payment_required && path.merchant_binding && typeof path.merchant_binding === 'object' ? {
          checkout_origin: path.merchant_binding.checkout_origin || null,
          processor_host: path.merchant_binding.processor && path.merchant_binding.processor.host ? path.merchant_binding.processor.host : null,
          merchant_account_id: path.merchant_binding.processor && path.merchant_binding.processor.merchant_account_id ? path.merchant_binding.processor.merchant_account_id : null,
          issuer_merchant_descriptor: path.merchant_binding.issuer_merchant_descriptor || null,
        } : null,
        agent_completable: path.agent_completable, execution_after_send: path.execution_after_send,
      } : null,
      // Reject / Watch apply while the domain is still the owner's to decide; once a sibling is approved or in flight
      // (lane-owned) those buttons would only ever 409 — the card says so instead
      decidable: !R.LANE_OWNED_STATES.includes(d.agent_state),
      // shown only while the bridge would still honour it: the same floors-hash test approveRow / activeWaiver apply
      waiver: path && activeWaiverFor.has(`${d.id}|${path.id}`) ? waiverFor.get(`${d.id}|${path.id}`) : null,
      d30_confidence: null, // step 7 (D30 loop) — no evidence yet
      price_tolerance_cents: policy.owner_price_tolerance_cents,
      rows: mine,
    };
  });
  cards.sort((a, b) => String(a.domain.domain).localeCompare(String(b.domain.domain)) || String(a.placement.location_key || '').localeCompare(String(b.placement.location_key || '')));
  return { cards };
}

// ---------------------------------------------------------------------------
// Approve — one dimension instance, frozen exactly as the owner saw it
// ---------------------------------------------------------------------------
async function approveRow(db, { authorityId, actor, approvedAmountCents = null, note = null, now = new Date(), bridge = null }) {
  if (!actor) refuse(400, 'an approving admin identity is required');
  const result = await db.transaction(async (trx) => {
    const probe = await trx(AUTH).where({ id: authorityId }).first('id', 'prospect_id');
    if (!probe) refuse(404, 'authority row not found');
    const placement = await trx('seo_link_prospects').where({ id: probe.prospect_id }).first();
    if (!placement || !placement.domain_id) refuse(409, 'placement is not bound to a registry domain');
    const named = await trx('seo_link_domains').where({ id: placement.domain_id }).first('id', 'domain');
    if (!named) refuse(404, 'registry domain not found');
    // the bridge's lock order: advisory domain lock, then row locks
    await lockProspectDomain(trx, named.domain);
    const row = await trx(AUTH).where({ id: authorityId }).forUpdate().first();
    const domain = await trx('seo_link_domains').where({ id: placement.domain_id }).forUpdate().first();
    if (!row || !domain) refuse(404, 'authority row not found');
    // the card must still BE a card under the lock: another tab's Reject / Watch, a worker claim or a Judge move
    // since the page loaded means this approval would authorize something the owner no longer sees
    const placementNow = await trx('seo_link_prospects').where({ id: placement.id }).forUpdate().first();
    if (!placementNow || placementNow.status !== PARKED || placementNow.parked_from_status !== PARKABLE || placementNow.claimed_at) refuse(409, `the placement is no longer awaiting your decision (${placementNow ? placementNow.status : 'gone'}) — refresh the queue`);
    if (!BRIDGE_STATES.includes(domain.agent_state)) refuse(409, `the domain is ${domain.agent_state.replace(/_/g, ' ')} — it left the queue; refresh`);
    Object.assign(placement, placementNow);
    await loadApprovals(trx, [row]);
    const whyNotLevel = whyNotApprovable(row);
    if (whyNotLevel) refuse(409, `not approvable: ${whyNotLevel}`);
    if (!domain.best_path_id || row.path_id !== domain.best_path_id) refuse(409, 'the placement is no longer on the domain\'s best path — the nightly bridge rotates it; refresh the queue');
    const path = await trx('seo_link_acquisition_paths').where({ id: domain.best_path_id }).first();
    if (!path || path.superseded_by || path.baseline === true) refuse(409, 'the path was superseded since the card — refresh the queue');
    const whyNotPath = whyNotApprovable(row, path);
    if (whyNotPath) refuse(409, `not approvable: ${whyNotPath}`);
    const { policy } = await P.loadPolicy(trx);
    const ctx = { path, domain, policy, score: domain.score, instanceKey: row.instance_key };
    // the card's frozen inputs must still be the live ones (§3.6b) — "an owner approved THESE numbers, not
    // whatever they became": the ONE test the listing applies before it shows a button
    const { waiver } = await activeWaiver(trx, domain.id, path.id, ctx);
    const { reason: stale, hash, pathRevision } = stalenessOf(row, ctx, waiver);
    if (stale) refuse(409, stale);

    const money = row.dimension === 'payment';
    let amounts = { approved_amount_cents: null, max_payable_cents: null };
    if (money) {
      if (path.payment_required !== true) refuse(409, 'the path no longer requires payment');
      if (path.currency !== 'USD') refuse(409, `checkout currency is ${path.currency}, not USD — an owner approval cannot change it`);
      // the amount is the OWNER'S statement, never a server default: a stale or direct client that omits it gets 400
      if (approvedAmountCents === null || approvedAmountCents === undefined || approvedAmountCents === '') refuse(400, 'approved_amount_cents is required for a payment approval (the card shows the quote; submit the amount you approve)');
      const cents = Number(approvedAmountCents);
      if (!Number.isSafeInteger(cents) || cents <= 0) refuse(400, 'approved_amount_cents must be a positive whole number of cents');
      if (cents > P.PG_INT_MAX) refuse(400, 'approved_amount_cents is out of range');
      const tolerance = Number(policy.owner_price_tolerance_cents) || 0;
      amounts = { approved_amount_cents: cents, max_payable_cents: Math.min(cents + tolerance, P.PG_INT_MAX) };
    }
    const action = actionFor(row);
    const actionHash = action === 'accept_terms' ? path.legal_terms_hash : action === 'renewal' ? row.instance_kind : null;
    const snapshot = { ...P.decisionInputs(row.dimension, ctx), ...(note ? { note: String(note).slice(0, 2000) } : {}) };
    // the exact agreement the owner read travels with EVERY approval on an attested path — the acceptance and the
    // payment it accompanies alike (§3.6b), never only the accept_terms instance
    if (action === 'accept_terms' || path.legal_attestation === true) snapshot.legal_terms_url = legalTermsUrlOf(path);
    // account-wide fee (§3.3): ONE approval, its prospect_id = the group anchor, attached to every sibling
    // payment row carrying the same instance / level / hash (the hash has no placement-specific field)
    const shared = money && path.fee_scope === 'account_wide' && placement.payment_group_id;
    const anchorId = shared ? placement.payment_group_id : placement.id;
    const [approval] = await trx('seo_link_approvals').insert({
      prospect_id: anchorId, path_id: path.id, path_revision: pathRevision, decision_inputs_hash: hash,
      money_action: money, decision: 'approved', authority: row.level, ...amounts, terms_snapshot: snapshot,
      dimension: row.dimension, action, instance_key: row.instance_key, action_hash: actionHash,
      approved_by: actor, approved_at: now, created_at: now, updated_at: now,
    }).returning('*');
    const attached = [row.id];
    if (shared) {
      // only siblings that are themselves CARDS on THIS path at THIS revision: parked from prospect, unleased, bound to
      // the best path, same per-dimension path_revision (an older stamp with a reverted-equal hash must not inherit an
      // approval the next bridge pass would invalidate for the whole group) — the hash carries no path identity, so a stale-path or in-flight row with an equal hash must never inherit
      // the owner's spending authority) — locked, like the clicked placement
      const siblings = (await trx('seo_link_prospects').where({ domain_id: domain.id, payment_group_id: placement.payment_group_id, path_id: path.id, status: PARKED, parked_from_status: PARKABLE }).whereNull('claimed_at').forUpdate().select('id'))
        .map((s) => s.id).filter((id) => id !== placement.id);
      if (siblings.length) {
        const candidates = await loadApprovals(trx, await trx(AUTH).whereIn('prospect_id', siblings).where({ path_id: path.id, path_revision: pathRevision, dimension: 'payment', instance_key: row.instance_key, level: row.level, decision_inputs_hash: hash }).whereNull('ended_at').whereNull('satisfied_at'));
        for (const c of candidates) if (!c.approved) attached.push(c.id);
      }
    }
    await trx(AUTH).whereIn('id', attached).update({ approval_id: approval.id, updated_at: now });
    const prospectIds = [...new Set([placement.id, ...(await trx(AUTH).whereIn('id', attached).select('prospect_id')).map((r) => r.prospect_id)])];
    // the nightly `stale` rule keys on this — the inline run below is best-effort
    await trx('seo_link_prospects').whereIn('id', prospectIds).update({ updated_at: now });
    return { approval, attached, domainId: domain.id, prospectIds };
  });
  const run = bridge || require('./link-authority-bridge').runAuthorityBridge;
  const ran = await bestEffortBridge(run, db, { domainIds: [result.domainId], notify: noop, now });
  return { ...result, bridge: ran };
}

// ---------------------------------------------------------------------------
// Reject / Watch — the domain decision, audited per approvable row
// ---------------------------------------------------------------------------
async function decideDomain(db, { domainId, decision, actor, note = null, now = new Date() }) {
  if (!actor) refuse(400, 'a deciding admin identity is required');
  const action = decision === 'rejected' ? 'reject' : decision === 'watch' ? 'watch' : null;
  if (!action) refuse(400, 'decision must be rejected or watch');
  return db.transaction(async (trx) => {
    const named = await trx('seo_link_domains').where({ id: domainId }).first('id', 'domain');
    if (!named) refuse(404, 'registry domain not found');
    await lockProspectDomain(trx, named.domain);
    const domain = await trx('seo_link_domains').where({ id: domainId }).forUpdate().first();
    if (!domain) refuse(404, 'registry domain not found');
    if (R.LANE_OWNED_STATES.includes(domain.agent_state)) refuse(409, `agent_state '${domain.agent_state}' is lane-owned: a placement is already approved or in flight — reject or watch it from the board first`);
    if (!BRIDGE_STATES.includes(domain.agent_state)) refuse(409, `agent_state '${domain.agent_state}' is not awaiting your decision`);
    const placements = await trx('seo_link_prospects').where({ domain_id: domain.id }).select('id', 'path_id', 'status');
    const ids = placements.map((p) => p.id);
    const open = ids.length ? await loadApprovals(trx, await trx(AUTH).whereIn('prospect_id', ids).whereNull('ended_at').whereNull('satisfied_at')) : [];
    const audited = open.filter((r) => R.APPROVABLE_LEVELS.includes(r.level) && !r.approved);
    const pathIds = [...new Set(audited.map((r) => r.path_id).filter(Boolean))];
    const paths = pathIds.length ? await trx('seo_link_acquisition_paths').whereIn('id', pathIds) : [];
    const pathById = new Map(paths.map((p) => [p.id, p]));
    const { policy } = await P.loadPolicy(trx);
    const approvals = [];
    for (const r of audited) {
      const path = pathById.get(r.path_id);
      const snapshot = path ? { ...P.decisionInputs(r.dimension, { path, domain, policy, score: domain.score, instanceKey: r.instance_key }), ...(path.legal_attestation === true ? { legal_terms_url: legalTermsUrlOf(path) } : {}) } : { dimension: r.dimension, instance_key: r.instance_key };
      const [a] = await trx('seo_link_approvals').insert({
        prospect_id: r.prospect_id, path_id: r.path_id, path_revision: r.path_revision, decision_inputs_hash: r.decision_inputs_hash,
        money_action: r.dimension === 'payment', decision, authority: r.level, approved_amount_cents: null, max_payable_cents: null,
        terms_snapshot: { ...snapshot, ...(note ? { note: String(note).slice(0, 2000) } : {}) },
        dimension: r.dimension, action: actionFor(r), instance_key: r.instance_key, action_hash: null,
        approved_by: actor, approved_at: now, created_at: now, updated_at: now,
      }).returning('id');
      approvals.push(a.id);
    }
    const applied = await R.applyRegistryAction(trx, domain, action, now);
    if (!applied.updated) refuse(409, 'the domain moved to a lane-owned state meanwhile — refresh the queue');
    if (ids.length) await trx('seo_link_prospects').whereIn('id', ids).update({ updated_at: now });
    return { domainId: domain.id, domain: domain.domain, agent_state: applied.nextState, watch_recheck_at: applied.watchRecheckAt, audited: approvals.length, placements: ids.length };
  });
}

// ---------------------------------------------------------------------------
// Acquire anyway — the §6.3 1b floor waiver
// ---------------------------------------------------------------------------
async function acquireAnyway(db, { domainId, actor, note = null, now = new Date(), bridge = null }) {
  if (!actor) refuse(400, 'a waiving admin identity is required');
  const result = await db.transaction(async (trx) => {
    const named = await trx('seo_link_domains').where({ id: domainId }).first('id', 'domain');
    if (!named) refuse(404, 'registry domain not found');
    await lockProspectDomain(trx, named.domain);
    const domain = await trx('seo_link_domains').where({ id: domainId }).forUpdate().first();
    if (!domain) refuse(404, 'registry domain not found');
    // waivable = the DENY verdict the bridge wrote (or the owner's own Reject): a lane-owned, new, investigating or
    // watching domain has nothing a floor waiver may override, and a forged / stale request must not force a
    // bridge run over an authorized or in-flight lane
    if (domain.agent_state !== 'rejected') refuse(409, `only a rejected domain can be acquired anyway (this one is ${String(domain.agent_state).replace(/_/g, ' ')})`);
    if (!domain.best_path_id) refuse(409, 'no reproducible acquisition path yet — investigate first');
    const path = await trx('seo_link_acquisition_paths').where({ id: domain.best_path_id }).first();
    if (!path || path.superseded_by || path.baseline === true) refuse(409, 'the best path is superseded or a baseline placeholder — re-investigate first');
    const { policy } = await P.loadPolicy(trx);
    const ctx = { path, domain, policy, score: domain.score };
    const invalid = P.validityFailure(path, domain, domain.score);
    if (invalid) refuse(409, `not actionable by anyone until re-investigated: ${invalid}`);
    const f = P.floorInputs(ctx);
    const failing = [];
    if (num(f.spam_score) > f.max_spam_score) failing.push({ floor: 'spam_score', value: f.spam_score, threshold: f.max_spam_score });
    if (num(f.confidence) < f.min_path_confidence) failing.push({ floor: 'confidence', value: f.confidence, threshold: f.min_path_confidence });
    if (num(f.score) < f.min_score) failing.push({ floor: 'score', value: f.score, threshold: f.min_score });
    if (!failing.length) refuse(409, 'every quality floor passes — there is nothing to waive; the nightly bridge decides it normally');
    const replaced = await trx('seo_link_floor_waivers').where({ domain_id: domain.id, path_id: path.id }).whereNull('invalidated_at')
      .update({ invalidated_at: now, invalidated_reason: 'replaced by a newer waiver', updated_at: now });
    const [waiver] = await trx('seo_link_floor_waivers').insert({
      // pg serialises a JS array as a Postgres ARRAY, not JSON — jsonb needs the string (an object would be fine)
      domain_id: domain.id, path_id: path.id, overridden_floors: JSON.stringify(failing), decision_inputs_hash: P.floorInputsHash(ctx),
      note: note ? String(note).slice(0, 2000) : null, approved_by: actor, approved_at: now, created_at: now, updated_at: now,
    }).returning('*');
    await trx('seo_link_domains').where({ id: domain.id }).update({ updated_at: now });
    return { waiver, replaced, domainId: domain.id, domain: domain.domain, floors: failing };
  });
  const run = bridge || require('./link-authority-bridge').runAuthorityBridge;
  const ran = await bestEffortBridge(run, db, { domainIds: [result.domainId], notify: noop, now });
  // what now awaits the owner on this domain (parked siblings park nothing new, so `parked` alone undercounts)
  const ids = (await db('seo_link_prospects').where({ domain_id: result.domainId }).select('id')).map((p) => p.id);
  const open = ids.length ? await loadApprovals(db, await db(AUTH).whereIn('prospect_id', ids).whereNull('ended_at').whereNull('satisfied_at')) : [];
  const awaiting = open.filter((r) => typeof r.level === 'string' && r.level.startsWith('OWNER_') && !r.approved).length;
  const state = (await db('seo_link_domains').where({ id: result.domainId }).first('agent_state'))?.agent_state || null;
  return { ...result, bridge: ran, awaiting, agent_state: state };
}

module.exports = { listOwnerQueue, approveRow, decideDomain, acquireAnyway, whyNotApprovable, actionFor, OwnerQueueError, APPROVE_HERE };
