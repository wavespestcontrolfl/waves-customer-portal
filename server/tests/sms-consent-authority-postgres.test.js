// Real preference route, validators and suppression writers; no provider calls.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn(async () => ({})) }));

const { randomUUID } = require('node:crypto');
const { withSmsConsentLock } = require('../utils/customer-comms-lock');
const connection = process.env.DATABASE_URL;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

(connection ? describe : describe.skip)('SMS consent authority with two PostgreSQL connections', () => {
  const customerId = randomUUID();
  const phone = '+19415550149';
  const input = { customerId, to: phone, channel: 'sms', audience: 'lead', purpose: 'conversational' };
  let db;
  let consent;
  let suppression;
  let policy;
  let saveHandler;

  beforeAll(async () => {
    const url = new URL(connection);
    const qa = process.env.WAVES_LOCAL_DEV === '1' && process.env.WAVES_WORKTREE_ID
      && url.pathname === `/waves_qa_${process.env.WAVES_WORKTREE_ID.replaceAll('-', '')}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!qa && !ci) throw new Error('Use only the owned synthetic QA or isolated CI database.');
    process.env.DB_POOL_MAX = '2';
    db = require('../models/db');
    consent = require('../services/messaging/validators/consent');
    suppression = require('../services/messaging/validators/suppression');
    policy = require('../services/messaging/policy').resolvePolicy('lead', 'conversational');
    saveHandler = require('../routes/notifications').stack
      .find(layer => layer.route?.path === '/preferences' && layer.route.methods.put).route.stack[0].handle;
    await db('customers').insert({ id: customerId, first_name: 'QA', last_name: 'Consent', phone,
      email: `qa-consent-${customerId}@example.invalid`, active: true, pipeline_stage: 'new_lead' });
    expect(db.client.pool.max).toBe(2);
  });

  beforeEach(async () => {
    await db('messaging_suppression').where({ phone }).del();
    await db('notification_prefs').insert({ customer_id: customerId, sms_enabled: true })
      .onConflict('customer_id').merge({ sms_enabled: true });
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db('messaging_suppression').where({ phone }).del();
      await db('notification_prefs').where({ customer_id: customerId }).del();
      await db('property_preferences').where({ customer_id: customerId }).del();
      await db('customers').where({ id: customerId }).del();
    } finally { await db.destroy(); }
  });

  async function savePreference(enabled) {
    let payload;
    await saveHandler({ customerId, body: { smsEnabled: enabled } }, {
      json(value) { payload = value; },
      status(code) { throw new Error(`Unexpected HTTP ${code}`); },
    }, error => { throw error; });
    expect(payload.success).toBe(true);
    expect(payload.preferences.smsEnabled).toBe(enabled);
  }

  async function verdict(dbh) {
    const state = await consent.loadContactState(input, dbh);
    await suppression.loadSuppressionState(input, state, dbh);
    const allowed = await consent.checkConsentForPurpose(input, policy, state);
    return allowed.ok ? suppression.checkSuppression(input, policy, state) : allowed;
  }

  async function waitForBlockedWriter(trx) {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      await trx.raw('SELECT pg_stat_clear_snapshot()');
      const { rows } = await trx.raw(`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND wait_event = 'advisory'`);
      if (rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Writer did not wait for SMS authority');
  }

  // Pause INSIDE the real contact loader, after the preference SELECT has
  // completed but before its customer and suppression SELECTs. This is the
  // reviewed race; no pre-read lock-wait simulation can stand in for it.
  async function raceAfterPreferenceRead(write) {
    const read = deferred();
    const resume = deferred();
    let held;
    let writerCommitted = false;
    let handedOff = false;
    const send = withSmsConsentLock(db, { phone, customerId }, async trx => {
      held = trx;
      const paused = table => {
        const query = trx(table);
        if (table === 'notification_prefs') {
          const first = query.first;
          query.first = function (...columns) {
            return first.apply(this, columns).then(async row => {
              read.resolve(); await resume.promise; return row;
            });
          };
        }
        return query;
      };
      paused.isTransaction = true;
      const result = await verdict(paused);
      expect(result.ok).toBe(true);
      expect(writerCommitted).toBe(false);
      handedOff = true;
    });
    await read.promise;
    const writer = write().then(() => { writerCommitted = true; });
    try {
      await waitForBlockedWriter(held);
      expect(handedOff).toBe(false);
      expect(writerCommitted).toBe(false);
    } finally {
      resume.resolve();
      await Promise.all([send, writer]);
    }
    expect(handedOff).toBe(true);
    expect(writerCommitted).toBe(true);
    const next = await withSmsConsentLock(db, { phone, customerId }, verdict);
    expect(next.ok).toBe(false);
  }

  test.each([true, false])('preference save cannot commit between consent read and handoff (row exists: %s)', async exists => {
    if (!exists) await db('notification_prefs').where({ customer_id: customerId }).del();
    await raceAfterPreferenceRead(() => savePreference(false));
  });

  test.each(['STOP', 'non-mobile', '21610'])('%s cannot commit after the preference read and before handoff', async source => {
    await raceAfterPreferenceRead(async () => {
      if (source === '21610') {
        const result = await require('../services/messaging/sync-optout').recordSyncProviderOptOut({ phone, attemptAt: new Date() });
        expect(result.recorded).toBe(true);
      } else {
        const result = source === 'STOP'
          ? await suppression.recordSuppression({ phone, reason: 'opt_out', source: 'qa' })
          : await suppression.recordNonMobileSuppression({ phone, source: 'qa' });
        expect(result.ok).toBe(true);
      }
    });
  });

  test('START clearance waits for an active handoff and releases its lock', async () => {
    const ready = deferred(); const release = deferred();
    let held; let cleared = false;
    const send = withSmsConsentLock(db, { phone, customerId }, async trx => {
      held = trx; ready.resolve(); await release.promise;
    });
    await ready.promise;
    const clear = suppression.clearSuppression({ phone, source: 'qa' }).then(result => {
      expect(result.ok).toBe(true); cleared = true;
    });
    try {
      await waitForBlockedWriter(held);
      expect(cleared).toBe(false);
    } finally {
      release.resolve();
      await Promise.all([send, clear]);
      // Include the canonical clear's post-commit cache cleanup transaction.
      const until = Date.now() + 3000;
      while ((db.client.pool.numUsed() || db.client.pool.numPendingAcquires()) && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(db.client.pool.numUsed()).toBe(0);
    }
    expect(await db('messaging_suppression').where({ phone }).first()).toMatchObject({ active: false });
    expect(await withSmsConsentLock(db, { phone, customerId }, verdict)).toEqual({ ok: true });
  });

  test('a completed preference opt-out prevents the next handoff', async () => {
    await savePreference(false);
    const result = await withSmsConsentLock(db, { phone, customerId }, verdict);
    expect(result).toMatchObject({ ok: false, code: 'SMS_OPTED_OUT' });
  });

  test('an existing suppression prevents the next handoff, including formatted input', async () => {
    expect(await suppression.recordSuppression({ phone: '(941) 555-0149', reason: 'opt_out', source: 'qa' })).toEqual({ ok: true });
    const result = await withSmsConsentLock(db, { phone, customerId }, verdict);
    expect(result.ok).toBe(false);
  });

  test('missing-row defaults still allow a known lead with positively loaded suppression', async () => {
    await db('notification_prefs').where({ customer_id: customerId }).del();
    expect(await withSmsConsentLock(db, { phone, customerId }, verdict)).toEqual({ ok: true });
    expect(await db('notification_prefs').where({ customer_id: customerId }).first()).toBeUndefined();
  });

  test.each(['consent', 'suppression'])('a failed %s read throws and releases both locks', async validator => {
    await expect(withSmsConsentLock(db, { phone, customerId }, async trx => {
      await trx.raw('SET LOCAL search_path = pg_catalog');
      return validator === 'consent' ? consent.loadContactState(input, trx) : suppression.loadSuppressionState(input, {}, trx);
    })).rejects.toHaveProperty('code', '42P01');
    await savePreference(false);
    expect((await withSmsConsentLock(db, { phone, customerId }, verdict)).ok).toBe(false);
  });
});
