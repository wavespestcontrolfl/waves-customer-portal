/**
 * GATE_ESTIMATE_TWO_HOUR_EMAIL_STOPS, the 2-hour estimate_sent email's stops (owner 2026-11-21): at step 0, with the gate on,
 * the email is not sent and the enrollment ends for a final estimate, an opt-out or a reply. It never changes the content
 * sent (always the step's own body) and a later step keeps only the accept stop. Synthetic names and estimates only.
 */

jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  messagingHeldByCollectionHold: jest.fn(async () => ({ held: false })),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_name, fn) => fn()),
  wasLockSkipped: jest.requireActual('../utils/cron-lock').wasLockSkipped,
}));
jest.mock('../services/contact-notification-prefs', () => ({
  ...jest.requireActual('../services/contact-notification-prefs'),
  rerouteForContactEmailOptOut: jest.fn(async (_customerId, email) => ({ email, rerouted: false })),
}));
// The engine's reply arms (text, then email) have their own suite (estimate-followup-email-reply-pause: hasRepliedSince).
jest.mock('../services/estimate-follow-up', () => ({
  hasRepliedSince: jest.fn(async () => false),
  _private: { TERMINAL_STATUSES: new Set(['declined', 'accepted', 'expired', 'void']) },
}));

const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const logger = require('../services/logger');
const followUp = require('../services/estimate-follow-up');
const { sendStep } = require('../services/automation-runner');

const ENROLLED_AT = new Date('2026-11-20T17:00:00Z');
const SENT_AT = new Date('2026-11-20T15:00:00Z');
const OLD_BODY = 'Old body: just making sure it landed.';
const OLD_TEXT = 'Old text: making sure it landed.';

function estimateRow(extra = {}) {
  return {
    id: 'est-1', status: 'sent', customer_email: 'pat@example.com', sent_at: SENT_AT,
    estimate_data: { result: { recurring: { services: [{ service: 'Pest Control', mo: 30 }] } } },
    ...extra,
  };
}

let savedGate;
beforeEach(() => {
  savedGate = process.env.GATE_ESTIMATE_TWO_HOUR_EMAIL_STOPS;
  process.env.GATE_ESTIMATE_TWO_HOUR_EMAIL_STOPS = 'true';
  jest.clearAllMocks();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  followUp.hasRepliedSince.mockResolvedValue(false);
});
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_ESTIMATE_TWO_HOUR_EMAIL_STOPS;
  else process.env.GATE_ESTIMATE_TWO_HOUR_EMAIL_STOPS = savedGate;
});

function chain({ result = [], first, returning } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'whereNot', 'join', 'whereNotNull', 'whereNull', 'orWhereNotNull', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.select = jest.fn(() => q);
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => Promise.resolve(1));
  q.del = jest.fn(() => Promise.resolve(1));
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(() => Promise.resolve(returning || []));
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => db(table);
    trx.raw = jest.fn(async () => ({ rows: [] }));
    return fn(trx);
  });
}


const STEP_ZERO = { id: 'step-1', step_order: 0, subject: 'A quick note on your Waves estimate, {{first_name}}',
  html_body: `<p>${OLD_BODY}</p>`, text_body: OLD_TEXT, from_email: 'automations@wavespestcontrol.com', enabled: true };
const STEP_ONE = { ...STEP_ZERO, id: 'step-2', step_order: 1, html_body: '<p>Second step body.</p>', text_body: 'Second step text.' };

// estimateRows: the answers to each read of `estimates`, in order. The accept-stop read is first, the stop read second.
function queues({ estimateRows, enrollment: overrides = {}, steps = [STEP_ZERO] }) {
  const enrollment = {
    id: 'enrollment-n', template_key: 'estimate_sent', customer_id: 'cust-n', status: 'active', current_step: 0,
    email: 'pat@example.com', first_name: 'Pat', last_name: 'Synthetic', enrolled_at: ENROLLED_AT,
    metadata: { estimate_id: 'est-1' }, ...overrides,
  };
  const enrollmentUpdate = chain();
  const sendUpdate = chain();
  setDbQueues({
    automation_enrollments: [chain({ first: enrollment }), chain({ first: enrollment }), enrollmentUpdate],
    automation_templates: [chain({ first: { key: 'estimate_sent', name: 'Estimate Sent', asm_group: 'service' } })],
    automation_steps: [chain({ result: steps })],
    automation_step_sends: [chain({ returning: [{ id: 'send-n' }] }), sendUpdate],
    email_suppressions: [chain({ result: [] })],
    estimates: estimateRows.map((row) => chain({ first: row })),
  });
  return { enrollmentUpdate, sendUpdate };
}

const estimateReads = () => db.mock.calls.filter(([table]) => table === 'estimates').length;
const notCancelled = (enrollmentUpdate) => expect(enrollmentUpdate.update)
  .not.toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
function cancelledWith(enrollmentUpdate, reason) {
  expect(enrollmentUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
    status: 'cancelled',
    next_send_at: null,
    metadata: { sql: expect.stringContaining('{cancel_reason}'), bindings: [JSON.stringify(reason)] },
  }));
}
// The step's own body, exactly: nothing the gate does ever changes what is sent.
const sendOnce = async () => {
  sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-x' });
  await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: true });
  const sent = sendgrid.sendOne.mock.calls.at(-1)[0];
  expect(sent.subject).toBe('A quick note on your Waves estimate, Pat');
  expect(sent.html).toContain(OLD_BODY);
  expect(sent.text).toContain(OLD_TEXT);
  return sent;
};
const blocked = async (reason) => {
  await expect(sendStep('enrollment-n')).resolves.toEqual({ sent: false, blocked: true, reason });
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
};

describe('estimate_sent stops (gate off)', () => {
  test('gate off = main: the accept-stop read only, no reply check, the step body goes', async () => {
    delete process.env.GATE_ESTIMATE_TWO_HOUR_EMAIL_STOPS;
    queues({ estimateRows: [undefined, estimateRow({ status: 'void', archived_at: new Date() })] });
    await sendOnce();
    expect(estimateReads()).toBe(1);
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });

  test('gate off: the accept stop still cancels, as on main', async () => {
    const { enrollmentUpdate } = queues({ estimateRows: [{ id: 'est-1' }] });
    delete process.env.GATE_ESTIMATE_TWO_HOUR_EMAIL_STOPS;
    await blocked('The customer accepted the estimate');
    cancelledWith(enrollmentUpdate, 'estimate_accepted');
  });
});

describe('estimate_sent stops (gate on, step 0)', () => {
  test('the accept stop runs first and cancels as estimate_accepted', async () => {
    const { enrollmentUpdate } = queues({ estimateRows: [{ id: 'est-1' }] });
    await blocked('The customer accepted the estimate');
    cancelledWith(enrollmentUpdate, 'estimate_accepted');
    expect(estimateReads()).toBe(1);
  });

  test.each([['accepted'], ['declined'], ['expired'], ['void']])('terminal status %s cancels as estimate_closed', async (status) => {
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, estimateRow({ status })] });
    await blocked('The estimate is no longer open');
    cancelledWith(enrollmentUpdate, 'estimate_closed');
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });

  test('an archived estimate cancels as estimate_closed', async () => {
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, estimateRow({ archived_at: new Date('2026-11-20T20:00:00Z') })] });
    await blocked('The estimate is no longer open');
    cancelledWith(enrollmentUpdate, 'estimate_closed');
  });

  test('an estimate past its expires_at cancels as estimate_closed though its status still reads viewed', async () => {
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, estimateRow({ status: 'viewed', expires_at: new Date(Date.now() - 3600000) })] });
    await blocked('The estimate is no longer open');
    cancelledWith(enrollmentUpdate, 'estimate_closed');
  });

  test('an estimate that opted out of follow-ups cancels as estimate_opted_out, before the reply check', async () => {
    followUp.hasRepliedSince.mockResolvedValue(true);
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, estimateRow({ estimate_data: { noEngagementAutomation: true } })] });
    await blocked('The estimate opted out of follow-ups');
    cancelledWith(enrollmentUpdate, 'estimate_opted_out');
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });

  test('a final state wins over an opt-out', async () => {
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, estimateRow({ status: 'declined', estimate_data: { noEngagementAutomation: true } })] });
    await blocked('The estimate is no longer open');
    cancelledWith(enrollmentUpdate, 'estimate_closed');
  });

  test('a reply since the send cancels as estimate_replied', async () => {
    followUp.hasRepliedSince.mockResolvedValue(true);
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, estimateRow()] });
    await blocked('The customer replied since the estimate went out');
    cancelledWith(enrollmentUpdate, 'estimate_replied');
    expect(followUp.hasRepliedSince).toHaveBeenCalledWith(expect.objectContaining({ id: 'est-1' }), expect.any(Date));
  });

  test('no reply: the step body goes and the enrollment stays', async () => {
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, estimateRow({ viewed_at: new Date() })] });
    await sendOnce();
    notCancelled(enrollmentUpdate);
    expect(estimateReads()).toBe(2);
  });
});

describe('the reply cutoff', () => {
  const cutoffFor = async (estimate, enrollment) => {
    followUp.hasRepliedSince.mockResolvedValue(true);
    queues({ estimateRows: [undefined, estimate], enrollment });
    await sendStep('enrollment-n');
    return followUp.hasRepliedSince.mock.calls[0]?.[1];
  };

  test('the earlier of enrolled_at and sent_at: sent_at earlier (the usual case)', async () => {
    expect(await cutoffFor(estimateRow({ sent_at: SENT_AT }), {})).toEqual(SENT_AT);
  });

  test('a resend overwrote sent_at with a later time: enrolled_at is earlier, so a reply before the resend still stops', async () => {
    expect(await cutoffFor(estimateRow({ sent_at: new Date('2026-11-20T19:00:00Z') }), {})).toEqual(ENROLLED_AT);
  });

  test('sent_at unreadable or missing: enrolled_at', async () => {
    expect(await cutoffFor(estimateRow({ sent_at: 'not a time' }), {})).toEqual(ENROLLED_AT);
    followUp.hasRepliedSince.mockClear();
    expect(await cutoffFor(estimateRow({ sent_at: null }), {})).toEqual(ENROLLED_AT);
  });

  test('enrolled_at unreadable: sent_at', async () => {
    expect(await cutoffFor(estimateRow(), { enrolled_at: 'not a time' })).toEqual(SENT_AT);
  });

  test('neither readable: no reply check, the step body goes', async () => {
    queues({ estimateRows: [undefined, estimateRow({ sent_at: 'x' })], enrollment: { enrolled_at: null } });
    await sendOnce();
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });
});

describe('a status that is neither final nor sent or viewed', () => {
  test.each([['sending'], ['draft'], ['scheduled'], ['send_failed']])('%s with a reply (a resend in flight) still stops as estimate_replied', async (status) => {
    followUp.hasRepliedSince.mockResolvedValue(true);
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, estimateRow({ status })] });
    await blocked('The customer replied since the estimate went out');
    cancelledWith(enrollmentUpdate, 'estimate_replied');
  });

  test.each([['sending'], ['draft'], ['scheduled'], ['send_failed']])('%s with no reply is never a stop by itself: the step body goes, the enrollment stays', async (status) => {
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, estimateRow({ status })] });
    await sendOnce();
    notCancelled(enrollmentUpdate);
    expect(followUp.hasRepliedSince).toHaveBeenCalledTimes(1);
  });
});

describe('a failed reply read', () => {
  test('fails open (the step body goes) and logs only the error code', async () => {
    followUp.hasRepliedSince.mockRejectedValue(Object.assign(new Error('select ... 941-555-0100'), { code: '57P01' }));
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, estimateRow()] });
    await sendOnce();
    notCancelled(enrollmentUpdate);
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('57P01');
    expect(logged).not.toContain('941-555-0100');
  });
});

describe('a later step of the template (step_order 1)', () => {
  const laterStep = (estimateRows) => queues({ estimateRows, steps: [STEP_ZERO, STEP_ONE], enrollment: { current_step: 1 } });
  const sendLater = async () => {
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-later' });
    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: true });
    const sent = sendgrid.sendOne.mock.calls.at(-1)[0];
    expect(sent.html).toContain('Second step body.');
    expect(sent.text).toContain('Second step text.');
  };

  test('stops 2 to 4 do not run: a reply, a closed, an archived and an opted-out estimate leave it sending; one estimate read', async () => {
    followUp.hasRepliedSince.mockResolvedValue(true);
    const { enrollmentUpdate } = laterStep([undefined, estimateRow({ status: 'declined', archived_at: new Date(), estimate_data: { noEngagementAutomation: true } })]);
    await sendLater();
    notCancelled(enrollmentUpdate);
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
    expect(estimateReads()).toBe(1);
  });

  test('the accept stop still cancels it', async () => {
    const { enrollmentUpdate } = laterStep([{ id: 'est-1' }]);
    await blocked('The customer accepted the estimate');
    cancelledWith(enrollmentUpdate, 'estimate_accepted');
  });
});

describe('estimate_sent when the stops do not apply', () => {
  test('no estimate id on the enrollment = main: the accept-stop read only, the step body goes', async () => {
    queues({ estimateRows: [undefined], enrollment: { metadata: {} } });
    await sendOnce();
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });

  test('an estimate row that does not exist = main: the step body goes', async () => {
    queues({ estimateRows: [undefined, undefined] });
    await sendOnce();
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });

  test('a test send is untouched: no estimate read, the step body goes', async () => {
    queues({ estimateRows: [] });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-test' });
    await sendStep('enrollment-n', { testRecipient: 'owner@example.com' });
    expect(sendgrid.sendOne.mock.calls[0][0].html).toContain(OLD_BODY);
    expect(estimateReads()).toBe(0);
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });
});
