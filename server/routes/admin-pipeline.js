const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { buildPipelineResponse } = require('../services/pipeline-opportunities');

const MAX_CANDIDATES = 5000;

router.use(adminAuthenticate, requireTechOrAdmin);

function searchDigits(search) {
  return String(search || '').replace(/\D/g, '');
}

function searchRef(search) {
  return String(search || '').trim().replace(/^#/, '');
}

function applyLeadSearch(query, search) {
  const term = String(search || '').trim();
  if (!term) return query;
  const s = `%${term}%`;
  const ref = searchRef(term);
  const digits = searchDigits(search);
  return query.where(function () {
    this.whereILike('leads.first_name', s)
      .orWhereILike('leads.last_name', s)
      .orWhereILike('leads.phone', s)
      .orWhereILike('leads.email', s)
      .orWhereILike('leads.address', s)
      .orWhereILike('leads.service_interest', s)
      .orWhereILike('lead_sources.name', s);
    if (ref) {
      this.orWhereRaw('leads.id::text ILIKE ?', [`%${ref}%`])
        .orWhereRaw('leads.estimate_id::text ILIKE ?', [`%${ref}%`]);
    }
    if (digits.length >= 7) {
      this.orWhereRaw("regexp_replace(COALESCE(leads.phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}%`]);
    }
  });
}

function applyEstimateSearch(query, search) {
  const term = String(search || '').trim();
  if (!term) return query;
  const s = `%${term}%`;
  const ref = searchRef(term);
  const digits = searchDigits(search);
  return query.where(function () {
    this.whereILike('estimates.customer_name', s)
      .orWhereILike('estimates.customer_phone', s)
      .orWhereILike('estimates.customer_email', s)
      .orWhereILike('estimates.address', s)
      .orWhereILike('estimates.service_interest', s)
      .orWhereILike('estimates.lead_source', s)
      .orWhereILike('estimates.source', s);
    if (ref) {
      this.orWhereRaw('estimates.id::text ILIKE ?', [`%${ref}%`])
        .orWhereRaw('estimates.customer_id::text ILIKE ?', [`%${ref}%`]);
    }
    if (digits.length >= 7) {
      this.orWhereRaw("regexp_replace(COALESCE(estimates.customer_phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}%`]);
    }
  });
}

async function fetchLeads({ search, source, ownerId }) {
  let query = db('leads')
    .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
    .leftJoin('technicians', 'leads.assigned_to', 'technicians.id')
    .select(
      'leads.*',
      'lead_sources.name as source_name',
      'lead_sources.source_type',
      'lead_sources.channel as source_channel',
      db.raw('technicians.name as assigned_name'),
    )
    .orderBy('leads.first_contact_at', 'desc')
    .limit(MAX_CANDIDATES + 1);

  query = applyLeadSearch(query, search);
  if (source) {
    query = query.where(function () {
      this.whereILike('lead_sources.name', source)
        .orWhereILike('lead_sources.channel', source)
        .orWhereILike('leads.lead_type', source);
    });
  }
  if (ownerId) query = query.where('leads.assigned_to', ownerId);
  return query;
}

async function fetchEstimates({ search, source, ownerId }) {
  let query = db('estimates')
    .leftJoin('technicians', 'estimates.created_by_technician_id', 'technicians.id')
    .select('estimates.*', 'technicians.name as created_by_name')
    .whereNull('estimates.archived_at')
    .orderBy('estimates.created_at', 'desc')
    .limit(MAX_CANDIDATES + 1);

  query = applyEstimateSearch(query, search);
  if (source) {
    query = query.where(function () {
      this.whereILike('estimates.source', source)
        .orWhereILike('estimates.lead_source', source);
    });
  }
  if (ownerId) query = query.where('estimates.created_by_technician_id', ownerId);
  return query;
}

// GET /api/admin/pipeline/opportunities
router.get('/opportunities', async (req, res, next) => {
  try {
    const query = {
      search: req.query.search || '',
      stage: req.query.stage || req.query.filter || '',
      status: req.query.status || '',
      needsAction: req.query.needsAction ?? '',
      source: req.query.source || '',
      ownerId: req.query.ownerId || req.query.owner_id || '',
      dateFrom: req.query.dateFrom || req.query.date_from || '',
      dateTo: req.query.dateTo || req.query.date_to || '',
      sort: req.query.sort || 'default',
      page: req.query.page || 1,
      pageSize: req.query.pageSize || req.query.page_size || 50,
    };

    const [leadsRaw, estimatesRaw] = await Promise.all([
      fetchLeads(query),
      fetchEstimates(query),
    ]);
    const truncated = leadsRaw.length > MAX_CANDIDATES || estimatesRaw.length > MAX_CANDIDATES;
    const leads = leadsRaw.slice(0, MAX_CANDIDATES);
    const estimates = estimatesRaw.slice(0, MAX_CANDIDATES);

    res.json(buildPipelineResponse({
      leads,
      estimates,
      query,
      truncated,
    }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.__private = {
  applyEstimateSearch,
  applyLeadSearch,
  searchDigits,
  searchRef,
};
