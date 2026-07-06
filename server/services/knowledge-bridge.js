/**
 * Knowledge Bridge Service
 *
 * Bridges Claudeopedia (knowledge_base) ↔ Agronomic Wiki (knowledge_entries).
 *
 * Claudeopedia is the general-purpose KB: products, protocols, pest IDs,
 * UF/IFAS references, business SOPs — mostly manually curated or AI-seeded.
 *
 * Agronomic Wiki is outcome-driven: auto-generated pages from real treatment
 * outcomes linked to lawn assessment before/after data.
 *
 * The bridge:
 *  1. Cross-references entries between the two systems
 *  2. Enriches wiki pages with Claudeopedia reference data (MOA, FRAC, protocols)
 *  3. Enriches Claudeopedia entries with real outcome stats from the wiki
 *  4. Provides unified search across both
 *  5. Powers contextual recommendations on lawn assessments
 */

const db = require('../models/db');
const logger = require('./logger');
const { loadCustomerGrassContext } = require('./lawn-grass-context');
const { TRUSTED_STATUSES } = require('./agronomic-wiki');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const MODEL = require('../config/models').FLAGSHIP;
const { ROUTES } = require('../config/models');
const { dispatch } = require('./llm/call');

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 190);
}

async function callClaude(systemPrompt, userPrompt, maxTokens = 2048) {
  // Live model — GPT-5.5 (ROUTES.knowledgeAnswer). callClaude's sole caller
  // (generateAssessmentRecommendations) strict-JSON.parses the result, so require
  // PARSEABLE JSON here: dispatch with jsonMode and return the normalized JSON string.
  // Invalid/preamble OpenAI output → { ok:false } → fall through to the Claude
  // fallback below rather than returning text the caller can't parse.
  {
    const r = await dispatch(ROUTES.knowledgeAnswer, { system: systemPrompt, text: userPrompt, jsonMode: true, maxTokens });
    if (r.ok && r.json) return JSON.stringify(r.json);
  }
  // Fallback — Claude (FLAGSHIP).
  if (!Anthropic) return null;
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    return response.content?.[0]?.text || null;
  } catch (err) {
    logger.error(`[knowledge-bridge] Claude call failed: ${err.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE BRIDGE SERVICE
// ══════════════════════════════════════════════════════════════

const KnowledgeBridge = {

  // ────────────────────────────────────────────────────────────
  // createLink — manually or programmatically link two entries
  // ────────────────────────────────────────────────────────────
  async createLink({ kbEntryId, wikiEntryId, linkType, relevanceScore, linkReason, createdBy }) {
    try {
      // Look up slugs
      const kb = kbEntryId ? await db('knowledge_base').where({ id: kbEntryId }).select('slug').first() : null;
      const wiki = wikiEntryId ? await db('knowledge_entries').where({ id: wikiEntryId }).select('slug').first() : null;

      const [link] = await db('knowledge_bridge').insert({
        kb_entry_id: kbEntryId || null,
        kb_slug: kb?.slug || null,
        wiki_entry_id: wikiEntryId || null,
        wiki_slug: wiki?.slug || null,
        link_type: linkType,
        relevance_score: relevanceScore || 0.5,
        link_reason: linkReason || null,
        created_by: createdBy || 'system',
      }).onConflict(['kb_entry_id', 'wiki_entry_id', 'link_type']).ignore().returning('*');

      // Also set direct FK pointers for fast joins
      if (kbEntryId && wikiEntryId) {
        await db('knowledge_base').where({ id: kbEntryId }).update({ wiki_entry_id: wikiEntryId });
        await db('knowledge_entries').where({ id: wikiEntryId }).update({ kb_entry_id: kbEntryId });
      }

      return link || null;
    } catch (err) {
      logger.error(`[knowledge-bridge] createLink failed: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // autoLink — scan for matching entries and create links
  // Runs product name matching, condition matching, seasonal matching
  // ────────────────────────────────────────────────────────────
  async autoLink() {
    const stats = { productLinks: 0, conditionLinks: 0, seasonalLinks: 0, errors: 0 };

    try {
      // 1. Product matching: KB entries with category 'product' ↔ Wiki product pages
      const kbProducts = await db('knowledge_base')
        .where({ category: 'product', status: 'active' })
        .select('id', 'title', 'slug');

      const wikiProducts = await db('knowledge_entries')
        .where({ category: 'product' })
        .select('id', 'title', 'slug');

      for (const kbProd of kbProducts) {
        const kbName = kbProd.title.replace(/^Product:\s*/i, '').toLowerCase();
        for (const wikiProd of wikiProducts) {
          const wikiName = wikiProd.title.replace(/^Product:\s*/i, '').toLowerCase();
          if (kbName === wikiName || kbName.includes(wikiName) || wikiName.includes(kbName)) {
            const link = await KnowledgeBridge.createLink({
              kbEntryId: kbProd.id,
              wikiEntryId: wikiProd.id,
              linkType: 'product_reference',
              relevanceScore: 0.95,
              linkReason: `Product name match: "${kbProd.title}" ↔ "${wikiProd.title}"`,
              createdBy: 'auto_link',
            });
            if (link) stats.productLinks++;
          }
        }
      }

      // 2. Condition matching: KB pest/disease entries ↔ Wiki condition pages
      const kbConditions = await db('knowledge_base')
        .whereIn('category', ['pest', 'disease', 'weed', 'condition', 'pest_control', 'lawn_care'])
        .where({ status: 'active' })
        .select('id', 'title', 'slug');

      const wikiConditions = await db('knowledge_entries')
        .where({ category: 'condition' })
        .select('id', 'title', 'slug');

      for (const kbCond of kbConditions) {
        const kbName = kbCond.title.replace(/^Condition:\s*/i, '').toLowerCase();
        for (const wikiCond of wikiConditions) {
          const wikiName = wikiCond.title.replace(/^Condition:\s*/i, '').toLowerCase();
          if (kbName === wikiName || kbName.includes(wikiName) || wikiName.includes(kbName)) {
            const link = await KnowledgeBridge.createLink({
              kbEntryId: kbCond.id,
              wikiEntryId: wikiCond.id,
              linkType: 'condition_treatment',
              relevanceScore: 0.90,
              linkReason: `Condition name match: "${kbCond.title}" ↔ "${wikiCond.title}"`,
              createdBy: 'auto_link',
            });
            if (link) stats.conditionLinks++;
          }
        }
      }

      // 3. Seasonal matching: KB seasonal guides ↔ Wiki seasonal intelligence pages
      const kbSeasonal = await db('knowledge_base')
        .whereIn('category', ['seasonal', 'protocol', 'schedule'])
        .where({ status: 'active' })
        .select('id', 'title', 'slug', 'content');

      const wikiSeasonal = await db('knowledge_entries')
        .where({ category: 'seasonal' })
        .select('id', 'title', 'slug');

      const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];

      for (const kbEntry of kbSeasonal) {
        const kbLower = (kbEntry.title + ' ' + kbEntry.slug).toLowerCase();
        for (const wikiEntry of wikiSeasonal) {
          const wikiMonth = wikiEntry.slug.replace('seasonal/', '').toLowerCase();
          if (months.includes(wikiMonth) && kbLower.includes(wikiMonth)) {
            const link = await KnowledgeBridge.createLink({
              kbEntryId: kbEntry.id,
              wikiEntryId: wikiEntry.id,
              linkType: 'seasonal_guide',
              relevanceScore: 0.80,
              linkReason: `Seasonal match: "${kbEntry.title}" ↔ "${wikiEntry.title}"`,
              createdBy: 'auto_link',
            });
            if (link) stats.seasonalLinks++;
          }
        }
      }

      logger.info(`[knowledge-bridge] autoLink complete: ${JSON.stringify(stats)}`);
      return stats;

    } catch (err) {
      logger.error(`[knowledge-bridge] autoLink failed: ${err.message}`);
      stats.errors++;
      return stats;
    }
  },

  // ────────────────────────────────────────────────────────────
  // unifiedSearch — search both knowledge systems at once
  // ────────────────────────────────────────────────────────────
  async unifiedSearch(query, options = {}) {
    if (!query?.trim()) return { claudeopedia: [], wiki: [], bridged: [] };

    const term = `%${query.trim().toLowerCase()}%`;
    const limit = Math.min(options.limit || 20, 50);

    // Search Claudeopedia
    let claudeopediaQuery = db('knowledge_base')
      .where(function () {
        this.where('title', 'ilike', term)
          .orWhere('content', 'ilike', term);
      })
      .where({ status: 'active' });
    if (options.trustedOnly) {
      // Wiki-sync MIRRORS inherit the wiki's review gate on agent-facing
      // reads; merely-linked curated articles stay visible.
      claudeopediaQuery = claudeopediaQuery.whereNot(function untrustedWikiMirror() {
        this.where('source', 'wiki-sync').whereIn(
          'wiki_entry_id',
          db('knowledge_entries').select('id').whereNotIn('review_status', TRUSTED_STATUSES),
        );
      });
    }
    const claudeopedia = await claudeopediaQuery
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .select('id', 'slug', 'title', 'category', 'confidence', 'updated_at', 'wiki_entry_id');

    // Search Agronomic Wiki. Agent-facing callers pass trustedOnly so red
    // pages awaiting review never feed an agent; the admin browse/review UI
    // omits it and sees everything.
    let wikiQuery = db('knowledge_entries')
      .where(function () {
        this.where('title', 'ilike', term)
          .orWhere('content', 'ilike', term)
          .orWhere('summary', 'ilike', term);
      });
    if (options.trustedOnly) {
      wikiQuery = wikiQuery.whereIn('review_status', TRUSTED_STATUSES);
    }
    const wiki = await wikiQuery
      .orderBy('data_point_count', 'desc')
      .limit(limit)
      .select('id', 'slug', 'title', 'category', 'confidence', 'data_point_count', 'updated_at', 'kb_entry_id', 'review_tier', 'review_status');

    // Find bridged pairs
    const allKbIds = claudeopedia.map(e => e.id).filter(Boolean);
    const allWikiIds = wiki.map(e => e.id).filter(Boolean);
    const bridges = (allKbIds.length || allWikiIds.length) ? await db('knowledge_bridge')
      .where(function () {
        if (allKbIds.length) this.whereIn('kb_entry_id', allKbIds);
        if (allWikiIds.length) this.orWhereIn('wiki_entry_id', allWikiIds);
      })
      .select('*') : [];

    return {
      claudeopedia: claudeopedia.map(e => ({ ...e, source: 'claudeopedia' })),
      wiki: wiki.map(e => ({ ...e, source: 'agronomic_wiki' })),
      bridged: bridges,
      totalResults: claudeopedia.length + wiki.length,
    };
  },

  // ────────────────────────────────────────────────────────────
  // getLinkedEntries — get all linked entries for a given entry
  // ────────────────────────────────────────────────────────────
  async getLinkedEntries(entryId, source = 'auto') {
    try {
      let bridges;
      if (source === 'claudeopedia' || source === 'auto') {
        bridges = await db('knowledge_bridge').where({ kb_entry_id: entryId });
        if (!bridges.length && source === 'auto') {
          bridges = await db('knowledge_bridge').where({ wiki_entry_id: entryId });
        }
      } else {
        bridges = await db('knowledge_bridge').where({ wiki_entry_id: entryId });
      }

      if (!bridges.length) return { links: [], wikiEntries: [], kbEntries: [] };

      const wikiIds = bridges.map(b => b.wiki_entry_id).filter(Boolean);
      const kbIds = bridges.map(b => b.kb_entry_id).filter(Boolean);

      const wikiEntries = wikiIds.length
        ? await db('knowledge_entries').whereIn('id', wikiIds).select('id', 'slug', 'title', 'category', 'summary', 'data_point_count', 'confidence')
        : [];

      const kbEntries = kbIds.length
        ? await db('knowledge_base').whereIn('id', kbIds).select('id', 'slug', 'title', 'category', 'confidence')
        : [];

      return { links: bridges, wikiEntries, kbEntries };
    } catch (err) {
      logger.error(`[knowledge-bridge] getLinkedEntries failed: ${err.message}`);
      return { links: [], wikiEntries: [], kbEntries: [] };
    }
  },

  // ────────────────────────────────────────────────────────────
  // enrichWikiPageWithKB — pull Claudeopedia data into a wiki page
  // Called during wiki page generation/update
  // ────────────────────────────────────────────────────────────
  async enrichWikiPageWithKB(wikiEntryId) {
    try {
      const { kbEntries } = await KnowledgeBridge.getLinkedEntries(wikiEntryId, 'wiki');

      if (!kbEntries.length) return null;

      // Gather full content from linked KB entries
      const fullEntries = await db('knowledge_base')
        .whereIn('id', kbEntries.map(e => e.id))
        .select('title', 'category', 'content', 'confidence');

      return {
        referenceCount: fullEntries.length,
        references: fullEntries.map(e => ({
          title: e.title,
          category: e.category,
          confidence: e.confidence,
          excerpt: (e.content || '').substring(0, 500),
        })),
      };
    } catch (err) {
      logger.error(`[knowledge-bridge] enrichWikiPageWithKB failed: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // enrichKBEntryWithOutcomes — pull wiki outcome stats into a KB entry
  // ────────────────────────────────────────────────────────────
  async enrichKBEntryWithOutcomes(kbEntryId) {
    try {
      const { wikiEntries } = await KnowledgeBridge.getLinkedEntries(kbEntryId, 'claudeopedia');

      if (!wikiEntries.length) return null;

      return {
        outcomePages: wikiEntries.length,
        totalDataPoints: wikiEntries.reduce((sum, e) => sum + (e.data_point_count || 0), 0),
        entries: wikiEntries.map(e => ({
          title: e.title,
          category: e.category,
          dataPoints: e.data_point_count,
          confidence: e.confidence,
          summary: e.summary,
        })),
      };
    } catch (err) {
      logger.error(`[knowledge-bridge] enrichKBEntryWithOutcomes failed: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // generateAssessmentRecommendations — AI-powered recommendations
  // Uses both Claudeopedia protocols + wiki outcome data
  // Called after lawn assessment is confirmed
  // ────────────────────────────────────────────────────────────
  async generateAssessmentRecommendations(assessmentId) {
    try {
      const assessment = await db('lawn_assessments').where({ id: assessmentId }).first();
      if (!assessment) return null;

      const customer = await db('customers').where({ id: assessment.customer_id }).first();

      // Grass context lives on customer_turf_profiles, not customers.
      // track_key is the protocol track id (e.g. 'st_augustine'); it may be
      // null when the customer has no turf profile yet.
      const grassContext = await loadCustomerGrassContext(assessment.customer_id);
      const grassType = grassContext.grassTypeLabel || 'St. Augustine';
      const grassTrack = grassContext.trackKey || null;

      // Pull relevant Claudeopedia entries (protocols, product info)
      const protocolEntries = await db('knowledge_base')
        .whereIn('category', ['protocol', 'product', 'lawn_care', 'seasonal'])
        .where({ status: 'active' })
        // Wiki-sync MIRRORS inherit the wiki's review gate (customer-visible
        // recs); merely-linked curated articles stay visible.
        .whereNot(function untrustedWikiMirror() {
          this.where('source', 'wiki-sync').whereIn(
            'wiki_entry_id',
            db('knowledge_entries').select('id').whereNotIn('review_status', TRUSTED_STATUSES),
          );
        })
        .where(function () {
          this.where('content', 'ilike', `%${grassType}%`)
            .orWhere('category', 'seasonal');
          if (grassTrack) this.orWhere('content', 'ilike', `%track ${grassTrack}%`);
        })
        .select('title', 'content', 'category')
        .limit(10);

      // Pull relevant wiki outcome data (what's actually worked)
      // Trusted pages only — these feed customer-visible recommendations,
      // so red pages awaiting review are excluded (exception-based gate).
      const outcomeEntries = await db('knowledge_entries')
        .whereIn('review_status', TRUSTED_STATUSES)
        .where(function () {
          this.where('category', 'seasonal');
          if (grassTrack) {
            this.orWhere(function () {
              this.where('category', 'track').where('slug', 'ilike', `%${slugify(grassTrack)}%`);
            });
          }
        })
        .select('title', 'summary', 'data_point_count', 'confidence')
        .limit(5);

      // Build scores context
      const scores = {
        turf_density: assessment.turf_density,
        weed_suppression: assessment.weed_suppression,
        color_health: assessment.color_health,
        fungus_control: assessment.fungus_control,
        thatch_level: assessment.thatch_level,
        // Tech-confirmed consolidated damage score (higher = healthier), folding
        // disease/thatch/insect/drought/mechanical. This is the score the tech can
        // correct on completion, so it — not the raw AI fungus/thatch sub-reads —
        // is authoritative for whether damage recommendations are warranted.
        stress_damage: assessment.stress_damage,
        observations: assessment.observations,
        season: assessment.season,
      };

      const month = new Date().getMonth() + 1;
      const monthName = ['January','February','March','April','May','June','July','August','September','October','November','December'][month - 1];

      const systemPrompt = `You are the agronomic intelligence engine for Waves Pest Control in Southwest Florida. You generate clear, actionable lawn care recommendations by combining protocol knowledge with real treatment outcome data. Write in a professional but warm tone suitable for both the tech and the customer. Be specific and SWFL-relevant.`;

      const userPrompt = `Generate lawn care recommendations for this assessment:

Customer: ${customer?.first_name} ${customer?.last_name}
Grass Type: ${grassType} (Track ${grassTrack || 'unspecified'})
Month: ${monthName} (Season: ${assessment.season})

Current Scores (all 0-100, higher = healthier):
- Turf Density: ${scores.turf_density}%
- Weed Suppression: ${scores.weed_suppression}%
- Color Health: ${scores.color_health}%${scores.stress_damage != null ? `
- Stress / Damage (TECH-CONFIRMED, consolidates disease, thatch, insect, drought & mechanical): ${scores.stress_damage}%
  ↳ Fungus Control ${scores.fungus_control}% and Thatch Level ${scores.thatch_level}% are the AI's raw sub-reads only. When the tech-confirmed Stress/Damage is healthy, do NOT recommend fungicide/dethatch treatments those raw sub-reads might otherwise imply; when it is low but fungus/thatch look fine, the damage is drought/mechanical/insect — recommend accordingly.` : `
- Fungus Control: ${scores.fungus_control}%
- Thatch Level: ${scores.thatch_level}%`}
- Observations: ${scores.observations || 'None'}

Protocol References (from Claudeopedia):
${protocolEntries.map(e => `[${e.category}] ${e.title}: ${(e.content || '').substring(0, 300)}`).join('\n')}

Real Outcome Data (from Agronomic Wiki):
${outcomeEntries.map(e => `${e.title} (${e.data_point_count} data points, ${e.confidence} confidence): ${e.summary || 'No summary'}`).join('\n')}

Return a JSON object with:
{
  "summary": "<one sentence customer-friendly lawn status summary>",
  "recommendations": [
    { "priority": 1, "action": "<specific action>", "reason": "<why based on data>", "timeframe": "<when>" }
  ],
  "nextVisitFocus": "<what to prioritize on the next visit>",
  "customerTip": "<one simple thing the customer can do between visits>"
}`;

      const result = await callClaude(systemPrompt, userPrompt, 1500);
      if (!result) return null;

      try {
        const parsed = JSON.parse(result.replace(/```json|```/g, '').trim());

        // Save to assessment
        await db('lawn_assessments').where({ id: assessmentId }).update({
          ai_summary: parsed.summary,
          recommendations: JSON.stringify(parsed),
          updated_at: new Date(),
        });

        return parsed;
      } catch (parseErr) {
        logger.error(`[knowledge-bridge] Failed to parse recommendations: ${parseErr.message}`);
        return null;
      }

    } catch (err) {
      logger.error(`[knowledge-bridge] generateAssessmentRecommendations failed: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // syncToClaudeopedia — push wiki outcome summaries into Claudeopedia
  // Creates/updates a "Living Outcomes" entry for each product/track
  // ────────────────────────────────────────────────────────────
  async syncToClaudeopedia() {
    const stats = { created: 0, updated: 0, errors: 0 };

    try {
      // Only the clean brain crosses into Claudeopedia: trusted pages
      // (auto/approved — red pages awaiting review are excluded), with real
      // content. Everything agents read from the KB side inherits this gate.
      const wikiEntries = await db('knowledge_entries')
        .where('data_point_count', '>', 0)
        .whereIn('review_status', TRUSTED_STATUSES)
        .select('id', 'slug', 'title', 'category', 'summary', 'data_point_count', 'confidence', 'content', 'review_status');

      const syncable = wikiEntries.filter((w) => !(w.content || '').includes('*Pending AI generation'));

      for (const wiki of syncable) {
        try {
          const kbSlug = `outcomes-${wiki.slug.replace(/\//g, '-')}`;

          const existing = await db('knowledge_base').where({ slug: kbSlug }).first();

          // Mirror trust follows the source page — a resync must never
          // resurrect a flagged mirror of a red/blocked page, and a brand-new
          // mirror of an untrusted page starts gated. Drives BOTH the status
          // field and the active boolean (different KB readers filter on each).
          const wikiTrusted = ['auto', 'approved'].includes(wiki.review_status);
          const kbData = {
            title: `Outcome Data: ${wiki.title}`,
            category: wiki.category === 'product' ? 'product' : wiki.category === 'track' ? 'protocol' : 'seasonal',
            content: `## Real-World Outcome Data\n\n${wiki.summary || ''}\n\n**Data Points:** ${wiki.data_point_count}\n**Confidence:** ${wiki.confidence}\n\n---\n\n${(wiki.content || '').substring(0, 3000)}`,
            source: 'wiki-sync',
            confidence: wiki.confidence,
            status: wikiTrusted ? 'active' : 'flagged',
            active: wikiTrusted,
            metadata: JSON.stringify({ wiki_slug: wiki.slug, wiki_id: wiki.id, synced_at: new Date().toISOString() }),
            wiki_entry_id: wiki.id,
          };

          if (existing) {
            await db('knowledge_base').where({ id: existing.id }).update({ ...kbData, updated_at: new Date() });
            stats.updated++;

            // Ensure bridge link exists
            await KnowledgeBridge.createLink({
              kbEntryId: existing.id,
              wikiEntryId: wiki.id,
              linkType: 'data_enrichment',
              relevanceScore: 1.0,
              linkReason: 'Wiki-to-Claudeopedia sync',
              createdBy: 'wiki_sync',
            });
          } else {
            const [newEntry] = await db('knowledge_base').insert({
              ...kbData,
              slug: kbSlug,
              path: `kb/${kbData.category}/${kbSlug}.md`,
              last_verified_at: new Date(),
              verified_by: 'wiki-sync',
            }).returning('*');

            if (newEntry) {
              stats.created++;
              await KnowledgeBridge.createLink({
                kbEntryId: newEntry.id,
                wikiEntryId: wiki.id,
                linkType: 'data_enrichment',
                relevanceScore: 1.0,
                linkReason: 'Wiki-to-Claudeopedia initial sync',
                createdBy: 'wiki_sync',
              });
            }
          }
        } catch (entryErr) {
          logger.error(`[knowledge-bridge] syncToClaudeopedia entry error: ${entryErr.message}`);
          stats.errors++;
        }
      }

      logger.info(`[knowledge-bridge] syncToClaudeopedia complete: ${JSON.stringify(stats)}`);
      return stats;
    } catch (err) {
      logger.error(`[knowledge-bridge] syncToClaudeopedia failed: ${err.message}`);
      return stats;
    }
  },

  // ────────────────────────────────────────────────────────────
  // syncToClaudeopediaIfDue — daily cron entry point with a weekly guard
  // (same self-healing pattern as the wiki's weeklyRefreshIfDue: a single
  // weekly fire time misses whole weeks when the process isn't up at that
  // exact minute).
  // ────────────────────────────────────────────────────────────
  async syncToClaudeopediaIfDue() {
    try {
      const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
      const recentRun = await db('knowledge_update_log')
        .where({ trigger_type: 'kb_sync' })
        .where('created_at', '>', sixDaysAgo)
        .first('id');
      if (recentRun) return { skipped: true };
    } catch (err) {
      logger.error(`[knowledge-bridge] syncIfDue guard query failed: ${err.message}`);
    }

    const stats = await KnowledgeBridge.syncToClaudeopedia();
    try {
      await db('knowledge_update_log').insert({
        action: stats.errors ? 'error' : 'sync',
        entry_slug: null,
        description: `Wiki→KB trusted sync: ${stats.created} created, ${stats.updated} updated, ${stats.errors} errors`,
        trigger_type: stats.errors ? 'kb_sync_error' : 'kb_sync',
      });
    } catch (err) {
      logger.error(`[knowledge-bridge] Failed to log sync: ${err.message}`);
    }
    return stats;
  },

  // ────────────────────────────────────────────────────────────
  // getStats — bridge health dashboard
  // ────────────────────────────────────────────────────────────
  async getStats() {
    const [bridgeCount] = await db('knowledge_bridge').count('id as count');
    const [kbCount] = await db('knowledge_base').count('id as count');
    const [wikiCount] = await db('knowledge_entries').count('id as count');

    const [kbLinked] = await db('knowledge_base').whereNotNull('wiki_entry_id').count('id as count');
    const [wikiLinked] = await db('knowledge_entries').whereNotNull('kb_entry_id').count('id as count');

    const linkTypes = await db('knowledge_bridge')
      .select('link_type')
      .count('id as count')
      .groupBy('link_type');

    return {
      totalBridgeLinks: parseInt(bridgeCount.count),
      claudeopediaTotal: parseInt(kbCount.count),
      wikiTotal: parseInt(wikiCount.count),
      claudeopediaLinked: parseInt(kbLinked.count),
      wikiLinked: parseInt(wikiLinked.count),
      linkTypeDistribution: linkTypes.reduce((acc, r) => { acc[r.link_type] = parseInt(r.count); return acc; }, {}),
    };
  },
};

module.exports = KnowledgeBridge;
