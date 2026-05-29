const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { etDateString } = require('../utils/datetime-et');
const {
  syncCommandCenterAlerts,
  applyAlertLifecycle,
  updateAlert,
  listEvents,
} = require('../services/admin-alerts');
const { resolveCloseoutRequirementsForJobs } = require('../services/service-closeout-requirements');

router.use(adminAuthenticate, requireAdmin);

const DEFAULTS = {
  agedEstimateDays: 3,
  expiringEstimateDays: 2,
  staleLeadHours: 2,
  highValueEstimateAmount: 1000,
  highValueInvoiceAmount: 1000,
};

const PRE_ARRIVAL_JOB_STATUSES = new Set(['pending', 'confirmed', 'rescheduled', 'en_route']);
const DONE_JOB_STATUSES = new Set(['completed', 'cancelled', 'canceled', 'skipped']);
const COMPLETED_JOB_STATUS = 'completed';
const OPEN_ESTIMATE_STATUSES = ['sent', 'viewed', 'open'];
const OPEN_LEAD_STATUSES = ['new', 'open', 'contacted', 'qualified'];

function selectedDate(req) {
  const raw = String(req.query.date || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : etDateString();
}

function nowMinutesET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function timeToMinutes(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function customerName(row) {
  return [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.customer_name || 'Unknown customer';
}

function customerHref(id) {
  return id ? `/admin/customers?customerId=${encodeURIComponent(id)}` : null;
}

function jobHref(id) {
  return `/admin/dispatch?job=${encodeURIComponent(id)}`;
}

function estimateHref(id) {
  return `/admin/estimates?estimateId=${encodeURIComponent(id)}`;
}

function leadHref(id) {
  return `/admin/leads?leadId=${encodeURIComponent(id)}`;
}

function invoiceHref(row) {
  return `/admin/invoices?search=${encodeURIComponent(row.invoice_number || row.id)}`;
}

function employee(row, role = 'technician') {
  const id = row.technician_id || row.assigned_to || row.created_by_technician_id || null;
  const name = row.tech_name || row.assigned_name || row.created_by_name || null;
  return id || name ? { id, name: name || 'Unassigned', role } : null;
}

function issue({
  id,
  type,
  severity = 'medium',
  label,
  summary,
  sourceRecordType,
  sourceRecordId,
  href,
  customer,
  employee,
  occurredAt,
  metadata,
}) {
  return { id, type, severity, label, summary, sourceRecordType, sourceRecordId, href, customer, employee, occurredAt, metadata: metadata || {} };
}

function mapJob(row) {
  const name = customerName(row);
  return {
    id: row.id,
    type: 'today_job',
    severity: 'info',
    label: row.service_type || 'Scheduled service',
    summary: `${row.window_start || 'Any time'}${row.window_end ? `-${row.window_end}` : ''} · ${name}`,
    sourceRecordType: 'job',
    sourceRecordId: row.id,
    href: jobHref(row.id),
    customer: { id: row.customer_id, name, href: customerHref(row.customer_id) },
    employee: employee(row),
    occurredAt: row.scheduled_date,
    metadata: {
      serviceType: row.service_type,
      serviceId: row.service_id || null,
      status: row.status,
      scheduledWindow: [row.window_start, row.window_end].filter(Boolean).join(' - '),
      technicianName: row.tech_name || null,
    },
  };
}

async function getTodaysJobs({ date, technicianId, serviceLine }) {
  const q = db('scheduled_services as s')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .leftJoin('technicians as t', 's.technician_id', 't.id')
    .where('s.scheduled_date', date)
    .select(
      's.id',
      's.customer_id',
      's.technician_id',
      's.service_id',
      's.service_type',
      's.scheduled_date',
      's.window_start',
      's.window_end',
      's.status',
      'c.first_name',
      'c.last_name',
      't.name as tech_name',
    )
    .orderByRaw('COALESCE(s.window_start, \'23:59\'), c.last_name NULLS LAST');
  if (technicianId) q.where('s.technician_id', technicianId);
  if (serviceLine) q.whereILike('s.service_type', `%${serviceLine}%`);
  const rows = await q;
  return rows.map(mapJob);
}

async function getJobsNeedingAttention({ date, technicianId, serviceLine }) {
  const rows = await getTodaysJobs({ date, technicianId, serviceLine });
  const currentMinutes = date === etDateString() ? nowMinutesET() : null;
  const attention = [];
  const completedJobIds = rows
    .filter((r) => r.metadata.status === COMPLETED_JOB_STATUS)
    .map((r) => r.sourceRecordId);

  for (const row of rows) {
    const status = String(row.metadata.status || '').toLowerCase();
    if (!row.employee?.id && !DONE_JOB_STATUSES.has(status)) {
      attention.push(issue({
        ...row,
        id: `${row.sourceRecordId}_unassigned`,
        type: 'unassigned_job',
        severity: 'high',
        label: 'Unassigned job',
        summary: `${row.customer.name} has no assigned technician.`,
      }));
    }

    const windowEnd = timeToMinutes(row.metadata.scheduledWindow?.split(' - ')[1]);
    if (currentMinutes != null && windowEnd != null && currentMinutes > windowEnd && PRE_ARRIVAL_JOB_STATUSES.has(status)) {
      attention.push(issue({
        ...row,
        id: `${row.sourceRecordId}_late`,
        type: 'late_job',
        severity: 'high',
        label: 'Late job',
        summary: `${row.customer.name} is past the scheduled window and still ${status}.`,
      }));
    }

    if (['blocked', 'hold', 'problem'].includes(status)) {
      attention.push(issue({
        ...row,
        id: `${row.sourceRecordId}_blocked`,
        type: 'blocked_job',
        severity: 'high',
        label: 'Blocked job',
        summary: `${row.customer.name} is marked ${status}.`,
      }));
    }
  }

  if (completedJobIds.length) {
    const completedJobs = rows
      .filter((r) => completedJobIds.includes(r.sourceRecordId))
      .map((r) => ({
        id: r.sourceRecordId,
        service_id: r.metadata.serviceId,
        service_type: r.metadata.serviceType,
      }));
    const requirementsByJob = await resolveCloseoutRequirementsForJobs(completedJobs);
    const formRows = await db('job_form_submissions')
      .whereIn('scheduled_service_id', completedJobIds)
      .whereNotNull('completed_at')
      .select('scheduled_service_id')
      .catch(() => []);
    const withForms = new Set(formRows.map((r) => r.scheduled_service_id));

    const appRows = await db('property_application_history as pah')
      .leftJoin('service_records as sr', 'pah.service_record_id', 'sr.id')
      .whereIn('sr.scheduled_service_id', completedJobIds)
      .select('sr.scheduled_service_id')
      .catch(() => []);
    const withApplications = new Set(appRows.map((r) => r.scheduled_service_id));

    for (const row of rows.filter((r) => completedJobIds.includes(r.sourceRecordId))) {
      const closeoutRequirements = requirementsByJob.get(row.sourceRecordId) || {};
      if (closeoutRequirements.requiresServiceReport && !withForms.has(row.sourceRecordId)) {
        attention.push(issue({
          ...row,
          id: `${row.sourceRecordId}_missing_required_service_report`,
          type: 'missing_required_service_report',
          severity: 'medium',
          label: 'Missing required service report',
          summary: 'Completed job is missing the required closeout report.',
          metadata: { ...row.metadata, closeoutRequirements },
        }));
      }
      if (closeoutRequirements.requiresApplicationLog && !withApplications.has(row.sourceRecordId)) {
        attention.push(issue({
          ...row,
          id: `${row.sourceRecordId}_missing_required_material_log`,
          type: 'missing_required_material_log',
          severity: 'medium',
          label: 'Missing required material log',
          summary: 'Completed job is missing the required chemical or material application record.',
          metadata: { ...row.metadata, closeoutRequirements },
        }));
      }
    }
  }

  return attention.slice(0, 50);
}

async function getPipelineFollowUp() {
  const now = new Date();
  const agedCutoff = new Date(now.getTime() - DEFAULTS.agedEstimateDays * 86400000);
  const expiringCutoff = new Date(now.getTime() + DEFAULTS.expiringEstimateDays * 86400000);
  const rows = await db('estimates as e')
    .leftJoin('customers as c', 'e.customer_id', 'c.id')
    .leftJoin('technicians as t', 'e.created_by_technician_id', 't.id')
    .whereNull('e.archived_at')
    .where((qb) => {
      qb.whereIn('e.status', OPEN_ESTIMATE_STATUSES)
        .orWhere('e.status', 'draft')
        .orWhere(function () {
          this.whereIn('e.status', OPEN_ESTIMATE_STATUSES).where('e.expires_at', '<=', expiringCutoff);
        });
    })
    .select('e.*', 'c.first_name', 'c.last_name', 't.name as created_by_name')
    .orderBy('e.created_at', 'desc')
    .limit(80);

  const items = [];
  for (const row of rows) {
    const name = customerName(row);
    const base = {
      sourceRecordType: 'estimate',
      sourceRecordId: row.id,
      href: estimateHref(row.id),
      customer: { id: row.customer_id, name, href: customerHref(row.customer_id) },
      employee: employee(row, 'sales'),
      occurredAt: row.sent_at || row.created_at,
      metadata: {
        status: row.status,
        amount: Number(row.monthly_total || row.onetime_total || row.total || 0),
        sentAt: row.sent_at,
        expiresAt: row.expires_at,
      },
    };
    if (row.status === 'draft') {
      items.push(issue({ ...base, id: `${row.id}_draft`, type: 'draft_estimate', severity: 'low', label: 'Draft estimate', summary: `${name} has an estimate that has not been sent.` }));
    } else if (row.sent_at && new Date(row.sent_at) < agedCutoff) {
      items.push(issue({ ...base, id: `${row.id}_aged`, type: 'aged_estimate', severity: 'medium', label: 'Aged estimate', summary: `${name} has an open estimate older than ${DEFAULTS.agedEstimateDays} days.` }));
    } else if (row.expires_at && new Date(row.expires_at) <= expiringCutoff) {
      items.push(issue({ ...base, id: `${row.id}_expiring`, type: 'expiring_estimate', severity: 'medium', label: 'Expiring estimate', summary: `${name} has an estimate expiring soon.` }));
    }
    const amount = Number(row.monthly_total || row.onetime_total || 0);
    if (amount >= DEFAULTS.highValueEstimateAmount && OPEN_ESTIMATE_STATUSES.includes(row.status)) {
      items.push(issue({ ...base, id: `${row.id}_high_value`, type: 'high_value_open_estimate', severity: 'medium', label: 'High-value open estimate', summary: `${name} has an open estimate over $${DEFAULTS.highValueEstimateAmount}.` }));
    }
  }
  return items.slice(0, 30);
}

async function getMissedLeads() {
  const staleCutoff = new Date(Date.now() - DEFAULTS.staleLeadHours * 3600000);
  const rows = await db('leads as l')
    .leftJoin('technicians as t', 'l.assigned_to', 't.id')
    .whereIn('l.status', OPEN_LEAD_STATUSES)
    .where((qb) => {
      qb.whereNull('l.assigned_to')
        .orWhereNull('l.first_contact_at')
        .orWhere('l.created_at', '<', staleCutoff);
    })
    .select('l.*', 't.name as assigned_name')
    .orderBy('l.created_at', 'desc')
    .limit(40);

  return rows.map((row) => {
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.phone || 'Unknown lead';
    const type = !row.assigned_to ? 'unassigned_lead' : 'stale_lead';
    return issue({
      id: `${row.id}_${type}`,
      type,
      severity: type === 'unassigned_lead' ? 'medium' : 'low',
      label: type === 'unassigned_lead' ? 'Unassigned lead' : 'Stale lead',
      summary: type === 'unassigned_lead' ? `${name} needs an owner.` : `${name} may need follow-up.`,
      sourceRecordType: 'lead',
      sourceRecordId: row.id,
      href: leadHref(row.id),
      customer: row.customer_id ? { id: row.customer_id, name, href: customerHref(row.customer_id) } : null,
      employee: employee(row, 'sales'),
      occurredAt: row.created_at || row.first_contact_at,
      metadata: { status: row.status, serviceInterest: row.service_interest, channel: row.first_contact_channel },
    });
  });
}

async function getMoneyCollections() {
  const rows = await db('invoices as i')
    .leftJoin('customers as c', 'i.customer_id', 'c.id')
    .whereNull('i.archived_at')
    .whereNotIn('i.status', ['draft', 'paid', 'void', 'processing'])
    .where((qb) => {
      qb.where('i.status', 'overdue').orWhere('i.due_date', '<', etDateString()).orWhere('i.total', '>=', DEFAULTS.highValueInvoiceAmount);
    })
    .select('i.*', 'c.first_name', 'c.last_name')
    .orderBy('i.due_date', 'asc')
    .limit(40);
  return rows.map((row) => {
    const name = customerName(row);
    const highValue = Number(row.total || 0) >= DEFAULTS.highValueInvoiceAmount;
    return issue({
      id: `${row.id}_${row.status === 'overdue' || row.due_date < etDateString() ? 'overdue' : 'high_value_unpaid'}`,
      type: row.status === 'overdue' || row.due_date < etDateString() ? 'overdue_invoice' : 'high_value_unpaid_invoice',
      severity: row.status === 'overdue' || row.due_date < etDateString() ? 'high' : 'medium',
      label: row.status === 'overdue' || row.due_date < etDateString() ? 'Overdue invoice' : 'High-value unpaid invoice',
      summary: `${name} owes $${Number(row.total || 0).toFixed(2)}${highValue ? ' on a high-value invoice' : ''}.`,
      sourceRecordType: 'invoice',
      sourceRecordId: row.id,
      href: invoiceHref(row),
      customer: { id: row.customer_id, name, href: customerHref(row.customer_id) },
      employee: null,
      occurredAt: row.due_date || row.created_at,
      metadata: { invoiceNumber: row.invoice_number, status: row.status, total: Number(row.total || 0), dueDate: row.due_date },
    });
  });
}

async function getCustomerIssues() {
  const messages = await db('messages as m')
    .leftJoin('conversations as v', 'm.conversation_id', 'v.id')
    .leftJoin('customers as c', 'v.customer_id', 'c.id')
    .where('m.channel', 'sms')
    .where('m.direction', 'inbound')
    .andWhere(function () { this.where({ 'm.is_read': false }).orWhereNull('m.is_read'); })
    .select('m.id', 'm.body', 'm.created_at', 'v.customer_id', 'v.contact_phone', 'c.first_name', 'c.last_name')
    .orderBy('m.created_at', 'desc')
    .limit(30)
    .catch(() => []);

  return messages.map((row) => {
    const name = customerName(row) || row.contact_phone || 'Unknown sender';
    return issue({
      id: `${row.id}_unread_message`,
      type: 'unread_inbound_message',
      severity: 'medium',
      label: 'Unread customer message',
      summary: row.body ? String(row.body).slice(0, 120) : `${name} has an unread inbound message.`,
      sourceRecordType: 'message',
      sourceRecordId: row.id,
      href: row.customer_id ? `/admin/communications?customerId=${encodeURIComponent(row.customer_id)}` : '/admin/communications',
      customer: row.customer_id ? { id: row.customer_id, name, href: customerHref(row.customer_id) } : null,
      employee: null,
      occurredAt: row.created_at,
      metadata: { phone: row.contact_phone },
    });
  });
}

function rollupTeamAttention(sections) {
  const counts = new Map();
  const sourceSections = ['jobsNeedingAttention', 'pipelineFollowUp', 'missedLeads'];
  for (const section of sourceSections) {
    for (const row of sections[section] || []) {
      if (!row.employee?.id && !row.employee?.name) continue;
      const key = row.employee.id || row.employee.name;
      const existing = counts.get(key) || {
        id: `team_${key}`,
        type: 'team_attention',
        severity: 'medium',
        label: 'Needs follow-up',
        employee: row.employee,
        count: 0,
        issueTypes: new Set(),
      };
      existing.count += 1;
      existing.issueTypes.add(row.label);
      counts.set(key, existing);
    }
  }
  return [...counts.values()].map((row) => ({
    id: row.id,
    type: row.type,
    severity: row.count >= 3 ? 'high' : 'medium',
    label: row.label,
    summary: `${row.employee.name || 'Team member'} has ${row.count} operational item${row.count === 1 ? '' : 's'} needing follow-up.`,
    sourceRecordType: 'employee',
    sourceRecordId: row.employee.id,
    href: '/admin/dashboard',
    customer: null,
    employee: row.employee,
    occurredAt: null,
    metadata: { count: row.count, issueTypes: [...row.issueTypes] },
  })).slice(0, 20);
}

router.get('/', async (req, res, next) => {
  try {
    const date = selectedDate(req);
    const filters = {
      branchId: req.query.branchId || null,
      technicianId: req.query.technicianId || null,
      serviceLine: req.query.serviceLine || null,
    };
    const base = { date, technicianId: filters.technicianId, serviceLine: filters.serviceLine };
    const [
      todaysJobs,
      jobsNeedingAttention,
      pipelineFollowUp,
      missedLeads,
      moneyCollections,
      customerIssues,
    ] = await Promise.all([
      getTodaysJobs(base),
      getJobsNeedingAttention(base),
      getPipelineFollowUp(base),
      getMissedLeads(base),
      getMoneyCollections(base),
      getCustomerIssues(base),
    ]);
    const rawSections = {
      todaysJobs,
      jobsNeedingAttention,
      pipelineFollowUp,
      missedLeads,
      moneyCollections,
      customerIssues,
      teamAttention: [],
    };
    const alertsByKey = await syncCommandCenterAlerts(rawSections);
    const sections = applyAlertLifecycle(rawSections, alertsByKey);
    sections.teamAttention = rollupTeamAttention(sections);
    res.json({
      date,
      filters,
      summary: {
        todaysJobs: todaysJobs.length,
        jobsNeedingAttention: jobsNeedingAttention.length,
        agedEstimates: pipelineFollowUp.length,
        missedLeads: missedLeads.length,
        overdueInvoices: moneyCollections.length,
        openCustomerIssues: customerIssues.length,
        teamAttentionItems: sections.teamAttention.length,
      },
      sections,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/alerts/:id', async (req, res, next) => {
  try {
    const action = String(req.body?.action || '').trim();
    const alert = await updateAlert({
      id: req.params.id,
      action,
      actorUserId: req.technicianId,
      ownerUserId: req.body?.ownerUserId,
      snoozedUntil: req.body?.snoozedUntil,
      note: req.body?.note,
    });
    res.json({ alert });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/alerts/:id/events', async (req, res, next) => {
  try {
    const events = await listEvents(req.params.id);
    res.json({ events });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
