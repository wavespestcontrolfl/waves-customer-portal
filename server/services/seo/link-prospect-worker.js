/**
 * Link Prospect Worker contract (Backlink Manager M3a)
 *
 * The machine-to-machine boundary the Hermes (Docker) acquisition agent uses.
 * Hermes is "the hands" — it claims unworked prospects, executes the signup/
 * outreach, and reports back. It NEVER writes canonical truth: a report only
 * moves a prospect to `placed`; the nightly verifier + indexer confirm and
 * promote to `live`/`indexed` ("verify, don't trust").
 */
const db = require('../../models/db');
// Lazy: prospect-domain-lock requires this module (SIGNUP_TYPES) — resolve at call time.
const locationKeyOf = (v) => require('./prospect-domain-lock').locationKeyOf(v);
// Lazy for the same reason. Settlement runs in TWO places: inside claim()
// (under its row locks, before the lease — the guarantee for every row that
// is claimed again) and at every lease RELEASE, for rows that leave
// claimability (placed / rejected / drafted) and would otherwise stay linked
// to a retired path forever. The release-side move carries the registry's
// optimistic predicate (path, lease, outreach state); a claim that slips in
// between the release and this call simply settles the row itself.
// Release + settlement are ONE transaction (`q` is the caller's trx): a
// settlement failure rolls the release back too, so the lease stands and a
// later report / sweep retries both — never a released row stranded on a
// retired path by a swallowed error.
const settleReleasedPlacements = (ids, q = db) => {
  if (!Array.isArray(ids) || !ids.length) return Promise.resolve(0);
  return require('./link-registry').settleRetiredPlacements(q, { prospectIds: ids });
};
const logger = require('../logger');
const { WAVES_LOCATIONS } = require('../../config/locations');

const WORKER = 'hermes';
const SIGNUP_TYPES = ['directory', 'citation', 'social'];
const OUTREACH_TYPES = ['editorial', 'resource', 'guest_post', 'haro'];
// Registry domain states under which no placement is leased (plan §7: the
// registry must not be new / investigating / not_reproducible / rejected /
// watching): the owner's Watch / Reject rulings, an investigation in flight,
// and a domain no route could be reproduced on. `new` (never investigated)
// joins the list only while the investigator is ON (GATE_LINK_INVESTIGATOR):
// with it dark nothing moves a domain out of `new` — every legacy-board
// domain sits there — so listing it would halt every claim; once the
// investigator qualifies domains, an uninvestigated one waits its turn.
const NON_CLAIMABLE_DOMAIN_STATES = ['investigating', 'not_reproducible', 'watching', 'rejected'];
function nonClaimableDomainStates() {
  return require('../../config/feature-gates').isEnabled('linkInvestigator') ? ['new', ...NON_CLAIMABLE_DOMAIN_STATES] : NON_CLAIMABLE_DOMAIN_STATES;
}
const MAX_ATTEMPTS = 4;

// Recipient sanity check, shared by the outreach send valve (link-prospect-outreach
// re-exports this) so a worker-drafted address is held to the same bar a send needs —
// otherwise an invalid draft parks unsendable in the approval queue. Gmail is the
// real validator; this just rejects obvious garbage. Lives here (the base module) to
// keep the outreach→worker dependency one-directional.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return t.length > 0 && t.length <= 254 && EMAIL_RE.test(t);
}

// quality_signals may arrive as an object (pg jsonb) or a JSON string.
function parseQuality(q) {
  if (!q) return {};
  if (typeof q === 'object') return { ...q };
  try { return JSON.parse(q) || {}; } catch { return {}; }
}

/**
 * Lease up to n unworked prospects of a lane, atomically. FOR UPDATE SKIP LOCKED
 * so parallel Hermes subagents never grab the same row.
 */
// SAFETY DEFAULT for signup-lane claims: filter to the classifier's auto-safe lane
// (automation_policy='submit_free') UNLESS the caller explicitly opts into another
// policy. So the external Hermes worker — which calls claim({n,type}) with no policy —
// can never lease a row the classifier/runner parked as needs_account / pay_and_submit /
// skip. Pass automationPolicy:'any' to deliberately bypass the filter. Outreach lane is
// unaffected (it has no automation_policy). Pure → unit-testable without the DB.
function effectiveAutomationPolicy(type, automationPolicy) {
  if (type === 'outreach') return null;
  if (automationPolicy == null) return 'submit_free';
  if (automationPolicy === 'any') return null;
  return automationPolicy;
}

async function claim({ n = 10, type = 'signup', requireContactEmail = false, automationPolicy = null, domains = null, preview = false, followUp = false } = {}) {
  const types = type === 'outreach' ? OUTREACH_TYPES : SIGNUP_TYPES;
  const limit = Math.min(Math.max(parseInt(n, 10) || 1, 1), 50);
  // the §6.4 follow-up lane: a DRAFT lease over sent conversations whose follow-up is due — its own predicate
  if (followUp) return db.transaction((trx) => claimFollowUps(trx, { limit, preview }));
  const effectivePolicy = effectiveAutomationPolicy(type, automationPolicy);
  // Normalize the optional domain allowlist (lowercase, strip scheme/www) so it
  // matches the SQL-normalized target_domain below.
  const domainAllow = Array.isArray(domains)
    ? domains.map((d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean)
    : null;

  return db.transaction(async (trx) => {
    // The candidate query is a FACTORY: a claim may need more than one batch
    // (below), and each batch excludes the candidates already consumed.
    const candidates = () => {
    let q = trx('seo_link_prospects')
      .where({ status: 'prospect' })
      .whereIn('link_type', types)
      .whereNull('claimed_at')
      // Don't re-serve a prospect that already has a pending/sent/quarantined outreach
      // draft — a drafted prospect stays status='prospect' until the operator approves
      // the send (M3b); send_error rows await human reconciliation. Without this they'd
      // be re-claimed and re-drafted, reopening a possibly-sent message.
      .whereRaw("COALESCE(outreach_status, 'none') NOT IN ('drafted', 'sending', 'sent', 'send_error')")
      // …nor one that already carries a sent stamp whatever its status
      // reads (locked outreach state — the registry refuses to move it and
      // no worker may re-serve it)
      .whereNull('outreach_sent_at')
      // …and it must be LINKED to an acquisition path at all: a board row the
      // periodic catch-up has not yet linked (up to hours after insert) has
      // passed no confidence / completability / supersession check, so it is
      // not leased — nor previewed — until the registry knows its path
      .whereNotNull('path_id')
      // …and a DISPROVEN path (confidence 0 — gone, omitted under coverage,
      // or an unobserved claim) is filtered here, before ordering and LIMIT,
      // so a prefix of higher-ranked rows on dead routes can never consume
      // the batch and starve valid prospects below. RETIRED (superseded)
      // paths deliberately stay IN the candidate set: settlement below is
      // the only thing that moves such a placement onto its successor, and
      // each one is consumed by it exactly once (moved, unclassified, then
      // ineligible until the classifier has read the successor).
      .whereNotIn('path_id',
        trx('seo_link_acquisition_paths').select('id').whereNull('superseded_by') // ACTIVE rows only — a retired zero-confidence path still reaches settlement
          .where((s) => s.whereNull('confidence').orWhere('confidence', '<=', 0).orWhere('agent_completable', false))) // never assessed (NULL), disproven, or a route whose contract needs a human step
      // …and the owner's registry ruling holds at the chokepoint: a placement
      // on a domain the owner parked (Watch) or refused (Reject) is never
      // leased, whatever its own status/policy/confidence still read
      .where((b) => b.whereNull('domain_id').orWhereNotIn('domain_id',
        trx('seo_link_domains').select('id').whereIn('agent_state', nonClaimableDomainStates())));
    // The in-process auto-drafter emails a stored contact and can't fill a web form,
    // so it claims only prospects that already have a contact_email — leaving
    // form-only prospects untouched (status='prospect') for manual handling rather
    // than claiming+skipping them every run. External callers (Hermes) omit this and
    // do their own recipient research.
    if (requireContactEmail) q = q.whereNotNull('contact_email');
    // The citation runner (and, by the safety default above, the Hermes signup path)
    // leases only prospects the classifier marked auto-safe — never account/payment/
    // CAPTCHA-gated ones.
    if (effectivePolicy) q = q.where('automation_policy', effectivePolicy);
    // Supervised-first: when a domain allowlist is supplied, claim ONLY those rows
    // (host-normalized match) so higher-ranked non-allowlisted rows aren't leased and
    // released every run, starving the allowlisted target. SECURITY note: this is the
    // STARVATION fix only — the runner still independently validates each navigated
    // URL's host before submitting.
    if (domainAllow && domainAllow.length) {
      q = q.where((b) => {
        for (const d of domainAllow) {
          // NB: write the optional scheme as https{0,1}, NOT https? — a literal ? inside a knex
          // whereRaw is parsed as a positional binding placeholder, so https? plus the real "= ?"
          // reads as 2 placeholders for 1 value ("Expected 1 bindings, saw 2"). {0,1} is equivalent.
          b.orWhereRaw("lower(regexp_replace(regexp_replace(target_domain, '^https{0,1}://', ''), '^www\\.', '')) = ?", [d]);
        }
      });
    } else if (domainAllow) {
      // An explicit-but-empty allowlist matches nothing (don't silently claim all).
      q = q.whereRaw('1 = 0');
    }
    return q;
    };
    const ranked = (n2, exclude) => {
      let q = candidates();
      if (exclude.length) q = q.whereNotIn('id', exclude);
      return q
        .orderByRaw("CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END")
        .orderBy('domain_rating', 'desc')
        .limit(n2);
    };

    // Read-only preview (dry-run): return matching rows WITHOUT leasing them — no
    // claimed_at/claimed_by write, no lease_token — so a dry run honors its no-writes
    // contract and never strands rows until the stale sweep. A live claim would
    // SETTLE rows on superseded paths (moved, unclassified, not leased), so the
    // preview excludes them rather than report a retired URL as claimable.
    // …and a placement whose target_url lags its LIVE path's submission_url
    // is excluded too: a live claim would refresh the URL, unclassify the row
    // and defer it (below) rather than lease it, so the preview must not show
    // it as claimable — least of all under the obsolete URL.
    // …nor a placement whose LANE drifted from its path's (re-laned in place,
    // same URL): a live claim would re-lane and defer it, so the preview
    // must not show it — least of all as this lane's work.
    // Like the live claim, the preview batches until `limit` valid rows are
    // collected or the candidates run out — the URL and lane checks run
    // after LIMIT, so a prefix of such rows must not hide valid rows below it.
    if (preview) {
      const out = [];
      const seen = [];
      while (out.length < limit) {
        const batch = await ranked(limit - out.length, seen).whereNotIn('path_id', trx('seo_link_acquisition_paths').select('id').whereNotNull('superseded_by'));
        if (batch.length === 0) break;
        for (const r of batch) seen.push(r.id);
        const batchPathIds = [...new Set(batch.map((r) => r.path_id).filter(Boolean))];
        const batchPaths = batchPathIds.length ? await trx('seo_link_acquisition_paths').whereIn('id', batchPathIds).select('id', 'submission_url', 'link_type') : [];
        const liveUrlOf = new Map(batchPaths.map((p) => [p.id, p.submission_url]));
        const laneOf = new Map(batchPaths.map((p) => [p.id, p.link_type || null]));
        for (const r of batch) {
          const liveUrl = r.path_id ? liveUrlOf.get(r.path_id) : null;
          const lane = r.path_id ? laneOf.get(r.path_id) : null;
          if (!(liveUrl && r.target_url !== liveUrl) && !(lane && lane !== r.link_type)) out.push({ ...r });
        }
      }
      return out;
    }

    // Batches until `limit` live rows are leased or the candidates run out:
    // the LIMIT is applied before settlement, so a batch whose top rows are
    // all retired (settled, unclassified, not leased) must not make a
    // one-shot worker conclude there is no work while claimable rows sit
    // below them. Every batch excludes the candidates already consumed, so
    // the loop terminates by EXHAUSTION (a finite board, each round consuming
    // fresh rows) — never by a round cap that could return an empty batch
    // with claimable rows still unread.
    const out = [];
    const consumed = [];
    const now = new Date();
    while (out.length < limit) {
    let rows = await ranked(limit - out.length, consumed).forUpdate().skipLocked();
    if (rows.length === 0) break; // exhausted
    for (const r of rows) consumed.push(r.id);
    const ids = rows.map((r) => r.id);
    // Settle BEFORE leasing, under the row locks just taken: a placement
    // whose path the investigator superseded (while it was leased, or since
    // its last release) is handed out on the LIVE path — never the retired
    // path_id / obsolete target_url. Doing it here, atomically with the
    // claim, is the one place every execution passes through; a release-
    // then-settle sequence could always be raced by the next claim. Fails
    // closed: a settlement error aborts the claim (nothing leased).
    await require('./link-registry').settleRetiredPlacements(trx, { prospectIds: ids, now: new Date() });
    // ALWAYS re-read and re-validate after settlement — whether or not
    // anything moved: a placement whose settlement was REFUSED (locked
    // outreach state) still sits on a retired path and must not be leased
    // either. The lane/policy filters above ran against the pre-settlement
    // row; a moved placement takes the successor's lane and is left
    // UNCLASSIFIED (policy null until the weekly classifier has read the
    // successor's page), so it is no longer eligible for THIS claim.
    const current = await trx('seo_link_prospects').whereIn('id', ids).select('id', 'path_id', 'target_url', 'link_type', 'automation_policy', 'last_classified_at');
    const byId = new Map((current || []).map((m) => [m.id, m]));
    rows = rows.map((r) => ({ ...r, ...(byId.get(r.id) || {}) }));
    // …and a placement is leased only on a path that is LIVE and STANDING:
    // not retired into a successor, and not DISPROVEN — the investigator
    // zeroes a path's confidence when a covered re-investigation omits it
    // or its URL returns 404/410 (and writes an unverified submission URL
    // at confidence 0); neither is a route a worker may act on, whatever
    // policy the placement still carries.
    const pathIds = [...new Set(rows.map((r) => r.path_id).filter(Boolean))];
    // …read FOR UPDATE: the path rows stay locked through the lease write, so an
    // investigation superseding or revising one of them waits for this commit
    // (its settlement then finds the leased row's stamp) instead of the claim
    // handing Hermes a path/URL that changed between this read and the lease
    const paths = pathIds.length ? await trx('seo_link_acquisition_paths').whereIn('id', pathIds).forUpdate().select('id', 'superseded_by', 'confidence', 'submission_url', 'revision', 'agent_completable', 'link_type') : [];
    // …nor one the investigator marked NOT agent-completable: its contract
    // requires a human step (plan §6.3), and the outreach lane has no policy
    // filter that would otherwise stop Hermes from leasing it
    // …STANDING means a POSITIVE confidence: a path whose confidence is NULL
    // (schema-permitted — never assessed) or non-numeric has passed no check
    // and is refused exactly like a disproven one (fail closed)
    const { isStandingConfidence } = require('./link-registry');
    const blocked = new Set(paths.filter((p) => p.superseded_by || !isStandingConfidence(p.confidence) || p.agent_completable === false).map((p) => p.id));
    // …and the placement's LANE must be its path's lane: settlement above
    // reconciles a drifted lane, but a settlement it REFUSED (locked outreach
    // state) leaves the row where it was — a row whose path now belongs to
    // another lane is never handed to this lane's worker
    const laneOf = new Map(paths.map((p) => [p.id, p.link_type || null]));
    rows = rows.filter((r) => !blocked.has(r.path_id) && types.includes(r.link_type) && (laneOf.get(r.path_id) == null || laneOf.get(r.path_id) === r.link_type));
    if (effectivePolicy) rows = rows.filter((r) => r.automation_policy === effectivePolicy);
    if (rows.length === 0) continue;
    // The LIVE path's submission_url is the execution truth: when the
    // investigator moved a route to its working origin (www / http) while
    // this placement was leased, its target_url still names the dead apex —
    // refresh it here, under the claim's lock. A changed execution URL is a
    // NEW page for the classifier (a fallback vhost may be paid, gated or
    // off-target), so the row is left unclassified and NOT leased now — the
    // same fail-closed transition a path supersession applies.
    const urlOf = new Map(paths.map((p) => [p.id, p.submission_url]));
    const deferred = new Set();
    for (const r of rows) {
      const liveUrl = r.path_id ? urlOf.get(r.path_id) : null;
      if (liveUrl && r.target_url !== liveUrl) {
        await trx('seo_link_prospects').where({ id: r.id }).whereNull('claimed_at')
          .update({ target_url: liveUrl, automation_policy: null, last_classified_at: null, updated_at: new Date() });
        deferred.add(r.id);
      }
    }
    rows = rows.filter((r) => !deferred.has(r.id));
    if (rows.length === 0) continue;
    const leaseIds = rows.map((r) => r.id);
    // The lease UPDATE re-asserts the owner's ruling: a Watch / Reject that
    // committed between the candidate SELECT and this statement (the txn
    // locks prospect rows, not domains) must win, so the non-claimable-
    // domain predicate rides the write itself. It also stamps the PATH
    // REVISION this lease was taken on, so a same-path change that lands
    // while the row is leased can be reconciled when the lease releases.
    const revisionOf = new Map(paths.map((p) => [p.id, p.revision == null ? null : Number(p.revision)]));
    for (const r of rows) {
      await trx('seo_link_prospects')
        .where({ id: r.id }).whereNull('claimed_at')
        .where((b) => b.whereNull('domain_id').orWhereNotIn('domain_id',
          trx('seo_link_domains').select('id').whereIn('agent_state', nonClaimableDomainStates())))
        .update({ claimed_at: now, claimed_by: WORKER, leased_path_revision: r.path_id ? revisionOf.get(r.path_id) ?? null : null, updated_at: now });
    }
    // only what the UPDATE actually leased is handed out
    const leased = await trx('seo_link_prospects').whereIn('id', leaseIds).where('claimed_at', now).select('id');
    const leasedIds = new Set((leased || []).map((l) => l.id));
    // lease_token = the claim timestamp; the worker echoes it back in /report so
    // a late report from a swept/reclaimed lease can't clobber a newer claim.
    for (const r of rows) if (leasedIds.has(r.id)) out.push({ ...r, claimed_at: now, claimed_by: WORKER, lease_token: now.toISOString() });
    }
    return out;
  });
}

/**
 * The follow-up draft lease (plan §6.4 / §7 `mode=draft` on the follow-up lane): a row whose initial pitch went out
 * (outreach_status 'sent'), whose ONE follow-up is due (follow_up_status none / due, follow_up_due_at reached) and
 * whose lifecycle is in FOLLOW_UP_STATUSES(path) — `contacted`, plus the Judge-owned placed / live / indexed on a
 * submit-first path — on a standing path, on a domain the owner has not parked or refused. The lease grants nothing
 * beyond composing the follow-up: the row's status is never touched; the lease is released by the `drafted` report
 * (→ follow_up_status 'drafted'), a 'failed' (back to due) or 'skipped' (→ skipped) report, or the stale sweep.
 * A sent row is outreach-locked (the mover refuses it), so no settlement runs here.
 */
async function claimFollowUps(trx, { limit, preview }) {
  const M = require('./link-outreach-mandate');
  const now = new Date();
  const widest = M.FOLLOW_UP_STATUSES({ execution_after_send: false });
  // the due set is small (one follow-up per conversation, ten days out) — read whole, narrowed below in order
  const due = await trx('seo_link_prospects')
    .whereIn('link_type', OUTREACH_TYPES)
    .whereNull('claimed_at')
    .where({ outreach_status: 'sent' })
    .whereIn('follow_up_status', ['none', 'due'])
    .whereNotNull('follow_up_due_at').where('follow_up_due_at', '<=', now)
    .whereIn('status', [...widest])
    .whereNotNull('path_id')
    .orderBy('follow_up_due_at', 'asc')
    .select('*');
  if (!due.length) return [];
  // the owner's registry ruling holds at the chokepoint: a placement on a parked (Watch) or refused (Reject) domain is never leased
  const blockedDomains = new Set((await trx('seo_link_domains').whereIn('agent_state', nonClaimableDomainStates()).select('id')).map((d) => d.id));
  const candidates = due.filter((r) => !r.domain_id || !blockedDomains.has(r.domain_id));
  if (!candidates.length) return [];
  const pathIds = [...new Set(candidates.map((r) => r.path_id))];
  const paths = await trx('seo_link_acquisition_paths').whereIn('id', pathIds).select('id', 'superseded_by', 'confidence', 'revision', 'agent_completable', 'execution_after_send');
  const pathById = new Map(paths.map((p) => [p.id, p]));
  const { isStandingConfidence } = require('./link-registry');
  // the lifecycle set is PATH-dependent: placed / live / indexed follow up only on a submit-first path
  const rows = candidates.filter((r) => {
    const p = pathById.get(r.path_id);
    return p && !p.superseded_by && isStandingConfidence(p.confidence) && p.agent_completable !== false && M.FOLLOW_UP_STATUSES(p).includes(r.status);
  }).slice(0, limit);
  if (preview) return rows.map((r) => ({ ...r }));
  const out = [];
  for (const r of rows) {
    const n = await trx('seo_link_prospects').where({ id: r.id, outreach_status: 'sent' }).whereIn('follow_up_status', ['none', 'due']).whereNull('claimed_at')
      .update({ claimed_at: now, claimed_by: WORKER, follow_up_status: 'due', leased_path_revision: pathById.get(r.path_id).revision == null ? null : Number(pathById.get(r.path_id).revision), updated_at: now });
    if (n) out.push({ ...r, follow_up_status: 'due', claimed_at: now, claimed_by: WORKER, lease_token: now.toISOString() });
  }
  return out;
}

/**
 * Map a worker outcome to a DB patch. Pure (no I/O) → unit-testable.
 * Always releases the lease. `placed` never goes straight to `live`.
 * `existingQuality` is the prospect's current quality_signals (object|json|null),
 * merged into so a pending marker doesn't clobber prior signals.
 */
function mapReportToPatch(outcome, body = {}, existingQuality = null) {
  const now = new Date();
  const release = { claimed_at: null, claimed_by: null, updated_at: now };

  if (outcome === 'placed') {
    // Persist a paid-placement cost (e.g. sponsored post) for funnel ROI; only a
    // valid non-negative number, else null. Accept a real number or a non-blank
    // numeric string ONLY — Number('')/Number('  ')/Number(false)/Number([]) all
    // coerce to 0, which would record a blank field as a bogus free placement.
    const raw = body.cost;
    const isNumericInput = typeof raw === 'number'
      || (typeof raw === 'string' && raw.trim() !== '');
    const n = Number(raw);
    const cost = isNumericInput && Number.isFinite(n) && n >= 0 ? n : null;
    const patch = {
      ...release,
      status: 'placed',
      live_url: body.live_url || null,
      anchor_text: body.claimed_anchor || null,
      evidence_url: body.evidence_url || null,
      cost,
      notes: body.notes || null,
    };
    // Pending = submitted to a slow-moderation directory; the live URL may be unknown
    // until approval. cited_homepage = this placement links to the homepage (signup
    // runner), so the verifier reconciles THIS row against the homepage, not its
    // target_page — scoping the homepage rule to runner-created rows only. location =
    // the GBP location this placement is for; the signup runner's durable de-dupe
    // (alreadyPlacedAt) keys on (target_domain, quality_signals.location) so a multi-
    // location business gets one listing PER location per directory, and a SECOND row
    // for the SAME (domain, location) is recognized as a duplicate even across runs.
    if (body.pending || body.cited_homepage || body.location) {
      const quality = parseQuality(existingQuality);
      if (body.pending) { quality.pending = true; quality.submitted_at = now.toISOString(); }
      if (body.cited_homepage) quality.cited_homepage = true;
      if (body.location) quality.location = String(body.location);
      patch.quality_signals = JSON.stringify(quality);
    }
    // v2 identity (plan §3.3): the placement's location_key — the third column
    // of the board's unique key and what the runner's alreadyPlacedAt keys on.
    // quality.location stays as the display signal; 'default' = not scoped.
    if (body.location) patch.location_key = locationKeyOf(body.location);
    return patch;
  }
  if (outcome === 'drafted') {
    // Hermes (hybrid lane) researched the target and drafted a one-to-one outreach
    // email. Park the draft for human approval — status stays 'prospect' (NOTHING
    // is sent until an operator approves the send in M3b). claim() skips drafted
    // rows so this isn't re-served. The send valve is link-prospect-outreach.js.
    const to = typeof body.outreach_to_email === 'string' ? body.outreach_to_email.trim() : '';
    return {
      ...release,
      outreach_to_email: to || null,
      outreach_subject: body.outreach_subject || null,
      outreach_body: body.outreach_body || null,
      outreach_status: 'drafted',
      notes: body.notes || null,
    };
  }
  if (outcome === 'skipped') {
    return { ...release, status: 'rejected', notes: body.notes || 'worker skipped' };
  }
  // failed: leave it claimable again (status unchanged) for a retry next sweep.
  return { ...release, notes: body.notes || null };
}

async function report({ prospect_id, outcome, lease_token, ...body }) {
  // A 'placed' report MUST carry a live_url — otherwise the row lands in 'placed'
  // with live_url=null, which the verifier skips and claim() never re-serves,
  // permanently stranding it. EXCEPTION: pending=true (slow-moderation submission)
  // is allowed without a live_url — the verifier's domain reconcile tracks it.
  if (outcome === 'placed' && !body.live_url && !body.pending) {
    return { ok: false, code: 'live_url_required', error: 'a placed report requires live_url (or pending:true)' };
  }
  const leaseDate = lease_token ? new Date(lease_token) : null;
  if (!leaseDate || Number.isNaN(leaseDate.getTime())) {
    return { ok: false, code: 'lease_required', error: 'valid lease_token required (the claimed_at returned by /claim)' };
  }

  const prospect = await db('seo_link_prospects').where({ id: prospect_id }).first();
  if (!prospect) return { ok: false, code: 'not_found', error: 'prospect not found' };
  // a leased FOLLOW-UP (the §6.4 draft lease: follow_up_status 'due' under a lease on a sent conversation) settles
  // on its own columns — never the lifecycle, the attempt count or the draft of the initial pitch
  if (followUpLease(prospect)) return reportFollowUp({ prospect, outcome, leaseDate, body });
  // A drafted report MUST carry the full draft, else the approval queue surfaces an
  // unsendable row that fails checkSendPreconditions at send time.
  if (outcome === 'drafted' && (!isValidEmail(body.outreach_to_email) || !body.outreach_subject || !body.outreach_body)) {
    return { ok: false, code: 'draft_incomplete', error: 'a drafted report requires a valid outreach_to_email, outreach_subject, and outreach_body' };
  }
  // Guard the lane: a 'drafted' report on a signup-lane prospect would set
  // outreach_status='drafted' on a row that claim() then skips and the send valve
  // rejects as not_outreach — stranding it. Only outreach prospects can be drafted.
  if (outcome === 'drafted' && !OUTREACH_TYPES.includes(prospect.link_type)) {
    return { ok: false, code: 'not_outreach', error: 'drafted is only valid for outreach-lane prospects' };
  }
  // Don't let a late 'drafted' report reopen an outreach that's already in flight,
  // sent, or quarantined after an ambiguous send — that would resurrect a sendable
  // draft and risk a duplicate. send_error rows need deliberate human reconciliation,
  // not a worker reopen. (The send path also clears the lease — defense in depth.)
  if (outcome === 'drafted' && (prospect.outreach_sent_at || ['sending', 'sent', 'send_error'].includes(prospect.outreach_status))) {
    return { ok: false, code: 'outreach_locked', error: 'outreach already sent, in flight, or awaiting reconciliation' };
  }

  const attempts = (prospect.attempts || 0) + 1;
  const patch = mapReportToPatch(outcome, body, prospect.quality_signals);
  // Cap retries so a permanently-failing prospect doesn't churn forever.
  if (outcome === 'failed' && attempts >= MAX_ATTEMPTS) patch.status = 'rejected';

  // Optimistic concurrency: only apply if THIS lease is still current. If the
  // claim was swept and re-claimed by another worker, claimed_at no longer
  // matches, the update affects 0 rows, and we reject the stale report.
  const { updated, moved, reopened } = await db.transaction(async (trx) => {
    const n = await trx('seo_link_prospects')
      .where({ id: prospect_id })
      .where('claimed_at', leaseDate)
      .update({ ...patch, attempts });
    if (!n) return { updated: 0, moved: 0, reopened: false };
    // the lease is released — a superseded / changed path is followed in the
    // SAME transaction, even if this row is never claimed again
    const settled = await settleReleasedPlacements([prospect_id], trx);
    let reopenedRow = false;
    // The retry lifecycle is PATH-specific: a failure (and the retry cap it
    // may have exhausted) belongs to the predecessor. When settlement just
    // moved the row onto a DIFFERENT path, the successor has had no attempt
    // yet — reopen it with a fresh count rather than leaving it terminal.
    // The same holds for a SAME-path revision that landed during the lease
    // (working URL, gate, lane): the route the attempts were spent on is
    // materially different now. A confidence-only disproof is not — a
    // route declared gone stays closed. `skipped` is a route-specific
    // decision too (no emailable contact on the OLD route, a duplicate on
    // the OLD page): it reopens the same way when the route changed.
    if (settled && (outcome === 'failed' || outcome === 'skipped')) {
      const after = await trx('seo_link_prospects').where({ id: prospect_id }).first('path_id');
      let reopen = false;
      if (after && after.path_id && after.path_id !== prospect.path_id) reopen = true;
      else if (after && after.path_id && prospect.leased_path_revision != null) {
        const pathNow = await trx('seo_link_acquisition_paths').where({ id: after.path_id }).first('revision');
        reopen = !!(pathNow && pathNow.revision != null && Number(pathNow.revision) > Number(prospect.leased_path_revision));
      }
      if (reopen) {
        await trx('seo_link_prospects').where({ id: prospect_id }).whereNull('claimed_at').update({ status: 'prospect', attempts: 0, updated_at: new Date() });
        reopenedRow = true;
      }
    }
    return { updated: n, moved: settled, reopened: reopenedRow };
  });

  if (updated === 0) {
    return { ok: false, code: 'stale_lease', error: 'lease expired or reclaimed; re-claim before reporting' };
  }
  // A `drafted` outcome whose settlement MOVED the placement no longer holds
  // a draft (the transition cleared copy composed for a retired route): the
  // report is honest about it, like saveDraft — the drafter must not count
  // it, the worker must not treat it as accepted.
  if (outcome === 'drafted' && moved) {
    logger.info(`[link-worker] report ${prospect_id} outcome=drafted discarded — its acquisition path moved while drafting`);
    return { ok: false, code: 'path_moved', error: 'the placement\'s acquisition path changed while drafting; the draft was discarded — re-draft against the current path' };
  }
  if (reopened) {
    logger.info(`[link-worker] report ${prospect_id} outcome=${outcome} on a superseded/revised path — reopened on its successor with a fresh retry count`);
    return { ok: true, status: 'prospect', attempts: 0, reopened_on_successor: true };
  }
  logger.info(`[link-worker] report ${prospect_id} outcome=${outcome} attempts=${attempts} -> ${patch.status || prospect.status}`);
  return { ok: true, status: patch.status || prospect.status, attempts };
}

const followUpLease = (p) => p.follow_up_status === 'due' && p.outreach_status === 'sent';
// the follow-up lane's report: drafted → the follow-up parked for the bridge's decision; failed → due again (the next
// sweep re-leases it); skipped → skipped for good, with the worker's reason. Any other outcome is not this lane's.
const FOLLOW_UP_OUTCOMES = ['drafted', 'failed', 'skipped'];
async function reportFollowUp({ prospect, outcome, leaseDate, body }) {
  if (!FOLLOW_UP_OUTCOMES.includes(outcome)) return { ok: false, code: 'not_follow_up_outcome', error: `a follow-up lease reports drafted, failed or skipped — not ${outcome}` };
  if (outcome === 'drafted' && (!body.outreach_subject || !body.outreach_body)) return { ok: false, code: 'draft_incomplete', error: 'a drafted follow-up requires outreach_subject and outreach_body (the recipient is the thread\'s)' };
  const now = new Date();
  const release = { claimed_at: null, claimed_by: null, updated_at: now };
  const note = body.notes || null;
  const patch = outcome === 'drafted'
    ? { ...release, follow_up_subject: body.outreach_subject, follow_up_body: body.outreach_body, follow_up_status: 'drafted', ...(note ? { notes: prospect.notes ? `${prospect.notes}\n${note}` : note } : {}) }
    : outcome === 'skipped'
      ? { ...release, follow_up_status: 'skipped', follow_up_skipped_reason: note || 'worker skipped' }
      : { ...release, follow_up_status: 'due' };
  // the same optimistic concurrency as the initial lane: only THIS lease writes, on the follow-up state it was taken in
  const n = await db('seo_link_prospects').where({ id: prospect.id, follow_up_status: 'due', outreach_status: 'sent' }).where('claimed_at', leaseDate).update(patch);
  if (!n) return { ok: false, code: 'stale_lease', error: 'lease expired or reclaimed; re-claim before reporting' };
  logger.info(`[link-worker] follow-up report ${prospect.id} outcome=${outcome}`);
  return { ok: true, status: prospect.status, follow_up_status: patch.follow_up_status };
}

/**
 * Canonical NAP served with every /claim response so the worker never invents
 * business details on a signup. Citations must match a GBP listing exactly —
 * locations.js addresses/phones ARE the GBP-listed ones — so this maps only
 * the public fields (no account ids, refresh-token env names, or resource names).
 */
function businessProfile() {
  return {
    brand: 'Waves Pest Control',
    website: 'https://wavespestcontrol.com',
    contact_email: process.env.HERMES_SIGNUP_EMAIL || 'contact@wavespestcontrol.com',
    default_location_id: 'bradenton',
    locations: WAVES_LOCATIONS.map((l) => ({
      id: l.id,
      name: l.name,
      address: l.address,
      phone: l.phone,
      google_place_id: l.googlePlaceId,
    })),
    instructions: 'Use the default location for brand-wide directories. Only use another '
      + 'listed location when the prospect targets that city. Never invent or reformat '
      + 'an address, phone, or email — copy them exactly as given.',
  };
}

/** Reclaim leases older than maxHours back to the pool (stuck-worker recovery). */
async function sweepExpiredClaims(maxHours = 6) {
  const cutoff = new Date(Date.now() - maxHours * 3600 * 1000);
  // ONE atomic statement: the state predicate rides the UPDATE (a row that
  // left `prospect` between a read and a write keeps its lease) and
  // RETURNING names exactly the rows released, for settlement.
  const released = await db.transaction(async (trx) => {
    const rows = await trx('seo_link_prospects')
      .whereNotNull('claimed_at')
      .where('claimed_at', '<', cutoff)
      .where({ status: 'prospect' }) // only release ones still unworked
      .update({ claimed_at: null, claimed_by: null, updated_at: new Date() })
      .returning(['id']);
    const ids = (rows || []).map((r) => (r && typeof r === 'object' ? r.id : r)).filter(Boolean);
    if (ids.length) await settleReleasedPlacements(ids, trx); // released AND settled, or neither
    // a stuck FOLLOW-UP draft lease (§6.4: a sent conversation leased at follow_up_status 'due') is released the same
    // way — the lifecycle is not `prospect` there and a sent row is never settled (outreach-locked)
    const followUps = await trx('seo_link_prospects')
      .whereNotNull('claimed_at').where('claimed_at', '<', cutoff)
      .where({ follow_up_status: 'due', outreach_status: 'sent' })
      .update({ claimed_at: null, claimed_by: null, updated_at: new Date() });
    return ids.length + (Number(followUps) || 0);
  });
  if (released) logger.info(`[link-worker] released ${released} stale claim(s)`);
  return { released };
}

/** Release specific leases back to the pool (e.g. a dry-run that claimed but won't
 *  report). Takes [{ id, lease_token }] and clears ONLY rows whose claimed_at still
 *  equals the lease we hold — so if the sweep released and another worker reclaimed
 *  mid-run, we never clobber that newer lease (optimistic-concurrency, same guard
 *  as report()). Never touches status/attempts. */
async function releaseClaims(claims = []) {
  if (!Array.isArray(claims) || claims.length === 0) return { released: 0 };
  let released = 0;
  for (const c of claims) {
    if (!c || !c.id || !c.lease_token) continue;
    const leaseDate = new Date(c.lease_token);
    if (Number.isNaN(leaseDate.getTime())) continue;
    released += await db.transaction(async (trx) => {
      const n = await trx('seo_link_prospects')
        .where({ id: c.id })
        .where('claimed_at', leaseDate)
        .update({ claimed_at: null, claimed_by: null, updated_at: new Date() });
      if (n) await settleReleasedPlacements([c.id], trx); // released AND settled, or neither
      return n;
    });
  }
  return { released };
}

module.exports = {
  claim, report, sweepExpiredClaims, releaseClaims, settleReleasedPlacements, mapReportToPatch, businessProfile, isValidEmail,
  FOLLOW_UP_OUTCOMES,
  effectiveAutomationPolicy,
  WORKER, SIGNUP_TYPES, OUTREACH_TYPES, MAX_ATTEMPTS, nonClaimableDomainStates,
};
