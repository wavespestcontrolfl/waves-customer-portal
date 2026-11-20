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
 * stamped, if at all, only inside that transaction, and the fixtures go with it. One test needs two real connections
 * at once (two stamps racing for one lead's lock): it commits two bells dated 2020, which no sweep's 48-hour scan can
 * read, and deletes them after.
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
  // The bell's content version as the bell list and the Done fence read it (notification-service.js).
  const versionOf = async (id) => {
    const { NOTIFICATION_VERSION_SQL } = require('../services/notification-service')._private;
    return (await db('notifications').where({ id }).first(db.raw(`${NOTIFICATION_VERSION_SQL} AS version`))).version;
  };
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
  // A person's delivered text to a phone, tied to a customer or to none (the shared witnesses' text rule, staff-contact.js).
  const staffTextTo = (phone, at, customerId = null) => insert('sms_log', {
    direction: 'outbound', from_phone: '+15555559499', to_phone: phone, customer_id: customerId,
    message_body: 'Hi, this is Waves about your request.', message_type: 'manual', status: 'delivered',
    twilio_sid: `SMO${crypto.randomUUID().replace(/-/g, '')}`, metadata: JSON.stringify({ human_authored: true }), created_at: at,
  });
  // A lead with no customer on file, on the phone given.
  const leadOn = (phone) => insert('leads', { phone, first_name: 'Lead', last_name: 'Sample', status: 'new', created_at: mins(-3 * 24 * 60) });
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
    const versionsBefore = { [formBell.id]: await versionOf(formBell.id), [webBell.id]: await versionOf(webBell.id) };
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
      // The stamp is not part of the bell's version: an admin's Done fenced on the version read before it still lands.
      expect(await versionOf(bell.id)).toBe(versionsBefore[bell.id]);
    }
    expect(metaOf(await db('notifications').where({ id: callBell.id }).first())).not.toHaveProperty(reminder.PUSH_STAMP);

    // The next sweep finds both stamped: nothing is sent again.
    jest.clearAllMocks();
    await run();
    expect(pushesFor(formBell.id)).toHaveLength(0);
    expect(pushesFor(webBell.id)).toHaveLength(0);
  }, 180000);

  test('one lead\'s new-lead bell and the repeat-form bell the writer rings push once, for the later inquiry; none again in 48 hours; then the re-rung row can', async () => {
    const { customer, lead } = await leadOnFile();
    const webBell = await newLeadBell(lead, mins(-25));
    const formBell = await repeatFormBell(customer, lead, mins(-18));
    await run();
    expect(pushesFor(formBell.id)).toHaveLength(1);
    expect(pushesFor(webBell.id)).toHaveLength(0);
    expect(metaOf(await db('notifications').where({ id: formBell.id }).first())[reminder.PUSH_STAMP]).toBe(NOW.toISOString());
    // Held back by the lead's claim, not stamped: the next sweep judges it again, and the claim holds it again.
    expect(metaOf(await db('notifications').where({ id: webBell.id }).first())).not.toHaveProperty(reminder.PUSH_STAMP);
    jest.clearAllMocks();
    await run();
    expect(pushesFor(webBell.id)).toHaveLength(0);

    const sweepAt = async (at) => {
      jest.clearAllMocks();
      const result = await reminder.runNewLeadReminder({ now: at, clock: () => at });
      await Promise.all(result.sends || []);
      return result;
    };
    // The lead asks again 10 minutes after that push (a new bell row), and nobody reaches it in 15 minutes: capped.
    const nextBell = await newLeadBell(lead, mins(10));
    await sweepAt(mins(30));
    expect(pushesFor(nextBell.id)).toHaveLength(0);
    // The lead sends the form again at +40 minutes: the writer refreshes the stamped repeat-form row. Its stamp is kept;
    // the ring moves created_at (bumpOnRefresh) and rungAt to the real time, both set to the suite's clock here. The
    // scan reads it again, and the cap holds it.
    const ringAgain = async (at) => {
      await ringRepeatFormAlert(customer, lead.id);
      await db('notifications').where({ id: formBell.id })
        .update({ created_at: at, metadata: db.raw('metadata || ?::jsonb', [JSON.stringify({ rungAt: at.toISOString() })]) });
      return metaOf(await db('notifications').where({ id: formBell.id }).first());
    };
    // The rows the scan reads at `at` and finds due (the sweep's own two steps).
    const dueAt = async (at) => {
      const { candidateQuery, dueItems } = reminder.__private;
      const rows = await candidateQuery(new Date(at.getTime() - 48 * 60 * MIN), null, 1000);
      return dueItems(rows, at).map((i) => i.row.id);
    };
    expect(await ringAgain(mins(40))).toMatchObject({ [reminder.PUSH_STAMP]: NOW.toISOString(), rungAt: mins(40).toISOString() });
    expect(await dueAt(mins(60))).toContain(formBell.id);
    await sweepAt(mins(60));
    expect(pushesFor(formBell.id)).toHaveLength(0);
    // It rings again 49 hours after the push (Saturday 3:40 PM), and nobody reaches the lead: that event pushes.
    await ringAgain(mins(49 * 60 - 20));
    const saturday = mins(49 * 60);
    expect(await dueAt(saturday)).toContain(formBell.id);
    await sweepAt(saturday);
    expect(pushesFor(formBell.id)).toHaveLength(1);
    expect(metaOf(await db('notifications').where({ id: formBell.id }).first())[reminder.PUSH_STAMP]).toBe(saturday.toISOString());
  }, 180000);

  test('the cap stays with the lead a push was for: the writer refreshes the repeat-form row for the customer\'s other lead, which pushes, and the first lead stays capped', async () => {
    const { customer, lead: leadA } = await leadOnFile();
    const leadB = await insert('leads', {
      customer_id: customer.id, phone: customer.phone, first_name: 'Lead', last_name: 'Sample', status: 'new', created_at: mins(-3 * 24 * 60),
    });
    const formBell = await repeatFormBell(customer, leadA, mins(-18));
    await run();
    expect(pushesFor(formBell.id)).toHaveLength(1);
    // A form for lead B refreshes the same row (keyed by the customer) at +10 minutes: it now names lead B, and keeps the
    // stamp and lead A's record. The ring moves created_at and rungAt, set to the suite's clock here.
    await ringRepeatFormAlert(customer, leadB.id);
    await db('notifications').where({ id: formBell.id })
      .update({ created_at: mins(10), metadata: db.raw('metadata || ?::jsonb', [JSON.stringify({ rungAt: mins(10).toISOString() })]) });
    expect(metaOf(await db('notifications').where({ id: formBell.id }).first())).toMatchObject({
      leadId: leadB.id, [reminder.PUSH_STAMP]: NOW.toISOString(), [reminder.LEAD_STAMPS]: { [leadA.id]: NOW.toISOString() },
    });
    const sweepAt = async (at) => {
      jest.clearAllMocks();
      const result = await reminder.runNewLeadReminder({ now: at, clock: () => at });
      await Promise.all(result.sends || []);
    };
    // Lead B has had no push: the refreshed row pushes for it.
    await sweepAt(mins(30));
    expect(pushesFor(formBell.id)).toHaveLength(1);
    expect(metaOf(await db('notifications').where({ id: formBell.id }).first())[reminder.LEAD_STAMPS])
      .toEqual({ [leadA.id]: NOW.toISOString(), [leadB.id]: mins(30).toISOString() });
    // Lead A's own new-lead bell is still capped by its push at NOW.
    const aBell = await newLeadBell(leadA, mins(20));
    await sweepAt(mins(40));
    expect(pushesFor(aBell.id)).toHaveLength(0);
  }, 180000);

  test('a person\'s text to a phone two open leads share reaches neither; to a lead\'s own phone it reaches it; tied to the lead\'s own customer it counts on a shared phone', async () => {
    const sharedPhone = `+1555555${phoneN += 1}`;
    const ownPhone = `+1555555${phoneN += 1}`;
    const leadA = await leadOn(sharedPhone);
    const leadB = await leadOn(sharedPhone);
    const leadC = await leadOn(ownPhone);
    const { customer, lead: leadD } = await leadOnFile();
    await leadOn(customer.phone);
    const bells = await Promise.all([leadA, leadB, leadC, leadD].map((l) => newLeadBell(l, mins(-18))));
    await staffTextTo(sharedPhone, mins(-10));
    await staffTextTo(ownPhone, mins(-10));
    await staffTextTo(customer.phone, mins(-10), customer.id);
    await run();
    expect(bells.map((b) => pushesFor(b.id).length)).toEqual([1, 1, 0, 0]);
  }, 60000);

  test('a person\'s text tied to another customer is no proof for a lead with no customer on that phone', async () => {
    const phone = `+1555555${phoneN += 1}`;
    const other = await insert('customers', {
      first_name: 'Other', last_name: 'Sample', phone, email: `other${phoneN}-${Date.now()}@example.invalid`, created_at: mins(-3 * 24 * 60),
    });
    const bell = await newLeadBell(await leadOn(phone), mins(-18));
    await staffTextTo(phone, mins(-10), other.id);
    await run();
    expect(pushesFor(bell.id)).toHaveLength(1);
  }, 60000);

  // Two sweeps (two app instances, or a slow sweep and the next one) can reach two bells of one lead at once. Each stamp
  // takes the lead's lock in its own transaction and reads the claim under it, so the second waits for the first to
  // commit, then reads its stamp and writes nothing.
  test('two stamps of one lead\'s bells at once: the lead\'s lock makes the second wait, read the first stamp and write nothing', async () => {
    await mockTrx.rollback();
    mockTrx = null;
    const { stampOnce } = require('../services/lead-reminder-sweep').__private;
    const { leadClaim } = reminder.__private;
    const at = new Date('2020-03-02T15:00:00-05:00');
    const leadId = crypto.randomUUID();
    const bell = async (minutesBefore) => {
      const [r] = await db.real('notifications').insert({
        recipient_type: 'admin', category: 'new_lead', title: 'New lead', body: 'Lead Sample via the website - Wants pest control',
        link: `/admin/leads?lead=${leadId}`, created_at: new Date(at.getTime() - minutesBefore * MIN),
        metadata: JSON.stringify({ triggerKey: 'new_lead', doneWhen: 'lead_contacted', payload: { leadId } }),
      }).returning('*');
      return r;
    };
    const item = (r) => ({ row: r, meta: metaOf(r), leadId, anchor: new Date(r.created_at) });
    const ungrantedAdvisoryLocks = async () => (await db.real.raw(`SELECT count(*)::int AS n FROM pg_locks l
      JOIN pg_database d ON d.oid = l.database WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = current_database()`)).rows[0].n;
    const ids = [];
    let release = () => {};
    const stamps = [];
    try {
      const older = await bell(25);
      ids.push(older.id);
      const newer = await bell(18);
      ids.push(newer.id);
      // The first stamp (the newer bell) holds the lead's lock, its transaction open, until the second is seen waiting.
      let locked;
      const gotLock = new Promise((resolve) => { locked = resolve; });
      const held = new Promise((resolve) => { release = resolve; });
      const claim = leadClaim(item(newer));
      const holding = { ...claim, taken: async (conn, t) => { const taken = await claim.taken(conn, t); locked(); await held; return taken; } };
      stamps.push(stampOnce(reminder.PUSH_STAMP, item(newer), () => at, () => true, holding));
      await gotLock;
      stamps.push(stampOnce(reminder.PUSH_STAMP, item(older), () => at, () => true, leadClaim(item(older))));
      let sawWait = false;
      for (let i = 0; i < 100 && !sawWait; i += 1) {
        sawWait = (await ungrantedAdvisoryLocks()) > 0;
        if (!sawWait) await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
      expect(sawWait).toBe(true);
      release();
      expect(await Promise.all(stamps)).toEqual([{ [reminder.PUSH_STAMP]: at.toISOString(), [reminder.LEAD_STAMPS]: { [leadId]: at.toISOString() } }, null]);
      const after = new Map((await db.real('notifications').whereIn('id', ids)).map((r) => [r.id, metaOf(r)]));
      expect(after.get(newer.id)[reminder.PUSH_STAMP]).toBe(at.toISOString());
      expect(after.get(older.id)).not.toHaveProperty(reminder.PUSH_STAMP);
    } finally {
      release();
      await Promise.allSettled(stamps);
      if (ids.length) await db.real('notifications').whereIn('id', ids).del();
    }
  }, 180000);

  test('a bell that rang again or moved to Activity, or whose lead converted, between its stamp and its push sends nothing', async () => {
    const rerung = await leadOnFile();
    const moved = await leadOnFile();
    const converted = await leadOnFile();
    const rerungBell = await repeatFormBell(rerung.customer, rerung.lead, mins(-20));
    const movedBell = await newLeadBell(moved.lead, mins(-20));
    const convertedBell = await newLeadBell(converted.lead, mins(-20));
    // What a fresh form does to the standing bell (notifyAdmin's ringing refresh advances rungAt), and what routing to
    // Claude's queue does (feed activity), landing after the stamp and before the push.
    const changes = { [rerungBell.id]: { rungAt: mins(-1).toISOString() }, [movedBell.id]: { feed: 'activity' } };
    mockBeforeDispatch = async (id) => {
      if (changes[id]) await db('notifications').where({ id }).update({ metadata: db.raw('metadata || ?::jsonb', [JSON.stringify(changes[id])]) });
      // A person booked the lead while its stamp waited: the bell row is untouched, the lead is not.
      if (id === convertedBell.id) await db('leads').where({ id: converted.lead.id }).update({ converted_at: mins(-1) });
    };
    await run();
    expect(dispatchedFor(rerungBell.id)).toEqual([false]);
    expect(dispatchedFor(movedBell.id)).toEqual([false]);
    expect(dispatchedFor(convertedBell.id)).toEqual([false]);
    // All keep their stamp: at most one push per bell (a ring reaches the phones itself).
    for (const bell of [rerungBell, movedBell, convertedBell]) {
      expect(metaOf(await db('notifications').where({ id: bell.id }).first())[reminder.PUSH_STAMP]).toBe(NOW.toISOString());
    }
  }, 180000);

  // Every metadata shape a row can hold gets a version, and any shape without the reminder stamps keeps the version the
  // plain hash gave it: `-` on a JSON scalar is an error, and one such row would break the whole bell list.
  test('the bell version reads every metadata shape, and leaves every unstamped row as it was', async () => {
    const { NOTIFICATION_VERSION_SQL } = require('../services/notification-service')._private;
    const plain = 'md5(jsonb_build_array(title, body, link, detail, metadata)::text)';
    const { rows } = await db.raw(
      `SELECT ${NOTIFICATION_VERSION_SQL} AS version, ${plain} AS plain FROM (VALUES
        ('t', 'b', NULL::text, NULL::text, '"scalar"'::jsonb), ('t', 'b', NULL, NULL, '7'::jsonb),
        ('t', 'b', NULL, NULL, NULL::jsonb), ('t', 'b', NULL, NULL, '["newLeadRealertAt"]'::jsonb),
        ('t', 'b', 'l', 'd', '{"a": 1}'::jsonb)) AS v(title, body, link, detail, metadata)`,
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.version).toBe(row.plain);
  });
});
