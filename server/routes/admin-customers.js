const express = require('express');
const router = express.Router();
const db = require('../models/db');
const LeadScorer = require('../services/lead-scorer');
const PipelineManager = require('../services/pipeline-manager');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { recordAuditEvent } = require('../services/audit-log');
const PhotoService = require('../services/photos');

router.use(adminAuthenticate, requireTechOrAdmin);

function applyCustomerListFilters(query, filters) {
  const { search, stage, tier, tag, source, area, city, cards, hasBalance, lastVisited } = filters;
  if (search) {
    const s = `%${search}%`;
    const isPhoneLike = /^[\d\s().+\-]+$/.test(search);
    const phoneDigits = isPhoneLike ? String(search).replace(/\D/g, '') : '';
    query = query.where(function () {
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereILike('phone', s).orWhereILike('email', s)
        .orWhereILike('address_line1', s).orWhereILike('city', s)
        .orWhereILike('company_name', s)
        .orWhereRaw("(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) ILIKE ?", [s]);
      if (phoneDigits.length >= 3) {
        this.orWhereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${phoneDigits}%`]);
      }
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
  if (cards === 'has') {
    query = query.whereExists(function () {
      this.select(db.raw('1')).from('payment_methods').whereRaw('payment_methods.customer_id = customers.id');
    });
  } else if (cards === 'none') {
    query = query.whereNotExists(function () {
      this.select(db.raw('1')).from('payment_methods').whereRaw('payment_methods.customer_id = customers.id');
    });
  }
  if (hasBalance === 'true' || hasBalance === true) {
    query = query.whereExists(function () {
      this.select('customer_id').from('invoices')
        .whereRaw('invoices.customer_id = customers.id')
        .whereIn('status', ['sent', 'viewed', 'overdue'])
        .groupBy('customer_id')
        .havingRaw('COALESCE(SUM(total), 0) > 0');
    });
  }
  if (lastVisited && lastVisited !== 'all') {
    if (lastVisited === 'never') {
      query = query.whereNotExists(function () {
        this.select(db.raw('1')).from('service_records').whereRaw('service_records.customer_id = customers.id');
      });
    } else {
      const days = parseInt(lastVisited, 10);
      if (Number.isFinite(days) && days >= 0) {
        query = query.whereExists(function () {
          this.select('customer_id').from('service_records')
            .whereRaw('service_records.customer_id = customers.id')
            .groupBy('customer_id')
            .havingRaw('MAX(service_date) >= ?::date - (? * INTERVAL \'1 day\')', [etDateString(), days]);
        });
      }
    }
  }
  return query;
}

async function auditCustomerMutation(req, action, customerId, metadata = {}, critical = false) {
  await recordAuditEvent({
    actor_type: 'technician',
    actor_id: req.technicianId || null,
    action,
    resource_type: 'customer',
    resource_id: customerId,
    metadata,
    ip_address: req.ip,
    user_agent: req.get('user-agent') || null,
    critical,
  });
}

function phoneLast10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function cleanText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function cleanOptionalText(value) {
  const cleaned = cleanText(value);
  return cleaned || null;
}

function cleanEmail(value) {
  const cleaned = cleanText(value).toLowerCase();
  return cleaned || null;
}

function cleanState(value) {
  const cleaned = cleanText(value).toUpperCase();
  return cleaned ? cleaned.slice(0, 2) : 'FL';
}

async function createDefaultCustomerRows(trx, customerId) {
  await trx('property_preferences')
    .insert({ customer_id: customerId })
    .onConflict('customer_id')
    .ignore();
  await trx('notification_prefs')
    .insert({ customer_id: customerId })
    .onConflict('customer_id')
    .ignore();
}

async function attachMatchedCustomerToAccount(trx, customer) {
  if (!customer) return null;
  if (customer.account_id) return customer.account_id;

  const accountId = customer.id;
  await trx('customer_accounts')
    .insert({
      id: accountId,
      first_name: customer.first_name,
      last_name: customer.last_name,
      phone: customer.phone || null,
      email: customer.email ? String(customer.email).trim().toLowerCase() : null,
      company_name: customer.company_name || null,
      created_at: customer.created_at || new Date(),
      updated_at: new Date(),
    })
    .onConflict('id')
    .ignore();

  await trx('customers')
    .where({ id: customer.id })
    .update({
      account_id: accountId,
      is_primary_profile: customer.is_primary_profile === false ? false : true,
      profile_label: customer.profile_label || 'Primary',
      updated_at: new Date(),
    });

  return accountId;
}

async function findAccountByContact(trx, { phone }) {
  const digits = phoneLast10(phone);
  if (digits) {
    const byCustomerPhone = await trx('customers')
      .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}`])
      .whereNull('deleted_at')
      .orderBy('is_primary_profile', 'desc')
      .orderBy('created_at', 'asc')
      .first();
    if (byCustomerPhone) {
      const accountId = await attachMatchedCustomerToAccount(trx, byCustomerPhone);
      return { accountId, existingCustomer: { ...byCustomerPhone, account_id: accountId }, matchType: 'phone' };
    }
  }

  return null;
}

async function ensureCustomerAccount(trx, input) {
  const existing = await findAccountByContact(trx, input);
  if (existing?.accountId) return existing;

  const [account] = await trx('customer_accounts').insert({
    first_name: input.firstName,
    last_name: input.lastName,
    phone: input.phone || null,
    email: input.email ? String(input.email).trim().toLowerCase() : null,
    company_name: input.companyName || null,
  }).returning('*');

  return { accountId: account.id, existingCustomer: null, matchType: null };
}

async function accountPropertySummary(accountId, excludeCustomerId = null) {
  if (!accountId) return [];
  let query = db('customers')
    .where({ account_id: accountId })
    .whereNull('deleted_at')
    .select('id', 'profile_label', 'address_line1', 'city', 'state', 'zip', 'pipeline_stage', 'monthly_rate', 'is_primary_profile')
    .orderBy('is_primary_profile', 'desc')
    .orderBy('created_at', 'asc');
  if (excludeCustomerId) query = query.whereNot({ id: excludeCustomerId });
  return query;
}

async function findCrossAccountContactConflict(customerId, accountId, updates) {
  const normalizedAccountId = accountId ? String(accountId) : null;
  const conflicts = [];

  if (updates.phone !== undefined) {
    const digits = phoneLast10(updates.phone);
    if (digits) {
      const rows = await db('customers')
        .whereNull('deleted_at')
        .whereNot({ id: customerId })
        .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}`])
        .select('id', 'account_id', 'first_name', 'last_name', 'phone');
      const conflict = rows.find((row) => String(row.account_id || row.id) !== normalizedAccountId);
      if (conflict) conflicts.push({ field: 'phone', customer: conflict });
    }
  }

  if (updates.email !== undefined) {
    const email = cleanEmail(updates.email);
    if (email) {
      const rows = await db('customers')
        .whereNull('deleted_at')
        .whereNot({ id: customerId })
        .whereRaw('LOWER(email) = ?', [email])
        .select('id', 'account_id', 'first_name', 'last_name', 'email');
      const conflict = rows.find((row) => String(row.account_id || row.id) !== normalizedAccountId);
      if (conflict) conflicts.push({ field: 'email', customer: conflict });
    }
  }

  return conflicts[0] || null;
}

// --- Static POST routes (must be registered before /:id handlers to avoid route shadowing) ---

// POST /api/admin/customers/fix-tiers — Recalculate tiers from service count
router.post('/fix-tiers', requireAdmin, async (req, res, next) => {
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

// POST /api/admin/customers/backfill-review-status — flip has_left_google_review = true
// for any customer who already has a matched (non-_stats) row in google_reviews.
// One-shot helper for the ~170 historical reviewers; safe to re-run (idempotent —
// preserves the original review_marked_at on rows that are already true).
router.post('/backfill-review-status', requireAdmin, async (req, res, next) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const matchedIds = await db('google_reviews')
      .whereNotNull('customer_id')
      .where('reviewer_name', '!=', '_stats')
      .distinct('customer_id')
      .pluck('customer_id');

    if (matchedIds.length === 0) {
      return res.json({ success: true, matched: 0, updated: 0, alreadyFlagged: 0, dryRun });
    }

    const candidates = await db('customers')
      .whereIn('id', matchedIds)
      .whereNull('deleted_at')
      .select('id', 'has_left_google_review');

    const toFlip = candidates.filter(c => !c.has_left_google_review).map(c => c.id);
    const alreadyFlagged = candidates.length - toFlip.length;

    if (!dryRun && toFlip.length > 0) {
      await db('customers')
        .whereIn('id', toFlip)
        .update({ has_left_google_review: true, review_marked_at: new Date() });
    }

    logger.info(`[customers] Review-status backfill: ${toFlip.length} flipped, ${alreadyFlagged} already flagged${dryRun ? ' (dry run)' : ''}`);
    res.json({ success: true, matched: candidates.length, updated: dryRun ? 0 : toFlip.length, alreadyFlagged, dryRun });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/quick-add — minimal customer creation from appointment modal
router.post('/quick-add', async (req, res, next) => {
  try {
    const { firstName, lastName, phone, email, address, city, state, zip, profileLabel } = req.body;
    if (!firstName || !lastName || !phone) {
      return res.status(400).json({ error: 'firstName, lastName, phone required' });
    }
    const normalized = {
      firstName: cleanText(firstName),
      lastName: cleanText(lastName),
      phone: cleanText(phone),
      email: cleanEmail(email),
      address: cleanText(address),
      city: cleanText(city),
      state: cleanState(state),
      zip: cleanText(zip),
      profileLabel: cleanOptionalText(profileLabel),
    };
    if (!normalized.firstName || !normalized.lastName || !normalized.phone) {
      return res.status(400).json({ error: 'firstName, lastName, phone required' });
    }

    const customer = await db.transaction(async (trx) => {
      const account = await ensureCustomerAccount(trx, normalized);
      const siblingCount = await trx('customers').where({ account_id: account.accountId }).whereNull('deleted_at').count('* as count').first();
      const [created] = await trx('customers').insert({
        account_id: account.accountId,
        is_primary_profile: !account.existingCustomer,
        profile_label: normalized.profileLabel || (account.existingCustomer ? 'Rental property' : 'Primary'),
        first_name: normalized.firstName,
        last_name: normalized.lastName,
        phone: normalized.phone,
        email: normalized.email,
        address_line1: normalized.address,
        city: normalized.city,
        state: normalized.state,
        zip: normalized.zip,
        pipeline_stage: 'new_lead',
        lead_source: 'admin_manual',
        active: true,
      }).returning('*');
      await createDefaultCustomerRows(trx, created.id);
      return { ...created, _attachedToExistingAccount: !!account.existingCustomer, _propertyCount: Number(siblingCount?.count || 0) + 1 };
    });

    logger.info(`[customers] Quick-add created customer_id=${customer.id} account_id=${customer.account_id || customer.id}`);

    res.status(201).json({
      customer: {
        id: customer.id,
        firstName: customer.first_name,
        lastName: customer.last_name,
        phone: customer.phone,
        accountId: customer.account_id,
        profileLabel: customer.profile_label,
        attachedToExistingAccount: customer._attachedToExistingAccount,
        propertyCount: customer._propertyCount,
        address: `${customer.address_line1 || ''}, ${customer.city || ''}, ${customer.state || ''} ${customer.zip || ''}`.trim(),
        city: customer.city,
        state: customer.state,
        zip: customer.zip,
        tier: customer.waveguard_tier,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers — directory + pipeline
router.get('/', async (req, res, next) => {
  try {
    // Default sort: last name, then first name, ascending (phonebook
    // alphabetical). The old default was lead_score desc + limit 100,
    // which meant the client's local alphabetical re-sort only covered
    // the top-100-by-lead-score slice. Anything beyond that fell off
    // the end of the list — looked like "not alphabetical" to operators
    // working large customer bases.
    const {
      search, stage, tier, tag, source, area, city,
      cards, hasBalance, lastVisited,
      sort = 'name', order = 'asc',
    } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));

    const filters = { search, stage, tier, tag, source, area, city, cards, hasBalance, lastVisited };
    let query = applyCustomerListFilters(db('customers').whereNull('customers.deleted_at'), filters).select(
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
      db.raw("(SELECT COUNT(*) FROM payment_methods WHERE payment_methods.customer_id = customers.id) as cards_on_file"),
    );

    // Alphabetical by first name only — operator preference. No tie-break
    // on last name or other columns. NULLS LAST keeps blank-first-name
    // rows pinned to the end of the list instead of the top.
    const dir = order === 'desc' ? 'desc' : 'asc';
    if (sort === 'name') {
      query = query.orderByRaw(`LOWER(first_name) ${dir} NULLS LAST`);
    } else {
      const sortCol = { lead_score: 'lead_score', rate: 'monthly_rate', last_contact: 'last_contact_date', revenue: 'lifetime_revenue' }[sort] || 'first_name';
      query = query.orderBy(sortCol, dir);
    }

    const total = await applyCustomerListFilters(
      db('customers').whereNull('customers.deleted_at'),
      filters
    ).count('* as count').first();
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
        accountId: c.account_id, profileLabel: c.profile_label,
        isPrimaryProfile: !!c.is_primary_profile,
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
        cardsOnFile: parseInt(c.cards_on_file || 0),
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
          accountId: c.account_id, profileLabel: c.profile_label,
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

// GET /api/admin/customers/:id/cards — just the saved payment methods.
// Lightweight endpoint so the MobilePaymentSheet's Card on File picker
// doesn't have to load the full customer profile (tags, interactions,
// services, etc.) every time the tech opens the payment sheet.
router.get('/:id/cards', async (req, res, next) => {
  try {
    const cards = await db('payment_methods')
      .where({ customer_id: req.params.id })
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc');
    res.json({
      cards: cards.map((c) => ({
        id: c.id,
        method_type: c.method_type,
        brand: c.card_brand,
        last_four: c.last_four,
        exp_month: c.exp_month,
        exp_year: c.exp_year,
        bank_name: c.bank_name,
        is_default: !!c.is_default,
      })),
    });
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

// GET /api/admin/customers/:id/comms — unified per-customer SMS + voice
// thread (PR 3 of comms unification). Replaces the SMS-only feed that
// fed the Comms tab from `data.smsLog`. Email lands in PR 5.
router.get('/:id/comms', async (req, res, next) => {
  try {
    const customerId = req.params.id;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);

    const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const rows = await db('messages')
      .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
      .where('conversations.customer_id', customerId)
      .whereIn('messages.channel', ['sms', 'voice'])
      .select(
        'messages.id', 'messages.channel', 'messages.direction', 'messages.body',
        'messages.ai_summary', 'messages.message_type', 'messages.duration_seconds',
        'messages.media', 'messages.answered_by', 'messages.is_read',
        'messages.delivery_status', 'messages.recording_sid', 'messages.created_at',
        'conversations.our_endpoint_id', 'conversations.contact_phone'
      )
      .orderBy('messages.created_at', 'desc')
      .limit(limit);

    // Resolve the friendly label (location / domain) for each Waves number
    // hit by this customer, so the UI can show e.g. "Lakewood Ranch — HQ"
    // instead of a raw E.164.
    let TWILIO_NUMBERS;
    try { TWILIO_NUMBERS = require('../config/twilio-numbers'); } catch { TWILIO_NUMBERS = null; }

    const comms = rows.map(m => {
      const numberCfg = TWILIO_NUMBERS?.findByNumber?.(m.our_endpoint_id) || null;
      let media = [];
      try { media = typeof m.media === 'string' ? JSON.parse(m.media) : (m.media || []); } catch { media = []; }
      return {
        id: m.id,
        channel: m.channel,
        direction: m.direction,
        body: m.body,
        aiSummary: m.ai_summary,
        messageType: m.message_type,
        durationSeconds: m.duration_seconds,
        media,
        answeredBy: m.answered_by,
        isRead: !!m.is_read,
        deliveryStatus: m.delivery_status,
        recordingSid: m.recording_sid,
        createdAt: m.created_at,
        ourEndpointId: m.our_endpoint_id,
        ourEndpointLabel: numberCfg?.label || null,
        contactPhone: m.contact_phone || customer.phone || null,
      };
    });

    res.json({ comms, total: comms.length });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/estimates-summary — compact payload for the
// Estimates page's customer slide-over. Returns customer basics, the full
// estimate history for that customer, aggregate conversion stats, and the
// most recent comms touchpoint. Much cheaper than /api/admin/customers/:id
// which pulls 16 parallel tables; this endpoint is the 4 we actually need.
router.get('/:id/estimates-summary', async (req, res, next) => {
  try {
    const customer = await db('customers')
      .where({ id: req.params.id })
      .whereNull('deleted_at')
      .select(
        'id', 'first_name', 'last_name', 'phone', 'email',
        'address_line1', 'city', 'state', 'zip',
        'waveguard_tier', 'active', 'created_at',
        'property_type', 'company_name',
        'lead_source', 'lead_source_detail',
      )
      .first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const [estimates, lastMessage] = await Promise.all([
      db('estimates')
        .where({ customer_id: customer.id })
        .orderBy('created_at', 'desc')
        .select(
          'id', 'status', 'token', 'service_interest', 'decline_reason',
          'monthly_total', 'annual_total', 'onetime_total', 'waveguard_tier',
          'created_at', 'sent_at', 'viewed_at', 'accepted_at', 'declined_at', 'expires_at',
        ),
      db('messages')
        .where({ customer_id: customer.id })
        .whereIn('channel', ['sms', 'voice'])
        .orderBy('created_at', 'desc')
        .select('channel', 'direction', 'created_at', 'body')
        .first()
        .catch(() => null),
    ]);

    // Conversion math. "Decided" = accepted + declined. Pipeline count
    // includes draft/sent/viewed/expired so the rate isn't inflated by
    // still-open quotes. Accepted lifetime monthly is the sum of monthly
    // totals at acceptance time — useful proxy for recurring CLV.
    const accepted = estimates.filter((e) => e.status === 'accepted');
    const declined = estimates.filter((e) => e.status === 'declined');
    const acceptedLifetimeMonthly = accepted.reduce((s, e) => s + Number(e.monthly_total || 0), 0);
    const decided = accepted.length + declined.length;
    const stats = {
      total: estimates.length,
      accepted: accepted.length,
      declined: declined.length,
      open: estimates.filter((e) => ['draft', 'sent', 'viewed'].includes(e.status)).length,
      conversionRate: decided > 0 ? Math.round((accepted.length / decided) * 100) / 100 : null,
      acceptedLifetimeMonthly: Math.round(acceptedLifetimeMonthly * 100) / 100,
    };

    res.json({
      customer,
      estimates,
      stats,
      lastContact: lastMessage ? {
        channel: lastMessage.channel,
        direction: lastMessage.direction,
        at: lastMessage.created_at,
        preview: lastMessage.body ? String(lastMessage.body).slice(0, 140) : null,
      } : null,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id — full detail
router.get('/:id', async (req, res, next) => {
  try {
    const c = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!c) return res.status(404).json({ error: 'Customer not found' });

    const currentYear = Number(etDateString().slice(0, 4));
    const [tags, interactions, prefs, services, estimates, payments, paymentsTotal, scheduled, smsLog, healthScore, invoices, cards, photos, notificationPrefs, referralInfo, complianceRecords, customerDiscounts, nutrientLedgerRows, nutrientLedgerSummary, accountProperties] = await Promise.all([
      db('customer_tags').where({ customer_id: c.id }).select('tag'),
      db('customer_interactions').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(30),
      db('property_preferences').where({ customer_id: c.id }).first(),
      db('service_records')
        .where({ 'service_records.customer_id': c.id })
        .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
        .select('service_records.*', 'technicians.name as technician_name')
        .orderBy('service_records.service_date', 'desc')
        .limit(20),
      db('estimates').where({ customer_id: c.id }).orderBy('created_at', 'desc'),
      db('payments').where({ 'payments.customer_id': c.id }).leftJoin('payment_methods', 'payments.payment_method_id', 'payment_methods.id').select('payments.*', 'payment_methods.card_brand', 'payment_methods.last_four').orderBy('payment_date', 'desc').limit(20),
      db('payments').where({ customer_id: c.id, status: 'paid' }).first(db.raw('COALESCE(SUM(amount - COALESCE(refund_amount, 0)), 0)::float as net')).catch(e => { logger.warn(`[customers:${c.id}] payments_sum: ${e.message}`); return { net: 0 }; }),
      db('scheduled_services').where({ customer_id: c.id }).orderBy('scheduled_date').limit(10),
      db('sms_log').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(20),
      db('customer_health_scores').where({ customer_id: c.id }).orderBy('scored_at', 'desc').first().catch(e => { logger.warn(`[customers:${c.id}] health_scores: ${e.message}`); return null; }),
      db('invoices').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(10).catch(e => { logger.warn(`[customers:${c.id}] invoices: ${e.message}`); return []; }),
      db('payment_methods').where({ customer_id: c.id }).catch(e => { logger.warn(`[customers:${c.id}] payment_methods: ${e.message}`); return []; }),
      db('service_photos')
        .join('service_records', 'service_photos.service_record_id', 'service_records.id')
        .where('service_records.customer_id', c.id)
        .select(
          'service_photos.id',
          'service_photos.s3_key',
          'service_photos.s3_url',
          'service_photos.caption',
          'service_photos.service_record_id',
          'service_photos.created_at'
        )
        .orderBy('service_photos.created_at', 'desc')
        .limit(12)
        .catch(e => { logger.warn(`[customers:${c.id}] service_photos: ${e.message}`); return []; }),
      db('notification_prefs').where({ customer_id: c.id }).first().catch(e => { logger.warn(`[customers:${c.id}] notification_prefs: ${e.message}`); return null; }),
      db('referral_promoters').where({ customer_id: c.id }).first().catch(e => { logger.warn(`[customers:${c.id}] referral_promoters: ${e.message}`); return null; }),
      db('property_application_history').where({ customer_id: c.id }).orderBy('applied_at', 'desc').limit(10).catch(e => { logger.warn(`[customers:${c.id}] property_application_history: ${e.message}`); return []; }),
      db('customer_discounts').where({ 'customer_discounts.customer_id': c.id }).leftJoin('discounts', 'customer_discounts.discount_id', 'discounts.id').select('customer_discounts.*', 'discounts.name as discount_name', 'discounts.discount_type', 'discounts.amount as discount_value').catch(e => { logger.warn(`[customers:${c.id}] customer_discounts: ${e.message}`); return []; }),
      db('property_nutrient_ledger')
        .where({ customer_id: c.id, application_year: currentYear })
        .orderBy('application_date', 'desc')
        .orderBy('created_at', 'desc')
        .limit(25)
        .catch(e => { logger.warn(`[customers:${c.id}] property_nutrient_ledger: ${e.message}`); return []; }),
      db('property_nutrient_ledger')
        .where({ customer_id: c.id, application_year: currentYear })
        .first(
          db.raw('COALESCE(SUM(n_applied_per_1000), 0)::float as "nApplied"'),
          db.raw('COALESCE(SUM(p_applied_per_1000), 0)::float as "pApplied"'),
          db.raw('COALESCE(SUM(k_applied_per_1000), 0)::float as "kApplied"'),
          db.raw('COUNT(*)::int as entries')
        )
        .catch(e => { logger.warn(`[customers:${c.id}] property_nutrient_ledger_summary: ${e.message}`); return null; }),
      accountPropertySummary(c.account_id, c.id).catch(e => { logger.warn(`[customers:${c.id}] account_properties: ${e.message}`); return []; }),
    ]);

    // The invoices table stores the billed amount as `total`; the frontend reads
    // `amount_due`/`amount_paid`. Only collectible statuses contribute to
    // amount_due — draft/void must not inflate Balance Owed (frontend filters
    // by `status !== 'paid'`).
    const COLLECTIBLE_STATUSES = new Set(['sent', 'viewed', 'overdue', 'paid']);
    const mappedInvoices = (invoices || []).map(inv => {
      const total = parseFloat(inv.total || 0);
      const isPaid = inv.status === 'paid';
      const isCollectible = COLLECTIBLE_STATUSES.has(inv.status);
      return {
        ...inv,
        amount_due: isCollectible ? total : 0,
        amount_paid: isPaid ? total : 0,
      };
    });
    // Lifetime revenue is the net of all paid payments (Stripe + Zelle/manual),
    // minus refunds. customers.lifetime_revenue isn't kept in sync, and summing
    // paid-invoice totals from the limit(10) query above would underreport for
    // long-tenured customers and miss off-gateway payments without invoices.
    const lifetimeRevenue = parseFloat(paymentsTotal?.net || 0);

    const signedPhotos = await Promise.all((photos || []).map(async (p) => {
      if (!p.s3_key) return { ...p, url: null, s3_url: null };
      try {
        return { ...p, url: await PhotoService.getViewUrl(p.s3_key, 300), s3_url: null };
      } catch (err) {
        logger.warn(`[customers:${c.id}] service photo presign failed: ${err.message}`);
        return { ...p, url: null, s3_url: null };
      }
    }));

    res.json({
      customer: {
        id: c.id, firstName: c.first_name, lastName: c.last_name,
        accountId: c.account_id,
        profileLabel: c.profile_label,
        isPrimaryProfile: !!c.is_primary_profile,
        email: c.email, phone: c.phone, secondaryPhone: c.secondary_phone,
        secondaryContact: c.secondary_contact_name, companyName: c.company_name,
        serviceContactName: c.service_contact_name,
        serviceContactPhone: c.service_contact_phone,
        serviceContactEmail: c.service_contact_email,
        address: { line1: c.address_line1, city: c.city, state: c.state, zip: c.zip },
        property: { type: c.property_type, lawnType: c.lawn_type, sqft: c.property_sqft, lotSqft: c.lot_sqft, palmCount: c.palm_count },
        tier: c.waveguard_tier, monthlyRate: parseFloat(c.monthly_rate || 0),
        memberSince: c.member_since, active: c.active,
        pipelineStage: c.pipeline_stage, leadScore: c.lead_score,
        leadSource: c.lead_source, leadSourceDetail: c.lead_source_detail,
        landingPageUrl: c.landing_page_url,
        assignedTo: c.assigned_to, lastContactDate: c.last_contact_date,
        nextFollowUp: c.next_follow_up_date, followUpNotes: c.follow_up_notes,
        lifetimeRevenue,
        annualValue: parseFloat(c.monthly_rate || 0) * 12,
        totalServices: c.total_services,
        referralCode: c.referral_code, crmNotes: c.crm_notes,
        satelliteUrl: c.satellite_url,
        hasLeftGoogleReview: !!c.has_left_google_review,
        reviewMarkedAt: c.review_marked_at,
      },
      accountProperties: accountProperties.map(p => ({
        id: p.id,
        profileLabel: p.profile_label,
        address: { line1: p.address_line1, city: p.city, state: p.state, zip: p.zip },
        pipelineStage: p.pipeline_stage,
        monthlyRate: parseFloat(p.monthly_rate || 0),
        isPrimaryProfile: !!p.is_primary_profile,
      })),
      tags: tags.map(t => t.tag),
      interactions, preferences: prefs, services, estimates, payments, scheduled, smsLog,
      healthScore: healthScore || null,
      invoices: mappedInvoices,
      cards: cards || [],
      photos: signedPhotos,
      notificationPrefs: notificationPrefs || null,
      referralInfo: referralInfo || null,
      complianceRecords: complianceRecords || [],
      nutrientLedger: {
        year: currentYear,
        summary: {
          year: currentYear,
          nApplied: Number(Number(nutrientLedgerSummary?.nApplied || 0).toFixed(3)),
          pApplied: Number(Number(nutrientLedgerSummary?.pApplied || 0).toFixed(3)),
          kApplied: Number(Number(nutrientLedgerSummary?.kApplied || 0).toFixed(3)),
          totalN: Number(Number(nutrientLedgerSummary?.nApplied || 0).toFixed(3)),
          totalP: Number(Number(nutrientLedgerSummary?.pApplied || 0).toFixed(3)),
          totalK: Number(Number(nutrientLedgerSummary?.kApplied || 0).toFixed(3)),
          entries: Number(nutrientLedgerSummary?.entries || 0),
          source: 'property_nutrient_ledger',
        },
        rows: nutrientLedgerRows || [],
      },
      customerDiscounts: customerDiscounts || [],
    });
  } catch (err) { next(err); }
});

// POST /api/admin/customers — create
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { firstName, lastName, phone, email, address, addressLine1, city, state, zip, tier, monthlyRate, leadSource, pipelineStage, tags, notes, companyName, propertyType, profileLabel } = req.body;
    if (!firstName || !lastName || !phone) return res.status(400).json({ error: 'Name and phone required' });
    const normalized = {
      firstName: cleanText(firstName),
      lastName: cleanText(lastName),
      phone: cleanText(phone),
      email: cleanEmail(email),
      addressLine1: cleanText(addressLine1 || address),
      city: cleanText(city),
      state: cleanState(state),
      zip: cleanText(zip),
      tier: cleanOptionalText(tier),
      monthlyRate: monthlyRate === '' || monthlyRate === undefined || monthlyRate === null ? 0 : parseFloat(monthlyRate) || 0,
      leadSource: cleanOptionalText(leadSource),
      pipelineStage: cleanText(pipelineStage) || 'new_lead',
      notes: cleanOptionalText(notes),
      companyName: cleanOptionalText(companyName),
      propertyType: cleanOptionalText(propertyType),
      profileLabel: cleanOptionalText(profileLabel),
    };
    if (!normalized.firstName || !normalized.lastName || !normalized.phone) {
      return res.status(400).json({ error: 'Name and phone required' });
    }

    const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

    const customer = await db.transaction(async (trx) => {
      const account = await ensureCustomerAccount(trx, normalized);
      const siblingCount = await trx('customers').where({ account_id: account.accountId }).whereNull('deleted_at').count('* as count').first();
      const [created] = await trx('customers').insert({
        account_id: account.accountId,
        is_primary_profile: !account.existingCustomer,
        profile_label: normalized.profileLabel || (account.existingCustomer ? 'Rental property' : 'Primary'),
        first_name: normalized.firstName, last_name: normalized.lastName, phone: normalized.phone, email: normalized.email,
        address_line1: normalized.addressLine1, city: normalized.city, state: normalized.state, zip: normalized.zip,
        waveguard_tier: normalized.tier, monthly_rate: normalized.monthlyRate,
        member_since: etDateString(),
        referral_code: code, lead_source: normalized.leadSource,
        pipeline_stage: normalized.pipelineStage,
        pipeline_stage_changed_at: new Date(),
        assigned_to: req.technicianId,
        company_name: normalized.companyName, property_type: normalized.propertyType, crm_notes: normalized.notes,
      }).returning('*');

      await createDefaultCustomerRows(trx, created.id);

      if (tags?.length) {
        for (const tag of tags) {
          const cleanTag = cleanText(tag);
          if (cleanTag) {
            await trx('customer_tags').insert({ customer_id: created.id, tag: cleanTag }).onConflict(['customer_id', 'tag']).ignore();
          }
        }
      }
      return { ...created, _attachedToExistingAccount: !!account.existingCustomer, _existingCustomer: account.existingCustomer, _propertyCount: Number(siblingCount?.count || 0) + 1 };
    });

    // Intentional fire-and-forget: derived pipeline/score state can lag the
    // create response, and failures should not roll back the durable customer.
    void PipelineManager.onEvent(customer.id, 'lead_created')
      .catch(err => logger.warn(`[customers:${customer.id}] pipeline lead_created failed: ${err.message}`));
    void LeadScorer.calculateScore(customer.id)
      .catch(err => logger.warn(`[customers:${customer.id}] lead score failed: ${err.message}`));
    await auditCustomerMutation(req, 'customer.create', customer.id, {
      fields: ['first_name', 'last_name', 'phone', 'email', 'address', 'tier', 'monthly_rate', 'lead_source', 'pipeline_stage', 'tags'],
    });

    // Fire-and-forget geocoding (don't block the create response)
    if (normalized.addressLine1) {
      require('../services/geocoder').ensureCustomerGeocoded(customer.id).catch(() => {});
    }

    res.status(201).json({
      id: customer.id,
      referralCode: code,
      accountId: customer.account_id,
      profileLabel: customer.profile_label,
      attachedToExistingAccount: customer._attachedToExistingAccount,
      propertyCount: customer._propertyCount,
      existingCustomerId: customer._existingCustomer?.id || null,
      existingCustomerName: customer._existingCustomer ? `${customer._existingCustomer.first_name} ${customer._existingCustomer.last_name}` : null,
    });
  } catch (err) { next(err); }
});

// PUT /api/admin/customers/:id
router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const fields = { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', profileLabel: 'profile_label', addressLine1: 'address_line1', city: 'city', state: 'state', zip: 'zip', tier: 'waveguard_tier', monthlyRate: 'monthly_rate', active: 'active', leadSource: 'lead_source', companyName: 'company_name', propertyType: 'property_type', crmNotes: 'crm_notes', nextFollowUpDate: 'next_follow_up_date', followUpNotes: 'follow_up_notes', secondaryPhone: 'secondary_phone', secondaryContactName: 'secondary_contact_name', pipelineStage: 'pipeline_stage', serviceContactName: 'service_contact_name', serviceContactPhone: 'service_contact_phone', serviceContactEmail: 'service_contact_email', hasLeftGoogleReview: 'has_left_google_review' };
    const updates = {};
    for (const [k, v] of Object.entries(fields)) {
      if (req.body[k] !== undefined) {
        // Handle empty strings for numeric/date fields
        if (v === 'monthly_rate') { updates[v] = req.body[k] === '' ? 0 : parseFloat(req.body[k]) || 0; }
        else if (v === 'next_follow_up_date') { updates[v] = req.body[k] || null; }
        else if (v === 'has_left_google_review') { updates[v] = !!req.body[k]; }
        else if (v === 'email') { updates[v] = cleanEmail(req.body[k]); }
        else if (v === 'phone') { updates[v] = cleanText(req.body[k]); }
        else if (v === 'state') { updates[v] = cleanState(req.body[k]); }
        else { updates[v] = req.body[k]; }
      }
    }
    // Stamp when the review flag flips so admins can see who/when later.
    if (updates.has_left_google_review !== undefined) {
      updates.review_marked_at = updates.has_left_google_review ? new Date() : null;
    }
    let before = null;
    if (Object.keys(updates).length) {
      before = await db('customers').where({ id: req.params.id }).first();
      if (!before) return res.status(404).json({ error: 'Customer not found' });

      const contactConflict = await findCrossAccountContactConflict(
        req.params.id,
        before.account_id || before.id,
        updates
      );
      if (contactConflict) {
        const c = contactConflict.customer;
        return res.status(409).json({
          error: 'contact_exists_on_another_account',
          field: contactConflict.field,
          message: `That ${contactConflict.field} is already used by ${c.first_name || ''} ${c.last_name || ''}`.trim(),
          existingCustomerId: c.id,
        });
      }

      await db('customers').where({ id: req.params.id }).update(updates);
      const sensitiveFields = ['email', 'phone', 'secondary_phone', 'address_line1', 'city', 'state', 'zip', 'monthly_rate', 'active', 'pipeline_stage', 'service_contact_name', 'service_contact_phone', 'service_contact_email'];
      const changed = Object.keys(updates).filter(field => before && before[field] !== updates[field]);
      if (changed.some(field => sensitiveFields.includes(field))) {
        await auditCustomerMutation(req, 'customer.update_sensitive', req.params.id, {
          fields: changed,
          sensitiveFieldsChanged: changed.filter(field => sensitiveFields.includes(field)),
        }, true);
      }
    }

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

// PUT /api/admin/customers/:id/notification-prefs
//
// Admin override for a customer's notification_prefs row. Today this
// only exposes auto_flip_en_route (Phase 2E per-customer opt-out for
// the geofence EXIT auto-flip pipeline) — customers manage everything
// else through the customer-facing /api/notifications/preferences
// endpoint themselves. Add new fields here only when ops genuinely
// needs to override on a customer's behalf.
//
// Creates the prefs row if it doesn't exist (defaults to all TRUE).
router.put('/:id/notification-prefs', requireAdmin, async (req, res, next) => {
  try {
    const dbUpdates = {};
    if (req.body.autoFlipEnRoute !== undefined) {
      dbUpdates.auto_flip_en_route = !!req.body.autoFlipEnRoute;
    }
    if (Object.keys(dbUpdates).length === 0) {
      return res.status(400).json({ error: 'No supported fields provided.' });
    }
    dbUpdates.updated_at = new Date();

    const existing = await db('notification_prefs')
      .where({ customer_id: req.params.id })
      .first();
    if (existing) {
      await db('notification_prefs')
        .where({ customer_id: req.params.id })
        .update(dbUpdates);
    } else {
      await db('notification_prefs').insert({
        customer_id: req.params.id,
        ...dbUpdates,
      });
    }

    const prefs = await db('notification_prefs')
      .where({ customer_id: req.params.id })
      .first();
    // Log only normalized fields persisted (not raw req.body) — the
    // endpoint accepts arbitrary JSON and a future caller could put
    // phone/email/address-like fields into plaintext logs (Railway,
    // errors.log) and create avoidable PII exposure. Drop updated_at
    // from the payload — timestamp noise that adds nothing forensically.
    const { updated_at: _drop, ...logPayload } = dbUpdates;
    logger.info(`[customers] notification_prefs updated for ${req.params.id}: ${JSON.stringify(logPayload)}`);
    res.json({ success: true, notificationPrefs: prefs });
  } catch (err) { next(err); }
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
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    await db('customers').where({ id: req.params.id }).update({ deleted_at: new Date() });
    await auditCustomerMutation(req, 'customer.archive', req.params.id, { previousDeletedAt: customer.deleted_at || null }, true);
    logger.info(`[customers] Soft-deleted customer id=${req.params.id}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PATCH /api/admin/customers/:id/restore — restore a soft-deleted customer (admin only)
router.patch('/:id/restore', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNotNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found or not deleted' });

    await db('customers').where({ id: req.params.id }).update({ deleted_at: null });
    await auditCustomerMutation(req, 'customer.restore', req.params.id, { previousDeletedAt: customer.deleted_at || null }, true);
    logger.info(`[customers] Restored customer id=${req.params.id}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /api/admin/customers/:id/refund — Refund a Stripe payment
// =========================================================================
router.post('/:id/refund', requireAdmin, async (req, res, next) => {
  try {
    const { paymentId, amount, reason } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'paymentId required' });

    await auditCustomerMutation(req, 'customer.payment.refund', req.params.id, {
      paymentId,
      amount: amount || null,
      reason: reason || 'requested_by_customer',
    }, true);
    const StripeService = require('../services/stripe');
    const result = await StripeService.refund(paymentId, { amount, reason: reason || 'requested_by_customer' });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
