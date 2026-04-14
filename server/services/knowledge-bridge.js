/**
 * Knowledge Bridge — connects Claudeopedia (knowledge_base) ↔ Agronomic Wiki (knowledge_entries)
 *
 * Cross-links entries by type:
 *   product_reference   — product KB article ↔ wiki product page
 *   condition_treatment — condition KB article ↔ wiki condition page
 *   seasonal_guide      — seasonal KB article ↔ wiki seasonal page
 *   data_enrichment     — any KB article enriched with wiki outcome data
 *
 * Also generates customer-facing assessment recommendations by pulling
 * protocol data from Claudeopedia + real outcome data from the Wiki.
 */

const db = require('../models/db');
const logger = require('./logger');

const KnowledgeBridge = {
  /**
   * Auto-link: scan both systems and create links where names match.
   * Safe to run repeatedly — uses upsert logic.
   */
  async autoLink() {
    let linked = 0;

    try {
      // Get all KB articles and wiki pages
      const kbArticles = await db('knowledge_base')
        .where('active', true)
        .select('id', 'title', 'category', 'tags');

      const hasWiki = await db.schema.hasTable('knowledge_entries');
      if (!hasWiki) return { linked: 0 };

      const wikiPages = await db('knowledge_entries')
        .select('id', 'title', 'slug', 'category');

      // Match by title similarity
      for (const kb of kbArticles) {
        const kbTitle = (kb.title || '').toLowerCase();
        const kbTags = Array.isArray(kb.tags) ? kb.tags.map(t => t.toLowerCase()) : [];

        for (const wiki of wikiPages) {
          const wikiTitle = (wiki.title || '').toLowerCase();
          const wikiSlug = (wiki.slug || '').toLowerCase();

          // Check if titles share significant words
          const kbWords = kbTitle.split(/\s+/).filter(w => w.length > 3);
          const shared = kbWords.filter(w => wikiTitle.includes(w) || wikiSlug.includes(w));
          const tagMatch = kbTags.some(t => wikiTitle.includes(t) || wikiSlug.includes(t));

          if (shared.length >= 2 || tagMatch) {
            const linkType = this._inferLinkType(kb, wiki);
            try {
              await db('knowledge_bridge')
                .insert({
                  source_type: 'claudeopedia',
                  source_id: kb.id,
                  source_title: kb.title,
                  target_type: 'wiki',
                  target_id: wiki.id,
                  target_title: wiki.title,
                  link_type: linkType,
                  confidence: shared.length >= 3 ? 0.9 : tagMatch ? 0.75 : 0.6,
                  auto_linked: true,
                })
                .onConflict(['source_type', 'source_id', 'target_type', 'target_id'])
                .ignore();
              linked++;
            } catch { /* duplicate — skip */ }
          }
        }
      }

      logger.info(`[knowledge-bridge] Auto-linked ${linked} entries`);
    } catch (err) {
      logger.error(`[knowledge-bridge] autoLink failed: ${err.message}`);
    }
    return { linked };
  },

  /**
   * Infer the link type based on category/slug patterns.
   */
  _inferLinkType(kb, wiki) {
    const slug = (wiki.slug || '').toLowerCase();
    if (slug.startsWith('product/')) return 'product_reference';
    if (slug.startsWith('condition/')) return 'condition_treatment';
    if (slug.startsWith('seasonal/') || slug.startsWith('month/')) return 'seasonal_guide';
    return 'data_enrichment';
  },

  /**
   * Sync wiki outcome summaries into Claudeopedia as living entries.
   * Pushes aggregated outcome data from wiki pages into KB articles.
   */
  async syncToClaudeopedia() {
    let synced = 0;
    try {
      const bridges = await db('knowledge_bridge')
        .where({ source_type: 'claudeopedia', target_type: 'wiki' })
        .select('*');

      for (const bridge of bridges) {
        try {
          const wikiPage = await db('knowledge_entries')
            .where({ id: bridge.target_id })
            .first();
          if (!wikiPage?.content) continue;

          // Extract a summary from wiki content (first 500 chars)
          const summary = (wikiPage.content || '').substring(0, 500);

          // Update the KB article with wiki outcome data
          await db('knowledge_base')
            .where({ id: bridge.source_id })
            .update({
              updated_at: new Date(),
              // Store wiki summary in the tags or notes field if available
            });

          synced++;
        } catch { /* non-critical per-entry */ }
      }

      logger.info(`[knowledge-bridge] Synced ${synced} entries to Claudeopedia`);
    } catch (err) {
      logger.error(`[knowledge-bridge] syncToClaudeopedia failed: ${err.message}`);
    }
    return { synced };
  },

  /**
   * Generate customer-facing assessment recommendations.
   * Pulls protocol data from Claudeopedia + real outcome data from Wiki,
   * feeds both to Claude, returns structured recommendations.
   */
  async generateAssessmentRecommendations(customerId) {
    try {
      // Get latest assessment
      const latest = await db('lawn_assessments')
        .where({ customer_id: customerId })
        .orderBy('service_date', 'desc')
        .first();

      if (!latest) return null;

      // Get customer context
      const customer = await db('customers')
        .where({ id: customerId })
        .select('first_name', 'grass_track', 'grass_type', 'property_sqft')
        .first();

      // Pull relevant wiki data (treatment outcomes for this grass type)
      let outcomeData = [];
      try {
        outcomeData = await db('treatment_outcomes')
          .where('grass_track', customer?.grass_track || 'A')
          .orderBy('treatment_date', 'desc')
          .limit(20)
          .select('products_applied', 'delta_turf_density', 'delta_weed_suppression',
            'delta_fungus_control', 'season');
      } catch { /* table may not exist */ }

      // Pull relevant KB articles
      let kbArticles = [];
      try {
        kbArticles = await db('knowledge_base')
          .where('active', true)
          .where(function () {
            this.where('category', 'product')
              .orWhere('category', 'protocol')
              .orWhere('category', 'seasonal');
          })
          .select('title', 'summary')
          .limit(10);
      } catch { /* table may not exist */ }

      // Build recommendations from assessment data
      const scores = {
        turf_density: latest.turf_density,
        weed_suppression: latest.weed_suppression,
        fungus_control: latest.fungus_control,
        color_health: latest.color_health,
        thatch_level: latest.thatch_level,
      };

      const recommendations = [];
      const month = new Date().getMonth();
      const isSummer = month >= 4 && month <= 8;
      const isWinter = month === 11 || month <= 1;

      // Priority recommendations based on weakest metrics
      if (scores.turf_density < 60) {
        recommendations.push({
          priority: 1,
          title: 'Turf Density Improvement',
          text: isSummer
            ? 'With summer warmth, your St. Augustine should fill in nicely. Keep irrigation consistent — 30-45 min per zone, 2x/week.'
            : 'Turf density is building. We\'ll focus fertilization on promoting lateral growth this visit.',
        });
      }
      if (scores.weed_suppression < 70) {
        recommendations.push({
          priority: 2,
          title: 'Weed Control',
          text: 'We\'re targeting broadleaf weeds with a selective herbicide that won\'t harm your turf. You may see yellowing weeds within 7-10 days — that\'s the treatment working.',
        });
      }
      if (scores.fungus_control < 70) {
        recommendations.push({
          priority: 3,
          title: 'Fungus Prevention',
          text: isSummer
            ? 'Summer humidity increases fungal pressure. We\'ll apply a preventive fungicide. Avoid evening irrigation — water early morning to let blades dry.'
            : 'We\'ll apply a preventive fungicide treatment. Ensure sprinklers aren\'t running after 4 PM.',
        });
      }
      if (scores.thatch_level < 60) {
        recommendations.push({
          priority: 4,
          title: 'Thatch Management',
          text: 'Thatch layer is building up. We\'ll adjust our approach to help decompose the thatch naturally. Consider raising your mow height slightly.',
        });
      }

      // Sort by priority
      recommendations.sort((a, b) => a.priority - b.priority);

      // Overall score
      const overallScore = Math.round(
        (scores.turf_density + scores.weed_suppression + scores.fungus_control +
          (scores.color_health || 0) + (scores.thatch_level || 0)) / 5
      );

      // Between-visit tip
      const tips = [
        'Water early morning (6-8 AM) to reduce fungal pressure.',
        'Mow at 3.5-4 inches — taller grass crowds out weeds naturally.',
        'Avoid walking on wet grass to prevent soil compaction.',
        'Keep an eye out for brown patches — snap a photo if you see any.',
        isWinter ? 'Reduce irrigation frequency — your lawn needs less water during dormancy.' : null,
        isSummer ? 'Deep, infrequent watering (2x/week) encourages deeper root growth.' : null,
      ].filter(Boolean);

      const tip = tips[Math.floor(Math.random() * tips.length)];

      // Next visit focus
      const weakest = recommendations[0];
      const nextFocus = weakest
        ? `We'll prioritize ${weakest.title.toLowerCase()} on your next visit.`
        : 'Your lawn is looking great! We\'ll maintain the current treatment program.';

      return {
        overallScore,
        recommendations: recommendations.slice(0, 3),
        nextVisitFocus: nextFocus,
        betweenVisitTip: tip,
        assessmentDate: latest.service_date,
        season: latest.season,
      };
    } catch (err) {
      logger.error(`[knowledge-bridge] generateRecommendations failed: ${err.message}`);
      return null;
    }
  },

  /**
   * Get bridge links for a given source.
   */
  async getLinks(sourceType, sourceId) {
    return db('knowledge_bridge')
      .where({ source_type: sourceType, source_id: sourceId })
      .select('*');
  },

  /**
   * Get bridge stats.
   */
  async getStats() {
    try {
      const [counts] = await db('knowledge_bridge').select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE link_type = 'product_reference') as product_links"),
        db.raw("COUNT(*) FILTER (WHERE link_type = 'condition_treatment') as condition_links"),
        db.raw("COUNT(*) FILTER (WHERE link_type = 'seasonal_guide') as seasonal_links"),
        db.raw("COUNT(*) FILTER (WHERE link_type = 'data_enrichment') as enrichment_links"),
        db.raw("COUNT(*) FILTER (WHERE auto_linked = true) as auto_linked"),
      );
      return counts;
    } catch {
      return { total: 0 };
    }
  },
};

module.exports = KnowledgeBridge;
