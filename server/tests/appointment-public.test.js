/**
 * Customer appointment page — state gating, the calendar file's RFC 5545
 * shape, and the link-first SMS bodies' GSM-7 / segment budget.
 */

const mockDb = jest.fn();
mockDb.schema = { hasTable: jest.fn(async () => true) };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/tech-photo', () => ({
  resolveTechPhotoUrl: jest.fn().mockResolvedValue(null),
}));

const appointmentRouter = require('../routes/appointment-public');
const { pageState, icsEscape, icsFold, STORM_NOTE_MIN_CHANCE } = appointmentRouter._test;
const { smsLineFor } = require('../services/appointment-link');
const { TEMPLATES } = require('../models/migrations/20260801000010_appointment_page_sms_templates')._test;
const { detectEncoding, countSegments } = require('../services/messaging/segment-counter');

// Fixed "now": 2026-08-01 12:00 ET (16:00 UTC, EDT).
const NOW = new Date('2026-08-01T16:00:00.000Z');

describe('appointment page state', () => {
  test('terminal and live statuses each get their own customer-safe state', () => {
    expect(pageState({ status: 'completed', scheduled_date: '2026-08-05' }, NOW).state).toBe('completed');
    expect(pageState({ status: 'cancelled', scheduled_date: '2026-08-05' }, NOW).state).toBe('cancelled');
    expect(pageState({ status: 'canceled', scheduled_date: '2026-08-05' }, NOW).state).toBe('cancelled');
    expect(pageState({ status: 'en_route', scheduled_date: '2026-08-01' }, NOW).state).toBe('in_progress');
    expect(pageState({ status: 'on_site', scheduled_date: '2026-08-01' }, NOW).state).toBe('in_progress');
    expect(pageState({ status: 'no_show', scheduled_date: '2026-08-05' }, NOW).state).toBe('not_available');
    expect(pageState({ status: 'skipped', scheduled_date: '2026-08-05' }, NOW).state).toBe('not_available');
  });

  test('future pending/confirmed/rescheduled visits render the full card', () => {
    for (const status of ['pending', 'confirmed', 'rescheduled']) {
      expect(pageState({ status, scheduled_date: '2026-08-05', window_start: '09:00:00' }, NOW).state)
        .toBe('upcoming');
    }
  });

  test('a visit is past only after the QUOTED 2-hour arrival window, not the job block', () => {
    // 9:00 start -> promise runs to 11:00; at 12:00 ET it is past.
    expect(pageState({
      status: 'confirmed', scheduled_date: '2026-08-01', window_start: '09:00:00', window_end: '10:00:00',
    }, NOW).state).toBe('past');
    // 10:30 start -> promise runs to 12:30; at 12:00 ET the tech may still
    // legitimately arrive, so the card stays live.
    expect(pageState({
      status: 'confirmed', scheduled_date: '2026-08-01', window_start: '10:30:00', window_end: '11:00:00',
    }, NOW).state).toBe('upcoming');
    // Later today is plainly upcoming.
    expect(pageState({
      status: 'confirmed', scheduled_date: '2026-08-01', window_start: '15:00:00',
    }, NOW).state).toBe('upcoming');
  });

  test('a windowless visit stays live until the end of its day', () => {
    expect(pageState({ status: 'pending', scheduled_date: '2026-08-01' }, NOW).state).toBe('upcoming');
    expect(pageState({ status: 'pending', scheduled_date: '2026-07-31' }, NOW).state).toBe('past');
  });
});

describe('calendar file', () => {
  test('escapes the RFC 5545 special characters', () => {
    expect(icsEscape('Pest Control; interior, exterior')).toBe('Pest Control\\; interior\\, exterior');
    expect(icsEscape('line one\nline two')).toBe('line one\\nline two');
    expect(icsEscape('back\\slash')).toBe('back\\\\slash');
  });

  test('folds long content lines to the 75-octet limit with continuation spaces', () => {
    const long = `DESCRIPTION:${'x'.repeat(200)}`;
    const folded = icsFold(long);
    const physical = folded.split('\r\n');
    expect(physical.length).toBeGreaterThan(1);
    expect(Buffer.byteLength(physical[0], 'utf8')).toBeLessThanOrEqual(75);
    for (const line of physical.slice(1)) {
      expect(line.startsWith(' ')).toBe(true);
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    // Unfolding (drop each continuation's single leading space) restores
    // the original content exactly — the property that makes a folded line
    // safe to emit.
    const unfolded = physical[0] + physical.slice(1).map((l) => l.slice(1)).join('');
    expect(unfolded).toBe(long);
  });

  test('short lines are left alone', () => {
    expect(icsFold('VERSION:2.0')).toBe('VERSION:2.0');
  });
});

describe('appointment link clause', () => {
  test('renders a clause with a trailing blank line, and collapses to empty without a URL', () => {
    expect(smsLineFor('https://wavespestcontrol.com/l/a81xk'))
      .toBe('Everything about your visit: https://wavespestcontrol.com/l/a81xk\n\n');
    expect(smsLineFor('https://x.test/l/a', 'View and confirm your appointment'))
      .toBe('View and confirm your appointment: https://x.test/l/a\n\n');
    expect(smsLineFor(null)).toBe('');
    expect(smsLineFor('')).toBe('');
  });
});

describe('link-first SMS bodies', () => {
  test('every seeded body is GSM-7 — a single non-GSM char would double the segment bill', () => {
    for (const tpl of TEMPLATES) {
      expect(detectEncoding(tpl.body).encoding).toBe('GSM_7');
    }
  });

  test('a representative render of each body fits 2 segments', () => {
    const link = 'https://wavespestcontrol.com/l/a81xk';
    const filled = {
      first_name: 'Riley',
      service_type: 'quarterly pest control',
      time: '9:00 AM',
      day: 'Sunday',
      date: 'Aug 2',
      appointment_line: `Everything about your visit: ${link}\n\n`,
      // The overwhelmingly common case: no card hold on the visit.
      card_hold_policy_line: '',
    };
    for (const tpl of TEMPLATES) {
      const rendered = tpl.body.replace(/\{(\w+)\}/g, (m, key) => (key in filled ? filled[key] : m));
      expect(rendered).not.toMatch(/\{\w+\}/); // every placeholder resolved
      expect(detectEncoding(rendered).encoding).toBe('GSM_7');
      expect(countSegments(rendered).segmentCount).toBeLessThanOrEqual(2);
    }
  });

  test('the 24h body still carries the card-hold fee disclosure placeholder', () => {
    const reminder = TEMPLATES.find((t) => t.template_key === 'reminder_24h_v2');
    expect(reminder.body).toContain('{card_hold_policy_line}');
    expect(reminder.variables).toContain('card_hold_policy_line');
  });
});

describe('storm note threshold', () => {
  test('matches the heavy-rain tier the booking chips use', () => {
    expect(STORM_NOTE_MIN_CHANCE).toBe(50);
  });
});
