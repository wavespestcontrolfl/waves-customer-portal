/**
 * Backlink Manager v2 — the nightly `link-authority` bridge
 * (docs/design/backlink-manager-plan.md §6.3 "Bridge", §3.3b, §3.1; step 4 PR 2a).
 *
 * How an investigated domain becomes a stamped placement. Per run:
 *   (a) every `qualified` domain with a `best_path_id`, and
 *   (b) every domain owning an OPEN authority row that is stale — an
 *       unsatisfied one decided before the policy / path / domain last changed
 *       or decided on a path that is no longer the domain's best, a satisfied
 *       accept_terms one bound to an agreement hash the path no longer carries,
 *       or one whose placement still points at a superseded path — and every
 *       `qualified` domain missing a placement for a GBP location —
 * each processed in ONE transaction under the shared per-domain lock
 * (prospect-domain-lock): choose the Waves page (homepage — see the note in
 * the plan), create the placement rows if missing (one per GBP location for a
 * signup lane, one unscoped row for an outreach lane), run the PURE §6.3
 * decision, rotate the instances that outlived their path or agreement (each
 * row records the path it was decided on, so a supersession the registry mover
 * applied at a lease release — after the bridge's own run — still ends the old
 * generation and opens the next), write/refresh one authority row per required
 * instance (a satisfied instance is never re-decided; an approval whose frozen
 * inputs no longer match is invalidated), stamp the placement's display level, park an
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
 * Session lock 'link-authority-bridge' serializes runs. Selection (which
 * domains a run visits, and the ONE rotation rule the bridge shares with it)
 * lives in link-authority-selection.js.
 *
 * Inputs the later steps supply are pinned to their fail-closed values here:
 * monthSpendCents = 0 and d30Confidence = null (no purchases / D30 loop yet —
 * AUTO_PAID_WITHIN_POLICY cannot be granted). draftClean is the §6.4 review of
 * the placement's parked draft (link-outreach-mandate): AUTO_OUTREACH is
 * granted only on a lint-clean, commitment-free draft, per placement.
 *
 * Auto-send (§6.4, step 4 PR 3a): after a NIGHTLY run commits, every placement
 * it decided whose open communication instance reads AUTO_OUTREACH on a
 * drafted, unleased `prospect` row is handed to the sender in 'auto' mode —
 * the sender re-validates everything under its own lock (gate, policy cap,
 * customer exclusion, the authority row) and stops the batch at the cap. An
 * inline run (an owner's click) and an admin's manual job never send: only the
 * scheduler's nightly call opts in (autoSend: true; the default is false).
 */

const { isEnabled } = require('../../config/feature-gates');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { claimProspectDomain, findPlacementRow, targetPageOf } = require('./prospect-domain-lock');
const { OUTREACH_ACQUISITION_TYPES, LEVEL_SEVERITY, settleRetiredPlacements, movePatch, isOutreachLocked } = require('./link-registry');
const P = require('./link-authority-policy');
const M = require('./link-outreach-mandate');
const { selectDomains, paidPlacementIds, groupMismatch, expectedLocations, rotationOutcome, ts, BRIDGE_STATES, LIVE_STATUSES, ACQUIRING_STATUSES, PARKABLE } = require('./link-authority-selection');

const LOCK_KEY = 'link-authority-bridge';
const RUN_LIMIT_MAX = 500;
const DEFAULT_LIMIT = 50;
const AUTH = 'seo_link_placement_authorities';
const OWNER = 'link-authority';
// Every bridged placement targets the homepage: listing-style paths are the
// homepage by spec, and no topic is persisted on the registry domain yet for
// the scorer's topic → money-page mapping (deferred; noted in the plan).
const HOMEPAGE = targetPageOf('/');
// Placement statuses the bridge may move: prospect ⇄ awaiting_owner. Everything
// else (contacted/negotiating/placed/live/indexed/lost/rejected/watching) is
// Judge- or owner-owned history.
const PARKED = 'awaiting_owner';
// Statuses a placement reaches only AFTER its conversation happened: durable
// evidence of a send even without the outreach markers (the admin route lets a
// manual row be advanced to contacted/negotiating by hand). placed/live/indexed
// prove it ONLY on a path whose submit follows the pitch — on a submit-first
// path (execution_after_send=false) they prove the submit alone and the initial
// email is still the LATE SEND owed from those states (§6.4).
const CONVERSED_STATUSES = Object.freeze(['contacted', 'negotiating']);
const PLACED_STATUSES = Object.freeze(['placed', 'live', 'indexed']);
const durableSend = (placement, path) => Boolean(placement.outreach_sent_at || placement.outreach_status === 'sent')
  || CONVERSED_STATUSES.includes(placement.status)
  || (PLACED_STATUSES.includes(placement.status) && !P.submitFirst(path));

const isOwner = (l) => typeof l === 'string' && l.startsWith('OWNER_');
const isAuto = (l) => typeof l === 'string' && l.startsWith('AUTO_');
const severity = (l) => { const i = LEVEL_SEVERITY.indexOf(l); return i === -1 ? LEVEL_SEVERITY.length : i; };
const mostSevere = (levels) => levels.reduce((best, l) => (best === null || severity(l) < severity(best) ? l : best), null);
const defaultExclusive = (key, fn) => require('../../utils/cron-lock').runExclusive(key, fn, { recordHealth: false });
const defaultNotify = (title, body, opts) => require('../notification-service').notifyAdmin('system', title, body, opts);

// A row is AUTHORIZED when it is satisfied, AUTO_*, or OWNER_* with a valid
// (approved, not invalidated) approval attached — PR 2b writes those; the
// bridge honours them so an approved placement is never re-parked. A CONSUMED
// approval is spent (§3.6b): on a row still unsatisfied (a failed / ambiguous
// terminal outcome awaits rotation) it authorizes nothing more — the owner
// approves the retry afresh — while on a satisfied row it is the durable
// prerequisite it reads as. The Owner queue reads it the same way.
async function annotateApprovals(trx, rows) {
  const ids = [...new Set(rows.filter((r) => r.approval_id).map((r) => r.approval_id))];
  const approvals = ids.length ? await trx('seo_link_approvals').whereIn('id', ids).select('id', 'decision', 'invalidated_at', 'consumed_at') : [];
  const byId = new Map(approvals.map((a) => [a.id, a]));
  for (const r of rows) {
    const a = r.approval_id ? byId.get(r.approval_id) : null;
    r.approved = Boolean(a && a.decision === 'approved' && !a.invalidated_at && (!a.consumed_at || r.satisfied_at));
  }
  return rows;
}
const authorized = (r) => Boolean(r.satisfied_at) || isAuto(r.level) || (isOwner(r.level) && r.approved === true);
// an approval attached to an instance that is ending is invalidated with it
// (the action it approved no longer exists on the current path)
async function invalidateApprovals(trx, rows, reason, now) {
  const ids = [...new Set(rows.filter((r) => r.approval_id).map((r) => r.approval_id))];
  if (!ids.length) return 0;
  return trx('seo_link_approvals').whereIn('id', ids).whereNull('invalidated_at').update({ invalidated_at: now, invalidated_reason: reason, updated_at: now });
}
// the selection module's reader — the bridge and selection must agree on what "paid" means
const paymentActivity = async (trx, prospectIds) => (await paidPlacementIds(trx, prospectIds)).size > 0;
// payment on an outreach path is DEFERRED until the publisher exposes a checkout
// (ready_for_payment, §3.3b): it neither parks the placement nor holds the
// domain back from ready_to_acquire — the initial send claims on communication
// authority alone (the claim predicate, plan §6.4, accepts nothing below
// ready_to_acquire). ONLY the levels that wait for a checkout defer — the
// owner's own approval (OWNER_PAYMENT), the policy's (AUTO_PAID_WITHIN_POLICY)
// and a fee the owner settles by hand at that checkout (OWNER_MANUAL_PAYMENT:
// foreign currency / no merchant binding — the conversation must open the
// checkout first). A price the owner must ENTER (OWNER_INPUT_REQUIRED) is an
// input, not a checkout step: it parks immediately.
const DEFERRABLE_PAYMENT_LEVELS = Object.freeze(['OWNER_PAYMENT', 'AUTO_PAID_WITHIN_POLICY', 'OWNER_MANUAL_PAYMENT']);
// The publisher's account / form step on a SEND-FIRST outreach path (execution_after_send true, plan §6.4: the
// acquire claims at contacted/negotiating only after the send satisfied) is settled AFTER the pitch just the same:
// parking the `prospect` for it would block the draft (the drafter and saveDraft load `prospect` rows only) and
// hold the aggregate at qualified, so the send-first conversation could never begin. `p` = { outreach, sendFirst }.
const deferred = (r, p) => p.outreach === true && (
  (r.dimension === 'payment' && DEFERRABLE_PAYMENT_LEVELS.includes(r.level))
  || (p.sendFirst === true && r.dimension === 'execution' && r.instance_kind === '-')
  || (p.sendFirst === false && r.dimension === 'communication'));

const freshCounters = () => ({ placementsCreated: 0, rowsWritten: 0, redecided: 0, ended: 0, parked: 0, released: 0, invalidatedApprovals: 0, invalidatedWaivers: 0, aggregateChanges: 0, skippedLeased: 0, pinned: 0, parkedDomains: [] });
const defaultSend = (args) => require('./link-prospect-outreach').sendOutreach(args);

// §6.4 auto-send: EVERY placement whose open communication instance reads
// AUTO_OUTREACH and unsatisfied, on a drafted unleased `prospect` row —
// selected on its own each nightly, not only from the domains this run decided,
// so a draft the cap deferred last night (its rows unchanged, its domain not
// re-selected) gets its attempt when the window reopens. Read AFTER the domain
// transactions committed (never inside one: the sender takes its own advisory
// lock and the Gmail call is network). Each send is its own claim; the sender's
// cap decision under the lock ends the batch. The batch bounds ATTEMPTS (the
// nightly's work); a refusal the claim returns without touching the row (a
// customer recipient, an inbox another placement holds, a policy that moved)
// would otherwise leave that row at the head of the oldest-first ordering every
// night and starve every newer draft behind it — so a refused row is re-stamped
// to the tail (updated_at) and the next batch is the rows behind it.
const AUTO_SEND_BATCH = 100;
async function autoSendDecided(db, { send, now }) {
  const out = { attempted: 0, sent: 0, skipped: [] };
  // the due follow-ups FIRST (§6.4: few and dated — a sustained pitch backlog that fills the cap every night must
  // never starve them), then the initial pitches — one cap decision under the sender's lock ends both
  // — and ONE attempt budget (AUTO_SEND_BATCH) across both: the pitches get what the follow-ups left
  const capped = await dispatchBatch(db, out, { send, now, followUp: true, limit: AUTO_SEND_BATCH });
  const remaining = AUTO_SEND_BATCH - out.attempted;
  if (!capped && remaining > 0) await dispatchBatch(db, out, { send, now, followUp: false, limit: remaining });
  return out;
}
// one lane's batch: the AUTO_OUTREACH rows of its instance kind on drafted, unleased rows, at most `limit` attempts. Returns true when the cap ended it.
async function dispatchBatch(db, out, { send, now, followUp, limit }) {
  const kind = followUp ? 'followup' : '-';
  const rows = await db(AUTH).where({ dimension: 'communication', instance_kind: kind, level: P.LEVELS.AUTO_OUTREACH }).whereNull('ended_at').whereNull('satisfied_at').select('prospect_id', 'path_id');
  if (!rows.length) return false;
  const paths = await db('seo_link_acquisition_paths').whereIn('id', [...new Set(rows.map((r) => r.path_id).filter(Boolean))]).select('id', 'acquisition_type', 'account_required', 'execution_after_send');
  // Submit-first pitches become eligible only after placement. Filter lifecycle and
  // path ordering before LIMIT so waiting submissions cannot starve ready drafts.
  const eligible = new Set(paths.map((x) => x.id));
  const submitFirstIds = paths.filter(P.submitFirst).map((x) => x.id);
  const decidedPath = new Map(rows.filter((r) => eligible.has(r.path_id)).map((r) => [r.prospect_id, r.path_id]));
  if (!decidedPath.size) return false;
  const statusCol = followUp ? 'follow_up_status' : 'outreach_status';
  let q = db('seo_link_prospects').whereIn('id', [...decidedPath.keys()]).whereIn('path_id', [...eligible]).where({ [statusCol]: 'drafted' }).whereNull('claimed_at');
  q = followUp ? q.where({ outreach_status: 'sent' }).whereIn('status', [...M.FOLLOW_UP_STATUSES_ANY]) : q.where((b) => b.where((x) => x.where({ status: PARKABLE }).whereNotIn('path_id', submitFirstIds))
    .orWhere((x) => x.whereIn('status', ['placed', 'live', 'indexed']).whereIn('path_id', submitFirstIds))).whereNull('outreach_sent_at');
  const batch = await q.orderBy('updated_at', 'asc').limit(limit).select('id', 'path_id', 'updated_at');
  for (const p of batch) {
    if (decidedPath.get(p.id) !== p.path_id) continue; // the row left the path its instance was decided on — the bridge rotates it
    out.attempted += 1;
    let res;
    try { res = await send({ prospectId: p.id, approvedBy: 'auto-outreach', mode: 'auto', followUp, now }); } catch (err) { res = { ok: false, code: 'error', error: err.message }; }
    if (res && res.ok) { out.sent += 1; continue; }
    out.skipped.push({ id: p.id, code: (res && res.code) || 'error', ...(followUp ? { follow_up: true } : {}) });
    if (res && res.code === 'rate_limited') return true; // the cap is reached for the window — nothing else sends today
    // the refused row goes behind every draft that existed before this run (still drafted: the claim never took it) —
    // unless an edit landed since the run began: a later timestamp is what marks that draft stale for the next
    // selection and is never moved backward
    await db('seo_link_prospects').where({ id: p.id, [statusCol]: 'drafted' }).where('updated_at', '<=', now).update({ updated_at: now });
  }
  return false;
}

// The OTHER owner decisions that hold a placement in its park — the park predicate (`gates` in bridgeDomain) minus
// the row being acted on: an unauthorized OWNER_* row not deferred past the send. The sender refuses while one
// stands: satisfying only its communication instance would clear the park with that decision still open.
async function openOwnerHold(trx, { placement, path, exceptRowId }) {
  const rows = await annotateApprovals(trx, (await trx(AUTH).where({ prospect_id: placement.id }).whereNull('ended_at')).filter((r) => r.id !== exceptRowId));
  const lane = { outreach: true, sendFirst: !P.submitFirst(path) };
  return rows.find((r) => !authorized(r) && isOwner(r.level) && !deferred(r, lane)) || null;
}

// ---------------------------------------------------------------------------
// One domain, one transaction. Counters are LOCAL to the transaction and
// merged by the caller only after it commits — a rollback reports nothing.
// ---------------------------------------------------------------------------
async function bridgeDomain(trx, { domainId, policy, policyUpdatedAt, now }) {
  const out = freshCounters();
  // the shared board guard: the per-domain ADVISORY lock + "one conversation per
  // inbox" — an outreach-lane placement is never opened beside an active outreach
  // row. Taken BEFORE the domain row lock: every per-domain writer (lost-link
  // recovery, the worker) orders advisory lock → row locks, and the Sunday scan
  // can still be queuing recoveries when the bridge starts
  const named = await trx('seo_link_domains').where({ id: domainId }).first('id', 'domain');
  if (!named) return { skipped: 'no best path', out };
  const { inFlight } = await claimProspectDomain(trx, named.domain);
  const domain = await trx('seo_link_domains').where({ id: domainId }).forUpdate().first();
  if (!domain) return { skipped: 'no best path', out };
  const allIds = (await trx('seo_link_prospects').where({ domain_id: domain.id }).select('id')).map((p) => p.id);
  if (!domain.best_path_id) {
    // the investigator cleared the route (disproveGonePaths) and left the
    // placements behind: every open unsatisfied instance ends, its approval is
    // invalidated, and a lane-owned aggregate goes back to investigating —
    // nothing on this domain is claimable until a route exists again
    const open = allIds.length ? await trx(AUTH).whereIn('prospect_id', allIds).whereNull('ended_at').whereNull('satisfied_at').select('id', 'approval_id') : [];
    if (!open.length) return { skipped: 'no best path', out };
    out.invalidatedApprovals += await invalidateApprovals(trx, open, 'path disproven: no best path', now);
    await trx(AUTH).whereIn('id', open.map((r) => r.id)).update({ ended_at: now, end_outcome: 'superseded', updated_at: now });
    out.ended += open.length;
    if (BRIDGE_STATES.includes(domain.agent_state)) {
      out.aggregateChanges += await trx('seo_link_domains').where({ id: domain.id, agent_state: domain.agent_state }).update({ agent_state: 'investigating', rejected_by: null, updated_at: now });
    }
    return { decided: true, out };
  }
  const path = await trx('seo_link_acquisition_paths').where({ id: domain.best_path_id }).first();
  if (!path || path.superseded_by) return { skipped: 'best path superseded', out };
  if (path.baseline === true) return { skipped: 'baseline placeholder (not an executable path)', out };
  const ctx = { path, domain, policy, score: domain.score };
  // a `rejected` the bridge wrote itself (rejected_by = 'bridge': every blocking
  // row was DENY) is the one it may lift once the inputs improve; the owner's
  // registry Reject stamps 'owner' and stands until Reopen / Watch or a waiver
  const bridgeRejected = domain.agent_state === 'rejected' && domain.rejected_by === 'bridge';

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

  const outreachPath = OUTREACH_ACQUISITION_TYPES.includes(path.acquisition_type);
  const lane = { outreach: outreachPath, sendFirst: outreachPath && !P.submitFirst(path) };

  // the lane's shape, and the domain's placements outside it (the other lane's
  // keys after a re-rank); a settled payment on an off-shape row means the
  // acquisition was already paid for — a NEW in-shape placement would open a
  // second payment instance under another group and the group-keyed duplicate
  // guard could not see the first, so the shape change waits for the owner
  const shape = new Set(expectedLocations(path));
  const offShape = (await trx('seo_link_prospects').where({ domain_id: domain.id }).select('id', 'location_key', 'claimed_at')).filter((p) => !shape.has(p.location_key));
  const offShapePaid = offShape.length ? await paymentActivity(trx, offShape.map((p) => p.id)) : false;
  // refused BEFORE any placement is adopted, reused or created: a reused in-shape row would open a fresh payment
  // instance beside the settled off-shape proof just the same. Selection suppresses this domain (held); only a
  // forced run lands here.
  if (offShapePaid) return { skipped: 'settled payment on a placement outside the lane shape: owner review before this lane is bridged', out };

  let placements = [];
  const dormant = [];
  for (const location of expectedLocations(path)) {
    let row = null;
    let conversation = false;
    let closedHere = null;
    if (location === '-') {
      // the lane's conversation when one is already bridged: the domain-bound unscoped row on the best path that
      // carries open rows — looked up FIRST, so the answer never depends on which active row the inbox lock
      // happened to return (a dormant homepage row and the adopted conversation are both `prospect` to it)
      const bound = await trx('seo_link_prospects').where({ domain_id: domain.id, path_id: path.id, location_key: '-' }).select('*');
      if (bound.length) {
        const withOpen = new Set((await trx(AUTH).whereIn('prospect_id', bound.map((p) => p.id)).whereNull('ended_at').select('prospect_id')).map((r) => r.prospect_id));
        // a CLOSED conversation (§13 stamp — silent, its inbox and domain released) is history, not the lane's
        // conversation: it never shadows a live row, so a prospect admitted for the released publisher is bridged
        row = bound.find((p) => withOpen.has(p.id) && !p.conversation_closed_at) || null;
        conversation = Boolean(row);
        // …and with NOTHING live at the location, the closed conversation stays the slot's placement (as selection's
        // `covered` reads it): re-aggregated as history, never replaced — a re-pitch of a silent publisher is a NEW
        // prospect the registry admits, not a row the nightly fabricates the moment the closure releases the domain
        if (!row) closedHere = bound.find((p) => withOpen.has(p.id) && p.conversation_closed_at) || null;
      }
    }
    if (!row) row = await findPlacementRow(trx, domain.domain, HOMEPAGE, { location, columns: ['*'] });
    // the exact homepage row is a closed conversation and another row is in flight for the domain: the in-flight row
    // IS the placement (adopted below); the closed row stays as it is (its history, no re-pitch)
    if (row && row.conversation_closed_at && inFlight && inFlight.id !== row.id) row = null;
    // one conversation per inbox: an active outreach row on ANOTHER page beside an UNBRIDGED homepage row means the
    // homepage row is not this domain's conversation. Pinned (sent / locked) or leased, the homepage row is a
    // conversation of its own — two for one inbox is a conflict nothing here may resolve. Dormant, the in-flight row
    // IS the placement (adopted / moved below) and the homepage row's open instances end, so it neither votes nor
    // re-selects the domain — never a nightly slot spent on the same standoff
    if (row && location === '-' && inFlight && inFlight.id !== row.id && !conversation) {
      if (isOutreachLocked(row) || row.claimed_at) return { skipped: `outreach conversation in flight on another page (${inFlight.status})`, out };
      dormant.push(row);
      row = null;
    }
    if (!row && location === '-' && inFlight) {
      // an outreach conversation already exists for this inbox (a manual or
      // strategy-agent row on another page): that row IS the placement rather
      // than a second one. Bound to another path: a LOCKED/sent conversation
      // is pinned there (nothing is created this run); an unlocked one (a
      // draft, a fresh prospect) follows the re-rank through the mover below.
      row = await trx('seo_link_prospects').where({ id: inFlight.id }).first();
      if (!row || (row.path_id && row.path_id !== path.id && isOutreachLocked(row))) return { skipped: `outreach conversation in flight on another path (${inFlight.status})`, out };
    }
    if (row && !row.path_id) {
      // an UNBOUND row — exact homepage match or the in-flight conversation;
      // the manual prospect endpoint assigns no registry ids — is ADOPTED:
      // bound to the domain and its best path (the mover cannot follow a null
      // path). Lane, execution URL, classification and an unsent draft follow
      // the path through the ONE move patch (link-registry movePatch), so a
      // row created under a signup lane is claimable by the outreach worker
      // once bound to an outreach path; a locked/sent conversation keeps what
      // it was sent under (the patch refuses it) and is only bound.
      const sync = movePatch(row, path, now) || {};
      const adopt = { ...sync, domain_id: domain.id, path_id: path.id, updated_at: now, ...(row.link_type || sync.link_type ? {} : { link_type: path.link_type }) };
      // a row whose initial email durably went out but that still reads `prospect` (the manual endpoint records
      // the send without the lifecycle move) is the CONTACTED conversation: the sender refuses a sent row and a
      // paid outreach checkout claims only from contacted/negotiating, so `prospect` would strand it. CAS on the
      // status the decision read — a concurrent Judge move wins and the adoption keeps its status.
      const sentAsProspect = row.status === PARKABLE && Boolean(row.outreach_sent_at || row.outreach_status === 'sent');
      if (sentAsProspect) adopt.status = 'contacted';
      const applied = await trx('seo_link_prospects').where({ id: row.id, status: row.status }).update(adopt);
      if (!applied) { delete adopt.status; await trx('seo_link_prospects').where({ id: row.id }).update(adopt); }
      Object.assign(row, applied ? adopt : { ...adopt, status: (await trx('seo_link_prospects').where({ id: row.id }).first('status')).status });
    }
    if (!row && closedHere && !inFlight) row = closedHere;
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
  // is left alone this run. The mover never touches authority rows: the
  // rotation below reads each row's own path_id, so a move it applies later
  // (at the lease release) is rotated on the next run all the same.
  const behind = placements.filter((p) => p.path_id !== path.id);
  if (behind.length) {
    // a superseded predecessor is followed along its chain; a path that is
    // still live but simply no longer the domain's best (the investigator
    // re-ranked) hands its unleased placements to the best path directly —
    // otherwise the domain would consume a batch slot every night without a
    // placement on the path it is meant to acquire through
    const behindPaths = await trx('seo_link_acquisition_paths').whereIn('id', [...new Set(behind.map((p) => p.path_id))]).select('id', 'superseded_by');
    const chained = new Set(behindPaths.filter((x) => x.superseded_by).map((x) => x.id));
    const viaChain = behind.filter((p) => chained.has(p.path_id));
    const viaRerank = behind.filter((p) => !chained.has(p.path_id));
    if (viaChain.length) await settleRetiredPlacements(trx, { prospectIds: viaChain.map((p) => p.id), now });
    // exactly the in-shape rows: a sibling on the same old path outside this lane's shape stays put (retired below)
    if (viaRerank.length) await settleRetiredPlacements(trx, { prospectIds: viaRerank.map((p) => p.id), successor: path, now });
    const moved = await trx('seo_link_prospects').whereIn('id', behind.map((p) => p.id)).select('*');
    const byId = new Map(moved.map((p) => [p.id, p]));
    placements = placements.map((p) => byId.get(p.id) || p);
    const stuck = placements.filter((p) => p.path_id !== path.id);
    // a PINNED conversation (locked send state / sent stamp) stays on the path it was claimed on until the worker's
    // release-time settle: this domain's placement for that location, not re-decided here and not a nightly retry
    out.pinned += stuck.filter(isOutreachLocked).length;
    out.skippedLeased += stuck.filter((p) => !isOutreachLocked(p)).length;
    placements = placements.filter((p) => p.path_id === path.id);
  }
  // A placement OUTSIDE the lane's shape (GBP-keyed rows after a re-rank to an
  // outreach path, or the unscoped row after one to a signup lane) is never
  // moved into the other lane — that would open N conversations for one inbox
  // or N unscoped signups — and never decided: its open unsatisfied instances
  // end `superseded`, so it carries no authority (not claimable under the
  // authority contract) and stops being a staleness source. Its history stays.
  // A row still LEASED keeps its authority this run — the worker may be performing the external step under it
  // and reports against it; the same boundary the mover observes (claimed_at IS NULL). Retired once released.
  const retirable = offShape.filter((p) => !p.claimed_at);
  if (retirable.length) {
    const retiring = await trx(AUTH).whereIn('prospect_id', retirable.map((p) => p.id)).whereNull('ended_at').whereNull('satisfied_at').select('id', 'approval_id');
    if (retiring.length) {
      out.invalidatedApprovals += await invalidateApprovals(trx, retiring, 'placement outside the lane shape', now);
      await trx(AUTH).whereIn('id', retiring.map((r) => r.id)).update({ ended_at: now, end_outcome: 'superseded', updated_at: now });
      out.ended += retiring.length;
    }
  }
  // a dormant homepage row displaced by the in-flight conversation: EVERY open instance ends (a satisfied one too —
  // it proves a conversation that is not this lane's), so the row carries no authority and is never a staleness source
  if (dormant.length) {
    const displaced = await trx(AUTH).whereIn('prospect_id', dormant.map((p) => p.id)).whereNull('ended_at').select('id', 'approval_id');
    if (displaced.length) {
      out.invalidatedApprovals += await invalidateApprovals(trx, displaced, 'displaced by the in-flight conversation', now);
      await trx(AUTH).whereIn('id', displaced.map((r) => r.id)).update({ ended_at: now, end_outcome: 'superseded', updated_at: now });
      out.ended += displaced.length;
    }
  }

  // payment group (§3.3 / bridge): the purchase contract keys every reservation,
  // duplicate guard and renewal by it — account_wide siblings share the first
  // placement's id; a per_location fee is its own group (re-investigation from
  // account_wide to per_location splits the group; the reverse re-joins it)
  // A fee_scope change after placements exist is a REGROUP: automatic only while
  // no purchase exists in any state (plan §3.3) — otherwise the keys stay as they
  // are (merging paid groups or detaching a placement from the purchase keyed to
  // its group would break renewal attribution and the duplicate guard) and every
  // unsatisfied payment instance parks OWNER_INPUT_REQUIRED for the owner's
  // regroup. A first assignment (no group yet) is never a regroup.
  let regroupHeld = false;
  if (path.payment_required && placements.length) {
    const anchor = path.fee_scope === 'account_wide' ? ((placements.find((p) => p.payment_group_id) || {}).payment_group_id || placements[0].id) : null;
    const changing = placements.filter((p) => p.payment_group_id !== (anchor || p.id));
    regroupHeld = groupMismatch(path, placements) && await paymentActivity(trx, allIds);
    if (!regroupHeld) {
      for (const p of changing) {
        const groupId = anchor || p.id;
        await trx('seo_link_prospects').where({ id: p.id }).update({ payment_group_id: groupId, updated_at: now });
        p.payment_group_id = groupId;
      }
    }
  }
  // the communication verdict depends on the PLACEMENT's draft (§6.3 2c), so the decision is per placement — and
  // once the pitch went out and its ONE follow-up is drafted (§6.4, followUpPending), the communication/followup
  // instance is required and decided by the same rule on the FOLLOW-UP's text (the satisfied initial is never re-decided)
  const decisionFor = (placement) => {
    const followUp = lane.outreach && M.followUpPending(placement, ctx.path);
    const draftClean = !lane.outreach ? false : followUp ? M.followUpReview(placement).clean : M.draftReview(placement).clean;
    const decided = P.decideAuthority({ ...ctx, monthSpendCents: 0, d30Confidence: null, draftClean, followUp, waiver });
    return regroupHeld
      ? { ...decided, instances: decided.instances.map((i) => (i.dimension === 'payment' ? { ...i, level: P.LEVELS.OWNER_INPUT_REQUIRED, reason: 'fee scope changed after payment activity: the owner performs the regroup' } : i)) }
      : decided;
  };

  const summaries = [];
  for (const placement of placements) {
    const decision = decisionFor(placement);
    // ALL rows, ended ones included: the full UNIQUE (prospect, dimension,
    // instance_key) keeps history, so a replacement instance takes the next
    // generation (`${kind}:${n+1}`, §3.3b) — never the ended row's key.
    const history = await annotateApprovals(trx, await trx(AUTH).where({ prospect_id: placement.id }).select('*'));
    // rotation (rotationOutcome): the ended instance's approval is invalidated
    // and the next generation is decided below
    for (const r of history) {
      const outcome = rotationOutcome(r, path);
      if (!outcome) continue;
      if (r.approval_id) {
        out.invalidatedApprovals += await trx('seo_link_approvals').where({ id: r.approval_id }).whereNull('invalidated_at').update({ invalidated_at: now, invalidated_reason: outcome === 'terms_changed' ? 'terms_changed' : 'path_superseded', updated_at: now });
      }
      await trx(AUTH).where({ id: r.id }).update({ ended_at: now, end_outcome: outcome, updated_at: now });
      Object.assign(r, { ended_at: now, end_outcome: outcome });
      out.ended += 1;
    }
    const open = history.filter((r) => !r.ended_at);
    const key = (r) => `${r.dimension}|${r.instance_kind}`;
    const nextGeneration = (inst) => 1 + history.filter((r) => key(r) === key(inst)).reduce((m, r) => Math.max(m, Number(String(r.instance_key).split(':').pop()) || 0), 0);
    const byKey = new Map(open.map((r) => [key(r), r]));
    const required = new Set(decision.instances.map(key));

    for (const inst of decision.instances) {
      const existing = byKey.get(key(inst));
      // the hash binds to THIS instance (§3.6b): the open row's own key, or the next generation's for a fresh row
      const instanceKey = existing ? existing.instance_key : `${inst.instance_kind}:${nextGeneration(inst)}`;
      const hash = P.decisionInputsHash(inst.dimension, { ...ctx, instanceKey });
      const pathRevision = path[`revision_${inst.dimension}`] ?? path.revision ?? 1;
      const floorWaiverId = waiver ? waiver.id : null;
      if (!existing) {
        // an adopted conversation whose initial email already went out (durable
        // `outreach_sent_at` / `sent`, or a status only reached after contact —
        // a manual row advanced to contacted/negotiating by hand carries no
        // markers) gets its FIRST communication instance satisfied from that
        // evidence — the worker only sends `prospect` rows, so an unsatisfied
        // instance here could never be satisfied, and the follow-up needs the
        // initial send satisfied
        const sentBefore = inst.dimension === 'communication' && inst.instance_kind === '-' && !history.some((r) => key(r) === key(inst)) && durableSend(placement, path);
        const [row] = await trx(AUTH).insert({
          prospect_id: placement.id, path_id: path.id, dimension: inst.dimension, instance_kind: inst.instance_kind, instance_key: instanceKey,
          level: inst.level, reason: inst.reason, decision_inputs_hash: hash, path_revision: pathRevision,
          floor_waiver_id: floorWaiverId, decided_at: now, created_at: now, updated_at: now,
          ...(sentBefore ? { satisfied_at: placement.outreach_sent_at || now, satisfied_reason: 'sent' } : {}),
        }).returning('*');
        open.push(row);
        history.push(row);
        out.rowsWritten += 1;
        continue;
      }
      if (existing.satisfied_at) continue; // done — never re-decided
      // a communication instance whose send is in flight (claimed `sending`, or errored before the Sent-folder reconcile)
      // is PINNED at the authority the claim was granted under: the draft is no longer `drafted` (so a re-review here
      // would read it unclean and rewrite AUTO → OWNER on a row `finalizeSend` then satisfies by id, no owner click
      // taken) — the reconcile settles it, not a concurrent bridge run
      if (inst.dimension === 'communication' && M.AMBIGUOUS_SEND_STATUSES.includes(inst.instance_kind === 'followup' ? placement.follow_up_status : placement.outreach_status)) continue;
      const inputsMoved = existing.level !== inst.level || existing.decision_inputs_hash !== hash || Number(existing.path_revision) !== Number(pathRevision);
      const changed = inputsMoved || (existing.floor_waiver_id || null) !== floorWaiverId || existing.reason !== inst.reason;
      if (!changed && ts(existing.decided_at) >= Math.max(staleAfter, ts(placement.updated_at))) continue;
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
      out.invalidatedApprovals += await invalidateApprovals(trx, [r], 'instance no longer required by the path', now);
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
    // an owner-gated send is approval-ready only once a DRAFTED message exists
    // (the draft lease, mode=draft, runs first; the card binds the draft); an
    // ambiguous send (sending / send_error) stays in the reconciliation
    // lifecycle, which loads `prospect` rows only — parking it would strand it
    const draftReady = (r) => (r.instance_kind === 'followup' ? placement.follow_up_status : placement.outreach_status) === 'drafted';
    const gates = (r) => {
      if (authorized(r)) return false;
      if (!isOwner(r.level)) return false;
      if (r.dimension === 'communication' && !draftReady(r) && (r.level === 'OWNER_OUTREACH' || r.level === 'OWNER_LEGAL')) return false;
      if (deferred(r, lane)) return false;
      return true;
    };
    const ownerGated = live.some(gates);
    const leased = Boolean(placement.claimed_at);
    let status = placement.status;
    let transition = null;
    if (status === PARKABLE && ownerGated && !leased) transition = { status: PARKED, parked_from_status: PARKABLE };
    else if (status === PARKED && !ownerGated && placement.parked_from_status === PARKABLE) transition = { status: PARKABLE, parked_from_status: null };
    // the display stamp lands unconditionally but WITHOUT touching updated_at
    // (a draft reported between the snapshot and this write keeps its later
    // timestamp, so the next selection still sees it); a status move is
    // OPTIMISTIC on the status + lease the decision read — the worker's
    // claim/report and the outreach save/send lock the row without this domain
    // lock, so a row a report promoted or a claim leased since the snapshot is
    // not this run's to move (the next run re-reads it)
    if (Object.keys(patch).length) await trx('seo_link_prospects').where({ id: placement.id }).update(patch);
    if (transition) {
      // compare-and-swap on status, lease AND the outreach state that produced `draftReady` — a send that started
      // after the snapshot (drafted → sending) must not be parked under it
      const cas = trx('seo_link_prospects').where({ id: placement.id, status: placement.status }).whereNull('claimed_at');
      if (placement.outreach_status == null) cas.whereNull('outreach_status'); else cas.where('outreach_status', placement.outreach_status);
      const applied = await cas.update({ ...transition, updated_at: now });
      if (applied) {
        status = transition.status;
        if (status === PARKED) {
          out.parked += 1;
          if (!out.parkedDomains.includes(domain.domain)) out.parkedDomains.push(domain.domain);
        } else out.released += 1;
      }
    }
    summaries.push({ id: placement.id, status, authority, rows: live, ...lane, claimed_at: placement.claimed_at || null });
  }

  // informational stamp on the path — that column only, never the revision or updated_at
  const pathLevel = mostSevere(summaries.map((s) => s.authority).filter(Boolean));
  if (pathLevel && pathLevel !== path.authority_last_decided) await trx('seo_link_acquisition_paths').where({ id: path.id }).update({ authority_last_decided: pathLevel });

  // §3.1 aggregate over ALL the domain's placements, not only the ones bridged
  // now. A `rejected` domain is re-aggregated on the owner's explicit "Acquire
  // anyway" (a valid waiver) or when the rejection was the bridge's own
  // (bridgeRejected) — the worker excludes `rejected` domains, so a lifted
  // DENY that never reached the aggregate would strand the domain for good.
  if (BRIDGE_STATES.includes(domain.agent_state) || (domain.agent_state === 'rejected' && (waiver || bridgeRejected))) {
    const all = await trx('seo_link_prospects').where({ domain_id: domain.id }).select('id', 'status', 'path_id', 'claimed_at', 'location_key', 'conversation_closed_at');
    // the bridged placements' status + lease come from THIS read, not the
    // pre-decision snapshot: a claim or report that landed meanwhile (the
    // worker locks the row without this domain lock) is what the aggregate sees
    const fresh = new Map(all.map((p) => [p.id, p]));
    const seen = new Map(summaries.map((s) => { const f = fresh.get(s.id); return [s.id, f ? { ...s, status: f.status, claimed_at: f.claimed_at || null, conversation_closed_at: f.conversation_closed_at || null } : s]; }));
    const others = all.filter((p) => !seen.has(p.id));
    const otherRows = others.length ? await annotateApprovals(trx, await trx(AUTH).whereIn('prospect_id', others.map((p) => p.id)).whereNull('ended_at').select('*')) : [];
    const otherPathIds = [...new Set(others.map((p) => p.path_id).filter(Boolean))];
    const otherPaths = otherPathIds.length ? await trx('seo_link_acquisition_paths').whereIn('id', otherPathIds).select('id', 'acquisition_type', 'account_required', 'execution_after_send') : [];
    const laneById = new Map(otherPaths.map((p) => { const outreach = OUTREACH_ACQUISITION_TYPES.includes(p.acquisition_type); return [p.id, { outreach, sendFirst: outreach && !P.submitFirst(p) }]; }));
    // an off-shape row (the other lane's keys) is INERT in the aggregate except for a live/indexed link it already won:
    // its workflow status cannot progress (no authority) and must not hold the domain at acquiring / qualified
    for (const p of others) seen.set(p.id, { id: p.id, status: p.status, rows: otherRows.filter((r) => r.prospect_id === p.id), ...(laneById.get(p.path_id) || { outreach: false, sendFirst: false }), claimed_at: p.claimed_at || null, conversation_closed_at: p.conversation_closed_at || null, offShape: !shape.has(p.location_key) });
    const next = aggregateState([...seen.values()]);
    if (next !== domain.agent_state) {
      const moved = await trx('seo_link_domains').where({ id: domain.id, agent_state: domain.agent_state }).update({ agent_state: next, rejected_by: next === 'rejected' ? 'bridge' : null, updated_at: now });
      if (moved) out.aggregateChanges += 1;
    }
  }
  return { decided: true, out };
}

// §3.1 — ready_to_acquire while ANY authorized placement is pending UNLEASED;
// acquired once live with NOTHING pending (no active intermediate, no
// owner-held sibling); acquiring for the active intermediates — a leased
// placement, `placed`, `contacted`/`negotiating`, or parked at a handoff
// (`ready_for_credentials`/`ready_for_payment`) — a CLOSED conversation
// (§13: conversation_closed_at, silent, its inbox and domain released) is
// history, not an active intermediate; qualified while the owner
// (or a deferred owner decision) holds it; back to investigating when EVERY
// placement's current BLOCKING decision is INVALID; rejected ONLY when every
// one is DENY (a single DENY beside a pending sibling never rejects; a carried
// satisfied instance — the pitch went out, the money left — is history, not a
// decision, and never masks a terminal level; a placement with NO blocking
// row — a historical lost/rejected one, an unbridged one — casts no vote; an
// `offShape` placement counts only for a live/indexed link it already won).
// "authorized" = satisfied, AUTO_*, or OWNER_* with a valid approval; a
// DEFERRED row (payment on an outreach placement, `outreach: true`; the acquire
// step on a send-first one, `sendFirst: true`) is not pending — it is settled
// at checkout / at the publisher's step, after the send.
function aggregateState(placements) {
  const rows = (p) => p.rows || [];
  const pending = (p) => rows(p).filter((r) => !deferred(r, p));
  const leased = (p) => Boolean(p.claimed_at);
  const authorizedPending = (p) => p.status === PARKABLE && !leased(p) && pending(p).length > 0 && pending(p).every(authorized);
  const ownerPending = (p) => p.status === PARKABLE && pending(p).some((r) => !authorized(r) && isOwner(r.level));
  const blocking = (p) => rows(p).filter((r) => !r.satisfied_at);
  const live = (p) => !p.offShape;
  const judged = placements.filter((p) => live(p) && blocking(p).length > 0);
  const every = (level) => judged.length > 0 && judged.every((p) => blocking(p).every((r) => r.level === level));
  const active = (p) => live(p) && (leased(p) || (ACQUIRING_STATUSES.includes(p.status) && !p.conversation_closed_at));
  const held = (p) => live(p) && (p.status === PARKED || ownerPending(p));
  if (placements.some((p) => live(p) && authorizedPending(p))) return 'ready_to_acquire';
  if (placements.some((p) => LIVE_STATUSES.includes(p.status)) && !placements.some(active) && !placements.some(held)) return 'acquired';
  if (placements.some(active)) return 'acquiring';
  if (placements.some(held)) return 'qualified';
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
  exclusive = defaultExclusive, notify = defaultNotify, autoSend = false, send = defaultSend,
} = {}) {
  const now = fixedNow || new Date();
  const gated = !isEnabled('linkAuthority');
  limit = Math.max(1, Math.min(Math.floor(Number(limit) || 0) || DEFAULT_LIMIT, RUN_LIMIT_MAX));
  const { policy, updated_at: policyUpdatedAt } = await P.loadPolicy(db);
  const targets = await selectDomains(db, { domainIds, limit, policyUpdatedAt });
  const out = { dryRun, gated, selected: targets.length, decided: 0, ...freshCounters(), errors: [] };
  delete out.parkedDomains;
  if (gated || dryRun) return out;

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
  if (ran && ran.skipped) out.skipped = ran.reason || 'lease_held';
  // the §6.4 sweep runs even when the DECISION lease was held (a manual / inline run holds it with autoSend false, so
  // no other holder would send): the sender claims every row under its own locks and needs no bridge lease
  if (autoSend) await dispatchAutoSends(db, out, { send, now, exclusive });
  await bellForParked(notify, out, parkedDomains, now);
  return out;
}

// §6.4 — every pending authorized draft (this run's and the ones the cap deferred); the outreach gate is the
// sender's own first check. A failure is one error entry on the run, never a thrown nightly.
async function dispatchAutoSends(db, out, { send, now, exclusive }) {
  if (!isEnabled('linkProspectOutreach')) return;
  try {
    // Share the scan lease through reconciliation AND dispatch: no weekly scan
    // can still be publishing evidence while this bridge chooses a follow-up.
    const result = await exclusive('backlink-scan', async () => {
      await require('./link-prospect-verifier').reconcileOutreach({ now });
      return autoSendDecided(db, { send, now });
    }, { recordHealth: false });
    out.autoSend = result?.skipped === true
      ? { attempted: 0, sent: 0, skipped: [{ code: 'backlink_scan_busy' }] } : result;
    const skipped = out.autoSend.skipped.length ? ` (${out.autoSend.skipped.map((s) => s.code).join(', ')})` : '';
    if (out.autoSend.attempted) logger.info(`[link-authority] auto-outreach: ${out.autoSend.sent}/${out.autoSend.attempted} sent${skipped}`);
  } catch (err) {
    logger.error(`[link-authority] auto-outreach failed: ${err.message}`);
    out.errors.push({ autoSend: err.message });
  }
}

// ONE bell per run that parked something (never per card); keyed by ET day so a re-run refreshes it
async function bellForParked(notify, out, parkedDomains, now) {
  if (!(out.parked > 0)) return;
  try {
    await notify('Link placements await your decision', `${out.parked} placement${out.parked === 1 ? '' : 's'} parked awaiting your approval: ${parkedDomains.slice(0, 8).join(', ')}${parkedDomains.length > 8 ? ` +${parkedDomains.length - 8} more` : ''}`, {
        link: '/admin/seo', bell: true, dedupeKey: `link-authority:${etDateString(now)}`, refreshOnDedupe: true,
        metadata: { lane: 'link_authority', parked: out.parked, domains: parkedDomains },
      });
  } catch (err) { logger.error(`[link-authority] bell failed: ${err.message}`); }
}

module.exports = { runAuthorityBridge, aggregateState, annotateApprovals, invalidateApprovals, autoSendDecided, openOwnerHold, LOCK_KEY, HOMEPAGE, RUN_LIMIT_MAX, DEFAULT_LIMIT };
