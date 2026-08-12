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
 * lead; a human locks the appointment in. The mutating confirm_booking is later.
 *
 * Phase 2 "context" (CONTEXT_TOOLS): get_account_overview, get_service_history,
 * get_pricing, lookup_customer, and the Phase C history pair
 * (get_call_history, get_message_history) — READ-ONLY account reads.
 * Dark behind VOICE_RELAY_CONTEXT_ENABLED (fail-closed): with the gate off the
 * tools don't register (activeTools) AND executeTool refuses them; with the
 * gate on they still refuse unless the session carries a matched customer id
 * (relay-context.resolveCallerContext — identity is ANI-only). Bodies live in
 * relay-context.js.
 */

const logger = require('../logger');
const { createLeadFromExtraction } = require('../lead-from-extraction');
const { toE164, isLikelyE164 } = require('../../utils/phone');

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
        callback_phone: {
          type: 'string',
          description: 'Best phone number to reach the caller (10-digit US or E.164). '
            + 'Capture this especially if they are calling from a blocked/withheld or different number.',
        },
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

// Phase 2 context tools — registered only while VOICE_RELAY_CONTEXT_ENABLED
// (activeTools below) and useful only for an ANI-matched caller.
const CONTEXT_TOOLS = [
  {
    name: 'lookup_customer',
    description:
      'Find a Waves customer account by the account holder\'s name and/or the ' +
      'street address of the property and/or a phone number. Use it when the ' +
      'caller is asking about an account that is not their own matched one — a ' +
      'spouse\'s, landlord\'s, parent\'s, or tenant\'s account. READ-ONLY. It ' +
      'returns at most a first name, city, and a customer_ref you can pass to ' +
      'get_account_overview / get_service_history — never full details. If it ' +
      'reports multiple matches, ask the caller to narrow it down and call again.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Account holder\'s name (first, last, or both), as the caller gives it' },
        street: { type: 'string', description: 'Street address (or a distinctive part of it) of the service property' },
        phone: { type: 'string', description: 'A phone number that may be on the account (10-digit US or E.164)' },
      },
      required: [],
    },
  },
  {
    name: 'get_account_overview',
    description:
      'Look up a Waves account: active recurring services, next scheduled ' +
      'appointment, last completed visit, and open balance. READ-ONLY. With no ' +
      'input it reads the MATCHED caller\'s own account (full detail). Pass a ' +
      'customer_ref from lookup_customer to read a looked-up account instead — ' +
      'those return limited detail (no amounts). Never guess account details.',
    input_schema: {
      type: 'object',
      properties: {
        customer_ref: { type: 'string', description: 'A customer_ref returned by lookup_customer on THIS call. Omit for the matched caller\'s own account.' },
      },
      required: [],
    },
  },
  {
    name: 'get_service_history',
    description:
      'Look up recent service history: the last few completed visits with date ' +
      'and service name (plus the customer-facing visit summary on the matched ' +
      'caller\'s own account). READ-ONLY. With no input it reads the MATCHED ' +
      'caller\'s own account; pass a customer_ref from lookup_customer for a ' +
      'looked-up account (dates and service names only).',
    input_schema: {
      type: 'object',
      properties: {
        customer_ref: { type: 'string', description: 'A customer_ref returned by lookup_customer on THIS call. Omit for the matched caller\'s own account.' },
      },
      required: [],
    },
  },
  {
    name: 'get_call_history',
    description:
      'Summaries of past phone calls between Waves and the number THIS call is ' +
      'coming from — the most recent ten processed calls, newest first. ' +
      'READ-ONLY. Works ONLY when the caller\'s own number matched a customer ' +
      'account; it NEVER works for looked-up accounts (call and text history ' +
      'can contain payment and health details and is never shared with a voice ' +
      'the number did not verify). Use it when the caller references an ' +
      'earlier conversation.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_message_history',
    description:
      'The recent SMS/text thread between Waves and the number THIS call is ' +
      'coming from — about the last twenty messages, newest last, each labeled ' +
      'Customer or Waves. READ-ONLY. Works ONLY when the caller\'s own number ' +
      'matched a customer account; it NEVER works for looked-up accounts. Use ' +
      'it when the caller mentions a text they sent or received.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pricing',
    description:
      'Look up standard recurring-plan pricing from the live Waves pricing ' +
      'engine (the same engine the website quote calculator uses). READ-ONLY. ' +
      'Pricing is public website information — use it for ANY caller, including ' +
      'brand-new prospects. If it reports information is still needed, ask the ' +
      'caller for it and call again. You may quote ONLY the numbers this tool ' +
      'returns — never negotiate, discount, or estimate a price yourself.',
    input_schema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          enum: ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite_bait'],
          description: 'Which recurring plan to price',
        },
        home_sqft: { type: 'number', description: 'Approximate home square footage (ask the caller)' },
        lot_sqft: { type: 'number', description: 'Approximate lot size in square feet (needed for lawn/mosquito/tree & shrub)' },
        lawn_sqft: { type: 'number', description: 'Approximate lawn/turf square footage, if the caller knows it' },
        frequency: { type: 'string', enum: ['quarterly', 'bimonthly', 'monthly'], description: 'Pest control visit frequency (default quarterly)' },
        lawn_track: { type: 'string', enum: ['st_augustine', 'bermuda', 'zoysia', 'bahia'], description: 'Grass type, if known' },
        lawn_tier: { type: 'string', enum: ['basic', 'standard', 'enhanced', 'premium'], description: 'Lawn program tier (default standard)' },
        mosquito_tier: { type: 'string', enum: ['seasonal9', 'monthly12'], description: 'Mosquito program (default monthly12)' },
      },
      required: ['service'],
    },
  },
];
const CONTEXT_TOOL_NAMES = CONTEXT_TOOLS.map((t) => t.name);

// Phase B's ONE write — registered only while BOTH gates are on
// (VOICE_RELAY_CONTEXT_ENABLED + GATE_VOICE_AI_BOOKING, each fail-closed).
// It places a PENDING office-review booking, never a confirmed appointment,
// and sends nothing to the customer. Body lives in relay-booking.js.
const BOOKING_TOOLS = [
  {
    name: 'request_booking',
    description:
      'Place a booking REQUEST for a slot that find_slots or get_availability ' +
      'returned on THIS call, for the matched caller\'s account or a ' +
      'customer_ref from lookup_customer. This does NOT confirm an appointment ' +
      '— it creates a pending request a Waves team member reviews and confirms ' +
      'with the customer. The slot is re-checked against live availability ' +
      'first; if it is gone, offer fresh times. Never tell the caller the time ' +
      'is locked in — a team member will text or call to confirm.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'The chosen slot\'s date, exactly as the availability tool returned it (YYYY-MM-DD)' },
        time: { type: 'string', description: 'The chosen slot\'s start time, exactly as returned (e.g. "9:00 AM")' },
        service: { type: 'string', description: 'What the caller wants, in their own words (mapped to a real Waves service; unclear asks book a Waves Assessment)' },
        customer_ref: { type: 'string', description: 'A customer_ref from lookup_customer on THIS call, when booking for a looked-up account. Omit for the matched caller\'s own account.' },
      },
      required: ['date', 'time'],
    },
  },
];

/**
 * The tool set to register for a relay session. Context tools appear ONLY
 * while the context gate is on; request_booking additionally needs
 * GATE_VOICE_AI_BOOKING (both checked at call time, not module load, so an
 * env flip takes effect without a restart of the test/process).
 */
function activeTools() {
  const { isContextEnabled } = require('./relay-context');
  if (!isContextEnabled()) return TOOLS;
  const { isBookingEnabled } = require('./relay-booking');
  return isBookingEnabled() ? [...TOOLS, ...CONTEXT_TOOLS, ...BOOKING_TOOLS] : [...TOOLS, ...CONTEXT_TOOLS];
}

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

  const street = String(address_line1 || '').trim();
  const cityStr = String(city || '').trim();
  const zipStr = String(zip || '').trim();
  const addrParts = [street, cityStr, zipStr].filter(Boolean);
  // Only send a geocodable `address` when there's a street or ZIP. For a
  // city-only caller, pass just `city` so resolveBookingCoords uses its
  // service_zones fallback instead of throwing on a city-only geocode (which
  // would skip the fallback the public /book route relies on).
  const coords = await booking.resolveBookingCoords({
    address: (street || zipStr) && addrParts.length ? `${addrParts.join(', ')}, FL` : null,
    city: cityStr || null,
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
 * ctx: { from, to, callSid, language, markCaptured(), customerId }
 * (customerId is the ANI-matched customer for this session, or null.)
 */
async function executeTool(name, input = {}, ctx = {}) {
  try {
    if (name === 'request_booking') {
      // Both gates re-checked inside (fail closed, defense in depth); the
      // body re-validates the slot through the live availability engine and
      // creates ONLY a pending office-review row — no customer comms.
      const { requestBookingText } = require('./relay-booking');
      return await requestBookingText(input, ctx);
    }
    if (CONTEXT_TOOL_NAMES.includes(name)) {
      const relayContext = require('./relay-context');
      // Double gate (defense in depth): even if a stale tool list registered
      // these, the gate off means NO account/pricing reads — fail closed.
      if (!relayContext.isContextEnabled()) {
        return 'That lookup is not available. Tell the caller a Waves team member will follow up with the details.';
      }
      // Pricing is PUBLIC website information (owner ruling, Phase B): any
      // caller — including a brand-new prospect — may be quoted engine output.
      if (name === 'get_pricing') {
        return await relayContext.pricingText(input);
      }
      // lookup_customer: find any account (spouse/landlord/parent calling
      // about a shared one). Output shaping + the session ref registry
      // (ctx.rememberLookup) keep this from ever dumping a record.
      if (name === 'lookup_customer') {
        return await relayContext.lookupCustomersText(input, ctx.rememberLookup);
      }
      // Phase C — call/text history is ANI-VERIFIED ONLY (stricter than the
      // two-tier account rule): transcripts and SMS bodies can carry payment
      // and health details, so a looked-up ref gets NOTHING here, not even a
      // redacted view. Enforced in output code, never prompt language.
      if (name === 'get_call_history' || name === 'get_message_history') {
        if (String(input.customer_ref || '').trim()) {
          return 'Call and text history are only available for the account the caller\'s own phone number '
            + 'matches — never for a looked-up account. Do not share, summarize, or hint at any past call '
            + 'or text on this account.';
        }
        if (!ctx.customerId) {
          return 'No customer account matches the number this call is coming from, so there is no call or '
            + 'text history to read. Do NOT guess at past calls or texts. Offer to have the office follow up, '
            + 'and capture the lead.';
        }
        const relayHistory = require('./relay-history');
        if (name === 'get_call_history') return await relayHistory.callHistoryText(ctx.from);
        return await relayHistory.messageHistoryText(ctx.customerId, ctx.from);
      }
      // Account tools — two disclosure tiers, enforced HERE, not in prompt
      // language:
      //   - no customer_ref → the ANI-matched caller's own account, full
      //     detail (Phase A). Identity is the ANI match made at session
      //     start — never a caller's claim. No match → no account data.
      //   - customer_ref → an account looked up on THIS call. If it happens
      //     to BE the matched caller's own account, full tier; otherwise the
      //     redacted tier (dates + service names + balance yes/no).
      let targetCustomerId = null;
      let tier = 'full';
      const ref = String(input.customer_ref || '').trim();
      if (ref) {
        const looked = typeof ctx.resolveLookupRef === 'function' ? ctx.resolveLookupRef(ref) : null;
        if (!looked) {
          return 'That customer_ref is not from a lookup_customer result on this call. Call lookup_customer '
            + 'first; never invent or reuse a reference. Do not share or guess any account details.';
        }
        targetCustomerId = looked;
        tier = ctx.customerId && looked === ctx.customerId ? 'full' : 'redacted';
      } else {
        if (!ctx.customerId) {
          return 'No customer account matches the number this call is coming from. Do NOT share, confirm, or '
            + 'guess any account details. If they are calling about someone else\'s account, use lookup_customer; '
            + 'otherwise offer to have the office call them back, and capture the lead.';
        }
        targetCustomerId = ctx.customerId;
      }
      if (name === 'get_account_overview') return await relayContext.accountOverviewText(targetCustomerId, { tier });
      if (name === 'get_service_history') return await relayContext.serviceHistoryText(targetCustomerId, { tier });
    }
    if (name === 'capture_lead') {
      // Robocall/spam: do NOT write it to the lead pipeline (createLeadFromExtraction
      // records any truthy quality as a normal lead). Suppress the hangup capture
      // floor too so it doesn't write a fallback lead for the same call.
      if (input.lead_quality === 'spam') {
        if (typeof ctx.markCaptured === 'function') ctx.markCaptured();
        logger.info(`[voice-relay] capture_lead suppressed (spam) callSid=${ctx.callSid || 'n/a'}`);
        return 'Marked as spam/robocall — no lead created. Wrap up and end the call politely.';
      }
      // Voice-agent lead contract (AGENTS.md): reject non-E.164 caller IDs
      // before any lead create/merge. Prefer a number the caller gave verbally
      // (callback_phone) over the inbound caller ID, which is blocked/withheld
      // for some callers. No valid number → do not write a junk-phone lead.
      const callerPhone = toE164(input.callback_phone || ctx.from || '');
      if (!isLikelyE164(callerPhone)) {
        logger.warn(`[voice-relay] capture_lead skipped — no valid E.164 callback number callSid=${ctx.callSid || 'n/a'}`);
        return 'I could not save the lead yet — we do not have a valid phone number to reach the caller. '
          + 'Ask the caller for the best 10-digit number and call capture_lead again with callback_phone.';
      }
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
        phone: callerPhone,
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
    if (name === 'request_booking') {
      return 'The booking request could not be placed — NOTHING was booked. Tell the caller a Waves '
        + 'team member will call to schedule, and capture the lead with their preferred time.';
    }
    if (CONTEXT_TOOL_NAMES.includes(name)) {
      return 'Could not look that up right now. Do not guess — tell the caller a Waves team member will follow up with the details.';
    }
    return 'Could not look up appointment times right now. Tell the caller a Waves team member will call to schedule, and capture the lead.';
  }
}

module.exports = { TOOLS, CONTEXT_TOOLS, BOOKING_TOOLS, activeTools, executeTool, speakSlot, formatSlots, resolveAvailability, availabilityResultToText };
