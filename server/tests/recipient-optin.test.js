jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  recipientPhoneKey,
  optinBlocksSend,
  markRecipientOptin,
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
// The confirm path takes the phone off the account's unconsented list, stamps
// the account's consent artifact when the whole row is covered, and records
// the outcome on that customer's review card; a NO / STOP records declined.
describe('recipient YES / NO: consent stamp, unconsented hold, review card', () => {
  const { onRecipientConfirmed, onRecipientDeclined } = require('../services/recipient-optin');
  const KEY = '9415550123';
  const OTHER = '9415550444';
  function fakeDb({ customer, optinRows }) {
    const state = { customer: { id: 'c1', service_preferences: {}, ...customer }, optin: optinRows, cards: [] };
    const dbh = jest.fn((table) => {
      const ctx = { filter: {}, raw: null, whereIn: null, nullCols: [], customerScoped: false };
      const q = {
        where: jest.fn((f) => { if (f && typeof f === 'object') Object.assign(ctx.filter, f); return q; }),
        whereNotNull: jest.fn(() => q),
        forUpdate: jest.fn(() => q),
        whereNull: jest.fn((c) => { ctx.nullCols.push(c); return q; }),
        whereIn: jest.fn((c, v) => { if (c === 'call_log_id') ctx.customerScoped = true; else ctx.whereIn = [c, v]; return q; }),
        whereRaw: jest.fn((sql, binds) => { ctx.raw = binds; return q; }),
        select: jest.fn(async () => state.optin.filter((r) => r.phone_key && (!ctx.filter.phone_key || r.phone_key === ctx.filter.phone_key)
          && (!ctx.filter.status || r.status === ctx.filter.status) && (!ctx.filter.customer_id || r.customer_id === ctx.filter.customer_id)
          && (!ctx.whereIn || ctx.whereIn[1].includes(r.phone_key)))),
        first: jest.fn(async () => (table === 'customers' ? { ...state.customer } : null)),
        update: jest.fn(async (payload) => {
          if (table === 'customers') {
            if (ctx.nullCols.includes('service_contacts_consent_at') && state.customer.service_contacts_consent_at) return 0;
            if (payload.service_contacts_consent_at) { Object.assign(state.customer, payload); return 1; }
            // The YES removes the phone from the unconsented list: binds [phoneKey].
            const list = state.customer.service_preferences.unconsented_slot_phone_keys || [];
            state.customer.service_preferences.unconsented_slot_phone_keys = list.filter((k) => k !== payload.service_preferences.binds[0]);
            return 1;
          }
          if (table === 'triage_items') {
            state.cards.push({ phoneKey: ctx.raw[0], customerScoped: ctx.customerScoped, payload: JSON.parse(payload.payload.binds[0]) });
            return 1;
          }
          return 0;
        }),
      };
      return q;
    });
    dbh.raw = jest.fn((sql, binds) => (binds ? { sql, binds } : sql));
    return { dbh, state };
  }
  const confirmed = (extra = []) => [{ phone_key: KEY, customer_id: 'c1', status: 'confirmed' }, ...extra];
  const spouseRow = (extra = {}) => ({
    service_contact_name: 'Sample Spouse', service_contact_phone: '+19415550123', service_contact_email: null, service_contact_role: 'spouse_partner',
    service_contact2_phone: null, service_contact3_phone: null, ...extra,
  });

  test('YES on a single-phone unstamped row: stamps recipient_optin_confirmed and records it on that customer\'s card', async () => {
    const { dbh, state } = fakeDb({ customer: spouseRow(), optinRows: confirmed() });
    await onRecipientConfirmed(KEY, { dbh });
    expect(state.customer).toMatchObject({ service_contacts_consent_source: 'recipient_optin_confirmed', service_contacts_consent_text_version: 'portal-2026-07-23' });
    expect(state.customer.service_contacts_consent_at).toBeInstanceOf(Date);
    expect(state.cards).toEqual([{ phoneKey: KEY, customerScoped: true, payload: { optin_result: 'confirmed' } }]);
  });

  test('YES takes this phone off the account\'s unconsented list (others stay)', async () => {
    const { dbh, state } = fakeDb({
      customer: spouseRow({ service_contacts_consent_at: new Date(), service_preferences: { unconsented_slot_phone_keys: [KEY, OTHER] } }),
      optinRows: confirmed(),
    });
    await onRecipientConfirmed(KEY, { dbh });
    expect(state.customer.service_preferences.unconsented_slot_phone_keys).toEqual([OTHER]);
  });

  test('YES with ANOTHER unconfirmed slot phone: no stamp; the card says why', async () => {
    const { dbh, state } = fakeDb({ customer: spouseRow({ service_contact2_phone: '+19415550444' }), optinRows: confirmed() });
    await onRecipientConfirmed(KEY, { dbh });
    expect(state.customer.service_contacts_consent_at).toBeUndefined();
    expect(state.cards[0].payload).toEqual({ optin_result: 'confirmed', consent_stamp: 'held:other_slot_phone_unconfirmed' });
  });

  test('YES when the other slot phone has its OWN confirmed row: stamps', async () => {
    const { dbh, state } = fakeDb({ customer: spouseRow({ service_contact2_phone: '+19415550444' }), optinRows: confirmed([{ phone_key: OTHER, customer_id: 'c1', status: 'confirmed' }]) });
    await onRecipientConfirmed(KEY, { dbh });
    expect(state.customer.service_contacts_consent_source).toBe('recipient_optin_confirmed');
  });

  test('YES when the other slot phone was covered by the stamp an unconsented add cleared (grandfathered, no opt-in row): stamps', async () => {
    const { dbh, state } = fakeDb({
      customer: spouseRow({ service_contact2_phone: '+19415550444', service_preferences: { consent_covered_phone_keys: [OTHER] } }),
      optinRows: confirmed(),
    });
    await onRecipientConfirmed(KEY, { dbh });
    expect(state.customer.service_contacts_consent_source).toBe('recipient_optin_confirmed');
  });

  test('YES on an already-stamped (portal-attested) row keeps that stamp', async () => {
    const at = new Date('2026-07-22T00:00:00Z');
    const { dbh, state } = fakeDb({ customer: spouseRow({ service_contacts_consent_at: at, service_contacts_consent_source: 'portal_account_holder' }), optinRows: confirmed() });
    await onRecipientConfirmed(KEY, { dbh });
    expect(state.customer.service_contacts_consent_source).toBe('portal_account_holder');
    expect(state.customer.service_contacts_consent_at).toBe(at);
  });

  test('a confirmed phone that sits in no slot is never stamped', async () => {
    const { dbh, state } = fakeDb({ customer: spouseRow({ service_contact_phone: '+19415550999' }), optinRows: confirmed() });
    await onRecipientConfirmed(KEY, { dbh });
    expect(state.customer.service_contacts_consent_at).toBeUndefined();
    expect(state.cards[0].payload.consent_stamp).toBe('held:phone_not_in_a_slot');
  });

  test('a failed follow-up on the webhook\'s transactional handle is rethrown (the YES must not commit with the hold still in place); fire-and-forget stays best-effort', async () => {
    const { dbh } = fakeDb({ customer: spouseRow({ service_preferences: { unconsented_slot_phone_keys: [KEY] } }), optinRows: confirmed() });
    const inner = dbh.getMockImplementation();
    dbh.mockImplementation((table) => {
      if (table === 'customers') throw new Error('row lock failed');
      return inner(table);
    });
    await expect(onRecipientConfirmed(KEY, { dbh })).resolves.toBeUndefined();
    dbh.isTransaction = true;
    await expect(onRecipientConfirmed(KEY, { dbh })).rejects.toThrow('row lock failed');
  });

  test('NO / STOP records declined on the card', async () => {
    const { dbh, state } = fakeDb({ customer: spouseRow(), optinRows: [{ phone_key: KEY, customer_id: 'c1', status: 'declined' }] });
    await onRecipientDeclined(KEY, { dbh });
    expect(state.cards[0].payload).toEqual({ optin_result: 'declined' });
  });

  test('wired into the transitions: confirm and decline run their follow-ups', () => {
    const src = require('fs').readFileSync(require.resolve('../services/recipient-optin'), 'utf8');
    expect(src).toContain("if (status === 'confirmed') await onRecipientConfirmed(key, { dbh });");
    expect(src).toContain("else if (status === 'declined') await onRecipientDeclined(key, { dbh });");
    // The booked visit rides a send-window-deferred ask (re-checked before it goes out).
    expect(src).toContain('optin_visit_id: claim.visitId || null,');
    // An on-site visit ask is tagged on the row, and the undispatched-ask
    // recovery sweep releases it instead of re-sending it without its visit.
    expect(src).toContain("requested_by: visitId ? ON_SITE_VISIT_ASK : 'portal_contact_save',");
    expect(src).toContain('...(visitId ? { requested_by: ON_SITE_VISIT_ASK } : {}),');
    expect(src).toContain('if (idx < 0 || row.requested_by === ON_SITE_VISIT_ASK) {');
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
