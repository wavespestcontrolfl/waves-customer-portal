/**
 * Canonical read-only visit → invoice projection for admin detail surfaces.
 *
 * Callers own the visit scope, ordering and cap. An invoice belongs to a visit
 * by its direct scheduled_service_id; only an invoice with no direct visit may
 * fall back through its service_record.scheduled_service_id. No phone, name,
 * customer, amount or payment inference belongs here.
 */
async function projectRelatedVisits(conn, visits) {
  if (!Array.isArray(visits) || !visits.length) return [];
  const visitIds = [...new Set(visits.map((visit) => String(visit.id)).filter(Boolean))];
  const invoiceRows = await conn('invoices as i')
    .leftJoin('service_records as sr', 'i.service_record_id', 'sr.id')
    .where((qb) => qb
      .whereIn('i.scheduled_service_id', visitIds)
      .orWhere((fallback) => fallback
        .whereNull('i.scheduled_service_id')
        .whereIn('sr.scheduled_service_id', visitIds)))
    .select(
      'i.id',
      'i.status',
      'i.scheduled_service_id',
      'sr.scheduled_service_id as service_record_scheduled_service_id',
    );

  const invoicesByVisit = new Map(visitIds.map((id) => [id, new Map()]));
  for (const invoice of invoiceRows) {
    // Direct ownership wins. The SQL fallback is eligible only when this is
    // NULL, so an invoice explicitly linked to another visit never leaks in.
    const visitId = invoice.scheduled_service_id || invoice.service_record_scheduled_service_id;
    const bucket = invoicesByVisit.get(String(visitId));
    if (bucket) bucket.set(String(invoice.id), { id: invoice.id, status: invoice.status || 'unknown' });
  }

  return visits.map((visit) => ({
    id: visit.id,
    status: visit.status || 'unknown',
    scheduled_date: visit.scheduled_date,
    invoices: [...(invoicesByVisit.get(String(visit.id)) || new Map()).values()]
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  }));
}

async function loadRelatedVisits(conn, callId) {
  const visits = await conn('scheduled_services')
    .where({ source_call_log_id: callId })
    .orderBy('scheduled_date', 'desc')
    .orderBy('id', 'desc')
    .select('id', 'status', 'scheduled_date');
  return projectRelatedVisits(conn, visits);
}

module.exports = { loadRelatedVisits, projectRelatedVisits };
