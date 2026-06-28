const crypto = require('crypto');

const db = require('../models/db');
const logger = require('./logger');
const { transitionJobStatus } = require('./job-status');
const { resolveCompletionProfileForScheduledService } = require('./service-completion-profiles');
const { buildCompletionLifecycleUpdates } = require('../utils/service-duration-capture');
const { etDateString } = require('../utils/datetime-et');
const { projectReportPathForProject } = require('./project-report-links');
const { createAlertOnce } = require('./dispatch-alerts');

const NON_MEMBERSHIP_TIER_KEYS = new Set(['none', 'onetime', 'na', 'no', 'notset', 'commercial']);
const TERMINAL_NON_COMPLETABLE_STATUSES = new Set(['cancelled', 'skipped', 'no_show']);

function normalizeDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function addDaysToDateOnly(value, days = 0) {
  const dateOnly = normalizeDateOnly(value) || etDateString();
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function serializeJsonb(value) {
  return JSON.stringify(value ?? null);
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function pickExistingColumns(values = {}, columnInfo = {}) {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => Boolean(columnInfo[key]))
  );
}

function membershipTierKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function hasMembership(customer = {}) {
  const rawTier = customer.waveguard_tier ?? customer.tier;
  const tierKey = membershipTierKey(rawTier);
  if (tierKey && NON_MEMBERSHIP_TIER_KEYS.has(tierKey)) return false;
  if (tierKey) return true;
  const monthlyRate = Number(customer.monthly_rate ?? customer.monthlyRate ?? 0);
  return Number.isFinite(monthlyRate) && monthlyRate > 0;
}

async function hasActiveRecurringSchedule(customerId, knex = db) {
  if (!customerId) return false;
  const cols = await knex('scheduled_services').columnInfo().catch(() => ({}));
  const hasRecurringCols = cols.is_recurring || cols.recurring_parent_id || cols.recurring_pattern;
  if (!hasRecurringCols) return false;

  const row = await knex('scheduled_services')
    .where({ customer_id: customerId })
    .whereNotIn('status', ['cancelled', 'completed', 'skipped', 'no_show'])
    .where(function recurringOnly() {
      if (cols.is_recurring) this.orWhere({ is_recurring: true });
      if (cols.recurring_parent_id) this.orWhereNotNull('recurring_parent_id');
      if (cols.recurring_pattern) this.orWhereNotNull('recurring_pattern');
    })
    .first('id')
    .catch((err) => {
      logger.warn(`[project-completion] recurring schedule lookup failed for ${customerId}: ${err.message}`);
      return null;
    });
  return Boolean(row);
}

async function isRecurringCustomer(customer = {}, knex = db) {
  if (!customer?.id) return false;
  if (customer.active === false || customer.deleted_at) return false;
  if (hasMembership(customer)) return true;
  return hasActiveRecurringSchedule(customer.id, knex);
}

function shouldAttachProjectToPortal({ profile = {}, customer = {}, recurringCustomer = false } = {}) {
  if (profile.portalVisibility === 'internal_only') return false;
  const policy = profile.portalAttachPolicy || 'never';
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  if (policy === 'active_portal_customer') return customer.active !== false && !customer.deleted_at;
  if (policy === 'recurring_customer') return Boolean(recurringCustomer);
  return false;
}

function projectReviewedForPortalAttachment(project = {}) {
  return String(project.status || '').toLowerCase() === 'sent' || Boolean(project.sent_at);
}

function positiveMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function projectCompletionInvoiceAmount({ scheduledService = {}, customer = {} } = {}) {
  const estimated = positiveMoney(scheduledService.estimated_price);
  if (estimated > 0) return estimated;
  // Callbacks (re-services, e.g. pest_re_service / lawn_re_service) are free
  // for recurring/WaveGuard customers — they must never fall back to the
  // monthly rate, or the completion billing guard would either bill a month's
  // dues or block the visit on a "billing required" 409. An explicit positive
  // price above still bills if the operator set one.
  if (scheduledService.is_callback) return 0;
  if (scheduledService.create_invoice_on_complete) {
    return positiveMoney(customer.monthly_rate ?? scheduledService.monthly_rate);
  }
  return 0;
}

function prepaidCoversAmount(scheduledService = {}, amount = 0) {
  const prepaid = positiveMoney(scheduledService.prepaid_amount);
  return amount > 0 && prepaid >= amount;
}

function operationalError(message, { status = 400, code = null, details = null } = {}) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.code = code;
  err.details = details;
  err.isOperational = true;
  return err;
}

async function findExistingCompletionInvoice({
  scheduledServiceId,
  serviceRecordId = null,
  knex = db,
} = {}) {
  if (!scheduledServiceId && !serviceRecordId) return null;
  try {
    const query = knex('invoices')
      .whereNot('status', 'void')
      .where(function invoiceForCompletion() {
        if (scheduledServiceId) this.orWhere({ scheduled_service_id: scheduledServiceId });
        if (serviceRecordId) this.orWhere({ service_record_id: serviceRecordId });
      })
      .orderBy('created_at', 'desc');
    return query.first();
  } catch (err) {
    logger.warn(`[project-completion] invoice lookup failed for scheduled service ${scheduledServiceId}: ${err.message}`);
    return null;
  }
}

async function resolveProjectCompletionBilling({
  scheduledService,
  serviceRecord = null,
  customer = {},
  knex = db,
} = {}) {
  const invoiceAmount = projectCompletionInvoiceAmount({ scheduledService, customer });
  if (!(invoiceAmount > 0)) {
    return { required: false, resolved: true, amount: 0, reason: 'not_billable' };
  }
  if (prepaidCoversAmount(scheduledService, invoiceAmount)) {
    return { required: true, resolved: true, amount: invoiceAmount, reason: 'prepaid_covered' };
  }
  const invoice = await findExistingCompletionInvoice({
    scheduledServiceId: scheduledService.id,
    serviceRecordId: serviceRecord?.id || null,
    knex,
  });
  if (invoice) {
    return {
      required: true,
      resolved: true,
      amount: invoiceAmount,
      reason: 'invoice_exists',
      invoice,
    };
  }
  return {
    required: true,
    resolved: false,
    amount: invoiceAmount,
    reason: 'invoice_required',
  };
}

function projectCompletionNotes({ project, profile, portalAttached, reportPath }) {
  return {
    projectCompletion: true,
    projectId: project.id,
    projectType: project.project_type,
    projectTitle: project.title || null,
    completionMode: profile.completionMode || null,
    portalVisibility: profile.portalVisibility || null,
    portalAttachPolicy: profile.portalAttachPolicy || null,
    portalAttached: Boolean(portalAttached),
    projectReport: {
      token: project.report_token || null,
      url: portalAttached ? reportPath : null,
      tokenOnly: !portalAttached && Boolean(project.report_token),
    },
  };
}

function projectFollowupSuggestion({
  scheduledService = {},
  project = {},
  profile = {},
} = {}) {
  const policy = profile.followupPolicy || 'none';
  const days = profile.defaultFollowupDays == null ? null : Number(profile.defaultFollowupDays);
  const baseDate = project.project_date || scheduledService.scheduled_date || etDateString();
  const normalizedDays = Number.isFinite(days) ? days : null;
  const suggestedDate = Number.isFinite(days) ? addDaysToDateOnly(baseDate, days) : null;
  if (policy === 'none') {
    return {
      required: false,
      policy,
      days: null,
      suggestedDate: null,
      alertType: null,
    };
  }
  if (policy === 'auto_schedule') {
    return {
      required: true,
      policy,
      days: normalizedDays,
      suggestedDate,
      alertType: null,
      unsupported: true,
      reason: 'auto_schedule_not_implemented',
    };
  }
  if (policy !== 'alert') {
    return {
      required: false,
      policy,
      days: normalizedDays,
      suggestedDate,
      alertType: null,
      reason: 'unsupported_followup_policy',
    };
  }
  return {
    required: true,
    policy,
    days: normalizedDays,
    suggestedDate,
    alertType: 'follow_up_needed',
  };
}

function buildServiceRecordInsert({
  scheduledService,
  project,
  profile,
  serviceRecordCols = {},
  lifecycleUpdates = {},
  portalAttached = false,
  reportPath = null,
}) {
  const serviceDate = normalizeDateOnly(project.project_date)
    || normalizeDateOnly(scheduledService.scheduled_date)
    || etDateString();
  const notes = [
    project.title ? `Project completed: ${project.title}` : 'Project completed.',
    project.recommendations ? String(project.recommendations).trim() : '',
  ].filter(Boolean).join('\n\n');
  const structuredNotes = projectCompletionNotes({
    project,
    profile,
    portalAttached,
    reportPath,
  });

  const recordInsert = {
    customer_id: scheduledService.customer_id,
    technician_id: scheduledService.technician_id || project.created_by_tech_id || null,
    service_date: serviceDate,
    service_type: scheduledService.service_type || profile.serviceName || project.title || 'Project service',
    status: 'completed',
    technician_notes: notes,
  };

  if (serviceRecordCols.scheduled_service_id) recordInsert.scheduled_service_id = scheduledService.id;
  if (serviceRecordCols.structured_notes) recordInsert.structured_notes = serializeJsonb(structuredNotes);
  if (serviceRecordCols.completion_source) recordInsert.completion_source = 'project_completion';
  if (serviceRecordCols.protocol_defaults_used) recordInsert.protocol_defaults_used = false;
  if (serviceRecordCols.service_data) {
    recordInsert.service_data = serializeJsonb({
      project: {
        id: project.id,
        type: project.project_type,
        findings: project.findings || {},
      },
    });
  }
  Object.assign(recordInsert, pickExistingColumns(lifecycleUpdates, serviceRecordCols));
  return recordInsert;
}

function projectServiceData(project) {
  return {
    project: {
      id: project.id,
      type: project.project_type,
      findings: project.findings || {},
    },
  };
}

function serviceRecordMatchesScheduledService(serviceRecord = {}, scheduledService = {}) {
  if (!serviceRecord?.id || !scheduledService?.id) return false;
  if (!serviceRecord.scheduled_service_id) return false;
  return String(serviceRecord.scheduled_service_id) === String(scheduledService.id);
}

async function createProjectFollowupAlert({
  scheduledService,
  project,
  serviceRecord,
  profile,
  customer,
  followup,
  trx,
} = {}) {
  if (!followup?.required || followup.policy !== 'alert' || !scheduledService?.id) {
    return {
      required: !!followup?.required,
      created: false,
      skipped: true,
      reason: followup?.reason || (followup?.policy ? 'not_alert_policy' : 'not_required'),
    };
  }

  const customerName = [
    customer?.first_name,
    customer?.last_name,
  ].filter(Boolean).join(' ').trim() || null;
  const alertType = followup.alertType || 'follow_up_needed';
  const existing = await trx('dispatch_alerts')
    .where({
      type: alertType,
      job_id: scheduledService.id,
    })
    .whereNull('resolved_at')
    .first('id');
  if (existing) {
    return {
      required: true,
      created: false,
      existingAlertId: existing.id,
      suggestedDate: followup.suggestedDate,
      days: followup.days,
      policy: followup.policy,
    };
  }
  const payload = {
    source: 'project_completion',
    projectId: project.id,
    projectType: project.project_type,
    serviceRecordId: serviceRecord?.id || null,
    serviceType: scheduledService.service_type || profile.serviceName || null,
    customerId: scheduledService.customer_id || null,
    customerName,
    followupPolicy: followup.policy,
    followupDays: followup.days,
    suggestedFollowupDate: followup.suggestedDate,
  };
  const alertResult = await createAlertOnce({
    type: alertType,
    severity: 'info',
    techId: scheduledService.technician_id || null,
    jobId: scheduledService.id,
    trx,
    payload,
    existingPayloadSource: 'project_completion',
  });
  if (!alertResult?.created) {
    return {
      required: true,
      created: false,
      existingAlertId: alertResult?.row?.id || null,
      suggestedDate: followup.suggestedDate,
      days: followup.days,
      policy: followup.policy,
    };
  }
  return {
    required: true,
    created: true,
    alertId: alertResult.row?.id || null,
    suggestedDate: followup.suggestedDate,
    days: followup.days,
    policy: followup.policy,
  };
}

function buildServiceRecordProjectCompletionUpdate({
  serviceRecord = {},
  project,
  profile,
  serviceRecordCols = {},
  lifecycleUpdates = {},
  portalAttached = false,
  reportPath = null,
  nowValue = null,
}) {
  const structuredNotes = projectCompletionNotes({
    project,
    profile,
    portalAttached,
    reportPath,
  });
  const existingStructuredNotes = parseJsonObject(serviceRecord.structured_notes);
  const existingServiceData = parseJsonObject(serviceRecord.service_data);
  const update = {
    status: 'completed',
  };

  if (serviceRecordCols.structured_notes) {
    update.structured_notes = serializeJsonb({
      ...existingStructuredNotes,
      ...structuredNotes,
    });
  }
  if (serviceRecordCols.completion_source) update.completion_source = 'project_completion';
  if (serviceRecordCols.protocol_defaults_used) update.protocol_defaults_used = false;
  if (serviceRecordCols.service_data) {
    update.service_data = serializeJsonb({
      ...existingServiceData,
      ...projectServiceData(project),
    });
  }
  if (serviceRecordCols.report_view_token) update.report_view_token = null;
  if (serviceRecordCols.report_template_version) update.report_template_version = null;
  if (serviceRecordCols.pdf_storage_key) update.pdf_storage_key = null;
  if (serviceRecordCols.report_html_storage_key) update.report_html_storage_key = null;
  if (serviceRecordCols.map_svg_storage_key) update.map_svg_storage_key = null;
  if (serviceRecordCols.updated_at && nowValue) update.updated_at = nowValue;

  return {
    ...pickExistingColumns(lifecycleUpdates, serviceRecordCols),
    ...pickExistingColumns(update, serviceRecordCols),
  };
}

async function completeProjectBackedService({
  projectId,
  actorId = null,
  now = new Date(),
  knex = db,
  transitionJobStatusFn = transitionJobStatus,
} = {}) {
  if (!projectId) {
    const err = new Error('projectId required');
    err.status = 400;
    throw err;
  }

  let postCommitTrackServiceId = null;
  const result = await knex.transaction(async (trx) => {
    const project = await trx('projects').where({ id: projectId }).first();
    if (!project) {
      const err = new Error('Project not found');
      err.status = 404;
      throw err;
    }

    const projectCols = await trx('projects').columnInfo().catch(() => ({}));

    if (!project.scheduled_service_id) {
      const closeUpdate = { status: 'closed', updated_at: trx.fn.now() };
      if (projectCols.closed_at) closeUpdate.closed_at = project.closed_at || now;
      await trx('projects').where({ id: project.id }).update(closeUpdate);
      const closedProject = await trx('projects').where({ id: project.id }).first();
      return {
        project: closedProject,
        serviceRecord: null,
        serviceCompleted: false,
        portalAttached: false,
        portalAttachReason: 'no_linked_scheduled_service',
      };
    }

    const scheduledService = await trx('scheduled_services as s')
      .leftJoin('customers as c', 's.customer_id', 'c.id')
      .where({ 's.id': project.scheduled_service_id })
      .first(
        's.*',
        'c.id as customer_row_id',
        'c.first_name',
        'c.last_name',
        'c.email',
        'c.phone',
        'c.active as customer_active',
        'c.deleted_at as customer_deleted_at',
        'c.waveguard_tier',
        'c.monthly_rate',
      );
    if (!scheduledService) {
      const err = new Error('Linked scheduled service not found');
      err.status = 400;
      throw err;
    }
    if (String(scheduledService.customer_id) !== String(project.customer_id)) {
      const err = new Error('Project customer does not match linked scheduled service');
      err.status = 400;
      throw err;
    }
    if (TERMINAL_NON_COMPLETABLE_STATUSES.has(String(scheduledService.status || '').toLowerCase())) {
      const err = new Error(`Cannot complete a ${scheduledService.status} scheduled service from a project`);
      err.status = 409;
      throw err;
    }

    const customer = {
      id: scheduledService.customer_id,
      first_name: scheduledService.first_name,
      last_name: scheduledService.last_name,
      email: scheduledService.email,
      phone: scheduledService.phone,
      active: scheduledService.customer_active,
      deleted_at: scheduledService.customer_deleted_at,
      waveguard_tier: scheduledService.waveguard_tier,
      monthly_rate: scheduledService.monthly_rate,
    };
    const profile = await resolveCompletionProfileForScheduledService(scheduledService, trx);
    if (!profile.projectBacked) {
      const closeUpdate = { status: 'closed', updated_at: trx.fn.now() };
      if (projectCols.closed_at) closeUpdate.closed_at = project.closed_at || now;
      if (projectCols.portal_visible) closeUpdate.portal_visible = false;
      if (projectCols.portal_visibility) {
        closeUpdate.portal_visibility = profile.portalVisibility || project.portal_visibility || 'token_only';
      }
      if (projectCols.portal_attach_policy) {
        closeUpdate.portal_attach_policy = profile.portalAttachPolicy || project.portal_attach_policy || 'never';
      }
      if (projectCols.completion_profile_snapshot) {
        closeUpdate.completion_profile_snapshot = serializeJsonb(profile);
      }
      await trx('projects').where({ id: project.id }).update(closeUpdate);
      const closedProject = await trx('projects').where({ id: project.id }).first();
      return {
        project: closedProject,
        serviceRecord: null,
        serviceCompleted: false,
        portalAttached: false,
        portalAttachReason: 'not_project_backed_service',
        recurringCustomer: null,
        reportPath: null,
        completionProfile: profile,
      };
    }
    const recurringCustomer = await isRecurringCustomer(customer, trx);
    const portalAllowedByPolicy = shouldAttachProjectToPortal({ profile, customer, recurringCustomer });
    const portalReviewed = projectReviewedForPortalAttachment(project);
    const portalAttached = portalAllowedByPolicy && portalReviewed;
    const portalAttachReason = portalAttached
      ? 'policy_allowed'
      : portalAllowedByPolicy && !portalReviewed
        ? 'report_not_sent'
        : 'policy_not_met';
    const token = project.report_token || crypto.randomBytes(16).toString('hex');
    const reportProjectForPath = { ...project, report_token: token };
    const reportPath = await projectReportPathForProject(trx, reportProjectForPath, customer);

    let serviceRecord = null;
    if (project.service_record_id) {
      const candidate = await trx('service_records').where({ id: project.service_record_id }).first();
      if (serviceRecordMatchesScheduledService(candidate, scheduledService)) {
        serviceRecord = candidate;
      } else if (candidate) {
        logger.warn(`[project-completion] project ${project.id} linked service_record_id ${candidate.id} does not match scheduled_service_id ${scheduledService.id}; creating or reusing a scheduled-service record instead`);
      }
    }
    if (!serviceRecord) {
      serviceRecord = await trx('service_records')
        .where({ scheduled_service_id: scheduledService.id })
        .orderBy('created_at', 'desc')
        .first()
        .catch(() => null);
    }

    const billing = await resolveProjectCompletionBilling({
      scheduledService,
      serviceRecord,
      customer,
      knex: trx,
    });
    if (billing.required && !billing.resolved) {
      throw operationalError('Project-backed service requires billing resolution before closeout', {
        status: 409,
        code: 'project_completion_billing_required',
        details: {
          amount: billing.amount,
          scheduledServiceId: scheduledService.id,
          reason: billing.reason,
        },
      });
    }

    const followupSuggestion = projectFollowupSuggestion({
      scheduledService,
      project,
      profile,
    });
    if (followupSuggestion.unsupported) {
      throw operationalError('Project follow-up auto-scheduling is not available yet', {
        status: 409,
        code: 'project_followup_auto_schedule_unsupported',
        details: {
          scheduledServiceId: scheduledService.id,
          policy: followupSuggestion.policy,
          suggestedDate: followupSuggestion.suggestedDate,
          days: followupSuggestion.days,
        },
      });
    }

    const lifecycleUpdates = buildCompletionLifecycleUpdates(scheduledService, now);
    const scheduledServiceCols = await trx('scheduled_services').columnInfo().catch(() => ({}));
    const scheduledLifecycleUpdates = pickExistingColumns(lifecycleUpdates, scheduledServiceCols);
    const serviceRecordCols = await trx('service_records').columnInfo().catch(() => ({}));
    if (!serviceRecord) {
      const insert = buildServiceRecordInsert({
        scheduledService,
        project: { ...project, report_token: token },
        profile,
        serviceRecordCols,
        lifecycleUpdates,
        portalAttached,
        reportPath,
      });
      [serviceRecord] = await trx('service_records').insert(insert).returning('*');
    } else {
      const update = buildServiceRecordProjectCompletionUpdate({
        serviceRecord,
        project: { ...project, report_token: token },
        profile,
        serviceRecordCols,
        lifecycleUpdates,
        portalAttached,
        reportPath,
        nowValue: trx.fn.now(),
      });
      if (Object.keys(update).length) {
        [serviceRecord] = await trx('service_records')
          .where({ id: serviceRecord.id })
          .update(update)
          .returning('*');
      }
    }

    const followupAlert = await createProjectFollowupAlert({
      scheduledService,
      project: { ...project, report_token: token },
      serviceRecord,
      profile,
      customer,
      followup: followupSuggestion,
      trx,
    });
    if (billing.invoice?.id && serviceRecord?.id && !billing.invoice.service_record_id) {
      await trx('invoices').where({ id: billing.invoice.id }).update({
        service_record_id: serviceRecord.id,
        technician_id: scheduledService.technician_id || billing.invoice.technician_id || null,
        updated_at: trx.fn.now(),
      }).catch((err) => {
        logger.warn(`[project-completion] invoice link failed for ${billing.invoice.id}: ${err.message}`);
      });
    }

    if (scheduledService.status !== 'completed') {
      if (Object.keys(scheduledLifecycleUpdates).length) {
        await trx('scheduled_services').where({ id: scheduledService.id }).update(scheduledLifecycleUpdates);
      }
      await transitionJobStatusFn({
        jobId: scheduledService.id,
        fromStatus: scheduledService.status,
        toStatus: 'completed',
        transitionedBy: actorId,
        notes: `Completed via project ${project.id}`,
        trx,
      });
      postCommitTrackServiceId = scheduledService.id;
    }

    const projectUpdate = {
      status: 'closed',
      report_token: token,
      service_record_id: serviceRecord.id,
      updated_at: trx.fn.now(),
    };
    if (projectCols.closed_at) projectUpdate.closed_at = project.closed_at || now;
    if (projectCols.portal_visible) projectUpdate.portal_visible = portalAttached;
    if (projectCols.portal_visibility) projectUpdate.portal_visibility = profile.portalVisibility || 'token_only';
    if (projectCols.portal_attach_policy) projectUpdate.portal_attach_policy = profile.portalAttachPolicy || 'never';
    if (projectCols.completion_profile_snapshot) projectUpdate.completion_profile_snapshot = serializeJsonb(profile);
    await trx('projects').where({ id: project.id }).update(projectUpdate);

    const updatedProject = await trx('projects').where({ id: project.id }).first();
    return {
      project: updatedProject,
      serviceRecord,
      serviceCompleted: true,
      portalAttached,
      portalAttachReason,
      recurringCustomer,
      billing,
      followup: {
        ...followupSuggestion,
        alert: followupAlert,
      },
      reportPath,
      completionProfile: profile,
    };
  });

  if (postCommitTrackServiceId) {
    try {
      const trackTransitions = require('./track-transitions');
      await trackTransitions.markComplete(postCommitTrackServiceId, {
        actorType: 'admin',
        actorId,
        // Deliberate closeout: the project completion already committed
        // the operational status flip, and a project can legitimately
        // close before the linked visit's scheduled date — bypass the
        // stale-attempt future-date guard so track_state stays in sync.
        allowFutureDate: true,
      });
    } catch (err) {
      logger.warn(`[project-completion] track completion refresh failed for ${postCommitTrackServiceId}: ${err.message}`);
    }
  }

  return result;
}

async function buildProjectCloseoutPreview(projectId, knex = db) {
  if (!projectId) return null;
  const project = await knex('projects').where({ id: projectId }).first();
  if (!project) return null;
  if (!project.scheduled_service_id) {
    return {
      projectId: project.id,
      serviceCompletion: {
        linked: false,
        willCompleteService: false,
        reason: 'no_linked_scheduled_service',
      },
      billing: { required: false, resolved: true, amount: 0, reason: 'not_billable' },
      followup: { required: false, policy: 'none', days: null, suggestedDate: null },
      portal: { attached: true, reason: 'ad_hoc_project_default' },
      canClose: project.status !== 'closed',
    };
  }

  const scheduledService = await knex('scheduled_services as s')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where({ 's.id': project.scheduled_service_id })
    .first(
      's.*',
      'c.id as customer_row_id',
      'c.first_name',
      'c.last_name',
      'c.email',
      'c.phone',
      'c.active as customer_active',
      'c.deleted_at as customer_deleted_at',
      'c.waveguard_tier',
      'c.monthly_rate',
    );
  if (!scheduledService) {
    return {
      projectId: project.id,
      serviceCompletion: {
        linked: true,
        willCompleteService: false,
        reason: 'linked_scheduled_service_missing',
      },
      billing: { required: false, resolved: true, amount: 0, reason: 'not_billable' },
      followup: { required: false, policy: 'none', days: null, suggestedDate: null },
      portal: { attached: false, reason: 'linked_scheduled_service_missing' },
      canClose: false,
    };
  }

  const customer = {
    id: scheduledService.customer_id,
    first_name: scheduledService.first_name,
    last_name: scheduledService.last_name,
    email: scheduledService.email,
    phone: scheduledService.phone,
    active: scheduledService.customer_active,
    deleted_at: scheduledService.customer_deleted_at,
    waveguard_tier: scheduledService.waveguard_tier,
    monthly_rate: scheduledService.monthly_rate,
  };
  const profile = await resolveCompletionProfileForScheduledService(scheduledService, knex);
  const terminalStatus = TERMINAL_NON_COMPLETABLE_STATUSES.has(String(scheduledService.status || '').toLowerCase());
  const willCompleteService = profile.projectBacked && !terminalStatus;
  const recurringCustomer = willCompleteService ? await isRecurringCustomer(customer, knex) : null;
  const portalAllowedByPolicy = willCompleteService
    ? shouldAttachProjectToPortal({ profile, customer, recurringCustomer })
    : false;
  const portalReviewed = projectReviewedForPortalAttachment(project);
  const portalAttached = portalAllowedByPolicy && portalReviewed;
  const portalReason = portalAttached
    ? 'policy_allowed'
    : portalAllowedByPolicy && !portalReviewed
      ? 'report_not_sent'
      : terminalStatus
        ? 'terminal_scheduled_service'
        : profile.projectBacked
          ? 'policy_not_met'
          : 'not_project_backed_service';

  let serviceRecord = null;
  if (willCompleteService && project.service_record_id) {
    const candidate = await knex('service_records').where({ id: project.service_record_id }).first();
    if (serviceRecordMatchesScheduledService(candidate, scheduledService)) serviceRecord = candidate;
  }
  if (willCompleteService && !serviceRecord) {
    serviceRecord = await knex('service_records')
      .where({ scheduled_service_id: scheduledService.id })
      .orderBy('created_at', 'desc')
      .first()
      .catch(() => null);
  }

  const billing = willCompleteService
    ? await resolveProjectCompletionBilling({
      scheduledService,
      serviceRecord,
      customer,
      knex,
    })
    : {
      required: false,
      resolved: true,
      amount: 0,
      reason: 'project_not_completing_service',
    };
  const followup = willCompleteService
    ? projectFollowupSuggestion({ scheduledService, project, profile })
    : {
      required: false,
      policy: profile.followupPolicy || 'none',
      days: null,
      suggestedDate: null,
      alertType: null,
    };

  return {
    projectId: project.id,
    serviceCompletion: {
      linked: true,
      willCompleteService,
      scheduledServiceId: scheduledService.id,
      status: scheduledService.status || null,
      serviceType: scheduledService.service_type || profile.serviceName || null,
      projectBacked: !!profile.projectBacked,
      completionMode: profile.completionMode || null,
      reason: willCompleteService
        ? 'project_backed_service'
        : terminalStatus
          ? 'terminal_scheduled_service'
          : 'not_project_backed_service',
    },
    billing: {
      required: !!billing.required,
      resolved: !!billing.resolved,
      amount: billing.amount || 0,
      reason: billing.reason || null,
      invoiceId: billing.invoice?.id || null,
      invoiceStatus: billing.invoice?.status || null,
    },
    followup,
    portal: {
      attached: portalAttached,
      reason: portalReason,
      recurringCustomer,
      portalVisibility: profile.portalVisibility || null,
      portalAttachPolicy: profile.portalAttachPolicy || null,
    },
    canClose: project.status !== 'closed'
      && !terminalStatus
      && !followup.unsupported
      && (!billing.required || billing.resolved),
  };
}

async function resolveProjectPortalAttachment(project = {}, knex = db) {
  if (!project?.scheduled_service_id) {
    return {
      portalAttached: true,
      portalAttachReason: 'ad_hoc_project_default',
      completionProfile: null,
      recurringCustomer: null,
    };
  }

  const scheduledService = await knex('scheduled_services as s')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where({ 's.id': project.scheduled_service_id })
    .first(
      's.*',
      'c.id as customer_row_id',
      'c.first_name',
      'c.last_name',
      'c.email',
      'c.phone',
      'c.active as customer_active',
      'c.deleted_at as customer_deleted_at',
      'c.waveguard_tier',
      'c.monthly_rate',
    );
  if (!scheduledService) {
    return {
      portalAttached: false,
      portalAttachReason: 'linked_scheduled_service_missing',
      completionProfile: null,
      recurringCustomer: false,
    };
  }
  const customer = {
    id: scheduledService.customer_id,
    active: scheduledService.customer_active,
    deleted_at: scheduledService.customer_deleted_at,
    waveguard_tier: scheduledService.waveguard_tier,
    monthly_rate: scheduledService.monthly_rate,
  };
  const profile = await resolveCompletionProfileForScheduledService(scheduledService, knex);
  const recurringCustomer = await isRecurringCustomer(customer, knex);
  const portalAttached = shouldAttachProjectToPortal({ profile, customer, recurringCustomer });
  return {
    portalAttached,
    portalAttachReason: portalAttached ? 'policy_allowed' : 'policy_not_met',
    completionProfile: profile,
    recurringCustomer,
  };
}

module.exports = {
  buildProjectCloseoutPreview,
  buildServiceRecordInsert,
  buildServiceRecordProjectCompletionUpdate,
  completeProjectBackedService,
  createProjectFollowupAlert,
  findExistingCompletionInvoice,
  hasMembership,
  isRecurringCustomer,
  operationalError,
  pickExistingColumns,
  prepaidCoversAmount,
  projectCompletionInvoiceAmount,
  projectFollowupSuggestion,
  projectReviewedForPortalAttachment,
  resolveProjectCompletionBilling,
  resolveProjectPortalAttachment,
  serviceRecordMatchesScheduledService,
  shouldAttachProjectToPortal,
  _test: {
    hasActiveRecurringSchedule,
    membershipTierKey,
    normalizeDateOnly,
    addDaysToDateOnly,
    parseJsonObject,
    pickExistingColumns,
    prepaidCoversAmount,
    projectCompletionNotes,
    projectCompletionInvoiceAmount,
    projectFollowupSuggestion,
    projectReviewedForPortalAttachment,
    serviceRecordMatchesScheduledService,
  },
};
