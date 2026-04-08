const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const leadAttribution = require('../services/lead-attribution');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// ═══════════════════════════════════════════════════════════════════════════
// ANALYTICS (must be before /:id to avoid param catch)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin/leads/analytics/overview — top-level funnel stats
router.get('/analytics/overview', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const start = start_date ? new Date(start_date) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const end = end_date ? new Date(end_date) : new Date();

    const leads = await db('leads')
      .where('first_contact_at', '>=', start)
      .where('first_contact_at', '<=', end);

    const total = leads.length;
    const won = leads.filter(l => l.status === 'won').length;
    const lost = leads.filter(l => l.status === 'lost').length;
    const active = leads.filter(l => !['won', 'lost', 'disqualified', 'duplicate'].includes(l.status)).length;
    const conversionRate = total > 0 ? Math.round(won / total * 1000) / 10 : 0;

    const responded = leads.filter(l => l.response_time_minutes != null);
    const avgResponseTime = responded.length > 0
      ? Math.round(responded.reduce((s, l) => s + l.response_time_minutes, 0) / responded.length)
      : null;

    const totalCosts = await db('lead_source_costs')
      .where('month', '>=', start)
      .where('month', '<=', end)
      .sum('cost_amount as total')
      .first();

    let costTotal = parseFloat(totalCosts?.total || 0);
    if (costTotal === 0) {
      const sources = await db('lead_sources').where('is_active', true);
      const months = Math.max(1, Math.ceil((new Date(end) - new Date(start)) / (30 * 86400000)));
      costTotal = sources.reduce((s, src) => s + parseFloat(src.monthly_cost || 0), 0) * months;
    }

    let revenue = 0;
    const wonLeads = leads.filter(l => l.status === 'won');
    for (const l of wonLeads) {
      revenue += parseFloat(l.initial_service_value || 0) + parseFloat(l.monthly_value || 0);
    }

    const cpa = won > 0 ? Math.round(costTotal / won * 100) / 100 : 0;
    const roi = costTotal > 0 ? Math.round((revenue - costTotal) / costTotal * 1000) / 10 : 0;

    res.json({
      total, won, lost, active, conversionRate,
      avgResponseTime, costTotal: Math.round(costTotal * 100) / 100,
      revenue: Math.round(revenue * 100) / 100, cpa, roi,
      startDate: start, endDate: end,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/leads/analytics/by-source — ROI per source
router.get('/analytics/by-source', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const results = await leadAttribution.calculateAllSourceROI(
      start_date ? new Date(start_date) : undefined,
      end_date ? new Date(end_date) : undefined,
    );
    res.json({ sources: results });
  } catch (err) { next(err); }
});

// GET /api/admin/leads/analytics/by-channel — ROI aggregated by channel
router.get('/analytics/by-channel', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const allROI = await leadAttribution.calculateAllSourceROI(
      start_date ? new Date(start_date) : undefined,
      end_date ? new Date(end_date) : undefined,
    );

    const byChannel = {};
    for (const r of allROI) {
      const ch = r.source.channel || 'Other';
      if (!byChannel[ch]) {
        byChannel[ch] = { channel: ch, totalLeads: 0, conversions: 0, totalCost: 0, totalRevenue: 0, sources: 0 };
      }
      byChannel[ch].totalLeads += r.totalLeads;
      byChannel[ch].conversions += r.conversions;
      byChannel[ch].totalCost += r.totalCost;
      byChannel[ch].totalRevenue += r.totalRevenue;
      byChannel[ch].sources += 1;
    }

    const channels = Object.values(byChannel).map(ch => ({
      ...ch,
      conversionRate: ch.totalLeads > 0 ? Math.round(ch.conversions / ch.totalLeads * 1000) / 10 : 0,
      costPerLead: ch.totalLeads > 0 ? Math.round(ch.totalCost / ch.totalLeads * 100) / 100 : 0,
      costPerAcquisition: ch.conversions > 0 ? Math.round(ch.totalCost / ch.conversions * 100) / 100 : 0,
      roi: ch.totalCost > 0 ? Math.round((ch.totalRevenue - ch.totalCost) / ch.totalCost * 1000) / 10 : 0,
    }));

    res.json({ channels });
  } catch (err) { next(err); }
});

// GET /api/admin/leads/analytics/funnel — funnel stage counts
router.get('/analytics/funnel', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const start = start_date ? new Date(start_date) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const end = end_date ? new Date(end_date) : new Date();

    const stages = await db('leads')
      .select('status')
      .count('* as count')
      .where('first_contact_at', '>=', start)
      .where('first_contact_at', '<=', end)
      .groupBy('status');

    const stageMap = {};
    for (const s of stages) stageMap[s.status] = parseInt(s.count, 10);

    const funnel = [
      { stage: 'new', label: 'New Leads', count: stageMap.new || 0 },
      { stage: 'contacted', label: 'Contacted', count: stageMap.contacted || 0 },
      { stage: 'estimate_sent', label: 'Estimate Sent', count: (stageMap.estimate_sent || 0) + (stageMap.estimate_viewed || 0) },
      { stage: 'negotiating', label: 'Negotiating', count: stageMap.negotiating || 0 },
      { stage: 'won', label: 'Won', count: stageMap.won || 0 },
      { stage: 'lost', label: 'Lost', count: stageMap.lost || 0 },
      { stage: 'unresponsive', label: 'Unresponsive', count: stageMap.unresponsive || 0 },
      { stage: 'disqualified', label: 'Disqualified', count: stageMap.disqualified || 0 },
    ];

    const totalEntering = (stageMap.new || 0) + (stageMap.contacted || 0) + (stageMap.estimate_sent || 0)
      + (stageMap.estimate_viewed || 0) + (stageMap.negotiating || 0)
      + (stageMap.won || 0) + (stageMap.lost || 0) + (stageMap.unresponsive || 0) + (stageMap.disqualified || 0) + (stageMap.duplicate || 0);

    res.json({ funnel, totalEntering });
  } catch (err) { next(err); }
});

// GET /api/admin/leads/analytics/response — response time vs conversion
router.get('/analytics/response', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const start = start_date ? new Date(start_date) : new Date(new Date().getFullYear(), 0, 1);
    const end = end_date ? new Date(end_date) : new Date();

    const leads = await db('leads')
      .whereNotNull('response_time_minutes')
      .where('first_contact_at', '>=', start)
      .where('first_contact_at', '<=', end);

    const buckets = [
      { label: '<5 min', min: 0, max: 5, total: 0, won: 0 },
      { label: '5-15 min', min: 5, max: 15, total: 0, won: 0 },
      { label: '15-30 min', min: 15, max: 30, total: 0, won: 0 },
      { label: '30-60 min', min: 30, max: 60, total: 0, won: 0 },
      { label: '1-4 hr', min: 60, max: 240, total: 0, won: 0 },
      { label: '4-24 hr', min: 240, max: 1440, total: 0, won: 0 },
      { label: '24+ hr', min: 1440, max: Infinity, total: 0, won: 0 },
    ];

    for (const lead of leads) {
      const m = lead.response_time_minutes;
      for (const b of buckets) {
        if (m >= b.min && m < b.max) {
          b.total++;
          if (lead.status === 'won') b.won++;
          break;
        }
      }
    }

    const result = buckets.map(b => ({
      label: b.label,
      total: b.total,
      won: b.won,
      conversionRate: b.total > 0 ? Math.round(b.won / b.total * 1000) / 10 : 0,
    }));

    res.json({ buckets: result });
  } catch (err) { next(err); }
});

// GET /api/admin/leads/analytics/lost — lost reasons analysis
router.get('/analytics/lost', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const start = start_date ? new Date(start_date) : new Date(new Date().getFullYear(), 0, 1);
    const end = end_date ? new Date(end_date) : new Date();

    const reasons = await db('leads')
      .select('lost_reason')
      .count('* as count')
      .where('status', 'lost')
      .where('first_contact_at', '>=', start)
      .where('first_contact_at', '<=', end)
      .groupBy('lost_reason')
      .orderBy('count', 'desc');

    const competitors = await db('leads')
      .select('lost_to_competitor')
      .count('* as count')
      .where('status', 'lost')
      .whereNotNull('lost_to_competitor')
      .where('first_contact_at', '>=', start)
      .where('first_contact_at', '<=', end)
      .groupBy('lost_to_competitor')
      .orderBy('count', 'desc');

    res.json({
      reasons: reasons.map(r => ({ reason: r.lost_reason || 'Not specified', count: parseInt(r.count, 10) })),
      competitors: competitors.map(c => ({ competitor: c.lost_to_competitor, count: parseInt(c.count, 10) })),
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE MANAGEMENT (must be before /:id)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin/leads/sources — all sources with current month lead count
router.get('/sources', async (req, res, next) => {
  try {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const sources = await db('lead_sources')
      .select(
        'lead_sources.*',
        db.raw(`(SELECT COUNT(*) FROM leads WHERE leads.lead_source_id = lead_sources.id AND leads.first_contact_at >= ?) as month_leads`, [monthStart]),
        db.raw(`(SELECT COUNT(*) FROM leads WHERE leads.lead_source_id = lead_sources.id AND leads.status = 'won' AND leads.first_contact_at >= ?) as month_conversions`, [monthStart]),
        db.raw(`(SELECT COUNT(*) FROM leads WHERE leads.lead_source_id = lead_sources.id) as total_leads`),
        db.raw(`(SELECT COUNT(*) FROM leads WHERE leads.lead_source_id = lead_sources.id AND leads.status = 'won') as total_conversions`),
      )
      .orderBy('name');

    res.json({ sources });
  } catch (err) { next(err); }
});

// GET /api/admin/leads/sources/:id — source detail with ROI
router.get('/sources/:id', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const roi = await leadAttribution.calculateSourceROI(
      req.params.id,
      start_date ? new Date(start_date) : undefined,
      end_date ? new Date(end_date) : undefined,
    );
    if (!roi) return res.status(404).json({ error: 'Source not found' });

    const recentLeads = await db('leads')
      .where('lead_source_id', req.params.id)
      .orderBy('first_contact_at', 'desc')
      .limit(20);

    res.json({ ...roi, recentLeads });
  } catch (err) { next(err); }
});

// POST /api/admin/leads/sources — create source
router.post('/sources', async (req, res, next) => {
  try {
    const {
      name, source_type, channel, twilio_phone_number, twilio_phone_sid,
      domain, landing_page_url, gbp_location_id, cost_type,
      monthly_cost, cost_per_lead, setup_cost, notes,
    } = req.body;

    const [source] = await db('lead_sources').insert({
      name, source_type, channel,
      twilio_phone_number: twilio_phone_number ? leadAttribution.normalizePhone(twilio_phone_number) : null,
      twilio_phone_sid, domain, landing_page_url, gbp_location_id,
      cost_type: cost_type || 'free',
      monthly_cost: monthly_cost || 0,
      cost_per_lead: cost_per_lead || 0,
      setup_cost: setup_cost || 0,
      notes,
    }).returning('*');

    res.json({ source });
  } catch (err) { next(err); }
});

// PUT /api/admin/leads/sources/:id — update source
router.put('/sources/:id', async (req, res, next) => {
  try {
    const allowed = [
      'name', 'source_type', 'channel', 'twilio_phone_number', 'twilio_phone_sid',
      'domain', 'landing_page_url', 'gbp_location_id', 'cost_type',
      'monthly_cost', 'cost_per_lead', 'setup_cost', 'is_active', 'notes',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.twilio_phone_number) updates.twilio_phone_number = leadAttribution.normalizePhone(updates.twilio_phone_number);
    updates.updated_at = new Date();

    const [source] = await db('lead_sources').where('id', req.params.id).update(updates).returning('*');
    if (!source) return res.status(404).json({ error: 'Source not found' });
    res.json({ source });
  } catch (err) { next(err); }
});

// POST /api/admin/leads/sources/:id/cost — log monthly cost
router.post('/sources/:id/cost', async (req, res, next) => {
  try {
    const { month, cost_amount, cost_category, notes } = req.body;
    const [cost] = await db('lead_source_costs').insert({
      lead_source_id: req.params.id,
      month: month || new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      cost_amount: cost_amount || 0,
      cost_category: cost_category || 'monthly_fee',
      notes,
    }).returning('*').onConflict(['lead_source_id', 'month', 'cost_category']).merge();

    res.json({ cost });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CAMPAIGN MANAGEMENT (must be before /:id)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin/leads/campaigns — all campaigns
router.get('/campaigns', async (req, res, next) => {
  try {
    const campaigns = await db('marketing_campaigns')
      .leftJoin('lead_sources', 'marketing_campaigns.lead_source_id', 'lead_sources.id')
      .select(
        'marketing_campaigns.*',
        'lead_sources.name as source_name',
      )
      .orderBy('marketing_campaigns.created_at', 'desc');

    for (const c of campaigns) {
      if (c.lead_source_id && c.start_date) {
        const q = db('leads').where('lead_source_id', c.lead_source_id);
        if (c.start_date) q.where('first_contact_at', '>=', c.start_date);
        if (c.end_date) q.where('first_contact_at', '<=', c.end_date);
        const leads = await q;
        c.actual_leads = leads.length;
        c.actual_conversions = leads.filter(l => l.status === 'won').length;
      } else {
        c.actual_leads = 0;
        c.actual_conversions = 0;
      }
    }

    res.json({ campaigns });
  } catch (err) { next(err); }
});

// POST /api/admin/leads/campaigns — create campaign
router.post('/campaigns', async (req, res, next) => {
  try {
    const {
      name, channel, lead_source_id, start_date, end_date,
      budget, target_leads, target_conversions, offer_details,
      utm_source, utm_medium, utm_campaign, notes,
    } = req.body;

    const [campaign] = await db('marketing_campaigns').insert({
      name, channel, lead_source_id: lead_source_id || null,
      start_date, end_date, budget: budget || 0,
      target_leads, target_conversions, offer_details,
      utm_source, utm_medium, utm_campaign, notes,
    }).returning('*');

    res.json({ campaign });
  } catch (err) { next(err); }
});

// PUT /api/admin/leads/campaigns/:id — update campaign
router.put('/campaigns/:id', async (req, res, next) => {
  try {
    const allowed = [
      'name', 'channel', 'lead_source_id', 'status', 'start_date', 'end_date',
      'budget', 'spend_to_date', 'target_leads', 'target_conversions',
      'offer_details', 'utm_source', 'utm_medium', 'utm_campaign', 'notes',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date();

    const [campaign] = await db('marketing_campaigns').where('id', req.params.id).update(updates).returning('*');
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
// LEAD MANAGEMENT (/:id routes last to avoid catching /sources, /campaigns, /analytics)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin/leads — paginated list with filters
router.get('/', async (req, res, next) => {
  try {
    const {
      status, source, channel, search, sort = 'first_contact_at',
      order = 'desc', page = 1, limit = 50, start_date, end_date,
    } = req.query;

    let query = db('leads')
      .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
      .leftJoin('technicians', 'leads.assigned_to', 'technicians.id')
      .select(
        'leads.*',
        'lead_sources.name as source_name',
        'lead_sources.source_type',
        'lead_sources.channel as source_channel',
        db.raw("COALESCE(technicians.first_name || ' ' || technicians.last_name, NULL) as assigned_name"),
      );

    if (status) query = query.where('leads.status', status);
    if (source) query = query.where('leads.lead_source_id', source);
    if (channel) query = query.where('lead_sources.channel', channel);
    if (start_date) query = query.where('leads.first_contact_at', '>=', start_date);
    if (end_date) query = query.where('leads.first_contact_at', '<=', end_date);
    if (search) {
      const s = `%${search}%`;
      query = query.where(function () {
        this.whereILike('leads.first_name', s)
          .orWhereILike('leads.last_name', s)
          .orWhereILike('leads.phone', s)
          .orWhereILike('leads.email', s)
          .orWhereILike('leads.address', s)
          .orWhereILike('leads.service_interest', s);
      });
    }

    const validSorts = {
      first_contact_at: 'leads.first_contact_at',
      name: 'leads.first_name',
      status: 'leads.status',
      response_time: 'leads.response_time_minutes',
      monthly_value: 'leads.monthly_value',
    };
    const sortCol = validSorts[sort] || 'leads.first_contact_at';

    const pg = parseInt(page, 10) || 1;
    const lim = Math.min(parseInt(limit, 10) || 50, 200);

    const countQuery = db('leads')
      .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id');
    if (status) countQuery.where('leads.status', status);
    if (source) countQuery.where('leads.lead_source_id', source);
    if (channel) countQuery.where('lead_sources.channel', channel);
    if (start_date) countQuery.where('leads.first_contact_at', '>=', start_date);
    if (end_date) countQuery.where('leads.first_contact_at', '<=', end_date);
    if (search) {
      const s = `%${search}%`;
      countQuery.where(function () {
        this.whereILike('leads.first_name', s)
          .orWhereILike('leads.last_name', s)
          .orWhereILike('leads.phone', s)
          .orWhereILike('leads.email', s);
      });
    }
    const { count } = await countQuery.count('* as count').first();

    const leads = await query
      .orderBy(sortCol, order === 'asc' ? 'asc' : 'desc')
      .limit(lim)
      .offset((pg - 1) * lim);

    res.json({ leads, total: parseInt(count, 10), page: pg, limit: lim });
  } catch (err) { next(err); }
});

// POST /api/admin/leads — create lead manually
router.post('/', async (req, res, next) => {
  try {
    const {
      first_name, last_name, phone, email, address, city, zip,
      lead_source_id, lead_type, service_interest, urgency,
      is_residential, is_commercial, notes,
    } = req.body;

    const [lead] = await db('leads').insert({
      first_name, last_name,
      phone: leadAttribution.normalizePhone(phone),
      email, address, city, zip,
      lead_source_id: lead_source_id || null,
      lead_type: lead_type || 'walk_in',
      service_interest, urgency: urgency || 'normal',
      is_residential: is_residential !== false,
      is_commercial: is_commercial === true,
      first_contact_at: new Date(),
      first_contact_channel: 'manual',
      status: 'new',
    }).returning('*');

    await db('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'created',
      description: `Lead created manually by ${req.technician.first_name}`,
      performed_by: req.technician.first_name + ' ' + (req.technician.last_name || ''),
      metadata: notes ? JSON.stringify({ notes }) : null,
    });

    res.json({ lead });
  } catch (err) { next(err); }
});

// GET /api/admin/leads/:id — single lead with activities
router.get('/:id', async (req, res, next) => {
  try {
    const lead = await db('leads')
      .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
      .leftJoin('technicians', 'leads.assigned_to', 'technicians.id')
      .select(
        'leads.*',
        'lead_sources.name as source_name',
        'lead_sources.source_type',
        'lead_sources.channel as source_channel',
        db.raw("COALESCE(technicians.first_name || ' ' || technicians.last_name, NULL) as assigned_name"),
      )
      .where('leads.id', req.params.id)
      .first();

    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const activities = await db('lead_activities')
      .where('lead_id', req.params.id)
      .orderBy('created_at', 'desc');

    res.json({ lead, activities });
  } catch (err) { next(err); }
});

// PUT /api/admin/leads/:id — update lead
router.put('/:id', async (req, res, next) => {
  try {
    const allowed = [
      'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'zip',
      'lead_source_id', 'lead_type', 'service_interest', 'urgency',
      'is_residential', 'is_commercial', 'status', 'is_qualified',
      'disqualification_reason', 'assigned_to', 'estimate_id', 'customer_id',
      'monthly_value', 'initial_service_value', 'waveguard_tier',
      'next_follow_up_at', 'notes',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.phone) updates.phone = leadAttribution.normalizePhone(updates.phone);
    updates.updated_at = new Date();

    const [lead] = await db('leads').where('id', req.params.id).update(updates).returning('*');
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    await db('lead_activities').insert({
      lead_id: req.params.id,
      activity_type: 'updated',
      description: `Lead updated: ${Object.keys(updates).filter(k => k !== 'updated_at').join(', ')}`,
      performed_by: req.technician.first_name + ' ' + (req.technician.last_name || ''),
      metadata: JSON.stringify(updates),
    });

    res.json({ lead });
  } catch (err) { next(err); }
});

// POST /api/admin/leads/:id/activity — log activity
router.post('/:id/activity', async (req, res, next) => {
  try {
    const { activity_type, description, metadata } = req.body;
    const [activity] = await db('lead_activities').insert({
      lead_id: req.params.id,
      activity_type: activity_type || 'note',
      description: description || '',
      performed_by: req.technician.first_name + ' ' + (req.technician.last_name || ''),
      metadata: metadata ? JSON.stringify(metadata) : null,
    }).returning('*');
    res.json({ activity });
  } catch (err) { next(err); }
});

// POST /api/admin/leads/:id/convert — convert to customer
router.post('/:id/convert', async (req, res, next) => {
  try {
    const { customer_id, monthly_value, initial_service_value, waveguard_tier } = req.body;
    await leadAttribution.markConverted(req.params.id, {
      customerId: customer_id,
      monthlyValue: monthly_value,
      initialServiceValue: initial_service_value,
      waveguardTier: waveguard_tier,
    });
    const lead = await db('leads').where('id', req.params.id).first();
    res.json({ lead });
  } catch (err) { next(err); }
});

// POST /api/admin/leads/:id/lost — mark lost
router.post('/:id/lost', async (req, res, next) => {
  try {
    const { reason, competitor, notes } = req.body;
    await leadAttribution.markLost(req.params.id, { reason, competitor, notes });
    const lead = await db('leads').where('id', req.params.id).first();
    res.json({ lead });
  } catch (err) { next(err); }
});

// POST /api/admin/leads/:id/assign — assign to tech
router.post('/:id/assign', async (req, res, next) => {
  try {
    const { technician_id } = req.body;
    const [lead] = await db('leads').where('id', req.params.id).update({
      assigned_to: technician_id,
      updated_at: new Date(),
    }).returning('*');

    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const tech = technician_id ? await db('technicians').where('id', technician_id).first() : null;

    await db('lead_activities').insert({
      lead_id: req.params.id,
      activity_type: 'assigned',
      description: `Assigned to ${tech ? tech.first_name + ' ' + (tech.last_name || '') : 'unassigned'}`,
      performed_by: req.technician.first_name + ' ' + (req.technician.last_name || ''),
    });

    if (lead.response_time_minutes == null) {
      await leadAttribution.logFirstResponse(req.params.id);
    }

    res.json({ lead });
  } catch (err) { next(err); }
});

module.exports = router;
