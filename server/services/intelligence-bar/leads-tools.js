/**
 * Intelligence Bar — Leads Pipeline Tools
 * server/services/intelligence-bar/leads-tools.js
 *
 * Tools for lead pipeline management. Virginia's daily driver alongside Comms.
 * Covers the full funnel: new → contacted → estimate_sent → won/lost,
 * plus source attribution, response time tracking, and bulk status updates.
 */

const db = require('../../models/db');
const logger = require('../logger');

const ACTIVE_STATUSES = ['new', 'contacted', 'estimate_sent', 'estimate_viewed', 'negotiating'];
const CLOSED_STATUSES = ['won', 'lost', 'disqualified', 'duplicate', 'unresponsive'];

const LEADS_TOOLS = [
  {
    name: 'get_lead_overview',
    description: `Get lead pipeline overview: total leads, active/won/lost counts, conversion rate, avg response time, cost per acquisition, ROI.
Use for: "how's the pipeline?", "lead conversion rate this month?", "how many active leads?"`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback period in days (default 30)' },
      },
    },
  },
  {
    name: 'query_leads',
    description: `Search and filter leads by status, source, name, phone, service interest, or date range.
Use for: "show me all new leads", "leads from Google Ads", "find the Henderson lead", "unresponsive leads older than 2 weeks"`,
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['new', 'contacted', 'estimate_sent', 'estimate_viewed', 'negotiating', 'won', 'lost', 'unresponsive', 'disqualified', 'duplicate'] },
        source: { type: 'string', description: 'Lead source name (e.g. Google Ads, Referral, Door Knock)' },
        search: { type: 'string', description: 'Search name, phone, email, address, or service interest' },
        days_back: { type: 'number', description: 'Only leads from last N days' },
        sort: { type: 'string', enum: ['newest', 'oldest', 'value', 'response_time'], description: 'Default: newest' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_stale_leads',
    description: `Find leads that haven't been contacted or followed up on in a given time window. These are leads going cold and need immediate attention.
Use for: "which leads haven't been contacted in 48 hours?", "stale leads", "leads going cold", "who needs a follow-up?"`,
    input_schema: {
      type: 'object',
      properties: {
        hours_threshold: { type: 'number', description: 'Consider stale after this many hours with no activity (default 48)' },
        status: { type: 'string', description: 'Filter by status (default: active statuses only)' },
      },
    },
  },
  {
    name: 'get_lead_funnel',
    description: `Get the lead funnel: count at each pipeline stage and conversion rates between stages.
Use for: "show me the funnel", "where are leads getting stuck?", "stage conversion rates"`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback period (default 30)' },
      },
    },
  },
  {
    name: 'get_source_performance',
    description: `Compare lead source performance: leads generated, conversion rate, cost, CPA, ROI for each source.
Use for: "which source converts best?", "Google Ads ROI?", "compare referrals vs paid leads", "cost per acquisition by source"`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback period (default 30)' },
      },
    },
  },
  {
    name: 'get_lost_analysis',
    description: `Analyze why leads are being lost: breakdown by reason, competitor mentions, patterns.
Use for: "why are we losing leads?", "top lost reasons", "are we losing to competitors or price?"`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback period (default 90)' },
      },
    },
  },
  {
    name: 'get_response_times',
    description: `Analyze lead response times: distribution by time bucket (<5min, 5-15min, 15-60min, 1-4hr, 4-24hr, 24hr+), and how response time correlates with conversion.
Use for: "how fast are we responding to leads?", "response time breakdown", "does faster response = more conversions?"`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number' },
      },
    },
  },
  {
    name: 'update_lead_status',
    description: `Update the status of a single lead. ALWAYS confirm with the operator before executing.
Use for: "move Henderson to contacted", "mark the Smith lead as lost — chose competitor", "mark lead #42 as won"`,
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        lead_name: { type: 'string', description: 'Find lead by name (partial match)' },
        new_status: { type: 'string', enum: ['new', 'contacted', 'estimate_sent', 'estimate_viewed', 'negotiating', 'won', 'lost', 'unresponsive', 'disqualified', 'duplicate'] },
        lost_reason: { type: 'string', description: 'Required when marking as lost' },
        notes: { type: 'string' },
      },
      required: ['new_status'],
    },
  },
  {
    name: 'bulk_update_leads',
    description: `Bulk-update lead statuses matching criteria. ALWAYS show what will be affected and confirm before executing.
Use for: "move all unresponsive leads older than 30 days to lost", "mark all no-response leads as unresponsive"`,
    input_schema: {
      type: 'object',
      properties: {
        current_status: { type: 'string', description: 'Only update leads with this status' },
        older_than_days: { type: 'number', description: 'Only leads older than N days' },
        new_status: { type: 'string', enum: ['contacted', 'unresponsive', 'lost', 'disqualified'] },
        lost_reason: { type: 'string' },
        dry_run: { type: 'boolean', description: 'If true, just count matches without updating. Default true.' },
      },
      required: ['current_status', 'new_status'],
    },
  },
];


// ─── EXECUTION ──────────────────────────────────────────────────

async function executeLeadsTool(toolName, input) {
  try {
    switch (toolName) {
      case 'get_lead_overview': return await getLeadOverview(input.days || 30);
      case 'query_leads': return await queryLeads(input);
      case 'get_stale_leads': return await getStaleLeads(input);
      case 'get_lead_funnel': return await getLeadFunnel(input.days || 30);
      case 'get_source_performance': return await getSourcePerformance(input.days || 30);
      case 'get_lost_analysis': return await getLostAnalysis(input.days || 90);
      case 'get_response_times': return await getResponseTimes(input.days || 30);
      case 'update_lead_status': return await updateLeadStatus(input);
      case 'bulk_update_leads': return await bulkUpdateLeads(input);
      default: return { error: `Unknown leads tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:leads] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}


// ─── IMPLEMENTATIONS ────────────────────────────────────────────

async function getLeadOverview(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const leads = await db('leads').where('first_contact_at', '>=', since);
  const total = leads.length;
  const won = leads.filter(l => l.status === 'won').length;
  const lost = leads.filter(l => l.status === 'lost').length;
  const active = leads.filter(l => ACTIVE_STATUSES.includes(l.status)).length;
  const unresponsive = leads.filter(l => l.status === 'unresponsive').length;

  const responded = leads.filter(l => l.response_time_minutes != null);
  const avgResponseMinutes = responded.length > 0
    ? Math.round(responded.reduce((s, l) => s + l.response_time_minutes, 0) / responded.length)
    : null;

  // Revenue from won leads
  const revenue = leads.filter(l => l.status === 'won')
    .reduce((s, l) => s + parseFloat(l.initial_service_value || 0) + parseFloat(l.monthly_value || 0) * 12, 0);

  // Cost data
  const costs = await db('lead_source_costs').where('month', '>=', since).sum('cost_amount as total').first().catch(() => ({ total: 0 }));
  const totalCost = parseFloat(costs?.total || 0);

  return {
    period_days: days,
    total_leads: total,
    active,
    won,
    lost,
    unresponsive,
    conversion_rate: total > 0 ? Math.round(won / total * 1000) / 10 : 0,
    avg_response_minutes: avgResponseMinutes,
    total_cost: Math.round(totalCost),
    cpa: won > 0 ? Math.round(totalCost / won) : null,
    estimated_annual_revenue: Math.round(revenue),
    roi: totalCost > 0 ? Math.round((revenue - totalCost) / totalCost * 100) : null,
  };
}


async function queryLeads(input) {
  const { status, source, search, days_back, sort = 'newest', limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 20, 100);

  let query = db('leads')
    .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
    .leftJoin('technicians', 'leads.assigned_to', 'technicians.id')
    .select(
      'leads.*', 'lead_sources.name as source_name', 'lead_sources.channel',
      'technicians.name as assigned_name',
    );

  if (status) query = query.where('leads.status', status);
  if (source) query = query.whereILike('lead_sources.name', `%${source}%`);
  if (days_back) query = query.where('leads.first_contact_at', '>=', new Date(Date.now() - days_back * 86400000).toISOString());
  if (search) {
    const s = `%${search}%`;
    query = query.where(function () {
      this.whereILike('leads.first_name', s).orWhereILike('leads.last_name', s)
        .orWhereILike('leads.phone', s).orWhereILike('leads.email', s)
        .orWhereILike('leads.service_interest', s).orWhereILike('leads.address', s);
    });
  }

  const sortMap = {
    newest: ['leads.first_contact_at', 'desc'],
    oldest: ['leads.first_contact_at', 'asc'],
    value: ['leads.monthly_value', 'desc'],
    response_time: ['leads.response_time_minutes', 'asc'],
  };
  const [col, dir] = sortMap[sort] || sortMap.newest;
  query = query.orderBy(col, dir);

  const leads = await query.limit(limit);

  return {
    leads: leads.map(l => ({
      id: l.id,
      name: `${l.first_name} ${l.last_name || ''}`.trim(),
      phone: l.phone, email: l.email,
      status: l.status, source: l.source_name, channel: l.channel,
      service_interest: l.service_interest, urgency: l.urgency,
      assigned_to: l.assigned_name,
      city: l.city, address: l.address,
      monthly_value: l.monthly_value ? parseFloat(l.monthly_value) : null,
      response_time_min: l.response_time_minutes,
      first_contact: l.first_contact_at,
      last_activity: l.updated_at,
      notes: l.notes,
    })),
    total: leads.length,
  };
}


async function getStaleLeads(input) {
  const { hours_threshold = 48, status } = input;
  const cutoff = new Date(Date.now() - hours_threshold * 3600000).toISOString();

  let query = db('leads')
    .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
    .select('leads.*', 'lead_sources.name as source_name')
    .where('leads.updated_at', '<', cutoff);

  if (status) {
    query = query.where('leads.status', status);
  } else {
    query = query.whereIn('leads.status', ACTIVE_STATUSES);
  }

  const leads = await query.orderBy('leads.updated_at', 'asc').limit(30);

  return {
    stale_leads: leads.map(l => ({
      id: l.id,
      name: `${l.first_name} ${l.last_name || ''}`.trim(),
      phone: l.phone,
      status: l.status,
      source: l.source_name,
      service_interest: l.service_interest,
      hours_since_activity: Math.round((Date.now() - new Date(l.updated_at)) / 3600000),
      first_contact: l.first_contact_at,
      monthly_value: l.monthly_value ? parseFloat(l.monthly_value) : null,
    })),
    total: leads.length,
    threshold_hours: hours_threshold,
    note: leads.length > 0 ? `${leads.length} leads with no activity in ${hours_threshold}+ hours` : 'No stale leads — pipeline is fresh.',
  };
}


async function getLeadFunnel(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const stages = await db('leads').where('first_contact_at', '>=', since)
    .select('status', db.raw('COUNT(*) as count'))
    .groupBy('status').orderByRaw('COUNT(*) DESC');

  const countMap = {};
  stages.forEach(s => { countMap[s.status] = parseInt(s.count); });

  const funnelOrder = ['new', 'contacted', 'estimate_sent', 'estimate_viewed', 'negotiating', 'won'];
  const funnel = funnelOrder.map((stage, i) => {
    const count = countMap[stage] || 0;
    const prevCount = i > 0 ? (countMap[funnelOrder[i - 1]] || 0) : count;
    return {
      stage,
      count,
      conversion_from_prev: i > 0 && prevCount > 0 ? Math.round(count / prevCount * 100) : null,
    };
  });

  const total = Object.values(countMap).reduce((s, c) => s + c, 0);

  return {
    period_days: days,
    funnel,
    total_leads: total,
    lost: countMap.lost || 0,
    unresponsive: countMap.unresponsive || 0,
    disqualified: countMap.disqualified || 0,
    bottleneck: funnel.slice(1).reduce((worst, s) =>
      s.conversion_from_prev !== null && (worst === null || s.conversion_from_prev < worst.conversion_from_prev) ? s : worst, null),
  };
}


async function getSourcePerformance(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const sources = await db('leads')
    .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
    .where('leads.first_contact_at', '>=', since)
    .select(
      'lead_sources.name as source',
      'lead_sources.channel',
      db.raw('COUNT(*) as total'),
      db.raw("COUNT(*) FILTER (WHERE leads.status = 'won') as won"),
      db.raw("COUNT(*) FILTER (WHERE leads.status = 'lost') as lost"),
      db.raw('AVG(leads.response_time_minutes) as avg_response'),
      db.raw("SUM(CASE WHEN leads.status = 'won' THEN COALESCE(leads.monthly_value, 0) * 12 + COALESCE(leads.initial_service_value, 0) ELSE 0 END) as revenue"),
    )
    .groupBy('lead_sources.name', 'lead_sources.channel')
    .orderByRaw('COUNT(*) DESC');

  // Get costs per source
  const costs = await db('lead_sources').where('is_active', true)
    .select('name', 'monthly_cost').catch(() => []);
  const costMap = {};
  costs.forEach(c => { costMap[c.name] = parseFloat(c.monthly_cost || 0); });

  const months = Math.max(1, days / 30);

  return {
    period_days: days,
    sources: sources.map(s => {
      const totalLeads = parseInt(s.total);
      const won = parseInt(s.won);
      const cost = (costMap[s.source] || 0) * months;
      const revenue = parseFloat(s.revenue || 0);
      return {
        source: s.source || 'Unknown',
        channel: s.channel,
        total_leads: totalLeads,
        won,
        lost: parseInt(s.lost),
        conversion_rate: totalLeads > 0 ? Math.round(won / totalLeads * 100) : 0,
        avg_response_min: s.avg_response ? Math.round(parseFloat(s.avg_response)) : null,
        estimated_cost: Math.round(cost),
        estimated_revenue: Math.round(revenue),
        cpa: won > 0 ? Math.round(cost / won) : null,
        roi: cost > 0 ? Math.round((revenue - cost) / cost * 100) : null,
      };
    }),
  };
}


async function getLostAnalysis(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const reasons = await db('leads')
    .where('status', 'lost')
    .where('first_contact_at', '>=', since)
    .select('lost_reason', db.raw('COUNT(*) as count'), db.raw("string_agg(DISTINCT competitor, ', ') as competitors"))
    .groupBy('lost_reason').orderByRaw('COUNT(*) DESC');

  const totalLost = reasons.reduce((s, r) => s + parseInt(r.count), 0);

  // Fixable vs unfixable
  const fixable = ['price', 'no_response', 'not_ready'];
  const fixableCount = reasons.filter(r => fixable.includes(r.lost_reason)).reduce((s, r) => s + parseInt(r.count), 0);

  return {
    period_days: days,
    total_lost: totalLost,
    reasons: reasons.map(r => ({
      reason: r.lost_reason || 'unknown',
      count: parseInt(r.count),
      pct: totalLost > 0 ? Math.round(parseInt(r.count) / totalLost * 100) : 0,
      competitors: r.competitors || null,
    })),
    fixable_losses: fixableCount,
    fixable_pct: totalLost > 0 ? Math.round(fixableCount / totalLost * 100) : 0,
    insight: fixableCount > totalLost / 2
      ? `${fixableCount} of ${totalLost} lost leads (${Math.round(fixableCount / totalLost * 100)}%) are fixable — price objections, no follow-up, or timing. Focus on faster follow-up and flexible pricing.`
      : 'Most lost leads are external factors (competitor, DIY, out of area). Pipeline process is solid.',
  };
}


async function getResponseTimes(days) {
  const since = new Date(Date.now() - (days || 30) * 86400000).toISOString();

  const leads = await db('leads')
    .where('first_contact_at', '>=', since)
    .whereNotNull('response_time_minutes')
    .select('response_time_minutes', 'status');

  const buckets = [
    { label: 'Under 5 min', max: 5, count: 0, won: 0 },
    { label: '5-15 min', max: 15, count: 0, won: 0 },
    { label: '15-60 min', max: 60, count: 0, won: 0 },
    { label: '1-4 hours', max: 240, count: 0, won: 0 },
    { label: '4-24 hours', max: 1440, count: 0, won: 0 },
    { label: '24+ hours', max: Infinity, count: 0, won: 0 },
  ];

  leads.forEach(l => {
    const min = l.response_time_minutes;
    for (const bucket of buckets) {
      if (min <= bucket.max) {
        bucket.count++;
        if (l.status === 'won') bucket.won++;
        break;
      }
    }
  });

  return {
    period_days: days,
    total_with_response: leads.length,
    buckets: buckets.map(b => ({
      label: b.label,
      count: b.count,
      conversion_rate: b.count > 0 ? Math.round(b.won / b.count * 100) : 0,
    })),
    avg_minutes: leads.length > 0 ? Math.round(leads.reduce((s, l) => s + l.response_time_minutes, 0) / leads.length) : null,
    median_minutes: leads.length > 0 ? leads.sort((a, b) => a.response_time_minutes - b.response_time_minutes)[Math.floor(leads.length / 2)].response_time_minutes : null,
  };
}


async function updateLeadStatus(input) {
  const { lead_id, lead_name, new_status, lost_reason, notes } = input;

  let lead;
  if (lead_id) {
    lead = await db('leads').where('id', lead_id).first();
  } else if (lead_name) {
    lead = await db('leads').where(function () {
      const s = `%${lead_name}%`;
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereRaw("first_name || ' ' || last_name ILIKE ?", [s]);
    }).whereIn('status', ACTIVE_STATUSES).first();
  }
  if (!lead) return { error: 'Lead not found' };

  const oldStatus = lead.status;
  const updates = { status: new_status, updated_at: new Date() };
  if (lost_reason) updates.lost_reason = lost_reason;
  if (notes) updates.notes = db.raw("COALESCE(notes, '') || '\n' || ?", [notes]);

  await db('leads').where('id', lead.id).update(updates);

  await db('lead_activities').insert({
    lead_id: lead.id,
    activity_type: 'status_change',
    description: `Status: ${oldStatus} → ${new_status}${lost_reason ? ` (${lost_reason})` : ''}`,
    performed_by: 'Intelligence Bar',
  });

  logger.info(`[intelligence-bar:leads] Updated lead ${lead.id} ${lead.first_name} ${lead.last_name}: ${oldStatus} → ${new_status}`);

  return {
    success: true,
    lead: `${lead.first_name} ${lead.last_name || ''}`.trim(),
    old_status: oldStatus,
    new_status,
    lost_reason: lost_reason || null,
  };
}


async function bulkUpdateLeads(input) {
  const { current_status, older_than_days, new_status, lost_reason, dry_run = true } = input;
  const cutoff = older_than_days ? new Date(Date.now() - older_than_days * 86400000).toISOString() : null;

  let query = db('leads').where('status', current_status);
  if (cutoff) query = query.where('updated_at', '<', cutoff);

  const matching = await query.clone().select('id', 'first_name', 'last_name', 'status', 'updated_at');

  if (dry_run) {
    return {
      dry_run: true,
      matches: matching.length,
      preview: matching.slice(0, 10).map(l => ({
        name: `${l.first_name} ${l.last_name || ''}`.trim(),
        current_status: l.status,
        last_activity: l.updated_at,
      })),
      action: `Would move ${matching.length} leads from "${current_status}" to "${new_status}"${older_than_days ? ` (older than ${older_than_days} days)` : ''}`,
      note: 'This is a preview. Say "do it" or "execute" to apply the changes.',
    };
  }

  // Execute bulk update
  const ids = matching.map(l => l.id);
  if (ids.length === 0) return { success: true, updated: 0, note: 'No matching leads found' };

  const updates = { status: new_status, updated_at: new Date() };
  if (lost_reason) updates.lost_reason = lost_reason;

  await db('leads').whereIn('id', ids).update(updates);

  // Log activity for each
  const activities = ids.map(id => ({
    lead_id: id,
    activity_type: 'status_change',
    description: `Bulk update: ${current_status} → ${new_status}${lost_reason ? ` (${lost_reason})` : ''}`,
    performed_by: 'Intelligence Bar',
  }));
  await db('lead_activities').insert(activities).catch(() => {});

  logger.info(`[intelligence-bar:leads] Bulk updated ${ids.length} leads: ${current_status} → ${new_status}`);

  return {
    success: true,
    updated: ids.length,
    from_status: current_status,
    to_status: new_status,
  };
}


module.exports = { LEADS_TOOLS, executeLeadsTool };
