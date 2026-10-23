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
      update: async (patch) => { mockState.updates.push(patch); return mockState.claim; },
      then: (res, rej) => Promise.resolve(table === 'messaging_audit_log' ? mockState.auditRows : []).then(res, rej),
    };
    return q;
  };
  const qb = (table) => chain(table);
  qb.raw = (sql) => ({ __raw: String(sql) });
  qb.fn = { now: () => new Date() };
  return qb;
});

const mockGetTemplate = jest.fn();
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: (...a) => mockGetTemplate(...a) }));
const mockSelectVariant = jest.fn();
jest.mock('../services/sms-template-variants', () => ({ selectVariant: (...a) => mockSelectVariant(...a) }));
const mockSendCustomerMessage = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...a) => mockSendCustomerMessage(...a),
  classifyDeliveryCertainty: () => 'certain',
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
  mockState.reminder = {
    id: 'rem-1', customer_id: 'cust-1', scheduled_service_id: 'svc-1', appointment_time: '2026-11-04T15:00:00Z', service_type: 'Pest Control',
  };
  mockState.customer = { id: 'cust-1', first_name: 'Synthia', last_name: 'Tester', phone: '+19415550101' };
  mockState.prefs = null;
  mockState.claim = 1;
  mockState.updates = [];
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
  const statusFor = async (state, auditRows = [], options) => {
    mockState.reminder = { id: 'rem-1', cancellation_notice_state: state };
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
  ])('marker %s with audit rows %j is %s', async (state, rows, expected) => {
    expect(await statusFor(state, rows)).toBe(expected);
  });

  test('delivered needs an accepted audit row for EVERY approved recipient; fewer is partial, never delivered', async () => {
    expect(await statusFor('sent', [{ to_hash: 'h1' }], { recipients: 2 })).toBe('partial');
    // Two rows for the same recipient (app + sms legs) are still one recipient.
    expect(await statusFor('sent', [{ to_hash: 'h1' }, { to_hash: 'h1' }], { recipients: 2 })).toBe('partial');
    expect(await statusFor('sent', [{ to_hash: 'h1' }, { to_hash: 'h2' }], { recipients: 2 })).toBe('delivered');
    expect(await statusFor('sent', [], { recipients: 2 })).toBe('uncertain');
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

// The recovery sweep sends with cancelGeneration: the claim itself is one statement that adopts only the untouched approved
// marker while the visit is still the cancelled one the bundle was written for (no transition to another status since).
describe('handleCancellation with cancelGeneration (the cancel recovery sweep)', () => {
  const SINCE = new Date('2026-10-23T14:00:00Z');
  const approvedNotice = [{ recipient_key: 'any', body: 'x' }];

  test('the tokenless claim is bound to the original cancellation generation', async () => {
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: true, approvedNotice, cancelGeneration: { since: SINCE }, outcome: {} });
    expect(mockState.wheres).toContainEqual(['appointment_reminders', 'cancellation_notice_state', 'pending_approved']);
    const raw = mockState.raws.find(([, sql]) => /NOT EXISTS \(SELECT 1 FROM job_status_history h/.test(sql));
    expect(raw).toBeTruthy();
    expect(raw[1]).toMatch(/h\.to_status <> 'cancelled' AND h\.transitioned_at > \?/);
    expect(raw[2]).toEqual([SINCE]);
    expect(mockState.raws.some(([, sql]) => /ss\.status = 'cancelled'/.test(sql))).toBe(true);
  });

  test('a claim that matches no row (the visit changed) sends nothing', async () => {
    mockState.claim = 0;
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: true, approvedNotice, cancelGeneration: { since: SINCE }, outcome });
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(outcome.notificationSent).toBe(false);
  });

  test('without cancelGeneration the claim carries no generation condition (the request and Dispatch are unchanged)', async () => {
    await AppointmentReminders.handleCancellation('svc-1', { sendNotification: true, approvedNotice, outcome: {} });
    expect(mockState.raws.some(([, sql]) => /NOT EXISTS \(SELECT 1 FROM job_status_history h/.test(sql))).toBe(false);
    expect(mockState.wheres).not.toContainEqual(['appointment_reminders', 'cancellation_notice_state', 'pending_approved']);
  });
});
