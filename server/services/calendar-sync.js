/**
 * Unified Calendar Sync — pulls appointments from Google Calendar into
 * the scheduled_services table.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

const GOOGLE_KEY = process.env.GOOGLE_CALENDAR_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
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
      lead_source: source || 'calendar', member_since: etDateString(),
    }).returning('*');
    logger.info(`[cal-sync] Created customer: ${firstName} ${lastName}`);
    return cust.id;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
const CalendarSync = {
  async syncAll(daysAhead = 14) {
    const results = { google: { found: 0, created: 0, updated: 0, skipped: 0, error: null } };

    try {
      if (!GOOGLE_KEY) throw new Error('Set GOOGLE_API_KEY or GOOGLE_CALENDAR_API_KEY in Railway env vars');

      const now = new Date();
      const past = new Date(now.getTime() - 86400000); // 1 day back
      const until = new Date(now.getTime() + daysAhead * 86400000);

      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events` +
        `?key=${GOOGLE_KEY}&timeMin=${past.toISOString()}&timeMax=${until.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=100`;

      const res = await fetch(url);
      if (!res.ok) {
        const hint = res.status === 403
          ? 'Calendar must be shared publicly: Google Calendar → Settings → calendar → Access permissions → Make available to public'
          : res.status === 404 ? 'Calendar ID not found — check GOOGLE_CALENDAR_ID'
          : '';
        throw new Error(`Calendar API ${res.status}${hint ? '. ' + hint : ''}`);
      }
      const data = await res.json();
      const events = data.items || [];
      results.google.found = events.length;

      for (const ev of events) {
        try {
          const startRaw = ev.start?.dateTime || ev.start?.date;
          if (!startRaw) { results.google.skipped++; continue; }

          // Deduplicate by google event ID (stored in legacy square_booking_id column)
          const gcalId = `gcal_${ev.id}`;
          try {
            const existing = await db('scheduled_services').where({ square_booking_id: gcalId }).first();
            if (existing) { results.google.skipped++; continue; }
          } catch { /* column may not exist yet — skip dedup */ }

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

          const ins = {
            customer_id: customerId, scheduled_date: dateStr,
            window_start: startTime, window_end: endTime,
            service_type: serviceName, status: 'pending',
            notes: ev.description ? ev.description.substring(0, 500) : null,
          };
          try {
            await db('scheduled_services').insert({ ...ins, square_booking_id: gcalId, source: 'calendar', zone: getZone(customer?.city || ev.location), time_window: hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening', estimated_duration_minutes: durationMin });
          } catch {
            await db('scheduled_services').insert(ins);
          }
          results.google.created++;
        } catch (err) {
          logger.error(`[cal-sync] Google event insert failed: ${err.message}`);
          results.google.skipped++;
        }
      }
    } catch (err) {
      results.google.error = err.message;
      logger.error(`[cal-sync] Google Calendar sync failed: ${err.message}`);
    }

    logger.info(`[cal-sync] Done — Google: ${results.google.created} new`);
    return results;
  },
};

module.exports = CalendarSync;
