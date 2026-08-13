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
  // The SHARED lane vocabulary + the in-lock dedupe the self-service callback
  // commit runs (routes/booking.js) — the filing path takes the same lock and
  // asks the same question inside its transaction.
  RESERVICE_LANES: { pest: { serviceKey: 'pest_reservice' }, lawn: { serviceKey: 'lawn_reservice' } },
  openCallbackExistsForLane: jest.fn(async () => false),
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
const { openCallbackExistsForLane } = require('../services/reservice-scheduler');
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
  for (const m of ['where', 'whereNull', 'whereIn', 'whereNot', 'whereRaw', 'orderBy', 'select', 'limit']) b[m] = jest.fn(() => b);
  b.first = jest.fn(() => Promise.resolve(rows[0] || null));
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  b.insert = jest.fn(() => b);
  b.returning = jest.fn(() => Promise.resolve(insertRows || [{ id: 'sr-1' }]));
  b.update = jest.fn(() => { throw new Error('UNEXPECTED UPDATE'); });
  b.del = jest.fn(() => { throw new Error('UNEXPECTED DELETE'); });
  return b;
}

let builders;
let trx;
function primeDb({ requests = [], customers = [{ id: CUSTOMER_ID, active: true, waveguard_tier: 'silver', monthly_rate: 49 }] } = {}) {
  builders = {
    service_requests: makeBuilder(requests),
    customers: makeBuilder(customers),
  };
  const resolve = (table) => {
    if (!builders[table]) builders[table] = makeBuilder([]);
    return builders[table];
  };
  db.mockImplementation(resolve);
  // The filing COMMIT GATE: the dedupe re-read + the insert run inside one
  // transaction under a per-(customer, lane) advisory lock. Same builders, so
  // the existing insert assertions still see the write.
  trx = jest.fn(resolve);
  trx.raw = jest.fn(async () => ({}));
  db.transaction = jest.fn(async (cb) => cb(trx));
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
  // Unverified-requester writes are gated OFF unless a test says otherwise.
  delete process.env.VOICE_RELAY_ALLOW_THIRD_PARTY_WRITES;
  primeDb();
  reserviceScheduler.openReserviceCallbacks.mockResolvedValue({});
  openCallbackExistsForLane.mockResolvedValue(false);
  reserviceScheduler.reserviceLanesForCustomer.mockResolvedValue(['pest']);
});

const GOOD = { lane: 'pest', issue: 'ants are back in the kitchen along the baseboard' };
// customerTier 'full' = the ANI IS the account's own `customers.phone`. A match
// on one of the `service_contact*_phone` slots caps at 'redacted' (relay-tools
// matchedCallerTier); absent ⇒ redacted, fail closed.
const CTX = {
  customerId: CUSTOMER_ID, customerTier: 'full', from: CALLER, callSid: 'CA-res-1',
  markCaptured: jest.fn(), markReserviceFiled: jest.fn(),
};

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

  // ⭐ THE P0 THIS LANE SHIPPED WITH. A caller matched on one of the
  // `service_contact*_phone` slots (spouse, tenant, PRIOR OCCUPANT) arrives
  // with ctx.customerId SET and tier 'redacted'. The write gate checked only
  // ctx.customerId, so such a caller filed a `service_requests` row on someone
  // else's account AND paged the owner with nothing saying who was on the line.
  // The filing stays allowed; every surface it lands on is stamped.
  test('a REDACTED-tier contact-slot caller files on the matched account but is stamped UNVERIFIED everywhere', async () => {
    process.env.VOICE_RELAY_ALLOW_THIRD_PARTY_WRITES = 'true';
    const ctx = { ...CTX, customerTier: 'redacted' };
    const out = await executeTool('request_reservice', GOOD, ctx);

    const row = builders.service_requests.insert.mock.calls[0][0];
    expect(row.customer_id).toBe(CUSTOMER_ID);
    expect(row.status).toBe('new'); // still office-reviewed, nothing scheduled
    // The stamp LEADS both columns so it survives every admin truncation.
    expect(row.subject).toMatch(/^⚠️ UNVERIFIED REQUESTER — /);
    expect(row.description).toMatch(/^⚠️ UNVERIFIED third-party requester — verify identity before confirming\./);
    expect(row.description).toMatch(/secondary contact number/i);
    expect(row.description).toContain('***0142'); // masked, never the full number
    expect(row.description).not.toContain('9415550142');
    expect(row.description).toContain('ants are back');

    // The internal admin notification carries it in the title AND the body.
    const [, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).toMatch(/UNVERIFIED REQUESTER/);
    // The note rides inside the stored description (stamped FIRST there so it
    // survives every truncation) — the body must carry it exactly once.
    expect(body).toMatch(/⚠️ UNVERIFIED third-party requester/);
    expect(body.match(/UNVERIFIED third-party requester/g)).toHaveLength(1);
    expect(opts.metadata.unverified_requester).toBe(true);

    // …and so does the owner alert (the routing fix that reaches a human).
    expect(relayAlert.alertOwnerReservice).toHaveBeenCalledWith(
      expect.objectContaining({ unverifiedRequester: true, unverifiedNote: expect.stringMatching(/UNVERIFIED third-party requester/) }),
      ctx,
    );

    // The model is told not to confirm account details back to that caller.
    expect(out).toMatch(/secondary contact on this account/i);
    expect(out).toMatch(/NOTHING IS SCHEDULED YET/);
    assertNoComms();
  });

  test('a ctx with no customerTier at all is treated as UNVERIFIED (fail closed)', async () => {
    process.env.VOICE_RELAY_ALLOW_THIRD_PARTY_WRITES = 'true';
    const ctx = { ...CTX };
    delete ctx.customerTier;
    await executeTool('request_reservice', GOOD, ctx);
    expect(builders.service_requests.insert.mock.calls[0][0].subject).toMatch(/UNVERIFIED REQUESTER/);
    expect(relayAlert.alertOwnerReservice.mock.calls[0][0].unverifiedRequester).toBe(true);
  });

  test('a FULL-tier matched caller carries no unverified stamp anywhere', async () => {
    await executeTool('request_reservice', GOOD, CTX);
    const row = builders.service_requests.insert.mock.calls[0][0];
    expect(row.subject).not.toMatch(/UNVERIFIED/);
    expect(row.description).not.toMatch(/UNVERIFIED/);
    expect(NotificationService.notifyAdmin.mock.calls[0][1]).not.toMatch(/UNVERIFIED/);
    expect(NotificationService.notifyAdmin.mock.calls[0][2]).not.toMatch(/UNVERIFIED/);
    expect(relayAlert.alertOwnerReservice.mock.calls[0][0].unverifiedRequester).toBe(false);
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

  // ⭐ THE COMMIT GATE. The open-request read is a READ, and the live-call path
  // can genuinely run this tool twice: a write that blows the relay's WRITE
  // timeout is detached and still running, so a retry could pass the same
  // "nothing open" read and file a second ticket — two owner pages for one
  // problem. The authoritative dedupe re-runs inside the insert's transaction,
  // under a per-(customer, lane) advisory lock.
  // ⭐ THE SHARED LANE LOCK. A private namespace would serialize this module
  // only against itself; the writer worth serializing against is the
  // self-service callback commit (routes/booking.js), which takes
  // `reservice-lane`/<customer>:<serviceKey> and then runs the same
  // openCallbackExistsForLane check.
  test('the dedupe re-read and the insert share ONE transaction under the SHARED lane lock', async () => {
    await executeTool('request_reservice', GOOD, CTX);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(trx.raw).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['reservice-lane', `${CUSTOMER_ID}:pest_reservice`],
    );
    // …and the booked-callback question is asked INSIDE that lock, on the trx.
    expect(openCallbackExistsForLane).toHaveBeenCalledWith(trx, CUSTOMER_ID, 'pest');
    // The lock is taken BEFORE the re-read and the insert it protects.
    const lockOrder = trx.raw.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(builders.service_requests.insert.mock.invocationCallOrder[0]);
    expect(builders.service_requests.insert).toHaveBeenCalledTimes(1);
  });

  test('a callback that commits DURING the call blocks the ticket (in-lock dedupe)', async () => {
    openCallbackExistsForLane.mockResolvedValue(true); // committed after the opening read
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(out).toMatch(/ALREADY on the schedule/i);
    expect(out).not.toMatch(/\d{1,2}:\d{2}/); // no window, no date
    expect(builders.service_requests.insert).not.toHaveBeenCalled();
    expect(relayAlert.alertOwnerReservice).not.toHaveBeenCalled();
    assertNoComms();
  });

  test('an in-lock dedupe FAILURE refuses to file (fail closed)', async () => {
    openCallbackExistsForLane.mockRejectedValue(new Error('pool gone'));
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(out).toMatch(/could not check whether a re-service is already on the schedule/i);
    expect(builders.service_requests.insert).not.toHaveBeenCalled();
  });

  test('a ticket that appears between the read and the insert wins — no second ticket, no second owner page', async () => {
    // The first (unlocked) read sees nothing; the in-transaction re-read under
    // the lock finds the racer's row. Without the re-read this filed a duplicate.
    builders.service_requests.first = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'sr-racer', created_at: '2026-08-11T12:00:00Z' });
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(out).toMatch(/already open/i);
    expect(out).toMatch(/do NOT file another/i);
    expect(builders.service_requests.insert).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(relayAlert.alertOwnerReservice).not.toHaveBeenCalled();
    expect(CTX.markReserviceFiled).not.toHaveBeenCalled();
    assertNoComms();
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

  // ⭐ "SOMEBODY WILL BE AT THIS PROPERTY ON THURSDAY MORNING" IS THE
  // DISCLOSURE THE REDACTED TIER EXISTS TO WITHHOLD. A service-contact slot
  // holds spouses, tenants and prior occupants; matching one recognises the
  // account and authenticates nobody, so the dedupe answer must lose its date
  // and window — the same line every READ path in the lane already draws.
  test('a REDACTED-tier caller is told it is booked, but never when', async () => {
    process.env.VOICE_RELAY_ALLOW_THIRD_PARTY_WRITES = 'true';
    reserviceScheduler.openReserviceCallbacks.mockResolvedValue({
      pest: { date: '2026-08-20', windowStart: '09:00', serviceType: 'Re-Service' },
    });
    const out = await executeTool('request_reservice', GOOD, { ...CTX, customerTier: 'redacted' });
    expect(out).toMatch(/ALREADY on the schedule/i);
    expect(out).toMatch(/do NOT state the date or the arrival window/i);
    expect(out).not.toMatch(/August 20/i);
    expect(out).not.toContain('09:00');
    expect(builders.service_requests.insert).not.toHaveBeenCalled();
  });

  // ⭐ FILING MUTATES THE ACCOUNT AND PAGES THE OWNER. The UNVERIFIED stamp is
  // a signal for the human who reads the ticket, not a permission check — so a
  // prior occupant or a spoofed secondary number gets the same answer
  // request_booking gives them: nothing written, a human calls back.
  test('a REDACTED-tier caller files NOTHING while the third-party write gate is off', async () => {
    const out = await executeTool('request_reservice', GOOD, { ...CTX, customerTier: 'redacted' });
    expect(out).toMatch(/only filed for the account the caller's own phone number matches/i);
    expect(out).toMatch(/Capture the lead/i);
    expect(builders.service_requests.insert).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(relayAlert.alertOwnerReservice).not.toHaveBeenCalled();
    assertNoComms();
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

  // ⭐ THE ALERT IS THE ESCAPE HATCH, SO IT GETS A RECEIPT. The ticket queue is
  // the documented black hole; a process exit between the ticket commit and
  // the owner page stranded a durable ticket nobody would ever see — and the
  // already-open dedupe guard then refused a second ticket without ever
  // re-alerting. The receipt (owner_alerted_at) is stamped on a delivered
  // page, the guard retries the alerts when it is missing, and the hourly
  // sweep covers rows no second call ever touches.
  test('a DELIVERED owner page stamps owner_alerted_at on the ticket', async () => {
    relayAlert.alertOwnerReservice.mockResolvedValue(true); // clearAllMocks does not reset implementations
    builders.service_requests.update = jest.fn(() => {
      const r = { returning: jest.fn(async () => [{ id: 'sr-1' }]) }; // the claim wins
      return Object.assign(Promise.resolve(1), r);
    });
    await executeTool('request_reservice', GOOD, CTX);
    expect(builders.service_requests.update).toHaveBeenCalledWith(
      expect.objectContaining({ owner_alerted_at: expect.any(Date) }),
    );
  });

  test('an UNDELIVERED page leaves the receipt unstamped and RELEASES the claim (retryable)', async () => {
    relayAlert.alertOwnerReservice.mockResolvedValue(false);
    builders.service_requests.update = jest.fn(() => {
      const r = { returning: jest.fn(async () => [{ id: 'sr-1' }]) };
      return Object.assign(Promise.resolve(1), r);
    });
    await executeTool('request_reservice', GOOD, CTX);
    const payloads = builders.service_requests.update.mock.calls.map(([p]) => p);
    expect(payloads.some((p) => p && p.owner_alerted_at)).toBe(false); // never stamped
    expect(payloads.some((p) => p && 'owner_alert_claimed_at' in p && p.owner_alert_claimed_at === null)).toBe(true); // claim released
  });

  // ⭐ THE CLAIM VALUE IS THE OWNERSHIP TOKEN. A stale claimant (its send ran
  // past the lease while a retry reclaimed) clearing owner_alert_claimed_at
  // unconditionally deleted the NEW claimant's live lease and let yet another
  // retry page in parallel. The release is conditioned on THIS claimant's
  // exact stamp still being on the row.
  test('the release is guarded by THIS claimant\'s exact claim stamp', async () => {
    relayAlert.alertOwnerReservice.mockResolvedValue(false);
    builders.service_requests.update = jest.fn(() => {
      const r = { returning: jest.fn(async () => [{ id: 'sr-1' }]) };
      return Object.assign(Promise.resolve(1), r);
    });
    await executeTool('request_reservice', GOOD, CTX);
    const claimPayload = builders.service_requests.update.mock.calls
      .map(([p]) => p)
      .find((p) => p && p.owner_alert_claimed_at instanceof Date);
    expect(claimPayload).toBeTruthy();
    const guard = builders.service_requests.where.mock.calls
      .find(([col, val]) => col === 'owner_alert_claimed_at' && val instanceof Date);
    expect(guard).toBeTruthy();
    expect(guard[1]).toBe(claimPayload.owner_alert_claimed_at); // the SAME stamp we claimed with
  });

  // ⭐ A TIMED-OUT SEND IS AMBIGUOUS, NOT FAILED — it may still land after the
  // deadline. Releasing the claim on that result invited an immediate retry to
  // page in parallel with the late-landing send; the claim is kept and the
  // lease expires on its own (the sweep retries then).
  test('an AMBIGUOUS page keeps the claim — no stamp, no release', async () => {
    relayAlert.alertOwnerReservice.mockResolvedValue('ambiguous');
    builders.service_requests.update = jest.fn(() => {
      const r = { returning: jest.fn(async () => [{ id: 'sr-1' }]) };
      return Object.assign(Promise.resolve(1), r);
    });
    await executeTool('request_reservice', GOOD, CTX);
    const payloads = builders.service_requests.update.mock.calls.map(([p]) => p);
    expect(payloads.some((p) => p && p.owner_alerted_at)).toBe(false); // no receipt claimed
    expect(payloads.some((p) => p && 'owner_alert_claimed_at' in p && p.owner_alert_claimed_at === null)).toBe(false); // claim KEPT
  });

  test('the already-open guard RETRIES the alerts for a voice ticket with no receipt', async () => {
    primeDb({
      requests: [{
        id: 'sr-old', created_at: '2026-08-10T12:00:00Z', source: 'voice_agent',
        owner_alerted_at: null, subject: 'Re-service request (phone assistant): ants', description: 'ants',
        urgency: 'routine', category: 'pest_issue', customer_id: CUSTOMER_ID,
      }],
    });
    relayAlert.alertOwnerReservice.mockResolvedValue(true); // clearAllMocks does not reset implementations
    builders.service_requests.update = jest.fn(() => {
      const r = { returning: jest.fn(async () => [{ id: 'sr-old' }]) }; // the claim wins
      return Object.assign(Promise.resolve(1), r);
    });
    const out = await executeTool('request_reservice', GOOD, CTX);
    expect(builders.service_requests.insert).not.toHaveBeenCalled(); // still no second ticket
    expect(relayAlert.alertOwnerReservice).toHaveBeenCalledTimes(1); // …but the page is retried
    expect(builders.service_requests.update).toHaveBeenCalledWith(
      expect.objectContaining({ owner_alerted_at: expect.any(Date) }),
    );
    expect(out).toMatch(/already/i);
  });

  test('the already-open guard does NOT re-page a ticket that carries the receipt', async () => {
    primeDb({
      requests: [{
        id: 'sr-old', created_at: '2026-08-10T12:00:00Z', source: 'voice_agent',
        owner_alerted_at: '2026-08-10T12:01:00Z', subject: 's', description: 'd',
        urgency: 'routine', category: 'pest_issue', customer_id: CUSTOMER_ID,
      }],
    });
    await executeTool('request_reservice', GOOD, CTX);
    expect(relayAlert.alertOwnerReservice).not.toHaveBeenCalled();
  });

  // ⭐ ONE PAGE PER TICKET, ATOMICALLY. Creator, retry guard, and sweep can all
  // meet the same unreceipted row; the conditional claim UPDATE has one winner.
  test('a LOST alert claim pages nobody (concurrent rails cannot double-page)', async () => {
    relayAlert.alertOwnerReservice.mockResolvedValue(true);
    builders.service_requests.update = jest.fn(() => {
      const r = { returning: jest.fn(async () => []) }; // somebody else holds the claim
      return Object.assign(Promise.resolve(0), r);
    });
    await executeTool('request_reservice', GOOD, CTX);
    expect(relayAlert.alertOwnerReservice).not.toHaveBeenCalled();
  });

  test('the hourly sweep pages unalerted voice tickets and stamps them', async () => {
    const relayReservice = require('../services/voice-agent/relay-reservice');
    primeDb({
      requests: [{
        id: 'sr-stranded', customer_id: CUSTOMER_ID, category: 'pest_issue', urgency: 'urgent',
        subject: 'Re-service request (phone assistant): roaches', description: 'roaches',
        source: 'voice_agent', owner_alerted_at: null,
      }],
    });
    relayAlert.alertOwnerReservice.mockResolvedValue(true); // clearAllMocks does not reset implementations
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    builders.service_requests.update = jest.fn(() => {
      const r = { returning: jest.fn(async () => [{ id: 'sr-stranded' }]) }; // the claim wins
      return Object.assign(Promise.resolve(1), r);
    });
    const paged = await relayReservice.sweepUnalertedVoiceReservices();
    expect(paged).toBe(1);
    expect(relayAlert.alertOwnerReservice).toHaveBeenCalledTimes(1);
    expect(builders.service_requests.update).toHaveBeenCalledWith(
      expect.objectContaining({ owner_alerted_at: expect.any(Date) }),
    );
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
