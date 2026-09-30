// Street-level address hold lifecycle (owner ruling 2026-09-30): the review card
// closes with a cancelled / skipped visit, and an unconfirmed hold takes no
// self-book daily-cap capacity. Synthetic data only.
const fs = require('fs');
const { closeHoldCardForEndedVisit, heldVisitSubquery, refreshHoldFollowUpPlan, hasOwedFollowUpForStreetLevelVisit, isStreetLevelHoldVisit } = require('../services/street-level-hold');

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

describe('r14: owned follow-up, review status after rejection, bell recheck, voice dedupe', () => {
  const proc = () => fs.readFileSync(require.resolve('../services/call-recording-processor.js'), 'utf8');
  const visit = { id: 'v1', source_call_log_id: 'c1' };
  const conn = ({ hold, owed }) => (table) => {
    const q = { where() { return q; }, whereRaw() { return q; }, orderBy() { return q; }, first: async () => (table === 'triage_items' && q._owed ? owed : (q._hold === false ? null : hold)) };
    q.where = (arg) => { if (arg && arg.reason_code === 'attached_booking_followup_unbooked') q._owed = true; return q; };
    return q;
  };
  const holdCard = { id: 't1', status: 'resolved', payload: { street_level_address: true, scheduled_service_id: 'v1' } };

  test('the office owns the owed follow-up: a reprocess after the confirm creates no child while the hook\'s card exists (any status)', async () => {
    expect(await hasOwedFollowUpForStreetLevelVisit(conn({ hold: holdCard, owed: { id: 'o1' } }), visit)).toBe(true);
    expect(await hasOwedFollowUpForStreetLevelVisit(conn({ hold: holdCard, owed: null }), visit)).toBe(false);   // no owed card: normal creation
    expect(await hasOwedFollowUpForStreetLevelVisit(conn({ hold: null, owed: { id: 'o1' } }), visit)).toBe(false);   // not a street-level visit
    const s = proc();
    const existing = s.indexOf('if (existingChild) return null;');
    const owned = s.indexOf('if (await hasOwedFollowUpForStreetLevelVisit(trx, primaryRow)) return null;', existing);
    expect(owned).toBeGreaterThan(existing);
    expect(owned - existing).toBeLessThan(900);
  });

  test('transcript rejection recomputes review_status after dismissing the other cards, under the same lock', () => {
    const s = proc();
    const at = s.indexOf("'Transcript rejected as an implausible hallucination.'");
    const block = s.slice(at - 900, at + 900);
    expect(block.indexOf('await lockTriageCall(trx, call.id);')).toBeLessThan(block.indexOf('.whereRaw(SUPERSEDE_KEPT_CARD_SQL)'));
    expect(block.indexOf('.whereRaw(SUPERSEDE_KEPT_CARD_SQL)')).toBeLessThan(block.indexOf('await syncCallReviewStatus(trx, call.id, null);'));
  });

  test('the confirm-address bell reads the visit live right before ringing; a confirmed visit rings nothing, a lookup blip rings', async () => {
    const s = proc();
    const check = s.indexOf('if (!(await isStreetLevelHoldVisit(svc.id, db, { failClosed: false }))) {');
    const build = s.indexOf('const alert = buildStreetLevelHoldAlert({', check);
    expect(check).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(check);
    // The race: confirmed since the booking committed -> not a hold any more -> no bell.
    const confirmedNow = () => ({ where() { return this; }, whereExists() { return this; }, first: async () => undefined });
    expect(await isStreetLevelHoldVisit('v1', confirmedNow, { failClosed: false })).toBe(false);
    const stillHeld = () => ({ where() { return this; }, whereExists() { return this; }, first: async () => ({ id: 'v1' }) });
    expect(await isStreetLevelHoldVisit('v1', stillHeld, { failClosed: false })).toBe(true);
    const blip = () => { throw new Error('db down'); };
    expect(await isStreetLevelHoldVisit('v1', blip, { failClosed: false })).toBe(false);   // bell path: ring
    expect(await isStreetLevelHoldVisit('v1', blip)).toBe(true);                             // reminder path: hold
  });

  test('voice-agent booking dedupe: an unconfirmed street-level hold blocks only a matching start, like any pipeline booking', () => {
    const s = fs.readFileSync(require.resolve('../services/voice-agent/relay-booking.js'), 'utf8');
    const at = s.indexOf('const existing = await trx(\'scheduled_services\')');
    const block = s.slice(at, at + 1600);
    expect(block).toContain(".orWhere((q2) => q2\n            .where('source_action', VOICE_AGENT_BOOKING_SOURCE_ACTION)\n            .whereNotExists(function () { require('../street-level-hold').heldVisitSubquery(this, 'scheduled_services'); })))");
    expect(block).toContain(".where('window_start', windowStart)");
    // Source action unchanged (owner ruling 2026-09-30).
    expect(s).toContain('source_action: VOICE_AGENT_BOOKING_SOURCE_ACTION,');
  });
});
