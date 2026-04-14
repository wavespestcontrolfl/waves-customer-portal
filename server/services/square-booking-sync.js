// DEPRECATED — Square has been removed. Migrated to Stripe.
// This file is kept for reference only. Safe to delete.

/**
 * Square Booking Sync — pulls appointments from Square Bookings API
 * into the scheduled_services table for the Schedule & Dispatch board.
 *
 * Runs on-demand (admin button) or via cron.
 * Deduplicates by square_booking_id to avoid double-creating.
 * Matches Square customers to portal customers by phone/email.
 */

const db = require('../models/db');
const SquareService = require('./square');
const { resolveLocation } = require('../config/locations');
const logger = require('./logger');

// Map Square service variation IDs to readable service names
// These come from Square's catalog — fallback to the raw ID
const SERVICE_NAME_MAP = {
  // Add Square service variation IDs → display names here as needed
  // e.g. 'ABCDEF123': 'General Pest Control',
};

function mapSquareStatus(squareStatus) {
  const map = {
    ACCEPTED: 'confirmed',
    PENDING: 'pending',
    DECLINED: 'cancelled',
    CANCELLED_BY_CUSTOMER: 'cancelled',
    CANCELLED_BY_SELLER: 'cancelled',
    NO_SHOW: 'cancelled',
  };
  return map[squareStatus] || 'pending';
}

function getZone(city) {
  const c = (city || '').toLowerCase();
  if (c.includes('parrish') || c.includes('palmetto') || c.includes('ellenton')) return 'parrish';
  if (c.includes('lakewood') || c.includes('bradenton') || c.includes('university')) return 'lakewood_ranch';
  if (c.includes('sarasota') || c.includes('siesta') || c.includes('osprey')) return 'sarasota';
  if (c.includes('venice') || c.includes('north port') || c.includes('nokomis') || c.includes('englewood')) return 'venice';
  return 'unknown';
}

const SquareBookingSync = {
  /**
   * Sync Square bookings into scheduled_services.
   * @param {number} daysAhead — how many days forward to sync (default 14)
   * @returns {{ synced, created, updated, skipped, errors }}
   */
  async sync(daysAhead = 14) {
    const bookings = await SquareService.getUpcomingBookings(daysAhead);
    if (!bookings.length) {
      logger.info('[square-sync] No upcoming bookings from Square');
      return { synced: 0, created: 0, updated: 0, skipped: 0, errors: [], message: 'Square returned 0 bookings for the next ' + daysAhead + ' days. Check Square Dashboard → Appointments to verify bookings exist.' };
    }

    let created = 0, updated = 0, skipped = 0;
    const errors = [];

    for (const booking of bookings) {
      try {
        // Skip cancelled
        if (['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'DECLINED', 'NO_SHOW'].includes(booking.status)) {
          // If we have it in our DB, mark it cancelled
          const existing = await db('scheduled_services').where({ square_booking_id: booking.id }).first();
          if (existing && existing.status !== 'cancelled') {
            await db('scheduled_services').where({ id: existing.id }).update({ status: 'cancelled', updated_at: new Date() });
            updated++;
          } else {
            skipped++;
          }
          continue;
        }

        // Check if already synced
        const existing = await db('scheduled_services').where({ square_booking_id: booking.id }).first();

        if (existing) {
          // Update status if changed
          const newStatus = mapSquareStatus(booking.status);
          if (existing.status !== newStatus && existing.status !== 'completed') {
            await db('scheduled_services').where({ id: existing.id }).update({
              status: newStatus, updated_at: new Date(),
            });
            updated++;
          } else {
            skipped++;
          }
          continue;
        }

        // Find or create customer in portal DB
        let customerId = null;
        const phone = booking.customerPhone ? booking.customerPhone.replace(/\D/g, '').replace(/^1(\d{10})$/, '+1$1') : null;
        const formattedPhone = phone && phone.length === 10 ? `+1${phone}` : phone;

        if (formattedPhone) {
          const cust = await db('customers').where({ phone: formattedPhone }).first();
          if (cust) {
            customerId = cust.id;
          }
        }
        if (!customerId && booking.customerEmail) {
          const cust = await db('customers').where({ email: booking.customerEmail }).first();
          if (cust) customerId = cust.id;
        }

        // Create customer if not found
        if (!customerId && booking.customerName && booking.customerName !== 'Walk-in') {
          const nameParts = booking.customerName.split(' ');
          const firstName = nameParts[0] || 'Unknown';
          const lastName = nameParts.slice(1).join(' ') || '';
          const loc = resolveLocation('');
          const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

          try {
            const [newCust] = await db('customers').insert({
              first_name: firstName, last_name: lastName,
              phone: formattedPhone || null, email: booking.customerEmail || null,
              referral_code: code, pipeline_stage: 'new_lead',
              pipeline_stage_changed_at: new Date(),
              lead_source: 'square_booking', nearest_location_id: loc.id,
              member_since: new Date().toISOString().split('T')[0],
            }).returning('*');
            customerId = newCust.id;
            logger.info(`[square-sync] Created customer: ${firstName} ${lastName}`);
          } catch (custErr) {
            logger.error(`[square-sync] Customer creation failed: ${custErr.message}`);
          }
        }

        if (!customerId) {
          skipped++;
          continue;
        }

        // Resolve service name — clean up Square variation names that are just price/duration
        let serviceName = SERVICE_NAME_MAP[booking.serviceName] || booking.serviceName || 'Service';
        if (/^\s*[-–—]?\s*\d+\s*(hour|hr|min)/i.test(serviceName) || /^\$\d/.test(serviceName.trim())) {
          serviceName = 'General Pest Control';
        }

        // Parse time
        const start = new Date(booking.startAt);
        const startTime = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
        const endTime = booking.durationMinutes
          ? new Date(start.getTime() + booking.durationMinutes * 60000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' })
          : null;
        const dateStr = start.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

        // Get customer info for zone
        const customer = await db('customers').where({ id: customerId }).first();
        const zone = getZone(customer?.city);

        // Determine time window
        const hour = parseInt(startTime.split(':')[0]);
        const timeWindow = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

        // Insert scheduled service
        await db('scheduled_services').insert({
          customer_id: customerId,
          scheduled_date: dateStr,
          window_start: startTime,
          window_end: endTime,
          service_type: serviceName,
          status: mapSquareStatus(booking.status),
          notes: booking.note || null,
          square_booking_id: booking.id,
          source: 'square',
          zone,
          time_window: timeWindow,
          estimated_duration_minutes: booking.durationMinutes || 60,
        });

        created++;
        logger.info(`[square-sync] Created service: ${serviceName} for ${booking.customerName} on ${dateStr}`);

      } catch (err) {
        logger.error(`[square-sync] Failed to sync booking ${booking.id}: ${err.message}`);
        errors.push({ bookingId: booking.id, error: err.message });
      }
    }

    logger.info(`[square-sync] Sync complete: ${created} created, ${updated} updated, ${skipped} skipped, ${errors.length} errors`);
    return { synced: bookings.length, created, updated, skipped, errors };
  },
};

module.exports = SquareBookingSync;
