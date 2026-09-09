/**
 * Job Form Service
 *
 * Resolves the active template for a service type, persists submissions, and
 * computes completion percent based on required fields.
 */

const db = require('../models/db');
const logger = require('./logger');

async function getTemplateForServiceType(serviceType, database = db) {
  if (!serviceType) return null;
  return database('job_form_templates')
    .where({ service_type: serviceType, is_active: true })
    .first();
}

function countRequired(sections) {
  if (!Array.isArray(sections)) return 0;
  let n = 0;
  for (const s of sections) {
    for (const f of (s.fields || [])) {
      if (f.required) n++;
    }
  }
  return n;
}

function countFilledRequired(sections, responses) {
  if (!Array.isArray(sections) || !responses) return 0;
  let n = 0;
  for (const s of sections) {
    for (const f of (s.fields || [])) {
      if (!f.required) continue;
      const v = responses[f.id];
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' && v.trim() === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      n++;
    }
  }
  return n;
}

function computeCompletion(template, responses) {
  const sections = typeof template.sections === 'string' ? JSON.parse(template.sections) : template.sections;
  const required = countRequired(sections);
  if (!required) return 100;
  const filled = countFilledRequired(sections, responses);
  return Math.round((filled / required) * 100);
}

/**
 * saveSubmission({ scheduledServiceId, serviceRecordId, technicianId, customerId, serviceType, responses, startedAt })
 */
async function saveSubmission(opts, database = db) {
  const {
    scheduledServiceId, serviceRecordId, technicianId, customerId,
    serviceType, responses, startedAt,
  } = opts;

  const template = await getTemplateForServiceType(serviceType, database);
  if (!template) {
    logger.warn(`[job-form] No active template for service_type=${serviceType}`);
    return null;
  }

  const completion = computeCompletion(template, responses || {});

  const row = {
    template_id: template.id,
    service_record_id: serviceRecordId || null,
    scheduled_service_id: scheduledServiceId || null,
    technician_id: technicianId || null,
    customer_id: customerId,
    responses: JSON.stringify(responses || {}),
    completion_percent: completion,
    started_at: startedAt || null,
    completed_at: completion >= 100 ? new Date() : null,
  };

  // One submission per scheduled_service — upsert
  const existing = scheduledServiceId
    ? await database('job_form_submissions').where({ scheduled_service_id: scheduledServiceId }).first()
    : null;

  if (existing) {
    await database('job_form_submissions').where({ id: existing.id }).update(row);
    return { ...existing, ...row, id: existing.id };
  } else {
    const [inserted] = await database('job_form_submissions').insert(row).returning('*');
    return inserted;
  }
}

module.exports = { getTemplateForServiceType, saveSubmission, computeCompletion };
