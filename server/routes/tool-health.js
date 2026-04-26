/**
 * Tool Health API
 *
 * GET /api/admin/tool-health?hours=24
 *   Returns status summary, contexts breakdown, recent errors, and
 *   agent health cards — everything the Tool Health dashboard needs
 *   in one call so it renders in a single round trip.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate } = require('../middleware/admin-auth');

router.use(adminAuthenticate);

const AGENT_SOURCES = [
  { source: 'intelligence-bar', label: 'Admin Intelligence Bar', critical: true },
  { source: 'lead-response-agent', label: 'Lead Response Agent', critical: true },
  { source: 'tech-intelligence-bar', label: 'Tech Intelligence Bar', critical: false },
];

router.get('/', async (req, res, next) => {
  try {
    const hours = Math.min(parseInt(req.query.hours || '24', 10) || 24, 24 * 30);
    const since = new Date(Date.now() - hours * 3600 * 1000);

    const [summary, bySource, byContext, byTool, recentErrors] = await Promise.all([
      db('tool_health_events')
        .where('created_at', '>=', since)
        .select(
          db.raw('COUNT(*)::int as total'),
          db.raw('SUM(CASE WHEN success THEN 1 ELSE 0 END)::int as succeeded'),
          db.raw('SUM(CASE WHEN NOT success THEN 1 ELSE 0 END)::int as failed'),
          db.raw('SUM(CASE WHEN circuit_open THEN 1 ELSE 0 END)::int as circuit_open_count'),
          db.raw('AVG(duration_ms)::int as avg_duration_ms'),
        )
        .first(),

      db('tool_health_events')
        .where('created_at', '>=', since)
        .select('source')
        .count('* as total')
        .select(db.raw('SUM(CASE WHEN NOT success THEN 1 ELSE 0 END)::int as failed'))
        .avg('duration_ms as avg_duration_ms')
        .max('created_at as last_call_at')
        .groupBy('source'),

      db('tool_health_events')
        .where('created_at', '>=', since)
        .whereNotNull('context')
        .select('context')
        .count('* as total')
        .select(db.raw('SUM(CASE WHEN NOT success THEN 1 ELSE 0 END)::int as failed'))
        .countDistinct('tool_name as tools_used')
        .groupBy('context'),

      db('tool_health_events')
        .where('created_at', '>=', since)
        .select('context', 'tool_name', 'source')
        .count('* as total')
        .select(db.raw('SUM(CASE WHEN NOT success THEN 1 ELSE 0 END)::int as failed'))
        .avg('duration_ms as avg_duration_ms')
        .groupBy('context', 'tool_name', 'source'),

      db('tool_health_events')
        .where('created_at', '>=', since)
        .where('success', false)
        .orderBy('created_at', 'desc')
        .limit(30)
        .select('id', 'source', 'context', 'tool_name', 'circuit_open', 'error_message', 'created_at'),
    ]);

    // Normalize agent cards
    const sourceMap = new Map(bySource.map(r => [r.source, r]));
    const agents = AGENT_SOURCES.map(def => {
      const row = sourceMap.get(def.source);
      const total = parseInt(row?.total || 0);
      const failed = parseInt(row?.failed || 0);
      const errorRate = total > 0 ? failed / total : 0;
      let status = 'ok';
      if (total === 0) status = 'idle';
      else if (errorRate >= 0.2) status = 'critical';
      else if (errorRate >= 0.05) status = 'warning';
      return {
        source: def.source,
        label: def.label,
        critical: def.critical,
        total,
        failed,
        errorRate,
        status,
        avgDurationMs: row?.avg_duration_ms ? Math.round(parseFloat(row.avg_duration_ms)) : null,
        lastCallAt: row?.last_call_at || null,
      };
    });

    // Group tools by context for the dashboard sections
    const contextsMap = new Map();
    for (const row of byContext) {
      contextsMap.set(row.context, {
        context: row.context,
        total: parseInt(row.total),
        failed: parseInt(row.failed || 0),
        toolsUsed: parseInt(row.tools_used || 0),
        tools: [],
      });
    }
    for (const row of byTool) {
      const ctx = row.context || 'unknown';
      if (!contextsMap.has(ctx)) {
        contextsMap.set(ctx, { context: ctx, total: 0, failed: 0, toolsUsed: 0, tools: [] });
      }
      contextsMap.get(ctx).tools.push({
        toolName: row.tool_name,
        source: row.source,
        total: parseInt(row.total),
        failed: parseInt(row.failed || 0),
        errorRate: parseInt(row.total) > 0 ? parseInt(row.failed || 0) / parseInt(row.total) : 0,
        avgDurationMs: row.avg_duration_ms ? Math.round(parseFloat(row.avg_duration_ms)) : null,
      });
    }
    const contexts = Array.from(contextsMap.values())
      .map(c => ({ ...c, errorRate: c.total > 0 ? c.failed / c.total : 0 }))
      .sort((a, b) => b.failed - a.failed || b.total - a.total);

    const totalCalls = parseInt(summary?.total || 0);
    const totalFailed = parseInt(summary?.failed || 0);
    const overallErrorRate = totalCalls > 0 ? totalFailed / totalCalls : 0;

    let overallStatus = 'ok';
    if (totalCalls === 0) overallStatus = 'idle';
    else if (overallErrorRate >= 0.2 || (summary?.circuit_open_count || 0) > 0) overallStatus = 'critical';
    else if (overallErrorRate >= 0.05) overallStatus = 'warning';

    // Alerts: circuit-open, tools with >20% error and >=5 calls
    const alerts = [];
    if ((summary?.circuit_open_count || 0) > 0) {
      alerts.push({
        severity: 'critical',
        title: 'Circuit breaker tripped',
        detail: `${summary.circuit_open_count} tool calls short-circuited in the last ${hours}h. Check error log below.`,
      });
    }
    for (const ctx of contexts) {
      for (const tool of ctx.tools) {
        if (tool.total >= 5 && tool.errorRate >= 0.2) {
          alerts.push({
            severity: tool.errorRate >= 0.5 ? 'critical' : 'warning',
            title: `${tool.toolName} failing`,
            detail: `${tool.failed}/${tool.total} calls failed (${Math.round(tool.errorRate * 100)}%) in ${ctx.context}.`,
          });
        }
      }
    }

    res.json({
      windowHours: hours,
      generatedAt: new Date().toISOString(),
      overallStatus,
      summary: {
        total: totalCalls,
        succeeded: parseInt(summary?.succeeded || 0),
        failed: totalFailed,
        errorRate: overallErrorRate,
        avgDurationMs: summary?.avg_duration_ms ? Math.round(parseFloat(summary.avg_duration_ms)) : null,
        circuitOpenCount: parseInt(summary?.circuit_open_count || 0),
      },
      agents,
      contexts,
      recentErrors: recentErrors.map(e => ({
        id: e.id,
        source: e.source,
        context: e.context,
        toolName: e.tool_name,
        circuitOpen: e.circuit_open,
        errorMessage: e.error_message,
        at: e.created_at,
      })),
      alerts,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
