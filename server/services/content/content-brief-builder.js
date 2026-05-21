/**
 * content-brief-builder.js — orchestrator that takes one opportunity
 * off the queue, gathers SERP + customer + conversion signals, runs
 * the decision router, composes the full brief, and persists it.
 *
 * This is the seam where the four miners (GSC opp, SERP profiler,
 * customer insights, conversion feedback) become one engine. The
 * writer agents (later phases) consume content_briefs rows as their
 * single source of truth.
 *
 * compose() is read-only-friendly when persist=false — used by the
 * preview CLI so Adam can see "if we ran the engine right now, here's
 * what brief #1 would look like" without writing anything.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const queue = require('./opportunity-queue');
const router = require('./decision-router');

// Lazily-loaded dependencies — these may not all exist on every
// branch in the stack, so we defer until first use.
function lazy(name, path) {
  let mod;
  return () => {
    if (mod === undefined) {
      try { mod = require(path); }
      catch (err) { logger.warn(`[brief-builder] ${name} unavailable: ${err.message}`); mod = null; }
    }
    return mod;
  };
}
const getSerpProfiler = lazy('serp-profiler', '../seo/serp-profiler');
const getConversionMiner = lazy('conversion-feedback-miner', '../seo/conversion-feedback-miner');

// ── required-sections matrix (per page-type, per v3.1 brief schema) ─

const REQUIRED_SECTIONS = {
  'city-service': [
    'local intro',
    'services offered',
    'common pests in this city',
    'same-day / free inspection CTA',
    'what to expect',
    'pricing / estimate language',
    'reviews or trust proof',
    'FAQ from customer calls',
    'internal links',
  ],
  'customer-question': [
    'answer in first paragraph',
    'short explanation with local context',
    'when to call a pro',
    'related questions',
    'source / internal link',
  ],
  'supporting-blog': [
    'hub link in intro',
    'one city mention (or generic SWFL framing)',
    '2+ H2 sections',
    'pro-tip callout',
    'FAQ section (2–3 questions)',
    'CTA to relevant city page',
  ],
  refresh: [
    'preserve existing slug',
    'add 1+ new section reflecting current data',
    'update dateModified',
    'refresh CTAs to current promo',
  ],
  metadata: [
    'rewrite title (60 char target)',
    'rewrite meta_description (155 char target)',
    'no body changes',
  ],
  links: ['add internal links from sibling pages to the target URL'],
  gbp: ['short post body', 'CTA link', 'optional image'],
  none: [],
};

const SCHEMA_TYPES = {
  'city-service': ['LocalBusiness', 'Service', 'BreadcrumbList'],
  'customer-question': ['WebPage', 'Article', 'BreadcrumbList'],
  'supporting-blog': ['Article', 'BreadcrumbList'],
  refresh: [], // preserve existing
  metadata: [],
  links: [],
  gbp: [],
  none: [],
};

const WORD_COUNT_TARGET = {
  'city-service': '900-1500',
  'customer-question': '600-900',
  'supporting-blog': '900-1500',
  refresh: 'intent-complete (delta-only)',
  metadata: 'n/a',
  links: 'n/a',
  gbp: '150-300 chars',
  none: 'n/a',
};

const VOICE_CONSTRAINTS = {
  tone: 'casual, technically knowledgeable, slightly snarky SWFL neighbor',
  forbidden: [
    'corporate boilerplate',
    'hardcoded prices (link to /pest-control-calculator/ instead)',
    'verbatim customer quotes from SMS/call sources',
    '"nitrogen blackout" without mentioning phosphorus restriction',
  ],
  required_phrases: [
    'reference SWFL conditions (sandy soil, afternoon storms, St. Augustine)',
    'use "you" and "your" naturally',
  ],
};

const SERVICE_HUB_LINKS = {
  pest: ['/pest-control-services/', '/waveguard-memberships/', '/pest-library/'],
  lawn: ['/lawn-care/', '/lawn-care/fertilizer-blackout-manatee-county/'],
  mosquito: ['/mosquito-control/'],
  termite: ['/termite-inspection/'],
  rodent: ['/rodent-control/'],
  'tree-shrub': ['/tree-shrub-care/'],
  specialty: ['/pest-control-services/'],
};

// ── main API ────────────────────────────────────────────────────────

class ContentBriefBuilder {
  /**
   * Compose a brief for a specific opportunity (does not claim).
   * persist=true writes to content_briefs as a new version.
   */
  async compose(opportunityId, { persist = true, skipSerp = false } = {}) {
    const opp = await queue.getById(opportunityId);
    if (!opp) throw new Error(`opportunity ${opportunityId} not found`);

    const signals = await this._gatherSignals(opp, { skipSerp });
    const existingBriefVersions = await this._countExistingBriefs(opp.id);

    const decision = router.route(opp, { ...signals, existing_brief_versions: existingBriefVersions });

    const brief = this._composeBrief({ opportunity: opp, signals, decision, existingBriefVersions });
    if (persist) brief.id = await this._persist(brief);
    return brief;
  }

  /**
   * Compose briefs for the top-N pending opportunities. Inspection
   * only — uses peek() instead of claim().
   */
  async previewTop({ limit = 5, minScore = null, persist = false, skipSerp = true } = {}) {
    const opps = await queue.peek({ limit, minScore });
    const out = [];
    for (const o of opps) {
      try {
        const brief = await this.compose(o.id, { persist, skipSerp });
        out.push({ ...brief, _opportunity: o });
      } catch (err) {
        out.push({ _opportunity: o, error: err.message });
      }
    }
    return out;
  }

  // ── internals ──────────────────────────────────────────────────────

  async _gatherSignals(opportunity, { skipSerp }) {
    const out = { serp_profile: null, customer_signal: null, conversion_feedback: null };

    // SERP profile — keyword-driven. Skip when no query (page-only
    // buckets like decay_refresh don't need SERP profile).
    if (!skipSerp && opportunity.query) {
      const serpProfiler = getSerpProfiler();
      if (serpProfiler) {
        try {
          out.serp_profile = await serpProfiler.profile({
            query: opportunity.query,
            city: opportunity.city || null,
            device: 'mobile',
            persist: false,
          });
        } catch (err) {
          logger.warn(`[brief-builder] SERP profile failed for "${opportunity.query}": ${err.message}`);
        }
      }
    }

    // Customer-insight cluster — match topic-ish keywords against
    // the opportunity's query / service / city.
    out.customer_signal = await this._matchCustomerCluster(opportunity).catch((err) => {
      logger.warn(`[brief-builder] customer cluster lookup failed: ${err.message}`);
      return null;
    });

    // Conversion feedback for this (city, service).
    if (opportunity.service || opportunity.city) {
      const conv = getConversionMiner();
      if (conv?.lookup) {
        try {
          out.conversion_feedback = await conv.lookup({
            city: opportunity.city || null,
            service: opportunity.service || null,
            windowDays: 90,
            maxAgeDays: 14,
          });
        } catch (err) {
          logger.warn(`[brief-builder] conversion lookup failed: ${err.message}`);
        }
      }
    }
    return out;
  }

  async _matchCustomerCluster(opportunity) {
    if (!opportunity.service && !opportunity.city) return null;
    let q = db('customer_insight_clusters').orderBy('total_count', 'desc');
    if (opportunity.city) q = q.where('city', opportunity.city);
    if (opportunity.service) q = q.where('service', opportunity.service);
    const row = await q.first();
    if (!row) return null;
    return {
      ...row,
      source_counts: typeof row.source_counts === 'string'
        ? JSON.parse(row.source_counts)
        : (row.source_counts || {}),
    };
  }

  async _countExistingBriefs(opportunityId) {
    try {
      const r = await db('content_briefs').where('opportunity_id', opportunityId).count('* as c').first();
      return parseInt(r?.c || 0, 10);
    } catch {
      return 0;
    }
  }

  _composeBrief({ opportunity, signals, decision, existingBriefVersions }) {
    const pageType = decision.page_type;

    return {
      opportunity_id: opportunity.id,
      version: existingBriefVersions + 1,
      action_type: decision.action_type,
      target_url: opportunity.page_url || null,
      target_keyword: opportunity.query || null,
      city: opportunity.city || null,
      service: opportunity.service || null,
      page_type: pageType,

      final_score: decision.final_score,
      score_breakdown: decision.score_breakdown,

      serp_signal: signals.serp_profile
        ? {
            dominant_intent: signals.serp_profile.dominant_intent,
            dominant_page_type: signals.serp_profile.dominant_page_type,
            local_pack_present: signals.serp_profile.local_pack_present,
            ai_overview_present: signals.serp_profile.ai_overview_present,
            directory_saturation: signals.serp_profile.directory_saturation,
            confidence: signals.serp_profile.confidence,
            competitor_cta_patterns: signals.serp_profile.payload?.competitor_cta_patterns || [],
            competitor_proof_patterns: signals.serp_profile.payload?.competitor_proof_patterns || [],
            paa_questions: signals.serp_profile.payload?.paa_questions || [],
            serp_gap: signals.serp_profile.payload?.serp_gap || null,
          }
        : {},
      gsc_signal: {
        bucket: opportunity.bucket,
        impressions: opportunity.signal_metadata?.impressions || null,
        avg_position: opportunity.signal_metadata?.avg_position || null,
        ctr: opportunity.signal_metadata?.ctr || null,
        decay_pct: opportunity.signal_metadata?.decay_pct || null,
        growth_pct: opportunity.signal_metadata?.growth_pct || null,
      },
      customer_signal: signals.customer_signal
        ? {
            topic: signals.customer_signal.topic,
            normalized_question: signals.customer_signal.normalized_question,
            total_count: signals.customer_signal.total_count,
            source_counts: signals.customer_signal.source_counts,
            funnel_stage: signals.customer_signal.funnel_stage,
            urgency: signals.customer_signal.urgency,
            example_phrasing_anonymized: signals.customer_signal.example_phrasing_anonymized,
          }
        : null,
      conversion_signal: signals.conversion_feedback
        ? {
            window_days: signals.conversion_feedback.window_days,
            leads_total: signals.conversion_feedback.leads_total,
            close_rate: signals.conversion_feedback.close_rate,
            avg_ticket: signals.conversion_feedback.avg_ticket,
            estimated_revenue: signals.conversion_feedback.estimated_revenue,
          }
        : null,

      required_sections: REQUIRED_SECTIONS[pageType] || [],
      schema_types: SCHEMA_TYPES[pageType] || [],
      internal_links_to_add: this._internalLinksFor(opportunity, pageType),
      word_count_target: WORD_COUNT_TARGET[pageType] || 'intent-complete',
      voice_constraints: VOICE_CONSTRAINTS,

      publish_window: nextWeekday9amET().toISOString(),
      human_review_required: decision.human_review_required,
      human_review_reason: decision.human_review_reason,
      router_notes: decision.router_notes,

      composed_at: new Date(),
    };
  }

  _internalLinksFor(opportunity, pageType) {
    if (['metadata', 'links', 'gbp', 'none'].includes(pageType)) return [];
    const links = new Set();
    const hubs = SERVICE_HUB_LINKS[opportunity.service] || [];
    for (const h of hubs) links.add(h);
    if (opportunity.city && opportunity.service) {
      const citySlug = opportunity.city.toLowerCase().replace(/\s+/g, '-');
      links.add(`/${opportunity.service}-control-${citySlug}-fl/`);
    }
    return Array.from(links).slice(0, 5);
  }

  async _persist(brief) {
    try {
      const [row] = await db('content_briefs')
        .insert({
          opportunity_id: brief.opportunity_id,
          version: brief.version,
          action_type: brief.action_type,
          target_url: brief.target_url,
          target_keyword: brief.target_keyword,
          city: brief.city,
          service: brief.service,
          page_type: brief.page_type,
          final_score: brief.final_score,
          score_breakdown: JSON.stringify(brief.score_breakdown),
          serp_signal: JSON.stringify(brief.serp_signal),
          gsc_signal: JSON.stringify(brief.gsc_signal),
          customer_signal: brief.customer_signal ? JSON.stringify(brief.customer_signal) : null,
          conversion_signal: brief.conversion_signal ? JSON.stringify(brief.conversion_signal) : null,
          required_sections: JSON.stringify(brief.required_sections),
          schema_types: JSON.stringify(brief.schema_types),
          internal_links_to_add: JSON.stringify(brief.internal_links_to_add),
          word_count_target: brief.word_count_target,
          voice_constraints: JSON.stringify(brief.voice_constraints),
          publish_window: brief.publish_window,
          human_review_required: brief.human_review_required,
          human_review_reason: brief.human_review_reason,
          router_notes: brief.router_notes,
          composed_at: brief.composed_at,
        })
        .returning('id');
      return row?.id || row;
    } catch (err) {
      logger.warn(`[brief-builder] persist failed: ${err.message}`);
      return null;
    }
  }
}

// ── publish-window picker ───────────────────────────────────────────

function nextWeekday9amET() {
  // 9am ET on the next Monday–Friday that's at least 6 hours away.
  // Crude — the autonomous-runner (later phase) will replace with a
  // calendar-aware slot picker that avoids already-scheduled days.
  const now = new Date();
  let target = new Date(now);
  target.setUTCHours(13, 0, 0, 0); // 9am ET ≈ 13:00 UTC (EDT) — accept skew
  if (target - now < 6 * 3600 * 1000) target.setUTCDate(target.getUTCDate() + 1);
  while (target.getUTCDay() === 0 || target.getUTCDay() === 6) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target;
}

module.exports = new ContentBriefBuilder();
module.exports.ContentBriefBuilder = ContentBriefBuilder;
module.exports._internals = {
  REQUIRED_SECTIONS,
  SCHEMA_TYPES,
  WORD_COUNT_TARGET,
  SERVICE_HUB_LINKS,
  nextWeekday9amET,
};
