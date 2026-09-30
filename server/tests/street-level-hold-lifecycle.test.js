// Street-level address hold lifecycle (owner ruling 2026-09-30): the review card
// closes with a cancelled / skipped visit, and an unconfirmed hold takes no
// self-book daily-cap capacity. Synthetic data only.
const fs = require('fs');
const { closeHoldCardForEndedVisit, heldVisitSubquery, refreshHoldFollowUpPlan } = require('../services/street-level-hold');

const card = (status = 'open') => ({ id: 't1', status, payload: { street_level_address: true, scheduled_service_id: 'visit-1' }, summary: 'x' });

// A fake conn: scheduled_services lookup, triage card lookup/update, call_log update, review aggregate.
const makeConn = ({ visit = { id: 'visit-1', source_call_log_id: 'call-1' }, holdCard = card(), openAfter = 0 } = {}) => {
  const log = { updates: [], locked: false, raws: [] };
  const conn = (table) => {
    const q = {
      where(arg) { q._where = arg; return q; }, whereIn() { return q; }, whereRaw() { return q; }, orderBy() { return q; }, count() { q._count = true; return q; },
      first: async () => {
        if (table === 'scheduled_services') return visit;
        if (q._count) return { n: openAfter };
        return holdCard;
      },
      update: async (u) => { log.updates.push({ table, where: q._where, u }); return 1; },
    };
    return q;
  };
  conn.raw = async (...a) => { log.locked = true; log.raws.push(a); return { rows: [{}] }; };
  conn.transaction = async (fn) => fn(conn);
  return { conn, log };
};

describe('closeHoldCardForEndedVisit', () => {
  for (const toStatus of ['cancelled', 'skipped']) {
    test(`a ${toStatus} street-level hold visit resolves its open card and closes the call's review state, under the per-call lock`, async () => {
      const { conn, log } = makeConn();
      expect(await closeHoldCardForEndedVisit('visit-1', toStatus, conn)).toBe(true);
      expect(log.locked).toBe(true);
      const cardUpdate = log.updates.find((u) => u.table === 'triage_items');
      expect(cardUpdate.where).toEqual({ id: 't1' });
      expect(cardUpdate.u).toMatchObject({ status: 'resolved' });
      expect(cardUpdate.u.resolution_note).toContain(toStatus);
      expect(log.updates.find((u) => u.table === 'call_log').u).toMatchObject({ review_status: 'resolved' });
    });
  }
  test('another open card on the call keeps review_status open', async () => {
    const { conn, log } = makeConn({ openAfter: 1 });
    await closeHoldCardForEndedVisit('visit-1', 'cancelled', conn);
    expect(log.updates.find((u) => u.table === 'call_log').u).toMatchObject({ review_status: 'open' });
  });
  test('byte-identical for everything else: not a voice_agent visit, no street-level card, or the card is already closed', async () => {
    for (const opts of [{ visit: null }, { visit: { id: 'v', source_call_log_id: null } }, { holdCard: null }, { holdCard: card('resolved') }]) {
      const { conn, log } = makeConn(opts);
      expect(await closeHoldCardForEndedVisit('visit-1', 'cancelled', conn)).toBe(false);
      expect(log.updates).toHaveLength(0);
      expect(log.locked).toBe(false);
    }
  });
  test('never throws', async () => {
    expect(await closeHoldCardForEndedVisit('visit-1', 'cancelled', () => { throw new Error('db down'); })).toBe(false);
  });
  test('the shared status writer runs it for cancelled and skipped only', () => {
    const s = fs.readFileSync(require.resolve('../services/job-status.js'), 'utf8');
    expect(s).toContain("if (['cancelled', 'skipped'].includes(String(toStatus))) {\n        void require('./street-level-hold').closeHoldCardForEndedVisit(jobId, toStatus)");
  });
});

describe('self-book daily cap', () => {
  test('both voice-agent counts exclude an unconfirmed street-level hold (one query each)', () => {
    const avail = fs.readFileSync(require.resolve('../services/availability.js'), 'utf8');
    const booking = fs.readFileSync(require.resolve('../routes/booking.js'), 'utf8');
    const a = avail.slice(avail.indexOf('const voiceRow = await trx'), avail.indexOf('return parseInt(row?.count || 0, 10) + parseInt(voiceRow?.count'));
    expect(a).toContain("heldVisitSubquery(this, 'scheduled_services')");
    expect(a.match(/await trx\(/g)).toHaveLength(1);
    const b = booking.slice(booking.indexOf('const voiceCountQuery = db('), booking.indexOf('const voiceCounts = await voiceCountQuery;'));
    expect(b).toContain("heldVisitSubquery(this, 'scheduled_services')");
  });
  test('the exclusion is the hold subquery correlated to the outer visit: unconfirmed and not cancelled / skipped / rescheduled', () => {
    const raws = [];
    const q = { select() { return q; }, from() { return q; }, where() { return q; }, whereRaw(s) { raws.push(s); return q; } };
    heldVisitSubquery(q, 'scheduled_services');
    expect(raws).toContain("hold_ti.payload->>'scheduled_service_id' = scheduled_services.id::text");
    expect(raws).toContain('scheduled_services.customer_confirmed = false');
    expect(raws).toContain("scheduled_services.status NOT IN ('cancelled', 'skipped', 'rescheduled')");
  });
});

describe('follow-up plan refresh on reuse', () => {
  const plan = (d, w = '09:00') => ({ scheduledDate: d, windowStart: w });
  const make = (payload) => {
    const updates = [];
    const conn = (table) => {
      const q = {
        where() { return q; }, whereRaw() { return q; }, orderBy() { return q; },
        first: async () => (payload ? { id: 't1', status: 'resolved', payload, summary: 'x' } : null),
        update: async (u) => { updates.push({ table, u }); return 1; },
      };
      return q;
    };
    conn.raw = (sql, b) => ({ sql, b });
    return { conn, updates };
  };
  const base = { street_level_address: true, scheduled_service_id: 'v1' };

  test('a newly discovered follow-up is written onto the hold card (any status)', async () => {
    const { conn, updates } = make(base);
    expect(await refreshHoldFollowUpPlan(conn, { callLogId: 'c1', visitId: 'v1', plan: plan('2026-10-19') })).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].u.payload.b[0]).toContain('2026-10-19');
  });
  test('a corrected date replaces the old one; an unchanged plan, or no plan, writes nothing', async () => {
    const changed = make({ ...base, follow_up_plan: { scheduled_date: '2026-10-19', window_start: '09:00' } });
    expect(await refreshHoldFollowUpPlan(changed.conn, { callLogId: 'c1', visitId: 'v1', plan: plan('2026-10-26') })).toBe(true);
    expect(changed.updates[0].u.payload.b[0]).toContain('2026-10-26');
    const same = make({ ...base, follow_up_plan: { scheduled_date: '2026-10-19', window_start: '09:00' } });
    expect(await refreshHoldFollowUpPlan(same.conn, { callLogId: 'c1', visitId: 'v1', plan: plan('2026-10-19') })).toBe(false);
    const none = make(base);
    expect(await refreshHoldFollowUpPlan(none.conn, { callLogId: 'c1', visitId: 'v1', plan: null })).toBe(false);
    expect(none.updates).toHaveLength(0);
    expect(await refreshHoldFollowUpPlan(make(null).conn, { callLogId: 'c1', visitId: 'v1', plan: plan('2026-10-19') })).toBe(false);
  });
  test('the reuse path refreshes the card before returning without a child', () => {
    const s = fs.readFileSync(require.resolve('../services/call-recording-processor.js'), 'utf8');
    const at = s.indexOf('if (await isStreetLevelHoldRow(trx, primaryRow)) {');
    expect(s.slice(at, at + 500)).toContain('await refreshHoldFollowUpPlan(trx, { callLogId: primaryRow.source_call_log_id, visitId: primaryRow.id, plan: callFollowUpPlan });');
    expect(s.slice(at, at + 600)).toContain('return null;');
  });
});
