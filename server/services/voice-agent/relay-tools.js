/**
 * Voice-relay tools.
 *
 * Phase 0: `capture_lead` — every call leaves a lead (the floor), via the same
 * createLeadFromExtraction pipeline as the existing ElevenLabs agent.
 *
 * Phase 1 (read-only quoting): `get_availability` and `find_slots` let the agent
 * QUOTE real open appointment windows over the phone. They call the exact same
 * route-aware slot engine as the web /book funnel (booking.js `_internals`) — no
 * duplicated scheduling logic — and are strictly READ-ONLY: they never write a
 * booking or touch the schedule. The agent offers times and still captures a
 * lead; a human locks the appointment in. The mutating confirm_booking is Phase 2.
 */

const logger = require('../logger');
const { createLeadFromExtraction } = require('../lead-from-extraction');

const LEAD_QUALITIES = ['hot', 'warm', 'cold', 'spam'];

const TOOLS = [
  {
    name: 'capture_lead',
    description:
      'Save the caller as a lead in the Waves system. Call this once you have ' +
      'gathered the caller\'s reason for calling and as much contact/location ' +
      'detail as they\'ll give. Always call it before ending the call so a human ' +
      'can follow up. Safe to call with partial information.',
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string', description: 'Caller first name, if given' },
        last_name: { type: 'string', description: 'Caller last name, if given' },
        email: { type: 'string', description: 'Email, if given' },
        address_line1: { type: 'string', description: 'Street address of the service location' },
        city: { type: 'string', description: 'City of the service location' },
        zip: { type: 'string', description: '5-digit ZIP of the service location' },
        requested_service: {
          type: 'string',
          description: 'What the caller wants in their own words (e.g. "ants in the kitchen", "lawn looks bad")',
        },
        pain_points: { type: 'string', description: 'Specific problem details / urgency' },
        preferred_date_time: { type: 'string', description: 'Any timing preference or time the caller picked (free text)' },
        call_summary: { type: 'string', description: 'One or two sentence summary of the call' },
        lead_quality: {
          type: 'string',
          enum: LEAD_QUALITIES,
          description: 'hot = ready to buy / urgent, warm = interested, cold = just asking, spam = not a real lead',
        },
      },
      required: ['call_summary'],
    },
  },
  {
    name: 'get_availability',
    description:
      'Look up the soonest open appointment windows near a service location. Use ' +
      'this when the caller asks when you can come out and has not named a ' +
      'specific day. Requires the service address or at least the city/ZIP. ' +
      'READ-ONLY: this does NOT book anything — it only returns times you can ' +
      'offer; a team member confirms the appointment.',
    input_schema: {
      type: 'object',
      properties: {
        address_line1: { type: 'string', description: 'Street address of the service location, if given' },
        city: { type: 'string', description: 'City (e.g. Bradenton, Sarasota, Venice)' },
        zip: { type: 'string', description: '5-digit ZIP of the service location' },
      },
      required: [],
    },
  },
  {
    name: 'find_slots',
    description:
      'Find open appointment windows matching a natural-language time request ' +
      '(e.g. "next Thursday morning", "sometime next week after lunch", "a week ' +
      'from Friday"). Use this when the caller names a preferred day or timeframe. ' +
      'Requires the service address or at least the city/ZIP. READ-ONLY: returns ' +
      'times to offer; it does NOT book anything.',
    input_schema: {
      type: 'object',
      properties: {
        when: { type: 'string', description: 'The caller\'s timing request in their own words' },
        address_line1: { type: 'string', description: 'Street address of the service location, if given' },
        city: { type: 'string', description: 'City (e.g. Bradenton, Sarasota, Venice)' },
        zip: { type: 'string', description: '5-digit ZIP of the service location' },
      },
      required: ['when'],
    },
  },
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Format one engine slot ({ date:'YYYY-MM-DD', start_label:'9:00 AM' }) as speakable text. */
function speakSlot(slot) {
  const parts = String(slot && slot.date ? slot.date : '').split('-').map((n) => parseInt(n, 10));
  let dateStr = (slot && slot.date) || '';
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    dateStr = `${WEEKDAYS[dt.getUTCDay()]} ${MONTHS[parts[1] - 1]} ${parts[2]}`;
  }
  const time = String((slot && (slot.start_label || slot.start)) || '').replace(':00', '').replace(/\s+/g, ' ').trim();
  return time ? `${dateStr} at ${time}` : dateStr;
}

function formatSlots(slots, max = 4) {
  return (slots || []).slice(0, max).map(speakSlot).filter(Boolean).join('; ');
}

/**
 * Shared read-only availability lookup. `when` (optional) routes through the
 * natural-language parser (find_slots); omit it for the soonest-windows path
 * (get_availability). Returns a status the executor turns into model-facing text.
 */
async function resolveAvailability({ address_line1, city, zip, when }) {
  const { isEnabled } = require('../../config/feature-gates');
  if (!isEnabled('selfBooking')) return { status: 'unavailable' };

  const booking = require('../../routes/booking')._internals;
  const config = await booking.loadBookingConfig();

  const addrStr = [address_line1, city, zip].map((s) => String(s || '').trim()).filter(Boolean).join(', ');
  const coords = await booking.resolveBookingCoords({
    address: addrStr ? `${addrStr}, FL` : null,
    city: city ? String(city).trim() : null,
  });
  if (!coords.lat || !coords.lng) return { status: 'need_location' };

  const today = new Date();
  const duration = config.slot_duration_minutes || 60;

  if (when) {
    const { parseWhen, summarizeWindow } = require('../../services/scheduling/parse-when');
    const w = await parseWhen(String(when), {
      now: today,
      minDaysOut: config.advance_days_min ?? 1,
      maxDaysOut: booking.MAX_BOOKING_HORIZON_DAYS,
      defaultWindowDays: config.advance_days_max ?? 14,
    });
    const availability = await booking.buildBookingAvailability({
      lat: coords.lat, lng: coords.lng, duration,
      rangeFrom: w.dateFrom, rangeTo: w.dateTo, config, today,
      timeOfDay: w.timeOfDay, expandOpenDays: true,
    });
    const count = (availability.days || []).reduce((n, d) => n + (Array.isArray(d.slots) ? d.slots.length : 0), 0);
    return { status: 'ok', availability, summary: summarizeWindow(w, { count, nearby: availability.nearby }) };
  }

  const { etDateString, addETDays } = require('../../utils/datetime-et');
  const rangeFrom = etDateString(addETDays(today, config.advance_days_min ?? 1));
  const rangeTo = etDateString(addETDays(today, config.advance_days_max ?? 14));
  const availability = await booking.buildBookingAvailability({
    lat: coords.lat, lng: coords.lng, duration, rangeFrom, rangeTo, config, today,
  });
  return { status: 'ok', availability, summary: null };
}

function availabilityResultToText(res) {
  if (res.status === 'unavailable') {
    return 'Live scheduling is not available right now. Do NOT quote any times — tell the caller a Waves team member will call to schedule, and capture the lead.';
  }
  if (res.status === 'need_location') {
    return 'Could not determine the service location. Ask the caller for their street address or ZIP code, then call this tool again.';
  }
  const list = formatSlots(res.availability && res.availability.slots, 4);
  if (!list) {
    return `${res.summary ? res.summary + ' ' : ''}No open times in that window. Tell the caller a Waves team member will call to find a time that works, and capture the lead.`;
  }
  return (
    `${res.summary ? res.summary + ' ' : ''}Open times: ${list}. ` +
    'NOTHING IS BOOKED YET — read the caller two or three of these options and let them pick. ' +
    'After they choose, tell them a Waves team member will call shortly to confirm and lock it in, ' +
    'then call capture_lead with their chosen time in preferred_date_time. Do not promise the slot is reserved.'
  );
}

/**
 * Execute a tool call. Returns a short string (the tool_result content) telling
 * the model what happened so it can respond to the caller naturally.
 *
 * ctx: { from, to, callSid, language, markCaptured() }
 */
async function executeTool(name, input = {}, ctx = {}) {
  try {
    if (name === 'capture_lead') {
      const extracted = {
        first_name: input.first_name || null,
        last_name: input.last_name || null,
        email: input.email || null,
        address_line1: input.address_line1 || null,
        city: input.city || null,
        zip: input.zip || null,
        requested_service: input.requested_service || null,
        matched_service: null,
        preferred_date_time: input.preferred_date_time || null,
        pain_points: input.pain_points || null,
        call_summary: input.call_summary || null,
        lead_quality: LEAD_QUALITIES.includes(input.lead_quality) ? input.lead_quality : null,
      };
      await createLeadFromExtraction(extracted, {
        phone: ctx.from || null,
        toPhone: ctx.to || null,
        callSid: ctx.callSid || null,
        language: ctx.language || null,
      });
      if (typeof ctx.markCaptured === 'function') ctx.markCaptured();
      logger.info(`[voice-relay] capture_lead saved callSid=${ctx.callSid || 'n/a'}`);
      return 'Lead saved successfully. Let the caller know a Waves team member will follow up shortly to confirm details and scheduling.';
    }

    if (name === 'get_availability') {
      const res = await resolveAvailability({ address_line1: input.address_line1, city: input.city, zip: input.zip });
      return availabilityResultToText(res);
    }

    if (name === 'find_slots') {
      if (!input.when) return 'Ask the caller what day or timeframe they prefer, then call find_slots with that.';
      const res = await resolveAvailability({ when: input.when, address_line1: input.address_line1, city: input.city, zip: input.zip });
      return availabilityResultToText(res);
    }

    return `Unknown tool "${name}". Do not retry; continue the conversation.`;
  } catch (err) {
    logger.error(`[voice-relay] tool "${name}" failed: ${err.message}`);
    if (name === 'capture_lead') {
      return 'The lead could not be saved right now, but proceed to wrap up the call politely; the call is still recorded for follow-up.';
    }
    return 'Could not look up appointment times right now. Tell the caller a Waves team member will call to schedule, and capture the lead.';
  }
}

module.exports = { TOOLS, executeTool, speakSlot, formatSlots, resolveAvailability, availabilityResultToText };
