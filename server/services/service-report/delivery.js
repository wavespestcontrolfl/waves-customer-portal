const { getServiceLineConfig } = require('./service-line-configs');
const { frozenSmsSummary } = require('./lawn-report-write-gate');

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

// Progress visits (typed trend types, visit 2+) get the short progress SMS
// whose lead sentence is the snapshot's generated Today's Result headline —
// immutable, versioned, banned-words-safe, and identical to the report it
// links to. No headline (or visit 1) → not progress-eligible.
function typedProgressContext(record) {
  let serviceData = record?.service_data;
  if (typeof serviceData === 'string') {
    try {
      serviceData = JSON.parse(serviceData);
    } catch {
      serviceData = null;
    }
  }
  const snapshot = serviceData && typeof serviceData === 'object'
    ? serviceData.typedReportSnapshot
    : null;
  if (!snapshot || typeof snapshot !== 'object') return { isProgress: false, headline: '' };
  const headline = String(snapshot.todaysResult?.headline || '').trim();
  const isProgress = Number(snapshot.visitSequence) > 1 && !!headline;
  return { isProgress, headline };
}

function serviceReportV1SmsType({ hasInvoiceLink = false, isProgress = false } = {}) {
  if (hasInvoiceLink) return 'service_report_v1_with_invoice';
  return isProgress ? 'service_report_v1_progress' : 'service_report_v1';
}

function buildServiceReportV1Sms({
  customerFirstName,
  reportUrl,
  advisory,
  fallbackAdvisory,
  payUrl,
  summaryLine,
} = {}) {
  const url = String(reportUrl || '').trim();
  if (!url) return '';

  const firstName = normalizeName(customerFirstName);
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const mergedAdvisory = normalizeAdvisory(advisory, fallbackAdvisory);
  const exterior = normalizeMinutes(mergedAdvisory.exterior_reentry_min);
  const interior = normalizeMinutes(mergedAdvisory.interior_reentry_min);

  // Prefer the frozen V2 synthesis line so the text matches the report's lead;
  // fall back to the generic line when there's no synthesized summary.
  const summary = String(summaryLine || '').trim();
  const lines = summary
    ? [`${greeting} ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`, url]
    : [`${greeting} your Waves service report is ready: ${url}`];

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
  summaryLine: summaryLineParam,
} = {}) {
  if (!shouldSendServiceReportV1Delivery(record)) {
    return { enabled: false, body: '', smsType: null, metadata: {} };
  }

  const config = getServiceLineConfig(record.service_line || service?.service_type);
  const hasInvoiceLink = !!String(payUrl || '').trim();
  const progress = typedProgressContext(record);
  const smsType = serviceReportV1SmsType({ hasInvoiceLink, isProgress: progress.isProgress });
  // Frozen V2 synthesis line (write-gate) — keeps the text on-message with the report.
  // Not used for progress SMS (those lead with the progress headline).
  const summaryLine = smsType === 'service_report_v1_progress' ? null : (summaryLineParam || frozenSmsSummary(record));
  const vars = buildServiceReportV1SmsVars({
    customerFirstName: service?.first_name,
    reportUrl: smsReportUrl || reportUrl,
    advisory: record.advisory,
    fallbackAdvisory: config.advisoryDefaults,
    payUrl,
  });
  if (summaryLine) vars.summary_line = summaryLine;
  if (smsType === 'service_report_v1_progress') {
    vars.progress_headline = progress.headline;
  }
  const body = buildServiceReportV1Sms({
    customerFirstName: service?.first_name,
    reportUrl: smsReportUrl || reportUrl,
    advisory: record.advisory,
    fallbackAdvisory: config.advisoryDefaults,
    payUrl,
    summaryLine,
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

// Fold a lawn assessment score (and optional tip) into an already-composed
// completion SMS body, right below the "report is ready: <link>" lead line so
// the customer's score rides in the SAME text as the report — instead of a
// separate "lawn health report ready" message.
//
// The body handed in was already selected/truncated to a segment target, so
// the fold must not blow past it: prefer score + tip, else drop the (longer)
// tip for score-only, else skip the fold entirely (the full recommendations
// still live in the linked report, so the inline tip is not material).
//
// Returns { body, folded, truncated }:
//   folded=false, body=original  → nothing changed (no score, or no room)
//   truncated=true               → a tip existed but was dropped for budget
function foldLawnScoreIntoCompletionSms(body, scoreParts = {}, { maxSegments = 2 } = {}) {
  const { countSegments } = require('../messaging/segment-counter');
  const base = String(body || '');
  const scoreLine = String(scoreParts?.scoreLine || '').trim();
  const tipLine = String(scoreParts?.tipLine || '').trim();
  if (!base || !scoreLine) return { body: base, folded: false, truncated: false };

  // DB templates separate paragraphs with a blank line; the prebuilt V1 body
  // uses single newlines — split on whichever this body uses so the score
  // lands under the lead line either way.
  const sep = base.includes('\n\n') ? '\n\n' : '\n';
  const foldIn = (block) => {
    const parts = base.split(sep);
    parts.splice(1, 0, block);
    return parts.join(sep);
  };
  const segs = (text) => countSegments(text).segmentCount;

  if (tipLine) {
    const withTip = foldIn(`${scoreLine}\n${tipLine}`);
    if (segs(withTip) <= maxSegments) return { body: withTip, folded: true, truncated: false };
  }
  const scoreOnly = foldIn(scoreLine);
  if (segs(scoreOnly) <= maxSegments) {
    return { body: scoreOnly, folded: true, truncated: !!tipLine };
  }
  return { body: base, folded: false, truncated: false };
}

module.exports = {
  buildServiceReportV1DeliveryContext,
  buildServiceReportV1Sms,
  buildServiceReportV1SmsVars,
  foldLawnScoreIntoCompletionSms,
  serviceReportV1SmsType,
  shouldSendServiceReportV1Delivery,
  typedProgressContext,
};
