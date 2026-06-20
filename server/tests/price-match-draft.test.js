const {
  createDraft, listDrafts, getDraft, sendDraft, dismissDraft, resetStuckDraft, markEmail,
} = require('../services/price-scan/price-match-draft');

// Minimal in-memory knex-like stub for the price_match_drafts chains used.
function makeFakeDb() {
  const rows = [];
  let nextId = 1;
  const cmp = (op, a, b) => {
    const av = a == null ? null : new Date(a).getTime();
    const bv = b instanceof Date ? b.getTime() : b;
    if (op === '<') return av != null && av < bv;
    if (op === '>') return av != null && av > bv;
    return a === b;
  };
  const db = () => {
    const state = { where: null, whereIn: null, ops: [] };
    const matches = (r) => (!state.where || Object.keys(state.where).every((k) => r[k] === state.where[k]))
      && (!state.whereIn || state.whereIn.arr.includes(r[state.whereIn.col]))
      && state.ops.every(({ col, op, val }) => cmp(op, r[col], val));
    const builder = {
      where(...args) {
        if (args.length === 3) state.ops.push({ col: args[0], op: args[1], val: args[2] });
        else state.where = { ...(state.where || {}), ...args[0] };
        return builder;
      },
      whereIn(col, arr) { state.whereIn = { col, arr }; return builder; },
      orderBy() { return builder; },
      limit() { return builder; },
      first() { return Promise.resolve(rows.find(matches)); },
      insert(data) {
        return {
          returning: () => {
            const r = {
              id: nextId++, status: 'pending', claimed_at: null, claim_token: null,
              sent_at: null, dismissed_at: null, message_id: null, sent_by: null, ...data,
            };
            rows.push(r);
            return Promise.resolve([r]);
          },
        };
      },
      update(data) {
        // knex update is thenable (runs on await) and also supports .returning().
        const apply = () => {
          const found = rows.filter(matches);
          found.forEach((r) => Object.assign(r, data));
          return found;
        };
        return {
          returning: () => Promise.resolve(apply()),
          then: (resolve, reject) => Promise.resolve(apply()).then(resolve, reject),
        };
      },
      then(resolve, reject) {
        return Promise.resolve(rows.filter(matches)).then(resolve, reject);
      },
    };
    return builder;
  };
  db.fn = { now: () => '__now__' };
  db._rows = rows;
  return db;
}

const proofMatch = {
  product: 'Taurus SC Termiticide',
  baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' },
  competitor: { vendor: 'DoMyOwn', price: 89, quantity: '78 oz', source_url: 'https://www.domyown.com/p-1817.html' },
  savingsPct: 0.063,
};

describe('price-match-draft service', () => {
  // markEmail() reads process.env.MARK_EMAIL; isolate it so an ambient value in
  // CI/dev doesn't flip the fallback assertions.
  const savedMark = process.env.MARK_EMAIL;
  beforeEach(() => { delete process.env.MARK_EMAIL; });
  afterAll(() => {
    if (savedMark === undefined) delete process.env.MARK_EMAIL;
    else process.env.MARK_EMAIL = savedMark;
  });

  test('default recipient is the SiteOne rep', () => {
    expect(markEmail()).toBe('mmroczkowski@siteone.com');
  });

  test('MARK_EMAIL env overrides the recipient', async () => {
    process.env.MARK_EMAIL = 'rep@siteone.com';
    const db = makeFakeDb();
    const row = await createDraft(db, [proofMatch]);
    expect(row.recipient).toBe('rep@siteone.com');
  });

  test('createDraft composes + persists a pending draft', async () => {
    const db = makeFakeDb();
    const row = await createDraft(db, [proofMatch]);
    expect(row.status).toBe('pending');
    expect(row.recipient).toBe('mmroczkowski@siteone.com');
    expect(row.included_count).toBe(1);
    expect(row.subject).toMatch(/Price-match request/);
    expect(row.html).toContain('$1.22/oz'); // per-unit carried through
    expect(db._rows).toHaveLength(1);
  });

  test('createDraft returns null when nothing has proof (no empty draft)', async () => {
    const db = makeFakeDb();
    const noProof = { product: 'X', baseline: { price: 5, quantity: '1 oz' }, competitor: { price: 4, quantity: '1 oz' } };
    expect(await createDraft(db, [noProof])).toBeNull();
    expect(db._rows).toHaveLength(0);
  });

  test('sendDraft emails the recipient and flips to sent', async () => {
    const db = makeFakeDb();
    const draft = await createDraft(db, [proofMatch]);
    const sendOne = jest.fn(async () => ({ messageId: 'msg_123' }));
    const result = await sendDraft(db, draft.id, { actor: 'Waves' }, { sendgrid: { sendOne } });

    expect(result.ok).toBe(true);
    expect(sendOne).toHaveBeenCalledTimes(1);
    const arg = sendOne.mock.calls[0][0];
    expect(arg.to).toBe('mmroczkowski@siteone.com');
    expect(arg.subject).toMatch(/Price-match request/);
    expect(arg.html).toContain('domyown.com');
    const after = await getDraft(db, draft.id);
    expect(after.status).toBe('sent');
    expect(after.message_id).toBe('msg_123');
    expect(after.sent_by).toBe('Waves');
  });

  test('sendDraft refuses a non-pending draft (no double-send)', async () => {
    const db = makeFakeDb();
    const draft = await createDraft(db, [proofMatch]);
    const sendOne = jest.fn(async () => ({ messageId: 'm' }));
    await sendDraft(db, draft.id, {}, { sendgrid: { sendOne } });
    const second = await sendDraft(db, draft.id, {}, { sendgrid: { sendOne } });
    expect(second).toEqual({ ok: false, reason: 'already_sent' });
    expect(sendOne).toHaveBeenCalledTimes(1); // not sent twice
  });

  test('sendDraft on a missing id -> not_found', async () => {
    const db = makeFakeDb();
    expect(await sendDraft(db, 999, {}, { sendgrid: { sendOne: jest.fn() } })).toEqual({ ok: false, reason: 'not_found' });
  });

  test('refuses to send (without claiming) when SendGrid is not configured', async () => {
    const db = makeFakeDb();
    const draft = await createDraft(db, [proofMatch]);
    const sendOne = jest.fn();
    const result = await sendDraft(db, draft.id, {}, { sendgrid: { isConfigured: () => false, sendOne } });
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
    expect(sendOne).not.toHaveBeenCalled();
    expect((await getDraft(db, draft.id)).status).toBe('pending'); // not stranded in 'sending'
  });

  test('a failed/ambiguous send stays claimed (no immediate-retry double-send)', async () => {
    const db = makeFakeDb();
    const draft = await createDraft(db, [proofMatch]);
    const sendOne = jest.fn(async () => { throw new Error('sendgrid timeout'); });
    await expect(sendDraft(db, draft.id, {}, { sendgrid: { sendOne } })).rejects.toThrow('sendgrid timeout');
    const after = await getDraft(db, draft.id);
    expect(after.status).toBe('sending'); // NOT reopened — a timeout isn't proof it didn't send
    // an immediate retry is refused (still claimed), so the rep can't get it twice
    const retry = await sendDraft(db, draft.id, {}, { sendgrid: { sendOne: jest.fn() } });
    expect(retry).toEqual({ ok: false, reason: 'already_sending' });
  });

  test('dismissDraft drops a pending draft; non-pending -> null', async () => {
    const db = makeFakeDb();
    const draft = await createDraft(db, [proofMatch]);
    const dropped = await dismissDraft(db, draft.id, { actor: 'Waves' });
    expect(dropped.status).toBe('dismissed');
    expect(await dismissDraft(db, draft.id)).toBeNull(); // already dismissed
  });

  test('a stale send cannot finalize a newer claim (per-claim token)', async () => {
    const db = makeFakeDb();
    const draft = await createDraft(db, [proofMatch]);
    // Call #1 claims with token A, then "hangs"; during the hang the draft is
    // stale-reset and re-sent under a NEW claim (token B).
    const sendOne = jest.fn(async () => {
      db._rows[0].claim_token = 'B'; // newer claim took over while we were hung
      db._rows[0].claimed_at = '2026-06-19T12:00:00Z';
      return { messageId: 'stale-call' };
    });
    const result = await sendDraft(db, draft.id, {}, { sendgrid: { sendOne }, token: 'A' });
    expect(result).toEqual({ ok: true, reconcile: true, messageId: 'stale-call' });
    // the newer claim (B) is untouched — the stale call did NOT mark it sent
    expect(db._rows[0].status).toBe('sending');
    expect(db._rows[0].claim_token).toBe('B');
  });

  test('a draft stuck mid-send finalizes to reconcile, not silent success', async () => {
    const db = makeFakeDb();
    const draft = await createDraft(db, [proofMatch]);
    // sendOne succeeds but the row is reset out from under us before finalize.
    const sendOne = jest.fn(async () => { db._rows[0].status = 'pending'; db._rows[0].claimed_at = null; return { messageId: 'm9' }; });
    const result = await sendDraft(db, draft.id, {}, { sendgrid: { sendOne } });
    expect(result).toEqual({ ok: true, reconcile: true, messageId: 'm9' });
  });

  test('resetStuckDraft recovers a STALE sending claim but refuses a fresh one', async () => {
    const db = makeFakeDb();
    const draft = await createDraft(db, [proofMatch]);
    const now = Date.parse('2026-06-19T12:00:00Z');
    db._rows[0].status = 'sending';

    // Fresh claim (1s ago) — likely an in-flight send; must NOT be reset.
    db._rows[0].claimed_at = new Date(now - 1000).toISOString();
    expect(await resetStuckDraft(db, draft.id, { nowMs: now })).toBeNull();

    // Stale claim (20 min ago) — a crash; safe to recover.
    db._rows[0].claimed_at = new Date(now - 20 * 60 * 1000).toISOString();
    const recovered = await resetStuckDraft(db, draft.id, { nowMs: now });
    expect(recovered.status).toBe('pending');
    expect(recovered.claimed_at).toBeNull();
    expect(await resetStuckDraft(db, draft.id, { nowMs: now })).toBeNull(); // not sending anymore
  });

  test('dismiss refuses a fresh sending draft, allows a stale one', async () => {
    const db = makeFakeDb();
    const draft = await createDraft(db, [proofMatch]);
    const now = Date.parse('2026-06-19T12:00:00Z');
    db._rows[0].status = 'sending';
    db._rows[0].claimed_at = new Date(now - 1000).toISOString();
    expect(await dismissDraft(db, draft.id, { nowMs: now })).toBeNull(); // in-flight
    db._rows[0].claimed_at = new Date(now - 20 * 60 * 1000).toISOString();
    expect((await dismissDraft(db, draft.id, { nowMs: now })).status).toBe('dismissed');
  });

  test('active list surfaces pending AND sending (stuck claims not hidden)', async () => {
    const db = makeFakeDb();
    await createDraft(db, [proofMatch]); // pending
    await createDraft(db, [proofMatch]);
    db._rows[1].status = 'sending';
    const active = await listDrafts(db, { status: ['pending', 'sending'] });
    expect(active).toHaveLength(2);
  });

  test('listDrafts filters by status', async () => {
    const db = makeFakeDb();
    await createDraft(db, [proofMatch]);
    const pending = await listDrafts(db, { status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(await listDrafts(db, { status: 'sent' })).toHaveLength(0);
  });
});
