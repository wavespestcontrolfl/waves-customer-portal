const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { etDateString, addETDays } = require('../utils/datetime-et');
const TwilioService = require('../services/twilio');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

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

    // Resolve coordinates
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

    if (!resolvedLat || !resolvedLng) {
      return res.status(400).json({ error: 'address, lat/lng, or city required' });
    }

    // Default date window from config — anchored to ET calendar days so the
    // window doesn't shift by a day between 8 PM ET and midnight UTC.
    const today = new Date();
    const defaultFrom = etDateString(addETDays(today, config.advance_days_min ?? 1));
    const defaultTo = etDateString(addETDays(today, config.advance_days_max ?? 14));
    const rangeFrom = date_from || defaultFrom;
    const rangeTo = date_to || defaultTo;

    const duration = duration_minutes
      ? parseInt(duration_minutes)
      : (config.slot_duration_minutes || 60);

    const result = await findAvailableSlots({
      lat: resolvedLat,
      lng: resolvedLng,
      durationMinutes: duration,
      dateFrom: rangeFrom,
      dateTo: rangeTo,
      dayStartHour: parseInt((config.day_start || '08:00').split(':')[0]),
      dayEndHour: parseInt((config.day_end || '17:00').split(':')[0]),
      topN: 200,
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
      .whereBetween('date', [
        rangeFrom,
        rangeTo,
      ])
      .select('date')
      .count('* as count')
      .groupBy('date');
    const fullDays = new Set(
      bookingCounts.filter(r => parseInt(r.count) >= maxPerDay)
        .map(r => (typeof r.date === 'string' ? r.date.split('T')[0] : r.date.toISOString().split('T')[0]))
    );

    const candidateMap = new Map();
    for (const slot of (result.slots || [])) {
      if (fullDays.has(slot.date)) continue;
      const rawStartMin = timeToMin(slot.start_time);
      // Route scoring returns minute-level travel offsets; customers should see clean booking windows.
      const startMin = cleanBookingStart(rawStartMin, slot, dayStartMin, slotGridMinutes);
      const endMin = startMin + duration;
      if (!isWholeHour(startMin)) continue;
      if (endMin > dayEndMin) continue;
      // Lunch windows are reserved for route health and should never be self-booked.
      if (startMin < lunchEnd && endMin > lunchStart) continue;
      const startTime = `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`;
      const endTime = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
      const key = `${slot.date}|${startTime}`;
      if (candidateMap.has(key)) continue;
      const labels = dateLabels(slot.date);
      candidateMap.set(key, {
        date: slot.date,
        ...labels,
        start_time: startTime,
        end_time: endTime,
        start_label: minToTime12(startMin),
        end_label: minToTime12(endMin),
        detour_minutes: slot.detour_minutes,
        reason: proximityReason(slot.detour_minutes),
        technician_id: slot.technician.id,
        rank: slot.rank,
        score: slot.score,
        startTime24: startTime,
        endTime24: endTime,
        start: minToTime12(startMin),
        end: minToTime12(endMin),
      });
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
      days.push({
        date,
        ...labels,
        slots: slots.map(s => ({
          ...s,
          is_best_fit: s === best,
        })).slice(0, 4), // max 4 slots per day
      });
    }
    days.sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      slots: curatedSlots.map(({ score, startTime24, endTime24, start, end, ...slot }) => slot),
      days,
      lat: resolvedLat,
      lng: resolvedLng,
      duration_minutes: duration,
      service_type: service_type || null,
      total_feasible: result.total_feasible || 0,
    });
  } catch (err) {
    logger.error('[booking:availability] failed:', err);
    next(err);
  }
});

// POST /api/booking/confirm
router.post('/confirm', async (req, res, next) => {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('selfBooking')) {
      return res.status(503).json({ error: 'Self-scheduling coming soon' });
    }

    const {
      estimate_id, customer_id,
      slot_date, slot_start, slot_end,
      technician_id,
      service_type,
      duration_minutes,
      customer_notes,
      source,
      referrer_url,
      new_customer,
    } = req.body;

    if (!slot_date || !slot_start) {
      return res.status(400).json({ error: 'slot_date and slot_start required' });
    }

    // Resolve customer
    let custId = null;
    let estimate = null;
    if (estimate_id) {
      estimate = await db('estimates').where('id', estimate_id).first();
      if (!custId) custId = estimate?.customer_id;
    }

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
          return res.status(409).json({ error: 'This phone number is already on file. Please verify the customer profile before booking.' });
        }
        if (String(existing.id) !== String(customer_id)) {
          return res.status(400).json({ error: 'Customer lookup mismatch' });
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
        return res.status(400).json({ error: 'Address verification required for existing customer booking' });
      }
      custId = addressVerifiedCustomer.id;
    }

    // Create customer from new_customer payload if none resolved
    if (!custId && new_customer && phoneDigits && new_customer.first_name) {
      const [created] = await db('customers').insert({
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
      }).returning('id');
      custId = created.id || created;
      await db('notification_prefs')
        .insert({ customer_id: custId })
        .onConflict('customer_id')
        .ignore();
    }

    if (!custId) return res.status(400).json({ error: 'customer_id, estimate_id, or new_customer required' });

    const customer = await db('customers').where('id', custId).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    await db('notification_prefs')
      .insert({ customer_id: custId })
      .onConflict('customer_id')
      .ignore();
	
	    const config = (await db('booking_config').first()) || {};
    const duration = duration_minutes || config.slot_duration_minutes || 60;

    // Compute end time if not provided
    const endMin = slot_end ? timeToMin(slot_end) : (timeToMin(slot_start) + duration);
    const endTime = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;

    // Re-verify the slot is still available (race condition guard)
    const conflict = await db('scheduled_services')
      .where('scheduled_date', slot_date)
      .where('technician_id', technician_id || null)
      .whereNotIn('status', ['cancelled'])
      .where(function () {
        this.where(function () {
          this.where('window_start', '<', endTime).andWhere('window_end', '>', slot_start);
        });
      })
      .first();
    if (conflict && technician_id) {
      return res.status(409).json({ error: 'That time slot was just taken. Please pick another.' });
    }

    const confCode = 'WPC-' + Array.from({ length: 4 }, () =>
      'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
    ).join('');

    // Resolve zone from city (best-effort, for reporting)
    const zones = await db('service_zones').select('*');
    const zone = zones.find(z => (z.cities || []).some(c =>
      c.toLowerCase() === (customer.city || '').toLowerCase()
    )) || null;

    const resolvedServiceType = service_type
      || estimate?.services?.[0]
      || estimate?.service_type
      || 'General Pest Control';

    const [booking] = await db('self_booked_appointments').insert({
      customer_id: custId,
      estimate_id: estimate_id || null,
      technician_id: technician_id || null,
      service_zone_id: zone?.id || null,
      date: slot_date,
      start_time: slot_start,
      end_time: endTime,
      duration_minutes: duration,
      customer_notes: customer_notes || null,
      confirmation_code: confCode,
      source: source || 'direct',
      referrer_url: referrer_url || req.get('referer') || null,
      service_type: resolvedServiceType,
    }).returning('*');

    const [serviceRow] = await db('scheduled_services').insert({
      customer_id: custId,
      technician_id: technician_id || null,
      scheduled_date: slot_date,
      window_start: slot_start,
      window_end: endTime,
      service_type: resolvedServiceType,
      status: 'confirmed',
      customer_confirmed: true,
      confirmed_at: new Date(),
      notes: customer_notes ? `Self-booked. Notes: ${customer_notes}` : 'Self-booked via portal',
      source: source || 'self_booked',
      self_booking_id: booking.id,
      estimated_duration_minutes: duration,
      zone: zone?.zone_name?.split('/')[0]?.trim()?.toLowerCase() || null,
    }).returning('*');

    // Dispatch-v2 reads scheduled_services directly; no legacy dispatch_jobs sync.

    // SMS notifications (best-effort)
    try {
      const dateLabel = new Date(slot_date + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York',
      });
      const startLabel = minToTime12(timeToMin(slot_start));
      const endLabel = minToTime12(endMin);

      const customerSms = await sendCustomerMessage({
        to: customer.phone,
        body: `Your Waves appointment is confirmed for ${dateLabel}, ${startLabel} - ${endLabel} at ${customer.address_line1}, ${customer.city}. Confirmation: ${confCode}. Reply RESCHEDULE if you need to change.`,
        channel: 'sms',
        audience: 'customer',
        purpose: 'appointment_confirmation',
        customerId: custId,
        appointmentId: serviceRow?.id,
        identityTrustLevel: 'phone_matches_customer',
        metadata: { original_message_type: 'booking_confirmation', source: source || 'portal' },
      });
      if (!customerSms.sent) {
        logger.warn(`[booking:confirm] Customer SMS blocked/failed for customer ${custId}: ${customerSms.code || customerSms.reason || 'unknown'}`);
      }

      if (process.env.ADAM_PHONE) {
        await TwilioService.sendSMS(process.env.ADAM_PHONE,
          `📱 New self-booked appointment:\n${customer.first_name} ${customer.last_name}\n${resolvedServiceType}\n${dateLabel} ${startLabel}\n${customer.city}\nSource: ${source || 'portal'}\nCode: ${confCode}`,
          { messageType: 'internal_alert' }
        );
      }
    } catch (err) {
      logger.error(`[booking:confirm] SMS failed: ${err.message}`);
    }

    res.json({ booking, confirmationCode: confCode });
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
