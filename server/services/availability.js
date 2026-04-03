/**
 * Zone-Based Availability Engine
 *
 * Only shows slots when a tech is already working in the customer's zone.
 * Finds 1-hour gaps between existing jobs with buffer enforcement.
 */
const db = require('../models/db');
const logger = require('./logger');

class AvailabilityEngine {

  async getAvailableSlots(city, estimateId) {
    // 1. Resolve city → zone
    const zone = await this.resolveZone(city);
    if (!zone) return { zone: null, days: [], message: `No service zone found for ${city}` };

    // 2. Get config
    const config = await db('booking_config').first() || {
      advance_days_min: 1, advance_days_max: 14,
      day_start: '08:00', day_end: '17:00',
      lunch_start: '12:00', lunch_end: '13:00',
      slot_duration_minutes: 60, buffer_minutes: 15,
      max_self_books_per_day: 3,
    };

    const slotDuration = config.slot_duration_minutes || 60;
    const buffer = config.buffer_minutes || 15;
    const lunchStart = this.timeToMin(config.lunch_start || '12:00');
    const lunchEnd = this.timeToMin(config.lunch_end || '13:00');
    const dayStart = this.timeToMin(config.day_start || '08:00');
    const dayEnd = this.timeToMin(config.day_end || '17:00');

    const days = [];
    const today = new Date();

    for (let i = config.advance_days_min; i <= config.advance_days_max; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);
      if (date.getDay() === 0) continue; // skip Sunday

      const dateStr = date.toISOString().split('T')[0];

      // Find techs working in this zone on this day
      const techBlocks = await db('tech_schedule_blocks')
        .where('service_zone_id', zone.id)
        .where('date', dateStr)
        .where('block_type', 'available');

      // Also check if any scheduled_services exist in this zone for the day
      const zoneCities = zone.cities || [];
      const scheduledInZone = await db('scheduled_services')
        .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
        .where('scheduled_services.scheduled_date', dateStr)
        .whereNotIn('scheduled_services.status', ['cancelled'])
        .whereIn('customers.city', zoneCities)
        .select('scheduled_services.*');

      // If no tech blocks AND no existing services in zone, skip this day
      if (techBlocks.length === 0 && scheduledInZone.length === 0) continue;

      // Count existing self-bookings for this zone/day
      const existingBookings = await db('self_booked_appointments')
        .where('service_zone_id', zone.id)
        .where('date', dateStr)
        .whereNot('status', 'cancelled')
        .count('* as count')
        .first();

      if (parseInt(existingBookings.count) >= config.max_self_books_per_day) continue;

      // Build occupied slots from scheduled_services
      const occupied = scheduledInZone.map(s => ({
        start: this.timeToMin(s.window_start || '09:00'),
        end: this.timeToMin(s.window_end || s.window_start ? this.addMinutes(s.window_start, 60) : '10:00'),
      }));

      // Add existing self-bookings
      const selfBooked = await db('self_booked_appointments')
        .where('service_zone_id', zone.id)
        .where('date', dateStr)
        .whereNot('status', 'cancelled');
      selfBooked.forEach(b => {
        occupied.push({ start: this.timeToMin(b.start_time), end: this.timeToMin(b.end_time) });
      });

      // Add lunch block
      occupied.push({ start: lunchStart, end: lunchEnd });

      // Sort occupied by start time
      occupied.sort((a, b) => a.start - b.start);

      // Find gaps
      const slots = this.findGaps(occupied, dayStart, dayEnd, slotDuration, buffer);

      if (slots.length > 0) {
        days.push({
          date: dateStr,
          dayOfWeek: date.toLocaleDateString('en-US', { weekday: 'short' }),
          dayNum: date.getDate(),
          month: date.toLocaleDateString('en-US', { month: 'short' }),
          fullDate: date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
          slots: slots.map(s => ({
            start: this.minToTime12(s.start),
            end: this.minToTime12(s.end),
            startTime24: this.minToTime24(s.start),
            endTime24: this.minToTime24(s.end),
          })),
          zone: zone.zone_name,
        });
      }
    }

    return { zone: zone.zone_name, days };
  }

  findGaps(occupied, dayStart, dayEnd, slotDuration, buffer) {
    const slots = [];
    let cursor = dayStart;

    for (const block of occupied) {
      const gapStart = cursor + buffer;
      const gapEnd = block.start - buffer;

      if (gapEnd - gapStart >= slotDuration) {
        // Can fit a slot here
        slots.push({ start: gapStart, end: gapStart + slotDuration });
      }
      cursor = Math.max(cursor, block.end);
    }

    // Check gap after last occupied block
    const finalStart = cursor + buffer;
    if (dayEnd - finalStart >= slotDuration) {
      slots.push({ start: finalStart, end: finalStart + slotDuration });
    }

    return slots.slice(0, 4); // max 4 slots per day
  }

  async resolveZone(city) {
    const zones = await db('service_zones');
    for (const zone of zones) {
      const cities = zone.cities || [];
      if (cities.some(c => c.toLowerCase() === (city || '').toLowerCase())) {
        return zone;
      }
    }
    return null;
  }

  async confirmBooking(estimateId, customerId, date, startTime, customerNotes) {
    // Resolve estimate
    const estimate = estimateId ? await db('estimates').where('id', estimateId).first() : null;
    const customer = await db('customers').where('id', customerId).first();
    if (!customer) throw new Error('Customer not found');

    const zone = await this.resolveZone(customer.city);
    const config = await db('booking_config').first();
    const slotDuration = config?.slot_duration_minutes || 60;

    const endTime = this.addMinutes(startTime, slotDuration);
    const confCode = 'WPC-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

    // Create self_booked_appointment
    const [booking] = await db('self_booked_appointments').insert({
      customer_id: customerId,
      estimate_id: estimateId || null,
      service_zone_id: zone?.id || null,
      date,
      start_time: startTime,
      end_time: endTime,
      duration_minutes: slotDuration,
      customer_notes: customerNotes || null,
      confirmation_code: confCode,
    }).returning('*');

    // Create scheduled_service so it shows on the dispatch board
    const serviceType = estimate?.services?.[0] || estimate?.service_type || 'General Pest Control';
    await db('scheduled_services').insert({
      customer_id: customerId,
      scheduled_date: date,
      window_start: startTime,
      window_end: endTime,
      service_type: serviceType,
      status: 'confirmed',
      customer_confirmed: true,
      confirmed_at: new Date(),
      notes: customerNotes ? `Self-booked. Notes: ${customerNotes}` : 'Self-booked via portal',
      source: 'self_booked',
      self_booking_id: booking.id,
      zone: zone?.zone_name?.split('/')[0]?.trim()?.toLowerCase() || null,
    });

    // Sync to dispatch_jobs
    try {
      const { syncJobsFromSchedule } = require('./dispatch/schedule-bridge');
      await syncJobsFromSchedule(date);
    } catch { /* dispatch sync is best-effort */ }

    // Send SMS notifications
    try {
      const TwilioService = require('./twilio');
      const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

      // Customer confirmation
      await TwilioService.sendSMS(customer.phone,
        `Your Waves Pest Control appointment is confirmed!\n\n📅 ${dateLabel}\n⏰ ${this.minToTime12(this.timeToMin(startTime))} – ${this.minToTime12(this.timeToMin(endTime))}\n📍 ${customer.address_line1}, ${customer.city}\n\nConfirmation: ${confCode}\n\nReply RESCHEDULE if you need to change. 🌊`,
        { customerId: customer.id, messageType: 'booking_confirmation' }
      );

      // Adam notification
      if (process.env.ADAM_PHONE) {
        await TwilioService.sendSMS(process.env.ADAM_PHONE,
          `📱 New self-booked appointment:\n${customer.first_name} ${customer.last_name}\n${serviceType}\n${dateLabel} ${this.minToTime12(this.timeToMin(startTime))}\n${customer.city}\nCode: ${confCode}`,
          { messageType: 'internal_alert' }
        );
      }
    } catch (err) {
      logger.error(`Booking SMS failed: ${err.message}`);
    }

    return { booking, confirmationCode: confCode };
  }

  // Time helpers
  timeToMin(t) {
    if (!t) return 540; // default 9:00
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  }

  minToTime12(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  minToTime24(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  addMinutes(time, mins) {
    const total = this.timeToMin(time) + mins;
    return this.minToTime24(total);
  }
}

module.exports = new AvailabilityEngine();
