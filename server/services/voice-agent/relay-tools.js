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
        do_not_contact_request: {
          type: 'boolean',
          description: 'True ONLY if the caller asked us to stop contacting them (or stop texting/emailing them). '
            + 'You do not act on this yourself and you do not promise anything about it — recording it here is '
            + 'what stops our automated texts, and a Waves team member reviews it.',
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
        visit_date: { type: 'string', description: 'The visit date as YYYY-MM-DD, exactly as get_service_history reported it. Omit for the most recent completed visit.' },
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
        lawn_tier: { type: 'string', enum: ['basic', 'standard', 'enhanced', 'premium'], description: 'Lawn program tier (default standard)' },
        mosquito_tier: { type: 'string', enum: ['seasonal9', 'monthly12'], description: 'Mosquito program (default monthly12)' },
        property_type: {
          type: 'string',
          enum: ['single_family', 'townhome_end', 'townhome_interior', 'duplex', 'condo_ground', 'condo_upper'],
          description: 'What kind of home it is, if the caller says. A condo or townhome prices lower than a '
            + 'house, so pass it when you know it. Omit when they have not said — it defaults to a single-family home.',
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
    'After they choose, tell them a Waves team member will call shortly to confirm and lock it in, ' +
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
        return await relayHistory.messageHistoryText(ctx.from);
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
      if (name === 'get_account_overview') return await relayContext.accountOverviewText(targetCustomerId, { tier });
      if (name === 'get_service_history') return await relayContext.serviceHistoryText(targetCustomerId, { tier });
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
      const preferenceText = String(input.contact_preference || '');
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
      const STOP = '(?:stop|no more|don\'?t|do not|quit|cease|remove|unsubscribe|take me off)';
      const stopClause = (() => {
        const m = new RegExp(`\\b${STOP}\\b`, 'i').exec(preferenceText);
        if (!m) return '';
        const rest = preferenceText.slice(m.index);
        // First clause boundary after the stop word: punctuation, a dash, or a
        // coordinating word that introduces the replacement.
        const cut = rest.search(/[,;.!?—–]|\s+\b(?:but|instead|and then|rather)\b/i);
        return cut === -1 ? rest : rest.slice(0, cut);
      })();
      const TEXTY = /\b(?:text|texts|texting|sms|message|messages|messaging)\b/i;
      const statedSmsStop = TEXTY.test(stopClause);
      // A total stop is any "stop <reaching me at all>" phrasing — and the
      // common ones do not say "contact": "remove my number", "don't bother me
      // anymore", "take me off your list". It is NOT total when the same clause
      // scopes it to a non-SMS channel ("don't reach me by email"), which is
      // the inverse mistake: suppressing texts the caller never mentioned.
      const NON_SMS_CHANNEL = /\b(?:e-?mail|mail|letter|post|call|calls|calling|phone)\b/i;
      const totalIdiom = /\b(?:contact|contacting|reach|reaching|bother|bothering|number|list)\b/i.test(stopClause)
        || /\b(?:leave me alone|take me off (?:your |the )?list|do not contact)\b/i.test(preferenceText);
      const totalStop = (totalIdiom && !NON_SMS_CHANNEL.test(stopClause))
        || !preferenceText.trim(); // a bare flag with no words = the total request
      const smsOptOut = statedSmsStop || totalStop;
      const emailOnlyRequest = !smsOptOut;
      if (input.do_not_contact_request === true && emailOnlyRequest) {
        logger.warn(
          `[voice-relay] verbal do-not-contact is NOT an unambiguous SMS stop callSid=${ctx.callSid || 'n/a'} `
          + `(classified: ${totalIdiom ? 'total-stop scoped to another channel' : 'no texting words in the stop clause'}) `
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
      const callerVerified = ctx.callerVerified === true;
      if (input.do_not_contact_request === true && !emailOnlyRequest && !callerVerified) {
        logger.warn(
          `[voice-relay] verbal do-not-contact from an UNVERIFIED session callSid=${ctx.callSid || 'n/a'} — no `
          + 'messaging suppression written (an unverified ANI must not be able to silence a customer\'s texts); '
          + 'recorded on the lead for a human'
        );
      }
      if (input.do_not_contact_request === true && !emailOnlyRequest && callerVerified) {
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
          const suppression = await recordSuppression({
            phone: optOutPhone,
            reason: 'opt_out_natural_language',
            source: 'voice_agent',
            capturedBody: String(input.contact_preference || 'Caller asked not to be contacted (voice agent).').slice(0, 300),
          });
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
      const leadResult = await createLeadFromExtraction(extracted, {
        phone: callerPhone,
        // WHO this call is, kept separate from WHERE to call back: callerPhone
        // may be the alternate number the caller gave, and resolving identity
        // from that would attach this call to whoever else owns it. Only a
        // FULL-tier ANI match is an identity — a contact-slot recognition
        // authenticates nobody, so it stays a phone match like any other.
        identityCustomerId: matchedCallerTier(ctx) === 'full' ? (ctx.customerId || null) : null,
        toPhone: ctx.to || null,
        callSid: ctx.callSid || null,
        language: ctx.language || null,
      });
      // Thread the lead id into the session. A booking placed on THIS call
      // stamps it on the review card, so office confirm converts THIS lead —
      // outbound-review-confirm.js otherwise falls back to "the customer's
      // single active lead", which can convert an unrelated open quote to WON.
      const capturedLeadId = leadResult && leadResult.leadId;
      if (capturedLeadId && typeof ctx.noteLeadId === 'function') ctx.noteLeadId(capturedLeadId);
      // capture_lead usually runs AFTER request_booking (the prompt says so),
      // so back-fill the card that was already written for this call.
      if (capturedLeadId && typeof ctx.bookingRequested === 'function' && ctx.bookingRequested()) {
        const { attachLeadToVoiceBookingCard } = require('./relay-booking');
        await attachLeadToVoiceBookingCard(ctx.callSid, capturedLeadId);
      }
      // ⭐ NO LEAD IS A REAL OUTCOME, NOT A FAILURE — AND NOT A SUCCESS EITHER.
      // createLeadFromExtraction deliberately creates NOTHING for a matched
      // lifecycle customer (an ordinary support call must never overwrite a won
      // lead). The floor still stands down — a second attempt hits the same
      // guard and creates nothing — but the record must not claim a lead that
      // does not exist, and the model must not be told one was saved.
      const leadCreated = Boolean(capturedLeadId);
      if (typeof ctx.markCaptured === 'function') ctx.markCaptured({ leadCreated });
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
      await alertOwnerHotLead({ ...extracted, phone: callerPhone, urgency_reason: input.urgency_reason || null }, ctx);
      if (!leadCreated) {
        return 'Noted on this customer\'s account — this is an existing customer, so no new lead was created and '
          + 'none should be. The call and your summary are on their record for the office to review. Tell the caller '
          + 'a Waves team member will follow up, and do not say a new request or appointment was created.';
      }
      return 'Lead saved successfully. Let the caller know a Waves team member will follow up shortly to confirm details and scheduling.';
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
