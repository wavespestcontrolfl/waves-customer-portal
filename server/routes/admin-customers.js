const express = require('express');
const router = express.Router();
const db = require('../models/db');
const LeadScorer = require('../services/lead-scorer');
const PipelineManager = require('../services/pipeline-manager');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/customers — directory + pipeline
router.get('/', async (req, res, next) => {
  try {
    const { search, stage, tier, tag, source, area, city, sort = 'lead_score', order = 'desc', page = 1, limit = 100 } = req.query;

    let query = db('customers').select(
      'customers.*',
      db.raw('(SELECT COUNT(*) FROM service_records WHERE service_records.customer_id = customers.id) as services_count'),
      db.raw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id) as last_service_date"),
      db.raw("(SELECT MIN(scheduled_date) FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND scheduled_date >= CURRENT_DATE AND status NOT IN ('cancelled','completed')) as next_service_date"),
      db.raw("(SELECT string_agg(tag, ',') FROM customer_tags WHERE customer_tags.customer_id = customers.id) as tags_str"),
      db.raw("(SELECT string_agg(DISTINCT service_type, ',') FROM service_records WHERE service_records.customer_id = customers.id) as service_types"),
      db.raw("(SELECT COUNT(DISTINCT service_type) FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND status NOT IN ('cancelled')) as service_type_count"),
      // rating column may not exist — use satisfaction_rating from treatment_outcomes or skip
      db.raw("(SELECT NULL) as last_rating"),
    );

    if (search) {
      const s = `%${search}%`;
      query = query.where(function () {
        this.whereILike('first_name', s).orWhereILike('last_name', s)
          .orWhereILike('phone', s).orWhereILike('email', s)
          .orWhereILike('address_line1', s).orWhereILike('city', s)
          .orWhereILike('company_name', s);
      });
    }
    if (stage) query = query.where('pipeline_stage', stage);
    if (tier === 'none') query = query.whereNull('waveguard_tier');
    else if (tier) query = query.where('waveguard_tier', tier);
    if (city) query = query.whereILike('city', city);
    if (source) query = query.where('lead_source', source);
    if (area) query = query.whereILike('city', `%${area}%`);
    if (tag) query = query.whereExists(function () {
      this.select('*').from('customer_tags').whereRaw('customer_tags.customer_id = customers.id').where('tag', tag);
    });

    const sortCol = { lead_score: 'lead_score', name: 'first_name', rate: 'monthly_rate', last_contact: 'last_contact_date', revenue: 'lifetime_revenue' }[sort] || 'lead_score';
    query = query.orderBy(sortCol, order === 'asc' ? 'asc' : 'desc');

    const total = await db('customers').count('* as count').first();
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const customers = await query.limit(parseInt(limit)).offset(offset);

    // Pipeline counts
    const pipelineCounts = await db('customers').select('pipeline_stage').count('* as count').groupBy('pipeline_stage');
    const pipelineMap = {};
    pipelineCounts.forEach(p => { pipelineMap[p.pipeline_stage || 'unknown'] = parseInt(p.count); });

    // Available filters
    const allTags = await db('customer_tags').select('tag').groupBy('tag').orderBy('tag');
    const allSources = await db('customers').select('lead_source').whereNotNull('lead_source').groupBy('lead_source');
    const allAreas = await db('customers').select('city').whereNotNull('city').where('city', '!=', '').groupBy('city').orderBy('city');

    res.json({
      customers: customers.map(c => ({
        id: c.id, firstName: c.first_name, lastName: c.last_name,
        email: c.email, phone: c.phone, city: c.city,
        address: `${c.address_line1 || ''}, ${c.city || ''}, ${c.state || ''} ${c.zip || ''}`.trim(),
        tier: c.waveguard_tier, monthlyRate: parseFloat(c.monthly_rate || 0),
        memberSince: c.member_since, active: c.active,
        pipelineStage: c.pipeline_stage, leadScore: c.lead_score,
        leadSource: c.lead_source, leadSourceDetail: c.lead_source_detail,
        landingPageUrl: c.landing_page_url, companyName: c.company_name,
        propertyType: c.property_type,
        lastContactDate: c.last_contact_date, lastContactType: c.last_contact_type,
        nextFollowUp: c.next_follow_up_date,
        lifetimeRevenue: parseFloat(c.lifetime_revenue || 0),
        totalServices: parseInt(c.total_services || c.services_count || 0),
        lastServiceDate: c.last_service_date, nextServiceDate: c.next_service_date,
        serviceTypes: c.service_types || '',
        serviceCount: parseInt(c.service_type_count || 0),
        lastRating: c.last_rating != null ? parseInt(c.last_rating) : null,
        tags: (c.tags_str || '').split(',').filter(Boolean),
        onboardingComplete: c.onboarding_complete,
      })),
      total: parseInt(total.count), page: parseInt(page), limit: parseInt(limit),
      totalPages: Math.ceil(parseInt(total.count) / parseInt(limit)),
      pipelineCounts: pipelineMap,
      filters: {
        tags: allTags.map(t => t.tag),
        sources: allSources.map(s => s.lead_source).filter(Boolean),
        areas: allAreas.map(a => a.city).filter(Boolean),
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/pipeline — kanban view
router.get('/pipeline/view', async (req, res, next) => {
  try {
    const stages = ['new_lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'follow_up', 'negotiating', 'won', 'active_customer', 'at_risk', 'churned', 'lost', 'dormant'];
    const result = {};

    for (const stage of stages) {
      const customers = await db('customers')
        .where({ pipeline_stage: stage })
        .leftJoin('customer_tags', 'customers.id', 'customer_tags.customer_id')
        .select('customers.*')
        .groupBy('customers.id')
        .orderBy('lead_score', 'desc')
        .limit(20);

      const monthlyTotal = customers.reduce((s, c) => s + parseFloat(c.monthly_rate || 0), 0);

      result[stage] = {
        count: customers.length,
        monthlyRevenue: monthlyTotal,
        customers: customers.map(c => ({
          id: c.id, name: `${c.first_name} ${c.last_name}`,
          address: `${c.address_line1 || ''}, ${c.city || ''}`,
          phone: c.phone, tier: c.waveguard_tier,
          monthlyRate: parseFloat(c.monthly_rate || 0),
          leadScore: c.lead_score, leadSource: c.lead_source,
          pipelineStageChangedAt: c.pipeline_stage_changed_at,
          nextFollowUp: c.next_follow_up_date,
        })),
      };
    }

    res.json({ pipeline: result });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/sync-square — pull service history from Square
router.post('/:id/sync-square', async (req, res, next) => {
  try {
    const SquareHistorySync = require('../services/square-history-sync');
    const result = await SquareHistorySync.syncCustomer(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/customers/:id/timeline — unified customer timeline
router.get('/:id/timeline', async (req, res, next) => {
  try {
    const customerId = req.params.id;
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const timeline = [];

    // customer_interactions
    const interactions = await db('customer_interactions').where({ customer_id: customerId }).select('interaction_type', 'subject', 'body', 'created_at');
    for (const i of interactions) {
      timeline.push({
        type: 'interaction', title: i.subject || `${i.interaction_type} interaction`,
        description: i.body || '', date: i.created_at,
        metadata: { interactionType: i.interaction_type },
      });
    }

    // sms_log
    const smsLogs = await db('sms_log').where({ customer_id: customerId }).select('direction', 'message_body', 'created_at');
    for (const s of smsLogs) {
      timeline.push({
        type: 'sms', title: `SMS ${s.direction === 'inbound' ? 'received' : 'sent'}`,
        description: (s.message_body || '').slice(0, 200), date: s.created_at,
        metadata: { direction: s.direction },
      });
    }

    // call_log
    try {
      const calls = await db('call_log').where({ customer_id: customerId }).select('from_phone', 'duration_seconds', 'call_summary', 'created_at');
      for (const c of calls) {
        timeline.push({
          type: 'call', title: 'Phone call',
          description: c.call_summary || `Call from ${c.from_phone}`, date: c.created_at,
          metadata: { fromPhone: c.from_phone, durationSeconds: c.duration_seconds },
        });
      }
    } catch { /* call_log table may not exist */ }

    // service_records
    const services = await db('service_records')
      .where({ 'service_records.customer_id': customerId })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.service_type', 'service_records.service_date', 'technicians.name as tech_name');
    for (const s of services) {
      timeline.push({
        type: 'service', title: `Service: ${s.service_type}`,
        description: s.tech_name ? `Performed by ${s.tech_name}` : 'Service completed',
        date: s.service_date, metadata: { serviceType: s.service_type, techName: s.tech_name },
      });
    }

    // payments
    const payments = await db('payments').where({ customer_id: customerId }).select('amount', 'payment_date', 'description');
    for (const p of payments) {
      timeline.push({
        type: 'payment', title: `Payment: $${parseFloat(p.amount || 0).toFixed(2)}`,
        description: p.description || 'Payment received', date: p.payment_date,
        metadata: { amount: parseFloat(p.amount || 0) },
      });
    }

    // scheduled_services
    const scheduled = await db('scheduled_services').where({ customer_id: customerId }).select('service_type', 'scheduled_date', 'status');
    for (const s of scheduled) {
      timeline.push({
        type: 'scheduled_service', title: `Scheduled: ${s.service_type}`,
        description: `Status: ${s.status}`, date: s.scheduled_date,
        metadata: { serviceType: s.service_type, status: s.status },
      });
    }

    // google_reviews
    try {
      const reviews = await db('google_reviews').where({ customer_id: customerId }).select('star_rating', 'review_text', 'review_created_at');
      for (const r of reviews) {
        timeline.push({
          type: 'review', title: `Google Review: ${'★'.repeat(r.star_rating)}${'☆'.repeat(5 - r.star_rating)}`,
          description: (r.review_text || '').slice(0, 200), date: r.review_created_at,
          metadata: { starRating: r.star_rating },
        });
      }
    } catch { /* google_reviews may not have customer_id */ }

    // activity_log
    try {
      const activities = await db('activity_log').where({ customer_id: customerId }).select('action', 'description', 'created_at');
      for (const a of activities) {
        timeline.push({
          type: 'activity', title: a.action, description: a.description || '',
          date: a.created_at, metadata: { action: a.action },
        });
      }
    } catch { /* ignore */ }

    // Sort by date descending
    timeline.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    res.json({ timeline });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id — full detail
router.get('/:id', async (req, res, next) => {
  try {
    const c = await db('customers').where({ id: req.params.id }).first();
    if (!c) return res.status(404).json({ error: 'Customer not found' });

    const [tags, interactions, prefs, services, estimates, payments, scheduled, smsLog] = await Promise.all([
      db('customer_tags').where({ customer_id: c.id }).select('tag'),
      db('customer_interactions').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(30),
      db('property_preferences').where({ customer_id: c.id }).first(),
      db('service_records').where({ customer_id: c.id }).orderBy('service_date', 'desc').limit(20),
      db('estimates').where({ customer_id: c.id }).orderBy('created_at', 'desc'),
      db('payments').where({ 'payments.customer_id': c.id }).leftJoin('payment_methods', 'payments.payment_method_id', 'payment_methods.id').select('payments.*', 'payment_methods.card_brand', 'payment_methods.last_four').orderBy('payment_date', 'desc').limit(20),
      db('scheduled_services').where({ customer_id: c.id }).orderBy('scheduled_date').limit(10),
      db('sms_log').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(20),
    ]);

    res.json({
      customer: {
        id: c.id, firstName: c.first_name, lastName: c.last_name,
        email: c.email, phone: c.phone, secondaryPhone: c.secondary_phone,
        secondaryContact: c.secondary_contact_name, companyName: c.company_name,
        address: { line1: c.address_line1, city: c.city, state: c.state, zip: c.zip },
        property: { type: c.property_type, lawnType: c.lawn_type, sqft: c.property_sqft, lotSqft: c.lot_sqft, palmCount: c.palm_count },
        tier: c.waveguard_tier, monthlyRate: parseFloat(c.monthly_rate || 0),
        memberSince: c.member_since, active: c.active,
        pipelineStage: c.pipeline_stage, leadScore: c.lead_score,
        leadSource: c.lead_source, leadSourceDetail: c.lead_source_detail,
        landingPageUrl: c.landing_page_url,
        assignedTo: c.assigned_to, lastContactDate: c.last_contact_date,
        nextFollowUp: c.next_follow_up_date, followUpNotes: c.follow_up_notes,
        lifetimeRevenue: parseFloat(c.lifetime_revenue || 0),
        annualValue: parseFloat(c.monthly_rate || 0) * 12,
        totalServices: c.total_services,
        referralCode: c.referral_code, crmNotes: c.crm_notes,
      },
      tags: tags.map(t => t.tag),
      interactions, preferences: prefs, services, estimates, payments, scheduled, smsLog,
    });
  } catch (err) { next(err); }
});

// POST /api/admin/customers — create
router.post('/', async (req, res, next) => {
  try {
    const { firstName, lastName, phone, email, addressLine1, city, state, zip, tier, monthlyRate, leadSource, pipelineStage, tags, notes, companyName, propertyType } = req.body;
    if (!firstName || !lastName || !phone) return res.status(400).json({ error: 'Name and phone required' });

    const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

    const [customer] = await db('customers').insert({
      first_name: firstName, last_name: lastName, phone, email,
      address_line1: addressLine1 || '', city: city || '', state: state || 'FL', zip: zip || '',
      waveguard_tier: tier || null, monthly_rate: monthlyRate || 0,
      member_since: new Date().toISOString().split('T')[0],
      referral_code: code, lead_source: leadSource,
      pipeline_stage: pipelineStage || 'new_lead',
      pipeline_stage_changed_at: new Date(),
      assigned_to: req.technicianId,
      company_name: companyName, property_type: propertyType, crm_notes: notes,
    }).returning('*');

    await db('property_preferences').insert({ customer_id: customer.id });
    await db('notification_prefs').insert({ customer_id: customer.id });

    if (tags?.length) {
      for (const tag of tags) {
        await db('customer_tags').insert({ customer_id: customer.id, tag }).onConflict(['customer_id', 'tag']).ignore();
      }
    }

    await PipelineManager.onEvent(customer.id, 'lead_created');
    await LeadScorer.calculateScore(customer.id);

    res.status(201).json({ id: customer.id, referralCode: code });
  } catch (err) { next(err); }
});

// PUT /api/admin/customers/:id
router.put('/:id', async (req, res, next) => {
  try {
    const fields = { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', addressLine1: 'address_line1', city: 'city', state: 'state', zip: 'zip', tier: 'waveguard_tier', monthlyRate: 'monthly_rate', active: 'active', leadSource: 'lead_source', companyName: 'company_name', propertyType: 'property_type', crmNotes: 'crm_notes', nextFollowUpDate: 'next_follow_up_date', followUpNotes: 'follow_up_notes', secondaryPhone: 'secondary_phone', secondaryContactName: 'secondary_contact_name', pipelineStage: 'pipeline_stage' };
    const updates = {};
    for (const [k, v] of Object.entries(fields)) {
      if (req.body[k] !== undefined) {
        // Handle empty strings for numeric/date fields
        if (v === 'monthly_rate') { updates[v] = req.body[k] === '' ? 0 : parseFloat(req.body[k]) || 0; }
        else if (v === 'next_follow_up_date') { updates[v] = req.body[k] || null; }
        else { updates[v] = req.body[k]; }
      }
    }
    if (Object.keys(updates).length) await db('customers').where({ id: req.params.id }).update(updates);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PUT /api/admin/customers/:id/stage
router.put('/:id/stage', async (req, res, next) => {
  try {
    const { stage, notes } = req.body;
    const customer = await db('customers').where({ id: req.params.id }).first();
    const oldStage = customer.pipeline_stage;
    await db('customers').where({ id: req.params.id }).update({ pipeline_stage: stage, pipeline_stage_changed_at: new Date() });
    if (stage === 'churned' && req.body.churnReason) {
      await db('customers').where({ id: req.params.id }).update({ churned_at: new Date(), churn_reason: req.body.churnReason });
    }
    await db('customer_interactions').insert({
      customer_id: req.params.id, interaction_type: 'note',
      subject: `Stage changed: ${oldStage} → ${stage}`,
      body: notes || '', admin_user_id: req.technicianId,
    });

    // Email automations are manual-only for now (triggered from Communications → Email Automations tab)
    // Future: auto-trigger based on Square service bookings

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/tags
router.post('/:id/tags', async (req, res, next) => {
  try {
    await db('customer_tags').insert({ customer_id: req.params.id, tag: req.body.tag }).onConflict(['customer_id', 'tag']).ignore();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/customers/:id/tags/:tag
router.delete('/:id/tags/:tag', async (req, res, next) => {
  try {
    await db('customer_tags').where({ customer_id: req.params.id, tag: req.params.tag }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/interactions
router.post('/:id/interactions', async (req, res, next) => {
  try {
    const { type, subject, body } = req.body;
    await db('customer_interactions').insert({
      customer_id: req.params.id, interaction_type: type || 'note',
      subject, body, admin_user_id: req.technicianId,
    });
    await db('customers').where({ id: req.params.id }).update({ last_contact_date: new Date(), last_contact_type: type || 'note' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/follow-up
router.post('/:id/follow-up', async (req, res, next) => {
  try {
    await db('customers').where({ id: req.params.id }).update({
      next_follow_up_date: req.body.date, follow_up_notes: req.body.notes,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/sync-square — pull all customers from Square
router.post('/sync-square', async (req, res, next) => {
  try {
    const SquareCustomerSync = require('../services/square-customer-sync');
    const result = await SquareCustomerSync.sync();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/customers/:id — delete a customer and related records
router.delete('/:id', async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Delete related records (cascade should handle most, but be explicit)
    await db('estimates').where({ customer_id: req.params.id }).del().catch(() => {});
    await db('scheduled_services').where({ customer_id: req.params.id }).del().catch(() => {});
    await db('payments').where({ customer_id: req.params.id }).del().catch(() => {});
    await db('service_records').where({ customer_id: req.params.id }).del().catch(() => {});
    await db('property_preferences').where({ customer_id: req.params.id }).del().catch(() => {});
    await db('notification_prefs').where({ customer_id: req.params.id }).del().catch(() => {});
    await db('customer_interactions').where({ customer_id: req.params.id }).del().catch(() => {});
    await db('customer_tags').where({ customer_id: req.params.id }).del().catch(() => {});
    await db('activity_log').where({ customer_id: req.params.id }).del().catch(() => {});
    await db('sms_log').where({ customer_id: req.params.id }).del().catch(() => {});
    await db('notifications').where({ recipient_id: req.params.id }).del().catch(() => {});

    await db('customers').where({ id: req.params.id }).del();
    logger.info(`[customers] Deleted customer ${customer.first_name} ${customer.last_name} (${req.params.id})`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/fix-tiers — Recalculate tiers from service count
router.post('/fix-tiers', async (req, res, next) => {
  try {
    const customers = await db('customers')
      .select('customers.id', 'customers.waveguard_tier')
      .whereIn('customers.pipeline_stage', ['active_customer', 'won']);

    let updated = 0;
    for (const c of customers) {
      // Count distinct recurring service types for this customer
      const services = await db('scheduled_services')
        .where({ customer_id: c.id })
        .whereIn('status', ['scheduled', 'confirmed', 'completed'])
        .countDistinct('service_type as count')
        .first();

      const count = parseInt(services?.count || 0);
      let newTier = null;
      if (count === 0) newTier = null;
      else if (count === 1) newTier = 'Bronze';
      else if (count === 2) newTier = 'Silver';
      else if (count === 3) newTier = 'Gold';
      else newTier = 'Platinum';

      if (newTier !== c.waveguard_tier) {
        await db('customers').where({ id: c.id }).update({ waveguard_tier: newTier });
        updated++;
      }
    }

    logger.info(`[customers] Fix tiers: ${updated} of ${customers.length} customers updated`);
    res.json({ success: true, updated, total: customers.length });
  } catch (err) { next(err); }
});

module.exports = router;
