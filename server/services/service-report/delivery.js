const { getServiceLineConfig } = require('./service-line-configs');

function normalizeName(value) {
  return String(value || '').trim().split(/\s+/)[0] || '';
}

function normalizeMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded > 0 ? rounded : null;
}

function normalizeAdvisory(advisory = {}, fallback = {}) {
  let source = advisory;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      source = {};
    }
  }
  source = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const defaults = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
  return { ...defaults, ...source };
}

function shouldSendServiceReportV1Delivery(record) {
  if (!record || record.report_template_version !== 'service_report_v1') return false;
  const status = String(record.status || '').toLowerCase();
  return status === 'completed' || status === 'complete';
}

function serviceReportV1SmsType({ hasInvoiceLink = false } = {}) {
  return hasInvoiceLink ? 'service_report_v1_with_invoice' : 'service_report_v1';
}

function buildServiceReportV1Sms({
  customerFirstName,
  reportUrl,
  advisory,
  fallbackAdvisory,
  payUrl,
} = {}) {
  const url = String(reportUrl || '').trim();
  if (!url) return '';

  const firstName = normalizeName(customerFirstName);
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const mergedAdvisory = normalizeAdvisory(advisory, fallbackAdvisory);
  const exterior = normalizeMinutes(mergedAdvisory.exterior_reentry_min);
  const interior = normalizeMinutes(mergedAdvisory.interior_reentry_min);

  const lines = [
    `${greeting} your Waves service report is ready: ${url}`,
  ];

  if (exterior !== null && interior !== null) {
    lines.push(`Re-entry: ${exterior} min outside, ${interior} min inside.`);
  } else if (exterior !== null) {
    lines.push(`Re-entry: ${exterior} min outside.`);
  } else if (interior !== null) {
    lines.push(`Re-entry: ${interior} min inside.`);
  }

  const invoiceUrl = String(payUrl || '').trim();
  if (invoiceUrl) lines.push(`Invoice: ${invoiceUrl}`);

  lines.push('Reply STOP to opt out.');
  return lines.join('\n');
}

function buildServiceReportV1SmsVars({
  customerFirstName,
  reportUrl,
  advisory,
  fallbackAdvisory,
  payUrl,
} = {}) {
  const url = String(reportUrl || '').trim();
  if (!url) return null;

  const mergedAdvisory = normalizeAdvisory(advisory, fallbackAdvisory);
  const exterior = normalizeMinutes(mergedAdvisory.exterior_reentry_min);
  const interior = normalizeMinutes(mergedAdvisory.interior_reentry_min);
  let reentryLine = '';
  if (exterior !== null && interior !== null) {
    reentryLine = `\nRe-entry: ${exterior} min outside, ${interior} min inside.`;
  } else if (exterior !== null) {
    reentryLine = `\nRe-entry: ${exterior} min outside.`;
  } else if (interior !== null) {
    reentryLine = `\nRe-entry: ${interior} min inside.`;
  }

  return {
    first_name: normalizeName(customerFirstName) || 'there',
    report_url: url,
    reentry_line: reentryLine,
    pay_url: String(payUrl || '').trim(),
  };
}

function buildServiceReportV1DeliveryContext({
  record,
  service,
  reportUrl,
  smsReportUrl,
  payUrl,
} = {}) {
  if (!shouldSendServiceReportV1Delivery(record)) {
    return { enabled: false, body: '', smsType: null, metadata: {} };
  }

  const config = getServiceLineConfig(record.service_line || service?.service_type);
  const hasInvoiceLink = !!String(payUrl || '').trim();
  const smsType = serviceReportV1SmsType({ hasInvoiceLink });
  const vars = buildServiceReportV1SmsVars({
    customerFirstName: service?.first_name,
    reportUrl: smsReportUrl || reportUrl,
    advisory: record.advisory,
    fallbackAdvisory: config.advisoryDefaults,
    payUrl,
  });
  const body = buildServiceReportV1Sms({
    customerFirstName: service?.first_name,
    reportUrl: smsReportUrl || reportUrl,
    advisory: record.advisory,
    fallbackAdvisory: config.advisoryDefaults,
    payUrl,
  });

  return {
    enabled: true,
    body,
    vars,
    smsType,
    metadata: {
      original_message_type: smsType,
      service_record_id: record.id,
      report_template_version: 'service_report_v1',
      report_url: reportUrl || smsReportUrl || null,
      report_sms_url: smsReportUrl || reportUrl || null,
      service_line: config.id,
    },
  };
}

module.exports = {
  buildServiceReportV1DeliveryContext,
  buildServiceReportV1Sms,
  buildServiceReportV1SmsVars,
  serviceReportV1SmsType,
  shouldSendServiceReportV1Delivery,
};
