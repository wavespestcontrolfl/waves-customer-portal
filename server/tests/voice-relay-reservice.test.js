/**
 * Voice-relay Phase E item 3 — EXISTING-CUSTOMER RESERVICE ROUTING.
 *
 * Matrix:
 *   - gate off → refuses, zero DB touch
 *   - ANI-MATCHED existing customer with a problem between visits → a
 *     service_requests row on their account (the portal's own vocabulary),
 *     NOT a lead; the hangup capture floor is suppressed
 *   - UNMATCHED caller → refused here, keeps using capture_lead
 *   - a looked-up customer_ref is refused (the write lands on an account the
 *     caller's voice was never verified for)
 *   - an already-open request, or an already-booked free re-service, blocks a
 *     second one
 *   - ⭐ `reservice_token` NEVER appears in ANY output (regex over every
 *     model-facing string this lane can emit), and is never even selected
 *   - no customer-facing comms on any path
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({ CONTACT_MATCH_PHONE_COLS: ['phone'], summarizePriorCall: jest.fn() }));
jest.mock('../services/reservice-scheduler', () => ({
  openReserviceCallbacks: jest.fn(async () => ({})),
  reserviceLanesForCustomer: jest.fn(async () => ['pest']),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n-1' })) }));
// The INTERNAL owner alert (owner ruling: a filed re-service must reach a human,
// not the ticket queue). Mocked here — its own behavior is covered in
// voice-relay-alert.test.js.
jest.mock('../services/voice-agent/relay-alert', () => ({
  alertOwnerHotLead: jest.fn(async () => false),
  alertOwnerReservice: jest.fn(async () => true),
}));
// Customer-facing spies — must stay un-called on every path.
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/email', () => ({ send: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({ registerAppointment: jest.fn() }));

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const relayAlert = require('../services/voice-agent/relay-alert');
const logger = require('../services/logger');
const reserviceScheduler = require('../services/reservice-scheduler');
const TwilioService = require('../services/twilio');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailService = require('../services/email');
const AppointmentReminders = require('../services/appointment-reminders');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');

const relayReservice = require('../services/voice-agent/relay-reservice');
const { executeTool, CONTEXT_TOOLS, activeTools } = require('../services/voice-agent/relay-tools');

// Synthetic fixtures only.
const CUSTOMER_ID = 'c-1111';
const CALLER = '+19415550142';
// A realistic-SHAPED synthetic token (64 lowercase hex, like customers.reservice_token).
const FAKE_TOKEN = 'a1b2c3d4'.repeat(8);
const RESERVICE_TOKEN_RE = /[a-f0-9]{32,}|reservice_token|\/reservice\//i;

function makeBuilder(rows, { insertRows } = {}) {
  const b = {};
  for (const m of ['where', 'whereNull', 'whereIn', 'whereNot', 'orderBy', 'select', 'limit']) b[m] = jest.fn(() => b);
  b.first = jest.fn(() => Promise.resolve(rows[0] || null));
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  b.insert = jest.fn(() => b);
  b.returning = jest.fn(() => Promise.resolve(insertRows || [{ id: 'sr-1' }]));
  b.update = jest.fn(() => { throw new Error('UNEXPECTED UPDATE'); });
  b.del = jest.fn(() => { throw new Error('UNEXPECTED DELETE'); });
  return b;
}

let builders;
function primeDb({ requests = [], customers = [{ id: CUSTOMER_ID, active: true, waveguard_tier: 'silver', monthly_rate: 49 }] } = {}) {
  builders = {
    service_requests: makeBuilder(requests),
    customers: makeBuilder(customers),
  };
  db.mockImplementation((table) => {
    if (!builders[table]) builders[table] = makeBuilder([]);
    return builders[table];
  });
}

function assertNoComms() {
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(EmailService.send).not.toHaveBeenCalled();
  expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
}

const savedGate = process.env.VOICE_RELAY_CONTEXT_ENABLED;
afterAll(() => {
  if (savedGate === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedGate;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  primeDb();
  reserviceScheduler.openReserviceCallbacks.mockResolvedValue({});
  reserviceScheduler.reserviceLanesForCustomer.mockResolvedValue(['pest']);
});

const GOOD = { lane: 'pest', issue: 'ants are back in the kitchen along the baseboard' };
const CTX = { customerId: CUSTOMER_ID, callSid: 'CA-res-1', markCaptured: jest.fn(), markReserviceFiled: jest.fn() };

describe('GATE OFF — dark', () => {
  test('refuses, zero DB touch, no comms', async () => {
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(out).toMatch(/not available/i);
    expect(activeTools().map((t) => t.name)).not.toContain('request_reservice');
    expect(db).not.toHaveBeenCalled();
    assertNoComms();
  });
});

describe('GATE ON', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('the tool registers with the context tools and requires lane + issue', () => {
    expect(activeTools().map((t) => t.name)).toContain('request_reservice');
    const tool = CONTEXT_TOOLS.find((t) => t.name === 'request_reservice');
    expect(tool.input_schema.required).toEqual(['lane', 'issue']);
    expect(tool.input_schema.properties.lane.enum).toEqual(['pest', 'lawn']);
  });

  test('MATCHED existing customer → a service_requests row in the portal\'s own vocabulary', async () => {
    const out = await executeTool('request_reservice', GOOD, CTX);

    const insert = builders.service_requests.insert;
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row).toMatchObject({
      customer_id: CUSTOMER_ID,
      category: 'pest_issue',
      urgency: 'routine',
      status: 'new',
      source: 'voice_agent',
    });
    expect(row.description).toContain('ants are back');
    expect(row.subject).toMatch(/^Re-service request \(phone assistant\)/);
    expect(row.photos).toBe('[]');

    // Routed to the RE-SERVICE lane, not the lead pipeline.
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
    // …and the hangup capture floor is suppressed so no lead noise follows.
    expect(CTX.markCaptured).toHaveBeenCalled();

    // Internal admin notification only.
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][0]).toBe('service');
    assertNoComms();

    expect(out).toMatch(/NOTHING IS SCHEDULED YET/);
    expect(out).toMatch(/never state a date, a time, a link, or a code/i);
  });

  test('lawn lane maps to the lawn_concern category; urgent maps to the urgent enum', async () => {
    await executeTool('request_reservice', { lane: 'lawn', issue: 'brown patches spreading', urgent: true }, CTX);
    expect(builders.service_requests.insert.mock.calls[0][0]).toMatchObject({
      category: 'lawn_concern', urgency: 'urgent',
    });
    expect(NotificationService.notifyAdmin.mock.calls[0][1]).toMatch(/URGENT/);
  });

  test('UNMATCHED caller → refused with capture_lead guidance, nothing written', async () => {
    const out = await executeTool('request_reservice', GOOD, { customerId: null, callSid: 'CA-x' });
    expect(out).toMatch(/use capture_lead/i);
    expect(builders.service_requests.insert).not.toHaveBeenCalled();
    assertNoComms();
  });

  test('a looked-up customer_ref is refused — this writes to an unverified account', async () => {
    const out = await executeTool('request_reservice', { ...GOOD, customer_ref: 'C1' }, {
      ...CTX, resolveLookupRef: () => CUSTOMER_ID,
    });
    expect(out).toMatch(/own phone number matches/i);
    expect(builders.service_requests.insert).not.toHaveBeenCalled();
  });

  test('missing/invalid lane or issue → asks, writes nothing', async () => {
    for (const input of [{ issue: 'ants' }, { lane: 'roof', issue: 'ants' }, { lane: 'pest', issue: '  ' }]) {
      const out = await executeTool('request_reservice', input, CTX);
      expect(out).toMatch(/ask the caller/i);
    }
    expect(builders.service_requests.insert).not.toHaveBeenCalled();
  });

  test('an already-OPEN request in the lane blocks a second one', async () => {
    primeDb({ requests: [{ id: 'sr-old', created_at: '2026-08-10T12:00:00Z' }] });
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(out).toMatch(/already open/i);
    expect(out).toMatch(/do NOT file another/i);
    expect(builders.service_requests.insert).not.toHaveBeenCalled();
    // The open-request query used the portal's own non-terminal status set.
    expect(builders.service_requests.whereIn).toHaveBeenCalledWith('status', ['new', 'acknowledged', 'scheduled']);
  });

  test('an already-BOOKED free re-service in the lane blocks a second one (picker\'s own dedupe read)', async () => {
    reserviceScheduler.openReserviceCallbacks.mockResolvedValue({
      pest: { date: '2026-08-20', windowStart: '09:00', serviceType: 'Re-Service', rescheduleUrl: '/reschedule/deadbeef' },
    });
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(out).toMatch(/ALREADY on the schedule/i);
    expect(builders.service_requests.insert).not.toHaveBeenCalled();
    // Even the reschedule URL the dedupe read carries is never spoken.
    expect(out).not.toContain('/reschedule/');
    expect(out).toMatch(/never read out a link or a code/i);
  });

  test('coverage is stated only when the plan actually grants the lane', async () => {
    reserviceScheduler.reserviceLanesForCustomer.mockResolvedValue([]);
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(out).toMatch(/Do NOT tell the caller whether it is free/i);
  });

  // COVERAGE affects the SCRIPT only ("this is free"), never permission — a
  // failure there is genuinely fail-soft.
  test('a COVERAGE lookup failure never blocks the filing (fail-soft)', async () => {
    reserviceScheduler.reserviceLanesForCustomer.mockRejectedValue(new Error('db down'));
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(builders.service_requests.insert).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/Re-service request filed/i);
    expect(out).toMatch(/Do NOT tell the caller whether it is free/i);
  });

  // ⭐ THE DEDUPE FAILS CLOSED. openReserviceCallbacks answers "is a free
  // re-service ALREADY booked?" — a failure there used to be caught and
  // continued, which reads exactly like "no", and filed a duplicate ticket for
  // a customer who already had a visit on the calendar.
  test('a DEDUPE lookup failure refuses to file (fail closed)', async () => {
    reserviceScheduler.openReserviceCallbacks.mockRejectedValue(new Error('db down'));
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(builders.service_requests.insert).not.toHaveBeenCalled();
    expect(out).toMatch(/could not check whether a re-service is already on the schedule/i);
    expect(out).toMatch(/nothing was filed/i);
    expect(out).not.toMatch(/filed for this account/i);
  });

  test('an admin-notification failure never loses the request', async () => {
    NotificationService.notifyAdmin.mockRejectedValue(new Error('bell down'));
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(builders.service_requests.insert).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/Re-service request filed/i);
  });

  // notifyAdmin SWALLOWS DB errors and returns null instead of throwing — which
  // is exactly why routes/requests.js checks `if (!notif)`. A dropped return
  // means the request is durable but INVISIBLE in the admin feed, silently.
  test('a notifyAdmin that returns null (swallowed DB error) is logged LOUDLY', async () => {
    NotificationService.notifyAdmin.mockResolvedValue(null);
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(builders.service_requests.insert).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/Re-service request filed/i);
    const errors = logger.error.mock.calls.map(([m]) => String(m)).join(' | ');
    expect(errors).toMatch(/did NOT persist/i);
    expect(errors).toMatch(/unsurfaced in the admin feed/i);
  });

  // ⭐ OWNER-RULED ROUTING FIX: the ticket alone lands in a queue with a
  // documented 0/14 resolution rate, so every voice-filed re-service also pages
  // the owner through the existing internal alert path.
  test('every filed re-service ALSO fires the internal owner alert', async () => {
    await executeTool('request_reservice', GOOD, CTX);
    expect(builders.service_requests.insert).toHaveBeenCalledTimes(1);
    expect(relayAlert.alertOwnerReservice).toHaveBeenCalledTimes(1);
    const [payload] = relayAlert.alertOwnerReservice.mock.calls[0];
    expect(payload).toMatchObject({ lane: 'pest', category: 'pest_issue' });
    expect(payload.requestId).toBeTruthy();
  });

  test('an owner-alert failure never loses the request (fail-open)', async () => {
    relayAlert.alertOwnerReservice.mockRejectedValue(new Error('twilio down'));
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(builders.service_requests.insert).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/Re-service request filed/i);
  });

  test('a REFUSED filing fires no owner alert', async () => {
    reserviceScheduler.openReserviceCallbacks.mockResolvedValue({ pest: { date: '2026-08-20' } });
    await executeTool('request_reservice', GOOD, CTX);
    expect(builders.service_requests.insert).not.toHaveBeenCalled();
    expect(relayAlert.alertOwnerReservice).not.toHaveBeenCalled();
  });
});

describe('⭐ reservice_token NEVER leaves the building by voice', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('the customer read never SELECTS reservice_token', async () => {
    await executeTool('request_reservice', GOOD, CTX);
    const selected = builders.customers.first.mock.calls.flat().flat();
    expect(selected).not.toContain('reservice_token');
    expect(selected).toEqual(expect.arrayContaining(['id', 'active']));
  });

  test('no output this lane can emit matches a token, a token-shaped run, or a /reservice/ link', async () => {
    const outputs = [];
    // every branch, including the ones that read token-adjacent state
    outputs.push(await executeTool('request_reservice', GOOD, CTX));
    outputs.push(await executeTool('request_reservice', GOOD, { customerId: null }));
    outputs.push(await executeTool('request_reservice', { ...GOOD, customer_ref: 'C1' }, CTX));
    outputs.push(await executeTool('request_reservice', { issue: 'x' }, CTX));

    primeDb({ requests: [{ id: 'sr-old', created_at: '2026-08-10T12:00:00Z' }] });
    outputs.push(await executeTool('request_reservice', GOOD, CTX));

    primeDb();
    reserviceScheduler.openReserviceCallbacks.mockResolvedValue({
      pest: { date: '2026-08-20', windowStart: '09:00', rescheduleUrl: `/reschedule/${FAKE_TOKEN}` },
    });
    outputs.push(await executeTool('request_reservice', GOOD, CTX));

    for (const out of outputs) {
      expect(typeof out).toBe('string');
      expect(out).not.toMatch(RESERVICE_TOKEN_RE);
      expect(out).not.toContain(FAKE_TOKEN);
    }
  });

  test('the module never reaches for reserviceStreamlineAccess (which returns the raw token)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/voice-agent/relay-reservice.js'), 'utf8');
    // Comments may NAME these (the header explains why they are avoided);
    // no line of actual CODE may reference any of them.
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l));
    for (const banned of [/reserviceStreamlineAccess/, /buildReserviceLink/, /reservice_token/]) {
      expect(code.filter((l) => banned.test(l))).toEqual([]);
    }
  });
});
