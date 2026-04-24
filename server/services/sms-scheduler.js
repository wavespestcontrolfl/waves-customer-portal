/**
 * Conversational SMS Scheduler — Twilio + Claude + AvailabilityEngine
 *
 * Handles natural language scheduling via SMS:
 *   "I can't do Tuesday, how about Thursday afternoon?"
 *   "Can I move my appointment to next week?"
 *   "What times do you have available Friday?"
 *
 * Uses a state machine stored in `sms_scheduling_sessions` to track
 * multi-turn conversations. Claude interprets intent; AvailabilityEngine
 * provides real slots; the service orchestrates the flow.
 *
 * States:
 *   idle           → no active session
 *   slots_offered  → we've shown available times, waiting for pick
 *   confirm_pending → customer picked a time, waiting for "yes"
 *   completed      → booking confirmed
 *   expired        → session timed out (30 min)
 */
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../models/db');
const AvailabilityEngine = require('./availability');
const TwilioService = require('./twilio');
const logger = require('./logger');
const MODELS = require('../config/models');

const anthropic = new Anthropic();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const SYSTEM_PROMPT = `You are a scheduling assistant for Waves Pest Control, a family-owned pest control and lawn care company in Southwest Florida. You help customers reschedule or book appointments via SMS.

RULES:
- Be warm, brief, and professional. This is SMS — keep responses under 300 characters when possible.
- Use the customer's first name.
- Never invent times or dates. Only offer slots from the AVAILABLE_SLOTS data provided.
- If the customer mentions a specific day, try to match it. If no slots exist that day, suggest the closest alternatives.
- If the customer picks a slot, confirm it clearly with date, time, and address.
- If the customer's message is unrelated to scheduling, set intent to "off_topic".
- Do NOT use emojis. Keep the tone neighborly-professional — no wave icons, no calendar / clock / pin icons, no enclosed-alphanumeric digits.

OUTPUT FORMAT — respond with ONLY a JSON object (no markdown, no backticks):
{
  "intent": "request_slots" | "pick_slot" | "confirm_yes" | "confirm_no" | "cancel" | "off_topic" | "unclear",
  "preferred_day": "YYYY-MM-DD" or null,
  "preferred_time_of_day": "morning" | "afternoon" | "any" or null,
  "picked_slot_index": number or null,
  "reply": "The SMS text to send back to the customer"
}`;

class SmsScheduler {

  /**
   * Main entry: process an inbound SMS that may be scheduling-related.
   * Returns { handled: boolean, reply?: string }
   */
  async handleMessage(customerId, messageBody, fromPhone, toPhone) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return { handled: false };

    const body = (messageBody || '').trim();
    if (!body) return { handled: false };

    // Check for active session
    let session = await this.getActiveSession(customerId);

    // If no session, check if this looks like a scheduling request
    if (!session) {
      const isScheduling = this.looksLikeScheduling(body);
      if (!isScheduling) return { handled: false };

      // Create new session
      session = await this.createSession(customerId);
    }

    // Route based on session state
    try {
      const result = await this.processWithClaude(session, customer, body);

      switch (result.intent) {
        case 'off_topic':
          // Not scheduling — let other handlers deal with it
          await this.expireSession(session.id);
          return { handled: false };

        case 'request_slots':
          return await this.handleRequestSlots(session, customer, result, fromPhone, toPhone);

        case 'pick_slot':
          return await this.handlePickSlot(session, customer, result, fromPhone, toPhone);

        case 'confirm_yes':
          return await this.handleConfirm(session, customer, fromPhone, toPhone);

        case 'confirm_no':
        case 'cancel':
          await this.updateSession(session.id, { state: 'idle' });
          const cancelReply = `No problem, ${customer.first_name}. Just text us whenever you're ready to reschedule.`;
          await this.sendReply(fromPhone, toPhone, cancelReply, customerId);
          return { handled: true, reply: cancelReply };

        case 'unclear':
        default:
          // Ask Claude to clarify
          const clarifyReply = result.reply || `Sorry ${customer.first_name}, I didn't catch that. Would you like to see available appointment times?`;
          await this.sendReply(fromPhone, toPhone, clarifyReply, customerId);
          return { handled: true, reply: clarifyReply };
      }
    } catch (err) {
      logger.error(`[sms-scheduler] Error: ${err.message}`);
      return { handled: false };
    }
  }

  /**
   * Quick regex check: does this message look like a scheduling request?
   */
  looksLikeScheduling(body) {
    const patterns = [
      /\b(reschedule|schedule|appointment|book|slot|available|availability)\b/i,
      /\b(can't|cannot|won't|can not)\s+(do|make)\b/i,
      /\b(how about|what about|instead|move|change|switch)\b/i,
      /\b(next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|week)\b/i,
      /\b(morning|afternoon|evening)\b.*\b(work|available|open|free)\b/i,
      /\b(what|any)\s+(times?|days?|slots?)\b/i,
      /\bRESCHEDULE\b/i, // keyword from confirmation SMS
    ];
    return patterns.some(p => p.test(body));
  }

  /**
   * Send the message + context to Claude for intent parsing.
   */
  async processWithClaude(session, customer, body) {
    // Build context
    const context = {
      customerName: customer.first_name,
      sessionState: session.state,
      offeredSlots: session.offered_slots || null,
      pendingSlot: session.pending_slot || null,
    };

    // Get the existing appointment being rescheduled (if any)
    const existingAppt = await db('scheduled_services')
      .where({ customer_id: customer.id })
      .whereNotIn('status', ['completed', 'cancelled', 'skipped'])
      .orderBy('scheduled_date', 'asc')
      .first();

    if (existingAppt) {
      const d = new Date(existingAppt.scheduled_date + 'T12:00:00');
      context.existingAppointment = {
        date: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' }),
        time: existingAppt.window_start || 'TBD',
        serviceType: existingAppt.service_type,
      };
    }

    const userMessage = `CONTEXT: ${JSON.stringify(context)}

CUSTOMER MESSAGE: "${body}"

${context.offeredSlots ? `AVAILABLE_SLOTS (indices start at 1):\n${context.offeredSlots.map((s, i) => `${i + 1}. ${s.label}`).join('\n')}` : ''}`;

    try {
      const response = await anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const block = response.content[0];
      const text = typeof block === 'string' ? block : (block?.text || JSON.stringify(block));
      // Parse JSON — strip markdown fences if present
      const clean = text.replace(/```json\s*|```/g, '').trim();
      return JSON.parse(clean);
    } catch (err) {
      logger.error(`[sms-scheduler] Claude parse error: ${err.message}`);
      return { intent: 'unclear', reply: null };
    }
  }

  /**
   * Handle "request_slots" — fetch availability and text options back.
   */
  async handleRequestSlots(session, customer, result, fromPhone, toPhone) {
    const city = customer.city || 'Bradenton';
    const availability = await AvailabilityEngine.getAvailableSlots(city);

    if (!availability.days || availability.days.length === 0) {
      const reply = `Hey ${customer.first_name}, we're fully booked in the ${city} area for the next 2 weeks. Call us at (941) 318-7612 and we'll work something out.`;
      await this.sendReply(fromPhone, toPhone, reply, customer.id);
      await this.expireSession(session.id);
      return { handled: true, reply };
    }

    // If customer preferred a specific day, filter for it
    let filteredDays = availability.days;
    if (result.preferred_day) {
      const prefDay = availability.days.find(d => d.date === result.preferred_day);
      if (prefDay) filteredDays = [prefDay];
    }

    // If preferred time of day, filter slots
    if (result.preferred_time_of_day && result.preferred_time_of_day !== 'any') {
      filteredDays = filteredDays.map(day => ({
        ...day,
        slots: day.slots.filter(s => {
          const hour = parseInt(s.startTime24.split(':')[0]);
          return result.preferred_time_of_day === 'morning' ? hour < 12 : hour >= 12;
        }),
      })).filter(d => d.slots.length > 0);
    }

    // Build flat list of top 4 options
    const options = [];
    for (const day of filteredDays.slice(0, 3)) {
      for (const slot of day.slots.slice(0, 2)) {
        if (options.length >= 4) break;
        options.push({
          date: day.date,
          fullDate: day.fullDate,
          start: slot.start,
          end: slot.end,
          startTime24: slot.startTime24,
          endTime24: slot.endTime24,
          label: `${day.fullDate}, ${slot.start}-${slot.end}`,
        });
      }
    }

    if (options.length === 0) {
      const reply = `Sorry ${customer.first_name}, no openings for that day/time. Want me to check other days?`;
      await this.sendReply(fromPhone, toPhone, reply, customer.id);
      return { handled: true, reply };
    }

    // Store offered slots in session
    await this.updateSession(session.id, {
      state: 'slots_offered',
      offered_slots: JSON.stringify(options),
    });

    // Build SMS
    let reply = `Here's what we have, ${customer.first_name}:\n`;
    options.forEach((o, i) => {
      reply += `\n${i + 1}. ${o.label}`;
    });
    reply += `\n\nReply with the number to book, or tell me another day.`;

    await this.sendReply(fromPhone, toPhone, reply, customer.id);
    return { handled: true, reply };
  }

  /**
   * Handle "pick_slot" — customer chose one of the offered options.
   */
  async handlePickSlot(session, customer, result, fromPhone, toPhone) {
    const offered = session.offered_slots || [];
    const idx = (result.picked_slot_index || 0) - 1; // convert 1-indexed to 0-indexed

    if (idx < 0 || idx >= offered.length) {
      const reply = `Hmm, I didn't get which one. Reply 1-${offered.length} to pick a time, or tell me a different day.`;
      await this.sendReply(fromPhone, toPhone, reply, customer.id);
      return { handled: true, reply };
    }

    const slot = offered[idx];

    // Store pending slot
    await this.updateSession(session.id, {
      state: 'confirm_pending',
      pending_slot: JSON.stringify(slot),
    });

    const reply = `Got it, ${customer.first_name}. I'll book you for:\n\nDate: ${slot.fullDate}\nTime: ${slot.start} – ${slot.end}\nAddress: ${customer.address_line1 || ''}, ${customer.city || ''}\n\nReply YES to confirm or NO to pick a different time.`;
    await this.sendReply(fromPhone, toPhone, reply, customer.id);
    return { handled: true, reply };
  }

  /**
   * Handle "confirm_yes" — lock in the booking.
   */
  async handleConfirm(session, customer, fromPhone, toPhone) {
    const slot = session.pending_slot || null;
    if (!slot) {
      const reply = `I don't have a pending time to confirm. Want to see available slots?`;
      await this.sendReply(fromPhone, toPhone, reply, customer.id);
      return { handled: true, reply };
    }

    try {
      // Cancel existing appointment if rescheduling
      const existing = await db('scheduled_services')
        .where({ customer_id: customer.id })
        .whereNotIn('status', ['completed', 'cancelled', 'skipped'])
        .orderBy('scheduled_date', 'asc')
        .first();

      // Cancel old + book new atomically
      const result = await db.transaction(async trx => {
        if (existing) {
          await trx('scheduled_services').where({ id: existing.id }).update({
            status: 'cancelled',
            notes: trx.raw("COALESCE(notes, '') || ?", ['\nRescheduled via SMS to ' + slot.fullDate]),
            updated_at: new Date(),
          });
        }

        // Book via AvailabilityEngine
        return AvailabilityEngine.confirmBooking(
          null, // no estimate
          customer.id,
          slot.date,
          slot.startTime24,
          'Booked via conversational SMS'
        );
      });

      // Mark session complete
      await this.updateSession(session.id, {
        state: 'completed',
        booked_date: slot.date,
        booked_time: slot.startTime24,
        confirmation_code: result.confirmationCode,
      });

      // Log activity
      await db('activity_log').insert({
        customer_id: customer.id,
        action: 'sms_booking_confirmed',
        description: `${customer.first_name} booked ${slot.fullDate} ${slot.start} via conversational SMS (${result.confirmationCode})`,
      }).catch(() => {});

      // The AvailabilityEngine.confirmBooking already sends confirmation SMS
      // Just close out — no duplicate message needed
      return { handled: true, reply: 'Booking confirmed via AvailabilityEngine' };

    } catch (err) {
      logger.error(`[sms-scheduler] Booking failed: ${err.message}`);
      const reply = `Sorry ${customer.first_name}, there was an issue booking that slot. Call us at (941) 318-7612 and we'll get you sorted.`;
      await this.sendReply(fromPhone, toPhone, reply, customer.id);
      return { handled: true, reply };
    }
  }

  // ── Session management ────────────────────────────────

  async getActiveSession(customerId) {
    const session = await db('sms_scheduling_sessions')
      .where({ customer_id: customerId })
      .whereNot('state', 'completed')
      .whereNot('state', 'expired')
      .where('updated_at', '>', new Date(Date.now() - SESSION_TTL_MS))
      .orderBy('updated_at', 'desc')
      .first();
    return session || null;
  }

  async createSession(customerId) {
    const [session] = await db('sms_scheduling_sessions').insert({
      customer_id: customerId,
      state: 'idle',
    }).returning('*');
    return session;
  }

  async updateSession(id, data) {
    data.updated_at = new Date();
    await db('sms_scheduling_sessions').where({ id }).update(data);
  }

  async expireSession(id) {
    await db('sms_scheduling_sessions').where({ id }).update({ state: 'expired', updated_at: new Date() });
  }

  // ── SMS helper ────────────────────────────────────────

  async sendReply(to, from, body, customerId) {
    try {
      await TwilioService.sendSMS(to, body, {
        customerId,
        fromNumber: from,
        messageType: 'sms_scheduler',
      });
    } catch (err) {
      logger.error(`[sms-scheduler] Send failed: ${err.message}`);
    }
  }
}

module.exports = new SmsScheduler();
