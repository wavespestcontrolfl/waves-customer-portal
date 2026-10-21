/**
 * The cancellation text the Intelligence Bar cancel card shows is the text that is sent
 * (GATE_IB_CANCEL_WITH_EFFECTS). previewCancellationText and handleCancellation share ONE recipient resolution
 * (resolveNoticeContacts) and ONE renderer (renderCancellationBody). The card pins one template variant and the
 * recipients; Confirm hands the approved bodies to handleCancellation, which sends exactly those and refuses a
 * recipient the card did not approve. Synthetic names and numbers only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockState = {
  reminder: null, customer: null, prefs: null, claim: 1, cancelled: true, updates: [],
};
jest.mock('../models/db', () => {
  const chain = (table) => {
    const q = {
      where: () => q, whereNull: () => q, whereIn: () => q, whereNotNull: () => q, whereRaw: () => q, whereNot: () => q,
      leftJoin: () => q, select: () => q, orderBy: () => q,
      first: async () => {
        if (table === 'appointment_reminders') return mockState.reminder;
        if (table === 'customers') return mockState.customer;
        if (table === 'notification_prefs') return mockState.prefs;
        if (table === 'scheduled_services') return { status: mockState.cancelled ? 'cancelled' : 'confirmed', tech_name: null };
        return null;
      },
      update: async (patch) => { mockState.updates.push(patch); return mockState.claim; },
      then: (res, rej) => Promise.resolve([]).then(res, rej),
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
    expect(mockGetTemplate).not.toHaveBeenCalled();
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
