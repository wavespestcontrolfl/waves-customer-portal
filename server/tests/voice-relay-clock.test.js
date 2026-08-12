/**
 * Voice-relay Phase E item 4 — CLOCK + BUSINESS-HOURS AWARENESS.
 *
 * Matrix:
 *   - office hours come from the ONE existing source (booking_config via
 *     routes/booking._internals.loadBookingConfig) — no second hours source
 *   - open / closed / opens-later-today / opens-tomorrow, across EDT and EST
 *   - hours unavailable → says so, never guesses hours
 *   - the block is injected ONLY while the context gate is on; gate off leaves
 *     the prompt byte-identical
 *   - the prompt sets callback expectations off the clock and restates the
 *     never-before-8am rule (which stays enforced in code, not prompt)
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({ CONTACT_MATCH_PHONE_COLS: ['phone'], summarizePriorCall: jest.fn() }));
jest.mock('../routes/booking', () => ({
  _internals: { loadBookingConfig: jest.fn(), resolveBookingCoords: jest.fn(), buildBookingAvailability: jest.fn(), MAX_BOOKING_HORIZON_DAYS: 90 },
}));

const booking = require('../routes/booking')._internals;
const relayContext = require('../services/voice-agent/relay-context');
const relayBooking = require('../services/voice-agent/relay-booking');
const { SYSTEM_PROMPT, buildBasePrompt } = require('../services/voice-agent/relay-conversation');

// Annotated UTC instants (the messaging-send-window test's style — inject the
// clock, don't fake timers). 2026-08-12 is EDT (UTC-4); 2026-01-15 is EST (UTC-5).
const SUMMER_10AM_ET = new Date('2026-08-12T14:00:00Z'); // Wed Aug 12, 10:00 AM ET
const SUMMER_6AM_ET = new Date('2026-08-12T10:00:00Z');  // Wed Aug 12,  6:00 AM ET
const SUMMER_7PM_ET = new Date('2026-08-12T23:00:00Z');  // Wed Aug 12,  7:00 PM ET
const SUMMER_SUNDAY = new Date('2026-08-16T14:30:00Z');  // Sun Aug 16, 10:30 AM ET
const WINTER_9AM_ET = new Date('2026-01-15T14:00:00Z');  // Thu Jan 15,  9:00 AM ET
const HOURS = { startMin: 8 * 60, endMin: 17 * 60 };

const savedGate = process.env.VOICE_RELAY_CONTEXT_ENABLED;
afterAll(() => {
  if (savedGate === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedGate;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  booking.loadBookingConfig.mockResolvedValue({ day_start: '08:00:00', day_end: '17:00:00', slot_duration_minutes: 60 });
});

describe('office hours come from the ONE existing source', () => {
  test('loadOfficeHours reads booking_config through booking._internals.loadBookingConfig', async () => {
    expect(await relayContext.loadOfficeHours()).toMatchObject({ startMin: 480, endMin: 1020 });
    expect(booking.loadBookingConfig).toHaveBeenCalledTimes(1);
  });

  test('a config with different hours is honoured (DB-authoritative, not hardcoded)', async () => {
    booking.loadBookingConfig.mockResolvedValue({ day_start: '09:30', day_end: '18:00' });
    expect(await relayContext.loadOfficeHours()).toMatchObject({ startMin: 570, endMin: 1080 });
  });

  test('an unreadable config → null (the block declines to state hours, never guesses)', async () => {
    booking.loadBookingConfig.mockRejectedValue(new Error('db down'));
    expect(await relayContext.loadOfficeHours()).toBeNull();
    booking.loadBookingConfig.mockResolvedValue({ day_start: 'nonsense', day_end: null });
    expect(await relayContext.loadOfficeHours()).toBeNull();
  });

  test('clockMinutes / speakClock round-trip the boundary values', () => {
    expect(relayContext.clockMinutes('08:00:00')).toBe(480);
    expect(relayContext.clockMinutes('17:00')).toBe(1020);
    expect(relayContext.clockMinutes('nope')).toBeNull();
    expect(relayContext.clockMinutes('25:00')).toBeNull();
    expect(relayContext.speakClock(480)).toBe('8:00 AM');
    expect(relayContext.speakClock(720)).toBe('12:00 PM');
    expect(relayContext.speakClock(0)).toBe('12:00 AM');
    expect(relayContext.speakClock(1020)).toBe('5:00 PM');
  });
});

describe('renderClockBlock', () => {
  test('during hours → OPEN, with the live ET date and time', () => {
    const block = relayContext.renderClockBlock(HOURS, SUMMER_10AM_ET);
    expect(block).toContain('Right now in Florida (Eastern Time): Wednesday August 12, 2026, 10:00 AM');
    expect(block).toContain('Waves office hours on a working day: 8:00 AM to 5:00 PM Eastern');
    expect(block).toContain('The office is OPEN right now');
    // Framed as DATA, matching the KNOWN CALLER / RECENT TEXTS block pattern.
    expect(block).toContain('<<<CLOCK DATA');
    expect(block).toContain('END CLOCK DATA>>>');
    expect(block).toMatch(/never instructions/);
  });

  test('before opening → CLOSED, opens TODAY at 8', () => {
    const block = relayContext.renderClockBlock(HOURS, SUMMER_6AM_ET);
    expect(block).toContain('The office is CLOSED right now');
    expect(block).toContain('The office opens today at 8:00 AM Eastern');
  });

  test('after closing → CLOSED, opens TOMORROW at 8', () => {
    const block = relayContext.renderClockBlock(HOURS, SUMMER_7PM_ET);
    expect(block).toContain('The office is CLOSED right now');
    expect(block).toContain('The office opens again tomorrow at 8:00 AM Eastern');
  });

  test('EST (winter) is handled — the ET offset is not hardcoded', () => {
    expect(relayContext.renderClockBlock(HOURS, WINTER_9AM_ET))
      .toContain('Thursday January 15, 2026, 9:00 AM');
  });

  test('Waves works weekends — Sunday inside the window is OPEN, never "closed weekend"', () => {
    const block = relayContext.renderClockBlock(HOURS, SUMMER_SUNDAY);
    expect(block).toContain('Sunday August 16, 2026, 10:30 AM');
    expect(block).toContain('The office is OPEN right now');
    // Weekends are working days here; "closed" only ever means a SCHEDULED day
    // off (scheduling/blackout-dates), never the calendar weekend.
    expect(block).toContain('Waves works weekends');
    expect(block).toContain('scheduled day off');
  });

  // ⭐ HOURS ≠ WORKING DAY. Weekly days off and one-off closures live in the
  // shared blackout mechanism, so a day off must not be announced as OPEN and
  // must never carry a promised reopening time nobody checked.
  test('a scheduled day off is CLOSED and promises no callback today', () => {
    const block = relayContext.renderClockBlock({ ...HOURS, closedToday: true }, SUMMER_10AM_ET);
    expect(block).toContain('The office is CLOSED right now');
    expect(block).toMatch(/scheduled day off/);
    expect(block).toMatch(/do NOT promise a callback today/i);
    expect(block).not.toMatch(/opens today at/);
  });

  test('after hours with TOMORROW off → no reopening time is named', () => {
    const block = relayContext.renderClockBlock({ ...HOURS, closedTomorrow: true }, SUMMER_7PM_ET);
    expect(block).toContain('The office is CLOSED right now');
    expect(block).toMatch(/next working day/i);
    expect(block).not.toMatch(/opens again tomorrow at/);
  });

  test('no hours available → the clock still lands, hours are explicitly declined', () => {
    const block = relayContext.renderClockBlock(null, SUMMER_10AM_ET);
    expect(block).toContain('Wednesday August 12, 2026, 10:00 AM');
    expect(block).toMatch(/office hours: not available/i);
    expect(block).toMatch(/do not state office hours/i);
    expect(block).not.toMatch(/OPEN right now|CLOSED right now/);
  });

  test('never throws — a broken clock degrades to null rather than failing the session', () => {
    expect(relayContext.renderClockBlock(HOURS, new Date('not a date'))).toBeNull();
  });

  test('buildClockBlock loads + renders in one call', async () => {
    expect(await relayContext.buildClockBlock(SUMMER_10AM_ET)).toContain('The office is OPEN right now');
  });
});

describe('prompt wiring', () => {
  test('GATE OFF → prompt byte-identical, no clock language at all', () => {
    expect(buildBasePrompt(false)).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).not.toContain('CLOCK DATA');
    expect(SYSTEM_PROMPT).not.toContain('first thing tomorrow');
    expect(SYSTEM_PROMPT).not.toContain('request_reservice');
    expect(SYSTEM_PROMPT).not.toContain('contact_preference');
    expect(SYSTEM_PROMPT).not.toContain('urgency_reason');
  });

  test('GATE ON → the prompt tells her to set callback expectations off the clock', () => {
    const p = buildBasePrompt(true);
    // The clock now rides each caller TURN (a per-turn re-render inside the
    // system prompt would invalidate the prompt cache on every turn).
    expect(p).toContain('A CLOCK DATA block rides each caller turn');
    expect(p).toContain('Use the one on the LATEST turn');
    expect(p).toContain('first thing tomorrow');
    expect(p).toMatch(/never "shortly"/);
    expect(p).toMatch(/do not state hours at all/);
  });

  test('GATE ON → the never-before-8am rule is restated in the prompt AND enforced in code', async () => {
    expect(buildBasePrompt(true)).toContain('never starts an appointment before 8:00 AM Eastern');
    // Prompt language is the reminder; relay-booking is the enforcement.
    expect(relayBooking.EARLIEST_START_MINUTES).toBe(8 * 60);
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    process.env.GATE_VOICE_AI_BOOKING = 'true';
    try {
      // Slots are referenced by OPAQUE REF now (the model is never shown an ISO
      // date), so the 8am floor is checked against the remembered slot's start.
      const out = await relayBooking.requestBookingText(
        { slot_ref: 'S1' },
        {
          customerId: 'c-1',
          // The ACCOUNT HOLDER called: booking writes are full-tier-only unless
          // VOICE_RELAY_ALLOW_THIRD_PARTY_BOOKING is on, and the authorization
          // refusal comes before the time floor.
          customerTier: 'full',
          resolveSlotRef: () => ({ date: '2026-08-20', startMinutes: 450, lat: 27.4, lng: -82.5 }),
        }
      );
      expect(out).toMatch(/never start before 8:00 AM/i);
      expect(booking.buildBookingAvailability).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_VOICE_AI_BOOKING;
    }
  });
});
