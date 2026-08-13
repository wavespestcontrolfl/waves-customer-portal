// ROUTE-TIERS core rules: the tier ladder (exact 7/14-day boundaries), the
// cumulative drift budget from the recurrence anchor, destination legality,
// anchor derivation, and the reminder-sent freeze incl. fail-closed reads.
const {
  daysBetween,
  tierRadiusForDaysOut,
  tierMoveWindow,
  loadAnchorMap,
  resolveAnchor,
  loadReminderFreeze,
  DRIFT_BUDGET_DAYS,
  MIN_DESTINATION_DAYS_OUT,
} = require('../services/auto-dispatch/route-tiers');

describe('daysBetween', () => {
  test('whole calendar days, order-sensitive', () => {
    expect(daysBetween('2026-08-13', '2026-08-27')).toBe(14);
    expect(daysBetween('2026-08-13', '2026-08-13')).toBe(0);
    expect(daysBetween('2026-08-27', '2026-08-13')).toBe(-14);
  });
  test('DST seam does not roll the count (Nov 1 2026 fall-back)', () => {
    expect(daysBetween('2026-10-30', '2026-11-03')).toBe(4);
  });
  test('unparseable input returns null', () => {
    expect(daysBetween('garbage', '2026-08-13')).toBeNull();
    expect(daysBetween(null, '2026-08-13')).toBeNull();
  });
});

describe('tierRadiusForDaysOut — exact ladder boundaries', () => {
  test('tier 1: >= 14 days out ⇒ ±5', () => {
    expect(tierRadiusForDaysOut(14)).toBe(5); // boundary
    expect(tierRadiusForDaysOut(15)).toBe(5);
    expect(tierRadiusForDaysOut(90)).toBe(5);
  });
  test('tier 2: 7–13 days out ⇒ ±3', () => {
    expect(tierRadiusForDaysOut(13)).toBe(3); // boundary (just under 14)
    expect(tierRadiusForDaysOut(7)).toBe(3);  // boundary
  });
  test('tier 3 / frozen: under 7 days ⇒ 0 (no day-moves)', () => {
    expect(tierRadiusForDaysOut(6)).toBe(0); // boundary (just under 7)
    expect(tierRadiusForDaysOut(3)).toBe(0);
    expect(tierRadiusForDaysOut(0)).toBe(0);
    expect(tierRadiusForDaysOut(-1)).toBe(0);
  });
  test('non-finite input fails closed to 0', () => {
    expect(tierRadiusForDaysOut(NaN)).toBe(0);
    expect(tierRadiusForDaysOut(undefined)).toBe(0);
    expect(tierRadiusForDaysOut(null)).toBe(0);
  });
});

describe('tierMoveWindow — radius ∩ drift budget ∩ destination floor', () => {
  const today = '2026-08-13';

  test('never-moved tier-1 visit: full ±5 window around its date', () => {
    // 20 days out, anchor == current date
    const w = tierMoveWindow({ origDate: '2026-09-02', anchorDate: '2026-09-02', today, radius: 5 });
    expect(w).toEqual({ dateFrom: '2026-08-28', dateTo: '2026-09-07' });
  });

  test('destination legality: the window never dips under today+5', () => {
    // 7 days out (tier 2, ±3): orig-3 = today+4 — illegal; floor at today+5.
    const w = tierMoveWindow({ origDate: '2026-08-20', anchorDate: '2026-08-20', today, radius: 3 });
    expect(w).toEqual({ dateFrom: '2026-08-18', dateTo: '2026-08-23' });
    expect(w.dateFrom >= '2026-08-18').toBe(true); // today+5
  });

  test('moving later is always inside the radius; earlier is floored', () => {
    const w = tierMoveWindow({ origDate: '2026-08-19', anchorDate: '2026-08-19', today, radius: 3 });
    // orig-3 = 08-16 < today+5 = 08-18 → floored
    expect(w.dateFrom).toBe('2026-08-18');
    expect(w.dateTo).toBe('2026-08-22');
  });

  test('drift budget is CUMULATIVE across tiers: tier 2 only spends what tier 1 left', () => {
    // Anchor 2026-09-01; tier 1 already moved the visit +4 to 2026-09-05.
    // Now (tier 2, ±3) the radius alone would allow up to 09-08, but the ±5
    // budget from the anchor caps at 09-06.
    const w = tierMoveWindow({ origDate: '2026-09-05', anchorDate: '2026-09-01', today, radius: 3 });
    expect(w.dateTo).toBe('2026-09-06'); // anchor+5, NOT orig+3=09-08
    expect(w.dateFrom).toBe('2026-09-02'); // orig-3 (anchor-5=08-27 is looser)
  });

  test('sequential moves: a second move can only spend the remaining budget', () => {
    const anchor = '2026-09-01';
    // Move 1 (tier 1, ±5): full window 08-27..09-06 available.
    const w1 = tierMoveWindow({ origDate: anchor, anchorDate: anchor, today, radius: 5 });
    expect(w1).toEqual({ dateFrom: '2026-08-27', dateTo: '2026-09-06' });
    // Suppose it moved to 09-05 (+4). Move 2 (tier 1 again, ±5):
    const w2 = tierMoveWindow({ origDate: '2026-09-05', anchorDate: anchor, today, radius: 5 });
    expect(w2.dateTo).toBe('2026-09-06'); // only +1 of budget left
    expect(w2.dateFrom).toBe('2026-08-31'); // orig-5 still within anchor-5
    // Suppose it then lands ON the budget edge 09-06. Move 3:
    const w3 = tierMoveWindow({ origDate: '2026-09-06', anchorDate: anchor, today, radius: 5 });
    expect(w3.dateTo).toBe('2026-09-06'); // no later budget at all
  });

  test('empty intersection returns null (budget exhausted)', () => {
    // Anchor far behind the current date + a floor pushing from below can
    // empty the window: orig way past anchor+5 (data drift) → no legal dates.
    const w = tierMoveWindow({ origDate: '2026-09-20', anchorDate: '2026-09-01', today, radius: 3 });
    // orig-3=09-17 > anchor+5=09-06 ⇒ empty
    expect(w).toBeNull();
  });

  test('missing inputs return null (fail closed)', () => {
    expect(tierMoveWindow({ origDate: null, anchorDate: '2026-09-01', today, radius: 5 })).toBeNull();
    expect(tierMoveWindow({ origDate: '2026-09-01', anchorDate: null, today, radius: 5 })).toBeNull();
    expect(tierMoveWindow({ origDate: '2026-09-01', anchorDate: '2026-09-01', today, radius: 0 })).toBeNull();
  });

  test('constants match the approved policy', () => {
    expect(DRIFT_BUDGET_DAYS).toBe(5);
    expect(MIN_DESTINATION_DAYS_OUT).toBe(5);
  });
});

// ── Anchor derivation (durable move evidence, cumulative across writers) ───
function anchorDbStub({ moveRows = [], auditRows = [], throwOn = null } = {}) {
  return (table) => {
    const c = {};
    ['whereIn', 'where', 'orderBy'].forEach((m) => { c[m] = () => c; });
    c.select = async () => {
      if (throwOn === table) throw new Error('db down');
      if (table === 'reschedule_log') return moveRows;
      if (table === 'auto_dispatch_audit_logs') return auditRows;
      return [];
    };
    return c;
  };
}

describe('anchor derivation', () => {
  test('never-moved visit (no evidence anywhere) anchors at its current scheduled_date', async () => {
    const map = await loadAnchorMap(anchorDbStub(), ['s1']);
    const svc = { id: 's1', scheduled_date: '2026-09-02', auto_dispatch_change_count: 0 };
    expect(resolveAnchor(svc, map)).toBe('2026-09-02');
  });

  test('moved visit anchors at the EARLIEST transactional reschedule_log original_date', async () => {
    const map = await loadAnchorMap(anchorDbStub({
      moveRows: [
        { scheduled_service_id: 's1', original_date: '2026-09-01', created_at: '2026-08-01' },
        { scheduled_service_id: 's1', original_date: '2026-09-03', created_at: '2026-08-05' },
      ],
    }), ['s1']);
    const svc = { id: 's1', scheduled_date: '2026-09-05', auto_dispatch_change_count: 2 };
    expect(resolveAnchor(svc, map)).toBe('2026-09-01');
  });

  test('audit trail is a CUMULATIVE fallback when reschedule_log has no row', async () => {
    const map = await loadAnchorMap(anchorDbStub({
      auditRows: [{ scheduled_service_id: 's1', old_scheduled_date: '2026-09-02', created_at: '2026-08-02' }],
    }), ['s1']);
    const svc = { id: 's1', scheduled_date: '2026-09-04', auto_dispatch_change_count: 1 };
    expect(resolveAnchor(svc, map)).toBe('2026-09-02');
  });

  test('a lost change_count stamp cannot reset the anchor — durable evidence wins', async () => {
    // Move committed (reschedule_log row) but the best-effort counter stamp
    // failed, so change_count is still 0. The anchor must stay the pre-move
    // date, not the current one (codex pre-push P1).
    const map = await loadAnchorMap(anchorDbStub({
      moveRows: [{ scheduled_service_id: 's1', original_date: '2026-09-01', created_at: '2026-08-01' }],
    }), ['s1']);
    const svc = { id: 's1', scheduled_date: '2026-09-05', auto_dispatch_change_count: 0 };
    expect(resolveAnchor(svc, map)).toBe('2026-09-01');
  });

  test('change_count>0 with NO durable evidence is anchor-unknown ⇒ null (no move)', async () => {
    const map = await loadAnchorMap(anchorDbStub(), ['s1']);
    const svc = { id: 's1', scheduled_date: '2026-09-05', auto_dispatch_change_count: 1 };
    expect(resolveAnchor(svc, map)).toBeNull();
  });

  test('evidence query failure fails closed for EVERY visit', async () => {
    for (const throwOn of ['reschedule_log', 'auto_dispatch_audit_logs']) {
      const map = await loadAnchorMap(anchorDbStub({ throwOn }), ['s1']);
      expect(map).toBeNull();
      expect(resolveAnchor({ id: 's1', scheduled_date: '2026-09-05', auto_dispatch_change_count: 1 }, map)).toBeNull();
      expect(resolveAnchor({ id: 's2', scheduled_date: '2026-09-09', auto_dispatch_change_count: 0 }, map)).toBeNull();
    }
  });
});

// ── Reminder-sent freeze ───────────────────────────────────────────────────
function reminderDbStub({ rows = [], owners = [], throwOnFirstQuery = false, throwOnOwnerQuery = false } = {}) {
  let call = 0;
  return () => {
    call++;
    const isOwnerQuery = call > 1;
    const c = {};
    ['whereIn', 'where'].forEach((m) => { c[m] = () => c; });
    c.select = async () => {
      if (!isOwnerQuery && throwOnFirstQuery) throw new Error('db down');
      if (isOwnerQuery && throwOnOwnerQuery) throw new Error('db down');
      return isOwnerQuery ? owners : rows;
    };
    return c;
  };
}

describe('loadReminderFreeze (72h reminder is the HARD gate)', () => {
  const T = '2026-08-20T12:00:00.000Z';

  test('sent flag on the visit-linked row freezes the visit', async () => {
    const res = await loadReminderFreeze(reminderDbStub({
      rows: [{ scheduled_service_id: 's1', customer_id: 'c1', appointment_time: T, reminder_72h_sent: true, suppressed_by_sibling: false }],
    }), ['s1']);
    expect(res.failed).toBe(false);
    expect(res.frozen.has('s1')).toBe(true);
  });

  test('unsent row does not freeze; no row at all does not freeze', async () => {
    const res = await loadReminderFreeze(reminderDbStub({
      rows: [{ scheduled_service_id: 's1', customer_id: 'c1', appointment_time: T, reminder_72h_sent: false, suppressed_by_sibling: false }],
    }), ['s1', 's2']);
    expect(res.failed).toBe(false);
    expect(res.frozen.size).toBe(0);
  });

  test('suppressed sibling placeholder: frozen only when the slot OWNER row sent', async () => {
    const base = { scheduled_service_id: 's1', customer_id: 'c1', appointment_time: T, reminder_72h_sent: true, suppressed_by_sibling: true };
    // Owner sent → the merged-label text covered this visit → frozen.
    let res = await loadReminderFreeze(reminderDbStub({
      rows: [base],
      owners: [{ customer_id: 'c1', appointment_time: T }],
    }), ['s1']);
    expect(res.frozen.has('s1')).toBe(true);
    // No sent owner → the placeholder's own pre-set flags mean nothing → free.
    res = await loadReminderFreeze(reminderDbStub({ rows: [base], owners: [] }), ['s1']);
    expect(res.frozen.has('s1')).toBe(false);
  });

  test('FAIL CLOSED: an unreadable reminder table reports failed=true', async () => {
    const res = await loadReminderFreeze(reminderDbStub({ throwOnFirstQuery: true }), ['s1']);
    expect(res.failed).toBe(true);
  });

  test('FAIL CLOSED: owner-lookup failure also reports failed=true', async () => {
    const res = await loadReminderFreeze(reminderDbStub({
      rows: [{ scheduled_service_id: 's1', customer_id: 'c1', appointment_time: T, reminder_72h_sent: true, suppressed_by_sibling: true }],
      throwOnOwnerQuery: true,
    }), ['s1']);
    expect(res.failed).toBe(true);
  });

  test('empty id list is a clean no-op', async () => {
    const res = await loadReminderFreeze(reminderDbStub({ throwOnFirstQuery: true }), []);
    expect(res).toEqual({ failed: false, frozen: new Set() });
  });
});
