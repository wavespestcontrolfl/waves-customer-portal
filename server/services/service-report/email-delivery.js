const db = require('../../models/db');
const logger = require('../logger');
const sendgrid = require('../sendgrid-mail');
const { wrapEmail, formatDate, plainText } = require('../email-template');
const EmailTemplateLibrary = require('../email-template-library');
const { buildReportV1Data } = require('./report-data');
const {
  enqueuePdfRenderRetry,
  getOrRenderServiceReportPdf,
} = require('./pdf-queue');
const { shouldSendServiceReportV1Delivery } = require('./delivery');
const { buildServiceReportDynamicContext } = require('./dynamic-context');
const { safePdfRenderError } = require('./pdf-events');
const { formatReadyTime } = require('./time-format');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function portalBaseUrl() {
  return (process.env.PORTAL_URL || process.env.PUBLIC_PORTAL_URL || 'https://portal.wavespestcontrol.com')
    .replace(/\/+$/, '');
}

function minutes(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded > 0 ? `${rounded} min` : null;
}

function serviceDisplayName(data = {}) {
  return data.serviceDisplayName || data.serviceType || data.serviceLineDisplay || 'Waves service';
}

function readyAt(dynamicContext, key) {
  const target = dynamicContext?.reentry?.targets?.find((entry) => entry.key === key);
  return target?.readyAt ? formatReadyTime(target.readyAt, dynamicContext.reentry.displayTimezone) : null;
}

function hasActionRequiredFinding(findings = []) {
  return findings.some((finding) => ['critical', 'high'].includes(String(finding.severity || '').toLowerCase()));
}

function customerActionFindings(findings = []) {
  return findings.filter((finding) => String(finding?.category || '').toLowerCase() !== 'no_activity');
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function canFallbackFromTemplateEmailError(err) {
  return /relation .*email_templates.* does not exist|active template not found|template version not found|template not found/i.test(err?.message || '');
}

function pdfAttachment(filename, buffer) {
  return {
    content: buffer.toString('base64'),
    filename,
    type: 'application/pdf',
    disposition: 'attachment',
  };
}

function buildServiceReportV1Email({ data, reportUrl, pdfAttached = false } = {}) {
  const serviceLine = serviceDisplayName(data);
  const serviceDate = formatDate(data?.serviceDate);
  const first = data?.customerName ? data.customerName.split(/\s+/)[0] : 'there';
  const tech = data?.technicianName || 'your Waves technician';
  const location = data?.cityState ? ` at ${escapeHtml(data.cityState)}` : '';
  const findings = customerActionFindings(Array.isArray(data?.findings) ? data.findings : []);
  const applications = Array.isArray(data?.applications) ? data.applications : [];
  const advisory = data?.advisory || {};
  const dynamicContext = data?.dynamicContext || {};
  const topFindings = findings.slice(0, 3);
  const exteriorReadyAt = readyAt(dynamicContext, 'exterior');
  const interiorReadyAt = readyAt(dynamicContext, 'interior');
  const pressureMetric = (data?.metrics || []).find((metric) => /pressure/i.test(metric.label || ''));
  const pressureValue = pressureMetric?.value != null && pressureMetric.value !== ''
    ? String(pressureMetric.value)
    : (data?.pressureIndex != null ? String(data.pressureIndex) : null);

  const findingsHtml = topFindings.length
    ? `<p style="margin:16px 0 6px 0;"><strong>Top findings</strong></p><ul style="margin:0 0 0 18px;padding:0;">${topFindings.map((finding) => `<li>${escapeHtml(finding.title || 'Finding documented')}</li>`).join('')}</ul>`
    : '<p style="margin:16px 0 0 0;">No action-required findings were documented during this visit.</p>';

  const heroSummary = hasActionRequiredFinding(findings)
    ? 'One recommendation needs attention to help reduce recurring activity.'
    : dynamicContext.pressureTrend?.direction === 'down'
      ? dynamicContext.pressureTrend.customerSummary
      : dynamicContext.reentry?.customerSummary
        || dynamicContext.pressureTrend?.customerSummary
        || 'Your routine service is complete.';

  const intro = [
    `<p style="margin:0;">Hi ${escapeHtml(first)}, ${escapeHtml(tech)} completed ${escapeHtml(serviceLine)}${location}${serviceDate ? ` on ${escapeHtml(serviceDate)}` : ''}.</p>`,
    `<p style="margin:16px 0 0 0;"><strong>${escapeHtml(heroSummary)}</strong></p>`,
    findingsHtml,
    '<p style="margin:16px 0 0 0;">The customer advisory below is the section to read before people or pets return to treated areas.</p>',
  ].join('');

  const lines = [
    ['Service', escapeHtml(serviceLine)],
    serviceDate ? ['Date', escapeHtml(serviceDate)] : null,
    ['Applications', escapeHtml(countLabel(applications.length, 'application'))],
    ['Findings', escapeHtml(countLabel(findings.length, 'finding'))],
    pressureValue ? ['Pressure index', escapeHtml(pressureValue), true] : null,
    exteriorReadyAt ? ['Exterior ready at', escapeHtml(exteriorReadyAt), true] : (minutes(advisory.exterior_reentry_min) ? ['Exterior re-entry', escapeHtml(minutes(advisory.exterior_reentry_min)), true] : null),
    interiorReadyAt ? ['Interior ready at', escapeHtml(interiorReadyAt), true] : (minutes(advisory.interior_reentry_min) ? ['Interior re-entry', escapeHtml(minutes(advisory.interior_reentry_min)), true] : null),
    dynamicContext.pressureTrend?.customerSummary ? ['Pressure trend', escapeHtml(dynamicContext.pressureTrend.customerSummary), true] : null,
  ].filter(Boolean);

  const subject = hasActionRequiredFinding(findings)
    ? 'Your Waves report is ready - one recommendation needs attention'
    : dynamicContext.pressureTrend?.direction === 'down'
      ? 'Your Waves report is ready - pest pressure is down'
      : exteriorReadyAt
        ? `Your Waves report is ready - exterior ready at ${exteriorReadyAt}`
        : `Your Waves service report - ${serviceLine}${serviceDate ? ` ${serviceDate}` : ''}`;
  const html = wrapEmail({
    preheader: `Your Waves service report is ready${serviceDate ? ` for ${serviceDate}` : ''}.`,
    heading: 'Your Waves service report is ready',
    intro,
    lines,
    ctaHref: reportUrl,
    ctaLabel: 'View full report',
    footerNote: pdfAttached
      ? 'Your PDF service report is attached. Reply to this email or call (941) 297-5749 with any questions.'
      : 'Your full report is ready at the link above. A downloadable PDF will be available shortly. Reply to this email or call (941) 297-5749 with any questions.',
  });
  const text = plainText([
    `Hi ${first},`,
    '',
    `${tech} completed ${serviceLine}${data?.cityState ? ` at ${data.cityState}` : ''}${serviceDate ? ` on ${serviceDate}` : ''}.`,
    '',
    `View full report: ${reportUrl}`,
    '',
    dynamicContext.reentry?.customerSummary || null,
    exteriorReadyAt ? `Exterior ready at: ${exteriorReadyAt}` : (minutes(advisory.exterior_reentry_min) ? `Exterior re-entry: ${minutes(advisory.exterior_reentry_min)}` : null),
    interiorReadyAt ? `Interior ready at: ${interiorReadyAt}` : (minutes(advisory.interior_reentry_min) ? `Interior re-entry: ${minutes(advisory.interior_reentry_min)}` : null),
    dynamicContext.pressureTrend?.customerSummary || null,
    pressureValue ? `Pressure index: ${pressureValue}` : null,
    `Findings: ${countLabel(findings.length, 'finding')}`,
    '',
    topFindings.length ? `Top findings: ${topFindings.map((finding) => finding.title || 'Finding documented').join('; ')}` : 'No action-required findings were documented during this visit.',
    '',
    pdfAttached ? 'The PDF service report is attached.' : 'A downloadable PDF will be available shortly.',
    '',
    'Questions? Reply to this email or call (941) 297-5749.',
    'Waves Pest Control',
  ]);

  return { subject, html, text };
}

async function loadServiceRecord(recordId) {
  return db('service_records')
    .where({ 'service_records.id': recordId })
    .leftJoin('customers', 'service_records.customer_id', 'customers.id')
    .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
    .select(
      'service_records.*',
      'customers.first_name',
      'customers.last_name',
      'customers.email as customer_email',
      'customers.city',
      'customers.state',
      'technicians.name as technician_name',
    )
    .first();
}

async function sendServiceReportV1Email(recordId, { token, reportUrl, pdfUrl } = {}) {
  if (!sendgrid.isConfigured()) {
    return { ok: false, error: 'SendGrid not configured' };
  }

  const service = await loadServiceRecord(recordId);
  if (!service) return { ok: false, error: 'Service record not found' };
  if (!shouldSendServiceReportV1Delivery(service)) {
    return { ok: false, skipped: true, error: 'Not a completed service report v1 record' };
  }
  if (!service.customer_email) return { ok: false, skipped: true, error: 'No customer email' };

  const reportToken = token || service.report_view_token;
  if (!reportToken) return { ok: false, error: 'Missing report token' };

  const base = portalBaseUrl();
  const fullReportUrl = reportUrl || `${base}/report/${encodeURIComponent(reportToken)}`;
  const fullPdfUrl = pdfUrl || `${base}/api/reports/${encodeURIComponent(reportToken)}`;
  const data = await buildReportV1Data(service, reportToken);
  data.dynamicContext = await buildServiceReportDynamicContext({
    recordId,
    mode: 'static',
  });

  let pdf = null;
  try {
    const result = await getOrRenderServiceReportPdf(recordId, { token: reportToken });
    pdf = result.pdf;
    if (result.storageFailed) {
      await enqueuePdfRenderRetry({
        serviceRecordId: recordId,
        payload: {
          source: 'service_report_v1_email_storage_failed',
        },
      }).catch((queueErr) => {
        logger.warn(`[service-report-v1-email] PDF storage retry queue failed for ${recordId}: ${queueErr.message}`);
      });
    }
  } catch (err) {
    logger.warn(`[service-report-v1-email] PDF attachment skipped for ${recordId}: ${safePdfRenderError(err)}`);
    await enqueuePdfRenderRetry({
      serviceRecordId: recordId,
      payload: {
        source: 'service_report_v1_email',
      },
    }).catch((queueErr) => {
      logger.warn(`[service-report-v1-email] PDF retry queue failed for ${recordId}: ${queueErr.message}`);
    });
  }

  const email = buildServiceReportV1Email({
    data: { ...data, pdfUrl: fullPdfUrl },
    reportUrl: fullReportUrl,
    pdfAttached: !!pdf,
  });
  const attachments = pdf ? [{
    content: pdf.toString('base64'),
    filename: `waves-service-report-${data.serviceDate || recordId}.pdf`,
    type: 'application/pdf',
    disposition: 'attachment',
  }] : undefined;

  try {
    const serviceLabel = serviceDisplayName(data);
    const templateResult = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'service.report_ready',
      to: service.customer_email,
      payload: {
        first_name: data?.customerName ? data.customerName.split(/\s+/)[0] : 'there',
        report_url: fullReportUrl,
        service_label: serviceLabel,
        service_date: data?.serviceDate ? formatDate(data.serviceDate) : '',
        technician_name: data?.technicianName || '',
      },
      recipientType: 'customer',
      recipientId: service.customer_id || null,
      triggerEventId: `service_report_ready:${recordId}`,
      categories: ['service_report_v1'],
      attachments: pdf ? [pdfAttachment(`waves-service-report-${data.serviceDate || recordId}.pdf`, pdf)] : [],
    });
    if (templateResult.blocked) {
      logger.warn(`[service-report-v1-email] Template service report ${recordId} blocked: ${templateResult.reason}`);
      return { ok: false, skipped: true, error: templateResult.reason || 'Email suppressed', attachedPdf: !!pdf };
    }
    logger.info(`[service-report-v1-email] Sent template service report ${recordId} to customer ${service.customer_id || 'unknown'}`);
    return { ok: true, messageId: templateResult.message?.provider_message_id || null, attachedPdf: !!pdf };
  } catch (err) {
    if (!canFallbackFromTemplateEmailError(err)) {
      logger.error(`[service-report-v1-email] Template send failed for ${recordId}: ${err.message}`);
      return { ok: false, error: err.message, attachedPdf: !!pdf };
    }
    logger.warn(`[service-report-v1-email] Template unavailable for ${recordId}; falling back to legacy renderer: ${err.message}`);
  }

  const result = await sendgrid.sendOne({
    to: service.customer_email,
    subject: email.subject,
    html: email.html,
    text: email.text,
    categories: ['service_report_v1'],
    asmGroupId: sendgrid.serviceGroupId(),
    attachments,
  });

  logger.info(`[service-report-v1-email] Sent service report ${recordId} to customer ${service.customer_id || 'unknown'}`);
  return { ok: true, messageId: result.messageId || null, attachedPdf: !!pdf };
}

module.exports = {
  buildServiceReportV1Email,
  sendServiceReportV1Email,
};
