/**
 * Lost-link recovery — the reacquisition hook the inbound monitor never had.
 *
 * When the weekly scan verifies (by crawl) that a referring domain worth having
 * dropped its last live link to us, the domain goes onto the Link Building
 * board as a seo_link_prospects row with source='lost_recovery'. From there the
 * existing machinery takes over: the outreach drafter claims email-bearing
 * outreach prospects and parks a draft for the owner to approve; nothing here
 * sends anything.
 *
 * Scoring/contact discovery mirrors the strategist's create_link_prospects tool
 * (prospect-scorer is canonical for link_type and contact), fail-soft: a scorer
 * error still queues the row with what the monitor knows.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');

const worker = require('./link-prospect-worker');
const lockMod = require('./prospect-domain-lock');
const { claimProspectDomain, lockProspectDomain, canonicalProspectDomain, byDomain, TARGET_DOMAIN_CANONICAL_SQL } = lockMod;

// The worker's lane allowlists are canonical: signup-lane types are never
// reopened into outreach, and a reopened row must carry a type the outreach
// worker actually claims. Derived, never copied, so a reclassification there
// flows through here.
const NON_OUTREACH_TYPES = new Set(worker.SIGNUP_TYPES);
const OUTREACH_TYPES = new Set(worker.OUTREACH_TYPES);
// Board states that mean "someone is already on this" — never reopened here.
// Recovery excludes EVERY board row for the domain (see prospect-domain-lock).
const IN_FLIGHT_STATUSES = new Set(lockMod.IN_FLIGHT_STATUSES);
// Board says the link is up, monitor says the domain is dark: the board is
// stale (verifier runs after the scan). Deferred, never a terminal skip.
const STALE_WHEN_DOMAIN_DARK = new Set(['live', 'indexed']);

// Shared with every other board writer so they all lock the same key.
const normalizeDomain = canonicalProspectDomain;
// byDomain / TARGET_DOMAIN_CANONICAL_SQL come from prospect-domain-lock (one canonical host everywhere).

// targetPathOf / targetPageOf / targetPageVariants live in prospect-domain-lock
// (one canonical page identity for every board writer).
const { targetPathOf, targetPageOf, targetPageVariants } = lockMod;

/**
 * queueLostDomains(losses) — losses are the alertable entries from
 * BacklinkMonitor.domainLevelLosses(). Returns { queued, skipped, reasons[] }.
 */
async function queueLostDomains(losses, { scorer } = {}) {
  // results[] carries one verdict per loss so the caller can stamp the backlink
  // row: 'queued' / 'skipped' are final, 'error' / 'deferred' are retried next scan.
  const out = { queued: 0, skipped: 0, reasons: [], results: [] };
  if (!Array.isArray(losses) || !losses.length) return out;
  const scoreMod = scorer || require('./prospect-scorer');

  for (const loss of losses) {
    const before = { q: out.queued, s: out.skipped };
    try {
      const verdict = await queueOne(loss, out, scoreMod);
      // 'deferred' (like 'error') is NOT terminal: the caller leaves the
      // backlink's recovery marker null and the owed sweep retries next scan.
      const outcome = verdict === 'deferred' ? 'deferred' : out.queued > before.q ? 'queued' : 'skipped';
      out.results.push({ domain: loss && loss.domain, backlink_id: loss && loss.backlink_id, outcome });
    } catch (err) {
      out.results.push({ domain: loss && loss.domain, backlink_id: loss && loss.backlink_id, outcome: 'error' });
      // One bad row must not abort the batch — the rest still queue, and the
      // domain stays lost so the next scan does not retry it (logged instead).
      out.skipped++;
      out.reasons.push({ domain: loss && loss.domain, reason: `error: ${err.message}` });
      logger.warn(`[lost-link-recovery] ${loss && loss.domain}: ${err.message}`);
    }
  }

  if (out.queued || out.skipped) logger.info(`[lost-link-recovery] queued ${out.queued}, skipped ${out.skipped}`);
  return out;
}

async function queueOne(loss, out, scoreMod) {
  {
    const domain = normalizeDomain(loss.domain);
    const targetPage = targetPageOf(loss.target_url);
    if (!domain) { out.skipped++; return; }

    // Recovery is DOMAIN-scoped (one representative loss per domain, resolved at
    // domain scope when any link returns): if the domain already has a row in
    // flight for ANY Waves page, a second claimable prospect would start parallel
    // outreach to the same inbox. Suppress; the existing row is the conversation.
    const inFlight = await byDomain(db('seo_link_prospects'), domain)
      .whereIn('status', [...IN_FLIGHT_STATUSES]).first('id', 'status', 'target_page');
    if (inFlight && IN_FLIGHT_STATUSES.has(inFlight.status)) {
      const where = inFlight.target_page ? ` for ${targetPathOf(inFlight.target_page)}` : '';
      if (STALE_WHEN_DOMAIN_DARK.has(inFlight.status)) {
        // The board still says live/indexed, but the monitor just verified the
        // domain has NO active link — the daily verifier (04:30 ET, after the
        // 03:30 scan) has not demoted it yet. Not a terminal verdict: leave the
        // recovery marker null so the owed sweep re-evaluates once the row is lost.
        out.skipped++;
        out.reasons.push({ domain, reason: `board row still ${inFlight.status}${where} — deferred until the verifier demotes it` });
        return 'deferred';
      }
      out.skipped++;
      out.reasons.push({ domain, reason: `already on board (${inFlight.status}${where})` });
      return;
    }

    // (target_domain, target_page) is unique on the board. A link we acquired
    // through the pipeline already has a row, and the outbound verifier moves
    // it to 'lost' when the inbound link disappears — that EXACT-page row is
    // REOPENED as a fresh prospect (the worker only claims status='prospect').
    // Rows rejected by the owner are left alone.
    const exists = await byDomain(db('seo_link_prospects'), domain).whereIn('target_page', targetPageVariants(loss.target_url)).first('id', 'status', 'notes', 'link_type');
    if (exists && exists.status === 'lost' && NON_OUTREACH_TYPES.has(exists.link_type)) {
      // A lost signup-lane placement (citation/directory/social) is not an
      // outreach target; reopening it would hand it to the citation runner.
      out.skipped++;
      out.reasons.push({ domain, reason: `lost ${exists.link_type} placement — signup lane, not reopened` });
      return;
    }
    if (exists && exists.status === 'lost') {
      const note = `Lost-link recovery: our link on ${loss.source_url} was verified gone (${loss.lost_reason}). Re-pitch for the same placement.`;
      // A fresh outreach cycle: the worker/send valve treat a populated
      // outreach_sent_at as "already sent" and the worker rejects rows whose
      // lifetime `attempts` hit MAX_ATTEMPTS — so both restart, with the prior
      // values kept in quality_signals (prior_outreach_sent_at, prior_attempts).
      // link_type is nullable (creation paths store null when scoring failed) and
      // the worker claims only OUTREACH_TYPES — a reopen must leave a claimable type.
      const reopenType = OUTREACH_TYPES.has(exists.link_type) ? exists.link_type
        : OUTREACH_TYPES.has(loss.link_type) ? loss.link_type : 'resource';
      // Under the shared per-domain board lock, with the domain-wide in-flight
      // probe REPEATED under it: another writer (admin/strategy/promoter — they
      // all take this lock) may have filed an in-flight row for this domain on
      // another page since the probe above; reopening beside it would leave two
      // claimable prospects for one inbox. Conditional on status='lost' too: the
      // daily verifier can restore the row to live between our read and this
      // write — a 0-row update means it is no longer lost, not reopened.
      const reopened = await db.transaction(async (trx) => {
        const { inFlight: raced } = await claimProspectDomain(trx, domain, { statuses: IN_FLIGHT_STATUSES, lanes: 'all' });
        if (raced) return { raced };
        return trx('seo_link_prospects').where({ id: exists.id, status: 'lost' }).update({
          status: 'prospect',
          priority: 'high',
          link_type: reopenType,
          claimed_at: null, claimed_by: null,
          attempts: 0,
          // The prior attempt is APPENDED to quality_signals.prior_outreach_attempts
          // (an append-only ledger dailySendCount also counts): a resend of this
          // reopened row stamps its own outreach_attempted_at, so every attempt
          // inside one trailing-24h window counts against the cap — however many
          // times the row is recovered, lost and reopened.
          outreach_status: 'none', outreach_send_token: null, outreach_sent_at: null, outreach_attempted_at: null,
          quality_signals: trx.raw(
            "jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(COALESCE(quality_signals, '{}'::jsonb), '{lost_recovery}', 'true'::jsonb, true), '{lost_reason}', to_jsonb(?::text), true), '{prior_outreach_sent_at}', COALESCE(to_jsonb(outreach_sent_at), COALESCE(quality_signals, '{}'::jsonb) -> 'prior_outreach_sent_at', 'null'::jsonb), true), '{prior_outreach_attempts}', CASE WHEN jsonb_typeof(COALESCE(quality_signals, '{}'::jsonb) -> 'prior_outreach_attempts') = 'array' THEN quality_signals -> 'prior_outreach_attempts' ELSE '[]'::jsonb END || COALESCE(to_jsonb(outreach_attempted_at), '[]'::jsonb), true), '{prior_attempts}', to_jsonb(COALESCE(attempts, 0)), true)",
            [loss.lost_reason || 'unknown'],
          ),
          notes: exists.notes ? `${exists.notes}\n${note}` : note,
          updated_at: new Date(),
        });
      });
      if (reopened && reopened.raced) {
        out.skipped++;
        out.reasons.push({ domain, reason: `already on board (concurrent ${reopened.raced.status}${reopened.raced.target_page ? ` for ${targetPathOf(reopened.raced.target_page)}` : ''})` });
        return;
      }
      if (!reopened) {
        out.skipped++;
        out.reasons.push({ domain, reason: 'board row no longer lost (restored concurrently)' });
        return;
      }
      out.queued++;
      out.reasons.push({ domain, reason: 'reopened lost prospect' });
      return;
    }
    if (exists) {
      out.skipped++;
      out.reasons.push({ domain, reason: IN_FLIGHT_STATUSES.has(exists.status) ? `already on board (${exists.status})` : `left alone (${exists.status})` });
      return;
    }

    let scored = null;
    try {
      const [r] = await scoreMod.scoreCandidates([{
        domain,
        domain_rating: loss.domain_rating || null,
        source_url: loss.source_url || null,
        sample_anchors: loss.anchor_text ? [loss.anchor_text] : [],
      }]);
      scored = r || null;
    } catch (err) {
      logger.warn(`[lost-link-recovery] scoring failed for ${domain}: ${err.message}`);
    }

    // The scorer's classification is canonical (same rule as create_link_prospects):
    // if it says this is a signup-lane site, it is not an outreach target and the
    // monitor's heuristic was wrong — don't put it in front of the drafter.
    // The scorer's classification is canonical; without one, the monitor's
    // heuristic type is only kept if the worker can claim it (the monitor
    // commonly says 'unknown'), else it falls back to 'resource' exactly like
    // prospect-scorer's own coercion for the outreach lane.
    const claimable = scoreMod.CLAIMABLE_LINK_TYPES || new Set(['editorial', 'resource', 'guest_post', 'haro', 'directory', 'citation', 'social']);
    const linkType = scored?.intent_class || (claimable.has(loss.link_type) ? loss.link_type : 'resource');
    if (NON_OUTREACH_TYPES.has(linkType)) {
      out.skipped++;
      out.reasons.push({ domain, reason: `scorer classified as ${linkType}` });
      return;
    }
    // Same contactability gate as create_link_prospects: an outreach target with
    // no way to reach a human (or a join-not-email HARO platform) never goes on
    // the board, no matter how good the lost placement was.
    if (scored && (!scored.gate?.ok || scored.gate.lane === 'haro_platform')) {
      out.skipped++;
      out.reasons.push({ domain, reason: scored.gate?.reason || 'no contact path' });
      return;
    }

    const qs = {
      lost_recovery: true,
      lost_reason: loss.lost_reason,
      previous_source_url: loss.source_url,
      relevance: scored?.relevance_0_100 ?? null,
      lead_value_tier: scored?.lead_value_tier ?? null,
      is_local_swfl: scored?.is_local_swfl ?? null,
      intent_class: scored?.intent_class ?? null,
      gate_lane: scored?.gate?.lane ?? null,
      scored_by: 'lost_link_recovery',
    };

    // Atomic against a concurrent writer racing the existence check (the
    // scoring/contact lookup above is slow): the unique (target_domain,
    // target_page) conflict is ignored and counted as a skip, never thrown.
    const inserted = await db.transaction(async (trx) => {
      // The shared admission guard (prospect-domain-lock — every board writer
      // goes through it): lock the canonical domain, then RE-CHECK in-flight
      // rows under it. The unique key is the textual (target_domain,
      // target_page) pair, so a row filed for this domain under another Waves
      // page or spelling during the slow scoring/contact lookup would not
      // conflict — it would land beside this one, both claimable.
      const { inFlight: raced } = await claimProspectDomain(trx, domain, { statuses: IN_FLIGHT_STATUSES, lanes: 'all' });
      if (raced) return { raced };
      return trx('seo_link_prospects').insert({
      target_domain: domain,
      target_url: loss.source_url || null,
      // live_url = the page the link lived on. It puts the row under the DAILY
      // verifier (which selects on live_url), so a link that quietly returns
      // between weekly inbound scans flips this row live before the drafter
      // pitches for it — the weekly scan's resolveRecoveredLink is the backstop.
      live_url: loss.source_url || null,
      target_page: targetPage,
      anchor_planned: loss.anchor_text || scored?.suggested_anchor || null,
      link_type: linkType,
      // A proven placement outranks a cold prospect regardless of the scorer's guess.
      priority: 'high',
      domain_rating: loss.domain_rating || null,
      contact_email: scored?.contact?.contact_email || null,
      contact_url: scored?.contact?.contact_url || null,
      contact_checked_at: scored?.contact ? new Date() : null,
      score: scored?.score ?? null,
      tier: scored?.tier ?? null,
      quality_signals: JSON.stringify(qs),
      notes: `Lost-link recovery: our link on ${loss.source_url} was verified gone (${loss.lost_reason}). Re-pitch for the same placement.`,
      source: 'lost_recovery',
      source_ref: loss.backlink_id || null,
      owner: 'backlink_monitor',
      }).onConflict(['target_domain', 'target_page']).ignore().returning('id');
    });
    if (inserted && inserted.raced) {
      out.skipped++;
      out.reasons.push({ domain, reason: `already on board (concurrent ${inserted.raced.status}${inserted.raced.target_page ? ` for ${targetPathOf(inserted.raced.target_page)}` : ''})` });
      return;
    }
    // pg resolves an insert without returning() to [] even when a row landed;
    // with returning('id') an ON CONFLICT DO NOTHING is the only empty result.
    if (!Array.isArray(inserted) || inserted.length === 0) {
      out.skipped++;
      out.reasons.push({ domain, reason: 'already on board (concurrent insert)' });
      return;
    }
    out.queued++;
  }
}

/**
 * resolveRecoveredLink(backlink, now) — the inbound link came back on its own.
 * Any un-pitched recovery prospect for the DOMAIN (queued by queueLostDomains
 * or a reopened lost row) is closed as live so the drafter never pitches for a
 * link that already exists. Rows already contacted/negotiating are left to the
 * operator (a conversation is open); a parked draft is withdrawn.
 *
 * Domain scope, not target page: recovery rows are queued one-per-domain only
 * after the domain has NO active link left (domainLevelLosses), represented by
 * whichever lost row ranked highest — so a sibling link to a different Waves
 * page reappearing is the same evidence ("the domain links to us again") and
 * must close the same row, whatever target_page it was filed under.
 */
async function resolveRecoveredLink(backlink, now = new Date(), { trx } = {}) {
  const domain = normalizeDomain(backlink.source_domain);
  if (!domain) return { resolved: 0 };
  // The placement move below (owner probe → target_page update) is a board
  // write like any other: it runs under the shared per-domain lock inside a
  // transaction — the caller's, or one opened here for a standalone call.
  if (!trx) return db.transaction((t) => resolveRecoveredLink(backlink, now, { trx: t }));
  const q = trx;
  await lockProspectDomain(q, domain);
  // Only UNSENT rows close automatically: a 'sending' row has a Gmail send in
  // flight whose finalizer needs the token; sent/send_error rows are the
  // operator's reconciliation, not ours.
  // `trx`: the monitor joins this to the backlink's lost→active flip so the
  // two commit (or roll back) together.
  const candidates = () => byDomain(q('seo_link_prospects'), domain)
    .where({ status: 'prospect' })
    .whereRaw("(source = 'lost_recovery' OR COALESCE(quality_signals->>'lost_recovery', 'false') = 'true')")
    .whereRaw("COALESCE(outreach_status, 'none') IN ('none', 'drafted')")
    .whereNull('outreach_sent_at');
  const rows = await candidates().select('id', 'target_page');
  if (!Array.isArray(rows) || !rows.length) return { resolved: 0, superseded: 0, pending: 0 };
  // Every per-row write repeats the unsent guards ATOMICALLY (as markLive does):
  // a send can flip the row to outreach_status='sending' between the read and
  // the write, and clearing its token then would strand the Gmail finalizer.
  // A 0-row update = the row moved on; it is left for reconciliation (pending).
  const unsentRow = (id) => q('seo_link_prospects').where({ id, status: 'prospect' })
    .whereRaw("COALESCE(outreach_status, 'none') IN ('none', 'drafted')")
    .whereNull('outreach_sent_at');

  // The row's target identity must FOLLOW the link that returned: the daily
  // verifier validates live_url against the row's target_page, so a
  // domain-level recovery row filed under a sibling Waves page would be
  // demoted back to lost by the very next definitive crawl. Same page → close
  // as live; other page and that (domain, page) pair is free → move the row to
  // the returned page and close as live; other page already owned by another
  // board row → THAT row is the placement, this recovery is closed as
  // superseded (rejected + note) rather than left live under a wrong identity.
  const returnedPage = targetPageOf(backlink.target_url);
  const variants = new Set(targetPageVariants(backlink.target_url));
  const closeNote = `\nLost-link recovery closed ${etDateString(now)}: the link reappeared on its own (no outreach needed).`;
  let resolved = 0, superseded = 0, pending = 0;
  for (const row of rows) {
    const samePage = variants.has(row.target_page);
    const owner = samePage ? null
      : await byDomain(q('seo_link_prospects'), domain).whereIn('target_page', [...variants]).whereNot('id', row.id).first('id', 'status');
    if (owner) {
      const n = await unsentRow(row.id).update({
        status: 'rejected',
        backlink_id: backlink.id || null,
        claimed_at: null, claimed_by: null,
        outreach_status: 'none', outreach_send_token: null,
        notes: q.raw("COALESCE(notes, '') || ?", [`${closeNote} Placement for ${returnedPage} is tracked by prospect ${owner.id} (${owner.status}); this recovery row is superseded.`]),
        updated_at: now,
      });
      if (n) superseded += n; else pending++;
      continue;
    }
    const n = await unsentRow(row.id).update({
      status: 'live',
      ...(samePage ? {} : { target_page: returnedPage }),
      live_url: backlink.source_url,
      backlink_id: backlink.id || null,
      // first_live_at = the FIRST time the placement went live (verifier sets it
      // only when null); a re-close after a loss must not rewrite that history.
      first_live_at: q.raw('COALESCE(first_live_at, ?)', [now]),
      claimed_at: null, claimed_by: null,
      outreach_status: 'none', outreach_send_token: null,
      notes: q.raw("COALESCE(notes, '') || ?", [samePage ? closeNote : `${closeNote} Target page moved ${row.target_page} → ${returnedPage} to follow the returned link.`]),
      updated_at: now,
    });
    if (n) resolved += n; else pending++;
  }
  if (resolved || superseded || pending) logger.info(`[lost-link-recovery] ${domain}: link restored on its own — ${resolved} recovery prospect(s) closed as live, ${superseded} superseded, ${pending} moved on concurrently (left for reconciliation)`);
  return { resolved, superseded, pending };
}

module.exports = { queueLostDomains, resolveRecoveredLink, _test: { normalizeDomain, targetPageOf, targetPageVariants, TARGET_DOMAIN_CANONICAL_SQL } };
