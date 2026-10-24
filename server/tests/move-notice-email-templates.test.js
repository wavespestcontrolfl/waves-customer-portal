'use strict';

// GATE_MOVE_NOTICE_EMAIL: the seeded appointment.rescheduled /
// appointment.cancelled templates, and the two appointment-email senders that
// use them (including the stale-notice abort at the dispatch boundary).

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ newsletterGroupId: jest.fn(() => 101), serviceGroupId: jest.fn(() => 202) }));
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-06-16T00:00:00.000Z' } })),
}));
jest.mock('../services/contact-notification-prefs', () => ({
  declinedEmailSlotRoles: jest.fn(async () => new Set()),
  contactAddressStillAllowed: jest.fn(async () => true),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AppointmentEmail = require('../services/appointment-email');
const { formatETDay, formatETDate } = require('../utils/datetime-et');
const seed = require('../models/migrations/20261025030000_seed_move_notice_email_templates');

const { TEMPLATES, PREVIEW_PAYLOAD, templateRow } = seed.__private;

function render(key, payloadOverrides = {}) {
  const t = TEMPLATES.find((x) => x.key === key);
  return EmailTemplates.renderTemplate({
    template: { id: `tmpl-${key}`, ...templateRow(t) },
    version: { id: `ver-${key}`, subject: t.subject, preview_text: t.preview, blocks: t.blocks, text_body: '' },
    payload: { ...PREVIEW_PAYLOAD, ...payloadOverrides },
  });
}

// In-memory knex stand-in for the migration: tables of rows, and every update.
function fakeKnex({ existingKeys = [], hasFixtures = true } = {}) {
  const rows = {
    email_templates: existingKeys.map((key, i) => ({ id: `old-${i}`, template_key: key })),
    email_template_versions: [],
    email_template_fixtures: [],
  };
  const updates = [];
  let next = 1;
  const matches = (filter) => (r) => Object.entries(filter || {}).every(([k, v]) => r[k] === v);
  const knex = (name) => {
    let filter = null;
    const q = {
      where: (f) => { filter = f; return q; },
      first: async () => rows[name].find(matches(filter)),
      insert: (row) => {
        const saved = { id: `${name}-${next++}`, ...row };
        rows[name].push(saved);
        return { returning: async () => [saved], then: (res, rej) => Promise.resolve([1]).then(res, rej) };
      },
      update: async (patch) => {
        updates.push({ name, filter, patch });
        rows[name].filter(matches(filter)).forEach((r) => Object.assign(r, patch));
        return 1;
      },
    };
    return q;
  };
  knex.schema = { hasTable: async (table) => table !== 'email_template_fixtures' || hasFixtures };
  knex.transaction = async (fn) => fn(knex);
  return { knex, rows, updates };
}

describe('move-notice email template seed', () => {
  test('seeds the two notices as required transactional appointment emails', () => {
    expect(TEMPLATES.map((t) => t.key)).toEqual(['appointment.rescheduled', 'appointment.cancelled']);
    for (const t of TEMPLATES) {
      const row = templateRow(t);
      expect(row).toMatchObject({
        mode: 'service', audience: 'customer', purpose: 'appointment',
        send_stream: 'transactional_required', suppression_group_key: 'transactional_required', status: 'active',
      });
      expect(JSON.parse(row.required_variables)).toEqual(expect.arrayContaining(['first_name', 'service_type', 'appointment_day', 'appointment_date']));
    }
    expect(JSON.parse(templateRow(TEMPLATES[0]).required_variables)).toContain('arrival_window');
  });

  test.each([
    ['appointment.rescheduled', 'Your Waves appointment has a new time',
      'Your Quarterly Pest Control with Waves is now Wednesday, November 4, 2026, between 4:00 PM and 6:00 PM.'],
    ['appointment.cancelled', 'Your Waves appointment is cancelled',
      'Your Quarterly Pest Control with Waves on Wednesday, November 4, 2026 is cancelled.'],
  ])('%s renders the text\'s own sentence with no raw placeholders', (key, subject, sentence) => {
    const rendered = render(key);
    expect(rendered.subject).toBe(subject);
    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.text).toContain(sentence);
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.html).toContain('waves-logo');
  });

  test('up() inserts a missing template with its active version and preview fixture, and leaves an existing one alone', async () => {
    const { knex, rows, updates } = fakeKnex({ existingKeys: ['appointment.cancelled'] });
    await seed.up(knex);
    const added = rows.email_templates.find((r) => r.template_key === 'appointment.rescheduled');
    expect(added).toMatchObject({ send_stream: 'transactional_required', status: 'active' });
    expect(rows.email_template_versions).toEqual([expect.objectContaining({ template_id: added.id, version_number: 1, status: 'active', subject: 'Your Waves appointment has a new time' })]);
    expect(added.active_version_id).toBe(rows.email_template_versions[0].id);
    expect(rows.email_template_fixtures).toEqual([expect.objectContaining({ template_id: added.id, is_default: true })]);
    // The office may have edited the existing one: nothing touches it.
    expect(updates.every((u) => u.filter.id !== 'old-0')).toBe(true);
    expect(rows.email_templates.filter((r) => r.template_key === 'appointment.cancelled')).toHaveLength(1);
  });

  test('up() runs again without duplicates, and without the fixtures table seeds the templates only', async () => {
    const first = fakeKnex({ hasFixtures: false });
    await seed.up(first.knex);
    await seed.up(first.knex);
    expect(first.rows.email_templates.map((r) => r.template_key).sort()).toEqual(['appointment.cancelled', 'appointment.rescheduled']);
    expect(first.rows.email_template_versions).toHaveLength(2);
    expect(first.rows.email_template_fixtures).toHaveLength(0);
  });

  test('down() is a documented no-op', async () => {
    await expect(seed.down()).resolves.toBeUndefined();
  });
});

describe('move-notice email senders', () => {
  const APPT = '2026-06-22T14:00:00.000Z'; // 10:00 AM Eastern, the live slot below
  const CUSTOMER = { id: 'c1', first_name: 'Pat', email: 'pat@example.com', phone: '+19415551234' };

  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => {
      if (table === 'customers') return { where: () => ({ select: () => ({ first: async () => CUSTOMER }) }) };
      if (table === 'notification_prefs') return { where: () => ({ first: async () => ({ appointment_notify_primary: true }) }) };
      if (table === 'recipient_optin') { const q = { where: () => q, whereNotNull: () => q, whereNull: () => q, first: async () => undefined }; return q; }
      if (table === 'customer_interactions') return { insert: async () => [1] };
      if (table === 'appointment_reminders') return { where: () => ({ first: async () => null }) };
      if (table === 'scheduled_services') return { where: () => ({ first: async () => ({ scheduled_date: '2026-06-22', window_start: '10:00' }) }) };
      throw new Error(`unexpected db table ${table}`);
    });
  });

  test('the reschedule email carries the new day, date and window, the caller\'s key, and the slot it promises', async () => {
    const res = await AppointmentEmail.sendAppointmentRescheduledEmail({
      customerId: 'c1', scheduledServiceId: 'ss1', appointmentTime: APPT, serviceLabel: 'Quarterly Pest Control',
      arrivalWindow: 'between 10:00 AM and 12:00 PM', idempotencyKey: 'appointment.rescheduled:ss1:123',
    });
    expect(res.ok).toBe(true);
    const call = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(call).toMatchObject({
      templateKey: 'appointment.rescheduled', to: 'pat@example.com',
      payload: expect.objectContaining({
        service_type: 'Quarterly Pest Control', appointment_day: formatETDay(new Date(APPT)), appointment_date: formatETDate(new Date(APPT)),
        arrival_window: 'between 10:00 AM and 12:00 PM',
      }),
    });
    expect(call.idempotencyKey).toMatch(/^appointment\.rescheduled:ss1:123:[0-9a-f]{16}$/);
  });

  test('the cancellation email carries the cancelled day and date and no window', async () => {
    const res = await AppointmentEmail.sendAppointmentCancelledEmail({
      customerId: 'c1', scheduledServiceId: 'ss1', appointmentTime: APPT, serviceLabel: 'Quarterly Pest Control', idempotencyKey: 'appointment.cancelled:ss1:r0',
    });
    expect(res.ok).toBe(true);
    const call = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe('appointment.cancelled');
    expect(call.payload).toMatchObject({ appointment_day: formatETDay(new Date(APPT)), appointment_date: formatETDate(new Date(APPT)) });
    expect(call.payload).not.toHaveProperty('arrival_window');
    expect(call.idempotencyKey).toMatch(/^appointment\.cancelled:ss1:r0:[0-9a-f]{16}$/);
  });

  test.each([
    ['answers false', async () => false],
    ['throws', async () => { throw new Error('read failed'); }],
  ])('a notice that is no longer true at the dispatch boundary (stillCurrent %s) is held, never sent', async (_label, stillCurrent) => {
    EmailTemplates.sendTemplate.mockImplementationOnce(async (opts) => {
      if (opts.onQueued && (await opts.onQueued()) === false) return { aborted: true };
      return { sent: true, message: { provider_message_id: 'sg-2' } };
    });
    const res = await AppointmentEmail.sendAppointmentCancelledEmail({
      customerId: 'c1', scheduledServiceId: 'ss1', appointmentTime: APPT, serviceLabel: 'Pest Control', idempotencyKey: 'k', stillCurrent,
    });
    expect(res).toEqual({ ok: false, held: true, reason: 'stale_notice' });
  });

  test('no appointment time: nothing is sent', async () => {
    const res = await AppointmentEmail.sendAppointmentRescheduledEmail({ customerId: 'c1', scheduledServiceId: 'ss1', appointmentTime: null, idempotencyKey: 'k' });
    expect(res).toEqual({ ok: false, reason: 'no_appointment_time' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });
});
