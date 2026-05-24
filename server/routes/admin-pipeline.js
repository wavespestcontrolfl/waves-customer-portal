const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { buildPipelineResponse } = require('../services/pipeline-opportunities');

const MAX_CANDIDATES = 5000;
const DEFAULT_REVIEWED_HISTORY_LIMIT = 20;
const MAX_REVIEWED_HISTORY_LIMIT = 100;

router.use(adminAuthenticate, requireTechOrAdmin);

function performedBy(req) {
  return [req.technician?.first_name, req.technician?.last_name].filter(Boolean).join(' ') || 'Admin';
}

function searchDigits(search) {
  return String(search || '').replace(/\D/g, '');
}

function searchRef(search) {
  return String(search || '').trim().replace(/^#/, '');
}

function cleanId(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function leadDisplayName(lead) {
  return [lead?.first_name, lead?.last_name].filter(Boolean).join(' ').trim() || lead?.name || 'Unknown Lead';
}

function estimateDisplayName(estimate) {
  return estimate?.customer_name || estimate?.name || 'Unknown Customer';
}

function matchCandidateLead(lead) {
  return {
    leadId: lead.id,
    name: leadDisplayName(lead),
    phone: lead.phone || null,
    email: lead.email || null,
    address: lead.address || null,
    serviceInterest: lead.service_interest || lead.serviceInterest || lead.service || null,
    source: lead.source_name || lead.source || lead.lead_source || null,
    status: lead.status || null,
    estimateId: lead.estimate_id || null,
    createdAt: lead.created_at || null,
    updatedAt: lead.updated_at || null,
  };
}

const DUPLICATE_DISMISS_REASONS = new Set([
  'not_same_customer',
  'bad_match',
  'already_handled',
  'other',
]);

function normalizeDismissReason(reason) {
  const normalized = String(reason || '').trim().toLowerCase();
  return DUPLICATE_DISMISS_REASONS.has(normalized) ? normalized : 'not_same_customer';
}

function filterDismissedCandidates(candidates, dismissedLeadIds = []) {
  const dismissedSet = new Set(dismissedLeadIds.map((leadId) => String(leadId)));
  const visibleCandidates = candidates.filter((candidate) => !dismissedSet.has(String(candidate.leadId)));
  return {
    candidates: visibleCandidates,
    dismissedCount: candidates.length - visibleCandidates.length,
  };
}

async function fetchDismissedLeadIdsForEstimate({ database = db, estimateId }) {
  const rows = await database('pipeline_duplicate_risk_dismissals')
    .where('estimate_id', estimateId)
    .select('lead_id');
  return rows.map((row) => row.lead_id).filter(Boolean);
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function historyLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_REVIEWED_HISTORY_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_REVIEWED_HISTORY_LIMIT);
}

function mapDismissalHistory(row) {
  return {
    id: row.id,
    action: 'dismissed',
    estimateId: row.estimate_id || null,
    leadId: row.lead_id || null,
    reason: row.reason || null,
    actor: row.dismissed_by_name || null,
    hasNote: Boolean(row.note),
    createdAt: row.updated_at || row.created_at || null,
  };
}

function mapLinkedHistory(row) {
  const metadata = parseJsonObject(row.metadata);
  return {
    id: row.id,
    action: 'linked',
    estimateId: metadata.estimateId || metadata.estimate_id || null,
    leadId: row.lead_id || null,
    reason: null,
    actor: row.performed_by || null,
    hasNote: false,
    createdAt: row.created_at || null,
  };
}

function compareHistoryCreatedAt(left, right) {
  const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
  const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
  return rightTime - leftTime;
}

async function getReviewedHistory({ database = db, limit = DEFAULT_REVIEWED_HISTORY_LIMIT } = {}) {
  const safeLimit = historyLimit(limit);
  const dismissalTableExists = await database.schema.hasTable('pipeline_duplicate_risk_dismissals');
  const dismissalRows = dismissalTableExists
    ? await database('pipeline_duplicate_risk_dismissals')
      .leftJoin('technicians', 'pipeline_duplicate_risk_dismissals.dismissed_by', 'technicians.id')
      .select(
        'pipeline_duplicate_risk_dismissals.*',
        database.raw('technicians.name as dismissed_by_name'),
      )
      .orderBy('pipeline_duplicate_risk_dismissals.updated_at', 'desc')
      .limit(safeLimit)
    : [];

  const linkedRows = await database('lead_activities')
    .where('activity_type', 'linked_estimate')
    .select('id', 'lead_id', 'performed_by', 'metadata', 'created_at')
    .orderBy('created_at', 'desc')
    .limit(safeLimit);

  const data = [
    ...dismissalRows.map(mapDismissalHistory),
    ...linkedRows.map(mapLinkedHistory),
  ].sort(compareHistoryCreatedAt).slice(0, safeLimit);

  return { data };
}

async function getLinkCandidateLeads({ database = db, estimateId }) {
  const id = cleanId(estimateId);
  if (!id) {
    const err = new Error('estimateId is required');
    err.status = 400;
    throw err;
  }

  const estimate = await database('estimates').where('id', id).first();
  if (!estimate || estimate.archived_at) {
    const err = new Error('Estimate not found');
    err.status = 404;
    throw err;
  }

  const phoneDigits = searchDigits(estimate.customer_phone || estimate.phone).slice(-10);
  const email = String(estimate.customer_email || estimate.email || '').trim().toLowerCase();
  const address = String(estimate.address || estimate.service_address || '').trim();
  const nameParts = String(estimate.customer_name || estimate.name || '').trim().split(/\s+/).filter(Boolean);
  const hasMatchSignal = phoneDigits.length >= 7 || email || address || nameParts.length;
  if (!hasMatchSignal) {
    return {
      estimate: {
        estimateId: estimate.id,
        name: estimateDisplayName(estimate),
        phone: estimate.customer_phone || null,
        email: estimate.customer_email || null,
        address: estimate.address || null,
        serviceInterest: estimate.service_interest || null,
        status: estimate.status || null,
        createdAt: estimate.created_at || null,
        updatedAt: estimate.updated_at || null,
      },
      candidates: [],
      dismissedCount: 0,
    };
  }

  let query = database('leads')
    .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
    .select('leads.*', 'lead_sources.name as source_name')
    .limit(10);

  query = query.where(function () {
    if (phoneDigits.length >= 7) {
      this.orWhereRaw("RIGHT(regexp_replace(COALESCE(leads.phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phoneDigits]);
    }
    if (email) {
      this.orWhereRaw('LOWER(COALESCE(leads.email, \'\')) = ?', [email]);
    }
    if (address) {
      this.orWhereILike('leads.address', `%${address}%`);
    }
    if (nameParts.length) {
      this.orWhere(function () {
        for (const part of nameParts.slice(0, 2)) {
          this.orWhereILike('leads.first_name', `%${part}%`)
            .orWhereILike('leads.last_name', `%${part}%`);
        }
      });
    }
  });

  const rows = await query.orderBy('leads.updated_at', 'desc');
  const dismissedLeadIds = await fetchDismissedLeadIdsForEstimate({ database, estimateId: id });
  const filtered = filterDismissedCandidates(rows.map(matchCandidateLead), dismissedLeadIds);

  return {
    estimate: {
      estimateId: estimate.id,
      name: estimateDisplayName(estimate),
      phone: estimate.customer_phone || null,
      email: estimate.customer_email || null,
      address: estimate.address || null,
      serviceInterest: estimate.service_interest || null,
      status: estimate.status || null,
      createdAt: estimate.created_at || null,
      updatedAt: estimate.updated_at || null,
    },
    candidates: filtered.candidates,
    dismissedCount: filtered.dismissedCount,
  };
}

async function linkOpportunityRecords({
  database = db,
  leadId,
  estimateId,
  force = false,
  actor = 'Admin',
}) {
  const cleanLeadId = cleanId(leadId);
  const cleanEstimateId = cleanId(estimateId);
  if (!cleanLeadId || !cleanEstimateId) {
    const err = new Error('leadId and estimateId are required');
    err.status = 400;
    throw err;
  }

  return database.transaction(async (trx) => {
    const lead = await trx('leads').where('id', cleanLeadId).first();
    if (!lead) {
      const err = new Error('Lead not found');
      err.status = 404;
      throw err;
    }

    const estimate = await trx('estimates').where('id', cleanEstimateId).first();
    if (!estimate || estimate.archived_at) {
      const err = new Error('Estimate not found');
      err.status = 404;
      throw err;
    }

    if (lead.estimate_id && String(lead.estimate_id) !== String(cleanEstimateId) && !force) {
      const err = new Error('Lead is already linked to a different estimate');
      err.status = 409;
      err.code = 'lead_already_linked';
      err.currentEstimateId = lead.estimate_id;
      throw err;
    }

    const [updatedLead] = await trx('leads')
      .where('id', cleanLeadId)
      .update({
        estimate_id: cleanEstimateId,
        updated_at: new Date(),
      })
      .returning('*');

    await trx('lead_activities').insert({
      lead_id: cleanLeadId,
      activity_type: 'linked_estimate',
      description: `Linked estimate ${cleanEstimateId}`,
      performed_by: actor,
      metadata: JSON.stringify({
        estimateId: cleanEstimateId,
        previousEstimateId: lead.estimate_id || null,
        source: 'admin_pipeline',
        forced: Boolean(force),
      }),
    });

    return {
      lead: updatedLead,
      estimate,
      linked: true,
    };
  });
}

async function dismissDuplicateRisk({
  database = db,
  estimateId,
  leadId = null,
  reason = 'not_same_customer',
  note = '',
  actorId = null,
}) {
  const cleanEstimateId = cleanId(estimateId);
  if (!cleanEstimateId) {
    const err = new Error('estimateId is required');
    err.status = 400;
    throw err;
  }

  const cleanLeadId = cleanId(leadId);
  if (!cleanLeadId) {
    const err = new Error('leadId is required');
    err.status = 400;
    throw err;
  }
  const cleanReason = normalizeDismissReason(reason);
  const cleanNote = String(note || '').trim() || null;

  return database.transaction(async (trx) => {
    const estimate = await trx('estimates').where('id', cleanEstimateId).first();
    if (!estimate || estimate.archived_at) {
      const err = new Error('Estimate not found');
      err.status = 404;
      throw err;
    }

    if (cleanLeadId) {
      const lead = await trx('leads').where('id', cleanLeadId).first();
      if (!lead) {
        const err = new Error('Lead not found');
        err.status = 404;
        throw err;
      }
    }

    const now = new Date();
    const [dismissal] = await trx('pipeline_duplicate_risk_dismissals')
      .insert({
        estimate_id: cleanEstimateId,
        lead_id: cleanLeadId,
        dismissed_by: actorId || null,
        reason: cleanReason,
        note: cleanNote,
        updated_at: now,
      })
      .onConflict(['estimate_id', 'lead_id'])
      .merge({
        lead_id: cleanLeadId,
        dismissed_by: actorId || null,
        reason: cleanReason,
        note: cleanNote,
        updated_at: now,
      })
      .returning('*');

    await trx('audit_log').insert({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId || null,
      action: 'pipeline.duplicate_risk.dismiss',
      resource_type: 'estimate',
      resource_id: cleanEstimateId,
      metadata: {
        estimateId: cleanEstimateId,
        leadId: cleanLeadId,
        reason: cleanReason,
        hasNote: Boolean(cleanNote),
        source: 'admin_pipeline',
      },
    });

    return {
      dismissed: true,
      dismissal,
      estimate,
    };
  });
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

async function fetchDismissedDuplicatePairs() {
  const exists = await db.schema.hasTable('pipeline_duplicate_risk_dismissals');
  if (!exists) return [];
  return db('pipeline_duplicate_risk_dismissals').select('estimate_id', 'lead_id');
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

    const [leadsRaw, estimatesRaw, dismissedDuplicatePairs] = await Promise.all([
      fetchLeads(query),
      fetchEstimates(query),
      fetchDismissedDuplicatePairs(),
    ]);
    const truncated = leadsRaw.length > MAX_CANDIDATES || estimatesRaw.length > MAX_CANDIDATES;
    const leads = leadsRaw.slice(0, MAX_CANDIDATES);
    const estimates = estimatesRaw.slice(0, MAX_CANDIDATES);

    res.json(buildPipelineResponse({
      leads,
      estimates,
      query,
      truncated,
      dismissedDuplicatePairs,
    }));
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/pipeline/opportunities/reviewed-history
router.get('/opportunities/reviewed-history', async (req, res, next) => {
  try {
    res.json(await getReviewedHistory({ limit: req.query.limit }));
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/pipeline/opportunities/:estimateId/link-candidates
router.get('/opportunities/:estimateId/link-candidates', async (req, res, next) => {
  try {
    res.json(await getLinkCandidateLeads({ estimateId: req.params.estimateId }));
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/pipeline/opportunities/link
router.post('/opportunities/link', async (req, res, next) => {
  try {
    const result = await linkOpportunityRecords({
      leadId: req.body.leadId || req.body.lead_id,
      estimateId: req.body.estimateId || req.body.estimate_id,
      force: req.body.force === true,
      actor: performedBy(req),
    });
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        currentEstimateId: err.currentEstimateId,
      });
    }
    next(err);
  }
});

// POST /api/admin/pipeline/opportunities/:estimateId/dismiss-duplicate-risk
router.post('/opportunities/:estimateId/dismiss-duplicate-risk', async (req, res, next) => {
  try {
    const result = await dismissDuplicateRisk({
      estimateId: req.params.estimateId,
      leadId: req.body.leadId || req.body.lead_id || null,
      reason: req.body.reason,
      note: req.body.note,
      actorId: req.technicianId || req.technician?.id || null,
    });
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
module.exports.__private = {
  applyEstimateSearch,
  applyLeadSearch,
  dismissDuplicateRisk,
  fetchDismissedDuplicatePairs,
  fetchDismissedLeadIdsForEstimate,
  filterDismissedCandidates,
  getLinkCandidateLeads,
  getReviewedHistory,
  historyLimit,
  linkOpportunityRecords,
  mapDismissalHistory,
  mapLinkedHistory,
  normalizeDismissReason,
  parseJsonObject,
  searchDigits,
  searchRef,
};
