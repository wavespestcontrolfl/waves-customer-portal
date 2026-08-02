const { getServiceLineConfig } = require('./service-line-configs');

function normalizeName(value) {
  return String(value || '').trim().split(/\s+/)[0] || '';
}

// The completion text names the service (owner ruling 2026-08-01) rather than
// saying "your service report". Mirrors normalizeServiceTypeForTemplate in
// admin-dispatch so this family reads the same as service_complete_with_invoice,
// but degrades to a bare 'service' instead of that helper's 'your service' —
// the template already supplies the possessive, and "your your service report"
// is the render you get otherwise.
function serviceTypeLabel(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/\s+services?$/i, '')
    .replace(/^your\s+/i, '')
    .trim();
  return cleaned || 'service';
}

function shouldSendServiceReportV1Delivery(record) {
  if (!record || record.report_template_version !== 'service_report_v1') return false;
  const status = String(record.status || '').toLowerCase();
  return status === 'completed' || status === 'complete';
}

// The progress-headline SMS variant (service_report_v1_progress) was removed
// 2026-07-06 (owner call): the completion text is a gateway to the service
// report, and the report itself carries the Today's Result trend — a special
// SMS lead-in was overkill. Every visit sends the base report text.
function serviceReportV1SmsType({ hasInvoiceLink = false } = {}) {
  return hasInvoiceLink ? 'service_report_v1_with_invoice' : 'service_report_v1';
}

// Owner ruling 2026-08-01: completion texts stay SHORT so they deliver in one
// segment, and they name the service.
//   - No re-entry line. It lives on the linked report
//     (dynamicContext.reentry + advisory.exterior/interior_reentry_min), which
//     is where a customer reads the detail anyway.
//   - No "Reply STOP to opt out." A completed visit is transactional: consent
//     came with the transaction, and Twilio enforces the STOP keyword at the
//     account level whether or not the body advertises it. Opt-out wording
//     belongs on estimates and the marketing-adjacent lanes only.
//   - No lawn synthesis lead-in. Lawn reads exactly like pest; the score band
//     and watering advice belong on the report, not in a text.
function buildServiceReportV1Sms({
  customerFirstName,
  reportUrl,
  payUrl,
  serviceType,
} = {}) {
  const url = String(reportUrl || '').trim();
  if (!url) return '';

  const firstName = normalizeName(customerFirstName);
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const lines = [`${greeting} your ${serviceTypeLabel(serviceType)} report is ready: ${url}`];

  const invoiceUrl = String(payUrl || '').trim();
  if (invoiceUrl) lines.push(`Invoice: ${invoiceUrl}`);

  return lines.join('\n');
}

function buildServiceReportV1SmsVars({
  customerFirstName,
  reportUrl,
  payUrl,
  serviceType,
} = {}) {
  const url = String(reportUrl || '').trim();
  if (!url) return null;

  return {
    first_name: normalizeName(customerFirstName) || 'there',
    report_url: url,
    service_type: serviceTypeLabel(serviceType),
    // Retired with the re-entry line, but STILL SUPPLIED as empty string. The
    // migration in this change strips {reentry_line} from both bodies, and an
    // unresolved placeholder does not render blank — it suppresses the entire
    // send (#3121). Keeping the key costs nothing and means a stale row, a
    // half-applied migration, or an operator re-adding the token by hand can
    // never silence a completion text.
    reentry_line: '',
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
  // Name the visit's actual service. The scheduled service_type is what the
  // sibling paid templates already render, so both families read alike; the
  // service-line displayName is the fallback when the record has no type.
  const serviceType = service?.service_type || record.service_type || config.displayName;
  const vars = buildServiceReportV1SmsVars({
    customerFirstName: service?.first_name,
    reportUrl: smsReportUrl || reportUrl,
    payUrl,
    serviceType,
  });
  const body = buildServiceReportV1Sms({
    customerFirstName: service?.first_name,
    reportUrl: smsReportUrl || reportUrl,
    payUrl,
    serviceType,
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
};
