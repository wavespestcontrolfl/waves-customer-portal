/**
 * On-site follow-up after the recipient's YES (owner 2026-10-02): the caller's
 * appointment texts switch off once, and the recipient gets the booking
 * confirmation they missed, driven by the confirmed recipient_optin row's
 * visit_id (call-pipeline on-site asks only). One atomic claim per row, retries
 * from the sweep, never a double send or a second demotion.
 */
const KEY = '5550100123';
const OTHER = '5550100456';

// A small stateful stand-in for the three tables the follow-up touches. Queries
// are evaluated by the shape the service builds (claim / finish / demote marker).
function load({ rows, customer, visitState = 'live', replay, prefsInsert, gateOn = true, demoteGateOn = true } = {}) {
  jest.resetModules();
  const state = {
    optin: rows.map((r) => ({ followup_claimed_at: null, followup_done_at: null, caller_demoted_at: null, ...r })),
    customer: { id: 'c1', service_contacts_consent_at: new Date('2026-10-01T00:00:00Z'), service_preferences: {}, ...customer },
    prefs: [],
    visitState,
  };
  const make = (table) => {
    const ctx = { filter: {}, nulls: [], notNulls: [], groupBy: null };
    const matches = (r) => Object.entries(ctx.filter).every(([k, v]) => r[k] === v)
      && ctx.nulls.every((c) => r[c] == null) && ctx.notNulls.every((c) => r[c] != null);
    const q = {
      where: jest.fn((f) => { if (typeof f === 'function') f({ whereNull: () => ({ orWhere: () => {} }) }); else Object.assign(ctx.filter, f); return q; }),
      whereNull: jest.fn((c) => { ctx.nulls.push(c); return q; }),
      whereNotNull: jest.fn((c) => { ctx.notNulls.push(c); return q; }),
      select: jest.fn(() => q),
      forUpdate: jest.fn(() => q),
      whereRaw: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      groupBy: jest.fn(() => q),
      orderByRaw: jest.fn(() => q),
      limit: jest.fn(async () => [...new Set(state.optin.filter((r) => r.status === 'confirmed' && r.visit_id && !r.followup_done_at).map((r) => r.customer_id))].map((customer_id) => ({ customer_id }))),
      first: jest.fn(async () => {
        if (table === 'customers') return { ...state.customer };
        if (table === 'recipient_optin') { const r = state.optin.find(matches); return r ? { ...r } : undefined; }
        return null;
      }),
      insert: jest.fn((row) => {
        if (table !== 'notification_prefs') return q;
        const i = { onConflict: () => ({ merge: async (patch) => { state.prefs.push({ ...row, ...patch }); return 1; } }) };
        if (prefsInsert) prefsInsert(row);
        return i;
      }),
      update: jest.fn((patch) => {
        let touched = [];
        if (table === 'recipient_optin') {
          const isClaim = Object.keys(patch).join() === 'followup_claimed_at' && patch.followup_claimed_at instanceof Date;
          touched = state.optin.filter((r) => matches(r)
            && (!isClaim || (r.status === 'confirmed' && !r.followup_claimed_at)));
          touched.forEach((r) => Object.assign(r, patch));
        }
        if (table === 'customers' && patch.service_contacts_consent_at) { Object.assign(state.customer, patch); touched = [state.customer]; }
        const done = Promise.resolve(touched.length);
        done.returning = async () => touched.map((r) => ({ ...r }));
        return done;
      }),
    };
    // Awaiting a select on recipient_optin answers the matching customers.
    q.then = (resolve, reject) => Promise.resolve(table === 'recipient_optin'
      ? state.optin.filter(matches).map((r) => ({ customer_id: r.customer_id, phone_key: r.phone_key }))
      : []).then(resolve, reject);
    return q;
  };
  const dbMock = jest.fn(make);
  dbMock.transaction = jest.fn(async (fn) => fn(dbMock));
  dbMock.raw = (sql, binds) => (binds ? { sql, binds } : sql);
  jest.doMock('../models/db', () => dbMock);
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => gateOn), onSiteCallerDemoteLive: jest.fn(() => demoteGateOn) }));
  jest.doMock('../services/street-level-hold', () => ({ isStreetLevelHoldVisit: jest.fn(async () => state.visitState === 'wait') }));
  const sendReplay = replay || jest.fn(async () => ({ sent: true }));
  jest.doMock('../services/appointment-reminders', () => ({
    scheduledServiceApptTime: jest.fn(async () => new Date(Date.now() + (state.visitState === 'dead' ? -3600000 : 3600000))),
    sendConfirmationToServiceContact: sendReplay,
  }));
  // visitAskState reads the visit's status through the same db handle.
  const origImpl = dbMock.getMockImplementation();
  dbMock.mockImplementation((table) => {
    if (table === 'scheduled_services') {
      const q = { where: () => q, first: async () => (state.visitState === 'dead' ? undefined : { id: 'v1' }) };
      return q;
    }
    return origImpl(table);
  });
  const optin = require('../services/recipient-optin');
  return { optin, state, sendReplay, dbMock };
}
const row = (extra = {}) => ({ customer_id: 'c1', phone_key: KEY, status: 'confirmed', visit_id: 'v1', confirmed_at: new Date(), ...extra });
const spouse = (extra = {}) => ({
  service_contact_name: 'Sample Spouse', service_contact_phone: '+15550100123', service_contact_email: null, service_contact_role: 'spouse_partner',
  service_contact2_phone: null, service_contact3_phone: null, ...extra,
});

describe('on-site follow-up: caller demotion + confirmation replay', () => {
  test('a YES on a live visit demotes the caller once and replays the confirmation, answering the YES', async () => {
    const { optin, state, sendReplay } = load({ rows: [row()], customer: spouse() });
    expect(await optin.settleOnSiteFollowUps(['c1'], { inReplyToYes: true })).toBe(1);
    expect(state.prefs).toEqual([{ customer_id: 'c1', appointment_notify_primary: false }]);
    expect(state.optin[0].caller_demoted_at).toBeInstanceOf(Date);
    expect(sendReplay).toHaveBeenCalledWith({ customerId: 'c1', scheduledServiceId: 'v1', phone: '+15550100123', inReplyToYes: true });
    expect(state.optin[0].followup_done_at).toBeInstanceOf(Date);
    expect(state.optin[0].followup_claimed_at).toBeNull();
  });

  test('a repeated / duplicate YES never sends twice or demotes again (a holder who turned texts back on stays on)', async () => {
    const { optin, state, sendReplay } = load({ rows: [row()], customer: spouse() });
    await optin.settleOnSiteFollowUps(['c1'], { inReplyToYes: true });
    await optin.settleOnSiteFollowUps(['c1'], { inReplyToYes: true });
    await optin.sweepOnSiteFollowUps();
    expect(sendReplay).toHaveBeenCalledTimes(1);
    expect(state.prefs).toHaveLength(1);
  });

  test('a replay that is held / not sent releases its claim; the sweep retries (not as a reply) without demoting again', async () => {
    const replay = jest.fn()
      .mockResolvedValueOnce({ sent: false, reason: 'not_sent' })
      .mockResolvedValueOnce({ sent: true });
    const { optin, state } = load({ rows: [row()], customer: spouse(), replay });
    await optin.settleOnSiteFollowUps(['c1'], { inReplyToYes: true });
    expect(state.optin[0].followup_done_at).toBeNull();
    expect(state.optin[0].followup_claimed_at).toBeNull();
    expect(state.optin[0].caller_demoted_at).toBeInstanceOf(Date);
    expect(await optin.sweepOnSiteFollowUps()).toEqual({ settled: 1 });
    expect(replay).toHaveBeenCalledTimes(2);
    expect(replay.mock.calls[1][0].inReplyToYes).toBe(false);
    expect(state.optin[0].followup_done_at).toBeInstanceOf(Date);
    expect(state.prefs).toHaveLength(1);
  });

  test('retryable vs final replay reasons', async () => {
    for (const [result, done] of [
      [{ sent: false, reason: 'primary_confirmation_pending' }, false],
      [{ sent: false, reason: 'callback_number_hold' }, false],
      [{ sent: false, reason: 'error' }, false],
      [{ sent: false, reason: 'template_unavailable' }, false],
      [{ sent: false, reason: 'already_sent' }, true],
      [{ sent: false, reason: 'visit_not_live' }, true],
      [{ sent: false, reason: 'sms_not_chosen' }, true],
      [{ sent: false, reason: 'delivery_uncertain' }, true],
    ]) {
      const { optin, state } = load({ rows: [row()], customer: spouse(), replay: jest.fn(async () => result) });
      await optin.settleOnSiteFollowUps(['c1']);
      expect(!!state.optin[0].followup_done_at).toBe(done);
    }
  });

  test('a visit that is gone (cancelled / under way / past) ends it: no demotion, no send', async () => {
    const { optin, state, sendReplay } = load({ rows: [row()], customer: spouse(), visitState: 'dead' });
    await optin.settleOnSiteFollowUps(['c1']);
    expect(sendReplay).not.toHaveBeenCalled();
    expect(state.prefs).toEqual([]);
    expect(state.optin[0].followup_done_at).toBeInstanceOf(Date);
  });

  test('an office-review hold waits (claim released, nothing demoted or sent)', async () => {
    const { optin, state, sendReplay } = load({ rows: [row()], customer: spouse(), visitState: 'wait' });
    await optin.settleOnSiteFollowUps(['c1']);
    expect(sendReplay).not.toHaveBeenCalled();
    expect(state.prefs).toEqual([]);
    expect(state.optin[0].followup_done_at).toBeNull();
    expect(state.optin[0].followup_claimed_at).toBeNull();
  });

  test('another slot phone on the account: the caller stays, the recipient still gets the replay', async () => {
    const { optin, state, sendReplay } = load({ rows: [row()], customer: spouse({ service_contact2_phone: '+15550100456' }) });
    await optin.settleOnSiteFollowUps(['c1']);
    expect(state.prefs).toEqual([]);
    expect(state.optin[0].caller_demoted_at).toBeNull();
    expect(sendReplay).toHaveBeenCalledTimes(1);
  });

  test('the account\'s consent not covering the phone yet (no stamp): no demotion, no send; waits for the sweep', async () => {
    const { optin, state, sendReplay } = load({ rows: [row()], customer: spouse({ service_contacts_consent_at: null }) });
    await optin.settleOnSiteFollowUps(['c1']);
    expect(sendReplay).not.toHaveBeenCalled();
    expect(state.prefs).toEqual([]);
    expect(state.optin[0].followup_done_at).toBeNull();
    expect(state.optin[0].followup_claimed_at).toBeNull();
  });

  test('a phone on the unconsented hold is not a recipient: nobody is demoted', async () => {
    const { optin, state, sendReplay } = load({ rows: [row()], customer: spouse({ service_preferences: { unconsented_slot_phone_keys: [KEY] } }) });
    await optin.settleOnSiteFollowUps(['c1']);
    expect(sendReplay).not.toHaveBeenCalled();
    expect(state.prefs).toEqual([]);
  });

  test('a contact removed from the slots ends it', async () => {
    const { optin, state, sendReplay } = load({ rows: [row()], customer: spouse({ service_contact_phone: '+15550100999' }) });
    await optin.settleOnSiteFollowUps(['c1']);
    expect(sendReplay).not.toHaveBeenCalled();
    expect(state.prefs).toEqual([]);
    expect(state.optin[0].followup_done_at).toBeInstanceOf(Date);
  });

  test('portal / explicit-consent asks (no visit_id) never trigger it', async () => {
    const { optin, state, sendReplay } = load({ rows: [row({ visit_id: null })], customer: spouse() });
    expect(await optin.settleOnSiteFollowUps(['c1'])).toBe(0);
    expect(sendReplay).not.toHaveBeenCalled();
    expect(state.prefs).toEqual([]);
  });

  test('a claim another process holds (fresh lease) is left alone; a pending / declined row never runs', async () => {
    const held = load({ rows: [row({ followup_claimed_at: new Date() })], customer: spouse() });
    expect(await held.optin.settleOnSiteFollowUps(['c1'])).toBe(0);
    expect(held.sendReplay).not.toHaveBeenCalled();
    const pending = load({ rows: [row({ status: 'pending' }), row({ phone_key: OTHER, status: 'declined' })], customer: spouse() });
    expect(await pending.optin.settleOnSiteFollowUps(['c1'])).toBe(0);
  });

  test('a follow-up older than the cap is dropped, not retried forever', async () => {
    const { optin, state, sendReplay } = load({ rows: [row({ confirmed_at: new Date(Date.now() - 15 * 24 * 3600000) })], customer: spouse() });
    await optin.settleOnSiteFollowUps(['c1']);
    expect(sendReplay).not.toHaveBeenCalled();
    expect(state.optin[0].followup_done_at).toBeInstanceOf(Date);
  });

  test('a replay that throws never throws out of the follow-up, and the claim is released for the sweep', async () => {
    const { optin, state } = load({ rows: [row()], customer: spouse(), replay: jest.fn(async () => { throw new Error('boom'); }) });
    await expect(optin.settleOnSiteFollowUps(['c1'])).resolves.toBe(0);
    expect(state.optin[0].followup_done_at).toBeNull();
    expect(state.optin[0].followup_claimed_at).toBeNull();
  });

  test('a demotion write that fails retries (not done) but the replay still goes out', async () => {
    const { optin, state, sendReplay } = load({
      rows: [row()], customer: spouse(), prefsInsert: () => { throw new Error('prefs down'); },
    });
    await optin.settleOnSiteFollowUps(['c1']);
    expect(sendReplay).toHaveBeenCalledTimes(1);
    expect(state.optin[0].followup_done_at).toBeNull();
  });

  test('gate off: nothing runs', async () => {
    const { optin, sendReplay } = load({ rows: [row()], customer: spouse(), gateOn: false });
    expect(await optin.settleOnSiteFollowUps(['c1'])).toBe(0);
    expect(await optin.sweepOnSiteFollowUps()).toEqual({ settled: 0 });
    expect(sendReplay).not.toHaveBeenCalled();
  });

  test('GATE_ONSITE_CALLER_DEMOTE off (dark): a YES demotes nobody and replays nothing; the sweep closes the row so a later flip never acts on it', async () => {
    const { optin, state, sendReplay } = load({ rows: [row(), row({ phone_key: OTHER, visit_id: null })], customer: spouse(), demoteGateOn: false });
    expect(await optin.settleOnSiteFollowUps(['c1'], { inReplyToYes: true })).toBe(0);
    expect(await optin.demoteCallerForConfirmedOnSite('c1', KEY, 'v1')).toBe('skipped');
    expect(state.optin[0].followup_done_at).toBeNull();
    expect(await optin.sweepOnSiteFollowUps()).toEqual({ settled: 0 });
    expect(sendReplay).not.toHaveBeenCalled();
    expect(state.prefs).toEqual([]);
    expect(state.optin[0].caller_demoted_at).toBeNull();
    // Closed: the visit-bound row only (a portal ask carries no visit and no obligation).
    expect(state.optin[0].followup_done_at).toBeInstanceOf(Date);
    expect(state.optin[1].followup_done_at).toBeNull();
  });

  test('the gate reader is strict: only GATE_ONSITE_CALLER_DEMOTE=true turns it on', () => {
    jest.resetModules();
    jest.dontMock('../config/feature-gates');
    const { onSiteCallerDemoteLive } = require('../config/feature-gates');
    const prior = process.env.GATE_ONSITE_CALLER_DEMOTE;
    try {
      delete process.env.GATE_ONSITE_CALLER_DEMOTE;
      expect(onSiteCallerDemoteLive()).toBe(false);
      process.env.GATE_ONSITE_CALLER_DEMOTE = '1';
      expect(onSiteCallerDemoteLive()).toBe(false);
      process.env.GATE_ONSITE_CALLER_DEMOTE = 'true';
      expect(onSiteCallerDemoteLive()).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.GATE_ONSITE_CALLER_DEMOTE; else process.env.GATE_ONSITE_CALLER_DEMOTE = prior;
    }
  });
});

describe('the YES drives the follow-up only AFTER it commits', () => {
  // The webhook's transaction handle: the YES's own reads go through it; its
  // executionPromise settles at commit (or rejects on rollback).
  function trxOf(dbMock, executionPromise) {
    const trx = jest.fn((table) => {
      const q = dbMock(table);
      return q;
    });
    trx.raw = dbMock.raw;
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.isTransaction = true;
    trx.executionPromise = executionPromise;
    return trx;
  }
  const tick = () => new Promise((r) => setImmediate(r));

  test('the follow-up waits for the commit, then answers the YES', async () => {
    const { optin, sendReplay, state, dbMock } = load({ rows: [row()], customer: spouse() });
    let commit;
    const trx = trxOf(dbMock, new Promise((resolve) => { commit = resolve; }));
    await optin.onRecipientConfirmed(KEY, { dbh: trx });
    await tick();
    expect(sendReplay).not.toHaveBeenCalled();
    commit();
    await tick();
    await tick();
    expect(sendReplay).toHaveBeenCalledTimes(1);
    expect(sendReplay.mock.calls[0][0].inReplyToYes).toBe(true);
    expect(state.optin[0].followup_done_at).toBeInstanceOf(Date);
  });

  test('a rolled-back YES runs nothing', async () => {
    const { optin, sendReplay, state, dbMock } = load({ rows: [row()], customer: spouse() });
    const rolledBack = Promise.reject(new Error('rolled back'));
    rolledBack.catch(() => {});
    await optin.onRecipientConfirmed(KEY, { dbh: trxOf(dbMock, rolledBack) });
    await tick();
    await tick();
    expect(sendReplay).not.toHaveBeenCalled();
    expect(state.prefs).toEqual([]);
  });

  test('a replay failure on a fire-and-forget YES never undoes or blocks the consent already recorded', async () => {
    const { optin, state } = load({ rows: [row()], customer: spouse({ service_contacts_consent_at: null }), replay: jest.fn(async () => { throw new Error('boom'); }) });
    await expect(optin.onRecipientConfirmed(KEY)).resolves.toBeUndefined();
    expect(state.customer.service_contacts_consent_source).toBe('recipient_optin_confirmed');
  });
});

describe('demoteCallerForConfirmedOnSite: a phone that already said YES gets no new ask', () => {
  test('demotes once when the booking is live and it never happened; skipped when already applied, not confirmed or the visit is not live', async () => {
    const a = load({ rows: [row()], customer: spouse() });
    expect(await a.optin.demoteCallerForConfirmedOnSite('c1', KEY, 'v2')).toBe('demoted');
    expect(a.state.prefs).toHaveLength(1);
    expect(await a.optin.demoteCallerForConfirmedOnSite('c1', KEY, 'v2')).toBe('skipped');
    expect(a.state.prefs).toHaveLength(1);
    expect(a.sendReplay).not.toHaveBeenCalled();

    const pending = load({ rows: [row({ status: 'pending' })], customer: spouse() });
    expect(await pending.optin.demoteCallerForConfirmedOnSite('c1', KEY, 'v2')).toBe('skipped');
    const dead = load({ rows: [row()], customer: spouse(), visitState: 'dead' });
    expect(await dead.optin.demoteCallerForConfirmedOnSite('c1', KEY, 'v2')).toBe('skipped');
    expect(dead.state.prefs).toEqual([]);
  });
});

describe('wiring', () => {
  const fs = require('fs');
  const read = (p) => fs.readFileSync(require.resolve(p), 'utf8');
  test('the 15-minute sweep retries unfinished follow-ups; the booking site reconciles an already-confirmed phone', () => {
    expect(read('../index.js')).toContain('await sweepOnSiteFollowUps();');
    expect(read('../services/call-recording-processor.js')).toContain('demoteCallerForConfirmedOnSite(customerId, phoneKey, svc.id)');
  });
  test('the replay claim is atomic on the row (one UPDATE ... RETURNING), never a read-then-write', () => {
    const src = read('../services/recipient-optin.js');
    expect(src).toContain(".update({ followup_claimed_at: new Date() })\n    .returning(['phone_key', 'visit_id', 'confirmed_at', 'caller_demoted_at']);");
    expect(src).toContain(".whereNull('caller_demoted_at')");
  });
});
