/**
 * F1 windowed comms context (universal one-time services, ratified Q13):
 * recurring = since the last completed visit of the same service line,
 * cap 120 days; one-time = since the job origin, cap 180 days; the floor
 * is ALWAYS applied to every channel query (never uncapped most-recent-N),
 * and it is a real Date object (waves-db §2 — no naive ISO strings).
 */
const {
  buildCompletionCommsContext,
  resolveContextWindow,
  RECURRING_CAP_DAYS,
  ONE_TIME_CAP_DAYS,
} = require('../services/completion-comms-context');

const DAY = 24 * 60 * 60 * 1000;

// Chainable knex stub: rowsByTable feeds results; whereArgs records the
// (column, op, value) where-clauses each table saw.
function stubKnex(rowsByTable = {}, whereArgs = {}) {
  const knex = (table) => {
    const rows = rowsByTable[table] || [];
    whereArgs[table] = whereArgs[table] || [];
    // Fully chainable + thenable, like real knex: any builder method returns
    // the builder; awaiting it (or .catch) resolves the configured rows.
    let filtered = rows;
    const q = {
      where(...args) { whereArgs[table].push(args); return q; },
      // Real filtering for the object form — resolveContextWindow excludes
      // the current visit via whereNot({ id }).
      whereNot(obj) {
        if (obj && typeof obj === 'object') {
          filtered = filtered.filter((r) => !Object.entries(obj).every(([k, v]) => r[k] === v));
        }
        return q;
      },
      orderBy() { return q; },
      limit() { return q; },
      select() { return q; },
      first: () => Promise.resolve(filtered[0] || null),
      catch: (fn) => Promise.resolve(filtered).catch(fn),
      then: (resolve, reject) => Promise.resolve(filtered).then(resolve, reject),
    };
    return q;
  };
  knex.schema = { hasTable: () => Promise.resolve(true) };
  return knex;
}

const NOW = Date.now();

describe('resolveContextWindow', () => {
  test('recurring: floor = last completed same-line visit when inside the cap', async () => {
    const lastVisit = new Date(NOW - 45 * DAY);
    const knex = stubKnex({
      scheduled_services: [
        // .first() resolves the current visit; .select() resolves the recent
        // completed set — the stub returns the same array for both, so the
        // current row leads and a prior pest visit follows.
        { id: 'svc-1', customer_id: 'c1', service_type: 'Quarterly Pest Control Service', recurring_parent_id: 'parent-1', created_at: new Date(NOW - 400 * DAY) },
        { service_type: 'Quarterly Pest Control Service', scheduled_date: lastVisit },
        { service_type: 'Lawn Care Service', scheduled_date: new Date(NOW - 10 * DAY) },
      ],
    });
    const win = await resolveContextWindow({ customerId: 'c1', scheduledServiceId: 'svc-1', knex });
    expect(win.isRecurring).toBe(true);
    expect(win.floor.getTime()).toBe(lastVisit.getTime());
    expect(win.reason).toContain('last completed');
  });

  test('recurring: cap wins when the last visit is older than 120 days', async () => {
    const knex = stubKnex({
      scheduled_services: [
        { id: 'svc-1', customer_id: 'c1', service_type: 'Quarterly Pest Control Service', recurring_parent_id: 'parent-1', created_at: new Date(NOW - 400 * DAY) },
        { service_type: 'Quarterly Pest Control Service', scheduled_date: new Date(NOW - 300 * DAY) },
      ],
    });
    const win = await resolveContextWindow({ customerId: 'c1', scheduledServiceId: 'svc-1', knex });
    const expectedCap = NOW - RECURRING_CAP_DAYS * DAY;
    expect(Math.abs(win.floor.getTime() - expectedCap)).toBeLessThan(60 * 1000);
    expect(win.reason).toContain(`${RECURRING_CAP_DAYS} days`);
  });

  test('one-time: floor = estimate accepted_at when inside the cap', async () => {
    const accepted = new Date(NOW - 20 * DAY);
    const knex = stubKnex({
      scheduled_services: [
        { id: 'svc-1', customer_id: 'c1', service_type: 'Rodent Exclusion Service', source_estimate_id: 'est-1', created_at: new Date(NOW - 19 * DAY) },
      ],
      estimates: [{ accepted_at: accepted, created_at: new Date(NOW - 25 * DAY) }],
      service_completion_profiles: [],
    });
    const win = await resolveContextWindow({ customerId: 'c1', scheduledServiceId: 'svc-1', knex });
    expect(win.isRecurring).toBe(false);
    expect(win.floor.getTime()).toBe(accepted.getTime());
    expect(win.reason).toContain('estimate');
  });

  test('one-time: hard cap when the origin is older than 180 days', async () => {
    const knex = stubKnex({
      scheduled_services: [
        { id: 'svc-1', customer_id: 'c1', service_type: 'Rodent Exclusion Service', created_at: new Date(NOW - 400 * DAY) },
      ],
      service_completion_profiles: [],
    });
    const win = await resolveContextWindow({ customerId: 'c1', scheduledServiceId: 'svc-1', knex });
    const expectedCap = NOW - ONE_TIME_CAP_DAYS * DAY;
    expect(Math.abs(win.floor.getTime() - expectedCap)).toBeLessThan(60 * 1000);
  });

  test('historical draft: the floor is the last completion BEFORE the drafted visit, not after it', async () => {
    const draftedVisit = new Date(NOW - 60 * DAY);
    const before = new Date(NOW - 90 * DAY);
    const after = new Date(NOW - 10 * DAY); // completed since — must NOT move the floor
    const knex = stubKnex({
      scheduled_services: [
        { id: 'svc-1', customer_id: 'c1', service_type: 'Quarterly Pest Control Service', recurring_parent_id: 'p1', scheduled_date: draftedVisit, created_at: new Date(NOW - 400 * DAY) },
        { id: 'svc-2', service_type: 'Quarterly Pest Control Service', scheduled_date: after },
        { id: 'svc-3', service_type: 'Quarterly Pest Control Service', scheduled_date: before },
      ],
    });
    // The stub ignores range where()s, so assert the BOUND was requested
    // instead: the '<' clause must carry the drafted visit's date...
    const whereArgs = {};
    const knex2 = stubKnex({
      scheduled_services: [
        { id: 'svc-1', customer_id: 'c1', service_type: 'Quarterly Pest Control Service', recurring_parent_id: 'p1', scheduled_date: draftedVisit, created_at: new Date(NOW - 400 * DAY) },
      ],
    }, whereArgs);
    await resolveContextWindow({ customerId: 'c1', scheduledServiceId: 'svc-1', knex: knex2 });
    const bound = (whereArgs.scheduled_services || []).find((args) => args.length === 3 && args[0] === 'scheduled_date' && args[1] === '<');
    expect(bound).toBeTruthy();
    expect(bound[2].getTime()).toBe(draftedVisit.getTime());
    void knex;
  });

  test('recurring floor uses the prior visit\'s COMPLETION time over its midnight schedule date', async () => {
    const scheduledMidnight = new Date(NOW - 45 * DAY);
    const completedThatEvening = new Date(scheduledMidnight.getTime() + 18 * 60 * 60 * 1000);
    const knex = stubKnex({
      scheduled_services: [
        { id: 'svc-1', customer_id: 'c1', service_type: 'Quarterly Pest Control Service', recurring_parent_id: 'p1', scheduled_date: new Date(NOW), created_at: new Date(NOW - 400 * DAY) },
        { id: 'svc-2', service_type: 'Quarterly Pest Control Service', scheduled_date: scheduledMidnight, completed_at: completedThatEvening },
      ],
    });
    const win = await resolveContextWindow({ customerId: 'c1', scheduledServiceId: 'svc-1', knex });
    expect(win.floor.getTime()).toBe(completedThatEvening.getTime());
  });

  test('estimate without accepted_at falls through to the booking created_at', async () => {
    const booked = new Date(NOW - 15 * DAY);
    const knex = stubKnex({
      scheduled_services: [
        { id: 'svc-1', customer_id: 'c1', service_type: 'Rodent Exclusion Service', source_estimate_id: 'est-1', created_at: booked },
      ],
      estimates: [{ accepted_at: null }],
      service_completion_profiles: [],
    });
    const win = await resolveContextWindow({ customerId: 'c1', scheduledServiceId: 'svc-1', knex });
    expect(win.floor.getTime()).toBe(booked.getTime());
    expect(win.reason).toContain('booking');
  });

  test('no scheduled service: caller-supplied origin anchors the one-time window', async () => {
    const origin = new Date(NOW - 30 * DAY);
    const knex = stubKnex({});
    const win = await resolveContextWindow({ customerId: 'c1', originDate: origin, knex });
    expect(win.isRecurring).toBe(false);
    expect(win.floor.getTime()).toBe(origin.getTime());
  });
});

describe('buildCompletionCommsContext', () => {
  test('every channel query carries the Date floor (never uncapped)', async () => {
    const whereArgs = {};
    const knex = stubKnex({
      scheduled_services: [
        { id: 'svc-1', customer_id: 'c1', service_type: 'Rodent Exclusion Service', created_at: new Date(NOW - 10 * DAY) },
      ],
      service_completion_profiles: [],
      call_log: [], sms_log: [], emails: [],
    }, whereArgs);
    await buildCompletionCommsContext({ customerId: 'c1', scheduledServiceId: 'svc-1', knex });
    for (const table of ['call_log', 'sms_log', 'emails']) {
      const floorClause = (whereArgs[table] || []).find((args) => args.length === 3 && args[1] === '>=');
      expect(floorClause).toBeTruthy();
      expect(floorClause[2]).toBeInstanceOf(Date);
    }
  });

  test('merges channels newest-first, caps the block, and hints the service line', async () => {
    const mk = (offsetDays) => new Date(NOW - offsetDays * DAY);
    const knex = stubKnex({
      scheduled_services: [
        { id: 'svc-1', customer_id: 'c1', service_type: 'Rodent Exclusion Service', created_at: mk(10) },
      ],
      service_completion_profiles: [],
      call_log: [
        { created_at: mk(1), direction: 'inbound', lead_synopsis: 'Heard noises again in the attic' },
      ],
      sms_log: [
        { created_at: mk(2), direction: 'outbound', message_body: 'Confirming your exclusion visit window' },
      ],
      emails: [
        { received_at: mk(3), subject: 'Attic photos', snippet: 'Photos of the soffit gap attached' },
      ],
    });
    const ctx = await buildCompletionCommsContext({ customerId: 'c1', scheduledServiceId: 'svc-1', knex });
    const lines = ctx.text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Call');
    expect(lines[1]).toContain('Text');
    expect(lines[2]).toContain('Email');
    expect(ctx.promptHint).toContain('ignore unrelated topics');
    expect(ctx.promptHint).toContain('rodent');
  });

  test('no customerId returns an empty context', async () => {
    const ctx = await buildCompletionCommsContext({ customerId: null, knex: stubKnex({}) });
    expect(ctx.text).toBe('');
  });
});
