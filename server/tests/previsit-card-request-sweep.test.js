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
    outboundReviewPending: false,
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

  test('an outbound-review pending row waits for the office', () => {
    expect(previsitCardInviteEligible({ ...base, outboundReviewPending: true }))
      .toEqual({ send: false, reason: 'outbound_review_pending' });
  });

  test('a visit already texted never re-texts from the sweep', () => {
    expect(previsitCardInviteEligible({ ...base, cardLinkSentAt: new Date() }))
      .toEqual({ send: false, reason: 'already_texted' });
  });

  test('a customer the funnel EVER invited is skipped — introduction, not dunning (owner default)', () => {
    expect(previsitCardInviteEligible({ ...base, customerEverInvited: true }))
      .toEqual({ send: false, reason: 'customer_already_invited' });
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
