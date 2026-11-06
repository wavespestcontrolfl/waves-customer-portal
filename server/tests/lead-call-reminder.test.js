// The lead call-back reminder banner (GATE_LEAD_CALL_REMINDER, owner 2026-11-05 "remind"): a "Missed call request" or
// night call-back bell still open one business hour after its latest event sends ONE banner, only while nobody has
// reached the lead, only 8 AM to 8 PM ET. The database is a stub here: the rows, the fenced stamp's result and the
// open check are set per test.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockState = { rows: [], leads: [], stampResult: 1, open: {}, estimate: null, calls: [], failLeads: false, failOpen: false };
jest.mock('../models/db', () => {
  const handle = (state) => {
    mockState.calls.push(state);
    if (state.table === 'leads') {
      if (mockState.failLeads) throw new Error('leads read failed');
      return mockState.leads;
    }
    if (state.table === 'estimates') return state.verb === 'first' ? mockState.estimate : [];
    if (state.table !== 'notifications') return [];
    if (state.verb === 'update') return mockState.stampResult;
    if (state.verb === 'first') {
      if (mockState.failOpen) throw new Error('open read failed');
      return Object.prototype.hasOwnProperty.call(mockState.open, state.id) ? mockState.open[state.id] : { done_at: null };
    }
    return mockState.rows;
  };
  const db = jest.fn((table) => {
    const state = { table, verb: 'select', id: null, update: null };
    const chain = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(() => handle(state)).then(res, rej);
        return (...args) => {
          if (prop === 'update' || prop === 'first') state.verb = prop;
          if (prop === 'update') [state.update] = args;
          if (prop === 'where' && args[0] && typeof args[0] === 'object' && args[0].id) state.id = args[0].id;
          return chain;
        };
      },
    });
    return chain;
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: () => 'now()' };
  return db;
});
jest.mock('../services/notification-service', () => ({
  _private: { excludeActivityOnlyFromBell: (q) => q, DONE_CLEARED: {} },
  safeErrorSummary: (e) => e.message,
}));
const mockBundles = { byId: {}, fail: false };
jest.mock('../services/admin-alert-contact-witnesses', () => ({
  loadContactBundles: jest.fn(async (items) => {
    if (mockBundles.fail) throw new Error('witnesses failed');
    return new Map(items.map((i) => [String(i.id), {
      anchor: i.bellAt, textAt: null, backAt: null, inAt: null, replyAt: null, visitAt: null, ...(mockBundles.byId[i.id] || {}),
    }]));
  }),
}));
jest.mock('../services/call-commitments', () => ({
  handedOffWithin: jest.fn((q) => q),
  whereEstimateCustomerOwnership: jest.fn((q) => q),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: false, push: { sent: 1 } })) }));

const { triggerNotification } = require('../services/notification-triggers');
const { loadContactBundles } = require('../services/admin-alert-contact-witnesses');
const reminder = require('../services/lead-call-reminder');

const { runLeadCallReminder, __private: { inSendHours, dueAtFor } } = reminder;

// Eastern wall-clock times in November 2026 (EST, UTC-5).
const est = (day, hhmm) => new Date(`2026-11-${day}T${hhmm}:00-05:00`);
const NOW = est('05', '15:00');
const LEAD = '11111111-1111-4111-8111-111111111111';
const CUST = '22222222-2222-4222-8222-222222222222';
const CALL = '33333333-3333-4333-8333-333333333333';
const row = (id, { createdAt = est('05', '13:30'), metadata = {} } = {}) => ({
  id,
  title: 'Leads — call Pat Sample back',
  body: 'Missed call request: Pat replied CALL to our lead text and nobody pressed 1.',
  link: `/admin/leads?lead=${LEAD}`,
  metadata: { dedupeKey: `lead-call-reply-missed:${CALL}`, leadId: LEAD, customerId: CUST, doneWhen: 'lead_contacted', area: 'Leads', ...metadata },
  created_at: createdAt,
  created_at_token: createdAt.toISOString(),
});
const reminders = () => triggerNotification.mock.calls.filter(([key]) => key === 'lead_call_reminder');
const stamps = () => mockState.calls.filter((c) => c.table === 'notifications' && c.verb === 'update');
const run = async (now = NOW) => {
  const result = await runLeadCallReminder({ now });
  await Promise.all(result.sends || []);
  return result;
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_LEAD_CALL_REMINDER = 'true';
  Object.assign(mockState, { rows: [row('n-1')], leads: [{ id: LEAD, customer_id: CUST, phone: '+19415550100', status: 'new', deleted_at: null }], stampResult: 1, open: {}, estimate: null, calls: [], failLeads: false, failOpen: false });
  Object.assign(mockBundles, { byId: {}, fail: false });
});
afterEach(() => { delete process.env.GATE_LEAD_CALL_REMINDER; });

describe('the gate', () => {
  test.each([[undefined], [''], ['1'], ['on'], ['TRUE'], ['shadow'], [' true']])('GATE_LEAD_CALL_REMINDER = %j reads and sends nothing', async (value) => {
    if (value === undefined) delete process.env.GATE_LEAD_CALL_REMINDER; else process.env.GATE_LEAD_CALL_REMINDER = value;
    expect(require('../config/feature-gates').leadCallReminderLive()).toBe(false);
    expect(await runLeadCallReminder({ now: NOW })).toEqual({ skipped: true, reason: 'gate_off' });
    expect(mockState.calls).toEqual([]);
    expect(triggerNotification).not.toHaveBeenCalled();
  });
  test('exactly "true" is live', () => {
    expect(require('../config/feature-gates').leadCallReminderLive()).toBe(true);
  });
});

describe('the clock', () => {
  test.each([
    ['a ring missed at 10:09 AM -> 11:09 AM', est('04', '10:09'), est('04', '11:09')],
    ['the 8 AM night call-back bell -> 9:00 AM', est('05', '08:00'), est('05', '09:00')],
    ['a ring missed at 7:30 PM -> 8:30 AM the next day', est('04', '19:30'), est('05', '08:30')],
  ])('one business hour, 8 AM to 8 PM ET: %s', (_label, asked, due) => {
    expect(dueAtFor(asked).getTime()).toBe(due.getTime());
  });

  test.each([
    [est('05', '07:59'), false], [est('05', '08:00'), true], [est('05', '19:59'), true], [est('05', '20:00'), false], [est('05', '23:30'), false],
  ])('send hours: %s -> %s', (at, open) => {
    expect(inSendHours(at)).toBe(open);
  });

  test('outside 8 AM to 8 PM nothing is read, stamped or sent; the next morning sweep sends it', async () => {
    mockState.rows = [row('n-1', { createdAt: est('04', '19:30') })];
    expect(await runLeadCallReminder({ now: est('04', '21:00') })).toEqual({ skipped: true, reason: 'quiet_hours' });
    expect(mockState.calls).toEqual([]);
    const morning = await run(est('05', '08:40'));
    expect(morning).toMatchObject({ skipped: false, due: 1, reminded: 1 });
    expect(reminders()).toHaveLength(1);
  });

  test('a bell less than one business hour old is not due yet', async () => {
    mockState.rows = [row('n-1', { createdAt: est('05', '14:30') })];
    expect(await run()).toMatchObject({ due: 0, reminded: 0 });
    expect(loadContactBundles).not.toHaveBeenCalled();
    expect(stamps()).toEqual([]);
  });

  test('a bell whose latest event is over 24 hours old sends nothing, so the gate cannot burst old bells', async () => {
    mockState.rows = [row('n-1', { createdAt: est('04', '14:00') })];
    expect(await run()).toMatchObject({ due: 0, reminded: 0 });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a refresh that rang again moves the clock: the bell is judged from metadata.rungAt', async () => {
    mockState.rows = [row('n-1', { createdAt: est('04', '09:00'), metadata: { rungAt: est('05', '14:30').toISOString() } })];
    expect(await run()).toMatchObject({ due: 0 });
    mockState.rows = [row('n-1', { createdAt: est('04', '09:00'), metadata: { rungAt: est('05', '13:30').toISOString() } })];
    expect(await run()).toMatchObject({ due: 1, reminded: 1 });
    expect(loadContactBundles.mock.calls[0][0][0].bellAt).toEqual(est('05', '13:30'));
  });
});

describe('the banner', () => {
  test('an open, due bell nobody answered is stamped once and sends one banner with its own words', async () => {
    const result = await run();
    expect(result).toMatchObject({ skipped: false, due: 1, reminded: 1 });
    const [stamp] = stamps();
    expect(stamp.id).toBe('n-1');
    expect(JSON.parse(stamp.update.metadata.bindings[0])).toEqual({ leadCallReminderAt: NOW.toISOString() });
    expect(reminders()).toHaveLength(1);
    const [, payload, opts] = reminders()[0];
    expect(payload).toEqual({
      alertRowId: 'n-1',
      alertTitle: 'Leads — call Pat Sample back',
      alertBody: 'Missed call request: Pat replied CALL to our lead text and nobody pressed 1.',
      alertLink: `/admin/leads?lead=${LEAD}`,
      customerId: CUST,
    });
    expect(opts).toMatchObject({ pushOnly: true, adminOnly: true, bellAuthorized: true });
    // The witnesses read the lead's own customer and phone, from the bell's event.
    expect(loadContactBundles.mock.calls[0][0]).toEqual([{ id: 'n-1', kind: 'lead', bellAt: est('05', '13:30'), refs: { customerId: CUST, phone: '+19415550100' } }]);
  });

  test('the night call-back bell (lead-call-text-followup) is covered too', async () => {
    mockState.rows = [row('n-2', { createdAt: est('05', '08:00'), metadata: { dedupeKey: 'lead-call-text-followup:44444444-4444-4444-8444-444444444444' } })];
    expect(await run(est('05', '09:10'))).toMatchObject({ reminded: 1 });
    expect(reminders()[0][1].alertRowId).toBe('n-2');
  });

  test('the registry words: the row title, then the reminder line and the row body; the row link', () => {
    const { TRIGGER_REGISTRY } = jest.requireActual('../services/notification-triggers');
    const built = TRIGGER_REGISTRY.lead_call_reminder.build({ alertTitle: 'Leads — call Pat Sample back', alertBody: 'Missed call request: Pat replied CALL.', alertLink: '/admin/leads?lead=x' });
    expect(built).toEqual({ title: 'Leads — call Pat Sample back', body: 'Reminder: nobody has reached this lead yet. Missed call request: Pat replied CALL.', link: '/admin/leads?lead=x' });
    expect(TRIGGER_REGISTRY.lead_call_reminder.build({})).toEqual({ title: 'Leads — call a lead back', body: 'Reminder: nobody has reached this lead yet.', link: '/admin/leads' });
    expect(require('../services/alert-sounds').soundForTrigger('lead_call_reminder')).toBe('waves-missed-call.caf');
  });

  test('a stamp the fence refused (closed, or changed since it was read) sends nothing', async () => {
    mockState.stampResult = 0;
    expect(await run()).toMatchObject({ due: 1, reminded: 0 });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('just before the push the row is read again: a row closed or gone meanwhile, or a failed read, says no', async () => {
    await run();
    const { beforePush } = reminders()[0][2];
    expect(await beforePush()).toBe(true);
    mockState.open['n-1'] = { done_at: new Date() };
    expect(await beforePush()).toBe(false);
    mockState.open['n-1'] = undefined;
    expect(await beforePush()).toBe(false);
    mockState.open = {};
    mockState.failOpen = true;
    expect(await beforePush()).toBe(false);
  });

  test('a banner that throws is logged and never reaches the sweep', async () => {
    triggerNotification.mockRejectedValueOnce(new Error('push down'));
    const result = await runLeadCallReminder({ now: NOW });
    await expect(Promise.all(result.sends)).resolves.toEqual([null]);
    expect(result.reminded).toBe(1);
  });
});

describe('nobody is reminded about a lead a person already reached', () => {
  test.each([
    ['a person texted', { textAt: est('05', '13:45') }],
    ['a person called and spoke', { backAt: est('05', '14:00') }],
    ['the lead called in and a person answered', { inAt: est('05', '14:10') }],
    ['a person answered by email', { replyAt: est('05', '14:20') }],
    ['a visit was booked', { visitAt: est('05', '14:30') }],
  ])('%s after the bell', async (_label, witness) => {
    mockBundles.byId['n-1'] = witness;
    expect(await run()).toMatchObject({ due: 1, reminded: 0 });
    expect(stamps()).toEqual([]);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('contact BEFORE the bell does not count', async () => {
    mockBundles.byId['n-1'] = { textAt: est('05', '13:00'), backAt: est('05', '12:00') };
    expect(await run()).toMatchObject({ reminded: 1 });
  });

  test('an estimate handed off to the lead\'s customer after the bell', async () => {
    mockState.estimate = { id: 'est-1' };
    expect(await run()).toMatchObject({ reminded: 0 });
    const { handedOffWithin, whereEstimateCustomerOwnership } = require('../services/call-commitments');
    expect(handedOffWithin.mock.calls[0][1]).toEqual(est('05', '13:30'));
    expect(whereEstimateCustomerOwnership.mock.calls[0][1]).toBe(CUST);
  });

  test.each([['won'], ['lost'], ['disqualified'], ['duplicate'], ['unresponsive'], ['handled']])('a lead a person closed (%s)', async (status) => {
    mockState.leads[0].status = status;
    expect(await run()).toMatchObject({ reminded: 0 });
    expect(loadContactBundles).not.toHaveBeenCalled();
  });

  test('a deleted lead', async () => {
    mockState.leads[0].deleted_at = new Date();
    expect(await run()).toMatchObject({ reminded: 0 });
  });

  test('a missing lead row is unknown, not gone: the bell\'s own customer is judged', async () => {
    mockState.leads = [];
    expect(await run()).toMatchObject({ reminded: 1 });
    expect(loadContactBundles.mock.calls[0][0][0].refs).toEqual({ customerId: CUST, phone: null });
  });

  test('a bell that names no lead and no customer cannot be judged, so it sends nothing', async () => {
    mockState.rows = [row('n-1', { metadata: { leadId: undefined, customerId: 'not-a-uuid' } })];
    expect(await run()).toMatchObject({ due: 0, reminded: 0 });
  });

  test('a witness read that fails is no verdict: nothing is stamped or sent', async () => {
    mockBundles.fail = true;
    expect(await run()).toMatchObject({ due: 1, reminded: 0 });
    expect(stamps()).toEqual([]);
    mockBundles.fail = false;
    mockState.failLeads = true;
    expect(await run()).toMatchObject({ due: 1, reminded: 0 });
    expect(triggerNotification).not.toHaveBeenCalled();
  });
});

describe('the alert-relevance sweep runs the pass after its closes', () => {
  const { runAdminAlertRelevanceSweep } = require('../services/admin-alert-relevance');
  beforeEach(() => { mockState.rows = []; });

  test('gate on: the pass runs with the sweep\'s time and its count is reported', async () => {
    const spy = jest.spyOn(reminder, 'runLeadCallReminder').mockResolvedValueOnce({ skipped: false, due: 2, reminded: 2, sends: [] });
    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(spy).toHaveBeenCalledWith({ now: NOW });
    expect(result.leadCallReminders).toBe(2);
    spy.mockRestore();
  });

  test('gate off: the pass is never called', async () => {
    delete process.env.GATE_LEAD_CALL_REMINDER;
    const spy = jest.spyOn(reminder, 'runLeadCallReminder');
    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(spy).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('leadCallReminders');
    spy.mockRestore();
  });

  test('a pass that throws is logged and the sweep still returns', async () => {
    const spy = jest.spyOn(reminder, 'runLeadCallReminder').mockRejectedValueOnce(new Error('boom'));
    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result.skipped).toBe(false);
    expect(result).not.toHaveProperty('leadCallReminders');
    spy.mockRestore();
  });
});
