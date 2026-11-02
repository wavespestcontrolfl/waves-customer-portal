/**
 * Follow-up due alerts (owner 2026-11-02, B1) against live Postgres, through the real reads, the real notification
 * service and the real alert episodes, under the production bell policy (GATE_ADMIN_BELL_POLICY on, so a row lands
 * only because it asks to ring). Proves the SQL side of "covered" (a later visit created after the card, a visit
 * dated inside the due + 7 day window, a visit booked from the card's visit, an inactive customer, a resolved card),
 * one own alert per uncovered card on its due date, the catch-up row for an old card, raise-once on a repeat run, and
 * the close when a visit gets booked. It reads every open follow_up_needed card in the database, so it asserts on
 * its own cards only. It refuses any database but a private QA one or CI's.
 */
process.env.GATE_ADMIN_BELL_POLICY = 'true'; // read once, when feature-gates loads
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('follow-up due alerts (live Postgres)', () => {
  let db;
  let FollowupDue;
  const NOW = new Date('2026-11-02T13:20:00Z'); // 8:20 AM Eastern, Monday
  const customers = [];
  const visits = [];
  const cards = [];
  const keysFor = () => [...cards.map((id) => `followup-due:${id}`), 'followup-due-older'];

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    FollowupDue = require('../services/followup-due-alerts');
  });

  const clearNotifications = () => db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ANY(?::text[])", [keysFor()]).del();

  afterAll(async () => {
    if (!db) return;
    await clearNotifications();
    await db('dispatch_alerts').whereIn('id', cards).del();
    await db('scheduled_services').whereIn('id', visits).update({ followup_source_service_id: null });
    await db('scheduled_services').whereIn('id', visits).del();
    await db('customers').whereIn('id', customers).del();
  });

  async function customer(over = {}) {
    const id = randomUUID();
    await db('customers').insert({ id, first_name: 'Pat', last_name: 'Synthetic', phone: '+15555550100', ...over });
    customers.push(id);
    return id;
  }

  async function visit(customerId, { day, createdAt, over = {} }) {
    const id = randomUUID();
    await db('scheduled_services').insert({
      id, customer_id: customerId, scheduled_date: day, service_type: 'Quarterly Pest Control Service', status: 'completed', created_at: createdAt, ...over,
    });
    visits.push(id);
    return id;
  }

  // A flagged follow-up: the completed source visit plus its dispatch card, created 2026-10-20.
  async function flagged({ due, resolved = false, customerOver = {} }) {
    const customerId = await customer(customerOver);
    const sourceId = await visit(customerId, { day: '2026-10-20', createdAt: '2026-10-01T12:00:00Z' });
    const [alert] = await db('dispatch_alerts').insert({
      type: 'follow_up_needed', severity: 'info', job_id: sourceId, created_at: '2026-10-20T15:00:00Z',
      resolved_at: resolved ? '2026-10-25T15:00:00Z' : null,
      payload: JSON.stringify({ customerId, serviceType: 'Quarterly Pest Control Service', suggestedFollowupDate: due }),
    }).returning('id');
    cards.push(alert.id);
    return { cardId: alert.id, customerId, sourceId };
  }

  const ownRows = (cardId) => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [`followup-due:${cardId}`]);
  const catchUp = () => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = 'followup-due-older'").first();
  const run = (now = NOW) => FollowupDue.runFollowupDueAlerts({ now, gateEnabled: true });

  test('one own alert per uncovered due card, none for covered ones, one catch-up for the old card, closed when booked', async () => {
    const due = await flagged({ due: '2026-11-02' });
    const old = await flagged({ due: '2026-08-20' });
    const future = await flagged({ due: '2026-11-20' });
    const later = await flagged({ due: '2026-11-01' });
    await visit(later.customerId, { day: '2026-12-15', createdAt: '2026-10-21T12:00:00Z' });
    const windowed = await flagged({ due: '2026-10-31' });
    await visit(windowed.customerId, { day: '2026-11-03', createdAt: '2026-10-10T12:00:00Z' });
    const sourced = await flagged({ due: '2026-11-01' });
    await visit(sourced.customerId, { day: '2026-09-01', createdAt: '2026-10-02T12:00:00Z', over: { followup_source_service_id: sourced.sourceId } });
    const cancelled = await flagged({ due: '2026-11-01' });
    await visit(cancelled.customerId, { day: '2026-11-04', createdAt: '2026-10-21T12:00:00Z', over: { status: 'cancelled' } });
    const churned = await flagged({ due: '2026-11-01', customerOver: { active: false, pipeline_stage: 'churned' } });
    const resolved = await flagged({ due: '2026-11-01', resolved: true });

    const first = await run();
    expect(first.raised).toBeGreaterThanOrEqual(2); // the due-today card and the card whose only later visit was cancelled
    expect(first.listed).toBeGreaterThanOrEqual(1);

    const [dueRow] = await ownRows(due.cardId);
    expect(dueRow.category).toBe('schedule');
    expect(dueRow.title).toBe("Schedule — book Pat S.'s follow-up (due Nov 2)");
    expect(dueRow.body).toBe('Quarterly Pest Control Service follow-up you flagged on Oct 20; no visit is booked.');
    expect(dueRow.link).toBe(`/admin/customers?customerId=${due.customerId}`);
    expect(dueRow.read_at).toBeNull();
    expect(dueRow.metadata).toMatchObject({
      promise: true, dispatchAlertId: due.cardId, customerId: due.customerId, doneWhen: 'followup_booked', severity: 'needs-you', area: 'Schedule',
      subject: { type: 'visit', id: due.sourceId },
    });
    expect(await ownRows(cancelled.cardId)).toHaveLength(1);
    for (const none of [old, future, later, windowed, sourced, churned, resolved]) expect(await ownRows(none.cardId)).toHaveLength(0);

    const list = await catchUp();
    expect(list.title).toMatch(/^Schedule — book \d+ older follow-ups?$/);
    expect(list.metadata.itemKeys).toContain(old.cardId);
    expect(list.metadata.itemKeys).not.toContain(due.cardId);
    expect(list.detail).toContain('Pat S. · Quarterly Pest Control Service · due Aug 20 (74 days ago)');
    expect(list.read_at).toBeNull();

    // A repeat run writes nothing new: one row per card, the same catch-up row, quiet.
    await db('notifications').where({ id: list.id }).update({ read_at: new Date('2026-11-02T14:00:00Z') });
    const second = await run();
    expect(second.raised).toBe(0);
    expect(await ownRows(due.cardId)).toHaveLength(1);
    const again = await catchUp();
    expect(again.id).toBe(list.id);
    expect(again.read_at).not.toBeNull();

    // Booking a visit for the due card and for the old card closes the first and drops the second off the list.
    await visit(due.customerId, { day: '2026-11-10', createdAt: '2026-11-02T14:00:00Z' });
    await visit(old.customerId, { day: '2026-11-12', createdAt: '2026-11-02T14:00:00Z' });
    const third = await run(new Date('2026-11-02T14:30:00Z'));
    expect(third.closed).toBeGreaterThanOrEqual(1);
    const [closedRow] = await ownRows(due.cardId);
    expect(closedRow.done_at).not.toBeNull();
    expect(closedRow.resolution).toBe('Follow-up booked');
    expect(closedRow.metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'followup_booked' });
    const shrunk = await catchUp();
    expect(shrunk.done_at !== null || !shrunk.metadata.itemKeys.includes(old.cardId)).toBe(true);
    expect(await ownRows(cancelled.cardId)).toHaveLength(1);
  });
});
