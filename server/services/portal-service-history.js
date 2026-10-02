// The portal's completed-visit history: the customer-visible service records,
// newest first, with products, the reviewed report text and report links.
// One read for every surface that shows a customer their own past visits
// (GET /api/services and the portal assistant's recent-visits tool), so the
// suppression rules for typed-report shadows, the raw-note rule and the
// report-link rules below can never differ between them.
const db = require('../models/db');
// Shared with the service-report PDF renderer (documents.js) and the pay
// page so every customer-facing render of technician_notes follows one
// rule: the reviewed report text only, never the tech's raw note, with the
// legacy inspection-fee scrub on top (owner ruling 2026-10-01; codex #2817).
const { customerSafeVisitNotes } = require('./context-aggregator');
const { applyPropertyPredicate } = require('./account-properties');

// Saved-property scope (GATE_APP_PROPERTY_SCOPE) on a service-record query
// that LEFT JOINs the visit: the shared predicate's "every property retired"
// leg is whereNull(visits.id), which a record WITHOUT a visit would satisfy
// under a left join — match nothing explicitly instead. Records without a
// visit (property_id NULL) belong to the primary, like unstamped visits.
function scopeRecordsToProperty(query, scope) {
  if (!scope || !scope.enabled || !scope.scoped) return query;
  if (scope.closed || !scope.property) return query.whereRaw('1 = 0');
  return applyPropertyPredicate(query, scope, 'scheduled_services');
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function suppressesCustomerArtifacts(structuredNotes = {}) {
  return Boolean(structuredNotes.typedReportDelivery) && structuredNotes.typedReportDelivery !== 'auto_send';
}

// completedOnly (the assistant's recent-visits tool): only records whose
// status is 'completed', filtered before the limit and in the total, so an
// incomplete visit is never described as a completed one. The route leaves
// it off and lists every record, as before.
async function listPortalServiceHistory(customerId, { limit = 20, offset = 0, type = null, scope = null, completedOnly = false } = {}) {
  let query = db('service_records')
    .where({ 'service_records.customer_id': customerId })
    .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
    .leftJoin('scheduled_services', 'service_records.scheduled_service_id', 'scheduled_services.id')
    .select(
      'service_records.*',
      'technicians.name as technician_name',
      db.raw('COALESCE(scheduled_services.check_in_time, scheduled_services.actual_start_time) as effective_check_in_time'),
      db.raw('COALESCE(scheduled_services.check_out_time, scheduled_services.actual_end_time) as effective_check_out_time')
    )
    .orderBy('service_records.service_date', 'desc')
    .orderBy('service_records.id', 'desc')
    .limit(limit)
    .offset(offset);

  if (type) {
    query = query.where('service_records.service_type', 'ilike', `%${type}%`);
  }
  if (scope) query = scopeRecordsToProperty(query, scope);
  if (completedOnly) query = query.where('service_records.status', 'completed');

  const services = await query;

  // Attach products and photo counts
  const enriched = await Promise.all(services.map(async (svc) => {
    const structuredNotes = parseJsonObject(svc.structured_notes);
    const suppressCustomerArtifacts = suppressesCustomerArtifacts(structuredNotes);

    const products = suppressCustomerArtifacts
      ? []
      : await db('service_products')
        .where({ service_record_id: svc.id })
        .select('product_name', 'product_category', 'active_ingredient', 'moa_group', 'notes');

    const photoCount = suppressCustomerArtifacts
      ? { count: 0 }
      : await db('service_photos')
        .where({ service_record_id: svc.id })
        .count('id as count')
        .first();

    const photoCountNum = parseInt(photoCount?.count) || 0;
    const isProjectCompletion = svc.completion_source === 'project_completion'
      || structuredNotes.projectCompletion === true;
    const projectReport = structuredNotes.projectReport || {};
    const projectReportUrl = structuredNotes.portalAttached && projectReport.url
      ? projectReport.url
      : null;
    // Any typed delivery posture other than auto_send (internal_only
    // shadow, disabled kill switch) keeps report links off customer surfaces.
    const internalOnlyReport = suppressCustomerArtifacts;
    return {
      id: svc.id,
      date: svc.service_date,
      type: svc.service_type,
      status: svc.status || null,
      technician: svc.technician_name || null,
      checkInTime: svc.effective_check_in_time || null,
      checkOutTime: svc.effective_check_out_time || null,
      // The reviewed report text only, never the tech's raw note
      // (context-aggregator.js customerSafeVisitNotes).
      notes: suppressCustomerArtifacts ? null : customerSafeVisitNotes(svc, { projectLine: true }),
      soilTemp: svc.soil_temp ? parseFloat(svc.soil_temp) : null,
      thatchMeasurement: svc.thatch_measurement ? parseFloat(svc.thatch_measurement) : null,
      soilPh: svc.soil_ph ? parseFloat(svc.soil_ph) : null,
      soilMoisture: svc.soil_moisture || null,
      // field_flags are internal QA markers, not customer-facing.
      products: products || [],
      hasPhotos: suppressCustomerArtifacts ? false : photoCountNum > 0,
      photoCount: suppressCustomerArtifacts ? 0 : photoCountNum,
      isProjectCompletion,
      projectId: structuredNotes.projectId || null,
      projectType: structuredNotes.projectType || null,
      projectReportPortalAttached: Boolean(structuredNotes.portalAttached && projectReportUrl),
      // internal_only typed completions (Phase-1b shadow) store a report
      // for admin review, but the customer must not see it — the flag is
      // frozen at completion time, so graduating the profile to auto_send
      // later never retroactively exposes shadow reports.
      reportUrl: isProjectCompletion
        ? projectReportUrl
        : (svc.report_view_token && !internalOnlyReport ? `/report/${svc.report_view_token}` : null),
      reportPdfUrl: isProjectCompletion
        ? projectReportUrl
        : (svc.report_view_token && !internalOnlyReport ? `/api/reports/${svc.report_view_token}` : null),
      reportToken: !internalOnlyReport ? (svc.report_view_token || null) : null,
      reportGeneratedAt: !internalOnlyReport ? (svc.report_generated_at || null) : null,
      reportViewedAt: !internalOnlyReport ? (svc.report_viewed_at || null) : null,
      // Explicit signal for the client: when false, render no report
      // button at all (the /api/documents/service-report fallback 404s
      // for suppressed records, so a fallback link would dead-end).
      reportAvailable: isProjectCompletion
        ? Boolean(projectReportUrl)
        : !internalOnlyReport,
    };
  }));

  // Get total count for pagination
  let totalQuery = db('service_records')
    .where({ 'service_records.customer_id': customerId });
  if (scope) {
    totalQuery = scopeRecordsToProperty(
      totalQuery.leftJoin('scheduled_services', 'service_records.scheduled_service_id', 'scheduled_services.id'),
      scope,
    );
  }
  if (completedOnly) totalQuery = totalQuery.where('service_records.status', 'completed');
  const total = await totalQuery.count('service_records.id as count').first();
  return { services: enriched, total: parseInt(total.count) };
}

module.exports = { listPortalServiceHistory, parseJsonObject, suppressesCustomerArtifacts };
