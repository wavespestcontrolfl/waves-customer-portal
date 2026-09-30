/**
 * F1 windowed comms context (universal one-time services, ratified Q13):
 * recurring = since the last completed visit of the same service line,
 * cap 120 days; one-time = since the job origin, cap 180 days; the floor
 * is ALWAYS applied to every channel query (never uncapped most-recent-N),
 * and it is a real Date object (waves-db §2 — no naive ISO strings).
 */
const {
  buildCompletionCommsContext,
  buildCustomerWordsContext,
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
      whereRaw(...args) { (whereArgs[`${table}:raw`] = whereArgs[`${table}:raw`] || []).push(args); return q; },
      modify(fn) { fn(q); return q; },
      orderBy() { return q; },
      limit(n) { whereArgs[`${table}:limit`] = n; return q; },
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

  test('a recurring PARENT row (is_recurring, null parent id) gets the recurring window', async () => {
    const lastVisit = new Date(NOW - 30 * DAY);
    const knex = stubKnex({
      scheduled_services: [
        { id: 'svc-1', customer_id: 'c1', service_type: 'Quarterly Pest Control Service', is_recurring: true, recurring_parent_id: null, scheduled_date: new Date(NOW), created_at: new Date(NOW - 300 * DAY) },
        { id: 'svc-2', service_type: 'Quarterly Pest Control Service', scheduled_date: lastVisit },
      ],
    });
    const win = await resolveContextWindow({ customerId: 'c1', scheduledServiceId: 'svc-1', knex });
    expect(win.isRecurring).toBe(true);
    expect(win.floor.getTime()).toBe(lastVisit.getTime());
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

  test('customer words: quoted history stripped, bare codes masked in texts, snippets, replies and subjects', async () => {
    const mk = (offsetDays) => new Date(NOW - offsetDays * DAY);
    const ctx = await buildCustomerWordsContext({
      customerId: 'c1',
      scheduledServiceId: 'svc-1',
      knex: stubKnex({
        scheduled_services: [
          { id: 'svc-1', customer_id: 'c1', service_type: 'Pest Control Service', created_at: mk(20) },
        ],
        service_completion_profiles: [],
        call_log: [],
        // Bare credentials texted back to a Waves question (which is left
        // out as a Waves text), so nothing anchors them.
        sms_log: [
          { created_at: mk(5), direction: 'inbound', message_body: '4821' },
          { created_at: mk(6), direction: 'inbound', message_body: 'BLUE' },
        ],
        emails: [
          // A reply whose quoted history holds Waves' own words.
          { received_at: mk(1), subject: 'Re: Your visit', body_text: 'Sounds good, see you then.\n\nOn Mon, Sep 28, 2026 at 9:00 AM Waves Pest Control <contact@wavespestcontrol.com> wrote:\n> We will retreat the kitchen for free next week.', from_address: 'pat@example.com', label_ids: ['INBOX'] },
          // A three-digit PIN in a snippet with no body.
          { received_at: mk(2), subject: 'PIN', snippet: 'The pin is 123 if you need it', from_address: 'pat@example.com', label_ids: ['INBOX'] },
          // Bare replies to a quoted credential question: the question is
          // stripped with the history, so the reply alone must be masked.
          { received_at: mk(3), subject: 'Re: Gate', body_text: '4821\n\nOn Mon, Sep 28, 2026 at 9:00 AM Waves Pest Control <contact@wavespestcontrol.com> wrote:\n> What is the gate code for the side gate?', from_address: 'pat@example.com', label_ids: ['INBOX'] },
          { received_at: mk(4), subject: 'Re: Gate again', body_text: 'BLUE\n\nOn Mon, Sep 28, 2026 at 9:00 AM Waves Pest Control <contact@wavespestcontrol.com> wrote:\n> What is the gate code for the side gate?', from_address: 'pat@example.com', label_ids: ['INBOX'] },
          // A bare code as the subject, with an innocuous body.
          { received_at: mk(7), subject: '7719', body_text: 'Thanks for coming out.', from_address: 'pat@example.com', label_ids: ['INBOX'] },
        ],
      }),
    });
    expect(ctx.text).toContain('Sounds good, see you then.');
    expect(ctx.text).not.toContain('retreat the kitchen');
    expect(ctx.text).not.toMatch(/\b123\b/);
    expect(ctx.text).not.toContain('4821');
    expect(ctx.text).not.toContain('BLUE');
    expect(ctx.text).toMatch(/Customer text .*: \[redacted\]/);
    expect(ctx.text).not.toContain('7719');
    expect(ctx.text).toContain('Thanks for coming out.');
  });

  test('no customerId returns an empty context', async () => {
    const ctx = await buildCompletionCommsContext({ customerId: null, knex: stubKnex({}) });
    expect(ctx.text).toBe('');
  });

  // GATE_REPORT_WRITER_RULES: the report writer reads only the customer's
  // own words, each labeled; Waves' own texts and emails stay out.
  test('customer words keep the customer\'s own words, labeled, and drop what Waves sent', async () => {
    const mk = (offsetDays) => new Date(NOW - offsetDays * DAY);
    const knexWith = (whereArgs) => stubKnex({
      scheduled_services: [
        { id: 'svc-1', customer_id: 'c1', service_type: 'Rodent Exclusion Service', created_at: mk(10) },
      ],
      service_completion_profiles: [],
      call_log: [
        { created_at: mk(1), direction: 'inbound', lead_synopsis: 'Heard noises again in the attic' },
        { created_at: mk(4), direction: 'outbound', lead_synopsis: 'Confirmed the visit window' },
        { created_at: mk(7), direction: null, lead_synopsis: 'Discussed the attic hatch' },
        // Linked by caller ID before classification, then marked spam.
        { created_at: mk(8), direction: 'inbound', processing_status: 'spam', lead_synopsis: 'Extended warranty robocall' },
        // Only a raw transcript: both speakers mixed, never the customer's words.
        { created_at: mk(5), direction: 'outbound', transcription: 'Agent: We will be there Thursday. Customer: OK.' },
      ],
      sms_log: [
        { created_at: mk(2), direction: 'outbound', message_body: 'Confirming your exclusion visit window' },
        { created_at: mk(3), direction: 'inbound', message_body: 'Scratching is worse after midnight' },
        // The code comes before its anchor, and the anchor sits past the
        // 260-character cut: redaction has to run on the whole message.
        { created_at: mk(9), direction: 'inbound', message_body: `4821 ${'and the side yard is muddy '.repeat(12)}is the gate code` },
      ],
      emails: [
        { received_at: mk(5), subject: 'Attic photos', snippet: 'Photos of the soffit gap attached', from_address: 'pat@example.com', label_ids: ['INBOX'] },
        { received_at: mk(6), subject: 'Your visit', snippet: 'See you Tuesday', from_address: 'Waves Pest Control <contact@wavespestcontrol.com>', label_ids: ['SENT'] },
        // Gmail's snippet stops before the anchor; the full body has it.
        { received_at: mk(10), subject: 'Access', snippet: `5173 ${'the back door sticks '.repeat(8)}`, body_text: `5173 ${'the back door sticks '.repeat(14)}is the gate code`, from_address: 'pat@example.com', label_ids: ['INBOX'] },
        // A snippet with no body has lost the context entirely.
        { received_at: mk(11), subject: 'Side gate', snippet: 'The number is 6620 if you need it', from_address: 'pat@example.com', label_ids: ['INBOX'] },
      ],
    }, whereArgs);
    const whereArgs = {};
    const ctx = await buildCustomerWordsContext({
      customerId: 'c1', scheduledServiceId: 'svc-1', knex: knexWith(whereArgs),
    });
    // The filters run in the queries, before each channel's cap, so Waves'
    // own texts and mail can never crowd the customer's words out.
    expect(whereArgs.sms_log).toContainEqual(['direction', 'inbound']);
    // The whole bounded window is read before misdials are dropped, so they
    // never use up the six calls kept.
    expect(whereArgs['call_log:limit']).toBe(50);
    // The canonical call reader's exclusions: no sandbox call, no call
    // classified spam or wrong number.
    expect(whereArgs['call_log:raw'].map(([sql]) => sql).join(' ')).toContain("COALESCE(??, '') <> ?");
    expect(whereArgs.call_log.some(([arg]) => typeof arg === 'function')).toBe(true);
    expect(ctx.text).not.toContain('warranty robocall');
    expect(ctx.text).not.toContain('We will be there Thursday');
    expect(ctx.promptHint).toContain('never what Waves said or promised');
    expect(ctx.text).not.toContain('4821');
    expect(ctx.text).not.toContain('5173');
    expect(ctx.text).not.toContain('6620');

    expect(ctx.text).toMatch(/Customer text .*: \[redacted\] and the side yard is muddy/);
    expect(whereArgs['emails:raw'].map(([sql]) => sql).join(' ')).toMatch(/SENT.*wavespestcontrol\.com/s);
    const lines = ctx.text.split('\n')
      .filter((line) => !/side yard is muddy|back door sticks|Side gate/.test(line));
    expect(lines).toEqual([
      expect.stringMatching(/^Call .* \(the customer called; AI summary of the whole conversation, not verified\): Heard noises again in the attic$/),
      expect.stringMatching(/^Customer text .*: Scratching is worse after midnight$/),
      expect.stringMatching(/^Call .* \(Waves called the customer; AI summary of the whole conversation, not verified\): Confirmed the visit window$/),
      expect.stringMatching(/^Customer email .* "Attic photos": Photos of the soffit gap attached$/),
      expect.stringMatching(/^Call .* \(caller unknown; AI summary of the whole conversation, not verified\): Discussed the attic hatch$/),
    ]);
    expect(ctx.text).not.toContain('Confirming your exclusion visit window');
    expect(ctx.text).not.toContain('See you Tuesday');
    expect(ctx.promptHint).toContain('never a finding');
    expect(ctx.promptHint).toContain('rodent');
  });
});
