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
  CREATE TEMP TABLE customers (id uuid PRIMARY KEY, email text, deleted_at timestamp);
  CREATE TEMP TABLE leads (id uuid PRIMARY KEY, customer_id uuid);
  CREATE TEMP TABLE sms_log (id uuid PRIMARY KEY, customer_id uuid, direction text, status text, message_type text, message_body text, created_at timestamp, from_phone text, metadata jsonb, twilio_sid text);
  CREATE TEMP TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), twilio_sid text, delivery_status text, updated_at timestamp);
  CREATE TEMP TABLE short_codes (id uuid PRIMARY KEY, customer_id uuid, lead_id uuid, kind text, channel text, purpose text, entity_type text, entity_id uuid);
  CREATE TEMP TABLE invoices (id uuid PRIMARY KEY, payer_id int);
  CREATE TEMP TABLE short_code_clicks (id uuid PRIMARY KEY, short_code_id uuid, clicked_at timestamp, is_bot boolean NOT NULL DEFAULT false);
  CREATE TEMP TABLE email_messages (id uuid PRIMARY KEY, recipient_type text, recipient_id text, recipient_email_snapshot text, status text, template_key text, subject_snapshot text, queued_at timestamp, updated_at timestamp, sent_at timestamp, delivered_at timestamp, opened_at timestamp, clicked_at timestamp, bounced_at timestamp, complained_at timestamp, lead_id uuid, estimate_id uuid);
  CREATE TEMP TABLE automation_templates (key text PRIMARY KEY, name text);
  CREATE TEMP TABLE automation_enrollments (id uuid PRIMARY KEY, template_key text, customer_id uuid);
  CREATE TEMP TABLE automation_step_sends (id uuid PRIMARY KEY, enrollment_id uuid, step_order int, status text, email text, sent_at timestamp, delivered_at timestamp, opened_at timestamp, clicked_at timestamp, updated_at timestamp);
  CREATE TEMP TABLE newsletter_sends (id uuid PRIMARY KEY, subject text);
  CREATE TEMP TABLE newsletter_subscribers (id int PRIMARY KEY, customer_id uuid, email text);
  CREATE TEMP TABLE newsletter_send_deliveries (id uuid PRIMARY KEY, send_id uuid, subscriber_id int, email text, sent_at timestamp, delivered_at timestamp, opened_at timestamp, clicked_at timestamp, bounced_at timestamp, complained_at timestamp);
  CREATE TEMP TABLE customer_page_views (id uuid PRIMARY KEY, customer_id uuid, page text, viewed_at timestamptz);
  CREATE TEMP TABLE estimates (id uuid PRIMARY KEY, customer_id uuid, address text);
  CREATE TEMP TABLE estimate_views (id uuid PRIMARY KEY, estimate_id uuid, viewed_at timestamp);
  CREATE TEMP TABLE scheduled_services (id uuid PRIMARY KEY, customer_id uuid);
  CREATE TEMP TABLE projects (id uuid PRIMARY KEY, customer_id uuid, report_viewed_at timestamp, project_type text);
  CREATE TEMP TABLE prep_guide_views (id serial PRIMARY KEY, project_id uuid, scheduled_service_id uuid, viewed_at timestamp);
  CREATE TEMP TABLE service_records (id uuid PRIMARY KEY, customer_id uuid, report_viewed_at timestamp, service_type text);
  CREATE TEMP TABLE customer_contracts (id uuid PRIMARY KEY, customer_id uuid, viewed_at timestamp, title text);
  CREATE TEMP TABLE price_change_notices (id uuid PRIMARY KEY, customer_id uuid, first_viewed_at timestamp, view_count int);
`;
const CALL_LOG_DDL = 'CREATE TEMP TABLE call_log (id uuid PRIMARY KEY, customer_id uuid, created_at timestamp, direction text, status text, duration_seconds int, call_outcome text)';

// One instant per fixture row, minutes apart, so ordering is unambiguous.
const T = (minute, second = 0) => new Date(Date.UTC(2026, 8, 20, 12, minute, second));

pg('getCustomerActivity on Postgres', () => {
  let db;
  const cust = randomUUID();
  const other = randomUUID();
  const lead = randomUUID();

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: url, pool: { min: 1, max: 1 } });
    await db.raw(TEMP_TABLES);
    await db.raw(CALL_LOG_DDL);

    await db('customers').insert([
      { id: cust, email: 'Synthetic.Person@example.test' },
      { id: other, email: 'other@example.test' },
    ]);
    await db('leads').insert({ id: lead, customer_id: cust });

    // texts: outbound sent/delivered/failed + an inbound reply; another customer's row
    await db('sms_log').insert([
      { id: randomUUID(), customer_id: cust, direction: 'outbound', status: 'delivered', message_type: 'reminder', message_body: 'Reminder   for\nyour visit', created_at: T(1) },
      { id: randomUUID(), customer_id: cust, direction: 'outbound', status: 'read', message_type: 'reminder', message_body: 'Read receipt text', created_at: T(7) },
      { id: randomUUID(), customer_id: cust, direction: 'outbound', status: 'failed', message_type: 'billing', message_body: 'x'.repeat(400), created_at: T(2) },
      { id: randomUUID(), customer_id: cust, direction: 'inbound', status: 'received', message_type: null, message_body: 'Sounds good, thanks', created_at: T(3) },
      { id: randomUUID(), customer_id: other, direction: 'inbound', status: 'received', message_type: null, message_body: 'not mine', created_at: T(90) },
      // queued for later / cancelled / held: never left, so never listed
      { id: randomUUID(), customer_id: cust, direction: 'outbound', status: 'scheduled', message_type: 'reminder', message_body: 'scheduled reminder', created_at: T(80) },
      { id: randomUUID(), customer_id: cust, direction: 'outbound', status: 'sending', message_type: 'reminder', message_body: 'sending reminder', created_at: T(81) },
      { id: randomUUID(), customer_id: cust, direction: 'outbound', status: 'canceled', message_type: 'reminder', message_body: 'canceled reminder', created_at: T(82) },
      { id: randomUUID(), customer_id: cust, direction: 'outbound', status: 'cancelled', message_type: 'reminder', message_body: 'cancelled reminder', created_at: T(83) },
      // recruiting texts on a shared customer id are owner-only: never customer history or engagement
      { id: randomUUID(), customer_id: cust, direction: 'inbound', status: 'received', message_type: 'job_applicant_reply', message_body: 'applicant reply', created_at: T(85) },
      { id: randomUUID(), customer_id: cust, direction: 'outbound', status: 'sent', message_type: 'job_interview_invite', message_body: 'applicant invite', created_at: T(86) },
      // push proof: an app notification a device accepted, not a text
      { id: randomUUID(), customer_id: cust, direction: 'outbound', status: 'sent', message_type: 'appointment_reminder', message_body: 'Tomorrow at 9', created_at: T(6), from_phone: 'push', metadata: JSON.stringify({ channel: 'push' }) },
    ]);

    // link clicks: one by customer, one by the customer's lead, one bot (excluded)
    const scA = randomUUID(); const scB = randomUUID(); const scC = randomUUID();
    await db('short_codes').insert([
      { id: scA, customer_id: cust, kind: 'invoice', channel: 'sms', purpose: 'invoice_send' },
      { id: scB, customer_id: null, lead_id: lead, kind: 'estimate', channel: 'email', purpose: 'estimate_send' },
      { id: scC, customer_id: other, kind: 'invoice', channel: 'sms', purpose: 'invoice_send' },
    ]);
    await db('short_code_clicks').insert([
      { id: randomUUID(), short_code_id: scA, clicked_at: T(10), is_bot: false },
      { id: randomUUID(), short_code_id: scB, clicked_at: T(11), is_bot: false },
      { id: randomUUID(), short_code_id: scA, clicked_at: T(95), is_bot: true },
      // the same tap as the provider click at T(23): 90 seconds after it, so that click is not listed again
      { id: randomUUID(), short_code_id: scA, clicked_at: T(23, 90), is_bot: false },
      // 30 seconds after the provider click at T(52), but a bot click and another customer's click: neither collapses it
      { id: randomUUID(), short_code_id: scA, clicked_at: T(52, 30), is_bot: true },
      { id: randomUUID(), short_code_id: scC, clicked_at: T(52, 30), is_bot: false },
      // three minutes after it: outside the two-minute window
      { id: randomUUID(), short_code_id: scA, clicked_at: T(55), is_bot: false },
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
      // provider click with no human short-link click within two minutes: stays listed, never engaged
      { id: randomUUID(), recipient_type: 'customer', recipient_id: cust, recipient_email_snapshot: 'synthetic.person@example.test', status: 'clicked', subject_snapshot: 'Unmatched click', sent_at: T(51), clicked_at: T(52) },
      // owned by the customer but addressed to a payer's AP inbox: shown with the masked address, never engaged
      { id: randomUUID(), recipient_type: 'customer', recipient_id: cust, recipient_email_snapshot: 'Accounts.Payable@example.test', status: 'clicked', subject_snapshot: 'Invoice statement', sent_at: T(59), clicked_at: T(60) },
      // failed: dated at the failure transition (updated_at), after its queue time
      { id: randomUUID(), recipient_type: 'customer', recipient_id: cust, recipient_email_snapshot: 'synthetic.person@example.test', status: 'failed', subject_snapshot: 'Failed send', queued_at: T(26), updated_at: T(28) },
    ]);

    // automation + newsletter (opens only, later than every engaged event)
    const enr = randomUUID();
    await db('automation_templates').insert({ key: 'welcome', name: 'Welcome series' });
    await db('automation_enrollments').insert({ id: enr, template_key: 'welcome', customer_id: cust });
    await db('automation_step_sends').insert([
      { id: randomUUID(), enrollment_id: enr, step_order: 0, status: 'sent', email: ' SYNTHETIC.PERSON@example.test ', sent_at: T(30), delivered_at: T(31), opened_at: T(32) },
      { id: randomUUID(), enrollment_id: enr, step_order: 1, status: 'bounced', email: 'synthetic.person@example.test', sent_at: T(35), updated_at: T(36) },
      { id: randomUUID(), enrollment_id: enr, step_order: 2, status: 'complained', email: 'synthetic.person@example.test', sent_at: T(37), updated_at: T(38) },
    ]);
    // payment_failed redirected to a billing contact: someone else's inbox, so its
    // opens and clicks (the newest events of all) are not the customer's
    const enrBill = randomUUID();
    await db('automation_enrollments').insert({ id: enrBill, template_key: 'welcome', customer_id: cust });
    await db('automation_step_sends').insert({ id: randomUUID(), enrollment_id: enrBill, step_order: 0, status: 'clicked', email: 'accounts.payable@example.test', sent_at: T(87), delivered_at: T(88), opened_at: T(89), clicked_at: T(91) });
    const send = randomUUID();
    await db('newsletter_sends').insert({ id: send, subject: 'September news' });
    // the subscriber's CURRENT address differs from the one this issue was delivered to (email change since)
    await db('newsletter_subscribers').insert({ id: 7, customer_id: cust, email: 'new.inbox@example.test' });
    await db('newsletter_send_deliveries').insert({ id: randomUUID(), send_id: send, subscriber_id: 7, email: 'Subscriber.Address@example.test', sent_at: T(33), delivered_at: T(34), opened_at: T(70) });

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
    await db('prep_guide_views').insert([
      { project_id: null, scheduled_service_id: visit, viewed_at: T(43) },
      { project_id: proj, scheduled_service_id: null, viewed_at: T(44) },
    ]);
    await db('service_records').insert({ id: randomUUID(), customer_id: cust, report_viewed_at: T(45), service_type: 'Quarterly pest control' });
    await db('customer_contracts').insert({ id: randomUUID(), customer_id: cust, viewed_at: T(47), title: 'Service agreement' });
    await db('price_change_notices').insert({ id: randomUUID(), customer_id: cust, first_viewed_at: T(48), view_count: 3 });

    // a call
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
      'Email sent', 'Link clicked (reported by email provider — may be a scanner)', 'Email bounced',
      'Opened the appointment page', 'Opened the portal', 'Viewed their estimate (unfiltered)', 'Viewed the prep guide (unfiltered)',
      'Viewed their service report (unfiltered)', 'Viewed their inspection report (unfiltered)', 'Viewed a contract (unfiltered)',
      'Viewed the price-change notice (unfiltered)', 'Called us',
    ]));
    expect(r.events.some((e) => /not mine|admin copy|test send|other owner|recruiting|payer statement|promoter mail|scheduled reminder|sending reminder|canceled reminder|cancelled reminder/.test(`${e.title} ${e.detail}`))).toBe(false);
    // 4 human clicks: the bot click and another customer's click are filtered
    expect(r.events.filter((e) => e.source === 'link')).toHaveLength(4);
    // the lead-linked click carries the email channel
    expect(r.events.find((e) => e.title === 'Clicked the estimate link').channel).toBe('email');
    // text previews are one flat, capped line
    const failed = r.events.find((e) => e.title === 'Text failed (billing)');
    expect(failed.detail.length).toBeLessThanOrEqual(140);
    expect(r.events.find((e) => e.title === 'Text delivered (reminder)').detail).toBe('Reminder for your visit');
    expect(r.unavailableSources).toEqual([]);
    // no outside-link or portal-visit source in this PR
    expect(r.events.some((e) => e.source === 'outlink' || e.source === 'portal')).toBe(false);
  });

  test('a read text is a delivered text with a read-receipt title, and it paginates like any other', async () => {
    const r = await run({ limit: 200 });
    expect(r.events.find((e) => e.detail === 'Read receipt text')).toMatchObject({
      kind: 'delivered', engaged: false, channel: 'sms', title: 'Text delivered (read receipt) (reminder)', at: T(7).toISOString(),
    });
    // exact pagination: the read text is the top of a one-row page when it is the newest text
    const solo = randomUUID();
    await db('customers').insert({ id: solo, email: 'reader@example.test' });
    await db('sms_log').insert([
      { id: randomUUID(), customer_id: solo, direction: 'outbound', status: 'sent', message_type: null, message_body: 'first', created_at: T(1) },
      { id: randomUUID(), customer_id: solo, direction: 'outbound', status: 'read', message_type: null, message_body: 'second', created_at: T(2) },
    ]);
    const page = await timeline.getCustomerActivity(solo, { limit: 1 }, db);
    expect(page.events.map((e) => e.title)).toEqual(['Text delivered (read receipt)']);
    expect(page.hasMore).toBe(true);
    const next = await timeline.getCustomerActivity(solo, { limit: 1, before: page.nextCursor }, db);
    expect(next.events.map((e) => e.title)).toEqual(['Text sent']);
  });

  test('address fallback: unowned and lead mail is included; job_application, payer and promoter mail is not', async () => {
    const r = await run({ limit: 200 });
    const subjects = r.events.filter((e) => e.source === 'email').map((e) => e.detail.split(' · ')[0]);
    expect(subjects).toEqual(expect.arrayContaining(['By address only', 'lead-era quote', 'Your estimate']));
    expect(subjects).not.toContain('recruiting mail');
    expect(r.events.some((e) => /recruiting mail/.test(e.detail || ''))).toBe(false);
  });

  test('lead-typed mail is owned by recipient_id: kept after an email change, and never pulled in by a shared inbox', async () => {
    const owner = randomUUID(); const owner2 = randomUUID(); const ownLead = randomUUID(); const strangerLead = randomUUID();
    await db('customers').insert([{ id: owner, email: 'changed.address@example.test' }, { id: owner2, email: 'shared.inbox@example.test' }]);
    await db('leads').insert([{ id: ownLead, customer_id: owner }, { id: strangerLead, customer_id: null }]);
    await db('email_messages').insert([
      // estimate events keep type 'lead' while recipient_id is the CUSTOMER id; old address no longer on the customer
      { id: randomUUID(), recipient_type: 'lead', recipient_id: owner, recipient_email_snapshot: 'old.address@example.test', status: 'sent', subject_snapshot: 'lead-typed, customer id', sent_at: T(1) },
      // lead linked to this customer, old address
      { id: randomUUID(), recipient_type: 'lead', recipient_id: ownLead, recipient_email_snapshot: 'old.address@example.test', status: 'sent', subject_snapshot: 'lead-typed, linked lead', sent_at: T(2) },
      // another prospect (unlinked lead) sharing the customer's current inbox
      { id: randomUUID(), recipient_type: 'lead', recipient_id: strangerLead, recipient_email_snapshot: 'changed.address@example.test', status: 'sent', subject_snapshot: 'other lead, same inbox', sent_at: T(3) },
      // lead-typed row naming a different customer's id on the same inbox
      { id: randomUUID(), recipient_type: 'lead', recipient_id: owner2, recipient_email_snapshot: 'changed.address@example.test', status: 'sent', subject_snapshot: 'other customer id, same inbox', sent_at: T(4) },
      // truly unowned lead-typed row (no recipient_id): the address still matches
      { id: randomUUID(), recipient_type: 'lead', recipient_id: null, recipient_email_snapshot: 'changed.address@example.test', status: 'sent', subject_snapshot: 'unowned lead mail', sent_at: T(5) },
    ]);
    const r = await timeline.getCustomerActivity(owner, { limit: 50 }, db);
    const subjects = r.events.filter((e) => e.source === 'email').map((e) => e.detail.split(' · ')[0]).sort();
    expect(subjects).toEqual(['lead-typed, customer id', 'lead-typed, linked lead', 'unowned lead mail']);
  });

  describe('GATE_LEAD_EMAIL_LINKS: mail sent to the customer\'s lead / estimate before they converted', () => {
    const saved = process.env.GATE_LEAD_EMAIL_LINKS;
    afterEach(() => { if (saved === undefined) delete process.env.GATE_LEAD_EMAIL_LINKS; else process.env.GATE_LEAD_EMAIL_LINKS = saved; });

    async function seed() {
      const conv = randomUUID(); const stranger = randomUUID();
      const convLead = randomUUID(); const otherLead = randomUUID();
      const convEst = randomUUID(); const otherEst = randomUUID();
      await db('customers').insert([{ id: conv, email: 'new.address@example.test' }, { id: stranger, email: 'stranger@example.test' }]);
      await db('leads').insert([{ id: convLead, customer_id: conv }, { id: otherLead, customer_id: null }]);
      await db('estimates').insert([{ id: convEst, customer_id: conv }, { id: otherEst, customer_id: null }]);
      await db('email_messages').insert([
        // sent to the prospect under an address the customer no longer uses; only the link ties it to them
        { id: randomUUID(), recipient_type: 'lead', recipient_id: null, recipient_email_snapshot: 'prospect.old@example.test', status: 'sent', subject_snapshot: 'linked by lead', sent_at: T(1), lead_id: convLead },
        { id: randomUUID(), recipient_type: 'lead', recipient_id: null, recipient_email_snapshot: 'prospect.old@example.test', status: 'sent', subject_snapshot: 'linked by estimate', sent_at: T(2), estimate_id: convEst },
        // linked to somebody else's lead / estimate
        { id: randomUUID(), recipient_type: 'lead', recipient_id: null, recipient_email_snapshot: 'prospect.old@example.test', status: 'sent', subject_snapshot: 'other prospect lead', sent_at: T(3), lead_id: otherLead },
        { id: randomUUID(), recipient_type: 'lead', recipient_id: null, recipient_email_snapshot: 'prospect.old@example.test', status: 'sent', subject_snapshot: 'other prospect estimate', sent_at: T(4), estimate_id: otherEst },
        // the estimate is theirs, but the row names another customer: ownership by id wins
        { id: randomUUID(), recipient_type: 'lead', recipient_id: stranger, recipient_email_snapshot: 'stranger@example.test', status: 'sent', subject_snapshot: 'names another customer', sent_at: T(5), estimate_id: convEst },
        // customer-typed rows are owned by recipient_id, never by a link
        { id: randomUUID(), recipient_type: 'customer', recipient_id: stranger, recipient_email_snapshot: 'stranger@example.test', status: 'sent', subject_snapshot: 'customer-typed, other customer', sent_at: T(6), estimate_id: convEst },
        // test / admin mail never rides a link
        { id: randomUUID(), recipient_type: 'test', recipient_id: null, recipient_email_snapshot: 'x@example.test', status: 'sent', subject_snapshot: 'test mail', sent_at: T(7), lead_id: convLead },
      ]);
      return conv;
    }
    const subjectsOf = async (id) => (await timeline.getCustomerActivity(id, { limit: 50 }, db))
      .events.filter((e) => e.source === 'email').map((e) => e.detail.split(' · ')[0]).sort();

    test('dark (default): the timeline lists exactly what it did before', async () => {
      delete process.env.GATE_LEAD_EMAIL_LINKS;
      const conv = await seed();
      expect(await subjectsOf(conv)).toEqual([]);
    });

    test('on: mail linked to their lead or estimate appears; other people\'s mail and owned rows do not', async () => {
      process.env.GATE_LEAD_EMAIL_LINKS = 'true';
      const conv = await seed();
      expect(await subjectsOf(conv)).toEqual(['linked by estimate', 'linked by lead']);
    });

    test('on: the feed and the summary agree (summary is built from the same predicate)', async () => {
      process.env.GATE_LEAD_EMAIL_LINKS = 'true';
      const conv = await seed();
      const r = await timeline.getCustomerActivity(conv, { limit: 50 }, db);
      expect(r.unavailableSources).toEqual([]);
      expect(r.events.filter((e) => e.kind === 'sent')).toHaveLength(2);
    });
  });

  test('a failed email is dated at its failure time, after the queue time; automation bounces and complaints show', async () => {
    const r = await run({ limit: 200 });
    const failed = r.events.find((e) => e.source === 'email' && e.kind === 'failed');
    expect(failed.at).toBe(T(28).toISOString());
    expect(r.events.find((e) => e.source === 'automation' && e.kind === 'bounced').at).toBe(T(36).toISOString());
    expect(r.events.find((e) => e.source === 'automation' && e.kind === 'complained').at).toBe(T(38).toISOString());
    expect(r.events.filter((e) => e.source === 'automation' && ['bounced', 'complained'].includes(e.kind)).every((e) => e.engaged === false)).toBe(true);
  });

  test('recruiting texts on the customer id are hidden from the feed and the summary', async () => {
    const r = await run({ limit: 200 });
    expect(r.events.some((e) => /applicant/.test(e.detail || ''))).toBe(false);
    const solo = randomUUID();
    await db('customers').insert({ id: solo, email: 'recruit.only@example.test' });
    await db('sms_log').insert({ id: randomUUID(), customer_id: solo, direction: 'inbound', status: 'received', message_type: 'job_applicant_reply', message_body: 'hi', created_at: T(3) });
    const only = await timeline.getCustomerActivity(solo, {}, db);
    expect(only.events).toEqual([]);
    expect(only.summary.lastEngagedAt).toBeNull();
  });

  test('a push-proof row is an app notification, not a text, and is not engagement', async () => {
    const r = await run({ limit: 200 });
    const push = r.events.find((e) => e.channel === 'push');
    expect(push).toMatchObject({ kind: 'delivered', engaged: false, title: 'App notification delivered (appointment reminder)', at: T(6).toISOString() });
    expect(r.events.some((e) => e.channel === 'sms' && e.detail === 'Tomorrow at 9')).toBe(false);
  });

  test('every email event names the recorded recipient, masked; nothing is classified as the customer\'s own or not', async () => {
    const r = await run({ limit: 200 });
    const to = (source, pick) => r.events.filter((e) => e.source === source && pick(e)).map((e) => e.detail);
    expect(to('email', (e) => e.kind === 'sent' && /^Your estimate/.test(e.detail))).toEqual(['Your estimate · to s***@example.test']);
    // the payer / AP inbox is visible as such (masked), and its click is informational only
    expect(to('email', (e) => /Invoice statement/.test(e.detail))).toEqual(expect.arrayContaining(['Invoice statement · to a***@example.test']));
    expect(r.events.filter((e) => /Invoice statement/.test(e.detail)).every((e) => e.engaged === false)).toBe(true);
    // automation: the send row's own (trimmed, mixed-case) snapshot; the redirected billing send is not special
    expect(to('automation', (e) => e.kind === 'opened' && e.at === T(32).toISOString())).toEqual(['Welcome series (step 1) · to s***@example.test']);
    expect(to('automation', (e) => e.kind === 'sent' && e.at === T(87).toISOString())).toEqual(['Welcome series (step 1) · to a***@example.test']);
    // newsletter: the delivery row's own snapshot, not the subscriber's current address (changed since)
    expect(to('newsletter', (e) => e.kind === 'sent')).toEqual(['Newsletter: September news · to s***@example.test']);
    // the full address never leaves the server
    expect(JSON.stringify(r.events)).not.toMatch(/synthetic\.person@|accounts\.payable|subscriber\.address@|new\.inbox/i);
    expect(r.events.some((e) => /billing contact/i.test(e.title))).toBe(false);
  });

  test('a provider click within two minutes of the customer\'s own human short-link click is listed once, as the short-link click', async () => {
    const r = await run({ limit: 200 });
    const providerClicks = r.events.filter((e) => e.kind === 'provider_clicked').map((e) => [e.source, e.at]);
    // T(23) (email) is covered by the human click at T(23)+90s and is gone
    expect(providerClicks.find(([, at]) => at === T(23).toISOString())).toBeUndefined();
    // a bot click or another customer's click 30 seconds away, and a human click 3 minutes away, do not collapse T(52)
    expect(providerClicks).toEqual(expect.arrayContaining([['email', T(52).toISOString()]]));
    // clicks with no short-link click nearby stay listed
    expect(providerClicks).toEqual(expect.arrayContaining([['email', T(60).toISOString()], ['automation', T(91).toISOString()]]));
    // and the short-link click is the engaged event for that tap
    expect(r.events.find((e) => e.source === 'link' && e.at === T(23, 90).toISOString())).toMatchObject({ kind: 'clicked', engaged: true });
    // the lead's link click also collapses a nearby provider click (linkage by lead)
    const solo = randomUUID(); const soloLead = randomUUID(); const sc = randomUUID(); const en = randomUUID();
    await db('customers').insert({ id: solo, email: 'lead.tap@example.test' });
    await db('leads').insert({ id: soloLead, customer_id: solo });
    await db('short_codes').insert({ id: sc, customer_id: null, lead_id: soloLead, kind: 'estimate', channel: 'email', purpose: 'estimate_send' });
    await db('short_code_clicks').insert({ id: randomUUID(), short_code_id: sc, clicked_at: T(30, 45), is_bot: false });
    await db('automation_enrollments').insert({ id: en, template_key: 'welcome', customer_id: solo });
    await db('automation_step_sends').insert({ id: randomUUID(), enrollment_id: en, step_order: 0, status: 'clicked', email: 'lead.tap@example.test', sent_at: T(29), clicked_at: T(30) });
    const tap = await timeline.getCustomerActivity(solo, { limit: 50 }, db);
    expect(tap.events.map((e) => e.kind).sort()).toEqual(['clicked', 'sent']);
    // ...but the summary's informational provider-click time is the raw stamp
    expect(tap.summary.lastProviderClickAt).toBe(T(30).toISOString());
    expect(tap.summary.lastEngagedAt).toBe(T(30, 45).toISOString());
  });

  test('collapsed provider clicks cannot rank a row above a newer send, so paging never skips it', async () => {
    const solo = randomUUID(); const en = randomUUID(); const sc = randomUUID();
    await db('customers').insert({ id: solo, email: 'ranker@example.test' });
    await db('automation_enrollments').insert({ id: en, template_key: 'welcome', customer_id: solo });
    await db('short_codes').insert({ id: sc, customer_id: solo, kind: 'estimate', channel: 'email', purpose: 'estimate_send' });
    // two old sends whose (collapsed) provider clicks are recent, plus a newer send with no click
    await db('short_code_clicks').insert([
      { id: randomUUID(), short_code_id: sc, clicked_at: T(50, 20), is_bot: false },
      { id: randomUUID(), short_code_id: sc, clicked_at: T(51, 20), is_bot: false },
    ]);
    await db('automation_step_sends').insert([
      { id: randomUUID(), enrollment_id: en, step_order: 0, status: 'clicked', email: 'ap@example.test', sent_at: T(1), clicked_at: T(50) },
      { id: randomUUID(), enrollment_id: en, step_order: 1, status: 'clicked', email: 'ap@example.test', sent_at: T(2), clicked_at: T(51) },
      { id: randomUUID(), enrollment_id: en, step_order: 2, status: 'sent', email: 'Ranker@example.test', sent_at: T(20) },
    ]);
    const full = await timeline.getCustomerActivity(solo, { limit: 50 }, db);
    expect(full.events.map((e) => [e.kind, e.at])).toEqual([
      ['clicked', T(51, 20).toISOString()], ['clicked', T(50, 20).toISOString()],
      ['sent', T(20).toISOString()], ['sent', T(2).toISOString()], ['sent', T(1).toISOString()],
    ]);
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 8; i += 1) {
      const page = await timeline.getCustomerActivity(solo, { limit: 1, before: cursor }, db);
      seen.push(...page.events.map((e) => e.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(full.events.map((e) => e.id));
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

  test('engagement: only inbound replies, short-link clicks and recorded page views set lastEngagedAt', async () => {
    const r = await run({ limit: 200 });
    const engaged = r.events.filter((e) => e.engaged);
    expect(new Set(engaged.map((e) => e.source))).toEqual(new Set(['sms', 'link', 'pageview']));
    expect(engaged.every((e) => ['replied', 'clicked', 'viewed'].includes(e.kind))).toBe(true);
    // every other event is shown but never engaged
    const rest = r.events.filter((e) => !engaged.includes(e));
    expect(rest.some((e) => e.kind === 'opened')).toBe(true);
    expect(rest.some((e) => e.kind === 'provider_clicked')).toBe(true);
    expect(rest.some((e) => e.kind === 'viewed_unfiltered')).toBe(true);
    expect(rest.some((e) => e.source === 'call')).toBe(true);

    // Newer than every engaged event, and none of it counts: a provider click (T91), an open (T89, T70),
    // unfiltered token-page stamps (T42-T48), the call (T50), an AP-inbox click (T60).
    expect(r.summary.lastEngagedAt).toBe(T(55).toISOString()); // the human short-link click
    expect(r.summary.lastEngagedFrom).toBe('link clicks');
    expect(r.summary.lastEmailOpenAt).toBe(T(89).toISOString());
    expect(r.summary.lastProviderClickAt).toBe(T(91).toISOString());
    expect(r.summary.lastEmailOpenNote).toMatch(/unreliable/i);
    expect(r.summary.lastProviderClickNote).toMatch(/unfiltered/i);
    // the summary agrees with the events flagged engaged
    expect(engaged.map((e) => e.at).sort().pop()).toBe(r.summary.lastEngagedAt);
  });

  test('a customer with only non-engaged evidence has no engagement at all', async () => {
    const solo = randomUUID(); const est = randomUUID(); const en = randomUUID();
    await db('customers').insert({ id: solo, email: 'quiet@example.test' });
    await db('estimates').insert({ id: est, customer_id: solo, address: '2 Synthetic Way' });
    await db('estimate_views').insert({ id: randomUUID(), estimate_id: est, viewed_at: T(5) });
    await db('customer_contracts').insert({ id: randomUUID(), customer_id: solo, viewed_at: T(6), title: 'Agreement' });
    await db('automation_enrollments').insert({ id: en, template_key: 'welcome', customer_id: solo });
    await db('automation_step_sends').insert({ id: randomUUID(), enrollment_id: en, step_order: 0, status: 'clicked', email: 'quiet@example.test', sent_at: T(1), opened_at: T(2), clicked_at: T(3) });
    const r = await timeline.getCustomerActivity(solo, {}, db);
    expect(r.events).toHaveLength(5);
    expect(r.events.every((e) => e.engaged === false)).toBe(true);
    expect(r.summary).toMatchObject({ lastEngagedAt: null, lastEngagedFrom: null, lastEmailOpenAt: T(2).toISOString(), lastProviderClickAt: T(3).toISOString() });
  });

  test('summary reads the whole history, not just the visible page', async () => {
    const r = await run({ limit: 1 });
    expect(r.events).toHaveLength(1);
    expect(r.summary.lastEngagedAt).toBe(T(55).toISOString());
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

  // Fresh customer per test: every fixture below is scoped to its own ids.
  const fresh = async (email) => {
    const id = randomUUID();
    await db('customers').insert({ id, email });
    return id;
  };
  const activity = (id) => timeline.getCustomerActivity(id, { limit: 200 }, db);

  test('an unresolved review-ask reservation placeholder is never a text the customer got, feed or summary', async () => {
    const c = await fresh('reservation@example.test');
    const parent = randomUUID(); const twin = randomUUID();
    await db('sms_log').insert([
      // failed / undelivered placeholders pass the OUTBOUND_LEFT status filter but never reached the customer
      { id: randomUUID(), customer_id: c, direction: 'outbound', status: 'failed', message_type: 'review_request', message_body: 'placeholder failed', created_at: T(1), metadata: JSON.stringify({ review_ask_reservation: true }) },
      { id: randomUUID(), customer_id: c, direction: 'outbound', status: 'undelivered', message_type: 'review_request', message_body: 'placeholder undelivered', created_at: T(2), metadata: JSON.stringify({ review_ask_reservation: true }) },
      // a resolved (delivered) review ask is a real text
      { id: randomUUID(), customer_id: c, direction: 'outbound', status: 'delivered', message_type: 'review_request', message_body: 'real review ask', created_at: T(3), metadata: JSON.stringify({ review_ask_reservation: true }) },
      // an ordinary failed text stays listed
      { id: randomUUID(), customer_id: c, direction: 'outbound', status: 'failed', message_type: 'billing', message_body: 'real failed text', created_at: T(4) },
      // a reservation twin must not hide its scheduled parent
      { id: parent, customer_id: c, direction: 'outbound', status: 'sent', message_type: 'reminder', message_body: 'kept parent', created_at: T(5) },
      { id: twin, customer_id: c, direction: 'outbound', status: 'failed', message_type: 'reminder', message_body: 'placeholder twin', created_at: T(6), metadata: JSON.stringify({ review_ask_reservation: true, scheduled_sms_log_id: parent }) },
    ]);
    const r = await activity(c);
    expect(r.events.filter((e) => e.source === 'sms').map((e) => e.detail).sort()).toEqual(['kept parent', 'real failed text', 'real review ask']);
    // paging is exact: the placeholders never occupy a page slot
    const seen = []; let cursor = null;
    do {
      const page = await timeline.getCustomerActivity(c, { limit: 1, before: cursor }, db);
      seen.push(...page.events);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(3);
  });

  test('address fallback matches case-insensitively and ignores padding on the snapshot', async () => {
    const c = await fresh('Mixed.Case@Example.Test');
    await db('email_messages').insert([
      { id: randomUUID(), recipient_type: null, recipient_id: null, recipient_email_snapshot: ' MIXED.case@example.TEST ', status: 'sent', subject_snapshot: 'Upper snapshot', sent_at: T(1) },
      { id: randomUUID(), recipient_type: 'lead', recipient_id: '', recipient_email_snapshot: 'mixed.case@example.test', status: 'sent', subject_snapshot: 'Lower snapshot', sent_at: T(2) },
      { id: randomUUID(), recipient_type: null, recipient_id: null, recipient_email_snapshot: 'someone.else@example.test', status: 'sent', subject_snapshot: 'Other inbox', sent_at: T(3) },
    ]);
    const subjects = (await activity(c)).events.map((e) => e.detail.split(' · ')[0]);
    expect(subjects.sort()).toEqual(['Lower snapshot', 'Upper snapshot']);
  });

  test('a payer\'s click on a code minted under the homeowner is "Link clicked by invoice recipient" and never engaged', async () => {
    const c = await fresh('payer.home@example.test');
    const payerInvoice = randomUUID(); const ownInvoice = randomUUID();
    await db('invoices').insert([{ id: payerInvoice, payer_id: 12 }, { id: ownInvoice, payer_id: null }]);
    const byMarker = randomUUID(); const byInvoice = randomUUID(); const own = randomUUID();
    await db('short_codes').insert([
      // new mint: carries the producer marker
      { id: byMarker, customer_id: c, kind: 'invoice', channel: 'email', purpose: 'payer_invoice', entity_type: 'invoices', entity_id: ownInvoice },
      // historical mint: no marker, but its invoice has a payer
      { id: byInvoice, customer_id: c, kind: 'invoice', channel: null, purpose: null, entity_type: 'invoices', entity_id: payerInvoice },
      // the homeowner's own invoice link
      { id: own, customer_id: c, kind: 'invoice', channel: 'email', purpose: 'invoice_send', entity_type: 'invoices', entity_id: ownInvoice },
    ]);
    await db('short_code_clicks').insert([
      { id: randomUUID(), short_code_id: byMarker, clicked_at: T(10) },
      { id: randomUUID(), short_code_id: byInvoice, clicked_at: T(11) },
      { id: randomUUID(), short_code_id: own, clicked_at: T(5) },
    ]);
    const r = await activity(c);
    const clicks = r.events.filter((e) => e.source === 'link');
    expect(clicks.map((e) => [e.title, e.kind, e.engaged])).toEqual([
      ['Link clicked by invoice recipient', 'payer_clicked', false],
      ['Link clicked by invoice recipient', 'payer_clicked', false],
      ['Clicked the invoice link', 'clicked', true],
    ]);
    // the summary credits only the homeowner's own click, not the newer payer clicks
    expect(r.summary.lastEngagedAt).toBe(T(5).toISOString());
    const onlyPayer = await fresh('payer.only@example.test');
    const code = randomUUID();
    await db('short_codes').insert({ id: code, customer_id: onlyPayer, kind: 'invoice', channel: 'email', purpose: 'payer_invoice' });
    await db('short_code_clicks').insert({ id: randomUUID(), short_code_id: code, clicked_at: T(20) });
    const none = await activity(onlyPayer);
    expect(none.events.map((e) => e.title)).toEqual(['Link clicked by invoice recipient']);
    expect(none.summary.lastEngagedAt).toBeNull();
  });

  test('a payer click never collapses the customer\'s own provider click into an "engaged" one', async () => {
    const c = await fresh('payer.near@example.test');
    const code = randomUUID();
    await db('short_codes').insert({ id: code, customer_id: c, kind: 'invoice', channel: 'email', purpose: 'payer_invoice' });
    await db('short_code_clicks').insert({ id: randomUUID(), short_code_id: code, clicked_at: T(30, 30) });
    await db('email_messages').insert({ id: randomUUID(), recipient_type: 'customer', recipient_id: c, recipient_email_snapshot: 'payer.near@example.test', status: 'clicked', subject_snapshot: 'Own mail', sent_at: T(29), clicked_at: T(30) });
    const titles = (await activity(c)).events.map((e) => e.title);
    expect(titles).toContain('Link clicked (reported by email provider — may be a scanner)');
    expect(titles).toContain('Link clicked by invoice recipient');
  });

  test('a short code with no (or an unknown) channel is a neutral link, not a text', async () => {
    const c = await fresh('nochannel@example.test');
    const none = randomUUID(); const odd = randomUUID(); const sms = randomUUID();
    await db('short_codes').insert([
      { id: none, customer_id: c, kind: 'estimate', channel: null },
      { id: odd, customer_id: c, kind: 'booking', channel: 'whatsapp' },
      { id: sms, customer_id: c, kind: 'invoice', channel: 'sms' },
    ]);
    await db('short_code_clicks').insert([
      { id: randomUUID(), short_code_id: none, clicked_at: T(1) },
      { id: randomUUID(), short_code_id: odd, clicked_at: T(2) },
      { id: randomUUID(), short_code_id: sms, clicked_at: T(3) },
    ]);
    const byTitle = Object.fromEntries((await activity(c)).events.map((e) => [e.title, e.channel]));
    expect(byTitle).toEqual({ 'Clicked the estimate link': 'link', 'Clicked the booking link': 'link', 'Clicked the invoice link': 'sms' });
  });

  test('a scheduled send is one row: the provider row wins; a parent with no provider row stays', async () => {
    const c = await fresh('scheduled@example.test');
    const parent = randomUUID(); const provider = randomUUID(); const pushParent = randomUUID(); const pushProvider = randomUUID();
    const lonely = randomUUID(); const failedProvider = randomUUID(); const failedParent = randomUUID();
    const hiddenProviderParent = randomUUID(); const hiddenProvider = randomUUID();
    await db('sms_log').insert([
      // promoted parent + text provider row
      { id: parent, customer_id: c, direction: 'outbound', status: 'sent', message_type: 'reminder', message_body: 'parent text', created_at: T(1) },
      { id: provider, customer_id: c, direction: 'outbound', status: 'delivered', message_type: 'reminder', message_body: 'provider text', created_at: T(2), metadata: JSON.stringify({ scheduled_sms_log_id: parent }) },
      // parent + push-proof provider row: only the app-notification row shows
      { id: pushParent, customer_id: c, direction: 'outbound', status: 'sent', message_type: 'reminder', message_body: 'push parent', created_at: T(3) },
      { id: pushProvider, customer_id: c, direction: 'outbound', status: 'sent', message_type: 'reminder', message_body: 'push provider', created_at: T(4), from_phone: 'push', metadata: JSON.stringify({ channel: 'push', scheduled_sms_log_id: pushParent }) },
      // parent nothing references
      { id: lonely, customer_id: c, direction: 'outbound', status: 'sent', message_type: 'reminder', message_body: 'lonely parent', created_at: T(5) },
      // a failed provider row still replaces its parent
      { id: failedParent, customer_id: c, direction: 'outbound', status: 'sent', message_type: 'billing', message_body: 'failed parent', created_at: T(6) },
      { id: failedProvider, customer_id: c, direction: 'outbound', status: 'failed', message_type: 'billing', message_body: 'failed provider', created_at: T(7), metadata: JSON.stringify({ scheduled_sms_log_id: failedParent }) },
      // a provider row that is itself not listable (never left) must not hide its parent
      { id: hiddenProviderParent, customer_id: c, direction: 'outbound', status: 'sent', message_type: 'reminder', message_body: 'kept parent', created_at: T(8) },
      { id: hiddenProvider, customer_id: c, direction: 'outbound', status: 'canceled', message_type: 'reminder', message_body: 'canceled provider', created_at: T(9), metadata: JSON.stringify({ scheduled_sms_log_id: hiddenProviderParent }) },
    ]);
    const texts = (await activity(c)).events.filter((e) => e.source === 'sms');
    expect(texts.map((e) => e.detail).sort()).toEqual(['failed provider', 'kept parent', 'lonely parent', 'provider text', 'push provider']);
    expect(texts.find((e) => e.detail === 'push provider').channel).toBe('push');
    expect(texts.find((e) => e.detail === 'failed provider').kind).toBe('failed');
    // paging stays exact across the collapse: limit 1 pages walk the same five events
    const seen = []; let cursor = null;
    do {
      const page = await timeline.getCustomerActivity(c, { limit: 1, before: cursor }, db);
      seen.push(...page.events);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.map((e) => e.detail).sort()).toEqual(['failed provider', 'kept parent', 'lonely parent', 'provider text', 'push provider']);
  });

  test('a terminal text status is dated when the status callback landed, not when the text was sent; paging stays exact', async () => {
    const c = await fresh('status-time@example.test');
    const [delivered, failed, stale, noInbox, inflight] = [1, 2, 3, 4, 5].map(() => randomUUID());
    const sid = (n) => `SM-status-${n}-${delivered.slice(0, 8)}`;
    await db('sms_log').insert([
      { id: delivered, customer_id: c, direction: 'outbound', status: 'delivered', message_type: 'reminder', message_body: 'delivered text', created_at: T(1), twilio_sid: sid(1) },
      { id: failed, customer_id: c, direction: 'outbound', status: 'failed', message_type: 'billing', message_body: 'failed text', created_at: T(2), twilio_sid: sid(2) },
      // inbox row still reports an older status (a non-status touch): keeps created_at
      { id: stale, customer_id: c, direction: 'outbound', status: 'read', message_type: null, message_body: 'stale text', created_at: T(3), twilio_sid: sid(3) },
      // no inbox row: keeps created_at
      { id: noInbox, customer_id: c, direction: 'outbound', status: 'delivered', message_type: null, message_body: 'no inbox row', created_at: T(4), twilio_sid: sid(4) },
      // in-flight status: the 'sent' event stays at created_at even if the inbox row moved
      { id: inflight, customer_id: c, direction: 'outbound', status: 'sent', message_type: null, message_body: 'in flight', created_at: T(5), twilio_sid: sid(5) },
    ]);
    await db('messages').insert([
      { twilio_sid: sid(1), delivery_status: 'delivered', updated_at: T(30) },
      { twilio_sid: sid(2), delivery_status: 'failed', updated_at: T(20) },
      { twilio_sid: sid(3), delivery_status: 'delivered', updated_at: T(40) },
      { twilio_sid: sid(5), delivery_status: 'sent', updated_at: T(50) },
    ]);
    const at = Object.fromEntries((await activity(c)).events.map((e) => [e.detail, e.at]));
    expect(at).toEqual({
      'delivered text': T(30).toISOString(),
      'failed text': T(20).toISOString(),
      'stale text': T(3).toISOString(),
      'no inbox row': T(4).toISOString(),
      'in flight': T(5).toISOString(),
    });
    // the ranking key is the event time: a one-row walk yields the same order
    const seen = []; let cursor = null;
    do {
      const page = await timeline.getCustomerActivity(c, { limit: 1, before: cursor }, db);
      seen.push(...page.events.map((e) => e.detail));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['delivered text', 'failed text', 'in flight', 'no inbox row', 'stale text']);
  });

  test('a source whose table cannot be read is reported unavailable and the rest still returns', async () => {
    await db.raw('DROP TABLE call_log');
    const r = await run({ limit: 200 });
    expect(r.unavailableSources).toEqual(['calls']);
    expect(r.events.some((e) => e.source === 'call')).toBe(false);
    expect(r.events.some((e) => e.title === 'Replied by text')).toBe(true);
    expect(r.summary.lastEngagedAt).toBe(T(55).toISOString());
    await db.raw(CALL_LOG_DDL);
  });

  test('unknown customer returns null; a bad cursor is a 400', async () => {
    expect(await timeline.getCustomerActivity(randomUUID(), {}, db)).toBeNull();
    await expect(run({ before: 'not-a-date' })).rejects.toMatchObject({ status: 400 });
  });
});
