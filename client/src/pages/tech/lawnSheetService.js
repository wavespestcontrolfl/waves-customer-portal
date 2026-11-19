// client/src/pages/tech/lawnSheetService.js
//
// The `service` prop the lawn Fast Complete sheet (FastCompleteLawnSheet) is
// opened with, built from a schedule row. One builder for both pages that open
// the sheet, admin Dispatch and the Today page, so the two cannot drift.
import { completionBillingFacts } from '../../lib/completion-billing-facts';
import { onSiteTimeOf } from '../../lib/on-site-time';
import { accessSheetFields } from '../../lib/schedule-access';
import { serviceWindowLabel } from './routeStops';
import { shortAddress } from './visitBrief';

// `a || b` over a row's snake_case and camelCase spellings, as the sheet was always given them.
const pickOf = (row, ...keys) => keys.reduce((found, key) => found || row[key], undefined);

export function lawnSheetService(row) {
  return {
    // What the Wrap-up reads to know whether the visit invoices and who pays.
    ...completionBillingFacts(row),
    // The stop's gate and access codes for the sheet header.
    ...accessSheetFields(row),
    id: row.id,
    customerName: pickOf(row, 'customer_name', 'customerName'),
    serviceType: pickOf(row, 'service_type', 'serviceType'),
    address: shortAddress(row.address) || row.address || '',
    // The customer block under the title (name link, directions, call).
    customerId: pickOf(row, 'customerId', 'customer_id') || null,
    fullAddress: typeof row.address === 'string' ? row.address : '',
    customerPhone: pickOf(row, 'customerPhone', 'customer_phone') || '',
    // The neighborhood's pinned gate, when the day feed carries one: the
    // directions link routes through it before the house.
    gateWaypoint: row.gateWaypoint || null,
    // When the technician checked in (the Time on-site clock), by the full
    // form's own rule: the on-site status-log entry, else checkInTime.
    onSiteAt: onSiteTimeOf(row) || null,
    timeLabel: serviceWindowLabel(row) || '',
    // Server-computed (GATE_TRACE_ELIGIBILITY): false hides the
    // treatment-zone row, since the save route would refuse the trace.
    traceEligible: row.traceEligible,
    // Decides whether a zero stock holds Complete (WaveGuard lawn visits may go negative).
    waveguardTier: row.waveguardTier || null,
    // The visit the user opened, checked against the live context.
    routedCustomerId: pickOf(row, 'customerId', 'customer_id') || null,
    routedScheduledDate: pickOf(row, 'scheduledDate', 'scheduled_date') || null,
    routedPropertyId: 'propertyId' in row ? row.propertyId : undefined,
    routedAddress: typeof row.address === 'string' ? row.address : null,
    // Checked against the live visit: the office may have changed the service since.
    routedServiceType: row.serviceTypeRaw || null,
    routedCatalogServiceId: row.catalogServiceId || null,
    completionInvoiceAlreadySent: !!row.completionInvoiceAlreadySent,
    // Today's off-route saved attempt (useSavedFastCompletions): the row holds
    // only the visit id and the attempt's summary, so the sheet offers that
    // attempt and never a fresh completion.
    recoveryOnly: row.fastCompletionRecoveryOnly === true,
  };
}
