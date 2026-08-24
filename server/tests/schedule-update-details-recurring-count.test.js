/**
 * Edit-appointment visit count on a recurring plan that already exists.
 *
 * The modal could change a plan's cadence but never its length: "End
 * repeating" and "Count" were hidden on a series template, the save dropped
 * recurringCount for anything with a series, and the server's edit path only
 * ever REWROTE existing children's dates. So a 14-day concourse plan could not
 * be capped at two treatments from the appointment.
 *
 * The count is not a stored field — a fixed plan IS recurring_ongoing=false
 * plus exactly N live rows — so setting it means reconciling rows:
 * reconcileRecurringSeriesVisitCount extends from the series' latest live
 * visit when short and cancels the furthest-out visits when long.
 *
 * Unit tests drive the extracted function with a scripted fake connection
 * (harness mirrors recurring-series-maintenance.test.js); source-pattern
 * guards pin the route wiring the unit tests can't reach — lock ordering, the
 * spawn-path exclusion, and the silent post-commit reminder finalize.
 */
jest.mock('../services/job-status', () => ({
  nextClaimTs: jest.fn(() => 'claim-token-1'),
  transitionJobStatus: jest.fn().mockResolvedValue(undefined),
}));

const fs = require('fs');
const path = require('path');

const adminScheduleRouter = require('../routes/admin-schedule');
const {
  reconcileRecurringSeriesVisitCount,
  MAX_SERIES_VISIT_COUNT,
} = adminScheduleRouter._test;
const { transitionJobStatus } = require('../services/job-status');
const { etDateString } = require('../utils/datetime-et');

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

const COLS = {
  recurring_ongoing: {}, skip_weekends: {}, weekend_shift: {}, service_id: {},
  create_invoice_on_complete: {}, estimated_price: {}, appointment_type: {},
  recurring_nth: {}, recurring_weekday: {}, recurring_interval_days: {},
  annual_prepay_term_id: {}, payer_id: {}, po_number: {}, self_pay_override: {},
};

// Dates relative to "today" so the reconcile's future-only filter behaves the
// way it will in production — a fixture pinned to a past calendar year would
// make every candidate look stale and hide real regressions.
const TODAY = etDateString();
function daysOut(n) {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Scriptable fake knex connection (same shape as the maintenance suite's).
// `.transaction(cb)` models a SAVEPOINT — the reconcile only opens one for the
// abort-tolerant add-on preload — and `.schema.hasTable` backs the card-hold
// refusal guard.
function makeConn(handler, { hasCardHoldTable = true } = {}) {
  const buildTable = (table) => {
    const calls = [];
    const b = {};
    const record = (name) => (...args) => {
      if (name === 'where' && typeof args[0] === 'function') {
        const nested = [];
        const sub = {};
        for (const m of ['where', 'orWhere', 'whereIn', 'orWhereIn', 'whereNull', 'orWhereNull', 'whereNotNull', 'whereNot']) {
          sub[m] = (...a) => { nested.push([m, ...a]); return sub; };
        }
        args[0].call(sub, sub);
        calls.push(['whereFn', nested]);
      } else {
        calls.push([name, ...args]);
      }
      return b;
    };
    for (const m of ['where', 'orWhere', 'whereIn', 'whereNotIn', 'whereBetween', 'whereNull', 'whereNotNull', 'orWhereIn', 'whereNot', 'orderBy', 'count', 'select', 'del', 'update', 'limit']) {
      b[m] = record(m);
    }
    b.first = (...args) => {
      calls.push(['first', ...args]);
      return Promise.resolve(handler({ table, calls, op: 'first' }));
    };
    b.columnInfo = () => Promise.resolve(handler({ table, calls, op: 'columnInfo' }));
    b.insert = (data) => {
      calls.push(['insert', data]);
      return {
        returning: () => Promise.resolve(handler({ table, calls, op: 'insertReturning', data })),
        then: (res, rej) => Promise.resolve(handler({ table, calls, op: 'insert', data })).then(res, rej),
      };
    };
    b.then = (res, rej) => Promise.resolve(handler({ table, calls, op: 'await' })).then(res, rej);
    return b;
  };
  const fn = (table) => buildTable(table);
  fn.isTransaction = true;
  fn.raw = () => Promise.resolve();
  fn.fn = { now: () => new Date() };
  fn.schema = {
    hasTable: (t) => Promise.resolve(t === 'estimate_card_holds' ? hasCardHoldTable : true),
  };
  fn.transaction = (cb) => Promise.resolve().then(() => cb(fn));
  return fn;
}

// A biweekly plan anchored 28 days ago, with `upcoming` live visits still on
// the calendar. Ids ascend with the date so assertions can name them.
function scenario({
  upcoming,
  parentOverrides = {},
  coveredVisitIds = [],
  cardHoldVisitIds = [],
  prepaidVisitIds = [],
  paidInvoiceVisitIds = [],
  cardRequestVisitIds = [],
  invoiceRows = null,
  zeroPrepaidAll = false,
  hasCardHoldTable = true,
  // Weekly days-off JSON served through the fake conn (getBlackoutDates reads
  // via the caller's conn/trx).
  weeklyDaysOff = null,
}) {
  const parent = {
    id: 10,
    customer_id: 5,
    is_recurring: true,
    recurring_pattern: 'custom',
    recurring_interval_days: 14,
    recurring_ongoing: true,
    scheduled_date: daysOut(-28),
    window_start: '09:00',
    window_end: '11:00',
    service_type: 'Concourse Treatment',
    time_window: 'morning',
    zone: 'A',
    estimated_duration_minutes: 120,
    skip_weekends: false,
    technician_id: 'tech-1',
    create_invoice_on_complete: true,
    ...parentOverrides,
  };
  // Live upcoming rows, earliest first, 14 days apart starting tomorrow.
  const live = Array.from({ length: upcoming }, (_, i) => ({
    id: 100 + i,
    status: 'pending',
    scheduled_date: daysOut(1 + i * 14),
    recurring_parent_id: 10,
    annual_prepay_term_id: coveredVisitIds.includes(100 + i) ? 'term-1' : null,
    prepaid_amount: prepaidVisitIds.includes(100 + i) ? '185.00' : (zeroPrepaidAll ? '0.00' : null),
  }));
  const inserted = [];
  const handler = ({ table, calls, op, data }) => {
    if (table === 'scheduled_services') {
      if (op === 'columnInfo') return COLS;
      if (op === 'first') return parent; // latestLiveSeriesVisit
      if (op === 'await') {
        // loadActiveSeriesDates selects scheduled_date only.
        const selectCall = calls.find((c) => c[0] === 'select');
        if (Array.isArray(selectCall?.[1])) return live;
        if (selectCall?.[1] === 'scheduled_date') {
          return [{ scheduled_date: parent.scheduled_date }, ...live];
        }
        return live;
      }
      if (op === 'insertReturning') { inserted.push(data); return [{ id: 900 + inserted.length, ...data }]; }
      if (op === 'insert') { inserted.push(data); return [1]; }
    }
    if (table === 'scheduled_service_addons') {
      if (op === 'columnInfo') return {};
      return [];
    }
    if (table === 'estimate_card_holds') {
      if (op === 'await') {
        return cardHoldVisitIds.map((id) => ({ scheduled_service_id: id }));
      }
      return [];
    }
    if (table === 'appointment_card_requests') {
      if (op === 'await') return cardRequestVisitIds.map((id) => ({ scheduled_service_id: id }));
      return [];
    }
    if (table === 'invoices') {
      if (op === 'await') {
        if (invoiceRows) return invoiceRows;
        return paidInvoiceVisitIds.map((id) => ({
          scheduled_service_id: id, status: 'paid', credit_applied: '0.00', line_items: '[]',
        }));
      }
      return [];
    }
    if (table === 'system_settings') {
      return weeklyDaysOff ? { value: weeklyDaysOff } : null;
    }
    if (table === 'schedule_blackout_dates') return [];
    return null;
  };
  return { conn: makeConn(handler, { hasCardHoldTable }), inserted, parent, live };
}

// latestLiveSeriesVisit and the live-visit read both call .first()/.then() on
// scheduled_services; the scenario handler distinguishes them by the select
// shape, so pin that assumption once here rather than in every test.
function reconcile(conn, parent, targetCount, extra = {}) {
  return reconcileRecurringSeriesVisitCount(conn, {
    parentId: 10,
    parent,
    cols: COLS,
    targetCount,
    actorId: 'admin-1',
    claimToken: 'claim-token-1',
    ...extra,
  });
}

describe('reconcileRecurringSeriesVisitCount — trimming a plan', () => {
  beforeEach(() => jest.clearAllMocks());

  test('capping a running plan at 2 cancels the furthest-out visits and keeps the nearest', async () => {
    const { conn, parent, live, inserted } = scenario({ upcoming: 5 });
    const result = await reconcile(conn, parent, 2);

    expect(result.before).toBe(5);
    expect(result.target).toBe(2);
    expect(inserted).toHaveLength(0);
    // Visits 3, 4 and 5 come off — the two nearest today stay.
    expect(result.cancelledIds).toEqual([live[2].id, live[3].id, live[4].id]);
    expect(transitionJobStatus).toHaveBeenCalledTimes(3);
    const first = transitionJobStatus.mock.calls[0][0];
    expect(first.jobId).toBe(live[2].id);
    expect(first.toStatus).toBe('cancelled');
    // Silent by contract: the claim is minted suppressed and finalized
    // post-commit with sendNotification:false. Anything else texts a customer
    // about an office-side plan change.
    expect(first.notifyCustomer).toBe('caller_suppress');
    expect(first.cancelNoticeToken).toBe('claim-token-1');
    expect(first.trx).toBe(conn);
  });

  test('the series parent and the visit being edited are never cancelled', async () => {
    const { conn, parent, live } = scenario({ upcoming: 4 });
    live[0].id = 10; // parent is also an upcoming visit
    const result = await reconcile(conn, parent, 2, { protectedVisitId: live[2].id });

    expect(result.cancelledIds).not.toContain(10);
    expect(result.cancelledIds).not.toContain(live[2].id);
  });

  test('a protected visit past the cut still lands on exactly the target (Codex #3337 P1)', async () => {
    // Regression: the surplus used to be sliced BEFORE protected rows were
    // filtered out, so protecting a row past the cut cancelled fewer visits
    // than asked and left the plan longer than the number the response and
    // the audit line both reported — an extra billable visit on the calendar.
    const { conn, parent, live } = scenario({ upcoming: 4 });
    const result = await reconcile(conn, parent, 2, { protectedVisitId: live[2].id });

    // 4 live → target 2 means exactly 2 cancellations, whichever rows are
    // eligible. The protected third visit survives; the second goes instead.
    expect(result.cancelledIds).toHaveLength(2);
    expect(result.cancelledIds).toEqual([live[1].id, live[3].id]);
    const remaining = live.length - result.cancelledIds.length;
    expect(remaining).toBe(result.target);
  });

  test('refuses when the target is unreachable without cancelling a protected visit', async () => {
    const { conn, parent, live } = scenario({ upcoming: 3 });
    live[0].id = 10; // the parent occupies the first slot
    // Target 1 needs 2 cancellations but only 1 row is eligible (the parent
    // and the edited visit are both protected).
    await expect(
      reconcile(conn, parent, 1, { protectedVisitId: live[1].id }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('lowest this plan can go') });
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('refuses the whole save when a surplus visit is covered by an annual prepay term', async () => {
    const { conn, parent, live } = scenario({ upcoming: 4, coveredVisitIds: [103] });
    await expect(reconcile(conn, parent, 2)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('annual prepay term'),
    });
    // Nothing partially applied — the refusal happens before the first cancel.
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(live).toHaveLength(4);
  });

  test('refuses when a surplus visit still holds a card for a late-cancel fee', async () => {
    const { conn, parent } = scenario({ upcoming: 4, cardHoldVisitIds: [103] });
    await expect(reconcile(conn, parent, 2)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('late-cancel fee'),
    });
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('refuses when a surplus visit was prepaid by hand — cash, phone card or Zelle (Codex #3337 P1)', async () => {
    // POST /:id/prepaid stamps prepaid_amount, and can stamp a whole series at
    // once, so future siblings carry it. Trimming one silently is money taken
    // for a visit that never happens.
    const { conn, parent } = scenario({ upcoming: 4, prepaidVisitIds: [103] });
    await expect(reconcile(conn, parent, 2)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already prepaid'),
    });
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('refuses when a surplus visit already has an invoice holding money', async () => {
    const { conn, parent } = scenario({ upcoming: 4, paidInvoiceVisitIds: [103] });
    await expect(reconcile(conn, parent, 2)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('invoice that has money on it'),
    });
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('the invoice guard covers `prepaid` — credit-covered invoices stamp no field on the visit (Codex #3337 r2 P1)', () => {
    // An invoice fully covered by account credit closes as terminal
    // 'prepaid' with paid_at and does NOT necessarily stamp prepaid_amount
    // or an annual term on the scheduled_service, so a hand-listed
    // ['paid','partially_paid'] guard walked straight past it.
    const { INVOICE_UNCOLLECTIBLE_STATUSES } = require('../services/invoice-helpers');
    const guard = src.slice(
      src.indexOf('An invoice already holding money for a future visit'),
      src.indexOf('for (const inv of invoiced)'),
    );
    // Derived from the canonical vocabulary, not re-listed by hand.
    expect(guard).toContain('INVOICE_UNCOLLECTIBLE_STATUSES');
    expect(INVOICE_UNCOLLECTIBLE_STATUSES).toContain('prepaid');
    // ...minus the terminal states that hold no money.
    for (const empty of ['void', 'refunded', 'canceled', 'cancelled']) {
      expect(guard).toContain(`'${empty}'`);
    }
    expect(guard).toContain("'partially_paid'");
  });

  test('refuses on an invoice holding money WITHOUT a settled status — partial account credit (Codex #3337 r3 P1)', async () => {
    // A partial credit application leaves the invoice 'sent' and charges
    // total − credit_applied; the customer's balance is already drawn down.
    const { conn, parent } = scenario({
      upcoming: 4,
      invoiceRows: [{ scheduled_service_id: 103, status: 'sent', credit_applied: '40.00', line_items: '[]' }],
    });
    await expect(reconcile(conn, parent, 2)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('account credit already applied'),
    });
  });

  test('refuses on a ledger-backed estimate deposit credit line', async () => {
    const { conn, parent } = scenario({
      upcoming: 4,
      invoiceRows: [{
        scheduled_service_id: 103, status: 'sent', credit_applied: '0.00',
        line_items: JSON.stringify([{ category: 'deposit_credit', amount: -75 }]),
      }],
    });
    await expect(reconcile(conn, parent, 2)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('estimate deposit credit'),
    });
  });

  test('an ordinary open invoice with no money on it does not block the trim', async () => {
    // draft/sent with nothing collected: the cancel path voids it.
    const { conn, parent, live } = scenario({
      upcoming: 3,
      invoiceRows: [{ scheduled_service_id: 102, status: 'sent', credit_applied: '0.00', line_items: '[]' }],
    });
    const result = await reconcile(conn, parent, 2);
    expect(result.cancelledIds).toEqual([live[2].id]);
  });

  test('a zero/null prepaid stamp is not coverage — an ordinary plan still trims', async () => {
    const { conn, parent, live } = scenario({ upcoming: 3, prepaidVisitIds: [], zeroPrepaidAll: true });
    const result = await reconcile(conn, parent, 2);
    expect(result.cancelledIds).toEqual([live[2].id]);
  });

  test('refuses a /secure visit whose late-cancel fee is unsettled — that path CHARGES (Codex #3337 r5 P1)', async () => {
    // handleAppointmentCardCancellation does not merely close the request: at
    // appointment-card-request.js:1996 it calls chargeAppointmentNoShowFee
    // inside the cancel window. The trim has no fee preview and no waiver, so
    // such a visit must never reach the follow-through.
    const { conn, parent } = scenario({ upcoming: 4, cardRequestVisitIds: [103] });
    await expect(reconcile(conn, parent, 2)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('late-cancel fee has not been settled'),
    });
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('a settled card-request fee does not block the trim', async () => {
    // fee_status already charged/waived/released → nothing left to decide.
    const { conn, parent, live } = scenario({ upcoming: 3, cardRequestVisitIds: [] });
    const result = await reconcile(conn, parent, 2);
    expect(result.cancelledIds).toEqual([live[2].id]);
  });

  test('the card-request guard mirrors canonical chargeability, not every null fee stamp (Codex #3337 r6 P2)', () => {
    // An abandoned `pending` request or an auto-secured `satisfied` one also
    // has fee_status NULL but carries no agreed fee — refusing those would
    // block trims with no money exposure at all.
    const guard = src.slice(src.indexOf('Mirrors the canonical chargeability check'), src.indexOf('return covered;'));
    expect(guard).toContain("conn('appointment_card_requests')");
    expect(guard).toContain("where('status', 'completed')");
    expect(guard).toContain("where('no_show_fee_amount', '>', 0)");
    expect(guard).toContain("where('cancel_window_hours', '>', 0)");
    expect(guard).toContain("whereNotNull('fee_agreed_at')");
    expect(guard).toContain("whereNotNull('stripe_payment_method_id')");
    // In-flight fee events are unsettled too, not benign absence.
    expect(guard).toContain("orWhereIn('fee_status', ['charging', 'charge_review'])");
  });

  test('the ongoing baseline is read UNDER the maintenance lock (Codex #3337 r6 P1)', () => {
    // A pre-lock read is stale by construction: a concurrent mutation holding
    // the lock commits the opposite value while this request waits for it.
    const lockLine = src.indexOf('acquireRecurringSeriesMaintenanceLock(trx, commsPeek.recurring_parent_id');
    const baselineRead = src.indexOf('const wasOngoingBeforeSave = ongoingBeforeRow?.recurring_ongoing === true;');
    expect(lockLine).toBeGreaterThan(-1);
    expect(baselineRead).toBeGreaterThan(lockLine);
    // And it must not have been left behind before the lock as well.
    expect((src.match(/const wasOngoingBeforeSave =/g) || []).length).toBe(1);
  });

  test('the generic details write does not carry recurring_ongoing for an existing plan (Codex #3337 r7 P1)', () => {
    // The guarded series-wide block owns that flag, because it is the only
    // write checked against the operator's baseline under the lock. Leaving it
    // in `updates` let a stale flag land on the parent even when the guard
    // correctly skipped the series write — parent ongoing, children fixed, and
    // a later completion auto-extends visits another operator just removed.
    expect(src).toContain('const existingPlanOwnsOngoing = spawnRecurringChildren === false;');
    expect(src).toContain('if (cols.recurring_ongoing && !existingPlanOwnsOngoing) updates.recurring_ongoing = !!recurringOngoing;');
    // ...and the guarded write still covers the parent row itself.
    const guarded = src.slice(src.indexOf('recurring_ongoing lives on every row of the series'));
    expect(guarded.slice(0, 900)).toContain("this.where('id', parentId).orWhere('recurring_parent_id', parentId)");
  });

  test('the resize audit records the achieved length, not the request (Codex #3337 r6 P2)', () => {
    const audit = src.slice(src.indexOf("action: 'recurring_plan_count_set'") - 700, src.indexOf("action: 'recurring_plan_count_set'") + 900);
    expect(audit).toContain('plan now has ${visitCountResult.achieved}');
    expect(audit).toContain('could not be placed on the cadence');
  });

  test('a pre-migration env without the card-hold table still trims (prepay guard stands alone)', async () => {
    const { conn, parent, live } = scenario({ upcoming: 3, hasCardHoldTable: false });
    const result = await reconcile(conn, parent, 2);
    expect(result.cancelledIds).toEqual([live[2].id]);
  });
});

describe('reconcileRecurringSeriesVisitCount — extending a plan', () => {
  beforeEach(() => jest.clearAllMocks());

  test('raising the count tops up from the latest live visit on the plan cadence', async () => {
    const { conn, parent, inserted } = scenario({ upcoming: 2 });
    const result = await reconcile(conn, parent, 4);

    expect(result.added).toHaveLength(2);
    expect(inserted).toHaveLength(2);
    expect(transitionJobStatus).not.toHaveBeenCalled();
    for (const row of inserted) {
      expect(row.recurring_parent_id).toBe(10);
      expect(row.is_recurring).toBe(true);
      expect(row.status).toBe('pending');
      expect(row.service_type).toBe('Concourse Treatment');
      expect(row.estimated_duration_minutes).toBe(120);
      // A counted plan is fixed — a top-up row carrying the ongoing flag
      // would let the next completion auto-extend straight past the count.
      expect(row.recurring_ongoing).toBe(false);
      // Never in the past, even though the series anchor is.
      expect(row.scheduled_date > TODAY).toBe(true);
    }
    // Placed on the 14-day cadence, not the anchor's original schedule.
    const dates = inserted.map((r) => r.scheduled_date).sort();
    expect(new Set(dates).size).toBe(2);
  });

  test('does not double-book a date the series already occupies', async () => {
    const { conn, parent, inserted } = scenario({ upcoming: 3 });
    await reconcile(conn, parent, 5);
    const occupied = new Set([daysOut(1), daysOut(15), daysOut(29)]);
    for (const row of inserted) expect(occupied.has(row.scheduled_date)).toBe(false);
  });

  test('an unchanged count writes nothing at all', async () => {
    const { conn, parent, inserted } = scenario({ upcoming: 3 });
    const result = await reconcile(conn, parent, 3);
    expect(result.added).toHaveLength(0);
    expect(result.cancelledIds).toHaveLength(0);
    expect(inserted).toHaveLength(0);
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('the count is clamped to the series cap, so one typo cannot fill a calendar', async () => {
    const { conn, parent } = scenario({ upcoming: 2 });
    const result = await reconcile(conn, parent, 9999);
    expect(result.target).toBe(MAX_SERIES_VISIT_COUNT);
  });

  test('extend-only mode never trims, and stamps its rows ongoing (the flip to Never)', async () => {
    const { conn, parent, inserted } = scenario({ upcoming: 1 });
    const result = await reconcile(conn, parent, 3, { ongoingSeries: true });
    expect(result.added).toHaveLength(2);
    for (const row of inserted) expect(row.recurring_ongoing).toBe(true);

    // Same mode, already above target → no cancellations.
    jest.clearAllMocks();
    const over = scenario({ upcoming: 5 });
    const r2 = await reconcile(over.conn, over.parent, 3, { ongoingSeries: true });
    expect(r2.cancelledIds).toHaveLength(0);
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });
});

describe('reconcileRecurringSeriesVisitCount — blackout days and weekly closures', () => {
  beforeEach(() => jest.clearAllMocks());

  test('top-up visits honor weekly days off even when the row does not skip weekends', async () => {
    // schedule_weekly_days_off=[0,6] (Sat+Sun closed, the 08-18 owner setting):
    // a daily-cadence top-up spans more than a week, so without the blackout
    // nudge some rows MUST land on a weekend. Every landed date has to be a
    // weekday, strictly future, and unique.
    const { conn, parent, inserted } = scenario({
      upcoming: 1,
      weeklyDaysOff: '[0,6]',
      parentOverrides: { recurring_interval_days: 1, skip_weekends: false },
    });
    const result = await reconcile(conn, parent, 8);
    expect(result.added).toHaveLength(7);
    const dates = inserted.map((r) => r.scheduled_date);
    expect(new Set(dates).size).toBe(7);
    for (const d of dates) {
      expect(d > TODAY).toBe(true);
      expect([0, 6]).not.toContain(new Date(`${d}T12:00:00`).getDay());
    }
  });
});

describe('planCadenceRewriteTargets — cadence edits stay future-only and clear of blackouts', () => {
  const { planCadenceRewriteTargets } = adminScheduleRouter._test;

  test('re-dating pending children of an older parent never targets a past date', () => {
    const { childTargets } = planCadenceRewriteTargets({
      baseDateStr: daysOut(-60),
      pattern: 'monthly',
      rOpts: {},
      skip: false,
      dir: 'forward',
      pendingChildren: [
        { id: 'c1', scheduled_date: daysOut(-30) },
        { id: 'c2', scheduled_date: daysOut(1) },
      ],
      pendingBoosters: [],
      boosterMonths: [],
      seenDates: new Set(),
      blackoutDates: null,
    });
    expect(childTargets.size).toBe(2);
    for (const d of childTargets.values()) expect(d > TODAY).toBe(true);
  });

  test('a years-stale parent still re-dates every pending child — the plan base fast-forwards to the current cadence phase', () => {
    // Four years back on monthly cadence: without the fast-forward, all
    // (2*4+30) attempts land on/before today and childTargets stays empty,
    // silently leaving the children on the old cadence.
    const base = new Date(`${TODAY}T12:00:00Z`);
    base.setUTCDate(base.getUTCDate() - 1460);
    const { childTargets } = planCadenceRewriteTargets({
      baseDateStr: base.toISOString().slice(0, 10),
      pattern: 'monthly',
      rOpts: {},
      skip: false,
      dir: 'forward',
      pendingChildren: [
        { id: 'c1', scheduled_date: daysOut(5) },
        { id: 'c2', scheduled_date: daysOut(35) },
      ],
      pendingBoosters: [],
      boosterMonths: [],
      seenDates: new Set(),
      blackoutDates: null,
    });
    expect(childTargets.size).toBe(2);
    for (const d of childTargets.values()) expect(d > TODAY).toBe(true);
  });

  test('booster rewrites of an older parent never target a past date', () => {
    // Base 60 days back with a booster month covering roughly today: the
    // recomputed booster walk emits candidates on/before today, which must
    // be skipped — a pending FUTURE booster is never re-dated into the past.
    const base = new Date(`${TODAY}T12:00:00Z`);
    base.setUTCDate(base.getUTCDate() - 60);
    const allMonths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const { boosterTargets } = planCadenceRewriteTargets({
      baseDateStr: base.toISOString().slice(0, 10),
      pattern: 'quarterly',
      rOpts: {},
      skip: false,
      dir: 'forward',
      pendingChildren: [],
      pendingBoosters: [
        { id: 'b1', scheduled_date: daysOut(10) },
        { id: 'b2', scheduled_date: daysOut(40) },
      ],
      boosterMonths: allMonths,
      seenDates: new Set(),
      blackoutDates: null,
    });
    for (const d of boosterTargets.values()) expect(d > TODAY).toBe(true);
  });

  test('a child landing on a blacked-out day is nudged forward by the shared clear-of-blackout', () => {
    const args = {
      baseDateStr: '2098-03-10',
      pattern: 'monthly',
      rOpts: {},
      skip: false,
      dir: 'forward',
      pendingBoosters: [],
      boosterMonths: [],
    };
    const clear = planCadenceRewriteTargets({
      ...args,
      pendingChildren: [{ id: 'c1', scheduled_date: '2098-04-01' }],
      seenDates: new Set(),
      blackoutDates: null,
    }).childTargets.get('c1');
    const nudged = planCadenceRewriteTargets({
      ...args,
      pendingChildren: [{ id: 'c1', scheduled_date: '2098-04-01' }],
      seenDates: new Set(),
      blackoutDates: new Set([clear]),
    }).childTargets.get('c1');
    const next = new Date(`${clear}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    expect(nudged).toBe(next.toISOString().slice(0, 10));
  });
});

describe('reconcileRecurringSeriesVisitCount — stale-snapshot guard', () => {
  beforeEach(() => jest.clearAllMocks());

  test('refuses when the live plan moved since the modal read it (Codex #3337 r3 P1)', async () => {
    // Modal saw 4; a completion/cancellation left 3 before Save landed.
    const { conn, parent } = scenario({ upcoming: 3 });
    await expect(reconcile(conn, parent, 2, { baselineCount: 4 })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('changed while the appointment was open'),
    });
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('proceeds when the baseline still matches the live plan', async () => {
    const { conn, parent, live } = scenario({ upcoming: 3 });
    const result = await reconcile(conn, parent, 2, { baselineCount: 3 });
    expect(result.cancelledIds).toEqual([live[2].id]);
  });
});

describe('update-details wiring (source guards)', () => {
  test('the reconcile takes the per-parent maintenance lock BEFORE the comms lock', () => {
    // Reverse order deadlocks against runRecurringAlertAction, which acquires
    // maintenance→comms on the same two keys.
    const trxStart = src.indexOf("const commsPeek = await trx('scheduled_services')");
    const maintenanceLock = src.indexOf('acquireRecurringSeriesMaintenanceLock(trx, commsPeek.recurring_parent_id', trxStart);
    const commsLock = src.indexOf('await lockCustomerComms(trx, commsPeek.customer_id)', trxStart);
    expect(trxStart).toBeGreaterThan(-1);
    expect(maintenanceLock).toBeGreaterThan(-1);
    expect(commsLock).toBeGreaterThan(maintenanceLock);
  });

  test('the reconcile is skipped when the make-this-recurring spawn path ran', () => {
    expect(src).toContain('if (wantsVisitCountReconcile) {');
    expect(src).toMatch(/isRecurring && !shouldSpawnRecurringChildren\s*\n\s*&& \(wantsVisitCountReconcile \|\| recurringOngoing !== undefined\)/);
  });

  test('a counted plan clears recurring_ongoing across the whole series', () => {
    // Parent-only would leave children flagged, and several readers
    // (cancellation eligibility, follow-up planning) scan children.
    const block = src.slice(src.indexOf('recurring_ongoing lives on every row of the series'));
    expect(block.slice(0, 900)).toContain("this.where('id', parentId).orWhere('recurring_parent_id', parentId)");
    expect(block.slice(0, 900)).toContain('update({ recurring_ongoing: !!recurringOngoing');
  });

  test('trimmed visits finalize their reminders silently', () => {
    const finalize = src.indexOf('AppointmentReminders.handleSeriesCancellation(\n          visitCountResult.cancelledIds');
    expect(finalize).toBeGreaterThan(-1);
    expect(src.slice(finalize, finalize + 400)).toContain('sendNotification: false');
  });

  test('the plan-length change is audited', () => {
    expect(src).toContain("action: 'recurring_plan_count_set'");
  });

  test('the reconcile aborts when a merge-undo repoints the customer mid-save (Codex #3337 r2 P1)', () => {
    // The comms fence was keyed off the pre-lock peek. Inserting/cancelling
    // for a customer whose fence we do not hold is invisible to a concurrent
    // undo of the restored owner — the same abort the spawn path takes.
    const block = src.slice(src.indexOf('Owner-change abort, same seam and same wording'));
    expect(block.slice(0, 900)).toContain("String(parent.customer_id) !== String(commsPeek.customer_id)");
    expect(block.slice(0, 900)).toContain("code = 'CUSTOMER_CHANGED_RETRY'");
    // Both writers take it — the reconcile and the make-recurring spawn.
    expect((src.match(/CUSTOMER_CHANGED_RETRY/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('top-up visits get the post-registration terminal re-check (Codex #3337 r2 P1)', () => {
    // A series cancel landing between this commit and the reminder insert
    // would otherwise leave an armed reminder on a cancelled visit.
    const loop = src.slice(
      src.indexOf('const visitCountAddedIds = new Set('),
      src.indexOf('if (assignmentChanged || detailsChanged || addonsReplaced)'),
    );
    expect(loop).toContain('registerSpawnedVisitReminder(');
    expect(loop).toContain('visitCountAddedIds.has(child.id)');
    expect(loop).toContain("cancelSpawnedReminderIfVisitTerminal(db, child.id, 'schedule/visit-count')");
    // The re-check must run AFTER the registration it is closing the race on.
    expect(loop.indexOf('registerSpawnedVisitReminder('))
      .toBeLessThan(loop.indexOf('cancelSpawnedReminderIfVisitTerminal('));
  });

  test('the ongoing top-up needs a REAL fixed→ongoing transition, and the gate (Codex #3337 r4 P1)', () => {
    // The modal sends recurringOngoing on every save of a recurring
    // appointment, so keying off the submitted value alone made a notes-only
    // save top up any ongoing plan under three visits — with the gate OFF,
    // which broke the dark ship outright. Regression guard for all three
    // conditions.
    const block = src.slice(src.indexOf('Fires ONLY on a real fixed→ongoing transition'));
    const head = block.slice(0, 900);
    expect(head).toContain('recurringOngoing === true && !wasOngoingBeforeSave');
    expect(head).toContain("isEnabled('editApptVisitCount')");
    expect(src).toContain('const wasOngoingBeforeSave = ongoingBeforeRow?.recurring_ongoing === true;');
    // Measured against the PARENT's prior flag, not the edited child's.
    expect(src).toContain("commsPeek?.recurring_parent_id");
  });

  test('every existing-plan mutation takes the maintenance lock, not just count edits (Codex #3337 r4 P1)', () => {
    // The series-wide ongoing flip can itself insert visits; gating the lock
    // on the count left it racing the completion auto-extend and the dispatch
    // series cancel.
    expect(src).toContain('const wantsExistingPlanMutation = wantsVisitCountReconcile');
    expect(src).toContain('if (wantsExistingPlanMutation && commsPeek) {');
    const lockLine = src.indexOf('acquireRecurringSeriesMaintenanceLock(trx, commsPeek.recurring_parent_id');
    const commsLine = src.indexOf('await lockCustomerComms(trx, commsPeek.customer_id)');
    expect(lockLine).toBeGreaterThan(-1);
    expect(commsLine).toBeGreaterThan(lockLine);
  });

  test('flipping a spent plan back to Never leaves it with visits ahead (Codex #3337 r3 P1)', () => {
    // Auto-extend only fires from a COMPLETION, so an exhausted plan flipped
    // to ongoing with nothing booked has no completion coming. Reuses the
    // convert_ongoing contract (flip + ensure 3 upcoming) via the same writer.
    const block = src.slice(src.indexOf('Turning a plan back to "Never" must also leave it'));
    expect(block.slice(0, 2000)).toContain('!wantsVisitCountReconcile');
    expect(block.slice(0, 2000)).toContain('targetCount: 3');
    expect(block.slice(0, 2000)).toContain('ongoingSeries: true');
    // Only tops up when short — never on a plan that already has visits.
    expect(block.slice(0, 2000)).toContain('if (liveNow < 3)');
  });

  test('a resize resolves the stale end-of-plan alert in the same transaction (Codex #3337 r3 P1)', () => {
    // The alerts endpoint returns stored rows without rechecking them, so a
    // refilled plan would keep a card whose extend click books more visits.
    const block = src.slice(src.indexOf('A resize can invalidate an open end-of-plan alert'));
    expect(block.slice(0, 1500)).toContain("resolved_action: 'plan_resized'");
    expect(block.slice(0, 1500)).toContain("whereIn('alert_type', ['plan_ending', 'plan_ending_soon', 'ongoing_plan_exhausted'])");
    // Savepoint — the bookkeeping must not poison the resize transaction.
    expect(block.slice(0, 1500)).toContain('await trx.transaction(async (sp) => {');
  });

  test('refuses a trim while an attached PaymentIntent can still settle (Codex #3337 r4 P1)', () => {
    // The post-commit void deliberately does NOT void an in-flight or
    // unverifiable PI — it logs and leaves the invoice for manual review — so
    // the refusal has to happen before the cancel commits.
    const guard = src.slice(
      src.indexOf('An invoice already holding money for a future visit'),
      src.indexOf('return covered;'),
    );
    expect(guard).toContain('stripe_payment_intent_id');
    expect(guard).toContain('card payment that can still settle');
    const invoiceSrc = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');
    expect(invoiceSrc).toContain('PI_MONEY_IN_FLIGHT_STATUSES.includes(pi.status)');
  });

  test('the trim runs the SHARED cancellation follow-through, not a copy of it (Codex #3337 r4)', () => {
    // Three review rounds each found a different piece of the cancellation
    // pipeline missing from the trim. Both surfaces now call one module.
    const shared = fs.readFileSync(path.join(__dirname, '../services/visit-cancellation-followthrough.js'), 'utf8');
    // Every obligation lives in the shared module...
    expect(shared).toContain('handleCardHoldCancellation');
    expect(shared).toContain('handleAppointmentCardCancellation');
    expect(shared).toContain('alertUnresolvedCancellationFee');
    expect(shared).toContain('voidOpenInvoicesForCancelledService');
    expect(shared).toContain('trackTransitions.cancel');
    expect(shared).toContain('recordTrackTransitionResultFailure');
    expect(shared).toContain('recordTrackTransitionFailure');

    // ...and BOTH cancel surfaces call it rather than inlining their own.
    const dispatchSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    expect(dispatchSrc).toContain("require('../services/visit-cancellation-followthrough')");
    expect(dispatchSrc).toContain("source: 'admin-dispatch'");
    expect(src).toContain("require('../services/visit-cancellation-followthrough')");
    expect(src).toContain("source: 'schedule/visit-count'");

    // The dispatch series-cancel must no longer carry its own copy of the
    // rails — that duplication is what this extraction removed.
    const seriesBranch = dispatchSrc.slice(
      dispatchSrc.indexOf("if (toStatus === 'cancelled' && ['following', 'series'].includes(scope))"),
      dispatchSrc.indexOf("await db('activity_log').insert({"),
    );
    expect(seriesBranch).not.toContain('handleCardHoldCancellation');
    expect(seriesBranch).not.toContain('trackTransitions.cancel');
  });

  test('the dispatch waive-fee gate survives the extraction (admin-only)', () => {
    const dispatchSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    expect(dispatchSrc).toContain("waiveFee: req.techRole === 'admin' && req.body?.waiveCardHoldFee === true");
    // The trim has no waiver control and refuses fee-bearing visits up front,
    // so it must never waive one silently.
    const trimCall = src.slice(src.indexOf("source: 'schedule/visit-count'") - 700, src.indexOf("source: 'schedule/visit-count'"));
    expect(trimCall).toContain('waiveFee: false');
  });

  test('trimmed visits reuse the shared status writer, which owns the invoice void', () => {
    // Rebuttal guard for Codex #3337 r2 "Void open invoices for trimmed
    // visits": transitionJobStatus runs voidOpenInvoicesForCancelledService
    // post-commit for EVERY caller (job-status.js, inside
    // maybeReparkFollowupObligation, fired from trx.executionPromise.then).
    // A second sweep here would be the parallel mechanism AGENTS.md forbids.
    // If the trim ever stops going through transitionJobStatus, this fails
    // and the void has to be re-homed.
    const trim = src.slice(
      src.indexOf('const { transitionJobStatus } = require'),
      src.indexOf('return result;', src.indexOf('const { transitionJobStatus } = require')),
    );
    expect(trim).toContain('toStatus: \'cancelled\'');
    expect(trim).toContain('trx,');
    const jobStatusSrc = fs.readFileSync(path.join(__dirname, '../services/job-status.js'), 'utf8');
    expect(jobStatusSrc).toContain("require('./invoice').voidOpenInvoicesForCancelledService(jobId)");
    expect(jobStatusSrc).toContain('maybeReparkFollowupObligation();');
  });
});

describe('GATE_EDIT_APPT_VISIT_COUNT — the lane ships dark', () => {
  const gatesSrc = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');

  test('the gate defaults OFF — only the exact string "true" arms it', () => {
    expect(gatesSrc).toContain("editApptVisitCount: process.env.GATE_EDIT_APPT_VISIT_COUNT === 'true'");
  });

  test('a count sent while dark is REFUSED, never silently dropped', () => {
    // A dropped count reads to the office as a plan they capped — they would
    // find out when the extra visits ran.
    const guard = src.indexOf("if (recurringPlannedCount !== undefined && !isEnabled('editApptVisitCount'))");
    expect(guard).toBeGreaterThan(-1);
    expect(src.slice(guard, guard + 320)).toContain('GATE_EDIT_APPT_VISIT_COUNT');
    expect(src.slice(guard, guard + 320)).toContain('httpError(409');
  });

  test('the summary endpoint publishes the gate so the modal can hide the controls', () => {
    expect(src).toContain("canSetCount: isEnabled('editApptVisitCount')");
  });

  test('the add-on mirror runs in a savepoint, not a bare catch (Codex #3337 P2)', () => {
    // In Postgres a failed statement poisons the transaction; catching it
    // without a savepoint leaves the txn aborted, so the commit would roll
    // back the visits the mirror is only supposed to decorate.
    const start = src.indexOf('SAVEPOINT, not a bare try/catch (Codex #3337 P2)');
    const end = src.indexOf('[schedule/visit-count] add-on mirror failed', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain('trx.transaction(async (sp) => {');
    expect(block).toContain("sp('scheduled_service_addons').insert(addonData)");
    // The inserts must run on the savepoint, never the outer transaction.
    expect(block).not.toContain("trx('scheduled_service_addons').insert(addonData)");
  });

  test('the refusal is checked before the reconcile can write anything', () => {
    const guard = src.indexOf("if (recurringPlannedCount !== undefined && !isEnabled('editApptVisitCount'))");
    const reconcileCall = src.indexOf('await reconcileRecurringSeriesVisitCount(trx, {');
    expect(guard).toBeLessThan(reconcileCall);
  });
});
