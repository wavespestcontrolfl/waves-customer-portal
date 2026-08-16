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
//   - No lawn synthesis lead-in and no score/tip fold-in. Lawn reads exactly
//     like pest; the score band and watering advice belong on the report.
//
// There is no code-built body any more. Completion texts render from the
// EDITABLE DB TEMPLATE for every service line, so these vars are the whole
// contract between this module and what the customer receives — a second,
// hand-assembled implementation could only drift from the template and give
// tests false confidence about copy the deployed row does not render.
function buildServiceReportV1SmsVars({
  customerFirstName,
  reportUrl,
  payUrl,
  serviceType,
  reserviceLine,
  pastDueLine,
} = {}) {
  const url = String(reportUrl || '').trim();
  if (!url) return null;

  return {
    first_name: normalizeName(customerFirstName) || 'there',
    report_url: url,
    // EXPAND half of an expand/contract rollout. `service_type` is supplied
    // here BEFORE any template references it, and `reentry_line` keeps being
    // supplied as an empty string AFTER the line was retired. Railway runs
    // migrations before the new instance takes traffic, so for a window the
    // OLD code serves the NEW template and vice versa — and an unresolved
    // placeholder does not render blank, it suppresses the entire send
    // (#3121). Supplying both keys means neither ordering can silence a
    // completion text. Emptying reentry_line is also what drops the re-entry
    // line from the live copy today, without touching the template at all.
    // The contract half — rewriting the bodies to use {service_type} and drop
    // {reentry_line} — ships as a SEPARATE PR once this is deployed.
    service_type: serviceTypeLabel(serviceType),
    reentry_line: '',
    pay_url: String(payUrl || '').trim(),
    // EXPAND half for the re-service streamline (same rollout discipline as
    // service_type above): supplied at every render site BEFORE any template
    // body carries {reservice_line}. The clause is computed by the caller
    // (reservice-link.reserviceLineForCustomer) and is '' unless
    // GATE_RESERVICE_STREAMLINE + GATE_RESERVICE_SELF_SERVE are both on AND
    // the customer's live plan grants a re-service lane. The contract half —
    // the migration appending the token to the bodies — ships as a separate
    // PR once this is deployed.
    reservice_line: typeof reserviceLine === 'string' ? reserviceLine : '',
    // EXPAND half for the completion-SMS past-due balance line (same rollout
    // discipline again): supplied at every render site BEFORE any template
    // body carries {past_due_line}. The clause is computed by the caller
    // (open-balance.pastDueSmsLineForCustomer) and is '' unless
    // GATE_COMPLETION_SMS_BALANCE is on AND the customer has an older open
    // self-pay balance beyond the visit's own invoice. The contract half —
    // the migration appending the token to the two with-invoice bodies —
    // ships as a separate PR once this is deployed.
    past_due_line: typeof pastDueLine === 'string' ? pastDueLine : '',
  };
}

function buildServiceReportV1DeliveryContext({
  record,
  service,
  reportUrl,
  smsReportUrl,
  payUrl,
  reserviceLine,
  pastDueLine,
} = {}) {
  if (!shouldSendServiceReportV1Delivery(record)) {
    return { enabled: false, smsType: null, metadata: {} };
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
    reserviceLine,
    pastDueLine,
  });
  return {
    enabled: true,
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
  buildServiceReportV1SmsVars,
  serviceReportV1SmsType,
  shouldSendServiceReportV1Delivery,
};
