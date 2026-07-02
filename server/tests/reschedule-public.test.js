/**
 * Public self-serve reschedule — eligibility gating, booking-window range,
 * the SMS {reschedule_line} clause contract, and the template migrations'
 * embed shape.
 */

const mockDb = jest.fn();
mockDb.schema = { hasTable: jest.fn(async () => true) };
jest.mock('../models/db', () => mockDb);

const reschedulePublicRouter = require('../routes/reschedule-public');
const { smsLineFor } = require('../services/reschedule-link');
const smsMigration = require('../models/migrations/20260702000011_reschedule_link_sms_templates');
const emailMigration = require('../models/migrations/20260702000012_reschedule_link_email_templates');

const { eligibility, bookingRange, apptDateStr, label12 } = reschedulePublicRouter._test;

// Fixed "now": 2026-07-02 12:00 ET (16:00 UTC, EDT).
const NOW = new Date('2026-07-02T16:00:00.000Z');

describe('reschedule-public eligibility', () => {
  test('terminal and live statuses are not reschedulable, with customer-safe reasons', () => {
    expect(eligibility({ status: 'completed', scheduled_date: '2026-07-10' }, NOW))
      .toEqual({ ok: false, reason: 'completed' });
    expect(eligibility({ status: 'cancelled', scheduled_date: '2026-07-10' }, NOW))
      .toEqual({ ok: false, reason: 'cancelled' });
    expect(eligibility({ status: 'canceled', scheduled_date: '2026-07-10' }, NOW))
      .toEqual({ ok: false, reason: 'cancelled' });
    expect(eligibility({ status: 'en_route', scheduled_date: '2026-07-02' }, NOW))
      .toEqual({ ok: false, reason: 'in_progress' });
    expect(eligibility({ status: 'on_site', scheduled_date: '2026-07-02' }, NOW))
      .toEqual({ ok: false, reason: 'in_progress' });
    expect(eligibility({ status: 'no_show', scheduled_date: '2026-07-01' }, NOW))
      .toEqual({ ok: false, reason: 'not_available' });
    expect(eligibility({ status: 'skipped', scheduled_date: '2026-07-10' }, NOW))
      .toEqual({ ok: false, reason: 'not_available' });
  });

  test('past appointments are not reschedulable', () => {
    expect(eligibility({ status: 'confirmed', scheduled_date: '2026-07-01' }, NOW))
      .toEqual({ ok: false, reason: 'past' });
  });

  test('same-day appointment whose window elapsed in ET is past', () => {
    expect(eligibility({
      status: 'confirmed',
      scheduled_date: '2026-07-02',
      window_start: '08:00:00',
      window_end: '10:00:00',
    }, NOW)).toEqual({ ok: false, reason: 'past' });
  });

  test('same-day appointment with a window still ahead stays reschedulable', () => {
    expect(eligibility({
      status: 'confirmed',
      scheduled_date: '2026-07-02',
      window_start: '13:00:00',
      window_end: '15:00:00',
    }, NOW)).toEqual({ ok: true });
  });

  test('pending / confirmed / rescheduled future appointments are reschedulable', () => {
    for (const status of ['pending', 'confirmed', 'rescheduled']) {
      expect(eligibility({ status, scheduled_date: '2026-07-10' }, NOW)).toEqual({ ok: true });
    }
  });

  test('apptDateStr normalizes Date and string forms', () => {
    expect(apptDateStr('2026-07-10T00:00:00.000Z')).toBe('2026-07-10');
    expect(apptDateStr(new Date('2026-07-10T00:00:00.000Z'))).toBe('2026-07-10');
    expect(apptDateStr(null)).toBe(null);
  });

  test('label12 formats HH:MM(:SS) into 12-hour labels for the replay response', () => {
    expect(label12('09:00')).toBe('9:00 AM');
    expect(label12('14:00:00')).toBe('2:00 PM');
    expect(label12('00:30')).toBe('12:30 AM');
    expect(label12('12:00')).toBe('12:00 PM');
    expect(label12(null)).toBe(null);
  });
});

describe('reschedule-public booking window', () => {
  test('mirrors booking_config advance days', () => {
    const range = bookingRange({ advance_days_min: 1, advance_days_max: 14 }, NOW);
    expect(range).toEqual({ rangeFrom: '2026-07-03', rangeTo: '2026-07-16' });
  });

  test('defaults match the public /book funnel defaults', () => {
    const range = bookingRange({}, NOW);
    expect(range).toEqual({ rangeFrom: '2026-07-03', rangeTo: '2026-07-16' });
  });
});

describe('reschedule-link SMS clause', () => {
  test('renders the embed clause for a URL and empty string for none', () => {
    expect(smsLineFor('https://portal.wavespestcontrol.com/l/abc12'))
      .toBe('Need a different time? Reschedule online: https://portal.wavespestcontrol.com/l/abc12\n\n');
    expect(smsLineFor(null)).toBe('');
    expect(smsLineFor('')).toBe('');
  });
});

describe('SMS template migration embed contract', () => {
  test('every updated template body embeds {reschedule_line} and lists the variable', () => {
    expect(smsMigration.UPDATES.map((u) => u.template_key).sort())
      .toEqual(['appointment_confirmation', 'reminder_24h', 'reminder_72h']);
    for (const u of smsMigration.UPDATES) {
      expect(u.newBody).toContain('{reschedule_line}');
      expect(u.variables).toContain('reschedule_line');
      // Clause var carries its own trailing blank line — the body must not
      // double it up ("\n\n{reschedule_line}" is the only valid embedding).
      expect(u.newBody).toContain('\n\n{reschedule_line}');
      expect(u.newBody).not.toContain('{reschedule_line}\n\n');
    }
  });
});

describe('email template migration helpers', () => {
  const { insertRescheduleCta, referencesRescheduleUrl, withVariable } = emailMigration.__private;

  test('inserts the reschedule CTA before the existing CTA', () => {
    const blocks = [
      { type: 'paragraph', content: 'Hello' },
      { type: 'cta', label: 'View appointment', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thanks' },
    ];
    const next = insertRescheduleCta(blocks);
    expect(next).toHaveLength(4);
    expect(next[1]).toEqual({ type: 'cta', label: 'Reschedule appointment', url_variable: 'reschedule_url' });
    expect(next[2].url_variable).toBe('customer_portal_url');
  });

  test('falls back to before-signature, then append, when no CTA exists', () => {
    const withSig = insertRescheduleCta([
      { type: 'paragraph', content: 'Hello' },
      { type: 'signature', content: 'Thanks' },
    ]);
    expect(withSig[1].url_variable).toBe('reschedule_url');
    expect(withSig[2].type).toBe('signature');

    const appended = insertRescheduleCta([{ type: 'paragraph', content: 'Hello' }]);
    expect(appended[1].url_variable).toBe('reschedule_url');
  });

  test('detects existing reschedule_url references (idempotent up)', () => {
    expect(referencesRescheduleUrl([{ type: 'cta', url_variable: 'reschedule_url' }])).toBe(true);
    expect(referencesRescheduleUrl([{ type: 'small_note', content: 'Reschedule: {{reschedule_url}}' }])).toBe(true);
    expect(referencesRescheduleUrl([{ type: 'cta', url_variable: 'customer_portal_url' }])).toBe(false);
    expect(referencesRescheduleUrl('[{"type":"cta","url_variable":"reschedule_url"}]')).toBe(true);
  });

  test('withVariable appends once and tolerates JSON-string columns', () => {
    expect(withVariable(['a'], 'reschedule_url')).toEqual(['a', 'reschedule_url']);
    expect(withVariable(['a', 'reschedule_url'], 'reschedule_url')).toEqual(['a', 'reschedule_url']);
    expect(withVariable('["a"]', 'reschedule_url')).toEqual(['a', 'reschedule_url']);
  });
});
