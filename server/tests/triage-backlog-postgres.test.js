const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const { lockTriageCall } = require('../utils/triage-locks');
const { sweepBacklog, revertBacklog, parseOptions, AUDIT_CUTOFF } = require('../../ops/agents/triage-backlog-sweep');

describe('backlog command validation', () => {
  test.each([['--execute', '--revert'], ['--execute', '--revert='], ['--execute', '--revert=invalid'], ['--execute', '--stale-days=oops'], ['--execute', '--unknown']])('rejects malformed command %j', (...args) => {
    expect(() => parseOptions(args)).toThrow();
  });
  test('reversal requires a tag and defaults to dry run', () => {
    expect(parseOptions(['--revert=triage-backlog-sweep-example'])).toMatchObject({ execute: false, revert: 'triage-backlog-sweep-example' });
    expect(parseOptions(['--execute', '--revert', 'triage-backlog-sweep-example'])).toMatchObject({ execute: true, revert: 'triage-backlog-sweep-example' });
  });
});

jest.setTimeout(60000);
(SKIP ? describe.skip : describe)('historical backlog maintenance on PostgreSQL', () => {
  const schema = `triage_backlog_${randomUUID().replaceAll('-', '')}`;
  const tables = ['call_log', 'triage_items', 'scheduled_services'];
  // Keep relationship/booking tests independent of how long ago the audit ran.
  const noAging = { staleDays: 100000, advisoryDays: 100000 };
  const tag = `triage-backlog-sweep-test-${randomUUID()}`;
  let database;
  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    await database.raw("CREATE UNIQUE INDEX triage_items_open_unique_idx ON ??.triage_items (call_log_id, reason_code) WHERE status IN ('open', 'in_progress')", [schema]);
    await database.raw("CREATE FUNCTION ??.reject_aggregate() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic aggregate failure'; END $$ LANGUAGE plpgsql", [schema]);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await database.raw('DROP TRIGGER IF EXISTS reject_aggregate ON ??.call_log', [schema]);
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.??', [schema, table]);
  });
  afterAll(async () => { await database.raw('DROP SCHEMA ?? CASCADE', [schema]); await database.destroy(); });

  async function fixture({ reason = 'low_extraction_confidence', relationship = 'unknown', old = false, status = 'open', booked = false, afterAudit = false } = {}) {
    const created_at = new Date(Date.parse(AUDIT_CUTOFF) + (afterAudit ? 60000 : -(old ? 40 : 1) * 86400000));
    const call = { id: randomUUID(), created_at, review_status: 'open', ai_extraction_enriched: { caller: { relationship_to_property: relationship } } };
    const card = { id: randomUUID(), call_log_id: call.id, reason_code: reason, severity: reason === 'name_email_mismatch' ? 'advisory' : 'blocking', status, created_at };
    await database('call_log').insert(call);
    await database('triage_items').insert(card);
    if (booked) await database('scheduled_services').insert({ id: randomUUID(), source_call_log_id: call.id, status: 'confirmed', created_at: new Date(created_at.getTime() + 3600000) });
    return { call, card };
  }
  const sweep = (extra = {}) => sweepBacklog(database, { ...noAging, tag, ...extra });

  test('dry run reports eligible cards without changing cards or aggregates', async () => {
    const { card, call } = await fixture();
    expect(await sweep()).toMatchObject({ dryRun: true, applied: 0, plannedByRule: { retired_flag: 1 },
      plannedCards: [{ id: card.id, call_log_id: call.id, reason_code: card.reason_code, from: 'open', to: 'dismissed', rule: 'retired_flag' }],
      plannedCalls: [{ id: call.id, from: 'open', to: 'dismissed' }],
    });
    expect(await database('triage_items').where({ id: card.id }).first()).toMatchObject({ status: 'open', resolution_note: null });
    expect((await database('call_log').where({ id: call.id }).first()).review_status).toBe('open');
  });
  test.each([
    [{ reason: 'caller_not_authorized', relationship: 'tenant' }, false],
    [{ reason: 'caller_not_authorized', relationship: 'tenant', booked: true }, false],
    [{ reason: 'caller_not_authorized', relationship: 'spouse_partner', booked: true }, true],
    [{ reason: 'caller_not_authorized', relationship: 'spouse_partner' }, true],
    [{ reason: 'missing_unit_number', old: true, booked: true }, false],
    [{ status: 'in_progress', old: true }, false],
    [{ reason: 'cancellation_request', booked: true }, false],
    [{ reason: 'address_unverified', booked: true }, true],
    [{ afterAudit: true }, false],
  ])('historical eligibility and exclusions: %j', async (options, dismiss) => {
    const { card } = await fixture(options);
    expect((await sweep({ execute: true })).applied).toBe(dismiss ? 1 : 0);
    expect((await database('triage_items').where({ id: card.id }).first()).status).toBe(dismiss ? 'dismissed' : card.status);
  });
  test.each(['name_email_mismatch', 'cancellation_request'])('aged %s cards use the configured age pass', async reason => {
    await fixture({ reason, old: true });
    expect((await sweep({ execute: true, staleDays: 30, advisoryDays: 30 })).applied).toBe(1);
  });
  test.each(['parent_service_id', 'recurring_parent_id', 'followup_source_service_id'])('child visits cannot stand in for a parent booking: %s', async childLink => {
    const { call, card } = await fixture({ reason: 'address_unverified' });
    const customerId = randomUUID();
    await database('call_log').where({ id: call.id }).update({ customer_id: customerId });
    const parent = { id: randomUUID(), customer_id: customerId, status: 'completed', created_at: new Date(call.created_at.getTime() - 86400000) };
    const child = { id: randomUUID(), customer_id: customerId, status: 'pending', created_at: new Date(call.created_at.getTime() + 3600000), [childLink]: parent.id };
    await database('scheduled_services').insert([parent, child]);
    expect((await sweep()).plannedCards).toEqual([]);
    expect((await sweep({ execute: true })).applied).toBe(0);
    expect((await database('triage_items').where({ id: card.id }).first()).status).toBe('open');
    // A real new parent booking in the same window still satisfies the coarse rule.
    await database('scheduled_services').where({ id: child.id }).update({ [childLink]: null });
    expect((await sweep({ execute: true })).applied).toBe(1);
  });

  async function whileCallLocked(callId, operation, mutate) {
    const blocker = await database.transaction();
    await lockTriageCall(blocker, callId);
    let requested; let timeout; let pending;
    const reachedLock = new Promise(resolve => { requested = resolve; });
    const listener = query => { if (query.sql.includes('pg_advisory_xact_lock')) requested(); };
    database.on('query', listener);
    try {
      pending = operation();
      await Promise.race([reachedLock, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('writer did not request the shared call lock')), 5000); })]);
      clearTimeout(timeout);
      await mutate(blocker);
      await blocker.commit();
      return await pending;
    } finally {
      clearTimeout(timeout);
      database.removeListener('query', listener);
      await blocker.rollback();
      if (pending) await pending.catch(() => {});
    }
  }
  test('an admin changing relationship under the call lock invalidates the earlier classification', async () => {
    const { call, card } = await fixture({ reason: 'caller_not_authorized' });
    const result = await whileCallLocked(call.id, () => sweep({ execute: true }), trx =>
      trx('call_log').where({ id: call.id }).update({ ai_extraction_enriched: { caller: { relationship_to_property: 'tenant' } } }));
    expect(result.applied).toBe(0);
    expect((await database('triage_items').where({ id: card.id }).first()).status).toBe('open');
  });
  test('an admin claim on a sibling keeps the aggregate open after the sweep', async () => {
    const { call, card } = await fixture();
    const sibling = { ...card, id: randomUUID(), reason_code: 'name_email_mismatch' };
    await database('triage_items').insert(sibling);
    expect((await sweep()).plannedCalls).toEqual([]);
    const result = await whileCallLocked(call.id, () => sweep({ execute: true }), trx =>
      trx('triage_items').where({ id: sibling.id }).update({ status: 'in_progress' }));
    expect(result.applied).toBe(1);
    expect((await database('call_log').where({ id: call.id }).first()).review_status).toBe('open');
  });
  test('revert is dry by default, idempotent, and cannot overwrite a later human resolution', async () => {
    const { call, card } = await fixture();
    await sweep({ execute: true });
    expect(await revertBacklog(database, tag)).toMatchObject({ applied: 0,
      plannedCards: [{ id: card.id, call_log_id: call.id, reason_code: card.reason_code, from: 'dismissed', to: 'open', rule: 'revert_run_tag' }],
      plannedCalls: [{ id: call.id, from: 'dismissed', to: 'open' }],
    });
    const result = await whileCallLocked(call.id, () => revertBacklog(database, tag, { execute: true }), trx =>
      trx('triage_items').where({ id: card.id }).update({ status: 'resolved', resolution_source: 'human' }));
    expect(result.applied).toBe(0);
    const second = await fixture();
    await sweep({ execute: true });
    expect((await revertBacklog(database, tag, { execute: true })).applied).toBe(1);
    expect((await database('call_log').where({ id: second.call.id }).first()).review_status).toBe('open');
    expect((await revertBacklog(database, tag, { execute: true })).applied).toBe(0);
  });
  test.each(['open', 'in_progress'])('reversal skips a new %s recurrence under the call lock without aborting other calls', async status => {
    const { call, card } = await fixture();
    const second = await fixture();
    await sweep({ execute: true });
    const recurrence = { ...card, id: randomUUID(), status };
    const result = await whileCallLocked(call.id, () => revertBacklog(database, tag, { execute: true }), async trx => {
      await trx('triage_items').insert(recurrence);
      await trx('call_log').where({ id: call.id }).update({ review_status: 'open' });
    });
    expect(result.applied).toBe(1);
    expect((await database('triage_items').where({ id: card.id }).first()).status).toBe('dismissed');
    expect((await database('triage_items').where({ id: recurrence.id }).first()).status).toBe(status);
    expect((await database('triage_items').where({ id: second.card.id }).first()).status).toBe('open');
    expect((await revertBacklog(database, tag)).plannedCards).toEqual([]);
  });
  test.each(['apply', 'revert'])('%s rolls back card transitions if aggregate synchronization fails', async operation => {
    const { card } = await fixture();
    if (operation === 'revert') await sweep({ execute: true });
    await database.raw('CREATE TRIGGER reject_aggregate BEFORE UPDATE ON ??.call_log FOR EACH ROW EXECUTE FUNCTION ??.reject_aggregate()', [schema, schema]);
    await expect(operation === 'apply' ? sweep({ execute: true }) : revertBacklog(database, tag, { execute: true })).rejects.toThrow('synthetic aggregate failure');
    expect((await database('triage_items').where({ id: card.id }).first()).status).toBe(operation === 'apply' ? 'open' : 'dismissed');
  });
});
