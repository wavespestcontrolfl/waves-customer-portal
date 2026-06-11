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
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const { THRESHOLDS } = require('./scoring-config');
const { buildSeoRequirements } = require('./blog-seo-contract');
const { isFaqBlockedService } = require('./content-guardrails');

const queue = require('./opportunity-queue');
const router = require('./decision-router');
const factsSufficiency = require('./facts-sufficiency');
const factsLoader = require('../content-astro/facts-bank-loader');

// ── keyword overlap helpers for customer-cluster topic match ────────

const KEYWORD_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with',
  'of', 'is', 'are', 'do', 'does', 'how', 'what', 'why', 'when', 'where',
  'my', 'your', 'our', 'this', 'that', 'near', 'me', 'us', 'pest',
  // 'pest' is too generic to be a useful topic-match anchor — it's
  // already the dominant service in the brief; topic match should pull
  // on more specific words.
]);

function extractKeywords(text) {
  if (!text) return new Set();
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !KEYWORD_STOP_WORDS.has(w))
  );
}

function sharesKeyword(clusterText, opportunityKeywords) {
  if (!opportunityKeywords.size) return false;
  const clusterWords = extractKeywords(clusterText);
  for (const w of clusterWords) {
    if (opportunityKeywords.has(w)) return true;
  }
  return false;
}

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
    'early CTA within first 25% of article',
    '2+ H2 sections',
    'pro-tip callout',
    'pest-practices homeowner guidance',
    'FAQ section (2–3 questions)',
    'final CTA to relevant city/service page',
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

// Answer-engine (AEO) treatment. When a brief originates from an aeo_gap
// opportunity — a city×service that answer engines (ChatGPT/Gemini/Claude/AI
// Overview) are NOT citing Waves for — overlay extractability requirements so
// the page can actually be quoted: a self-contained direct-answer block up top,
// an explicit FAQ section, and FAQPage schema. The seo-completion-gate then
// enforces that requesting FAQPage means a visible FAQ exists, so this is
// self-reinforcing. Inert outside aeo_gap (gated upstream by GATE_AEO_GAP_MINING).
//
// customer-question is intentionally EXCLUDED: that contract already answers
// the question in the first paragraph (direct answer is built in) and forbids
// FAQPage schema (deprecated May 2026, per writer-agent-config + quality-gate).
const AEO_TREATED_PAGE_TYPES = new Set([
  'city-service', 'supporting-blog', 'refresh',
]);

function applyAeoTreatment({ isAeoGap, pageType, requiredSections, schemaTypes, voiceConstraints }) {
  if (!isAeoGap || !AEO_TREATED_PAGE_TYPES.has(pageType)) {
    return { requiredSections, schemaTypes, voiceConstraints };
  }
  const sections = [...requiredSections];
  if (!sections.some((s) => /direct-answer/i.test(s))) {
    sections.unshift(
      'direct-answer block (40–60 words, self-contained, answers the core query in the opening — written to be quoted verbatim by an answer engine)'
    );
  }
  if (!sections.some((s) => /\bFAQ\b/i.test(s))) {
    sections.push('FAQ section (3–5 Q/A pairs phrased exactly how a SWFL homeowner would ask an AI assistant)');
  }
  const schema = Array.from(new Set([...schemaTypes, 'FAQPage']));
  const voice = {
    ...voiceConstraints,
    aeo_notes: [
      'Name Waves Pest Control in one unambiguous sentence near the top (licensed/insured SWFL pest & lawn company) so the entity is clear to an answer engine.',
      'Answer the core question in the first 1–2 sentences — direct answer before context.',
      'Write self-contained, factual sentences (no "as mentioned above") so any paragraph stands alone when extracted.',
    ],
  };
  return { requiredSections: sections, schemaTypes: schema, voiceConstraints: voice };
}

// NO-FAQ policy at the BRIEF level. FAQ-blocked topics (content-guardrails.
// isFaqBlockedService — the same single-sourced policy module the publish-time
// P0 enforces and the generators condition on) must not receive a brief that
// requires an FAQ section or FAQPage schema: the generators now correctly omit
// the FAQ, so a leftover "FAQ section (…)" required_section would trip
// seo-completion-gate's P1_MISSING_FAQ_WHEN_BRIEF_REQUIRED_FAQ (and at the
// live AUTONOMOUS_CONTENT_MAX_P1_FINDINGS=0 canary config route a compliant
// no-FAQ draft out of publish), and a leftover FAQPage schema_type would P0
// as FAQ_SCHEMA_WITHOUT_VISIBLE_FAQ. Applied AFTER the AEO overlay so the
// aeo_gap FAQ/FAQPage additions are stripped too.
const FAQ_SECTION_RE = /\bfaq\b|frequently asked|common questions/i;

function stripFaqRequirements({ requiredSections, schemaTypes }) {
  return {
    requiredSections: requiredSections.filter((s) => !FAQ_SECTION_RE.test(String(s || ''))),
    schemaTypes: schemaTypes.filter((t) => !/^faqpage$/i.test(String(t || '').trim())),
  };
}

// Canonical URL slug component per service for city-service pages.
// pest → "pest-control" (so URL is /pest-control-bradenton-fl/)
// lawn → "lawn-care" (NOT lawn-control — that's not a real page)
// tree-shrub doesn't ship as a city-service slug today; surface no
// link instead of fabricating one.
const SERVICE_CITY_SLUG = {
  pest: 'pest-control',
  lawn: 'lawn-care',
  mosquito: 'mosquito-control',
  termite: 'termite-control',
  rodent: 'rodent-control',
  // tree-shrub / specialty: no canonical city-service slug pattern;
  // fall back to the service hub link only.
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

    // Facts pack — the verified facts-bank facts the writer agent may cite.
    // Only assembled for facts-gated content actions with a city × service.
    const factsPack = await this._loadFactsPack(opp, decision).catch((err) => {
      logger.warn(`[brief-builder] facts pack load failed: ${err.message}`);
      return null;
    });

    const brief = this._composeBrief({ opportunity: opp, signals, decision, existingBriefVersions, factsPack });
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
    // Recency filter: stale clusters can hold a misleading high
    // total_count long past their useful window. customerClusterRecencyDays
    // is the cap that customer-insights-miner uses on the read side too.
    const sinceLastSeen = new Date(
      Date.now() - THRESHOLDS.customerClusterRecencyDays * 86400_000
    );
    let q = db('customer_insight_clusters').orderBy('total_count', 'desc');
    if (opportunity.city) q = q.where('city', opportunity.city);
    if (opportunity.service) q = q.where('service', opportunity.service);
    q = q.where('last_seen', '>=', sinceLastSeen);

    // Topic match: when the opportunity has a query/keyword, prefer
    // clusters whose topic / normalized_question shares a content word
    // with it. Without this, the highest-total cluster for the (city,
    // service) pair gets attached even if the topic is unrelated —
    // can incorrectly boost customerDemand and reroute new_supporting_blog
    // → create_customer_question_page on a mismatched question.
    const rows = await q.limit(20).select('*');
    if (!rows.length) return null;
    const opportunityKeywords = extractKeywords(opportunity.query || opportunity.target_keyword || '');

    let chosen = null;
    if (opportunityKeywords.size > 0) {
      for (const r of rows) {
        const clusterText = `${r.topic || ''} ${r.normalized_question || ''}`;
        if (sharesKeyword(clusterText, opportunityKeywords)) { chosen = r; break; }
      }
    }
    // If nothing topic-matched, fall back to the highest-count cluster
    // for this (city, service) pair — only when the opportunity itself
    // doesn't carry a discernible topic (e.g. local_gap or refresh of
    // a generic page).
    if (!chosen && opportunityKeywords.size === 0) chosen = rows[0];
    if (!chosen) return null;

    return {
      ...chosen,
      source_counts: typeof chosen.source_counts === 'string'
        ? JSON.parse(chosen.source_counts)
        : (chosen.source_counts || {}),
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

  /**
   * Assemble the facts pack for a facts-gated city × service action. Returns
   * null when the action isn't facts-gated or the city/service can't be
   * mapped.
   *
   * The pack contains ONLY copy-usable facts (public, public_copy_allowed,
   * copy-safe evidence, in-TTL). This MUST match what claims-ledger-validator
   * indexes (also `purpose: 'copy'`): the agent is told it may cite only
   * facts_pack ids, so handing it prompt-only / internal facts would invite
   * citations the validator then rejects, and risk non-public facts reaching
   * body copy. Prompt-only context facts are intentionally excluded.
   */
  async _loadFactsPack(opportunity, decision) {
    const actionType = decision?.action_type || opportunity.action_type;
    if (!factsSufficiency.FACTS_GATED_ACTIONS.has(actionType)) return null;

    const cityId = factsSufficiency.normalizeCityId(opportunity.city);
    const serviceId = factsSufficiency.normalizeServiceId(opportunity.service);
    if (!cityId || !serviceId) return null;

    const cityFile = await factsLoader.loadCity(cityId);
    const serviceFile = await factsLoader.loadService(serviceId);
    const countyId = cityFile?.county || null;
    const countyFile = countyId ? await factsLoader.loadCounty(countyId) : null;

    const pack = (file, id) => {
      if (!file || file.ok === false) return { id, facts: [] };
      // purpose:'copy' + PAGE_COPY_CONTEXTS — citeable, publishable facts
      // scoped to contexts a city/service page covers (aligns exactly with the
      // claims-ledger validator's index, via the shared constant).
      const facts = factsLoader.usableFacts(file, { purpose: 'copy', contexts: factsLoader.PAGE_COPY_CONTEXTS })
        .map((f) => ({ id: f.id, type: f.type, value: f.value, evidence_strength: f.evidence_strength, allowed_contexts: f.allowed_contexts || [] }));
      return { id, facts, internal_links: file.internal_links || {} };
    };

    const allowed = [];
    const disallowed = [];
    for (const file of [cityFile, serviceFile, countyFile]) {
      if (!file || file.ok === false) continue;
      for (const p of file.allowed_claim_patterns || []) allowed.push(p);
      for (const p of file.disallowed_claim_patterns || []) disallowed.push(p);
    }

    return {
      city: pack(cityFile, cityId),
      service: pack(serviceFile, serviceId),
      county: countyFile ? pack(countyFile, countyId) : null,
      allowed_claim_patterns: allowed,
      disallowed_claim_patterns: disallowed,
    };
  }

  _composeBrief({ opportunity, signals, decision, existingBriefVersions, factsPack = null }) {
    const pageType = decision.page_type;

    // Overlay answer-engine extractability requirements for aeo_gap briefs.
    const aeo = applyAeoTreatment({
      isAeoGap: opportunity.bucket === 'aeo_gap',
      pageType,
      requiredSections: REQUIRED_SECTIONS[pageType] || [],
      schemaTypes: SCHEMA_TYPES[pageType] || [],
      voiceConstraints: VOICE_CONSTRAINTS,
    });

    // FAQ-blocked topic? Match on the same fields the downstream gates use:
    // the opportunity's service plus the customer-signal service/topic (a
    // city-service brief can carry broad service 'pest' with the real topic
    // on customer_signal — e.g. 'rodent'/'termite').
    const faqBlocked = isFaqBlockedService([
      opportunity.service,
      signals.customer_signal?.service,
      signals.customer_signal?.topic,
    ]);
    const { requiredSections, schemaTypes } = faqBlocked
      ? stripFaqRequirements({ requiredSections: aeo.requiredSections, schemaTypes: aeo.schemaTypes })
      : { requiredSections: aeo.requiredSections, schemaTypes: aeo.schemaTypes };

    return {
      facts_pack: factsPack,
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
            city: signals.customer_signal.city || opportunity.city || null,
            service: signals.customer_signal.service || opportunity.service || null,
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

      required_sections: requiredSections,
      schema_types: schemaTypes,
      internal_links_to_add: this._internalLinksFor(opportunity, pageType),
      seo_requirements: buildSeoRequirements({
        page_type: pageType,
        action_type: decision.action_type,
        city: opportunity.city || null,
        service: opportunity.service || null,
      }),
      word_count_target: WORD_COUNT_TARGET[pageType] || 'intent-complete',
      voice_constraints: aeo.voiceConstraints,

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
    // City-service link uses the canonical service slug, NOT
    // `${service}-control-` (lawn would produce /lawn-control-…-fl/
    // which isn't a real page; the real slug is /lawn-care-…-fl/).
    // Services without a canonical city-service slug pattern (e.g.
    // tree-shrub, specialty) get only the hub link.
    if (opportunity.city && opportunity.service) {
      const slug = SERVICE_CITY_SLUG[opportunity.service];
      if (slug) {
        const citySlug = opportunity.city.toLowerCase().replace(/\s+/g, '-');
        links.add(`/${slug}-${citySlug}-fl/`);
      }
    }
    return Array.from(links).slice(0, 5);
  }

  /**
   * Persist the brief. Throws on failure — earlier iteration swallowed
   * insert errors and returned null, so compose() resolved as if the
   * brief was saved when content_briefs was missing / mis-migrated or
   * an (opportunity_id, version) conflict fired. That silently dropped
   * the brief from the audit trail and let the pipeline continue
   * state transitions against a phantom brief. Now any persistence
   * failure rejects compose() so the runner can act on it.
   */
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
          facts_pack: brief.facts_pack ? JSON.stringify(brief.facts_pack) : null,
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
      // Log + rethrow. compose() bubbles this up; the runner records
      // a failed brief outcome and the queue row gets released for
      // retry instead of silently advancing to publish.
      logger.warn(`[brief-builder] persist failed for opp ${brief.opportunity_id}: ${err.message}`);
      throw new Error(`content_briefs persist failed: ${err.message}`);
    }
  }
}

// ── publish-window picker ───────────────────────────────────────────

function nextWeekday9amET() {
  // 9am ET on the next Monday–Friday that's at least 6 hours away.
  // Earlier iteration hardcoded UTC 13:00 as "9am ET" which is only
  // true during EDT; in EST it scheduled at 8am ET — wrong for half
  // the year. parseETDateTime("YYYY-MM-DDT09:00") anchors to actual
  // 9am ET regardless of DST.
  // Crude — the autonomous-runner (later phase) will replace with a
  // calendar-aware slot picker that avoids already-scheduled days.
  const now = new Date();
  for (let offset = 0; offset < 14; offset++) {
    const etDay = etDateString(addETDays(now, offset));
    const target = parseETDateTime(`${etDay}T09:00`);
    if (target - now < 6 * 3600 * 1000) continue;
    // Skip weekends in ET.
    const etWeekday = target.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    if (etWeekday === 'Sat' || etWeekday === 'Sun') continue;
    return target;
  }
  // Fallback (shouldn't hit — 14 days always contains a weekday).
  return parseETDateTime(`${etDateString(addETDays(now, 1))}T09:00`);
}

module.exports = new ContentBriefBuilder();
module.exports.ContentBriefBuilder = ContentBriefBuilder;
module.exports._internals = {
  REQUIRED_SECTIONS,
  SCHEMA_TYPES,
  WORD_COUNT_TARGET,
  SERVICE_HUB_LINKS,
  buildSeoRequirements,
  nextWeekday9amET,
  applyAeoTreatment,
  stripFaqRequirements,
};
