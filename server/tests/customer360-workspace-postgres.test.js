// Opt-in integration checks against this worktree's migrated Railway dev database.
// Uses synthetic records only; queries are real and fixtures are removed by id.
// No application DATABASE_URL or provider client is used.
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  Object.defineProperty(db, 'schema', { get: () => mockPg.schema });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ markInboundSmsReadAdmin: jest.fn().mockResolvedValue(0) }));
const { randomUUID, randomBytes } = require('node:crypto');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const { invoiceOverdueSql, invoiceDaysOverdue } = require('../services/collections/account-anchor');
const router = require('../routes/admin-customers');
const { countUnreadInboundSms, markInboundSmsRead } = require('../services/inbound-sms-read');
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
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic unknown-sender text',
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
});
