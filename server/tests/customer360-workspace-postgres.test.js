// Opt-in integration checks against this worktree's migrated Railway dev database.
// Uses synthetic records only; queries are real and fixtures are removed by id.
// No application DATABASE_URL or provider client is used.
jest.mock('../models/db', () => {
  const db = (...args) => {
    if (args[0] === 'messages as m' && mockMembershipFailure) throw new Error('Synthetic membership lookup failure');
    return mockPg(...args);
  };
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (work) => mockPg.transaction((trx) => {
    const connection = (table) => {
      const query = trx(table);
      if (table === 'messages as m' && mockAfterRemainingRead) {
        const first = query.first.bind(query);
        query.first = async (...args) => {
          const row = await first(...args);
          const afterRead = mockAfterRemainingRead;
          mockAfterRemainingRead = null;
          await afterRead();
          return row;
        };
      }
      return query;
    };
    connection.raw = trx.raw.bind(trx);
    return work(connection);
  });
  Object.defineProperty(db, 'schema', { get: () => mockPg.schema });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  markInboundSmsReadAdmin: (...args) => jest.requireActual('../services/notification-service').markInboundSmsReadAdmin(...args),
  scopeAdminFeedToRole: (...args) => jest.requireActual('../services/notification-service').scopeAdminFeedToRole(...args),
}));
const { randomUUID, randomBytes } = require('node:crypto');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const { invoiceOverdueSql, invoiceDaysOverdue } = require('../services/collections/account-anchor');
const router = require('../routes/admin-customers');
const { countUnreadInboundSms, markInboundSmsRead, retargetOrClearUnknownSenderBell } = require('../services/inbound-sms-read');
const { appendMessage } = require('../services/conversations');
const realNotificationService = jest.requireActual('../services/notification-service');
const { openBalanceSummary } = require('../services/open-balance');
const connection = process.env.C360_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const ids = Array.from({ length: 4 }, () => randomUUID());
const prefix = `C360-${randomBytes(4).toString('hex')}`;
let mockPg;
let mockAfterRemainingRead;
let mockMembershipFailure;
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

  // Reuse one synthetic sender fixture across identity, scope and race cases.
  async function withSender({ promoted = false, crossNumber = false, bellAfterEntry = false } = {}, run) {
    const phone = `+1941${randomBytes(4).readUInt32BE().toString().padStart(10, '0').slice(-7)}`;
    const conversationIds = [randomUUID(), randomUUID()];
    const messageIds = [randomUUID(), randomUUID()];
    const sids = messageIds.map(id => `SM-synthetic-${id}`);
    let bell;
    try {
      await mockPg('conversations').insert(conversationIds.map((id, i) => ({
        id, customer_id: promoted ? ids[3] : null, channel: 'sms',
        contact_phone: promoted ? null : phone, our_endpoint_id: `+1941555029${i}`,
      })));
      await mockPg('messages').insert(messageIds.map((id, i) => ({
        id, conversation_id: conversationIds[crossNumber ? i : 0], channel: 'sms',
        direction: 'inbound', author_type: 'lead', is_read: false, twilio_sid: sids[i],
        body: 'Synthetic sender text', created_at: new Date(Date.now() - (2 - i) * 60000),
      })));
      if (promoted) await mockPg('sms_log').insert(sids.map(twilio_sid => ({
        direction: 'inbound', from_phone: phone, to_phone: '+19415550290',
        twilio_sid, message_body: 'Synthetic promoted twin', customer_id: ids[3], is_read: false,
      })));
      [bell] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic sender bell',
        link: '/admin/communications', metadata: JSON.stringify({ payload: { twilioSid: sids[0] } }),
        created_at: new Date(Date.now() + (bellAfterEntry ? 300000 : -60000)),
      }).returning('*');
      await run({ phone, conversationIds, messageIds, sids, bell,
        readBell: () => mockPg('notifications').where({ id: bell.id }).first() });
    } finally {
      mockAfterRemainingRead = null; mockMembershipFailure = false;
      await mockPg('sms_log').whereIn('twilio_sid', sids).delete();
      await mockPg('messages').whereIn('conversation_id', conversationIds).delete();
      if (bell) await mockPg('notifications').where({ id: bell.id }).delete();
      await mockPg('conversations').whereIn('id', conversationIds).delete();
    }
  }

  test.each([
    ['same conversation', {}], ['different business numbers', { crossNumber: true }],
    ['promoted conversation with durable legacy sender', { promoted: true, crossNumber: true }],
  ])('sender bell retargets to an unread sibling in %s', async (_name, options) => {
    await withSender(options, async ({ messageIds, sids, readBell }) => {
      await markInboundSmsRead({ messageIds: [messageIds[0]], role: 'admin' });
      expect((await readBell()).read_at).toBeNull();
      expect((await readBell()).metadata.payload.twilioSid).toBe(sids[1]);
      expect((await mockPg('messages').where({ id: messageIds[1] }).first()).is_read).toBe(false);
      await markInboundSmsRead({ messageIds: [messageIds[1]], role: 'admin' });
      expect((await readBell()).read_at).not.toBeNull();
    });
  }, 30000);

  test('promoted reads clear their linked bell while preserving the generic unread sibling', async () => {
    await withSender({ promoted: true }, async ({ messageIds, sids, readBell }) => {
      const [linked] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic linked bell',
        link: `/admin/communications?thread=${ids[3]}`, metadata: JSON.stringify({ payload: { twilioSid: sids[0] } }),
        created_at: new Date(Date.now() - 60000),
      }).returning('id');
      try {
        await markInboundSmsRead({ messageIds: [messageIds[0]], role: 'admin' });
        expect((await mockPg('notifications').where({ id: linked.id }).first()).read_at).not.toBeNull();
        expect((await readBell()).read_at).toBeNull();
        expect((await readBell()).metadata.payload.twilioSid).toBe(sids[1]);
      } finally { await mockPg('notifications').where({ id: linked.id }).delete(); }
    });
  }, 30000);

  test('membership failure cannot clear a generic bell with an unread sibling', async () => {
    await withSender({}, async ({ messageIds, sids, readBell }) => {
      mockMembershipFailure = true;
      await markInboundSmsRead({ messageIds: [messageIds[0]], role: 'admin' });
      expect((await readBell()).read_at).toBeNull();
      expect((await readBell()).metadata.payload.twilioSid).toBe(sids[0]);
    });
  });

  test.each(['message IDs', 'conversation IDs'])('retrying %s reconciles a bell after the first read lock times out', async input => {
    await withSender({}, async ({ phone, messageIds, conversationIds, readBell }) => {
      const scope = input === 'message IDs' ? { messageIds }
        : { conversationIds, readBefore: new Date() };
      const lock = await mockPg.transaction();
      try {
        await lock.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`inbound_sms_bell_retarget:${phone}`]);
        expect(await markInboundSmsRead({ ...scope, role: 'admin' })).toMatchObject({ updated: 2, notificationsCleared: 0 });
        expect((await readBell()).read_at).toBeNull();
      } finally { await lock.rollback(); }
      // Both rows are already read, so the retry updates no messages. It
      // must still revisit the sender bell that the timed-out attempt left.
      expect(await markInboundSmsRead({ ...scope, role: 'admin' })).toMatchObject({ updated: 0, notificationsCleared: 1 });
      expect((await readBell()).read_at).not.toBeNull();
    });
  }, 30000);

  test('technician reads cannot retarget or clear hidden sender bells', async () => {
    await withSender({}, async ({ messageIds, sids, readBell }) => {
      // Legacy metadata without a techVisible trigger is hidden by default.
      await markInboundSmsRead({ messageIds: [messageIds[0]], role: 'technician' });
      expect((await readBell()).metadata.payload.twilioSid).toBe(sids[0]);
      expect((await readBell()).read_at).toBeNull();
      await markInboundSmsRead({ messageIds: [messageIds[1]], role: 'technician' });
      expect((await readBell()).metadata.payload.twilioSid).toBe(sids[0]);
      expect((await readBell()).read_at).toBeNull();
    });
  }, 30000);

  test('conversation-ID reads clear the sender bell once all scoped messages are read', async () => {
    await withSender({}, async ({ conversationIds, readBell }) => {
      await markInboundSmsRead({ conversationIds, readBefore: new Date(), role: 'admin' });
      expect((await readBell()).read_at).not.toBeNull();
    });
  }, 30000);

  test.each([false, true])('concurrent sender reads converge after promotion=%s', async (promoted) => {
    await withSender({ promoted }, async ({ messageIds, readBell }) => {
      await Promise.all(messageIds.map(id => markInboundSmsRead({ messageIds: [id], role: 'admin' })));
      expect((await readBell()).read_at).not.toBeNull();
    });
  }, 30000);

  test('a read preserves a bell created after request entry', async () => {
    await withSender({ bellAfterEntry: true }, async ({ messageIds, readBell }) => {
      await markInboundSmsRead({ messageIds, role: 'admin' });
      expect((await readBell()).read_at).toBeNull();
    });
  }, 30000);

  test('clear rechecks unread messages inserted after its initial SELECT', async () => {
    await withSender({}, async ({ phone, conversationIds, messageIds, readBell }) => {
      await mockPg('messages').whereIn('id', messageIds).update({ is_read: true });
      // This writer deliberately omits the phone lock. Insert on another
      // connection after the real SELECT completes and before the UPDATE.
      mockAfterRemainingRead = () => mockPg('messages').insert({
        conversation_id: conversationIds[0], channel: 'sms', direction: 'inbound',
        author_type: 'lead', is_read: false, twilio_sid: `SM-race-${randomUUID()}`, body: 'New arrival',
      });
      expect(await retargetOrClearUnknownSenderBell(phone, new Date())).toBe(0);
      expect((await readBell()).read_at).toBeNull();
    });
  }, 30000);

  test('an inbound append waits for the sender read-clear lock before committing', async () => {
    await withSender({}, async ({ phone, conversationIds }) => {
      const sid = `SM-append-${randomUUID()}`;
      let lockTrx;
      let appended;
      try {
        lockTrx = await mockPg.transaction();
        await lockTrx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`inbound_sms_bell_retarget:${phone}`]);
        appended = appendMessage({ conversationId: conversationIds[0], channel: 'sms', direction: 'inbound',
          authorType: 'lead', contactPhone: phone, twilioSid: sid, body: 'Synthetic locked append' })
          .then(value => ({ value }), error => ({ error }));
        let waiter;
        const deadline = Date.now() + 2000;
        do {
          ({ rows: [waiter] } = await mockPg.raw("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory' LIMIT 1"));
          if (!waiter) await new Promise(resolve => setTimeout(resolve, 10));
        } while (!waiter && Date.now() < deadline);
        expect(waiter).toBeDefined();
        expect(await mockPg('messages').where({ twilio_sid: sid }).first()).toBeUndefined();
        await lockTrx.commit();
        lockTrx = null;
        const result = await appended;
        if (result.error) throw result.error;
        expect(result.value.twilio_sid).toBe(sid);
      } finally {
        if (lockTrx) await lockTrx.rollback();
        if (appended) await appended;
      }
    });
  }, 30000);

  test('SID-only notification clears bind one or several SIDs and preserve unrelated bells', async () => {
    const sids = [randomUUID(), randomUUID(), randomUUID()];
    const bells = [];
    try {
      for (const sid of sids) bells.push((await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: 'Synthetic SID bell',
        link: '/admin/communications', metadata: JSON.stringify({ payload: { twilioSid: sid } }),
        created_at: new Date(Date.now() - 60000),
      }).returning('*'))[0]);
      expect(await realNotificationService.markInboundSmsReadAdmin({ twilioSids: sids.slice(0, 2), role: 'admin' })).toBe(2);
      expect((await mockPg('notifications').where({ id: bells[2].id }).first()).read_at).toBeNull();
      expect(await realNotificationService.markInboundSmsReadAdmin({ twilioSid: sids[2], role: 'admin' })).toBe(1);
    } finally { await mockPg('notifications').whereIn('id', bells.map(bell => bell.id)).delete(); }
  }, 30000);

});
