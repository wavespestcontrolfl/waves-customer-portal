const express = require('express');
const router = express.Router();
const db = require('../models/db');
const LeadScorer = require('../services/lead-scorer');
const PipelineManager = require('../services/pipeline-manager');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

// --- Static POST routes (must be registered before /:id handlers to avoid route shadowing) ---

// POST /api/admin/customers/fix-tiers — Recalculate tiers from service count
router.post('/fix-tiers', async (req, res, next) => {
  try {
    const customers = await db('customers')
      .select('customers.id', 'customers.waveguard_tier')
      .whereIn('customers.pipeline_stage', ['active_customer', 'won'])
      .whereNull('deleted_at');

    let updated = 0;
    for (const c of customers) {
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

// POST /api/admin/customers/quick-add — minimal customer creation from appointment modal
router.post('/quick-add', async (req, res, next) => {
  try {
    const { firstName, lastName, phone, address, city, zip } = req.body;
    if (!firstName || !lastName || !phone) {
      return res.status(400).json({ error: 'firstName, lastName, phone required' });
    }

    const phoneDigits = String(phone).replace(/\D/g, '');
    if (phoneDigits.length >= 10) {
      const existing = await db('customers')
        .whereRaw("regexp_replace(phone, '[^0-9]', '', 'g') LIKE ?", [`%${phoneDigits.slice(-10)}`])
        .first();
      if (existing) {
        return res.status(409).json({
          error: 'phone_exists',
          message: `This phone is already on file for ${existing.first_name} ${existing.last_name}`,
          existingCustomerId: existing.id,
          existingCustomerName: `${existing.first_name} ${existing.last_name}`,
        });
      }
    }

    const [customer] = await db('customers').insert({
      first_name: firstName,
      last_name: lastName,
      phone,
      address_line1: address || null,
      city: city || null,
      state: 'FL',
      zip: zip || null,
      pipeline_stage: 'new_lead',
      lead_source: 'admin_manual',
      active: true,
    }).returning('*');

    logger.info(`[customers] Quick-add: ${firstName} ${lastName} (${phone})`);

    res.status(201).json({
      customer: {
        id: customer.id,
        firstName: customer.first_name,
        lastName: customer.last_name,
        phone: customer.phone,
        address: `${customer.address_line1 || ''}, ${customer.city || ''}, ${customer.state || ''} ${customer.zip || ''}`.trim(),
        city: customer.city,
        tier: customer.waveguard_tier,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers — directory + pipeline
router.get('/', async (req, res, next) => {
  try {
    const { search, stage, tier, tag, source, area, city, sort = 'lead_score', order = 'desc' } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));

    let query = db('customers').whereNull('customers.deleted_at').select(
      'customers.*',
      db.raw('(SELECT COUNT(*) FROM service_records WHERE service_records.customer_id = customers.id) as services_count'),
      db.raw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id) as last_service_date"),
      db.raw("(SELECT MIN(scheduled_date) FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND scheduled_date >= CURRENT_DATE AND status NOT IN ('cancelled','completed')) as next_service_date"),
      db.raw("(SELECT string_agg(tag, ',') FROM customer_tags WHERE customer_tags.customer_id = customers.id) as tags_str"),
      db.raw("(SELECT string_agg(DISTINCT service_type, ',') FROM service_records WHERE service_records.customer_id = customers.id) as service_types"),
      db.raw("(SELECT COUNT(DISTINCT service_type) FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND status NOT IN ('cancelled')) as service_type_count"),
      // rating column may not exist — use satisfaction_rating from treatment_outcomes or skip
      db.raw("(SELECT NULL) as last_rating"),
      db.raw("(SELECT COALESCE(SUM(total), 0) FROM invoices WHERE invoices.customer_id = customers.id AND status IN ('sent', 'viewed', 'overdue')) as balance_owed"),
      db.raw("(SELECT COALESCE(overall_score, 0) FROM customer_health_scores WHERE customer_health_scores.customer_id = customers.id ORDER BY created_at DESC LIMIT 1) as health_score"),
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
    if (city) query = query.whereILike('city', `%${city}%`);
    if (source) query = query.where('lead_source', source);
    if (area) query = query.whereILike('city', `%${area}%`);
    if (tag) query = query.whereExists(function () {
      this.select('*').from('customer_tags').whereRaw('customer_tags.customer_id = customers.id').where('tag', tag);
    });

    const sortCol = { lead_score: 'lead_score', name: 'first_name', rate: 'monthly_rate', last_contact: 'last_contact_date', revenue: 'lifetime_revenue' }[sort] || 'lead_score';
    query = query.orderBy(sortCol, order === 'asc' ? 'asc' : 'desc');

    const total = await db('customers').whereNull('deleted_at').count('* as count').first();
    const totalCount = parseInt(total?.count || 0);
    const offset = (page - 1) * limit;
    const customers = await query.limit(limit).offset(offset);

    // Pipeline counts
    const pipelineCounts = await db('customers').whereNull('deleted_at').select('pipeline_stage').count('* as count').groupBy('pipeline_stage');
    const pipelineMap = {};
    pipelineCounts.forEach(p => { pipelineMap[p.pipeline_stage || 'unknown'] = parseInt(p.count); });

    // Available filters
    const allTags = await db('customer_tags').select('tag').groupBy('tag').orderBy('tag');
    const allSources = await db('customers').whereNull('deleted_at').select('lead_source').whereNotNull('lead_source').groupBy('lead_source');
    const allAreas = await db('customers').whereNull('deleted_at').select('city').whereNotNull('city').where('city', '!=', '').groupBy('city').orderBy('city');

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
        balanceOwed: parseFloat(c.balance_owed || 0),
        healthScore: c.health_score != null ? parseInt(c.health_score) : null,
      })),
      total: totalCount, page, limit,
      totalPages: Math.max(1, Math.ceil(totalCount / limit)),
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
        .whereNull('deleted_at')
        .select('*')
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

// GET /api/admin/customers/:id/timeline — unified customer timeline
router.get('/:id/timeline', async (req, res, next) => {
  try {
    const customerId = req.params.id;
    const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
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

    // sms + voice via unified messages (since PR 2). Joined to conversations
    // so we can attribute to this customer regardless of whether the
    // historical row had customer_id set on sms_log/call_log directly.
    try {
      const comms = await db('messages')
        .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
        .where('conversations.customer_id', customerId)
        .whereIn('messages.channel', ['sms', 'voice'])
        .select(
          'messages.channel', 'messages.direction', 'messages.body',
          'messages.ai_summary', 'messages.duration_seconds',
          'messages.created_at',
          'conversations.contact_phone', 'conversations.our_endpoint_id'
        );
      for (const m of comms) {
        if (m.channel === 'sms') {
          timeline.push({
            type: 'sms',
            title: `SMS ${m.direction === 'inbound' ? 'received' : 'sent'}`,
            description: (m.body || '').slice(0, 200),
            date: m.created_at,
            metadata: { direction: m.direction },
          });
        } else {
          const fromPhone = m.direction === 'inbound' ? m.contact_phone : m.our_endpoint_id;
          timeline.push({
            type: 'call',
            title: 'Phone call',
            description: m.ai_summary || (m.body ? m.body.slice(0, 200) : `Call from ${fromPhone || 'unknown'}`),
            date: m.created_at,
            metadata: { fromPhone, durationSeconds: m.duration_seconds },
          });
        }
      }
    } catch { /* unified comms tables may not exist in older snapshots */ }

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
    const c = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!c) return res.status(404).json({ error: 'Customer not found' });

    const [tags, interactions, prefs, services, estimates, payments, scheduled, smsLog, healthScore, invoices, cards, photos, notificationPrefs, referralInfo, complianceRecords, customerDiscounts] = await Promise.all([
      db('customer_tags').where({ customer_id: c.id }).select('tag'),
      db('customer_interactions').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(30),
      db('property_preferences').where({ customer_id: c.id }).first(),
      db('service_records').where({ customer_id: c.id }).orderBy('service_date', 'desc').limit(20),
      db('estimates').where({ customer_id: c.id }).orderBy('created_at', 'desc'),
      db('payments').where({ 'payments.customer_id': c.id }).leftJoin('payment_methods', 'payments.payment_method_id', 'payment_methods.id').select('payments.*', 'payment_methods.card_brand', 'payment_methods.last_four').orderBy('payment_date', 'desc').limit(20),
      db('scheduled_services').where({ customer_id: c.id }).orderBy('scheduled_date').limit(10),
      db('sms_log').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(20),
      db('customer_health_scores').where({ customer_id: c.id }).orderBy('scored_at', 'desc').first().catch(e => { logger.warn(`[customers:${c.id}] health_scores: ${e.message}`); return null; }),
      db('invoices').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(10).catch(e => { logger.warn(`[customers:${c.id}] invoices: ${e.message}`); return []; }),
      db('payment_methods').where({ customer_id: c.id }).catch(e => { logger.warn(`[customers:${c.id}] payment_methods: ${e.message}`); return []; }),
      db('service_photos').where({ customer_id: c.id }).select('id', 's3_url', 'caption', 'service_record_id', 'created_at').orderBy('created_at', 'desc').limit(12).catch(e => { logger.warn(`[customers:${c.id}] service_photos: ${e.message}`); return []; }),
      db('notification_prefs').where({ customer_id: c.id }).first().catch(e => { logger.warn(`[customers:${c.id}] notification_prefs: ${e.message}`); return null; }),
      db('referral_promoters').where({ customer_id: c.id }).first().catch(e => { logger.warn(`[customers:${c.id}] referral_promoters: ${e.message}`); return null; }),
      db('property_application_history').where({ customer_id: c.id }).orderBy('applied_at', 'desc').limit(10).catch(e => { logger.warn(`[customers:${c.id}] property_application_history: ${e.message}`); return []; }),
      db('customer_discounts').where({ 'customer_discounts.customer_id': c.id }).leftJoin('discounts', 'customer_discounts.discount_id', 'discounts.id').select('customer_discounts.*', 'discounts.name as discount_name', 'discounts.discount_type', 'discounts.amount as discount_value').catch(e => { logger.warn(`[customers:${c.id}] customer_discounts: ${e.message}`); return []; }),
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
        satelliteUrl: c.satellite_url,
      },
      tags: tags.map(t => t.tag),
      interactions, preferences: prefs, services, estimates, payments, scheduled, smsLog,
      healthScore: healthScore || null,
      invoices: invoices || [],
      cards: cards || [],
      photos: photos || [],
      notificationPrefs: notificationPrefs || null,
      referralInfo: referralInfo || null,
      complianceRecords: complianceRecords || [],
      customerDiscounts: customerDiscounts || [],
    });
  } catch (err) { next(err); }
});

// POST /api/admin/customers — create
router.post('/', async (req, res, next) => {
  try {
    const { firstName, lastName, phone, email, addressLine1, city, state, zip, tier, monthlyRate, leadSource, pipelineStage, tags, notes, companyName, propertyType } = req.body;
    if (!firstName || !lastName || !phone) return res.status(400).json({ error: 'Name and phone required' });

    const phoneDigits = String(phone).replace(/\D/g, '');
    if (phoneDigits.length >= 10) {
      const existing = await db('customers')
        .whereRaw("regexp_replace(phone, '[^0-9]', '', 'g') LIKE ?", [`%${phoneDigits.slice(-10)}`])
        .first();
      if (existing) {
        return res.status(409).json({
          error: 'phone_exists',
          message: `This phone is already on file for ${existing.first_name} ${existing.last_name}`,
          existingCustomerId: existing.id,
          existingCustomerName: `${existing.first_name} ${existing.last_name}`,
        });
      }
    }

    const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

    const [customer] = await db('customers').insert({
      first_name: firstName, last_name: lastName, phone, email,
      address_line1: addressLine1 || '', city: city || '', state: state || 'FL', zip: zip || '',
      waveguard_tier: tier || null, monthly_rate: monthlyRate || 0,
      member_since: etDateString(),
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

    // Fire-and-forget geocoding (don't block the create response)
    if (addressLine1) {
      require('../services/geocoder').ensureCustomerGeocoded(customer.id).catch(() => {});
    }

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

    // If address changed, re-geocode (clear lat/lng first so ensureCustomerGeocoded refreshes)
    const addressChanged = ['address_line1', 'city', 'state', 'zip'].some(f => updates[f] !== undefined);
    if (addressChanged) {
      await db('customers').where({ id: req.params.id }).update({ latitude: null, longitude: null });
      require('../services/geocoder').ensureCustomerGeocoded(req.params.id).catch(() => {});
    }

    // Fire-and-forget: trigger cancellation save when deactivating a customer
    if (updates.active === false) {
      try {
        const cancellationSave = require('../services/workflows/cancellation-save');
        if (cancellationSave.initiate) {
          cancellationSave.initiate(req.params.id, 'default').catch(err =>
            logger.error(`[customers] Cancellation save on deactivation failed: ${err.message}`)
          );
        }
      } catch (err) {
        logger.error(`[customers] Cancellation save require failed: ${err.message}`);
      }
    }

    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('customers_email_unique') || err.message?.includes('duplicate key')) {
      return res.status(400).json({ error: 'That email is already in use by another customer.' });
    }
    next(err);
  }
});

// PUT /api/admin/customers/:id/stage
router.put('/:id/stage', async (req, res, next) => {
  try {
    const { stage, notes } = req.body;
    const customer = await db('customers').where({ id: req.params.id }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
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

    // Fire-and-forget: trigger cancellation save workflow when moving to churned or at_risk
    if (stage === 'churned' || (stage === 'at_risk' && oldStage !== 'at_risk')) {
      try {
        const cancellationSave = require('../services/workflows/cancellation-save');
        if (cancellationSave.initiate) {
          const cancelReason = req.body.churnReason || 'default';
          cancellationSave.initiate(req.params.id, cancelReason).catch(err =>
            logger.error(`[customers] Cancellation save failed: ${err.message}`)
          );
        }
      } catch (err) {
        logger.error(`[customers] Cancellation save require failed: ${err.message}`);
      }
    }

    // Fire-and-forget: update health score on stage change
    try {
      const customerHealth = require('../services/customer-health');
      if (customerHealth.scoreCustomer) {
        customerHealth.scoreCustomer(req.params.id).catch(err =>
          logger.error(`[customers] Health score update on stage change failed: ${err.message}`)
        );
      }
    } catch (err) {
      logger.error(`[customers] Customer health require failed: ${err.message}`);
    }

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

// DELETE /api/admin/customers/:id — soft-delete a customer
router.delete('/:id', async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    await db('customers').where({ id: req.params.id }).update({ deleted_at: new Date() });
    logger.info(`[customers] Soft-deleted customer ${customer.first_name} ${customer.last_name} (${req.params.id})`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PATCH /api/admin/customers/:id/restore — restore a soft-deleted customer (admin only)
router.patch('/:id/restore', async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNotNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found or not deleted' });

    await db('customers').where({ id: req.params.id }).update({ deleted_at: null });
    logger.info(`[customers] Restored customer ${customer.first_name} ${customer.last_name} (${req.params.id})`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /api/admin/customers/:id/refund — Refund a Stripe payment
// =========================================================================
router.post('/:id/refund', async (req, res, next) => {
  try {
    const { paymentId, amount, reason } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'paymentId required' });

    const StripeService = require('../services/stripe');
    const result = await StripeService.refund(paymentId, { amount, reason: reason || 'requested_by_customer' });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
