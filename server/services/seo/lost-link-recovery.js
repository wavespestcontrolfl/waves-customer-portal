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

const NON_OUTREACH_TYPES = new Set(['directory', 'citation', 'social']);
// Board states that mean "someone is already on this" — never reopened here.
const IN_FLIGHT_STATUSES = new Set(['prospect', 'contacted', 'negotiating', 'placed', 'live', 'indexed']);

function normalizeDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^(www|mail)\./, '').replace(/[/:].*$/, '');
}

function targetPageOf(url) {
  return String(url || '').split('#')[0].split('?')[0] || 'https://wavespestcontrol.com/';
}

/**
 * queueLostDomains(losses) — losses are the alertable entries from
 * BacklinkMonitor.domainLevelLosses(). Returns { queued, skipped, reasons[] }.
 */
async function queueLostDomains(losses, { scorer } = {}) {
  const out = { queued: 0, skipped: 0, reasons: [] };
  if (!Array.isArray(losses) || !losses.length) return out;
  const scoreMod = scorer || require('./prospect-scorer');

  for (const loss of losses) {
    const domain = normalizeDomain(loss.domain);
    const targetPage = targetPageOf(loss.target_url);
    if (!domain) { out.skipped++; continue; }

    // (target_domain, target_page) is unique on the board. A link we acquired
    // through the pipeline already has a row, and the outbound verifier moves
    // it to 'lost' when the inbound link disappears — that row is REOPENED as a
    // fresh prospect (the worker only claims status='prospect'). Rows still in
    // flight, or rejected by the owner, are left alone.
    const exists = await db('seo_link_prospects').where({ target_domain: domain, target_page: targetPage }).first('id', 'status', 'notes');
    if (exists && exists.status === 'lost') {
      const note = `Lost-link recovery: our link on ${loss.source_url} was verified gone (${loss.lost_reason}). Re-pitch for the same placement.`;
      // A fresh outreach cycle: the worker/send valve treat a populated
      // outreach_sent_at as "already sent", so the prior send moves into
      // quality_signals.prior_outreach_sent_at instead of being erased.
      await db('seo_link_prospects').where({ id: exists.id }).update({
        status: 'prospect',
        priority: 'high',
        claimed_at: null, claimed_by: null,
        outreach_status: 'none', outreach_send_token: null, outreach_attempted_at: null, outreach_sent_at: null,
        quality_signals: db.raw(
          "jsonb_set(jsonb_set(jsonb_set(COALESCE(quality_signals, '{}'::jsonb), '{lost_recovery}', 'true'::jsonb, true), '{lost_reason}', to_jsonb(?::text), true), '{prior_outreach_sent_at}', COALESCE(to_jsonb(outreach_sent_at), COALESCE(quality_signals, '{}'::jsonb) -> 'prior_outreach_sent_at', 'null'::jsonb), true)",
          [loss.lost_reason || 'unknown'],
        ),
        notes: exists.notes ? `${exists.notes}\n${note}` : note,
        updated_at: new Date(),
      });
      out.queued++;
      out.reasons.push({ domain, reason: 'reopened lost prospect' });
      continue;
    }
    if (exists) {
      out.skipped++;
      out.reasons.push({ domain, reason: IN_FLIGHT_STATUSES.has(exists.status) ? `already on board (${exists.status})` : `left alone (${exists.status})` });
      continue;
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
      continue;
    }
    // Same contactability gate as create_link_prospects: an outreach target with
    // no way to reach a human (or a join-not-email HARO platform) never goes on
    // the board, no matter how good the lost placement was.
    if (scored && (!scored.gate?.ok || scored.gate.lane === 'haro_platform')) {
      out.skipped++;
      out.reasons.push({ domain, reason: scored.gate?.reason || 'no contact path' });
      continue;
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

    await db('seo_link_prospects').insert({
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
    });
    out.queued++;
  }

  if (out.queued || out.skipped) logger.info(`[lost-link-recovery] queued ${out.queued}, skipped ${out.skipped}`);
  return out;
}

module.exports = { queueLostDomains, _test: { normalizeDomain, targetPageOf } };
