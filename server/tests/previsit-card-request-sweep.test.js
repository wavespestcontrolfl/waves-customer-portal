const {
  previsitCardInviteEligible,
  sweepGateEnabled,
  runSweep,
  LEAD_DAYS,
  BATCH_CAP,
} = require('../services/previsit-card-request-sweep');

// The sweep's own selection rules only — funnel policy (payer, autopay,
// saved-method auto-secure, one-text-ever, dark levers) is deliberately NOT
// re-encoded here and stays with requestCardForAppointment.
describe('previsitCardInviteEligible', () => {
  const base = {
    status: 'confirmed',
    isCallback: false,
    reServiceLabel: false,
    outboundReviewUncleared: false,
    cardLinkSentAt: null,
    customerEverInvited: false,
  };

  test('live never-invited visit → send', () => {
    expect(previsitCardInviteEligible(base)).toEqual({ send: true });
    expect(previsitCardInviteEligible({ ...base, status: 'pending' })).toEqual({ send: true });
  });

  test('non-live statuses never send', () => {
    for (const status of ['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show', '']) {
      expect(previsitCardInviteEligible({ ...base, status }).send).toBe(false);
    }
  });

  test('a callback/re-service visit never gets a card ask — free with the plan', () => {
    expect(previsitCardInviteEligible({ ...base, isCallback: true }))
      .toEqual({ send: false, reason: 'callback_visit' });
    expect(previsitCardInviteEligible({ ...base, reServiceLabel: true }))
      .toEqual({ send: false, reason: 'callback_visit' });
  });

  test('an outbound-review row without the durable clearance stamp never texts — status is not clearance (Codex #3361 r27 P1)', () => {
    // Covers BOTH the still-pending legacy row and the lazily-activated one
    // (a silent reschedule lands on status 'confirmed' without any office
    // decision): the caller derives this flag from call_sms_cleared_at
    // alone, never from status.
    expect(previsitCardInviteEligible({ ...base, outboundReviewUncleared: true }))
      .toEqual({ send: false, reason: 'outbound_review_uncleared' });
    expect(previsitCardInviteEligible({ ...base, status: 'pending', outboundReviewUncleared: true }))
      .toEqual({ send: false, reason: 'outbound_review_uncleared' });
  });

  test('the uncleared flag is derived from the clearance stamp, not the row status', () => {
    const sweep = require('fs').readFileSync(
      require.resolve('../services/previsit-card-request-sweep'), 'utf8',
    );
    // Set membership, not a single marker: voice-agent bookings share the
    // office-review lifecycle, so both markers derive the flag the same way.
    expect(sweep).toContain('outboundReviewUncleared: OFFICE_REVIEW_SOURCE_ACTIONS.includes(visit.source_action) && !visit.call_sms_cleared_at');
    // The SQL admission mirrors it: no status-based re-admit branch remains.
    expect(sweep).not.toContain("outboundConfirmed");
    expect(sweep).toContain(".orWhereNotNull('s.call_sms_cleared_at'))");
  });

  test('a visit already texted never re-texts from the sweep', () => {
    expect(previsitCardInviteEligible({ ...base, cardLinkSentAt: new Date() }))
      .toEqual({ send: false, reason: 'already_texted' });
  });

  test('a customer the funnel EVER invited is skipped — introduction, not dunning (owner default)', () => {
    expect(previsitCardInviteEligible({ ...base, customerEverInvited: true }))
      .toEqual({ send: false, reason: 'customer_already_invited' });
  });

  test('an existing recurring customer is never backstopped (owner ruling 2026-08-15)', () => {
    expect(previsitCardInviteEligible({ ...base, existingRecurringCustomer: true }))
      .toEqual({ send: false, reason: 'existing_recurring_customer' });
  });

  test('the recurring exclusion is in the QUERY and rechecked under the lock — not only completed history', () => {
    const sweep = require('fs').readFileSync(
      require.resolve('../services/previsit-card-request-sweep'), 'utf8',
    );
    // Pre-portal members carry no completed scheduled_services rows, so the
    // first-time predicate alone read a 16-month member as new (2026-08-15
    // incident): a live recurring series must exclude on its own.
    expect(sweep).toContain('.whereNotExists(function recurringPlan()');
    expect(sweep).toContain("qb.where('rec.is_recurring', true).orWhereNotNull('rec.recurring_parent_id')");
    // Fail-closed race recheck inside the advisory lock, same as the
    // invited-history rechecks.
    expect(sweep).toContain('if (reqRow || stampRow || !liveCustomer || recurringRow)');
    // Shared active-plan vocabulary (codex #3426 r1 P1): recurring evidence
    // counts every NON-terminal row — an in-progress (en_route/on_site)
    // recurring visit is an active plan — never only the sweep's own
    // pending/confirmed candidate statuses.
    expect(sweep).toContain("require('./waveguard-existing-services')");
    expect(sweep.match(/whereNotIn\('rec\.status', TERMINAL_STATUSES\)/g)).toHaveLength(2);
    expect(sweep).not.toContain("whereIn('rec.status', LIVE_VISIT_STATUSES)");
  });
});

describe('sweep gating', () => {
  const prior = process.env.GATE_PREVISIT_CARD_SWEEP;
  afterEach(() => {
    if (prior === undefined) delete process.env.GATE_PREVISIT_CARD_SWEEP;
    else process.env.GATE_PREVISIT_CARD_SWEEP = prior;
  });

  test('gate reads the env forms the other lanes accept', () => {
    delete process.env.GATE_PREVISIT_CARD_SWEEP;
    expect(sweepGateEnabled()).toBe(false);
    for (const v of ['true', '1', 'on']) {
      process.env.GATE_PREVISIT_CARD_SWEEP = v;
      expect(sweepGateEnabled()).toBe(true);
    }
    process.env.GATE_PREVISIT_CARD_SWEEP = 'false';
    expect(sweepGateEnabled()).toBe(false);
  });

  test('runSweep is inert with the gate off — no db touched', async () => {
    delete process.env.GATE_PREVISIT_CARD_SWEEP;
    const explodingDb = () => { throw new Error('db must not be touched while dark'); };
    await expect(runSweep(explodingDb)).resolves.toEqual({ skipped: true, reason: 'gate_off' });
  });
});

describe('sweep constants', () => {
  test('backstop cadence: short lead, bounded batch', () => {
    expect(LEAD_DAYS).toBe(3);
    expect(BATCH_CAP).toBe(25);
  });
});
