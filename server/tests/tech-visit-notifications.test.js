// tech-visit-notifications.js — the assigned field tech's card + one-line
// push for assignment / removal / move / cancel (Field Team Program Phase 0
// item 2). Silent rules are the contract: gate off, the actor's own change,
// a non-assignable recipient. A push failure never loses the card.
// The feed insert, as (technicianId, row) with the payload parsed back —
// resolve false to fail the insert.
const mockWriteCard = jest.fn().mockResolvedValue(undefined);
const mockSendToAdminUser = jest.fn().mockResolvedValue({ sent: 1 });

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/push-notifications', () => ({
  sendToAdminUser: (...args) => mockSendToAdminUser(...args),
}));

const db = require('../models/db');
// The card transaction (lock + check + insert) runs against the same mock.
const transactions = [];
db.transaction = (fn) => { transactions.push(fn); return fn(db); };
db.raw = jest.fn((sql) => sql);
function cardsTable() {
  return {
    insert: jest.fn(async (row) => {
      const ok = await mockWriteCard(row.technician_id, { ...row, payload: JSON.parse(row.payload) });
      if (ok === false) throw new Error('insert failed');
    }),
  };
}
const logger = require('../services/logger');
const notices = require('../services/tech-visit-notifications');

const TECH = { id: 'tech-1', name: 'Tech One', employment_status: 'active', field_dispatchable: true };
const ADAM_ID = '11111111-1111-4111-8111-111111111111';
const ADAM = { id: ADAM_ID, name: 'Adam Benetti', employment_status: 'active', field_dispatchable: true };
const VISIT = {
  id: 'visit-1', service_type: 'Pest Control', scheduled_date: '2026-09-10', window_start: '09:00:00', window_end: '11:00:00',
  technician_id: 'tech-1', status: 'confirmed', cust_first_name: 'Ana', cust_last_name: 'Ruiz', cust_address: '4312 Cortez Rd W', cust_city: 'Bradenton',
};

function chain(first, firstImpl = null) {
  const c = {};
  for (const m of ['where', 'leftJoin', 'select', 'forShare']) c[m] = jest.fn(() => c);
  c.first = jest.fn(firstImpl || (async () => first));
  return c;
}

// technicians rows by id; one visit row for scheduled_services.
function prime({ techs = { 'tech-1': TECH, [ADAM_ID]: ADAM }, visit = VISIT } = {}) {
  db.mockImplementation((table) => {
    if (table === 'technicians') {
      const c = chain(null);
      c.where = jest.fn((arg) => { c.first = jest.fn(async () => techs[arg.id] || null); return c; });
      return c;
    }
    if (table === 'scheduled_services as s') return chain(visit);
    if (table === 'tech_notifications') return cardsTable();
    throw new Error(`unexpected table ${table}`);
  });
}

describe('notifyTechVisitChange', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_TECH_VISIT_NOTIFICATIONS = 'true';
    prime();
  });
  afterAll(() => { delete process.env.GATE_TECH_VISIT_NOTIFICATIONS; });

  test('gate off (unset) → nothing is read or written', async () => {
    delete process.env.GATE_TECH_VISIT_NOTIFICATIONS;
    const out = await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1', actorId: ADAM_ID });
    expect(out).toEqual({ sent: false, skipped: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
    expect(mockWriteCard).not.toHaveBeenCalled();
  });

  test('the actor is never told about their own change (Adam assigning Adam)', async () => {
    const out = await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: ADAM_ID, actorId: ADAM_ID });
    expect(out).toEqual({ sent: false, skipped: 'self' });
    expect(mockWriteCard).not.toHaveBeenCalled();
    expect(mockSendToAdminUser).not.toHaveBeenCalled();
  });

  test.each([
    ['prospective placeholder', { employment_status: 'prospective', field_dispatchable: false }],
    ['inactive account', { employment_status: 'inactive', field_dispatchable: true }],
    ['office-only admin', { employment_status: 'active', field_dispatchable: false }],
  ])('a %s never receives a card or a push', async (_label, row) => {
    prime({ techs: { 'tech-9': { id: 'tech-9', name: 'Tech Nine', ...row }, [ADAM_ID]: ADAM } });
    const out = await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-9', actorId: ADAM_ID });
    expect(out).toEqual({ sent: false, skipped: 'not_assignable' });
    expect(mockWriteCard).not.toHaveBeenCalled();
  });

  test('assigned: one feed row with the composed card + the one-line push', async () => {
    const out = await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1', actorId: ADAM_ID });
    expect(out).toEqual({ sent: true });
    expect(mockWriteCard).toHaveBeenCalledTimes(1);
    const [techId, row] = mockWriteCard.mock.calls[0];
    expect(techId).toBe('tech-1');
    expect(row.type).toBe('visit_assigned');
    expect(row.message).toBe('New visit on your route: Ruiz — Pest Control · Thu Sep 10, 9–11 AM · 4312 Cortez Rd W, Bradenton · Assigned by Adam');
    expect(row.payload).toMatchObject({
      kind: 'assigned', visit_id: 'visit-1', headline: 'New visit on your route', customer_name: 'Ruiz',
      service_type: 'Pest Control', when: 'Thu Sep 10, 9–11 AM', address: '4312 Cortez Rd W, Bradenton', actor: 'by Adam',
    });
    // Owner ruling 2026-09-05: the push is one line, no details.
    expect(mockSendToAdminUser).toHaveBeenCalledWith('tech-1', expect.objectContaining({
      title: 'You have a new visit on your route', body: '', url: '/tech', tag: 'visit-visit-1',
    }));
  });

  test('unassigned names who has it now; rescheduled carries the previous slot; cancelled names the actor', async () => {
    // Each card is prepared against the row the change COMMITTED.
    prime({ visit: { ...VISIT, technician_id: ADAM_ID } });
    await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'unassigned', technicianId: 'tech-1', actorId: ADAM_ID });
    expect(mockWriteCard.mock.calls[0][1]).toMatchObject({
      type: 'visit_unassigned',
      payload: { headline: 'Moved off your route', now_with: 'Adam Benetti', actor: 'by Adam' },
    });

    prime();
    await notices.notifyTechVisitChange({
      visitId: 'visit-1', kind: 'rescheduled', technicianId: 'tech-1', actorId: 'customer_self_serve',
      previous: { date: '2026-09-09', windowStart: '13:00', windowEnd: '15:00' },
    });
    expect(mockWriteCard.mock.calls[1][1]).toMatchObject({
      type: 'visit_rescheduled',
      payload: { headline: 'Visit moved', previous_when: 'Wed Sep 9, 1–3 PM', when: 'Thu Sep 10, 9–11 AM', actor: 'by the customer online' },
    });

    prime({ visit: { ...VISIT, status: 'cancelled' } });
    await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'cancelled', technicianId: 'tech-1', actorId: ADAM_ID });
    expect(mockWriteCard.mock.calls[2][1]).toMatchObject({
      type: 'visit_cancelled',
      payload: { headline: 'Visit cancelled', actor: 'by Adam' },
    });
    expect(mockSendToAdminUser).toHaveBeenLastCalledWith('tech-1', expect.objectContaining({ title: 'A visit on your route was cancelled' }));
  });

  test('a text-reply move (reschedule-sms actor customer_sms) reads "by text", not "online"', async () => {
    await notices.notifyTechVisitChange({
      visitId: 'visit-1', kind: 'rescheduled', technicianId: 'tech-1', actorId: 'customer_sms',
      previous: { date: '2026-09-09', windowStart: '13:00', windowEnd: '15:00' },
    });
    expect(mockWriteCard.mock.calls[0][1].payload.actor).toBe('by the customer by text');
  });

  test('a card the committed row already contradicts is dropped (deploy overlap: two instances, two queues)', async () => {
    // assigned / rescheduled: the row must still name the recipient.
    prime({ visit: { ...VISIT, technician_id: ADAM_ID } });
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1' })).toEqual({ sent: false, skipped: 'stale' });
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'rescheduled', technicianId: 'tech-1' })).toEqual({ sent: false, skipped: 'stale' });
    // unassigned: the row must NOT name them any more.
    prime();
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'unassigned', technicianId: 'tech-1' })).toEqual({ sent: false, skipped: 'stale' });
    // cancelled: a compensated (reverted) cancel never reaches the tech.
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'cancelled', technicianId: 'tech-1' })).toEqual({ sent: false, skipped: 'stale' });
    // assigned / rescheduled on a visit that has since ended: nothing to announce.
    prime({ visit: { ...VISIT, status: 'cancelled' } });
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1' })).toEqual({ sent: false, skipped: 'stale' });
    prime({ visit: { ...VISIT, status: 'completed' } });
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'rescheduled', technicianId: 'tech-1' })).toEqual({ sent: false, skipped: 'stale' });
    expect(mockWriteCard).not.toHaveBeenCalled();
    expect(mockSendToAdminUser).not.toHaveBeenCalled();
  });

  test('a moved-off card on a visit that has since ended names the terminal state, never "Now with B" (the previous holder still hears it)', async () => {
    prime({ visit: { ...VISIT, status: 'completed', technician_id: ADAM_ID } });
    await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'unassigned', technicianId: 'tech-1', actorId: ADAM_ID });
    expect(mockWriteCard.mock.calls[0][1]).toMatchObject({
      type: 'visit_unassigned',
      payload: { headline: 'Moved off your route', now_with: null, ended: 'completed', actor: 'by Adam' },
    });
    expect(mockWriteCard.mock.calls[0][1].message).toContain('Now completed');
    expect(mockWriteCard.mock.calls[0][1].message).not.toContain('Now with');
    prime({ visit: { ...VISIT, status: 'no_show', technician_id: ADAM_ID } });
    await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'unassigned', technicianId: 'tech-1' });
    expect(mockWriteCard.mock.calls[1][1].payload).toMatchObject({ now_with: null, ended: 'a no-show' });
    // A live visit still names the holder.
    prime({ visit: { ...VISIT, technician_id: ADAM_ID } });
    await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'unassigned', technicianId: 'tech-1' });
    expect(mockWriteCard.mock.calls[2][1].payload).toMatchObject({ now_with: 'Adam Benetti', ended: null });
  });

  test('a voice-agent booking still pending office review is silent to everyone — reassigned, moved, or cancelled; once confirmed it announces', async () => {
    prime({ visit: { ...VISIT, status: 'pending', source_action: 'voice_agent' } });
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1' })).toEqual({ sent: false, skipped: 'stale' });
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'rescheduled', technicianId: 'tech-1' })).toEqual({ sent: false, skipped: 'stale' });
    prime({ visit: { ...VISIT, status: 'pending', source_action: 'voice_agent', technician_id: ADAM_ID } });
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'unassigned', technicianId: 'tech-1' })).toEqual({ sent: false, skipped: 'stale' });
    // Cancelled straight from pending: the row reads cancelled now, so the
    // writer's pre-transition status is what keeps it silent.
    prime({ visit: { ...VISIT, status: 'cancelled', source_action: 'voice_agent' } });
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'cancelled', technicianId: 'tech-1', previousStatus: 'pending' })).toEqual({ sent: false, skipped: 'stale' });
    expect(mockWriteCard).not.toHaveBeenCalled();
    // A confirmed voice booking that is cancelled DOES tell its tech.
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'cancelled', technicianId: 'tech-1', previousStatus: 'confirmed' })).toEqual({ sent: true });
    // A pending row from any OTHER creator (announced at insert) still notifies.
    prime({ visit: { ...VISIT, status: 'pending', source_action: 'outbound_callback' } });
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1' })).toEqual({ sent: true });
    prime({ visit: { ...VISIT, status: 'confirmed', source_action: 'voice_agent' } });
    expect(await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1' })).toEqual({ sent: true });
  });

  test('a failed feed insert means NO push for that card (a push with no card behind it sends the tech to an empty feed)', async () => {
    mockWriteCard.mockResolvedValueOnce(false);
    const out = await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1', actorId: ADAM_ID });
    expect(out).toEqual({ sent: false, skipped: 'error' });
    expect(mockSendToAdminUser).not.toHaveBeenCalled();
    // The insert error's message carries the SQL with its bound values (the
    // customer's name and address) — the log line names the visit and the
    // driver code only.
    const logged = logger.error.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('card not written for visit visit-1');
    expect(logged).not.toContain('insert failed');
    expect(logged).not.toContain('Ruiz');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('card not written'));
  });

  test('the card carries the unit (line 2) — the tech has no details link to find the door', async () => {
    prime({ visit: { ...VISIT, address_line2: 'Apt 4' } });
    await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1' });
    expect(mockWriteCard.mock.calls[0][1].payload.address).toBe('4312 Cortez Rd W, Apt 4, Bradenton');
    prime({ visit: { ...VISIT, service_address_line1: '88 Palm Ave', address_line2: 'Unit 12', service_address_city: 'Parrish' } });
    await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1' });
    expect(mockWriteCard.mock.calls[1][1].payload.address).toBe('88 Palm Ave, Unit 12, Parrish');
    // The line-2 column is the canonical stamped-vs-customer resolution, on the visit read.
    expect(db.raw).toHaveBeenCalledWith(expect.stringContaining('as address_line2'));
  });

  test('the card names the visit\'s stamped service address when one exists (a different property than the address on file)', async () => {
    prime({ visit: { ...VISIT, service_address_line1: '88 Palm Ave', service_address_city: 'Parrish' } });
    await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1', actorId: ADAM_ID });
    expect(mockWriteCard.mock.calls[0][1].payload.address).toBe('88 Palm Ave, Parrish');
  });

  test('the committed snapshot fills the card when it matches the row; a snapshot the row has moved past is dropped (the later move\'s own card lands)', async () => {
    // Matching snapshot (the hook wrote exactly what the row holds): fills the card.
    await notices.notifyTechVisitChange({
      visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1', actorId: ADAM_ID,
      snapshot: { date: '2026-09-10', windowStart: '09:00', windowEnd: '11:00' },
    });
    expect(mockWriteCard.mock.calls[0][1].payload.when).toBe('Thu Sep 10, 9–11 AM');
    expect(mockSendToAdminUser).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();
    // Superseded: the row was moved again after this hook committed.
    const out = await notices.notifyTechVisitChange({
      visitId: 'visit-1', kind: 'rescheduled', technicianId: 'tech-1', actorId: ADAM_ID,
      previous: { date: '2026-09-09', windowStart: '13:00', windowEnd: '15:00' },
      snapshot: { date: '2026-09-12', windowStart: '13:00', windowEnd: '15:00' },
    });
    expect(out).toEqual({ sent: false, skipped: 'stale' });
    // Only supplied fields are compared: a date-only snapshot on the row's date passes.
    await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1', actorId: ADAM_ID, snapshot: { date: '2026-09-10' } });
    expect(mockWriteCard).toHaveBeenCalledTimes(1);
    expect(mockWriteCard).not.toHaveBeenCalledWith('tech-1', expect.objectContaining({ type: 'visit_rescheduled' }));
  });

  test('a push failure is logged and the card still counts as sent', async () => {
    mockSendToAdminUser.mockRejectedValueOnce(new Error('apns down'));
    const out = await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1', actorId: ADAM_ID });
    expect(out).toEqual({ sent: true });
    expect(mockWriteCard).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('push failed'));
  });

  test('a read failure never throws to the writer', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1' }))
      .resolves.toEqual({ sent: false, skipped: 'error' });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('notifyAssignmentChange (both sides of a tech change)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_TECH_VISIT_NOTIFICATIONS = 'true';
    prime({ techs: { 'tech-1': TECH, 'tech-2': { ...TECH, id: 'tech-2', name: 'Tech Two' }, [ADAM_ID]: ADAM } });
  });

  test('previous holder hears it left, new holder hears it arrived; the actor is skipped on their own side', async () => {
    prime({ techs: { 'tech-1': TECH, 'tech-2': { ...TECH, id: 'tech-2', name: 'Tech Two' }, [ADAM_ID]: ADAM }, visit: { ...VISIT, technician_id: 'tech-2' } });
    await notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: 'tech-1', toTechId: 'tech-2', actorId: ADAM_ID });
    expect(mockWriteCard.mock.calls.map(([id, row]) => [id, row.type])).toEqual([
      ['tech-1', 'visit_unassigned'],
      ['tech-2', 'visit_assigned'],
    ]);
    jest.clearAllMocks();
    // Adam takes it himself: only the tech who lost it hears.
    prime({ techs: { 'tech-1': TECH, 'tech-2': { ...TECH, id: 'tech-2', name: 'Tech Two' }, [ADAM_ID]: ADAM }, visit: { ...VISIT, technician_id: ADAM_ID } });
    await notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: 'tech-1', toTechId: ADAM_ID, actorId: ADAM_ID });
    expect(mockWriteCard.mock.calls.map(([id, row]) => [id, row.type])).toEqual([['tech-1', 'visit_unassigned']]);
  });

  test('both cards are written BEFORE any push is awaited (a slow push cannot reorder a rapid A→B, B→C)', async () => {
    prime({ techs: { 'tech-1': TECH, 'tech-2': { ...TECH, id: 'tech-2', name: 'Tech Two' }, [ADAM_ID]: ADAM }, visit: { ...VISIT, technician_id: 'tech-2' } });
    const order = [];
    mockWriteCard.mockImplementation(async (techId, row) => { order.push(`card:${techId}:${row.type}`); return true; });
    mockSendToAdminUser.mockImplementation(async (techId) => {
      order.push(`push:${techId}`);
      await new Promise((r) => setTimeout(r, 5));
    });
    await notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: 'tech-1', toTechId: 'tech-2', actorId: ADAM_ID });
    expect(order).toEqual(['card:tech-1:visit_unassigned', 'card:tech-2:visit_assigned', 'push:tech-1', 'push:tech-2']);
    mockWriteCard.mockResolvedValue(undefined);
    mockSendToAdminUser.mockResolvedValue({ sent: 1 });
  });

  test('two changes to the same visit apply in call order even when the first one reads slower (A→B, then B→C)', async () => {
    const order = [];
    mockWriteCard.mockImplementation(async (techId, row) => { order.push(`${techId}:${row.type}`); return true; });
    // The first hook's visit read is slow; the second's is instant.
    let visitReads = 0;
    db.mockImplementation((table) => {
      if (table === 'technicians') {
        const c = { where: jest.fn((arg) => { c.first = jest.fn(async () => ({ ...TECH, id: arg.id, name: arg.id })); return c; }), first: jest.fn() };
        return c;
      }
      if (table === 'scheduled_services as s') {
        // The row as each hook's reads see it: B→C commits after the first
        // hook's two reads (one per side), so those see B, the rest see C.
        const row = { ...VISIT, technician_id: visitReads < 2 ? 'tech-2' : 'tech-3' };
        const slow = visitReads++ === 0;
        return chain(null, slow ? () => new Promise((r) => setTimeout(() => r(row), 20)) : () => Promise.resolve(row));
      }
      if (table === 'tech_notifications') return cardsTable();
      throw new Error(`unexpected table ${table}`);
    });
    const first = notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: 'tech-1', toTechId: 'tech-2', actorId: ADAM_ID });
    const second = notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: 'tech-2', toTechId: 'tech-3', actorId: ADAM_ID });
    await Promise.all([first, second]);
    expect(order).toEqual([
      'tech-1:visit_unassigned', 'tech-2:visit_assigned',
      'tech-2:visit_unassigned', 'tech-3:visit_assigned',
    ]);
    expect(notices._test.visitQueues.size).toBe(0);
    mockWriteCard.mockResolvedValue(undefined);
  });

  test('A→B then B→C both committed before the first card is prepared: B hears only "moved off" — the stale "new visit" is dropped, C hears it arrived', async () => {
    const order = [];
    mockWriteCard.mockImplementation(async (techId, row) => { order.push(`${techId}:${row.type}`); return true; });
    db.mockImplementation((table) => {
      if (table === 'technicians') {
        const c = { where: jest.fn((arg) => { c.first = jest.fn(async () => ({ ...TECH, id: arg.id, name: arg.id })); return c; }), first: jest.fn() };
        return c;
      }
      if (table === 'scheduled_services as s') return chain({ ...VISIT, technician_id: 'tech-3' });
      if (table === 'tech_notifications') return cardsTable();
      throw new Error(`unexpected table ${table}`);
    });
    await Promise.all([
      notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: 'tech-1', toTechId: 'tech-2', actorId: ADAM_ID }),
      notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: 'tech-2', toTechId: 'tech-3', actorId: ADAM_ID }),
    ]);
    expect(order).toEqual(['tech-1:visit_unassigned', 'tech-2:visit_unassigned', 'tech-3:visit_assigned']);
    // A's card names who holds the visit NOW (the row), not the hook's own
    // destination B — A never gets a B→C notice to correct it.
    expect(mockWriteCard.mock.calls[0][1].payload.now_with).toBe('tech-3');
    mockWriteCard.mockResolvedValue(undefined);
  });

  test('the stale check and the feed insert share ONE transaction with the visit row locked (no transition can land between them)', async () => {
    transactions.length = 0;
    const reads = [];
    db.mockImplementation((table) => {
      if (table === 'technicians') {
        const c = { where: jest.fn((arg) => { c.first = jest.fn(async () => ({ ...TECH, id: arg.id, name: arg.id })); return c; }), first: jest.fn() };
        return c;
      }
      if (table === 'scheduled_services as s') {
        const c = chain(null, async () => { reads.push(c.forShare.mock.calls[0]); return { ...VISIT, technician_id: 'tech-2' }; });
        return c;
      }
      if (table === 'tech_notifications') {
        return { insert: jest.fn(async () => { reads.push('insert'); }) };
      }
      throw new Error(`unexpected table ${table}`);
    });
    await notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-2', actorId: ADAM_ID });
    // One transaction; inside it the row read is FOR SHARE OF s, then the insert.
    expect(transactions).toHaveLength(1);
    expect(reads).toEqual([['s'], 'insert']);
  });

  test('a direct creation notice queues behind a pending change for the same visit', async () => {
    const order = [];
    mockWriteCard.mockImplementation(async (techId, row) => { order.push(`${techId}:${row.type}`); return true; });
    let visitReads = 0;
    db.mockImplementation((table) => {
      if (table === 'technicians') {
        const c = { where: jest.fn((arg) => { c.first = jest.fn(async () => ({ ...TECH, id: arg.id, name: arg.id })); return c; }), first: jest.fn() };
        return c;
      }
      if (table === 'scheduled_services as s') {
        // The creation's read sees its own row; the change commits after it.
        const row = { ...VISIT, technician_id: visitReads < 1 ? 'tech-1' : 'tech-2' };
        const slow = visitReads++ === 0;
        return chain(null, slow ? () => new Promise((r) => setTimeout(() => r(row), 20)) : () => Promise.resolve(row));
      }
      if (table === 'tech_notifications') return cardsTable();
      throw new Error(`unexpected table ${table}`);
    });
    const creation = notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1', actorId: 'customer_self_serve' });
    const change = notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: 'tech-1', toTechId: 'tech-2', actorId: ADAM_ID });
    await Promise.all([creation, change]);
    expect(order).toEqual(['tech-1:visit_assigned', 'tech-1:visit_unassigned', 'tech-2:visit_assigned']);
    mockWriteCard.mockResolvedValue(undefined);
  });

  test('notifyVisitCancelled without a technicianId reads the assigned tech from the row', async () => {
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') {
        const c = { where: jest.fn(() => c), first: jest.fn(async () => ({ technician_id: 'tech-1' })) };
        return c;
      }
      if (table === 'technicians') {
        const c = { where: jest.fn(() => c), first: jest.fn(async () => TECH) };
        return c;
      }
      if (table === 'scheduled_services as s') return chain({ ...VISIT, status: 'cancelled' });
      if (table === 'tech_notifications') return cardsTable();
      throw new Error(`unexpected table ${table}`);
    });
    await notices.notifyVisitCancelled({ visitId: 'visit-1' });
    expect(mockWriteCard).toHaveBeenCalledWith('tech-1', expect.objectContaining({ type: 'visit_cancelled' }));
  });

  test('no change (same tech, or both null) is a no-op; gate off never reads', async () => {
    expect(notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: 'tech-1', toTechId: 'tech-1' })).toBeNull();
    expect(notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: null, toTechId: null })).toBeNull();
    delete process.env.GATE_TECH_VISIT_NOTIFICATIONS;
    expect(notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: 'tech-1', toTechId: 'tech-2' })).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('a creation notice handed a caller trx waits for that commit too', async () => {
    let resolveCommit;
    const trx = { executionPromise: new Promise((res) => { resolveCommit = res; }) };
    notices.notifyTechVisitChange({ visitId: 'visit-1', kind: 'assigned', technicianId: 'tech-1', actorId: 'customer_estimate_accept', trx });
    await Promise.resolve();
    expect(mockWriteCard).not.toHaveBeenCalled();
    resolveCommit();
    await new Promise((r) => setImmediate(r));
    expect(mockWriteCard).toHaveBeenCalledWith('tech-1', expect.objectContaining({ type: 'visit_assigned' }));
    expect(mockWriteCard.mock.calls[0][1].payload.actor).toBe('by the customer online');
  });

  test('inside a caller transaction the notice waits for the OUTERMOST commit and is dropped on rollback', async () => {
    prime({ techs: { 'tech-1': TECH, 'tech-2': { ...TECH, id: 'tech-2', name: 'Tech Two' }, [ADAM_ID]: ADAM }, visit: { ...VISIT, technician_id: 'tech-2' } });
    let resolveCommit; let rejectCommit;
    const trx = { executionPromise: new Promise((res, rej) => { resolveCommit = res; rejectCommit = rej; }) };
    notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: 'tech-1', toTechId: 'tech-2', actorId: ADAM_ID, trx });
    await Promise.resolve();
    expect(mockWriteCard).not.toHaveBeenCalled();
    resolveCommit();
    await new Promise((r) => setImmediate(r));
    expect(mockWriteCard).toHaveBeenCalledTimes(2);

    jest.clearAllMocks();
    const rolled = { executionPromise: new Promise((_res, rej) => { rejectCommit = rej; }) };
    notices.notifyAssignmentChange({ visitId: 'visit-1', fromTechId: 'tech-1', toTechId: 'tech-2', actorId: ADAM_ID, trx: rolled });
    rejectCommit(new Error('rollback'));
    await new Promise((r) => setImmediate(r));
    expect(mockWriteCard).not.toHaveBeenCalled();
  });
});

describe('formatWhen', () => {
  const { formatWhen } = notices._test;
  test('ET day label + compressed window', () => {
    expect(formatWhen('2026-09-10', '09:00:00', '11:00:00')).toBe('Thu Sep 10, 9–11 AM');
    expect(formatWhen('2026-09-10', '11:00', '13:00')).toBe('Thu Sep 10, 11 AM–1 PM');
    expect(formatWhen('2026-09-10', '09:30', null)).toBe('Thu Sep 10, 9:30 AM');
    expect(formatWhen(new Date('2026-09-10T12:00:00Z'), null, null)).toBe('Thu Sep 10');
    expect(formatWhen(null, '09:00', '11:00')).toBeNull();
  });
});
