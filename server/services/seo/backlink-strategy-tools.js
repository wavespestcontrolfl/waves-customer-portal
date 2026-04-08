/**
 * Backlink Strategy Agent — Tool Executor
 *
 * Maps each custom tool call to existing services.
 * No new business logic — just wiring.
 */

const db = require('../../models/db');
const logger = require('../logger');

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return null; }
}

async function executeBacklinkTool(toolName, input) {
  switch (toolName) {

    // ── Audit ───────────────────────────────────────────────────

    case 'get_backlink_dashboard': {
      const BacklinkMonitor = require('./backlink-monitor');
      return BacklinkMonitor.getDashboard();
    }

    case 'scan_backlinks': {
      const BacklinkMonitor = require('./backlink-monitor');
      return BacklinkMonitor.scan();
    }

    case 'get_signup_agent_stats': {
      const [total, pending, processing, completed, verified, failed, skipped] = await Promise.all([
        db('backlink_agent_queue').count('* as c').first(),
        db('backlink_agent_queue').where({ status: 'pending' }).count('* as c').first(),
        db('backlink_agent_queue').where({ status: 'processing' }).count('* as c').first(),
        db('backlink_agent_queue').where({ status: 'signup_complete' }).count('* as c').first(),
        db('backlink_agent_queue').where({ status: 'verified' }).count('* as c').first(),
        db('backlink_agent_queue').where({ status: 'failed' }).count('* as c').first(),
        db('backlink_agent_queue').where({ status: 'skipped' }).count('* as c').first(),
      ]);
      const profiles = await db('backlink_agent_profiles').count('* as c').first();
      const totalN = parseInt(total.c);

      return {
        total: totalN,
        pending: parseInt(pending.c),
        processing: parseInt(processing.c),
        completed: parseInt(completed.c),
        verified: parseInt(verified.c),
        failed: parseInt(failed.c),
        skipped: parseInt(skipped.c),
        profiles_created: parseInt(profiles.c),
        success_rate: totalN > 0 ? Math.round(((parseInt(completed.c) + parseInt(verified.c)) / totalN) * 100) : 0,
      };
    }

    case 'get_citation_dashboard': {
      const CitationAuditor = require('./citation-auditor');
      return CitationAuditor.getDashboard();
    }

    // ── Competitor analysis ─────────────────────────────────────

    case 'scan_competitor_gaps': {
      const BacklinkMonitor = require('./backlink-monitor');
      return BacklinkMonitor.scanCompetitorGaps(input.competitor_domain);
    }

    case 'get_competitor_gap_opportunities': {
      const minDR = input.min_domain_rating || 20;
      const limit = input.limit || 30;

      let query = db('seo_competitor_backlinks')
        .where('waves_has_link', false)
        .where('source_domain_rating', '>=', minDR)
        .orderBy('source_domain_rating', 'desc')
        .limit(limit);

      if (input.priority && input.priority !== 'all') {
        query = query.where('prospect_priority', input.priority);
      }

      const gaps = await query;

      return {
        total: gaps.length,
        opportunities: gaps.map(g => ({
          source_domain: g.source_domain,
          source_url: g.source_url,
          domain_rating: g.source_domain_rating,
          anchor_text: g.anchor_text,
          competitor_domain: g.competitor_domain,
          link_type: g.link_type,
          is_dofollow: g.is_dofollow,
          priority: g.prospect_priority,
        })),
      };
    }

    // ── Queue management ────────────────────────────────────────

    case 'add_targets_to_queue': {
      const urls = input.urls || [];
      const source = input.source || 'strategy_agent';
      let added = 0, skipped = 0;
      const duplicates = [];

      for (const rawUrl of urls) {
        const url = rawUrl.trim();
        if (!url) continue;
        const domain = extractDomain(url);
        if (!domain) { skipped++; continue; }

        const exists = await db('backlink_agent_queue').where({ domain }).first();
        if (exists) { duplicates.push(domain); skipped++; continue; }

        await db('backlink_agent_queue').insert({
          url, original_url: url, source, domain,
        });
        added++;
      }

      logger.info(`[backlink-strategy] Added ${added} targets, skipped ${skipped} (source: ${source})`);
      return { added, skipped, duplicates };
    }

    case 'get_queue_status': {
      const limit = input.limit || 30;
      let query = db('backlink_agent_queue')
        .orderBy('created_at', 'desc')
        .limit(limit);

      if (input.status) query = query.where({ status: input.status });

      const items = await query;

      // Also get aggregate counts
      const counts = await db('backlink_agent_queue')
        .select('status')
        .count('* as count')
        .groupBy('status');

      const statusMap = {};
      counts.forEach(c => { statusMap[c.status] = parseInt(c.count); });

      return {
        counts: statusMap,
        items: items.map(i => ({
          id: i.id,
          url: i.url,
          domain: i.domain,
          source: i.source,
          status: i.status,
          error: i.error_message,
          created: i.created_at,
        })),
      };
    }

    case 'get_completed_profiles': {
      const limit = input.limit || 50;
      const profiles = await db('backlink_agent_profiles')
        .leftJoin('backlink_agent_queue', 'backlink_agent_profiles.queue_id', 'backlink_agent_queue.id')
        .select(
          'backlink_agent_profiles.*',
          'backlink_agent_queue.domain',
          'backlink_agent_queue.status as queue_status',
          'backlink_agent_queue.source'
        )
        .orderBy('backlink_agent_profiles.created_at', 'desc')
        .limit(limit);

      return {
        total: profiles.length,
        profiles: profiles.map(p => ({
          site_url: p.site_url,
          domain: p.domain,
          profile_url: p.profile_url,
          backlink_url: p.backlink_url,
          backlink_status: p.backlink_status,
          is_dofollow: p.is_dofollow,
          domain_authority: p.domain_authority,
          source: p.source,
          queue_status: p.queue_status,
          created: p.created_at,
        })),
      };
    }

    // ── Search volume ───────────────────────────────────────────

    case 'check_search_volume': {
      const dataforseo = require('./dataforseo');
      const data = await dataforseo.searchVolume(input.keywords);
      if (!data?.tasks?.[0]?.result) return { error: 'DataForSEO unavailable' };

      const results = data.tasks[0].result;
      return {
        keywords: results.map(r => ({
          keyword: r.keyword,
          volume: r.search_volume,
          competition: r.competition,
          cpc: r.cpc,
        })),
      };
    }

    // ── LLM visibility ──────────────────────────────────────────

    case 'check_llm_mentions': {
      const BacklinkMonitor = require('./backlink-monitor');
      await BacklinkMonitor.checkLLMMentions();

      // Return recent results
      const recent = await db('seo_llm_mentions')
        .orderBy('check_date', 'desc')
        .limit(10);

      return {
        checks: recent.map(r => ({
          query: r.query,
          platform: r.llm_platform,
          waves_mentioned: r.waves_mentioned,
          competitors: typeof r.competitors_mentioned === 'string'
            ? JSON.parse(r.competitors_mentioned) : r.competitors_mentioned,
          date: r.check_date,
        })),
      };
    }

    // ── Report ──────────────────────────────────────────────────

    case 'save_strategy_report': {
      const [report] = await db('backlink_strategy_reports').insert({
        summary: input.summary,
        profile_health: input.profile_health,
        new_targets_added: input.new_targets_added || 0,
        competitor_gaps_found: input.competitor_gaps_found || 0,
        editorial_recommendations: input.editorial_recommendations,
        citation_issues: input.citation_issues,
        llm_visibility: input.llm_visibility,
        action_items: input.action_items,
        created_at: new Date(),
      }).returning('*');

      logger.info(`[backlink-strategy] Report saved: ${report.id}`);
      return { report_id: report.id, saved: true };
    }

    default:
      return { error: `Unknown backlink tool: ${toolName}` };
  }
}

module.exports = { executeBacklinkTool };
