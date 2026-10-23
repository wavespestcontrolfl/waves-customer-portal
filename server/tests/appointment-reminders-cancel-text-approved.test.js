/**
 * The cancellation text the Intelligence Bar cancel card shows is the text that is sent
 * (GATE_IB_CANCEL_WITH_EFFECTS). previewCancellationText and handleCancellation share ONE recipient resolution
 * (resolveNoticeContacts) and ONE renderer (renderCancellationBody). The card pins one template variant and the
 * recipients; Confirm hands the approved bodies to handleCancellation, which sends exactly those and refuses a
 * recipient the card did not approve. Synthetic names and numbers only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockState = {
  reminder: null, customer: null, prefs: null, claim: 1, cancelled: true, updates: [], audit: null, auditRows: [], wheres: [], raws: [],
};
jest.mock('../models/db', () => {
  const chain = (table) => {
    const q = {
      where: (...a) => { mockState.wheres.push([table, ...a]); return q; }, whereNull: () => q, whereIn: () => q, whereNotNull: () => q,
      whereRaw: (...a) => { mockState.raws.push([table, ...a]); return q; }, whereNot: () => q,
      leftJoin: () => q, select: () => q, orderBy: () => q,
      first: async () => {
        if (table === 'appointment_reminders') return mockState.reminder;
        if (table === 'customers') return mockState.customer;
        if (table === 'notification_prefs') return mockState.prefs;
        if (table === 'messaging_audit_log') return mockState.audit;
        if (table === 'scheduled_services') return { status: mockState.cancelled ? 'cancelled' : 'confirmed', tech_name: null };
        return null;
      },
      insert: async (row) => { (mockState.inserts ||= []).push([table, row]); return [1]; },
      update: async (patch) => { mockState.updates.push(patch); return mockState.claim; },
      forUpdate: () => q,
      then: (res, rej) => Promise.resolve(table === 'messaging_audit_log' ? mockState.auditRows
        : table === 'appointment_reminders' ? (mockState.reminders || (mockState.reminder ? [mockState.reminder] : [])) : []).then(res, rej),
    };
    return q;
  };
  const qb = (table) => chain(table);
  qb.raw = (sql) => ({ __raw: String(sql) });
  qb.fn = { now: () => new Date() };
  qb.transaction = jest.fn(async (fn) => fn(qb));
  return qb;
});

const mockFence = jest.fn(async () => {});
jest.mock('../services/cancel-generation-fence', () => ({ assertCancelGeneration: (...a) => mockFence(...a) }));
const mockGetTemplate = jest.fn();
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: (...a) => mockGetTemplate(...a) }));
const mockSelectVariant = jest.fn();
jest.mock('../services/sms-template-variants', () => ({ selectVariant: (...a) => mockSelectVariant(...a) }));
const mockSendCustomerMessage = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...a) => mockSendCustomerMessage(...a),
  classifyDeliveryCertainty: () => 'certain',
  normalizeRecipient: (phone) => (phone ? `+1${String(phone).replace(/\D/g, '').slice(-10)}` : null),
}));
jest.mock('../services/messaging/push-channel-routing', () => ({ wantsAppFirst: async () => false }));
jest.mock('../services/messaging/validators/line-type', () => ({ readCachedLineType: async () => null, cacheLineType: async () => {}, NON_SMS_LINE_TYPES: [] }));
jest.mock('../services/recipient-optin', () => ({ filterRecipientsByOptin: async (contacts) => contacts }));
jest.mock('../services/street-level-hold', () => ({ heldVisitSubquery: () => ({}), isStreetLevelHoldVisit: async () => false }));
jest.mock('../services/property-notification-prefs', () => ({ prefsForVisit: async (prefs) => prefs }));

const AppointmentReminders = require('../services/appointment-reminders');

const BASE = 'Hi {first_name}, your {service_type} on {day}, {date} is cancelled.';
const render = (body, vars) => body.replace(/\{(\w+)\}/g, (_m, k) => vars[k]);

beforeEach(() => {
  jest.clearAllMocks();
  mockState.reminders = null;
  mockState.reminder = {
    id: 'rem-1', customer_id: 'cust-1', scheduled_service_id: 'svc-1', appointment_time: '2026-11-04T15:00:00Z', service_type: 'Pest Control',
  };
  mockState.customer = { id: 'cust-1', first_name: 'Synthia', last_name: 'Tester', phone: '+19415550101' };
  mockState.prefs = null;
  mockState.claim = 1;
  mockState.updates = [];
  mockFence.mockReset();
  mockFence.mockResolvedValue(undefined);
  mockState.audit = null;
  mockState.auditRows = [];
  mockState.wheres = [];
  mockState.raws = [];
  mockSelectVariant.mockResolvedValue(null);
  // Mirrors getTemplate: a pinned snapshot body renders as given, else the base body.
  mockGetTemplate.mockImplementation(async (_key, vars, _ctx, opts = {}) => render(opts.templateBody ?? BASE, vars));
  mockSendCustomerMessage.mockResolvedValue({ sent: true, blocked: false });
});

describe('previewCancellationText', () => {
  test('resolves the recipients the send uses and renders the text per recipient', async () => {
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    expect(preview.would_send).toBe(true);
    expect(preview.recipients).toHaveLength(1);
    expect(preview.recipients[0]).toMatchObject({ role: 'primary', phone_last4: '0101', first_name: 'Synthia' });
    expect(preview.recipients[0].recipient_key).toMatch(/^[0-9a-f]{16}$/);
    expect(preview.recipients[0].body).toMatch(/^Hi Synthia, your Pest Control on /);
    expect(preview.body).toBe(preview.recipients[0].body);
    expect(preview.template_body).toBeNull();
  });

  test('picks ONE weighted variant and pins its body; a re-check with the approved object renders the same wording', async () => {
    mockSelectVariant.mockResolvedValue({ body: 'Variant for {first_name}: {service_type} on {date} is off.' });
    const first = await AppointmentReminders.previewCancellationText('svc-1');
    expect(first.template_body).toBe('Variant for {first_name}: {service_type} on {date} is off.');
    expect(first.body).toMatch(/^Variant for Synthia: Pest Control on /);
    // A different variant would be drawn now, but the re-check ignores the draw and uses the pinned body.
    mockSelectVariant.mockResolvedValue({ body: 'Another variant' });
    const again = await AppointmentReminders.previewCancellationText('svc-1', { approved: first });
    expect(again).toEqual(first);
    expect(mockSelectVariant).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['no reminder record', 'no_reminder_record', () => { mockState.reminder = null; }],
    ['no customer', 'customer_not_found', () => { mockState.customer = null; }],
    ['an unrenderable template', 'template_unavailable', () => { mockGetTemplate.mockResolvedValue(null); }],
  ])('%s: no text is composed (%s)', async (_label, reason, arrange) => {
    arrange();
    expect(await AppointmentReminders.previewCancellationText('svc-1')).toMatchObject({ would_send: false, body: null, recipients: [], reason });
  });

  test('a pinned variant is refused when the template itself is no longer live', async () => {
    mockGetTemplate.mockImplementation(async (_k, vars, _c, opts = {}) => (opts.templateBody ? render(opts.templateBody, vars) : null));
    const out = await AppointmentReminders.previewCancellationText('svc-1', { approved: { template_body: 'Pinned {first_name}' } });
    expect(out.reason).toBe('template_unavailable');
  });
});

describe('handleCancellation sends the approved text', () => {
  test('without an approval it renders the live template per contact, as a Dispatch cancel always did', async () => {
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', { outcome });
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(mockSendCustomerMessage.mock.calls[0][0].body).toMatch(/^Hi Synthia, your Pest Control on /);
    expect(outcome.notificationSent).toBe(true);
  });

  test('with the card\'s approved body it sends exactly that body to that recipient', async () => {
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    mockGetTemplate.mockClear();
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', {
      outcome, approvedNotice: preview.recipients.map(({ recipient_key, body }) => ({ recipient_key, body: `${body} (approved)` })),
    });
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(mockSendCustomerMessage.mock.calls[0][0].body).toBe(`${preview.body} (approved)`);
    // The approved body is sent as shown; the template is read only to confirm it is still live (unaudited, no variant roll).
    expect(mockGetTemplate).toHaveBeenCalledTimes(1);
    expect(mockGetTemplate.mock.calls[0][3]).toEqual({ audit: false, noVariants: true });
  });

  test('a template disabled or removed after the card was built stops the approved send (the kill switch still applies)', async () => {
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    mockGetTemplate.mockResolvedValue(null); // the appointment_cancelled row is now inactive or gone
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', {
      outcome, approvedNotice: preview.recipients.map(({ recipient_key, body }) => ({ recipient_key, body })),
    });
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(outcome.notificationSent).toBe(false);
    expect(outcome.notificationError).toMatch(/missing or inactive/);
    // Terminal for an approved send: the sweep never re-sends it.
    const states = mockState.updates.filter((p) => typeof p.cancellation_notice_state === 'string').map((p) => p.cancellation_notice_state);
    expect(states[states.length - 1]).toBe('suppressed');
  });

  test('provider handoff began and then the send threw (acceptance without an audit row) is reported UNCERTAIN, never as a plain failure', async () => {
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    // The canonical sender runs the pre-dispatch fence (dispatchStarted), then its audit write fails after the handoff.
    mockSendCustomerMessage.mockImplementation(async (args) => {
      await args.preDispatchCheck();
      throw new Error('audit insert failed');
    });
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', {
      outcome, approvedNotice: preview.recipients.map(({ recipient_key, body }) => ({ recipient_key, body })),
    });
    expect(outcome.notificationSent).toBe(false);
    expect(outcome.notificationUncertain).toBe(true);
    expect(outcome.notificationError).toMatch(/may have gone out/);
    expect(outcome.notificationError).toMatch(/Check the customer's message history/);
    // Finalized as sent (the claim is never retried, so nothing re-texts the recipient).
    const states = mockState.updates.filter((p) => typeof p.cancellation_notice_state === 'string').map((p) => p.cancellation_notice_state);
    expect(states[states.length - 1]).toBe('sent');
  });

  test('a known not-sent failure (nothing reached the provider) still reports plain not-sent', async () => {
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    mockSendCustomerMessage.mockRejectedValue(new Error('provider timeout'));
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', {
      outcome, approvedNotice: preview.recipients.map(({ recipient_key, body }) => ({ recipient_key, body })),
    });
    expect(outcome.notificationSent).toBe(false);
    expect(outcome.notificationUncertain).toBeUndefined();
    expect(outcome.notificationPartial).toBeUndefined();
  });

  test('one recipient reached and another BLOCKED without a throw is reported partial (claim stays sent, no retry)', async () => {
    mockState.customer = {
      ...mockState.customer, service_contact_name: 'Sam', service_contact_phone: '+19415550202', service_contacts_consent_at: '2026-07-23T00:00:00Z',
    };
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    expect(preview.recipients).toHaveLength(2);
    // The primary is texted first; the service contact is refused by the provider layer (opt-out / landline block).
    mockSendCustomerMessage
      .mockResolvedValueOnce({ sent: true, blocked: false })
      .mockResolvedValueOnce({ sent: false, blocked: true, code: 'RECIPIENT_OPTED_OUT' });
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', {
      outcome, approvedNotice: preview.recipients.map(({ recipient_key, body }) => ({ recipient_key, body })),
    });
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(2);
    expect(outcome.notificationSent).toBe(true);
    expect(outcome.notificationPartial).toBe(true);
    expect(outcome.notificationError).toMatch(/not to the service contact/);
    expect(outcome.notificationError).toMatch(/Do not resend to those already reached/);
    expect(outcome.notificationError).not.toMatch(/\d{10}/); // no phone numbers
    const states = mockState.updates.filter((p) => typeof p.cancellation_notice_state === 'string').map((p) => p.cancellation_notice_state);
    expect(states[states.length - 1]).toBe('sent');
  });

  test('a carded contact removed from the appointment contacts before the send is reported as a gap, not a full success', async () => {
    mockState.customer = {
      ...mockState.customer, service_contact_name: 'Sam', service_contact_phone: '+19415550202', service_contacts_consent_at: '2026-07-23T00:00:00Z',
    };
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    expect(preview.recipients).toHaveLength(2);
    // The service contact is removed after the last preview check: only the primary is left to send to.
    delete mockState.customer.service_contact_name;
    delete mockState.customer.service_contact_phone;
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', {
      outcome, approvedNotice: preview.recipients.map(({ recipient_key, body }) => ({ recipient_key, body })),
    });
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(outcome.notificationSent).toBe(true);
    expect(outcome.notificationPartial).toBe(true);
    expect(outcome.notificationError).toMatch(/not to 1 approved recipient\(s\) no longer on the appointment contacts/);
    expect(outcome.notificationError).not.toMatch(/\d{10}/);
    const states = mockState.updates.filter((p) => typeof p.cancellation_notice_state === 'string').map((p) => p.cancellation_notice_state);
    expect(states[states.length - 1]).toBe('sent');
  });

  test('every recipient reached is a clean success (no partial flag)', async () => {
    mockState.customer = {
      ...mockState.customer, service_contact_name: 'Sam', service_contact_phone: '+19415550202', service_contacts_consent_at: '2026-07-23T00:00:00Z',
    };
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', {
      outcome, approvedNotice: preview.recipients.map(({ recipient_key, body }) => ({ recipient_key, body })),
    });
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ notificationSent: true, notificationError: null });
    expect(outcome.notificationPartial).toBeUndefined();
  });

  test('a recipient reached before a later recipient failed is reported as a PARTIAL delivery, never as not-sent', async () => {
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    // The service contact was added after the card: the primary is approved and sends, the new contact is refused.
    mockState.customer = {
      ...mockState.customer, service_contact_name: 'Sam', service_contact_phone: '+19415550202', service_contacts_consent_at: '2026-07-23T00:00:00Z',
    };
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', {
      outcome, approvedNotice: preview.recipients.map(({ recipient_key, body }) => ({ recipient_key, body })),
    });
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(mockSendCustomerMessage.mock.calls[0][0].to).toBe('+19415550101');
    expect(outcome.notificationSent).toBe(true);
    expect(outcome.notificationPartial).toBe(true);
    expect(outcome.notificationError).toMatch(/Do not resend/);
    expect(outcome.notificationError).toMatch(/approved for other recipients/);
    // The claim is finalized as sent (the accepted recipient is never re-texted by a retry).
    const states = mockState.updates.filter((p) => typeof p.cancellation_notice_state === 'string').map((p) => p.cancellation_notice_state);
    expect(states[states.length - 1]).toBe('sent');
  });

  test('a recipient the card did not approve is NOT texted (the send stops before any provider call)', async () => {
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', {
      outcome, approvedNotice: [{ recipient_key: 'deadbeefdeadbeef', body: 'Approved for someone else' }],
    });
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(outcome.notificationSent).toBe(false);
    expect(outcome.notificationError).toMatch(/approved for other recipients/);
  });

  test('sendNotification false sends nothing, with or without an approval', async () => {
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: false });
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: false, approvedNotice: [] });
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });
});

// An approved send is never left for the cancellation sweep: a retry would render the live template and resolve
// today's recipients, not what the card approved.
describe('a failed approved send is not retried by the sweep', () => {
  const noticeStates = () => mockState.updates.filter((p) => 'cancellation_notice_state' in p).map((p) => p.cancellation_notice_state);

  test('approved: a transient provider failure finalizes the claim terminally as suppressed and reports not-sent', async () => {
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    mockSendCustomerMessage.mockRejectedValue(new Error('provider timeout'));
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', {
      outcome, approvedNotice: preview.recipients.map(({ recipient_key, body }) => ({ recipient_key, body })),
    });
    expect(outcome.notificationSent).toBe(false);
    const states = noticeStates();
    expect(states[states.length - 1]).toBe('suppressed');
    // Never put back to a retryable 'pending' lease (the sweep's input) after the failure.
    expect(states.slice(states.indexOf('suppressed') + 1)).toEqual([]);
    expect(states.filter((x) => x === 'pending' || x === 'pending_notify').length).toBeLessThanOrEqual(1);
  });

  test('not approved (a plain Dispatch cancel): the same failure is NOT finalized as suppressed - the retry path is unchanged', async () => {
    mockSendCustomerMessage.mockRejectedValue(new Error('provider timeout'));
    await AppointmentReminders.handleCancellation('svc-1', { outcome: {} });
    expect(noticeStates()).not.toContain('suppressed');
  });
});

// The cancel transaction mints the approved send's claim as 'pending_approved' (job-status.js). No sweep lists that
// state, so a crash or a transient database failure before the approved send finalizes can never let the sweep text
// the live template to the current recipients. The approved send adopts the marker and finalizes it itself.
describe('the approved send owns a pending_approved marker', () => {
  const stateOf = (patch) => (patch && typeof patch.cancellation_notice_state === 'string' ? patch.cancellation_notice_state : undefined);
  const approved = async () => {
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    return preview.recipients.map(({ recipient_key, body }) => ({ recipient_key, body }));
  };

  test('the approved send adopts the marker, keeps it (never plain pending), and finalizes it as sent', async () => {
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', { outcome, approvedNotice: await approved() });
    const claim = mockState.updates.find((p) => p.cancellation_notice_at && 'cancellation_notice_state' in p);
    expect(claim.cancellation_notice_state).toBe('pending_approved');
    const states = mockState.updates.map(stateOf).filter(Boolean);
    expect(states).not.toContain('pending');
    expect(states).not.toContain('pending_notify');
    expect(states[states.length - 1]).toBe('sent');
    expect(outcome.notificationSent).toBe(true);
  });

  test('an unapproved (Dispatch) send is unchanged: it still claims with the CASE that yields pending / pending_notify', async () => {
    await AppointmentReminders.handleCancellation('svc-1', { outcome: {} });
    const claim = mockState.updates.find((p) => p.cancellation_notice_at && 'cancellation_notice_state' in p);
    expect(typeof claim.cancellation_notice_state).toBe('object');
    expect(JSON.stringify(claim.cancellation_notice_state)).toContain('pending_notify');
    expect(mockState.updates.map(stateOf)).not.toContain('pending_approved');
  });

  test('a failed approved send ends terminal suppressed, never back in a state the sweep adopts', async () => {
    mockSendCustomerMessage.mockRejectedValue(new Error('provider timeout'));
    await AppointmentReminders.handleCancellation('svc-1', { outcome: {}, approvedNotice: await approved() });
    const states = mockState.updates.map(stateOf).filter(Boolean);
    expect(states[states.length - 1]).toBe('suppressed');
    expect(states.slice(1)).not.toContain('pending');
    expect(states.slice(1)).not.toContain('pending_notify');
  });
});

// What the cancel recovery sweep (services/ib-cancel-effect-bundles.js) asks before it may send the approved text:
// only an untouched 'pending_approved' marker is 'ready'; a 'sent' marker with no accepted audit row means the provider
// handoff may have begun, so it is 'uncertain' and is never sent again.
describe('approvedCancellationNoticeStatus', () => {
  const sha = (value) => require('crypto').createHash('sha256').update(value, 'utf8').digest('hex');
  const KEY = (phone) => require('crypto').createHash('sha256').update(phone.replace(/\D/g, '').slice(-10), 'utf8').digest('hex').slice(0, 16);
  const statusFor = async (state, auditRows = [], options) => {
    mockState.reminder = { id: 'rem-1', customer_id: 'cust-1', cancellation_notice_state: state, cancellation_notice_at: new Date('2026-10-23T14:00:00.000Z') };
    mockState.auditRows = auditRows;
    return AppointmentReminders.approvedCancellationNoticeStatus('svc-1', options);
  };

  test.each([
    ['pending_approved', [], 'ready'],
    ['sent', [{ to_hash: 'h1' }], 'delivered'],
    ['sent', [], 'uncertain'],
    ['suppressed', [], 'suppressed'],
    ['pending', [], 'other'],
    ['pending_notify', [], 'other'],
    [null, [], 'other'],
  ])('marker %s with audit rows %j is %s (no recipient list: any accepted send)', async (state, rows, expected) => {
    expect(await statusFor(state, rows)).toBe(expected);
  });

  // Delivery is proven PER APPROVED RECIPIENT, by that recipient's own phone: a count of destinations proves nothing (an
  // accepted SMS followed by an email fallback to the same person is two destinations and one person).
  // A visit can have several reminder rows. The live send may have sent one and died before reporting while a sibling is untouched:
  // the untouched sibling must never make the text 'ready' (it would be sent a second time).
  describe('several reminder rows for the visit', () => {
    const row = (id, state, at = '2026-10-23T14:00:00.000Z') => ({ id, customer_id: 'cust-1', cancellation_notice_state: state, cancellation_notice_at: at ? new Date(at) : null });
    const status = async (rows, auditRows = [{ to_hash: 'h1' }], options) => {
      mockState.reminders = rows;
      mockState.auditRows = auditRows;
      return AppointmentReminders.approvedCancellationNoticeStatus('svc-1', options);
    };

    test('every row untouched is ready; a sibling already sent makes it delivered/uncertain, never ready (whatever the row order)', async () => {
      expect(await status([row('a', 'pending_approved'), row('b', 'pending_approved')])).toBe('ready');
      expect(await status([row('a', 'sent'), row('b', 'pending_approved')])).toBe('delivered');
      expect(await status([row('a', 'pending_approved'), row('b', 'sent')])).toBe('delivered');
      expect(await status([row('a', 'pending_approved'), row('b', 'sent')], [])).toBe('uncertain');
      expect(await status([row('a', 'pending_approved'), row('b', 'suppressed')])).toBe('suppressed');
      expect(await status([row('a', 'pending_approved'), row('b', 'pending')])).toBe('other');
    });

    test('a null-state sibling (never marked) does not block ready; delivery is judged on every sent row\'s token', async () => {
      expect(await status([row('a', 'pending_approved'), row('b', null, null)])).toBe('ready');
      const keys = [KEY('+19415550101')];
      expect(await status([row('a', 'sent'), row('b', 'pending_approved')], [{ to_hash: sha('+19415550101') }], { recipientKeys: keys })).toBe('delivered');
      const audit = mockState.raws.filter(([table]) => table === 'messaging_audit_log').map(([, sql]) => String(sql));
      expect(audit.every((sql) => !sql.includes('transitioned_at'))).toBe(true);
    });

    test('the fenced claim adopts nothing while a sibling row was touched, and adopts when every row is untouched', async () => {
      const FENCE2 = { visitId: 'svc-1', restorations: 0, hits: [] };
      const claim = async (rows) => {
        mockState.reminders = rows;
        mockState.updates = [];
        return AppointmentReminders.claimApprovedNoticeForGeneration({ id: 'a', scheduled_service_id: 'svc-1' }, FENCE2);
      };
      expect((await claim([row('a', 'pending_approved'), row('b', 'sent')])).claimed).toBe(0);
      expect(mockState.updates.some((u) => 'cancellation_notice_at' in u)).toBe(false);
      expect((await claim([row('a', 'pending_approved'), row('b', 'pending_approved')])).claimed).toBe(1);
    });
  });

  test('delivered needs an accepted audit row for the phone of EVERY approved recipient', async () => {
    const primary = '+19415550101';
    const keys = [KEY(primary)];
    expect(await statusFor('sent', [{ to_hash: sha(primary) }], { recipientKeys: keys })).toBe('delivered');
  });

  test('an email-fallback destination or another recipient\'s phone is not proof for this recipient: partial, never delivered', async () => {
    const keys = [KEY('+19415550101')];
    expect(await statusFor('sent', [{ to_hash: sha('someone@example.test') }], { recipientKeys: keys })).toBe('partial');
    expect(await statusFor('sent', [{ to_hash: sha('+19415550199') }], { recipientKeys: keys })).toBe('partial');
  });

  test('two approved recipients with one of them proven, or one that is no longer a contact, is partial', async () => {
    const keys = [KEY('+19415550101'), KEY('+19415550177')];
    expect(await statusFor('sent', [{ to_hash: sha('+19415550101') }], { recipientKeys: keys })).toBe('partial');
    expect(await statusFor('sent', [{ to_hash: sha('+19415550101') }, { to_hash: sha('+19415550177') }], { recipientKeys: keys })).toBe('partial'); // 0177 is not on the customer
  });

  test('no accepted audit rows at all is uncertain whatever the recipient list', async () => {
    expect(await statusFor('sent', [], { recipientKeys: [KEY('+19415550101')] })).toBe('uncertain');
  });

  test('no reminder row at all', async () => {
    mockState.reminder = null;
    expect(await AppointmentReminders.approvedCancellationNoticeStatus('svc-1')).toBe('no_reminder');
  });

  test('it never sends or claims anything', async () => {
    await statusFor('pending_approved');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockState.updates).toEqual([]);
  });
});

// The recovery sweep sends with cancelGeneration (a cancel-generation fence). Its claim is its own small transaction: the
// fence takes a share lock on the visit and proves the pinned generation, THEN the approved marker is claimed, so a
// restore + re-cancel cannot replace the reminder between the proof and the claim (a single UPDATE with subqueries could
// not promise that: PostgreSQL re-checks only the updated tuple after a lock wait).
describe('handleCancellation with cancelGeneration (the cancel recovery sweep)', () => {
  const FENCE = { visitId: 'svc-1', restorations: 2, hits: [] };
  const approvedNotice = [{ recipient_key: require('crypto').createHash('sha256').update('9415550101', 'utf8').digest('hex').slice(0, 16), body: 'Hi Synthia, your visit is cancelled.' }];
  const run = (outcome = {}) => AppointmentReminders.handleCancellation('svc-1', { sendNotification: true, approvedNotice, cancelGeneration: FENCE, outcome });

  // One approved recipient is reached before 8 PM and the next crosses the send window: the generic rail would queue it for a
  // replay that carries no generation or visit-date constraint. The fenced recovery send never queues; it reports the gap.
  test('a recipient held by the send window is NOT queued for a later replay; it is reported as not reached', async () => {
    mockState.customer = {
      ...mockState.customer, service_contact_name: 'Sam', service_contact_phone: '+19415550202', service_contacts_consent_at: '2026-07-23T00:00:00Z',
    };
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    const both = preview.recipients.map(({ recipient_key, body }) => ({ recipient_key, body }));
    mockSendCustomerMessage
      .mockResolvedValueOnce({ sent: true, blocked: false })
      .mockResolvedValueOnce({ sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', deferred: true, nextAllowedAt: '2026-11-04T12:00:00Z' });
    mockState.inserts = [];
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: true, approvedNotice: both, cancelGeneration: { ...FENCE, hits: [] }, outcome });
    expect(mockState.inserts.some(([table]) => table === 'sms_log')).toBe(false);
    expect(outcome).toMatchObject({ notificationSent: true, notificationPartial: true });
    expect(outcome.notificationError).toMatch(/Do not resend to those already reached/);
  });

  // Delivery evidence is matched by the claim token the approved send put on its audit rows, never by a time window.
  test('the approved send puts its claim token on its audit rows, and the evidence queries match that token (no cycle window)', async () => {
    mockSendCustomerMessage.mockClear();
    mockState.raws.length = 0;
    await run();
    const meta = mockSendCustomerMessage.mock.calls[0][0].metadata;
    expect(meta.cancellation_notice_token).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    // A status read on a 'sent' marker filters the audit by the reminder's own token and never by transitioned_at.
    mockState.raws.length = 0;
    mockState.reminder = { ...mockState.reminder, cancellation_notice_state: 'sent', cancellation_notice_at: new Date('2026-10-23T14:00:00.000Z') };
    await AppointmentReminders.approvedCancellationNoticeStatus('svc-1', { recipientKeys: approvedNotice.map((n) => n.recipient_key) });
    const audit = mockState.raws.filter(([table]) => table === 'messaging_audit_log').map(([, sql]) => String(sql));
    expect(audit.some((sql) => sql.includes("metadata->>'cancellation_notice_token'"))).toBe(true);
    expect(audit.some((sql) => sql.includes('transitioned_at'))).toBe(false);
    // A 'sent' marker with no claim token is unprovable, not delivered.
    mockState.reminder = { ...mockState.reminder, cancellation_notice_at: null };
    expect(await AppointmentReminders.approvedCancellationNoticeStatus('svc-1', {})).toBe('uncertain');
  });

  // The send window closes before the FIRST recipient: nothing was sent, so the claim is parked, not terminally suppressed.
  test('a window hold before any recipient keeps the approved marker (stamp reverted) and flags the bundle to park', async () => {
    mockSendCustomerMessage.mockImplementationOnce(async (input) => {
      await input.preDispatchCheck(); // the pre-dispatch stamp is made, then the provider boundary re-check finds 8 PM passed
      return { sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', deferred: true, nextAllowedAt: '2026-11-04T12:00:00Z' };
    });
    const fence = { ...FENCE, hits: [] };
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: true, approvedNotice, cancelGeneration: fence, outcome });
    expect(fence.windowHeld).toBe(true);
    const states = mockState.updates.filter((u) => typeof u.cancellation_notice_state === 'string').map((u) => u.cancellation_notice_state);
    expect(states[states.length - 1]).toBe('pending_approved');
    expect(states).not.toContain('suppressed');
    expect(outcome.notificationSent).toBe(false);
  });

  test('a window hold on the first recipient followed by a blocked second recipient still parks (nobody reached)', async () => {
    mockState.customer = {
      ...mockState.customer, service_contact_name: 'Sam', service_contact_phone: '+19415550202', service_contacts_consent_at: '2026-07-23T00:00:00Z',
    };
    const preview = await AppointmentReminders.previewCancellationText('svc-1');
    const both = preview.recipients.map(({ recipient_key, body }) => ({ recipient_key, body }));
    mockSendCustomerMessage
      .mockImplementationOnce(async (input) => { await input.preDispatchCheck(); return { sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', deferred: true, nextAllowedAt: '2026-11-04T12:00:00Z' }; })
      .mockResolvedValueOnce({ sent: false, blocked: true, code: 'RECIPIENT_OPTED_OUT' });
    const fence = { ...FENCE, hits: [] };
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: true, approvedNotice: both, cancelGeneration: fence, outcome: {} });
    expect(fence.windowHeld).toBe(true);
    const states = mockState.updates.filter((u) => typeof u.cancellation_notice_state === 'string').map((u) => u.cancellation_notice_state);
    expect(states).not.toContain('suppressed');
    expect(states[states.length - 1]).toBe('pending_approved');
  });

  test('the fence is proven inside a transaction, before the marker is claimed, and only the approved marker is claimed', async () => {
    const order = [];
    mockFence.mockImplementationOnce(async (trx, fence) => { order.push(['fence', fence, mockState.updates.filter((u) => 'cancellation_notice_state' in u).length]); });
    await run();
    expect(order).toEqual([['fence', FENCE, 0]]);
    expect(require('../models/db').transaction).toHaveBeenCalled();
    expect(mockState.wheres).toContainEqual(['appointment_reminders', { id: 'rem-1', cancellation_notice_state: 'pending_approved' }]);
    expect(mockState.updates.find((u) => 'cancellation_notice_state' in u)).toMatchObject({ cancellation_notice_state: 'pending_approved' });
  });

  // handleCancellation's own "close the reminder" write (cancelled: true), run on an older snapshot after a concurrent
  // restore, could re-close the LIVE visit's reminder and suppress its future reminders. For a fenced send it moves inside
  // the share-locked transaction, after the proof.
  test('the reminder close is not an unfenced write: it runs in the fenced transaction, after the proof, never before', async () => {
    const order = [];
    mockFence.mockImplementationOnce(async () => { order.push(['fence', mockState.updates.filter((u) => u.cancelled === true).length]); });
    await run();
    expect(order).toEqual([['fence', 0]]);
    expect(mockState.updates.filter((u) => u.cancelled === true)).toHaveLength(1);
  });

  // One more proof right before the stamp that precedes the provider handoff (a point-in-time check: the handoff itself cannot
  // be un-sent, and the claim's token already fails if a restore cleared the marker).
  test('the pre-dispatch stamp re-proves the generation and aborts the handoff when the visit was restored', async () => {
    mockSendCustomerMessage.mockClear();
    await run();
    const preDispatch = mockSendCustomerMessage.mock.calls[0][0].preDispatchCheck;
    expect(typeof preDispatch).toBe('function');
    mockFence.mockClear();
    expect(await preDispatch()).toEqual({ ok: true });
    expect(mockFence).toHaveBeenCalledWith(expect.anything(), FENCE);
    mockFence.mockRejectedValueOnce(Object.assign(new Error('cancellation fence: visit_is_confirmed'), { code: 'CANCEL_FENCE' }));
    expect(await preDispatch()).toMatchObject({ ok: false, code: 'appointment_restored' });
  });

  // A BUSY visit (an edit or a restore in flight) is not a verdict. The check runs before any stamp or handoff, so the finalizer
  // must leave the approved marker as it is (not terminal suppressed) and the next pass sends the text.
  test('a busy visit at the pre-dispatch proof blocks this attempt but keeps the approved marker for the retry', async () => {
    const fence = { visitId: 'svc-1', restorations: 2, hits: [] };
    // The claim transaction's proof passes; the pre-dispatch proof (the pool) reports busy as the send runs.
    mockSendCustomerMessage.mockImplementationOnce(async (input) => {
      mockFence.mockRejectedValueOnce(Object.assign(new Error('cancellation fence: visit_busy'), { code: 'CANCEL_FENCE', fenceReason: 'visit_busy' }));
      const verdict = await input.preDispatchCheck();
      return { sent: false, blocked: true, code: verdict.code };
    });
    mockState.updates.length = 0;
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: true, approvedNotice, cancelGeneration: fence, outcome });
    expect(fence.retryable).toBe(true);
    // No terminal marker was written: the only notice-state write is the fenced claim itself (still pending_approved).
    const stateWrites = mockState.updates.filter((u) => 'cancellation_notice_state' in u).map((u) => u.cancellation_notice_state);
    expect(stateWrites).toEqual(['pending_approved']);
    expect(outcome.notificationSent).toBe(false);
    // The retry (next sweep pass, a fresh fence, the visit no longer busy) claims the same marker again and the text goes out.
    const retryOutcome = {};
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: true, approvedNotice, cancelGeneration: { visitId: 'svc-1', restorations: 2, hits: [] }, outcome: retryOutcome });
    expect(retryOutcome.notificationSent).toBe(true);
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(2);
  });

  test('a definitive change at the pre-dispatch proof is not marked retryable', async () => {
    const fence = { visitId: 'svc-1', restorations: 2, hits: [] };
    mockSendCustomerMessage.mockImplementationOnce(async (input) => {
      mockFence.mockRejectedValueOnce(Object.assign(new Error('cancellation fence: visit_is_confirmed'), { code: 'CANCEL_FENCE', fenceReason: 'visit_is_confirmed' }));
      const verdict = await input.preDispatchCheck();
      return { sent: false, blocked: true, code: verdict.code };
    });
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: true, approvedNotice, cancelGeneration: fence, outcome: {} });
    expect(fence.retryable).toBeUndefined();
  });

  test('without cancelGeneration the pre-dispatch check never consults the fence', async () => {
    mockSendCustomerMessage.mockClear();
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: true, approvedNotice, outcome: {} });
    mockFence.mockClear();
    await mockSendCustomerMessage.mock.calls[0][0].preDispatchCheck();
    expect(mockFence).not.toHaveBeenCalled();
  });

  test('a refused fence leaves the reminder open (no close at all)', async () => {
    mockFence.mockRejectedValueOnce(Object.assign(new Error('cancellation fence: visit_is_confirmed'), { code: 'CANCEL_FENCE' }));
    await run();
    expect(mockState.updates.filter((u) => u.cancelled === true)).toEqual([]);
  });

  test('a refused fence claims and sends nothing, and says so', async () => {
    mockFence.mockRejectedValueOnce(Object.assign(new Error('cancellation fence: visit_busy'), { code: 'CANCEL_FENCE' }));
    const outcome = {};
    await run(outcome);
    expect(mockState.updates.filter((u) => 'cancellation_notice_state' in u)).toEqual([]);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(outcome.notificationSent).toBe(false);
  });

  test('a claim that matches no row (the marker is gone) sends nothing', async () => {
    mockState.claim = 0;
    const outcome = {};
    await run(outcome);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(outcome.notificationSent).toBe(false);
  });

  test('without cancelGeneration the fence is never consulted and the close is the ordinary guarded write (the request and Dispatch are unchanged)', async () => {
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: true, approvedNotice, outcome: {} });
    expect(mockFence).not.toHaveBeenCalled();
    expect(mockState.updates.filter((u) => u.cancelled === true)).toHaveLength(1);
  });
});
