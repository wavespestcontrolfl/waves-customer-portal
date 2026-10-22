jest.mock('../models/db', () => jest.fn());
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) })); // hold lookup: none of these fixtures is a hold
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-06-16T00:00:00.000Z' } })),
}));
// The contact's OWN email declines (contact login, GATE_CONTACT_LOGIN): empty
// unless a test says otherwise.
const mockDeclinedRoles = new Set();
// …and the addresses re-read at the dispatch boundary (codex r21 / r27): an
// address in this set is declined (or removed) as of the handoff.
const mockDeclinedEmails = new Set();
jest.mock('../services/contact-notification-prefs', () => ({
  declinedEmailSlotRoles: jest.fn(async () => mockDeclinedRoles),
  contactAddressStillAllowed: jest.fn(async (_customer, email) => !mockDeclinedEmails.has(String(email).toLowerCase())),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AppointmentEmail = require('../services/appointment-email');

function mockDb({ customer = null, prefs = null, slot = { scheduled_date: '2026-06-22', window_start: '10:00' }, onSiteDemoted = false }) {
  db.mockImplementation((table) => {
    if (table === 'customers') {
      return { where: () => ({ select: () => ({ first: async () => customer }) }) };
    }
    if (table === 'notification_prefs') {
      return { where: () => ({ first: async () => prefs }) };
    }
    if (table === 'recipient_optin') {
      // The on-site flow's texts-only demotion marker (GATE_ONSITE_CALLER_DEMOTE).
      const q = { where: () => q, whereNotNull: () => q, whereNull: () => q, first: async () => (onSiteDemoted ? { phone_key: '9415557777' } : undefined) };
      return q;
    }
    if (table === 'customer_interactions') {
      return { insert: async () => [1] };
    }
    if (table === 'appointment_reminders') {
      // pre-provider move-hold recheck — no hold
      return { where: () => ({ first: async () => null }) };
    }
    if (table === 'scheduled_services') {
      // ABA live-slot verification (codex r39) — the live row matches the
      // rendered slot the tests pass (2026-06-22T14:00Z = 10:00 ET).
      return { where: () => ({ first: async () => slot }) };
    }
    throw new Error(`unexpected db table ${table}`);
  });
}

beforeEach(() => jest.clearAllMocks());

describe('appointment email recipient resolution (fan-out to appointment contacts)', () => {
  test('routes to the service-contact email when the primary is not an appointment recipient', async () => {
    mockDb({
      customer: {
        id: 'c1', first_name: 'Pat', email: 'primary@example.com', phone: '+19415551234',
        service_contact_name: 'Sue', service_contact_phone: '+19415557777', service_contact_email: 'sue@service.com',
      },
      prefs: { appointment_notify_primary: false },
    });

    const res = await AppointmentEmail.sendAppointmentConfirmationEmail({
      customerId: 'c1', scheduledServiceId: 'ss1', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
    });

    expect(res.ok).toBe(true);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'sue@service.com' }));
    // Idempotency key carries the appointment instance so a reschedule resends,
    // and the recipient component is hashed (never the raw address) so long
    // emails can't overflow the idempotency_key column.
    const call = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(call.idempotencyKey).toContain(String(new Date('2026-06-22T14:00:00.000Z').getTime()));
    expect(call.idempotencyKey).not.toContain('sue@service.com');
  });

  test('the on-site flow switched the holder\'s TEXTS off: the holder still gets the appointment email, beside the contact', async () => {
    mockDb({
      customer: {
        id: 'c1', first_name: 'Pat', email: 'primary@example.com', phone: '+19415551234',
        service_contact_name: 'Sue', service_contact_phone: '+19415557777', service_contact_email: 'sue@service.com',
      },
      prefs: { appointment_notify_primary: false },
      onSiteDemoted: true,
    });
    const res = await AppointmentEmail.sendAppointmentConfirmationEmail({
      customerId: 'c1', scheduledServiceId: 'ss1', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
    });
    expect(res.ok).toBe(true);
    const to = EmailTemplates.sendTemplate.mock.calls.map(([c]) => c.to).sort();
    expect(to).toEqual(['primary@example.com', 'sue@service.com']);
  });

  test('the texts-only override applies to the account row BEFORE the property overlay (a property\'s own false still wins)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/appointment-email.js'), 'utf8');
    const override = src.indexOf("callerDemotedForTextsOnly(customer.id)");
    // Ownership comes from the markers alone, not the row's status (a STOP declines the row before the restore).
    const optin = require('fs').readFileSync(require.resolve('../services/recipient-optin.js'), 'utf8');
    expect(optin).toContain(".where({ customer_id: customerId })\n      .whereNotNull('caller_demoted_at')\n      .whereNull('caller_choice_at')\n      .first('phone_key');");
    const overlay = src.indexOf("prefsForVisit(prefs, customer.id, scheduledServiceId, 'email_recipients')");
    expect(override).toBeGreaterThan(0);
    expect(override).toBeLessThan(overlay);
  });

  test('the holder\'s OWN opt-out (no flow marker) still keeps them off the email', async () => {
    mockDb({
      customer: {
        id: 'c1', first_name: 'Pat', email: 'primary@example.com', phone: '+19415551234',
        service_contact_name: 'Sue', service_contact_phone: '+19415557777', service_contact_email: 'sue@service.com',
      },
      prefs: { appointment_notify_primary: false },
      onSiteDemoted: false,
    });
    await AppointmentEmail.sendAppointmentConfirmationEmail({
      customerId: 'c1', scheduledServiceId: 'ss1', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
    });
    expect(EmailTemplates.sendTemplate.mock.calls.map(([c]) => c.to)).toEqual(['sue@service.com']);
  });

  test('a contact\'s own decline never reroutes the notice to a holder who turned appointment notices off (codex #6363 r2)', async () => {
    mockDeclinedRoles.add('service_contact');
    try {
      mockDb({
        customer: {
          id: 'c1', first_name: 'Pat', email: 'primary@example.com', phone: '+19415551234',
          service_contact_name: 'Sue', service_contact_phone: '+19415557777', service_contact_email: 'sue@service.com',
        },
        prefs: { appointment_notify_primary: false },
      });
      const res = await AppointmentEmail.sendAppointmentConfirmationEmail({
        customerId: 'c1', scheduledServiceId: 'ss1', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
      });
      expect(res.ok).toBe(false);
      expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    } finally {
      mockDeclinedRoles.clear();
    }
  });

  test('a contact decline that lands during the library\'s awaits aborts THAT recipient at the dispatch boundary; the holder\'s notice still goes; an unreadable table holds (codex #6363 r21)', async () => {
    const ContactPrefs = require('../services/contact-notification-prefs');
    mockDb({
      customer: {
        id: 'c1', first_name: 'Pat', email: 'primary@example.com', phone: '+19415551234',
        service_contact_name: 'Sue', service_contact_phone: '+19415557777', service_contact_email: 'sue@service.com',
      },
      prefs: { appointment_notify_primary: true },
    });
    // The library resolves template / idempotency / suppression, then asks
    // onQueued; false aborts before the provider.
    EmailTemplates.sendTemplate.mockImplementation(async (opts) => {
      if (opts.onQueued && (await opts.onQueued()) === false) return { aborted: true };
      return { sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-06-16T00:00:00.000Z' } };
    });
    // The resolution saw no decline; by the handoff Sue has turned email off.
    mockDeclinedEmails.add('sue@service.com');
    try {
      const res = await AppointmentEmail.sendAppointmentConfirmationEmail({
        customerId: 'c1', scheduledServiceId: 'ss1', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
      });
      expect(res.ok).toBe(true);
      expect(EmailTemplates.sendTemplate.mock.calls.map(([c]) => c.to).sort()).toEqual(['primary@example.com', 'sue@service.com']);
      // Re-read against the customer row as of the handoff, for the contact's address and this event.
      expect(ContactPrefs.contactAddressStillAllowed).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'sue@service.com', 'appointment.confirmation');
    } finally {
      mockDeclinedEmails.clear();
    }
    // The holder's OWN mailbox is never subject to a contact's decline
    // (codex r23 security P2): a contact whose address equals the holder's
    // turning email off must not silence the holder's notice — the shared
    // address resolves as the holder's and the handoff lets it through, and
    // the contact declines are not even read for it.
    EmailTemplates.sendTemplate.mockClear();
    ContactPrefs.contactAddressStillAllowed.mockClear();
    mockDb({
      customer: {
        id: 'c1', first_name: 'Pat', email: 'shared@example.com', phone: '+19415551234',
        service_contact_name: 'Sue', service_contact_phone: '+19415557777', service_contact_email: 'shared@example.com',
      },
      prefs: { appointment_notify_primary: true },
    });
    mockDeclinedEmails.add('shared@example.com');
    try {
      const shared = await AppointmentEmail.sendAppointmentConfirmationEmail({
        customerId: 'c1', scheduledServiceId: 'ss1', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
      });
      expect(shared.ok).toBe(true);
      expect(EmailTemplates.sendTemplate.mock.calls.map(([c]) => c.to)).toEqual(['shared@example.com']);
      expect(ContactPrefs.contactAddressStillAllowed).not.toHaveBeenCalled();
    } finally {
      mockDeclinedEmails.clear();
    }
    // Unreadable at the handoff for a CONTACT's mailbox: the notice is held, not sent.
    EmailTemplates.sendTemplate.mockClear();
    mockDb({
      customer: {
        id: 'c1', first_name: 'Pat', email: 'primary@example.com', phone: '+19415551234',
        service_contact_name: 'Sue', service_contact_phone: '+19415557777', service_contact_email: 'sue@service.com',
      },
      prefs: { appointment_notify_primary: false },
    });
    ContactPrefs.contactAddressStillAllowed.mockRejectedValueOnce(new Error('timeout'));
    const held = await AppointmentEmail.sendAppointmentConfirmationEmail({
      customerId: 'c1', scheduledServiceId: 'ss1', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
    });
    expect(held).toEqual({ ok: false, held: true, reason: 'preferences_unavailable' });
    EmailTemplates.sendTemplate.mockImplementation(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-06-16T00:00:00.000Z' } }));
  });

  test('falls back to the primary email when the service contact has no email', async () => {
    mockDb({
      customer: {
        id: 'c2', first_name: 'Pat', email: 'primary@example.com', phone: '+19415551234',
        service_contact_name: 'Sue', service_contact_phone: '+19415557777', service_contact_email: null,
      },
      prefs: { appointment_notify_primary: false },
    });

    const res = await AppointmentEmail.sendAppointmentReminderEmail({
      customerId: 'c2', scheduledServiceId: 'ss2', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control', kind: '24h',
    });

    expect(res.ok).toBe(true);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'primary@example.com' }));
    // The fallback DELIVERS to the primary address, so it must carry the
    // PRIMARY's name — greeting the primary mailbox as "Sue" mislabels it
    // (common once phone-only buyer/tenant slots are auto-written by calls).
    const fallbackCall = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(fallbackCall.payload.first_name).toBe('Pat');
  });

  test('recipientFilter restricts the send to the allowlisted addresses only', async () => {
    mockDb({
      customer: {
        id: 'c6', first_name: 'Pat', email: 'primary@example.com', phone: '+19415551234',
        service_contact_name: 'Joseph Haught', service_contact_phone: null, service_contact_email: 'buyer@example.com',
      },
      prefs: { appointment_notify_primary: true },
      slot: { scheduled_date: '2026-07-09', window_start: '12:00' }, // 16:00Z = 12:00 ET
    });

    const res = await AppointmentEmail.sendAppointmentConfirmationEmail({
      customerId: 'c6', scheduledServiceId: 'ss6', appointmentTime: '2026-07-09T16:00:00.000Z', serviceLabel: 'WDO Inspection',
      recipientFilter: ['buyer@example.com'],
    });

    expect(res.ok).toBe(true);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'buyer@example.com' }));
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].payload.first_name).toBe('Joseph');
  });

  test('email-only customer (no phone contacts) still gets the email at the primary address', async () => {
    mockDb({
      customer: { id: 'c3', first_name: 'Pat', email: 'primary@example.com', phone: null },
      prefs: null,
    });

    const res = await AppointmentEmail.sendTechEnRouteEmail({ customerId: 'c3', techName: 'Adam', etaMinutes: 20 });

    expect(res.ok).toBe(true);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'primary@example.com' }));
  });

  test('includes an email-only service contact (email but no phone) when the primary has no email', async () => {
    mockDb({
      customer: {
        id: 'c6', first_name: 'Pat', email: null, phone: '+19415551234',
        service_contact_name: 'Sue', service_contact_phone: null, service_contact_email: 'sue@service.com',
      },
      prefs: { appointment_notify_primary: false },
    });

    const res = await AppointmentEmail.sendAppointmentConfirmationEmail({
      customerId: 'c6', scheduledServiceId: 'ss6', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
    });

    expect(res.ok).toBe(true);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'sue@service.com' }));
  });

  test('a null/unreconstructable appointment time renders blank fields, not 1970', async () => {
    mockDb({
      customer: { id: 'c5', first_name: 'Pat', email: 'primary@example.com', phone: '+19415551234' },
      prefs: null,
    });

    await AppointmentEmail.sendAppointmentConfirmationEmail({
      customerId: 'c5', scheduledServiceId: 'ss5', appointmentTime: null, serviceLabel: 'Quarterly Pest Control',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ appointment_day: '', appointment_date: '', appointment_time: '' }),
    }));
    const payload = EmailTemplates.sendTemplate.mock.calls[0][0].payload;
    expect(JSON.stringify(payload)).not.toContain('1970');
  });

  test('no email anywhere returns missing_email and does not call the email provider', async () => {
    mockDb({
      customer: {
        id: 'c4', first_name: 'Pat', email: null, phone: '+19415551234',
        service_contact_name: 'Sue', service_contact_phone: '+19415557777', service_contact_email: null,
      },
      prefs: { appointment_notify_primary: false },
    });

    const res = await AppointmentEmail.sendAppointmentConfirmationEmail({
      customerId: 'c4', scheduledServiceId: 'ss4', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing_email');
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });
});
