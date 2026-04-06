/**
 * Unified Calendar Sync — pulls appointments from both Square Bookings API
 * and Google Calendar into the scheduled_services table.
 *
 * One button, both sources.
 */

const db = require('../models/db');
const logger = require('./logger');
const { resolveLocation } = require('../config/locations');

const GOOGLE_KEY = process.env.GOOGLE_CALENDAR_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'c_5c16252ee04075f3fa68df16b64b93a0bf260fb164a84adbbcf5203e59e57609@group.calendar.google.com';

function extractEmail(text) {
  const m = (text || '').match(/[\w.-]+@[\w.-]+\.\w+/);
  return m ? m[0] : null;
}

function extractPhone(text) {
  const m = (text || '').match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0].replace(/\D/g, '') : null;
}

function parseServiceName(description, summary) {
  const svcMatch = (description || '').match(/(?:service|type|booking)[:\s]*([^\n]+)/i);
  if (svcMatch) return svcMatch[1].trim();
  const keywords = ['pest control', 'lawn care', 'mosquito', 'termite', 'rodent', 'wdo', 'bed bug', 'roach', 'flea', 'tree', 'shrub', 'inspection'];
  const combined = `${summary} ${description}`.toLowerCase();
  for (const kw of keywords) {
    if (combined.includes(kw)) return kw.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  }
  return summary || 'Service';
}

function getZone(city) {
  const c = (city || '').toLowerCase();
  if (c.includes('parrish') || c.includes('palmetto') || c.includes('ellenton')) return 'parrish';
  if (c.includes('lakewood') || c.includes('bradenton') || c.includes('university')) return 'lakewood_ranch';
  if (c.includes('sarasota') || c.includes('siesta') || c.includes('osprey')) return 'sarasota';
  if (c.includes('venice') || c.includes('north port') || c.includes('nokomis')) return 'venice';
  return 'unknown';
}

function mapSquareStatus(s) {
  return { ACCEPTED: 'confirmed', PENDING: 'pending', DECLINED: 'cancelled', CANCELLED_BY_CUSTOMER: 'cancelled', CANCELLED_BY_SELLER: 'cancelled', NO_SHOW: 'cancelled' }[s] || 'pending';
}

async function findOrCreateCustomer({ name, phone, email, source }) {
  const cleanPhone = phone ? (phone.length === 10 ? `+1${phone}` : phone.startsWith('+') ? phone : `+1${phone.replace(/\D/g, '').slice(-10)}`) : null;

  if (cleanPhone) {
    const c = await db('customers').where({ phone: cleanPhone }).first();
    if (c) return c.id;
  }
  if (email) {
    const c = await db('customers').where({ email }).first();
    if (c) return c.id;
  }

  if (!name || name === 'Walk-in') return null;

  const parts = name.split(' ');
  const firstName = parts[0] || 'Unknown';
  const lastName = parts.slice(1).join(' ') || '';
  const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

  try {
    const [cust] = await db('customers').insert({
      first_name: firstName, last_name: lastName,
      phone: cleanPhone, email: email || null,
      referral_code: code, pipeline_stage: 'new_lead', pipeline_stage_changed_at: new Date(),
      lead_source: source || 'calendar', member_since: new Date().toISOString().split('T')[0],
    }).returning('*');
    logger.info(`[cal-sync] Created customer: ${firstName} ${lastName}`);
    return cust.id;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
const CalendarSync = {
  async syncAll(daysAhead = 14) {
    const results = { square: { found: 0, created: 0, updated: 0, skipped: 0, error: null }, google: { found: 0, created: 0, updated: 0, skipped: 0, error: null } };

    // ── Square Bookings ──
    try {
      const SquareService = require('./square');
      const bookings = await SquareService.getUpcomingBookings(daysAhead);
      results.square.found = bookings.length;

      for (const b of bookings) {
        try {
          const isCancelled = ['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'DECLINED', 'NO_SHOW'].includes(b.status);
          const existing = await db('scheduled_services').where({ square_booking_id: b.id }).first();

          if (existing) {
            const newStatus = isCancelled ? 'cancelled' : mapSquareStatus(b.status);
            if (existing.status !== newStatus && existing.status !== 'completed') {
              await db('scheduled_services').where({ id: existing.id }).update({ status: newStatus, updated_at: new Date() });
              results.square.updated++;
            } else { results.square.skipped++; }
            continue;
          }

          if (isCancelled) { results.square.skipped++; continue; }

          const customerId = await findOrCreateCustomer({ name: b.customerName, phone: b.customerPhone, email: b.customerEmail, source: 'square_booking' });
          if (!customerId) { results.square.skipped++; continue; }

          const start = new Date(b.startAt);
          const dateStr = start.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          const startTime = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
          const endTime = b.durationMinutes ? new Date(start.getTime() + b.durationMinutes * 60000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' }) : null;
          const customer = await db('customers').where({ id: customerId }).first();
          const hour = parseInt(startTime.split(':')[0]);

          await db('scheduled_services').insert({
            customer_id: customerId, scheduled_date: dateStr,
            window_start: startTime, window_end: endTime,
            service_type: b.serviceName || 'Service', status: mapSquareStatus(b.status),
            notes: b.note || null, square_booking_id: b.id, source: 'square',
            zone: getZone(customer?.city), time_window: hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening',
            estimated_duration_minutes: b.durationMinutes || 60,
          });
          results.square.created++;
        } catch (err) { results.square.skipped++; }
      }
    } catch (err) {
      results.square.error = err.message;
      logger.error(`[cal-sync] Square sync failed: ${err.message}`);
    }

    // ── Google Calendar ──
    try {
      if (!GOOGLE_KEY) throw new Error('GOOGLE_CALENDAR_API_KEY / GOOGLE_MAPS_API_KEY not set');

      const now = new Date();
      const past = new Date(now.getTime() - 86400000); // 1 day back
      const until = new Date(now.getTime() + daysAhead * 86400000);

      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events` +
        `?key=${GOOGLE_KEY}&timeMin=${past.toISOString()}&timeMax=${until.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=100`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`Calendar API ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const events = data.items || [];
      results.google.found = events.length;

      for (const ev of events) {
        try {
          const startRaw = ev.start?.dateTime || ev.start?.date;
          if (!startRaw) { results.google.skipped++; continue; }

          // Deduplicate by google event ID
          const gcalId = `gcal_${ev.id}`;
          const existing = await db('scheduled_services').where({ square_booking_id: gcalId }).first();
          if (existing) { results.google.skipped++; continue; }

          const email = extractEmail(ev.description);
          const phone = extractPhone(ev.description);
          const serviceName = parseServiceName(ev.description, ev.summary);

          const customerId = await findOrCreateCustomer({ name: ev.summary, phone, email, source: 'google_calendar' });
          if (!customerId) { results.google.skipped++; continue; }

          const start = new Date(startRaw);
          const endRaw = ev.end?.dateTime || ev.end?.date;
          const end = endRaw ? new Date(endRaw) : null;
          const dateStr = start.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          const startTime = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
          const endTime = end ? end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' }) : null;
          const durationMin = end ? Math.round((end - start) / 60000) : 60;
          const customer = await db('customers').where({ id: customerId }).first();
          const hour = parseInt(startTime.split(':')[0]);

          await db('scheduled_services').insert({
            customer_id: customerId, scheduled_date: dateStr,
            window_start: startTime, window_end: endTime,
            service_type: serviceName, status: 'pending',
            notes: ev.description ? ev.description.substring(0, 500) : null,
            square_booking_id: gcalId, source: 'calendar',
            zone: getZone(customer?.city || ev.location),
            time_window: hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening',
            estimated_duration_minutes: durationMin,
          });
          results.google.created++;
        } catch (err) { results.google.skipped++; }
      }
    } catch (err) {
      results.google.error = err.message;
      logger.error(`[cal-sync] Google Calendar sync failed: ${err.message}`);
    }

    logger.info(`[cal-sync] Done — Square: ${results.square.created} new / Google: ${results.google.created} new`);
    return results;
  },
};

module.exports = CalendarSync;
