// SQL-level proof for the customer activity timeline on a real Postgres. Runs
// only with ACTIVITY_TIMELINE_TEST_DATABASE_URL (or CI's DATABASE_URL). It
// creates TEMP tables that shadow any real ones for this one connection
// (pool max 1) and writes nothing durable, so it is safe on a migrated DB.
// Synthetic names only; no provider is callable.
jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const timeline = require('../services/customer-activity-timeline');

const url = process.env.ACTIVITY_TIMELINE_TEST_DATABASE_URL || process.env.DATABASE_URL;
const pg = url ? describe : describe.skip;

const TEMP_TABLES = `
  CREATE TEMP TABLE customers (id uuid PRIMARY KEY, email text, last_seen_at timestamp, deleted_at timestamp);
  CREATE TEMP TABLE leads (id uuid PRIMARY KEY, customer_id uuid);
  CREATE TEMP TABLE sms_log (id uuid PRIMARY KEY, customer_id uuid, direction text, status text, message_type text, message_body text, created_at timestamp);
  CREATE TEMP TABLE short_codes (id uuid PRIMARY KEY, customer_id uuid, lead_id uuid, kind text, channel text, purpose text);
  CREATE TEMP TABLE short_code_clicks (id uuid PRIMARY KEY, short_code_id uuid, clicked_at timestamp, is_bot boolean NOT NULL DEFAULT false);
  CREATE TEMP TABLE email_messages (id uuid PRIMARY KEY, recipient_type text, recipient_id text, recipient_email_snapshot text, status text, template_key text, subject_snapshot text, queued_at timestamp, updated_at timestamp, sent_at timestamp, delivered_at timestamp, opened_at timestamp, clicked_at timestamp, bounced_at timestamp, complained_at timestamp);
  CREATE TEMP TABLE automation_templates (key text PRIMARY KEY, name text);
  CREATE TEMP TABLE automation_enrollments (id uuid PRIMARY KEY, template_key text, customer_id uuid);
  CREATE TEMP TABLE automation_step_sends (id uuid PRIMARY KEY, enrollment_id uuid, step_order int, status text, sent_at timestamp, delivered_at timestamp, opened_at timestamp, clicked_at timestamp, updated_at timestamp);
  CREATE TEMP TABLE newsletter_sends (id uuid PRIMARY KEY, subject text);
  CREATE TEMP TABLE newsletter_subscribers (id int PRIMARY KEY, customer_id uuid);
  CREATE TEMP TABLE newsletter_send_deliveries (id uuid PRIMARY KEY, send_id uuid, subscriber_id int, sent_at timestamp, delivered_at timestamp, opened_at timestamp, clicked_at timestamp, bounced_at timestamp, complained_at timestamp);
  CREATE TEMP TABLE customer_page_views (id uuid PRIMARY KEY, customer_id uuid, page text, viewed_at timestamptz);
  CREATE TEMP TABLE estimates (id uuid PRIMARY KEY, customer_id uuid, address text);
  CREATE TEMP TABLE estimate_views (id uuid PRIMARY KEY, estimate_id uuid, viewed_at timestamp);
  CREATE TEMP TABLE scheduled_services (id uuid PRIMARY KEY, customer_id uuid);
  CREATE TEMP TABLE projects (id uuid PRIMARY KEY, customer_id uuid, report_viewed_at timestamp, project_type text);
  CREATE TEMP TABLE prep_guide_views (id serial PRIMARY KEY, project_id uuid, scheduled_service_id uuid, viewed_at timestamp);
  CREATE TEMP TABLE service_records (id uuid PRIMARY KEY, customer_id uuid, report_viewed_at timestamp, service_type text);
  CREATE TEMP TABLE customer_contracts (id uuid PRIMARY KEY, customer_id uuid, viewed_at timestamp, title text);
  CREATE TEMP TABLE price_change_notices (id uuid PRIMARY KEY, customer_id uuid, first_viewed_at timestamp, view_count int);
  CREATE TEMP TABLE outbound_links (id uuid PRIMARY KEY, target_url text);
  CREATE TEMP TABLE outbound_link_clicks (id uuid PRIMARY KEY, outbound_link_id uuid, clicked_at timestamp, surface text, template_key text, customer_id uuid);
  CREATE TEMP TABLE call_log (id uuid PRIMARY KEY, customer_id uuid, created_at timestamp, direction text, status text, duration_seconds int, call_outcome text);
`;

// One instant per fixture row, minutes apart, so ordering is unambiguous.
const T = (minute) => new Date(Date.UTC(2026, 8, 20, 12, minute, 0));

pg('getCustomerActivity on Postgres', () => {
  let db;
  const cust = randomUUID();
  const other = randomUUID();
  const lead = randomUUID();

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: url, pool: { min: 1, max: 1 } });
    await db.raw(TEMP_TABLES);
    timeline.resetGuardCacheForTests();

    await db('customers').insert([
      { id: cust, email: 'Synthetic.Person@example.test', last_seen_at: T(59) },
      { id: other, email: 'other@example.test', last_seen_at: null },
    ]);
    await db('leads').insert({ id: lead, customer_id: cust });

    // texts: outbound sent/delivered/failed + an inbound reply; another customer's row
    await db('sms_log').insert([
      { id: randomUUID(), customer_id: cust, direction: 'outbound', status: 'delivered', message_type: 'reminder', message_body: 'Reminder   for\nyour visit', created_at: T(1) },
      { id: randomUUID(), customer_id: cust, direction: 'outbound', status: 'failed', message_type: 'billing', message_body: 'x'.repeat(400), created_at: T(2) },
      { id: randomUUID(), customer_id: cust, direction: 'inbound', status: 'received', message_type: null, message_body: 'Sounds good, thanks', created_at: T(3) },
      { id: randomUUID(), customer_id: other, direction: 'inbound', status: 'received', message_type: null, message_body: 'not mine', created_at: T(90) },
    ]);

    // link clicks: one by customer, one by the customer's lead, one bot (excluded)
    const scA = randomUUID(); const scB = randomUUID();
    await db('short_codes').insert([
      { id: scA, customer_id: cust, kind: 'invoice', channel: 'sms', purpose: 'invoice_send' },
      { id: scB, customer_id: null, lead_id: lead, kind: 'estimate', channel: 'email', purpose: 'estimate_send' },
    ]);
    await db('short_code_clicks').insert([
      { id: randomUUID(), short_code_id: scA, clicked_at: T(10), is_bot: false },
      { id: randomUUID(), short_code_id: scB, clicked_at: T(11), is_bot: false },
      { id: randomUUID(), short_code_id: scA, clicked_at: T(95), is_bot: true },
    ]);

    // emails: linked by recipient id; linked by address only; admin + test rows excluded
    await db('email_messages').insert([
      { id: randomUUID(), recipient_type: 'customer', recipient_id: cust, recipient_email_snapshot: 'synthetic.person@example.test', status: 'clicked', subject_snapshot: 'Your estimate', queued_at: T(19), sent_at: T(20), delivered_at: T(21), opened_at: T(22), clicked_at: T(23) },
      { id: randomUUID(), recipient_type: null, recipient_id: null, recipient_email_snapshot: 'Synthetic.Person@example.test', status: 'bounced', subject_snapshot: 'By address only', sent_at: T(24), bounced_at: T(25) },
      { id: randomUUID(), recipient_type: 'admin', recipient_id: null, recipient_email_snapshot: 'Synthetic.Person@example.test', status: 'sent', subject_snapshot: 'admin copy', sent_at: T(96) },
      { id: randomUUID(), recipient_type: 'test', recipient_id: null, recipient_email_snapshot: 'synthetic.person@example.test', status: 'sent', subject_snapshot: 'test send', sent_at: T(97) },
      { id: randomUUID(), recipient_type: 'customer', recipient_id: other, recipient_email_snapshot: 'other@example.test', status: 'sent', subject_snapshot: 'not mine', sent_at: T(98) },
      // shared address, but explicitly owned by another customer row
      { id: randomUUID(), recipient_type: 'customer', recipient_id: other, recipient_email_snapshot: 'synthetic.person@example.test', status: 'sent', subject_snapshot: 'shared address, other owner', sent_at: T(99) },
      // owned by a non-customer kind of recipient: an address match must NOT pull these in
      { id: randomUUID(), recipient_type: 'job_application', recipient_id: randomUUID(), recipient_email_snapshot: 'synthetic.person@example.test', status: 'clicked', subject_snapshot: 'recruiting mail', sent_at: T(92), clicked_at: T(93) },
      { id: randomUUID(), recipient_type: 'payer', recipient_id: randomUUID(), recipient_email_snapshot: 'synthetic.person@example.test', status: 'sent', subject_snapshot: 'payer statement', sent_at: T(94) },
      { id: randomUUID(), recipient_type: 'referral_promoter', recipient_id: randomUUID(), recipient_email_snapshot: 'synthetic.person@example.test', status: 'sent', subject_snapshot: 'promoter mail', sent_at: T(89) },
      // customer precursor (a lead with the same address) rides the address match
      { id: randomUUID(), recipient_type: 'lead', recipient_id: lead, recipient_email_snapshot: 'synthetic.person@example.test', status: 'sent', subject_snapshot: 'lead-era quote', sent_at: T(5) },
      // failed: dated at the failure transition (updated_at), after its queue time
      { id: randomUUID(), recipient_type: 'customer', recipient_id: cust, recipient_email_snapshot: 'synthetic.person@example.test', status: 'failed', subject_snapshot: 'Failed send', queued_at: T(26), updated_at: T(28) },
    ]);

    // automation + newsletter (opens only, later than every engaged event)
    const enr = randomUUID();
    await db('automation_templates').insert({ key: 'welcome', name: 'Welcome series' });
    await db('automation_enrollments').insert({ id: enr, template_key: 'welcome', customer_id: cust });
    await db('automation_step_sends').insert([
      { id: randomUUID(), enrollment_id: enr, step_order: 0, status: 'sent', sent_at: T(30), delivered_at: T(31), opened_at: T(32) },
      { id: randomUUID(), enrollment_id: enr, step_order: 1, status: 'bounced', sent_at: T(35), updated_at: T(36) },
      { id: randomUUID(), enrollment_id: enr, step_order: 2, status: 'complained', sent_at: T(37), updated_at: T(38) },
    ]);
    const send = randomUUID();
    await db('newsletter_sends').insert({ id: send, subject: 'September news' });
    await db('newsletter_subscribers').insert({ id: 7, customer_id: cust });
    await db('newsletter_send_deliveries').insert({ id: randomUUID(), send_id: send, subscriber_id: 7, sent_at: T(33), delivered_at: T(34), opened_at: T(70) });

    // page-type views
    const est = randomUUID(); const visit = randomUUID(); const proj = randomUUID();
    await db('customer_page_views').insert([
      { id: randomUUID(), customer_id: cust, page: 'appointment', viewed_at: T(40) },
      { id: randomUUID(), customer_id: cust, page: 'portal:home', viewed_at: T(41) },
      { id: randomUUID(), customer_id: other, page: 'track', viewed_at: T(91) },
    ]);
    await db('estimates').insert({ id: est, customer_id: cust, address: '1 Synthetic Way' });
    await db('estimate_views').insert({ id: randomUUID(), estimate_id: est, viewed_at: T(42) });
    await db('scheduled_services').insert({ id: visit, customer_id: cust });
    await db('projects').insert({ id: proj, customer_id: cust, report_viewed_at: T(46), project_type: 'wdo_inspection' });
    await db('prep_guide_views').insert([{ project_id: null, scheduled_service_id: visit, viewed_at: T(43) }, { project_id: proj, scheduled_service_id: null, viewed_at: T(44) }]);
    await db('service_records').insert({ id: randomUUID(), customer_id: cust, report_viewed_at: T(45), service_type: 'Quarterly pest control' });
    await db('customer_contracts').insert({ id: randomUUID(), customer_id: cust, viewed_at: T(47), title: 'Service agreement' });
    await db('price_change_notices').insert({ id: randomUUID(), customer_id: cust, first_viewed_at: T(48), view_count: 3 });

    // outside link click + a call
    const ol = randomUUID();
    await db('outbound_links').insert({ id: ol, target_url: 'https://www.chewy.com/some/path?tag=1' });
    await db('outbound_link_clicks').insert({ id: randomUUID(), outbound_link_id: ol, clicked_at: T(49), surface: 'page', template_key: 'prep.flea', customer_id: cust });
    await db('call_log').insert({ id: randomUUID(), customer_id: cust, created_at: T(50), direction: 'inbound', status: 'completed', duration_seconds: 125, call_outcome: 'info_given' });
  });

  afterAll(async () => { if (db) await db.destroy(); });

  const run = (opts) => timeline.getCustomerActivity(cust, opts, db);

  test('merges every source newest-first and keeps other customers, bots, admin and test mail out', async () => {
    const r = await run({ limit: 200 });
    const times = r.events.map((e) => e.at);
    expect(times).toEqual([...times].sort().reverse());
    const titles = r.events.map((e) => e.title);
    expect(titles).toEqual(expect.arrayContaining([
      'Text delivered (reminder)', 'Text failed (billing)', 'Replied by text',
      'Clicked the invoice link', 'Clicked the estimate link',
      'Email sent', 'Clicked a link in an email', 'Email bounced',
      'Opened the appointment page', 'Opened the portal', 'Opened their estimate', 'Opened the prep guide',
      'Opened their service report', 'Opened their inspection report', 'Opened a contract',
      'Opened the price-change notice', 'Clicked an outside link in the prep guide', 'Called us', 'Last seen in the portal',
    ]));
    expect(r.events.some((e) => /not mine|admin copy|test send|other owner|recruiting|payer statement|promoter mail/.test(`${e.title} ${e.detail}`))).toBe(false);
    // 2 clicks only: the bot click is filtered
    expect(r.events.filter((e) => e.source === 'link')).toHaveLength(2);
    // the lead-linked click carries the email channel
    expect(r.events.find((e) => e.title === 'Clicked the estimate link').channel).toBe('email');
    // outside-link detail is the host only (never the path or query)
    expect(r.events.find((e) => e.source === 'outlink').detail).toBe('chewy.com');
    // text previews are one flat, capped line
    const failed = r.events.find((e) => e.title === 'Text failed (billing)');
    expect(failed.detail.length).toBeLessThanOrEqual(140);
    expect(r.events.find((e) => e.title === 'Text delivered (reminder)').detail).toBe('Reminder for your visit');
    expect(r.unavailableSources).toEqual([]);
  });

  test('address fallback: unowned and lead mail is included; job_application, payer and promoter mail is not', async () => {
    const r = await run({ limit: 200 });
    const subjects = r.events.filter((e) => e.source === 'email').map((e) => e.detail);
    expect(subjects).toEqual(expect.arrayContaining(['By address only', 'lead-era quote', 'Your estimate']));
    expect(subjects).not.toContain('recruiting mail');
    // and the recruiting click never became engagement
    expect(r.events.some((e) => e.detail === 'recruiting mail')).toBe(false);
    expect(r.summary.lastEngagedAt).toBe(T(59).toISOString());
  });

  test('a failed email is dated at its failure time, after the queue time; automation bounces and complaints show', async () => {
    const r = await run({ limit: 200 });
    const failed = r.events.find((e) => e.source === 'email' && e.kind === 'failed');
    expect(failed.at).toBe(T(28).toISOString());
    expect(r.events.find((e) => e.source === 'automation' && e.kind === 'bounced').at).toBe(T(36).toISOString());
    expect(r.events.find((e) => e.source === 'automation' && e.kind === 'complained').at).toBe(T(38).toISOString());
    expect(r.events.filter((e) => e.source === 'automation' && ['bounced', 'complained'].includes(e.kind)).every((e) => e.engaged === false)).toBe(true);
  });

  test('an archived customer is not found', async () => {
    const gone = randomUUID();
    await db('customers').insert({ id: gone, email: 'gone@example.test', deleted_at: T(1) });
    expect(await timeline.getCustomerActivity(gone, {}, db)).toBeNull();
  });

  test('exactly `limit` events in the only source does not advertise a next page', async () => {
    const solo = randomUUID();
    await db('customers').insert({ id: solo, email: 'solo@example.test' });
    await db('sms_log').insert([1, 2, 3].map((i) => ({ id: randomUUID(), customer_id: solo, direction: 'outbound', status: 'sent', message_type: null, message_body: `t${i}`, created_at: T(i) })));
    const exact = await timeline.getCustomerActivity(solo, { limit: 3 }, db);
    expect(exact.events).toHaveLength(3);
    expect(exact.hasMore).toBe(false);
    expect(exact.nextCursor).toBeNull();
    const short = await timeline.getCustomerActivity(solo, { limit: 2 }, db);
    expect(short.hasMore).toBe(true);
    expect(short.nextCursor).toBe(short.events[1].at);
  });

  test('engagement: clicks, views, replies and portal visits count; opens and calls do not', async () => {
    const r = await run({ limit: 200 });
    const byKind = (kind) => r.events.filter((e) => e.kind === kind);
    expect(byKind('opened').length).toBeGreaterThan(0);
    expect(byKind('opened').every((e) => e.engaged === false)).toBe(true);
    expect(r.events.filter((e) => e.source === 'call').every((e) => e.engaged === false)).toBe(true);
    for (const kind of ['clicked', 'viewed', 'replied']) expect(byKind(kind).every((e) => e.engaged)).toBe(true);

    // Newsletter open at T(70) is the newest thing of all but must not be "engaged".
    expect(r.summary.lastEmailOpenAt).toBe(T(70).toISOString());
    expect(r.summary.lastEngagedAt).toBe(T(59).toISOString()); // the portal visit, not the later open
    expect(r.summary.lastEngagedFrom).toBe('portal visits');
    expect(r.summary.lastEmailOpenNote).toMatch(/unreliable/i);
    // the summary agrees with the events flagged engaged
    const newestEngaged = r.events.filter((e) => e.engaged).map((e) => e.at).sort().pop();
    expect(newestEngaged).toBe(r.summary.lastEngagedAt);
  });

  test('summary reads the whole history, not just the visible page', async () => {
    const r = await run({ limit: 1 });
    expect(r.events).toHaveLength(1);
    expect(r.summary.lastEngagedAt).toBe(T(59).toISOString());
  });

  test('cursor pages concatenate to the full list with no gaps or repeats', async () => {
    const full = (await run({ limit: 200 })).events;
    const seen = [];
    let cursor = null; let pages = 0;
    do {
      const page = await run({ limit: 4, before: cursor });
      seen.push(...page.events);
      cursor = page.nextCursor;
      pages += 1;
      if (page.nextCursor) expect(page.hasMore).toBe(true); else expect(page.hasMore).toBe(false);
      // later pages carry no summary
      if (pages > 1) expect(page.summary).toBeNull();
    } while (cursor && pages < 50);
    expect(seen.map((e) => e.id)).toEqual(full.map((e) => e.id));
  });

  test('a missing optional column reports the source absent and still returns the rest', async () => {
    await db.raw('ALTER TABLE customers DROP COLUMN last_seen_at');
    timeline.resetGuardCacheForTests();
    const r = await run({ limit: 200 });
    expect(r.absentSources).toContain('portal visits');
    expect(r.events.some((e) => e.channel === 'portal' && e.title === 'Last seen in the portal')).toBe(false);
    expect(r.summary.lastEngagedAt).toBe(T(49).toISOString()); // outside-link click is now newest engaged
    await db.raw('ALTER TABLE customers ADD COLUMN last_seen_at timestamp');
    timeline.resetGuardCacheForTests();
  });

  test('unknown customer returns null; a bad cursor is a 400', async () => {
    expect(await timeline.getCustomerActivity(randomUUID(), {}, db)).toBeNull();
    await expect(run({ before: 'not-a-date' })).rejects.toMatchObject({ status: 400 });
  });
});
