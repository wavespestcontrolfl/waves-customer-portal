const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { etDateString, addETDays, etParts } = require('../utils/datetime-et');
const TwilioService = require('../services/twilio');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { applyContactNormalization } = require('../utils/intake-normalize');
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

function addressMatchesCustomer(customer, address, zip) {
  const lookupAddress = normalizeAddress(address);
  const customerAddress = normalizeAddress(customer?.address_line1);
  if (!lookupAddress || !customerAddress || lookupAddress !== customerAddress) return false;
  const lookupZip = normalizeZip(zip);
  const customerZip = normalizeZip(customer?.zip);
  return !lookupZip || !customerZip || lookupZip === customerZip;
}

async function findUniqueCustomerByAddress(address, city, zip) {
  const normalizedAddress = normalizeAddress(address);
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
    .select('id', 'first_name', 'last_name', 'email', 'address_line1', 'city', 'state', 'zip', 'phone')
    .limit(1000);

  const matches = candidates.filter(customer => normalizeAddress(customer.address_line1) === normalizedAddress);
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
    const { phone, address, city, zip } = req.query;
    const customerFields = ['id', 'first_name', 'last_name', 'email', 'address_line1', 'city', 'state', 'zip'];
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
      if (customer && address && !addressMatchesCustomer(customer, address, zip)) {
        customer = null;
      }
      return res.json({ customer: customer || null });
    }

    if (address) {
      customer = await findUniqueCustomerByAddress(address, city, zip);
      if (customer) {
        return res.json({
          customer: {
            id: customer.id,
            first_name: customer.first_name,
            last_name: customer.last_name,
            address_line1: customer.address_line1,
            city: customer.city,
            state: customer.state,
            zip: customer.zip,
          },
          possible_match: true,
        });
      }
      return res.json({ customer: null, possible_match: false });
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
async function buildBookingAvailability({ lat, lng, duration, rangeFrom, rangeTo, config, today, timeOfDay = 'any', expandOpenDays = false }) {
  const result = await findAvailableSlots({
    lat,
    lng,
    durationMinutes: duration,
    dateFrom: rangeFrom,
    dateTo: rangeTo,
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
      estimate_id, customer_id, lead_id,
      slot_date, slot_start, slot_end,
      technician_id,
      service_type,
      quoted_service_label,
      duration_minutes,
      recurring_pattern,
      customer_notes,
      source,
      referrer_url,
      new_customer,
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

    // Resolve customer
    let custId = null;
    let estimate = null;
    if (estimate_id) {
      estimate = await db('estimates').where('id', estimate_id).first();
      if (!custId) custId = estimate?.customer_id;
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
        || !addressMatchesCustomer(addressVerifiedCustomer, new_customer.address_line1, new_customer.zip)
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
        address_line1: new_customer.address_line1 || null,
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
    await db('notification_prefs')
      .insert({ customer_id: custId })
      .onConflict('customer_id')
      .ignore();
	
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
        notes: customer_notes ? `Self-booked. Notes: ${customer_notes}` : 'Self-booked via portal',
        source: source || 'self_booked',
        self_booking_id: bookingRow.id,
        estimated_duration_minutes: duration,
        zone: zone?.zone_name?.split('/')[0]?.trim()?.toLowerCase() || null,
      }).returning('*');

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

    if (txResult.existing) {
      logger.info(`[booking:confirm] Double-submit replay for customer ${custId} on ${slotDateStr} ${slot_start} — returning existing booking ${txResult.existing.id}`);
      return { ok: true, body: {
        booking: txResult.existing,
        confirmationCode: txResult.existing.confirmation_code,
        replayed: true,
      } };
    }

    const { booking, serviceRow } = txResult;

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

    try {
      const AppointmentReminders = require('../services/appointment-reminders');
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
      const addressLabel = `${customer.address_line1}, ${customer.city}`;
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
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json(result.body);
  } catch (err) {
    logger.error('[booking:confirm] failed:', err);
    next(err);
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
  // Read-only engine surface reused by the voice agent's quoting tools so a
  // phoned-in availability check runs the exact same route-aware slot finder as
  // the web /book funnel (no duplicated scheduling logic).
  resolveBookingCoords,
  buildBookingAvailability,
  loadBookingConfig,
  createSelfBooking,
  MAX_BOOKING_HORIZON_DAYS,
};
