// The new-lead re-alert (owner 2026-11-19, "do phase 1 first"): an open new-lead bell no person has reached gets ONE more
// phone push 15 business minutes after its latest event. Business time is Monday to Saturday, 8 AM to 6 PM ET. The
// database is a stub: the rows, the leads, the answered calls, the stamp results and the open check are set per test.
// Synthetic names, phones and ids only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockState = {};
const resetState = () => Object.assign(mockState, {
  rows: [], leads: [], answered: [], estimates: [], emails: [], emailRows: [], handedOff: null, customer: null, customerRows: [], links: {}, stampResults: [], open: {}, calls: [], failLeads: false, failOpen: false, pages: null, onOpenRead: null,
});
resetState();
jest.mock('../models/db', () => {
  const handle = (state) => {
    mockState.calls.push(state);
    if (state.table === 'leads') {
      if (mockState.failLeads) throw new Error('leads read failed');
      return mockState.leads;
    }
    if (state.table === 'call_log') return mockState.answered;
    if (state.table === 'estimates') return state.verb === 'first' ? mockState.handedOff : mockState.estimates;
    if (state.table === 'emails as er') return mockState.emails;
    if (state.table === 'emails') return mockState.emailRows;
    if (state.table === 'customers') return state.verb === 'first' ? mockState.customer : mockState.customerRows;
    if (state.table !== 'notifications') return [];
    if (state.verb === 'update') return mockState.stampResults.length ? mockState.stampResults.shift() : 1;
    if (state.verb === 'first') {
      if (mockState.onOpenRead) mockState.onOpenRead();
      if (mockState.failOpen) throw new Error('open read failed');
      return Object.prototype.hasOwnProperty.call(mockState.open, state.id) ? mockState.open[state.id] : { done_at: null };
    }
    if (mockState.pages) return mockState.pages.shift() || [];
    return mockState.rows;
  };
  const db = jest.fn((table) => {
    const state = { table, verb: 'select', id: null, update: null, wheres: [], raws: [], ins: [] };
    const chain = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(() => handle(state)).then(res, rej);
        return (...args) => {
          if (prop === 'update' || prop === 'first') state.verb = prop;
          if (prop === 'update') [state.update] = args;
          if (prop === 'where') state.wheres.push(args);
          if (prop === 'modify') args[0](chain);
          // A grouped condition (where(fn), orWhere(fn)) runs on this same chain, so its parts are recorded too.
          if ((prop === 'where' || prop === 'orWhere') && typeof args[0] === 'function') args[0](chain);
          if (prop === 'whereIn' || prop === 'orWhereIn') state.ins.push(args);
          if (prop === 'whereRaw' || prop === 'orWhereRaw') state.raws.push(args);
          if (prop === 'where' && args[0] && typeof args[0] === 'object' && args[0].id) state.id = args[0].id;
          return chain;
        };
      },
    });
    return chain;
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  // The stamp's transaction runs on the same stub.
  db.transaction = jest.fn(async (work) => work(db));
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
    // Like the real witnesses: no bundle for an item with no customer and no phone to name it.
    return new Map(items.filter((i) => i.refs.customerId || i.refs.phone).map((i) => [String(i.id), {
      anchor: i.bellAt, textAt: null, backAt: null, inAt: null, replyAt: null, visitAt: null, ...(mockBundles.byId[i.id] || {}),
    }]));
  }),
}));
jest.mock('../services/call-commitments', () => ({
  handedOffWithin: jest.fn((q) => q),
  whereEstimateCustomerOwnership: jest.fn((q) => q),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: false, push: { sent: 1 } })) }));
// The witnesses' email linkage, set per test (mockState.links: a sent row's id -> the customer it links to; none = no link).
jest.mock('../services/email/email-customer-link', () => ({
  ...jest.requireActual('../services/email/email-customer-link'),
  resolveEmailCustomerLink: jest.fn(async (_conn, sent) => mockState.links[sent.id] || null),
}));
const { triggerNotification } = require('../services/notification-triggers');
const { loadContactBundles } = require('../services/admin-alert-contact-witnesses');
const sweepShared = require('../services/lead-reminder-sweep');
const { runNewLeadReminder: runReminder, PUSH_STAMP, __private: { inBusinessHours, businessDueAt } } = require('../services/new-lead-reminder');
// The dispatch-time clock is the sweep's `now` unless a test sets one: the real clock is not part of these cases.
const runNewLeadReminder = (opts = {}) => runReminder({ clock: () => opts.now, ...opts });

// Eastern wall-clock times in November 2026 (EST, UTC-5). Mon Nov 9, Sat Nov 7, Sun Nov 8.
const est = (day, hhmm) => new Date(`2026-11-${day}T${hhmm}:00-05:00`);
const LEAD = '11111111-1111-4111-8111-111111111111';
const CUST = '22222222-2222-4222-8222-222222222222';
const CALL_SID = 'CAsynthetic0001';
const row = (id, { createdAt = est('09', '10:00'), metadata = {}, title = 'New lead' } = {}) => ({
  id,
  title,
  body: 'Pat Sample via the website - Wants pest control',
  link: `/admin/leads?lead=${LEAD}`,
  metadata: { triggerKey: 'new_lead', doneWhen: 'lead_contacted', payload: { leadId: LEAD }, ...metadata },
  created_at: createdAt,
  created_at_token: createdAt.toISOString(),
});
const lead = (over = {}) => ({
  id: LEAD, customer_id: CUST, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample', status: 'new', deleted_at: null, created_at: est('09', '10:00'), twilio_call_sid: null, estimate_id: null, email: 'pat@example.invalid', ...over,
});
// The row lead-webhook.js ringRepeatFormAlert writes: category lead, the lead in metadata and in the link, no triggerKey.
const repeatFormRow = (id, createdAt = est('09', '10:00')) => ({
  id, category: 'lead', title: 'Leads — call Pat Sample about the quote form', body: 'Pat sent the quote form; on file as a lead since Nov 2.',
  link: `/admin/leads?lead=${LEAD}`,
  metadata: { dedupeKey: `lead-repeat-form:${CUST}`, customerId: CUST, leadId: LEAD, source: 'lead_repeat_form', subject: { type: 'lead', id: LEAD }, doneWhen: 'lead_contacted', who: 'person' },
  created_at: createdAt, created_at_token: createdAt.toISOString(),
});
const pushes = () => triggerNotification.mock.calls.filter(([key]) => key === 'lead_call_reminder');
const updates = () => mockState.calls.filter((c) => c.table === 'notifications' && c.verb === 'update');
const run = async (now) => {
  const result = await runNewLeadReminder({ now });
  await Promise.all(result.sends || []);
  return result;
};
// 15 minutes after a 10:00 AM Monday bell: the push is due.
const PUSH_NOW = est('09', '10:20');

beforeEach(() => {
  jest.clearAllMocks();
  resetState();
  sweepShared.__private.resumeAfter.clear();
  Object.assign(mockState, { rows: [row('n-1')], leads: [lead()], customer: { id: CUST, first_name: 'Pat', last_name: 'Sample', phone: '+19415550100' } });
  Object.assign(mockBundles, { byId: {}, fail: false });
});

describe('the clock: Monday to Saturday, 8 AM to 6 PM ET', () => {
  test.each([
    ['Monday 10:00 -> 10:15', est('09', '10:00'), 15, est('09', '10:15')],
    ['Monday 5:50 PM -> Tuesday 8:05 AM', est('09', '17:50'), 15, est('10', '08:05')],
    ['Saturday 5:50 PM -> Monday 8:05 AM (Sunday does not count)', est('07', '17:50'), 15, est('09', '08:05')],
    ['Saturday 5:30 PM, 60 minutes -> Monday 8:30 AM', est('07', '17:30'), 60, est('09', '08:30')],
    ['Sunday 11:00 AM -> Monday 8:15 AM', est('08', '11:00'), 15, est('09', '08:15')],
    ['Monday 6:00 AM -> 8:15 AM', est('09', '06:00'), 15, est('09', '08:15')],
  ])('%s', (_label, from, minutes, due) => {
    expect(businessDueAt(from, minutes).getTime()).toBe(due.getTime());
  });

  test.each([
    [est('09', '07:59'), false], [est('09', '08:00'), true], [est('09', '17:59'), true], [est('09', '18:00'), false],
    [est('07', '12:00'), true], [est('08', '12:00'), false], [est('09', '23:30'), false],
  ])('send hours: %s -> %s', (at, open) => {
    expect(inBusinessHours(at)).toBe(open);
  });

  test('outside the hours nothing is read, stamped or sent', async () => {
    expect(await runNewLeadReminder({ now: est('09', '18:05') })).toEqual({ skipped: true, reason: 'quiet_hours' });
    expect(await runNewLeadReminder({ now: est('08', '12:00') })).toEqual({ skipped: true, reason: 'quiet_hours' });
    expect(mockState.calls).toEqual([]);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a bell written at 5:55 PM is pushed at the next 8 AM sweep, not at night', async () => {
    mockState.rows = [row('n-1', { createdAt: est('09', '17:55') })];
    expect(await runNewLeadReminder({ now: est('09', '18:30') })).toMatchObject({ skipped: true });
    expect(await run(est('10', '08:20'))).toMatchObject({ skipped: false, due: 1, pushed: 1 });
  });

  test('a bell under 15 business minutes old is not due', async () => {
    mockState.rows = [row('n-1', { createdAt: est('09', '10:10') })];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 0, pushed: 0 });
    expect(loadContactBundles).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });

  test('a push more than 2 business hours past due is dropped, so a restart cannot burst old bells', async () => {
    expect(await run(est('09', '12:16'))).toMatchObject({ due: 0, pushed: 0 });
    expect(await run(est('09', '12:14'))).toMatchObject({ due: 1, pushed: 1 });
  });

  test('a bell older than 48 hours is never judged', async () => {
    mockState.rows = [row('n-1', { createdAt: est('07', '09:00') })];
    expect(await run(est('09', '10:00'))).toMatchObject({ due: 0 });
  });

  test('a refresh that rang again moves the clock: the bell is judged from metadata.rungAt', async () => {
    mockState.rows = [row('n-1', { createdAt: est('09', '08:30'), metadata: { rungAt: est('09', '10:10').toISOString() } })];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 0 });
    mockState.rows = [row('n-1', { createdAt: est('09', '08:30'), metadata: { rungAt: est('09', '10:00').toISOString() } })];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 1 });
  });
});

describe('business hours and the late window are asked again at dispatch', () => {
  test('a sweep whose hours closed before an item was stamped sends and stamps nothing', async () => {
    mockState.rows = [row('n-1', { createdAt: est('09', '17:40') })];
    const result = await runNewLeadReminder({ now: est('09', '17:59'), clock: () => est('09', '18:01') });
    expect(result).toMatchObject({ skipped: false, due: 1, pushed: 0 });
    expect(updates()).toEqual([]);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a push stamped inside the hours is refused by its beforePush check once the hours have closed', async () => {
    mockState.rows = [row('n-1', { createdAt: est('09', '17:40') })];
    let calls = 0;
    const clock = () => (calls++ === 0 ? est('09', '17:59') : est('09', '18:01'));
    const result = await runNewLeadReminder({ now: est('09', '17:59'), clock });
    await Promise.all(result.sends);
    expect(pushes()).toHaveLength(1);
    expect(await pushes()[0][2].beforePush()).toBe(false);
  });

  // The 10:00 bell is due at 10:15 and stale after 12:15 (2 business hours later). Due when the sweep began at 12:14.
  test('an item whose late window closes while the reads run is neither stamped nor sent', async () => {
    const result = await runNewLeadReminder({ now: est('09', '12:14'), clock: () => est('09', '12:16') });
    await Promise.all(result.sends);
    expect(result).toMatchObject({ skipped: false, due: 1, pushed: 0 });
    expect(updates()).toEqual([]);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a push stamped inside its late window is refused when the window closes during the open-row read', async () => {
    let late = false;
    mockState.onOpenRead = () => { late = true; };
    const result = await runNewLeadReminder({ now: est('09', '12:14'), clock: () => (late ? est('09', '12:16') : est('09', '12:14')) });
    await Promise.all(result.sends);
    expect(result).toMatchObject({ due: 1, pushed: 1 });
    expect(await pushes()[0][2].beforePush()).toBe(false);
    expect(late).toBe(true);
    // Inside the window the same check says yes.
    late = false;
    mockState.onOpenRead = null;
    expect(await pushes()[0][2].beforePush()).toBe(true);
  });
});

describe('the 15-minute push (no gate)', () => {
  test('an open bell nobody reached is stamped once and pushes once, with its own words, to admin users only', async () => {
    const result = await run(PUSH_NOW);
    expect(result).toMatchObject({ skipped: false, due: 1, pushed: 1 });
    expect(updates()).toHaveLength(1);
    expect(JSON.parse(updates()[0].update.metadata.bindings[0])).toEqual({ [PUSH_STAMP]: PUSH_NOW.toISOString() });
    expect(pushes()).toHaveLength(1);
    const [, payload, opts] = pushes()[0];
    expect(payload).toEqual({
      alertRowId: 'n-1', alertTitle: 'New lead', alertBody: 'Pat Sample via the website - Wants pest control', alertLink: `/admin/leads?lead=${LEAD}`, customerId: CUST,
    });
    expect(opts).toMatchObject({ pushOnly: true, adminOnly: true, bellAuthorized: true });
  });

  test('witnesses are read from before the lead came in, not only after the bell', async () => {
    mockState.rows = [row('n-1', { createdAt: est('09', '10:08') })];
    mockState.leads = [lead({ created_at: est('09', '10:00') })];
    await run(est('09', '10:30'));
    const [[items]] = loadContactBundles.mock.calls;
    expect(items).toEqual([{ id: 'n-1', kind: 'customer', bellAt: est('09', '09:55'), refs: { customerId: CUST, phone: '+19415550100' } }]);
  });

  test('a row already stamped sends nothing again: at most one push per bell row', async () => {
    mockState.rows = [row('n-1', { metadata: { [PUSH_STAMP]: est('09', '10:16').toISOString() } })];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 0, pushed: 0 });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a stamp the fence refused (closed, or changed since it was read) sends nothing', async () => {
    mockState.stampResults = [0];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 0 });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('tracking-line text bells (no lead id) are not judged', async () => {
    mockState.rows = [{ ...row('n-1'), link: '/admin/communications?thread=x', metadata: { triggerKey: 'new_lead', payload: { twilioSid: 'SMx' } } }];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 0 });
  });

  // lead-webhook-repeat-form.test.js pins the writer's category and dedupeKey to the relevance sweep's lead_repeat_form
  // class; the scan reads that class, so it reads the rows the writer rings.
  test('the scan reads every new-lead bell, and the repeat-form bell by the relevance sweep\'s own class for it', async () => {
    await run(PUSH_NOW);
    const scan = mockState.calls.find((c) => c.table === 'notifications' && c.verb === 'select');
    const repeatForm = require('../services/admin-alert-relevance').CLASSES.find((c) => c.key === 'lead_repeat_form');
    expect(scan.ins).toEqual([['category', ['new_lead']], ['category', repeatForm.categories]]);
    expect(scan.raws).toContainEqual(["metadata->>'dedupeKey' LIKE ?", [`${repeatForm.prefix}%`]]);
  });

  test('a lead who sent the quote form again, nobody reached since that form: one push, judged from the form', async () => {
    mockState.rows = [repeatFormRow('rf-1')];
    mockState.leads = [lead({ created_at: est('02', '10:00'), status: 'contacted' })];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 1 });
    expect(pushes()[0][1]).toMatchObject({ alertRowId: 'rf-1', alertLink: `/admin/leads?lead=${LEAD}` });
    // A later inquiry: the witnesses count from the form itself, not from when the lead came in.
    expect(loadContactBundles.mock.calls[0][0][0].bellAt).toEqual(est('09', '09:55'));

    jest.clearAllMocks();
    mockState.rows = [repeatFormRow('rf-2')];
    mockBundles.byId['rf-2'] = { textAt: est('09', '10:05') };
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 0 });
  });

  test('a repeat form minutes after a call lead is a fresh inquiry: the answered call that made the lead does not settle it', async () => {
    // A person answered the call that made the lead at 9:52; the caller sent the quote form at 10:00.
    mockState.leads = [lead({ created_at: est('09', '09:52'), twilio_call_sid: CALL_SID })];
    mockState.answered = [{ twilio_call_sid: CALL_SID }];
    mockState.rows = [repeatFormRow('rf-1')];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 1 });
    // Judged from the form itself, never from the lead's first contact, and the call is not read.
    expect(loadContactBundles.mock.calls[0][0][0].bellAt).toEqual(est('09', '09:55'));
    expect(mockState.calls.filter((c) => c.table === 'call_log')).toEqual([]);

    // The new-lead bell written with that lead is its intake bell: the answered call settles it.
    jest.clearAllMocks();
    mockState.rows = [row('n-2')];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 0 });
  });

  test('the banner re-reads the row just before it goes: closed or gone meanwhile, or a failed read, says no', async () => {
    await run(PUSH_NOW);
    const { beforePush } = pushes()[0][2];
    expect(await beforePush()).toBe(true);
    mockState.open = { 'n-1': { done_at: new Date() } };
    expect(await beforePush()).toBe(false);
    mockState.open = { 'n-1': undefined };
    expect(await beforePush()).toBe(false);
    mockState.open = {};
    mockState.failOpen = true;
    expect(await beforePush()).toBe(false);
  });

  test('the banner goes only while the row is an open bell with exactly the metadata the stamp left', async () => {
    await run(PUSH_NOW);
    const { beforePush } = pushes()[0][2];
    mockState.calls.length = 0;
    expect(await beforePush()).toBe(true);
    const [read] = mockState.calls.filter((c) => c.table === 'notifications' && c.verb === 'first');
    // A bell that rang again (notifyAdmin advanced rungAt), moved to Activity, or lost its stamp no longer matches.
    const stamped = { ...row('n-1').metadata, [PUSH_STAMP]: PUSH_NOW.toISOString() };
    expect(read.raws).toContainEqual(['metadata IS NOT DISTINCT FROM ?::jsonb', [JSON.stringify(stamped)]]);
    expect(read.raws).toContainEqual(["metadata->'retired' IS NULL"]);
  });

  test('a bell with a dedupe key is stamped under notifyAdmin\'s lock for that key; one without takes no lock', async () => {
    const db = require('../models/db');
    mockState.rows = [repeatFormRow('rf-1')];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 1 });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:lead-repeat-form:${CUST}`]);

    jest.clearAllMocks();
    mockState.rows = [row('n-2')];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 1 });
    expect(db.raw.mock.calls.filter(([sql]) => sql.includes('pg_advisory_xact_lock'))).toEqual([]);
  });

  test('a push provider failure never throws into the sweep', async () => {
    triggerNotification.mockRejectedValueOnce(new Error('provider down'));
    await expect(run(PUSH_NOW)).resolves.toMatchObject({ pushed: 1 });
  });
});

describe('"reached" is judged on the lead, whatever the close gates say', () => {
  test.each([
    ['a person texted the lead', { textAt: est('09', '10:05') }],
    ['a person called the lead back', { backAt: est('09', '10:05') }],
    ['a person answered an inbound call from the lead', { inAt: est('09', '10:05') }],
    ['a person emailed the lead', { replyAt: est('09', '10:05') }],
    ['a visit was booked', { visitAt: est('09', '10:05') }],
  ])('%s: no push', async (_label, bundle) => {
    mockBundles.byId = { 'n-1': bundle };
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 0 });
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });

  test('contact BEFORE the witnesses window does not count', async () => {
    mockBundles.byId = { 'n-1': { textAt: est('09', '09:00') } };
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 1 });
  });

  test('an answered call lead does not page: the call that made the lead is judged, though it ended before the bell', async () => {
    mockState.leads = [lead({ twilio_call_sid: CALL_SID })];
    mockState.answered = [{ twilio_call_sid: CALL_SID }];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 0 });
    expect(loadContactBundles).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a voicemail lead (its call not answered by a person) pages', async () => {
    mockState.rows = [row('n-1', { title: 'New voicemail lead' })];
    mockState.leads = [lead({ twilio_call_sid: CALL_SID })];
    mockState.answered = [];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 1 });
  });

  test.each(['won', 'lost', 'disqualified', 'duplicate', 'unresponsive', 'handled', 'estimate_sent', 'estimate_viewed'])('a lead in status %s sends nothing', async (status) => {
    mockState.leads = [lead({ status })];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test.each([['new'], ['contacted']])('status %s alone is not contact: it still pages', async (status) => {
    mockState.leads = [lead({ status })];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 1 });
  });

  test.each(['spam', 'cancelled', 'qualified', 'abandoned'])('a lead in status %s is outside the open-lead predicate: nothing is sent', async (status) => {
    mockState.leads = [lead({ status })];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a converted lead (converted_at set) is never paged, whatever its status', async () => {
    mockState.leads = [lead({ status: 'new', converted_at: est('09', '09:00') })];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
  });

  test('a deleted lead, or a lead row that is gone (unknown, never judged), sends nothing', async () => {
    mockState.leads = [lead({ deleted_at: est('09', '10:02') })];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
    mockState.leads = [];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
  });

  test('a lead with no customer, no phone and no email cannot be judged: nothing is sent', async () => {
    mockState.leads = [lead({ customer_id: null, phone: null, email: null })];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
    mockState.leads = [lead({ customer_id: null, phone: null, email: 'not an address' })];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
  });

  test('an email-only lead (no phone, no customer) nobody answered pushes; one a person emailed back does not', async () => {
    mockState.leads = [lead({ customer_id: null, phone: null })];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 1 });
    const [[items]] = loadContactBundles.mock.calls;
    expect(items[0].refs).toEqual({ customerId: null, phone: null });
    updates().length = 0;
    triggerNotification.mockClear();
    mockState.emails = [{ to_address: 'Pat Sample <pat@example.invalid>', cc_address: null, bcc_address: null, received_at: est('09', '10:05') }];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 0 });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('an email-only lead whose estimate was sent does not push', async () => {
    mockState.leads = [lead({ customer_id: null, phone: null, estimate_id: 'e-9' })];
    mockState.estimates = [{ id: 'e-9', customer_id: null, sent_at: est('09', '10:05') }];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
  });

  test('an estimate sent to the lead after it came in, by its own estimate or its customer', async () => {
    mockState.estimates = [{ id: 'e-1', customer_id: CUST, sent_at: est('09', '10:05') }];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
    mockState.leads = [lead({ customer_id: null, estimate_id: 'e-9' })];
    mockState.estimates = [{ id: 'e-9', customer_id: null, sent_at: est('09', '10:05') }];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
    mockState.leads = [lead({ estimate_id: 'e-9' })];
    mockState.estimates = [{ id: 'e-2', customer_id: '99999999-9999-4999-8999-999999999999', sent_at: est('09', '10:05') }];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 1 });
  });

  test('the estimate the bell names counts when it was sent, though the lead now points at another draft', async () => {
    // An email lead's draft bell carries metadata.estimateId; a later draft moved the lead's estimate_id, and it has no customer.
    const NAMED = '33333333-3333-4333-8333-333333333333';
    const LATER_DRAFT = '44444444-4444-4444-8444-444444444444';
    mockState.rows = [row('n-1', { metadata: { estimateId: NAMED } })];
    mockState.leads = [lead({ customer_id: null, phone: null, estimate_id: LATER_DRAFT })];
    mockState.estimates = [{ id: NAMED, customer_id: null, sent_at: est('09', '10:05') }];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 0 });
    expect(mockState.calls.find((c) => c.table === 'estimates').ins).toEqual([['id', [NAMED, LATER_DRAFT]]]);
    // The same quote with no bell naming it is another lead's: the bell still pushes.
    mockState.rows = [row('n-2')];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 1 });
  });

  test('an estimate sent long before the lead came in does not count', async () => {
    mockState.estimates = [{ id: 'e-1', customer_id: CUST, sent_at: est('02', '10:05') }];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 1 });
  });

  test('an estimate handed off to the lead\'s customer (the promise lane\'s witness)', async () => {
    mockState.handedOff = { id: 'e-3' };
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
  });

  test('a person\'s email to the lead\'s own address (a lead from email, no customer yet)', async () => {
    mockState.leads = [lead({ customer_id: null })];
    mockState.emails = [{ to_address: 'Pat Sample <pat@example.invalid>', cc_address: null, bcc_address: null, received_at: est('09', '10:05') }];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
    mockState.emails = [{ to_address: 'someone.else@example.invalid', cc_address: null, bcc_address: null, received_at: est('09', '10:05') }];
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 1 });
  });

  test('a send to a mailbox the lead shares with another customer counts only when the linkage ties it to this lead', async () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    // Two customers on file with one address (a couple, or a landlord and a tenant).
    mockState.customerRows = [{ id: CUST, email: 'pat@example.invalid' }, { id: OTHER, email: 'Pat@Example.invalid' }];
    mockState.emails = [{ id: 'm-1', gmail_thread_id: 't-1', to_address: 'pat@example.invalid', cc_address: '', bcc_address: '', received_at: est('09', '10:05') }];
    // Linked to the other customer: it says nothing about this lead.
    mockState.links = { 'm-1': OTHER };
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 1 });
    // Linked to nobody: it may have been for either customer, so it does not settle this lead either.
    mockState.links = {};
    mockState.rows = [row('n-2')];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 1 });
    // Linked to the lead's own customer: reached.
    mockState.links = { 'm-1': CUST };
    mockState.rows = [row('n-3')];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 0 });
    // The address on no other customer's file: a send linked to nobody reached this lead.
    mockState.customerRows = [{ id: CUST, email: 'pat@example.invalid' }];
    mockState.links = {};
    mockState.rows = [row('n-4')];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 0 });
  });

  test('an email lead looks back to when the message came in, not only to when classification made the lead', async () => {
    mockState.rows = [row('n-1', { createdAt: est('09', '10:03') })];
    mockState.leads = [lead({ customer_id: null, phone: null, created_at: est('09', '10:02'), first_contact_at: est('09', '09:40') })];
    mockState.emails = [{ to_address: 'pat@example.invalid', cc_address: null, bcc_address: null, received_at: est('09', '09:50') }];
    expect(await run(est('09', '10:20'))).toMatchObject({ due: 1, pushed: 0 });
    const [[items]] = loadContactBundles.mock.calls;
    expect(items[0].bellAt).toEqual(est('09', '09:35'));
  });

  test('a fresh form on a lead made days ago is judged from its own bell: the earlier contact and the old call do not suppress it', async () => {
    const old = est('06', '10:00');
    mockState.rows = [row('n-1', { createdAt: est('09', '10:00') })];
    mockState.leads = [lead({ created_at: old, twilio_call_sid: CALL_SID })];
    mockState.answered = [{ twilio_call_sid: CALL_SID }];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 1 });
    const [[items]] = loadContactBundles.mock.calls;
    expect(items[0].bellAt).toEqual(est('09', '09:55'));
    expect(mockState.calls.filter((c) => c.table === 'call_log')).toEqual([]);
  });

  test('a follow-up email bell on an old lead counts staff replies from the message, not from the bell', async () => {
    const EMAIL = '66666666-6666-4666-8666-666666666666';
    mockState.rows = [row('n-1', { createdAt: est('09', '10:00'), metadata: { emailId: EMAIL, leadId: LEAD } })];
    mockState.leads = [lead({ created_at: est('06', '10:00'), customer_id: null, phone: null })];
    mockState.emailRows = [{ id: EMAIL, received_at: est('09', '09:20') }];
    mockState.emails = [{ to_address: 'pat@example.invalid', cc_address: null, bcc_address: null, received_at: est('09', '09:40') }];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 0 });
    const [[items]] = loadContactBundles.mock.calls;
    expect(items[0].bellAt).toEqual(est('09', '09:15'));
    // One batched read of the messages, whatever the batch size; the push clock stays on the bell.
    expect(mockState.calls.filter((c) => c.table === 'emails')).toHaveLength(1);
  });

  test('only the new-lead trigger\'s bell is the intake bell: an email follow-up\'s draft bell is a later inquiry, however soon it came', async () => {
    const EMAIL = '55555555-5555-4555-8555-555555555555';
    // A person answered the call that made the lead at 9:52; the caller's email came in at 9:58, email-actions.js linked
    // it to that lead and rang its draft bell straight to the bell (notifyAdmin('new_lead'): no triggerKey).
    mockState.leads = [lead({ created_at: est('09', '09:52'), twilio_call_sid: CALL_SID })];
    mockState.answered = [{ twilio_call_sid: CALL_SID }];
    mockState.rows = [{
      id: 'd-1', category: 'new_lead', title: 'Email follow-up completed a quote request — draft estimate ready', body: 'Pat asked for a quote.',
      link: '/admin/estimates', created_at: est('09', '10:00'), created_at_token: est('09', '10:00').toISOString(),
      metadata: { emailId: EMAIL, leadId: LEAD, estimateId: '77777777-7777-4777-8777-777777777777', dedupeKey: `email-lead:draft:${EMAIL}` },
    }];
    mockState.emailRows = [{ id: EMAIL, received_at: est('09', '09:58') }];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 1 });
    // Judged from the message, never from the lead's first contact, and the call is not read.
    expect(loadContactBundles.mock.calls[0][0][0].bellAt).toEqual(est('09', '09:53'));
    expect(mockState.calls.filter((c) => c.table === 'call_log')).toEqual([]);

    // The trigger's own bell for that lead is its intake bell: the answered call settles it.
    jest.clearAllMocks();
    mockState.rows = [row('n-2')];
    expect(await run(PUSH_NOW)).toMatchObject({ due: 1, pushed: 0 });
  });

  test('a bell naming no usable email id reads no message and anchors to the bell', async () => {
    mockState.rows = [row('n-1', { metadata: { emailId: 'not-a-uuid' } })];
    await run(PUSH_NOW);
    expect(mockState.calls.filter((c) => c.table === 'emails')).toEqual([]);
  });

  test('the email read starts at the earliest anchor of the batch, not a fixed cutoff', async () => {
    mockState.leads = [lead({ customer_id: null, phone: null })];
    await run(PUSH_NOW);
    const query = mockState.calls.find((c) => c.table === 'emails as er');
    expect(query.wheres).toContainEqual(['er.received_at', '>', est('09', '09:55')]);
  });

  test('a failed witness read or lead read is no verdict: nothing is sent or stamped', async () => {
    mockBundles.fail = true;
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
    mockBundles.fail = false;
    mockState.failLeads = true;
    expect(await run(PUSH_NOW)).toMatchObject({ pushed: 0 });
    expect(updates()).toEqual([]);
    expect(triggerNotification).not.toHaveBeenCalled();
  });
});

describe('what it never does', () => {
  test('the push goes to admin users only: no customer or lead text, email or call is sent here', () => {
    const source = require('fs').readFileSync(require.resolve('../services/new-lead-reminder'), 'utf8');
    expect(source).not.toMatch(/sendSMS|sendEmail|twilio\.messages|sendCustomerMessage/);
    expect(require('fs').readFileSync(require.resolve('../services/lead-reminder-sweep'), 'utf8')).toMatch(/adminOnly: true/);
  });
});

describe('a capped scan resumes: old settled bells cannot hide a due one', () => {
  test('a sweep that reads 5 full pages remembers where it stopped; the next one starts after that row', async () => {
    // pageSize 1, five rows that are not yet due (a bell 10 minutes old), then a due bell on the next sweep.
    const fresh = (n) => row(`new-${n}`, { createdAt: new Date(est('09', '10:10').getTime() + n * 1000) });
    mockState.pages = [[fresh(1)], [fresh(2)], [fresh(3)], [fresh(4)], [fresh(5)]];
    expect(await runNewLeadReminder({ now: PUSH_NOW, pageSize: 1 })).toMatchObject({ due: 0, pushed: 0 });
    expect(sweepShared.__private.resumeAfter.get(PUSH_STAMP)).toEqual({ createdAt: fresh(5).created_at_token, id: 'new-5' });

    mockState.pages = [[row('n-due')]];
    mockState.calls.length = 0;
    const second = await runNewLeadReminder({ now: PUSH_NOW, pageSize: 1 });
    await Promise.all(second.sends);
    expect(second).toMatchObject({ due: 1, pushed: 1 });
    const firstQuery = mockState.calls.find((c) => c.table === 'notifications' && c.verb === 'select');
    expect(firstQuery.raws).toContainEqual(['(created_at, id) > (?::timestamptz, ?::uuid)', [fresh(5).created_at_token, 'new-5']]);
    // The due row fills a page of one, so the scan went on; an empty page ended it and the cursor starts over.
    expect(sweepShared.__private.resumeAfter.has(PUSH_STAMP)).toBe(false);
  });
});
