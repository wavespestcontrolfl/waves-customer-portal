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

const NON_OUTREACH_TYPES = new Set(['directory', 'citation', 'social']);
// The only link_types the outreach worker claims (link-prospect-worker OUTREACH_TYPES).
const OUTREACH_TYPES = new Set(['editorial', 'resource', 'guest_post', 'haro']);
// Board states that mean "someone is already on this" — never reopened here.
const IN_FLIGHT_STATUSES = new Set(['prospect', 'contacted', 'negotiating', 'placed', 'live', 'indexed']);

function normalizeDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^(www|mail)\./, '').replace(/[/:].*$/, '');
}

// Canonical board form of a Waves target page. The board's unique key is
// textual (target_domain, target_page) and existing rows use both
// https://wavespestcontrol.com/... and https://www.wavespestcontrol.com/...
// (always with a trailing slash), so: lookups try every variant, inserts use
// one canonical spelling (homepage bare — the 150-row majority — pages www).
function targetPathOf(url) {
  const raw = String(url || '').split('#')[0].split('?')[0];
  let path = '/';
  try { path = new URL(raw).pathname || '/'; } catch { path = raw.replace(/^https?:\/\/[^/]+/, '') || '/'; }
  path = path.replace(/\/+$/, '');
  return path ? `${path}/` : '/';
}
function targetPageOf(url) {
  const path = targetPathOf(url);
  return path === '/' ? 'https://wavespestcontrol.com/' : `https://www.wavespestcontrol.com${path}`;
}
function targetPageVariants(url) {
  const path = targetPathOf(url);
  const bare = path.replace(/\/$/, '');
  const out = new Set();
  for (const host of ['https://wavespestcontrol.com', 'https://www.wavespestcontrol.com', 'http://wavespestcontrol.com', 'http://www.wavespestcontrol.com']) {
    out.add(`${host}${path}`);
    if (bare) out.add(`${host}${bare}`);
  }
  return [...out];
}

/**
 * queueLostDomains(losses) — losses are the alertable entries from
 * BacklinkMonitor.domainLevelLosses(). Returns { queued, skipped, reasons[] }.
 */
async function queueLostDomains(losses, { scorer } = {}) {
  // results[] carries one terminal verdict per loss so the caller can stamp the
  // backlink row: 'queued' / 'skipped' are final, 'error' is retried next scan.
  const out = { queued: 0, skipped: 0, reasons: [], results: [] };
  if (!Array.isArray(losses) || !losses.length) return out;
  const scoreMod = scorer || require('./prospect-scorer');

  for (const loss of losses) {
    const before = { q: out.queued, s: out.skipped };
    try {
      await queueOne(loss, out, scoreMod);
      out.results.push({ domain: loss && loss.domain, backlink_id: loss && loss.backlink_id, outcome: out.queued > before.q ? 'queued' : 'skipped' });
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

    // (target_domain, target_page) is unique on the board. A link we acquired
    // through the pipeline already has a row, and the outbound verifier moves
    // it to 'lost' when the inbound link disappears — that row is REOPENED as a
    // fresh prospect (the worker only claims status='prospect'). Rows still in
    // flight, or rejected by the owner, are left alone.
    const exists = await db('seo_link_prospects').where({ target_domain: domain }).whereIn('target_page', targetPageVariants(loss.target_url)).first('id', 'status', 'notes', 'link_type');
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
      // Conditional on status='lost': the daily verifier can restore the row to
      // live between our read and this write — a 0-row update means it is no
      // longer lost and must not be reopened for outreach.
      const reopened = await db('seo_link_prospects').where({ id: exists.id, status: 'lost' }).update({
        status: 'prospect',
        priority: 'high',
        link_type: reopenType,
        claimed_at: null, claimed_by: null,
        attempts: 0,
        // outreach_attempted_at is deliberately KEPT: the daily send cap counts
        // trailing-24h attempts from it, so clearing it would let a just-sent
        // message vanish from the cap.
        outreach_status: 'none', outreach_send_token: null, outreach_sent_at: null,
        quality_signals: db.raw(
          "jsonb_set(jsonb_set(jsonb_set(jsonb_set(COALESCE(quality_signals, '{}'::jsonb), '{lost_recovery}', 'true'::jsonb, true), '{lost_reason}', to_jsonb(?::text), true), '{prior_outreach_sent_at}', COALESCE(to_jsonb(outreach_sent_at), COALESCE(quality_signals, '{}'::jsonb) -> 'prior_outreach_sent_at', 'null'::jsonb), true), '{prior_attempts}', to_jsonb(COALESCE(attempts, 0)), true)",
          [loss.lost_reason || 'unknown'],
        ),
        notes: exists.notes ? `${exists.notes}\n${note}` : note,
        updated_at: new Date(),
      });
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
    const inserted = await db('seo_link_prospects').insert({
      target_domain: domain,
      target_url: loss.source_url || null,
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
 * Any un-pitched recovery prospect for it (queued by queueLostDomains or a
 * reopened lost row) is closed as live so the drafter never pitches for a
 * link that already exists. Rows already contacted/negotiating are left to the
 * operator (a conversation is open); a parked draft is withdrawn.
 */
async function resolveRecoveredLink(backlink, now = new Date()) {
  const domain = normalizeDomain(backlink.source_domain);
  if (!domain) return { resolved: 0 };
  // Only UNSENT rows close automatically: a 'sending' row has a Gmail send in
  // flight whose finalizer needs the token; sent/send_error rows are the
  // operator's reconciliation, not ours.
  const n = await db('seo_link_prospects')
    .where({ target_domain: domain, status: 'prospect' })
    .whereIn('target_page', targetPageVariants(backlink.target_url))
    .whereRaw("(source = 'lost_recovery' OR COALESCE(quality_signals->>'lost_recovery', 'false') = 'true')")
    .whereRaw("COALESCE(outreach_status, 'none') IN ('none', 'drafted')")
    .whereNull('outreach_sent_at')
    .update({
      status: 'live',
      live_url: backlink.source_url,
      backlink_id: backlink.id || null,
      // first_live_at = the FIRST time the placement went live (verifier sets it
      // only when null); a re-close after a loss must not rewrite that history.
      first_live_at: db.raw('COALESCE(first_live_at, ?)', [now]),
      claimed_at: null, claimed_by: null,
      outreach_status: 'none', outreach_send_token: null,
      notes: db.raw("COALESCE(notes, '') || ?", [`\nLost-link recovery closed ${etDateString(now)}: the link reappeared on its own (no outreach needed).`]),
      updated_at: now,
    });
  if (n) logger.info(`[lost-link-recovery] ${domain}: link restored on its own — ${n} recovery prospect(s) closed as live`);
  return { resolved: n || 0 };
}

module.exports = { queueLostDomains, resolveRecoveredLink, _test: { normalizeDomain, targetPageOf, targetPageVariants } };
