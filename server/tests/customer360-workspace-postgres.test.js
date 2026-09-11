// Opt-in integration checks against this worktree's migrated Railway dev database.
// Uses synthetic records only; queries are real and fixtures are removed by id.
// No application DATABASE_URL or provider client is used.
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  // mockPg is itself already a transaction (the whole suite runs inside one,
  // rolled back in afterAll), so a nested db.transaction() becomes a real
  // Postgres SAVEPOINT rather than a fresh pooled connection like production
  // gets — enough to exercise the SQL (advisory lock + SET LOCAL) for real,
  // though it shares one connection rather than truly running in parallel.
  db.transaction = (...args) => mockPg.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => mockPg.schema });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ markInboundSmsReadAdmin: jest.fn().mockResolvedValue(0) }));
const { randomUUID, randomBytes } = require('node:crypto');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const { invoiceOverdueSql, invoiceDaysOverdue } = require('../services/collections/account-anchor');
const router = require('../routes/admin-customers');
const { countUnreadInboundSms, markInboundSmsRead, retargetOrClearUnknownSenderBell } = require('../services/inbound-sms-read');
const { sweepUnknownSenderAlertClaims } = require('../services/sms-reply-alert-sweep');
const NotificationService = require('../services/notification-service');
const realNotificationService = jest.requireActual('../services/notification-service');
const { openBalanceSummary } = require('../services/open-balance');
const connection = process.env.C360_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const ids = Array.from({ length: 4 }, () => randomUUID());
const prefix = `C360-${randomBytes(4).toString('hex')}`;
let mockPg;
let technicianId;
let invoiceId;
let estimateId;

async function read(path, query = {}, extra = {}) {
  const handler = router.stack.find(layer => layer.route?.path === path && layer.route.methods.get).route.stack.at(-1).handle;
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await handler({ params: { id: ids[0] }, query, techRole: 'admin', ...extra }, res, next);
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  return res.json.mock.calls[0]?.[0];
}

postgres('Customer 360 migrated PostgreSQL reads', () => {
  beforeAll(async () => {
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) throw new Error('Use a verified private worktree QA database');
    mockPg = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    if (!await mockPg.schema.hasTable('knex_migrations')) throw new Error('Run the development migrations before this suite');
    const now = new Date();
    const yesterday = etDateString(new Date(Date.now() - 86400000));
    const tomorrow = etDateString(new Date(Date.now() + 86400000));
    await mockPg('customers').insert(ids.map((id, index) => ({
      id, first_name: `${prefix}-${index}`, last_name: 'Synthetic',
      phone: `+1941555010${index}`, email: `${id}@example.invalid`,
      address_line1: '100 Example Lane', city: 'Test City', zip: '00000',
      pipeline_stage: 'active_customer',
    })));
    await mockPg('customer_health_scores').insert([
      { customer_id: ids[0], overall_score: 91, score_grade: 'A', churn_risk: 'low', churn_probability: 0.04, scored_at: now },
      { customer_id: ids[1], overall_score: 0, score_grade: 'F', churn_risk: 'critical', churn_probability: 0.90, scored_at: now },
      { customer_id: ids[2], overall_score: 70, score_grade: null, churn_risk: 'moderate', churn_probability: 0.30, scored_at: now },
    ]);
    await mockPg('retention_outreach').insert([
      { customer_id: ids[0], status: 'save_successful', outcome: 'retained', revenue_saved: 100, created_at: now },
      { customer_id: ids[0], status: 'completed', outcome: 'retained', revenue_saved: 0, created_at: now },
      { customer_id: ids[1], status: 'sent', created_at: now },
      { customer_id: ids[2], status: 'save_successful', revenue_saved: 100, created_at: new Date(Date.now() - 31 * 86400000) },
    ]);
    await mockPg('upsell_opportunities').insert({ customer_id: ids[1], status: 'accepted', estimated_monthly_value: 25, created_at: now });
    technicianId = randomUUID();
    await mockPg('technicians').insert({ id: technicianId, name: 'Synthetic Technician' });
    await mockPg('scheduled_services').insert({ customer_id: ids[0], technician_id: technicianId, scheduled_date: tomorrow, window_start: '09:00:00', window_end: '10:30:00', service_type: 'Synthetic service', status: 'confirmed' });
    invoiceId = randomUUID();
    await mockPg('invoices').insert([
      { id: invoiceId, customer_id: ids[0], invoice_number: `${prefix}-1`, token: randomBytes(24).toString('hex'), status: 'sent', due_date: yesterday, total: 125, credit_applied: 25, sent_at: now },
      { customer_id: ids[0], invoice_number: `${prefix}-2`, token: randomBytes(24).toString('hex'), status: 'viewed', due_date: tomorrow, total: 50, credit_applied: 0 },
      { customer_id: ids[0], invoice_number: `${prefix}-3`, token: randomBytes(24).toString('hex'), status: 'overdue', due_date: yesterday, total: 25, credit_applied: 25 },
    ]);
    estimateId = randomUUID();
    await mockPg('estimates').insert({ id: estimateId, customer_id: ids[0], status: 'accepted', accepted_at: now });
    for (const customerId of ids.slice(0, 2)) {
      const conversationId = randomUUID();
      await mockPg('conversations').insert({ id: conversationId, customer_id: customerId, channel: 'sms', contact_phone: customerId === ids[0] ? '+19415550100' : '+19415550101', our_endpoint_id: '+19415550190' });
      await mockPg('messages').insert({ conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'customer', is_read: false, body: 'Synthetic message '.repeat(25) });
    }
  }, 60000);

  afterAll(async () => {
    if (!mockPg) return;
    try {
      const conversations = mockPg('conversations').select('id').whereIn('customer_id', ids);
      await mockPg('messages').whereIn('conversation_id', conversations).delete();
      for (const table of ['conversations', 'estimates', 'invoices', 'scheduled_services', 'upsell_opportunities', 'retention_outreach', 'customer_health_scores']) {
        await mockPg(table).whereIn('customer_id', ids).delete();
      }
      await mockPg('customers').whereIn('id', ids).delete();
      if (technicianId) await mockPg('technicians').where({ id: technicianId }).delete();
    } finally { await mockPg.destroy(); }
  }, 60000);

  test('directory executes both page and count queries with recorded grades, zero score and unknown grades', async () => {
    const all = await read('/', { search: prefix, limit: '2' });
    expect(all).toMatchObject({ total: 4, totalPages: 2 });
    expect(all.customers).toHaveLength(2);
    expect(all.customers[0]).toMatchObject({ id: ids[0], healthGrade: 'A', healthScore: 91, overdueInvoiceCount: 1 });
    expect((await read('/', { search: prefix, minHealthScore: '0', maxHealthScore: '0' })).customers.map(row => row.id)).toEqual([ids[1]]);
    expect((await read('/', { search: prefix, healthGrade: 'ungraded' })).customers.map(row => row.id)).toEqual([ids[2], ids[3]]);
    expect((await read('/', { search: prefix, healthRisk: 'at_risk', minChurnProbability: '75' })).customers.map(row => row.id)).toEqual([ids[1]]);
  }, 30000);

  test('retention outcomes compose with health, avoid duplicate customers and exclude older cohorts', async () => {
    for (const retention of ['saved', 'revenue_saved']) {
      const result = await read('/', { search: prefix, retention, healthGrade: 'A', limit: '1' });
      expect(result.total).toBe(1);
      expect(result.customers.map(row => row.id)).toEqual([ids[0]]);
    }
    for (const retention of ['upsell_accepted', 'upsell_revenue']) {
      expect((await read('/', { search: prefix, retention })).customers.map(row => row.id)).toEqual([ids[1]]);
    }
  }, 30000);

  test('technician assignment scope ignores private filters and strips added fields', async () => {
    const result = await read('/', { search: prefix, healthGrade: 'F', retention: 'upsell_accepted' }, { techRole: 'technician', technicianId });
    expect(result.customers.map(row => row.id)).toEqual([ids[0]]);
    expect(result.customers[0]).not.toHaveProperty('healthGrade');
    expect(result.customers[0]).not.toHaveProperty('overdueInvoiceCount');
  }, 30000);

  test('timeline reads actual source columns and emits recorded lifecycle events and full text', async () => {
    const result = await read('/:id/timeline');
    expect(result.timeline.filter(row => row.metadata.invoiceId === invoiceId).map(row => row.title)).toEqual(expect.arrayContaining([`Invoice ${prefix}-1 created`, `Invoice ${prefix}-1 sent`]));
    expect(result.timeline.filter(row => row.metadata.estimateId === estimateId).map(row => row.title)).toEqual(expect.arrayContaining(['Estimate created', 'Estimate accepted']));
    expect(result.timeline.some(row => row.type === 'sms' && row.description.length > 200)).toBe(true);
    expect(result.timeline.some(row => row.title === 'Estimate sent')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('token');
  }, 30000);

  test('profile reads the upcoming technician and complete billing summary from the same records', async () => {
    const result = await read('/:id');
    expect(result.upcomingScheduled[0]).toMatchObject({ technician_name: 'Synthetic Technician', window_start: '09:00:00', window_end: '10:30:00' });
    expect(result.billingSummary).toMatchObject({ openBalance: 150, overdueBalance: 100, overdueCount: 1, complete: true });
    expect(result.estimates.find(row => row.id === estimateId).priceReferences).toEqual([]);
  }, 30000);

  test('shared unread and balance readers return the selected account and complete overdue totals', async () => {
    expect(await countUnreadInboundSms({ customerId: ids[0] })).toEqual({ conversations: 1, messages: 1 });
    expect(await countUnreadInboundSms({ customerId: ids[3] })).toEqual({ conversations: 0, messages: 0 });
    expect(await openBalanceSummary(ids[0], { displayLimit: 0 })).toMatchObject({ total: 150, overdueTotal: 100, overdueCount: 1, count: 2, complete: true, invoices: [] });
  }, 30000);

  test('legacy due-date fallbacks agree in the directory, profile and collections clock', async () => {
    const now = new Date();
    const today = etDateString(now);
    const midnight = parseETDateTime(`${today}T00:00`);
    const old = new Date(now.getTime() - 15 * 86400000);
    const tomorrow = etDateString(new Date(now.getTime() + 86400000));
    const cases = [
      { status: 'sent', due_date: null, created_at: old, total: 125, credit_applied: 25 },
      { status: 'viewed', due_date: null, created_at: new Date(midnight.getTime() - 1), total: 50, credit_applied: 0 },
      { status: 'sent', due_date: tomorrow, created_at: old, total: 30, credit_applied: 0 },
      { status: 'viewed', due_date: today, created_at: old, total: 20, credit_applied: 0 },
      { status: 'sent', due_date: null, created_at: midnight, total: 10, credit_applied: 0 },
      { status: 'overdue', due_date: tomorrow, created_at: old, total: 5, credit_applied: 0 },
      { status: 'sent', due_date: null, created_at: old, total: 25, credit_applied: 25 },
    ].map((row, index) => ({ ...row, id: randomUUID(), customer_id: ids[3], invoice_number: `${prefix}-legacy-${index}`, token: randomBytes(24).toString('hex') }));
    await mockPg('invoices').insert(cases);
    try {
      const rows = await mockPg('invoices').where('customer_id', ids[3])
        .select('invoices.*', mockPg.raw('? AS is_overdue', [invoiceOverdueSql(mockPg, now)]));
      for (const row of rows) expect(row.is_overdue).toBe(row.status === 'overdue' || invoiceDaysOverdue(now, row) > 0);
      const directory = await read('/', { search: prefix });
      expect(directory.customers.find(row => row.id === ids[3]).overdueInvoiceCount).toBe(3);
      const profile = await read('/:id', {}, { params: { id: ids[3] } });
      expect(profile.billingSummary).toMatchObject({ openBalance: 215, overdueBalance: 155, overdueCount: 3, complete: true });
      expect(await openBalanceSummary(ids[3])).toMatchObject({ total: 215, overdueTotal: 155, overdueCount: 3, count: 6, complete: true });
    } finally {
      await mockPg('invoices').whereIn('id', cases.map(row => row.id)).delete();
    }
  }, 30000);

  test('customer thread read scope covers older unread history while preserving later arrivals and other customers', async () => {
    const recentConversation = randomUUID();
    const olderConversation = randomUUID();
    const olderMessage = randomUUID();
    const laterMessage = randomUUID();
    await mockPg('conversations').insert([recentConversation, olderConversation].map((id, index) => ({ id, customer_id: ids[2], channel: 'sms', contact_phone: '+19415550102', our_endpoint_id: `+1941555019${index}` })));
    await mockPg('messages').insert(Array.from({ length: 100 }, () => ({ conversation_id: recentConversation, channel: 'sms', direction: 'inbound', author_type: 'customer', is_read: true, body: 'Read synthetic message', created_at: new Date(Date.now() - 60000) })));
    await mockPg('messages').insert({ id: olderMessage, conversation_id: olderConversation, channel: 'sms', direction: 'inbound', author_type: 'customer', is_read: false, body: 'Older unread synthetic message', created_at: new Date(Date.now() - 86400000) });

    const thread = await read('/:id/comms', {}, { params: { id: ids[2] } });
    expect(thread.comms).toHaveLength(100);
    expect(thread.comms.every(message => message.isRead && message.conversationId === recentConversation)).toBe(true);
    expect(thread.readScope.conversationIds.sort()).toEqual([recentConversation, olderConversation].sort());
    const readBefore = new Date(thread.readScope.readBefore);
    await mockPg('messages').insert({ id: laterMessage, conversation_id: recentConversation, channel: 'sms', direction: 'inbound', author_type: 'customer', is_read: false, body: 'Later synthetic message', created_at: new Date(readBefore.getTime() + 1000) });

    expect(await markInboundSmsRead({ conversationIds: thread.readScope.conversationIds, readBefore, role: 'admin' })).toMatchObject({ updated: 1 });
    expect((await mockPg('messages').where({ id: olderMessage }).first()).is_read).toBe(true);
    expect((await mockPg('messages').where({ id: laterMessage }).first()).is_read).toBe(false);
    expect(await countUnreadInboundSms({ customerId: ids[1] })).toEqual({ conversations: 1, messages: 1 });
  }, 30000);

  test('reading an unknown sender\'s alerted SID retargets its one bell to a later unread message instead of clearing it (codex #4210)', async () => {
    const conversationId = randomUUID();
    const alertedMessageId = randomUUID();
    const laterMessageId = randomUUID();
    const alertedSid = `SM-synthetic-alerted-${randomBytes(4).toString('hex')}`;
    const laterSid = `SM-synthetic-later-${randomBytes(4).toString('hex')}`;
    // A phone unique to this run — contact_phone carries a dedup constraint
    // shared with real inbound rows.
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    let bell;
    try {
      // Unknown sender: no customer_id, so the customer-scoped
      // nothing-left-unread clear below can never reach this conversation's
      // bell — only the SID it rang for (codex #4210 P2).
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550190' });
      await mockPg('messages').insert([
        { id: alertedMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: alertedSid, body: 'First synthetic text', created_at: new Date(Date.now() - 120000) },
        // Throttled: the 4h per-sender window suppressed its own bell.
        { id: laterMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: laterSid, body: 'Second synthetic text, same sender', created_at: new Date(Date.now() - 60000) },
      ]);
      [bell] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic unknown-sender text', link: '/admin/communications',
        metadata: JSON.stringify({ payload: { twilioSid: alertedSid } }),
      }).returning('*');

      // Reading only the alerted message must NOT clear the thread's only
      // bell while the later throttled message is still unread — it must
      // retarget the bell to that later SID instead.
      await markInboundSmsRead({ messageIds: [alertedMessageId], role: 'admin' });
      expect((await mockPg('messages').where({ id: alertedMessageId }).first()).is_read).toBe(true);
      expect((await mockPg('messages').where({ id: laterMessageId }).first()).is_read).toBe(false);
      let refreshedBell = await mockPg('notifications').where({ id: bell.id }).first();
      expect(refreshedBell.read_at).toBeNull();
      expect(refreshedBell.metadata.payload.twilioSid).toBe(laterSid);

      // Reading the last remaining unread message finds nothing left in the
      // conversation, so the retarget is a no-op and the bell (now keyed to
      // this SID) is eligible for the ordinary by-SID clear.
      await markInboundSmsRead({ messageIds: [laterMessageId], role: 'admin' });
      expect((await mockPg('messages').where({ id: laterMessageId }).first()).is_read).toBe(true);
      refreshedBell = await mockPg('notifications').where({ id: bell.id }).first();
      expect(refreshedBell.metadata.payload.twilioSid).toBe(laterSid);
    } finally {
      await mockPg('messages').whereIn('id', [alertedMessageId, laterMessageId]).delete();
      if (bell) await mockPg('notifications').where({ id: bell.id }).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('the retarget also runs for a conversationIds-driven read, not just an explicit messageIds one (claude pre-push audit P1, round 4)', async () => {
    const conversationId = randomUUID();
    const alertedMessageId = randomUUID();
    const laterMessageId = randomUUID();
    const alertedSid = `SM-synthetic-alerted-${randomBytes(4).toString('hex')}`;
    const laterSid = `SM-synthetic-later-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    let bell;
    try {
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550190' });
      await mockPg('messages').insert([
        { id: alertedMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: alertedSid, body: 'First synthetic text', created_at: new Date(Date.now() - 120000) },
        { id: laterMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: laterSid, body: 'Second synthetic text, same sender', created_at: new Date(Date.now() - 60000) },
      ]);
      [bell] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic unknown-sender text', link: '/admin/communications',
        metadata: JSON.stringify({ payload: { twilioSid: alertedSid } }),
      }).returning('*');

      // Opening the whole thread (the admin inbox's usual shape) passes
      // conversationIds + readBefore, not an explicit messageIds list — the
      // shared `scope` both mirrorSids and the retarget key off of covers
      // either input shape identically, but the P2 fix was only exercised
      // through messageIds until this test.
      const readBefore = new Date(Date.now() + 1000);
      await markInboundSmsRead({ conversationIds: [conversationId], readBefore, role: 'admin' });
      expect((await mockPg('messages').where({ id: alertedMessageId }).first()).is_read).toBe(true);
      expect((await mockPg('messages').where({ id: laterMessageId }).first()).is_read).toBe(true);
      // Both messages in scope are read in the SAME call, so nothing
      // remains unread — the bell must be cleared directly, not retargeted.
      const refreshedBell = await mockPg('notifications').where({ id: bell.id }).first();
      expect(refreshedBell.read_at).not.toBeNull();
    } finally {
      await mockPg('messages').whereIn('id', [alertedMessageId, laterMessageId]).delete();
      if (bell) await mockPg('notifications').where({ id: bell.id }).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('the retarget follows the sender across the business numbers they texted, not just one conversation (pre-push audit P1)', async () => {
    const firstConversationId = randomUUID();
    const secondConversationId = randomUUID();
    const alertedMessageId = randomUUID();
    const laterMessageId = randomUUID();
    const alertedSid = `SM-synthetic-alerted-${randomBytes(4).toString('hex')}`;
    const laterSid = `SM-synthetic-later-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    let bell;
    try {
      // The SAME unknown sender texted two different business numbers —
      // conversations are keyed by (contact_phone, channel, our_endpoint_id),
      // so this is two conversation rows, but the throttle/claim that rang
      // the one bell is keyed on the raw phone across both.
      await mockPg('conversations').insert([
        { id: firstConversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550190' },
        { id: secondConversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550191' },
      ]);
      await mockPg('messages').insert([
        { id: alertedMessageId, conversation_id: firstConversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: alertedSid, body: 'First synthetic text, first number', created_at: new Date(Date.now() - 120000) },
        // Same sender, a DIFFERENT conversation (second business number) —
        // throttled: the 4h per-sender window suppressed its own bell.
        { id: laterMessageId, conversation_id: secondConversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: laterSid, body: 'Second synthetic text, second number', created_at: new Date(Date.now() - 60000) },
      ]);
      [bell] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic unknown-sender text', link: '/admin/communications',
        metadata: JSON.stringify({ payload: { twilioSid: alertedSid } }),
      }).returning('*');

      // Reading the alerted message in the FIRST conversation must retarget
      // to the unread message in the SECOND — a conversation-scoped check
      // would find nothing remaining in the first conversation and wrongly
      // clear the sender's only bell.
      await markInboundSmsRead({ messageIds: [alertedMessageId], role: 'admin' });
      const refreshedBell = await mockPg('notifications').where({ id: bell.id }).first();
      expect(refreshedBell.read_at).toBeNull();
      expect(refreshedBell.metadata.payload.twilioSid).toBe(laterSid);
    } finally {
      await mockPg('messages').whereIn('id', [alertedMessageId, laterMessageId]).delete();
      if (bell) await mockPg('notifications').where({ id: bell.id }).delete();
      await mockPg('conversations').whereIn('id', [firstConversationId, secondConversationId]).delete();
    }
  }, 30000);

  test('concurrently reading both of an unknown sender\'s unread messages clears the bell instead of leaving it stuck on a retarget the other request already missed (pre-push audit P1)', async () => {
    const conversationId = randomUUID();
    const firstMessageId = randomUUID();
    const secondMessageId = randomUUID();
    const firstSid = `SM-synthetic-race-a-${randomBytes(4).toString('hex')}`;
    const secondSid = `SM-synthetic-race-b-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    let bell;
    // Unmock NotificationService for this test only: the real
    // markInboundSmsReadAdmin (still reading through mockPg, since
    // '../models/db' is mocked for the whole file) is what actually clears
    // read_at — without it, a stuck-vs-cleared bell can't be observed.
    NotificationService.markInboundSmsReadAdmin.mockImplementation((...args) => realNotificationService.markInboundSmsReadAdmin(...args));
    try {
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550190' });
      await mockPg('messages').insert([
        { id: firstMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: firstSid, body: 'First synthetic text', created_at: new Date(Date.now() - 120000) },
        { id: secondMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: secondSid, body: 'Second synthetic text, same sender', created_at: new Date(Date.now() - 60000) },
      ]);
      [bell] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic unknown-sender text', link: '/admin/communications',
        metadata: JSON.stringify({ payload: { twilioSid: firstSid } }),
      }).returning('*');

      // Both messages read at once, through separate concurrent calls (the
      // shape two staff members opening the same unknown thread at once, or
      // one request per message, would produce). This shares mockPg's one
      // connection (a savepoint per db.transaction() rather than production's
      // fresh pooled connection), so it can't reproduce the exact
      // cross-connection interleaving timing — but it does exercise the real
      // advisory-lock SQL under real concurrent JS calls and confirms the
      // end state converges correctly rather than assuming it from mocks.
      await Promise.all([
        markInboundSmsRead({ messageIds: [firstMessageId], role: 'admin' }),
        markInboundSmsRead({ messageIds: [secondMessageId], role: 'admin' }),
      ]);

      expect((await mockPg('messages').where({ id: firstMessageId }).first()).is_read).toBe(true);
      expect((await mockPg('messages').where({ id: secondMessageId }).first()).is_read).toBe(true);
      // Both messages are read, so the bell must end up cleared — the bug
      // this guards against leaves read_at permanently null because the
      // retarget's write and the ordinary by-SID clear can land in the
      // wrong order for whichever message "won" the race.
      const refreshedBell = await mockPg('notifications').where({ id: bell.id }).first();
      expect(refreshedBell.read_at).not.toBeNull();
    } finally {
      NotificationService.markInboundSmsReadAdmin.mockReset().mockResolvedValue(0);
      await mockPg('messages').whereIn('id', [firstMessageId, secondMessageId]).delete();
      if (bell) await mockPg('notifications').where({ id: bell.id }).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('reading an unknown sender\'s message never clears a bell created after this read began, even when nothing else is unread (codex #4210 round-2 P1)', async () => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const sid = `SM-synthetic-entry-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    let bell;
    try {
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550190' });
      await mockPg('messages').insert({ id: messageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: sid, body: 'Synthetic text', created_at: new Date(Date.now() - 60000) });
      // Stands in for a bell whose underlying inbound row lands strictly
      // AFTER this read's request-entry `now` (the real race: a new message
      // arrives, and its bell is written, between the `remaining` check and
      // the clear/retarget write). A future created_at guarantees it
      // postdates any `now` this call captures.
      [bell] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic unknown-sender text',
        link: '/admin/communications', created_at: new Date(Date.now() + 5 * 60000),
        metadata: JSON.stringify({ payload: { twilioSid: sid } }),
      }).returning('*');

      await markInboundSmsRead({ messageIds: [messageId], role: 'admin' });
      expect((await mockPg('messages').where({ id: messageId }).first()).is_read).toBe(true);
      // Nothing else is unread for this phone, so the pre-fix code would
      // clear the bell outright here — but it postdates the read's entry
      // and must be left alone.
      const refreshedBell = await mockPg('notifications').where({ id: bell.id }).first();
      expect(refreshedBell.read_at).toBeNull();
    } finally {
      await mockPg('messages').where({ id: messageId }).delete();
      if (bell) await mockPg('notifications').where({ id: bell.id }).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('a promoted thread\'s alerted SID still finds its live bell and retargets to a still-unread sibling instead of losing it to the blunt by-SID clear (codex #4210 round-2 P2)', async () => {
    const conversationId = randomUUID();
    const alertedMessageId = randomUUID();
    const laterMessageId = randomUUID();
    const alertedSid = `SM-synthetic-promoted-${randomBytes(4).toString('hex')}`;
    const laterSid = `SM-synthetic-promoted-later-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    let bell;
    try {
      // Promoted BEFORE the read: the conversation now carries a
      // customer_id AND has contact_phone NULLed — the real shape
      // promoteUnknownPhoneThreadWith leaves behind
      // (services/conversations.js clears contact_phone on every promote/
      // merge path; codex #4210 round-5 P1 caught an earlier version of
      // this fixture that unrealistically kept it set). The bell rang
      // while the sender was still unknown (link stays
      // '/admin/communications', never rewritten). A distinct
      // our_endpoint_id avoids the (customer_id, channel, our_endpoint_id)
      // dedup index colliding with ids[0]'s fixture conversation from
      // beforeAll.
      await mockPg('conversations').insert({ id: conversationId, customer_id: ids[0], channel: 'sms', contact_phone: null, our_endpoint_id: '+19415550192' });
      await mockPg('messages').insert([
        { id: alertedMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: alertedSid, body: 'First synthetic text, alerted while unknown', created_at: new Date(Date.now() - 120000) },
        // Arrived after promotion with no bell of its own (the throttled
        // dispatch never rang again for this window) — its only hope is the
        // ORIGINAL, still-live unlinked-style bell.
        { id: laterMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: laterSid, body: 'Second synthetic text, after promotion', created_at: new Date(Date.now() - 60000) },
      ]);
      // The durable sender identity: contact_phone is gone from the
      // conversation, so the retarget/liveBell queries resolve the phone
      // through sms_log.from_phone instead.
      await mockPg('sms_log').insert([
        { direction: 'inbound', from_phone: unknownPhone, to_phone: '+19415550192', twilio_sid: alertedSid, message_body: 'First synthetic text, alerted while unknown' },
        { direction: 'inbound', from_phone: unknownPhone, to_phone: '+19415550192', twilio_sid: laterSid, message_body: 'Second synthetic text, after promotion' },
      ]);
      [bell] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic unknown-sender text',
        link: '/admin/communications',
        metadata: JSON.stringify({ payload: { twilioSid: alertedSid } }),
      }).returning('*');

      // Reading the alerted message must NOT be handed to the blunt by-SID
      // clear just because the conversation is now customer-linked — that
      // would clear the bell while laterMessageId sits unread with no bell
      // of its own (pre-fix: c.customer_id IS NULL excluded this SID from
      // unknownSenderSids purely on today's linkage).
      await markInboundSmsRead({ messageIds: [alertedMessageId], role: 'admin' });
      expect((await mockPg('messages').where({ id: alertedMessageId }).first()).is_read).toBe(true);
      expect((await mockPg('messages').where({ id: laterMessageId }).first()).is_read).toBe(false);
      const refreshedBell = await mockPg('notifications').where({ id: bell.id }).first();
      expect(refreshedBell.read_at).toBeNull();
      expect(refreshedBell.metadata.payload.twilioSid).toBe(laterSid);
    } finally {
      await mockPg('messages').whereIn('id', [alertedMessageId, laterMessageId]).delete();
      await mockPg('sms_log').whereIn('twilio_sid', [alertedSid, laterSid]).delete();
      if (bell) await mockPg('notifications').where({ id: bell.id }).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('retargetOrClearUnknownSenderBell — the exported decision ringSmsReplyBell\'s post-insert race check now calls directly — retargets instead of clearing when a sibling is still unread (codex #4210 round-3 P1)', async () => {
    const conversationId = randomUUID();
    const readMessageId = randomUUID();
    const stillUnreadMessageId = randomUUID();
    const readSid = `SM-synthetic-postcheck-${randomBytes(4).toString('hex')}`;
    const unreadSid = `SM-synthetic-postcheck-later-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    let bell;
    try {
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550190' });
      await mockPg('messages').insert([
        // Already read by the time the post-check runs (the exact race:
        // the thread was opened while ringSmsReplyBell's bell insert was
        // still in flight).
        { id: readMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: true, twilio_sid: readSid, body: 'Read while the bell was being written', created_at: new Date(Date.now() - 60000) },
        // A throttled sibling from the same sender, still unread, with no
        // bell of its own — its only hope is this shared bell.
        { id: stillUnreadMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: unreadSid, body: 'Still unread, throttled', created_at: new Date(Date.now() - 30000) },
      ]);
      [bell] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic unknown-sender text',
        link: '/admin/communications',
        metadata: JSON.stringify({ payload: { twilioSid: readSid } }),
      }).returning('*');

      // The exact call ringSmsReplyBell's post-insert race check now makes
      // for an unknown sender, in place of the old blind by-SID clear.
      const cleared = await retargetOrClearUnknownSenderBell(unknownPhone, new Date());
      expect(cleared).toBe(0);
      const refreshedBell = await mockPg('notifications').where({ id: bell.id }).first();
      expect(refreshedBell.read_at).toBeNull();
      expect(refreshedBell.metadata.payload.twilioSid).toBe(unreadSid);
    } finally {
      await mockPg('messages').whereIn('id', [readMessageId, stillUnreadMessageId]).delete();
      if (bell) await mockPg('notifications').where({ id: bell.id }).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('concurrently reading a promoted thread\'s two unread siblings converges on a cleared bell rather than orphaning it on an already-read message (codex #4210 round-7 P1)', async () => {
    const conversationId = randomUUID();
    const firstMessageId = randomUUID();
    const secondMessageId = randomUUID();
    const firstSid = `SM-synthetic-promoted-race-a-${randomBytes(4).toString('hex')}`;
    const secondSid = `SM-synthetic-promoted-race-b-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    let bell;
    try {
      // Promoted, both messages unread, one bell currently targeting the
      // first. Round 6 decided per-SID membership by "is this exact SID the
      // bell's current target" — a snapshot taken OUTSIDE any lock, so
      // reading the two messages as separate concurrent calls could have
      // the second miss its own membership check (the bell still targeted
      // the first at that instant), fall to a by-SID no-op, and then have
      // the first's retarget hand the bell to it anyway under the phone
      // lock — landing after the second's read had already finished,
      // orphaning the bell on an already-read message nothing revisits.
      await mockPg('conversations').insert({ id: conversationId, customer_id: ids[0], channel: 'sms', contact_phone: null, our_endpoint_id: '+19415550193' });
      await mockPg('messages').insert([
        { id: firstMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: firstSid, body: 'First synthetic text, promoted', created_at: new Date(Date.now() - 120000) },
        { id: secondMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: secondSid, body: 'Second synthetic text, promoted', created_at: new Date(Date.now() - 60000) },
      ]);
      await mockPg('sms_log').insert([
        { direction: 'inbound', from_phone: unknownPhone, to_phone: '+19415550193', twilio_sid: firstSid, message_body: 'First synthetic text, promoted' },
        { direction: 'inbound', from_phone: unknownPhone, to_phone: '+19415550193', twilio_sid: secondSid, message_body: 'Second synthetic text, promoted' },
      ]);
      [bell] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic unknown-sender text',
        link: '/admin/communications',
        metadata: JSON.stringify({ payload: { twilioSid: firstSid } }),
      }).returning('*');

      await Promise.all([
        markInboundSmsRead({ messageIds: [firstMessageId], role: 'admin' }),
        markInboundSmsRead({ messageIds: [secondMessageId], role: 'admin' }),
      ]);

      expect((await mockPg('messages').where({ id: firstMessageId }).first()).is_read).toBe(true);
      expect((await mockPg('messages').where({ id: secondMessageId }).first()).is_read).toBe(true);
      // Both messages are read, so the bell must end up cleared regardless
      // of which call's phone-lock transaction ran last.
      const refreshedBell = await mockPg('notifications').where({ id: bell.id }).first();
      expect(refreshedBell.read_at).not.toBeNull();
    } finally {
      await mockPg('messages').whereIn('id', [firstMessageId, secondMessageId]).delete();
      await mockPg('sms_log').whereIn('twilio_sid', [firstSid, secondSid]).delete();
      if (bell) await mockPg('notifications').where({ id: bell.id }).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('the sweep recovers an unread unknown-sender message once the winning claim expires unconfirmed, without a later message to reclaim it (codex #4210 round-8 P1)', async () => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const sid = `SM-synthetic-sweep-crash-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    let dispatchedWith = null;
    const dispatch = jest.fn(async (args) => {
      dispatchedWith = args;
      // Simulate a successful re-alert: write the bell a real dispatch
      // would have produced.
      await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic recovered alert',
        link: '/admin/communications',
        metadata: JSON.stringify({ payload: { twilioSid: args.MessageSid } }),
      });
      return true;
    });
    try {
      // The winning dispatch claimed, then crashed before confirm OR
      // release ever ran — the row sits with its short lease already
      // expired and no bell was ever written for this message.
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550194' });
      await mockPg('messages').insert({ id: messageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: sid, body: 'Please quote pest control', created_at: new Date(Date.now() - 300000) });
      await mockPg('sms_log').insert({ direction: 'inbound', from_phone: unknownPhone, to_phone: '+19415550194', twilio_sid: sid, message_body: 'Please quote pest control', metadata: JSON.stringify({ sms_reply_eligible: true }) });
      await mockPg('sms_reply_alert_claims').insert({ phone: unknownPhone, expires_at: new Date(Date.now() - 60000) });

      const result = await sweepUnknownSenderAlertClaims({ dispatch });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatchedWith).toMatchObject({ From: unknownPhone, MessageSid: sid });
      expect(result.dispatched).toBe(1);

      // The thread ends with a bell.
      const bells = await mockPg('notifications').whereRaw("metadata->'payload'->>'twilioSid' = ?", [sid]).where({ read_at: null }).select();
      expect(bells).toHaveLength(1);
    } finally {
      await mockPg('messages').where({ id: messageId }).delete();
      await mockPg('sms_log').where({ twilio_sid: sid }).delete();
      await mockPg('sms_reply_alert_claims').where({ phone: unknownPhone }).delete();
      await mockPg('notifications').whereRaw("metadata->'payload'->>'twilioSid' = ?", [sid]).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('the sweep also recovers a released claim (the winner observed delivery failure and released cleanly) when no later message ever arrives (codex #4210 round-8 P1)', async () => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const sid = `SM-synthetic-sweep-released-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    let dispatchedWith = null;
    const dispatch = jest.fn(async (args) => {
      dispatchedWith = args;
      await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic recovered alert',
        link: '/admin/communications',
        metadata: JSON.stringify({ payload: { twilioSid: args.MessageSid } }),
      });
      return true;
    });
    try {
      // The loser returned "handled" on the assumption the winner had it
      // covered. The winner's delivery genuinely failed and it released the
      // claim immediately (the already-correct half of the fix) — but with
      // that release, NO claims row exists at all for this phone; the loser
      // never verified anything, and no later message ever arrived to
      // reclaim it. This is the failure mode findCandidatePhones must catch
      // without relying on a claims-table row existing.
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550195' });
      await mockPg('messages').insert({ id: messageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: sid, body: 'Please quote pest control', created_at: new Date(Date.now() - 300000) });
      await mockPg('sms_log').insert({ direction: 'inbound', from_phone: unknownPhone, to_phone: '+19415550195', twilio_sid: sid, message_body: 'Please quote pest control', metadata: JSON.stringify({ sms_reply_eligible: true }) });
      // Deliberately no sms_reply_alert_claims row at all.

      const result = await sweepUnknownSenderAlertClaims({ dispatch });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatchedWith).toMatchObject({ From: unknownPhone, MessageSid: sid });
      expect(result.dispatched).toBe(1);
    } finally {
      await mockPg('messages').where({ id: messageId }).delete();
      await mockPg('sms_log').where({ twilio_sid: sid }).delete();
      await mockPg('notifications').whereRaw("metadata->'payload'->>'twilioSid' = ?", [sid]).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('the sweep never races a claim that is still genuinely active (codex #4210 round-8 P1)', async () => {
    const activeConversationId = randomUUID();
    const activeMessageId = randomUUID();
    const activeSid = `SM-synthetic-sweep-active-${randomBytes(4).toString('hex')}`;
    const activePhone = `+1941555${String(Date.now()).slice(-4)}`;
    const dispatch = jest.fn(async () => true);
    try {
      // Genuinely in-flight: claim not yet expired.
      await mockPg('conversations').insert({ id: activeConversationId, customer_id: null, channel: 'sms', contact_phone: activePhone, our_endpoint_id: '+19415550196' });
      await mockPg('messages').insert({ id: activeMessageId, conversation_id: activeConversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: activeSid, body: 'In flight', created_at: new Date(Date.now() - 5000) });
      await mockPg('sms_log').insert({ direction: 'inbound', from_phone: activePhone, to_phone: '+19415550196', twilio_sid: activeSid, message_body: 'In flight', metadata: JSON.stringify({ sms_reply_eligible: true }) });
      await mockPg('sms_reply_alert_claims').insert({ phone: activePhone, expires_at: new Date(Date.now() + 60000) });

      const result = await sweepUnknownSenderAlertClaims({ dispatch });
      expect(dispatch).not.toHaveBeenCalled();
      expect(result.dispatched).toBe(0);
      expect(result.checked).toBeGreaterThanOrEqual(1);
    } finally {
      await mockPg('messages').where({ id: activeMessageId }).delete();
      await mockPg('sms_log').where({ twilio_sid: activeSid }).delete();
      await mockPg('sms_reply_alert_claims').where({ phone: activePhone }).delete();
      await mockPg('conversations').where({ id: activeConversationId }).delete();
    }
  }, 30000);

  test('the sweep never re-dispatches a message staff already dismissed the bell for, even though the SMS itself is still unread (codex #4210 round-10 P1)', async () => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const sid = `SM-synthetic-sweep-dismissed-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    let bell;
    const dispatch = jest.fn(async () => true);
    try {
      // Delivered successfully (sms_reply_alerted stamped) — staff saw the
      // ADMIN NOTIFICATION and dismissed it (read_at set) without ever
      // opening the SMS thread, so messages.is_read stays false. The claim
      // has since expired (staff took their time). findLiveBell alone would
      // treat the dismissed bell as "nothing covering it" and re-alert on a
      // message staff already acted on.
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550201' });
      await mockPg('messages').insert({ id: messageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: sid, body: 'Please quote pest control', created_at: new Date(Date.now() - 300000) });
      await mockPg('sms_log').insert({ direction: 'inbound', from_phone: unknownPhone, to_phone: '+19415550201', twilio_sid: sid, message_body: 'Please quote pest control', metadata: JSON.stringify({ sms_reply_eligible: true, sms_reply_alerted: true }) });
      [bell] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic unknown-sender text',
        link: '/admin/communications', read_at: new Date(),
        metadata: JSON.stringify({ payload: { twilioSid: sid } }),
      }).returning('*');

      const result = await sweepUnknownSenderAlertClaims({ dispatch });
      expect(dispatch).not.toHaveBeenCalled();
      expect(result.dispatched).toBe(0);
    } finally {
      await mockPg('messages').where({ id: messageId }).delete();
      await mockPg('sms_log').where({ twilio_sid: sid }).delete();
      if (bell) await mockPg('notifications').where({ id: bell.id }).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('the sweep never re-dispatches a push-only successful delivery that never wrote a bell row at all (codex #4210 round-10 P1)', async () => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const sid = `SM-synthetic-sweep-push-only-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    const dispatch = jest.fn(async () => true);
    try {
      // ringSmsReplyBell's own "delivered" definition is bellWritten OR
      // push.sent > 0 — a push-only success stamps sms_reply_alerted just
      // the same, with no notifications row ever written for it.
      // findLiveBell would find nothing, and — pre-fix — wrongly treat this
      // as orphaned.
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550202' });
      await mockPg('messages').insert({ id: messageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: sid, body: 'Please quote pest control', created_at: new Date(Date.now() - 300000) });
      await mockPg('sms_log').insert({ direction: 'inbound', from_phone: unknownPhone, to_phone: '+19415550202', twilio_sid: sid, message_body: 'Please quote pest control', metadata: JSON.stringify({ sms_reply_eligible: true, sms_reply_alerted: true }) });

      const result = await sweepUnknownSenderAlertClaims({ dispatch });
      expect(dispatch).not.toHaveBeenCalled();
      expect(result.dispatched).toBe(0);
    } finally {
      await mockPg('messages').where({ id: messageId }).delete();
      await mockPg('sms_log').where({ twilio_sid: sid }).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('a later, genuinely failed message is still recovered even though an older message from the same phone already delivered successfully (codex #4210 round-11 P1)', async () => {
    const conversationId = randomUUID();
    const olderMessageId = randomUUID();
    const newerMessageId = randomUUID();
    const olderSid = `SM-synthetic-sweep-older-delivered-${randomBytes(4).toString('hex')}`;
    const newerSid = `SM-synthetic-sweep-newer-failed-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    const olderCreatedAt = new Date(Date.now() - 600000);
    const newerCreatedAt = new Date(Date.now() - 60000);
    let dispatchedWith = null;
    const dispatch = jest.fn(async (args) => { dispatchedWith = args; return true; });
    try {
      // The OLDER message delivered successfully and is simply still
      // unread (staff hasn't looked yet — normal). A LATER message from
      // the SAME phone then had its own dispatch genuinely fail (claim
      // released, no receipt). A phone-wide "has anything ever delivered"
      // check would let the older receipt wrongly cover the newer,
      // unrelated failure — coverage must be checked per message, at or
      // after THAT message's own arrival.
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550203' });
      await mockPg('messages').insert([
        { id: olderMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: olderSid, body: 'Delivered, still unread', created_at: olderCreatedAt },
        { id: newerMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: newerSid, body: 'Failed, needs recovery', created_at: newerCreatedAt },
      ]);
      await mockPg('sms_log').insert([
        { direction: 'inbound', from_phone: unknownPhone, to_phone: '+19415550203', twilio_sid: olderSid, message_body: 'Delivered, still unread', metadata: JSON.stringify({ sms_reply_eligible: true, sms_reply_alerted: true }), created_at: olderCreatedAt },
        { direction: 'inbound', from_phone: unknownPhone, to_phone: '+19415550203', twilio_sid: newerSid, message_body: 'Failed, needs recovery', metadata: JSON.stringify({ sms_reply_eligible: true }), created_at: newerCreatedAt },
      ]);

      const result = await sweepUnknownSenderAlertClaims({ dispatch });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatchedWith).toMatchObject({ From: unknownPhone, MessageSid: newerSid });
      expect(result.dispatched).toBe(1);
    } finally {
      await mockPg('messages').whereIn('id', [olderMessageId, newerMessageId]).delete();
      await mockPg('sms_log').whereIn('twilio_sid', [olderSid, newerSid]).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('the sweep never re-alerts an AI-answered message just because it is still unread (codex #4210 round-9 P1)', async () => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const sid = `SM-synthetic-sweep-ai-answered-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    const dispatch = jest.fn(async () => true);
    try {
      // The AI answered this text successfully — dispatchUnknownSenderAlert
      // was deliberately never called (aiAnswered suppresses it), so the
      // sms_log row carries NO sms_reply_eligible stamp, even though the
      // unified message is still unread (a human simply hasn't reviewed it
      // yet — that's normal, not a lost alert).
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550199' });
      await mockPg('messages').insert({ id: messageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: sid, body: 'What services do you offer?', created_at: new Date(Date.now() - 300000) });
      await mockPg('sms_log').insert({ direction: 'inbound', from_phone: unknownPhone, to_phone: '+19415550199', twilio_sid: sid, message_body: 'What services do you offer?' });

      const result = await sweepUnknownSenderAlertClaims({ dispatch });
      expect(dispatch).not.toHaveBeenCalled();
      expect(result.dispatched).toBe(0);
    } finally {
      await mockPg('messages').where({ id: messageId }).delete();
      await mockPg('sms_log').where({ twilio_sid: sid }).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('the sweep never re-alerts a tracking-line first contact through the sms_reply path (codex #4210 round-9 P1)', async () => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const sid = `SM-synthetic-sweep-tracking-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    const dispatch = jest.fn(async () => true);
    try {
      // A domain/van tracking number's first contact routes to new_lead,
      // not sms_reply — twilio-webhook.js excludes numberConfig.type
      // domain_tracking/van_tracking from ever calling
      // dispatchUnknownSenderAlert, so no eligibility stamp exists here
      // either. Without the stamp requirement, the sweep would fire a
      // second, wrong-type alert for a message a DIFFERENT bell already
      // covers (findLiveBell only recognizes inbound_sms-category bells).
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550200' });
      await mockPg('messages').insert({ id: messageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: sid, body: 'Interested in a quote', created_at: new Date(Date.now() - 300000) });
      await mockPg('sms_log').insert({ direction: 'inbound', from_phone: unknownPhone, to_phone: '+19415550200', twilio_sid: sid, message_body: 'Interested in a quote' });

      const result = await sweepUnknownSenderAlertClaims({ dispatch });
      expect(dispatch).not.toHaveBeenCalled();
      expect(result.dispatched).toBe(0);
    } finally {
      await mockPg('messages').where({ id: messageId }).delete();
      await mockPg('sms_log').where({ twilio_sid: sid }).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);

  test('a message arriving from the phone between the unread-check and the clear is not swept into it — the clear rechecks atomically at write time (codex #4210 round-8 P2)', async () => {
    const conversationId = randomUUID();
    const firstMessageId = randomUUID();
    const secondMessageId = randomUUID();
    const firstSid = `SM-synthetic-race-clear-a-${randomBytes(4).toString('hex')}`;
    const secondSid = `SM-synthetic-race-clear-b-${randomBytes(4).toString('hex')}`;
    const unknownPhone = `+1941555${String(Date.now()).slice(-4)}`;
    let bell;
    try {
      await mockPg('conversations').insert({ id: conversationId, customer_id: null, channel: 'sms', contact_phone: unknownPhone, our_endpoint_id: '+19415550198' });
      // The only message currently unread-eligible is already read — the
      // function's OWN `remaining` check will find nothing at the moment it
      // runs, same as the pre-fix code.
      await mockPg('messages').insert({ id: firstMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: true, twilio_sid: firstSid, body: 'Already read', created_at: new Date(Date.now() - 60000) });
      [bell] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic unknown-sender text',
        link: '/admin/communications',
        metadata: JSON.stringify({ payload: { twilioSid: firstSid } }),
      }).returning('*');

      // A second, genuinely new message from the SAME sender arrives on a
      // separate real connection concurrently with the retarget-or-clear
      // call — the phone's advisory lock only serializes OTHER
      // retarget-or-clear calls, not an ordinary inbound insert, so this is
      // not blocked by it. `remaining` can find nothing at the instant it
      // runs, then this lands before the clear's own statement executes.
      const [cleared] = await Promise.all([
        retargetOrClearUnknownSenderBell(unknownPhone, new Date()),
        mockPg('messages').insert({ id: secondMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: secondSid, body: 'Second synthetic text, arrives mid-clear', created_at: new Date() }),
      ]);

      const refreshedBell = await mockPg('notifications').where({ id: bell.id }).first();
      if (cleared > 0) {
        // The insert lost the race and landed strictly after the clear had
        // already committed — a legitimate ordering (nothing was unread at
        // clear time); secondMessageId then relies on its own separate
        // dispatch, not this call.
        expect(refreshedBell.read_at).not.toBeNull();
      } else {
        // The atomic recheck caught the new arrival — the bell must
        // survive, not be silently dropped.
        expect(refreshedBell.read_at).toBeNull();
      }
    } finally {
      await mockPg('messages').whereIn('id', [firstMessageId, secondMessageId]).delete();
      if (bell) await mockPg('notifications').where({ id: bell.id }).delete();
      await mockPg('conversations').where({ id: conversationId }).delete();
    }
  }, 30000);
});
