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
const { getServiceReportEmailRecipients, SERVICE_CONTACT_COLUMNS } = require('../customer-contact');
const { publicPortalUrl } = require('../../utils/portal-url');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../../constants/business');
const { legacyTemplateFallbackAllowed } = require('../email-fallback-gate');

const SERVICE_REPORT_FROM_EMAIL = 'contact@wavespestcontrol.com';
const SERVICE_REPORT_FROM_NAME = 'Waves Pest Control';

// Mirror the service.report_ready template's suppression semantics so this
// legacy direct-send fallback honors the same email_suppressions rows the
// template path does (global bounce/spam/do_not_email + the service group).
const SERVICE_REPORT_GROUP_KEY = 'service_operational';
const SERVICE_REPORT_SUPPRESSION_TEMPLATE = {
  send_stream: 'service_operational',
  suppression_group_key: 'service_operational',
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function portalBaseUrl() {
  return publicPortalUrl();
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

function firstName(value) {
  return String(value || '').trim().split(/\s+/)[0] || 'there';
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

function serviceReportTemplatePayload({ recipient, data, reportUrl, serviceLabel, pdf }) {
  const findings = customerActionFindings(Array.isArray(data?.findings) ? data.findings : []);
  const applications = Array.isArray(data?.applications) ? data.applications : [];
  const dynamicContext = data?.dynamicContext || {};
  const advisory = data?.advisory || {};
  const exteriorReadyAt = readyAt(dynamicContext, 'exterior');
  const interiorReadyAt = readyAt(dynamicContext, 'interior');
  const reentryParts = [
    dynamicContext.reentry?.customerSummary,
    exteriorReadyAt ? `Exterior ready at ${exteriorReadyAt}` : null,
    interiorReadyAt ? `Interior ready at ${interiorReadyAt}` : null,
    !exteriorReadyAt && minutes(advisory.exterior_reentry_min) ? `Exterior re-entry: ${minutes(advisory.exterior_reentry_min)}` : null,
    !interiorReadyAt && minutes(advisory.interior_reentry_min) ? `Interior re-entry: ${minutes(advisory.interior_reentry_min)}` : null,
  ].filter(Boolean);
  const pressureMetric = (data?.metrics || []).find((metric) => /pressure/i.test(metric.label || ''));
  const pressureValue = pressureMetric?.value != null && pressureMetric.value !== ''
    ? String(pressureMetric.value)
    : (data?.pressureIndex != null ? String(data.pressureIndex) : '');

  return {
    first_name: firstName(recipient.name || data?.customerName),
    report_url: reportUrl,
    service_label: serviceLabel,
    service_date: data?.serviceDate ? formatDate(data.serviceDate) : '',
    technician_name: data?.technicianName || '',
    property_address: data?.cityState || '',
    finding_summary: findings.length
      ? `${countLabel(findings.length, 'finding')} documented for review`
      : 'No action-required findings were documented.',
    application_summary: countLabel(applications.length, 'application'),
    reentry_summary: reentryParts.join(' '),
    pressure_summary: dynamicContext.pressureTrend?.customerSummary || (pressureValue ? `Pressure index: ${pressureValue}` : ''),
    pdf_note: pdf
      ? 'Your PDF service report is attached.'
      : 'A downloadable PDF will be available shortly.',
    company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
  };
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

function errorMessage(err, fallback = 'Email delivery failed') {
  return err?.message || err?.error || String(err || fallback);
}

function serviceReportEmailIdempotencyKey(recordId, recipient, suffix = '') {
  const role = String(recipient?.role || 'recipient').replace(/[^a-z0-9_-]/gi, '_') || 'recipient';
  return `service_report_ready:${recordId}:${role}${suffix ? `:${suffix}` : ''}`;
}

function emailMessageId(result) {
  return result?.message?.provider_message_id || result?.messageId || null;
}

function nonRetryableEmailStatus(status) {
  return ['sent', 'delivered', 'opened', 'clicked', 'blocked', 'dropped', 'bounced', 'bounce', 'spam_report', 'spamreport', 'unsubscribed', 'complained']
    .includes(String(status || '').toLowerCase());
}

function deliveredEmailStatus(status) {
  return ['sent', 'delivered', 'opened', 'clicked'].includes(String(status || '').toLowerCase());
}

function isEmailMessageSchemaMissing(err) {
  return err?.code === '42P01' || err?.code === '42703';
}

async function sendLegacyServiceReportEmail({
  recordId,
  customerId,
  recipient,
  email,
  attachments,
}) {
  const idempotencyKey = serviceReportEmailIdempotencyKey(recordId, recipient);
  let message = null;
  let ledgerAvailable = true;

  try {
    const existing = await db('email_messages').where({ idempotency_key: idempotencyKey }).first();
    if (existing && nonRetryableEmailStatus(existing.status)) {
      if (String(existing.status || '').toLowerCase() === 'blocked') {
        return { blocked: true, reason: existing.error_message || 'Email suppressed', message: existing };
      }
      if (!deliveredEmailStatus(existing.status)) {
        return { blocked: true, reason: existing.error_message || `Email already ${existing.status}`, message: existing };
      }
      return { sent: true, deduped: true, message: existing };
    }

    const baseSnapshot = {
      provider: 'sendgrid',
      template_key: 'service.report_ready.legacy',
      trigger_event_id: idempotencyKey,
      recipient_type: 'customer',
      recipient_id: customerId || null,
      recipient_email_snapshot: recipient.email,
      from_name_snapshot: SERVICE_REPORT_FROM_NAME,
      from_email_snapshot: SERVICE_REPORT_FROM_EMAIL,
      reply_to_snapshot: SERVICE_REPORT_FROM_EMAIL,
      subject_snapshot: email.subject,
      html_snapshot: email.html,
      text_snapshot: email.text,
      // Direct inserter (bypasses sendTemplate) — stamp the attachment flag so
      // bounce recovery routes a bounced PDF report to manual instead of a
      // body-only replay. See server/services/email-bounce-recovery.js.
      has_attachments: Array.isArray(attachments) && attachments.length > 0,
      categories: JSON.stringify(['service_report_v1']),
      idempotency_key: idempotencyKey,
      queued_at: new Date(),
      updated_at: new Date(),
    };

    const persistSnapshot = async (overrides) => {
      const snapshot = { ...baseSnapshot, ...overrides };
      const rows = existing
        ? await db('email_messages').where({ id: existing.id }).update(snapshot).returning('*')
        : await db('email_messages').insert(snapshot).returning('*');
      return rows?.[0] || existing || snapshot;
    };

    // Honor suppressions before sending — the template path checks these but
    // this direct fallback previously skipped them, so a bounced/unsubscribed
    // address could still receive a legacy report. Record a blocked ledger row.
    const suppression = await EmailTemplateLibrary.activeSuppressionFor(
      SERVICE_REPORT_SUPPRESSION_TEMPLATE,
      recipient.email,
      SERVICE_REPORT_GROUP_KEY,
    );
    if (suppression) {
      const reason = `Suppressed: ${suppression.suppression_type}${suppression.group_key ? ` (${suppression.group_key})` : ''}`;
      const blocked = await persistSnapshot({ status: 'blocked', error_message: reason });
      return { blocked: true, reason, message: blocked };
    }

    message = await persistSnapshot({
      status: 'queued',
      provider_message_id: null,
      sent_at: null,
      error_message: null,
    });
  } catch (err) {
    if (!isEmailMessageSchemaMissing(err)) throw err;
    ledgerAvailable = false;
  }

  try {
    const result = await sendgrid.sendOne({
      to: recipient.email,
      // Service reports are transactional — name the sender explicitly
      // instead of inheriting sendgrid-mail's `newsletter@` default, which
      // was the wrong identity for billing-adjacent customer correspondence.
      fromEmail: SERVICE_REPORT_FROM_EMAIL,
      fromName: SERVICE_REPORT_FROM_NAME,
      subject: email.subject,
      html: email.html,
      text: email.text,
      categories: ['service_report_v1'],
      asmGroupId: sendgrid.serviceGroupId(),
      attachments,
    });
    if (ledgerAvailable && message?.id) {
      const rows = await db('email_messages').where({ id: message.id }).update({
        status: 'sent',
        provider_message_id: result.messageId,
        sent_at: new Date(),
        updated_at: new Date(),
      }).returning('*');
      message = rows?.[0] || message;
    }
    return { sent: true, messageId: result.messageId || null, message };
  } catch (err) {
    if (ledgerAvailable && message?.id) {
      await db('email_messages').where({ id: message.id }).update({
        status: 'failed',
        error_message: errorMessage(err).slice(0, 1000),
        updated_at: new Date(),
      }).catch(() => {});
    }
    throw err;
  }
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
    ? 'Your Waves report is ready — one recommendation needs attention'
    : dynamicContext.pressureTrend?.direction === 'down'
      ? 'Your Waves report is ready — pest pressure is down'
      : exteriorReadyAt
        ? `Your Waves report is ready — exterior ready at ${exteriorReadyAt}`
        : `Your Waves service report — ${serviceLine}${serviceDate ? ` ${serviceDate}` : ''}`;
  const html = wrapEmail({
    preheader: `Your Waves service report is ready${serviceDate ? ` for ${serviceDate}` : ''}.`,
    heading: 'Your Waves service report is ready',
    intro,
    lines,
    ctaHref: reportUrl,
    ctaLabel: 'View full report',
    footerNote: pdfAttached
      ? `Your PDF service report is attached. Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY} with any questions.`
      : `Your full report is ready at the link above. A downloadable PDF will be available shortly. Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY} with any questions.`,
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
    `Questions? Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY}.`,
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
      'customers.phone as customer_phone',
      ...SERVICE_CONTACT_COLUMNS.map((column) => `customers.${column}`),
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
  const prefs = await db('notification_prefs').where({ customer_id: service.customer_id }).first().catch(() => null);
  const recipients = getServiceReportEmailRecipients({
    id: service.customer_id,
    first_name: service.first_name,
    last_name: service.last_name,
    email: service.customer_email,
    phone: service.customer_phone,
    ...Object.fromEntries(SERVICE_CONTACT_COLUMNS.map((column) => [column, service[column]])),
  }, prefs || {});
  if (!recipients.length) return { ok: false, skipped: true, error: 'No service report recipient email' };

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

  const attachments = pdf ? [{
    content: pdf.toString('base64'),
    filename: `waves-service-report-${data.serviceDate || recordId}.pdf`,
    type: 'application/pdf',
    disposition: 'attachment',
  }] : undefined;

  const serviceLabel = serviceDisplayName(data);
  const templateOutcomes = await Promise.allSettled(
    recipients.map((recipient) => EmailTemplateLibrary.sendTemplate({
        templateKey: 'service.report_ready',
        to: recipient.email,
        payload: serviceReportTemplatePayload({
          recipient,
          data,
          reportUrl: fullReportUrl,
          serviceLabel,
          pdf,
        }),
        recipientType: 'customer',
        recipientId: service.customer_id || null,
        triggerEventId: `service_report_ready:${recordId}:${recipient.role || 'recipient'}`,
        idempotencyKey: serviceReportEmailIdempotencyKey(recordId, recipient),
        categories: ['service_report_v1'],
        attachments: pdf ? [pdfAttachment(`waves-service-report-${data.serviceDate || recordId}.pdf`, pdf)] : [],
      }).then((result) => ({ recipient, result }))),
  );
  const sent = [];
  const blocked = [];
  const failed = [];
  for (const [index, outcome] of templateOutcomes.entries()) {
    const recipient = recipients[index];
    if (outcome.status === 'fulfilled') {
      if (outcome.value.result?.blocked) {
        blocked.push({ recipient: outcome.value.recipient, reason: outcome.value.result.reason });
      } else if (outcome.value.result?.sent === false) {
        blocked.push({
          recipient: outcome.value.recipient,
          reason: outcome.value.result.reason || outcome.value.result.message?.error_message || 'Email not retryable',
        });
      } else {
        sent.push(outcome.value.result);
      }
    } else {
      failed.push({ recipient, error: outcome.reason });
    }
  }
  let legacyRecipients = recipients;
  if (!sent.length && failed.length && failed.every(({ error }) => canFallbackFromTemplateEmailError(error))) {
    if (!legacyTemplateFallbackAllowed()) {
      const err = failed[0]?.error || new Error('Email template unavailable');
      logger.error(`[service-report-v1-email] Legacy fallback disabled in production for ${recordId} — service.report_ready template send required: ${errorMessage(err)}`);
      return {
        ok: false,
        error: 'Email send unavailable: service.report_ready template path failed and legacy fallback is disabled in production',
        failedCount: failed.length,
        blockedCount: blocked.length,
        attachedPdf: !!pdf,
      };
    }
    legacyRecipients = failed.map(({ recipient }) => recipient).filter(Boolean);
    logger.warn(`[service-report-v1-email] Template unavailable for ${recordId}; falling back to legacy renderer for ${legacyRecipients.length} recipient(s): ${errorMessage(failed[0]?.error)}`);
  } else if (failed.length) {
    const err = failed[0]?.error || new Error('Email delivery failed');
    logger.warn(`[service-report-v1-email] Template service report ${recordId} delivered to ${sent.length} recipient(s), ${blocked.length} blocked, ${failed.length} failed; queue will retry failed recipient(s): ${errorMessage(err)}`);
    return {
      ok: false,
      error: errorMessage(err),
      messageId: emailMessageId(sent[0]) || null,
      messageIds: sent.map(emailMessageId).filter(Boolean),
      recipientCount: sent.length,
      failedCount: failed.length,
      blockedCount: blocked.length,
      attachedPdf: !!pdf,
    };
  } else if (sent.length) {
    const partial = blocked.length ? `; ${blocked.length} blocked` : '';
    logger.info(`[service-report-v1-email] Sent template service report ${recordId} to ${sent.length} recipient(s) for customer ${service.customer_id || 'unknown'}${partial}`);
    return {
      ok: true,
      messageId: emailMessageId(sent[0]) || null,
      messageIds: sent.map(emailMessageId).filter(Boolean),
      recipientCount: sent.length,
      failedCount: 0,
      blockedCount: blocked.length,
      attachedPdf: !!pdf,
    };
  } else if (blocked.length === recipients.length) {
    const reason = blocked[0]?.reason || 'Email suppressed';
    logger.warn(`[service-report-v1-email] Template service report ${recordId} blocked for all recipients: ${reason}`);
    return { ok: false, skipped: true, error: reason, attachedPdf: !!pdf };
  } else {
    const err = failed[0]?.error || new Error(blocked[0]?.reason || 'Email suppressed');
    logger.error(`[service-report-v1-email] Template send failed for ${recordId}: ${errorMessage(err)}`);
    return {
      ok: false,
      error: errorMessage(err),
      failedCount: failed.length,
      blockedCount: blocked.length,
      attachedPdf: !!pdf,
    };
  }

  const legacyOutcomes = await Promise.allSettled(legacyRecipients.map((recipient) => {
    const email = buildServiceReportV1Email({
      data: { ...data, customerName: recipient.name || data.customerName, pdfUrl: fullPdfUrl },
      reportUrl: fullReportUrl,
      pdfAttached: !!pdf,
    });
    return sendLegacyServiceReportEmail({
      recordId,
      customerId: service.customer_id || null,
      recipient,
      email,
      attachments,
    });
  }));

  const legacySent = [];
  const legacyBlocked = [];
  const legacyFailed = [];
  for (const outcome of legacyOutcomes) {
    if (outcome.status === 'fulfilled') {
      if (outcome.value?.blocked) {
        legacyBlocked.push(outcome.value);
      } else {
        legacySent.push(outcome.value);
      }
    } else {
      legacyFailed.push(outcome.reason);
    }
  }

  if (!legacySent.length && legacyBlocked.length === legacyRecipients.length) {
    const reason = legacyBlocked[0]?.reason || 'Email suppressed';
    logger.warn(`[service-report-v1-email] Legacy service report ${recordId} blocked for all recipients: ${reason}`);
    return { ok: false, skipped: true, error: reason, blockedCount: blocked.length + legacyBlocked.length, attachedPdf: !!pdf };
  }

  if (!legacySent.length) {
    const err = legacyFailed[0] || new Error('Email delivery failed');
    logger.error(`[service-report-v1-email] Legacy send failed for ${recordId}: ${errorMessage(err)}`);
    return {
      ok: false,
      error: errorMessage(err),
      failedCount: legacyFailed.length || legacyRecipients.length,
      blockedCount: blocked.length + legacyBlocked.length,
      attachedPdf: !!pdf,
    };
  }

  if (legacyFailed.length) {
    const err = legacyFailed[0] || new Error('Email delivery failed');
    logger.warn(`[service-report-v1-email] Legacy service report ${recordId} delivered to ${legacySent.length} recipient(s), ${legacyBlocked.length} blocked, ${legacyFailed.length} failed; queue will retry failed recipient(s): ${errorMessage(err)}`);
    return {
      ok: false,
      error: errorMessage(err),
      messageId: emailMessageId(legacySent[0]) || null,
      messageIds: legacySent.map(emailMessageId).filter(Boolean),
      recipientCount: legacySent.length,
      failedCount: legacyFailed.length,
      blockedCount: blocked.length + legacyBlocked.length,
      attachedPdf: !!pdf,
    };
  }

  const totalBlocked = blocked.length + legacyBlocked.length;
  const partial = totalBlocked ? `; ${totalBlocked} blocked` : '';
  logger.info(`[service-report-v1-email] Sent service report ${recordId} to ${legacySent.length} recipient(s) for customer ${service.customer_id || 'unknown'}${partial}`);
  return {
    ok: true,
    messageId: emailMessageId(legacySent[0]) || null,
    messageIds: legacySent.map(emailMessageId).filter(Boolean),
    recipientCount: legacySent.length,
    failedCount: legacyFailed.length,
    blockedCount: totalBlocked,
    attachedPdf: !!pdf,
  };
}

module.exports = {
  buildServiceReportV1Email,
  sendServiceReportV1Email,
};
