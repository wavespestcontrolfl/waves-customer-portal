/**
 * restaurant_prospects against live Postgres (services/prospects/dbpr-restaurants.js): the (kind, source_key) key,
 * the upsert that refreshes last_seen_at and nothing else and writes a repeated key once, the report read that never overwrites a pest_evidence
 * answer, and the pending query (NULL answer, under 3 attempts, inside the date window, newest first). It refuses
 * any database but a private QA one or CI's, and its rows carry a per-run business marker so cleanup touches only them.
 */
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('restaurant_prospects (live Postgres)', () => {
  let db;
  let svc;
  // source_key is varchar(40), like the real keys (short numeric ids): a full UUID marker would not fit.
  const RUN = randomUUID().replace(/-/g, '').slice(0, 16);
  const key = (n) => `t-${RUN}-${n}`;
  const rec = (n, over = {}) => ({
    kind: 'inspection', source_key: key(n), license_id: '5001', license_number: 'SEA0000001', license_type_code: '2010',
    business_name: 'SAMPLE DINER', address: '200 SAMPLE TRL', city: 'BRADENTON', zip: '34208', county: 'Manatee',
    phone: null, seats: null, event_date: '2026-11-10', detail: { disposition: 'Warning Issued' }, ...over,
  });
  const rows = () => db('restaurant_prospects').where('source_key', 'like', `t-${RUN}-%`);

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    svc = require('../services/prospects/dbpr-restaurants');
  });
  afterAll(async () => { if (db) await rows().del(); });

  test('saveRead keeps one measure per file: a newer year or more rows replace it, never fewer, even from runs that overlap', async () => {
    const kind = `t${RUN}`; // its own setting key, removed below
    const settings = () => db('system_settings').where({ key: `restaurant_prospects_read_${kind}` });
    try {
      expect(await svc.lastRead(kind)).toBeNull();
      await svc.saveRead(kind, { fiscalYear: '2026-07-01', rows: 6700 });
      await svc.saveRead(kind, { fiscalYear: '2026-07-01', rows: 6712 });
      expect(await svc.lastRead(kind)).toEqual({ fiscalYear: '2026-07-01', rows: 6712 });
      expect(await settings()).toHaveLength(1);
      // Fewer rows in the same year never lower it, one after another or from runs that overlap.
      await svc.saveRead(kind, { fiscalYear: '2026-07-01', rows: 6600 });
      expect(await svc.lastRead(kind)).toEqual({ fiscalYear: '2026-07-01', rows: 6712 });
      await Promise.all([6650, 6720, 6690].map((rows) => svc.saveRead(kind, { fiscalYear: '2026-07-01', rows })));
      expect(await svc.lastRead(kind)).toEqual({ fiscalYear: '2026-07-01', rows: 6720 });
      // A newer fiscal year replaces it, however few its rows.
      await svc.saveRead(kind, { fiscalYear: '2027-07-01', rows: 12 });
      expect(await svc.lastRead(kind)).toEqual({ fiscalYear: '2027-07-01', rows: 12 });
      // A value that is not a read is no measure, and the next read replaces it.
      await settings().update({ value: 'not json' });
      expect(await svc.lastRead(kind)).toBeNull();
      await settings().update({ value: JSON.stringify({ fiscalYear: 'later', rows: 5 }) });
      expect(await svc.lastRead(kind)).toBeNull();
      await svc.saveRead(kind, { fiscalYear: '2026-07-01', rows: 3 });
      expect(await svc.lastRead(kind)).toEqual({ fiscalYear: '2026-07-01', rows: 3 });
      expect(await settings()).toHaveLength(1);
    } finally {
      await settings().del();
    }
  });

  test('the same (kind, source_key) is one row; a different kind with the same key is another', async () => {
    await svc.upsertRecords([rec(1), rec(1, { kind: 'new_license', detail: { applicationType: 'Initial' } })]);
    await svc.upsertRecords([rec(1)]);
    const found = await rows().orderBy('kind');
    expect(found.map((r) => r.kind)).toEqual(['inspection', 'new_license']);
    await expect(db('restaurant_prospects').insert({ kind: 'inspection', source_key: key(1) })).rejects.toThrow(/restaurant_prospects_kind_source_key/);
  });

  test('a re-read refreshes last_seen_at and never touches an answer, findings or attempts', async () => {
    await svc.upsertRecords([rec(2)]);
    const [row] = await rows().where({ source_key: key(2) });
    await svc.saveReport(row.id, { pestEvidence: true, findings: [{ code: '35A-02-8', text: 'Flies' }] });
    await db('restaurant_prospects').where({ id: row.id }).update({ detail_attempts: 2, last_seen_at: '2026-01-01T00:00:00Z' });
    await svc.upsertRecords([rec(2, { detail: { disposition: 'changed' } })]);
    const [after] = await rows().where({ id: row.id });
    expect(after.pest_evidence).toBe(true);
    expect(after.detail).toEqual({ disposition: 'Warning Issued', findings: [{ code: '35A-02-8', text: 'Flies' }] });
    expect(after.detail_attempts).toBe(2);
    expect(new Date(after.last_seen_at).getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
  });

  test('saveReport does not overwrite an answer already written', async () => {
    await svc.upsertRecords([rec(3)]);
    const [row] = await rows().where({ source_key: key(3) });
    await svc.saveReport(row.id, { pestEvidence: false, findings: [] });
    await svc.saveReport(row.id, { pestEvidence: true, findings: [{ code: '35A-01-8', text: 'x' }] });
    const [after] = await rows().where({ id: row.id });
    expect(after.pest_evidence).toBe(false);
    expect(after.detail.findings).toEqual([]);
  });

  test('a batch that repeats a key writes one row with the last copy, and the count says so', async () => {
    const written = await svc.upsertRecords([rec(4, { business_name: 'SAMPLE DINER ONE' }), rec(4, { business_name: 'SAMPLE DINER TWO' })]);
    expect(written).toBe(1);
    const found = await rows().where({ source_key: key(4) });
    expect(found.map((r) => r.business_name)).toEqual(['SAMPLE DINER TWO']);
  });

  test('pending reads only unanswered inspections under 3 attempts inside the window, newest first', async () => {
    await svc.upsertRecords([
      rec(10, { event_date: '2026-11-01' }), rec(11, { event_date: '2026-11-15' }), rec(12, { event_date: '2026-09-01' }),
      rec(13, { event_date: '2026-11-16' }), rec(14, { event_date: '2026-11-17', kind: 'new_license' }),
    ]);
    const stored = await rows();
    const id = (n) => stored.find((r) => r.source_key === key(n)).id;
    await db('restaurant_prospects').where({ id: id(13) }).update({ detail_attempts: 3 });
    await svc.bumpAttempts(id(10));
    const pending = await svc.pendingInspections({ cutoff: '2026-10-05', limit: 100 });
    const mine = pending.filter((p) => [10, 11, 12, 13, 14].some((n) => p.id === id(n)));
    expect(mine.map((p) => p.id)).toEqual([id(11), id(10)]);
    const [one] = await svc.pendingInspections({ cutoff: '2026-10-05', limit: 1 });
    expect(one).toBeDefined();
    expect((await rows().where({ id: id(10) }))[0].detail_attempts).toBe(1);
  });
});
