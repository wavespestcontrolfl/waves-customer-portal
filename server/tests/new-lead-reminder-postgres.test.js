/**
 * The new-lead re-alert against live Postgres, the SQL as the sweep runs it: the shared scan reads every new-lead bell
 * and the repeat-form bell that the real writer rings (lead-webhook.js ringRepeatFormAlert, through the real alert
 * composer and notifyAdmin), and no other kind of lead bell. Each bell nobody reached is stamped once and pushes once;
 * the next sweep sends nothing. Each push asks its dispatch check against the row as stored, so a bell that rang again or
 * moved to Activity between its stamp and its push sends nothing. The rules themselves are covered by
 * new-lead-reminder.test.js. Synthetic names only.
 *
 * The sweep reads the whole notifications table, so every statement of a test runs in one transaction that is rolled
 * back after it (as admin-billing-recovery-postgres.test.js does): a bell anything else left open in this database is
 * stamped, if at all, only inside that transaction, and the fixtures go with it.
 */
const crypto = require('crypto');

// Every module reaches the database through this handle: the test's open transaction, else the real pool.
let mockTrx = null;
jest.mock('../models/db', () => {
  const actual = jest.requireActual('../models/db');
  const live = () => mockTrx || actual;
  return new Proxy(() => {}, {
    apply: (_target, _self, args) => live()(...args),
    get: (_target, prop) => {
      if (prop === 'real') return actual;
      const value = live()[prop];
      return typeof value === 'function' ? value.bind(live()) : value;
    },
  });
});
// The push provider is a stub, but each push asks its dispatch check (beforePush) as the real dispatcher does, and the
// answer is recorded. mockBeforeDispatch (optional) changes the bell after its stamp, before that check.
const mockDispatched = [];
let mockBeforeDispatch = null;
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async (_key, payload, opts = {}) => {
    if (mockBeforeDispatch) await mockBeforeDispatch(payload.alertRowId);
    const go = opts.beforePush ? await opts.beforePush() : true;
    mockDispatched.push({ id: payload.alertRowId, go });
    return { bellWritten: false, push: { sent: go ? 1 : 0 } };
  }),
}));
// notifyAdmin sends the bell's own banner after the writer's row lands; this suite needs only the row.
jest.mock('../services/bell-banners', () => ({ ...jest.requireActual('../services/bell-banners'), bannerAfterWrite: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

// The first test opens the first connection; on a loaded machine that alone can pass jest's 5 s default.
jest.setTimeout(60000);

const MIN = 60 * 1000;
// 3:00 PM ET on a Thursday, inside the Monday to Saturday 8 AM to 6 PM hours (EST, UTC-5). Every row's time is set from
// it, and the sweep's dispatch clock reads it too, so the suite runs the same at any hour.
const NOW = new Date('2026-11-05T15:00:00-05:00');

maybeDescribe('new-lead re-alert (live Postgres)', () => {
  let db;
  let reminder;
  let triggerNotification;
  let phoneN = 9400;
  const mins = (m) => new Date(NOW.getTime() + m * MIN);

  let ringRepeatFormAlert;
  // The writer's route module is large; it loads here, outside the test's own time.
  beforeAll(() => {
    db = require('../models/db');
    reminder = require('../services/new-lead-reminder');
    ({ triggerNotification } = require('../services/notification-triggers'));
    ({ ringRepeatFormAlert } = require('../routes/lead-webhook')._test);
  }, 120000);
  beforeEach(async () => {
    jest.clearAllMocks();
    require('../services/lead-reminder-sweep').__private.resumeAfter.clear();
    mockDispatched.length = 0;
    mockBeforeDispatch = null;
    mockTrx = await db.real.transaction();
  });
  afterEach(async () => {
    if (mockTrx && !mockTrx.isCompleted()) await mockTrx.rollback();
    mockTrx = null;
  });
  afterAll(async () => {
    await db?.real.destroy();
  }, 60000);

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    return r;
  };
  const metaOf = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {});
  // A lead on file for three days and still a lead (pipeline_stage new_lead), with its own customer row and phone.
  const leadOnFile = async () => {
    const onFile = mins(-3 * 24 * 60);
    const customer = await insert('customers', {
      first_name: 'Lead', last_name: 'Sample', phone: `+1555555${phoneN += 1}`, email: `lead${phoneN}-${Date.now()}@example.invalid`, pipeline_stage: 'new_lead', created_at: onFile,
    });
    const lead = await insert('leads', { customer_id: customer.id, phone: customer.phone, first_name: 'Lead', last_name: 'Sample', status: 'new', created_at: onFile });
    return { customer, lead };
  };
  // A website form's new-lead bell (category new_lead, the lead in its payload).
  const newLeadBell = (lead, at) => insert('notifications', {
    recipient_type: 'admin', category: 'new_lead', title: 'New lead', body: 'Lead Sample via the website - Wants pest control',
    link: `/admin/leads?lead=${lead.id}`, created_at: at,
    metadata: JSON.stringify({ triggerKey: 'new_lead', doneWhen: 'lead_contacted', payload: { leadId: lead.id } }),
  });
  // Another kind of lead bell (lead-call-reply-ring.js raiseMissedBell): the call reminder's, never this one's.
  const missedCallBell = (customer, lead, at) => insert('notifications', {
    recipient_type: 'admin', category: 'lead', title: 'Leads — call Lead Sample back',
    body: 'Missed call request: Lead replied CALL to our lead text and nobody pressed 1.', link: `/admin/leads?lead=${lead.id}`, created_at: at,
    metadata: JSON.stringify({ dedupeKey: `lead-call-reply-missed:${crypto.randomUUID()}`, leadId: lead.id, customerId: customer.id, doneWhen: 'lead_contacted', who: 'person' }),
  });
  // The row the real writer rings for a form sent again, moved to the suite's clock: the writer stamps the real time.
  const repeatFormBell = async (customer, lead, at) => {
    await ringRepeatFormAlert(customer, lead.id);
    const written = await db('notifications').where({ recipient_type: 'admin' }).whereNull('done_at')
      .whereRaw("metadata->>'dedupeKey' = ?", [`lead-repeat-form:${customer.id}`]).first();
    const { rungAt: _rungAt, askedAt: _askedAt, ...meta } = metaOf(written);
    await db('notifications').where({ id: written.id }).update({ created_at: at, metadata: JSON.stringify(meta) });
    return db('notifications').where({ id: written.id }).first();
  };
  const pushesFor = (id) => triggerNotification.mock.calls.filter(([key, payload]) => key === 'lead_call_reminder' && payload.alertRowId === id);
  // What each push's dispatch check answered for this bell.
  const dispatchedFor = (id) => mockDispatched.filter((d) => d.id === id).map((d) => d.go);
  const run = async () => {
    const result = await reminder.runNewLeadReminder({ now: NOW, clock: () => NOW });
    await Promise.all(result.sends || []);
    return result;
  };

  test('the scan reads every new-lead bell and the repeat-form bell the writer rings, and no other kind of lead bell', async () => {
    const formLead = await leadOnFile();
    const webLead = await leadOnFile();
    const formBell = await repeatFormBell(formLead.customer, formLead.lead, mins(-20));
    const webBell = await newLeadBell(webLead.lead, mins(-20));
    const callBell = await missedCallBell(webLead.customer, webLead.lead, mins(-20));
    // As the writer stored it: category lead, its key in metadata, the lead in metadata and in the link.
    expect(formBell).toMatchObject({ category: 'lead', link: `/admin/leads?lead=${formLead.lead.id}` });
    expect(metaOf(formBell)).toMatchObject({ dedupeKey: `lead-repeat-form:${formLead.customer.id}`, leadId: formLead.lead.id });

    await run();
    expect(pushesFor(formBell.id)).toHaveLength(1);
    expect(pushesFor(webBell.id)).toHaveLength(1);
    expect(pushesFor(callBell.id)).toHaveLength(0);
    // The dispatch check finds each row exactly as the stamp left it.
    expect(dispatchedFor(formBell.id)).toEqual([true]);
    expect(dispatchedFor(webBell.id)).toEqual([true]);
    for (const bell of [formBell, webBell]) {
      expect(metaOf(await db('notifications').where({ id: bell.id }).first())[reminder.PUSH_STAMP]).toBe(NOW.toISOString());
    }
    expect(metaOf(await db('notifications').where({ id: callBell.id }).first())).not.toHaveProperty(reminder.PUSH_STAMP);

    // The next sweep finds both stamped: nothing is sent again.
    jest.clearAllMocks();
    await run();
    expect(pushesFor(formBell.id)).toHaveLength(0);
    expect(pushesFor(webBell.id)).toHaveLength(0);
  }, 180000);

  test('a bell that rang again or moved to Activity between its stamp and its push sends nothing', async () => {
    const rerung = await leadOnFile();
    const moved = await leadOnFile();
    const rerungBell = await repeatFormBell(rerung.customer, rerung.lead, mins(-20));
    const movedBell = await newLeadBell(moved.lead, mins(-20));
    // What a fresh form does to the standing bell (notifyAdmin's ringing refresh advances rungAt), and what routing to
    // Claude's queue does (feed activity), landing after the stamp and before the push.
    const changes = { [rerungBell.id]: { rungAt: mins(-1).toISOString() }, [movedBell.id]: { feed: 'activity' } };
    mockBeforeDispatch = async (id) => {
      if (changes[id]) await db('notifications').where({ id }).update({ metadata: db.raw('metadata || ?::jsonb', [JSON.stringify(changes[id])]) });
    };
    await run();
    expect(dispatchedFor(rerungBell.id)).toEqual([false]);
    expect(dispatchedFor(movedBell.id)).toEqual([false]);
    // Both keep their stamp: at most one push per bell (a ring reaches the phones itself).
    for (const bell of [rerungBell, movedBell]) {
      expect(metaOf(await db('notifications').where({ id: bell.id }).first())[reminder.PUSH_STAMP]).toBe(NOW.toISOString());
    }
  }, 180000);
});
