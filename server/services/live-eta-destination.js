'use strict';
// The destination a live-ETA lookup resolves to for one scheduled_services row,
// and WHERE that resolution came from (Codex round-21/29 P2, PR #5334). Pure and
// dependency-light so the drafter-side aggregator (which records it in the
// send-time snapshot) and the send-time freshness check (which re-derives it
// from current rows) run the SAME resolution — and it IS the public tracker's
// rule (routes/track-public.js, the customer-visible source of truth):
//     latitude  = COALESCE(visit.lat, CASE WHEN NOT diverges THEN customer.latitude END)
//     longitude = COALESCE(visit.lng, CASE WHEN NOT diverges THEN customer.longitude END)
// i.e. EACH coordinate independently falls back to the customer's unless the
// stamped address diverges from the customer's ("no pin beats a wrong pin").
// Only a complete resulting pair is usable (else the caller falls back to
// status-only; the tracker would geocode, the text never guesses). `source`:
//   'visit'    both coordinates from the visit's stamp
//   'customer' both from the customer's primary coordinates
//   'mixed'    one from each — exactly what the tracker shows for a
//              half-stamped visit, so the text and the tracking page agree
//   null       no complete pair
// tests/sms-live-eta.test.js pins the tracker's SQL COALESCE lines so
// this rule cannot drift from them unnoticed.
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
  const custLat = diverges ? null : finiteNumber(customer?.latitude);
  const custLng = diverges ? null : finiteNumber(customer?.longitude);
  const lat = visitLat ?? custLat;
  const lng = visitLng ?? custLng;
  if (lat == null || lng == null) return { lat: null, lng: null, source: null };
  return { lat, lng, source: visitLat == null && visitLng == null ? 'customer' : 'mixed' };
}
// Does this resolution depend on the customer's own coordinates (so a
// re-geocoded customer address changes it)?
function usesCustomerCoordinates(source) {
  return source === 'customer' || source === 'mixed';
}

// Stable, non-reversible fingerprint of a tracker device id (Bouncie IMEI) for
// the persisted send-time snapshot (round-22 P2): the raw device id never lands
// in input_snapshot, yet a re-pointed technician->device mapping still changes
// the value. null for an empty id.
function deviceFingerprint(imei) {
  const v = String(imei ?? '').trim();
  return v ? require('crypto').createHash('sha256').update(v).digest('hex').slice(0, 16) : null;
}

// Calendar day 'YYYY-MM-DD' of a Postgres DATE value. pg hands DATE columns over
// as Date objects at local midnight, so the local calendar parts are the true day;
// strings pass through their date prefix. Never treat these as instants. THE one
// "what day is this visit" reader for live ETA: the aggregator's eligibility
// (liveEtaEligible / liveEtaOnSite) and the send-time recheck (sms-eta-freshness)
// both use it against etDateString(), so they cannot disagree.
function calendarDay(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : null;
}

module.exports = { resolveLiveEtaDestination, usesCustomerCoordinates, deviceFingerprint, calendarDay };
