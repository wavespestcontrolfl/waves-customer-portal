'use strict';
// The destination a live-ETA lookup resolves to for one scheduled_services row,
// and WHERE that resolution came from (Codex round-21 P2, PR #5334). Pure and
// dependency-light so the drafter-side aggregator (which records it in the
// send-time snapshot) and the send-time freshness check (which re-derives it
// from current rows) run the SAME resolution:
//   1. the visit's own stamped pin, when BOTH lat and lng are present
//      (source 'visit'); else
//   2. the customer's primary coordinates, when both are present and the
//      stamped address does not diverge from the customer's ("no pin beats a
//      wrong pin"; source 'customer'); else
//   3. nothing (source null) — the caller falls back to status-only.
// Coordinates are only ever used as a PAIR (round 17).
const { stampedAddressDiverges } = require('./stamped-address');
const { finiteNumber } = require('./customer-tracking-eta');

function resolveLiveEtaDestination(row, customer) {
  const visitLat = finiteNumber(row?.service_lat);
  const visitLng = finiteNumber(row?.service_lng);
  if (visitLat != null && visitLng != null) return { lat: visitLat, lng: visitLng, source: 'visit' };
  const diverges = stampedAddressDiverges({
    service_address_line1: row?.service_address_line1,
    service_address_zip: row?.service_address_zip,
    service_address_city: row?.service_address_city,
    customer_address_line1: customer?.address_line1,
    customer_zip: customer?.zip,
    customer_city: customer?.city,
  });
  if (diverges) return { lat: null, lng: null, source: null };
  const custLat = finiteNumber(customer?.latitude);
  const custLng = finiteNumber(customer?.longitude);
  return custLat != null && custLng != null ? { lat: custLat, lng: custLng, source: 'customer' } : { lat: null, lng: null, source: null };
}

module.exports = { resolveLiveEtaDestination };
