const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const crypto = require('crypto');
const { normalizeUrl, extractDomain, urlLookupVariants } = require('../../utils/normalize-url');
const { etDateString, addETDays } = require('../../utils/datetime-et');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const DIAGNOSIS_ACTION_MAP = {
  indexation_problem: { action: 'submit_indexnow', tier: 'auto', effort: 1 },
  canonical_problem: { action: 'fix_canonical', tier: 'seo', effort: 3 },
  duplicate_content: { action: 'differentiate_spoke', tier: 'seo', effort: 5 },
  technical_performance: { action: 'fix_cwv_template', tier: 'editor', effort: 3 },
  cannibalization: { action: 'differentiate_spoke', tier: 'editor', effort: 5 },
  ranking_decay: { action: 'refresh_content', tier: 'editor', effort: 5 },
  ctr_problem: { action: 'rewrite_title_meta', tier: 'editor', effort: 1 },
  thin_local_proof: { action: 'expand_local_proof', tier: 'editor', effort: 5 },
  structured_data: { action: 'add_schema', tier: 'auto', effort: 2 },
  internal_linking: { action: 'add_internal_links', tier: 'auto', effort: 1 },
  freshness: { action: 'refresh_content', tier: 'editor', effort: 5 },
  low_value: { action: 'noindex_page', tier: 'seo', effort: 2 },
};

const SCORING_WEIGHTS = {
  missing_service_area_page: 100,
  striking_distance_top_5_to_top_3: 85,
  striking_distance_page_2_to_page_1: 70,
  cannibalization_between_spokes: 60,
  intent_mismatch: 50,
  thin_content_vs_competitor: 35,
  schema_missing_or_invalid: 25,
  internal_link_gap: 20,
  title_meta_below_competitor: 15,
};

function buildActionDedupeKey(actionType, url) {
  const normalizedUrl = normalizeUrl(url);
  const digest = crypto.createHash('sha256').update(normalizedUrl).digest('hex');
  return `${String(actionType || '').slice(0, 60)}:${digest}`;
}

class SeoActionGenerator {
  async generateActionsFromDiagnosis(domain) {
    const d = extractDomain(domain) || 'wavespestcontrol.com';
    const batchId = db.raw('gen_random_uuid()');
    const batchLabel = `${etDateString()} pipeline run`;

    const urls = await db('seo_url_intelligence')
      .where('domain', d)
      .whereNot('primary_diagnosis', 'healthy')
      .whereNot('primary_diagnosis', 'unknown')
      .where('priority_score', '>', 10)
      .orderBy('priority_score', 'desc');

    let created = 0;
    let skipped = 0;

    for (const row of urls) {
      const mapping = DIAGNOSIS_ACTION_MAP[row.primary_diagnosis];
      if (!mapping) continue;

      const dedupeKey = buildActionDedupeKey(mapping.action, row.url);

      const impactScore = (SCORING_WEIGHTS[row.primary_diagnosis] || 30) *
        (row.priority_score / 100);

      const [inserted] = await db('seo_actions').insert({
        url_intelligence_id: row.id,
        url: row.url,
        domain: row.domain,
        city: row.city,
        service: row.service,
        issue_type: row.primary_diagnosis,
        action_type: mapping.action,
        summary: row.recommended_action,
        detail: JSON.stringify({
          current_title: row.title,
          current_meta: row.meta_description,
          current_h1: row.h1,
          gsc_clicks_28d: row.gsc_clicks_28d,
          gsc_impressions_28d: row.gsc_impressions_28d,
          gsc_position: row.gsc_avg_position_28d,
        }),
        priority_score: row.priority_score,
        impact_score: impactScore,
        effort_score: mapping.effort,
        approval_tier: mapping.tier,
        batch_id: batchId,
        batch_label: batchLabel,
        dedupe_key: dedupeKey,
      }).onConflict('dedupe_key').ignore().returning('id');

      if (inserted?.id) created++;
      else skipped++;
    }

    logger.info(`[SeoActionGenerator] ${d}: ${created} actions created, ${skipped} skipped (dedup)`);
    return { domain: d, actions_created: created, actions_skipped_dedup: skipped };
  }

  async autoApprove(domain = null) {
    const d = domain ? extractDomain(domain) : null;
    if (!d) return { error: 'domain is required for auto-approve', auto_approved: 0 };
    let query = db('seo_actions')
      .where('status', 'open')
      .where('approval_tier', 'auto')
      .where('approval_status', 'pending');
    if (d) query = query.where('domain', d);

    const updated = await query.update({
      approval_status: 'approved',
      approved_at: db.fn.now(),
      executor: 'system',
    });

    logger.info(`[SeoActionGenerator] Auto-approved ${updated} actions${d ? ` for ${d}` : ''}`);
    return { domain: d || 'all', auto_approved: updated };
  }

  async autoExecute(domain = null) {
    const d = domain ? extractDomain(domain) : null;
    if (!d) return { error: 'domain is required for auto-execute', auto_executed: 0, manual_required: 0, failed: 0 };
    let query = db('seo_actions')
      .where('approval_status', 'approved')
      .where('execution_status', 'queued')
      .where('approval_tier', 'auto')
      .where('status', 'open');
    if (d) query = query.where('domain', d);

    const actions = await query;

    let executed = 0;
    let skipped = 0;
    let failed = 0;
    for (const action of actions) {
      try {
        let notes = '';
        let done = false;

        if (action.action_type === 'submit_indexnow') {
          const IndexNow = require('./indexnow-submit');
          const result = await IndexNow.submit(action.url);
          if (!result?.ok) {
            const reason = result?.error || result?.status || 'IndexNow submission failed';
            await db('seo_actions').where('id', action.id).update({
              execution_status: 'failed',
              started_at: db.fn.now(),
              completed_at: db.fn.now(),
              execution_notes: `IndexNow failed: ${reason}`,
            });
            failed++;
            continue;
          }
          notes = result.throttled ? 'IndexNow submission skipped: recently submitted' : 'IndexNow submission sent';
          done = true;
        } else if (action.action_type === 'add_schema') {
          notes = 'Schema template changes require spoke repo deploy';
        } else if (action.action_type === 'add_internal_links') {
          notes = 'Internal link suggestions logged in seo_internal_link_graph';
        } else {
          notes = `Auto-execution not supported for ${action.action_type}`;
        }

        if (!done) {
          await db('seo_actions').where('id', action.id).update({
            execution_status: 'manual_required',
            execution_notes: notes,
          });
          skipped++;
          continue;
        }

        await db('seo_actions').where('id', action.id).update({
          execution_status: 'done',
          started_at: db.fn.now(),
          completed_at: db.fn.now(),
          execution_notes: notes,
        });

        await this.createExperiment(action);
        executed++;
      } catch (err) {
        await db('seo_actions').where('id', action.id).update({
          execution_status: 'failed',
          execution_notes: err.message,
        });
        failed++;
      }
    }

    logger.info(`[SeoActionGenerator] Auto-executed ${executed} actions${d ? ` for ${d}` : ''}`);
    return { domain: d || 'all', auto_executed: executed, manual_required: skipped, failed };
  }

  async generateAIDrafts(actionIds) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return { error: 'Anthropic API not configured', drafts_generated: 0 };
    }

    let query = db('seo_actions')
      .where('action_type', 'rewrite_title_meta')
      .where('status', 'open')
      .whereNull('ai_draft');

    if (actionIds && actionIds.length > 0) {
      query = query.whereIn('id', actionIds);
    } else {
      query = query.limit(10);
    }

    const actions = await query;
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let generated = 0;

    for (const action of actions) {
      try {
        let detail = {};
        try { detail = typeof action.detail === 'string' ? JSON.parse(action.detail) : (action.detail || {}); } catch {}

        // Fetch top queries for this URL
        const topQueries = await db('gsc_query_page_map')
          .whereIn('page_url', urlLookupVariants(action.url))
          .select('query')
          .sum('impressions as impressions')
          .sum('clicks as clicks')
          .groupBy('query')
          .orderBy('impressions', 'desc')
          .limit(10);

        const queryList = topQueries.map((q) => `"${q.query}" (${q.impressions} impr, ${q.clicks} clicks)`).join('\n');

        const response = await anthropic.messages.create({
          model: MODELS.FLAGSHIP,
          max_tokens: 1000,
          system: `You are an SEO specialist for Waves Pest Control, a local pest control company in Southwest Florida (Manatee/Sarasota/Charlotte counties). Write optimized title tags (50-60 chars) and meta descriptions (140-155 chars) that improve CTR for local service queries. Include the target city and service. Use action-oriented language. Never mention prices.`,
          messages: [{
            role: 'user',
            content: `Rewrite the title and meta description for this page:

URL: ${action.url}
Current title: ${detail.current_title || 'none'}
Current meta: ${detail.current_meta || 'none'}
City: ${action.city || 'unknown'}
Service: ${action.service || 'pest control'}
Current position: ${detail.gsc_position || 'unknown'}

Top ranking queries:
${queryList || 'No query data available'}

Return JSON: { "title": "...", "meta_description": "...", "reasoning": "..." }`,
          }],
        });

        const text = response.content[0]?.text || '';
        let draft;
        try {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          draft = jsonMatch ? JSON.parse(jsonMatch[0]) : { title: text, meta_description: '', reasoning: '' };
        } catch {
          draft = { title: text.substring(0, 60), meta_description: '', reasoning: 'Failed to parse JSON response' };
        }

        await db('seo_actions').where('id', action.id).update({
          ai_draft: JSON.stringify(draft),
          ai_model: MODELS.FLAGSHIP,
        });
        generated++;
      } catch (err) {
        logger.warn(`[SeoActionGenerator] AI draft failed for ${action.url}: ${err.message}`);
      }
    }

    logger.info(`[SeoActionGenerator] Generated ${generated} AI drafts`);
    return { drafts_generated: generated };
  }

  async createExperiment(action) {
    const d28ago = etDateString(addETDays(new Date(), -28));

    const gsc = await db('gsc_pages')
      .whereIn('page_url', urlLookupVariants(action.url))
      .where('date', '>=', d28ago)
      .select(
        db.raw('SUM(clicks) as clicks'),
        db.raw('SUM(impressions) as impressions'),
        db.raw('AVG(ctr) as ctr'),
        db.raw('AVG(position) as position'),
      )
      .first();

    const [experiment] = await db('seo_url_experiments').insert({
      url: action.url,
      action_type: action.action_type,
      publish_date: etDateString(),
      target_query_cluster: action.city && action.service
        ? `${action.service} ${action.city}`
        : null,
      pre_28d_clicks: parseInt(gsc?.clicks) || 0,
      pre_28d_impressions: parseInt(gsc?.impressions) || 0,
      pre_28d_ctr: gsc?.ctr ? parseFloat(gsc.ctr) : null,
      pre_28d_position: gsc?.position ? parseFloat(gsc.position) : null,
      status: 'running',
    }).returning('id');

    if (experiment?.id) {
      await db('seo_actions').where('id', action.id).update({ experiment_id: experiment.id });
    }

    return experiment;
  }

  async measureExperiments() {
    const cutoff = etDateString(addETDays(new Date(), -35));
    const experiments = await db('seo_url_experiments')
      .where('status', 'running')
      .where('publish_date', '<=', cutoff);

    let measured = 0;
    for (const exp of experiments) {
      try {
        const d28ago = etDateString(addETDays(new Date(), -28));

        const gsc = await db('gsc_pages')
          .whereIn('page_url', urlLookupVariants(exp.url))
          .where('date', '>=', d28ago)
          .select(
            db.raw('SUM(clicks) as clicks'),
            db.raw('SUM(impressions) as impressions'),
            db.raw('AVG(ctr) as ctr'),
            db.raw('AVG(position) as position'),
          )
          .first();

        const postClicks = parseInt(gsc?.clicks) || 0;
        const postImpressions = parseInt(gsc?.impressions) || 0;
        const postCtr = gsc?.ctr ? parseFloat(gsc.ctr) : null;
        const postPosition = gsc?.position ? parseFloat(gsc.position) : null;

        const preClicks = exp.pre_28d_clicks || 0;
        const clicksDelta = preClicks > 0 ? (postClicks - preClicks) / preClicks : 0;
        const prePos = exp.pre_28d_position ? parseFloat(exp.pre_28d_position) : null;
        const posImproved = prePos && postPosition ? postPosition < prePos - 0.5 : false;

        let status = 'accepted';
        if (clicksDelta < -0.1 || (prePos && postPosition && postPosition > prePos + 1.0)) {
          status = 'rejected';
        }

        await db('seo_url_experiments').where('id', exp.id).update({
          post_28d_clicks: postClicks,
          post_28d_impressions: postImpressions,
          post_28d_ctr: postCtr,
          post_28d_position: postPosition,
          status,
        });
        measured++;
      } catch (err) {
        logger.warn(`[SeoActionGenerator] Experiment measurement failed for ${exp.url}: ${err.message}`);
      }
    }

    logger.info(`[SeoActionGenerator] Measured ${measured} experiments`);
    return { experiments_measured: measured };
  }

  async getSummary(domain) {
    const d = domain ? extractDomain(domain) : null;
    let base = db('seo_actions').where('status', 'open');
    if (d) base = base.where('domain', d);

    const byTier = await base.clone()
      .where('approval_status', 'pending')
      .select('approval_tier')
      .count('id as count')
      .groupBy('approval_tier');

    const inProgress = await base.clone()
      .where('execution_status', 'in_progress')
      .count('id as count')
      .first();

    const done = await base.clone()
      .where('execution_status', 'done')
      .count('id as count')
      .first();

    const experiments = await db('seo_url_experiments')
      .select('status')
      .count('id as count')
      .groupBy('status');

    return {
      pending_by_tier: Object.fromEntries(byTier.map((r) => [r.approval_tier, parseInt(r.count)])),
      in_progress: parseInt(inProgress?.count) || 0,
      done: parseInt(done?.count) || 0,
      experiments: Object.fromEntries(experiments.map((r) => [r.status, parseInt(r.count)])),
    };
  }
}

const generator = new SeoActionGenerator();
generator._internals = { buildActionDedupeKey };

module.exports = generator;
