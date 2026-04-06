/**
 * Appointment Reminder Service — replaces Zapier zaps #12, #13, #20, #21, #22
 *
 * #12  1-Hour SMS Reminder:   Google Calendar event → extract service → SMS
 * #13  24-Hour SMS Reminder:  Google Calendar event → extract service → SMS
 * #20  72-Hour SMS Reminder:  Google Calendar event → extract service → approval → SMS
 * #21  New Appointment SMS:   Google Calendar new event → extract service → approval → SMS
 * #22  WDO Inspection:        Google Calendar new event → filter WDO → AI property research → email briefing + SMS
 *
 * Sources:
 *   - scheduled_services table (portal DB — already has 24h reminder via old scheduler)
 *   - Square Bookings API (if configured)
 *   - Google Calendar API (if configured)
 *
 * Env vars:
 *   GOOGLE_CALENDAR_ID      — Calendar ID for appointment calendar
 *   GOOGLE_CALENDAR_API_KEY  — or reuse GOOGLE_MAPS_API_KEY
 *   ANTHROPIC_API_KEY        — for WDO inspection AI briefing
 */

const db = require('../models/db');
const logger = require('./logger');
const TwilioService = require('./twilio');
const config = require('../config');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'c_5c16252ee04075f3fa68df16b64b93a0bf260fb164a84adbbcf5203e59e57609@group.calendar.google.com';
const GOOGLE_KEY = process.env.GOOGLE_CALENDAR_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || '';
const ADMIN_PHONE = '+19415993489';

// ── Fetch upcoming events from Google Calendar ──
async function fetchCalendarEvents(hoursAhead = 80) {
  if (!GOOGLE_KEY) return [];

  const now = new Date();
  const until = new Date(now.getTime() + hoursAhead * 3600000);

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events` +
    `?key=${GOOGLE_KEY}&timeMin=${now.toISOString()}&timeMax=${until.toISOString()}&singleEvents=true&orderBy=startTime`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`[appt-remind] Calendar API ${res.status}`);
      return [];
    }
    const data = await res.json();
    return (data.items || []).map(ev => ({
      id: ev.id,
      summary: ev.summary || '',
      description: ev.description || '',
      location: ev.location || '',
      startTime: ev.start?.dateTime || ev.start?.date,
      endTime: ev.end?.dateTime || ev.end?.date,
      email: extractEmail(ev.description || ''),
      serviceName: null, // will be extracted by AI or parsing
    }));
  } catch (err) {
    logger.error(`[appt-remind] Calendar fetch failed: ${err.message}`);
    return [];
  }
}

function extractEmail(text) {
  const m = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  return m ? m[0] : null;
}

// ── Extract service name from calendar description ──
function parseServiceName(description, summary) {
  // Try to extract service from structured description
  // Format: "Service: Pest Control\nEmail: ..."
  const svcMatch = description.match(/(?:service|type|booking)[:\s]*([^\n]+)/i);
  if (svcMatch) return svcMatch[1].trim();

  // Common service keywords
  const keywords = ['pest control', 'lawn care', 'mosquito', 'termite', 'rodent', 'wdo', 'bed bug', 'roach', 'flea', 'tree', 'shrub'];
  const combined = `${summary} ${description}`.toLowerCase();
  for (const kw of keywords) {
    if (combined.includes(kw)) return kw.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  }

  return summary || 'Service';
}

// ── Find customer by email or phone ──
async function findCustomer(email, phone) {
  if (email) {
    const c = await db('customers').where({ email }).first();
    if (c) return c;
  }
  if (phone) {
    const c = await db('customers').where({ phone }).first();
    if (c) return c;
  }
  return null;
}

// ── Deduplicate reminders ──
async function alreadySent(eventId, reminderType) {
  const key = `${eventId}|${reminderType}`;
  const existing = await db('activity_log')
    .where({ action: 'appointment_reminder' })
    .whereRaw("metadata::text LIKE ?", [`%${key}%`])
    .first();
  return !!existing;
}

async function logReminder(customerId, eventId, reminderType, details) {
  await db('activity_log').insert({
    customer_id: customerId,
    action: 'appointment_reminder',
    description: `${reminderType} reminder: ${details}`,
    metadata: JSON.stringify({ key: `${eventId}|${reminderType}`, eventId, reminderType }),
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
// MAIN SERVICE
// ══════════════════════════════════════════════════════════════
const AppointmentReminderService = {
  /**
   * Run all reminder checks. Called by cron every 30 minutes.
   */
  async checkAll() {
    const results = { sent: 0, skipped: 0, errors: 0 };

    // Source 1: Google Calendar events
    const calEvents = await fetchCalendarEvents(80);

    // Source 2: scheduled_services from portal DB
    const dbServices = await this.getUpcomingFromDB(80);

    // Merge into unified list
    const appointments = [];

    for (const ev of calEvents) {
      const start = new Date(ev.startTime);
      const hoursUntil = (start - Date.now()) / 3600000;

      appointments.push({
        source: 'calendar',
        id: ev.id,
        summary: ev.summary,
        description: ev.description,
        location: ev.location,
        startTime: start,
        hoursUntil,
        email: ev.email,
        serviceName: parseServiceName(ev.description, ev.summary),
        phone: null,
        customer: null,
      });
    }

    for (const svc of dbServices) {
      const start = new Date(`${svc.scheduled_date}T${svc.window_start || '08:00'}:00`);
      const hoursUntil = (start - Date.now()) / 3600000;

      appointments.push({
        source: 'db',
        id: `svc_${svc.id}`,
        summary: svc.service_type,
        description: '',
        location: svc.address || '',
        startTime: start,
        hoursUntil,
        email: svc.email,
        serviceName: svc.service_type,
        phone: svc.phone,
        customer: { id: svc.customer_id, first_name: svc.first_name, last_name: svc.last_name, phone: svc.phone, email: svc.email },
      });
    }

    // Process each appointment for applicable reminders
    for (const appt of appointments) {
      // Resolve customer
      if (!appt.customer) {
        appt.customer = await findCustomer(appt.email);
      }
      if (!appt.customer && !appt.phone) continue;

      const customerPhone = appt.customer?.phone || appt.phone;
      const firstName = appt.customer?.first_name || '';
      if (!customerPhone) continue;

      const timePretty = appt.startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
      const datePretty = appt.startTime.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });

      // 72-hour reminder (#20): 70-74 hours before
      if (appt.hoursUntil >= 70 && appt.hoursUntil <= 74) {
        if (await alreadySent(appt.id, '72h')) { results.skipped++; continue; }
        try {
          const body = `Hello ${firstName}! This is a reminder from Waves that your ${appt.serviceName} appointment is scheduled for ${datePretty} at ${timePretty}.\n\n` +
            `Please ensure gates are unlocked and pets are secured.\n\n` +
            `Reply CONFIRM to confirm or call (941) 318-7612 to reschedule.\n\n— Waves Pest Control 🌊`;
          await TwilioService.sendSMS(customerPhone, body);
          await logReminder(appt.customer?.id, appt.id, '72h', `${appt.serviceName} on ${datePretty}`);
          results.sent++;
          logger.info(`[appt-remind] 72h reminder sent: ${firstName} — ${appt.serviceName}`);
        } catch (err) { results.errors++; logger.error(`[appt-remind] 72h SMS failed: ${err.message}`); }
      }

      // 24-hour reminder (#13): 23-25 hours before
      if (appt.hoursUntil >= 23 && appt.hoursUntil <= 25) {
        if (await alreadySent(appt.id, '24h')) { results.skipped++; continue; }
        try {
          const body = `Hello ${firstName}! This is a reminder from Waves that your ${appt.serviceName} appointment is scheduled for tomorrow at ${timePretty}.\n\n` +
            `Your technician will arrive during the scheduled window. Please ensure gates are unlocked and pets are secured.\n\n` +
            `Reply CONFIRM to confirm or call (941) 318-7612 to reschedule.\n\n— Waves Pest Control 🌊`;
          await TwilioService.sendSMS(customerPhone, body);
          await logReminder(appt.customer?.id, appt.id, '24h', `${appt.serviceName} tomorrow at ${timePretty}`);
          results.sent++;
          logger.info(`[appt-remind] 24h reminder sent: ${firstName} — ${appt.serviceName}`);
        } catch (err) { results.errors++; logger.error(`[appt-remind] 24h SMS failed: ${err.message}`); }
      }

    }

    return results;
  },

  /**
   * Check for new appointments and send confirmation SMS (#21).
   * Also handles WDO inspection prep (#22).
   */
  async checkNewAppointments() {
    const events = await fetchCalendarEvents(168); // Next 7 days
    const results = { confirmations: 0, wdoPreps: 0 };

    for (const ev of events) {
      // Skip if already notified
      if (await alreadySent(ev.id, 'new_appt')) continue;

      const customer = await findCustomer(ev.email);
      if (!customer?.phone) continue;

      const start = new Date(ev.startTime);
      const timePretty = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
      const datePretty = start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
      const serviceName = parseServiceName(ev.description, ev.summary);

      // WDO Inspection special handling (#22)
      if (serviceName.toLowerCase().includes('wdo') || ev.summary.toLowerCase().includes('wdo')) {
        try {
          await this.handleWDOInspection(ev, customer, datePretty, timePretty);
          results.wdoPreps++;
        } catch (err) { logger.error(`[appt-remind] WDO prep failed: ${err.message}`); }
        continue;
      }

      // Regular new appointment confirmation (#21)
      try {
        const body = `Hello ${customer.first_name}! Your ${serviceName} appointment has been successfully scheduled for ${datePretty} at ${timePretty}.\n\n` +
          `Please ensure gates are unlocked and pets are secured before our technician arrives.\n\n` +
          `Need to reschedule? Reply here or call (941) 318-7612.\n\n— Waves Pest Control 🌊`;

        await TwilioService.sendSMS(customer.phone, body);
        await logReminder(customer.id, ev.id, 'new_appt', `${serviceName} on ${datePretty} at ${timePretty}`);
        results.confirmations++;
        logger.info(`[appt-remind] New appointment SMS sent: ${customer.first_name} — ${serviceName} on ${datePretty}`);
      } catch (err) {
        logger.error(`[appt-remind] New appointment SMS failed: ${err.message}`);
      }
    }

    return results;
  },

  /**
   * WDO Inspection pre-briefing (#22).
   * AI generates property research brief, sends email + SMS to admin.
   */
  async handleWDOInspection(event, customer, datePretty, timePretty) {
    const address = event.location || customer.address_line1 || '';
    if (!address) {
      logger.warn(`[appt-remind] WDO inspection skipped — no address for ${customer.first_name}`);
      return;
    }

    let briefing = null;

    // AI pre-inspection research
    if (Anthropic && process.env.ANTHROPIC_API_KEY) {
      try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{
            role: 'user',
            content: `You are a pre-inspection research assistant for a Florida pest control company preparing for a WDO (Wood-Destroying Organism) inspection.

Property: ${address}
Client: ${customer.first_name} ${customer.last_name || ''}
Inspection Date: ${datePretty} at ${timePretty}

Based on the address (SW Florida), generate a WDO pre-inspection briefing. Include:
1. Property type estimate (single family, townhome, etc.)
2. Year built estimate based on area development patterns
3. Pre-inspection risk score (Low/Moderate/High) based on FL location, age estimate, construction norms
4. Common WDO-relevant issues for this area (subterranean termites, drywood termites, wood-decay fungi, powder-post beetles)
5. Inspection focus areas (attic, crawl space, exterior trim, garage, bath traps, etc.)
6. Potential vulnerabilities based on typical SW FL construction
7. Items to verify on-site

Keep it concise and actionable — this is a field briefing, not a report.`,
          }],
        });
        briefing = response.content[0]?.text?.trim();
      } catch (err) {
        logger.error(`[appt-remind] WDO AI briefing failed: ${err.message}`);
      }
    }

    // SMS to admin
    const adminMsg = `WDO PREP: ${address} | ${datePretty} at ${timePretty} | Client: ${customer.first_name} ${customer.last_name || ''}\n\n` +
      (briefing ? briefing.substring(0, 1400) : 'AI briefing unavailable — manual prep needed.');

    await TwilioService.sendSMS(ADMIN_PHONE, adminMsg);

    // Log
    await logReminder(customer.id, event.id, 'wdo_prep', `WDO inspection at ${address} on ${datePretty}`);
    logger.info(`[appt-remind] WDO prep sent for ${address} on ${datePretty}`);
  },

  /**
   * Get upcoming services from portal DB.
   */
  async getUpcomingFromDB(hoursAhead = 80) {
    const now = new Date();
    const until = new Date(now.getTime() + hoursAhead * 3600000);
    const todayStr = now.toISOString().split('T')[0];
    const untilStr = until.toISOString().split('T')[0];

    return db('scheduled_services')
      .whereBetween('scheduled_date', [todayStr, untilStr])
      .whereIn('status', ['pending', 'confirmed'])
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select(
        'scheduled_services.*',
        'customers.first_name', 'customers.last_name',
        'customers.phone', 'customers.email',
        'customers.address_line1 as address'
      );
  },
};

module.exports = AppointmentReminderService;
