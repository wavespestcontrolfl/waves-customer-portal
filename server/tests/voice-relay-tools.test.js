/**
 * Voice-relay tools — Phase 1 read-only quoting + Phase 0 capture.
 * Verifies the tools call the shared booking engine, format slots for speech,
 * stay read-only, and respect the selfBooking gate.
 */
jest.mock('../services/lead-from-extraction', () => ({
  createLeadFromExtraction: jest.fn(),
  surfaceEstimateRequestForCustomer: jest.fn(async () => ({ persisted: true, suppressed: false })),
}));
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
        'do_not_contact_request', 'email', 'estimate_requested', 'first_name', 'last_name', 'lead_quality',
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
  // ⭐ SCRUBBED AT THE SOURCE. The free-text capture fields persist on durable
  // lead rows (transcript_summary, extracted_data, lead_activities.metadata)
  // — a spoken card number relayed by the model must be redacted BEFORE
  // createLeadFromExtraction ever sees it (the transcript/alert scrubs are
  // separate writers and do not cover these).
  test('a spoken card number never reaches the lead pipeline in any free-text field', async () => {
    createLeadFromExtraction.mockResolvedValue({ leadId: 'l-1', customerId: null, created: true });
    await executeTool(
      'capture_lead',
      {
        call_summary: 'Wants pest control; read out card 4111 1111 1111 1111 by mistake',
        pain_points: 'charged on 4111 1111 1111 1111 twice',
        requested_service: 'refund to 4111 1111 1111 1111',
        // The model classifies caller speech into WHICHEVER field fits —
        // the scheduling note and address are free text too.
        preferred_date_time: 'after the 4111 1111 1111 1111 charge clears',
        address_line1: 'unit 4111 1111 1111 1111 somewhere',
      },
      { from: '+19415551234', callSid: 'CA-pan-capture', markCaptured: jest.fn() },
    );
    const [extracted] = createLeadFromExtraction.mock.calls[0];
    const flat = JSON.stringify(extracted);
    expect(flat).not.toMatch(/4111[\s-]?1111[\s-]?1111[\s-]?1111/);
    expect(flat).toContain('[card ending 1111]'); // scrubbed, not dropped
  });

  // ⭐ A FAILED WRITE IS NOT A CAPTURE — the fail-closed keyed path must not
  // latch the one-capture budget or let the model claim anything was saved.
  test('a FAILED keyed capture never claims a capture — floor stays armed', async () => {
    createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: null, created: false, failed: true });
    const markCaptured = jest.fn();
    const out = await executeTool(
      'capture_lead',
      { call_summary: 'caller details' },
      { from: '+19415551234', callSid: 'CA-write-failed', markCaptured },
    );
    expect(out).toMatch(/could NOT be saved/i);
    expect(out).not.toMatch(/saved successfully/i);
    expect(markCaptured).not.toHaveBeenCalled();
  });

  // ⭐ A LATE-SETTLING FAILURE IS OBSERVED: the failed result fires the
  // session's onCaptureFailed callback, which re-runs the floor after the
  // call has closed (nothing else ever sees a post-drain failure).
  test('a FAILED capture fires onCaptureFailed for the post-close floor', async () => {
    createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: null, created: false, failed: true });
    const onCaptureFailed = jest.fn();
    await executeTool(
      'capture_lead',
      { call_summary: 'caller details' },
      { from: '+19415551234', callSid: 'CA-late-fail', markCaptured: jest.fn(), onCaptureFailed },
    );
    expect(onCaptureFailed).toHaveBeenCalled();
  });

  test('a SUPERSEDED capture tells the model to stand down entirely', async () => {
    createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: null, created: false, superseded: true });
    const markCaptured = jest.fn();
    const out = await executeTool(
      'capture_lead',
      { call_summary: 'caller details' },
      { from: '+19415551234', callSid: 'CA-superseded-cap', markCaptured },
    );
    expect(out).toMatch(/superseded by a reconnect/i);
    expect(markCaptured).not.toHaveBeenCalled();
  });

  test('a SPAM capture suppresses the floor WITHOUT claiming a lead', async () => {
    const markCaptured = jest.fn();
    const out = await executeTool(
      'capture_lead',
      { call_summary: 'auto warranty robocall', lead_quality: 'spam' },
      { from: '+19415551234', callSid: 'CA-spam', markCaptured }
    );
    expect(out).toMatch(/no lead created/i);
    expect(markCaptured).toHaveBeenCalledWith(expect.objectContaining({ leadCreated: false }));
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
  });

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

  // codex #3569: a promised written estimate needs an artifact. A new lead is
  // one; a lifecycle customer gets no lead, so the estimate-request card is —
  // and the promise is only authorized when that card actually persisted.
  describe('estimate_requested — the promise follows the artifact', () => {
    const { surfaceEstimateRequestForCustomer } = require('../services/lead-from-extraction');
    test('existing customer + card persisted ⇒ promise authorized, WHEN from CLOCK DATA', async () => {
      createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
      surfaceEstimateRequestForCustomer.mockResolvedValue({ persisted: true, suppressed: false });
      const relayContext = require('../services/voice-agent/relay-context');
      const spyCtx = jest.spyOn(relayContext, 'isContextEnabled').mockReturnValue(true);
      const out = await executeTool('capture_lead', { call_summary: 'wants a price for mosquito', estimate_requested: true, requested_service: 'mosquito', first_name: 'Pat', last_name: 'Lee', email: 'pat@example.com', address_line1: '12 Shell Dr' }, { from: '+19415551234', callSid: 'CA-est', officeOpenNow: () => true });
      spyCtx.mockRestore();
      expect(surfaceEstimateRequestForCustomer).toHaveBeenCalledWith('c-1', expect.objectContaining({ requested_service: 'mosquito', email: 'pat@example.com', address_line1: '12 Shell Dr' }), expect.objectContaining({ callSid: 'CA-est', spokenExpectation: 'about_15_minutes' }));
      expect(out).toMatch(/estimate request IS on the office queue/);
      expect(out).toMatch(/usually goes out in about 15 minutes/);
      expect(out).toMatch(/no new lead was created/i);
      expect(out).not.toMatch(/do not say a new request/); // no self-contradiction when queued
      expect(out).toMatch(/Do not say an appointment was created/);
    });
    test('existing customer + card NOT persisted ⇒ promise withdrawn', async () => {
      createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
      surfaceEstimateRequestForCustomer.mockResolvedValue({ persisted: false, suppressed: true });
      const out = await executeTool('capture_lead', { call_summary: 'wants a price', estimate_requested: true, first_name: 'Pat', last_name: 'Lee', email: 'pat@example.com', address_line1: '12 Shell Dr' }, { from: '+19415551234', callSid: 'CA-est2' });
      expect(out).toMatch(/could NOT be queued — do NOT promise a written estimate/);
    });
    test('new lead ⇒ the lead is the artifact; no card', async () => {
      createLeadFromExtraction.mockResolvedValue({ leadId: 'lead-9', created: true });
      surfaceEstimateRequestForCustomer.mockClear();
      const out = await executeTool('capture_lead', { call_summary: 'new caller wants a price', estimate_requested: true, first_name: 'Pat', last_name: 'Lee', email: 'pat@example.com', address_line1: '12 Shell Dr' }, { from: '+19415551234', callSid: 'CA-est3' });
      expect(surfaceEstimateRequestForCustomer).not.toHaveBeenCalled();
      // the obligation rides the lead artifact in the shape the Leads UI renders (sticky-on)
      expect(createLeadFromExtraction).toHaveBeenLastCalledWith(expect.objectContaining({ quote_requested: true, quote_promised: true }), expect.anything());
      expect(out).toMatch(/Lead saved/);
      expect(out).toMatch(/estimate request IS on the office queue/);
    });
    test('no matched customer and no lead ⇒ promise withdrawn', async () => {
      // (a FAILED capture returns its own "could not be saved" result before any promise; this is the
      // no-lead / no-customer outcome that reaches the estimate branch)
      createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: null, created: false });
      const out = await executeTool('capture_lead', { call_summary: 'x', estimate_requested: true, first_name: 'Pat', last_name: 'Lee', email: 'pat@example.com', address_line1: '12 Shell Dr' }, { from: '+19415551234', callSid: 'CA-est4' });
      expect(out).toMatch(/could NOT be queued/);
    });
    test('an INCOMPLETE capture never queues (hook P1): the result names the missing fields, no card, no promise', async () => {
      createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
      surfaceEstimateRequestForCustomer.mockClear();
      const markCaptured = jest.fn();
      const out = await executeTool('capture_lead', { call_summary: 'price?', estimate_requested: true, first_name: 'Pat' }, { from: '+19415551234', callSid: 'CA-est6', markCaptured });
      expect(surfaceEstimateRequestForCustomer).not.toHaveBeenCalled();
      expect(out).toMatch(/NOT queued yet — still missing: last_name, email, address_line1/);
      expect(markCaptured).toHaveBeenCalledWith(expect.objectContaining({ holdOpen: true })); // call stays open for the retry
      expect(out).toMatch(/If the caller declines to give it[\s\S]*WITHOUT estimate_requested/);
      // the caller declines ⇒ a capture WITHOUT the flag clears the hold so the call can end
      markCaptured.mockClear();
      await executeTool('capture_lead', { call_summary: 'price? declined email' }, { from: '+19415551234', callSid: 'CA-est6', markCaptured });
      expect(markCaptured).toHaveBeenCalledWith(expect.objectContaining({ holdOpen: false }));
      expect(out).toMatch(/Do NOT promise a written estimate yet/);
      expect(out).not.toMatch(/IS on the office queue/);
      // a NEW lead is not an estimate artifact either when the capture is incomplete
      createLeadFromExtraction.mockResolvedValue({ leadId: 'lead-2', created: true });
      const out2 = await executeTool('capture_lead', { call_summary: 'price?', estimate_requested: true, email: 'x@y.z' }, { from: '+19415551234', callSid: 'CA-est7' });
      expect(out2).toMatch(/still missing: first_name, last_name, address_line1/);
      expect(out2).not.toMatch(/IS on the office queue/);
      // requested but NOT promised — the lead shows "Quote requested on call" only
      expect(createLeadFromExtraction).toHaveBeenLastCalledWith(expect.objectContaining({ quote_requested: true, quote_promised: false }), expect.anything());
    });
    test('a malformed email counts as MISSING — never authorizes the promise', async () => {
      createLeadFromExtraction.mockResolvedValue({ leadId: 'lead-3', created: true });
      const markCaptured = jest.fn();
      const out = await executeTool('capture_lead', { call_summary: 'price?', estimate_requested: true, first_name: 'Pat', last_name: 'Lee', email: 'pat at example dot com', address_line1: '12 Shell Dr' }, { from: '+19415551234', callSid: 'CA-est8', markCaptured });
      expect(out).toMatch(/still missing: email/);
      expect(out).not.toMatch(/IS on the office queue/);
      // the garbled email never reaches the lead artifact
      expect(createLeadFromExtraction).toHaveBeenLastCalledWith(expect.objectContaining({ quote_promised: false, email: null }), expect.anything());
      expect(markCaptured).toHaveBeenCalledWith(expect.objectContaining({ holdOpen: true }));
    });
    test('a retry that supplies only the missing field keeps the earlier fields (session accumulation)', async () => {
      // stateful ctx like the real tool ctx
      let stash = {};
      const ctx = {
        from: '+19415551234', callSid: 'CA-est10', markCaptured: jest.fn(),
        getEstimateFields: () => ({ ...stash }),
        noteEstimateFields: (f) => { stash = { ...stash, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }; },
      };
      createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
      surfaceEstimateRequestForCustomer.mockClear();
      surfaceEstimateRequestForCustomer.mockResolvedValue({ persisted: true, suppressed: false });
      const first = await executeTool('capture_lead', { call_summary: 'price?', estimate_requested: true, first_name: 'Pat', last_name: 'Lee', address_line1: '12 Shell Dr', requested_service: 'mosquito', pain_points: 'bites on the lanai' }, ctx);
      expect(first).toMatch(/still missing: email/);
      expect(surfaceEstimateRequestForCustomer).not.toHaveBeenCalled();
      const second = await executeTool('capture_lead', { call_summary: 'price?', estimate_requested: true, email: 'pat@example.com' }, ctx);
      expect(second).toMatch(/IS on the office queue/);
      // the retry's LEAD WRITE also carries the first capture's identity fields
      expect(createLeadFromExtraction).toHaveBeenLastCalledWith(expect.objectContaining({ first_name: 'Pat', last_name: 'Lee', email: 'pat@example.com', address_line1: '12 Shell Dr', requested_service: 'mosquito' }), expect.anything());
      // every field from the FIRST capture survives the retry, including the service context
      expect(surfaceEstimateRequestForCustomer).toHaveBeenCalledWith('c-1', expect.objectContaining({ first_name: 'Pat', last_name: 'Lee', email: 'pat@example.com', address_line1: '12 Shell Dr', requested_service: 'mosquito', pain_points: 'bites on the lanai' }), expect.anything());
      expect(ctx.markCaptured).toHaveBeenLastCalledWith(expect.objectContaining({ holdOpen: false }));
    });

    test('gate OFF can never earn the 15-minute wording, even if a ctx claims the office is open', async () => {
      const relayContext = require('../services/voice-agent/relay-context');
      const spy = jest.spyOn(relayContext, 'isContextEnabled').mockReturnValue(false);
      createLeadFromExtraction.mockResolvedValue({ leadId: 'lead-off', created: true });
      const out = await executeTool('capture_lead', { call_summary: 'price?', estimate_requested: true, first_name: 'Pat', last_name: 'Lee', email: 'pat@example.com', address_line1: '12 Shell Dr' }, { from: '+19415551234', callSid: 'CA-off', officeOpenNow: () => true });
      expect(out).toMatch(/as soon as possible — do not name a time/);
      expect(out).not.toMatch(/15 minutes/);
      expect(createLeadFromExtraction).toHaveBeenLastCalledWith(expect.objectContaining({ quote_promised_expectation: 'as_soon_as_possible' }), expect.anything());
      spy.mockRestore();
    });

    test('the spoken turnaround is decided from the office clock in code and travels with the artifact', async () => {
      const relayContext = require('../services/voice-agent/relay-context');
      const spyOn = jest.spyOn(relayContext, 'isContextEnabled').mockReturnValue(true);
      createLeadFromExtraction.mockResolvedValue({ leadId: 'lead-7', created: true });
      const full = { call_summary: 'price?', estimate_requested: true, first_name: 'Pat', last_name: 'Lee', email: 'pat@example.com', address_line1: '12 Shell Dr' };
      const closed = await executeTool('capture_lead', full, { from: '+19415551234', callSid: 'CA-c', officeOpenNow: () => false });
      expect(closed).toMatch(/office is closed: tell the caller the written estimate goes out when the office opens — do not name a time/);
      expect(createLeadFromExtraction).toHaveBeenLastCalledWith(expect.objectContaining({ quote_promised: true, quote_promised_expectation: 'when_office_opens' }), expect.anything());
      const unknown = await executeTool('capture_lead', full, { from: '+19415551234', callSid: 'CA-u' });
      expect(unknown).toMatch(/as soon as possible — do not name a time/);
      expect(createLeadFromExtraction).toHaveBeenLastCalledWith(expect.objectContaining({ quote_promised_expectation: 'as_soon_as_possible' }), expect.anything());
      const open = await executeTool('capture_lead', full, { from: '+19415551234', callSid: 'CA-o', officeOpenNow: () => true });
      expect(open).toMatch(/about 15 minutes/);
      expect(createLeadFromExtraction).toHaveBeenLastCalledWith(expect.objectContaining({ quote_promised_expectation: 'about_15_minutes' }), expect.anything());
      spyOn.mockRestore();
    });

    test('a complete capture does not hold the call open', async () => {
      createLeadFromExtraction.mockResolvedValue({ leadId: 'lead-4', created: true });
      const markCaptured = jest.fn();
      await executeTool('capture_lead', { call_summary: 'price?', estimate_requested: true, first_name: 'Pat', last_name: 'Lee', email: 'pat@example.com', address_line1: '12 Shell Dr' }, { from: '+19415551234', callSid: 'CA-est9', markCaptured });
      expect(markCaptured).toHaveBeenCalledWith(expect.objectContaining({ leadCreated: true, holdOpen: false }));
    });
    test('not requested ⇒ result unchanged (no estimate note either way)', async () => {
      createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
      const out = await executeTool('capture_lead', { call_summary: 'support call' }, { from: '+19415551234', callSid: 'CA-est5' });
      expect(out).not.toMatch(/estimate request/);
    });
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
