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
 *
 * Phase E adds one more context tool and two capture behaviors:
 *   - `request_reservice` — an ANI-matched EXISTING customer reporting a
 *     problem between visits files in the re-service lane (relay-reservice.js),
 *     not the new-business lead pipeline. Unmatched callers keep capture_lead.
 *   - capture_lead now carries the caller's stated contact preference /
 *     consent instruction (captured for a human, never acted on) and fires the
 *     INTERNAL owner alert for a hot/urgent lead (relay-alert.js — one per
 *     call, fail-open, never customer-facing).
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
          description: 'hot = urgent or ready to buy (emergency, swarming, active infestation, angry customer), '
            + 'warm = interested, cold = just asking, spam = not a real lead. Use hot ONLY when it is genuinely '
            + 'urgent or they are ready to move — it pages the owner.',
        },
        urgency_reason: {
          type: 'string',
          description: 'If lead_quality is hot, one short phrase saying WHY it is urgent (e.g. "swarming termites in the '
            + 'living room", "wasp nest, allergic child", "upset about a missed visit").',
        },
        contact_preference: {
          type: 'string',
          description: 'Any contact instruction the caller stated, IN THEIR OWN WORDS (e.g. "stop texting me", '
            + '"call my husband Dave at 941-555-0114 instead, not me", "email only, I work nights"). Capture it '
            + 'verbatim if they said one. Leave empty if they said nothing about how to be contacted.',
        },
        preferred_contact_method: {
          type: 'string',
          enum: ['phone', 'sms', 'email', 'unspecified'],
          description: 'How the caller asked to be reached, if they said. Omit when they did not say.',
        },
        estimate_requested: {
          type: 'boolean',
          description: 'True when the caller asked about pricing and you could not give them a number on this call, '
            + 'so a written estimate was promised. The office fulfils it — the tool result tells you whether the '
            + 'request was actually queued.',
        },
        do_not_contact_request: {
          type: 'boolean',
          description: 'True ONLY if the caller asked us to stop contacting them (or stop texting/emailing them). '
            + 'You do not act on this yourself, and you do NOT promise anything about it — say a Waves team '
            + 'member will take care of it, never that it is already done. It is recorded for a human to action.',
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
    name: 'get_today_eta',
    description:
      'Check whether this account has an appointment TODAY, what the arrival ' +
      'window is, and whether the technician is already on the way. READ-ONLY ' +
      '— it never changes the schedule. Use it whenever the caller asks when ' +
      'the tech is coming, where the tech is, or how much longer. With no ' +
      'input it reads the MATCHED caller\'s own account; a customer_ref from ' +
      'lookup_customer returns only whether a visit is on today\'s schedule ' +
      '(no window, no live technician status). Quote only what it returns.',
    input_schema: {
      type: 'object',
      properties: {
        customer_ref: { type: 'string', description: 'A customer_ref returned by lookup_customer on THIS call. Omit for the matched caller\'s own account.' },
      },
      required: [],
    },
  },
  {
    name: 'get_service_report',
    description:
      'The customer-facing detail from a completed visit: what the technician ' +
      'found, what was applied, the customer note, and any re-entry guidance. ' +
      'READ-ONLY. Use it when the caller asks what was done on a visit. Omit ' +
      'the date for the most recent visit, or pass one (YYYY-MM-DD) from ' +
      'get_service_history. Read back ONLY what this tool returns — never add ' +
      'findings, products, or timings of your own. Matched caller\'s own ' +
      'account only.',
    input_schema: {
      type: 'object',
      properties: {
        visit_date: { type: 'string', description: 'The visit date as YYYY-MM-DD, exactly as shown in parentheses by get_service_history. Omit for the most recent completed visit.' },
        service: { type: 'string', description: 'When more than one visit shares that date, the service name the caller means (as get_service_history listed it). Omit otherwise.' },
      },
      required: [],
    },
  },
  {
    name: 'get_open_estimates',
    description:
      'Outstanding (sent, not yet accepted) estimates on an account, with the ' +
      'prices they were SENT at. READ-ONLY. Quote those numbers exactly — ' +
      'they are honoured as sent; never re-price, discount, or update them. ' +
      'With no input it reads the MATCHED caller\'s own account (line items ' +
      'and amounts); a customer_ref from lookup_customer returns only that an ' +
      'estimate exists and when it was sent, never amounts.',
    input_schema: {
      type: 'object',
      properties: {
        customer_ref: { type: 'string', description: 'A customer_ref returned by lookup_customer on THIS call. Omit for the matched caller\'s own account.' },
      },
      required: [],
    },
  },
  {
    name: 'get_invoice_history',
    description:
      'Invoices on the MATCHED caller\'s own account: numbers, dates, amounts, ' +
      'what is paid, what is unpaid, and the total open balance. READ-ONLY — ' +
      'it never takes or moves a payment. Matched caller only; it does not ' +
      'work for looked-up accounts. It returns no payment links or codes: ' +
      'point the caller to the Waves customer portal or the office, and never ' +
      'take a card number on this call.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_services_catalog',
    description:
      'The list of services Waves offers, by their customer-facing names. ' +
      'READ-ONLY and public information — use it for ANY caller, including a ' +
      'brand-new prospect asking "what do you do?". It returns names only; ' +
      'for what something costs, call get_pricing.',
    input_schema: { type: 'object', properties: {}, required: [] },
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
    name: 'request_reservice',
    description:
      'File a re-service request for an EXISTING customer whose problem came ' +
      'back between their scheduled visits ("the ants are back", "I\'m still ' +
      'seeing roaches after last week"). Use this INSTEAD of capture_lead for ' +
      'the matched caller — they are already a customer, not a new lead. It ' +
      'files the request with the office; it does NOT schedule anything and ' +
      'sends the customer nothing. Works only for the account the caller\'s own ' +
      'phone number matched. Never state a date, a link, or a code afterwards.',
    input_schema: {
      type: 'object',
      properties: {
        lane: {
          type: 'string',
          enum: ['pest', 'lawn'],
          description: 'Which service the problem is with: "pest" for bugs/rodents, "lawn" for turf.',
        },
        issue: {
          type: 'string',
          description: 'What the caller is seeing and where, in their own words (e.g. "ants back in the kitchen '
            + 'since the weekend, along the baseboard").',
        },
        urgent: {
          type: 'boolean',
          description: 'True only when it genuinely cannot wait (heavy activity, stings/bites, a vulnerable person '
            + 'in the home). Leave false otherwise.',
        },
      },
      required: ['lane', 'issue'],
    },
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
        // 'basic' is deliberately absent: the 4x tier is fully retired
        // (owner 2026-08-04) and the engine silently resolves it to enhanced —
        // advertising it would quote a program Waves does not sell.
        lawn_tier: { type: 'string', enum: ['standard', 'enhanced', 'premium'], description: 'Lawn program tier (default standard)' },
        mosquito_tier: { type: 'string', enum: ['seasonal9', 'monthly12'], description: 'Mosquito program (default monthly12)' },
        property_type: {
          type: 'string',
          enum: ['single_family', 'townhome_end', 'townhome_interior', 'duplex', 'condo_ground', 'condo_upper', 'commercial'],
          description: 'What kind of property it is, if the caller says. A condo or townhome prices lower than a '
            + 'house, so pass it when you know it. Omit when they have not said — it defaults to a single-family home. '
            + 'Pass "commercial" for any business, office, restaurant, HOA, or multifamily property — commercial is '
            + 'never priced on this call; the tool will tell you what to say.',
        },
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
      'returned on THIS call, identified by its slot_ref, for the matched ' +
      'caller\'s account or a ' +
      'customer_ref from lookup_customer. This does NOT confirm an appointment ' +
      '— it creates a pending request a Waves team member reviews and confirms ' +
      'with the customer. The slot is re-checked against live availability ' +
      'first; if it is gone, offer fresh times. Never tell the caller the time ' +
      'is locked in — a team member will text or call to confirm.',
    input_schema: {
      type: 'object',
      properties: {
        slot_ref: { type: 'string', description: 'The slot_ref (e.g. "S2") of the time the caller picked, exactly as find_slots or get_availability printed it on THIS call. Never invent one, and never pass a date or a time here.' },
        service: { type: 'string', description: 'What the caller wants, in their own words (mapped to a real Waves service; unclear asks book a Waves Assessment)' },
        customer_ref: { type: 'string', description: 'A customer_ref from lookup_customer on THIS call, when booking for a looked-up account. Omit for the matched caller\'s own account.' },
      },
      required: ['slot_ref'],
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

/**
 * Speakable slot list, each carrying an OPAQUE SLOT REF.
 *
 * speakSlot deliberately says "Tuesday August 18 at 9 AM" — there is no ISO
 * date anywhere in what the model is told. request_booking used to demand
 * `YYYY-MM-DD`, so the model had to RECONSTRUCT a key it was never given.
 * Instead the session remembers each offered slot (with the coords, duration
 * and timeOfDay it was generated from) under a ref, exactly like the
 * lookup_customer refs: the model echoes an opaque handle, and an invented one
 * resolves to nothing.
 */
function formatSlots(slots, max = 4, rememberSlot = null, offerContext = null) {
  return (slots || []).slice(0, max).map((slot) => {
    const spoken = speakSlot(slot);
    if (!spoken) return null;
    const ref = typeof rememberSlot === 'function' ? rememberSlot(slot, offerContext) : null;
    return ref ? `${spoken} (slot_ref: ${ref})` : spoken;
  }).filter(Boolean).join('; ');
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
    return {
      status: 'ok',
      availability,
      summary: summarizeWindow(w, { count, nearby: availability.nearby }),
      // Carried onto every remembered slot so request_booking can re-run the
      // engine with the SAME inputs. Dropping timeOfDay is not harmless: it
      // lets morning candidates push an offered afternoon slot out of the
      // per-day cap, so the re-check loses a slot that is still open.
      offerContext: {
        lat: coords.lat, lng: coords.lng, duration,
        timeOfDay: w.timeOfDay || 'any', expandOpenDays: true,
      },
    };
  }

  const { etDateString, addETDays } = require('../../utils/datetime-et');
  const rangeFrom = etDateString(addETDays(today, config.advance_days_min ?? 1));
  const rangeTo = etDateString(addETDays(today, config.advance_days_max ?? 14));
  const availability = await booking.buildBookingAvailability({
    lat: coords.lat, lng: coords.lng, duration, rangeFrom, rangeTo, config, today,
  });
  return {
    status: 'ok',
    availability,
    summary: null,
    offerContext: { lat: coords.lat, lng: coords.lng, duration, timeOfDay: 'any', expandOpenDays: false },
  };
}

function availabilityResultToText(res, ctx = {}) {
  if (res.status === 'unavailable') {
    return 'Live scheduling is not available right now. Do NOT quote any times — tell the caller a Waves team member will call to schedule, and capture the lead.';
  }
  if (res.status === 'need_location') {
    return 'Could not determine the service location. Ask the caller for their street address or ZIP code, then call this tool again.';
  }
  const list = formatSlots(res.availability && res.availability.slots, 4, ctx.rememberSlot, res.offerContext);
  if (!list) {
    return `${res.summary ? res.summary + ' ' : ''}No open times in that window. Tell the caller a Waves team member will call to find a time that works, and capture the lead.`;
  }
  return (
    `${res.summary ? res.summary + ' ' : ''}Open times: ${list}. ` +
    'NOTHING IS BOOKED YET — read the caller two or three of these options and let them pick. ' +
    'After they choose, tell them a Waves team member will call to confirm and lock it in (set WHEN ' +
    'from the latest CLOCK DATA — never "shortly" while the office is closed), ' +
    'then call capture_lead with their chosen time in preferred_date_time. Do not promise the slot is reserved. ' +
    'If you place a booking request, pass back the slot_ref of the option they picked — never a date you typed yourself.'
  );
}

/**
 * The disclosure tier the ANI match itself earned — 'full' ONLY when the
 * calling number is the account's OWN `customers.phone`. A match on one of the
 * service-contact slots (a lead-dedup column set that holds spouses, tenants
 * and prior occupants) recognises the account but authenticates nobody, so it
 * caps at 'redacted'.
 *
 * FAIL CLOSED: an absent/unknown tier on the session ctx is 'redacted'.
 */
function matchedCallerTier(ctx = {}) {
  return ctx.customerTier === 'full' ? 'full' : 'redacted';
}

/**
 * ⭐ THE READS THAT NEED THE CARRIER'S WORD, NOT JUST THE CALLER ID.
 *
 * Owner ruling 2026-08-12 (split tier). An ANI match still makes the agent a
 * receptionist who knows you — your name, your appointments, today's ETA, your
 * estimates, your service history all ride on it, because demanding attestation
 * for those would make her a stranger to most real customers (plenty of carriers
 * sign nothing).
 *
 * But caller ID is spoofable, and these four reads are where a spoof pays: what
 * you owe to the cent, the contents of your texts, what was said on your calls,
 * and the detail of what a technician found inside your home. Those need
 * STIR/SHAKEN attestation A — the carrier vouching that the caller owns the
 * number — and without it the agent says a human will follow up.
 *
 * FAIL CLOSED: an absent flag is "not attested".
 */
// The value is WHICH recognised callers the rule bites, because these two
// families draw their boundary differently. Invoices and service reports are
// account reads gated on the FULL tier, so attestation is the second lock on the
// one tier that opens them. Call and message history are ANI-SCOPED at every
// tier — the calling number IS the key, not the account — so for those the
// spoofable thing is the only thing, and attestation is required of anyone the
// session recognised at all.
const ATTESTATION_ONLY_TOOLS = {
  get_invoice_history: 'full-tier',
  get_service_report: 'full-tier',
  get_call_history: 'any-tier',
  get_message_history: 'any-tier',
};

function callerAttested(ctx = {}) {
  return ctx.callerAttested === true;
}

/**
 * Execute a tool call. Returns a short string (the tool_result content) telling
 * the model what happened so it can respond to the caller naturally.
 *
 * ctx: { from, to, callSid, language, markCaptured(), customerId, customerTier }
 * (customerId is the ANI-matched customer for this session, or null;
 * customerTier is 'full' | 'redacted' — see matchedCallerTier.)
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
      // ⭐ THE SPLIT TIER, ENFORCED BEFORE THE READ RUNS — not inside each tool,
      // so a new sensitive tool cannot be added without deciding which side of
      // this line it sits on. A matched caller whose carrier will not vouch for
      // the number gets the same answer a stranger would: a human follows up.
      // (The per-tool tier rules still run underneath; this only ever subtracts.)
      // It only bites a caller the session actually RECOGNISED. An unmatched or
      // wrong-tier caller is already refused by each tool's own rule, with the
      // reason that fits their case — this gate exists to subtract from the
      // callers who would otherwise have passed, and it must not restate
      // somebody else's refusal in worse words.
      const attestationScope = ATTESTATION_ONLY_TOOLS[name];
      const wouldHavePassed = !!ctx.customerId
        && (attestationScope === 'any-tier' || matchedCallerTier(ctx) === 'full');
      if (attestationScope && wouldHavePassed && !callerAttested(ctx)) {
        logger.info(
          `[voice-relay] ${name} withheld — caller not attestation-A callSid=${ctx.callSid || 'n/a'} `
          + `tier=${matchedCallerTier(ctx)}`
        );
        return 'That detail is not available on this call. Tell the caller you can see their account but cannot go '
          + 'through invoice amounts, past messages, call notes or report details over the phone, and that a Waves '
          + 'team member will follow up — they can also see all of it signed in to their portal. Do not explain why.';
      }
      // Pricing is PUBLIC website information (owner ruling, Phase B): any
      // caller — including a brand-new prospect — may be quoted engine output.
      if (name === 'get_pricing') {
        return await relayContext.pricingText(input);
      }
      // The service catalog is public information too (same rationale as
      // pricing): no tier gate beyond the context gate, names only.
      if (name === 'get_services_catalog') {
        return await relayContext.servicesCatalogText();
      }
      // Phase E: an ANI-matched EXISTING customer reporting a problem between
      // visits goes to the re-service lane (a service_requests row on their
      // account), NOT the new-business lead pipeline. Matched-caller only —
      // the body re-checks. Unmatched callers keep using capture_lead.
      if (name === 'request_reservice') {
        const { requestReserviceText } = require('./relay-reservice');
        return await requestReserviceText(input, ctx);
      }
      // lookup_customer: find any account (spouse/landlord/parent calling
      // about a shared one). Output shaping + the session ref registry
      // (ctx.rememberLookup) keep this from ever dumping a record.
      if (name === 'lookup_customer') {
        return await relayContext.lookupCustomersText(input, ctx);
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
        // The full-tier customer arm rides along (ANI == customers.phone at
        // that tier, so the customer thread IS this number's thread).
        return await relayHistory.messageHistoryText(ctx.from, { customerId: ctx.customerId, tier: matchedCallerTier(ctx) });
      }
      // Invoices are ANI-matched-caller only: itemized billing detail belongs
      // to the account holder, and the redacted tier already withholds
      // amounts. No pay/receipt link or token ever rides the reply.
      if (name === 'get_invoice_history') {
        if (String(input.customer_ref || '').trim()) {
          return 'Invoice detail is only available for the account the caller\'s own phone number matches. '
            + 'For a looked-up account you can say only whether a balance is open, never amounts.';
        }
        if (!ctx.customerId) {
          return 'No customer account matches the number this call is coming from, so there are no invoices '
            + 'to read. Do NOT guess at amounts owed. Offer to have the office follow up, and capture the lead.';
        }
        const { invoiceHistoryText } = require('./relay-money');
        return await invoiceHistoryText(ctx.customerId, { tier: matchedCallerTier(ctx) });
      }
      // get_service_report is per-visit detail — strictly MORE than the visit
      // summary the redacted tier already withholds, so it is matched-caller
      // only. (Property-specific findings belong to the account holder.)
      if (name === 'get_service_report') {
        if (String(input.customer_ref || '').trim()) {
          return 'Visit reports are only available for the account the caller\'s own phone number matches. '
            + 'For a looked-up account you can confirm visit dates and service names, nothing further.';
        }
        if (!ctx.customerId) {
          return 'No customer account matches the number this call is coming from, so there is no visit report '
            + 'to read. Do NOT describe any visit. Offer to have the office follow up, and capture the lead.';
        }
        const { serviceReportText } = require('./relay-visit');
        return await serviceReportText(ctx.customerId, {
          visitDate: input.visit_date,
          service: input.service,
          tier: matchedCallerTier(ctx),
        });
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
      let tier = 'redacted';
      const ref = String(input.customer_ref || '').trim();
      if (ref) {
        const looked = typeof ctx.resolveLookupRef === 'function' ? ctx.resolveLookupRef(ref) : null;
        if (!looked) {
          return 'That customer_ref is not from a lookup_customer result on this call. Call lookup_customer '
            + 'first; never invent or reuse a reference. Do not share or guess any account details.';
        }
        targetCustomerId = looked;
        // Even a ref that resolves to the caller's OWN matched account can only
        // reach the tier the ANI match itself earned (see matchedCallerTier).
        tier = ctx.customerId && looked === ctx.customerId ? matchedCallerTier(ctx) : 'redacted';
      } else {
        if (!ctx.customerId) {
          return 'No customer account matches the number this call is coming from. Do NOT share, confirm, or '
            + 'guess any account details. If they are calling about someone else\'s account, use lookup_customer; '
            + 'otherwise offer to have the office call them back, and capture the lead.';
        }
        targetCustomerId = ctx.customerId;
        tier = matchedCallerTier(ctx);
      }
      // The overview is receptionist-level and rides the ANI match — except the
      // balance FIGURE, which is the same number get_invoice_history is gated
      // on, so it takes the same attestation (relay-context redacts just that
      // line). Without this the split tier had a second door to the amount.
      if (name === 'get_account_overview') {
        return await relayContext.accountOverviewText(targetCustomerId, { tier, attested: callerAttested(ctx) });
      }
      // History dates/names ride the ANI match; the visit SUMMARIES are report
      // detail and take the same attestation lock as get_service_report — the
      // helper drops just that line when the carrier will not vouch.
      if (name === 'get_service_history') {
        return await relayContext.serviceHistoryText(targetCustomerId, { tier, attested: callerAttested(ctx) });
      }
      if (name === 'get_today_eta') {
        const { todayEtaText } = require('./relay-visit');
        return await todayEtaText(targetCustomerId, { tier });
      }
      if (name === 'get_open_estimates') {
        const { openEstimatesText } = require('./relay-money');
        return await openEstimatesText(targetCustomerId, { tier });
      }
    }
    if (name === 'capture_lead') {
      // Robocall/spam: do NOT write it to the lead pipeline (createLeadFromExtraction
      // records any truthy quality as a normal lead). Suppress the hangup capture
      // floor too so it doesn't write a fallback lead for the same call.
      if (input.lead_quality === 'spam') {
        // Floor suppressed, but NO lead exists — the transcript stamp must say so.
        if (typeof ctx.markCaptured === 'function') ctx.markCaptured({ leadCreated: false });
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
      // ⭐ SCRUBBED AT THE SOURCE, FAIL CLOSED. The free-text capture fields
      // are model-relayed caller speech headed for durable rows
      // (leads.transcript_summary, extracted_data, lead_activities.metadata)
      // — a caller reading a card number aloud must never persist a PAN there
      // (the transcript and alert copies scrub separately and do not cover
      // these writes). An unscrubbable field is dropped, never stored raw.
      const scrubbedField = (value) => {
        if (value == null || String(value).trim() === '') return null;
        try {
          const { scrubPans } = require('../../utils/pan-scrub');
          return scrubPans(String(value));
        } catch {
          return '[detail unavailable]';
        }
      };
      // EVERY unconstrained model-authored string takes the scrub — the model
      // classifies caller speech into whichever field fits, so a card number
      // can land in the scheduling note or the address as easily as the
      // summary. (contact_preference is scrubbed at ITS source in
      // lead-from-extraction, where the verbatim text first persists; the
      // opt-out classifier above reads input.contact_preference directly and
      // is unaffected.)
      const extracted = {
        first_name: scrubbedField(input.first_name),
        last_name: scrubbedField(input.last_name),
        email: scrubbedField(input.email),
        address_line1: scrubbedField(input.address_line1),
        city: scrubbedField(input.city),
        zip: scrubbedField(input.zip),
        requested_service: scrubbedField(input.requested_service),
        matched_service: null,
        preferred_date_time: scrubbedField(input.preferred_date_time),
        pain_points: scrubbedField(input.pain_points),
        call_summary: scrubbedField(input.call_summary),
        lead_quality: LEAD_QUALITIES.includes(input.lead_quality) ? input.lead_quality : null,
        // Phase E — a PREFERENCE is captured for a human to action; nothing
        // here starts messaging anyone, changes a channel, or grants consent.
        // The one exception is directly below: an explicit "stop texting me"
        // is honoured immediately, because the only thing that write can do is
        // STOP messages.
        contact_preference: input.contact_preference || null,
        preferred_contact_method: input.preferred_contact_method || null,
        do_not_contact_request: input.do_not_contact_request === true,
      };
      // ⭐ AN EXPLICIT VERBAL OPT-OUT IS HONOURED, NOT JUST FILED.
      //
      // This used to land only in `leads.extracted_data` for a human to read.
      // A caller who says "stop texting me" has withdrawn consent the moment
      // they say it, and every automated SMS path between that call and
      // whenever someone opens the lead would still have treated them as
      // contactable — the TCPA/consent rule in AGENTS.md is not satisfied by a
      // note in a JSON blob. So it goes through `recordSuppression`, the same
      // canonical writer the inbound STOP webhook uses, with its own reason so
      // the source is auditable and an admin can clear it exactly like any
      // other record. This is the ONLY consent write the agent makes and it is
      // one-directional: it can stop messages, never start them (nothing here
      // ever calls clearSuppression).
      // ⭐ ROUTED BY CHANNEL. `messaging_suppression` is phone-keyed: writing it
      // stops TEXTS. "Stop emailing me" sets the same boolean, so applying it
      // here would silence a customer's appointment reminders — an opt-out they
      // never asked for — while the email they DID ask about kept sending. So
      // an EMAIL-ONLY request writes nothing and stays a human's to action, the
      // same as every other stated preference in this lane; a general "stop
      // contacting me" still takes the SMS suppression (the one channel this
      // platform sends automatically) with its email half explicitly pending.
      // ⭐ A NEGATED STOP IS A REQUEST TO CONTINUE. "Don't stop texting me" and
      // "never stop the reminders" each begin with a word the classifier
      // treats as a stop verb, and the inner "stop texting" would classify as
      // an SMS withdrawal — silencing exactly the channel the caller asked to
      // KEEP. The negation pair is rewritten to a neutral verb BEFORE clause
      // extraction, so neither the outer nor the inner verb can seed a stop
      // clause. (Scoped to stop-verb pairs only: a lone "don't text me" is
      // still a real stop.)
      // The negation can sit a few INTENT words away from the verb: "I don't
      // WANT TO stop receiving texts" negates the stop just as surely as
      // "don't stop texting me". The gap admits only a short whitelist of
      // intent/filler words — never punctuation, never arbitrary text — so a
      // real stop in a later clause ("do not call me. stop texting") can't be
      // swallowed by a negator two clauses back.
      const NEGATED_STOP_RE = /\b(?:don'?t|do not|never|not)\s+(?:(?:ever|really|actually|want(?:ed)?|wanna|wish(?:ed)?|liked?|intend(?:ed)?|plan(?:ned)?|meant?|need(?:ed)?|cared?|going|trying|tried|to)\s+){0,4}(?:stop|quit|cease|unsubscribe|remove|opt\s+(?:me|us)?\s*out)\b/gi;
      const preferenceText = String(input.contact_preference || '').replace(NEGATED_STOP_RE, 'KEEP');
      const mentionsEmail = /\bemail(s|ing)?\b/i.test(preferenceText)
        || String(input.preferred_contact_method || '') === 'email';
      // The channels named, kept apart: "stop calling me" is a PHONE opt-out and
      // suppressing SMS for it silences texts the caller never mentioned, the
      // same over-application as the email case. Only a text/SMS request — or a
      // genuinely broad "stop contacting me at all" — writes the phone-keyed
      // messaging suppression.
      // ⭐ THE CHANNEL THEY ASKED TO STOP — read from the STOP CLAUSE ALONE.
      //
      // Two sentences with the same words in different clauses mean opposite
      // things: "stop texting me; call my husband instead" IS an SMS
      // withdrawal, and "stop emailing me, contact me by text instead" is not.
      // Proximity matching cannot tell them apart (both put a stop word within
      // a few words of a texting word), and a blanket "names a wanted channel"
      // veto silenced the first one — dropping an explicit withdrawal of
      // consent. So the stop verb's OWN clause is what decides: everything from
      // the stop word to the next clause boundary, with the replacement channel
      // that follows deliberately out of scope.
      // ⭐ AND "OPT ME OUT" IS A STOP VERB. The list was built from the imperative
      // phrasings ("stop", "don't", "take me off") and missed the one people
      // borrow from the messages themselves: "opt me out of texts", "I no longer
      // want texts". Neither matched, so an explicit, unambiguous withdrawal of
      // SMS consent classified as "no stop clause at all" and left the caller
      // fully text-eligible — the exact failure the TCPA/consent rule exists to
      // prevent.
      // ⭐ "NEVER" IS A STOP VERB TOO — and it is the most emphatic one a caller
      // has. "Never text me again" produced no stop clause at all, so the single
      // clearest withdrawal in the list read as naming no channel and left the
      // texts running.
      // ⭐ AND "LEAVE ME ALONE" HAS TO GET IN THE DOOR FIRST. The total-stop test
      // below already recognised the idiom, but nothing could ever hand it one:
      // clauses only exist where STOP matches, so the branch was unreachable and
      // the plainest total opt-out there is recorded nothing.
      // "take my number/phone number/info off" is the same verb as "take me
      // off" with the thing being removed named in the middle — a short bounded
      // gap keeps it one clause and never crosses punctuation.
      const STOP = '(?:stop|no more|no longer|never|don\'?t|do not|quit|cease|remove'
        + '|unsubscribe|opt(?:\\s+(?:me|us))?\\s+out'
        + '|take (?:me|us|(?:my|our)[^,;.!?]{0,20}?) off|leave (?:me|us) alone)';
      // The carve-out a caller attaches to a stop: "…except by text", "…only
      // text me". What follows one of these words is a channel they KEPT, and
      // it can sit inside the stop clause or just past its boundary.
      const EXCEPT = '(?:except(?:\\s+for)?|other than|besides|apart from|unless|only)';
      const EXCEPT_INLINE = new RegExp(`\\s+\\b${EXCEPT}\\b`, 'i');
      const EXCEPT_HEAD = new RegExp(`^[\\s,;.!?—–]*\\b${EXCEPT}\\b`, 'i');
      // ⭐ EVERY STOP CLAUSE, NOT JUST THE FIRST. A caller can name more than
      // one: "don't email me, don't text me" puts the SMS withdrawal in the
      // SECOND clause, and reading only the first classified the whole request
      // as email-only — leaving running exactly the texts they stopped. Each
      // clause still ends at its own boundary, so a replacement channel
      // ("…, text me instead") stays outside the clause that stopped anything.
      //
      // ⭐ AND EACH CLAUSE SPLITS INTO STOPPED vs KEPT. "Do not contact me
      // except by text" names texting INSIDE the stop clause while asking for
      // precisely that channel — reading the clause as one string turned a
      // request FOR texts into a withdrawal OF them, silencing the only channel
      // the caller left open. The exception marker is the seam: everything
      // before it is what they stopped, everything after is what they kept, and
      // the kept half can only ever VETO a suppression, never cause one.
      const stopClauses = (() => {
        const out = [];
        const re = new RegExp(`\\b${STOP}\\b`, 'gi');
        let m = re.exec(preferenceText);
        while (m) {
          const rest = preferenceText.slice(m.index);
          // ⭐ A PLAIN "and" CAN INTRODUCE THE REPLACEMENT CHANNEL. "stop
          // emailing me and text me instead" has no punctuation, so only the
          // trailing "instead" cut — leaving "text me" inside the stopped half
          // and suppressing the channel the caller just chose. An "and"
          // followed by a BASE-form channel verb + me/us is a new imperative
          // (the replacement) and ends the stop clause; a gerund continuation
          // ("stop texting and calling me") shares the stop verb and stays one
          // clause.
          const cut = rest.search(/[,;.!?—–]|\s+\b(?:but|instead|and then|rather)\b|\s+\band\s+(?:please\s+)?(?:text|message|call|phone|email|e-?mail|reach|contact)\s+(?:me|us)\b/i);
          let stopped = cut === -1 ? rest : rest.slice(0, cut);
          // A carve-out survives the clause boundary — "don't contact me, except
          // by text" puts it after the comma — so the text just past the cut is
          // read too, and only when it actually opens with an exception word.
          const after = cut === -1 ? '' : rest.slice(cut);
          let kept = EXCEPT_HEAD.test(after) ? after.split(/[;.!?]/)[0] : '';
          const inline = stopped.search(EXCEPT_INLINE);
          if (inline !== -1) {
            kept = `${stopped.slice(inline)} ${kept}`;
            stopped = stopped.slice(0, inline);
          }
          out.push({ stopped, kept });
          m = re.exec(preferenceText);
        }
        return out;
      })();
      // ⭐ "NEVER RECEIVED" IS A DELIVERY COMPLAINT, NOT A WITHDRAWAL. Bare
      // "never"/"no longer" are stop verbs, so "I never received your text" and
      // "I no longer receive texts" produced text-bearing stop clauses and
      // silenced reminders for the caller REPORTING they miss them. A stop
      // clause whose verb phrase is receipt-shaped is discarded.
      // …and "don't"/"do not" head the same complaints: "I don't receive
      // texts" reports missing texts, it doesn't withdraw them.
      const RECEIPT_COMPLAINT_RE = /^(?:never|no\s+longer|no\s+more|don'?t|do\s+not|doesn'?t|didn'?t|wo?n'?t|can'?t|cannot)\s+(?:receiv\w*|got|get\b|gets|getting|hear\w*|heard|see|seen|saw|had)\b/i;
      // ⭐ "DON'T FORGET TO TEXT ME" IS A REQUEST FOR TEXTS. The idioms that
      // pair a negator with forget/fail/hesitate invert it — the clause asks
      // FOR the channel it names, and reading it as a stop suppressed exactly
      // what the caller just requested.
      const POSITIVE_INTENT_DONT_RE = /^(?:don'?t|do\s+not|never)\s+(?:ever\s+)?(?:forget|fail|hesitate|be\s+(?:afraid|shy))\b/i;
      const actionableStopClauses = stopClauses.filter((c) => {
        const head = String(c.stopped || '').trim();
        return !RECEIPT_COMPLAINT_RE.test(head) && !POSITIVE_INTENT_DONT_RE.test(head);
      });
      const TEXTY = /\b(?:text|texts|texting|sms|message|messages|messaging)\b/i;
      // ⭐ "NO TEXTS" IS A STOP WITH NO STOP VERB. The bare channel negation —
      // "no texts", "no SMS", "no text messages please" — carries no word from
      // the STOP list, so it produced no clause and recorded nothing. It is its
      // own pattern; "no calls, text me instead" stays untouched (it negates
      // the CALL channel and keeps the texty one).
      // …and it must be IMPERATIVE, not descriptive: "I received no texts" and
      // "no text messages came through" are complaints about absence, not
      // withdrawals. The bare form counts only when it opens its own clause
      // (optionally after "please") and is not narrating what arrived.
      // Strict-tail on purpose: a trailing-verb LOOKAHEAD is bypassable by
      // backtracking ("text messages came" re-matching as "text" + leftovers),
      // so the imperative form is defined positively — the clause holds the
      // negation and at most a courtesy tail, nothing else.
      const BARE_NO_TEXTS_CLAUSE_RE = /^(?:please\s+)?no\s+(?:more\s+)?(?:texts?|sms|text\s+messages?)(?:\s+(?:please|thanks?|thank\s+you|anymore|at\s+all|to\s+(?:this|that|my)\s+number|to\s+me))?\s*$/i;
      const bareNoTexts = preferenceText
        .split(/[,;.!?—–]/)
        .some((clause) => BARE_NO_TEXTS_CLAUSE_RE.test(clause.trim()));
      // ⭐ WHOSE TEXTS? The suppression write is keyed to the CALLER's ANI, so
      // a stop clause about somebody ELSE — "stop texting my tenant", "don't
      // message her" — must never take it: it would silence the caller's own
      // reminders while the tenant's kept sending. A clause is third-party
      // scoped when it names another recipient and no first-person one; "stop
      // texting me and my husband" still includes the caller and suppresses,
      // and an unqualified "stop texting" stays the caller's own. Third-party
      // requests land on the lead for a human, like every instruction the
      // agent can't safely apply to the number it actually holds.
      const FIRST_PERSON_RE = /\b(?:me|us)\b|\b(?:my|our)\s+(?:number|phone|cell)\b/i;
      const THIRD_PARTY_RE = /\b(?:him|her|them)\b|\b(?:his|her|their)\s+(?:number|phone|cell)\b|\b(?:my|our|the)\s+(?:tenants?|husband|wife|spouse|partner|sons?|daughters?|kids?|child(?:ren)?|mother|father|mom|dad|parents?|brothers?|sisters?|roommates?|neighbou?rs?|landlords?|boyfriend|girlfriend|employees?|ex)\b/i;
      const thirdPartyScoped = (clause) => THIRD_PARTY_RE.test(clause) && !FIRST_PERSON_RE.test(clause);
      const statedSmsStop = actionableStopClauses.some((c) => TEXTY.test(c.stopped) && !TEXTY.test(c.kept) && !thirdPartyScoped(c.stopped))
        || bareNoTexts;
      // A total stop is any "stop <reaching me at all>" phrasing — and the
      // common ones do not say "contact": "remove my number", "don't bother me
      // anymore", "take me off your list". It is NOT total when the same clause
      // scopes it to a non-SMS channel ("don't reach me by email"), which is
      // the inverse mistake: suppressing texts the caller never mentioned.
      // ⭐ "PHONE NUMBER" IS NOT A CHANNEL. "Remove my phone number from your
      // list" is the most literal total opt-out a caller can state, and a bare
      // \bphone\b veto read the word as call-channel scoping and left their
      // texts running. "Phone" only scopes the stop to CALLS when it is not the
      // noun-phrase "phone number".
      const NON_SMS_CHANNEL = /\b(?:e-?mail|mail|letter|post|call|calls|calling|phone(?!\s+number))\b/i;
      // EVERY total-stop pattern is clause-scoped — including the idioms. The
      // unscoped fallback searched the WHOLE instruction, so "do not contact me
      // by email" matched "do not contact" and suppressed texts the caller
      // never withdrew: the clause-aware channel check above was doing its job
      // and the fallback walked straight past it.
      // The kept channel vetoes the total stop as well: "don't contact me except
      // by text" is total in its stopped half and still must not switch off the
      // texts they asked to keep. ("…except by email" keeps no texty channel, so
      // it stays a real SMS withdrawal — they left email as the only way in.)
      const totalStop = actionableStopClauses.some((c) => (
        // "stop all communications" / "do not communicate with me" are the
        // formal registers of the same total withdrawal — the stem covers
        // communicate/communicating/communication(s).
        (/\b(?:contact|contacting|communicat\w*|reach|reaching|bother|bothering|number|list)\b/i.test(c.stopped)
          || /\b(?:leave (?:me|us) alone|take (?:me|us) off (?:your |the )?list|do not contact)\b/i.test(c.stopped))
        && !NON_SMS_CHANNEL.test(c.stopped)
        && !TEXTY.test(c.kept)
        // A total stop about somebody else ("take my tenant off your list")
        // is not the caller's withdrawal either.
        && !thirdPartyScoped(c.stopped)
      ));
      // ⭐ AND A BARE FLAG IS NOT EVIDENCE OF A CHANNEL. `contact_preference` is
      // optional, so `do_not_contact_request: true` with no words at all can be
      // the model's shorthand for "stop emailing me" just as easily as for
      // "stop everything" — and suppressing on that guess switches off
      // reminders the caller never withdrew. No words ⇒ no write: recorded for
      // a human, which is where every ambiguous instruction in this lane goes.
      const smsOptOut = statedSmsStop || totalStop;
      const emailOnlyRequest = !smsOptOut;
      if (input.do_not_contact_request === true && emailOnlyRequest) {
        logger.warn(
          `[voice-relay] verbal do-not-contact is NOT an unambiguous SMS stop callSid=${ctx.callSid || 'n/a'} `
          + `(classified: ${stopClauses.length} stop clause(s), none withdrawing SMS) `
          + '— no messaging suppression written (that would stop texts they did not ask to stop); recorded on the '
          + 'lead for a human. The instruction itself is NOT logged: it is caller free text and can carry a name, '
          + 'a number or an address (AGENTS.md PII rule).'
        );
      }
      // ⭐ AND IT REQUIRES A VERIFIED CALL. This is the one write the agent makes
      // on the strength of the CALLING NUMBER alone, and suppression is
      // destructive in the quiet direction: whoever holds the leaked WS key
      // could declare a customer's number and switch off every automated text
      // they get — reminders included — with no call at all. Same boundary the
      // account tools sit behind: the setup-frame ANI must have matched the
      // signature-verified /voice call_log row (and cleared the attestation
      // rule, if it is on). Unverified ⇒ the request is still recorded on the
      // lead for a human; nothing is mutated.
      // ⭐ VERIFIED CALLS ONLY — AND ONLY WHILE THE CONTEXT GATE IS ON. Caller
      // verification is part of the context lane (the gate-off session makes no
      // DB read at all, which is the byte-identical-to-Phase-0 promise this
      // branch is pinned to), so with the gate OFF nothing here is verified and
      // nothing is suppressed: the request is recorded on the lead and a human
      // actions it, exactly as it did before this lane existed. The tool
      // description promises no more than that. Turning the suppression write
      // into a gate-off capability means running signed-call verification
      // outside the context gate — a deliberate change to that promise, and an
      // owner call, not a silent one.
      // ⭐ THE WORDS DECIDE, NOT AN OPTIONAL BOOLEAN. Suppression used to fire
      // only when `do_not_contact_request` was exactly true — a field the model
      // fills in at its own discretion, alongside the caller's verbatim words.
      // A caller who says "stop texting me" has withdrawn consent whether or not
      // the model remembered to tick a box, and TCPA does not care which of the
      // two the transcriber preferred. So the CLASSIFIER is the trigger; the
      // flag is one more way to arrive at it, never a precondition. (A bare flag
      // with no words still writes nothing — that case names no channel, which
      // is why `smsOptOut` stays false for it.)
      const optOutRequested = smsOptOut;
      // ⭐ THE RECORD AGREES WITH THE ACTION. The classifier — not the model's
      // optional boolean — is what triggers suppression now, so the persisted
      // lead data and the lifecycle-customer notification must say the same
      // thing: a caller whose "stop texting me" was honoured must never be
      // filed with `do_not_contact_request: false`, or the audit trail claims
      // no withdrawal happened while the canonical suppression is live.
      if (smsOptOut) extracted.do_not_contact_request = true;
      const callerVerified = ctx.callerVerified === true;
      if (optOutRequested && !callerVerified) {
        logger.warn(
          `[voice-relay] verbal do-not-contact from an UNVERIFIED session callSid=${ctx.callSid || 'n/a'} — no `
          + 'messaging suppression written (an unverified ANI must not be able to silence a customer\'s texts); '
          + 'recorded on the lead for a human'
        );
      }
      // Whether the SMS opt-out actually LANDED — threaded into the lead write
      // below so the human-facing record can distinguish "already stopped" from
      // "still needs you". Only a confirmed { ok: true } counts.
      let smsSuppressionApplied = false;
      if (optOutRequested && callerVerified) {
        try {
          const { recordSuppression } = require('../messaging/validators/suppression');
          // ⭐ IT RESOLVES ON FAILURE. recordSuppression catches its own DB
          // errors and returns { ok: false } — it does not reject — so an
          // un-inspected await here would log "honoured" over a caller whose
          // texts are still enabled. The flag is the only truth about whether
          // the opt-out actually landed.
          // ⭐ AND IT SUPPRESSES THE NUMBER THAT OPTED OUT, NOT THE CALLBACK.
          // `callerPhone` prefers the model-supplied callback_phone, which is
          // right for reaching the lead and WRONG here: the schema's own
          // example is "stop texting me, call my husband instead", so using it
          // would silence the husband's number and leave the caller's own
          // texts running — the exact inversion of what they asked for. The
          // withdrawal belongs to the number on the call.
          const optOutPhone = toE164(ctx.from || '') || callerPhone;
          // ⭐ capturedBody is caller free text headed for durable storage —
          // PAN-scrubbed like every other copy of it, failing closed to the
          // generic line (the suppression itself must still land).
          let capturedBody = 'Caller asked not to be contacted (voice agent).';
          if (input.contact_preference) {
            try {
              const { scrubPans } = require('../../utils/pan-scrub');
              capturedBody = scrubPans(String(input.contact_preference));
            } catch { /* keep the generic line */ }
          }
          const suppression = await recordSuppression({
            phone: optOutPhone,
            reason: 'opt_out_natural_language',
            source: 'voice_agent',
            capturedBody: capturedBody.slice(0, 300),
          });
          smsSuppressionApplied = !!(suppression && suppression.ok);
          if (suppression && suppression.ok) {
            // ⭐ SMS ONLY, AND THE LOG SAYS SO. `messaging_suppression` is
            // phone-keyed: it stops texts, and nothing else. A caller who said
            // "stop emailing me" has NOT been opted out of email by this write
            // — that ledger (`email_suppressions`, group-keyed) is a different
            // mechanism and a human's call, exactly like every other stated
            // preference in this lane. Logging it as "honoured" without that
            // distinction is how a half-done opt-out reads as a finished one.
            logger.info(
              `[voice-relay] verbal do-not-contact — SMS suppression recorded callSid=${ctx.callSid || 'n/a'}`
              + (mentionsEmail ? ' ⚠️ the caller also referenced EMAIL: that opt-out is NOT applied here and is pending a human' : '')
            );
          } else {
            logger.error(
              `[voice-relay] verbal do-not-contact NOT recorded callSid=${ctx.callSid || 'n/a'} `
              + `(${(suppression && suppression.error) || 'no ok flag'}) — automated texts are still enabled for this number`
            );
          }
        } catch (err) {
          // The lead still records the request; a failed suppression must not
          // lose the lead, and the owner alert below still pages a human.
          logger.error(`[voice-relay] verbal do-not-contact could NOT be recorded callSid=${ctx.callSid || 'n/a'}: ${err.message}`);
        }
      }
      // ⭐ THE OBLIGATION IS ESTABLISHED BEFORE THE LEAD COMMITS. Writing it
      // after left a gap: a process exit between the lead insert and the
      // marker stamp produced a durable hot lead with neither a receipt nor an
      // obligation the sweep could discover. Hotness is known from the input,
      // so a hot capture stamps relay_hot_alert_needed FIRST — a crash at any
      // later point leaves the sweep something to find (the lead-less branch
      // pages from the call row itself). Fail-soft; the lead write never
      // depends on it.
      // ⭐ NO OBLIGATION WITHOUT A LANE TO OWE IT TO. The sweep's recovery
      // carve-out deliberately bypasses the context gate so a rollback cannot
      // strand pages owed from when the lane WAS on — which means a marker
      // stamped while the gate is OFF would still page the owner through that
      // carve-out, breaking the gate-off zero-behavior promise. Only an
      // enabled lane creates the obligation; recovery then only ever replays
      // debts that were legitimate when incurred.
      const wasHotCapture = String(input.lead_quality || '').toLowerCase() === 'hot';
      if (wasHotCapture && ctx.callSid && require('./relay-context').isContextEnabled()) {
        try {
          const db = require('../../models/db');
          await db('call_log')
            .where({ twilio_call_sid: ctx.callSid })
            .update({
              metadata: db.raw(
                "COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
                [JSON.stringify({ relay_hot_alert_needed: 'true' })],
              ),
            });
        } catch (obligationErr) {
          logger.warn(`[voice-relay] hot-alert obligation pre-stamp failed callSid=${ctx.callSid}: ${obligationErr.message}`);
        }
      }
      const leadResult = await createLeadFromExtraction(extracted, {
        phone: callerPhone,
        // WHO this call is, kept separate from WHERE to call back: callerPhone
        // may be the alternate number the caller gave, and resolving identity
        // from that would attach this call to whoever else owns it. Only a
        // FULL-tier ANI match is an identity — a contact-slot recognition
        // authenticates nobody, so it stays a phone match like any other.
        identityCustomerId: matchedCallerTier(ctx) === 'full' ? (ctx.customerId || null) : null,
        // The caller's OWN number, so the lead lookup can tell "their history"
        // from "an unclaimed lead on somebody else's callback number".
        aniPhone: ctx.from || null,
        // …and whether that number is PROVEN or merely claimed. The setup
        // frame's ANI only authenticates after the call_log cross-check; a
        // session that failed it (or never settled) must resolve NO identity —
        // its lead stays unlinked. Live getter: a late-landing verification
        // upgrades this at read time.
        aniVerified: ctx.callerVerified === true,
        // The claim-owner nonce — the capture transaction re-proves ownership
        // against it inside its own lock (the atomic supersession check).
        sessionKey: ctx.sessionKey || null,
        // The lifecycle-customer notification must not tell staff "nothing was
        // changed" over a suppression that already landed.
        smsSuppressionApplied,
        toPhone: ctx.to || null,
        callSid: ctx.callSid || null,
        language: ctx.language || null,
      });
      // Thread the lead id into the session. A booking placed on THIS call
      // stamps it on the review card, so office confirm converts THIS lead —
      // outbound-review-confirm.js otherwise falls back to "the customer's
      // single active lead", which can convert an unrelated open quote to WON.
      // ⭐ A FAILED WRITE IS NOT A CAPTURE. The keyed fail-closed path (and a
      // superseded session) return explicit markers — neither may latch the
      // one-capture budget, stand the floor down, or let the model claim
      // anything was recorded.
      if (leadResult && leadResult.superseded) {
        return 'This session was superseded by a reconnect — NOTHING was saved. Do NOT call any more '
          + 'tools and do not answer account questions; say goodbye briefly.';
      }
      if (leadResult && leadResult.failed) {
        logger.error(`[voice-relay] capture_lead write FAILED callSid=${ctx.callSid || 'n/a'} — floor left armed, no capture claimed`);
        // A write that outlived the close drain settles HERE after the call
        // already finalized — nothing else would ever observe the failure.
        // The callback lets the session run its capture floor post-settlement
        // (the per-call lock + same-call reuse make that insert race-safe).
        if (typeof ctx.onCaptureFailed === 'function') {
          try { ctx.onCaptureFailed(); } catch { /* best-effort */ }
        }
        return 'The capture could NOT be saved just now — do NOT tell the caller anything was recorded. '
          + 'Keep their details in the conversation, finish helping them, and call capture_lead again '
          + 'before the call ends.';
      }
      const capturedLeadId = leadResult && leadResult.leadId;
      if (capturedLeadId && typeof ctx.noteLeadId === 'function') ctx.noteLeadId(capturedLeadId);
      // ⭐ EXACT CALL→LEAD PROVENANCE, ON THE CALL'S OWN ROW. leads only stamp
      // twilio_call_sid at INSERT — a reused lead keeps its original call — so
      // "find this call's lead by leads.twilio_call_sid" silently misses every
      // reuse. The linkage lives on call_log.metadata instead: relay_lead_id is
      // what the office-confirm recovery and the hot-alert sweep resolve
      // through, and relay_hot_alert_needed (written BEFORE the page attempt)
      // is the sweep's obligation marker — scoped to relay calls only, closing
      // the crash gap between the lead commit and the alert claim. Fail-soft:
      // the lead is the durable artifact and must never be lost to this stamp.
      // Written for ANY capture with provenance to record: a lifecycle customer
      // deliberately gets NO lead (leadId null), but a HOT call from them still
      // owes the owner a page — the obligation marker must not depend on a lead
      // existing, or a crashed page for an existing customer never sweeps.
      if (capturedLeadId && ctx.callSid) {
        try {
          const db = require('../../models/db');
          const linkage = { relay_lead_id: String(capturedLeadId) };
          await db('call_log')
            .where({ twilio_call_sid: ctx.callSid })
            .update({
              metadata: db.raw(
                "COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
                [JSON.stringify(linkage)],
              ),
            });
        } catch (linkErr) {
          logger.warn(`[voice-relay] call→lead linkage stamp failed callSid=${ctx.callSid}: ${linkErr.message}`);
        }
      }
      // capture_lead usually runs AFTER request_booking (the prompt says so),
      // so back-fill the card that was already written for this call.
      if (capturedLeadId && typeof ctx.bookingRequested === 'function' && ctx.bookingRequested()) {
        const { attachLeadToVoiceBookingCard } = require('./relay-booking');
        const attached = await attachLeadToVoiceBookingCard(ctx.callSid, capturedLeadId);
        // A failure here is not fatal and must not be silent: the confirm side
        // recovers the lead from this call's own CallSid, which is why the
        // backfill is allowed to be best-effort at all.
        if (!attached) {
          logger.warn(
            `[voice-relay] lead ${capturedLeadId} was NOT attached to the booking review card `
            + `callSid=${ctx.callSid || 'n/a'} — office confirm will recover it by CallSid`
          );
        }
      }
      // ⭐ NO LEAD IS A REAL OUTCOME, NOT A FAILURE — AND NOT A SUCCESS EITHER.
      // createLeadFromExtraction deliberately creates NOTHING for a matched
      // lifecycle customer (an ordinary support call must never overwrite a won
      // lead). The floor still stands down — a second attempt hits the same
      // guard and creates nothing — but the record must not claim a lead that
      // does not exist, and the model must not be told one was saved.
      const leadCreated = Boolean(capturedLeadId);
      if (typeof ctx.markCaptured === 'function') ctx.markCaptured({ leadCreated });
      // ⭐ A PROMISED ESTIMATE NEEDS AN ARTIFACT (codex #3569). A new lead IS
      // the artifact (the office works it). A lifecycle customer gets no lead,
      // so the promise would otherwise rest on a call summary nobody is paged
      // about — file the estimate-request card, and let the result below tell
      // the model whether the promise may be spoken.
      let estimateQueued = null; // null = not requested; true/false = requested and (not) persisted
      if (input.estimate_requested === true) {
        if (leadCreated) {
          estimateQueued = true;
        } else if (leadResult && leadResult.customerId) {
          const { surfaceEstimateRequestForCustomer } = require('../lead-from-extraction');
          const surfaced = typeof surfaceEstimateRequestForCustomer === 'function'
            ? await surfaceEstimateRequestForCustomer(leadResult.customerId, extracted, { callSid: ctx.callSid || null })
            : { persisted: false };
          estimateQueued = surfaced && surfaced.persisted === true;
        } else {
          estimateQueued = false;
        }
      }
      const estimateNote = estimateQueued === true
        ? ' The estimate request IS on the office queue: you may tell the caller a written estimate will be '
          + 'sent — set WHEN from the latest CLOCK DATA, never a time you cannot know.'
        : (estimateQueued === false
          ? ' IMPORTANT: the estimate request could NOT be queued — do NOT promise a written estimate. Say a '
            + 'Waves team member will follow up, nothing stronger.'
          : '');
      logger.info(
        `[voice-relay] capture_lead ${leadCreated ? 'saved' : 'recorded with NO lead (existing customer)'} `
        + `callSid=${ctx.callSid || 'n/a'}`
      );
      // The model's own one-line summary becomes call_log.call_summary at
      // session close — no second LLM round trip on the live call path.
      if (typeof ctx.noteCallSummary === 'function') ctx.noteCallSummary(input.call_summary);
      // Urgent/hot lead → INTERNAL owner alert, once per call, fail-open.
      // Deliberately AFTER the lead write: the lead is the durable artifact and
      // must never be lost to an alert failure. Never customer-facing.
      const { alertOwnerHotLead } = require('./relay-alert');
      const ownerPaged = await alertOwnerHotLead({
        ...extracted, phone: callerPhone, urgency_reason: input.urgency_reason || null,
        // The deep link on the owner page — the alert body masks numbers, so
        // the lead page is where the callback number lives.
        leadId: capturedLeadId || null,
      }, ctx);
      // ⭐ THE MODEL ONLY PROMISES A PAGE THAT WENT OUT. The prompt lets her tell
      // a hot caller "a team member is being notified right away" — and this
      // call used to discard the boolean that says whether anyone actually was
      // (ADAM_PHONE unset, or the internal-alert redirect had nowhere to put
      // it). A hot lead whose page did not go out — and was not already paged
      // earlier on this call — gets the promise explicitly withdrawn in the
      // tool result, which is where the model reads what really happened.
      const wasHot = String(input.lead_quality || '').toLowerCase() === 'hot';
      const alreadyPaged = typeof ctx.isOwnerAlerted === 'function'
        ? ctx.isOwnerAlerted() === true
        : ctx.ownerAlerted === true;
      // ⭐ THE MODEL IS TOLD WHAT THE TOOL DID. The prompt only permits telling
      // a caller their texts are stopped when this result SAYS the opt-out was
      // applied — without it Sandy either denied a suppression that happened
      // (false consent status) or promised one that failed.
      const suppressionNote = smsSuppressionApplied
        ? ' The SMS opt-out WAS applied: you may tell the caller text messages to this number have been '
          + 'stopped. Any email or broader contact preference still goes to a human.'
        : '';
      const pageCaveat = wasHot && !ownerPaged && !alreadyPaged
        ? ' IMPORTANT: the urgent page to the team could NOT be confirmed — do NOT tell the caller a team '
          + 'member is being notified right away. Say a Waves team member will follow up as soon as possible, '
          + 'nothing stronger.'
        : '';
      if (!leadCreated) {
        return 'Noted on this customer\'s account — this is an existing customer, so no new lead was created and '
          + 'none should be. The call and your summary are on their record for the office to review. Tell the caller '
          + 'a Waves team member will follow up, and do not say a new request or appointment was created.'
          + suppressionNote + pageCaveat + estimateNote;
      }
      return 'Lead saved successfully. Let the caller know a Waves team member will follow up to confirm '
        + 'details and scheduling — set WHEN from the latest CLOCK DATA (never "shortly" while the office '
        + 'is closed).' + suppressionNote + pageCaveat + estimateNote;
    }

    if (name === 'get_availability') {
      const res = await resolveAvailability({ address_line1: input.address_line1, city: input.city, zip: input.zip });
      return availabilityResultToText(res, ctx);
    }

    if (name === 'find_slots') {
      if (!input.when) return 'Ask the caller what day or timeframe they prefer, then call find_slots with that.';
      const res = await resolveAvailability({ when: input.when, address_line1: input.address_line1, city: input.city, zip: input.zip });
      return availabilityResultToText(res, ctx);
    }

    // The name is MODEL-supplied; bound and flatten it rather than echoing an
    // arbitrary string straight back into the tool result.
    return `Unknown tool "${String(name || '').replace(/[^\w.-]/g, '').slice(0, 40)}". Do not retry; continue the conversation.`;
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

module.exports = { TOOLS, CONTEXT_TOOLS, BOOKING_TOOLS, activeTools, executeTool, speakSlot, formatSlots, resolveAvailability, availabilityResultToText, matchedCallerTier };
