jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  recipientPhoneKey,
  optinBlocksSend,
  markRecipientOptin,
  applyDemoteMarkersOnConfirm,
  clearDemoteMarker,
  clearDemoteMarkersForPhone,
} = require('../services/recipient-optin');

describe('recipient double opt-in', () => {
  test('recipientPhoneKey matches the webhook last-10 convention', () => {
    expect(recipientPhoneKey('+19415550123')).toBe('9415550123');
    expect(recipientPhoneKey('(941) 555-0123')).toBe('9415550123');
    expect(recipientPhoneKey('')).toBe('');
    expect(recipientPhoneKey(null)).toBe('');
  });

  test('no row = grandfathered recipient, always allowed', () => {
    expect(optinBlocksSend(null, true)).toBe(false);
    expect(optinBlocksSend(undefined, true)).toBe(false);
  });

  test('pending and declined rows hold sends while the gate is on', () => {
    expect(optinBlocksSend({ status: 'pending' }, true)).toBe(true);
    expect(optinBlocksSend({ status: 'declined' }, true)).toBe(true);
    expect(optinBlocksSend({ status: 'confirmed' }, true)).toBe(false);
  });

  test('request_failed and lookup_error rows also hold sends (never-asked/unknown state)', () => {
    expect(optinBlocksSend({ status: 'request_failed' }, true)).toBe(true);
    expect(optinBlocksSend({ status: 'lookup_error' }, true)).toBe(true);
  });

  test('gate off disables the hold entirely', () => {
    expect(optinBlocksSend({ status: 'pending' }, false)).toBe(false);
    expect(optinBlocksSend({ status: 'declined' }, false)).toBe(false);
  });

  test('a later YES confirms declined rows even without dispatched_at (sync-21610 decline, codex #3495 r13)', async () => {
    // A synchronous 21610 declines the row BEFORE dispatch stamps
    // dispatched_at, and no sweep re-asks a declined row — the confirm
    // predicate must carve declined rows out of the dispatched_at
    // requirement or the person's explicit START+YES never unblocks them.
    // Capture the predicate the confirm update builds.
    const applied = { whereNotNull: [], orWhere: [] };
    function makeChain(rows = []) {
      const q = {};
      ['where', 'whereNot'].forEach((m) => {
        q[m] = jest.fn((arg) => {
          if (typeof arg === 'function') arg.call(q);
          return q;
        });
      });
      q.whereNotNull = jest.fn((col) => { applied.whereNotNull.push(col); return q; });
      q.orWhere = jest.fn((arg) => { applied.orWhere.push(arg); return q; });
      q.update = jest.fn(async () => 1);
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return q;
    }
    const confirmChain = makeChain();
    const pendingChain = makeChain([]); // no pending rows → no marker recovery
    const queues = { recipient_optin: [confirmChain, pendingChain] };
    const dbh = jest.fn((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`Unexpected table ${table}`);
      return queue.shift();
    });

    const updated = await markRecipientOptin('+19415550123', 'confirmed', { dbh });

    expect(updated).toBe(1);
    // ask_failed stays excluded; the dispatched_at requirement is grouped
    // with an OR status='declined' escape hatch.
    expect(confirmChain.whereNot).toHaveBeenCalledWith({ status: 'ask_failed' });
    expect(applied.whereNotNull).toContain('dispatched_at');
    expect(applied.orWhere).toContainEqual({ status: 'declined' });
  });

  // Marker-recovery sms_log lookup failure (hook #3495): on a TRANSACTIONAL
  // dbh Postgres has already aborted the trx — swallowing the error and
  // returning the count would let the webhook's fail-loud guard pass while
  // COMMIT resolves as a rollback. Must return FALSE so the caller retries
  // under its locked fallback. A fire-and-forget dbh keeps best-effort null.
  function markerRecoveryQueues({ smsLogFails }) {
    function chain({ rows = [], firstRejects = false } = {}) {
      const q = {};
      ['where', 'whereNot', 'whereRaw', 'whereNotNull', 'orWhere', 'orWhereRaw', 'orderBy'].forEach((m) => {
        q[m] = jest.fn((arg) => {
          if (typeof arg === 'function') arg.call(q);
          return q;
        });
      });
      q.update = jest.fn(async () => 1);
      q.first = jest.fn(() => (firstRejects
        ? Promise.reject(new Error('db down'))
        : Promise.resolve(null)));
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return q;
    }
    return {
      recipient_optin: [chain(), chain({ rows: [{ customer_id: 'c1' }] })],
      sms_log: [chain({ firstRejects: smsLogFails })],
    };
  }
  function queuedDbh(queues) {
    return jest.fn((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`Unexpected table ${table}`);
      return queue.shift();
    });
  }

  test('marker-recovery sms_log error on a transactional dbh returns FALSE', async () => {
    const dbh = queuedDbh(markerRecoveryQueues({ smsLogFails: true }));
    dbh.isTransaction = true;
    const updated = await markRecipientOptin('+19415550123', 'confirmed', { dbh });
    expect(updated).toBe(false);
  });

  test('marker-recovery sms_log error on a fire-and-forget dbh stays best-effort (returns the count)', async () => {
    const dbh = queuedDbh(markerRecoveryQueues({ smsLogFails: true }));
    const updated = await markRecipientOptin('+19415550123', 'confirmed', { dbh });
    expect(updated).toBe(1);
  });
});

// Owner redesign 2026-10-01: consent comes ONLY from the recipient's own YES.
// The confirm path stamps the account's consent artifact (when the whole row is
// covered), demotes the caller when the call left a marker for THIS phone,
// replays the booking confirmation to the recipient, and updates the review
// card; a NO / STOP or a failed ask clears only that phone's marker entry.
describe('recipient YES / NO: consent stamp, caller demotion, confirmation replay, review card', () => {
  const KEY = '9415550123';
  const OTHER = '9415550444';
  function fakeDb({ customer, optinRows, visit = { status: 'scheduled' } }) {
    const state = { customer: { id: 'c1', service_preferences: {}, ...customer }, optin: optinRows, prefs: [], cards: [], visit };
    const markers = () => state.customer.service_preferences.demote_primary_on_optin || {};
    const dbh = jest.fn((table) => {
      const ctx = { filter: {}, raw: null, whereIn: null, nullCols: [] };
      const q = {
        where: jest.fn((f) => { if (f && typeof f === 'object') Object.assign(ctx.filter, f); return q; }),
        whereNot: jest.fn(() => q),
        whereNotNull: jest.fn(() => q),
        whereNull: jest.fn((c) => { ctx.nullCols.push(c); return q; }),
        whereIn: jest.fn((c, v) => { ctx.whereIn = [c, v]; return q; }),
        whereRaw: jest.fn((sql, binds) => { ctx.raw = binds; return q; }),
        select: jest.fn(async () => state.optin.filter((r) => r.phone_key && (!ctx.filter.phone_key || r.phone_key === ctx.filter.phone_key)
          && (!ctx.filter.status || r.status === ctx.filter.status) && (!ctx.filter.customer_id || r.customer_id === ctx.filter.customer_id)
          && (!ctx.whereIn || ctx.whereIn[1].includes(r.phone_key)))),
        first: jest.fn(async () => {
          if (table === 'customers') return { ...state.customer };
          if (table === 'scheduled_services') return state.visit;
          if (table === 'recipient_optin') return state.optin.find((r) => r.phone_key === ctx.filter.phone_key && r.customer_id === ctx.filter.customer_id) || null;
          return null;
        }),
        update: jest.fn(async (payload) => {
          if (table === 'customers') {
            if (ctx.nullCols.includes('service_contacts_consent_at') && state.customer.service_contacts_consent_at) return 0;
            if (payload.service_contacts_consent_at) { Object.assign(state.customer, payload); return 1; }
            const raw = payload.service_preferences;
            // jsonb_exists guard: the entry must exist for the whereRaw'd form.
            if (ctx.raw && !(ctx.raw[0] in markers())) return 0;
            delete markers()[raw.binds[0]];
            return 1;
          }
          if (table === 'triage_items') { state.cards.push({ phoneKey: ctx.raw[0], payload: JSON.parse(payload.payload.binds[0]) }); return 1; }
          return 0;
        }),
        insert: jest.fn((row) => ({ onConflict: () => ({ merge: async () => { state.prefs.push(row); } }) })),
      };
      return q;
    });
    dbh.raw = jest.fn((sql, binds) => (binds ? { sql, binds } : sql));
    return { dbh, state };
  }
  const confirmed = (extra = []) => [{ phone_key: KEY, customer_id: 'c1', status: 'confirmed' }, ...extra];
  const marker = (extra = {}) => ({ demote_primary_on_optin: { [KEY]: { scheduled_service_id: 's1', set_at: 'x' }, ...extra } });
  const spouseRow = (extra = {}) => ({
    service_contact_name: 'Sample Spouse', service_contact_phone: '+19415550123', service_contact_email: null, service_contact_role: 'spouse_partner',
    service_contact2_phone: null, service_contact3_phone: null, ...extra,
  });
  const { applyDemoteMarkersOnConfirm, clearDemoteMarker, clearDemoteMarkersForPhone, runConfirmationReplays, reconcileDemoteMarker } = require('../services/recipient-optin');

  test('a late YES after the booked visit was cancelled: stale entry dropped, caller NOT demoted, no replay', async () => {
    const { dbh, state } = fakeDb({ customer: spouseRow({ service_preferences: marker() }), optinRows: confirmed(), visit: { status: 'cancelled' } });
    const { replays } = await applyDemoteMarkersOnConfirm(KEY, { dbh });
    expect(state.prefs).toEqual([]);
    expect(replays).toEqual([]);
    expect(state.customer.service_preferences.demote_primary_on_optin).toEqual({});
  });

  test('a late YES from a phone no longer in any slot on a stamped row: caller NOT demoted, entry dropped', async () => {
    const { dbh, state } = fakeDb({
      customer: spouseRow({ service_contact_phone: '+19415550999', service_contacts_consent_at: new Date(), service_preferences: marker() }),
      optinRows: confirmed(),
    });
    const { replays } = await applyDemoteMarkersOnConfirm(KEY, { dbh });
    expect(state.prefs).toEqual([]);
    expect(replays).toEqual([]);
    expect(state.customer.service_preferences.demote_primary_on_optin).toEqual({});
  });

  test('the YES that completes consent also applies the OTHER confirmed phone\'s held entry', async () => {
    const { dbh, state } = fakeDb({
      customer: spouseRow({ service_contact2_phone: '+19415550444', service_contact2_name: 'Sample Tenant', service_preferences: marker({ [OTHER]: { scheduled_service_id: 's9', set_at: 'y' } }) }),
      optinRows: confirmed([{ phone_key: OTHER, customer_id: 'c1', status: 'confirmed' }]),
    });
    const { replays } = await applyDemoteMarkersOnConfirm(KEY, { dbh });
    expect(state.customer.service_contacts_consent_source).toBe('recipient_optin_confirmed');
    expect(state.customer.service_preferences.demote_primary_on_optin).toEqual({});
    expect(replays.map((r) => r.scheduledServiceId).sort()).toEqual(['s1', 's9']);
  });

  describe('reconcileDemoteMarker: the opt-in already settled when the booking wrote the marker', () => {
    test('already confirmed (earlier call, or the YES beat the booking): applies the marker now', async () => {
      const { dbh, state } = fakeDb({ customer: spouseRow({ service_preferences: marker() }), optinRows: confirmed() });
      expect(await reconcileDemoteMarker('c1', KEY, { dbh })).toBe('applied');
      expect(state.prefs).toEqual([{ customer_id: 'c1', appointment_notify_primary: false }]);
      expect(state.customer.service_preferences.demote_primary_on_optin).toEqual({});
    });

    test.each(['declined', 'ask_failed'])('%s: drops the marker; the caller stays the recipient', async (status) => {
      const { dbh, state } = fakeDb({ customer: spouseRow({ service_preferences: marker() }), optinRows: [{ phone_key: KEY, customer_id: 'c1', status }] });
      expect(await reconcileDemoteMarker('c1', KEY, { dbh })).toBe('cleared');
      expect(state.prefs).toEqual([]);
      expect(state.customer.service_preferences.demote_primary_on_optin).toEqual({});
    });

    test.each(['pending', 'scheduled'])('%s: the marker waits for the reply', async (status) => {
      const { dbh, state } = fakeDb({ customer: spouseRow({ service_preferences: marker() }), optinRows: [{ phone_key: KEY, customer_id: 'c1', status }] });
      expect(await reconcileDemoteMarker('c1', KEY, { dbh })).toBe('pending');
      expect(state.customer.service_preferences.demote_primary_on_optin[KEY]).toBeDefined();
    });
  });

  test('YES, single-phone unstamped row: stamps recipient_optin_confirmed, demotes the caller via ITS marker entry, clears it, updates the card, queues the confirmation replay', async () => {
    const { dbh, state } = fakeDb({ customer: spouseRow({ service_preferences: { other: 1, ...marker() } }), optinRows: confirmed() });
    const { replays } = await applyDemoteMarkersOnConfirm(KEY, { dbh });
    expect(state.customer).toMatchObject({ service_contacts_consent_source: 'recipient_optin_confirmed', service_contacts_consent_text_version: 'portal-2026-07-23' });
    expect(state.customer.service_contacts_consent_at).toBeInstanceOf(Date);
    expect(state.prefs).toEqual([{ customer_id: 'c1', appointment_notify_primary: false }]);
    expect(state.customer.service_preferences.demote_primary_on_optin).toEqual({});
    expect(state.customer.service_preferences.other).toBe(1);
    expect(state.cards[0].payload).toEqual({ optin_result: 'confirmed' });
    expect(replays).toEqual([{ customerId: 'c1', scheduledServiceId: 's1', contact: { name: 'Sample Spouse', phone: '+19415550123', role: 'spouse_partner' } }]);
  });

  test('YES with ANOTHER unconfirmed slot phone: no stamp, no demotion, no replay; the card says why', async () => {
    const { dbh, state } = fakeDb({ customer: spouseRow({ service_contact2_phone: '+19415550444', service_preferences: marker() }), optinRows: confirmed() });
    const { replays } = await applyDemoteMarkersOnConfirm(KEY, { dbh });
    expect(state.customer.service_contacts_consent_at).toBeUndefined();
    expect(state.prefs).toEqual([]);
    expect(replays).toEqual([]);
    expect(state.customer.service_preferences.demote_primary_on_optin[KEY]).toBeDefined();
    expect(state.cards[0].payload).toEqual({ optin_result: 'confirmed', consent_stamp: 'held:other_slot_phone_unconfirmed' });
  });

  test('YES when the other slot phone has its OWN confirmed row: stamps', async () => {
    const { dbh, state } = fakeDb({ customer: spouseRow({ service_contact2_phone: '+19415550444' }), optinRows: confirmed([{ phone_key: OTHER, customer_id: 'c1', status: 'confirmed' }]) });
    await applyDemoteMarkersOnConfirm(KEY, { dbh });
    expect(state.customer.service_contacts_consent_source).toBe('recipient_optin_confirmed');
  });

  test('YES on an already-stamped (portal-attested) row keeps that stamp, and still demotes', async () => {
    const at = new Date('2026-07-22T00:00:00Z');
    const { dbh, state } = fakeDb({ customer: spouseRow({ service_contact2_phone: '+19415550444', service_contacts_consent_at: at, service_contacts_consent_source: 'portal_account_holder', service_preferences: marker() }), optinRows: confirmed() });
    await applyDemoteMarkersOnConfirm(KEY, { dbh });
    expect(state.customer.service_contacts_consent_source).toBe('portal_account_holder');
    expect(state.customer.service_contacts_consent_at).toBe(at);
    expect(state.prefs).toEqual([{ customer_id: 'c1', appointment_notify_primary: false }]);
  });

  test('MULTIPLE markers on an already-consented row: a YES applies and clears only its own entry; another contact\'s entry survives', async () => {
    const { dbh, state } = fakeDb({
      customer: spouseRow({ service_contact2_phone: '+19415550444', service_contacts_consent_at: new Date(), service_preferences: marker({ [OTHER]: { scheduled_service_id: 's9', set_at: 'y' } }) }),
      optinRows: confirmed([{ phone_key: OTHER, customer_id: 'c1', status: 'confirmed' }]),
    });
    await applyDemoteMarkersOnConfirm(KEY, { dbh });
    expect(Object.keys(state.customer.service_preferences.demote_primary_on_optin)).toEqual([OTHER]);
    expect(state.prefs).toHaveLength(1);
  });

  test('YES for a phone with NO marker entry leaves the pref alone (stamp still happens), and queues no replay', async () => {
    const { dbh, state } = fakeDb({ customer: spouseRow({ service_preferences: { demote_primary_on_optin: { [OTHER]: { scheduled_service_id: 's9' } } } }), optinRows: confirmed() });
    const { replays } = await applyDemoteMarkersOnConfirm(KEY, { dbh });
    expect(state.prefs).toEqual([]);
    expect(replays).toEqual([]);
    expect(state.customer.service_preferences.demote_primary_on_optin[OTHER]).toBeDefined();
  });

  test('a confirmed phone that sits in no slot is never stamped', async () => {
    const { dbh, state } = fakeDb({ customer: spouseRow({ service_contact_phone: '+19415550999' }), optinRows: confirmed() });
    await applyDemoteMarkersOnConfirm(KEY, { dbh });
    expect(state.customer.service_contacts_consent_at).toBeUndefined();
    expect(state.cards[0].payload.consent_stamp).toBe('held:phone_not_in_a_slot');
  });

  test('NO / STOP clears every marker entry for that phone only (caller stays the recipient); the card says declined', async () => {
    const { dbh, state } = fakeDb({ customer: spouseRow({ service_preferences: marker({ [OTHER]: { scheduled_service_id: 's9' } }) }), optinRows: [{ phone_key: KEY, customer_id: 'c1', status: 'declined' }] });
    await clearDemoteMarkersForPhone(KEY, { dbh });
    expect(Object.keys(state.customer.service_preferences.demote_primary_on_optin)).toEqual([OTHER]);
    expect(state.prefs).toEqual([]);
    expect(state.cards[0].payload).toEqual({ optin_result: 'declined' });
  });

  test('a failed ask drops only the entry naming this phone', async () => {
    const a = fakeDb({ customer: spouseRow({ service_preferences: marker({ [OTHER]: { scheduled_service_id: 's9' } }) }), optinRows: [] });
    await clearDemoteMarker('c1', KEY, { dbh: a.dbh });
    expect(Object.keys(a.state.customer.service_preferences.demote_primary_on_optin)).toEqual([OTHER]);
    const b = fakeDb({ customer: spouseRow({ service_preferences: { demote_primary_on_optin: { [OTHER]: { scheduled_service_id: 's9' } } } }), optinRows: [] });
    await clearDemoteMarker('c1', KEY, { dbh: b.dbh });
    expect(Object.keys(b.state.customer.service_preferences.demote_primary_on_optin)).toEqual([OTHER]);
  });

  test('confirmation replay: runs the shared confirmation helper per queued replay, after the transaction (non-tx: next tick)', async () => {
    const sendConfirmationToServiceContact = jest.fn(async () => ({ sent: true }));
    jest.doMock('../services/appointment-reminders', () => ({ sendConfirmationToServiceContact }));
    const replay = { customerId: 'c1', scheduledServiceId: 's1', contact: { name: 'Sample Spouse', phone: '+19415550123', role: 'spouse_partner' } };
    runConfirmationReplays([replay], null);
    expect(sendConfirmationToServiceContact).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendConfirmationToServiceContact).toHaveBeenCalledWith(replay);
    // Transactional dbh: waits for the commit (executionPromise), never fires on rollback.
    sendConfirmationToServiceContact.mockClear();
    let commit; let rollback;
    const committed = { isTransaction: true, executionPromise: new Promise((res) => { commit = res; }) };
    runConfirmationReplays([replay], committed);
    await Promise.resolve();
    expect(sendConfirmationToServiceContact).not.toHaveBeenCalled();
    commit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendConfirmationToServiceContact).toHaveBeenCalledTimes(1);
    sendConfirmationToServiceContact.mockClear();
    const rolled = { isTransaction: true, executionPromise: new Promise((_, rej) => { rollback = rej; }) };
    runConfirmationReplays([replay], rolled);
    rollback(new Error('rolled back'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendConfirmationToServiceContact).not.toHaveBeenCalled();
    jest.dontMock('../services/appointment-reminders');
  });

  test('wired into the transitions: confirm applies (and replays), decline clears, every ask_failed release clears', () => {
    const src = require('fs').readFileSync(require.resolve('../services/recipient-optin'), 'utf8');
    expect(src).toContain("if (status === 'confirmed') runConfirmationReplays((await applyDemoteMarkersOnConfirm(key, { dbh })).replays, dbh);");
    expect(src).toContain("else if (status === 'declined') await clearDemoteMarkersForPhone(key, { dbh });");
    expect(src.split('await releaseAskFailed(').length - 1).toBe(4);
    expect(src).toContain('async function withSavepoint(dbh, fn)');
    expect(src).toContain("service_contacts_consent_source: 'recipient_optin_confirmed'");
  });
});

describe('isOptinRailLive: the on-site opt-in ask needs a live rail', () => {
  test('true only when the gate is on AND the request template exists and is active; a read error counts as dark', async () => {
    jest.resetModules();
    const dbMock = jest.fn();
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => globalThis.__gateOn) }));
    const { isOptinRailLive } = require('../services/recipient-optin');
    const template = (row) => dbMock.mockImplementation(() => ({ where: () => ({ first: async () => row }) }));
    globalThis.__gateOn = false; template({ is_active: true });
    expect(await isOptinRailLive()).toBe(false);
    globalThis.__gateOn = true; template(null);
    expect(await isOptinRailLive()).toBe(false);
    template({ is_active: false });
    expect(await isOptinRailLive()).toBe(false);
    template({ is_active: true });
    expect(await isOptinRailLive()).toBe(true);
    dbMock.mockImplementation(() => { throw new Error('boom'); });
    expect(await isOptinRailLive()).toBe(false);
    jest.dontMock('../config/feature-gates');
    jest.dontMock('../models/db');
    jest.dontMock('../services/logger');
    jest.resetModules();
  });
});

