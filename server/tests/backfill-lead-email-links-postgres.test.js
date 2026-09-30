// The email lead/estimate link backfill on a real Postgres. Runs only with
// LEAD_EMAIL_LINKS_TEST_DATABASE_URL (or CI's DATABASE_URL). TEMP tables shadow
// any real ones for this connection (pool max 1), so nothing durable is written.
// Synthetic ids and addresses only.
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const backfill = require('../../scripts/backfill-lead-email-links');

const url = process.env.LEAD_EMAIL_LINKS_TEST_DATABASE_URL || process.env.DATABASE_URL;
const pg = url ? describe : describe.skip;

pg('backfill-lead-email-links on Postgres', () => {
  let db;
  const ids = {};
  const logs = [];
  const log = (l) => logs.push(l);

  const insertMail = (row) => db('email_messages').insert({
    id: randomUUID(), recipient_type: 'lead', recipient_email_snapshot: 'prospect@example.test', status: 'sent', ...row,
  });
  const linkOf = async (id) => db('email_messages').where({ id }).first('lead_id', 'estimate_id', 'recipient_type', 'recipient_id', 'updated_at');

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: url, pool: { min: 1, max: 1 } });
    await db.raw(`
      CREATE TEMP TABLE email_messages (id uuid PRIMARY KEY, recipient_type text, recipient_id text, recipient_email_snapshot text, status text,
        template_key text, trigger_event_id text, idempotency_key text, automation_run_id text, html_snapshot text,
        updated_at timestamp DEFAULT '2026-01-01', lead_id uuid, estimate_id uuid);
      CREATE TEMP TABLE estimates (id uuid PRIMARY KEY, token text, customer_id uuid);
      CREATE TEMP TABLE leads (id uuid PRIMARY KEY, estimate_id uuid, customer_id uuid, deleted_at timestamp, created_at timestamp DEFAULT now());
      CREATE TEMP TABLE email_template_automation_runs (id uuid PRIMARY KEY, entity_type text, entity_id text);
    `);
    Object.assign(ids, {
      cust: randomUUID(), estA: randomUUID(), estB: randomUUID(), estC: randomUUID(), leadA: randomUUID(), leadA2: randomUUID(),
      leadB: randomUUID(), run: randomUUID(),
    });
    await db('estimates').insert([
      { id: ids.estA, token: 'tokenAAAA1111', customer_id: ids.cust },
      { id: ids.estB, token: 'tokenBBBB2222', customer_id: null },
      { id: ids.estC, token: 'tokenCCCC3333', customer_id: null },
    ]);
    await db('leads').insert([
      { id: ids.leadA, estimate_id: ids.estA, customer_id: ids.cust, created_at: '2026-01-01' },
      { id: ids.leadA2, estimate_id: ids.estA, customer_id: null, created_at: '2026-02-01' }, // newer lead on the same estimate wins
      { id: ids.leadB, estimate_id: ids.estB, customer_id: null, deleted_at: '2026-03-01' }, // deleted: never linked
    ]);
    await db('email_template_automation_runs').insert({ id: ids.run, entity_type: 'estimate', entity_id: ids.estB });
  });
  afterAll(async () => { if (db) await db.destroy(); });

  test('dry run reads only: reports the plan and changes nothing (READ ONLY transaction)', async () => {
    ids.byTrigger = randomUUID(); ids.byRun = randomUUID(); ids.byLink = randomUUID(); ids.byRecipient = randomUUID();
    ids.none = randomUUID(); ids.ambiguous = randomUUID(); ids.customerTyped = randomUUID(); ids.already = randomUUID();
    await insertMail({ id: ids.byTrigger, template_key: 'estimate.delivery', trigger_event_id: `estimate_delivery:${ids.estA}` });
    await insertMail({ id: ids.byRun, template_key: 'estimate.engage_expiring', automation_run_id: ids.run, trigger_event_id: 'engage:x' });
    await insertMail({ id: ids.byLink, template_key: 'estimate.deposit_abandoned', html_snapshot: '<a href="https://portal.example.test/estimate/tokenCCCC3333">view</a>' });
    await insertMail({ id: ids.byRecipient, template_key: 'quote.request_received', recipient_id: ids.leadA, trigger_event_id: `quote_request_received:${ids.leadA}` });
    await insertMail({ id: ids.none, template_key: 'estimate.delivery', trigger_event_id: 'no ids here' });
    // two different estimates named: refuse to guess
    await insertMail({ id: ids.ambiguous, template_key: 'estimate.delivery', trigger_event_id: `a:${ids.estA}`, idempotency_key: `b:${ids.estB}` });
    await insertMail({ id: ids.customerTyped, template_key: 'invoice.sent', recipient_type: 'customer', recipient_id: ids.cust, trigger_event_id: `x:${ids.estA}` });
    await insertMail({ id: ids.already, template_key: 'estimate.delivery', trigger_event_id: `estimate_delivery:${ids.estA}`, estimate_id: ids.estB });

    const before = await db('email_messages').orderBy('id').select();
    logs.length = 0;
    const out = await backfill.run({ execute: false, dbh: db, log });
    expect(out.totals).toMatchObject({ candidates: 6, linked: 4, unresolved: 2, written: 0 });
    expect(await db('email_messages').orderBy('id').select()).toEqual(before);
    const text = logs.join('\n');
    expect(text).toMatch(/DRY RUN \(no writes\)/);
    expect(text).toMatch(/Nothing was written/);
    expect(text).not.toMatch(/example\.test/); // no addresses in the report
  });

  test('the dry run opens a READ ONLY transaction and issues no UPDATE', async () => {
    // (Postgres still lets a READ ONLY transaction write TEMP tables, so the
    // guarantee is asserted on the statements sent, and holds on real tables.)
    const sql = [];
    const spy = (q) => sql.push(q.sql);
    db.on('query', spy);
    try {
      await backfill.run({ execute: false, dbh: db, log });
    } finally { db.removeListener('query', spy); }
    expect(sql.some((q) => /SET TRANSACTION READ ONLY/i.test(q))).toBe(true);
    expect(sql.some((q) => /^\s*(update|insert|delete)\b/i.test(q))).toBe(false);
  });

  test('--execute links by run, trigger, body link and recipient; never guesses; leaves recipient columns and updated_at alone', async () => {
    const before = await linkOf(ids.byTrigger);
    const out = await backfill.run({ execute: true, dbh: db, log });
    expect(out.totals).toMatchObject({ candidates: 6, linked: 4, unresolved: 2, written: 4 });

    // newest not-deleted lead on the estimate
    expect(await linkOf(ids.byTrigger)).toMatchObject({ estimate_id: ids.estA, lead_id: ids.leadA2, recipient_type: 'lead', recipient_id: null });
    expect((await linkOf(ids.byTrigger)).updated_at).toEqual(before.updated_at);
    // run evidence -> estimate B; its only lead is deleted, so no lead
    expect(await linkOf(ids.byRun)).toMatchObject({ estimate_id: ids.estB, lead_id: null });
    // exactly one /estimate/<token> link in the rendered body -> estimate C (no lead owns it)
    expect(await linkOf(ids.byLink)).toMatchObject({ estimate_id: ids.estC, lead_id: null });
    // recipient_id is a real lead
    expect(await linkOf(ids.byRecipient)).toMatchObject({ lead_id: ids.leadA, estimate_id: null, recipient_id: ids.leadA });
    // no evidence / ambiguous / customer-typed / already linked: untouched
    expect(await linkOf(ids.none)).toMatchObject({ lead_id: null, estimate_id: null });
    expect(await linkOf(ids.ambiguous)).toMatchObject({ lead_id: null, estimate_id: null });
    expect(await linkOf(ids.customerTyped)).toMatchObject({ lead_id: null, estimate_id: null });
    expect(await linkOf(ids.already)).toMatchObject({ estimate_id: ids.estB });
  });

  test('re-running --execute is a no-op', async () => {
    const out = await backfill.run({ execute: true, dbh: db, log });
    expect(out.totals).toMatchObject({ candidates: 2, linked: 0, unresolved: 2, written: 0 });
  });
});

describe('backfill planning helpers', () => {
  const { planRow, uuidsIn, estimateTokensIn, parseArgs } = backfill;
  test('parseArgs defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ execute: false, limit: null, samples: 5 });
    expect(parseArgs(['--execute', '--limit', '10']).execute).toBe(true);
    expect(parseArgs(['--execute', '--limit', '10']).limit).toBe(10);
  });
  test('uuid and token extraction', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(uuidsIn(`x:${id.toUpperCase()}:y:${id}`)).toEqual([id]);
    expect(estimateTokensIn('<a href="https://h.example.test/estimate/abcDEF_12-3">x</a> /estimate/abcDEF_12-3')).toEqual(['abcDEF_12-3']);
  });
  test('the same estimate id in trigger_event_id AND idempotency_key is one match, not an ambiguity', () => {
    const est = '11111111-1111-4111-8111-111111111111';
    const lead = '22222222-2222-4222-8222-222222222222';
    const ref = {
      estimatesById: new Set([est]), estimateByToken: new Map(), runEstimate: new Map(), leadsById: new Set(), leadByEstimate: new Map([[est, lead]]),
    };
    const key = `estimate_followup_expiring:${est}`;
    expect(planRow({ trigger_event_id: key, idempotency_key: key, recipient_id: null }, ref))
      .toMatchObject({ estimate_id: est, estimateVia: 'trigger_event', lead_id: lead, leadVia: 'estimate_owner' });
    // two DIFFERENT estimates is still ambiguous
    const other = '33333333-3333-4333-8333-333333333333';
    ref.estimatesById.add(other);
    expect(planRow({ trigger_event_id: key, idempotency_key: `x:${other}`, recipient_id: null }, ref).estimate_id).toBeNull();
  });
  test('planRow with empty references links nothing', () => {
    const ref = { estimatesById: new Set(), estimateByToken: new Map(), runEstimate: new Map(), leadsById: new Set(), leadByEstimate: new Map() };
    expect(planRow({ trigger_event_id: 'x', recipient_id: null }, ref)).toMatchObject({ lead_id: null, estimate_id: null });
  });
});
