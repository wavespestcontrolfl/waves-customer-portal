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

const { TOOLS, executeTool, speakSlot, formatSlots } = require('../services/voice-agent/relay-tools');
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
  test('writes the lead, marks captured, drops invalid quality', async () => {
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
    expect(markCaptured).toHaveBeenCalled();
    expect(out).toMatch(/Lead saved/);
  });
});
