'use strict';

/**
 * GATE_REPORT_SHARED_TEMPLATE (owner 2026-10-24): every regular customer report (service, older
 * service, project, lawn assessment and pest assessment) takes the pest report's customer header
 * (CustomerReportHeader) and one vertical, stacked layout (reportTemplate.css) on the live web view.
 * WDO inspections and pre-treatment certificates keep their paper documents: the page decides that
 * from the report type. The one thing the page needs from the server is this payload key:
 *
 *   reportTemplate: true
 *
 * Callers add it to live web views only, so the PDF, static and SMS renders and the PDF cache key
 * never change. Gate off: an empty object, so the payload is byte-identical to before.
 * Pure. No database read, no model call.
 */

const featureGates = require('../../config/feature-gates');

// A partial feature-gates mock (a test) means off, never a crash in a report build.
function templateLive() {
  return typeof featureGates.reportSharedTemplateLive === 'function' && featureGates.reportSharedTemplateLive();
}

/** The payload key the shared template adds. Spread into a live report payload. */
function reportTemplatePayload() {
  return templateLive() ? { reportTemplate: true } : {};
}

module.exports = { reportTemplatePayload, templateLive };
