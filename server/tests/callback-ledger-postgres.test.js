// Opt-in against the established synthetic QA database; every test rolls back.
const run = process.env.CALLBACK_LEDGER_POSTGRES === '1' ? describe : describe.skip;
// Remote QA round trips can exceed Jest's five-second unit-test default.
jest.setTimeout(30000);
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
// audit-log is real: the card's callback_reopen event is the reopen boundary fulfillment reads.


run('callback ledger on PostgreSQL', () => {
  const { randomUUID } = require('node:crypto');
  const db = require('../models/db');
  let conn, trx, cards, gates, originalGates;
  const phone = '+15555550176';
  const now = new Date();
  const ago = new Date(now.getTime() - 3600000);
  const future = new Date(now.getTime() + 86400000);

  beforeAll(() => {
    if (process.env.WAVES_LOCAL_DEV !== '1' || !/^\/waves_qa_[a-f0-9]+$/.test(new URL(process.env.DATABASE_URL).pathname)) {
      throw new Error('Callback regression tests require the managed synthetic QA database');
    }
    conn = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    gates = require('../config/feature-gates').gates;
    originalGates = { callCommitments: gates.callCommitments, card: process.env.GATE_CALLBACK_CARD };
    gates.callCommitments = true;
    process.env.GATE_CALLBACK_CARD = 'true';
    cards = require('../services/callback-cards');
  });
  beforeEach(async () => {
    trx = await conn.transaction();
    db.mockImplementation((...args) => trx(...args));
    db.raw = trx.raw.bind(trx);
    db.transaction = trx.transaction.bind(trx);
  });
  afterEach(async () => { jest.restoreAllMocks(); await trx.rollback(); });
  afterAll(async () => {
    gates.callCommitments = originalGates.callCommitments;
    if (originalGates.card === undefined) delete process.env.GATE_CALLBACK_CARD;
    else process.env.GATE_CALLBACK_CARD = originalGates.card;
    await conn.destroy();
  });

  async function seed(patch = {}) {
    const callId = randomUUID(), id = randomUUID();
    await trx('call_log').insert({ id: callId, direction: 'inbound', from_phone: phone,
      to_phone: '+15555550100', status: 'completed', created_at: ago, updated_at: ago });
    const [row] = await trx('call_commitments').insert({ id, call_log_id: callId, commitment_key: `fixture:${id}`,
      party: 'waves', kind: 'callback', status: 'open', source: 'human', description: 'Synthetic callback',
      callback_due_at: ago, created_at: ago, updated_at: ago, ...patch }).returning('*');
    return row;
  }
  test('existing, human-created and edited callbacks receive deadlines without the notification worker', async () => {
    const ledger = require('../services/call-commitments');
    const existing = await seed({ callback_due_at: null });
    // A plain read (the Intelligence Bar tool, the integrations worker) writes nothing.
    await ledger.listOpenCommitments(trx);
    expect((await trx('call_commitments').where({ id: existing.id }).first()).callback_due_at).toBeNull();
    await ledger.listOpenCommitments(trx, { prepare: true });
    expect((await trx('call_commitments').where({ id: existing.id }).first()).callback_due_at).not.toBeNull();
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    const added = await ledger.addHumanCommitment(trx, existing.call_log_id, {
      party: 'waves', kind: 'callback', description: 'Call about the next visit', reviewedBy: staff.id, due_at: future,
    });
    expect(added.callback_due_at).not.toBeNull();
    const edited = await cards.actOnCallback(trx, added.id, { action: 'edit', actorId: staff.id,
      expectedAt: added.updated_at, due_at: null, now });
    expect(edited.due_at).toBeNull();
    expect(edited.effective_due_at).toEqual(edited.callback_due_at);
    expect(edited.callback_due_at).not.toBeNull();
  });

  test('snooze takes shared ownership and rejects a second action on the old version', async () => {
    const row = await seed();
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    expect(staff).toBeTruthy();
    const changed = await cards.actOnCallback(trx, row.id, { action: 'snooze', actorId: staff.id,
      expectedAt: row.updated_at, snooze: 'two_hours', now });
    expect(changed.assigned_to).toBe(staff.id);
    expect(changed.snoozed_until).toEqual(new Date(now.getTime() + 2 * 3600000));
    const ledger = require('../services/call-commitments');
    expect(ledger.selectOverdue([changed], { now })).toEqual([]);
    expect(await ledger.stillOpenIds(trx, [row.id], { now })).toEqual(new Set());
    expect(await ledger.stillOpenIds(trx, [row.id], { now: new Date(now.getTime() + 3 * 3600000) })).toEqual(new Set([row.id]));
    await expect(cards.actOnCallback(trx, row.id, { action: 'fulfill', actorId: staff.id,
      expectedAt: row.updated_at, now })).rejects.toMatchObject({ status: 409 });
    expect((await trx('call_commitments').where({ id: row.id }).first()).status).toBe('open');
  });

  test('a customer-scoped read prepares its own callback ahead of an older unscoped backlog', async () => {
    const ledger = require('../services/call-commitments');
    const older = new Date(ago.getTime() - 86400000);
    const backlog = Array.from({ length: 200 }, () => ({ callId: randomUUID(), id: randomUUID() }));
    await trx('call_log').insert(backlog.map(({ callId }) => ({ id: callId, direction: 'inbound', from_phone: phone,
      to_phone: '+15555550100', status: 'completed', created_at: older, updated_at: older })));
    await trx('call_commitments').insert(backlog.map(({ callId, id }) => ({ id, call_log_id: callId, commitment_key: `fixture:${id}`,
      party: 'waves', kind: 'callback', status: 'open', source: 'human', description: 'Synthetic backlog',
      callback_due_at: null, created_at: older, updated_at: older })));
    const customer = await trx('customers').first('id');
    expect(customer).toBeTruthy();
    const mine = await seed({ callback_due_at: null });
    await trx('call_log').where({ id: mine.call_log_id }).update({ customer_id: customer.id });
    const [row] = await ledger.listOpenCommitments(trx, { customerId: customer.id, kind: 'callback', prepare: true });
    expect(row.id).toBe(mine.id);
    expect(row.callback_due_at).not.toBeNull();
    expect((await trx('call_commitments').where({ id: mine.id }).first()).callback_due_at).not.toBeNull();
  });

  test('a paged walk over more than one preparation batch neither skips nor repeats callbacks', async () => {
    const ledger = require('../services/call-commitments');
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    // 210 undated AI callbacks whose CREATION order (the preparation order)
    // is the reverse of their CALL order (the deadline order): the ten
    // prepared last belong to the oldest calls and would sort first.
    const batch = Array.from({ length: 210 }, (_, i) => ({ callId: randomUUID(), id: randomUUID(),
      callAt: new Date(ago.getTime() - (210 - i) * 60000), createdAt: new Date(ago.getTime() - 3600000 + i * 1000) }));
    await trx('call_log').insert(batch.map(({ callId, callAt }) => ({ id: callId, direction: 'inbound', from_phone: phone,
      to_phone: '+15555550100', status: 'completed', duration_seconds: 60, created_at: callAt, updated_at: callAt })));
    await trx('call_commitments').insert(batch.map(({ callId, id, createdAt }) => ({ id, call_log_id: callId, commitment_key: `fixture:${id}`,
      party: 'waves', kind: 'callback', status: 'open', source: 'ai', description: 'Synthetic backlog',
      callback_due_at: null, created_at: createdAt, updated_at: createdAt })));
    const mine = new Set(batch.map((b) => b.id));
    const seen = [];
    for (let offset = 0, more = true; more;) {
      const page = await ledger.listOpenCommitments(trx, { kind: 'callback', limit: 101, offset, prepare: true, now });
      more = page.length > 100;
      seen.push(...page.slice(0, 100).map((r) => r.id).filter((id) => mine.has(id)));
      offset += 100;
    }
    expect(seen).toHaveLength(210);
    expect(new Set(seen).size).toBe(210);
    expect(staff).toBeTruthy();
    // The rows left undated by the first walk are prepared by the next first-page read.
    await ledger.listOpenCommitments(trx, { kind: 'callback', limit: 1, offset: 0, prepare: true, now });
    expect(Number((await trx('call_commitments').whereIn('id', [...mine]).whereNull('callback_due_at').count('id as n').first()).n)).toBe(0);
  }, 180000); // 210 remote preparation transactions

  test('a snoozed callback is not overdue and queues behind actionable work', async () => {
    const ledger = require('../services/call-commitments');
    const snoozed = await seed(), due = await seed({ created_at: new Date(ago.getTime() - 60000) });
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    await cards.actOnCallback(trx, snoozed.id, { action: 'snooze', actorId: staff.id, expectedAt: snoozed.updated_at, snooze: 'two_hours', now });
    const rows = (await ledger.listOpenCommitments(trx, { kind: 'callback', now })).filter((r) => [snoozed.id, due.id].includes(r.id));
    expect(rows.map((r) => [r.id, r.overdue])).toEqual([[due.id, true], [snoozed.id, false]]);
    const later = new Date(now.getTime() + 3 * 3600000);
    const rearmed = (await ledger.listOpenCommitments(trx, { kind: 'callback', now: later })).find((r) => r.id === snoozed.id);
    expect(rearmed.overdue).toBe(true);
  });

  test('an action that leaves the callback open releases its reminder identity for the next due sweep', async () => {
    const row = await seed();
    const key = `call-commitment-overdue:${row.id}:2026-09-09`;
    const [bell] = await trx('notifications').insert({ recipient_type: 'admin', category: 'alert', title: 'Fixture reminder',
      metadata: { commitment_id: row.id, dedupeKey: key } }).returning('*');
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    await cards.actOnCallback(trx, row.id, { action: 'snooze', actorId: staff.id, expectedAt: row.updated_at, snooze: 'two_hours', now });
    const after = await trx('notifications').where({ id: bell.id }).first();
    expect(after.read_at).not.toBeNull();
    expect(after.metadata.dedupeKey.startsWith(`${key}:superseded:`)).toBe(true);
    expect(await trx('notifications').whereRaw("metadata->>'dedupeKey' = ?", [key])).toEqual([]);
  });

  test('acting on one callback preserves a shared reminder for other open promises', async () => {
    const row = await seed(), other = await seed();
    const [bell] = await trx('notifications').insert({ recipient_type: 'admin', category: 'alert', title: 'Fixture backlog',
      metadata: { overdue_commitment_ids: [row.id, other.id] } }).returning('*');
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    const claimed = await cards.actOnCallback(trx, row.id, { action: 'claim', actorId: staff.id, expectedAt: row.updated_at, now });
    expect((await trx('notifications').where({ id: bell.id }).first()).read_at).toBeNull();
    await cards.actOnCallback(trx, row.id, { action: 'fulfill', actorId: staff.id, expectedAt: claimed.updated_at, now });
    expect((await trx('notifications').where({ id: bell.id }).first()).read_at).toBeNull();
  });

  test.each(['claim', 'snooze', 'release'])('%s on an AI callback records the review, so a later extraction cannot withdraw it', async (action) => {
    const ledger = require('../services/call-commitments');
    const row = await seed({ source: 'ai', last_seen_generation: 1 });
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    const acted = await cards.actOnCallback(trx, row.id, { action, actorId: staff.id, expectedAt: row.updated_at, snooze: 'two_hours', now });
    expect(acted.human_state).toBe('confirmed');
    expect(acted.reviewed_by).toBe(staff.id);
    expect(acted.updated_at).toEqual(now);
    await trx('call_commitments').insert({ call_log_id: row.call_log_id, commitment_key: 'waves:send_report',
      party: 'waves', kind: 'send_report', description: 'Newer extraction', source: 'ai', last_seen_generation: 2 });
    const live = await ledger.listOpenCommitments(trx, { kind: 'callback', now: new Date(now.getTime() + 3 * 3600000) });
    expect(live.map((r) => r.id)).toContain(row.id);
  });

  // applyHumanUpdate stamps reviewed_at from the real clock, so returned-call
  // evidence is placed strictly after the persisted review it must follow.
  const afterReview = async (id, ms = 1) => new Date(new Date((await trx('call_commitments').where({ id }).first()).reviewed_at).getTime() + ms);
  const tick = () => new Promise((resolve) => { setTimeout(resolve, 5); });
  const returnedCall = (at) => trx('call_log').insert({ id: randomUUID(), direction: 'outbound', from_phone: '+15555550100', to_phone: phone,
    status: 'completed', duration_seconds: 120, created_at: at, updated_at: at });

  test('a claimed callback still closes on returned-call evidence from before and after the claim', async () => {
    const ledger = require('../services/call-commitments');
    const row = await seed({ source: 'ai', last_seen_generation: 1 });
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    // Returned before the office claimed it: the claim must not hide it.
    await returnedCall(new Date(now.getTime() - 60000), row.call_log_id);
    await cards.actOnCallback(trx, row.id, { action: 'claim', actorId: staff.id, expectedAt: row.updated_at, now });
    expect((await trx('call_commitments').where({ id: row.id }).first()).human_state).toBe('confirmed');
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 1 });
    expect((await trx('call_commitments').where({ id: row.id }).first()).status).toBe('fulfilled');
    // Reopening the callback does not let the SAME evidence close it again;
    // only a call returned after the reopen does.
    const kept = await trx('call_commitments').where({ id: row.id }).first();
    await tick();
    await cards.actOnCallback(trx, row.id, { action: 'reopen', actorId: staff.id, expectedAt: kept.updated_at, now: new Date() });
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 0 });
    expect((await trx('call_commitments').where({ id: row.id }).first()).status).toBe('open');
    const reopenedAt = (await trx('audit_log').where({ resource_id: row.id, action: 'callback_reopen' }).first()).created_at;
    await returnedCall(new Date(new Date(reopenedAt).getTime() + 1), row.call_log_id);
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 1 });
    // A human verdict on any other promise is still never rewritten.
    const other = await seed({ source: 'ai', last_seen_generation: 1, kind: 'send_report', commitment_key: `fixture:report:${randomUUID()}` });
    await ledger.applyHumanUpdate(trx, other.id, { action: 'confirm', reviewedBy: staff.id });
    expect(await ledger.refreshFulfillment(trx, other.call_log_id)).toMatchObject({ checked: 0 });
  });

  test('an edited callback card is a new promise: only evidence after the edit closes it, even once claimed', async () => {
    const ledger = require('../services/call-commitments');
    const row = await seed({ source: 'ai', last_seen_generation: 1 });
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    await returnedCall(new Date(now.getTime() - 60000));
    await tick();
    const edited = await cards.actOnCallback(trx, row.id, { action: 'edit', actorId: staff.id, expectedAt: row.updated_at,
      description: 'Call about the revised quote', now: new Date() });
    expect(edited.human_state).toBe('edited');
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 0 });
    // A later claim overwrites reviewed_at; the edit boundary survives in the audit trail.
    const claimed = await cards.actOnCallback(trx, row.id, { action: 'claim', actorId: staff.id, expectedAt: edited.updated_at, now: new Date() });
    expect(claimed.human_state).toBe('edited');
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 0 });
    const editedAt = (await trx('audit_log').where({ resource_id: row.id, action: 'callback_edit' }).first()).created_at;
    await returnedCall(new Date(new Date(editedAt).getTime() + 1));
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 1 });
  });

  test('a save that changes nothing does not hide a call returned while the editor was open', async () => {
    const ledger = require('../services/call-commitments');
    const row = await seed({ source: 'ai', last_seen_generation: 1 });
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    const edited = await cards.actOnCallback(trx, row.id, { action: 'edit', actorId: staff.id, expectedAt: row.updated_at,
      description: 'Call about the revised quote', due_at: null, now: new Date() });
    const editedAt = (await trx('audit_log').where({ resource_id: row.id, action: 'callback_edit' }).first()).created_at;
    await returnedCall(new Date(new Date(editedAt).getTime() + 1));
    await tick();
    // The editor resubmits the same wording and deadline on Save.
    const saved = await cards.actOnCallback(trx, row.id, { action: 'edit', actorId: staff.id, expectedAt: edited.updated_at,
      description: 'Call about the revised quote', due_at: null, note: 'left as is', now: new Date() });
    expect(saved.human_state).toBe('edited');
    expect(saved.human_note).toBe('left as is');
    const audits = await trx('audit_log').where({ resource_id: row.id, action: 'callback_edit' }).orderBy('created_at', 'asc');
    expect(audits.map((a) => a.metadata.restated)).toEqual([true, false]);
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 1 });
  });

  test('a callback edited before callback cards existed keeps that review as its evidence boundary', async () => {
    const ledger = require('../services/call-commitments');
    const row = await seed({ source: 'ai', last_seen_generation: 1 });
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    await returnedCall(new Date(now.getTime() - 60000));
    await tick();
    // A pre-card row: human_state = 'edited', reviewed_at stamped, and no callback_edit event on record.
    const edited = await ledger.applyHumanUpdate(trx, row.id, { action: 'edit', description: 'Call about the fence line', reviewedBy: staff.id, renewalAudit: false });
    expect(await trx('audit_log').where({ resource_id: row.id, action: 'callback_edit' })).toEqual([]);
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 0 });
    // A later claim under callback cards leaves that boundary in place.
    await cards.actOnCallback(trx, row.id, { action: 'claim', actorId: staff.id, expectedAt: edited.updated_at, now: new Date() });
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 0 });
    // Confirming the edited card reaffirms the edit: state and review time stay.
    const claimed = await trx('call_commitments').where({ id: row.id }).first();
    await cards.actOnCallback(trx, row.id, { action: 'confirm', actorId: staff.id, expectedAt: claimed.updated_at, now: new Date() });
    const confirmed = await trx('call_commitments').where({ id: row.id }).first();
    expect(confirmed.human_state).toBe('edited');
    expect(confirmed.reviewed_at).toEqual(edited.reviewed_at);
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 0 });
    await returnedCall(await afterReview(row.id));
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 1 });
  });

  test('a card reopened through the generic path after gate rollback is a new promise', async () => {
    const ledger = require('../services/call-commitments');
    const row = await seed({ source: 'ai', last_seen_generation: 1 });
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    await cards.actOnCallback(trx, row.id, { action: 'claim', actorId: staff.id, expectedAt: row.updated_at, now });
    // A persisted card attempt keeps the row refreshable once the gate is off.
    await trx('call_log').insert({ id: randomUUID(), direction: 'outbound', from_phone: '+15555550100', to_phone: phone,
      status: 'no-answer', duration_seconds: 5, created_at: new Date(), updated_at: new Date(), metadata: { relatedCommitmentId: row.id } });
    // Returned before the claim (a claim hides nothing), and before the
    // transaction clock the audit rows below are stamped with.
    await returnedCall(new Date(now.getTime() - 60000));
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 1 });
    process.env.GATE_CALLBACK_CARD = 'false';
    try {
      await tick();
      // The PATCH route uses the generic ledger action while cards are off.
      await ledger.applyHumanUpdate(trx, row.id, { action: 'reopen', reviewedBy: staff.id });
      const reopen = await trx('audit_log').where({ resource_id: row.id, action: 'callback_reopen' }).first();
      expect(reopen).toMatchObject({ actor_type: 'technician', actor_id: staff.id });
      expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 0 });
      expect((await trx('call_commitments').where({ id: row.id }).first()).status).toBe('open');
      // A generic no-op save restates nothing; a changed wording does.
      await ledger.applyHumanUpdate(trx, row.id, { action: 'edit', description: 'Synthetic callback', due_at: null, reviewedBy: staff.id });
      await ledger.applyHumanUpdate(trx, row.id, { action: 'edit', description: 'Call about the new quote', reviewedBy: staff.id });
      const edits = await trx('audit_log').where({ resource_id: row.id, action: 'callback_edit' }).orderBy('created_at', 'asc');
      expect(edits.map((e) => e.metadata.restated)).toEqual([false, true]);
      await returnedCall(new Date(new Date(edits[1].created_at).getTime() + 1));
      expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 1 });
    } finally {
      process.env.GATE_CALLBACK_CARD = 'true';
    }
  });

  test('a human-recorded callback on an old call ignores evidence from before it was typed', async () => {
    const ledger = require('../services/call-commitments');
    const source = await seed();
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    await returnedCall(new Date(now.getTime() - 60000));
    const added = await ledger.addHumanCommitment(trx, source.call_log_id, {
      party: 'waves', kind: 'callback', description: 'Call back about the gate code', reviewedBy: staff.id,
    });
    await trx('call_commitments').where({ id: source.id }).del();
    expect(await ledger.refreshFulfillment(trx, source.call_log_id)).toMatchObject({ fulfilled: 0 });
    await returnedCall(new Date(new Date(added.created_at).getTime() + 1));
    expect(await ledger.refreshFulfillment(trx, source.call_log_id)).toMatchObject({ fulfilled: 1 });
  });

  test('a reopen that lands while proof is being looked up keeps the callback open', async () => {
    const ledger = require('../services/call-commitments');
    const row = await seed({ source: 'ai', last_seen_generation: 1 });
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    await cards.actOnCallback(trx, row.id, { action: 'claim', actorId: staff.id, expectedAt: row.updated_at, now });
    await returnedCall(await afterReview(row.id));
    const source = await trx('call_log').where({ id: row.call_log_id }).first();
    // The evidence lookup yields to a concurrent reopen before it resolves;
    // the source call is passed in so that lookup is the first call_log read.
    let interleaved = false;
    const racing = (table) => {
      const builder = trx(table);
      if (table === 'call_log' && !interleaved) {
        interleaved = true;
        const then = builder.then.bind(builder);
        builder.then = (resolve, reject) => tick().then(() => trx('call_commitments').where({ id: row.id }).first())
          .then((current) => cards.actOnCallback(trx, row.id, { action: 'reopen', actorId: staff.id, expectedAt: current.updated_at, now: new Date() }))
          .then(() => then(resolve, reject));
      }
      return builder;
    };
    expect(await ledger.refreshFulfillment(racing, row.call_log_id, source)).toMatchObject({ fulfilled: 0 });
    expect(interleaved).toBe(true);
    const after = await trx('call_commitments').where({ id: row.id }).first();
    expect(after.status).toBe('open');
    // In production the reopen is its own transaction, so its audit row is
    // stamped at that moment; inside this single rolled-back transaction
    // now() is the transaction start, so stamp the boundary explicitly.
    await trx('audit_log').where({ resource_id: row.id, action: 'callback_reopen' }).update({ created_at: new Date() });
    expect(await ledger.refreshFulfillment(trx, row.call_log_id)).toMatchObject({ fulfilled: 0 });
  });

  test.each(['confirm', 'edit', 'claim'])('a newer extraction rejects a stale %s action without reviving the callback', async (action) => {
    const row = await seed({ source: 'ai', last_seen_generation: 1 });
    await trx('call_commitments').insert({ call_log_id: row.call_log_id, commitment_key: 'waves:send_report',
      party: 'waves', kind: 'send_report', description: 'Newer extraction', source: 'ai', last_seen_generation: 2 });
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    expect(staff).toBeTruthy();
    await expect(cards.actOnCallback(trx, row.id, { action, actorId: staff.id, expectedAt: row.updated_at,
      description: 'Edited stale callback' })).rejects.toMatchObject({ status: 409 });
    const unchanged = await trx('call_commitments').where({ id: row.id }).first();
    expect(unchanged.human_state).toBeNull();
    expect(unchanged.updated_at).toEqual(row.updated_at);
  });

  test('the fallback is independent of a stated date and refreshes when extraction changes the source timing', async () => {
    const ledger = require('../services/call-commitments');
    const row = await seed({ source: 'ai', callback_due_at: null, due_at: future, last_seen_generation: 1 });
    await cards.prepareCallbackCards(trx, { callId: row.call_log_id });
    const calendar = await cards.loadCalendar(trx, ago);
    const first = await trx('call_commitments').where({ id: row.id }).first();
    expect(first.callback_due_at).toEqual(cards.staffedDeadline(ago, calendar));
    expect(first.due_at).toEqual(future);
    await trx('call_commitments').where({ id: row.id }).update({ commitment_key: 'waves:callback' });
    await trx('call_log').where({ id: row.call_log_id }).update({ processing_generation: 2, duration_seconds: 7200 });
    await ledger.upsertCommitments(trx, row.call_log_id, [{ party: 'waves', kind: 'callback', description: 'Call back', due_at: null }],
      { generation: 2, procGeneration: 2 });
    const changed = await trx('call_commitments').where({ id: row.id }).first();
    expect(changed.callback_due_at).toBeNull();
    await cards.prepareCallbackCards(trx, { callId: row.call_log_id });
    const source = await trx('call_log').where({ id: row.call_log_id }).first();
    const ended = ledger.callEndedAt(source);
    const currentCalendar = await cards.loadCalendar(trx, ended);
    const current = await trx('call_commitments').where({ id: row.id }).first();
    expect(current.due_at).toBeNull();
    expect(current.callback_due_at).toEqual(cards.staffedDeadline(ended, currentCalendar));
  });

  test.each([[true, true], [false, false]])('re-extraction preserves a fallback when reviewed=%s and cards enabled=%s', async (reviewed, enabled) => {
    const row = await seed({ source: 'ai', human_state: reviewed ? 'confirmed' : null, last_seen_generation: 1 });
    await trx('call_commitments').where({ id: row.id }).update({ commitment_key: 'waves:callback' });
    const gate = process.env.GATE_CALLBACK_CARD;
    process.env.GATE_CALLBACK_CARD = String(enabled);
    try {
      await require('../services/call-commitments').upsertCommitments(trx, row.call_log_id,
        [{ party: 'waves', kind: 'callback', description: 'New extraction', due_at: future }], { generation: 2 });
      expect((await trx('call_commitments').where({ id: row.id }).first()).callback_due_at).toEqual(row.callback_due_at);
    } finally { process.env.GATE_CALLBACK_CARD = gate; }
  });

  test('preparation cannot install a deadline computed before a concurrent row update', async () => {
    const row = await seed({ callback_due_at: null });
    const duringPrepare = (...args) => trx(...args);
    duringPrepare.raw = trx.raw.bind(trx);
    duringPrepare.transaction = async (fn) => {
      await trx('call_commitments').where({ id: row.id }).update({ due_at: future, updated_at: future });
      return trx.transaction(fn);
    };
    await cards.prepareCallbackCards(duringPrepare, { callId: row.call_log_id });
    const current = await trx('call_commitments').where({ id: row.id }).first();
    expect(current.callback_due_at).toBeNull();
    expect(current.due_at).toEqual(future);
    expect(current.updated_at).toEqual(future);
  });

});
