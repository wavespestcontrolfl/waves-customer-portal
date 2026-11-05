// The Today page's schedule-change cards (owner ruling 2026-10-03): every open
// visit_* card for the signed-in tech, a change touching today or tomorrow
// marked `soon` (its own card, listed first so the cap never cuts one off),
// a count of every other open change, and one "clear all" that covers the
// whole non-soon set up to the read the tech saw — only this tech's own
// schedule-change cards (Codex #5783 P2: past the 300-row cap too).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/time-tracking', () => ({}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const db = require('../models/db');
const router = require('../routes/tech-notifications');
const { etDateString, addETDays } = require('../utils/datetime-et');

db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
// db.from(subquery): a chain like db(table), recording the subquery it reads.
db.from = jest.fn((sub) => db({ from: sub }));

function handler(path, method) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// Each db(...) call gets its own recording chain resolving to the next result.
function stubDb(results) {
  const chains = [];
  db.mockImplementation((table) => {
    const calls = { table };
    const chain = {};
    for (const m of ['leftJoin', 'where', 'whereNull', 'whereIn', 'whereNotIn', 'whereRaw', 'orderBy', 'orderByRaw', 'limit', 'select', 'count']) {
      chain[m] = jest.fn((...args) => {
        (calls[m] ||= []).push(args);
        if (m === 'leftJoin' && typeof args[1] === 'function') {
          const on = { on: jest.fn((...o) => { calls.on = o; return on; }) };
          args[1].call(on);
        }
        // A grouped where (dismiss-batch): record its whereIn / orWhereIn.
        if (m === 'where' && typeof args[0] === 'function') {
          const group = {};
          for (const g of ['whereIn', 'orWhereIn']) group[g] = jest.fn((...a) => { (calls[`group_${g}`] ||= []).push(a); return group; });
          args[0].call(group);
        }
        return chain;
      });
    }
    chain.update = jest.fn(async (patch) => { calls.update = patch; return results.shift(); });
    chain.as = jest.fn((alias) => { calls.as = alias; return chain; });
    chain.then = (res, rej) => Promise.resolve(results.shift()).then(res, rej);
    chains.push(calls);
    return chain;
  });
  return chains;
}

const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;

describe('GET /schedule-changes', () => {
  test('soon cards and folded rows are read apart, each capped, so soon cards never crowd out the folded rows; later_total counts them all', async () => {
    const today = etDateString(new Date());
    const tomorrow = etDateString(addETDays(new Date(), 1));
    const soonRows = [{ id: ID(2), type: 'visit_rescheduled', payload: JSON.stringify({ previous_date: today }) }];
    const laterRows = [{ id: ID(1), type: 'visit_rescheduled', payload: { date: '2026-12-15' } }];
    const chains = stubDb([soonRows, laterRows, [{ n: '412' }]]);
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await handler('/schedule-changes', 'get')({ technicianId: 't-1' }, res, (e) => { throw e; });

    // Each read is an outer query over this tech's ranked open cards.
    const [soonCards, soonQ, laterCards, laterQ, countCards, countQ] = chains;
    const body = res.json.mock.calls[0][0];
    const asOf = new Date(body.as_of);
    for (const cards of [soonCards, laterCards, countCards]) {
      expect(cards.table).toBe('tech_notifications as tn');
      expect(cards.where[0]).toEqual(['tn.technician_id', 't-1']);
      expect(cards.whereNull[0]).toEqual(['tn.dismissed_at']);
      expect(cards.whereIn[0]).toEqual(['tn.type', ['visit_assigned', 'visit_unassigned', 'visit_rescheduled', 'visit_cancelled']]);
      // One card per visit: ranked within its visit, newest first.
      expect(cards.select[0][1].sql).toMatch(/^row_number\(\) OVER \(PARTITION BY COALESCE\(tn\.payload->>'visit_id', tn\.id::text\) ORDER BY tn\.created_at DESC, tn\.id DESC\) AS visit_rank$/);
      // …carrying what ANY open card of the visit says about today/tomorrow.
      expect(cards.select[0][2].sql).toContain("tn.payload->>'prior_day_unknown' = 'true'");
      expect(cards.select[0][2].sql).toMatch(/AS visit_touches_soon$/);
      expect(cards.select[0][2].bindings).toEqual([today, tomorrow, today, tomorrow]);
      expect(cards.select[0][3].sql).toMatch(/AS visit_soon_when$/);
      expect(cards.as).toBe('n');
    }
    for (const q of [soonQ, laterQ, countQ]) {
      expect(q.where[0]).toEqual(['n.visit_rank', 1]);
      // Every read stops at as_of, the bound a following clear-all uses.
      expect(q.where[1]).toEqual(['n.created_at', '<=', asOf]);
      // Joined on the uuid primary key, the payload id pattern-checked first.
      expect(q.on[0]).toBe('s.id');
      expect(q.on[2].sql).toMatch(/CASE WHEN n\.payload->>'visit_id' ~\* '.+' THEN \(n\.payload->>'visit_id'\)::uuid END/);
      // Every read (and so the count) leaves out the cards whose visit has
      // nothing left to say, judged on the read's ET day (the real rules: the
      // Postgres suite).
      expect(q.whereRaw[0][0]).toMatch(/^NOT \(n\.type IN \(/);
      expect(q.whereRaw[0][1]).toEqual([today, today, today]);
    }
    // Soon: any open card of the visit touches today/tomorrow, or the visit's
    // day as it is now does.
    // The visit's day now counts only while the visit is this tech's.
    expect(soonQ.whereRaw[1][0]).toBe("COALESCE(n.visit_touches_soon OR (s.technician_id = n.technician_id AND to_char(s.scheduled_date, 'YYYY-MM-DD') IN (?, ?)), false)");
    expect(soonQ.whereRaw[1][1]).toEqual([today, tomorrow]);
    expect(laterQ.whereRaw[1][0]).toMatch(/^NOT COALESCE\(/);
    expect(countQ.whereRaw[1][0]).toMatch(/^NOT COALESCE\(/);
    // Soon cards in visit order: today's stops lead tomorrow's.
    expect(soonQ.orderByRaw[0][0]).toBe('CASE WHEN s.technician_id = n.technician_id THEN s.scheduled_date END ASC NULLS LAST, CASE WHEN s.technician_id = n.technician_id THEN s.window_start END ASC NULLS LAST');
    expect(soonQ.limit[0]).toEqual([300]);
    expect(laterQ.limit[0]).toEqual([300]);

    expect(body.changes.map((c) => [c.id, c.soon])).toEqual([[ID(2), true], [ID(1), false]]);
    expect(body.changes[0].payload.previous_date).toBe(today);
    expect(body.later_total).toBe(412);
  });
});

describe('POST /dismiss-batch', () => {
  test('clears every open non-soon card of this tech written by as_of, with the older cards of the same visits, in one update', async () => {
    const chains = stubDb([37]);
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const asOf = new Date('2026-10-03T10:00:00.000Z');
    // keep_ids: the cards the read showed on their own; junk is dropped.
    await handler('/dismiss-batch', 'post')({ technicianId: 't-1', body: { as_of: asOf.toISOString(), keep_ids: [ID(2), 'not-a-uuid', 7] } }, res, (e) => { throw e; });

    const [update, idCards, shownIds, visitCards, shownVisits] = chains;
    expect(update.table).toBe('tech_notifications');
    expect(update.where.slice(0, 2)).toEqual([['technician_id', 't-1'], ['created_at', '<=', asOf]]);
    expect(update.whereIn[0]).toEqual(['type', ['visit_assigned', 'visit_unassigned', 'visit_rescheduled', 'visit_cancelled']]);
    expect(update.whereNull[0]).toEqual(['dismissed_at']);
    // The cards the read showed, or any open card of one of their visits.
    expect(update.group_whereIn[0][0]).toBe('id');
    expect(update.group_orWhereIn[0][0].sql).toBe("payload->>'visit_id'");
    for (const cards of [idCards, visitCards]) expect(cards.where[0]).toEqual(['tn.technician_id', 't-1']);
    for (const shown of [shownIds, shownVisits]) {
      expect(shown.where).toEqual([['n.visit_rank', 1], ['n.created_at', '<=', asOf]]);
      expect(shown.whereRaw[0][0]).toMatch(/^NOT \(n\.type IN \(/);
      expect(shown.whereRaw[1][0]).toMatch(/^NOT COALESCE\(/);
    }
    for (const shown of [shownIds, shownVisits]) expect(shown.whereNotIn[0]).toEqual(['n.id', [ID(2)]]);
    expect(shownIds.select[0]).toEqual(['n.id']);
    expect(shownVisits.select[0][0].sql).toBe("n.payload->>'visit_id'");
    expect(update.update).toMatchObject({ read: true, dismissed_at: expect.any(Date) });
    expect(res.json).toHaveBeenCalledWith({ success: true, dismissed: 37 });
  });

  test('today/tomorrow is judged as of the read, not the tap: an ET midnight in between never clears a card shown on its own', async () => {
    const chains = stubDb([0]);
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    // 11:59 PM ET Oct 3 read; the tap lands after midnight.
    await handler('/dismiss-batch', 'post')({ technicianId: 't-1', body: { as_of: '2026-10-04T03:59:00.000Z' } }, res, (e) => { throw e; });
    // The hide rules judge "past" on the read's day too.
    expect(chains[2].whereRaw[0][1]).toEqual(['2026-10-03', '2026-10-03', '2026-10-03']);
    expect(chains[2].whereRaw[1][1]).toEqual(['2026-10-03', '2026-10-04']);
    expect(chains[1].select[0][2].bindings).toEqual(['2026-10-03', '2026-10-04', '2026-10-03', '2026-10-04']);
  });

  test.each([
    ['no as_of', {}],
    ['an unparseable as_of', { as_of: 'yesterday-ish' }],
    ['a null as_of (new Date(null) is 1970)', { as_of: null }],
    ['a numeric as_of', { as_of: 0 }],
    ['an empty as_of', { as_of: '  ' }],
  ])('%s → 400, nothing written', async (_label, body) => {
    db.mockReset();
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await handler('/dismiss-batch', 'post')({ technicianId: 't-1', body }, res, (e) => { throw e; });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db).not.toHaveBeenCalled();
  });
});
