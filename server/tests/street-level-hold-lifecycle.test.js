// Street-level address hold lifecycle (owner ruling 2026-09-30): the review card
// closes with a cancelled / skipped visit, and an unconfirmed hold takes no
// self-book daily-cap capacity. Synthetic data only.
const fs = require('fs');
const { refreshOwedFollowUpPlan, reopenHoldCardForRestoredVisit, closeHoldCardForEndedVisit, heldVisitSubquery, refreshHoldFollowUpPlan, hasOwedFollowUpForStreetLevelVisit, isStreetLevelHoldVisit } = require('../services/street-level-hold');

const card = (status = 'open') => ({ id: 't1', status, payload: { street_level_address: true, scheduled_service_id: 'visit-1' }, summary: 'x' });

// A fake conn: scheduled_services lookup, triage card lookup/update, call_log update, review aggregate.
const makeConn = ({ visit = { id: 'visit-1', source_call_log_id: 'call-1' }, holdCard = card(), openAfter = 0, liveStatus } = {}) => {
  const log = { updates: [], locked: false, raws: [] };
  const conn = (table) => {
    const q = {
      where(arg) { q._where = arg; return q; }, whereIn() { return q; }, whereRaw() { return q; }, orderBy() { return q; }, count() { q._count = true; return q; }, forUpdate() { q._forUpdate = true; return q; },
      first: async () => {
        if (table === 'scheduled_services' && q._forUpdate) { log.rechecked = true; return liveStatus === null ? null : { status: liveStatus, customer_confirmed: false }; }
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
      const { conn, log } = makeConn({ liveStatus: toStatus });
      expect(await closeHoldCardForEndedVisit('visit-1', toStatus, conn)).toBe(true);
      expect(log.rechecked).toBe(true);
      expect(log.locked).toBe(true);
      const cardUpdate = log.updates.find((u) => u.table === 'triage_items');
      expect(cardUpdate.where).toEqual({ id: 't1' });
      expect(cardUpdate.u).toMatchObject({ status: 'resolved' });
      expect(cardUpdate.u.resolution_note).toContain(toStatus);
      expect(log.updates.find((u) => u.table === 'call_log').u).toMatchObject({ review_status: 'resolved' });
    });
  }
  test('another open card on the call keeps review_status open', async () => {
    const { conn, log } = makeConn({ openAfter: 1, liveStatus: 'cancelled' });
    await closeHoldCardForEndedVisit('visit-1', 'cancelled', conn);
    expect(log.updates.find((u) => u.table === 'call_log').u).toMatchObject({ review_status: 'open' });
  });
  test('byte-identical for everything else: not a voice_agent visit, no street-level card, or the card is already closed', async () => {
    for (const opts of [{ visit: null }, { visit: { id: 'v', source_call_log_id: null } }, { holdCard: null }, { holdCard: card('resolved') }]) {
      const { conn, log } = makeConn(opts);
      expect(await closeHoldCardForEndedVisit('visit-1', 'cancelled', conn)).toBeNull();
      expect(log.updates).toHaveLength(0);
      expect(log.locked).toBe(false);
    }
  });
  test('a COMPENSATED cancellation (the tech went live, the prior status was restored) leaves the card open', async () => {
    for (const restored of ['confirmed', 'en_route', 'pending']) {
      const { conn, log } = makeConn({ liveStatus: restored });
      expect(await closeHoldCardForEndedVisit('visit-1', 'cancelled', conn)).toBeNull();
      expect(log.rechecked).toBe(true);
      expect(log.updates).toHaveLength(0);
    }
    const gone = makeConn({ liveStatus: null });
    expect(await closeHoldCardForEndedVisit('visit-1', 'cancelled', gone.conn)).toBeNull();
  });
  test('never throws; a database failure answers false (retryable), distinct from a no-op (null)', async () => {
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
    const owned = s.indexOf('if (await hasOwedFollowUpForStreetLevelVisit(trx, primaryRow)) {', existing);
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
    const check = s.indexOf('if (!(await isStreetLevelHoldVisit(visit.id, db))) {');
    const build = s.indexOf('const alert = buildStreetLevelHoldAlert({', check);
    expect(check).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(check);
    // The race: confirmed since the booking committed -> not a hold any more -> no bell.
    const confirmedNow = () => ({ where() { return this; }, whereExists() { return this; }, first: async () => undefined });
    expect(await isStreetLevelHoldVisit('v1', confirmedNow)).toBe(false);
    const stillHeld = () => ({ where() { return this; }, whereExists() { return this; }, first: async () => ({ id: 'v1' }) });
    expect(await isStreetLevelHoldVisit('v1', stillHeld)).toBe(true);
    // A lookup blip answers "still held": the reminder path holds, the bell path rings.
    const blip = () => { throw new Error('db down'); };
    expect(await isStreetLevelHoldVisit('v1', blip)).toBe(true);
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

describe('r16: order-independent close / reopen around a compensated cancellation', () => {
  // A stateful fake: one visit, one street-level card, one call. Both helpers run against it.
  const makeWorld = ({ visitStatus = 'pending', cardStatus = 'open', confirmed = false, otherOpen = false } = {}) => {
    const w = { visit: { id: 'v1', source_call_log_id: 'c1', source_action: 'voice_agent', status: visitStatus, customer_confirmed: confirmed },
      card: { id: 't1', status: cardStatus, summary: 'x', payload: { street_level_address: true, scheduled_service_id: 'v1' } }, review: 'open', otherOpen, locked: 0 };
    const conn = (table) => {
      const q = {
        where(arg) { q._where = arg; return q; }, whereIn() { return q; }, whereRaw() { return q; }, orderBy() { return q; }, forUpdate() { q._fu = true; return q; },
        count() { q._count = true; return q; },
        first: async () => {
          if (table === 'scheduled_services') return q._fu ? { status: w.visit.status, customer_confirmed: w.visit.customer_confirmed } : w.visit;
          if (q._count) return { n: (['open', 'in_progress'].includes(w.card.status) ? 1 : 0) + (w.otherOpen ? 1 : 0) };
          if (q._where && q._where.reason_code && !q._where.call_log_id === false && q._standing) return undefined;
          return w.card;
        },
        update: async (u) => {
          if (table === 'triage_items') { Object.assign(w.card, u); return 1; }
          if (table === 'call_log') { w.review = u.review_status; return 1; }
          return 0;
        },
      };
      // The "standing open card" probe (whereIn on status before first) must see the card's live status.
      const wi = q.whereIn; q.whereIn = (...a) => { q._standing = true; return wi(...a); };
      const f = q.first; q.first = async () => { if (table === 'triage_items' && q._standing && !q._count) return ['open', 'in_progress'].includes(w.card.status) ? w.card : undefined; return f(); };
      return q;
    };
    conn.raw = async () => { w.locked += 1; return { rows: [{}] }; };
    conn.transaction = async (fn) => fn(conn);
    return { w, conn };
  };

  test('ordering A: the close ran first (visit still cancelled), then the restoration reopens the card and recomputes review_status', async () => {
    const { w, conn } = makeWorld({ visitStatus: 'cancelled', cardStatus: 'resolved' });
    w.review = 'resolved';
    w.visit.status = 'pending';                      // the compensation restored the prior status
    expect(await reopenHoldCardForRestoredVisit('v1', conn)).toBe(true);
    expect(w.card.status).toBe('open');
    expect(w.card.resolved_at).toBeNull();
    expect(w.card.resolution_note).toContain('Reopened');
    expect(w.review).toBe('open');
    expect(w.locked).toBeGreaterThan(0);
  });

  test('ordering B: the restoration ran first, so the close finds the visit live and leaves the card open', async () => {
    const { w, conn } = makeWorld({ visitStatus: 'pending', cardStatus: 'open' });
    expect(await closeHoldCardForEndedVisit('v1', 'cancelled', conn)).toBeNull();
    expect(w.card.status).toBe('open');
    // ...and a reopen then has nothing to do.
    expect(await reopenHoldCardForRestoredVisit('v1', conn)).toBe(false);
  });

  test('a restored visit that is confirmed, ended again, or already has an open card does not reopen; non-holds are untouched', async () => {
    for (const opts of [{ confirmed: true }, { visitStatus: 'cancelled' }, { visitStatus: 'skipped' }]) {
      const { w, conn } = makeWorld({ cardStatus: 'resolved', ...opts });
      expect(await reopenHoldCardForRestoredVisit('v1', conn)).toBe(false);
      expect(w.card.status).toBe('resolved');
    }
    const plain = makeWorld({ cardStatus: 'resolved' });
    plain.w.visit.source_action = 'ai_call_pipeline';
    plain.conn = (() => { const c = plain.conn; return (t) => { const q = c(t); const fst = q.first; q.first = async () => (t === 'scheduled_services' && !q._fu ? null : fst()); return q; }; })();
    expect(await reopenHoldCardForRestoredVisit('v1', plain.conn)).toBe(false);
  });

  test('the shared transition wires both directions: terminal -> live reopens, live -> terminal closes', () => {
    const s = fs.readFileSync(require.resolve('../services/job-status.js'), 'utf8');
    expect(s).toContain("if (['cancelled', 'skipped'].includes(String(fromStatus || ''))) {\n        void require('./street-level-hold').reopenHoldCardForRestoredVisit(jobId)");
    expect(s).toContain("void require('./street-level-hold').closeHoldCardForEndedVisit(jobId, toStatus)");
    // The compensation goes through that shared point.
    const cp = fs.readFileSync(require.resolve('../services/cancellation-processor.js'), 'utf8');
    expect(cp).toContain("fromStatus: 'cancelled',\n              toStatus: svc.status,");
  });
});

describe('r18: an OPEN owed follow-up task takes the current plan', () => {
  const plan = (d, w = '09:00') => ({ scheduledDate: d, windowStart: w });
  const make = (card) => {
    const updates = [];
    const conn = (table) => {
      const q = {
        where() { return q; }, whereRaw() { return q; }, whereIn(col, vals) { q._statuses = vals; return q; },
        first: async () => (card && q._statuses && q._statuses.includes(card.status) ? card : null),
        update: async (u) => { updates.push(u); return 1; },
      };
      return q;
    };
    conn.raw = (sql, b) => ({ sql, b });
    return { conn, updates };
  };
  const visit = { id: 'v1', source_call_log_id: 'c1' };
  const owed = (status, p) => ({ id: 'o1', status, payload: { skipped_reason: 'street_level_address_confirmed_follow_up_unbooked', ...(p ? { follow_up_plan: p } : {}) } });

  test('an open card is refreshed with a newly found or corrected plan', async () => {
    const a = make(owed('open'));
    expect(await refreshOwedFollowUpPlan(a.conn, visit, plan('2026-10-19'))).toBe(true);
    expect(a.updates[0].payload.b[0]).toContain('2026-10-19');
    const b = make(owed('in_progress', { scheduled_date: '2026-10-19', window_start: '09:00' }));
    expect(await refreshOwedFollowUpPlan(b.conn, visit, plan('2026-10-26'))).toBe(true);
    expect(b.updates[0].payload.b[0]).toContain('2026-10-26');
  });
  test('resolved / dismissed cards, an unchanged plan and a null plan are left untouched', async () => {
    for (const status of ['resolved', 'dismissed']) {
      const r = make(owed(status));
      expect(await refreshOwedFollowUpPlan(r.conn, visit, plan('2026-10-19'))).toBe(false);
      expect(r.updates).toHaveLength(0);
    }
    const same = make(owed('open', { scheduled_date: '2026-10-19', window_start: '09:00' }));
    expect(await refreshOwedFollowUpPlan(same.conn, visit, plan('2026-10-19'))).toBe(false);
    expect(await refreshOwedFollowUpPlan(make(owed('open')).conn, visit, null)).toBe(false);
  });
  test('the reuse path refreshes the open owed card before returning without a child', () => {
    const s = fs.readFileSync(require.resolve('../services/call-recording-processor.js'), 'utf8');
    const at = s.indexOf('if (await hasOwedFollowUpForStreetLevelVisit(trx, primaryRow)) {');
    expect(s.slice(at, at + 500)).toContain('await refreshOwedFollowUpPlan(trx, primaryRow, callFollowUpPlan);');
    expect(s.slice(at, at + 600)).toContain('return null;');
  });
});

describe('r22: the follow-up refresh is serialized with the office confirm and reconciles a late plan', () => {
  const confirm = require('../services/outbound-review-confirm');
  const plan = { scheduledDate: '2026-10-26', windowStart: '09:00' };
  const world = (status) => {
    const log = { locked: 0, updates: [] };
    const conn = (table) => {
      const q = {
        where() { return q; }, whereRaw() { return q; }, orderBy() { return q; },
        first: async () => ({ id: 't1', status, summary: 'x', payload: { street_level_address: true, scheduled_service_id: 'v1', follow_up_plan: { scheduled_date: '2026-10-19', window_start: '09:00' } } }),
        update: async (u) => { log.updates.push({ table, u }); return 1; },
      };
      return q;
    };
    conn.raw = async () => { log.locked += 1; return { rows: [{}] }; };
    return { conn, log };
  };

  test('takes the per-call lock first, so it cannot interleave with the confirm hook', async () => {
    const spy = jest.spyOn(confirm, 'fileOwedFollowUpForStreetLevelHold').mockResolvedValue(true);
    const { conn, log } = world('open');
    expect(await refreshHoldFollowUpPlan(conn, { callLogId: 'c1', visitId: 'v1', plan })).toBe(true);
    expect(log.locked).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();        // the card is still open: the hook will read the fresh plan
    spy.mockRestore();
  });

  test('the confirm already consumed the card (resolved): the late plan is reconciled into the owed-follow-up task', async () => {
    const spy = jest.spyOn(confirm, 'fileOwedFollowUpForStreetLevelHold').mockResolvedValue(true);
    const { conn } = world('resolved');
    expect(await refreshHoldFollowUpPlan(conn, { callLogId: 'c1', visitId: 'v1', plan })).toBe(true);
    expect(spy).toHaveBeenCalledWith(conn, { id: 'v1', source_call_log_id: 'c1' });
    spy.mockRestore();
  });
});

describe('r22: one lock order for the hold lifecycle (per-call triage lock, then the visit row)', () => {
  const read = (f) => fs.readFileSync(require.resolve(f), 'utf8');
  test('promotion, close, reopen and the follow-up refresh all take the triage lock before the visit lock', () => {
    const proc = read('../services/call-recording-processor.js');
    const promote = proc.slice(proc.indexOf('async function promoteReusedRowToStreetLevelHold'), proc.indexOf('// Rings the one "confirm the address" admin bell'));
    expect(promote.indexOf('await lockTriageCall(trx, callId);')).toBeGreaterThan(-1);
    expect(promote.indexOf('await lockTriageCall(trx, callId);')).toBeLessThan(promote.indexOf(".forUpdate().first('status', 'customer_confirmed')"));
    const hold = read('../services/street-level-hold.js');
    for (const fn of ['async function closeHoldCardForEndedVisit', 'async function reopenHoldCardForRestoredVisit']) {
      const body = hold.slice(hold.indexOf(fn));
      const end = body.indexOf('\n}\n');
      const f = body.slice(0, end);
      expect(f.indexOf('await lockTriageCall(')).toBeGreaterThan(-1);
      expect(f.indexOf('await lockTriageCall(')).toBeLessThan(f.indexOf('.forUpdate()'));
    }
    const refresh = hold.slice(hold.indexOf('async function refreshHoldFollowUpPlan'));
    expect(refresh.indexOf('lockTriageCall')).toBeGreaterThan(-1);
  });

  test('the reuse branch takes the triage lock before the technician-backfill UPDATE locks the visit row', () => {
    const proc = read('../services/call-recording-processor.js');
    const lock = proc.indexOf('if (existing.source_action === VOICE_AGENT_BOOKING_SOURCE_ACTION) await lockTriageCall(trx, existing.source_call_log_id || call.id);');
    expect(lock).toBeGreaterThan(0);
    const update = proc.indexOf(".update({ technician_id: reuseTechId, route_order: null, updated_at: new Date() })", lock);
    expect(update).toBeGreaterThan(lock);
    expect(proc.indexOf('await promoteReusedRowToStreetLevelHold(trx, primaryRow, promoteArgs);', lock)).toBeGreaterThan(update);
  });
});

describe('r22: an incomplete / declined closeout settles a hold like cancel / skip (card closed, address NOT approved)', () => {
  const read = (f) => fs.readFileSync(require.resolve(f), 'utf8');
  const make = (card, liveStatus = 'completed') => {
    const log = { updates: [], locked: 0 };
    const conn = (table) => {
      const q = {
        where() { return q; }, whereIn() { return q; }, whereRaw() { return q; }, orderBy() { return q; }, forUpdate() { return q; }, count() { q._count = true; return q; },
        first: async () => {
          if (table === 'scheduled_services' && q._fu === undefined) return { id: 'v1', source_call_log_id: 'c1' };
          if (q._count) return { n: 0 };
          return card;
        },
        update: async (u) => { log.updates.push({ table, u }); return 1; },
      };
      const f = q.forUpdate; q.forUpdate = () => { q._fu = true; const r = f(); q.first = async () => ({ status: liveStatus, customer_confirmed: false }); return r; };
      return q;
    };
    conn.raw = (s, b) => { log.locked += 1; return { s, b }; };
    conn.transaction = async (fn) => fn(conn);
    return { conn, log };
  };
  const card = { id: 't1', status: 'open', summary: 'x', payload: { street_level_address: true, scheduled_service_id: 'v1' } };

  for (const outcome of ['incomplete', 'customer_declined']) {
    test(`${outcome}: the card resolves with the note and the closed_out marker, under the per-call lock, and review_status is recomputed`, async () => {
      const { conn, log } = make(card);
      expect(await closeHoldCardForEndedVisit('v1', 'completed', conn, { note: `Visit closed out ${outcome} — address not confirmed`, closedOut: outcome })).toBe(true);
      const t = log.updates.find((u) => u.table === 'triage_items').u;
      expect(t).toMatchObject({ status: 'resolved', resolution_note: `Visit closed out ${outcome} — address not confirmed` });
      expect(t.payload.b[0]).toContain(`"closed_out":"${outcome}"`);
      expect(log.updates.some((u) => u.table === 'call_log')).toBe(true);
      // Nothing approves the address: no field stamp, no activation.
      expect(log.updates.some((u) => u.table === 'scheduled_services')).toBe(false);
      expect(log.locked).toBeGreaterThan(0);
    });
  }

  test('a database failure while settling answers false (not null), and a retry then settles (true)', async () => {
    const opts = { note: 'Visit closed out incomplete — address not confirmed', closedOut: 'incomplete' };
    const ok = make(card);
    let failOnce = true;
    const flaky = (table) => {
      const q = ok.conn(table);
      if (table === 'triage_items') { const u = q.update; q.update = async (x) => { if (failOnce) { failOnce = false; throw new Error('deadlock'); } return u(x); }; }
      return q;
    };
    flaky.raw = ok.conn.raw; flaky.transaction = async (fn) => fn(flaky);
    expect(await closeHoldCardForEndedVisit('v1', 'completed', flaky, opts)).toBe(false);
    expect(ok.log.updates).toHaveLength(0);
    expect(await closeHoldCardForEndedVisit('v1', 'completed', flaky, opts)).toBe(true);
    expect(ok.log.updates.some((u) => u.table === 'triage_items')).toBe(true);
  });

  test('a closed-out card that was already resolved without the marker still gets marked; an already-marked one is a no-op (null)', async () => {
    const opts = { note: 'n', closedOut: 'incomplete' };
    const unmarked = make({ ...card, status: 'resolved' });
    expect(await closeHoldCardForEndedVisit('v1', 'completed', unmarked.conn, opts)).toBe(true);
    const marked = make({ ...card, status: 'resolved', payload: { ...card.payload, closed_out: 'incomplete' } });
    expect(await closeHoldCardForEndedVisit('v1', 'completed', marked.conn, opts)).toBeNull();
    expect(marked.log.updates).toHaveLength(0);
  });

  test('the engine turns a failed settlement into the retryable 503 (release for resume), at both commit sites; cancel/skip ignore the result', () => {
    const c = read('../services/complete-scheduled-service.js');
    expect(c).toContain('return require(\'./street-level-hold\').closeHoldCardForEndedVisit(svc.id, \'completed\'');
    expect(c.split("if (holdRelease === false) {").length - 1).toBe(2);
    expect(read('../services/job-status.js')).toContain("void require('./street-level-hold').closeHoldCardForEndedVisit(jobId, toStatus).catch(");
  });

  test('the engine settles (and never releases) for those outcomes; the hold predicates read the marker; the lazy activation still refuses the closed-out hold', () => {
    const c = read('../services/complete-scheduled-service.js');
    expect(c.split(': await settleHoldAfterUnsuccessfulCloseout(svc, visitOutcome);').length - 1).toBe(2);
    expect(c).toContain('address not confirmed');
    expect(read('../services/street-level-hold.js')).toContain("COALESCE(hold_ti.payload->>'closed_out', '') = ''");
    const t = read('../routes/admin-triage.js');
    expect(t).toContain("AND COALESCE(triage_items.payload->>'closed_out', '') = ''");
    expect(t).toContain('payload.closed_out) return false;');
    // The activation recognizes a hold by its card in ANY state (closed out stays non-activatable).
    expect(read('../services/outbound-review-confirm.js')).toContain('await isStreetLevelHoldVisit(serviceId, db, { includeClosedOut: true })');
  });
});


describe('an unsuccessful closeout whose settlement fails stays retryable (pre-push P1)', () => {
  const src = require('fs').readFileSync(require.resolve('../services/complete-scheduled-service'), 'utf8');
  test('settleHoldAfterUnsuccessfulCloseout returns the close helper result, so false reaches the 503 resume exit', () => {
    const body = src.slice(src.indexOf('async function settleHoldAfterUnsuccessfulCloseout'), src.indexOf('async function completeScheduledService'));
    expect(body).toMatch(/return require\('\.\/street-level-hold'\)\.closeHoldCardForEndedVisit\(/);
    expect(body).not.toMatch(/return null;\s*\}\s*$/);
    expect(src).toMatch(/settleHoldAfterUnsuccessfulCloseout\(svc, visitOutcome\);\s*\n[\s\S]{0,400}if \(holdRelease === false\)/);
  });
});

describe('r23: every completion engine settles a performed completion of a hold through the one shared seam', () => {
  const read = (f) => fs.readFileSync(require.resolve(f), 'utf8');
  test('transitionJobStatus stamps the field confirmation in the transition trx for a performed completion only, before the credit-evidence skip', () => {
    const j = read('../services/job-status.js');
    expect(j).toContain("holdCompletionOutcome = 'performed'");
    const stamp = j.indexOf("whereNull('field_confirmed_at').update({ field_confirmed_at: stampedAt })");
    expect(stamp).toBeGreaterThan(0);
    expect(j.slice(stamp - 700, stamp)).toContain("['incomplete', 'customer_declined'].includes(String(holdCompletionOutcome))");
    expect(j.indexOf('const unapprovedHold', stamp)).toBeGreaterThan(stamp);
    // ...and it lands before the status CAS (so a lost CAS rolls the stamp back).
    expect(j.indexOf(".update({ status: toStatus, updated_at: t.fn.now() })", stamp)).toBeGreaterThan(stamp);
  });
  test('completeScheduledService passes its outcome so an unsuccessful closeout stamps nothing in the seam', () => {
    const c = read('../services/complete-scheduled-service.js');
    expect(c).toContain("holdCompletionOutcome: addressConfirmingOutcome ? 'performed' : String(visitOutcome),");
  });
  test('pest-recap releases a hold it completed before the recap text, and the recap send carries the visit id', () => {
    const r = read('../services/pest-recap.js');
    expect(r).toContain('completedHere = true;');
    const rel = r.indexOf("releaseStreetLevelHoldForPerformedCompletion(serviceId, { technicianId: transitionedBy }, 'pest-recap')");
    expect(rel).toBeGreaterThan(0);
    expect(r.indexOf("purpose: 'service_completion',", rel)).toBeGreaterThan(rel);
    expect(r).toContain("metadata: { original_message_type: 'pest_recap', service_record_id: recordId, scheduled_service_id: serviceId }");
  });
  test('project-completion releases a hold it completed, after commit', () => {
    const p = read('../services/project-completion.js');
    const rel = p.indexOf("releaseStreetLevelHoldForPerformedCompletion(postCommitTrackServiceId");
    expect(rel).toBeGreaterThan(p.indexOf('postCommitTrackServiceId = scheduledService.id;'));
  });
  test('the shared send step reads metadata.scheduled_service_id as the visit (the recap is held while a hold is live)', () => {
    expect(read('../services/messaging/send-customer-message.js')).toContain('input.metadata?.scheduled_service_id');
  });
  test('the release wrapper is exported for the engines that pass through the seam', async () => {
    const { releaseStreetLevelHoldForPerformedCompletion } = require('../services/outbound-review-confirm');
    expect(typeof releaseStreetLevelHoldForPerformedCompletion).toBe('function');
  });
});

describe('r26: the shared field-advance seam and the recap delivery honor a live hold', () => {
  const read = (f) => fs.readFileSync(require.resolve(f), 'utf8');
  const lifecycle = require('../services/street-level-hold');

  test('markOnProperty / markEnRoute skip a live hold (no throw, ids only in the log) before any state change', () => {
    const t = read('../services/track-transitions.js');
    expect(t.split("isStreetLevelHoldVisit(serviceId)) {").length - 1).toBe(2);
    expect(t).toContain("skipped for ${serviceId}: street_level_hold");
    // Fast-path skip + the recheck under the flip's row lock, in each of the two flips.
    expect(t.split("return { ok: false, reason: 'street_level_hold' };").length - 1).toBe(4);
    expect(t).toContain("trx.raw('SELECT 1 FROM scheduled_services WHERE id = ? FOR UPDATE', [serviceId]);");
    expect(t).toContain('isStreetLevelHoldVisit(serviceId, trx)) return null;');
    expect(t.split('await flipUnlessStreetLevelHeld(serviceId,').length - 1).toBe(2);
    // The check sits with the terminal-status guards, ahead of the future-date guard and any write.
    const m = t.indexOf('async function markOnProperty');
    expect(t.indexOf("reason: 'street_level_hold'", m)).toBeLessThan(t.indexOf("reason: 'future_scheduled_date'", m));
  });

  test('startJob refuses a live hold with the 409 street_level_hold error before creating any timer; the routes map it', () => {
    const tt = read('../services/time-tracking.js');
    const start = tt.indexOf('async function startJob');
    const refuse = tt.indexOf("code: 'street_level_hold'", start);
    expect(refuse).toBeGreaterThan(tt.indexOf(".forUpdate().first()", start));
    expect(refuse).toBeLessThan(tt.indexOf(".insert({", start));
    expect(refuse).toBeLessThan(tt.indexOf("entry_type: 'job', status: 'active' })", start));
    expect(read('../routes/tech-timetracking.js')).toContain("err.code === 'street_level_hold') return res.status(409)");
  });

  test('geofence auto-start and the notification start both fall back through the startJob refusal (reminder / 409)', () => {
    expect(read('../services/geofence-handler.js')).toContain('auto startJob failed, falling back to reminder');
    expect(read('../routes/tech-notifications.js')).toContain('return res.status(409).json({ error: err.message });');
  });

  test('startJob and markOnProperty behave: hold refuses / skips, no hold proceeds', async () => {
    jest.resetModules();
    jest.doMock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => true) }));
    const inserts = [];
    const trx = (table) => {
      const q = {
        where() { return q; }, forUpdate() { return q; }, update: async () => 1,
        first: async () => (table === 'scheduled_services' ? { id: 'j1', customer_id: 'c1', service_type: 'x' } : { id: 'shift' }),
        insert(r) { inserts.push(r); return q; }, returning: async () => [{ id: 'e1' }],
      };
      return q;
    };
    trx.raw = async () => ({ rows: [{}] });
    jest.doMock('../models/db', () => { const d = jest.fn(); d.transaction = async (fn) => fn(trx); d.raw = trx.raw; return d; });
    const tt = require('../services/time-tracking');
    await expect(tt.startJob('tech-1', 'j1', {})).rejects.toMatchObject({ status: 409 });
    expect(inserts).toHaveLength(0);
    jest.dontMock('../services/street-level-hold');
    jest.dontMock('../models/db');
    jest.resetModules();
  });

  test('recap delivery carries the visit id so the shared send step applies the hold', () => {
    expect(read('../services/service-report/recap-delivery.js')).toContain("scheduled_service_id: scheduledServiceId },");
    expect(lifecycle.HOLD_REFUSAL).toBeTruthy();
  });
});
