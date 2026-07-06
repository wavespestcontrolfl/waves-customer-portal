/**
 * Agronomic Intelligence Wiki Service
 *
 * Core service that links treatment outcomes to before/after assessments,
 * generates and maintains AI-written wiki pages, and provides search/read
 * access for other portal systems.
 */

const db = require('../models/db');
const logger = require('./logger');
const { loadCustomerGrassContext, irrigationTypeHasSystem } = require('./lawn-grass-context');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const MODEL = require('../config/models').FLAGSHIP;

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 190);
}

// Escape LIKE/ILIKE metacharacters so product names containing literal
// "%" or "_" (e.g. "LESCO High Manganese Combo AM 1% Mg 5.75% S ...")
// match as text instead of acting as wildcards. Pair with ESCAPE '\'.
function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (m) => `\\${m}`);
}

// Assessment-pairing recency windows. An unbounded pre/post lookup can pair
// a treatment with an assessment from a different program season, producing
// meaningless deltas. Bounds are generous on purpose — the lawn program runs
// ~monthly visits.
const PRE_ASSESSMENT_MAX_AGE_DAYS = 180;
const POST_ASSESSMENT_MAX_DAYS = 60;

function daysFrom(date, days) {
  return new Date(new Date(date).getTime() + days * 24 * 60 * 60 * 1000);
}

// Resolve a free-text applied-product name to its canonical catalog product.
// service_products rows carry whatever name the closeout stored, and the same
// physical product appears under multiple vendor listing names — keying wiki
// pages on the raw string splits one product's outcome data across pages.
// Returns the canonical name plus every known name variant (catalog name +
// aliases) so outcome aggregation covers all spellings.
async function resolveCanonicalProduct(productName) {
  const fallback = { canonicalName: productName, variants: [productName] };
  if (!productName) return fallback;
  try {
    let catalogRow = await db('products_catalog')
      .whereRaw('LOWER(name) = ?', [productName.toLowerCase()])
      .first('id', 'name');
    if (!catalogRow) {
      const alias = await db('product_aliases')
        .whereRaw('LOWER(alias_name) = ?', [productName.toLowerCase()])
        .first('product_id');
      if (alias?.product_id) {
        catalogRow = await db('products_catalog')
          .where({ id: alias.product_id })
          .first('id', 'name');
      }
    }
    if (!catalogRow) return fallback;

    const aliasRows = await db('product_aliases')
      .where({ product_id: catalogRow.id })
      .select('alias_name');
    const variants = [...new Set(
      [catalogRow.name, ...aliasRows.map((a) => a.alias_name), productName].filter(Boolean)
    )];
    return { canonicalName: catalogRow.name, variants };
  } catch (err) {
    logger.warn(`[agronomic-wiki] Canonical product lookup failed for "${productName}": ${err.message}`);
    return fallback;
  }
}

function getSeason(month) {
  if (month >= 4 && month <= 9) return 'peak';
  if (month === 3 || month === 10) return 'shoulder';
  return 'dormant';
}

function confidenceLevel(count) {
  if (count >= 50) return 'very_high';
  if (count >= 20) return 'high';
  if (count >= 5) return 'moderate';
  return 'low';
}

async function callClaude(systemPrompt, userPrompt) {
  if (!Anthropic) {
    logger.warn('[agronomic-wiki] Anthropic SDK not available — skipping AI generation');
    return null;
  }
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const text = response.content?.[0]?.text || '';
    const tokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
    return { text, tokens, model: response.model || MODEL };
  } catch (err) {
    logger.error(`[agronomic-wiki] Claude call failed: ${err.message}`);
    return null;
  }
}

async function logUpdate(action, entrySlug, description, opts = {}) {
  try {
    await db('knowledge_update_log').insert({
      action,
      entry_slug: entrySlug,
      description,
      trigger_type: opts.triggerType || null,
      trigger_id: opts.triggerId || null,
      model_used: opts.model || null,
      tokens_used: opts.tokens || null,
    });
  } catch (err) {
    logger.error(`[agronomic-wiki] Failed to log update: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
// CORE METHODS
// ══════════════════════════════════════════════════════════════

const AgronomicWiki = {

  // ────────────────────────────────────────────────────────────
  // linkTreatmentOutcome — called after an assessment is confirmed
  // ────────────────────────────────────────────────────────────
  async linkTreatmentOutcome(serviceRecordId) {
    try {
      if (!serviceRecordId) {
        logger.warn('[agronomic-wiki] linkTreatmentOutcome called without serviceRecordId');
        return null;
      }

      // Already linked?
      const existing = await db('treatment_outcomes')
        .where({ service_record_id: serviceRecordId })
        .first();
      if (existing) {
        logger.info(`[agronomic-wiki] treatment_outcome already exists for service_record ${serviceRecordId}`);
        return existing;
      }

      // 1. Find the service record (the treatment)
      const sr = await db('service_records').where({ id: serviceRecordId }).first();
      if (!sr) {
        logger.warn(`[agronomic-wiki] service_record ${serviceRecordId} not found`);
        return null;
      }

      const customerId = sr.customer_id;
      const treatmentDate = sr.service_date;

      // 2. Find the post-assessment. Prefer the assessment explicitly
      // captured for this scheduled service/record, then fall back to
      // the legacy date-based pairing.
      let postAssessment = null;
      if (sr.scheduled_service_id) {
        postAssessment = await db('lawn_assessments')
          .where({
            customer_id: customerId,
            confirmed_by_tech: true,
            service_id: sr.scheduled_service_id,
          })
          .orderByRaw('confirmed_at DESC NULLS LAST')
          .orderBy('created_at', 'desc')
          .first();
      }
      if (!postAssessment) {
        const postWindowEnd = daysFrom(treatmentDate, POST_ASSESSMENT_MAX_DAYS);
        postAssessment = await db('lawn_assessments')
          .where({ customer_id: customerId, confirmed_by_tech: true })
          .where(function () {
            this.where({ service_record_id: serviceRecordId })
              .orWhere(function () {
                this.where('service_date', '>=', treatmentDate)
                  .andWhere('service_date', '<=', postWindowEnd);
              });
          })
          .orderByRaw('CASE WHEN service_record_id = ? THEN 0 ELSE 1 END', [serviceRecordId])
          .orderBy('service_date', 'asc')
          .first();
      }

      if (!postAssessment) {
        logger.info(`[agronomic-wiki] No post-assessment found for service_record ${serviceRecordId}`);
        return null;
      }

      // 3. Find the pre-assessment — last confirmed assessment BEFORE the
      // treatment, bounded so an unrelated assessment from a prior program
      // year can't produce a bogus delta.
      const preAssessment = await db('lawn_assessments')
        .where({ customer_id: customerId, confirmed_by_tech: true })
        .where('service_date', '<', treatmentDate)
        .where('service_date', '>=', daysFrom(treatmentDate, -PRE_ASSESSMENT_MAX_AGE_DAYS))
        .orderBy('service_date', 'desc')
        .first();

      // 4. Gather products applied
      let productsApplied = [];
      try {
        const products = await db('service_products')
          .where({ service_record_id: serviceRecordId });
        productsApplied = products.map((p) => ({
          name: p.product_name,
          rate: p.application_rate,
          unit: p.rate_unit,
          method: p.application_method || null,
          area: p.application_area || null,
        }));
      } catch { /* service_products table may not exist */ }

      // 5. Gather property context. Grass type / track / sun / irrigation
      // live on customer_turf_profiles, not customers.
      const customer = await db('customers').where({ id: customerId }).first();
      const grassContext = await loadCustomerGrassContext(customerId);

      // treatment_outcomes.irrigation_system is a boolean ("has an automatic
      // irrigation system"); the turf-profile source is a 4-value enum.
      const irrigationHasSystem = irrigationTypeHasSystem(grassContext.irrigationSystem);

      // 6. Calculate deltas
      const pre = preAssessment || {};
      const post = postAssessment;
      const delta = (field) => {
        const preVal = pre[field];
        const postVal = post[field];
        if (preVal != null && postVal != null) return postVal - preVal;
        return null;
      };

      const daysBetween = preAssessment
        ? Math.round((new Date(post.service_date) - new Date(pre.service_date)) / (1000 * 60 * 60 * 24))
        : null;

      const month = new Date(treatmentDate).getMonth() + 1;

      // 7. Insert treatment_outcome
      const [outcome] = await db('treatment_outcomes').insert({
        customer_id: customerId,
        service_record_id: serviceRecordId,
        treatment_date: treatmentDate,
        service_type: sr.service_type || null,
        grass_track: grassContext.trackKey || null,
        visit_number: sr.visit_number || null,
        products_applied: JSON.stringify(productsApplied),

        pre_assessment_id: preAssessment?.id || null,
        pre_assessment_date: preAssessment?.service_date || null,
        pre_turf_density: pre.turf_density ?? null,
        pre_weed_suppression: pre.weed_suppression ?? null,
        pre_color_health: pre.color_health ?? null,
        pre_fungus_control: pre.fungus_control ?? null,
        pre_thatch_level: pre.thatch_level ?? null,

        post_assessment_id: post.id,
        post_assessment_date: post.service_date,
        post_turf_density: post.turf_density,
        post_weed_suppression: post.weed_suppression,
        post_color_health: post.color_health,
        post_fungus_control: post.fungus_control,
        post_thatch_level: post.thatch_level,

        delta_turf_density: delta('turf_density'),
        delta_weed_suppression: delta('weed_suppression'),
        delta_color_health: delta('color_health'),
        delta_fungus_control: delta('fungus_control'),
        delta_thatch_level: delta('thatch_level'),

        days_between_assessments: daysBetween,
        season: getSeason(month),

        grass_type: grassContext.grassType || null,
        property_sqft: grassContext.propertySqft || null,
        sun_exposure: grassContext.sunExposure || null,
        // No canonical source for near-water yet (not on turf profile).
        near_water: null,
        irrigation_system: irrigationHasSystem,

        satisfaction_rating: null,
      }).returning('*');

      await logUpdate('ingest', null, `Linked treatment outcome for service_record ${serviceRecordId}`, {
        triggerType: 'assessment_confirmed',
        triggerId: serviceRecordId,
      });

      // 8. Queue wiki page updates (fire-and-forget so we don't block the confirm)
      setImmediate(async () => {
        try {
          // Update product pages
          for (const p of productsApplied) {
            if (p.name) await AgronomicWiki.updateProductPage(p.name);
          }
          // Update track page
          if (outcome.grass_track) {
            await AgronomicWiki.updateTrackPage(outcome.grass_track);
          }
          // Update seasonal page
          await AgronomicWiki.updateSeasonalPage(month);
        } catch (err) {
          logger.error(`[agronomic-wiki] Background wiki update failed: ${err.message}`);
        }
      });

      logger.info(`[agronomic-wiki] Created treatment_outcome ${outcome.id} for customer ${customerId}`);
      return outcome;

    } catch (err) {
      logger.error(`[agronomic-wiki] linkTreatmentOutcome failed: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // updateProductPage — aggregate outcomes for a product, generate wiki page
  // ────────────────────────────────────────────────────────────
  async updateProductPage(productName) {
    try {
      // One page per catalog product: resolve the applied-product string to
      // its canonical catalog name and aggregate outcomes across every known
      // name variant, so vendor-listing spellings don't split the data.
      const { canonicalName, variants } = await resolveCanonicalProduct(productName);
      const slug = `product/${slugify(canonicalName)}`;

      const outcomes = await db('treatment_outcomes')
        .where(function () {
          for (const variant of variants) {
            this.orWhereRaw("products_applied::text ILIKE ? ESCAPE '\\'", [`%${escapeLike(variant)}%`]);
          }
        })
        .orderBy('treatment_date', 'desc');

      if (!outcomes.length) {
        logger.info(`[agronomic-wiki] No outcomes found for product ${productName}`);
        return null;
      }

      // Aggregate stats
      const stats = aggregateOutcomes(outcomes);
      const data = { productName: canonicalName, stats, outcomes: outcomes.slice(0, 50) };

      const entry = await AgronomicWiki.generatePage(slug, 'product', data, `Product: ${canonicalName}`);

      // Fold variant-named duplicate pages into the canonical page. Only after
      // a successful canonical write, so a generation failure never deletes
      // the only copy of the content.
      if (entry) {
        await mergeVariantProductPages(entry, variants, slug);
      }

      return entry;
    } catch (err) {
      logger.error(`[agronomic-wiki] updateProductPage failed for ${productName}: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // updateConditionPage — aggregate outcomes for a pest/disease/weed condition
  // ────────────────────────────────────────────────────────────
  async updateConditionPage(conditionName) {
    try {
      const slug = `condition/${slugify(conditionName)}`;

      // Find assessments mentioning this condition
      const assessments = await db('lawn_assessments')
        .where('observations', 'ilike', `%${conditionName}%`)
        .orderBy('service_date', 'desc')
        .limit(100);

      const customerIds = [...new Set(assessments.map((a) => a.customer_id))];

      // Find treatment outcomes for these customers
      const outcomes = customerIds.length
        ? await db('treatment_outcomes')
            .whereIn('customer_id', customerIds)
            .orderBy('treatment_date', 'desc')
            .limit(100)
        : [];

      const stats = aggregateOutcomes(outcomes);
      const data = { conditionName, stats, assessmentCount: assessments.length, outcomes: outcomes.slice(0, 50) };

      return AgronomicWiki.generatePage(slug, 'condition', data, `Condition: ${conditionName}`);
    } catch (err) {
      logger.error(`[agronomic-wiki] updateConditionPage failed for ${conditionName}: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // updateTrackPage — aggregate performance across all customers on a track
  // ────────────────────────────────────────────────────────────
  async updateTrackPage(trackId) {
    try {
      const slug = `track/${slugify(trackId)}`;

      const outcomes = await db('treatment_outcomes')
        .where({ grass_track: trackId })
        .orderBy('visit_number', 'asc')
        .orderBy('treatment_date', 'desc');

      if (!outcomes.length) {
        logger.info(`[agronomic-wiki] No outcomes found for track ${trackId}`);
        return null;
      }

      const stats = aggregateOutcomes(outcomes);
      const customerCount = new Set(outcomes.map((o) => o.customer_id)).size;
      const data = { trackId, stats, customerCount, outcomes: outcomes.slice(0, 50) };

      return AgronomicWiki.generatePage(slug, 'track', data, `Track ${trackId} Performance`);
    } catch (err) {
      logger.error(`[agronomic-wiki] updateTrackPage failed for ${trackId}: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // updateSeasonalPage — aggregate what happened this month
  // ────────────────────────────────────────────────────────────
  async updateSeasonalPage(month) {
    try {
      const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ];
      const monthName = monthNames[month - 1] || `Month-${month}`;
      const slug = `seasonal/${slugify(monthName)}`;

      const outcomes = await db('treatment_outcomes')
        .whereRaw("EXTRACT(MONTH FROM treatment_date) = ?", [month])
        .orderBy('treatment_date', 'desc');

      // Match product/track behavior: no outcomes → no page. Generating from
      // zero data burns an AI call to write a page that can only say
      // "no data yet".
      if (!outcomes.length) {
        logger.info(`[agronomic-wiki] No outcomes found for month ${month} — skipping seasonal page`);
        return null;
      }

      const stats = aggregateOutcomes(outcomes);
      const data = { month, monthName, stats, outcomes: outcomes.slice(0, 50) };

      return AgronomicWiki.generatePage(slug, 'seasonal', data, `${monthName} — Seasonal Intelligence`);
    } catch (err) {
      logger.error(`[agronomic-wiki] updateSeasonalPage failed for month ${month}: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // generatePage — call Claude to generate/update a wiki page
  // ────────────────────────────────────────────────────────────
  async generatePage(slug, category, data, title) {
    try {
      // Check for existing page
      const existing = await db('knowledge_entries').where({ slug }).first();

      const dataPointCount = data.outcomes?.length || data.assessmentCount || 0;
      const confidence = confidenceLevel(dataPointCount);
      const sourceIds = (data.outcomes || []).map((o) => o.id).slice(0, 200);

      // Skip regeneration when the underlying data hasn't changed — the AI
      // pass would just rewrite the same page. Placeholder stubs are always
      // retried.
      if (
        existing &&
        !existing.content.includes('*Pending AI generation') &&
        existing.data_point_count === dataPointCount &&
        sameSourceIds(existing.source_treatment_ids, sourceIds)
      ) {
        if (existing.stale_flag) {
          await db('knowledge_entries')
            .where({ id: existing.id })
            .update({ stale_flag: false, updated_at: new Date() });
        }
        await logUpdate('skip', slug, `Skipped ${category} page: ${title} — no new data since last generation (${dataPointCount} data points)`, {
          triggerType: 'wiki_generation',
        });
        logger.info(`[agronomic-wiki] Skipped page ${slug} — data unchanged (${dataPointCount} pts)`);
        return existing;
      }

      const systemPrompt = `You are maintaining an agronomic knowledge wiki for Waves Pest Control in Southwest Florida. You write technically accurate, data-driven content based on real treatment outcomes. Never fabricate data. Only make claims supported by the provided data points. When data is limited, say so explicitly. When data contradicts existing claims, flag it clearly. Write in markdown format.`;

      const existingContent = existing ? `\n\nCurrent wiki page content:\n${existing.content}` : '';

      const userPrompt = `${title}

Category: ${category}
Data points: ${dataPointCount}
Confidence: ${confidence}
${existingContent}

Aggregated data:
${JSON.stringify(data.stats || {}, null, 2)}

Recent treatment outcomes (up to 50):
${JSON.stringify((data.outcomes || []).map((o) => ({
  date: o.treatment_date,
  track: o.grass_track,
  season: o.season,
  delta_turf: o.delta_turf_density,
  delta_weed: o.delta_weed_suppression,
  delta_color: o.delta_color_health,
  delta_fungus: o.delta_fungus_control,
  delta_thatch: o.delta_thatch_level,
  days: o.days_between_assessments,
  grass: o.grass_type,
  products: o.products_applied,
})), null, 2)}

Task: ${existing ? 'Update this wiki page incorporating the new data. Preserve existing content that is still supported. Update statistics. Flag any contradictions.' : 'Generate a new wiki page from this data.'} Return the complete markdown page content.`;

      const result = await callClaude(systemPrompt, userPrompt);

      // A failed AI call must never clobber an existing page with the
      // placeholder stub — keep the current content and surface the failure
      // in the update log instead.
      if (!result?.text?.trim() && existing) {
        await logUpdate('error', slug, `Generation failed for ${category} page: ${title} — existing content preserved`, {
          triggerType: 'wiki_generation',
        });
        logger.warn(`[agronomic-wiki] Generation failed for ${slug} — existing content preserved`);
        return existing;
      }

      const content = result?.text?.trim()
        ? result.text
        : `# ${title}\n\n*Pending AI generation — ${dataPointCount} data points available.*`;

      const entryData = {
        slug,
        category,
        title: title || slug,
        content,
        summary: extractSummary(content),
        data_point_count: dataPointCount,
        confidence,
        last_data_update: new Date(),
        stale_flag: false,
        source_treatment_ids: JSON.stringify(sourceIds),
      };

      let entry;
      if (existing) {
        [entry] = await db('knowledge_entries')
          .where({ id: existing.id })
          .update({ ...entryData, updated_at: new Date() })
          .returning('*');
      } else {
        [entry] = await db('knowledge_entries')
          .insert(entryData)
          .returning('*');
      }

      await logUpdate(
        existing ? 'update' : 'ingest',
        slug,
        `${existing ? 'Updated' : 'Created'} ${category} page: ${title} (${dataPointCount} data points, ${confidence} confidence)`,
        {
          triggerType: 'wiki_generation',
          model: result?.model || null,
          tokens: result?.tokens || null,
        },
      );

      logger.info(`[agronomic-wiki] ${existing ? 'Updated' : 'Created'} page: ${slug} (${dataPointCount} pts, ${confidence})`);
      return entry;

    } catch (err) {
      logger.error(`[agronomic-wiki] generatePage failed for ${slug}: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // searchWiki — full-text search across wiki pages
  // ────────────────────────────────────────────────────────────
  async searchWiki(query) {
    if (!query || !query.trim()) return [];
    const term = `%${query.trim().toLowerCase()}%`;
    return db('knowledge_entries')
      .where(function () {
        this.where('title', 'ilike', term)
          .orWhere('content', 'ilike', term)
          .orWhere('summary', 'ilike', term)
          .orWhereRaw("tags::text ILIKE ?", [term]);
      })
      .orderByRaw("CASE WHEN title ILIKE ? THEN 0 WHEN summary ILIKE ? THEN 1 ELSE 2 END", [term, term])
      .orderBy('data_point_count', 'desc')
      .limit(30)
      .select('id', 'slug', 'category', 'title', 'summary', 'data_point_count', 'confidence', 'tags', 'last_data_update', 'stale_flag');
  },

  // ────────────────────────────────────────────────────────────
  // getPage — get a single page by slug
  // ────────────────────────────────────────────────────────────
  async getPage(slug) {
    return db('knowledge_entries').where({ slug }).first();
  },

  // ────────────────────────────────────────────────────────────
  // listPages — list pages filtered by category
  // ────────────────────────────────────────────────────────────
  async listPages(category, options = {}) {
    let query = db('knowledge_entries')
      .select('id', 'slug', 'category', 'title', 'summary', 'data_point_count', 'confidence', 'tags', 'last_data_update', 'stale_flag', 'created_at', 'updated_at');

    if (category) {
      query = query.where({ category });
    }

    if (options.staleOnly) {
      query = query.where({ stale_flag: true });
    }

    const orderBy = options.orderBy || 'updated_at';
    const orderDir = options.orderDir || 'desc';
    query = query.orderBy(orderBy, orderDir);

    const limit = Math.min(options.limit || 100, 500);
    const offset = options.offset || 0;
    query = query.limit(limit).offset(offset);

    return query;
  },

  // ────────────────────────────────────────────────────────────
  // getStats — dashboard stats
  // ────────────────────────────────────────────────────────────
  async getStats() {
    const [totalRow] = await db('knowledge_entries').count('id as count');
    const total = parseInt(totalRow.count) || 0;

    const confidenceDist = await db('knowledge_entries')
      .select('confidence')
      .count('id as count')
      .groupBy('confidence');

    const [staleRow] = await db('knowledge_entries').where({ stale_flag: true }).count('id as count');
    const staleCount = parseInt(staleRow.count) || 0;

    const [outcomeRow] = await db('treatment_outcomes').count('id as count');
    const totalOutcomes = parseInt(outcomeRow.count) || 0;

    const categoryDist = await db('knowledge_entries')
      .select('category')
      .count('id as count')
      .groupBy('category');

    return {
      totalPages: total,
      totalOutcomes,
      staleCount,
      confidenceDistribution: confidenceDist.reduce((acc, r) => {
        acc[r.confidence] = parseInt(r.count);
        return acc;
      }, {}),
      categoryDistribution: categoryDist.reduce((acc, r) => {
        acc[r.category] = parseInt(r.count);
        return acc;
      }, {}),
    };
  },

  // ────────────────────────────────────────────────────────────
  // getLog — recent update log
  // ────────────────────────────────────────────────────────────
  async getLog(limit = 50) {
    return db('knowledge_update_log')
      .orderBy('created_at', 'desc')
      .limit(Math.min(limit, 200));
  },

  // ────────────────────────────────────────────────────────────
  // weeklyRefresh — cron job: update stale pages, generate seasonal page
  // ────────────────────────────────────────────────────────────
  async weeklyRefresh() {
    logger.info('[agronomic-wiki] Starting weekly refresh');

    try {
      // 1. Mark stale pages (last_data_update > 60 days ago)
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      await db('knowledge_entries')
        .where('last_data_update', '<', sixtyDaysAgo)
        .where({ stale_flag: false })
        .update({ stale_flag: true });

      // 2. Refresh stale pages (up to 10 per run to control API costs).
      // Only categories with a refresh path — anything else would sit in the
      // stale list forever, permanently occupying refresh slots.
      const stalePages = await db('knowledge_entries')
        .where({ stale_flag: true })
        .whereIn('category', ['product', 'track', 'seasonal', 'condition'])
        .orderBy('last_data_update', 'asc')
        .limit(10);

      let refreshed = 0;
      for (const page of stalePages) {
        try {
          if (page.category === 'product') {
            const productName = page.title.replace(/^Product:\s*/i, '');
            await AgronomicWiki.updateProductPage(productName);
            refreshed++;
          } else if (page.category === 'track') {
            const trackId = page.slug.replace('track/', '');
            await AgronomicWiki.updateTrackPage(trackId);
            refreshed++;
          } else if (page.category === 'seasonal') {
            const monthSlug = page.slug.replace('seasonal/', '');
            const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
            const monthIdx = monthNames.indexOf(monthSlug);
            if (monthIdx >= 0) {
              await AgronomicWiki.updateSeasonalPage(monthIdx + 1);
              refreshed++;
            }
          } else if (page.category === 'condition') {
            const conditionName = page.title.replace(/^Condition:\s*/i, '');
            await AgronomicWiki.updateConditionPage(conditionName);
            refreshed++;
          }
        } catch (err) {
          logger.error(`[agronomic-wiki] Failed to refresh page ${page.slug}: ${err.message}`);
        }
      }

      // 3. Generate seasonal page for current month
      const currentMonth = new Date().getMonth() + 1;
      await AgronomicWiki.updateSeasonalPage(currentMonth);

      await logUpdate('lint', null, `Weekly refresh: ${refreshed} stale pages refreshed, seasonal page updated for month ${currentMonth}`, {
        triggerType: 'weekly_cron',
      });

      logger.info(`[agronomic-wiki] Weekly refresh complete: ${refreshed} pages refreshed`);
      return { refreshed, staleFound: stalePages.length };
    } catch (err) {
      logger.error(`[agronomic-wiki] weeklyRefresh failed: ${err.message}`);
      // Log the failure so a refresh that dies is visible in the update log
      // (a silent gap here previously read the same as "cron never fired").
      // Distinct trigger_type so weeklyRefreshIfDue doesn't count a failed
      // run as done — it retries the next day.
      await logUpdate('error', null, `Weekly refresh failed: ${err.message}`, {
        triggerType: 'weekly_cron_error',
      });
      return { refreshed: 0, error: err.message };
    }
  },

  // ────────────────────────────────────────────────────────────
  // weeklyRefreshIfDue — daily cron entry point with a weekly guard.
  // The refresh previously ran on a single Sunday-6AM fire time; any miss
  // (restart, deploy in flight, transient error) meant a whole week of
  // silence. Running daily with a "already ran in the last 6 days" guard
  // makes the schedule self-healing while keeping the weekly cadence.
  // ────────────────────────────────────────────────────────────
  async weeklyRefreshIfDue() {
    try {
      const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
      const recentRun = await db('knowledge_update_log')
        .where({ trigger_type: 'weekly_cron' })
        .where('created_at', '>', sixDaysAgo)
        .first('id');
      if (recentRun) {
        return { skipped: true, refreshed: 0 };
      }
    } catch (err) {
      // If the guard query itself fails, running the refresh is safer than
      // never running it.
      logger.error(`[agronomic-wiki] weeklyRefreshIfDue guard query failed: ${err.message}`);
    }
    return AgronomicWiki.weeklyRefresh();
  },
};

// ══════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ══════════════════════════════════════════════════════════════

// source_treatment_ids is jsonb — pg usually returns it parsed, but tolerate
// a raw string from older rows or mocks.
function sameSourceIds(existingIds, newIds) {
  let parsed = existingIds;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return false; }
  }
  if (!Array.isArray(parsed)) return false;
  if (parsed.length !== newIds.length) return false;
  const a = [...parsed].sort();
  const b = [...newIds].sort();
  return a.every((id, i) => id === b[i]);
}

// First real prose line of the page. Generated pages open with a heading and
// a run of "**Category:** ..." metadata lines — those make useless summaries
// for search results and the estimate AI context.
function extractSummary(content) {
  const line = content.split('\n').find((l) => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return false;
    if (/^\*\*[^*]+:\*\*/.test(t)) return false; // "**Label:** value" metadata
    if (/^[->|]/.test(t)) return false; // blockquote callouts, list bullets, tables
    if (/^-{3,}$/.test(t)) return false; // horizontal rules
    return true;
  });
  return line?.trim()?.substring(0, 500) || '';
}

// Delete leftover product pages that were keyed on a non-canonical name
// variant, re-pointing any knowledge_base.wiki_entry_id references at the
// canonical page first. knowledge_bridge rows cascade on delete and
// knowledge_contradictions references SET NULL (migration 20260414000018/19).
async function mergeVariantProductPages(canonicalEntry, variants, canonicalSlug) {
  for (const variant of variants) {
    const variantSlug = `product/${slugify(variant)}`;
    if (variantSlug === canonicalSlug) continue;
    try {
      const dupe = await db('knowledge_entries')
        .where({ slug: variantSlug, category: 'product' })
        .first('id', 'slug');
      if (!dupe) continue;

      try {
        await db('knowledge_base')
          .where({ wiki_entry_id: dupe.id })
          .update({ wiki_entry_id: canonicalEntry.id });
      } catch { /* knowledge_base.wiki_entry_id column may not exist */ }

      await db('knowledge_entries').where({ id: dupe.id }).del();
      await logUpdate('merge', canonicalSlug, `Merged duplicate product page ${dupe.slug} into ${canonicalSlug}`, {
        triggerType: 'wiki_generation',
      });
      logger.info(`[agronomic-wiki] Merged duplicate product page ${dupe.slug} into ${canonicalSlug}`);
    } catch (err) {
      logger.error(`[agronomic-wiki] Failed to merge duplicate page ${variantSlug}: ${err.message}`);
    }
  }
}

function aggregateOutcomes(outcomes) {
  if (!outcomes.length) return { count: 0 };

  const avg = (arr) => {
    const valid = arr.filter((v) => v != null);
    return valid.length ? Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10 : null;
  };

  const deltas = {
    turf_density: outcomes.map((o) => o.delta_turf_density),
    weed_suppression: outcomes.map((o) => o.delta_weed_suppression),
    color_health: outcomes.map((o) => o.delta_color_health),
    fungus_control: outcomes.map((o) => o.delta_fungus_control),
    thatch_level: outcomes.map((o) => o.delta_thatch_level),
  };

  const seasons = {};
  const grassTypes = {};
  const tracks = {};
  for (const o of outcomes) {
    if (o.season) seasons[o.season] = (seasons[o.season] || 0) + 1;
    if (o.grass_type) grassTypes[o.grass_type] = (grassTypes[o.grass_type] || 0) + 1;
    if (o.grass_track) tracks[o.grass_track] = (tracks[o.grass_track] || 0) + 1;
  }

  return {
    count: outcomes.length,
    avgDelta: {
      turf_density: avg(deltas.turf_density),
      weed_suppression: avg(deltas.weed_suppression),
      color_health: avg(deltas.color_health),
      fungus_control: avg(deltas.fungus_control),
      thatch_level: avg(deltas.thatch_level),
    },
    avgDaysBetween: avg(outcomes.map((o) => o.days_between_assessments)),
    seasonDistribution: seasons,
    grassTypeDistribution: grassTypes,
    trackDistribution: tracks,
  };
}

module.exports = AgronomicWiki;

// Exposed for unit tests only.
module.exports.__private = {
  escapeLike,
  extractSummary,
  sameSourceIds,
  resolveCanonicalProduct,
  PRE_ASSESSMENT_MAX_AGE_DAYS,
  POST_ASSESSMENT_MAX_DAYS,
};
