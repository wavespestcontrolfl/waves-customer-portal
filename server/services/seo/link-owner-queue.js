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
const { BRIDGE_STATES, groupMismatch, expectedLocations, paidPlacementIds } = require('./link-authority-selection');
const M = require('./link-outreach-mandate');

const AUTH = 'seo_link_placement_authorities';
const PARKED = 'awaiting_owner';
const PARKABLE = 'prospect';
// §3.3b: two cards the bridge never parks — an outreach path's DEFERRED payment surfaces once the publisher exposes a
// checkout (`ready_for_payment`), and a payment instance sits on a placed / live / indexed placement the Judge owns — a
// renewal, or a paid outreach placement's INITIAL fee the §8 reconciliation promoted while the fee still awaits the owner
const CHECKOUT = 'ready_for_payment';
const PLACED_STATUSES = Object.freeze(['placed', 'live', 'indexed']);
// …and the §6.4 FOLLOW-UP: an owner-level communication/followup row on a contacted conversation (or a Judge-owned one
// on a submit-first path — the sender narrows it) is the owner's send from here, without any park (a contacted row
// is never parked: its lifecycle is the conversation's)
const CONTACTED = 'contacted';
const CARD_STATUSES = Object.freeze([PARKABLE, PARKED, CHECKOUT, CONTACTED, 'negotiating', ...PLACED_STATUSES]);
const isFollowUp = (row) => row.dimension === 'communication' && row.instance_kind === 'followup';
const isOwner = (level) => typeof level === 'string' && level.startsWith('OWNER_');
const noop = () => {};

class OwnerQueueError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const refuse = (status, message) => { throw new OwnerQueueError(status, message); };

// The levels this PR's Approve button covers (plan §6.1; the rest of
// APPROVABLE_LEVELS is deliberately excluded — see whyNotApprovable).
const APPROVE_HERE = Object.freeze({
  OWNER_FREE: ['execution'], OWNER_ACCOUNT: ['execution'], OWNER_MEMBERSHIP: ['execution'],
  OWNER_LEGAL: ['execution', 'communication'], // the accept_terms instance, and the send (the click IS the approval, §6.3 2c)
  OWNER_PAYMENT: ['payment'],
  OWNER_OUTREACH: ['communication'],
});

// §3.6b action per (dimension, instance kind)
function actionFor(row) {
  if (row.dimension === 'execution') return row.instance_kind === 'terms' ? 'accept_terms' : 'acquire';
  if (row.dimension === 'payment') return row.instance_kind === '-' ? 'purchase' : 'renewal';
  return row.instance_kind === 'followup' ? 'outreach_followup' : 'outreach_send';
}

// Which of a placement's rows the owner decides from the queue in the placement's CURRENT status (plan §3.3b) — the
// listing and the locked click apply the same test: parked from prospect ⇒ every row; at the publisher's checkout ⇒
// the deferred payment; placed / live / indexed ⇒ its payment instance (a renewal, or the initial fee of a paid outreach
// placement the reconciliation promoted before the fee settled — plan §6.4). null = decided here.
function whyNotHere(placement, row, path, execution) {
  const { submitStepOwed } = require('./link-prospect-outreach');
  if (placement.status === PARKED) return placement.parked_from_status === PARKABLE ? null : `parked from ${placement.parked_from_status} — not the queue's to decide`;
  if (placement.status === CHECKOUT) return row.dimension === 'payment' ? null : 'the placement is at the publisher\'s checkout — only its payment is decided here';
  // A sent initial pitch unlocks its deferred acquisition decision without parking the conversation.
  if (['contacted', 'negotiating'].includes(placement.status) && placement.outreach_status === 'sent'
    && row.dimension === 'execution' && row.instance_kind === '-') return null;
  if (placement.status === CONTACTED) return isFollowUp(row) ? null : 'the placement is contacted — only its follow-up is decided here';
  if (PLACED_STATUSES.includes(placement.status)) return row.dimension === 'payment' || isFollowUp(row) || (row.dimension === 'communication' && P.submitFirst(path || {}) && !submitStepOwed(path, execution)) ? null : `the placement is ${placement.status} — only its payment or follow-up is decided here`;
  return `the placement is ${placement.status} — not awaiting your decision`;
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
  // a send is approved by SENDING it (the sender writes the approval bound to the draft hash): the initial pitch, or
  // the follow-up (§6.4) — the queue's Send action carries the row's kind to the sender
  if (row.dimension === 'communication' && !['-', 'followup'].includes(row.instance_kind)) return `${row.instance_kind}: not a send the queue offers`;
  if (row.level === P.LEVELS.OWNER_HUMAN_STEP) return 'a human performs this step; the runner checkpoint records it';
  // the bridge parks a fee-scope change after payment activity as OWNER_INPUT_REQUIRED with its regroup reason: that is
  // not a quote to enter — the owner's regroup (step 5) is required, and the nightly does not select the domain until then
  if (row.level === P.LEVELS.OWNER_INPUT_REQUIRED) return /regroup/.test(String(row.reason)) ? REGROUP_HELD : 'price entry required — re-investigate with a USD quote';
  if (row.level === P.LEVELS.OWNER_MANUAL_PAYMENT) return 'settled outside the system at checkout';
  if (!(APPROVE_HERE[row.level] || []).includes(row.dimension)) return `${row.level} is not approvable from the queue`;
  // an attested path whose agreement the owner cannot open (no terms url in the evidence) authorizes nothing —
  // neither the acceptance nor the payment it accompanies — until re-investigation restores the url
  if (path && path.legal_attestation === true && !legalTermsUrlOf(path)) return 'the agreement is not viewable (no terms url in the evidence) — re-investigate before approving';
  // a renewal instance is approvable only against a verified renewal quote: with none on the path the owner would be
  // authorizing a charge the investigator never priced — price entry (re-investigation with the renewal quote) comes first
  if (path && row.dimension === 'payment' && actionFor(row) === 'renewal' && !(Number.isSafeInteger(path.renewal_cost_cents) && path.renewal_cost_cents > 0)) return 'renewal price not verified — re-investigate with the renewal quote before approving';
  // sending the pitch would itself accept the publisher's terms: the co-transactional acceptance is not built (§3.3b)
  if (path && row.dimension === 'communication' && path.terms_accepted_by_send === true) return 'sending this pitch accepts the publisher\'s terms — not available until the terms acceptance ships';
  return null;
}

// The card's frozen inputs vs the live ones (§3.6b) — ONE test for the listing and the click: the hash, the
// per-dimension path revision and the level the policy yields now must all still match, else the row waits
// for the nightly bridge to re-decide it. A renewal instance (`2027:1`, `annual:1`) is opened by the renewal
// claim, not by the decision function — it takes the payment dimension's current `-` verdict.
function stalenessOf(row, ctx, waiver, held = false) {
  const hash = P.decisionInputsHash(row.dimension, { ...ctx, instanceKey: row.instance_key });
  const pathRevision = pathRevisionFor(ctx.path, row.dimension);
  // a HELD domain (a payment-input change under a purchase — plan §3.3) is suppressed by the nightly selection: the
  // stale stamp is not re-decided by any nightly run, the owner's regroup / shape review is what moves it
  if (hash !== row.decision_inputs_hash || Number(row.path_revision) !== pathRevision) return { reason: held ? REGROUP_HELD : 'inputs changed since the card — the nightly bridge re-decides it; refresh the queue', hash, pathRevision };
  // the follow-up instance is decided on the FOLLOW-UP's draft (ctx.followUpClean), the initial on the pitch's
  const followUp = isFollowUp(row);
  const decided = P.decideAuthority({ ...ctx, monthSpendCents: 0, d30Confidence: null, draftClean: (followUp ? ctx.followUpClean : ctx.draftClean) === true, followUp, waiver });
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
    // a CONSUMED approval on a row still unsatisfied (its execution reported a terminal failure / ambiguity and the
    // instance awaits rotation) is spent, not live authority (§3.6b) — the retry obtains a fresh one; on a satisfied
    // row it is the durable prerequisite it reads as
    r.approved = Boolean(a && a.decision === 'approved' && !a.invalidated_at && (!a.consumed_at || r.satisfied_at));
  }
  return rows;
}

async function activeWaiver(q, domainId, pathId, ctx) {
  const w = await q('seo_link_floor_waivers').where({ domain_id: domainId, path_id: pathId }).whereNull('invalidated_at').orderBy('approved_at', 'desc').first();
  if (!w) return { waiver: null, row: null };
  return { waiver: w.decision_inputs_hash === P.floorInputsHash(ctx) ? { id: w.id } : null, row: w };
}

// The quality floors a domain's best path fails right now — what Acquire anyway waives. Empty ⇒ nothing to waive: the
// registry row hides the button (`waivable: false`) and a click is refused. A superseded / baseline / invalid path is
// never waivable (it is not actionable by anyone until re-investigated).
function failingFloors(ctx) {
  const f = P.floorInputs(ctx);
  const failing = [];
  if (num(f.spam_score) > f.max_spam_score) failing.push({ floor: 'spam_score', value: f.spam_score, threshold: f.max_spam_score });
  if (num(f.confidence) < f.min_path_confidence) failing.push({ floor: 'confidence', value: f.confidence, threshold: f.min_path_confidence });
  if (num(f.score) < f.min_score) failing.push({ floor: 'score', value: f.score, threshold: f.min_score });
  return failing;
}
function waivableFloors(path, domain, policy) {
  if (!path || path.superseded_by || path.baseline === true) return [];
  if (P.validityFailure(path, domain, domain.score)) return [];
  return failingFloors({ path, domain, policy, score: domain.score });
}

// The bridge run after a click is BEST-EFFORT and runs after the click's transaction committed: a failure here
// (policy load, selection, the cron lock, a DB blip) must not turn a recorded decision into a 500 — the bumped
// updated_at already guarantees the nightly run picks the domain up. Reported as skipped: 'failed'.
async function bestEffortBridge(run, db, opts) {
  try {
    const out = await run(db, opts);
    // the bridge catches a per-domain failure itself and resolves with it in `errors` — to the click that is the same
    // deferral as a thrown failure: the decision is recorded, the nightly run retries the domain
    if (Array.isArray(out.errors) && out.errors.length) return { ...out, skipped: 'failed', error: out.errors.join('; ') };
    return out;
  } catch (err) {
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

const REGROUP_HELD = 'fee scope or lane shape changed after payment activity — held for the owner\'s regroup (step 5); the nightly bridge does not select this domain until then';
// the selection module's HOLD, read the same way it reads it (plan §3.3): a paid placement outside the lane's shape, or
// a fee_scope the paid group no longer matches — `all` = every placement of the domain, `paid` = paidPlacementIds
function heldFor(domain, path, all, paid) {
  if (!domain.best_path_id || !path) return false;
  const expected = expectedLocations(path);
  const mine = all.filter((p) => expected.includes(p.location_key));
  return all.some((p) => paid.has(p.id)) && (all.some((p) => !expected.includes(p.location_key) && paid.has(p.id)) || groupMismatch(path, mine));
}

function pathRevisionFor(path, dimension) { return Number(path[`revision_${dimension}`] ?? path.revision ?? 1); }
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

// ---------------------------------------------------------------------------
// The queue — one card per parked placement whose domain still awaits the owner
// ---------------------------------------------------------------------------
async function listOwnerQueue(db) {
  const { policy } = await P.loadPolicy(db);
  const uncertain = await db('seo_link_attempts').where({ action: 'submit', outcome: 'submit_ambiguous' }).select('id', 'prospect_id', 'evidence_url', 'updated_at');
  const candidates = await db('seo_link_prospects').where((q) => q.whereIn('status', [...CARD_STATUSES])
    .orWhere((held) => held.whereIn('id', uncertain.map((a) => a.prospect_id)))).whereNotNull('domain_id')
    .select('id', 'domain_id', 'path_id', 'target_page', 'live_url', 'location_key', 'link_type', 'payment_group_id', 'status', 'parked_from_status', 'outreach_status', 'outreach_draft_attempts', 'outreach_to_email', 'outreach_subject', 'outreach_body', 'follow_up_status', 'follow_up_subject', 'follow_up_body', 'follow_up_skipped_reason', 'claimed_at', 'updated_at', 'quality_signals'); // follow_up_skipped_reason: followUpReview reads the owner-routing markers from it — the card must judge the SAME inputs as the bridge
  const uncertainById = new Map(await Promise.all(uncertain.map(async (a) => [a.prospect_id, { ...a, evidence_url: await require('./signup-evidence').getEvidenceUrl(a.evidence_url, { expiresIn: 900 }) }])));
  const liveRows = candidates.length ? await db(AUTH).whereIn('prospect_id', candidates.map((p) => p.id)).whereNull('ended_at') : [];
  const executionById = new Map(liveRows.filter((r) => r.dimension === 'execution' && r.instance_kind === '-').map((r) => [r.prospect_id, r]));
  const domains = await db('seo_link_domains').whereIn('id', [...new Set(candidates.map((p) => p.domain_id))])
    .select('id', 'domain', 'agent_state', 'score', 'score_reasons', 'spam_score', 'domain_rating', 'organic_traffic', 'referring_domains', 'competitors_linked', 'best_path_id', 'source', 'discovery_priority');
  const domainById = new Map(domains.map((d) => [d.id, d]));
  const pathIds = [...new Set([...domains.map((d) => d.best_path_id), ...candidates.map((p) => p.path_id)].filter(Boolean))];
  const paths = pathIds.length ? await db('seo_link_acquisition_paths').whereIn('id', pathIds) : [];
  const pathById = new Map(paths.map((p) => [p.id, p]));
  // a parked prospect is a card outright; a checkout / placed placement only while an OPEN owner-level row it decides
  // here exists — otherwise every placed link would be a card with nothing to click
  const { SENDABLE_STATUSES, lateSend, submitStepOwed } = require('./link-prospect-outreach');
  const exhaustedDraft = (p) => p.path_id && domainById.get(p.domain_id)?.best_path_id === p.path_id
    && (SENDABLE_STATUSES.includes(p.status) || (lateSend(p, pathById.get(p.path_id)) && !submitStepOwed(pathById.get(p.path_id), executionById.get(p.id))))
    && Number(p.outreach_draft_attempts) >= require('./link-prospect-worker').MAX_ATTEMPTS
    && !['drafted', 'sending', 'sent', 'send_error'].includes(p.outreach_status);
  const parked = candidates.filter((p) => (p.quality_signals?.outreach_match_ambiguous || exhaustedDraft(p) || uncertainById.has(p.id) || (p.status === PARKED ? p.parked_from_status === PARKABLE
    : liveRows.some((r) => r.prospect_id === p.id && !r.satisfied_at && isOwner(r.level) && whyNotHere(p, r, pathById.get(p.path_id), executionById.get(p.id)) === null))));
  if (!parked.length) return { cards: [] };
  const matchIds = [...new Set(parked.map((p) => p.quality_signals?.outreach_match_ambiguous).filter(Boolean))];
  const matchRows = matchIds.length ? await db('seo_backlinks').whereIn('id', matchIds).where({ status: 'active' }).select('id', 'source_url') : [];
  const matchById = new Map(matchRows.map((b) => [b.id, b]));
  const eligibleDomains = new Set(domains.filter((d) => BRIDGE_STATES.includes(d.agent_state)).map((d) => d.id));
  const cardsFor = parked.filter((p) => domainById.has(p.domain_id) && (eligibleDomains.has(p.domain_id) || uncertainById.has(p.id)));
  if (!cardsFor.length) return { cards: [] };
  // the selection's hold, per domain: EVERY placement of the domain (not only the cards) against its best path
  const allPlacements = await db('seo_link_prospects').whereIn('domain_id', domains.map((d) => d.id)).select('id', 'domain_id', 'location_key', 'payment_group_id');
  const paid = await paidPlacementIds(db, allPlacements.map((p) => p.id));
  // a card's path is the placement's OWN (`path_id`) — never the domain's best path standing in for a deleted one
  // (ON DELETE SET NULL): a substituted path would show the replacement's price or terms as the card's, and the click
  // refuses it anyway; the card reads as awaiting the bridge's rotation instead
  const heldDomain = new Set(domains.filter((d) => heldFor(d, pathById.get(d.best_path_id), allPlacements.filter((p) => p.domain_id === d.id), paid)).map((d) => d.id));
  const cardIds = new Set(cardsFor.filter((p) => eligibleDomains.has(p.domain_id) && CARD_STATUSES.includes(p.status)).map((p) => p.id));
  const rows = await loadApprovals(db, liveRows.filter((r) => cardIds.has(r.prospect_id)));
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

  // account-wide fee: ONE payment approval covers the group — the button sits on the lowest-id sibling whose payment
  // row can be approved NOW (on the domain's current best path, fresh); a stale sibling that merely sorts first would
  // otherwise hide the button from the whole group until the nightly bridge rotates it. No such sibling ⇒ the lowest
  // id, so the "approve it on the first card" pointer still names one card.
  const freshPayment = (p) => {
    const d = domainById.get(p.domain_id);
    const path = pathById.get(p.path_id) || null;
    // a LEASED card cannot be the primary: its click is the lease 409 and every unleased sibling would defer to it
    if (p.claimed_at || !path || path.id !== d.best_path_id) return false;
    const ctx = { path, domain: d, policy, score: d.score, draftClean: M.draftReview(p).clean };
    return rows.some((r) => r.prospect_id === p.id && r.dimension === 'payment' && r.path_id === path.id && whyNotApprovable(r, path) === null && whyNotHere(p, r, pathById.get(p.path_id), executionById.get(p.id)) === null && !stalenessOf(r, ctx, activeWaiverFor.get(`${d.id}|${path.id}`) || null, heldDomain.has(d.id)).reason);
  };
  const groupPrimary = new Map();
  const byId = [...cardsFor].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const p of byId) if (p.payment_group_id && !groupPrimary.has(p.payment_group_id) && freshPayment(p)) groupPrimary.set(p.payment_group_id, p.id);
  for (const p of byId) if (p.payment_group_id && !groupPrimary.has(p.payment_group_id)) groupPrimary.set(p.payment_group_id, p.id);
  // what ONE approval from the primary covers: the siblings the click attaches to (unleased cards on the same path whose
  // payment row matches the primary's revision, level, key and hash and is not yet approved) — never the raw group
  // size, which would count a stale-path or leased sibling the approval will not reach
  const coveredByGroup = new Map();
  for (const [groupId, primaryId] of groupPrimary) {
    const p = cardsFor.find((x) => x.id === primaryId);
    const d = domainById.get(p.domain_id);
    const path = pathById.get(p.path_id) || null;
    const lead = path ? rows.find((r) => r.prospect_id === p.id && r.dimension === 'payment' && !r.satisfied_at) : null;
    const attachable = (s) => s.payment_group_id === groupId && s.path_id === path.id && !s.claimed_at
      && rows.some((r) => r.prospect_id === s.id && r.dimension === 'payment' && r.path_id === path.id && r.instance_key === lead.instance_key && r.level === lead.level && r.decision_inputs_hash === lead.decision_inputs_hash && Number(r.path_revision) === Number(lead.path_revision) && !r.satisfied_at && !r.approved);
    coveredByGroup.set(groupId, lead ? cardsFor.filter((s) => s.id === p.id || attachable(s)).length : 1);
  }

  // §13 — the recipient review the owner sees before a send click; best-effort here (the click re-runs it under the
  // lock and fails closed on an error), computed once per drafted card with a sendable communication row
  const reviewFor = new Map();
  // the draft each communication row would send: the pitch, or the follow-up (§6.4)
  const draftReady = (p, r) => (isFollowUp(r) ? p.follow_up_status : p.outreach_status) === 'drafted';
  const sendable = cardsFor.filter((p) => p.outreach_to_email && rows.some((r) => r.prospect_id === p.id && r.dimension === 'communication' && !r.satisfied_at && isOwner(r.level) && draftReady(p, r)));
  if (sendable.length) {
    try {
      const byEmail = await M.reviewByEmail(db, sendable.map((p) => p.outreach_to_email)); // one batch, not a query per card
      for (const p of sendable) reviewFor.set(p.id, byEmail.get(p.outreach_to_email) || null);
    } catch (err) {
      for (const p of sendable) reviewFor.set(p.id, { kind: 'error', recipient: p.outreach_to_email, matched: [], lookup_hash: null, error: err.message });
    }
  }
  // §13 on a FOLLOW-UP whose thread recipient is a customer contact: there is no other address to take (the pitch's
  // counterpart is re-addressed on the board), so the sender's terminal settlement applies here too — skipped now,
  // instead of an unusable card holding the conversation and the domain open forever; the nightly ends the instance
  // (followUpPending excludes a skipped follow-up). CAS on the drafted state, inside the sender's helper.
  for (const p of sendable) {
    if ((reviewFor.get(p.id) || {}).kind !== 'customer' || p.follow_up_status !== 'drafted') continue;
    if (!rows.some((r) => r.prospect_id === p.id && isFollowUp(r) && !r.satisfied_at && isOwner(r.level))) continue;
    if (await require('./link-prospect-outreach').closeCustomerRecipientFollowUp(db, p.id)) Object.assign(p, { follow_up_status: 'skipped', follow_up_skipped_reason: 'customer_recipient' });
  }
  // the send click's inputs (§6.4 / §13) on a communication row: the draft the click sends — the pitch, or the
  // follow-up — its review, the recipient match to acknowledge; `hash` travels back with the click: the claim sends
  // only the text the card displayed (§3.6b)
  const draftBlock = (p, r, reviews) => (isFollowUp(r)
    ? { to: p.outreach_to_email || null, subject: p.follow_up_subject || null, body: p.follow_up_body || null, hash: M.followUpHash(p), review: reviews.followUp, recipient_review: reviewFor.get(p.id) || null, follow_up: true }
    : { to: p.outreach_to_email || null, subject: p.outreach_subject || null, body: p.outreach_body || null, hash: M.draftHash(p), review: reviews.draft, recipient_review: reviewFor.get(p.id) || null });
  const noDraftYet = (r) => (isFollowUp(r) ? 'no follow-up draft to send — the drafter composes it once it is due' : 'no draft to send — draft the pitch on the Link Building board first');
  const cards = cardsFor.map((p) => {
    const d = domainById.get(p.domain_id);
    const path = pathById.get(p.path_id) || null;
    const onBestPath = Boolean(path && path.id === d.best_path_id);
    const shared = Boolean(path && path.fee_scope === 'account_wide' && p.payment_group_id);
    const reviews = { draft: M.draftReview(p), followUp: M.followUpReview(p) };
    const ctx = onBestPath ? { path, domain: d, policy, score: d.score, draftClean: reviews.draft.clean, followUpClean: reviews.followUp.clean } : null;
    const mine = rows.filter((r) => r.prospect_id === p.id).map((r) => {
      // the lease is the click's first refusal — a leased card never shows a button that can only 409
      // a row decided on a PRIOR path (the placement moved to the best path, its instances not yet rotated) is judged
      // against nothing here — the click's explicit row-path check refuses it, so the card never offers it
      let whyNot = !onBestPath ? 'placement is not on the domain\'s current best path — the nightly bridge rotates it'
        : r.path_id !== path.id ? 'the step was decided on a prior path — the nightly bridge rotates it'
          : (whyNotApprovable(r, path) || whyNotHere(p, r, pathById.get(p.path_id), executionById.get(p.id)) || (p.claimed_at ? 'leased to a worker — refresh after it reports' : null));
      // a follow-up closed above (or by the sender) for a customer recipient says so, not "no draft"
      if (!whyNot && isFollowUp(r) && p.follow_up_status === 'skipped' && p.follow_up_skipped_reason === 'customer_recipient') whyNot = 'the recipient is a customer contact — the follow-up is closed (the thread\'s recipient cannot change)';
      // a send needs a draft to send (the bridge parks the row only once one exists; a re-draft in flight clears it)
      if (!whyNot && r.dimension === 'communication' && !draftReady(p, r)) whyNot = noDraftYet(r);
      if (!whyNot && r.dimension === 'communication' && (reviewFor.get(p.id) || {}).kind === 'customer') whyNot = isFollowUp(r) ? 'the recipient is a customer contact — the follow-up is closed (the thread\'s recipient cannot change)' : 'the recipient is a customer contact — outreach never goes to a customer; re-draft to another address';
      // the same freshness test the click applies — a stale stamp never shows a button that can only 409, and an
      // APPROVED row whose inputs moved since (price, policy, revision) is shown as awaiting the bridge's re-decision
      // rather than as live spending authority (the bridge invalidates it on its next pass)
      const stale = onBestPath && (whyNot === null || whyNot === 'approved') ? stalenessOf(r, ctx, activeWaiverFor.get(`${d.id}|${path.id}`) || null, heldDomain.has(d.id)).reason : null;
      if (!whyNot && stale) whyNot = stale;
      const sharedFee = shared && r.dimension === 'payment';
      const primary = !sharedFee || groupPrimary.get(p.payment_group_id) === p.id;
      return {
        id: r.id, dimension: r.dimension, instance_kind: r.instance_kind, instance_key: r.instance_key, level: r.level, reason: r.reason,
        decided_at: r.decided_at, satisfied_at: r.satisfied_at, satisfied_reason: r.satisfied_reason,
        action: actionFor(r), approved: r.approved, approval: r.approval, approval_stale: r.approved && stale ? stale : null,
        // the quote THIS row authorizes: a renewal instance is the renewal price, never the initial fee; null fails closed
        quote_cents: r.dimension === 'payment' && path ? (actionFor(r) === 'renewal' ? (Number.isSafeInteger(path.renewal_cost_cents) && path.renewal_cost_cents > 0 ? path.renewal_cost_cents : null) : (Number.isSafeInteger(path.estimated_cost_cents) && path.estimated_cost_cents > 0 ? path.estimated_cost_cents : null)) : null,
        approvable: whyNot === null && primary,
        why_not: whyNot || (primary ? null : `one approval covers the ${coveredByGroup.get(p.payment_group_id)} locations sharing this fee — approve it on the first card`),
        shared_fee: sharedFee ? { group_id: p.payment_group_id, placements: coveredByGroup.get(p.payment_group_id) } : null,
        draft: r.dimension === 'communication' ? draftBlock(p, r, reviews) : undefined,
      };
    });
    return {
      submission_ambiguity: uncertainById.get(p.id) || null,
      outreach_draft_exhausted: eligibleDomains.has(d.id) && CARD_STATUSES.includes(p.status) && exhaustedDraft(p),
      backlink_match: eligibleDomains.has(d.id) && CARD_STATUSES.includes(p.status) ? matchById.get(p.quality_signals?.outreach_match_ambiguous) || null : null,
      placement: { id: p.id, target_page: p.target_page, live_url: p.live_url, location_key: p.location_key, link_type: p.link_type, status: p.status, outreach_status: p.outreach_status, follow_up_status: p.follow_up_status, claimed_at: p.claimed_at, updated_at: p.updated_at, payment_group_id: p.payment_group_id },
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
      decidable: eligibleDomains.has(d.id) && CARD_STATUSES.includes(p.status) && !R.LANE_OWNED_STATES.includes(d.agent_state),
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
    const path = await trx('seo_link_acquisition_paths').where({ id: domain.best_path_id }).first();
    const notHere = !placementNow ? 'gone' : placementNow.claimed_at ? `leased at ${placementNow.status}` : whyNotHere(placementNow, row, path);
    if (notHere) refuse(409, `the placement is no longer awaiting your decision (${notHere}) — refresh the queue`);
    if (!BRIDGE_STATES.includes(domain.agent_state)) refuse(409, `the domain is ${domain.agent_state.replace(/_/g, ' ')} — it left the queue; refresh`);
    Object.assign(placement, placementNow);
    await loadApprovals(trx, [row]);
    const whyNotLevel = whyNotApprovable(row);
    if (whyNotLevel) refuse(409, `not approvable: ${whyNotLevel}`);
    // a communication row is approved by SENDING (sendRow) — the sender writes the approval bound to the draft hash
    if (row.dimension === 'communication') refuse(409, 'a send is approved by sending it — use the Send action');
    // the row AND the placement itself must sit on the domain's best path — a placement whose path was deleted (path_id
    // SET NULL) is nobody's to approve until the bridge rotates it, whatever its rows still name
    if (!domain.best_path_id || row.path_id !== domain.best_path_id || placementNow.path_id !== domain.best_path_id) refuse(409, 'the placement is no longer on the domain\'s best path — the nightly bridge rotates it; refresh the queue');
    if (!path || path.superseded_by || path.baseline === true) refuse(409, 'the path was superseded since the card — refresh the queue');
    const whyNotPath = whyNotApprovable(row, path);
    if (whyNotPath) refuse(409, `not approvable: ${whyNotPath}`);
    const { policy } = await P.loadPolicy(trx);
    const ctx = { path, domain, policy, score: domain.score, instanceKey: row.instance_key, draftClean: M.draftReview(placementNow).clean };
    // the card's frozen inputs must still be the live ones (§3.6b) — "an owner approved THESE numbers, not
    // whatever they became": the ONE test the listing applies before it shows a button
    const { waiver } = await activeWaiver(trx, domain.id, path.id, ctx);
    const all = await trx('seo_link_prospects').where({ domain_id: domain.id }).select('id', 'domain_id', 'location_key', 'payment_group_id');
    const held = heldFor(domain, path, all, await paidPlacementIds(trx, all.map((p) => p.id)));
    const { reason: stale, hash, pathRevision } = stalenessOf(row, ctx, waiver, held);
    if (stale) refuse(409, stale);

    const money = row.dimension === 'payment';
    let amounts = { approved_amount_cents: null, max_payable_cents: null };
    if (money) {
      if (path.payment_required !== true) refuse(409, 'the path no longer requires payment');
      if (path.currency !== 'USD') refuse(409, `checkout currency is ${path.currency}, not USD — an owner approval cannot change it`);
      // the amount is the OWNER'S statement, never a server default: a stale or direct client that omits it gets 400
      if (approvedAmountCents === null || approvedAmountCents === undefined || approvedAmountCents === '') refuse(400, 'approved_amount_cents is required for a payment approval (the card shows the quote; submit the amount you approve)');
      // a number or a canonical integer string only — never a coerced boolean / array / decimal (`true` → 1, `[4500]` → 4500)
      const canonical = typeof approvedAmountCents === 'number' || (typeof approvedAmountCents === 'string' && /^[0-9]{1,15}$/.test(approvedAmountCents));
      if (!canonical) refuse(400, 'approved_amount_cents must be a whole number of cents');
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
      const siblings = (await trx('seo_link_prospects').where({ domain_id: domain.id, payment_group_id: placement.payment_group_id, path_id: path.id }).whereIn('status', [...CARD_STATUSES]).whereNull('claimed_at').forUpdate().select('id', 'status', 'parked_from_status'))
        .filter((s) => s.id !== placement.id && whyNotHere(s, row, path) === null).map((s) => s.id);
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
  const ran = await bestEffortBridge(run, db, { domainIds: [result.domainId], notify: noop, autoSend: false, now });
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
    // every other state is decidable here — the Registry table's Reject / Watch is THIS decision too, and a domain that
    // left the queue (Reopen → investigating) can still carry approved rows a plain state flip would leave live
    const placements = await trx('seo_link_prospects').where({ domain_id: domain.id }).select('id', 'path_id', 'status', 'outreach_status', 'follow_up_status');
    // a send whose outcome is not settled — the pitch's, or the follow-up's (§6.4: its own claim commits `sending` and
    // errors to `send_error` on its own columns) — the claim committed `sending` and Gmail is being called outside any
    // lock, or it errored and may still have been delivered: deciding the domain now would invalidate the approval that
    // send stands on and land a `contacted` placement under a rejected / watching domain — it finalizes or reconciles first
    const { AMBIGUOUS_SEND_STATUSES } = require('./link-outreach-mandate');
    if (placements.some((p) => AMBIGUOUS_SEND_STATUSES.includes(p.outreach_status) || AMBIGUOUS_SEND_STATUSES.includes(p.follow_up_status))) refuse(409, 'a pitch or follow-up for this domain is being sent or awaits reconciliation — let it finish (or reconcile it from the Link Building board) before deciding the domain');
    const ids = placements.map((p) => p.id);
    const open = ids.length ? await loadApprovals(trx, await trx(AUTH).whereIn('prospect_id', ids).whereNull('ended_at').whereNull('satisfied_at')) : [];
    // every owner-level row is audited, the already-approved ones included: a Reject / Watch is the owner's LATER word
    // on the domain, so an approval whose bridge run was gated or lease-held (the placement still parked) is invalidated
    // here — otherwise a Reopen or the watch re-investigation would let the bridge release that authorization without a
    // fresh click. The bridge's own invalidation is the ONE writer of invalidated_at on approvals.
    const ownerRows = open.filter((r) => R.APPROVABLE_LEVELS.includes(r.level));
    const word = decision === 'watch' ? 'watches' : 'rejected';
    // EVERY approval still attached to an open row is invalidated — not only the ones the queue labels approved: a
    // consumed approval on an unsatisfied row reads as spent here, but the bridge's own predicate still counts it, so
    // left valid a later Reopen would release the placement under the authorization the owner just declined
    const invalidated = await require('./link-authority-bridge').invalidateApprovals(trx, open, `owner ${word} the domain`, now);
    // an orphaned row (its path deleted — path_id SET NULL) has no path to audit against and the approvals table
    // requires one: its approval is invalidated above and the bridge ends the row on its next pass; it must never
    // roll the owner's decision back
    const audited = ownerRows.filter((r) => r.path_id);
    // an active floor waiver (Acquire anyway) is the owner's EARLIER word: left valid, the next bridge sweep would honour
    // it and lift this very rejection — the waiver ends with the decision (a new Acquire anyway writes a new one)
    const waiversInvalidated = await trx('seo_link_floor_waivers').where({ domain_id: domain.id }).whereNull('invalidated_at')
      .update({ invalidated_at: now, invalidated_reason: `owner ${word} the domain`, updated_at: now });
    const pathIds = [...new Set(audited.map((r) => r.path_id).filter(Boolean))];
    const paths = pathIds.length ? await trx('seo_link_acquisition_paths').whereIn('id', pathIds) : [];
    const pathById = new Map(paths.map((p) => [p.id, p]));
    const { policy } = await P.loadPolicy(trx);
    const approvals = [];
    for (const r of audited) {
      const path = pathById.get(r.path_id);
      // the audit record describes ONE context: hash, revision and snapshot are all taken from the live path / domain /
      // policy the owner decided under. When the card's stamp differs (inputs moved after it parked), the card's stamp
      // is kept inside the snapshot so the record still names the authority row it answers; `authority` stays the
      // level the card offered — the one the owner declined.
      const ctx = path ? { path, domain, policy, score: domain.score, instanceKey: r.instance_key } : null;
      const hash = ctx ? P.decisionInputsHash(r.dimension, ctx) : r.decision_inputs_hash;
      const revision = path ? pathRevisionFor(path, r.dimension) : r.path_revision;
      const moved = hash !== r.decision_inputs_hash || Number(revision) !== Number(r.path_revision);
      const snapshot = ctx
        ? { ...P.decisionInputs(r.dimension, ctx), ...(path.legal_attestation === true ? { legal_terms_url: legalTermsUrlOf(path) } : {}), ...(moved ? { card: { decision_inputs_hash: r.decision_inputs_hash, path_revision: r.path_revision } } : {}) }
        : { dimension: r.dimension, instance_key: r.instance_key };
      const [a] = await trx('seo_link_approvals').insert({
        prospect_id: r.prospect_id, path_id: r.path_id, path_revision: revision, decision_inputs_hash: hash,
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
    return { domainId: domain.id, domain: domain.domain, agent_state: applied.nextState, watch_recheck_at: applied.watchRecheckAt, audited: approvals.length, invalidated, waivers_invalidated: waiversInvalidated, placements: ids.length };
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
    const failing = failingFloors(ctx);
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
  const ran = await bestEffortBridge(run, db, { domainIds: [result.domainId], notify: noop, autoSend: false, now });
  // what now awaits the owner on this domain (parked siblings park nothing new, so `parked` alone undercounts). These
  // reads run after the commit and are best-effort like the bridge: the waiver is recorded whatever they do, so a read
  // failure reports an unavailable summary — never a failed click that invites a retry (which would only write an
  // audited replacement waiver).
  try {
    const mine = await db('seo_link_prospects').where({ domain_id: result.domainId }).select('id', 'status', 'parked_from_status', 'claimed_at', 'path_id', 'outreach_status');
    const pathIds = [...new Set(mine.map((p) => p.path_id).filter(Boolean))];
    const paths = pathIds.length ? await db('seo_link_acquisition_paths').whereIn('id', pathIds) : [];
    const pathById = new Map(paths.map((p) => [p.id, p]));
    const byId = new Map(mine.map((p) => [p.id, p]));
    const active = mine.length ? await db(AUTH).whereIn('prospect_id', mine.map((p) => p.id)).whereNull('ended_at') : [];
    const executionById = new Map(active.filter((r) => r.dimension === 'execution' && r.instance_kind === '-').map((r) => [r.prospect_id, r]));
    const open = await loadApprovals(db, active.filter((r) => !r.satisfied_at));
    // only what is a CARD now — a deferred outreach step (no draft yet, no checkout yet) stays open without a card and
    // must not be reported as awaiting in the queue
    const awaiting = open.filter((r) => isOwner(r.level) && !r.approved && byId.has(r.prospect_id) && !byId.get(r.prospect_id).claimed_at && whyNotHere(byId.get(r.prospect_id), r, pathById.get(byId.get(r.prospect_id).path_id), executionById.get(r.prospect_id)) === null).length;
    const state = (await db('seo_link_domains').where({ id: result.domainId }).first('agent_state'))?.agent_state || null;
    return { ...result, bridge: ran, awaiting, agent_state: state, summary_unavailable: false };
  } catch (err) {
    require('../logger').error(`[backlink-owner-queue] post-commit summary read failed for ${result.domain}: ${err.message}`);
    return { ...result, bridge: ran, awaiting: null, agent_state: null, summary_unavailable: true };
  }
}

// ---------------------------------------------------------------------------
// Send — the owner's click on a communication row IS its approval (§6.3 2c):
// the sender writes the approval under its own claim lock, bound to the draft
// hash and the recipient review the owner acknowledged, and sends. Every
// refusal the sender returns is a 4xx here; the placement / row / path checks
// mirror the sender's (it re-validates all of them under the lock).
// ---------------------------------------------------------------------------
const SEND_CODE_STATUS = Object.freeze({
  not_found: 404, gate_off: 403, gmail_not_connected: 503, rate_limited: 429, already_sent: 409, not_actionable: 409,
  not_authorized: 409, customer_recipient: 409, recipient_review_required: 409, recipient_lookup_failed: 503,
  path_moved: 409, path_unlinked: 409, no_draft: 409, incomplete_draft: 409, invalid_recipient: 409, not_outreach: 409,
  inbox_in_flight: 409, recipient_changed: 409, draft_changed: 409,
  no_initial_send: 409, reply_received: 409, bounced: 409, reply_check_failed: 503,
  send_failed: 502, finalize_failed: 500,
});
async function sendRow(db, { authorityId, actor, reviewedLookupHash = null, draftHash = null, send = null }) {
  if (!actor) refuse(400, 'a sending admin identity is required');
  // the click sends the text the card displayed (§3.6b) — the claim refuses a draft edited since
  if (typeof draftHash !== 'string' || !draftHash) refuse(400, 'the hash of the draft the card displayed is required — refresh the queue and send again');
  const row = await db(AUTH).where({ id: authorityId }).first('id', 'prospect_id', 'dimension', 'instance_kind', 'ended_at', 'satisfied_at');
  if (!row) refuse(404, 'authority row not found');
  if (row.dimension !== 'communication' || !['-', 'followup'].includes(row.instance_kind)) refuse(409, 'only the initial send and the follow-up are sent from the queue');
  if (row.ended_at || row.satisfied_at) refuse(409, 'the send instance is no longer open — refresh the queue');
  const placement = await db('seo_link_prospects').where({ id: row.prospect_id }).first('id', 'status', 'parked_from_status', 'claimed_at', 'path_id');
  if (!placement) refuse(404, 'placement not found');
  const path = placement.path_id ? await db('seo_link_acquisition_paths').where({ id: placement.path_id }).first() : null;
  const execution = await db(AUTH).where({ prospect_id: placement.id, dimension: 'execution', instance_kind: '-' }).whereNull('ended_at').first('path_id', 'satisfied_at');
  const notHere = placement.claimed_at ? `leased at ${placement.status}` : whyNotHere(placement, row, path, execution);
  if (notHere) refuse(409, `the placement is no longer awaiting your decision (${notHere}) — refresh the queue`);
  const sendOutreach = send || require('./link-prospect-outreach').sendOutreach;
  const r = await sendOutreach({ prospectId: placement.id, approvedBy: actor, mode: 'owner', reviewedLookupHash, draftHash, followUp: isFollowUp(row) });
  if (!r.ok) {
    const err = new OwnerQueueError(SEND_CODE_STATUS[r.code] || 400, r.error || `send refused: ${r.code}`);
    err.code = r.code;
    err.review = r.review || null;
    throw err;
  }
  return { sent: true, prospectId: placement.id, message_id: r.message_id, thread_id: r.thread_id, authority: r.authority };
}

module.exports = { listOwnerQueue, approveRow, sendRow, decideDomain, acquireAnyway, waivableFloors, whyNotApprovable, actionFor, legalTermsUrlOf, OwnerQueueError, APPROVE_HERE, SEND_CODE_STATUS };
