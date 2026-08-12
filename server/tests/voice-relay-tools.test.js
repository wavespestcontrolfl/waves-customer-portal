/**
 * Voice-relay tools — Phase 1 read-only quoting + Phase 0 capture.
 * Verifies the tools call the shared booking engine, format slots for speech,
 * stay read-only, and respect the selfBooking gate.
 */
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
jest.mock('../routes/booking', () => ({
  _internals: {
    loadBookingConfig: jest.fn(),
    resolveBookingCoords: jest.fn(),
    buildBookingAvailability: jest.fn(),
    MAX_BOOKING_HORIZON_DAYS: 90,
  },
}));
jest.mock('../services/scheduling/parse-when', () => ({ parseWhen: jest.fn(), summarizeWindow: jest.fn() }));

const { TOOLS, CONTEXT_TOOLS, activeTools, executeTool, speakSlot, formatSlots } = require('../services/voice-agent/relay-tools');
const { isEnabled } = require('../config/feature-gates');
const booking = require('../routes/booking')._internals;
const { parseWhen, summarizeWindow } = require('../services/scheduling/parse-when');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');

const CONFIG = { advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60, day_start: '08:00', day_end: '17:00' };
const SLOTS = [
  { date: '2026-07-01', start_label: '9:00 AM' },
  { date: '2026-07-01', start_label: '1:00 PM' },
  { date: '2026-07-02', start_label: '10:00 AM' },
];

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(true);
  booking.loadBookingConfig.mockResolvedValue(CONFIG);
  booking.resolveBookingCoords.mockResolvedValue({ lat: 27.4, lng: -82.5 });
  booking.buildBookingAvailability.mockResolvedValue({ slots: SLOTS, days: [{ slots: SLOTS }], nearby: true, total_feasible: 3 });
});

describe('TOOLS surface', () => {
  test('exposes capture_lead + the two read-only quoting tools', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(['capture_lead', 'find_slots', 'get_availability']);
  });
  test('find_slots requires `when`; get_availability requires nothing', () => {
    expect(TOOLS.find((t) => t.name === 'find_slots').input_schema.required).toEqual(['when']);
    expect(TOOLS.find((t) => t.name === 'get_availability').input_schema.required).toEqual([]);
  });
});

describe('Phase 2 context tools gate (VOICE_RELAY_CONTEXT_ENABLED, fail-closed)', () => {
  const saved = process.env.VOICE_RELAY_CONTEXT_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    else process.env.VOICE_RELAY_CONTEXT_ENABLED = saved;
  });

  // ⭐ THE GATE-OFF PIN WAS VACUOUS. `expect(activeTools()).toEqual(TOOLS)`
  // compares the module's output to the module's own constant, so ANY schema
  // edit satisfied it — capture_lead silently gained four properties under it.
  // The pin is now a FROZEN SNAPSHOT: an independent description of what a
  // caller reaches with the gate off, which a schema edit must consciously
  // update.
  const GATE_OFF_TOOL_SURFACE = {
    capture_lead: {
      required: ['call_summary'],
      properties: [
        'address_line1', 'callback_phone', 'city', 'contact_preference', 'call_summary',
        'do_not_contact_request', 'email', 'first_name', 'last_name', 'lead_quality',
        'pain_points', 'preferred_contact_method', 'preferred_date_time', 'requested_service',
        'urgency_reason', 'zip',
      ],
    },
    find_slots: {
      required: ['when'],
      properties: ['address_line1', 'city', 'when', 'zip'],
    },
    get_availability: {
      required: [],
      properties: ['address_line1', 'city', 'zip'],
    },
  };

  function toolSurface(tools) {
    return Object.fromEntries(tools.map((t) => [t.name, {
      required: [...(t.input_schema.required || [])].sort(),
      properties: Object.keys(t.input_schema.properties || {}).sort(),
    }]));
  }

  function normalizedSnapshot(snapshot) {
    return Object.fromEntries(Object.entries(snapshot).map(([name, shape]) => [name, {
      required: [...shape.required].sort(),
      properties: [...shape.properties].sort(),
    }]));
  }

  test('gate off/absent/anything-but-true → the tool surface matches the frozen snapshot', () => {
    for (const value of [undefined, 'false', '1', 'TRUE ', 'yes']) {
      if (value === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
      else process.env.VOICE_RELAY_CONTEXT_ENABLED = value;
      const tools = activeTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['capture_lead', 'find_slots', 'get_availability']);
      expect(toolSurface(tools)).toEqual(normalizedSnapshot(GATE_OFF_TOOL_SURFACE));
      // No write tool and no account/pricing tool is reachable at all.
      for (const forbidden of ['request_booking', 'request_reservice', 'lookup_customer', 'get_pricing']) {
        expect(tools.map((t) => t.name)).not.toContain(forbidden);
      }
    }
  });

  // The prompt is what the caller actually experiences with the gate off, and
  // buildBasePrompt(false) alone does not cover the ASSEMBLED result — the
  // voice profile and every gate-on addendum compose on top of it.
  test('gate off → the ASSEMBLED system prompt carries no gate-on behavior', () => {
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    delete process.env.GATE_VOICE_AI_BOOKING;
    const { buildBasePrompt, composeSystemPrompt, SYSTEM_PROMPT } = require('../services/voice-agent/relay-conversation');
    // Assembled the way _runLoop assembles it, including a profile.
    const assembled = composeSystemPrompt(buildBasePrompt(false), 'Keep it warm and plain-spoken.');
    expect(assembled.startsWith(SYSTEM_PROMPT)).toBe(true);
    for (const gateOnMarker of [
      'ACCOUNT ACCESS RULES', 'KNOWN CALLER', 'CLOCK DATA', 'RECENT TEXTS',
      'BOOKING REQUESTS', 'request_reservice', 'lookup_customer', 'get_pricing',
      'get_account_overview', 'get_invoice_history', 'slot_ref', 'contact_preference',
      'urgency_reason', 'Sandy',
    ]) {
      expect(assembled).not.toContain(gateOnMarker);
    }
    // The Phase-1 price refusal is still exactly the line the gate swaps out.
    const { PRICE_LINE_NO_CONTEXT } = require('../services/voice-agent/relay-conversation');
    expect(assembled).toContain(PRICE_LINE_NO_CONTEXT);
    // A profile still composes on (it is style, not gate-on behavior).
    expect(assembled).toContain('VOICE PROFILE');
  });

  test('gate on → the read-only context tools register too', () => {
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    expect(activeTools().map((t) => t.name).sort()).toEqual(
      ['capture_lead', 'find_slots', 'get_account_overview', 'get_availability',
        'get_call_history', 'get_invoice_history', 'get_message_history', 'get_open_estimates',
        'get_pricing', 'get_service_history', 'get_service_report', 'get_services_catalog',
        'get_today_eta', 'lookup_customer', 'request_reservice']
    );
    expect(CONTEXT_TOOLS).toHaveLength(12);
  });

  test('gate off → executeTool refuses context tools outright', async () => {
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    const out = await executeTool('get_account_overview', {}, { customerId: 'c-1' });
    expect(out).toMatch(/not available/i);
  });
});

describe('slot formatting (speakable)', () => {
  test('speakSlot strips :00 and renders a spoken date+time', () => {
    expect(speakSlot({ date: '2026-07-01', start_label: '9:00 AM' })).toMatch(/July 1 at 9 AM$/);
  });
  test('formatSlots joins with "; " and caps at 4', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ date: '2026-07-0' + (i + 1), start_label: '9:00 AM' }));
    expect(formatSlots(many).split('; ')).toHaveLength(4);
  });
});

describe('get_availability', () => {
  test('selfBooking gate OFF → refuse to quote, no engine call', async () => {
    isEnabled.mockReturnValue(false);
    const out = await executeTool('get_availability', { city: 'Bradenton' }, {});
    expect(out).toMatch(/not available/i);
    expect(out).toMatch(/Do NOT quote/);
    expect(booking.buildBookingAvailability).not.toHaveBeenCalled();
  });

  test('no resolvable location → asks for address/ZIP', async () => {
    booking.resolveBookingCoords.mockResolvedValue({ lat: null, lng: null });
    const out = await executeTool('get_availability', { city: '' }, {});
    expect(out).toMatch(/address or ZIP/i);
    expect(booking.buildBookingAvailability).not.toHaveBeenCalled();
  });

  test('with coords → quotes real times and stays read-only', async () => {
    const out = await executeTool('get_availability', { address_line1: '123 Main St', city: 'Bradenton', zip: '34209' }, {});
    expect(out).toMatch(/Open times:/);
    expect(out).toMatch(/July 1 at 9 AM/);
    expect(out).toMatch(/NOTHING IS BOOKED/);
    // address assembled with FL appended; engine called; NO writes
    expect(booking.resolveBookingCoords).toHaveBeenCalledWith(expect.objectContaining({ address: '123 Main St, Bradenton, 34209, FL' }));
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
  });
});

describe('find_slots', () => {
  test('missing `when` → asks for a timeframe, no engine call', async () => {
    const out = await executeTool('find_slots', {}, {});
    expect(out).toMatch(/day or timeframe/i);
    expect(parseWhen).not.toHaveBeenCalled();
  });

  test('with `when` → parses NL window and quotes matching times', async () => {
    parseWhen.mockResolvedValue({ dateFrom: '2026-07-01', dateTo: '2026-07-05', timeOfDay: 'morning', understood: true });
    summarizeWindow.mockReturnValue('Next Thursday morning:');
    const out = await executeTool('find_slots', { when: 'next thursday morning', city: 'Venice' }, {});
    expect(parseWhen).toHaveBeenCalled();
    expect(booking.buildBookingAvailability).toHaveBeenCalledWith(expect.objectContaining({ timeOfDay: 'morning', expandOpenDays: true }));
    expect(out).toMatch(/^Next Thursday morning: Open times:/);
  });
});

describe('capture_lead (Phase 0 floor, unchanged)', () => {
  // ⭐ NO LEAD IS A REAL OUTCOME. createLeadFromExtraction deliberately creates
  // nothing for a matched lifecycle customer (an ordinary support call must
  // never overwrite a won lead) — so the model must not be told a lead was
  // saved, and the transcript must not be stamped as one, while the hangup
  // floor still stands down (a second attempt creates nothing either).
  test('an existing lifecycle customer → honest "no lead created", floor still suppressed', async () => {
    createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
    const markCaptured = jest.fn();
    const out = await executeTool(
      'capture_lead',
      { call_summary: 'asking about the last visit' },
      { from: '+19415551234', callSid: 'CA-lifecycle', markCaptured }
    );
    expect(out).toMatch(/no new lead was created/i);
    expect(out).not.toMatch(/Lead saved/);
    expect(markCaptured).toHaveBeenCalledWith(expect.objectContaining({ leadCreated: false }));
  });

  test('writes the lead, marks captured, drops invalid quality', async () => {
    // A REAL lead id back: capture_lead now distinguishes "lead created" from
    // "existing customer, deliberately no lead" (see the lifecycle test below).
    createLeadFromExtraction.mockResolvedValue({ leadId: 'lead-1', created: true });
    const markCaptured = jest.fn();
    const out = await executeTool(
      'capture_lead',
      { call_summary: 'ants in kitchen', first_name: 'Pat', lead_quality: 'bogus', preferred_date_time: 'Tue 9 AM' },
      { from: '+19415551234', to: '+19412691697', callSid: 'CA1', markCaptured }
    );
    expect(createLeadFromExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ call_summary: 'ants in kitchen', first_name: 'Pat', lead_quality: null, preferred_date_time: 'Tue 9 AM' }),
      expect.objectContaining({ phone: '+19415551234', toPhone: '+19412691697', callSid: 'CA1' })
    );
    expect(markCaptured).toHaveBeenCalledWith(expect.objectContaining({ leadCreated: true }));
    expect(out).toMatch(/Lead saved/);
  });
});
