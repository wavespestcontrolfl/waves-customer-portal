/**
 * restaurant_prospects against live Postgres (services/prospects/dbpr-restaurants.js): the (kind, source_key) key,
 * the upsert that refreshes last_seen_at and nothing else and writes a repeated key once, the report read that never overwrites a pest_evidence
 * answer, the pending query (NULL answer, under 3 attempts, inside the date window, newest first), and the read
 * measure, judged and saved under a lock (settleRead). It refuses
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
  // The read a page's answer is saved for, as pendingInspections gives it: the row's id, count and visit number.
  const readOf = (row) => ({ id: row.id, violation35: row.detail.violation35 ?? null, visitNumber: row.detail.visitNumber ?? null });

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    svc = require('../services/prospects/dbpr-restaurants');
  });
  afterAll(async () => { if (db) await rows().del(); });

  test('settleRead judges each read against the stored measure under a lock and keeps the fullest; a run that waits on the lock is judged against what the other saved', async () => {
    const kind = `t${RUN}`; // its own setting key, removed below
    const key = `restaurant_prospects_read_${kind}`;
    const settings = () => db('system_settings').where({ key });
    const stored = async () => JSON.parse((await settings().first('value')).value);
    // Thursday Nov 19, 2026; the newest row is from the day before.
    const now = new Date('2026-11-19T15:36:00Z');
    const read = (rows) => ({ fiscalYear: '2026-07-01', rows, newest: '2026-11-18' });
    try {
      expect(await svc.settleRead(kind, read(6700), now)).toBeNull();
      expect(await svc.settleRead(kind, read(6712), now)).toBeNull();
      expect(await stored()).toEqual({ fiscalYear: '2026-07-01', rows: 6712 });
      // 90% passes without lowering it; under 90% is short and never saved.
      expect(await svc.settleRead(kind, read(6600), now)).toBeNull();
      expect(await svc.settleRead(kind, read(3000), now)).toEqual(expect.objectContaining({ flag: 'short' }));
      expect(await stored()).toEqual({ fiscalYear: '2026-07-01', rows: 6712 });
      // Another run holds the lock and saves 6800 rows. A read of 6100 waits, then is judged against 6800 (short),
      // not against the 6712 stored when it started (it would pass).
      const other = await db.transaction();
      try {
        await other.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [key]);
        const { pid } = (await other.raw('SELECT pg_backend_pid() AS pid')).rows[0];
        const waiting = svc.settleRead(kind, read(6100), now);
        let judged = false;
        waiting.then(() => { judged = true; }, () => { judged = true; });
        // The other run saves only once a session waits on its lock. Without the lock settleRead judges at once and
        // never waits, so the test fails here. It asks on its own connection (the pool may hold only these two), and
        // reads pg_locks, which is live: pg_stat_activity keeps its first snapshot for the whole transaction.
        const blockedByOther = async () => (await other.raw(
          'SELECT 1 FROM pg_locks WHERE NOT granted AND ? = ANY(pg_blocking_pids(pid))', [pid],
        )).rows.length > 0;
        let waited = false;
        for (let tries = 0; tries < 500 && !judged && !waited; tries += 1) {
          waited = await blockedByOther();
          if (!waited) await new Promise((resolve) => { setTimeout(resolve, 10); });
        }
        expect(waited).toBe(true);
        await other('system_settings').where({ key }).update({ value: JSON.stringify({ fiscalYear: '2026-07-01', rows: 6800 }) });
        await other.commit();
        expect(await waiting).toEqual(expect.objectContaining({ flag: 'short' }));
      } finally {
        if (!other.isCompleted()) await other.rollback();
      }
      expect(await stored()).toEqual({ fiscalYear: '2026-07-01', rows: 6800 });
      // A newer fiscal year replaces it, however few its rows.
      const july = { fiscalYear: '2027-07-01', rows: 12, newest: '2027-07-09' };
      expect(await svc.settleRead(kind, july, new Date('2027-07-12T14:36:00Z'))).toBeNull();
      expect(await stored()).toEqual({ fiscalYear: '2027-07-01', rows: 12 });
      // A value that is not a read is no measure: the next read replaces it.
      await settings().update({ value: 'not json' });
      expect(await svc.settleRead(kind, read(3), now)).toBeNull();
      expect(await stored()).toEqual({ fiscalYear: '2026-07-01', rows: 3 });
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
    await svc.saveReport(readOf(row), { pestEvidence: true, findings: [{ code: '35A-02-8', text: 'Flies' }] });
    await db('restaurant_prospects').where({ id: row.id }).update({ detail_attempts: 2, last_seen_at: '2026-01-01T00:00:00Z' });
    await svc.upsertRecords([rec(2, { detail: { disposition: 'changed' } })]);
    const [after] = await rows().where({ id: row.id });
    expect(after.pest_evidence).toBe(true);
    expect(after.detail).toEqual({ disposition: 'Warning Issued', findings: [{ code: '35A-02-8', text: 'Flies' }] });
    expect(after.detail_attempts).toBe(2);
    expect(new Date(after.last_seen_at).getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
  });

  test('a re-read fills the count and the visit number; on an unanswered row each only rises', async () => {
    await svc.upsertRecords([rec(20), rec(21)]);
    const [answered] = await rows().where({ source_key: key(21) });
    await svc.saveReport(readOf(answered), { pestEvidence: true, findings: [{ code: '35A-02-8', text: 'Flies' }] });
    await svc.upsertRecords([
      rec(20, { detail: { disposition: 'changed', violation35: 2, visitNumber: 1 } }),
      rec(21, { detail: { disposition: 'changed', violation35: 1, visitNumber: 2 } }),
    ]);
    const detail = async (n) => (await rows().where({ source_key: key(n) }))[0].detail;
    expect(await detail(20)).toEqual({ disposition: 'Warning Issued', violation35: 2, visitNumber: 1 });
    expect(await detail(21)).toEqual({ disposition: 'Warning Issued', violation35: 1, visitNumber: 2, findings: [{ code: '35A-02-8', text: 'Flies' }] });
    // An answered row keeps them.
    await svc.upsertRecords([rec(21, { detail: { disposition: 'changed', violation35: 3, visitNumber: 1 } })]);
    expect((await detail(21)).violation35).toBe(1);
    expect((await detail(21)).visitNumber).toBe(2);
    // An unanswered row takes a higher count (compared as numbers: 10 over 5) and a higher visit number, never a lower
    // one: a stale file that still says visit 1 cannot make the corrected callback a first visit again. A blank in the
    // file erases nothing, and nothing else changes.
    await svc.upsertRecords([rec(20, { detail: { disposition: 'changed', violation35: 5, visitNumber: 2 } })]);
    expect(await detail(20)).toEqual({ disposition: 'Warning Issued', violation35: 5, visitNumber: 2 });
    await svc.upsertRecords([rec(20, { detail: { disposition: 'changed', violation35: 10, visitNumber: 1 } })]);
    await svc.upsertRecords([rec(20, { detail: { disposition: 'changed', violation35: 2, visitNumber: null } })]);
    expect(await detail(20)).toEqual({ disposition: 'Warning Issued', violation35: 10, visitNumber: 2 });
    // A blank visit number (JSON null) is filled when a later file has it.
    await svc.upsertRecords([rec(22, { detail: { disposition: 'Warning Issued', violation35: 1, visitNumber: null } })]);
    await svc.upsertRecords([rec(22, { detail: { disposition: 'Warning Issued', violation35: 1, visitNumber: 1 } })]);
    expect(await detail(22)).toEqual({ disposition: 'Warning Issued', violation35: 1, visitNumber: 1 });
  });

  test('a visit listed twice in one file keeps the highest count and the highest visit number its copies give', async () => {
    const copy = (violation35, visitNumber, disposition) => rec(6, { detail: { disposition, violation35, visitNumber } });
    expect(await svc.upsertRecords([copy(2, 2, 'first'), copy(1, 1, 'second'), copy(1, null, 'last')])).toBe(1);
    const [row] = await rows().where({ source_key: key(6) });
    expect(row.detail).toEqual({ disposition: 'last', violation35: 2, visitNumber: 2 });
  });

  test('saveReport saves only while the row holds the count and visit number the page was read with', async () => {
    await svc.upsertRecords([rec(5, { detail: { disposition: 'Warning Issued', violation35: 1, visitNumber: 1 } })]);
    const [row] = await rows().where({ source_key: key(5) });
    const read = readOf(row);
    // A file re-read raises the count after the read began: no save, and the row waits for a later read.
    await svc.upsertRecords([rec(5, { detail: { disposition: 'Warning Issued', violation35: 2, visitNumber: 1 } })]);
    expect(await svc.saveReport(read, { pestEvidence: false, findings: [] })).toBe(false);
    expect((await rows().where({ id: row.id }))[0].pest_evidence).toBeNull();
    // Another visit number: no save either.
    expect(await svc.saveReport({ ...read, violation35: 2, visitNumber: 2 }, { pestEvidence: false, findings: [] })).toBe(false);
    // Read again with the row's values, it saves.
    expect(await svc.saveReport({ ...read, violation35: 2 }, { pestEvidence: false, findings: [] })).toBe(true);
    expect((await rows().where({ id: row.id }))[0].pest_evidence).toBe(false);
  });

  test('saveReport does not overwrite an answer already written', async () => {
    await svc.upsertRecords([rec(3)]);
    const [row] = await rows().where({ source_key: key(3) });
    expect(await svc.saveReport(readOf(row), { pestEvidence: false, findings: [] })).toBe(true);
    expect(await svc.saveReport(readOf(row), { pestEvidence: true, findings: [{ code: '35A-01-8', text: 'x' }] })).toBe(false);
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

  test('pending reads only unanswered first visits under 3 attempts inside the window, newest first, of the keys given', async () => {
    const first = (violation35) => ({ disposition: 'Warning Issued', violation35, visitNumber: 1 });
    await svc.upsertRecords([
      rec(10, { event_date: '2026-10-21', detail: first(1) }),
      rec(11, { event_date: '2026-11-15', detail: first(2) }),
      rec(12, { event_date: '2026-09-01', detail: first(1) }),
      rec(13, { event_date: '2026-11-16', detail: first(1) }), rec(14, { event_date: '2026-11-17', kind: 'new_license' }),
      // A callback, and a row stored before the visit number was kept: the parser answers for neither.
      rec(15, { event_date: '2026-11-18', detail: { disposition: 'Warning Issued', violation35: 1, visitNumber: 2 } }),
      rec(16, { event_date: '2026-11-19' }),
    ]);
    const stored = await rows();
    const id = (n) => stored.find((r) => r.source_key === key(n)).id;
    await db('restaurant_prospects').where({ id: id(13) }).update({ detail_attempts: 3 });
    await svc.bumpAttempts(id(10));
    // The keys of the run's own good read: every visit above.
    const keys = [10, 11, 12, 13, 14, 15, 16].map(key);
    const pending = async (given = keys) => svc.pendingInspections({ cutoff: '2026-10-05', limit: 100, keys: given });
    const mine = await pending();
    expect(mine.map((p) => p.id)).toEqual([id(11), id(10)]);
    // The file's count and visit number ride along with the visit's date.
    expect(mine.map((p) => [p.violation35, p.visitNumber, p.visitDate])).toEqual([[2, 1, '2026-11-15'], [1, 1, '2026-10-21']]);
    // The old row becomes eligible once a re-read of the file fills its visit number.
    await svc.upsertRecords([rec(16, { event_date: '2026-11-19', detail: first(1) })]);
    expect((await pending()).map((p) => p.id)).toEqual([id(16), id(11), id(10)]);
    const [one] = await svc.pendingInspections({ cutoff: '2026-10-05', limit: 1, keys });
    expect(one.id).toBe(id(16));
    // A visit the run's read does not list (a later file corrected it to no citation, or dropped it) is never read,
    // and no keys means no rows.
    expect((await pending(keys.filter((k) => k !== key(11)))).map((p) => p.id)).toEqual([id(16), id(10)]);
    expect(await pending([])).toEqual([]);
    expect(await svc.pendingInspections({ cutoff: '2026-10-05', limit: 100 })).toEqual([]);
    expect((await rows().where({ id: id(10) }))[0].detail_attempts).toBe(1);
  });
});
