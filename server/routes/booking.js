const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { etDateString, addETDays, etParts } = require('../utils/datetime-et');
const TwilioService = require('../services/twilio');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { applyContactNormalization } = require('../utils/intake-normalize');
const { normalizeUnitLine, unitLineValueKey, splitStreetLineUnit, parseRawAddress } = require('../utils/address-normalizer');
const RecurringAppointmentSeeder = require('../services/recurring-appointment-seeder');
const {
  isOneTimeBookingSource,
} = require('../services/self-booking-plan-sync');

function cleanBookingServiceLabel(value) {
  const label = String(value || '').trim().replace(/\s+/g, ' ');
  return label ? label.slice(0, 120) : null;
}

// Shared geocoder (same approach as admin-schedule-find-time.js)
async function geocodeAddress(address) {
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('No Google Maps API key configured');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Geocode failed: ${data.status}`);
  }
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

function timeToMin(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

function minToTime12(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function ceilToGrid(min, gridMinutes = 15) {
  return Math.ceil(min / gridMinutes) * gridMinutes;
}

function cleanBookingStart(rawStartMin, slot, dayStartMin, gridMinutes = 15) {
  if (!slot?.insertion?.after_stop_id && rawStartMin < dayStartMin + gridMinutes) {
    return dayStartMin;
  }
  return ceilToGrid(rawStartMin, gridMinutes);
}

function isWholeHour(min) {
  return min % 60 === 0;
}

function proximityReason(detourMin) {
  if (detourMin <= 2) return 'We have a tech right around the corner';
  if (detourMin <= 7) return 'A tech will be working nearby';
  if (detourMin <= 15) return 'A tech will be in your area';
  return 'Available time slot';
}

function dateLabels(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return {
    dayOfWeek: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }),
    dayNum: day,
    month: d.toLocaleDateString('en-US', { month: 'short', timeZone: 'America/New_York' }),
    fullDate: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' }),
  };
}

function compareRankedSlots(a, b) {
  const scoreA = a.score ?? a.rank ?? 999999;
  const scoreB = b.score ?? b.rank ?? 999999;
  if (scoreA !== scoreB) return scoreA - scoreB;
  const dateCmp = String(a.date).localeCompare(String(b.date));
  if (dateCmp !== 0) return dateCmp;
  return String(a.start_time).localeCompare(String(b.start_time));
}

function curateSlots(candidates, today) {
  const sorted = [...candidates].sort(compareRankedSlots);
  const picks = [];
  const pickedDates = new Set();

  for (const slot of sorted) {
    if (pickedDates.has(slot.date)) continue;
    picks.push(slot);
    pickedDates.add(slot.date);
    if (picks.length === 4) break;
  }

  const replaceWorstWith = (replacement) => {
    if (!replacement || picks.length === 0) return;
    let worstIndex = 0;
    for (let i = 1; i < picks.length; i++) {
      if (compareRankedSlots(picks[worstIndex], picks[i]) < 0) worstIndex = i;
    }
    const remainingDates = new Set(picks.map((s, i) => (i === worstIndex ? null : s.date)).filter(Boolean));
    if (remainingDates.has(replacement.date)) return;
    picks[worstIndex] = replacement;
  };

  if (picks.length === 4) {
    const allAm = picks.every(s => timeToMin(s.start_time) < 12 * 60);
    const allPm = picks.every(s => timeToMin(s.start_time) >= 13 * 60);
    if (allAm || allPm) {
      // Business wants a choice across the day, even if route score alone clusters the top picks.
      const missingHalf = allAm
        ? sorted.find(s => timeToMin(s.start_time) >= 13 * 60)
        : sorted.find(s => timeToMin(s.start_time) < 12 * 60);
      replaceWorstWith(missingHalf);
    }
  }

  const soonStart = etDateString(today);
  const soonEnd = etDateString(addETDays(today, 3));
  const hasSoonCandidate = sorted.some(s => s.date >= soonStart && s.date <= soonEnd);
  const hasSoonPick = picks.some(s => s.date >= soonStart && s.date <= soonEnd);
  if (hasSoonCandidate && !hasSoonPick) {
    const soonPick = sorted.find(s => s.date >= soonStart && s.date <= soonEnd);
    replaceWorstWith(soonPick);
  }

  return picks.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.start_time).localeCompare(String(b.start_time)));
}

function fallbackZoneCenter(city) {
  // Used only when no address/coords provided. Resolves via service_zones table.
  return db('service_zones').first().then(async () => {
    const zones = await db('service_zones').select('*');
    const match = zones.find(z => (z.cities || []).some(c => c.toLowerCase() === (city || '').toLowerCase()));
    if (match && match.center_lat && match.center_lng) {
      return { lat: parseFloat(match.center_lat), lng: parseFloat(match.center_lng), zone: match };
    }
    return null;
  });
}

const ADDRESS_SUFFIXES = {
  avenue: 'ave',
  boulevard: 'blvd',
  circle: 'cir',
  court: 'ct',
  cove: 'cv',
  drive: 'dr',
  lane: 'ln',
  parkway: 'pkwy',
  place: 'pl',
  road: 'rd',
  street: 'st',
  terrace: 'ter',
  terr: 'ter',
  trail: 'trl',
  way: 'wy',
};
const ADDRESS_SUFFIX_VARIANTS = Object.entries(ADDRESS_SUFFIXES).reduce((acc, [longForm, shortForm]) => {
  acc[longForm] = [longForm, shortForm];
  acc[shortForm] = [shortForm, longForm];
  return acc;
}, {});

function normalizeAddress(value) {
  return String(value || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/[.#]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => ADDRESS_SUFFIXES[part] || part)
    .join('');
}

function normalizeZip(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 5);
}

function streetNumber(value) {
  return String(value || '').split(',')[0].trim().match(/^\d+/)?.[0] || '';
}

function streetNameTokens(value) {
  const token = String(value || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .find((part, index) => index > 0 && /[a-z]/.test(part)) || '';
  return [...new Set(ADDRESS_SUFFIX_VARIANTS[token] || [token])];
}

// The identity of a unit is its value, not its designator or notation —
// "Apt A", "#A", and "Unit A" are the same door (normalizeUnitLine strips
// '#'; unitLineValueKey drops a lone designator).
function unitValueKey(value) {
  return unitLineValueKey(normalizeUnitLine(value));
}

// Units only conflict when BOTH sides carry one — a blank side stays
// compatible, since most on-file addresses predate unit capture.
function unitsConflict(customerLine2, submittedUnit) {
  const a = unitValueKey(customerLine2);
  const b = unitValueKey(submittedUnit);
  return !!a && !!b && a !== b;
}

// A manual booking can enter the unit in BOTH fields ("123 Main St Apt 4" +
// unit "Apt 4"). When the inline unit value-matches the dedicated one, strip
// it from the street line so line1+line2 displays never repeat it. A
// DIFFERENT inline unit is left untouched — addressMatchesCustomer treats
// that as a conflict, never silent data loss. The duplicate may sit inline in
// the first comma segment or span one or more comma segments of its own
// ("123 Main St, Bldg 2, Apt 4, Sarasota") — grow the head one segment at a
// time and let the comma-aware splitter decide; the remaining tail
// (city/state) is preserved either way.
function stripInlineUnitFromLine(line, submittedUnit) {
  const submittedKey = unitValueKey(submittedUnit);
  if (!submittedKey) return line;
  const segments = String(line || '').split(',');
  for (let k = 0; k < segments.length; k += 1) {
    const split = splitStreetLineUnit(segments.slice(0, k + 1).join(','));
    if (split.unit && unitValueKey(split.unit) === submittedKey) {
      return [split.street, ...segments.slice(k + 1)].join(',');
    }
  }
  return line;
}

// The unit a customer record carries: the dedicated column, or a legacy
// inline unit still living in address_line1.
function customerUnitOf(customer) {
  return customer?.address_line2 || splitStreetLineUnit(customer?.address_line1 || '').unit;
}

// The inline unit of a SUBMITTED street line. splitStreetLineUnit only peels
// trailing units; a full one-line address ("123 Main St Apt A Sarasota FL
// 34236") hides the unit mid-line behind the city/state tail, so when the
// direct peel finds nothing, parse the tail off and re-peel.
function submittedInlineUnit(line) {
  const direct = splitStreetLineUnit(line || '');
  if (direct.unit) return direct.unit;
  const parsedLine1 = parseRawAddress(line || '').line1 || '';
  return parsedLine1 ? splitStreetLineUnit(parsedLine1).unit : '';
}

// The dedicated unit field of a submission — trimmed, because a whitespace-only
// value is truthy and would otherwise mask an inline unit while normalizing to
// "no unit" in every comparison.
function submittedDedicatedUnit(newCustomer) {
  return String(newCustomer?.address_line2 || '').trim();
}

// A submitted unit that disagrees with the RESOLVED customer's on-file unit
// is a booking against the wrong door (Apt B posted against the Apt A
// record) — even on identity-proven paths that never ran the address match.
// The unit may arrive in the dedicated field OR inline in the street line
// (legacy/manual clients). Only same-street submissions count: a different
// street line is not a unit statement about this record.
function submittedUnitConflictsWithCustomer(customer, newCustomer) {
  const submitted = splitStreetLineUnit(newCustomer?.address_line1 || '');
  const submittedUnit = submittedDedicatedUnit(newCustomer) || submitted.unit;
  if (!submittedUnit) return false;
  const submittedStreet = normalizeAddress(submitted.street);
  const onFileStreet = normalizeAddress(splitStreetLineUnit(customer?.address_line1 || '').street);
  if (!submittedStreet || !onFileStreet || submittedStreet !== onFileStreet) return false;
  return unitsConflict(customerUnitOf(customer), submittedUnit);
}

// Unit to carry on the VISIT's own records when it can't be written to the
// customer row (unit writes are token-proven): the booker's submitted unit,
// only for a same-street submission against a record that has no unit of its
// own. Conflicting submissions never reach this — they 400 upstream.
function carriedVisitUnit(customer, newCustomer) {
  if (!newCustomer || customerUnitOf(customer)) return '';
  const submitted = splitStreetLineUnit(newCustomer.address_line1 || '');
  const submittedUnit = submittedDedicatedUnit(newCustomer) || submitted.unit;
  if (!submittedUnit) return '';
  const submittedStreet = normalizeAddress(submitted.street);
  const onFileStreet = normalizeAddress(splitStreetLineUnit(customer.address_line1 || '').street);
  if (!submittedStreet || submittedStreet !== onFileStreet) return '';
  return normalizeUnitLine(submittedUnit);
}

function addressMatchesCustomer(customer, address, zip, unit) {
  // Legacy records may still carry the unit inline in address_line1
  // ("123 Main St Apt A", empty address_line2) — split both sides so a
  // street-only + dedicated-unit submission still matches its own record.
  const submitted = splitStreetLineUnit(address);
  // A submission carrying TWO disagreeing units (inline in the street field
  // AND the dedicated box) is ambiguous — fail it rather than pick one.
  if (unitsConflict(submitted.unit, unit)) return false;
  const onFile = splitStreetLineUnit(customer?.address_line1);
  const lookupAddress = normalizeAddress(submitted.street);
  const customerAddress = normalizeAddress(onFile.street);
  if (!lookupAddress || !customerAddress || lookupAddress !== customerAddress) return false;
  // Same street is NOT the same household in a multi-unit building — a
  // submitted unit that disagrees with the one on file fails verification.
  if (unitsConflict(customerUnitOf(customer), unit || submitted.unit)) return false;
  const lookupZip = normalizeZip(zip);
  const customerZip = normalizeZip(customer?.zip);
  return !lookupZip || !customerZip || lookupZip === customerZip;
}

// Narrow same-street candidates by the submitted unit: exact unit matches
// win outright; only when none exists do blank-unit records stay compatible.
// Otherwise a street-only legacy row on the same street would destroy the
// uniqueness check and cost a returning customer their exact Apt match.
function narrowCandidatesByUnit(candidates, submittedUnit) {
  const compatible = candidates.filter((c) => !unitsConflict(customerUnitOf(c), submittedUnit));
  const submittedKey = unitValueKey(submittedUnit);
  if (!submittedKey) return compatible;
  const exact = compatible.filter((c) => unitValueKey(customerUnitOf(c)) === submittedKey);
  return exact.length ? exact : compatible;
}

async function findUniqueCustomerByAddress(address, city, zip, unit) {
  const submitted = splitStreetLineUnit(address);
  // Two disagreeing units in one submission is ambiguous — no match.
  if (unitsConflict(submitted.unit, unit)) return null;
  const normalizedAddress = normalizeAddress(submitted.street);
  if (!normalizedAddress) return null;
  const number = streetNumber(address);
  if (!number) return null;
  const streetTokens = streetNameTokens(address);
  if (!streetTokens.length || !streetTokens[0]) return null;

  const query = db('customers');

  query.where(function () {
    this.whereNull('deleted_at');
  });

  query.andWhere(function () {
    this.whereNull('active').orWhere('active', true);
  });

  query.andWhereRaw("split_part(trim(split_part(coalesce(address_line1, ''), ',', 1)), ' ', 1) = ?", [number]);
  query.andWhere(function () {
    for (const token of streetTokens) {
      this.orWhereRaw("lower(split_part(coalesce(address_line1, ''), ',', 1)) LIKE ?", [`%${token}%`]);
    }
  });

  const candidates = await query
    .select('id', 'first_name', 'last_name', 'email', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'phone')
    .limit(1000);

  const sameStreet = candidates.filter(
    (customer) => normalizeAddress(splitStreetLineUnit(customer.address_line1).street) === normalizedAddress
  );
  const matches = narrowCandidatesByUnit(sameStreet, unit || submitted.unit);
  const normalizedZip = normalizeZip(zip);
  const cityValue = String(city || '').trim().toLowerCase();
  if (normalizedZip || cityValue) {
    const zipMatches = normalizedZip ? matches.filter(customer => {
      const customerCity = String(customer.city || '').trim().toLowerCase();
      const customerZip = normalizeZip(customer.zip);
      if (customerZip !== normalizedZip) return false;
      const cityMatches = !cityValue || !customerCity || customerCity === cityValue;
      return cityMatches;
    }) : [];
    if (zipMatches.length === 1) return zipMatches[0];

    const cityOnlyMatches = matches.filter(customer => {
      const customerCity = String(customer.city || '').trim().toLowerCase();
      // Google/user ZIPs drift on a few LWR/Bradenton edges; only fall back after ZIP-exact matching fails.
      const exactCityMatch = cityValue && customerCity === cityValue;
      return exactCityMatch;
    });
    return cityOnlyMatches.length === 1 ? cityOnlyMatches[0] : null;
  }

  return matches.length === 1 ? matches[0] : null;
}

// GET /api/booking/customer-lookup?phone=9415551234 OR ?address=...&city=...&zip=...
router.get('/customer-lookup', async (req, res, next) => {
  try {
    const { phone, address, city, zip, unit } = req.query;
    const customerFields = ['id', 'first_name', 'last_name', 'email', 'address_line1', 'address_line2', 'city', 'state', 'zip'];
    const phoneCustomerFields = [...customerFields, 'phone'];
    let customer = null;

    if (phone) {
      const digits = String(phone).replace(/\D/g, '');
      if (digits.length !== 10) return res.json({ customer: null });

      const query = db('customers')
        .whereRaw("regexp_replace(phone, '[^0-9]', '', 'g') = ?", [digits])
        .where(function () {
          this.whereNull('deleted_at');
        })
        .andWhere(function () {
          this.whereNull('active').orWhere('active', true);
        });

      customer = await query.select(phoneCustomerFields).first();
      // SECURITY: never disclose a customer's PII (name/email/address) on a
      // phone number alone — that lets anyone enumerate identities from a
      // number they merely possess. Require a matching address before
      // disclosing. The booking funnel always collects the address (step 1)
      // before the phone step, so legitimate returning-customer autofill is
      // unaffected; only the address-less enumeration path is closed.
      if (customer && !(address && addressMatchesCustomer(customer, address, zip, unit))) {
        customer = null;
      }
      // address_line2 is needed ABOVE for the unit-aware match but must not
      // be disclosed: a blank submitted unit stays compatible by design, so
      // phone + street knowledge would otherwise read back the apartment
      // number. Same for a legacy unit still inline in address_line1 — the
      // response carries the street only. The booking UI never consumes
      // either field from this response.
      if (customer) {
        const { address_line2: _undisclosedUnit, ...publicCustomer } = customer;
        publicCustomer.address_line1 = splitStreetLineUnit(publicCustomer.address_line1 || '').street
          || publicCustomer.address_line1;
        return res.json({ customer: publicCustomer });
      }
      return res.json({ customer: null });
    }

    if (address) {
      // SECURITY: an unauthenticated caller must not be able to turn a street
      // address into the resident's PII (name / email / home address) — a
      // doxxing vector. Disclose ONLY the opaque customer id + a match boolean,
      // never personal details. The id is required so a recognized returning
      // customer is linked to their account at step 1; without it the account
      // link would depend on the racy step-3 phone lookup and a fast Confirm
      // would hit the phone-on-file guard (409) on a valid booking. Tightening
      // the id->booking trust (book-on-behalf via a guessed address) is a
      // separate, pre-existing hardening item, not in scope here.
      const match = await findUniqueCustomerByAddress(address, city, zip, unit);
      return res.json({
        customer: match ? { id: match.id } : null,
        possible_match: !!match,
      });
    }

    res.json({ customer: null });
  } catch (err) { next(err); }
});

// GET /api/booking/config — public booking config so the UI can gate properly
router.get('/config', async (req, res, next) => {
  try {
    const { isEnabled } = require('../config/feature-gates');
    const config = (await db('booking_config').first()) || {};
    res.json({
      enabled: isEnabled('selfBooking') && config.enabled !== false,
      advance_days_min: config.advance_days_min ?? 1,
      advance_days_max: config.advance_days_max ?? 14,
      slot_duration_minutes: config.slot_duration_minutes ?? 60,
      day_start: config.day_start || '08:00',
      day_end: config.day_end || '17:00',
    });
  } catch (err) { next(err); }
});

// Furthest out a customer can browse/search for a slot. The default window
// stays narrow (advance_days_max, ~14d); this only opens up when the customer
// explicitly picks a later date or searches via the Waves AI bar.
const MAX_BOOKING_HORIZON_DAYS = 90;

// Short-lived HMAC token minted in the availability response and REQUIRED by
// /capture-intent. It proves the caller went through a real booking-availability
// fetch (the funnel always does) rather than POSTing raw — so the public capture
// endpoint can't be used to seed abandoned-booking recovery SMS/email to
// arbitrary recipients. Bound to expiry (not to the phone, which the funnel
// doesn't prove); combined with the per-IP limiter this caps abuse to the funnel
// flow at ~12/min for the token's lifetime.
const CAPTURE_TOKEN_SECRET = process.env.JWT_SECRET || process.env.BOOKING_CAPTURE_SECRET || 'waves-booking-capture-dev';
const CAPTURE_TOKEN_TTL_MS = 30 * 60 * 1000;
// Bind the token to the requesting IP (trust proxy is set, so req.ip is the
// client). This stops "fetch one token, then POST many victim phones" — a
// captured token is only usable from the IP that minted it, so reuse is bounded
// by the same per-IP rate limiter. Hashed so the token never leaks the address.
// (CGNAT/mobile IP rotation just fails closed → that capture is skipped, no error.)
function captureIpKey(req) {
  const xff = req && req.headers && typeof req.headers['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for'].split(',')[0].trim() : '';
  const ip = (req && req.ip) || xff || '';
  return crypto.createHmac('sha256', CAPTURE_TOKEN_SECRET).update(`ip:${ip}`).digest('base64url').slice(0, 16);
}
function mintCaptureToken(ipKey = '', now = Date.now()) {
  const exp = now + CAPTURE_TOKEN_TTL_MS;
  const sig = crypto.createHmac('sha256', CAPTURE_TOKEN_SECRET).update(`capture:${exp}:${ipKey}`).digest('base64url');
  return `${exp}.${sig}`;
}
function verifyCaptureToken(token, ipKey = '', now = Date.now()) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [expStr, sig] = token.split('.');
  const exp = parseInt(expStr, 10);
  // Reject expired tokens and any exp implausibly far in the future (forged).
  if (!Number.isFinite(exp) || now > exp || exp > now + CAPTURE_TOKEN_TTL_MS + 60000) return false;
  const expected = crypto.createHmac('sha256', CAPTURE_TOKEN_SECRET).update(`capture:${exp}:${ipKey}`).digest('base64url');
  try {
    return !!sig && sig.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch { return false; }
}

// A slot counts as "nearby" (route-efficient) when its detour is small enough
// to earn one of the proximity reasons — i.e. a tech is already working close
// by. Drives the soft "no route near you that day yet" messaging downstream.
const NEARBY_DETOUR_MINUTES = 15;

// Whole-hour windows offered on a day with no existing stops, so a customer
// who picks/searches an otherwise-empty day gets real choice across the open
// block instead of just the 8 AM gap start. Skips noon (lunch is reserved).
const OPEN_DAY_WINDOWS = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'];

function inTimeOfDay(startTimeHHMM, timeOfDay) {
  if (!timeOfDay || timeOfDay === 'any') return true;
  const min = timeToMin(startTimeHHMM);
  if (timeOfDay === 'morning') return min < 12 * 60;
  // afternoon + evening both land inside the 12pm–5pm working window
  return min >= 12 * 60;
}

// Resolve service coordinates from any of: explicit lat/lng, a linked estimate's
// customer, a free-text address, or a city's service-zone center. Shared by
// /availability and /find-slots.
async function resolveBookingCoords({ lat, lng, address, city, estimate_id }) {
  let resolvedLat = lat ? parseFloat(lat) : null;
  let resolvedLng = lng ? parseFloat(lng) : null;

  if ((!resolvedLat || !resolvedLng) && estimate_id) {
    const est = await db('estimates').where('id', estimate_id).first();
    if (est?.customer_id) {
      const c = await db('customers').where('id', est.customer_id)
        .select('latitude', 'longitude', 'address_line1', 'city', 'state', 'zip').first();
      if (c?.latitude && c?.longitude) {
        resolvedLat = parseFloat(c.latitude);
        resolvedLng = parseFloat(c.longitude);
      } else if (c) {
        const addr = [c.address_line1, c.city, c.state, c.zip].filter(Boolean).join(', ');
        if (addr) {
          const geo = await geocodeAddress(addr);
          resolvedLat = geo.lat; resolvedLng = geo.lng;
        }
      }
    }
  }

  if ((!resolvedLat || !resolvedLng) && address) {
    const geo = await geocodeAddress(address);
    resolvedLat = geo.lat; resolvedLng = geo.lng;
  }

  if ((!resolvedLat || !resolvedLng) && city) {
    const zone = await fallbackZoneCenter(city);
    if (zone) { resolvedLat = zone.lat; resolvedLng = zone.lng; }
  }

  return { lat: resolvedLat, lng: resolvedLng };
}

// Load the singleton booking_config row, falling back to the same defaults the
// public routes use. Exported so non-route callers (e.g. the voice agent's
// read-only quoting tools) share one source of truth for the config window.
async function loadBookingConfig() {
  return (await db('booking_config').first()) || {
    advance_days_min: 1, advance_days_max: 14,
    slot_duration_minutes: 60,
    day_start: '08:00', day_end: '17:00',
    max_self_books_per_day: 3,
  };
}

// Core availability builder. Runs the route-aware slot finder over [rangeFrom,
// rangeTo], applies the per-day cap / lunch / whole-hour rules, then returns the
// curated best-4 plus a full per-day breakdown. `timeOfDay` ('morning' |
// 'afternoon' | 'evening' | 'any') filters candidates for Waves AI searches.
async function buildBookingAvailability({ lat, lng, duration, rangeFrom, rangeTo, config, today, timeOfDay = 'any', expandOpenDays = false, excludeServiceIds = [] }) {
  const result = await findAvailableSlots({
    lat,
    lng,
    durationMinutes: duration,
    dateFrom: rangeFrom,
    dateTo: rangeTo,
    // Relocating an existing visit (public self-reschedule): drop its own row
    // from the occupied-route set so it doesn't block the slot it's moving
    // out of. Default [] = identical behavior for every other caller.
    excludeServiceIds,
    dayStartHour: parseInt((config.day_start || '08:00').split(':')[0]),
    dayEndHour: parseInt((config.day_end || '17:00').split(':')[0]),
    // The default best-4 window is narrow, so 200 ranked candidates is ample.
    // A specific-date / "Find more dates" browse (expandOpenDays) can span the
    // full 90-day horizon across several techs — capping at 200 there would
    // drop the lowest-scored (furthest-out) dates and make the calendar mark
    // them unavailable, so pull every feasible candidate. find-time only slices
    // a pre-computed list, so this is cheap.
    topN: expandOpenDays ? Number.MAX_SAFE_INTEGER : 200,
  });

  // Enforce max_self_books_per_day — filter out dates already at cap
  const maxPerDay = config.max_self_books_per_day ?? 3;
  const slotGridMinutes = 60;
  const dayStartMin = timeToMin(config.day_start || '08:00');
  const dayEndMin = timeToMin(config.day_end || '17:00');
  const lunchStart = timeToMin(config.lunch_start || '12:00');
  const lunchEnd = timeToMin(config.lunch_end || '13:00');
  const bookingCounts = await db('self_booked_appointments')
    .whereNot('status', 'cancelled')
    .whereBetween('date', [rangeFrom, rangeTo])
    .select('date')
    .count('* as count')
    .groupBy('date');
  const fullDays = new Set(
    bookingCounts.filter(r => parseInt(r.count) >= maxPerDay)
      .map(r => (typeof r.date === 'string' ? r.date.split('T')[0] : r.date.toISOString().split('T')[0]))
  );

  const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const candidateMap = new Map();
  const addCandidate = (slot, startMin) => {
    const endMin = startMin + duration;
    if (!isWholeHour(startMin)) return;
    if (startMin < dayStartMin || endMin > dayEndMin) return;
    // Lunch windows are reserved for route health and should never be self-booked.
    if (startMin < lunchEnd && endMin > lunchStart) return;
    const startTime = fmt(startMin);
    if (!inTimeOfDay(startTime, timeOfDay)) return;
    const key = `${slot.date}|${startTime}`;
    // result.slots is score-sorted, so the first candidate to claim a date+time
    // is the most route-efficient one — keep it.
    if (candidateMap.has(key)) return;
    const labels = dateLabels(slot.date);
    candidateMap.set(key, {
      date: slot.date,
      ...labels,
      start_time: startTime,
      end_time: fmt(endMin),
      start_label: minToTime12(startMin),
      end_label: minToTime12(endMin),
      detour_minutes: slot.detour_minutes,
      reason: proximityReason(slot.detour_minutes),
      technician_id: slot.technician.id,
      rank: slot.rank,
      score: slot.score,
      startTime24: startTime,
      endTime24: fmt(endMin),
      start: minToTime12(startMin),
      end: minToTime12(endMin),
    });
  };

  for (const slot of (result.slots || [])) {
    if (fullDays.has(slot.date)) continue;
    if (expandOpenDays && (slot.stops_that_day || 0) === 0) {
      // Open day (no stops yet for this tech) — offer the whole block of hourly
      // windows so the customer can pick any time, not just the gap's earliest
      // start. These carry the gap's (large) detour, so they read as
      // "Available time slot" and keep the day flagged not-nearby.
      for (const win of OPEN_DAY_WINDOWS) addCandidate(slot, timeToMin(win));
    } else {
      // Route scoring returns minute-level travel offsets; customers see clean windows.
      const rawStartMin = timeToMin(slot.start_time);
      addCandidate(slot, cleanBookingStart(rawStartMin, slot, dayStartMin, slotGridMinutes));
    }
  }
  const candidates = [...candidateMap.values()].sort(compareRankedSlots);
  const curatedSlots = curateSlots(candidates, today);

  // Group slots by date, anonymize tech, add reason + best_fit flag, dedupe (one slot per day+start)
  const byDate = new Map();
  for (const slot of candidates) {
    const key = slot.date;
    if (!byDate.has(key)) byDate.set(key, []);
    const bucket = byDate.get(key);
    bucket.push({
      start_time: slot.start_time,
      end_time: slot.end_time,
      start_label: slot.start_label,
      end_label: slot.end_label,
      detour_minutes: slot.detour_minutes,
      reason: proximityReason(slot.detour_minutes),
      // Opaque identifiers the confirm step will replay
      technician_id: slot.technician_id,
      rank: slot.rank,
      // Legacy aliases (existing BookingPage reads these)
      startTime24: slot.start_time,
      endTime24: slot.end_time,
      start: minToTime12(timeToMin(slot.start_time)),
      end: minToTime12(timeToMin(slot.end_time)),
    });
  }

  // Sort each day's slots chronologically; mark best_fit on the single globally-top-ranked slot per day
  const days = [];
  for (const [date, slots] of byDate.entries()) {
    slots.sort((a, b) => a.start_time.localeCompare(b.start_time));
    const best = slots.reduce((acc, s) => (acc == null || s.rank < acc.rank ? s : acc), null);
    const labels = dateLabels(date);
    // Default landing keeps the tight 4-per-day cap; a specific-date / AI
    // search opens it up so the customer sees the full block of options.
    const perDayCap = expandOpenDays ? 8 : 4;
    const cappedSlots = slots.map(s => ({ ...s, is_best_fit: s === best })).slice(0, perDayCap);
    days.push({
      date,
      ...labels,
      // A day is "nearby" when at least one of its slots is route-efficient.
      nearby: cappedSlots.some(s => s.detour_minutes != null && s.detour_minutes <= NEARBY_DETOUR_MINUTES),
      slots: cappedSlots,
    });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));

  return {
    slots: curatedSlots.map(({ score, startTime24, endTime24, start, end, ...slot }) => slot),
    days,
    nearby: days.some(d => d.nearby),
    total_feasible: result.total_feasible || 0,
  };
}

// GET /api/booking/availability
//   query: lat, lng, address, city, service_type, duration_minutes, date_from, date_to
router.get('/availability', async (req, res, next) => {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('selfBooking')) {
      return res.status(503).json({ error: 'Self-scheduling coming soon' });
    }

    const {
      lat, lng, address, city, estimate_id,
      service_type, duration_minutes,
      date_from, date_to,
    } = req.query;

    const config = (await db('booking_config').first()) || {
      advance_days_min: 1, advance_days_max: 14,
      slot_duration_minutes: 60,
      day_start: '08:00', day_end: '17:00',
      max_self_books_per_day: 3,
    };

    const { lat: resolvedLat, lng: resolvedLng } = await resolveBookingCoords({ lat, lng, address, city, estimate_id });
    if (!resolvedLat || !resolvedLng) {
      return res.status(400).json({ error: 'address, lat/lng, or city required' });
    }

    // Default date window from config — anchored to ET calendar days so the
    // window doesn't shift by a day between 8 PM ET and midnight UTC. A
    // caller-supplied range is honored but clamped to the 90-day horizon so a
    // "Find more dates" / specific-date request can reach further out.
    const today = new Date();
    const minDate = etDateString(addETDays(today, config.advance_days_min ?? 1));
    const maxDate = etDateString(addETDays(today, MAX_BOOKING_HORIZON_DAYS));
    const defaultTo = etDateString(addETDays(today, config.advance_days_max ?? 14));
    const clamp = (d, fallback) => {
      if (!d) return fallback;
      if (d < minDate) return minDate;
      if (d > maxDate) return maxDate;
      return d;
    };
    const rangeFrom = clamp(date_from, minDate);
    let rangeTo = clamp(date_to, defaultTo);
    if (rangeTo < rangeFrom) rangeTo = rangeFrom;

    const duration = duration_minutes
      ? parseInt(duration_minutes)
      : (config.slot_duration_minutes || 60);

    const availability = await buildBookingAvailability({
      lat: resolvedLat, lng: resolvedLng, duration, rangeFrom, rangeTo, config, today,
      // "expand=open" widens otherwise-empty days into full hourly windows — used
      // when the customer browses a specific date / "Find more dates".
      expandOpenDays: req.query.expand === 'open',
    });

    res.json({
      slots: availability.slots,
      days: availability.days,
      nearby: availability.nearby,
      lat: resolvedLat,
      lng: resolvedLng,
      duration_minutes: duration,
      service_type: service_type || null,
      total_feasible: availability.total_feasible,
      // Proof-of-funnel token the client echoes to /capture-intent.
      capture_token: mintCaptureToken(captureIpKey(req)),
    });
  } catch (err) {
    logger.error('[booking:availability] failed:', err);
    next(err);
  }
});

// POST /api/booking/find-slots — Waves AI date/time search.
//   body: { query, lat, lng, address, city, estimate_id, service_type, duration_minutes }
//   Parses the natural-language "when" into a date window + time-of-day, then
//   returns the matching open slots (same shape as /availability) plus a short
//   summary line and a `nearby` flag for the soft route-density message.
router.post('/find-slots', async (req, res, next) => {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('selfBooking')) {
      return res.status(503).json({ error: 'Self-scheduling coming soon' });
    }

    const {
      query, lat, lng, address, city, estimate_id,
      service_type, duration_minutes,
    } = req.body || {};
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) return res.status(400).json({ error: 'query required' });
    if (cleanQuery.length > 500) return res.status(400).json({ error: 'query too long' });

    const config = (await db('booking_config').first()) || {
      advance_days_min: 1, advance_days_max: 14,
      slot_duration_minutes: 60,
      day_start: '08:00', day_end: '17:00',
      max_self_books_per_day: 3,
    };

    const { lat: resolvedLat, lng: resolvedLng } = await resolveBookingCoords({ lat, lng, address, city, estimate_id });
    if (!resolvedLat || !resolvedLng) {
      return res.status(400).json({ error: 'address, lat/lng, or city required' });
    }

    const today = new Date();
    const { parseWhen, summarizeWindow } = require('../services/scheduling/parse-when');
    const when = await parseWhen(cleanQuery, {
      now: today,
      minDaysOut: config.advance_days_min ?? 1,
      maxDaysOut: MAX_BOOKING_HORIZON_DAYS,
      defaultWindowDays: config.advance_days_max ?? 14,
    });

    const duration = duration_minutes
      ? parseInt(duration_minutes)
      : (config.slot_duration_minutes || 60);

    const availability = await buildBookingAvailability({
      lat: resolvedLat, lng: resolvedLng, duration,
      rangeFrom: when.dateFrom, rangeTo: when.dateTo, config, today,
      timeOfDay: when.timeOfDay,
      expandOpenDays: true,
    });

    const slotCount = (availability.days || []).reduce((n, d) => n + (Array.isArray(d.slots) ? d.slots.length : 0), 0);
    res.json({
      summary: summarizeWindow(when, { count: slotCount, nearby: availability.nearby }),
      understood: when.understood,
      window: { date_from: when.dateFrom, date_to: when.dateTo },
      time_of_day: when.timeOfDay,
      nearby: availability.nearby,
      slots: availability.slots,
      days: availability.days,
      lat: resolvedLat,
      lng: resolvedLng,
      duration_minutes: duration,
      service_type: service_type || null,
      capture_token: mintCaptureToken(captureIpKey(req)),
    });
  } catch (err) {
    logger.error('[booking:find-slots] failed:', err);
    next(err);
  }
});

// POST /api/booking/confirm
// createSelfBooking — the booking-commit operation behind POST /api/booking/confirm,
// extracted so non-HTTP callers (e.g. the voice agent's confirm_booking tool) run the
// EXACT same path: customer resolution, advisory-locked conflict re-check, the two-row
// transaction, and post-commit seeding/reminders/SMS/lead-conversion. Does NOT check
// the selfBooking gate (the caller decides). Returns a discriminated result
// { ok:true, body } | { ok:false, status, error }; throws on unexpected errors.
async function createSelfBooking(payload = {}) {
    const {
      estimate_id, estimate_share_token, pricing_estimate_id, estimate_token, customer_id, lead_id,
      slot_date, slot_start, slot_end,
      technician_id,
      service_type,
      quoted_service_label,
      duration_minutes,
      recurring_pattern,
      customer_notes,
      source,
      referrer_url,
      attribution,
      new_customer,
      payAtVisit,
    } = payload;

    if (!slot_date || !slot_start) {
      return { ok: false, status: 400, error: 'slot_date and slot_start required' };
    }

    // Normalize the calendar day ONCE and use it for the advisory locks,
    // the idempotency lookup, conflict checks, and inserts — an
    // equivalent-but-differently-shaped date string would otherwise take
    // a different lock key and bypass serialization entirely.
    const slotDateStr = String(slot_date).split('T')[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDateStr)) {
      return { ok: false, status: 400, error: 'Invalid slot_date' };
    }
    const todayEtStr = etDateString();
    if (slotDateStr < todayEtStr) {
      return { ok: false, status: 400, error: 'That date has already passed — please pick another day.' };
    }
    if (slotDateStr === todayEtStr) {
      const nowEt = etParts(new Date());
      if (timeToMin(slot_start) <= nowEt.hour * 60 + nowEt.minute) {
        return { ok: false, status: 409, error: 'That time has already passed today — please pick another slot.' };
      }
    }

    // A new_customer payload whose street line carries a DIFFERENT inline
    // unit than the dedicated field points at two doors at once — fail closed
    // like the matching paths, instead of minting (or backfilling from) a
    // self-contradictory address. submittedInlineUnit also finds a unit
    // hiding mid-line in a full one-line address ("… Apt A Sarasota FL 34236").
    if (new_customer && unitsConflict(submittedInlineUnit(new_customer.address_line1), submittedDedicatedUnit(new_customer))) {
      return { ok: false, status: 400, error: 'The street address and unit number disagree — please re-enter your address.' };
    }

    // Resolve customer
    let custId = null;
    let estimate = null;
    // Only TOKEN-PROVEN paths (verified estimate, or a wizard estimate whose
    // share token the caller possesses) may write a submitted unit onto an
    // existing record. Phone-on-file and the public address lookup are
    // knowledge, not possession — anyone who knows the phone or address could
    // otherwise attach an arbitrary unit to the customer.
    let unitBackfillAllowed = false;
    if (estimate_id) {
      estimate = await db('estimates').where('id', estimate_id).first();
      // Do NOT resolve identity from an unverified quote-wizard / handoff draft
      // (linked to a customer by unverified phone/email) — trusting it would let
      // anyone who quotes with a victim's contact then POST estimate_id here to
      // book under that customer. Only verified estimates (admin/accepted,
      // source !== 'quote_wizard') resolve identity; quote handoffs are used for
      // PRICING only, via pricing_estimate_id.
      if (!custId && estimate && estimate.source !== 'quote_wizard') {
        custId = estimate.customer_id;
        unitBackfillAllowed = true;
      }
      // A quote-wizard estimate still resolves identity when the caller proves
      // possession of its SHARE token (the legacy /book/:estimateToken page
      // posts the token it loaded the estimate with). Share tokens are
      // staff/system-issued to the estimate's own contact and are NEVER exposed
      // by the public quote flow — unlike the raw id, which /public/quote/calculate
      // returns to whoever ran the quote — so this keeps the legacy linked-booking
      // path working for promoted wizard estimates without re-opening the
      // forged-estimate_id identity hole.
      if (!custId && estimate && estimate.source === 'quote_wizard'
          && estimate.token && estimate_share_token
          && String(estimate.token) === String(estimate_share_token)) {
        custId = estimate.customer_id;
        unitBackfillAllowed = true;
      }
    }
    // NB: ?lead=<lead_id> is NOT trusted for identity. A lead_id is mintable
    // from a known phone/email via the public quote flow, so using it to resolve
    // the customer would bypass the phone-on-file guard. It is used only as a
    // "this booking came from an estimate deep link" signal for the
    // customer-derived lead conversion after the booking commits (see below).

    const phoneDigits = new_customer?.phone ? String(new_customer.phone).replace(/\D/g, '') : '';
    if (!custId && phoneDigits) {
      const existing = await db('customers')
        .whereRaw("regexp_replace(phone, '[^0-9]', '', 'g') = ?", [phoneDigits])
        .where(function () {
          this.whereNull('deleted_at');
        })
        .andWhere(function () {
          this.whereNull('active').orWhere('active', true);
        })
        .first();
      if (existing) {
        if (!customer_id) {
          // NOTE: a new_customer double-submit retry lands here (the first
          // attempt created the profile) and gets this 409 rather than an
          // idempotent replay — deliberately. Phone + date + start time is
          // NOT proof of identity on a public route; replaying the booking
          // row + confirmation code here would let anyone with a
          // customer's phone number probe slots and harvest booking
          // details. The in-transaction replay guard still covers callers
          // that proved identity (customer_id / estimate token).
          return { ok: false, status: 409, error: 'This phone number is already on file. Please verify the customer profile before booking.' };
        }
        if (String(existing.id) !== String(customer_id)) {
          return { ok: false, status: 400, error: 'Customer lookup mismatch' };
        }
        custId = existing.id;
        // Phone + customer_id resolves the BOOKING, but is knowledge, not
        // possession: the id comes from the public address lookup and the
        // phone can be typed by anyone who knows it. Not enough to WRITE a
        // unit onto the record — only token-proven estimate paths backfill.
      }
    }

    if (customer_id && !custId && !phoneDigits && !estimate_id) {
      const addressVerifiedCustomer = await db('customers')
        .where('id', customer_id)
        .whereNull('deleted_at')
        .andWhere(function () {
          this.whereNull('active').orWhere('active', true);
        })
        .first();
      if (
        !addressVerifiedCustomer
        || !new_customer
        || !addressMatchesCustomer(addressVerifiedCustomer, new_customer.address_line1, new_customer.zip, new_customer.address_line2)
      ) {
        return { ok: false, status: 400, error: 'Address verification required for existing customer booking' };
      }
      custId = addressVerifiedCustomer.id;
    }

    // Create customer from new_customer payload if none resolved
    let createdCustomerId = null;
    if (!custId && new_customer && phoneDigits && new_customer.first_name) {
      const [created] = await db('customers').insert(applyContactNormalization({
        first_name: new_customer.first_name,
        last_name: new_customer.last_name || '',
        phone: phoneDigits,
        email: new_customer.email || null,
        address_line1: stripInlineUnitFromLine(new_customer.address_line1, new_customer.address_line2) || null,
        address_line2: normalizeUnitLine(new_customer.address_line2) || null,
        city: new_customer.city || null,
        state: new_customer.state || 'FL',
        zip: new_customer.zip || null,
        latitude: new_customer.lat || null,
        longitude: new_customer.lng || null,
      })).returning('id');
      custId = created.id || created;
      createdCustomerId = custId;
      await db('notification_prefs')
        .insert({ customer_id: custId })
        .onConflict('customer_id')
        .ignore();
    }

    if (!custId) return { ok: false, status: 400, error: 'customer_id, estimate_id, or new_customer required' };

    const customer = await db('customers').where('id', custId).first();
    if (!customer) return { ok: false, status: 404, error: 'Customer not found' };

    // Estimate-token and phone-resolved paths never ran the address match, so
    // a submitted unit that disagrees with the resolved record's on-file unit
    // must fail closed here — never schedule Apt B's request against Apt A's
    // account. (A just-created customer already passed the payload guard.)
    if (!createdCustomerId && submittedUnitConflictsWithCustomer(customer, new_customer)) {
      return { ok: false, status: 400, error: 'The unit number doesn\'t match the one we have on file for this address.' };
    }

    // Returning booker supplying a unit their record lacks: attach it, but only
    // on a TOKEN-PROVEN path (unitBackfillAllowed — verified/share-token
    // estimate; never phone-on-file or the public address-only lookup, both of
    // which are knowledge anyone could hold), only when the submitted street
    // line matches the record (same rule as lead-webhook — never bolt a unit
    // onto a different address), and never when a legacy record already
    // carries the unit inline in address_line1 (double-store).
    // New customers already got it at insert.
    if (unitBackfillAllowed && !createdCustomerId && new_customer?.address_line2
        && !customer.address_line2 && !splitStreetLineUnit(customer.address_line1).unit) {
      const submittedUnit = normalizeUnitLine(new_customer.address_line2);
      if (submittedUnit && addressMatchesCustomer(customer, new_customer.address_line1, new_customer.zip, new_customer.address_line2)) {
        try {
          await db('customers').where('id', customer.id).update({ address_line2: submittedUnit });
          customer.address_line2 = submittedUnit;
        } catch (unitErr) {
          logger.warn(`[booking] could not persist unit for customer ${customer.id}: ${unitErr.message}`);
        }
      }
    }
    await db('notification_prefs')
      .insert({ customer_id: custId })
      .onConflict('customer_id')
      .ignore();

    // A unit submitted on a no-backfill path must not vanish: the customer row
    // stays untouched, but the visit's notes and the confirmation still carry
    // the door the booker gave us. Empty when the record already has a unit,
    // when this booking just created the customer, or on a different street.
    const visitUnit = createdCustomerId ? '' : carriedVisitUnit(customer, new_customer);

	    const config = (await db('booking_config').first()) || {};
    const duration = duration_minutes || config.slot_duration_minutes || 60;

    // Compute end time if not provided
    const endMin = slot_end ? timeToMin(slot_end) : (timeToMin(slot_start) + duration);
    const endTime = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;

    const confCode = 'WPC-' + Array.from({ length: 4 }, () =>
      'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
    ).join('');

    // Resolve zone from city (best-effort, for reporting)
    const zones = await db('service_zones').select('*');
    const zone = zones.find(z => (z.cities || []).some(c =>
      c.toLowerCase() === (customer.city || '').toLowerCase()
    )) || null;

    const resolvedServiceType = cleanBookingServiceLabel(quoted_service_label)
      || cleanBookingServiceLabel(service_type)
      || estimate?.services?.[0]
      || estimate?.service_type
      || 'General Pest Control';

    // Pay-per-application (gated by bookingPayAtVisit): resolve a per-application
    // price so the booked visit + its inherited recurring follow-ups carry
    // `estimated_price` + payment_method_preference='pay_at_visit' — the same
    // fields an estimate accept sets on its recurring visits, so the existing
    // completion → invoice → /pay path bills each visit. Best-effort: an
    // unresolvable price leaves the booking price-less (today's behavior). No
    // charge or card capture happens here; billing rides completion.
    let visitPrice = null;
    let paymentPref = null;
    if (payAtVisit) {
      try {
        const { resolveBookingVisitPrice } = require('../services/booking-pay-at-visit');
        // Bind the price to the booked SERVICE: only stamp when the priced
        // estimate's recurring service is the same service that was booked, so a
        // crafted/stale payload can't pair one service's booking with another
        // service's price. service_type is client-influenced, hence the bind.
        const bookedServiceKey = RecurringAppointmentSeeder.serviceKeyFor({ service_type: resolvedServiceType });
        // Bind the pricing cadence to the ACTUAL series this route creates, NOT
        // the client's recurring_pattern: a quarterly (4-visit) pest series is
        // seeded ONLY under this exact condition (mirrors
        // shouldSeedQuarterlyPestFollowUps below); every other booking creates a
        // single visit with no recurring series → no cadence → fail closed. So a
        // crafted recurring_pattern:'monthly' can't inflate the divisor and
        // underbill — bookingVisits is 4 or nothing.
        const willSeedQuarterlyPestSeries = !isOneTimeBookingSource(source)
          && RecurringAppointmentSeeder.normalizeRecurringPattern(recurring_pattern) === 'quarterly'
          && bookedServiceKey === 'pest_control';
        const bookingVisits = willSeedQuarterlyPestSeries ? 4 : null;
        // Pay-at-visit prices from the quote→book handoff estimate
        // (pricing_estimate_id) — deliberately SEPARATE from the identity
        // `estimate_id`. A quote-wizard draft is linked to a customer by
        // UNVERIFIED phone/email, so trusting it for identity would let anyone
        // who knows a phone book + price under that customer. Identity is
        // resolved by the normal verified path above; here we price ONLY when
        // the handoff token is valid AND the handoff estimate belongs to the
        // resolved customer — so a forged/borrowed id can't price a booking from
        // someone else's quote.
        const { verifyEstimateHandoffToken } = require('../utils/estimate-handoff-token');
        // Verify the HMAC BEFORE touching the DB: pricing_estimate_id is a raw
        // public-URL value, and the token is bound to the exact id string, so a
        // forged/malformed id (which would otherwise throw a Postgres uuid cast
        // error from the lookup) fails the cheap constant-time check first and
        // never reaches a query.
        const handoffTokenValid = !!pricing_estimate_id
          && verifyEstimateHandoffToken(pricing_estimate_id, estimate_token);
        const pricingEstimate = handoffTokenValid
          ? await db('estimates').where('id', pricing_estimate_id).first()
          : null;
        // Re-check the CURRENT estimate is still handoff-eligible: a wizard draft
        // is refreshed IN PLACE on re-runs, so a token minted while the quote was
        // residential/recurring must not price a snapshot that has since become
        // commercial or manual-quote (both excluded from the exposure gate).
        // status must still be 'draft': tokens are minted only for refreshable
        // wizard drafts, so once staff promote the same estimate (sent/accepted/
        // declined) a not-yet-expired token must not stamp pricing from a quote
        // that is no longer the live self-serve draft.
        const pricingEstData = pricingEstimate?.estimate_data || {};
        const pricingEstimateEligible = !!pricingEstimate
          && pricingEstimate.source === 'quote_wizard'
          && pricingEstimate.status === 'draft'
          && !pricingEstData.commercialEstimatedPricing
          && !pricingEstData.quoteRequired;
        const pricingTrusted = handoffTokenValid
          && pricingEstimateEligible
          && String(pricingEstimate.customer_id) === String(custId);
        // The verified LINKED-estimate path (/book/:estimateToken posts
        // estimate_id) still prices as it did before the handoff landed: that
        // estimate resolved identity above (non-quote_wizard only), so pricing
        // it is the same trust — customer-matched so a crafted estimate_id +
        // customer_id pair can't stamp another customer's price.
        const linkedEstimatePriceable = !!estimate
          && estimate.source !== 'quote_wizard'
          && String(estimate.customer_id) === String(custId);
        const priced = pricingTrusted
          ? resolveBookingVisitPrice({ estimate: pricingEstimate, serviceKey: bookedServiceKey, bookingVisits })
          : (linkedEstimatePriceable
            ? resolveBookingVisitPrice({ estimate, serviceKey: bookedServiceKey, bookingVisits })
            : null);
        if (priced) {
          visitPrice = priced.amount;
          paymentPref = 'pay_at_visit';
        }
      } catch (err) {
        logger.warn(`[booking:confirm] pay-at-visit price resolution failed for customer=${custId}: ${err.message}`);
      }
    }

    // Conflict re-check + both inserts ride one transaction, serialized per
    // customer+day: a double-submit (button double-tap, client retry)
    // otherwise mints two parents — and two seeded quarterly series — and a
    // partial failure could leave a booking without its dispatch row.
    let txResult;
    try {
      txResult = await db.transaction(async (trx) => {
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['self-booking-confirm', `${custId}:${slotDateStr}`],
      );
      // The customer-keyed lock above only serializes a double-submit —
      // two DIFFERENT customers confirming the same slot can still both
      // pass the overlap check under READ COMMITTED. Tech bookings take
      // BOTH locks: tech:date serializes against slot-reservation and
      // rebooker, zone:date serializes against the zone-capacity writers
      // (availability.confirmBooking and no-tech confirms here). Lock
      // order is fixed (tech first) so concurrent confirms can't
      // deadlock.
      const zoneSlug = zone?.zone_name?.split('/')[0]?.trim()?.toLowerCase() || null;
      if (technician_id) {
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['slot-reserve', `${technician_id}:${slotDateStr}`],
        );
      }
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['slot-reserve', `zone:${zone?.id || 'unknown'}:${slotDateStr}`],
      );

      // Idempotent replay: same customer, same day, same start time →
      // return the original booking instead of creating a duplicate.
      const existing = await trx('self_booked_appointments')
        .where({ customer_id: custId, date: slotDateStr, start_time: slot_start })
        .whereNot('status', 'cancelled')
        .first();
      if (existing) return { existing };

      // Re-verify the slot is still available (race condition guard).
      // Tech bookings conflict against the tech's route; no-tech bookings
      // conflict against other unassigned jobs in the same zone (the
      // capacity model the availability engine offers slots from).
      // Expired estimate-slot holds don't count (same predicate as
      // slot-reservation.js).
      const zoneCities = zone?.cities || [];
      const conflictQuery = trx('scheduled_services')
        .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
        .where('scheduled_services.scheduled_date', slotDateStr)
        .whereNotIn('scheduled_services.status', ['cancelled'])
        .where((q) => {
          q.whereNull('scheduled_services.reservation_expires_at')
            .orWhereRaw('scheduled_services.reservation_expires_at > NOW()');
        })
        // COALESCE the nullable window_end (admin edits can leave a start
        // with no end) — same predicate as slot-reservation/rebooker.
        .whereRaw(
          "scheduled_services.window_start < ?::time AND COALESCE(scheduled_services.window_end, scheduled_services.window_start + ((COALESCE(NULLIF(scheduled_services.estimated_duration_minutes, 0), 60)::text || ' minutes')::interval)) > ?::time",
          [endTime, slot_start],
        );
      // One capacity predicate for both branches: the tech's own route,
      // PLUS all zone jobs (assigned or not — availability builds slots
      // from the whole zone, so an unassigned zone booking occupies the
      // slot even for a tech-backed confirm), PLUS live estimate-slot
      // holds (customer_id NULL, no zone — a 15-minute county-wide hold
      // briefly blocking a slot beats double-booking over it).
      conflictQuery.where((q) => {
        if (technician_id) q.orWhere('scheduled_services.technician_id', technician_id);
        if (zoneSlug) q.orWhere('scheduled_services.zone', zoneSlug);
        if (zoneCities.length) q.orWhereIn('customers.city', zoneCities);
        q.orWhere((hold) => {
          hold.whereNull('scheduled_services.customer_id')
            .whereRaw('scheduled_services.reservation_expires_at > NOW()');
        });
      });
      const conflict = await conflictQuery.first('scheduled_services.id');
      if (conflict) {
        throw Object.assign(new Error('That time slot was just taken. Please pick another.'), {
          statusCode: 409,
          isOperational: true,
          code: 'SLOT_TAKEN',
        });
      }

      const [bookingRow] = await trx('self_booked_appointments').insert({
        customer_id: custId,
        estimate_id: estimate_id || null,
        technician_id: technician_id || null,
        service_zone_id: zone?.id || null,
        date: slotDateStr,
        start_time: slot_start,
        end_time: endTime,
        duration_minutes: duration,
        customer_notes: customer_notes || null,
        confirmation_code: confCode,
        source: source || 'direct',
        referrer_url: referrer_url || null,
        service_type: resolvedServiceType,
      }).returning('*');

      const [scheduledRow] = await trx('scheduled_services').insert({
        customer_id: custId,
        technician_id: technician_id || null,
        scheduled_date: slotDateStr,
        window_start: slot_start,
        window_end: endTime,
        service_type: resolvedServiceType,
        status: 'confirmed',
        customer_confirmed: true,
        confirmed_at: new Date(),
        notes: [
          customer_notes ? `Self-booked. Notes: ${customer_notes}` : 'Self-booked via portal',
          // Dispatch/tech surfaces render the address from the customer row,
          // which has no unit on no-backfill paths — the note is the carrier.
          visitUnit ? `Unit: ${visitUnit}` : null,
        ].filter(Boolean).join(' — '),
        source: source || 'self_booked',
        self_booking_id: bookingRow.id,
        estimated_duration_minutes: duration,
        zone: zone?.zone_name?.split('/')[0]?.trim()?.toLowerCase() || null,
        // Pay-per-application (gated): price the visit and mark the billing
        // preference. Null when the gate is off or no price resolved →
        // unchanged, price-less behavior. Inherited by seeded recurring
        // follow-ups (recurring-appointment-seeder).
        estimated_price: visitPrice,
        payment_method_preference: paymentPref,
        // Self-booked customers have no WaveGuard tier, so completion auto-invoice
        // (shouldAutoInvoiceCompletion) would skip them even with a price. Set the
        // flag so the visit invoices on completion; the AMOUNT still comes from
        // estimated_price (projectCompletionInvoiceAmount returns it first).
        create_invoice_on_complete: paymentPref === 'pay_at_visit',
      }).returning('*');

      // Mark abandoned-booking recovery intents converted ATOMICALLY with the
      // booking (same transaction), so converted_at is visible the instant the
      // booking commits. A post-commit update would leave a window where the
      // recovery cron — having SELECTed the intent before commit — could still
      // win the claim and text "your spot isn't reserved yet" to someone who
      // just booked.
      const bookedTen = String(customer.phone || '').replace(/\D/g, '').slice(-10);
      if (bookedTen.length === 10) {
        await trx('booking_intents')
          .whereNull('converted_at')
          .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [bookedTen])
          .update({ converted_at: trx.fn.now(), converted_booking_id: bookingRow.id, updated_at: trx.fn.now() });
      }

      return { booking: bookingRow, serviceRow: scheduledRow };
      });
    } catch (txErr) {
      // Expected race outcome — answer directly rather than throwing into
      // the global error middleware, which logs req.body (new_customer
      // phone/email/address would land in the logs).
      if (txErr.code === 'SLOT_TAKEN') {
        // Undo a profile this request just created: leaving it would make
        // the customer's retry with a different slot hit the
        // phone-already-on-file 409 and strand them entirely. The row is
        // seconds old with no children beyond its prefs row.
        if (createdCustomerId) {
          await db('notification_prefs').where({ customer_id: createdCustomerId }).del().catch(() => {});
          await db('customers').where({ id: createdCustomerId }).del().catch((delErr) => {
            logger.warn(`[booking:confirm] Could not roll back just-created customer ${createdCustomerId}: ${delErr.message}`);
          });
        }
        return { ok: false, status: 409, error: txErr.message };
      }
      throw txErr;
    }

    // New bookings mark their recovery intents converted INSIDE the transaction
    // above (atomic, race-free). This post-commit helper now only covers the
    // double-submit REPLAY path — the existing booking committed in an earlier
    // request, so a best-effort re-mark here closes out any intent captured since.
    const markBookingIntentsConverted = async (bookingId) => {
      try {
        const ten = String(customer.phone || '').replace(/\D/g, '').slice(-10);
        if (ten.length !== 10) return;
        await db('booking_intents')
          .whereNull('converted_at')
          .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten])
          .update({ converted_at: db.fn.now(), converted_booking_id: bookingId, updated_at: db.fn.now() });
      } catch (err) {
        logger.warn(`[booking:confirm] booking-intent conversion mark failed for customer=${custId}: ${err.message}`);
      }
    };

    if (txResult.existing) {
      await markBookingIntentsConverted(txResult.existing.id);
      logger.info(`[booking:confirm] Double-submit replay for customer ${custId} on ${slotDateStr} ${slot_start} — returning existing booking ${txResult.existing.id}`);
      return { ok: true, body: {
        booking: txResult.existing,
        confirmationCode: txResult.existing.confirmation_code,
        replayed: true,
      } };
    }

    const { booking, serviceRow } = txResult;
    // (new-booking intents already converted in the transaction above)

    // Appointment-type automations (tagging, prep guide emails) — same hook
    // the admin scheduling path runs. Post-commit and fire-and-forget so the
    // booking response never waits on it.
    {
      const AppointmentTagger = require('../services/appointment-tagger');
      void AppointmentTagger.onServiceScheduled(serviceRow.id)
        .catch((e) => logger.error(`[booking:confirm] appointment automations failed (non-blocking) for ${serviceRow.id}: ${e.message}`));
    }

    const requestedRecurringPattern = RecurringAppointmentSeeder.normalizeRecurringPattern(recurring_pattern);
    const isOneTimeEstimateBooking = isOneTimeBookingSource(source);
    let followUpRows = [];

    // Public self-booking books only the single requested visit. It does NOT create a
    // recurring WaveGuard series or activate a plan (owner policy: a WaveGuard plan is
    // set up explicitly via admin/estimate/payment, not from a public booking — so we
    // never seed future visits that would have no plan and no per-visit price to bill).
    // The quarterly-pest follow-up seeder below is the pre-existing exception and runs
    // independently of WaveGuard plan state.
    const shouldSeedQuarterlyPestFollowUps =
      !isOneTimeEstimateBooking
      && requestedRecurringPattern === 'quarterly'
      && RecurringAppointmentSeeder.serviceKeyFor({ service_type: resolvedServiceType }) === 'pest_control';
    if (shouldSeedQuarterlyPestFollowUps) {
      try {
        const seedResult = await RecurringAppointmentSeeder.seedFollowUpsForParent(db, serviceRow, {
          pattern: 'quarterly',
          plannedCount: 4,
          skipWeekends: true,
          weekendShift: 'forward',
          durationMinutes: duration,
          source: source || 'self_booked',
        });
        followUpRows = seedResult.insertedRows || [];
      } catch (err) {
        logger.error(`[booking:confirm] Quarterly follow-up seeding failed for ${serviceRow.id}: ${err.message}`);
      }
    }

    // Dispatch-v2 reads scheduled_services directly; no legacy dispatch sync.

    // Declared at function scope so BOTH the reminder-registration block and the
    // SMS block (deliverConfirmationByChannel) below can see it. It was previously
    // declared inside the reminder try, so the sibling SMS block threw a swallowed
    // ReferenceError — silently skipping the customer confirmation and owner alert.
    // Best-effort require: the booking + scheduled_services are ALREADY committed
    // above, so a module-load failure here must not 500 a successful booking (the
    // global error middleware would also log req.body with booking PII). Both
    // usages below are inside try/catch, so a null AppointmentReminders is safe.
    let AppointmentReminders = null;
    try {
      AppointmentReminders = require('../services/appointment-reminders');
    } catch (err) {
      logger.error(`[booking:confirm] appointment-reminders module load failed (booking already committed; continuing best-effort): ${err.message}`);
    }

    try {
      for (const row of [serviceRow, ...followUpRows].filter(r => r?.id)) {
        const scheduledDate = row.id === serviceRow.id
          ? slotDateStr
          : (typeof row.scheduled_date === 'string'
              ? row.scheduled_date.slice(0, 10)
              : row.scheduled_date instanceof Date
                ? row.scheduled_date.toISOString().slice(0, 10)
                : String(row.scheduled_date || '').slice(0, 10));
        const windowStart = String(row.window_start || slot_start || '08:00').slice(0, 5);
        await AppointmentReminders.registerAppointment(
          row.id,
          custId,
          `${scheduledDate}T${windowStart}`,
          row.service_type || resolvedServiceType,
          row.id === serviceRow.id ? 'booking_new' : 'booking_followup',
          { sendConfirmation: false },
        );
      }
    } catch (err) {
      logger.error(`[booking:confirm] Appointment reminder registration failed for ${serviceRow.id}: ${err.message}`);
    }

    // SMS notifications (best-effort)
    try {
      const dateLabel = new Date(slotDateStr + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York',
      });
      const startLabel = minToTime12(timeToMin(slot_start));
      const endLabel = minToTime12(endMin);
      const timeLabel = `${startLabel} - ${endLabel}`;
      // line1 is street-only once units live in address_line2 — the
      // confirmation must still show the apartment the visit is booked for,
      // including a unit that only rides on this visit (no-backfill paths).
      const addressLabel = `${[customer.address_line1, customer.address_line2 || visitUnit].filter(Boolean).join(', ')}, ${customer.city}`;
      const smsBody = await renderSmsTemplate(
        'self_booking_confirmation',
        {
          first_name: customer.first_name || 'there',
          date: dateLabel,
          time: timeLabel,
          address: addressLabel,
          confirmation_code: confCode,
        },
        { workflow: 'self_booking_confirmation', entity_type: 'scheduled_service', entity_id: serviceRow.id }
      );
      if (!smsBody) {
        logger.warn(`[booking:confirm] self_booking_confirmation template missing/disabled — skipping SMS for customer ${custId}`);
      }

      // Honor the customer's account-level New Appointment Confirmation channel
      // (sms | email | both). Default 'sms' keeps the exact prior send.
      await AppointmentReminders.deliverConfirmationByChannel({
        customerId: custId,
        scheduledServiceId: serviceRow?.id,
        serviceLabel: resolvedServiceType,
        smsAttempt: async () => {
          if (!smsBody) return false;
          const customerSms = await sendCustomerMessage({
            to: customer.phone,
            body: smsBody,
            channel: 'sms',
            audience: 'customer',
            purpose: 'appointment_confirmation',
            customerId: custId,
            appointmentId: serviceRow?.id,
            identityTrustLevel: 'phone_matches_customer',
            metadata: { original_message_type: 'booking_confirmation', source: source || 'portal' },
          });
          if (customerSms && !customerSms.sent) {
            logger.warn(`[booking:confirm] Customer SMS blocked/failed for customer ${custId}: ${customerSms.code || customerSms.reason || 'unknown'}`);
          }
          return !!customerSms?.sent;
        },
      });

      if (process.env.ADAM_PHONE) {
        await TwilioService.sendSMS(process.env.ADAM_PHONE,
          `📱 New self-booked appointment:\n${customer.first_name} ${customer.last_name}\n${resolvedServiceType}\n${dateLabel} ${startLabel}\n${customer.city}\nSource: ${source || 'portal'}\nCode: ${confCode}`,
          { messageType: 'internal_alert' }
        );
      }
    } catch (err) {
      logger.error(`[booking:confirm] SMS failed: ${err.message}`);
    }

    // A self-booked recurring series (quarterly pest follow-ups seeded above) is
    // the deal closing — convert the originating lead to won now rather than
    // waiting for the first visit to complete. enforceOriginating keeps the fuzzy
    // contact fallback from winning a later unlinked add-on lead sharing the
    // customer's phone/email; only a lead first contacted on/before the customer
    // signed up converts. Single unambiguous open lead only, idempotent.
    // Also convert when the booking is deep-linked from an accepted estimate
    // (?lead= present) — this covers one-time estimate-accepts that seed no
    // recurring series. `lead_id` is only a trigger flag; the conversion is
    // keyed off the VERIFIED customer, so the forgeable lead_id can never
    // convert a lead the booker doesn't own.
    if (followUpRows.length > 0 || lead_id) {
      try {
        const { convertLeadFromEvent } = require('../services/lead-estimate-link');
        await convertLeadFromEvent({
          source: followUpRows.length > 0 ? 'recurring_service_booked' : 'self_booking_estimate',
          customerId: custId,
          enforceOriginating: true,
        });
      } catch (err) {
        logger.warn(`[lead-trigger] self-booking conversion failed for customer=${custId}: ${err.message}`);
      }
    }

    // Persist an ad-tracked self-booking's click id onto a won lead so the
    // offline-conversion pipeline (data-manager qualified_lead / Meta CAPI) can
    // report it to Google/Meta by deterministic click id, not just hashed PII.
    // A cold ad click that books straight from the funnel has no lead otherwise,
    // so it would be invisible to ad optimization. Best-effort (booking is
    // already committed); only mints for ad-tracked bookers with no lead on file.
    try {
      const { attributeSelfBooking } = require('../services/lead-estimate-link');
      await attributeSelfBooking({
        customerId: custId,
        attribution,
        serviceInterest: resolvedServiceType,
        // Only a customer this booking just created is a fresh paid acquisition;
        // a resolved existing customer is a repeat booker, not a new lead.
        customerCreated: !!createdCustomerId,
      });
    } catch (err) {
      logger.warn(`[booking:confirm] self-booking attribution failed for customer=${custId}: ${err.message}`);
    }

    return { ok: true, body: { booking, confirmationCode: confCode } };
}

// POST /api/booking/confirm — thin HTTP adapter over createSelfBooking. The
// selfBooking gate lives here (a caller concern); the service is gate-agnostic.
router.post('/confirm', async (req, res, next) => {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('selfBooking')) {
      return res.status(503).json({ error: 'Self-scheduling coming soon' });
    }
    const result = await createSelfBooking({
      ...req.body,
      referrer_url: req.body?.referrer_url || req.get('referer') || null,
      // Server-resolved gate — set AFTER the spread so a client can't forge it.
      payAtVisit: isEnabled('bookingPayAtVisit'),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json(result.body);
  } catch (err) {
    logger.error('[booking:confirm] failed:', err);
    next(err);
  }
});

// Tight per-IP limiter: an intent row becomes send-eligible (the recovery cron
// treats it as transactional consent), so the public endpoint must not be usable
// to seed bulk outbound sends to arbitrary recipients.
// Two per-IP layers — a real funnel only captures a handful of times per session,
// so these are generous for genuine use but bound bulk abuse (the rows become
// send-eligible). A short burst cap + an hourly ceiling. (Full recipient-binding
// would need a Turnstile/OTP challenge — a deferred product decision.)
const captureIntentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, skipped: 'rate_limited' },
});
const captureIntentHourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, skipped: 'rate_limited' },
});

// Estimate-originated booking-link sources NOT covered by isOneTimeBookingSource
// that the recovery lane must still skip (one-time semantics; handled by the
// estimate follow-up lane). admin-manual-booking-resend = admin estimate resend.
const RECOVERY_SKIP_SOURCES = new Set(['admin-manual-booking-resend']);

// POST /api/booking/capture-intent — partial capture of a high-intent /book
// visitor (entered contact + picked a slot, hasn't confirmed yet) so the
// abandoned-booking recovery cron can follow up if they never finish. One OPEN
// intent per phone (refreshed, not duplicated); booked phones are skipped.
// Fire-and-forget: never returns a funnel-blocking error.
router.post('/capture-intent', captureIntentLimiter, captureIntentHourlyLimiter, async (req, res) => {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('selfBooking')) return res.json({ ok: false, skipped: 'gate' });

    const b = req.body || {};

    // Proof the caller went through the real booking funnel: a token minted in the
    // availability response (the funnel always fetches availability before the
    // contact step), bound to the requesting IP. Without it this public,
    // send-eligible endpoint could be used to seed recovery SMS/email to arbitrary
    // recipients. Fail closed — no/invalid token, no send-eligible row.
    if (!verifyCaptureToken(b.capture_token, captureIpKey(req))) {
      return res.json({ ok: true, skipped: 'unverified' });
    }

    // One-time / estimate-originated booking links are recovered by the estimate
    // deposit-abandonment lane (services/estimate-follow-up.js), not here —
    // capturing them would double-nudge AND a recovery link carrying source
    // 'booking_recovery' would drop the one-time semantics, letting
    // createSelfBooking seed a recurring series for a one-off visit. Skips the
    // shared one-time sources PLUS the admin one-time estimate-resend link, which
    // isn't in that helper (this is a recovery-lane guard only — it does not
    // change createSelfBooking's recurring decision for those sources).
    if (isOneTimeBookingSource(b.source) || RECOVERY_SKIP_SOURCES.has(String(b.source || '').trim())) {
      return res.json({ ok: true, skipped: 'estimate_source' });
    }

    const nc = b.new_customer || b;
    const phoneDigits = String(nc.phone || b.phone || '').replace(/\D/g, '');
    if (phoneDigits.length < 10) return res.status(400).json({ error: 'valid phone required' });
    const ten = phoneDigits.slice(-10);

    const str = (v, n) => { const s = (v == null ? '' : String(v)).trim(); return s ? s.slice(0, n) : null; };
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const sessionId = str(b.session_id, 80);
    // Client capture time — used to reject a stale (out-of-order / slow keepalive)
    // capture from overwriting a newer one for the same session.
    const clientTs = Number.isFinite(Number(b.capture_client_ts)) ? Math.floor(Number(b.capture_client_ts)) : null;
    // Quote→book handoff: persist the pricing estimate reference so the recovery
    // /book link re-carries it and a recovered booking still prices from that
    // exact quote (pay-at-visit). VERIFY the HMAC before storing — this is a
    // public endpoint and recovery re-sends whatever is stored here, so never
    // persist an id the caller couldn't prove was minted by us. Absent or
    // unverified → nulls, so a fresh capture without the params clears a stale
    // handoff instead of letting it ride along with a newer non-quote intent.
    const { verifyEstimateHandoffToken: verifyHandoff } = require('../utils/estimate-handoff-token');
    const handoffId = str(b.pricing_estimate_id, 80);
    const handoffToken = str(b.estimate_token, 200);
    const handoffVerified = !!(handoffId && handoffToken && verifyHandoff(handoffId, handoffToken));
    const row = {
      pricing_estimate_id: handoffVerified ? handoffId : null,
      pricing_estimate_token: handoffVerified ? handoffToken : null,
      session_id: sessionId,
      capture_client_ts: clientTs,
      phone: phoneDigits,
      first_name: str(nc.first_name, 120),
      last_name: str(nc.last_name, 120),
      email: str(nc.email, 200),
      // booking_intents has no unit column — keep the unit inline so the
      // recovery link/prefill still carries it.
      address_line1: str(
        [nc.address_line1, normalizeUnitLine(nc.address_line2)].filter(Boolean).join(', ') || b.address,
        250
      ),
      city: str(nc.city, 120),
      state: str(nc.state, 40),
      zip: str(nc.zip, 20),
      lat: num(nc.lat),
      lng: num(nc.lng),
      service_type: cleanBookingServiceLabel(b.quoted_service_label) || cleanBookingServiceLabel(b.service_type) || str(b.service_type, 120),
      service_id: str(b.service_id, 60),
      slot_date: b.slot_date ? String(b.slot_date).split('T')[0].slice(0, 10) : null,
      slot_start: str(b.slot_start, 10),
      slot_end: str(b.slot_end, 10),
      source: str(b.source, 60),
      attribution: b.attribution ? JSON.stringify(b.attribution) : null,
      last_activity_at: db.fn.now(),
      updated_at: db.fn.now(),
    };

    const tenMatch = (q) => q.whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten]);

    // Already booked → nothing to recover. Check BOTH a recently-converted intent
    // AND a recent self_booked_appointment for the phone: a fire-and-forget
    // capture fired on the Confirm click can land AFTER /booking/confirm committed
    // and marked intents converted, so a phone with a fresh booking but no prior
    // intent would otherwise mint a new open row and get a "spot isn't reserved
    // yet" nudge for a booking that already succeeded.
    const booked = await tenMatch(db('booking_intents').whereNotNull('converted_at')
      .where('converted_at', '>', new Date(Date.now() - 24 * 3600000))).first('id');
    if (booked) return res.json({ ok: true, skipped: 'already_booked' });
    const recentBooking = await db('self_booked_appointments as sba')
      .leftJoin('customers as c', 'sba.customer_id', 'c.id')
      .whereRaw("RIGHT(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten])
      .where('sba.created_at', '>', new Date(Date.now() - 6 * 3600000))
      .whereNot('sba.status', 'cancelled')
      .first('sba.id');
    if (recentBooking) return res.json({ ok: true, skipped: 'already_booked' });

    // Revalidate the SUBMITTED booking context server-side. The IP-bound token
    // proves the caller fetched availability, but not for THIS slot — so confirm
    // the posted slot is a real, currently-offered opening for the resolved coords
    // before making the row send-eligible. Combined with the token + per-IP
    // limiter, this stops a single availability fetch from seeding recovery sends
    // to arbitrary phones without a genuine bookable slot. Fail closed.
    try {
      const { lat, lng } = await resolveBookingCoords({ lat: row.lat, lng: row.lng, address: row.address_line1, city: row.city });
      if (!lat || !lng || !row.slot_date || !row.slot_start) {
        return res.json({ ok: true, skipped: 'unverified_slot' });
      }
      const cfg = (await db('booking_config').first()) || {};
      const avail = await buildBookingAvailability({
        lat, lng,
        duration: cfg.slot_duration_minutes || 60,
        rangeFrom: row.slot_date, rangeTo: row.slot_date,
        config: cfg, today: new Date(), expandOpenDays: true,
      });
      const day = (avail.days || []).find((d) => String(d.date).slice(0, 10) === row.slot_date);
      const offered = !!day && Array.isArray(day.slots)
        && day.slots.some((s) => String(s.start_time).slice(0, 5) === String(row.slot_start).slice(0, 5));
      if (!offered) return res.json({ ok: true, skipped: 'slot_unavailable' });
      row.lat = lat;
      row.lng = lng;
    } catch (e) {
      logger.warn(`[booking:capture-intent] slot revalidation failed: ${e.message}`);
      return res.json({ ok: false, skipped: 'unverified' });
    }

    // Resolve an existing customer by phone so a recovery send to a known customer
    // honors THEIR notification prefs (opt-out) via the customer-consent path,
    // instead of falling through to lead transactional consent (which would let an
    // opted-out customer still get the recovery SMS). Best-effort; new prospects
    // simply resolve to null.
    try {
      const { findCustomerByPhone } = require('../services/lead-from-extraction');
      const match = await findCustomerByPhone(phoneDigits);
      row.customer_id = match && match.id ? match.id : null;
    } catch (e) {
      // FAIL CLOSED on a lookup ERROR (vs a clean no-match): leaving customer_id
      // null would treat an existing OPTED-OUT customer as a lead and bypass their
      // opt-out on the recovery send. A transient blip → skip this capture.
      logger.warn(`[booking:capture-intent] customer lookup failed — skipping capture: ${e.message}`);
      return res.json({ ok: false, skipped: 'lookup_failed' });
    }

    // Refresh the existing OPEN intent, keyed by session_id when the client sends
    // one — so a corrected phone (after a mistyped first attempt) updates the SAME
    // row instead of orphaning the wrong number as its own recovery-eligible
    // intent. Fall back to the phone match for older clients with no session id.
    let open = null;
    if (sessionId) {
      open = await db('booking_intents').where({ session_id: sessionId })
        .whereNull('converted_at').where('suppressed', false)
        .orderBy('captured_at', 'desc').first('id');
    }
    if (!open) {
      open = await tenMatch(db('booking_intents').whereNull('converted_at').where('suppressed', false))
        .orderBy('captured_at', 'desc').first('id');
    }
    if (open) {
      // Guard against a stale capture overwriting corrected contact: only apply if
      // this request's client timestamp is >= the stored one (or either is absent).
      const upd = db('booking_intents').where({ id: open.id });
      if (clientTs != null) upd.where((q) => q.whereNull('capture_client_ts').orWhere('capture_client_ts', '<=', clientTs));
      const affected = await upd.update(row);
      return res.json({ ok: true, intent_id: open.id, updated: affected === 1, stale: affected === 0 });
    }
    const [created] = await db('booking_intents').insert(row).returning('id');
    return res.json({ ok: true, intent_id: created?.id || created, created: true });
  } catch (err) {
    logger.error(`[booking:capture-intent] failed: ${err.message}`);
    return res.json({ ok: false }); // fire-and-forget — never block the funnel
  }
});

// GET /api/booking/embed-snippet?source=xyz — returns copy-paste iframe HTML
router.get('/embed-snippet', (req, res) => {
  const source = (req.query.source || 'site').replace(/[^a-z0-9_-]/gi, '');
  const baseUrl = process.env.PUBLIC_URL || 'https://portal.wavespestcontrol.com';
  const iframeSrc = `${baseUrl}/book?source=${encodeURIComponent(source)}`;
  const snippet = `<!-- Waves Pest Control — Online Booking Embed -->
<iframe
  src="${iframeSrc}"
  title="Book Waves Pest Control"
  style="width:100%; min-height:760px; border:0; border-radius:12px; box-shadow:0 4px 16px rgba(0,0,0,0.08);"
  loading="lazy"
  referrerpolicy="no-referrer-when-downgrade"
  allow="clipboard-write"
></iframe>
<script>
  // Auto-resize the iframe to its content (optional)
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'waves-book-resize' && typeof e.data.height === 'number') {
      var f = document.querySelector('iframe[src*="' + ${JSON.stringify(baseUrl)} + '"]');
      if (f) f.style.height = e.data.height + 'px';
    }
  });
</script>`;
  res.json({ source, url: iframeSrc, snippet });
});

// GET /api/booking/sources — aggregate by source (for admin dashboard / intelligence bar)
router.get('/sources', async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const since = new Date();
    since.setDate(since.getDate() - parseInt(days));
    const rows = await db('self_booked_appointments')
      .where('created_at', '>=', since)
      .whereNot('status', 'cancelled')
      .select('source')
      .count('* as count')
      .groupBy('source')
      .orderBy('count', 'desc');
    res.json({ since: since.toISOString().split('T')[0], sources: rows });
  } catch (err) { next(err); }
});

// GET /api/booking/status/:code
router.get('/status/:code', async (req, res, next) => {
  try {
    const booking = await db('self_booked_appointments')
      .where('confirmation_code', req.params.code)
      .leftJoin('customers', 'self_booked_appointments.customer_id', 'customers.id')
      .select(
        'self_booked_appointments.*',
        'customers.first_name', 'customers.last_name',
        'customers.address_line1', 'customers.city'
      )
      .first();

    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json({ booking });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports._internals = {
  isOneTimeBookingSource,
  cleanBookingServiceLabel,
  addressMatchesCustomer,
  unitsConflict,
  stripInlineUnitFromLine,
  narrowCandidatesByUnit,
  submittedUnitConflictsWithCustomer,
  carriedVisitUnit,
  // Read-only engine surface reused by the voice agent's quoting tools so a
  // phoned-in availability check runs the exact same route-aware slot finder as
  // the web /book funnel (no duplicated scheduling logic).
  resolveBookingCoords,
  buildBookingAvailability,
  loadBookingConfig,
  createSelfBooking,
  MAX_BOOKING_HORIZON_DAYS,
  mintCaptureToken,
  verifyCaptureToken,
};
