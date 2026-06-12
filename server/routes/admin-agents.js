const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const leadAttribution = require('../services/lead-attribution');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { addETDays, etParts, parseETDateTime } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

const AGENTS = [
  {
    id: 'lead_conversion',
    name: 'Lead Conversion Agent',
    shortName: 'Conversion',
    description: 'Speed-to-lead, lead qualification, follow-up, and booking handoffs.',
    primaryUrl: '/admin/leads',
  },
  {
    id: 'seo_geo',
    name: 'SEO/GEO Agent',
    shortName: 'SEO/GEO',
    description: 'Search Console opportunities, content briefs, PR review, and AI visibility work.',
    primaryUrl: '/admin/seo',
  },
  {
    id: 'ads',
    name: 'Ads Agent',
    shortName: 'Ads',
    description: 'Paid search monitoring, budget risk, and campaign optimization.',
    primaryUrl: '/admin/ppc',
  },
  {
    id: 'reviews',
    name: 'Review Agent',
    shortName: 'Reviews',
    description: 'Google review replies, reputation gaps, and review velocity.',
    primaryUrl: '/admin/reviews',
  },
  {
    id: 'website_cro',
    name: 'Website/CRO Agent',
    shortName: 'Website/CRO',
    description: 'Landing-page fixes, CTA improvements, technical SEO, and conversion experiments.',
    primaryUrl: '/admin/seo',
  },
  {
    id: 'dispatch',
    name: 'Dispatch Agent',
    shortName: 'Dispatch',
    description: 'Route optimization proposals, schedule readiness, and field execution risks.',
    primaryUrl: '/admin/dispatch',
  },
  {
    id: 'pricing',
    name: 'Pricing Agent',
    shortName: 'Pricing',
    description: 'Pricing engine proposals, margin guardrails, and config-change review.',
    primaryUrl: '/admin/pricing-logic',
  },
];

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const ACTIVE_LEAD_STATUSES = ['new', 'contacted', 'estimate_sent', 'estimate_viewed'];
const CLOSED_LEAD_STATUSES = ['won', 'lost', 'unresponsive', 'disqualified', 'duplicate'];
const TASK_LIFECYCLE_STATUSES = new Set(['done', 'dismissed']);
const DRAFT_REPLY_PREFIX = '[DRAFT]';

async function tableExists(table) {
  return db.schema.hasTable(table).catch(() => false);
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

function compact(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

function customerName(row) {
  return [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
}

function firstName(row = {}) {
  const raw = String(row.first_name || row.reviewer_name || '').trim();
  const [first] = raw.split(/\s+/);
  return /^[a-z][a-z'-]{1,24}$/i.test(first || '') ? first : '';
}

function actorName(req) {
  return [req.technician?.first_name, req.technician?.last_name].filter(Boolean).join(' ')
    || req.technician?.email
    || req.technicianId
    || 'Admin';
}

function dateValue(value) {
  if (!value) return 0;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

function ageMinutes(value) {
  const startedAt = dateValue(value);
  if (!startedAt) return 0;
  const ms = Date.now() - startedAt;
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.round(ms / 60000);
}

function isPastDue(value) {
  return Boolean(value && dateValue(value) <= Date.now());
}

function isMissedCallLead(row) {
  const leadType = String(row.lead_type || '').toLowerCase();
  const duration = row.call_duration_seconds == null ? null : asNumber(row.call_duration_seconds, null);
  return leadType === 'voicemail' || (leadType === 'inbound_call' && (duration === null || duration <= 0));
}

function formatETWallDate(date, hour = 9, minute = 0) {
  const p = etParts(date);
  return parseETDateTime(
    `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  );
}

function followUpDateFromPreset(preset, explicitDate) {
  if (explicitDate) {
    const parsed = parseETDateTime(String(explicitDate));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  if (preset === 'later_today') return new Date(Date.now() + 4 * 60 * 60 * 1000);

  let offset = preset === 'two_days' ? 2 : 1;
  let candidate = addETDays(new Date(), offset);
  while ([0, 6].includes(etParts(candidate).dayOfWeek)) {
    offset += 1;
    candidate = addETDays(new Date(), offset);
  }
  return formatETWallDate(candidate, 9, 0);
}

function leadDraftMessage(lead, taskType) {
  const name = firstName(lead);
  const greeting = `Hi${name ? ` ${name}` : ''}, this is Waves Pest Control.`;
  const service = compact(lead.service_interest || '', 42);
  const servicePhrase = service ? ` with ${service}` : '';

  if (taskType === 'missed_call_unanswered') {
    return `${greeting} Sorry we missed your call. I can help${servicePhrase}. What is the best time today for a quick call?`;
  }
  if (taskType === 'estimate_viewed_not_booked') {
    return `${greeting} I saw you viewed your estimate. Any questions I can answer, or would you like help getting scheduled?`;
  }
  if (taskType === 'follow_up_due') {
    return `${greeting} Just following up on your${servicePhrase || ' pest control'} request. Can I answer questions or help get you scheduled?`;
  }
  return `${greeting} Thanks for reaching out${servicePhrase ? ` about${servicePhrase.replace(/^ with/, '')}` : ''}. I can help get this moving. What is the best time to talk today?`;
}

function reviewDraftMessage(review) {
  const rating = asNumber(review.star_rating, 0);
  const name = firstName(review);
  const greeting = name ? `Hi ${name},` : 'Hi there,';

  if (rating > 0 && rating <= 3) {
    return `${greeting} thank you for sharing this feedback. I am sorry your experience did not meet expectations. Please call or text us so we can review the visit and make it right. - Waves Pest Control`;
  }
  if (review.review_text) {
    return `${greeting} thank you for the kind review. We appreciate you choosing Waves Pest Control and are glad our team could help. - Waves Pest Control`;
  }
  return `${greeting} thank you for the ${rating || 5}-star review. We appreciate you choosing Waves Pest Control. - Waves Pest Control`;
}

function stableStringify(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function task(input) {
  return {
    id: input.id,
    agentId: input.agentId,
    title: compact(input.title, 120),
    summary: compact(input.summary, 220),
    priority: input.priority || 'medium',
    status: input.status || 'needs_review',
    source: input.source,
    sourceLabel: input.sourceLabel || input.source,
    sourceId: input.sourceId || null,
    createdAt: input.createdAt || null,
    dueAt: input.dueAt || null,
    actionUrl: input.actionUrl,
    actionLabel: input.actionLabel || 'Review',
    impact: input.impact || null,
    confidence: input.confidence ?? null,
    actions: input.actions || [],
    metadata: input.metadata || {},
  };
}

function taskFingerprint(item) {
  return crypto.createHash('sha256')
    .update(stableStringify({
      id: item.id,
      agentId: item.agentId,
      title: item.title,
      summary: item.summary,
      priority: item.priority,
      status: item.status,
      source: item.source,
      sourceId: item.sourceId,
      dueAt: item.dueAt,
      impact: item.impact,
      metadata: item.metadata,
    }))
    .digest('hex')
    .slice(0, 32);
}

function lifecycleActions(item, fingerprint) {
  const actions = [...(item.actions || [])];
  if (!actions.length && item.actionUrl) {
    actions.push({
      type: 'link',
      key: 'open_task',
      label: item.actionLabel || 'Open',
      url: item.actionUrl,
      variant: 'primary',
    });
  }

  const endpoint = `/admin/agents/tasks/${encodeURIComponent(item.id)}/state`;
  actions.push(
    {
      type: 'mutation',
      key: 'done',
      label: 'Done',
      endpoint,
      method: 'POST',
      body: { status: 'done', fingerprint },
      variant: 'secondary',
    },
    {
      type: 'mutation',
      key: 'dismiss',
      label: 'Dismiss',
      endpoint,
      method: 'POST',
      body: { status: 'dismissed', fingerprint },
      variant: 'ghost',
    }
  );
  return actions;
}

function enrichTask(item) {
  const fingerprint = taskFingerprint(item);
  return {
    ...item,
    fingerprint,
    actions: lifecycleActions(item, fingerprint),
  };
}

async function loadSource(sourceId, label, loader) {
  try {
    const result = await loader();
    return {
      source: {
        id: sourceId,
        label,
        status: result.missing ? 'missing' : 'ok',
        count: result.count ?? (result.tasks || []).length,
        lastActivityAt: result.lastActivityAt || latestDate(result.tasks || []),
      },
      tasks: result.tasks || [],
    };
  } catch (err) {
    logger.warn(`[admin-agents] ${sourceId} source failed: ${err.message}`);
    return {
      source: {
        id: sourceId,
        label,
        status: 'error',
        count: 0,
        error: err.message,
      },
      tasks: [],
    };
  }
}

function latestDate(tasks) {
  return tasks
    .map((item) => item.createdAt || item.dueAt)
    .filter(Boolean)
    .sort((a, b) => dateValue(b) - dateValue(a))[0] || null;
}

function agentForDecision(row) {
  const haystack = `${row.workflow || ''} ${row.agent_name || ''} ${row.entity_type || ''}`.toLowerCase();
  if (/route|dispatch|schedule/.test(haystack)) return 'dispatch';
  if (/price|pricing|margin|quote/.test(haystack)) return 'pricing';
  if (/seo|content|blog|geo|search/.test(haystack)) return 'seo_geo';
  if (/ad|ppc|campaign/.test(haystack)) return 'ads';
  if (/review|reputation/.test(haystack)) return 'reviews';
  return 'lead_conversion';
}

function isWebsiteAction(row) {
  const haystack = `${row.issue_type || ''} ${row.action_type || ''} ${row.summary || ''}`.toLowerCase();
  return /conversion|cta|landing|layout|speed|performance|technical|schema|canonical|404|crawl|index/.test(haystack);
}

async function loadAgentDecisionTasks() {
  if (!(await tableExists('agent_decisions'))) return { missing: true, tasks: [] };
  const rows = await db('agent_decisions')
    .where('status', 'pending_review')
    .select('id', 'workflow', 'agent_name', 'entity_type', 'confidence', 'reasoning_summary', 'recommended_actions', 'safety_flags', 'created_at')
    .orderBy('created_at', 'desc')
    .limit(14);

  return {
    count: rows.length,
    tasks: rows.map((row) => {
      const recommended = parseJson(row.recommended_actions, []);
      const safetyFlags = parseJson(row.safety_flags, []);
      const confidence = row.confidence == null ? null : asNumber(row.confidence, null);
      const priority = safetyFlags.length ? 'high' : confidence != null && confidence < 0.65 ? 'medium' : 'low';
      return task({
        id: `agent_decision:${row.id}`,
        agentId: agentForDecision(row),
        title: `${row.agent_name || 'Agent'} decision needs review`,
        summary: row.reasoning_summary || recommended.slice(0, 3).join(', ') || row.workflow || 'Review pending shadow decision.',
        priority,
        source: 'agent_decisions',
        sourceLabel: 'Agent Review',
        sourceId: row.id,
        createdAt: row.created_at,
        actionUrl: '/admin/agents?tab=decisions',
        actionLabel: 'Open Agent Review',
        confidence,
        impact: safetyFlags.length ? `${safetyFlags.length} safety flag${safetyFlags.length === 1 ? '' : 's'}` : null,
      });
    }),
  };
}

async function loadOperatorInboxTasks() {
  if (!(await tableExists('operator_inbox_items'))) return { missing: true, tasks: [] };
  const rows = await db('operator_inbox_items')
    .where(function openOrDue() {
      this.where('status', 'open')
        .orWhere(function dueSnooze() {
          this.where('status', 'snoozed').where('snoozed_until', '<=', db.fn.now());
        });
    })
    .select('id', 'source', 'channel', 'priority', 'needs_reply', 'at_risk', 'title', 'summary', 'occurred_at', 'created_at')
    .orderBy('occurred_at', 'desc')
    .limit(12);

  return {
    count: rows.length,
    tasks: rows.map((row) => task({
      id: `operator_inbox:${row.id}`,
      agentId: 'lead_conversion',
      title: row.title || `${row.channel || row.source || 'Customer'} item needs attention`,
      summary: row.summary || (row.needs_reply ? 'Customer follow-up is waiting.' : 'Open operator inbox item.'),
      priority: row.at_risk ? 'high' : row.priority || 'medium',
      source: 'operator_inbox_items',
      sourceLabel: 'Operator Inbox',
      sourceId: row.id,
      createdAt: row.occurred_at || row.created_at,
      actionUrl: '/admin/communications',
      actionLabel: 'Open Inbox',
      impact: row.needs_reply ? 'Needs reply' : null,
    })),
  };
}

async function loadLeadTasks() {
  if (!(await tableExists('leads'))) return { missing: true, tasks: [] };
  const rows = await db('leads')
    .where(function activeLeadWork() {
      this.where('status', 'new')
        .orWhere('next_follow_up_at', '<=', db.fn.now())
        .orWhere('status', 'estimate_viewed');
    })
    .whereNotIn('status', CLOSED_LEAD_STATUSES)
    .select(
      'id',
      'first_name',
      'last_name',
      'phone',
      'email',
      'status',
      'lead_type',
      'service_interest',
      'urgency',
      'first_contact_at',
      'next_follow_up_at',
      'created_at',
      'response_time_minutes',
      'call_duration_seconds',
      'estimate_id',
      'customer_id'
    )
    .orderByRaw("CASE WHEN status = 'new' THEN 0 ELSE 1 END")
    .orderBy('first_contact_at', 'desc')
    .limit(20);

  return {
    count: rows.length,
    tasks: rows.map((row) => {
      const name = customerName(row) || 'New lead';
      const phone = row.phone || null;
      const missedCall = isMissedCallLead(row);
      const dueFollowUp = isPastDue(row.next_follow_up_at);
      const speedToLeadMinutes = row.response_time_minutes == null
        ? ageMinutes(row.first_contact_at || row.created_at)
        : null;
      const due = row.next_follow_up_at || row.first_contact_at;
      const taskType = missedCall && row.status === 'new'
        ? 'missed_call_unanswered'
        : row.status === 'new'
          ? 'new_unanswered'
          : row.status === 'estimate_viewed'
            ? 'estimate_viewed_not_booked'
            : 'follow_up_due';
      const actionUrl = phone
        ? `/admin/leads?search=${encodeURIComponent(phone)}`
        : '/admin/leads';
      const actions = [
        (phone || row.customer_id) ? {
          type: 'mutation',
          key: 'create_lead_draft',
          label: 'Create draft',
          endpoint: `/admin/agents/leads/${row.id}/draft-response`,
          method: 'POST',
          body: { taskType },
          variant: 'primary',
        } : null,
        phone ? {
          type: 'link',
          key: 'open_sms',
          label: 'Open SMS',
          url: `/admin/communications?phone=${encodeURIComponent(phone)}&action=sms`,
          variant: 'secondary',
        } : null,
        row.status === 'new' ? {
          type: 'mutation',
          key: 'mark_contacted',
          label: 'Mark contacted',
          endpoint: `/admin/agents/leads/${row.id}/mark-contacted`,
          method: 'POST',
          variant: 'secondary',
        } : null,
        {
          type: 'mutation',
          key: 'schedule_follow_up',
          label: dueFollowUp ? 'Snooze to tomorrow' : 'Follow up tomorrow',
          endpoint: `/admin/agents/leads/${row.id}/schedule-follow-up`,
          method: 'POST',
          body: { preset: 'tomorrow_morning' },
          variant: 'secondary',
        },
        {
          type: 'link',
          key: 'open_lead',
          label: 'Open lead',
          url: actionUrl,
          variant: 'ghost',
        },
      ].filter(Boolean);

      return task({
        id: `lead:${row.id}`,
        agentId: 'lead_conversion',
        title: {
          missed_call_unanswered: `Missed call: ${name}`,
          new_unanswered: `New lead: ${name}`,
          estimate_viewed_not_booked: `Estimate viewed: ${name}`,
          follow_up_due: `Follow up with ${name}`,
        }[taskType],
        summary: [
          row.service_interest,
          phone,
          row.urgency && row.urgency !== 'normal' ? `${row.urgency} urgency` : null,
          row.status === 'new' && speedToLeadMinutes != null ? `${speedToLeadMinutes} min since lead` : null,
          `status: ${row.status}`,
        ].filter(Boolean).join(' · '),
        priority: taskType === 'missed_call_unanswered'
          ? 'critical'
          : row.urgency === 'high' || (row.status === 'new' && speedToLeadMinutes >= 15)
            ? 'high'
            : dueFollowUp || row.status === 'new'
              ? 'high'
              : 'medium',
        source: 'leads',
        sourceLabel: 'Lead Pipeline',
        sourceId: row.id,
        createdAt: row.first_contact_at || row.created_at,
        dueAt: due,
        actionUrl,
        actionLabel: 'Open Leads',
        impact: {
          missed_call_unanswered: 'Missed call',
          new_unanswered: 'Speed-to-lead',
          estimate_viewed_not_booked: 'Viewed estimate',
          follow_up_due: 'Follow-up SLA',
        }[taskType],
        actions,
        metadata: {
          taskType,
          leadId: row.id,
          phone,
          email: row.email || null,
          status: row.status,
          speedToLeadMinutes,
          estimateId: row.estimate_id || null,
          customerId: row.customer_id || null,
        },
      });
    }),
  };
}

async function loadLeadConversionDetails() {
  if (!(await tableExists('leads'))) return { missing: true, metrics: {} };

  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const activeRows = await db('leads')
    .whereIn('status', ACTIVE_LEAD_STATUSES)
    .select('id', 'status', 'lead_type', 'first_contact_at', 'next_follow_up_at', 'response_time_minutes', 'call_duration_seconds');
  const recentRows = await db('leads')
    .where('first_contact_at', '>=', since30)
    .select('status', 'response_time_minutes', 'first_contact_at');

  const responded = recentRows.filter((row) => row.response_time_minutes != null);
  const avgResponseMinutes = responded.length
    ? Math.round(responded.reduce((sum, row) => sum + asNumber(row.response_time_minutes), 0) / responded.length)
    : null;

  const metrics = {
    activeLeads: activeRows.length,
    newLeads: activeRows.filter((row) => row.status === 'new').length,
    unanswered: activeRows.filter((row) => row.response_time_minutes == null).length,
    overdueFollowUps: activeRows.filter((row) => isPastDue(row.next_follow_up_at)).length,
    missedCalls: activeRows.filter((row) => row.response_time_minutes == null && isMissedCallLead(row)).length,
    staleSpeedToLead: activeRows.filter((row) => row.status === 'new' && ageMinutes(row.first_contact_at) >= 15).length,
    booked30d: recentRows.filter((row) => row.status === 'won').length,
    avgResponseMinutes,
    agentRuns7d: 0,
    agentQueued7d: 0,
    draftsQueued7d: 0,
  };

  if (await tableExists('lead_agent_responses')) {
    const rows = await db('lead_agent_responses')
      .select('action_taken')
      .where('created_at', '>=', since7);
    metrics.agentRuns7d = rows.length;
    metrics.agentQueued7d = rows.filter((row) => /queued|review/i.test(row.action_taken || '')).length;
  }

  if (await tableExists('lead_activities')) {
    const draftRows = await db('lead_activities')
      .where('activity_type', 'draft_queued')
      .where('created_at', '>=', since7)
      .count('* as count')
      .first();
    metrics.draftsQueued7d = asNumber(draftRows?.count);
  }

  return {
    missing: false,
    metrics,
  };
}

async function loadContentReviewTasks() {
  if (!(await tableExists('opportunity_queue'))) return { missing: true, tasks: [] };
  const rows = await db('opportunity_queue')
    .where('status', 'pending_review')
    .select('id', 'action_type', 'bucket', 'query', 'page_url', 'service', 'city', 'score', 'skip_reason', 'updated_at', 'mined_at')
    .orderBy('score', 'desc')
    .limit(12);

  return {
    count: rows.length,
    tasks: rows.map((row) => task({
      id: `content_review:${row.id}`,
      agentId: 'seo_geo',
      title: `${labelize(row.action_type)} awaiting review`,
      summary: compact([row.query || row.page_url, row.city, row.service, row.skip_reason].filter(Boolean).join(' · '), 220),
      priority: asNumber(row.score) >= 75 ? 'high' : 'medium',
      source: 'opportunity_queue',
      sourceLabel: 'Content Engine',
      sourceId: row.id,
      createdAt: row.updated_at || row.mined_at,
      actionUrl: '/admin/content-engine',
      actionLabel: 'Open Content Engine',
      impact: row.score != null ? `score ${row.score}` : row.bucket,
    })),
  };
}

async function loadSeoActionTasks() {
  if (!(await tableExists('seo_actions'))) return { missing: true, tasks: [] };
  const rows = await db('seo_actions')
    .where({ status: 'open', approval_status: 'pending' })
    .select('id', 'url', 'domain', 'issue_type', 'action_type', 'summary', 'priority_score', 'impact_score', 'effort_score', 'created_at')
    .orderBy('priority_score', 'desc')
    .limit(14);

  return {
    count: rows.length,
    tasks: rows.map((row) => {
      const agentId = isWebsiteAction(row) ? 'website_cro' : 'seo_geo';
      return task({
        id: `seo_action:${row.id}`,
        agentId,
        title: row.summary || `${labelize(row.action_type)} for ${row.domain || 'site'}`,
        summary: [row.issue_type && labelize(row.issue_type), row.url].filter(Boolean).join(' · '),
        priority: asNumber(row.priority_score) >= 80 ? 'high' : 'medium',
        source: 'seo_actions',
        sourceLabel: 'SEO Actions',
        sourceId: row.id,
        createdAt: row.created_at,
        actionUrl: '/admin/seo',
        actionLabel: agentId === 'website_cro' ? 'Open SEO/CRO' : 'Open SEO',
        impact: row.impact_score != null ? `impact ${row.impact_score}` : `priority ${row.priority_score || 0}`,
      });
    }),
  };
}

async function loadAdTasks() {
  if (!(await tableExists('ad_campaigns'))) return { missing: true, tasks: [] };
  if (!(await tableExists('ad_performance_daily'))) return { missing: true, tasks: [] };

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const campaigns = await db('ad_campaigns')
    .where('status', 'active')
    .select('id', 'campaign_name', 'campaign_type', 'target_area', 'service_category', 'budget_mode', 'daily_budget_current', 'created_at')
    .orderBy('campaign_name')
    .limit(100);
  const campaignIds = campaigns.map((row) => row.id);
  if (!campaignIds.length) return { count: 0, tasks: [] };

  const perf = await db('ad_performance_daily')
    .whereIn('campaign_id', campaignIds)
    .where('date', '>=', since)
    .select('campaign_id')
    .sum('cost as cost')
    .sum('conversions as conversions')
    .sum('conversion_value as conversion_value')
    .groupBy('campaign_id');

  const perfByCampaign = new Map(perf.map((row) => [row.campaign_id, row]));
  const rows = campaigns
    .map((campaign) => {
      const p = perfByCampaign.get(campaign.id) || {};
      const cost = asNumber(p.cost);
      const conversions = asNumber(p.conversions);
      const value = asNumber(p.conversion_value);
      const roas = cost > 0 ? value / cost : null;
      return { ...campaign, cost, conversions, value, roas };
    })
    .filter((row) => row.budget_mode === 'stop' || (row.cost >= 50 && row.conversions < 1) || (row.cost >= 75 && row.roas != null && row.roas < 1.5))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10);

  return {
    count: rows.length,
    tasks: rows.map((row) => task({
      id: `ad_campaign:${row.id}`,
      agentId: 'ads',
      title: row.budget_mode === 'stop' ? `Campaign stopped: ${row.campaign_name}` : `Review spend: ${row.campaign_name}`,
      summary: [
        row.campaign_type,
        row.target_area,
        `$${Math.round(row.cost)} spent in 7d`,
        `${Math.round(row.conversions)} conv`,
      ].filter(Boolean).join(' · '),
      priority: row.budget_mode === 'stop' || (row.cost >= 100 && row.conversions < 1) ? 'high' : 'medium',
      source: 'ad_campaigns',
      sourceLabel: 'PPC',
      sourceId: row.id,
      createdAt: row.created_at,
      actionUrl: '/admin/ppc',
      actionLabel: 'Open PPC',
      impact: row.roas != null ? `${row.roas.toFixed(1)}x ROAS` : 'No conversions',
    })),
  };
}

async function loadReviewTasks() {
  if (!(await tableExists('google_reviews'))) return { missing: true, tasks: [] };
  const rows = await db('google_reviews')
    .where('reviewer_name', '!=', '_stats')
    .where(function needsReply() {
      this.whereNull('review_reply').orWhere('review_reply', 'like', '[DRAFT]%');
    })
    .select('id', 'reviewer_name', 'star_rating', 'review_text', 'review_reply', 'review_created_at', 'created_at')
    .orderBy('review_created_at', 'desc')
    .limit(12);

  return {
    count: rows.length,
    tasks: rows.map((row) => {
      const hasDraft = String(row.review_reply || '').trim().startsWith(DRAFT_REPLY_PREFIX);
      return task({
        id: `google_review:${row.id}`,
        agentId: 'reviews',
        title: `Reply to ${row.reviewer_name || 'Google review'}`,
        summary: compact(row.review_text || `${row.star_rating || '?'} star review`, 180),
        priority: asNumber(row.star_rating, 5) <= 3 ? 'high' : 'medium',
        source: 'google_reviews',
        sourceLabel: 'Google Reviews',
        sourceId: row.id,
        createdAt: row.review_created_at || row.created_at,
        actionUrl: '/admin/reviews',
        actionLabel: 'Open Reviews',
        impact: row.star_rating ? `${row.star_rating} star` : null,
        actions: [
          {
            type: 'mutation',
            key: 'create_review_draft',
            label: hasDraft ? 'Refresh draft' : 'Create draft',
            endpoint: `/admin/agents/reviews/${row.id}/draft-response`,
            method: 'POST',
            variant: 'primary',
          },
          {
            type: 'link',
            key: 'open_reviews',
            label: 'Open Reviews',
            url: '/admin/reviews',
            variant: 'secondary',
          },
        ],
        metadata: {
          reviewId: row.id,
          hasDraft,
        },
      });
    }),
  };
}

async function loadRouteProposalTasks() {
  if (!(await tableExists('route_optimization_proposals'))) return { missing: true, tasks: [] };
  const rows = await db('route_optimization_proposals')
    .whereIn('status', ['draft', 'ready'])
    .select('id', 'scheduled_date', 'status', 'service_count', 'tech_count', 'saved_distance_meters', 'warnings', 'created_at')
    .orderBy('created_at', 'desc')
    .limit(10);

  return {
    count: rows.length,
    tasks: rows.map((row) => {
      const warnings = parseJson(row.warnings, []);
      const savedMiles = asNumber(row.saved_distance_meters) / 1609.344;
      return task({
        id: `route_proposal:${row.id}`,
        agentId: 'dispatch',
        title: `Route proposal for ${row.scheduled_date}`,
        summary: `${row.service_count || 0} stops · ${row.tech_count || 0} techs · ${savedMiles.toFixed(1)} mi saved`,
        priority: warnings.some((w) => w?.severity === 'critical') ? 'high' : row.status === 'ready' ? 'medium' : 'low',
        source: 'route_optimization_proposals',
        sourceLabel: 'Route Planner',
        sourceId: row.id,
        createdAt: row.created_at,
        actionUrl: '/admin/dispatch',
        actionLabel: 'Open Dispatch',
        impact: warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'Route savings',
      });
    }),
  };
}

async function loadPricingProposalTasks() {
  if (!(await tableExists('pricing_engine_proposals'))) return { missing: true, tasks: [] };
  const rows = await db('pricing_engine_proposals')
    .where('status', 'pending')
    .select('id', 'trigger_source', 'config_key', 'current_value', 'proposed_value', 'pct_change', 'created_at')
    .orderBy('created_at', 'desc')
    .limit(10);

  return {
    count: rows.length,
    tasks: rows.map((row) => task({
      id: `pricing_proposal:${row.id}`,
      agentId: 'pricing',
      title: `Pricing change: ${row.config_key}`,
      summary: `${row.current_value ?? 'unset'} → ${row.proposed_value}${row.trigger_source ? ` · ${row.trigger_source}` : ''}`,
      priority: Math.abs(asNumber(row.pct_change)) >= 15 ? 'high' : 'medium',
      source: 'pricing_engine_proposals',
      sourceLabel: 'Pricing Proposals',
      sourceId: String(row.id),
      createdAt: row.created_at,
      actionUrl: '/admin/pricing-logic',
      actionLabel: 'Open Pricing',
      impact: row.pct_change != null ? `${Number(row.pct_change).toFixed(1)}% change` : null,
    })),
  };
}

function labelize(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function buildAgents(tasks, sources) {
  return AGENTS.map((agent) => {
    const agentTasks = tasks.filter((item) => item.agentId === agent.id);
    const critical = agentTasks.filter((item) => item.priority === 'critical').length;
    const high = agentTasks.filter((item) => item.priority === 'high').length;
    const needsApproval = agentTasks.filter((item) => ['needs_review', 'approval'].includes(item.status)).length;
    const erroredSource = sources.find((source) => source.status === 'error' && sourceAgentHint(source.id) === agent.id);
    const status = erroredSource
      ? 'blocked'
      : critical || high
        ? 'needs_review'
        : needsApproval
          ? 'active'
          : 'idle';

    return {
      ...agent,
      status,
      openTasks: agentTasks.length,
      needsApproval,
      highPriority: critical + high,
      lastActivityAt: latestDate(agentTasks),
      headline: headlineForAgent(agent, agentTasks, status),
    };
  });
}

function sourceAgentHint(sourceId) {
  if (['agent_decisions', 'operator_inbox_items', 'leads'].includes(sourceId)) return 'lead_conversion';
  if (['opportunity_queue', 'seo_actions'].includes(sourceId)) return 'seo_geo';
  if (sourceId === 'ad_campaigns') return 'ads';
  if (sourceId === 'google_reviews') return 'reviews';
  if (sourceId === 'route_optimization_proposals') return 'dispatch';
  if (sourceId === 'pricing_engine_proposals') return 'pricing';
  return null;
}

function headlineForAgent(agent, tasks, status) {
  if (status === 'blocked') return 'Source error';
  if (!tasks.length) return 'No open work';
  const high = tasks.filter((item) => item.priority === 'critical' || item.priority === 'high').length;
  if (high) return `${high} high-priority item${high === 1 ? '' : 's'}`;
  return `${tasks.length} open item${tasks.length === 1 ? '' : 's'}`;
}

async function loadOverviewSources() {
  return Promise.all([
    loadSource('agent_decisions', 'Agent Review', loadAgentDecisionTasks),
    loadSource('operator_inbox_items', 'Operator Inbox', loadOperatorInboxTasks),
    loadSource('leads', 'Lead Pipeline', loadLeadTasks),
    loadSource('opportunity_queue', 'Content Engine', loadContentReviewTasks),
    loadSource('seo_actions', 'SEO Actions', loadSeoActionTasks),
    loadSource('ad_campaigns', 'PPC', loadAdTasks),
    loadSource('google_reviews', 'Google Reviews', loadReviewTasks),
    loadSource('route_optimization_proposals', 'Route Planner', loadRouteProposalTasks),
    loadSource('pricing_engine_proposals', 'Pricing Proposals', loadPricingProposalTasks),
  ]);
}

function sortTasks(tasks) {
  return tasks.sort((a, b) => {
    const priorityDelta = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
    if (priorityDelta !== 0) return priorityDelta;
    return dateValue(b.createdAt || b.dueAt) - dateValue(a.createdAt || a.dueAt);
  });
}

async function applyTaskStates(tasks) {
  const enriched = tasks.map(enrichTask);
  if (!enriched.length || !(await tableExists('agent_ops_task_states'))) {
    return { tasks: enriched, hiddenCount: 0 };
  }

  const rows = await db('agent_ops_task_states')
    .whereIn('task_id', [...new Set(enriched.map((item) => item.id))])
    .whereIn('fingerprint', [...new Set(enriched.map((item) => item.fingerprint))])
    .whereIn('status', [...TASK_LIFECYCLE_STATUSES])
    .select('task_id', 'fingerprint', 'status');
  const handled = new Set(rows.map((row) => `${row.task_id}:${row.fingerprint}`));
  const visible = enriched.filter((item) => !handled.has(`${item.id}:${item.fingerprint}`));
  return { tasks: visible, hiddenCount: enriched.length - visible.length };
}

async function loadCurrentGeneratedTask(taskId) {
  const loaded = await loadOverviewSources();
  const current = loaded
    .flatMap((item) => item.tasks)
    .find((item) => item.id === taskId);
  return current ? enrichTask(current) : null;
}

function uuidOrNull(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))
    ? value
    : null;
}

router.get('/overview', async (_req, res) => {
  const [loaded, leadConversion] = await Promise.all([
    loadOverviewSources(),
    loadLeadConversionDetails(),
  ]);

  const sources = loaded.map((item) => item.source);
  const generatedTasks = sortTasks(loaded.flatMap((item) => item.tasks)).slice(0, 120);
  const stateApplied = await applyTaskStates(generatedTasks);
  const tasks = sortTasks(stateApplied.tasks).slice(0, 80);

  const agents = buildAgents(tasks, sources);
  res.json({
    generatedAt: new Date().toISOString(),
    summary: {
      agents: agents.length,
      activeAgents: agents.filter((agent) => agent.status !== 'idle').length,
      blockedAgents: agents.filter((agent) => agent.status === 'blocked').length,
      openTasks: tasks.length,
      hiddenTasks: stateApplied.hiddenCount,
      needsApproval: tasks.filter((item) => ['needs_review', 'approval'].includes(item.status)).length,
      highPriority: tasks.filter((item) => item.priority === 'critical' || item.priority === 'high').length,
    },
    agents,
    tasks,
    sources,
    agentDetails: {
      lead_conversion: leadConversion,
    },
  });
});

router.post('/tasks/:taskId/state', async (req, res, next) => {
  try {
    if (!(await tableExists('agent_ops_task_states'))) {
      return res.status(503).json({ error: 'Agent Ops task state table is not migrated yet' });
    }

    const status = String(req.body?.status || '').trim();
    if (!TASK_LIFECYCLE_STATUSES.has(status)) {
      return res.status(400).json({ error: "status must be 'done' or 'dismissed'" });
    }

    const current = await loadCurrentGeneratedTask(req.params.taskId);
    if (!current) return res.status(404).json({ error: 'Task is no longer active' });

    const requestedFingerprint = String(req.body?.fingerprint || '').trim();
    if (requestedFingerprint && requestedFingerprint !== current.fingerprint) {
      return res.status(409).json({ error: 'Task changed since the page loaded. Refresh Agent Ops and review it again.' });
    }

    const now = new Date();
    const snapshot = {
      id: current.id,
      fingerprint: current.fingerprint,
      agentId: current.agentId,
      title: current.title,
      summary: current.summary,
      priority: current.priority,
      status: current.status,
      source: current.source,
      sourceId: current.sourceId,
      createdAt: current.createdAt,
      dueAt: current.dueAt,
      impact: current.impact,
      metadata: current.metadata || {},
    };

    const [state] = await db('agent_ops_task_states')
      .insert({
        task_id: current.id,
        fingerprint: current.fingerprint,
        status,
        agent_id: current.agentId,
        source: current.source,
        source_id: current.sourceId == null ? null : String(current.sourceId),
        title: current.title,
        note: compact(req.body?.note || '', 500) || null,
        handled_by: actorName(req),
        handled_by_technician_id: uuidOrNull(req.technicianId),
        handled_at: now,
        snapshot: JSON.stringify(snapshot),
        created_at: now,
        updated_at: now,
      })
      .onConflict(['task_id', 'fingerprint'])
      .merge({
        status,
        note: compact(req.body?.note || '', 500) || null,
        handled_by: actorName(req),
        handled_by_technician_id: uuidOrNull(req.technicianId),
        handled_at: now,
        snapshot: JSON.stringify(snapshot),
        updated_at: now,
      })
      .returning('*');

    res.json({ state, task: current });
  } catch (err) {
    next(err);
  }
});

router.post('/leads/:id/mark-contacted', async (req, res, next) => {
  try {
    if (!(await tableExists('leads'))) return res.status(404).json({ error: 'Lead pipeline is not available' });

    const lead = await db('leads').where('id', req.params.id).first();
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (CLOSED_LEAD_STATUSES.includes(lead.status)) {
      return res.status(409).json({ error: 'Closed leads cannot be marked contacted from Agent Ops' });
    }

    const [updated] = await db('leads').where('id', req.params.id).update({
      status: lead.status === 'new' ? 'contacted' : lead.status,
      next_follow_up_at: null,
      updated_at: new Date(),
    }).returning('*');

    if (lead.response_time_minutes == null) await leadAttribution.logFirstResponse(req.params.id);

    await db('lead_activities').insert({
      lead_id: req.params.id,
      activity_type: 'contacted',
      description: 'Marked contacted from Agent Ops.',
      performed_by: actorName(req),
      metadata: JSON.stringify({ source: 'agent_ops', prior_status: lead.status }),
    }).catch(() => {});

    const responseLead = await db('leads').where('id', req.params.id).first();
    res.json({ lead: responseLead || updated, action: 'mark_contacted' });
  } catch (err) {
    next(err);
  }
});

router.post('/leads/:id/schedule-follow-up', async (req, res, next) => {
  try {
    if (!(await tableExists('leads'))) return res.status(404).json({ error: 'Lead pipeline is not available' });

    const lead = await db('leads').where('id', req.params.id).first();
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (CLOSED_LEAD_STATUSES.includes(lead.status)) {
      return res.status(409).json({ error: 'Closed leads cannot be scheduled from Agent Ops' });
    }

    const followUpAt = followUpDateFromPreset(req.body?.preset || 'tomorrow_morning', req.body?.followUpAt);
    if (!followUpAt || Number.isNaN(followUpAt.getTime())) {
      return res.status(400).json({ error: 'Invalid follow-up date' });
    }

    const [updated] = await db('leads').where('id', req.params.id).update({
      next_follow_up_at: followUpAt,
      follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
      last_follow_up_at: new Date(),
      updated_at: new Date(),
    }).returning('*');

    await db('lead_activities').insert({
      lead_id: req.params.id,
      activity_type: 'callback_scheduled',
      description: `Agent Ops follow-up scheduled for ${followUpAt.toLocaleString('en-US', { timeZone: 'America/New_York' })}.`,
      performed_by: actorName(req),
      metadata: JSON.stringify({
        source: 'agent_ops',
        preset: req.body?.preset || 'tomorrow_morning',
        follow_up_at: followUpAt.toISOString(),
        notes: req.body?.notes || null,
      }),
    }).catch(() => {});

    res.json({ lead: updated, action: 'schedule_follow_up', followUpAt: followUpAt.toISOString() });
  } catch (err) {
    next(err);
  }
});

router.post('/leads/:id/draft-response', async (req, res, next) => {
  try {
    if (!(await tableExists('leads'))) return res.status(404).json({ error: 'Lead pipeline is not available' });
    if (!(await tableExists('message_drafts'))) return res.status(404).json({ error: 'Message draft queue is not available' });

    const lead = await db('leads').where('id', req.params.id).first();
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (CLOSED_LEAD_STATUSES.includes(lead.status)) {
      return res.status(409).json({ error: 'Closed leads cannot have Agent Ops drafts created' });
    }

    const customer = lead.customer_id
      ? await db('customers').where({ id: lead.customer_id }).select('id', 'first_name', 'last_name', 'phone').first().catch(() => null)
      : null;
    const recipientPhone = lead.phone || customer?.phone || null;
    if (!recipientPhone) {
      return res.status(409).json({ error: 'Lead needs a phone number before Agent Ops can create an SMS draft' });
    }

    const draftLead = {
      ...lead,
      phone: recipientPhone,
      first_name: lead.first_name || customer?.first_name || null,
      last_name: lead.last_name || customer?.last_name || null,
    };
    const taskType = String(req.body?.taskType || '').trim() || (
      isMissedCallLead(lead) && lead.status === 'new'
        ? 'missed_call_unanswered'
        : lead.status === 'estimate_viewed'
          ? 'estimate_viewed_not_booked'
          : isPastDue(lead.next_follow_up_at)
            ? 'follow_up_due'
            : 'new_unanswered'
    );
    const draftResponse = leadDraftMessage(draftLead, taskType);
    const name = customerName(draftLead) || 'lead';
    const flags = {
      source: 'agent_ops',
      agentId: 'lead_conversion',
      taskType,
      leadId: lead.id,
      phone: recipientPhone,
      email: lead.email || null,
      customerId: lead.customer_id || null,
      createdBy: actorName(req),
      noAutoSend: true,
    };

    const now = new Date();
    const draftValues = {
      sms_log_id: null,
      customer_id: uuidOrNull(lead.customer_id),
      inbound_message: [
        `Lead: ${name}`,
        `Phone: ${recipientPhone}`,
        lead.email ? `Email: ${lead.email}` : null,
        lead.service_interest ? `Interest: ${lead.service_interest}` : null,
        `Status: ${lead.status}`,
      ].filter(Boolean).join('\n'),
      draft_response: draftResponse,
      intent: 'agent_ops_lead_followup',
      intent_confidence: 0.82,
      context_summary: compact(`Agent Ops ${taskType} draft for ${name} (${lead.status || 'unknown'}).`, 500),
      flags: JSON.stringify(flags),
      status: 'pending',
    };

    const { draft, refreshed } = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`agent_ops_lead_draft:${lead.id}:${taskType}`]).catch(() => {});
      const matches = await trx('message_drafts')
        .where({ status: 'pending', intent: 'agent_ops_lead_followup' })
        .whereRaw("flags ->> 'source' = ?", ['agent_ops'])
        .whereRaw("flags ->> 'leadId' = ?", [String(lead.id)])
        .whereRaw("flags ->> 'taskType' = ?", [taskType])
        .select('id')
        .orderBy('created_at', 'desc');

      const [existing, ...stale] = matches;
      if (stale.length) {
        await trx('message_drafts').whereIn('id', stale.map((row) => row.id)).update({
          status: 'rejected',
          approved_by: uuidOrNull(req.technicianId),
          approved_at: now,
        });
      }
      if (existing?.id) {
        const [updated] = await trx('message_drafts')
          .where({ id: existing.id })
          .update(draftValues)
          .returning('*');
        return { draft: updated, refreshed: true };
      }

      const [inserted] = await trx('message_drafts')
        .insert({ ...draftValues, created_at: now })
        .returning('*');
      return { draft: inserted, refreshed: false };
    });

    await db('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'draft_queued',
      description: refreshed ? 'Agent Ops refreshed a draft SMS for review.' : 'Agent Ops queued a draft SMS for review.',
      performed_by: actorName(req),
      metadata: JSON.stringify({
        source: 'agent_ops',
        draftId: draft?.id || null,
        taskType,
        noAutoSend: true,
        refreshed,
      }),
    }).catch(() => {});

    const actionParams = new URLSearchParams();
    actionParams.set('phone', recipientPhone);
    actionParams.set('action', 'sms');
    if (draft?.id) actionParams.set('draftId', draft.id);
    const actionUrl = `/admin/communications?${actionParams.toString()}`;

    res.json({
      success: true,
      draft: {
        id: draft?.id || null,
        leadId: lead.id,
        draftResponse,
        status: 'pending',
      },
      actionUrl,
      actionLabel: 'Open SMS draft',
      message: refreshed ? 'Draft refreshed for review. Nothing was sent.' : 'Draft saved for review. Nothing was sent.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/reviews/:id/draft-response', async (req, res, next) => {
  try {
    if (!(await tableExists('google_reviews'))) return res.status(404).json({ error: 'Google reviews are not available' });

    const review = await db('google_reviews').where('id', req.params.id).first();
    if (!review || review.reviewer_name === '_stats') return res.status(404).json({ error: 'Review not found' });

    const existingReply = String(review.review_reply || '').trim();
    if (existingReply && !existingReply.startsWith(DRAFT_REPLY_PREFIX)) {
      return res.status(409).json({ error: 'This review already has a posted reply' });
    }

    const draftResponse = reviewDraftMessage(review);
    const updated = await db('google_reviews')
      .where('id', req.params.id)
      .where('reviewer_name', '!=', '_stats')
      .where(function needsRealReply() {
        this.whereNull('review_reply').orWhere('review_reply', 'like', `${DRAFT_REPLY_PREFIX}%`);
      })
      .update({
        review_reply: `${DRAFT_REPLY_PREFIX} ${draftResponse}`,
        reply_updated_at: null,
      })
      .returning('id');
    if (Array.isArray(updated) ? updated.length === 0 : updated === 0) {
      return res.status(409).json({ error: 'This review already has a posted reply' });
    }

    await db('activity_log').insert({
      admin_user_id: uuidOrNull(req.technicianId),
      action: 'review_reply_draft_created',
      description: `Agent Ops saved a draft reply for ${review.star_rating}-star review from ${review.reviewer_name || 'Google reviewer'}.`,
      metadata: JSON.stringify({
        source: 'agent_ops',
        reviewId: review.id,
        noAutoPost: true,
      }),
    }).catch(() => {});

    res.json({
      success: true,
      review: {
        id: review.id,
        reviewerName: review.reviewer_name,
        starRating: review.star_rating,
        draftReply: draftResponse,
      },
      actionUrl: '/admin/reviews',
      actionLabel: 'Open review draft',
      message: 'Review reply draft saved. Nothing was posted to Google.',
    });
  } catch (err) {
    next(err);
  }
});

// ── Shadow Drafts (brand-voice loop) ────────────────────────────────────
// GET /shadow-drafts — recent message_drafts status='shadow' rows with
// their judgment (if the nightly judge has scored them yet).
router.get('/shadow-drafts', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const intent = String(req.query.intent || '').trim();

    const query = db('message_drafts')
      .where('message_drafts.status', 'shadow')
      .leftJoin('shadow_draft_judgments', 'message_drafts.id', 'shadow_draft_judgments.draft_id')
      .leftJoin('customers', 'message_drafts.customer_id', 'customers.id')
      .select(
        'message_drafts.id', 'message_drafts.customer_id', 'message_drafts.inbound_message',
        'message_drafts.draft_response', 'message_drafts.intent', 'message_drafts.scheduling_intent',
        'message_drafts.intended_actions', 'message_drafts.draft_ms', 'message_drafts.created_at',
        'customers.first_name', 'customers.last_name',
        'shadow_draft_judgments.verdict', 'shadow_draft_judgments.scores',
        'shadow_draft_judgments.human_replied', 'shadow_draft_judgments.human_reply_text',
        'shadow_draft_judgments.notes as judge_notes', 'shadow_draft_judgments.judged_at'
      )
      .orderBy('message_drafts.created_at', 'desc')
      .limit(limit);
    if (intent) query.where('message_drafts.intent', intent);

    const rows = await query;
    res.json({
      drafts: rows.map((r) => ({
        id: r.id,
        customerName: r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : null,
        inboundMessage: r.inbound_message,
        draftResponse: r.draft_response,
        intent: r.intent,
        schedulingIntent: Boolean(r.scheduling_intent),
        intendedActions: r.intended_actions || null,
        draftMs: r.draft_ms,
        createdAt: r.created_at,
        judgment: r.judged_at
          ? {
              verdict: r.verdict,
              scores: r.scores || null,
              humanReplied: Boolean(r.human_replied),
              humanReplyText: r.human_reply_text,
              notes: r.judge_notes,
              judgedAt: r.judged_at,
            }
          : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /shadow-scores — per-intent rollup over shadow_draft_judgments.
// Average scores count ONLY LLM-scored verdicts (scores is null on the
// deterministic no-reply outcomes); agreement/verdict counts cover all.
router.get('/shadow-scores', async (req, res, next) => {
  try {
    const totals = await db('message_drafts')
      .where('status', 'shadow')
      .select('intent')
      .count('* as drafts')
      .groupBy('intent');

    const judged = await db('shadow_draft_judgments')
      .select('intent', 'verdict')
      .count('* as count')
      .groupBy('intent', 'verdict');

    const avgScores = await db('shadow_draft_judgments')
      .whereNotNull('scores')
      .select(
        'intent',
        db.raw('COUNT(*) as scored'),
        db.raw("AVG((scores->>'voice')::numeric) as voice"),
        db.raw("AVG((scores->>'safety')::numeric) as safety"),
        db.raw("AVG((scores->>'actions')::numeric) as actions"),
        db.raw("AVG((scores->>'overall')::numeric) as overall")
      )
      .groupBy('intent');

    const byIntent = new Map();
    const bucket = (intent) => {
      const key = intent || 'GENERAL';
      if (!byIntent.has(key)) {
        byIntent.set(key, { intent: key, drafts: 0, judged: 0, verdicts: {}, scored: 0, avg: null });
      }
      return byIntent.get(key);
    };
    for (const row of totals) bucket(row.intent).drafts = parseInt(row.drafts, 10);
    for (const row of judged) {
      const b = bucket(row.intent);
      const n = parseInt(row.count, 10);
      b.judged += n;
      b.verdicts[row.verdict] = n;
    }
    for (const row of avgScores) {
      const b = bucket(row.intent);
      b.scored = parseInt(row.scored, 10);
      b.avg = {
        voice: row.voice === null ? null : Number(Number(row.voice).toFixed(1)),
        safety: row.safety === null ? null : Number(Number(row.safety).toFixed(1)),
        actions: row.actions === null ? null : Number(Number(row.actions).toFixed(1)),
        overall: row.overall === null ? null : Number(Number(row.overall).toFixed(1)),
      };
    }

    res.json({
      generatedAt: new Date().toISOString(),
      intents: [...byIntent.values()].sort((a, b) => b.drafts - a.drafts),
    });
  } catch (err) {
    next(err);
  }
});

// GET /intent-modes — per-intent graduation state (shadow vs suggest) plus
// suggest-mode outcome telemetry (brand-voice loop Phase D). Intents are the
// union of configured rows and intents actually seen in message_drafts, so
// a brand-new intent class shows up here before anyone configures it.
router.get('/intent-modes', async (req, res, next) => {
  try {
    const suggestMode = require('../services/sms-suggest-mode');
    const [rows, seenIntents, suggestedCounts, outcomes] = await Promise.all([
      suggestMode.listIntentModes(),
      db('message_drafts').whereNotNull('intent').distinct('intent').pluck('intent'),
      db('message_drafts').where('status', suggestMode.SUGGESTED_STATUS)
        .select('intent').count('* as count').groupBy('intent'),
      db('agent_decisions').where('workflow', suggestMode.SUGGEST_WORKFLOW)
        .select('detected_intent as intent', 'status').count('* as count')
        .groupBy('detected_intent', 'status'),
    ]);

    const byIntent = new Map();
    const bucket = (intent) => {
      const key = intent || 'GENERAL';
      if (!byIntent.has(key)) {
        byIntent.set(key, {
          intent: key,
          mode: 'shadow',
          locked: suggestMode.isEscalationIntent(key),
          updatedBy: null,
          updatedAt: null,
          reason: null,
          suggest: { suggested: 0, pending: 0, accepted: 0, corrected: 0, ignored: 0, superseded: 0, expired: 0 },
        });
      }
      return byIntent.get(key);
    };

    for (const row of rows) {
      const b = bucket(row.intent);
      b.mode = b.locked ? 'shadow' : row.mode;
      b.updatedBy = row.updated_by || null;
      b.updatedAt = row.updated_at || null;
      b.reason = row.reason || null;
    }
    for (const intent of seenIntents) bucket(intent);
    for (const row of suggestedCounts) bucket(row.intent).suggest.suggested = asNumber(row.count);
    for (const row of outcomes) {
      const b = bucket(row.intent);
      const key = row.status === 'pending_review' ? 'pending' : row.status;
      if (key in b.suggest) b.suggest[key] = asNumber(row.count);
    }

    res.json({
      generatedAt: new Date().toISOString(),
      gateEnabled: require('../config/feature-gates').isEnabled('smsSuggestMode'),
      intents: [...byIntent.values()].sort((a, b) => a.intent.localeCompare(b.intent)),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /intent-modes/:intent — flip one intent between shadow and suggest.
// Escalation intents are locked server-side (validateModeChange rejects);
// every flip writes an activity_log audit row.
router.put('/intent-modes/:intent', async (req, res, next) => {
  try {
    const suggestMode = require('../services/sms-suggest-mode');
    const intent = String(req.params.intent || '').trim();
    const mode = String(req.body?.mode || '').trim();
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;

    const prior = await db('sms_intent_modes').where({ intent }).first();
    let row;
    try {
      row = await suggestMode.setIntentMode({ intent, mode, actor: actorName(req), reason });
    } catch (err) {
      if (err.statusCode === 400) return res.status(400).json({ error: err.message });
      throw err;
    }

    await db('activity_log').insert({
      admin_user_id: req.technicianId || null,
      action: 'sms_intent_mode_changed',
      description: `SMS intent "${intent}" mode: ${prior?.mode || 'shadow'} → ${mode}`,
      metadata: JSON.stringify({
        source: 'agents_hub',
        intent,
        old_mode: prior?.mode || null,
        new_mode: mode,
        reason: reason || null,
      }),
    });

    res.json({
      intent: row.intent,
      mode: row.mode,
      locked: suggestMode.isEscalationIntent(row.intent),
      updatedBy: row.updated_by || null,
      updatedAt: row.updated_at || null,
      reason: row.reason || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
