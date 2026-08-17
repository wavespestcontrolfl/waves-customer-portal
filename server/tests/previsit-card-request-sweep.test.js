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

  test('a customer-level plan member is never backstopped even without a live recurring row (codex #3426 r3 P1)', () => {
    expect(previsitCardInviteEligible({ ...base, activePlanMember: true }))
      .toEqual({ send: false, reason: 'existing_plan_member' });
  });

  test('the recurring exclusion is in the QUERY and rechecked under the lock — not only completed history', () => {
    const sweep = require('fs').readFileSync(
      require.resolve('../services/previsit-card-request-sweep'), 'utf8',
    );
    // Pre-portal members carry no completed scheduled_services rows, so the
    // first-time predicate alone read a 16-month member as new (2026-08-15
    // incident): a live recurring series must exclude on its own.
    expect(sweep).toContain('.whereNotExists(function recurringPlan()');
    // The canonical recurring marker TRIO (codex #3426 r4 P1 — the same set
    // project-completion's hasActiveRecurringSchedule and pay-v2 read): a
    // legacy top-level series row can carry recurring_pattern alone, with
    // is_recurring false/null and no parent id. Both legs (candidate query +
    // locked recheck) read all three markers.
    expect(sweep.match(/qb\.where\('rec\.is_recurring', true\)\.orWhereNotNull\('rec\.recurring_parent_id'\)\.orWhereNotNull\('rec\.recurring_pattern'\)/g)).toHaveLength(2);
    // Fail-closed race recheck inside the advisory lock, same as the
    // invited-history rechecks.
    expect(sweep).toContain('if (reqRow || stampRow || !liveCustomer || recurringRow || isMembershipCustomerRow(liveCustomer))');
    // Shared active-plan vocabulary (codex #3426 r1 P1): recurring evidence
    // counts every NON-terminal row — an in-progress (en_route/on_site)
    // recurring visit is an active plan — never only the sweep's own
    // pending/confirmed candidate statuses.
    expect(sweep).toContain("require('./waveguard-existing-services')");
    expect(sweep.match(/whereNotIn\('rec\.status', TERMINAL_STATUSES\)/g)).toHaveLength(2);
    expect(sweep).not.toContain("whereIn('rec.status', LIVE_VISIT_STATUSES)");
  });

  test('customer-LEVEL plan evidence uses the ONE canonical predicate in filter and locked recheck (codex #3426 r3 P1)', () => {
    const sweep = require('fs').readFileSync(
      require.resolve('../services/previsit-card-request-sweep'), 'utf8',
    );
    // A legacy member can hold a tier (or a legacy positive monthly_rate)
    // with NO nonterminal recurring visit row — row-only evidence misses
    // them. The predicate is isMembershipCustomerRow, shared with the admin
    // "No Plan" badge and the estimate repricer, applied in JS on selected
    // columns — never a re-encoded SQL copy that could drift.
    expect(sweep).toContain('isMembershipCustomerRow');
    expect(sweep).toContain("'c.waveguard_tier as customer_waveguard_tier'");
    expect(sweep).toContain("'c.monthly_rate as customer_monthly_rate'");
    // Candidate filter leg (pre-cap: members must not burn the batch cap)…
    expect(sweep).toContain('activePlanMember: isMembershipCustomerRow({');
    // …and the in-lock recheck leg on the same customers probe.
    expect(sweep).toContain('|| isMembershipCustomerRow(liveCustomer)');
    expect(sweep).toContain("first('id', 'waveguard_tier', 'monthly_rate')");
    // Members are excluded IN the query, before the LIMIT (codex #3426 r4
    // P2): a JS-only filter after a fixed window lets member rows crowd
    // eligible one-time customers out of consideration. The SQL twin is
    // exported by the SAME module as the JS predicate so they cannot fork.
    expect(sweep).toContain(".whereRaw(notMembershipCustomerSql('c'))");
  });

  test('the SQL twin mirrors the JS membership predicate — same tier vocabulary, same legacy-rate fallback', () => {
    const {
      notMembershipCustomerSql,
      NON_MEMBERSHIP_TIER_KEYS,
      isMembershipCustomerRow,
    } = require('../services/waveguard-existing-services');
    const sql = notMembershipCustomerSql('c');
    // Every non-membership tier key the JS predicate consults appears in the
    // SQL IN-list — a key added to one side without the other fails here.
    for (const key of NON_MEMBERSHIP_TIER_KEYS) {
      expect(sql).toContain(`'${key}'`);
    }
    // Tier normalization and the tierless legacy monthly_rate fallback both
    // present, matching isMembershipCustomerRow's branch structure.
    expect(sql).toContain("regexp_replace(lower(coalesce(c.waveguard_tier, '')), '[^a-z0-9]+', '', 'g')");
    expect(sql).toContain('COALESCE(c.monthly_rate, 0) <= 0');
    // Spot-check the JS side agrees on the branch semantics the SQL encodes:
    // a known tier is a member even at rate 0; a non-membership tier is not
    // a member even at a positive rate; tierless resolves on the rate.
    expect(isMembershipCustomerRow({ waveguard_tier: 'Silver', monthly_rate: 0 })).toBe(true);
    expect(isMembershipCustomerRow({ waveguard_tier: 'none', monthly_rate: '49.00' })).toBe(false);
    expect(isMembershipCustomerRow({ waveguard_tier: null, monthly_rate: '49.00' })).toBe(true);
    expect(isMembershipCustomerRow({ waveguard_tier: null, monthly_rate: 0 })).toBe(false);
  });

  test('the sweep transaction joins the customer-comms lock namespace — conversions serialize with the send (codex #3426 r2)', () => {
    const sweep = require('fs').readFileSync(
      require.resolve('../services/previsit-card-request-sweep'), 'utf8',
    );
    // Plan-conversion writers hold `customer-comms:<id>` around their
    // scheduled_services inserts (customer-comms-lock.js contract). The
    // sweep's private invite key can't fence them; only sharing THEIR key
    // closes the recheck→send window. The lock must be granted before the
    // in-lock recheck, and the funnel call (send included) must run inside
    // the same transaction so the lock holds through dispatch.
    expect(sweep).toContain("require('../utils/customer-comms-lock')");
    const lockIdx = sweep.indexOf('await lockCustomerComms(trx, visit.customer_id);');
    const recheckIdx = sweep.indexOf('if (reqRow || stampRow || !liveCustomer || recurringRow || isMembershipCustomerRow(liveCustomer))');
    const funnelIdx = sweep.indexOf('const result = await requestCardForAppointment({');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(recheckIdx).toBeGreaterThan(lockIdx);
    expect(funnelIdx).toBeGreaterThan(recheckIdx);
  });

  test('every admin tier writer joins the customer-comms lock — editor AND fix-tiers (codex #3426 r4+r5)', () => {
    const adminCustomers = require('fs').readFileSync(
      require.resolve('../routes/admin-customers'), 'utf8',
    );
    // Two writers can flip waveguard_tier from the admin surface: the
    // customer editor (PUT /:id) and the bulk recalculator
    // (POST /fix-tiers). Both must hold `customer-comms:<id>` for the
    // write, or a membership-making commit can land between the sweep's
    // in-lock recheck and its SMS dispatch. The editor takes the lock
    // inside its own transaction; fix-tiers has none of its own, so it
    // wraps each write in withCustomerCommsLock and re-derives the
    // skip/no-op decisions from the row read under the lock.
    expect(adminCustomers).toContain("require('../utils/customer-comms-lock')");
    expect(adminCustomers).toContain('await lockCustomerComms(trx, req.params.id);');
    const fixTiersIdx = adminCustomers.indexOf("router.post('/fix-tiers'");
    const lockedWriteIdx = adminCustomers.indexOf('await withCustomerCommsLock(db, c.id, async (trx) => {');
    const nextRouteIdx = adminCustomers.indexOf("router.post('/backfill-review-status'");
    expect(fixTiersIdx).toBeGreaterThan(-1);
    expect(lockedWriteIdx).toBeGreaterThan(fixTiersIdx);
    expect(lockedWriteIdx).toBeLessThan(nextRouteIdx);
    // The tier UPDATE itself runs on the lock's trx, not the bare db —
    // an update outside the transaction would release-before-write.
    const fixTiersBody = adminCustomers.slice(fixTiersIdx, nextRouteIdx);
    expect(fixTiersBody).toContain("await trx('customers').where({ id: c.id }).update({ waveguard_tier: newTier });");
    expect(fixTiersBody).not.toContain("await db('customers').where({ id: c.id }).update");
  });

  test('Intelligence Bar membership writers join the customer-comms lock — single, bulk-scalar, bulk-per-row (codex #3426 r6)', () => {
    const tools = require('fs').readFileSync(
      require.resolve('../services/intelligence-bar/tools'), 'utf8',
    );
    // The IB exposes waveguard_tier and monthly_rate as updatable fields
    // through three write paths: updateCustomer's transaction, the bulk
    // single-statement scalar branch, and the bulk per-row address/email
    // branch. Every one must hold `customer-comms:<id>` before its
    // customers row lock, or an operator's membership-making write lands
    // between the sweep's in-lock recheck and the SMS send.
    expect(tools).toContain("require('../../utils/customer-comms-lock')");
    // Two per-customer acquisition sites (single edit + bulk per-row),
    // each gated on the membership fields:
    const perRowAcquisitions = tools.split('await lockCustomerComms(trx, customerId);').length - 1;
    expect(perRowAcquisitions).toBe(2);
    // The bulk scalar branch locks every id in STABLE sorted order before
    // its whereIn(...).forUpdate() — concurrent bulk writers over
    // overlapping sets must acquire in the same sequence.
    const bulkLoopIdx = tools.indexOf('for (const cid of [...customerIds].map(String).sort()) {');
    expect(bulkLoopIdx).toBeGreaterThan(-1);
    expect(tools.indexOf('await lockCustomerComms(trx, cid);')).toBeGreaterThan(bulkLoopIdx);
    const bulkForUpdateIdx = tools.indexOf(".whereIn('id', customerIds)\n          .forUpdate()");
    expect(bulkForUpdateIdx).toBeGreaterThan(bulkLoopIdx);
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
