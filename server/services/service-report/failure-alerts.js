// Raise an admin bell/push alert when a service report can no longer reach the
// customer on its own — i.e. the email delivery queue or the PDF render queue
// has exhausted its retries. Without this, a permanently failed report only
// leaves a logger.error line, so a customer who never received their report is
// indistinguishable from one who did. Both helpers are best-effort: they never
// throw (the caller is a queue worker that must keep draining) and they dedupe
// per record over a 24h window so a re-enqueue can't spam the bell.
const db = require('../../models/db');
const logger = require('../logger');
const { triggerNotification } = require('../notification-triggers');

const ALERT_WINDOW_HOURS = 24;

// Strip recipient emails and long opaque tokens out of provider error text
// before it lands on an admin bell entry.
function sanitizeErrorText(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b[a-f0-9]{24,}\b/gi, '[token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

async function alreadyAlerted(dedupeKey, knex) {
  if (!dedupeKey) return false;
  try {
    const existing = await knex('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->'payload'->>'dedupeKey' = ?", [dedupeKey])
      .where('created_at', '>=', knex.raw(`now() - interval '${ALERT_WINDOW_HOURS} hours'`))
      .first('id');
    return !!existing;
  } catch (err) {
    logger.warn(`[service-report-alerts] dedupe check failed: ${err.message}`);
    return false;
  }
}

// Best-effort customer + service context for the alert body. Falls back to the
// id carried on the queue row if the join can't be resolved.
async function loadServiceContext(serviceRecordId, fallbackCustomerId, knex) {
  const context = { customerId: fallbackCustomerId || null, customerName: null, serviceLabel: null };
  if (!serviceRecordId) return context;
  try {
    const row = await knex('service_records as sr')
      .leftJoin('customers as c', 'c.id', 'sr.customer_id')
      .where('sr.id', serviceRecordId)
      .first(
        'sr.customer_id as customer_id',
        'sr.service_type as service_type',
        'sr.service_date as service_date',
        'c.first_name as first_name',
        'c.last_name as last_name',
      );
    if (row) {
      context.customerId = row.customer_id || context.customerId;
      const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
      context.customerName = name || null;
      context.serviceLabel = [row.service_type, row.service_date].filter(Boolean).join(' · ') || null;
    }
  } catch (err) {
    logger.warn(`[service-report-alerts] context load failed for ${serviceRecordId}: ${err.message}`);
  }
  return context;
}

function adminLink(customerId) {
  return customerId ? `/admin/customers?customerId=${customerId}` : '/admin/dispatch';
}

async function alertServiceReportDeliveryFailed({ delivery, error } = {}, { knex = db, trigger = triggerNotification } = {}) {
  try {
    const serviceRecordId = delivery?.service_record_id || null;
    const dedupeKey = `service_report_delivery_failed:${delivery?.id || serviceRecordId || 'unknown'}`;
    if (await alreadyAlerted(dedupeKey, knex)) return { skipped: true, reason: 'duplicate' };

    const context = await loadServiceContext(serviceRecordId, delivery?.customer_id, knex);
    const errorMessage = sanitizeErrorText(error?.message || error?.error || error);
    logger.warn(`[service-report-alerts] email delivery exhausted for record=${serviceRecordId || 'unknown'} attempts=${delivery?.attempts ?? '?'}`);

    return await trigger('service_report_delivery_failed', {
      customerName: context.customerName,
      serviceLabel: context.serviceLabel,
      attempts: Number(delivery?.attempts) || null,
      errorMessage,
      link: adminLink(context.customerId),
      dedupeKey,
    });
  } catch (err) {
    logger.error(`[service-report-alerts] delivery alert failed: ${err.message}`);
    return { skipped: true, error: err.message };
  }
}

async function alertServiceReportPdfFailed({ job, error } = {}, { knex = db, trigger = triggerNotification } = {}) {
  try {
    const serviceRecordId = job?.service_record_id || null;
    const dedupeKey = `service_report_pdf_failed:${serviceRecordId || job?.id || 'unknown'}`;
    if (await alreadyAlerted(dedupeKey, knex)) return { skipped: true, reason: 'duplicate' };

    const context = await loadServiceContext(serviceRecordId, job?.customer_id, knex);
    const errorMessage = sanitizeErrorText(error?.message || error?.error || error);
    logger.warn(`[service-report-alerts] pdf render exhausted for record=${serviceRecordId || 'unknown'} attempts=${job?.attempts ?? '?'}`);

    return await trigger('service_report_pdf_failed', {
      customerName: context.customerName,
      serviceLabel: context.serviceLabel,
      attempts: Number(job?.attempts) || null,
      errorMessage,
      link: adminLink(context.customerId),
      dedupeKey,
    });
  } catch (err) {
    logger.error(`[service-report-alerts] pdf alert failed: ${err.message}`);
    return { skipped: true, error: err.message };
  }
}

module.exports = {
  alertServiceReportDeliveryFailed,
  alertServiceReportPdfFailed,
  sanitizeErrorText,
  __private: { alreadyAlerted, loadServiceContext, adminLink },
};
