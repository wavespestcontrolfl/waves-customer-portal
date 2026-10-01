/**
 * The technician's note as a customer may see it.
 *
 * AGENTS.md: raw `technician_notes` never egress on a report path. The field
 * is internal (gate codes, billing notes, remarks about the visit); the only
 * customer copy in it is the reviewed report parse,
 * technicianReportCustomerCopy, the same parse that feeds the written
 * report's summary (owner ruling 2026-07-16, report-data.js `legacy` block).
 *
 * reviewedReportNotes(record): that parse, and nothing else.
 *   - null when the completion rejected the report body
 *     (service_data.technicianReportBodyRejected) or a governing typed story
 *     refused it (typedStoryAcceptsBody), as the web report does;
 *   - null when the note is not the reviewed report shape, or a banned-copy
 *     screen nulled its body (a four-section report parses only while
 *     GATE_REPORT_WRITER_RULES is on, as on the web report);
 *   - otherwise the reviewed body, with the WDO inspection-fee scrub
 *     (customerSafeServiceNotes) and the access-code redactor on top: the
 *     parse checks shape and wording, not codes.
 * Fails closed: an unreadable service_data, or any step that throws, is null.
 *
 * customerReportNotes(record): the service history, the service-report PDF
 * and the pay page (owner ruling 2026-10-01: customers see only the report
 * text, never the tech's raw note). A typed report held from customers
 * (typedReportDelivery other than auto_send) shows none. A project
 * completion's note is not a technician's note: project-completion.js writes
 * it from the project's own title and recommendations, which the customer's
 * project report already shows, so it keeps its scrubbed render.
 *
 * Both take a service_records row (technician_notes, structured_notes,
 * service_data, completion_source).
 */

function structuredObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function reviewedReportNotes(record = {}) {
  try {
    const sd = typeof record.service_data === 'string'
      ? JSON.parse(record.service_data || '{}')
      : (record.service_data || {});
    if (sd?.technicianReportBodyRejected) return null;
    const { typedStoryAcceptsBody } = require('./activity-indicators');
    if (!typedStoryAcceptsBody(sd)) return null;
    const { technicianReportCustomerCopy } = require('./technician-report-copy');
    const copy = technicianReportCustomerCopy(record.technician_notes);
    if (!copy?.body) return null;
    const { customerSafeServiceNotes } = require('../project-types');
    const { redactAccessCodes } = require('../context-aggregator');
    if (typeof redactAccessCodes !== 'function') return null;
    const safe = redactAccessCodes(customerSafeServiceNotes(copy.body, structuredObject(record.structured_notes)));
    return safe && String(safe).trim() ? safe : null;
  } catch {
    return null;
  }
}

function customerReportNotes(record = {}) {
  try {
    const structured = structuredObject(record.structured_notes);
    const { suppressesCustomerArtifacts } = require('../../routes/services');
    if (suppressesCustomerArtifacts(structured)) return null;
    if (record.completion_source === 'project_completion' || structured.projectCompletion === true) {
      const { customerSafeServiceNotes } = require('../project-types');
      return customerSafeServiceNotes(record.technician_notes, structured) || null;
    }
  } catch {
    return null;
  }
  return reviewedReportNotes(record);
}

module.exports = { customerReportNotes, reviewedReportNotes };
